/*
 * OpenTT3D - pont C++ entre OpenTTD (WebAssembly) et le frontend JavaScript.
 *
 * Ce fichier est compilé dans le binaire Emscripten et expose une API C
 * stable (voir le wiki, section Architecture > Protocole, et
 * `src/engine/protocol.ts`).
 *
 * Principe : le pilote vidéo "web" (engine/bridge/web_v.cpp) rend la main
 * après l'initialisation ; ici, nous pompons explicitement la boucle de jeu
 * (`GameLoop` + `InputLoop` + `UpdateWindows`) tick par tick, sans timer ni
 * rendu, ce qui garantit un comportement déterministe et testable sous Node.
 *
 * Depuis #11, le pont expose aussi `ottd_command()` : les intentions
 * `EngineCommand` (build/vehicle) sont validées puis exécutées via
 * `Command<CMD_*>::Unsafe`, jamais par mutation directe de la carte.
 *
 * Licence : GPL v2 (comme OpenTTD).
 */

#include "stdafx.h"

#include "ai/ai_info.hpp"
#include "articulated_vehicles.h"
#include "autoreplace_cmd.h"
#include "autoreplace_func.h"
#include "bridge.h"
#include "bridge_map.h"
#include "cargo_type.h"
#include "cargotype.h"
#include "clear_map.h"
#include "command_func.h"
#include "company_base.h"
#include "company_func.h"
#include "company_type.h"
#include "core/backup_type.hpp"
#include "core/random_func.hpp"
#include "debug.h"
#include "depot_base.h"
#include "depot_map.h"
#include "depot_type.h"
#include "disaster_vehicle.h"
#include "direction_func.h"
#include "direction_type.h"
#include "elrail_func.h"
#include "engine_base.h"
#include "engine_func.h"
#include "economy_func.h"
#include "economy_type.h"
#include "engine_type.h"
#include "gfx_func.h"
#include "genworld.h"
#include "group.h"
#include "group_cmd.h"
#include "industry.h"
#include "industrytype.h"
#include "landscape.h"
#include "landscape_cmd.h"
#include "landscape_type.h"
#include "map_func.h"
#include "misc_cmd.h"
#include "newgrf_config.h"
#include "newgrf_roadstop.h"
#include "newgrf_station.h"
#include "openttd.h"
#include "order_base.h"
#include "order_cmd.h"
#include "order_type.h"
#include "rail.h"
#include "rail_cmd.h"
#include "rail_map.h"
#include "rail_type.h"
#include "road.h"
#include "road_cmd.h"
#include "road_func.h"
#include "road_map.h"
#include "road_type.h"
#include "saveload/saveload.h"
#include "saveload/saveload_filter.h"
#include "settings_type.h"
#include "station_base.h"
#include "station_cmd.h"
#include "station_map.h"
#include "station_type.h"
#include "strings_func.h"
#include "subsidy_base.h"
#include "table/strings.h"
#include "terraform_cmd.h"
#include "tile_map.h"
#include "timer/timer_game_calendar.h"
#include "timer/timer_game_economy.h"
#include "timer/timer_game_tick.h"
#include "timetable_cmd.h"
#include "town.h"
#include "town_cmd.h"
#include "track_func.h"
#include "track_type.h"
#include "tree_cmd.h"
#include "tree_map.h"
#include "transport_type.h"
#include "tunnelbridge.h"
#include "tunnelbridge_cmd.h"
#include "tunnelbridge_map.h"
#include "vehicle_base.h"
#include "vehicle_cmd.h"
#include "vehicle_type.h"
#include "vehiclelist.h"
#include "water_cmd.h"
#include "water_map.h"
#include "window_func.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <emscripten.h>
#include <optional>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <unordered_set>
#include <vector>

#include "safeguards.h"

/* Déclarés dans openttd.cpp ; non exportés par un en-tête public. */
extern Company *DoStartupNewCompany(bool is_ai, CompanyID company);
extern void PostMainLoop();

/**
 * Hook optionnel installé par le pont (patch engine/patches/0003) : OpenTTD
 * l'appelle dans `UserErrorI` / `FatalErrorI` avant `_exit`/`abort`, ce qui
 * permet de mémoriser le message dans `ottd_last_error()`.
 */
extern void (*_ottd_fatal_error_hook)(const char *message);

namespace {

/** Utilisé par le snapshot avant sa définition plus bas (#157). */
const char *RailTypeName(RailType type);
/** Utilisé par le snapshot des groupes avant sa définition plus bas (#164). */
std::string EngineName(EngineID engine);

bool _ottd_booted = false;
bool _ottd_in_game = false;
std::string _ottd_error;

/**
 * Sauvegarde mémoire en attente (`ottd_save_size` puis `ottd_save`).
 * Le cache est invalidé dès qu'une opération peut modifier l'état simulé :
 * `ottd_step`, `ottd_command`, `ottd_new_game*`, `ottd_load`.
 */
std::vector<uint8_t> _ottd_save_cache;
bool _ottd_save_cache_valid = false;

/** Compteurs de séquence indépendants pour les deux formats de snapshot. */
uint32_t _ottd_json_sequence = 0;
uint32_t _ottd_map_sequence = 0;

/** Codes de retour de `ottd_command()` (voir wiki, Protocole > Erreurs). */
enum OttdCommandStatus : int {
	OTTD_CMD_OK = 0,            ///< Commande exécutée.
	OTTD_CMD_NO_GAME = 1,       ///< Aucune partie en cours.
	OTTD_CMD_BAD_JSON = 2,      ///< JSON invalide ou incomplet.
	OTTD_CMD_UNKNOWN = 3,       ///< Type d'outil ou d'action inconnu.
	OTTD_CMD_INVALID = 4,       ///< Paramètre hors bornes ou incohérent.
	OTTD_CMD_BAD_COMPANY = 5,   ///< Entreprise inexistante.
	OTTD_CMD_FAILED = 6,        ///< Refus d'OpenTTD (état inchangé).
	OTTD_CMD_BUFFER = 7,        ///< Buffer de sortie trop petit.
	OTTD_CMD_NOT_SUPPORTED = 8, ///< Commande reconnue mais non supportée.
};

/** Dernier résultat JSON produit par `ottd_command()` (relu par le pilote). */
std::string _ottd_last_command_json = "{}";
/** Statut du dernier `ottd_command()` (même valeur que son retour). */
int _ottd_last_command_status = OTTD_CMD_OK;


void SetError(std::string_view message)
{
	_ottd_error.assign(message);
	Debug(misc, 0, "OpenTT3D: {}", _ottd_error);
}

bool IsPowerOfTwo(uint32_t value)
{
	return value != 0 && (value & (value - 1)) == 0;
}

uint8_t Log2(uint32_t value)
{
	uint8_t result = 0;
	while ((value >>= 1) != 0) result++;
	return result;
}

/* ------------------------------------------------------------------------- */
/*  Configuration de partie (issue #60)                                      */
/* ------------------------------------------------------------------------- */

/**
 * Options acceptées par `ottd_set_game_config()` et `ottd_new_game_ex()`.
 *
 * Tous les champs sont facultatifs : un champ absent conserve la valeur
 * courante de `_settings_newgame` (les défauts OpenTTD au premier appel).
 * Les noms JSON sont en snake_case, avec les alias camelCase du frontend.
 *
 * | Champ JSON                     | Type            | Effet |
 * |---|---|---|
 * | `climate` / `landscape`        | chaîne          | `_settings_newgame.game_creation.landscape` (`temperate`, `subarctic`, `subtropical`, `toyland`) |
 * | `start_year` / `startYear`     | entier 1800..2200 | `game_creation.starting_year` (+ `ending_year` au moins +50 ans) |
 * | `difficulty`                   | entier 0..3 ou chaîne (`easy`, `normal`, `hard`, `expert`) | préréglage de `_settings_newgame.difficulty` |
 * | `ai_companies` / `aiCompanies` | entier 0..14    | nombre d'entreprises IA créées au démarrage |
 * | `towns`                        | entier 1..5000  | nombre exact de villes (`custom_town_number`) |
 * | `industries`                   | entier 1..5000  | nombre exact d'industries (`custom_industry_number`) |
 * | `disasters`                    | booléen         | force `difficulty.disasters` |
 * | `map_size` / `mapSize` / `size`| entier 64..4096 (puissance de 2) | doit correspondre à `w` et `h` |
 * | `game_name` / `gameName`       | chaîne          | mémorisé et renvoyé dans le snapshot (aucun champ OpenTTD équivalent) |
 * | `companies` (#99)              | tableau d'objets `{name, colour}` | entreprises humaines créées au démarrage, ids 0..n-1 dans l'ordre ; absent = une seule entreprise locale |
 */

/** Nom et couleur d'une entreprise humaine créée au démarrage (#99). */
struct CompanyProfile {
	std::string name;
	/** Couleur OpenTTD 0..15 ; -1 conserve la couleur générée. */
	int colour = -1;
};

struct GameSetupConfig {
	std::optional<LandscapeType> landscape;
	std::optional<int> start_year;
	std::optional<int> difficulty;
	std::optional<int> ai_companies;
	std::optional<int> towns;
	std::optional<int> industries;
	std::optional<int> map_size;
	std::optional<bool> disasters;
	std::optional<std::string> game_name;
	/** Profils des entreprises humaines (#99). Vide = une entreprise par défaut. */
	std::vector<CompanyProfile> companies;
};

/** Configuration appliquée à la partie courante (pour le snapshot JSON). */
GameSetupConfig _ottd_active_config;
/** Configuration en attente, utilisée par le prochain `ottd_new_game`. */
GameSetupConfig _ottd_pending_config;
bool _ottd_has_pending_config = false;
/** Avertissements non bloquants de la partie courante. */
std::vector<std::string> _ottd_warnings;

void SkipJsonSpace(std::string_view text, size_t &pos)
{
	while (pos < text.size() &&
			(text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r')) {
		pos++;
	}
}

bool JsonDelimiter(std::string_view text, size_t pos)
{
	if (pos >= text.size()) return true;
	const char c = text[pos];
	return c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

bool JsonFail(std::string &error, std::string_view message)
{
	error.assign(message);
	return false;
}

void AppendUtf8(std::string &out, uint32_t codepoint)
{
	if (codepoint <= 0x7F) {
		out.push_back(static_cast<char>(codepoint));
	} else if (codepoint <= 0x7FF) {
		out.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
		out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
	} else if (codepoint <= 0xFFFF) {
		out.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
		out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
		out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
	} else {
		out.push_back(static_cast<char>(0xF0 | (codepoint >> 18)));
		out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
		out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
		out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
	}
}

bool ParseHex4(std::string_view text, size_t &pos, uint32_t &value)
{
	if (pos + 4 > text.size()) return false;
	value = 0;
	for (int i = 0; i < 4; i++) {
		const char c = text[pos++];
		value <<= 4;
		if (c >= '0' && c <= '9') value |= static_cast<uint32_t>(c - '0');
		else if (c >= 'a' && c <= 'f') value |= static_cast<uint32_t>(c - 'a' + 10);
		else if (c >= 'A' && c <= 'F') value |= static_cast<uint32_t>(c - 'A' + 10);
		else return false;
	}
	return true;
}

/** Lit une chaîne JSON (guillemets inclus) et décode les échappements usuels. */
bool ParseJsonString(std::string_view text, size_t &pos, std::string &out, std::string &error)
{
	if (pos >= text.size() || text[pos] != '"') {
		return JsonFail(error, "chaîne JSON attendue");
	}
	pos++;
	out.clear();
	while (pos < text.size()) {
		const char c = text[pos++];
		if (c == '"') return true;
		if (c != '\\') {
			out.push_back(c);
			continue;
		}
		if (pos >= text.size()) return JsonFail(error, "échappement JSON incomplet");
		const char escape = text[pos++];
		switch (escape) {
			case '"':  out.push_back('"'); break;
			case '\\': out.push_back('\\'); break;
			case '/':  out.push_back('/'); break;
			case 'b':  out.push_back('\b'); break;
			case 'f':  out.push_back('\f'); break;
			case 'n':  out.push_back('\n'); break;
			case 'r':  out.push_back('\r'); break;
			case 't':  out.push_back('\t'); break;
			case 'u': {
				uint32_t codepoint = 0;
				if (!ParseHex4(text, pos, codepoint)) return JsonFail(error, "échappement \\u invalide");
				if (codepoint >= 0xD800 && codepoint <= 0xDBFF &&
						pos + 6 <= text.size() && text[pos] == '\\' && text[pos + 1] == 'u') {
					pos += 2;
					uint32_t low = 0;
					if (!ParseHex4(text, pos, low) || low < 0xDC00 || low > 0xDFFF) {
						return JsonFail(error, "paire de substitution \\u invalide");
					}
					codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00);
				}
				AppendUtf8(out, codepoint);
				break;
			}
			default:
				return JsonFail(error, "échappement JSON inconnu");
		}
	}
	return JsonFail(error, "chaîne JSON non terminée");
}

/** Lit un nombre JSON strict (entier ou décimal, sans exposant). */
bool ParseJsonNumber(std::string_view text, size_t &pos, double &out, std::string &error)
{
	const size_t start = pos;
	if (pos < text.size() && text[pos] == '-') pos++;
	const size_t digits_start = pos;
	while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') pos++;
	if (pos == digits_start) return JsonFail(error, "nombre JSON attendu");
	if (pos < text.size() && text[pos] == '.') {
		pos++;
		const size_t fraction_start = pos;
		while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') pos++;
		if (pos == fraction_start) return JsonFail(error, "fraction JSON invalide");
	}
	if (!JsonDelimiter(text, pos)) return JsonFail(error, "nombre JSON invalide");

	const std::string token(text.substr(start, pos - start));
	char *end = nullptr;
	out = std::strtod(token.c_str(), &end);
	if (end == nullptr || *end != '\0') return JsonFail(error, "nombre JSON invalide");
	return true;
}

bool ReadJsonInt(std::string_view text, size_t &pos, int &out, std::string &error)
{
	if (pos >= text.size() || !((text[pos] >= '0' && text[pos] <= '9') || text[pos] == '-')) {
		return JsonFail(error, "un entier est attendu");
	}
	double value = 0;
	if (!ParseJsonNumber(text, pos, value, error)) return false;
	if (value != static_cast<double>(static_cast<int>(value))) {
		return JsonFail(error, "un entier est attendu");
	}
	out = static_cast<int>(value);
	return true;
}

std::optional<LandscapeType> ParseClimate(std::string_view value)
{
	if (value == "temperate") return LandscapeType::Temperate;
	if (value == "subarctic" || value == "arctic") return LandscapeType::Arctic;
	if (value == "subtropical" || value == "tropic") return LandscapeType::Tropic;
	if (value == "toyland") return LandscapeType::Toyland;
	return std::nullopt;
}

std::optional<int> ParseDifficulty(std::string_view value)
{
	if (value == "easy" || value == "facile") return 0;
	if (value == "normal" || value == "normale") return 1;
	if (value == "hard" || value == "difficile") return 2;
	if (value == "expert") return 3;
	return std::nullopt;
}

/**
 * Analyse un objet JSON plat de configuration de partie.
 * @param json texte JSON (vide, `null` ou objet).
 * @param[out] config configuration analysée (réinitialisée).
 * @param[out] error message lisible en cas d'échec.
 * @return true si la configuration est valide.
 */
bool ParseGameConfig(std::string_view json, GameSetupConfig &config, std::string &error)
{
	config = GameSetupConfig{};
	size_t pos = 0;
	SkipJsonSpace(json, pos);
	if (pos >= json.size()) return true;
	if (json.substr(pos) == "null") return true;
	if (json[pos] != '{') return JsonFail(error, "configuration : objet JSON attendu");

	pos++;
	std::unordered_set<std::string> seen;
	bool first_field = true;
	for (;;) {
		SkipJsonSpace(json, pos);
		if (pos >= json.size()) return JsonFail(error, "configuration : objet JSON incomplet");
		if (json[pos] == '}') {
			pos++;
			break;
		}
		if (!first_field) {
			if (json[pos] != ',') return JsonFail(error, "configuration : virgule attendue entre les champs");
			pos++;
			SkipJsonSpace(json, pos);
		}
		first_field = false;

		std::string key;
		if (!ParseJsonString(json, pos, key, error)) return false;
		if (!seen.insert(key).second) {
			return JsonFail(error, fmt::format("configuration : champ « {} » dupliqué", key));
		}

		SkipJsonSpace(json, pos);
		if (pos >= json.size() || json[pos] != ':') {
			return JsonFail(error, fmt::format("configuration : « : » attendu après « {} »", key));
		}
		pos++;
		SkipJsonSpace(json, pos);

		/* `null` remet le champ à sa valeur par défaut (aucun effet). */
		if (json.substr(pos, 4) == "null" && JsonDelimiter(json, pos + 4)) {
			pos += 4;
			continue;
		}

		if (key == "climate" || key == "landscape") {
			std::string value;
			if (pos >= json.size() || json[pos] != '"' || !ParseJsonString(json, pos, value, error)) {
				return JsonFail(error, "configuration : « climate » doit être une chaîne");
			}
			const std::optional<LandscapeType> landscape = ParseClimate(value);
			if (!landscape.has_value()) {
				return JsonFail(error, fmt::format(
					"configuration : climat inconnu « {} » (temperate, subarctic, subtropical, toyland)", value));
			}
			config.landscape = *landscape;
		} else if (key == "start_year" || key == "startYear") {
			int value = 0;
			if (!ReadJsonInt(json, pos, value, error)) return false;
			config.start_year = value;
		} else if (key == "difficulty") {
			if (pos < json.size() && json[pos] == '"') {
				std::string value;
				if (!ParseJsonString(json, pos, value, error)) return false;
				const std::optional<int> difficulty = ParseDifficulty(value);
				if (!difficulty.has_value()) {
					return JsonFail(error, fmt::format(
						"configuration : difficulté inconnue « {} » (easy, normal, hard, expert)", value));
				}
				config.difficulty = *difficulty;
			} else {
				int value = 0;
				if (!ReadJsonInt(json, pos, value, error)) return false;
				config.difficulty = value;
			}
		} else if (key == "ai_companies" || key == "aiCompanies") {
			int value = 0;
			if (!ReadJsonInt(json, pos, value, error)) return false;
			config.ai_companies = value;
		} else if (key == "towns") {
			int value = 0;
			if (!ReadJsonInt(json, pos, value, error)) return false;
			config.towns = value;
		} else if (key == "industries") {
			int value = 0;
			if (!ReadJsonInt(json, pos, value, error)) return false;
			config.industries = value;
		} else if (key == "map_size" || key == "mapSize" || key == "size" || key == "width" || key == "height") {
			int value = 0;
			if (!ReadJsonInt(json, pos, value, error)) return false;
			config.map_size = value;
		} else if (key == "disasters") {
			if (json.substr(pos, 4) == "true" && JsonDelimiter(json, pos + 4)) {
				pos += 4;
				config.disasters = true;
			} else if (json.substr(pos, 5) == "false" && JsonDelimiter(json, pos + 5)) {
				pos += 5;
				config.disasters = false;
			} else {
				return JsonFail(error, "configuration : « disasters » doit être un booléen");
			}
		} else if (key == "game_name" || key == "gameName" || key == "name") {
			std::string value;
			if (pos >= json.size() || json[pos] != '"' || !ParseJsonString(json, pos, value, error)) {
				return JsonFail(error, "configuration : « game_name » doit être une chaîne");
			}
			config.game_name = value;
		} else if (key == "companies") {
			/* Tableau d'objets `{name, colour?}` : profil de chaque entreprise
			 * humaine, dans l'ordre des ids 0..n-1 (#99). */
			if (pos >= json.size() || json[pos] != '[') {
				return JsonFail(error, "configuration : « companies » doit être un tableau");
			}
			pos++;
			SkipJsonSpace(json, pos);
			std::vector<CompanyProfile> companies;
			if (pos < json.size() && json[pos] == ']') {
				pos++;
			} else {
				for (;;) {
					SkipJsonSpace(json, pos);
					if (pos >= json.size() || json[pos] != '{') {
						return JsonFail(error, "configuration : chaque entreprise doit être un objet");
					}
					pos++;
					CompanyProfile profile;
					bool first_company_field = true;
					for (;;) {
						SkipJsonSpace(json, pos);
						if (pos >= json.size()) {
							return JsonFail(error, "configuration : entreprise JSON incomplète");
						}
						if (json[pos] == '}') {
							pos++;
							break;
						}
						if (!first_company_field) {
							if (json[pos] != ',') {
								return JsonFail(error, "configuration : virgule attendue entre les champs d'entreprise");
							}
							pos++;
							SkipJsonSpace(json, pos);
						}
						first_company_field = false;

						std::string field;
						if (!ParseJsonString(json, pos, field, error)) return false;
						SkipJsonSpace(json, pos);
						if (pos >= json.size() || json[pos] != ':') {
							return JsonFail(error, fmt::format("configuration : « : » attendu après « {} »", field));
						}
						pos++;
						SkipJsonSpace(json, pos);

						if (field == "name") {
							if (pos >= json.size() || json[pos] != '"' ||
									!ParseJsonString(json, pos, profile.name, error)) {
								return JsonFail(error, "configuration : « companies[].name » doit être une chaîne");
							}
						} else if (field == "colour" || field == "color") {
							int colour = 0;
							if (!ReadJsonInt(json, pos, colour, error)) return false;
							if (colour < 0 || colour > 15) {
								return JsonFail(error, fmt::format(
									"configuration : couleur d'entreprise {} hors bornes (0..15)", colour));
							}
							profile.colour = colour;
						} else {
							return JsonFail(error, fmt::format(
								"configuration : champ d'entreprise inconnu « {} »", field));
						}
					}
					if (profile.name.empty()) {
						return JsonFail(error, "configuration : « companies[].name » est requis");
					}
					companies.push_back(std::move(profile));
					SkipJsonSpace(json, pos);
					if (pos >= json.size()) return JsonFail(error, "configuration : tableau « companies » incomplet");
					if (json[pos] == ',') {
						pos++;
						continue;
					}
					if (json[pos] == ']') {
						pos++;
						break;
					}
					return JsonFail(error, "configuration : virgule attendue dans « companies »");
				}
			}
			if (companies.size() > MAX_COMPANIES) {
				return JsonFail(error, fmt::format(
					"configuration : {} entreprises humaines au maximum", static_cast<int>(MAX_COMPANIES)));
			}
			config.companies = std::move(companies);
		} else {
			return JsonFail(error, fmt::format("configuration : champ inconnu « {} »", key));
		}
	}

	SkipJsonSpace(json, pos);
	if (pos != json.size()) return JsonFail(error, "configuration : caractères en trop après l'objet JSON");
	return true;
}

/** Préréglages de difficulté appliqués avant la génération (0 = facile). */
struct DifficultyPreset {
	uint32_t max_loan;
	uint8_t initial_interest;
	uint8_t vehicle_costs;
	uint8_t construction_cost;
	uint8_t competitor_speed;
	uint8_t town_council_tolerance;
	bool disasters;
};

/**
 * Préréglages exposés par l'API (#60). Le niveau 1 « normale » correspond
 * exactement aux défauts d'OpenTTD 15.3 : une partie sans difficulté explicite
 * et une partie `difficulty: 1` produisent donc le même monde.
 */
static constexpr DifficultyPreset DIFFICULTY_PRESETS[4] = {
	{500000, 2, 0, 0, 2, 0, false}, // 0 facile
	{300000, 2, 0, 0, 2, 0, false}, // 1 normale (défauts OpenTTD)
	{200000, 3, 1, 1, 3, 1, true},  // 2 difficile
	{100000, 4, 2, 2, 4, 2, true},  // 3 expert
};

bool ApplyDifficultyPreset(int level, std::string &error)
{
	if (level < 0 || level >= static_cast<int>(std::size(DIFFICULTY_PRESETS))) {
		return JsonFail(error, fmt::format("configuration : difficulté {} hors bornes (0..3)", level));
	}
	const DifficultyPreset &preset = DIFFICULTY_PRESETS[level];
	_settings_newgame.difficulty.max_loan = preset.max_loan;
	_settings_newgame.difficulty.initial_interest = preset.initial_interest;
	_settings_newgame.difficulty.vehicle_costs = preset.vehicle_costs;
	_settings_newgame.difficulty.construction_cost = preset.construction_cost;
	_settings_newgame.difficulty.competitor_speed = preset.competitor_speed;
	_settings_newgame.difficulty.town_council_tolerance = preset.town_council_tolerance;
	_settings_newgame.difficulty.disasters = preset.disasters;
	return true;
}

/**
 * Valide puis applique la configuration à `_settings_newgame`.
 * `StartNewGameWithoutGUI()` recopie ensuite ces réglages dans `_settings_game`
 * (`MakeNewgameSettingsLive`), exactement comme le fait l'interface OpenTTD.
 */
bool ApplyGameConfig(const GameSetupConfig &config, uint32_t w, uint32_t h, std::string &error)
{
	if (config.map_size.has_value()) {
		const int size = *config.map_size;
		if (!IsPowerOfTwo(static_cast<uint32_t>(size)) || size < 64 || size > 4096) {
			return JsonFail(error, fmt::format(
				"configuration : map_size {} invalide (puissance de 2 entre 64 et 4096)", size));
		}
		if (static_cast<uint32_t>(size) != w || static_cast<uint32_t>(size) != h) {
			return JsonFail(error, fmt::format(
				"configuration : map_size {} incompatible avec les dimensions {}x{}", size, w, h));
		}
	}

	if (config.landscape.has_value()) {
		_settings_newgame.game_creation.landscape = *config.landscape;
	}

	if (config.start_year.has_value()) {
		const int year = *config.start_year;
		if (year < 1800 || year > 2200) {
			return JsonFail(error, fmt::format("configuration : année de départ {} hors bornes (1800..2200)", year));
		}
		_settings_newgame.game_creation.starting_year = TimerGameCalendar::Year{year};
		/* La fin de partie par défaut (2050) précéderait une année de départ
		 * tardive : on garde au moins 50 années de jeu, comme l'UI OpenTTD. */
		const TimerGameCalendar::Year minimum_end{year + 50};
		if (_settings_newgame.game_creation.ending_year < minimum_end) {
			_settings_newgame.game_creation.ending_year = minimum_end;
		}
	}

	if (config.difficulty.has_value() && !ApplyDifficultyPreset(*config.difficulty, error)) return false;

	if (config.towns.has_value()) {
		const int towns = *config.towns;
		if (towns < 1 || towns > static_cast<int>(CUSTOM_TOWN_MAX_NUMBER)) {
			return JsonFail(error, fmt::format(
				"configuration : nombre de villes {} hors bornes (1..{})", towns, CUSTOM_TOWN_MAX_NUMBER));
		}
		_settings_newgame.difficulty.number_towns = static_cast<uint8_t>(CUSTOM_TOWN_NUMBER_DIFFICULTY);
		_settings_newgame.game_creation.custom_town_number = static_cast<uint16_t>(towns);
	}

	if (config.industries.has_value()) {
		const int industries = *config.industries;
		if (industries < 1 || industries > static_cast<int>(IndustryPool::MAX_SIZE)) {
			return JsonFail(error, fmt::format(
				"configuration : nombre d'industries {} hors bornes (1..{})", industries, IndustryPool::MAX_SIZE));
		}
		_settings_newgame.difficulty.industry_density = static_cast<uint8_t>(ID_CUSTOM);
		_settings_newgame.game_creation.custom_industry_number = static_cast<uint16_t>(industries);
	}

	if (config.disasters.has_value()) _settings_newgame.difficulty.disasters = *config.disasters;

	if (config.ai_companies.has_value()) {
		const int count = *config.ai_companies;
		if (count < 0 || count >= static_cast<int>(MAX_COMPANIES)) {
			return JsonFail(error, fmt::format(
				"configuration : nombre d'IA {} hors bornes (0..{})", count, MAX_COMPANIES - 1));
		}
		/* Les entreprises humaines (#99) occupent les premiers emplacements :
		 * le total humains + IA doit tenir dans MAX_COMPANIES. */
		const int humans = config.companies.empty() ? 1 : static_cast<int>(config.companies.size());
		if (humans + count > static_cast<int>(MAX_COMPANIES)) {
			return JsonFail(error, fmt::format(
				"configuration : {} entreprises humaines + {} IA dépassent la limite de {}",
				humans, count, static_cast<int>(MAX_COMPANIES)));
		}
		/* Reflète la demande dans les réglages de difficulté (fenêtre IA,
		 * remplacement des faillites) ; la création effective est faite
		 * explicitement après la génération, de façon déterministe. */
		_settings_newgame.difficulty.max_no_competitors = static_cast<uint8_t>(count);
	}

	return true;
}

/** Nom protocolaire d'un climat. */
const char *LandscapeName(LandscapeType landscape)
{
	switch (landscape) {
		case LandscapeType::Temperate: return "temperate";
		case LandscapeType::Arctic:    return "subarctic";
		case LandscapeType::Tropic: return "subtropical";
		case LandscapeType::Toyland:   return "toyland";
		default:                       return "unknown";
	}
}

/** Pompe une itération de la boucle de jeu, sans rendu ni attente. */
inline void PumpOneTick()
{
	::GameLoop();
	::InputLoop();
	::UpdateWindows();
}

uint64_t HashBytes(uint64_t hash, const void *data, size_t size)
{
	const uint8_t *bytes = static_cast<const uint8_t *>(data);
	for (size_t i = 0; i < size; i++) {
		hash ^= bytes[i];
		hash *= 0x100000001b3ULL;
	}
	return hash;
}

template <typename T>
uint64_t HashValue(uint64_t hash, const T &value)
{
	return HashBytes(hash, &value, sizeof(value));
}

/** Nombre de véhicules appartenant à une entreprise (hors effets/désastres). */
uint32_t CountCompanyVehicles()
{
	uint32_t count = 0;
	for (const Vehicle *v : Vehicle::Iterate()) {
		if (v->type < VEH_COMPANY_END) count++;
	}
	return count;
}

/** Hash FNV-1a de l'état simulé : carte, compteurs globaux et véhicules. */
uint64_t ComputeStateHash()
{
	uint64_t hash = 0xcbf29ce484222325ULL;

	const uint32_t width = _ottd_in_game ? Map::SizeX() : 0;
	const uint32_t height = _ottd_in_game ? Map::SizeY() : 0;
	hash = HashValue(hash, width);
	hash = HashValue(hash, height);
	hash = HashValue(hash, TimerGameTick::counter);

	if (!_ottd_in_game) return hash;

	const uint32_t companies = static_cast<uint32_t>(Company::GetNumItems());
	const uint32_t towns = static_cast<uint32_t>(Town::GetNumItems());
	const uint32_t stations = static_cast<uint32_t>(Station::GetNumItems());
	const uint32_t vehicles = CountCompanyVehicles();
	hash = HashValue(hash, companies);
	hash = HashValue(hash, towns);
	hash = HashValue(hash, stations);
	hash = HashValue(hash, vehicles);

	for (uint index = 0; index < Map::Size(); index++) {
		Tile tile{TileIndex(index)};
		const uint8_t type = static_cast<uint8_t>(GetTileType(tile));
		const uint8_t tile_height = static_cast<uint8_t>(TileHeight(tile));
		const uint8_t owner = GetTileOwner(tile).base();
		const uint8_t slope = static_cast<uint8_t>(GetTileSlope(tile));
		const uint16_t m8 = tile.m8();
		hash = HashBytes(hash, &type, sizeof(type));
		hash = HashBytes(hash, &tile_height, sizeof(tile_height));
		hash = HashBytes(hash, &owner, sizeof(owner));
		hash = HashBytes(hash, &slope, sizeof(slope));
		hash = HashBytes(hash, &m8, sizeof(m8));
	}

	for (const Vehicle *v : Vehicle::Iterate()) {
		hash = HashValue(hash, v->index.base());
		hash = HashValue(hash, v->type);
		hash = HashValue(hash, v->x_pos);
		hash = HashValue(hash, v->y_pos);
		hash = HashValue(hash, v->z_pos);
		hash = HashValue(hash, v->direction);
		hash = HashValue(hash, v->cur_speed);
		hash = HashValue(hash, v->vehstatus.base());
	}

	return hash;
}

/* ------------------------------------------------------------------------- */
/*  Carte : format binaire v1                                                */
/* ------------------------------------------------------------------------- */

/*
 * Disposition (little-endian, toutes les sections font `width * height` octets,
 * indexées `y * width + x`) :
 *
 *   offset 0   en-tête de 64 octets (voir ci-dessous)
 *   offset 64  répertoire : 6 entrées de 12 octets
 *   offset 136 données : 6 sections contiguës de `tile_count` octets
 *
 * En-tête (u32 sauf mention) :
 *   0  magic         0x314D544F ("OTM1")
 *   4  version       u16 = 1
 *   6  header_size   u16 = 64
 *   8  width
 *   12 height
 *   16 tile_count    width * height
 *   20 layer_count   = 6
 *   24 sequence      compteur de snapshot carte
 *   28 tick          TimerGameTick::counter
 *   32 flags         bit 0 = snapshot complet
 *   36 data_offset   = 136
 *   40 directory_offset = 64
 *   44 bytes_per_layer  = tile_count
 *   48 reserved (0)
 *   52 reserved (0)
 *   56 reserved (0)
 *   60 reserved (0)
 *
 * Entrée de répertoire (12 octets) :
 *   0  layer_id      u8  (1 kind, 2 heightMap, 3 owner, 4 slope, 5 flags,
 *                        6 trackBits)
 *   1  elem_size     u8  = 1
 *   2  flags         u16 = 0
 *   4  offset        u32 (absolu depuis le début du buffer)
 *   8  length        u32 (= tile_count)
 */
static constexpr uint32_t OTTD_MAP_MAGIC = 0x314D544F; ///< "OTM1" en little-endian.
/* v2 : ajout de la couche `signalData` (#156), lisible par le frontend. */
static constexpr uint16_t OTTD_MAP_VERSION = 2;
static constexpr uint16_t OTTD_MAP_HEADER_SIZE = 64;
static constexpr uint16_t OTTD_MAP_DIRECTORY_ENTRY_SIZE = 12;
static constexpr uint8_t OTTD_MAP_LAYER_COUNT = 7;
static constexpr uint32_t OTTD_MAP_DATA_OFFSET = OTTD_MAP_HEADER_SIZE + OTTD_MAP_LAYER_COUNT * OTTD_MAP_DIRECTORY_ENTRY_SIZE;

enum MapLayer : uint8_t {
	MAP_LAYER_KIND = 1,
	MAP_LAYER_HEIGHT = 2,
	MAP_LAYER_OWNER = 3,
	MAP_LAYER_SLOPE = 4,
	MAP_LAYER_FLAGS = 5,
	MAP_LAYER_TRACK = 6,
	MAP_LAYER_SIGNAL = 7,
};

/* Index stables de `TILE_KIND_INDEX` dans src/engine/protocol.ts. */
enum TileKindIndex : uint8_t {
	TK_VOID = 0,
	TK_CLEAR = 1,
	TK_GRASS = 2,
	TK_ROUGH = 3,
	TK_WATER = 4,
	TK_COAST = 5,
	TK_RAIL = 6,
	TK_ROAD = 7,
	TK_HOUSE = 8,
	TK_TREES = 9,
	TK_STATION = 10,
	TK_INDUSTRY = 11,
	TK_BRIDGE = 12,
	TK_TUNNEL = 13,
	TK_OBJECT = 14,
	TK_AIRPORT = 15,
	TK_DOCK = 16,
	TK_CANAL = 17,
	TK_RIVER = 18,
	TK_LOCK = 19,
	TK_AQUEDUCT = 20,
	TK_CROSSING = 21,
};

/* Bits de `TILE_FLAG` dans src/engine/protocol.ts. */
enum TileFlagIndex : uint8_t {
	TF_WATER = 1 << 0,
	TF_SNOW = 1 << 1,
	TF_DESERT = 1 << 2,
	TF_RAINFOREST = 1 << 3,
	TF_BRIDGE = 1 << 4,
	TF_TUNNEL = 1 << 5,
	TF_SIGNAL = 1 << 6,
	TF_ELECTRIFIED = 1 << 7,
};

inline void WriteU16(uint8_t *out, uint16_t value)
{
	out[0] = static_cast<uint8_t>(value & 0xFF);
	out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

inline void WriteU32(uint8_t *out, uint32_t value)
{
	out[0] = static_cast<uint8_t>(value & 0xFF);
	out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
	out[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
	out[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

inline void WriteU64(uint8_t *out, uint64_t value)
{
	WriteU32(out, static_cast<uint32_t>(value & 0xFFFFFFFFULL));
	WriteU32(out + 4, static_cast<uint32_t>(value >> 32));
}

inline uint16_t ReadU16(const uint8_t *in)
{
	return static_cast<uint16_t>(in[0] | (in[1] << 8));
}

inline uint32_t ReadU32(const uint8_t *in)
{
	return static_cast<uint32_t>(in[0]) |
		(static_cast<uint32_t>(in[1]) << 8) |
		(static_cast<uint32_t>(in[2]) << 16) |
		(static_cast<uint32_t>(in[3]) << 24);
}

inline uint64_t ReadU64(const uint8_t *in)
{
	return static_cast<uint64_t>(ReadU32(in)) | (static_cast<uint64_t>(ReadU32(in + 4)) << 32);
}

/** Taille totale du snapshot binaire pour la carte courante. */
uint32_t MapSnapshotBytes(uint32_t width, uint32_t height)
{
	return OTTD_MAP_DATA_OFFSET + OTTD_MAP_LAYER_COUNT * width * height;
}

/**
 * Propriétaire au sens du protocole : identifiant d'entreprise, ou 255 si la
 * tuile n'appartient à aucune entreprise (ville, eau, industrie, vide, etc.).
 */
uint8_t ProtocolOwner(Owner owner)
{
	const uint32_t id = owner.base();
	return id < MAX_COMPANIES ? static_cast<uint8_t>(id) : 255;
}

/** `GetTileOwner` n'est pas défini pour les tuiles ville/industrie/vide. */
uint8_t TileOwnerByte(Tile tile)
{
	switch (GetTileType(tile)) {
		case MP_VOID:
		case MP_HOUSE:
		case MP_INDUSTRY:
			return 255;
		default:
			return ProtocolOwner(GetTileOwner(tile));
	}
}

/** Type de tuile au sens du protocole (voir `TILE_KIND_INDEX`). */
uint8_t TileKind(Tile tile)
{
	switch (GetTileType(tile)) {
		case MP_CLEAR:
			switch (GetClearGround(tile)) {
				case CLEAR_GRASS:  return TK_GRASS;
				case CLEAR_ROUGH:  return TK_ROUGH;
				case CLEAR_ROCKS:  return TK_ROUGH;
				case CLEAR_FIELDS: return TK_CLEAR;
				case CLEAR_SNOW:   return TK_GRASS;
				case CLEAR_DESERT: return TK_GRASS;
				default:           return TK_CLEAR;
			}

		case MP_RAILWAY:
			return TK_RAIL;

		case MP_ROAD:
			return IsLevelCrossing(tile) ? TK_CROSSING : TK_ROAD;

		case MP_HOUSE:
			return TK_HOUSE;

		case MP_TREES:
			return TK_TREES;

		case MP_STATION:
			switch (GetStationType(tile)) {
				case StationType::Airport: return TK_AIRPORT;
				case StationType::Oilrig:
				case StationType::Dock:    return TK_DOCK;
				default:                   return TK_STATION;
			}

		case MP_WATER:
			if (IsLock(tile)) return TK_LOCK;
			if (IsCoast(tile)) return TK_COAST;
			switch (GetWaterClass(tile)) {
				case WaterClass::Canal: return TK_CANAL;
				case WaterClass::River: return TK_RIVER;
				default:                return TK_WATER;
			}

		case MP_VOID:
			return TK_VOID;

		case MP_INDUSTRY:
			return TK_INDUSTRY;

		case MP_TUNNELBRIDGE:
			if (!IsBridgeTile(tile)) return TK_TUNNEL;
			return GetTunnelBridgeTransportType(tile) == TRANSPORT_WATER ? TK_AQUEDUCT : TK_BRIDGE;

		case MP_OBJECT:
			return TK_OBJECT;

		default:
			return TK_VOID;
	}
}

/** Drapeaux de tuile (voir `TILE_FLAG`). */
uint8_t TileFlags(Tile tile, uint8_t snow_line)
{
	uint8_t flags = 0;
	if (IsBridgeAbove(tile)) flags |= TF_BRIDGE;

	switch (GetTileType(tile)) {
		case MP_WATER:
			flags |= TF_WATER;
			break;

		case MP_TREES:
			/* Arbres sur berge : classés "coast" côté type, mais l'eau reste
			 * signalée pour le rendu. */
			if (GetWaterClass(tile) != WaterClass::Invalid) flags |= TF_WATER;
			break;

		case MP_TUNNELBRIDGE:
			if (IsBridgeTile(tile)) {
				flags |= TF_BRIDGE;
			} else {
				flags |= TF_TUNNEL;
			}
			if (GetTunnelBridgeTransportType(tile) == TRANSPORT_WATER) flags |= TF_WATER;
			break;

		case MP_RAILWAY:
			if (HasSignals(tile)) flags |= TF_SIGNAL;
			if (HasRailCatenary(GetRailType(tile))) flags |= TF_ELECTRIFIED;
			break;

		default:
			break;
	}

	switch (GetTropicZone(tile)) {
		case TROPICZONE_DESERT:    flags |= TF_DESERT; break;
		case TROPICZONE_RAINFOREST: flags |= TF_RAINFOREST; break;
		default: break;
	}

	if (_settings_game.game_creation.landscape == LandscapeType::Arctic && GetTileZ(tile) > snow_line) {
		flags |= TF_SNOW;
	}

	return flags;
}

/**
 * Encode les bits de signal d'une tuile (#156).
 *
 * Disposition, alignée sur `src/game/signalRules.ts` :
 *   bits 0..2 : type (1 bloc, 2 path/PBS, 3 entrée, 4 sortie, 5 combiné)
 *   bit 3     : 1 = bidirectionnel
 *   bits 4..5 : état (0 vert, 1 rouge, 2 jaune — OpenTTD n'émet que 0/1)
 *   bit 6     : 1 = sémaphore
 *
 * Une tuile peut porter des signaux de types différents selon la voie ; le
 * rendu n'affiche qu'un mât par tuile, on choisit donc la première voie
 * pourvue d'un signal dans l'ordre stable de `Track`.
 */
uint8_t PackSignalData(Tile tile)
{
	if (!IsPlainRailTile(tile) || !HasSignals(tile)) return 0;
	const uint8_t present = static_cast<uint8_t>(GetPresentSignals(tile));
	if (present == 0) return 0;

	static constexpr Track kTracks[] = {
		TRACK_X, TRACK_Y, TRACK_UPPER, TRACK_LOWER, TRACK_LEFT, TRACK_RIGHT,
	};
	Track track = INVALID_TRACK;
	for (const Track candidate : kTracks) {
		if ((present & SignalOnTrack(candidate)) != 0) {
			track = candidate;
			break;
		}
	}
	if (track == INVALID_TRACK) return 0;

	uint8_t kind = 0;
	switch (GetSignalType(tile, track)) {
		case SIGTYPE_BLOCK: kind = 1; break;
		case SIGTYPE_PBS:
		case SIGTYPE_PBS_ONEWAY: kind = 2; break;
		case SIGTYPE_ENTRY: kind = 3; break;
		case SIGTYPE_EXIT: kind = 4; break;
		case SIGTYPE_COMBO: kind = 5; break;
		default: return 0;
	}

	const uint8_t both = ((present & 0x3) == 0x3 || (present & 0xC) == 0xC) ? 1 : 0;
	const uint32_t states = GetSignalStates(tile);
	uint8_t aspect = 0; /* vert par défaut */
	for (int bit = 0; bit < 8; bit++) {
		if ((present & (1U << bit)) == 0) continue;
		aspect = (states & (1U << bit)) != 0 ? 0 : 1;
		break;
	}
	const uint8_t semaphore = GetSignalVariant(tile, track) == SIG_SEMAPHORE ? 1 : 0;
	return static_cast<uint8_t>(kind | (both << 3) | (aspect << 4) | (semaphore << 6));
}

/** Famille de pont exposée au protocole (#154). */
const char *BridgeMaterialName(BridgeType type)
{
	switch (type) {
		case 0: return "wood";
		case 1: return "concrete";
		case 2: case 9: return "steel";
		case 3: case 4: case 5: return "suspension";
		case 6: case 7: case 8: return "cantilever";
		case 10: case 11: case 12: return "tubular";
		default: return "wood";
	}
}

/* ------------------------------------------------------------------------- */
/*  JSON : helpers                                                           */
/* ------------------------------------------------------------------------- */

/** Échappe une chaîne UTF-8 pour l'insérer telle quelle dans du JSON. */
void AppendJsonString(std::string &out, std::string_view text)
{
	out.push_back('"');
	for (const unsigned char c : text) {
		switch (c) {
			case '"':  out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\b': out += "\\b"; break;
			case '\f': out += "\\f"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if (c < 0x20) {
					out += fmt::format("\\u{:04x}", static_cast<unsigned>(c));
				} else {
					out.push_back(static_cast<char>(c));
				}
				break;
		}
	}
	out.push_back('"');
}

/** Nom lisible d'un type de cargo, ou "invalid" si l'indice est hors borne. */
std::string CargoName(CargoType cargo)
{
	if (!IsValidCargoType(cargo)) return "invalid";
	return GetString(CargoSpec::Get(cargo)->name);
}

/** Slug protocolaire stable d'une cargaison (#160). */
std::string CargoSlug(CargoType cargo)
{
	if (!IsValidCargoType(cargo)) return "invalid";
	const CargoLabel label = CargoSpec::Get(cargo)->label;
	if (label == CT_PASSENGERS) return "passengers";
	if (label == CT_MAIL) return "mail";
	if (label == CT_COAL) return "coal";
	if (label == CT_WOOD) return "wood";
	if (label == CT_GRAIN) return "grain";
	if (label == CT_GOODS) return "goods";
	if (label == CT_OIL) return "oil";
	if (label == CT_LIVESTOCK) return "livestock";
	if (label == CT_VALUABLES) return "valuables";
	if (label == CT_IRON_ORE) return "iron_ore";
	if (label == CT_STEEL) return "steel";
	if (label == CT_WATER) return "water";
	if (label == CT_FRUIT) return "fruit";
	if (label == CT_MAIZE) return "maize";
	if (label == CT_FOOD) return "food";
	/* NewGRF : repli sur le nom localisé, jamais sur un index instable. */
	return CargoName(cargo);
}

/** CargoType correspondant à un slug du protocole, ou `INVALID_CARGO`. */
CargoType CargoTypeFromSlug(std::string_view slug)
{
	struct Entry {
		const char *name;
		CargoLabel label;
	};
	static const Entry entries[] = {
		{"passengers", CT_PASSENGERS},
		{"mail", CT_MAIL},
		{"coal", CT_COAL},
		{"wood", CT_WOOD},
		{"grain", CT_GRAIN},
		{"goods", CT_GOODS},
		{"oil", CT_OIL},
		{"livestock", CT_LIVESTOCK},
		{"valuables", CT_VALUABLES},
		{"iron_ore", CT_IRON_ORE},
		{"steel", CT_STEEL},
		{"water", CT_WATER},
		{"fruit", CT_FRUIT},
		{"maize", CT_MAIZE},
		{"food", CT_FOOD},
	};
	for (const Entry &entry : entries) {
		if (slug == entry.name) {
			const CargoType cargo = GetCargoTypeByLabel(entry.label);
			if (IsValidCargoType(cargo)) return cargo;
		}
	}
	return INVALID_CARGO;
}

/** Nom d'une entreprise, avec repli stable quand le nom n'est pas encore généré. */
std::string CompanyName(const Company *c)
{
	if (!c->name.empty()) return c->name;
	if (c->name_1 != INVALID_STRING_ID) return GetString(c->name_1, c->name_2);
	return fmt::format("Company {}", c->index.base() + 1);
}

/* ------------------------------------------------------------------------- */
/*  Autorité locale et subventions (#165/#166)                               */
/* ------------------------------------------------------------------------- */

/** Coût courant d'une action municipale, inflation des prix comprise. */
Money TownActionCost(TownAction action)
{
	return static_cast<Money>(_price[PR_TOWN_ACTION]) * GetTownActionCost(action) >> 8;
}

/** Nom JSON stable d'une action municipale exposée par le protocole. */
const char *TownActionKey(TownAction action)
{
	switch (action) {
		case TownAction::AdvertiseSmall:
		case TownAction::AdvertiseMedium:
		case TownAction::AdvertiseLarge:
			return "advertise";
		case TownAction::RoadRebuild:
			return "fund_roads";
		case TownAction::FundBuildings:
			return "fund_buildings";
		default:
			return nullptr;
	}
}

/** Résout une action demandée par l'UI (advertise, fund_roads, fund_buildings). */
std::optional<TownAction> ParseTownAction(std::string_view name)
{
	if (name == "advertise" || name == "publicite" || name == "publicité") {
		return TownAction::AdvertiseSmall;
	}
	if (name == "fund_roads" || name == "roads" || name == "routes") {
		return TownAction::RoadRebuild;
	}
	if (name == "fund_buildings" || name == "buildings" || name == "batiments" ||
			name == "bâtiments") {
		return TownAction::FundBuildings;
	}
	return std::nullopt;
}

/** Nom lisible d'une extrémité de subvention (ville ou industrie). */
std::string SubsidySourceName(const Source &source)
{
	if (source.type == SourceType::Industry) {
		const Industry *industry = Industry::GetIfValid(IndustryID(source.id));
		if (industry != nullptr) return industry->GetCachedName();
	}
	if (source.type == SourceType::Town) {
		const Town *town = Town::GetIfValid(TownID(source.id));
		if (town != nullptr) return town->GetCachedName();
	}
	return "—";
}

const char *SubsidySourceKind(const Source &source)
{
	return source.type == SourceType::Town ? "town" : "industry";
}

std::string PresidentName(const Company *c)
{
	if (!c->president_name.empty()) return c->president_name;
	if (c->president_name_1 != INVALID_STRING_ID) return GetString(c->president_name_1, c->president_name_2);
	return {};
}

const char *VehicleKindName(VehicleType type)
{
	switch (type) {
		case VEH_TRAIN:    return "train";
		case VEH_ROAD:     return "road";
		case VEH_SHIP:     return "ship";
		case VEH_AIRCRAFT: return "aircraft";
		default:           return "unknown";
	}
}

/** Statut véhicule : 0 arrêté, 1 en route, 2 en gare, 3 en dépôt, 4 en attente. */
uint8_t VehicleStatus(const Vehicle *v)
{
	/* Un véhicule immobilisé dans un dépôt est « en dépôt » même sans ordre
	 * de retour : l'UI de refit/duplication s'appuie sur ce statut. */
	if (v->IsStoppedInDepot()) return 3;
	if (v->vehstatus.Test(VehState::Stopped)) return 0;
	if (IsTileType(v->tile, MP_STATION)) return 2;
	if (v->cur_speed == 0 && v->current_order.IsType(OT_GOTO_DEPOT)) return 3;
	if (v->cur_speed == 0) return 4;
	return 1;
}

/**
 * Cargaison agrégée d'un convoi. Pour un train, on additionne les capacités et
 * les quantités de tous les véhicules de la rame ; le type affiché est celui du
 * premier véhicule capable de porter du cargo (la motrice est souvent vide).
 */
void AppendVehicleCargo(std::string &out, const Vehicle *v)
{
	CargoType cargo = INVALID_CARGO;
	uint64_t amount = 0;
	uint64_t capacity = 0;

	for (const Vehicle *u = v; u != nullptr; u = u->Next()) {
		if (cargo == INVALID_CARGO && u->cargo_cap != 0 && IsValidCargoType(u->cargo_type)) {
			cargo = u->cargo_type;
		}
		amount += u->cargo.TotalCount();
		capacity += u->cargo_cap;
	}

	if (capacity == 0 && amount == 0) {
		out += "null";
		return;
	}
	if (cargo == INVALID_CARGO && IsValidCargoType(v->cargo_type)) cargo = v->cargo_type;

	out += "{\"type\":";
	AppendJsonString(out, CargoSlug(cargo));
	out += fmt::format(",\"amount\":{},\"capacity\":{}}}", amount, capacity);
}

/** Nom protocolaire du type d'ordre (#161). */
const char *OrderKindName(const Order &order)
{
	if (order.IsType(OT_GOTO_STATION) || order.IsType(OT_GOTO_WAYPOINT)) return "station";
	if (order.IsType(OT_GOTO_DEPOT)) return "depot";
	if (order.IsType(OT_CONDITIONAL)) return "conditional";
	return "unknown";
}

/** Mode d'arrêt protocolaire déduit des drapeaux OpenTTD (#161). */
const char *OrderActionName(const Order &order)
{
	if (order.IsType(OT_CONDITIONAL)) return "normal";
	const OrderUnloadType unload = order.GetUnloadType();
	const OrderLoadType load = order.GetLoadType();
	if (unload == OrderUnloadType::Transfer) return "transfer";
	if (unload == OrderUnloadType::Unload && load == OrderLoadType::NoLoad) return "unload";
	if (load == OrderLoadType::NoLoad) return "no_load";
	if (load == OrderLoadType::FullLoad || load == OrderLoadType::FullLoadAny) return "full_load";
	return "normal";
}

const char *OrderComparatorName(OrderConditionComparator comparator)
{
	switch (comparator) {
		case OrderConditionComparator::Equal:           return "equal";
		case OrderConditionComparator::NotEqual:        return "not_equal";
		case OrderConditionComparator::LessThan:        return "less";
		case OrderConditionComparator::LessThanOrEqual: return "less_or_equal";
		case OrderConditionComparator::MoreThan:        return "more";
		case OrderConditionComparator::MoreThanOrEqual: return "more_or_equal";
		default:                                        return "equal";
	}
}

/**
 * Options d'un ordre dans le snapshot (#161/#162).
 *
 * OpenTTD n'expose nativement que des conditions sur le pourcentage de
 * chargement, la fiabilité, l'âge, etc. Le pont ne restitue donc que
 * `percentage` ; les conditions argent/date/cargaison restent une extension
 * du mock et sont refusées explicitement à l'écriture.
 */
void AppendOrderOptions(std::string &out, const Order &order, bool timetable_started)
{
	out += "{\"action\":";
	AppendJsonString(out, OrderActionName(order));

	if (order.IsType(OT_CONDITIONAL)) {
		out += ",\"condition\":{\"type\":\"percentage\",\"comparator\":";
		AppendJsonString(out, OrderComparatorName(order.GetConditionComparator()));
		out += fmt::format(",\"value\":{}", order.GetConditionValue());
		out += "},\"jump\":";
		out += fmt::format("{}", order.GetConditionSkipToOrder());
	} else {
		const uint16_t wait = order.GetTimetabledWait();
		const uint16_t travel = order.GetTimetabledTravel();
		if (wait > 0 || travel > 0 || timetable_started) {
			out += ",\"timetable\":{";
			bool first = true;
			if (wait > 0) {
				out += fmt::format("\"waitTicks\":{}", wait);
				first = false;
			}
			if (travel > 0) {
				if (!first) out.push_back(',');
				out += fmt::format("\"travelTicks\":{}", travel);
				first = false;
			}
			if (timetable_started) {
				if (!first) out.push_back(',');
				out += "\"autostart\":true";
			}
			out.push_back('}');
		}
	}
	out.push_back('}');
}

/** Union des emprises d'une gare, en tuiles. */
struct StationExtent {
	bool valid = false;
	uint32_t min_x = 0;
	uint32_t min_y = 0;
	uint32_t max_x = 0;
	uint32_t max_y = 0;

	void Add(const TileArea &area)
	{
		if (area.tile == INVALID_TILE || area.w == 0 || area.h == 0) return;

		const uint32_t x0 = TileX(area.tile);
		const uint32_t y0 = TileY(area.tile);
		const uint32_t x1 = x0 + area.w - 1;
		const uint32_t y1 = y0 + area.h - 1;

		if (!this->valid) {
			this->valid = true;
			this->min_x = x0;
			this->min_y = y0;
			this->max_x = x1;
			this->max_y = y1;
			return;
		}

		this->min_x = std::min(this->min_x, x0);
		this->min_y = std::min(this->min_y, y0);
		this->max_x = std::max(this->max_x, x1);
		this->max_y = std::max(this->max_y, y1);
	}
};

StationExtent GetStationExtent(const Station *st)
{
	StationExtent extent;
	extent.Add(st->train_station);
	extent.Add(st->bus_station);
	extent.Add(st->truck_station);
	extent.Add(st->ship_station);
	extent.Add(st->airport);
	/* Dernier recours : la tuile du panneau. */
	if (!extent.valid) extent.Add(TileArea(st->xy, 1, 1));
	return extent;
}

const char *StationKindName(const Station *st)
{
	if (st->facilities.Test(StationFacility::Train)) return "train";
	if (st->facilities.Test(StationFacility::Airport)) return "airport";
	if (st->facilities.Test(StationFacility::Dock)) return "ship";
	if (st->facilities.Test(StationFacility::TruckStop) ||
			st->facilities.Test(StationFacility::BusStop)) return "road";
	return "train";
}

/**
 * Type de dépôt exposé par le protocole (`road` ou `rail`), ou `nullptr` pour
 * les dépôts non couverts en v1 (maritime, hangar d'aéroport).
 */
const char *DepotKindName(TileIndex tile)
{
	switch (GetTileType(tile)) {
		case MP_ROAD:    return "road";
		case MP_RAILWAY: return "rail";
		default:         return nullptr;
	}
}

/**
 * Direction d'entrée d'un dépôt routier ou ferroviaire (0..3, `DiagDirection` :
 * 0 = NE, 1 = SE, 2 = SW, 3 = NW).
 */
uint8_t DepotDirection(TileIndex tile)
{
	if (GetTileType(tile) == MP_ROAD) {
		return static_cast<uint8_t>(GetRoadDepotDirection(tile));
	}
	return static_cast<uint8_t>(GetRailDepotDirection(tile));
}

/** Nombre de dépôts route/rail, c'est-à-dire ceux exposés dans `depots`. */
uint32_t CountProtocolDepots()
{
	uint32_t count = 0;
	for (const Depot *d : Depot::Iterate()) {
		if (DepotKindName(d->xy) != nullptr) count++;
	}
	return count;
}

/**
 * Expose les véhicules de désastre d'OpenTTD (#172) avec un type stable du
 * protocole. Les ombres, rotors et sous-marins n'ont pas d'équivalent visuel
 * dans le rendu OpenTT3D et sont ignorés ; les aéronefs et UFO deviennent des
 * « aircraft_crash ». Les vrais incendies restent simulés par le mock, OpenTTD
 * ne modélisant que des catastrophes scénarisées.
 */
const char *DisasterKindName(DisasterSubType subtype)
{
	switch (subtype) {
		case ST_ZEPPELINER:
		case ST_SMALL_UFO:
		case ST_BIG_UFO:
		case ST_BIG_UFO_DESTROYER:
		case ST_AIRPLANE:
		case ST_HELICOPTER:
			return "aircraft_crash";
		default:
			return nullptr;
	}
}

/** Sérialise les entités et l'économie dans `out` (JSON, sans la carte). */
void BuildWorldJson(std::string &out, uint32_t width, uint32_t height)
{
	const uint32_t tick = static_cast<uint32_t>(TimerGameTick::counter);
	const uint64_t hash = ComputeStateHash();
	/* La séquence n'est validée qu'après une écriture réussie : un appel de
	 * dimensionnement (`out == nullptr`) et l'écriture qui suit produisent
	 * ainsi exactement la même longueur de JSON. */
	const uint32_t sequence = _ottd_json_sequence + 1;

	const TimerGameCalendar::YearMonthDay ymd = TimerGameCalendar::ConvertDateToYMD(TimerGameCalendar::date);
	const uint32_t day_fraction = static_cast<uint32_t>(TimerGameTick::counter % Ticks::DAY_TICKS);
	const double speed = static_cast<double>(_game_speed) / 100.0;
	const GameSetupConfig &active = _ottd_active_config;
	/* Inflation cumulée en pourcentage : `inflation_prices` est un multiplicateur
	 * 16.16 (1.0 = 65536). Le pont ne publie jamais une valeur négative. */
	const double inflation = std::max(0.0,
			(static_cast<double>(_economy.inflation_prices) / 65536.0 - 1.0) * 100.0);

	const uint32_t companies = static_cast<uint32_t>(Company::GetNumItems());
	const uint32_t towns = static_cast<uint32_t>(Town::GetNumItems());
	const uint32_t industries = static_cast<uint32_t>(Industry::GetNumItems());
	const uint32_t stations = static_cast<uint32_t>(Station::GetNumItems());
	const uint32_t depots = CountProtocolDepots();

	/* Compteurs par entreprise, alignés sur la liste de véhicules émise
	 * (un train = une rame, pas un wagon). */
	std::array<uint32_t, MAX_COMPANIES> company_vehicles{};
	std::array<uint32_t, MAX_COMPANIES> company_stations{};
	uint32_t vehicles = 0;

	for (const Vehicle *v : Vehicle::Iterate()) {
		if (v->type >= VEH_COMPANY_END) continue;
		if (v->type == VEH_TRAIN && !v->IsFrontEngine()) continue;
		vehicles++;
		const uint32_t owner = v->owner.base();
		if (owner < MAX_COMPANIES) company_vehicles[owner]++;
	}
	for (const Station *st : Station::Iterate()) {
		const uint32_t owner = st->owner.base();
		if (owner < MAX_COMPANIES) company_stations[owner]++;
	}

	out.reserve(4096 + companies * 256 + towns * 160 + industries * 256 + stations * 256 +
			depots * 128 + vehicles * 256);

	out += fmt::format(
		"{{\"meta\":{{\"protocol\":1,\"tick\":{},\"hash\":\"0x{:016x}\",\"sequence\":{}}},"
		"\"economy\":{{\"year\":{},\"month\":{},\"day\":{},\"dayFraction\":{},\"speed\":{:.2f},\"paused\":{},"
		"\"inflation\":{:.2f},\"interestRate\":{},\"difficulty\":{},\"maxLoan\":{},\"loanInterval\":{}}},"
		"\"map\":{{\"width\":{},\"height\":{},\"encoding\":\"binary\",\"api\":\"ottd_snapshot_map\",\"bytes\":{},\"layers\":{},\"elementSize\":1}},",
		tick, hash, sequence,
		ymd.year.base(), ymd.month, ymd.day, day_fraction, speed, _pause_mode.Any() ? "true" : "false",
		inflation, _economy.interest_rate, active.difficulty.value_or(-1),
		static_cast<int64_t>(_economy.max_loan), static_cast<int64_t>(LOAN_INTERVAL),
		width, height, MapSnapshotBytes(width, height),
		static_cast<unsigned>(OTTD_MAP_LAYER_COUNT));

	out += fmt::format(
		"\"counts\":{{\"companies\":{},\"towns\":{},\"industries\":{},\"stations\":{},\"depots\":{},"
		"\"vehicles\":{}}},",
		companies, towns, industries, stations, depots, vehicles);

	/* --- Configuration appliquée (issue #60) ------------------------------ */
	out += "\"config\":{\"climate\":";
	AppendJsonString(out, LandscapeName(_settings_game.game_creation.landscape));
	out += fmt::format(
		",\"startYear\":{},\"difficulty\":{},\"aiCompanies\":{},\"towns\":{},\"industries\":{},"
		"\"seed\":{},\"mapSize\":{},\"disasters\":{},\"gameName\":",
		_settings_game.game_creation.starting_year.base(),
		active.difficulty.value_or(-1),
		active.ai_companies.value_or(0),
		active.towns.value_or(-1),
		active.industries.value_or(-1),
		_settings_game.game_creation.generation_seed,
		Map::SizeX() == Map::SizeY() ? Map::SizeX() : 0,
		_settings_game.difficulty.disasters ? "true" : "false");
	AppendJsonString(out, active.game_name.value_or(""));
	out += "}";

	/* --- Avertissements non bloquants ------------------------------------- */
	out += ",\"warnings\":[";
	bool first_warning = true;
	for (const std::string &warning : _ottd_warnings) {
		if (!first_warning) out.push_back(',');
		first_warning = false;
		AppendJsonString(out, warning);
	}
	out.push_back(']');
	out.push_back(',');

	/* --- Entreprises ------------------------------------------------------ */
	out += "\"companies\":[";
	bool first = true;
	for (const Company *c : Company::Iterate()) {
		if (!first) out.push_back(',');
		first = false;

		const uint32_t id = c->index.base();
		const uint32_t vehicles_owned = id < MAX_COMPANIES ? company_vehicles[id] : 0;
		const uint32_t stations_owned = id < MAX_COMPANIES ? company_stations[id] : 0;

		out += fmt::format("{{\"id\":{},\"name\":", id);
		AppendJsonString(out, CompanyName(c));
		out += ",\"president\":";
		AppendJsonString(out, PresidentName(c));
		/* Niveau IA 1..3 (#168) : dérivé de la vitesse des concurrents.
		 * OpenTTD pilote toutes les IA avec le même script, la difficulté
		 * module donc leur rythme commun. */
		const int competitor_speed = _settings_game.difficulty.competitor_speed;
		const int ai_level = std::max(1, std::min(3, 1 + (competitor_speed >= 4 ? 2 : competitor_speed >= 3 ? 1 : 0)));
		out += fmt::format(
			",\"colour\":{},\"money\":{},\"loan\":{},\"maxLoan\":{},\"value\":{},\"income\":{},\"expenses\":{},"
			"\"vehicles\":{},\"stations\":{},\"isAI\":{},\"isLocal\":{},\"bankrupt\":{},"
			"\"monthsOfBankruptcy\":{},\"aiLevel\":{}}}",
			static_cast<unsigned>(c->colour),
			static_cast<int64_t>(c->money),
			static_cast<int64_t>(c->current_loan),
			static_cast<int64_t>(c->GetMaxLoan()),
			static_cast<int64_t>(CalculateCompanyValue(c)),
			static_cast<int64_t>(c->cur_economy.income),
			static_cast<int64_t>(c->cur_economy.expenses),
			vehicles_owned, stations_owned,
			c->is_ai ? "true" : "false",
			c->index == _local_company ? "true" : "false",
			c->months_of_bankruptcy > 0 ? "true" : "false",
			static_cast<unsigned>(c->months_of_bankruptcy),
			c->is_ai ? ai_level : 0);
	}
	out.push_back(']');

	/* --- Villes ------------------------------------------------------------ */
	out += ",\"towns\":[";
	first = true;
	for (const Town *t : Town::Iterate()) {
		if (!first) out.push_back(',');
		first = false;

		const int16_t rating = _local_company.base() < MAX_COMPANIES ? t->ratings[_local_company] : 0;

		out += fmt::format(
			"{{\"id\":{},\"name\":", t->index.base());
		AppendJsonString(out, t->GetCachedName());
		out += fmt::format(
			",\"x\":{},\"y\":{},\"population\":{},\"growthRate\":{},\"buildings\":{},\"rating\":{}",
			TileX(t->xy), TileY(t->xy),
			t->cache.population, t->growth_rate, t->cache.num_houses, rating);

		/* Autorité locale : note et coûts des actions disponibles pour
		 * l'entreprise locale (#166). Une action hors masque reste exposée
		 * avec `available: false` pour que l'UI explique son indisponibilité. */
		TownActions mask{};
		if (Company::IsValidID(_local_company)) mask = GetMaskOfTownActions(_local_company, t);
		out += ",\"authority\":{\"rating\":";
		out += fmt::format("{}", rating);
		out += ",\"actions\":{";
		bool first_action = true;
		for (const TownAction action : {TownAction::AdvertiseSmall, TownAction::RoadRebuild,
				TownAction::FundBuildings}) {
			const char *key = TownActionKey(action);
			if (key == nullptr) continue;
			if (!first_action) out.push_back(',');
			first_action = false;
			AppendJsonString(out, key);
			bool available = mask.Test(action);
			/* Actions déjà en cours : OpenTTD ne les retire pas du masque,
			 * mais l'UI doit les griser jusqu'à la fin du programme. */
			if (action == TownAction::RoadRebuild && t->road_build_months != 0) available = false;
			if (action == TownAction::FundBuildings && t->fund_buildings_months != 0) available = false;
			out += fmt::format(":{{\"available\":{},\"cost\":{}}}",
				available ? "true" : "false",
				static_cast<int64_t>(TownActionCost(action)));
		}
		out += "}}}";
	}
	out.push_back(']');

	/* --- Industries -------------------------------------------------------- */
	out += ",\"industries\":[";
	first = true;
	for (const Industry *ind : Industry::Iterate()) {
		if (!first) out.push_back(',');
		first = false;

		const IndustrySpec *spec = GetIndustrySpec(ind->type);

		uint64_t production = 0;
		uint64_t transported = 0;
		for (const Industry::ProducedCargo &produced : ind->produced) {
			if (!IsValidCargoType(produced.cargo)) continue;
			production += produced.history[LAST_MONTH].production;
			transported += produced.history[LAST_MONTH].transported;
		}
		const uint64_t service_rate = production > 0
			? std::min<uint64_t>(100, transported * 100 / production) : 0;

		out += fmt::format("{{\"id\":{},\"name\":", ind->index.base());
		AppendJsonString(out, ind->GetCachedName());
		out += ",\"kind\":";
		AppendJsonString(out, spec != nullptr ? GetString(spec->name) : "unknown");
		out += fmt::format(
			",\"type\":{},\"x\":{:.2f},\"y\":{:.2f},\"width\":{},\"height\":{},"
			"\"production\":{},\"transported\":{},\"serviceRate\":{},\"stocks\":[",
			static_cast<unsigned>(ind->type),
			TileX(ind->location.tile) + (ind->location.w > 1 ? (ind->location.w - 1) / 2.0 : 0.0),
			TileY(ind->location.tile) + (ind->location.h > 1 ? (ind->location.h - 1) / 2.0 : 0.0),
			ind->location.w, ind->location.h,
			production, transported, service_rate);

		bool first_cargo = true;
		for (const Industry::ProducedCargo &produced : ind->produced) {
			if (!IsValidCargoType(produced.cargo) || produced.waiting == 0) continue;

			if (!first_cargo) out.push_back(',');
			first_cargo = false;
			out += "{\"cargo\":";
			AppendJsonString(out, CargoName(produced.cargo));
			out += fmt::format(",\"amount\":{},\"rate\":{}}}",
				produced.waiting, static_cast<unsigned>(produced.rate));
		}

		out += "],\"accepts\":[";
		bool first_accept = true;
		for (const Industry::AcceptedCargo &accepted : ind->accepted) {
			if (!IsValidCargoType(accepted.cargo)) continue;
			if (!first_accept) out.push_back(',');
			first_accept = false;
			AppendJsonString(out, CargoName(accepted.cargo));
		}
		out += "]}";
	}
	out.push_back(']');

	/* --- Gares ------------------------------------------------------------- */
	out += ",\"stations\":[";
	first = true;
	for (const Station *st : Station::Iterate()) {
		if (!first) out.push_back(',');
		first = false;

		const StationExtent extent = GetStationExtent(st);

		out += fmt::format("{{\"id\":{},\"company\":{},\"name\":", st->index.base(), ProtocolOwner(st->owner));
		AppendJsonString(out, st->GetCachedName());
		out += ",\"kind\":";
		AppendJsonString(out, StationKindName(st));
		out += fmt::format(
			",\"x\":{:.2f},\"y\":{:.2f},\"width\":{},\"height\":{},\"waiting\":[",
			(extent.min_x + extent.max_x + 1) / 2.0,
			(extent.min_y + extent.max_y + 1) / 2.0,
			extent.max_x - extent.min_x + 1,
			extent.max_y - extent.min_y + 1);

		bool first_cargo = true;
		for (const CargoSpec *spec : CargoSpec::Iterate()) {
			const CargoType cargo = static_cast<CargoType>(spec->Index());
			const uint32_t waiting = st->goods[cargo].TotalCount();
			if (waiting == 0) continue;

			if (!first_cargo) out.push_back(',');
			first_cargo = false;
			out += "{\"cargo\":";
			AppendJsonString(out, GetString(spec->name));
			out += fmt::format(",\"amount\":{}}}", waiting);
		}
		out += "]}";
	}
	out.push_back(']');

	/* --- Dépôts route/rail ------------------------------------------------- */
	/* `id` est l'index du pool OpenTTD (`DepotID`) : il reste stable tant que
	 * le dépôt existe et sert directement aux ordres `vehicle.order`
	 * (`kind: "depot"`). Les dépôts maritimes et hangars sont omis en v1. */
	out += ",\"depots\":[";
	first = true;
	for (const Depot *d : Depot::Iterate()) {
		const char *kind = DepotKindName(d->xy);
		if (kind == nullptr) continue;

		if (!first) out.push_back(',');
		first = false;

		out += fmt::format(
			"{{\"id\":{},\"company\":{},\"kind\":\"{}\",\"x\":{},\"y\":{},\"direction\":{},"
			"\"width\":1,\"height\":1",
			d->index.base(), ProtocolOwner(GetTileOwner(d->xy)), kind,
			TileX(d->xy), TileY(d->xy), DepotDirection(d->xy));
		if (std::string_view(kind) == "rail") {
			out += ",\"railType\":\"";
			out += RailTypeName(GetRailType(d->xy));
			out += "\"";
		}
		out += "}";
	}
	out.push_back(']');

	/* --- Groupes de véhicules (#164) -------------------------------------- */
	/* Les groupes sont typés et propres à une entreprise. `autoreplace` est
	 * déduit de la règle OpenTTD du premier véhicule du groupe : le pont ne
	 * stocke qu'un couple moteur d'origine → moteur de remplacement. */
	out += ",\"groups\":[";
	bool first_group = true;
	for (const Group *g : Group::Iterate()) {
		if (!Company::IsValidID(g->owner)) continue;
		uint32_t group_vehicles = 0;
		std::string replace_model;
		bool replace_when_old = false;
		for (const Vehicle *v : Vehicle::Iterate()) {
			if (v->group_id != g->index || !v->IsPrimaryVehicle()) continue;
			group_vehicles++;
			if (replace_model.empty()) {
				const EngineID replacement = EngineReplacementForCompany(
						Company::Get(g->owner), v->engine_type, g->index, &replace_when_old);
				if (replacement != EngineID::Invalid()) replace_model = EngineName(replacement);
			}
		}

		if (!first_group) out.push_back(',');
		first_group = false;
		const std::string group_name = g->name.empty()
				? fmt::format("Groupe {}", g->index.base() + 1)
				: g->name;
		out += fmt::format(
			"{{\"id\":{},\"company\":{},\"name\":", g->index.base(), ProtocolOwner(g->owner));
		AppendJsonString(out, group_name);
		out += fmt::format(
			",\"kind\":\"{}\",\"parent\":{},\"vehicles\":{}",
			VehicleKindName(g->vehicle_type),
			g->parent == GroupID::Invalid() ? -1 : static_cast<int>(g->parent.base()),
			group_vehicles);
		if (!replace_model.empty()) {
			out += ",\"autoreplace\":{\"model\":";
			AppendJsonString(out, replace_model);
			out += fmt::format(",\"whenOld\":{}}}", replace_when_old ? "true" : "false");
		} else {
			out += ",\"autoreplace\":null";
		}
		out.push_back('}');
	}
	out.push_back(']');

	/* --- Ponts et tunnels (#154/#155) ------------------------------------- */
	/* `structures` évite au rendu de deviner le matériau et les tabliers.
	 * Les milieux de pont ne sont pas des tuiles MP_TUNNELBRIDGE : on émet un
	 * ouvrage depuis sa culée nord/ouest, et un tunnel depuis son entrée de
	 * plus petit index. Les aqueducs (TRANSPORT_WATER) sont ignorés en v1. */
	out += ",\"structures\":[";
	first = true;
	for (uint index = 0; index < Map::Size(); index++) {
		const TileIndex tile(index);
		if (!IsTileType(tile, MP_TUNNELBRIDGE)) continue;
		const TransportType transport = GetTunnelBridgeTransportType(tile);
		if (transport == TRANSPORT_WATER) continue;

		if (IsBridgeTile(tile)) {
			const TileIndex other = GetOtherBridgeEnd(tile);
			/* Un pont a deux rampes : n'émettre que depuis la plus petite. */
			if (tile > other) continue;
			if (!first) out.push_back(',');
			first = false;
			out += fmt::format(
				"{{\"id\":{},\"kind\":\"bridge\",\"company\":{},\"transport\":\"{}\","
				"\"material\":\"{}\",\"from\":{{\"x\":{},\"y\":{}}},\"to\":{{\"x\":{},\"y\":{}}},"
				"\"length\":{},\"deckHeight\":{}}}",
				tile.base(), ProtocolOwner(GetTileOwner(tile)),
				transport == TRANSPORT_ROAD ? "road" : "rail",
				BridgeMaterialName(GetBridgeType(tile)),
				TileX(tile), TileY(tile), TileX(other), TileY(other),
				GetTunnelBridgeLength(tile, other) + 2, GetBridgeHeight(tile));
		} else {
			const TileIndex other = GetOtherTunnelEnd(tile);
			if (tile > other) continue;
			if (!first) out.push_back(',');
			first = false;
			out += fmt::format(
				"{{\"id\":{},\"kind\":\"tunnel\",\"company\":{},\"transport\":\"{}\","
				"\"from\":{{\"x\":{},\"y\":{}}},\"to\":{{\"x\":{},\"y\":{}}},"
				"\"length\":{},\"portalHeight\":{}}}",
				tile.base(), ProtocolOwner(GetTileOwner(tile)),
				transport == TRANSPORT_ROAD ? "road" : "rail",
				TileX(tile), TileY(tile), TileX(other), TileY(other),
				GetTunnelBridgeLength(tile, other) + 2, GetTileZ(tile));
		}
	}
	out.push_back(']');

	/* --- Véhicules --------------------------------------------------------- */
	out += ",\"vehicles\":[";
	first = true;
	for (const Vehicle *v : Vehicle::Iterate()) {
		if (v->type >= VEH_COMPANY_END) continue;
		if (v->type == VEH_TRAIN && !v->IsFrontEngine()) continue;

		if (!first) out.push_back(',');
		first = false;

		/* Vitesse approchée en tuiles par jour de jeu : chaque tick avance de
		 * GetAdvanceSpeed() = cur_speed * 3/4 unités pour 192 unités par pas,
		 * soit cur_speed / 256 tuile par tick. */
		const double tiles_per_day = static_cast<double>(v->cur_speed) * Ticks::DAY_TICKS / 256.0;

		out += fmt::format(
			"{{\"id\":{},\"kind\":\"{}\",\"company\":{},\"x\":{:.4f},\"y\":{:.4f},\"z\":{:.4f},"
			"\"direction\":{},\"speed\":{:.3f},\"status\":{},\"cargo\":",
			v->index.base(), VehicleKindName(v->type), ProtocolOwner(v->owner),
			v->x_pos / 16.0, v->y_pos / 16.0, v->z_pos / 16.0,
			static_cast<unsigned>(v->direction), tiles_per_day, VehicleStatus(v));

		AppendVehicleCargo(out, v);

		out += ",\"orderTargets\":[";
		bool first_order = true;
		if (v->orders != nullptr) {
			for (const Order &order : v->orders->GetOrders()) {
				if (!order.IsType(OT_GOTO_STATION) && !order.IsType(OT_GOTO_WAYPOINT)) continue;
				if (!first_order) out.push_back(',');
				first_order = false;
				out += fmt::format("{}", order.GetDestination().base());
			}
		}
		out += "],\"orderDetails\":[";
		const bool timetable_started = v->vehicle_flags.Test(VehicleFlag::TimetableStarted);
		for (VehicleOrderID index = 0; index < v->GetNumManualOrders(); index++) {
			const Order *order = v->GetOrder(index);
			if (order == nullptr) continue;
			if (index != 0) out.push_back(',');
			out += fmt::format("{{\"index\":{},\"kind\":", static_cast<unsigned>(index));
			AppendJsonString(out, OrderKindName(*order));
			if (order->IsType(OT_CONDITIONAL)) {
				out += ",\"target\":-1";
			} else {
				out += fmt::format(",\"target\":{}", order->GetDestination().base());
			}
			out += ",\"options\":";
			AppendOrderOptions(out, *order, timetable_started);
			out.push_back('}');
		}
		out += fmt::format("],\"currentOrder\":{},\"profitLastYear\":{:.2f},\"ageDays\":{}",
			static_cast<unsigned>(v->cur_real_order_index),
			static_cast<double>(v->profit_last_year) / 256.0,
			v->age.base());

		/* Groupe de rattachement (#164). */
		if (v->group_id != DEFAULT_GROUP && Group::IsValidID(v->group_id)) {
			const Group *group = Group::Get(v->group_id);
			const std::string group_name = group->name.empty()
					? fmt::format("Groupe {}", group->index.base() + 1)
					: group->name;
			out += ",\"group\":{\"id\":";
			out += fmt::format("{}", group->index.base());
			out += ",\"name\":";
			AppendJsonString(out, group_name);
			out.push_back('}');
		}

		/* Usure, fiabilité et panne (#163). OpenTTD stocke la fiabilité sur
		 * 16 bits ; on la normalise en pourcentage pour l'UI. */
		const Engine *engine = v->GetEngine();
		const uint32_t max_reliability = engine != nullptr && engine->reliability_max > 0
				? engine->reliability_max
				: v->reliability;
		const uint32_t current_reliability = max_reliability > 0
				? std::min<uint32_t>(v->reliability, max_reliability)
				: 0;
		const uint32_t wear = max_reliability > 0
				? ((max_reliability - current_reliability) * 100) / max_reliability
				: 0;
		const char *breakdown = "none";
		uint32_t breakdown_ticks = 0;
		if (v->breakdown_ctr == 1) {
			breakdown = "stopped";
			breakdown_ticks = v->breakdown_delay;
		} else if (v->breakdown_ctr == 2) {
			breakdown = "slowing";
			breakdown_ticks = 1;
		}
		const int64_t economy_day = TimerGameEconomy::date.base();
		const uint32_t days_since_service = static_cast<uint32_t>(
				std::max<int64_t>(0, economy_day - v->date_of_last_service.base()));
		const uint16_t service_interval = v->GetServiceInterval() > 0
				? v->GetServiceInterval()
				: 120;
		out += fmt::format(
			",\"reliability\":{{\"wear\":{},\"reliability\":{},\"breakdown\":\"{}\","
			"\"breakdownTicks\":{},\"lastServiceTick\":null,\"serviceIntervalDays\":{},"
			"\"daysSinceService\":{},\"maintenancePerYear\":{}}}",
			wear, 100 - wear, breakdown, breakdown_ticks, service_interval,
			days_since_service, v->GetDisplayRunningCost());
		out.push_back('}');
	}
	out.push_back(']');

	/* `news` et `events` restent vides en v1 : le moteur ne journalise pas
	 * encore ces informations de façon exploitable (voir wiki). */
	out += ",\"subsidies\":[";
	bool first_subsidy = true;
	for (const Subsidy *subsidy : Subsidy::Iterate()) {
		if (!IsValidCargoType(subsidy->cargo_type)) continue;
		if (!first_subsidy) out.push_back(',');
		first_subsidy = false;
		out += fmt::format("{{\"id\":{},\"cargo\":", subsidy->index.base());
		AppendJsonString(out, CargoName(subsidy->cargo_type));
		out += ",\"from\":";
		AppendJsonString(out, SubsidySourceName(subsidy->src));
		out += ",\"to\":";
		AppendJsonString(out, SubsidySourceName(subsidy->dst));
		out += fmt::format(
			",\"fromKind\":\"{}\",\"toKind\":\"{}\",\"remainingMonths\":{},\"awardedTo\":{}}}",
			SubsidySourceKind(subsidy->src), SubsidySourceKind(subsidy->dst),
			static_cast<unsigned>(subsidy->remaining),
			Company::IsValidID(subsidy->awarded) ? subsidy->awarded.base() : -1);
	}
	out += "],";
	/* --- Désastres actifs (#172) ------------------------------------------ */
	out += "\"disasters\":[";
	bool first_disaster = true;
	for (const DisasterVehicle *v : DisasterVehicle::Iterate()) {
		const char *kind = DisasterKindName(static_cast<DisasterSubType>(v->subtype));
		if (kind == nullptr || v->tile == INVALID_TILE) continue;
		if (!first_disaster) out.push_back(',');
		first_disaster = false;
		const uint8_t owner = TileOwnerByte(v->tile);
		out += fmt::format(
			"{{\"id\":{},\"kind\":\"{}\",\"x\":{:.2f},\"y\":{:.2f},\"company\":{},"
			"\"severity\":{},\"startedTick\":{},\"remainingDays\":1}}",
			v->index.base(), kind,
			TileX(v->tile) + 0.5, TileY(v->tile) + 0.5,
			static_cast<unsigned>(owner), v->subtype == ST_BIG_UFO ? 3 : 2, tick);
	}
	out += "],";
	out += "\"news\":[],\"events\":[]}";
}

/**
 * Crée les entreprises humaines de la partie (#99).
 *
 * Les ids sont attribués dans l'ordre croissant des emplacements libres, donc
 * de façon déterministe : sur tous les pairs, la i-ème entreprise humaine a le
 * même id et le même profil. Sans profil explicite, une seule entreprise est
 * créée (comportement historique).
 *
 * @param profiles noms/couleurs des entreprises humaines (ordre des ids).
 * @param[out] first_company id de la première entreprise créée.
 * @param[out] error message lisible si la création est incomplète.
 * @return nombre d'entreprises effectivement créées.
 */
int StartHumanCompanies(const std::vector<CompanyProfile> &profiles, CompanyID &first_company, std::string &error)
{
	first_company = CompanyID::Invalid();
	const int count = profiles.empty() ? 1 : static_cast<int>(profiles.size());
	int started = 0;
	for (int i = 0; i < count; i++) {
		CompanyID company_id = CompanyID::Invalid();
		for (CompanyID candidate = CompanyID::Begin(); candidate < MAX_COMPANIES; ++candidate) {
			if (!Company::IsValidID(candidate)) {
				company_id = candidate;
				break;
			}
		}
		if (company_id == CompanyID::Invalid()) {
			error = fmt::format("plus d'emplacement libre pour l'entreprise humaine {} sur {}", i, count);
			break;
		}

		Company *company = DoStartupNewCompany(false, company_id);
		if (company == nullptr) {
			error = fmt::format("création de l'entreprise humaine {} refusée", company_id.base());
			break;
		}

		if (i < static_cast<int>(profiles.size())) {
			const CompanyProfile &profile = profiles[i];
			if (!profile.name.empty()) company->name = profile.name;
			if (profile.colour >= 0 && profile.colour <= 15) {
				company->colour = static_cast<Colours>(profile.colour);
				_company_colours[company->index] = company->colour;
				ResetCompanyLivery(company);
			}
		}

		if (first_company == CompanyID::Invalid()) first_company = company_id;
		started++;
	}
	return started;
}

/**
 * Crée `count` entreprises IA et démarre leur script (`AI::StartNew`).
 *
 * `DoStartupNewCompany(true, id)` choisit les identifiants dans l'ordre
 * croissant des emplacements libres : pour une même graine et une même
 * configuration, les entreprises IA et leur script sont donc identiques.
 *
 * @param count nombre d'IA à démarrer.
 * @param[out] error message lisible si le démarrage est incomplet.
 * @return nombre d'IA effectivement démarrées.
 */
int StartAiCompanies(int count, std::string &error)
{
	int started = 0;
	for (int i = 0; i < count; i++) {
		CompanyID company_id = CompanyID::Invalid();
		for (CompanyID candidate = CompanyID::Begin(); candidate < MAX_COMPANIES; ++candidate) {
			if (!Company::IsValidID(candidate)) {
				company_id = candidate;
				break;
			}
		}
		if (company_id == CompanyID::Invalid()) {
			error = fmt::format("plus d'emplacement libre pour l'IA {} sur {}", i + 1, count);
			break;
		}

		Company *company = DoStartupNewCompany(true, company_id);
		if (company == nullptr) {
			error = fmt::format("création de l'entreprise IA {} refusée", company_id.base());
			break;
		}
		if (company->ai_info == nullptr) {
			error = fmt::format("l'entreprise IA {} n'a pas de script associé", company_id.base());
			break;
		}
		if (company->ai_info->GetName() == "DummyAI") {
			error = "aucun script IA installé : OpenTTD a démarré l'IA factice (DummyAI)";
			break;
		}
		started++;
	}
	return started;
}

/* ------------------------------------------------------------------------- */
/*  Commandes de construction et de véhicules (issue #11)                    */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/*  JSON générique (commandes)                                               */
/* ------------------------------------------------------------------------- */

/**
 * Valeur JSON minimale (objet, tableau, chaîne, nombre, booléen, null).
 *
 * Le pont n'embarque pas de bibliothèque JSON : cette structure couvre
 * exactement ce dont `EngineCommand` a besoin (objets imbriqués, tableaux
 * d'ordres, options typées) avec un parseur strict et sans allocation
 * superflue.
 */
struct JsonValue {
	enum class Type : uint8_t { Null, Bool, Number, String, Array, Object };

	Type type = Type::Null;
	bool boolean = false;
	double number = 0.0;
	std::string text;
	std::vector<JsonValue> items;
	std::vector<std::pair<std::string, JsonValue>> fields;

	bool IsNull() const { return this->type == Type::Null; }

	/** Champ d'un objet, ou nullptr s'il est absent (ou si la valeur n'est pas un objet). */
	const JsonValue *Find(std::string_view key) const
	{
		if (this->type != Type::Object) return nullptr;
		for (const auto &field : this->fields) {
			if (field.first == key) return &field.second;
		}
		return nullptr;
	}
};

bool ParseJsonValue(std::string_view text, size_t &pos, JsonValue &out, std::string &error, int depth)
{
	if (depth > 24) return JsonFail(error, "JSON trop profond");
	SkipJsonSpace(text, pos);
	if (pos >= text.size()) return JsonFail(error, "valeur JSON manquante");

	const char c = text[pos];
	if (c == '{') {
		pos++;
		out.type = JsonValue::Type::Object;
		SkipJsonSpace(text, pos);
		if (pos < text.size() && text[pos] == '}') {
			pos++;
			return true;
		}
		for (;;) {
			SkipJsonSpace(text, pos);
			std::string key;
			if (!ParseJsonString(text, pos, key, error)) return false;
			if (out.Find(key) != nullptr) {
				return JsonFail(error, fmt::format("clé JSON dupliquée « {} »", key));
			}
			SkipJsonSpace(text, pos);
			if (pos >= text.size() || text[pos] != ':') {
				return JsonFail(error, fmt::format("« : » attendu après la clé « {} »", key));
			}
			pos++;
			JsonValue value;
			if (!ParseJsonValue(text, pos, value, error, depth + 1)) return false;
			out.fields.emplace_back(std::move(key), std::move(value));
			SkipJsonSpace(text, pos);
			if (pos >= text.size()) return JsonFail(error, "objet JSON incomplet");
			if (text[pos] == ',') {
				pos++;
				continue;
			}
			if (text[pos] == '}') {
				pos++;
				return true;
			}
			return JsonFail(error, "virgule ou « } » attendu dans l'objet JSON");
		}
	}

	if (c == '[') {
		pos++;
		out.type = JsonValue::Type::Array;
		SkipJsonSpace(text, pos);
		if (pos < text.size() && text[pos] == ']') {
			pos++;
			return true;
		}
		for (;;) {
			JsonValue value;
			if (!ParseJsonValue(text, pos, value, error, depth + 1)) return false;
			out.items.emplace_back(std::move(value));
			SkipJsonSpace(text, pos);
			if (pos >= text.size()) return JsonFail(error, "tableau JSON incomplet");
			if (text[pos] == ',') {
				pos++;
				continue;
			}
			if (text[pos] == ']') {
				pos++;
				return true;
			}
			return JsonFail(error, "virgule ou « ] » attendu dans le tableau JSON");
		}
	}

	if (c == '"') {
		out.type = JsonValue::Type::String;
		return ParseJsonString(text, pos, out.text, error);
	}

	if (text.substr(pos, 4) == "true" && JsonDelimiter(text, pos + 4)) {
		pos += 4;
		out.type = JsonValue::Type::Bool;
		out.boolean = true;
		return true;
	}
	if (text.substr(pos, 5) == "false" && JsonDelimiter(text, pos + 5)) {
		pos += 5;
		out.type = JsonValue::Type::Bool;
		out.boolean = false;
		return true;
	}
	if (text.substr(pos, 4) == "null" && JsonDelimiter(text, pos + 4)) {
		pos += 4;
		out.type = JsonValue::Type::Null;
		return true;
	}

	if (c == '-' || (c >= '0' && c <= '9')) {
		double value = 0.0;
		if (!ParseJsonNumber(text, pos, value, error)) return false;
		out.type = JsonValue::Type::Number;
		out.number = value;
		return true;
	}

	return JsonFail(error, "valeur JSON invalide");
}

/** Analyse un document JSON complet ; la racine doit être un objet. */
bool ParseCommandJson(std::string_view json, JsonValue &out, std::string &error)
{
	size_t pos = 0;
	if (!ParseJsonValue(json, pos, out, error, 0)) return false;
	SkipJsonSpace(json, pos);
	if (pos != json.size()) return JsonFail(error, "caractères en trop après l'objet JSON");
	if (out.type != JsonValue::Type::Object) return JsonFail(error, "objet JSON attendu à la racine");
	return true;
}

bool JsonGetInt(const JsonValue *value, int &out)
{
	if (value == nullptr || value->type != JsonValue::Type::Number) return false;
	const double number = value->number;
	if (number < -2147483648.0 || number > 2147483647.0) return false;
	const int truncated = static_cast<int>(number);
	if (static_cast<double>(truncated) != number) return false;
	out = truncated;
	return true;
}

bool JsonGetNumber(const JsonValue *value, double &out)
{
	if (value == nullptr || value->type != JsonValue::Type::Number) return false;
	out = value->number;
	return true;
}

bool JsonGetString(const JsonValue *value, std::string &out)
{
	if (value == nullptr || value->type != JsonValue::Type::String) return false;
	out = value->text;
	return true;
}

/** Lit un point `{x,y}` en tuiles ; les fractions sont arrondies. */
bool JsonGetTile(const JsonValue *value, int &x, int &y)
{
	if (value == nullptr || value->type != JsonValue::Type::Object) return false;
	double dx = 0.0;
	double dy = 0.0;
	if (!JsonGetNumber(value->Find("x"), dx) || !JsonGetNumber(value->Find("y"), dy)) return false;
	x = static_cast<int>(std::lround(dx));
	y = static_cast<int>(std::lround(dy));
	return true;
}

bool IsTileInMap(int x, int y)
{
	return x >= 0 && y >= 0 &&
			static_cast<uint>(x) < Map::SizeX() && static_cast<uint>(y) < Map::SizeY();
}

std::string LowerAscii(std::string_view text)
{
	std::string result;
	result.reserve(text.size());
	for (const char c : text) {
		result.push_back((c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c);
	}
	return result;
}

const JsonValue *FindOption(const JsonValue *options, std::string_view name)
{
	return options != nullptr ? options->Find(name) : nullptr;
}

std::string OptionString(const JsonValue *options, std::string_view name, std::string fallback = {})
{
	std::string text;
	if (JsonGetString(FindOption(options, name), text)) return text;
	return fallback;
}

int OptionInt(const JsonValue *options, std::string_view name, int fallback)
{
	int value = 0;
	if (JsonGetInt(FindOption(options, name), value)) return value;
	return fallback;
}

bool OptionBool(const JsonValue *options, std::string_view name, bool fallback)
{
	const JsonValue *value = FindOption(options, name);
	if (value == nullptr) return fallback;
	if (value->type == JsonValue::Type::Bool) return value->boolean;
	if (value->type == JsonValue::Type::Number) return value->number != 0.0;
	return fallback;
}

bool ParseDiagDirName(std::string_view name, DiagDirection &out)
{
	if (name == "ne" || name == "north-east" || name == "nord-est") {
		out = DIAGDIR_NE;
	} else if (name == "se" || name == "south-east" || name == "sud-est") {
		out = DIAGDIR_SE;
	} else if (name == "sw" || name == "south-west" || name == "sud-ouest") {
		out = DIAGDIR_SW;
	} else if (name == "nw" || name == "north-west" || name == "nord-ouest") {
		out = DIAGDIR_NW;
	} else {
		return false;
	}
	return true;
}

DiagDirection OptionDiagDir(const JsonValue *options, std::string_view name, DiagDirection fallback)
{
	const JsonValue *value = FindOption(options, name);
	if (value == nullptr) return fallback;
	int number = 0;
	if (JsonGetInt(value, number)) {
		return (number >= 0 && number < 4) ? static_cast<DiagDirection>(number) : fallback;
	}
	std::string text;
	if (JsonGetString(value, text)) {
		DiagDirection dir = INVALID_DIAGDIR;
		if (ParseDiagDirName(LowerAscii(text), dir)) return dir;
	}
	return fallback;
}

bool ParseTrackName(std::string_view name, Track &out)
{
	if (name == "x" || name == "ne" || name == "sw" || name == "ne-sw") {
		out = TRACK_X;
	} else if (name == "y" || name == "nw" || name == "se" || name == "nw-se") {
		out = TRACK_Y;
	} else if (name == "upper" || name == "north" || name == "n") {
		out = TRACK_UPPER;
	} else if (name == "lower" || name == "south" || name == "s") {
		out = TRACK_LOWER;
	} else if (name == "left" || name == "west" || name == "w") {
		out = TRACK_LEFT;
	} else if (name == "right" || name == "east" || name == "e") {
		out = TRACK_RIGHT;
	} else {
		return false;
	}
	return true;
}

bool ParseRoadBitsName(std::string_view name, RoadBits &out)
{
	if (name == "x" || name == "ne-sw") {
		out = ROAD_X;
	} else if (name == "y" || name == "nw-se") {
		out = ROAD_Y;
	} else if (name == "n" || name == "north") {
		out = ROAD_N;
	} else if (name == "e" || name == "east") {
		out = ROAD_E;
	} else if (name == "s" || name == "south") {
		out = ROAD_S;
	} else if (name == "w" || name == "west") {
		out = ROAD_W;
	} else if (name == "all" || name == "cross") {
		out = ROAD_ALL;
	} else {
		return false;
	}
	return true;
}

/* ------------------------------------------------------------------------- */
/*  Résultat de commande                                                     */
/* ------------------------------------------------------------------------- */

/** Texte français associé à une erreur OpenTTD connue. */
struct CommandErrorText {
	StringID id;
	const char *code;
	const char *message;
};

static const CommandErrorText COMMAND_ERROR_TEXTS[] = {
	{STR_ERROR_INSUFFICIENT_FUNDS,                "NOT_ENOUGH_MONEY",      "Fonds insuffisants pour cette opération."},
	{STR_ERROR_SITE_UNSUITABLE,                   "SITE_UNSUITABLE",       "Emplacement inadapté : terrain, pente ou obstacle."},
	{STR_ERROR_LAND_SLOPED_IN_WRONG_DIRECTION,    "SLOPE_TOO_STEEP",       "Pente trop forte dans cette direction."},
	{STR_ERROR_FLAT_LAND_REQUIRED,                "FLAT_LAND_REQUIRED",    "Terrain plat requis à cet emplacement."},
	{STR_ERROR_ALREADY_BUILT,                     "ALREADY_BUILT",         "Une construction occupe déjà cette tuile."},
	{STR_ERROR_TOO_CLOSE_TO_EDGE_OF_MAP,          "TOO_CLOSE_TO_EDGE",     "Trop proche du bord de la carte."},
	{STR_ERROR_TOO_CLOSE_TO_ANOTHER_TOWN,         "TOO_CLOSE_TO_TOWN",     "Trop proche d'une ville."},
	{STR_ERROR_CAN_T_BUILD_HERE,                  "CANNOT_BUILD_HERE",     "Construction impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_ROAD_HERE,             "CANNOT_BUILD_ROAD",     "Route impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_RAILROAD_TRACK,        "CANNOT_BUILD_RAIL",     "Voie ferrée impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_ROAD_DEPOT,            "CANNOT_BUILD_DEPOT",    "Dépôt routier impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_TRAIN_DEPOT,           "CANNOT_BUILD_DEPOT",    "Dépôt ferroviaire impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_RAILROAD_STATION,      "CANNOT_BUILD_STATION",  "Gare ferroviaire impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_BUS_STATION,           "CANNOT_BUILD_STATION",  "Gare routière impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_TRUCK_STATION,         "CANNOT_BUILD_STATION",  "Gare de fret impossible à cet emplacement."},
	{STR_ERROR_CAN_T_BUILD_SIGNALS_HERE,          "CANNOT_BUILD_SIGNAL",   "Signal impossible à cet emplacement."},
	{STR_ERROR_NO_SUITABLE_RAILROAD_TRACK,        "NO_RAIL_TRACK",         "Aucune voie ferrée adaptée sur cette tuile."},
	{STR_ERROR_STATION_TOO_SPREAD_OUT,            "STATION_TOO_SPREAD_OUT", "Gare trop étendue pour ce réglage de partie."},
	{STR_ERROR_MUST_REMOVE_ROAD_FIRST,            "MUST_REMOVE_ROAD_FIRST", "La route doit être démolie avant cette construction."},
	{STR_ERROR_MUST_REMOVE_RAILROAD_TRACK,        "MUST_REMOVE_RAIL_FIRST", "La voie ferrée doit être démolie avant cette construction."},
	{STR_ERROR_RAIL_VEHICLE_NOT_AVAILABLE,        "ENGINE_NOT_AVAILABLE",  "Aucun matériel ferroviaire disponible à cette date."},
	{STR_ERROR_ROAD_VEHICLE_NOT_AVAILABLE,        "ENGINE_NOT_AVAILABLE",  "Aucun véhicule routier disponible à cette date."},
	{STR_ERROR_TOO_MANY_VEHICLES_IN_GAME,         "TOO_MANY_VEHICLES",     "Limite de véhicules de la partie atteinte."},
	{STR_ERROR_CAN_T_BUY_ROAD_VEHICLE,            "CANNOT_BUY_VEHICLE",    "Achat du véhicule routier refusé."},
	{STR_ERROR_CAN_T_BUY_TRAIN,                   "CANNOT_BUY_VEHICLE",    "Achat du train refusé."},
	{STR_ERROR_CAN_T_SELL_ROAD_VEHICLE,           "CANNOT_SELL_VEHICLE",   "Vente du véhicule routier refusée."},
	{STR_ERROR_CAN_T_SELL_TRAIN,                  "CANNOT_SELL_VEHICLE",   "Vente du train refusée."},
	{STR_ERROR_CAN_T_STOP_START_TRAIN,            "CANNOT_START_STOP",     "Démarrage ou arrêt du train refusé."},
	{STR_ERROR_CAN_T_STOP_START_ROAD_VEHICLE,     "CANNOT_START_STOP",     "Démarrage ou arrêt du véhicule refusé."},
	{STR_ERROR_DEPOT_WRONG_DEPOT_TYPE,            "WRONG_DEPOT_TYPE",      "Ce dépôt n'accepte pas ce type de véhicule."},
	{STR_ERROR_BRIDGE_TOO_LONG,                   "BRIDGE_TOO_LONG",       "Portée du pont trop longue pour ce matériau ou ce réglage."},
	{STR_ERROR_BRIDGE_THROUGH_MAP_BORDER,         "BRIDGE_THROUGH_MAP_BORDER", "Un pont ne peut pas traverser le bord de la carte."},
	{STR_ERROR_BRIDGEHEADS_NOT_SAME_HEIGHT,       "BRIDGEHEADS_NOT_SAME_HEIGHT", "Les deux culées du pont doivent être à la même hauteur."},
	{STR_ERROR_BRIDGE_TOO_LOW_FOR_TERRAIN,        "BRIDGE_TOO_LOW_FOR_TERRAIN", "Le tablier est trop bas pour le relief traversé."},
	{STR_ERROR_BRIDGE_TOO_HIGH_FOR_TERRAIN,       "BRIDGE_TOO_HIGH_FOR_TERRAIN", "Le tablier est trop haut au-dessus du relief."},
	{STR_ERROR_MUST_DEMOLISH_BRIDGE_FIRST,        "MUST_DEMOLISH_BRIDGE_FIRST", "Un pont existant doit être démoli avant cette construction."},
	{STR_ERROR_TUNNEL_TOO_LONG,                   "TUNNEL_TOO_LONG",       "Tunnel trop long pour ce réglage de partie."},
	{STR_ERROR_TUNNEL_THROUGH_MAP_BORDER,         "TUNNEL_THROUGH_MAP_BORDER", "Un tunnel ne peut pas traverser le bord de la carte."},
	{STR_ERROR_ANOTHER_TUNNEL_IN_THE_WAY,         "ANOTHER_TUNNEL_IN_THE_WAY", "Un autre tunnel croise ce tracé."},
	{STR_ERROR_SITE_UNSUITABLE_FOR_TUNNEL,        "SITE_UNSUITABLE_FOR_TUNNEL", "Emplacement inadapté : un portail doit être sur une pente régulière."},
	{STR_ERROR_START_AND_END_MUST_BE_IN,          "INVALID_PARAMETER",     "Les deux extrémités doivent être alignées sur X ou Y."},
};

/** Message OpenTTD (anglais) d'un échec, pour le diagnostic. */
std::string DescribeCommandError(CommandCost result)
{
	const EncodedString &encoded = result.GetEncodedMessage();
	if (!encoded.empty()) return encoded.GetDecodedString();
	const StringID message = result.GetErrorMessage();
	if (message == INVALID_STRING_ID) return {};
	return GetEncodedString(message).GetDecodedString();
}

/** Réponse JSON d'une commande (voir wiki, Protocole > Erreurs). */
struct CommandReply {
	bool ok = false;
	std::string code = "OK";
	std::string message;
	std::string detail;
	Money cost = 0;
	Money maintenance = 0;
	int tiles = 0;
	int orders = 0;
	VehicleID vehicle = VehicleID::Invalid();
	StationID station = StationID::Invalid();
	DepotID depot = DepotID::Invalid();
	GroupID group = GroupID::Invalid();
	std::string model;
};

void AppendReplyJson(std::string &out, const CommandReply &reply)
{
	out += "{\"ok\":";
	out += reply.ok ? "true" : "false";
	out += ",\"code\":";
	AppendJsonString(out, reply.code);
	out += ",\"message\":";
	AppendJsonString(out, reply.message);
	if (!reply.detail.empty()) {
		out += ",\"detail\":";
		AppendJsonString(out, reply.detail);
	}
	if (reply.ok) out += fmt::format(",\"cost\":{}", reply.cost);
	if (reply.ok && reply.maintenance > 0) {
		out += fmt::format(",\"maintenance\":{}", reply.maintenance);
	}
	if (reply.tiles > 0) out += fmt::format(",\"tiles\":{}", reply.tiles);
	if (reply.orders > 0) out += fmt::format(",\"orders\":{}", reply.orders);
	if (reply.vehicle != VehicleID::Invalid()) {
		out += fmt::format(",\"vehicleId\":{}", reply.vehicle.base());
	}
	if (reply.station != StationID::Invalid()) {
		out += fmt::format(",\"stationId\":{}", reply.station.base());
	}
	if (reply.depot != DepotID::Invalid()) {
		out += fmt::format(",\"depotId\":{}", reply.depot.base());
	}
	if (reply.group != GroupID::Invalid()) {
		out += fmt::format(",\"groupId\":{}", reply.group.base());
	}
	if (!reply.model.empty()) {
		out += ",\"model\":";
		AppendJsonString(out, reply.model);
	}
	out += "}";
}

bool FailWith(CommandReply &reply, std::string code, std::string message)
{
	reply.ok = false;
	reply.code = std::move(code);
	reply.message = std::move(message);
	return false;
}

bool FailFromCommand(CommandReply &reply, CommandCost result, const char *fallback_code, std::string fallback_message)
{
	reply.ok = false;
	reply.detail = DescribeCommandError(result);
	const StringID id = result.GetErrorMessage();
	for (const CommandErrorText &entry : COMMAND_ERROR_TEXTS) {
		if (entry.id == id) {
			reply.code = entry.code;
			reply.message = entry.message;
			return false;
		}
	}
	reply.code = fallback_code;
	reply.message = fallback_message;
	return false;
}

bool Succeed(CommandReply &reply, std::string message)
{
	reply.ok = true;
	reply.code = "OK";
	reply.message = std::move(message);
	return true;
}

/* ------------------------------------------------------------------------- */
/*  Exécution de commandes OpenTTD                                           */
/* ------------------------------------------------------------------------- */

/**
 * Exécute une commande pour une entreprise donnée.
 *
 * Passe par `Command<Tcmd>::Unsafe`, le même chemin que les scripts IA :
 * validation entreprise, essai (`estimate_only`) puis exécution, contrôle des
 * fonds et des dépenses. Aucune mutation directe de la carte n'est faite.
 *
 * @param company entreprise qui paie et possède la construction.
 * @param location tuile utilisée pour les messages (peut être `INVALID_TILE`).
 * @param estimate_only true pour un essai sans modification de l'état.
 * @return le résultat brut de la commande (`CommandCost` ou tuple).
 */
template <Commands Tcmd, typename... Args>
auto RunCompanyCommand(CompanyID company, TileIndex location, bool estimate_only, Args... args)
{
	/* `Backup<T>` ne restaure pas tout seul et journalise un avertissement si
	 * `Restore()` n'est pas appelé ; `AutoRestoreBackup` garantit la
	 * restauration à la sortie, y compris sur retour précoce ou exception. */
	AutoRestoreBackup<CompanyID> company_guard(_current_company, company);
	return Command<Tcmd>::template Unsafe<CommandCallback>(
			(StringID)0, nullptr, false, estimate_only, location, std::forward_as_tuple(args...));
}

/** Extrait `CommandCost` d'un résultat simple ou d'un tuple OpenTTD. */
template <typename T>
CommandCost CostOf(const T &result)
{
	if constexpr (std::is_same_v<T, CommandCost>) {
		return result;
	} else {
		return std::get<0>(result);
	}
}

/** Type/dépôt de route disponible pour l'entreprise. */
RoadType SelectRoadType(CompanyID company)
{
	if (HasRoadTypeAvail(company, ROADTYPE_ROAD)) return ROADTYPE_ROAD;
	if (HasRoadTypeAvail(company, ROADTYPE_TRAM)) return ROADTYPE_TRAM;
	return INVALID_ROADTYPE;
}

/** Type de rail disponible pour l'entreprise (rail classique en priorité). */
RailType SelectRailType(CompanyID company)
{
	if (HasRailTypeAvail(company, RAILTYPE_RAIL)) return RAILTYPE_RAIL;
	for (RailType candidate = RAILTYPE_BEGIN; candidate < RAILTYPE_END; candidate++) {
		if (HasRailTypeAvail(company, candidate)) return candidate;
	}
	return INVALID_RAILTYPE;
}

/** Nom protocole d'un type de rail (#157). */
const char *RailTypeName(RailType type)
{
	switch (type) {
		case RAILTYPE_RAIL: return "rail";
		case RAILTYPE_ELECTRIC: return "electrified";
		case RAILTYPE_MONO: return "monorail";
		case RAILTYPE_MAGLEV: return "maglev";
		default: return "rail";
	}
}

/** Lit un nom de type de rail protocole (`rail`, `electric`, `mono`, `maglev`). */
bool ParseRailTypeName(std::string_view name, RailType &out)
{
	if (name == "rail" || name == "normal" || name == "classique") {
		out = RAILTYPE_RAIL;
		return true;
	}
	if (name == "electrified" || name == "electric" || name == "electrifie" ||
			name == "électrifié" || name == "elrail") {
		out = RAILTYPE_ELECTRIC;
		return true;
	}
	if (name == "monorail" || name == "mono") {
		out = RAILTYPE_MONO;
		return true;
	}
	if (name == "maglev") {
		out = RAILTYPE_MAGLEV;
		return true;
	}
	return false;
}

/**
 * Type de rail demandé par une commande, ou type par défaut de l'entreprise.
 * `options.railType` accepte aussi les alias `type` et `rail`.
 */
RailType RequestedRailType(CompanyID company, const JsonValue *options, bool &ok)
{
	ok = true;
	RailType type = SelectRailType(company);
	const std::string name = LowerAscii(OptionString(options, "railType",
			OptionString(options, "rail_type", OptionString(options, "rail", ""))));
	if (name.empty()) return type;
	if (!ParseRailTypeName(name, type)) {
		ok = false;
		return INVALID_RAILTYPE;
	}
	if (!ValParamRailType(type) || !HasRailTypeAvail(company, type)) {
		ok = false;
		return INVALID_RAILTYPE;
	}
	return type;
}

/** Libellé d'un type de signal (#156). */
bool ParseSignalTypeName(std::string_view name, SignalType &type, SignalVariant &variant,
		bool one_way)
{
	variant = SIG_ELECTRIC;
	if (name == "block" || name == "bloc") {
		type = SIGTYPE_BLOCK;
		return true;
	}
	if (name == "path" || name == "pbs") {
		type = one_way ? SIGTYPE_PBS_ONEWAY : SIGTYPE_PBS;
		return true;
	}
	if (name == "entry" || name == "entree" || name == "entrée") {
		type = SIGTYPE_ENTRY;
		return true;
	}
	if (name == "exit" || name == "sortie") {
		type = SIGTYPE_EXIT;
		return true;
	}
	if (name == "combo" || name == "combine" || name == "combiné") {
		type = SIGTYPE_COMBO;
		return true;
	}
	return false;
}

/** Libellé lisible d'un moteur (nom personnalisé ou nom NewGRF). */
std::string EngineName(EngineID engine)
{
	const Engine *info = Engine::GetIfValid(engine);
	if (info != nullptr && !info->name.empty()) return info->name;
	return GetString(STR_ENGINE_NAME, engine.base());
}

/**
 * Choisit un moteur déterministe pour un dépôt.
 *
 * `model` accepte un identifiant numérique, un nom (sous-chaîne, insensible à
 * la casse) ou un mot-clé : `bus`, `truck`/`camion`, `train`/`locomotive`.
 * À défaut, le moteur disponible de plus grande capacité est retenu (le plus
 * petit identifiant en cas d'égalité), comme le fait l'IA.
 */
EngineID SelectEngine(CompanyID company, VehicleType type, const std::string &model)
{
	const std::string needle = LowerAscii(model);
	if (!needle.empty() && needle.size() <= 5 &&
			std::all_of(needle.begin(), needle.end(), [](char c) { return c >= '0' && c <= '9'; })) {
		uint32_t value = 0;
		for (const char c : needle) value = value * 10 + static_cast<uint32_t>(c - '0');
		if (value >= 0xFFFF) return EngineID::Invalid();
		const EngineID engine{static_cast<uint16_t>(value)};
		if (IsEngineBuildable(engine, type, company)) return engine;
		return EngineID::Invalid();
	}

	const bool passengers = needle.empty() || needle == "bus" || needle == "passenger" ||
			needle == "passagers" || needle == "voyageurs";
	const bool freight = needle == "truck" || needle == "camion" || needle == "cargo" ||
			needle == "fret" || needle == "marchandises";
	const bool any_train = needle == "train" || needle == "locomotive" || needle == "loco";
	const bool name_filter = !needle.empty() && !passengers && !freight && !any_train;

	EngineID best = EngineID::Invalid();
	uint64_t best_capacity = 0;
	for (const Engine *info : Engine::Iterate()) {
		if (info->type != type) continue;
		if (type == VEH_TRAIN && info->VehInfo<RailVehicleInfo>().railveh_type == RAILVEH_WAGON) continue;

		const EngineID engine = info->index;
		if (!IsEngineBuildable(engine, type, company)) continue;

		const CargoType cargo = info->GetDefaultCargoType();
		if (!IsValidCargoType(cargo)) continue;
		const bool is_passenger_cargo =
				CargoSpec::Get(cargo)->town_acceptance_effect == TAE_PASSENGERS;

		if (type == VEH_ROAD && passengers && !is_passenger_cargo) continue;
		if (type == VEH_ROAD && freight && is_passenger_cargo) continue;

		if (name_filter) {
			const std::string name = LowerAscii(EngineName(engine));
			if (name.find(needle) == std::string::npos) continue;
		}

		const uint64_t capacity = GetTotalCapacityOfArticulatedParts(engine);
		if (best == EngineID::Invalid() || capacity > best_capacity) {
			best = engine;
			best_capacity = capacity;
		}
	}
	return best;
}

/** Chemin en L entre deux tuiles (origine incluse, sans doublon). */
void MakeLPath(int from_x, int from_y, int to_x, int to_y, bool vertical_first, std::vector<TileIndex> &path)
{
	path.clear();
	path.push_back(TileXY(from_x, from_y));

	auto append_line = [&path](int x0, int y0, int x1, int y1) {
		const int step_x = (x1 > x0) - (x1 < x0);
		const int step_y = (y1 > y0) - (y1 < y0);
		int x = x0;
		int y = y0;
		while (x != x1 || y != y1) {
			x += step_x;
			y += step_y;
			path.push_back(TileXY(x, y));
		}
	};

	if (vertical_first) {
		append_line(from_x, from_y, from_x, to_y);
		append_line(from_x, to_y, to_x, to_y);
	} else {
		append_line(from_x, from_y, to_x, from_y);
		append_line(to_x, from_y, to_x, to_y);
	}
}

/** Lit `from` (obligatoire) et `to` (facultatif) et vérifie les bornes. */
bool ReadFromTo(const JsonValue &root, int &from_x, int &from_y, int &to_x, int &to_y, bool &has_to)
{
	if (!JsonGetTile(root.Find("from"), from_x, from_y) || !IsTileInMap(from_x, from_y)) return false;
	has_to = false;
	to_x = from_x;
	to_y = from_y;
	const JsonValue *to = root.Find("to");
	if (to != nullptr && !to->IsNull()) {
		if (!JsonGetTile(to, to_x, to_y) || !IsTileInMap(to_x, to_y)) return false;
		has_to = true;
	}
	return true;
}

/** Direction d'entrée d'un dépôt : voisin route/rail déjà construit. */
DiagDirection FindEntranceDirection(TileIndex tile, bool rail)
{
	static constexpr DiagDirection directions[4] = {DIAGDIR_NW, DIAGDIR_SW, DIAGDIR_SE, DIAGDIR_NE};
	static constexpr int offsets_x[4] = {0, 1, 0, -1};
	static constexpr int offsets_y[4] = {-1, 0, 1, 0};

	const int x = static_cast<int>(TileX(tile));
	const int y = static_cast<int>(TileY(tile));
	for (int i = 0; i < 4; i++) {
		const int nx = x + offsets_x[i];
		const int ny = y + offsets_y[i];
		if (!IsTileInMap(nx, ny)) continue;
		const TileIndex neighbour = TileXY(nx, ny);
		if (rail ? IsPlainRailTile(neighbour) : IsNormalRoadTile(neighbour)) return directions[i];
	}
	return INVALID_DIAGDIR;
}

/* ------------------------------------------------------------------------- */
/*  Outils de construction                                                   */
/* ------------------------------------------------------------------------- */

bool BuildRoad(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	const RoadType road_type = SelectRoadType(company);
	if (road_type == INVALID_ROADTYPE) {
		return FailWith(reply, "NO_ROAD_TYPE", "Aucun type de route disponible pour cette entreprise.");
	}

	std::string order = LowerAscii(OptionString(options, "order", "horizontal"));
	bool vertical_first = false;
	if (order == "vertical" || order == "y") {
		vertical_first = true;
	} else if (order != "horizontal" && order != "x") {
		return FailWith(reply, "INVALID_PARAMETER", "« options.order » doit valoir « horizontal » ou « vertical ».");
	}

	std::vector<TileIndex> path;
	MakeLPath(from_x, from_y, to_x, to_y, vertical_first, path);

	if (path.size() == 1) {
		RoadBits bits = ROAD_X;
		const std::string bits_name = LowerAscii(OptionString(options, "bits", ""));
		if (!bits_name.empty() && !ParseRoadBitsName(bits_name, bits)) {
			return FailWith(reply, "INVALID_PARAMETER", "« options.bits » inconnu (x, y, n, e, s, w, all).");
		}
		const TileIndex tile = path.front();
		CommandCost test = RunCompanyCommand<CMD_BUILD_ROAD>(
				company, tile, true, tile, bits, road_type, DRD_NONE, TownID::Invalid());
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de route refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_ROAD>(
				company, tile, false, tile, bits, road_type, DRD_NONE, TownID::Invalid());
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de route refusée.");
		reply.cost = result.GetCost();
		reply.tiles = 1;
		return Succeed(reply, "Route construite sur 1 tuile.");
	}

	/* Essai de tous les tronçons avant d'en construire un seul : une commande
	 * refusée laisse ainsi la carte strictement inchangée. */
	for (size_t i = 1; i < path.size(); i++) {
		const TileIndex start = path[i - 1];
		const TileIndex end = path[i];
		const Axis axis = TileY(start) != TileY(end) ? AXIS_Y : AXIS_X;
		CommandCost test = RunCompanyCommand<CMD_BUILD_LONG_ROAD>(
				company, end, true, end, start, road_type, axis, DRD_NONE, false, false, true);
		if (test.Failed()) {
			return FailFromCommand(reply, test, "COMMAND_FAILED", "Tronçon de route refusé : aucune tuile construite.");
		}
	}

	Money spent = 0;
	for (size_t i = 1; i < path.size(); i++) {
		const TileIndex start = path[i - 1];
		const TileIndex end = path[i];
		const Axis axis = TileY(start) != TileY(end) ? AXIS_Y : AXIS_X;
		CommandCost result = RunCompanyCommand<CMD_BUILD_LONG_ROAD>(
				company, end, false, end, start, road_type, axis, DRD_NONE, false, false, true);
		if (result.Failed()) {
			/* Ne peut arriver qu'en cas de changement d'état entre l'essai et
			 * l'exécution (autre commande, faillite) : on signale les tuiles
			 * déjà posées sans masquer l'erreur. */
			reply.cost = spent;
			reply.tiles = static_cast<int>(i);
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Tronçon de route interrompu.");
		}
		spent += result.GetCost();
	}

	reply.cost = spent;
	reply.tiles = static_cast<int>(path.size());
	return Succeed(reply, fmt::format("Route construite sur {} tuiles.", path.size()));
}

bool BuildRail(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	bool rail_type_ok = true;
	const RailType rail_type = RequestedRailType(company, options, rail_type_ok);
	if (!rail_type_ok || rail_type == INVALID_RAILTYPE) {
		return FailWith(reply, "NO_RAIL_TYPE",
				"Type de voie indisponible pour cette entreprise (rail, électrifié, monorail, maglev).");
	}

	std::string order = LowerAscii(OptionString(options, "order", "horizontal"));
	bool vertical_first = false;
	if (order == "vertical" || order == "y") {
		vertical_first = true;
	} else if (order != "horizontal" && order != "x") {
		return FailWith(reply, "INVALID_PARAMETER", "« options.order » doit valoir « horizontal » ou « vertical ».");
	}

	std::vector<TileIndex> path;
	MakeLPath(from_x, from_y, to_x, to_y, vertical_first, path);

	if (path.size() == 1) {
		Track track = TRACK_X;
		const std::string track_name = LowerAscii(OptionString(options, "track", "x"));
		if (!ParseTrackName(track_name, track)) {
			return FailWith(reply, "INVALID_PARAMETER", "« options.track » inconnu (x, y, upper, lower, left, right).");
		}
		const TileIndex tile = path.front();
		CommandCost test = RunCompanyCommand<CMD_BUILD_SINGLE_RAIL>(
				company, tile, true, tile, rail_type, track, false);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de voie refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_SINGLE_RAIL>(
				company, tile, false, tile, rail_type, track, false);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de voie refusée.");
		reply.cost = result.GetCost();
		reply.tiles = 1;
		return Succeed(reply, "Voie ferrée construite sur 1 tuile.");
	}

	for (size_t i = 1; i < path.size(); i++) {
		const TileIndex start = path[i - 1];
		const TileIndex end = path[i];
		const Axis axis = TileY(start) != TileY(end) ? AXIS_Y : AXIS_X;
		const Track track = axis == AXIS_X ? TRACK_X : TRACK_Y;
		CommandCost test = RunCompanyCommand<CMD_BUILD_RAILROAD_TRACK>(
				company, end, true, end, start, rail_type, track, false, false);
		if (test.Failed()) {
			return FailFromCommand(reply, test, "COMMAND_FAILED", "Tronçon de voie refusé : aucune tuile construite.");
		}
	}

	Money spent = 0;
	for (size_t i = 1; i < path.size(); i++) {
		const TileIndex start = path[i - 1];
		const TileIndex end = path[i];
		const Axis axis = TileY(start) != TileY(end) ? AXIS_Y : AXIS_X;
		const Track track = axis == AXIS_X ? TRACK_X : TRACK_Y;
		CommandCost result = RunCompanyCommand<CMD_BUILD_RAILROAD_TRACK>(
				company, end, false, end, start, rail_type, track, false, false);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = static_cast<int>(i);
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Tronçon de voie interrompu.");
		}
		spent += result.GetCost();
	}

	reply.cost = spent;
	reply.tiles = static_cast<int>(path.size());
	return Succeed(reply, fmt::format("Voie ferrée construite sur {} tuiles.", path.size()));
}

bool BuildStation(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	const TileIndex tile = TileXY(from_x, from_y);

	const std::string kind = LowerAscii(OptionString(options, "kind", OptionString(options, "station", "road")));
	const bool rail = kind == "rail" || kind == "train" || kind == "ferroviaire";
	const bool road = kind == "road" || kind == "bus" || kind == "truck" || kind == "camion" ||
			kind == "routiere" || kind == "routière";

	if (rail) {
		bool rail_type_ok = true;
		const RailType rail_type = RequestedRailType(company, options, rail_type_ok);
		if (!rail_type_ok || rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE",
					"Type de voie indisponible pour cette entreprise (rail, électrifié, monorail, maglev).");
		}

		Axis axis = AXIS_X;
		const std::string direction = LowerAscii(OptionString(options, "direction", OptionString(options, "axis", "")));
		if (!direction.empty()) {
			if (direction == "x" || direction == "ne" || direction == "sw" || direction == "ne-sw") {
				axis = AXIS_X;
			} else if (direction == "y" || direction == "nw" || direction == "se" || direction == "nw-se") {
				axis = AXIS_Y;
			} else {
				return FailWith(reply, "INVALID_PARAMETER", "« options.direction » inconnu (x, y, ne, nw, se, sw).");
			}
		} else if (has_to) {
			if (from_y == to_y) {
				axis = AXIS_X;
			} else if (from_x == to_x) {
				axis = AXIS_Y;
			} else {
				return FailWith(reply, "INVALID_PARAMETER", "Une gare ferroviaire doit être alignée sur x ou y.");
			}
		}

		int platforms = OptionInt(options, "platforms", OptionInt(options, "tracks", 1));
		int length = OptionInt(options, "length", OptionInt(options, "platform_length", 1));
		if (has_to) {
			const int distance = std::abs(to_x - from_x) + std::abs(to_y - from_y);
			if (OptionInt(options, "length", -1) < 0) length = distance + 1;
		}
		if (platforms < 1 || platforms > 8) {
			return FailWith(reply, "INVALID_PARAMETER", "« options.platforms » doit être compris entre 1 et 8.");
		}
		if (length < 1 || length > 16) {
			return FailWith(reply, "INVALID_PARAMETER", "« options.length » doit être compris entre 1 et 16.");
		}

		CommandCost test = RunCompanyCommand<CMD_BUILD_RAIL_STATION>(
				company, tile, true, tile, rail_type, axis,
				static_cast<uint8_t>(platforms), static_cast<uint8_t>(length),
				STAT_CLASS_DFLT, 0, StationID::Invalid(), true);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de gare refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_RAIL_STATION>(
				company, tile, false, tile, rail_type, axis,
				static_cast<uint8_t>(platforms), static_cast<uint8_t>(length),
				STAT_CLASS_DFLT, 0, StationID::Invalid(), true);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de gare refusée.");
		reply.cost = result.GetCost();
		reply.station = GetStationIndex(tile);
		reply.tiles = platforms * length;
		return Succeed(reply, fmt::format("Gare ferroviaire construite ({} voie(s) × {} tuile(s)).", platforms, length));
	}

	if (road) {
		const RoadType road_type = SelectRoadType(company);
		if (road_type == INVALID_ROADTYPE) {
			return FailWith(reply, "NO_ROAD_TYPE", "Aucun type de route disponible pour cette entreprise.");
		}
		if (has_to && (std::abs(to_x - from_x) + std::abs(to_y - from_y)) > 1) {
			return FailWith(reply, "NOT_SUPPORTED",
					"Les gares routières multi-tuiles ne sont pas supportées : utilisez une tuile ou une tuile adjacente.");
		}

		const bool truck = kind == "truck" || kind == "camion" ||
				LowerAscii(OptionString(options, "stop", "")) == "truck";
		const RoadStopType stop_type = truck ? RoadStopType::Truck : RoadStopType::Bus;
		const bool drive_through = OptionBool(options, "drive_through",
				OptionBool(options, "driveThrough", false));

		DiagDirection direction = OptionDiagDir(options, "direction", INVALID_DIAGDIR);
		if (direction == INVALID_DIAGDIR && has_to) {
			direction = DiagdirBetweenTiles(tile, TileXY(to_x, to_y));
		}
		if (direction == INVALID_DIAGDIR && drive_through && IsNormalRoadTile(tile)) {
			const RoadBits bits = GetRoadBits(tile, RTT_ROAD);
			if ((bits & ROAD_X) == ROAD_X) {
				direction = DIAGDIR_NE;
			} else if ((bits & ROAD_Y) == ROAD_Y) {
				direction = DIAGDIR_NW;
			}
		}
		if (direction == INVALID_DIAGDIR) {
			return FailWith(reply, "INVALID_PARAMETER",
					"« options.direction » requis pour une gare routière en passage (ne, se, sw, nw).");
		}

		CommandCost test = RunCompanyCommand<CMD_BUILD_ROAD_STOP>(
				company, tile, true, tile, 1, 1, stop_type, drive_through, direction,
				road_type, ROADSTOP_CLASS_DFLT, 0, StationID::Invalid(), true);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de gare refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_ROAD_STOP>(
				company, tile, false, tile, 1, 1, stop_type, drive_through, direction,
				road_type, ROADSTOP_CLASS_DFLT, 0, StationID::Invalid(), true);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de gare refusée.");
		reply.cost = result.GetCost();
		reply.station = GetStationIndex(tile);
		reply.tiles = 1;
		return Succeed(reply, truck ? "Gare de fret construite." : "Gare routière construite.");
	}

	return FailWith(reply, "UNKNOWN_TOOL", "« options.kind » doit valoir road, bus, truck ou rail.");
}

bool BuildDepot(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	const TileIndex tile = TileXY(from_x, from_y);
	const std::string kind = LowerAscii(OptionString(options, "kind", OptionString(options, "vehicle", "road")));
	const bool rail = kind == "rail" || kind == "train" || kind == "ferroviaire";
	const bool tram = kind == "tram";

	DiagDirection direction = OptionDiagDir(options, "direction", INVALID_DIAGDIR);
	if (direction == INVALID_DIAGDIR && has_to) {
		const TileIndex target = TileXY(to_x, to_y);
		if (std::abs(to_x - from_x) + std::abs(to_y - from_y) == 1) {
			direction = DiagdirBetweenTiles(tile, target);
		}
	}
	if (direction == INVALID_DIAGDIR) direction = FindEntranceDirection(tile, rail);
	if (direction == INVALID_DIAGDIR) direction = DIAGDIR_SE;

	if (rail) {
		bool rail_type_ok = true;
		const RailType rail_type = RequestedRailType(company, options, rail_type_ok);
		if (!rail_type_ok || rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE",
					"Type de voie indisponible pour cette entreprise (rail, électrifié, monorail, maglev).");
		}
		CommandCost test = RunCompanyCommand<CMD_BUILD_TRAIN_DEPOT>(
				company, tile, true, tile, rail_type, direction);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de dépôt refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_TRAIN_DEPOT>(
				company, tile, false, tile, rail_type, direction);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de dépôt refusée.");
		reply.cost = result.GetCost();
		reply.depot = GetDepotIndex(tile);
		reply.tiles = 1;
		return Succeed(reply, "Dépôt ferroviaire construit.");
	}

	if (kind == "road" || kind == "bus" || kind == "truck" || kind == "camion" ||
			kind == "routier" || tram) {
		const RoadType road_type = tram && HasRoadTypeAvail(company, ROADTYPE_TRAM)
				? ROADTYPE_TRAM
				: SelectRoadType(company);
		if (road_type == INVALID_ROADTYPE) {
			return FailWith(reply, "NO_ROAD_TYPE", "Aucun type de route disponible pour cette entreprise.");
		}
		CommandCost test = RunCompanyCommand<CMD_BUILD_ROAD_DEPOT>(
				company, tile, true, tile, road_type, direction);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de dépôt refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_ROAD_DEPOT>(
				company, tile, false, tile, road_type, direction);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de dépôt refusée.");
		reply.cost = result.GetCost();
		reply.depot = GetDepotIndex(tile);
		reply.tiles = 1;
		return Succeed(reply, tram ? "Dépôt de tramway construit." : "Dépôt routier construit.");
	}

	return FailWith(reply, "UNKNOWN_TOOL", "« options.kind » doit valoir road, tram ou rail.");
}

bool BuildSignal(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");

	/* Sens : unique par défaut, `direction` ou `both` peut demander deux sens. */
	const std::string direction = LowerAscii(OptionString(options, "direction", "both"));
	bool one_way = true;
	if (direction == "one-way" || direction == "oneway" || direction == "single" ||
			direction == "sens-unique" || direction == "unique") {
		one_way = true;
	} else if (direction == "both" || direction == "two-way" || direction == "twoway" ||
			direction == "bidirectional" || direction == "bidirectionnel") {
		one_way = false;
	} else {
		return FailWith(reply, "INVALID_PARAMETER",
				"« options.direction » doit valoir one-way ou both.");
	}
	if (OptionBool(options, "both", false)) one_way = false;

	const std::string type_name = LowerAscii(OptionString(options, "type", OptionString(options, "kind", "block")));
	SignalType signal_type = SIGTYPE_BLOCK;
	SignalVariant signal_variant = SIG_ELECTRIC;
	if (!ParseSignalTypeName(type_name, signal_type, signal_variant, one_way)) {
		return FailWith(reply, "INVALID_PARAMETER",
				"« options.type » inconnu (block, path, entry, exit, combo).");
	}
	if (OptionBool(options, "semaphore", false)) signal_variant = SIG_SEMAPHORE;

	std::vector<TileIndex> tiles;
	if (has_to) {
		if (from_x != to_x && from_y != to_y) {
			return FailWith(reply, "INVALID_PARAMETER", "Un alignement de signaux doit suivre x ou y.");
		}
		MakeLPath(from_x, from_y, to_x, to_y, false, tiles);
	} else {
		tiles.push_back(TileXY(from_x, from_y));
	}

	/* Densité : un signal toutes les N tuiles, comme le glissement OpenTTD. */
	const int spacing = std::max(1, std::min(8, OptionInt(options, "spacing", 1)));
	if (spacing > 1) {
		std::vector<TileIndex> spaced;
		for (size_t i = 0; i < tiles.size(); i += static_cast<size_t>(spacing)) {
			spaced.push_back(tiles[i]);
		}
		tiles = std::move(spaced);
	}

	/* Choix de la voie : unique, sinon `options.track` tranche. */
	Track forced_track = INVALID_TRACK;
	const std::string track_name = LowerAscii(OptionString(options, "track", ""));
	if (!track_name.empty() && !ParseTrackName(track_name, forced_track)) {
		return FailWith(reply, "INVALID_PARAMETER", "« options.track » inconnu (x, y, upper, lower, left, right).");
	}

	std::vector<Track> tracks;
	tracks.reserve(tiles.size());
	for (const TileIndex tile : tiles) {
		if (!IsPlainRailTile(tile)) {
			return FailWith(reply, "NO_RAIL_TRACK", "Un signal exige une voie ferrée sur la tuile.");
		}
		const TrackBits bits = GetTrackBits(tile);
		const uint8_t raw = static_cast<uint8_t>(bits & TRACK_BIT_MASK);
		Track track = forced_track;
		if (track == INVALID_TRACK) {
			if (raw == 0 || (raw & (raw - 1)) != 0) {
				return FailWith(reply, "AMBIGUOUS_TRACK",
						"Plusieurs voies sur cette tuile : précisez « options.track ».");
			}
			track = TrackBitsToTrack(bits);
		} else if ((raw & (1U << track)) == 0) {
			return FailWith(reply, "NO_RAIL_TRACK", "La voie demandée n'existe pas sur cette tuile.");
		}
		tracks.push_back(track);
	}

	/* Un seul signal est construit par tuile : `num_dir_cycle` alterne le côté
	 * pour obtenir un sens unique, 0 laisse le signal bidirectionnel. */
	const uint8_t dir_cycle = (one_way && !IsPbsSignal(signal_type)) ? 1 : 0;
	for (size_t i = 0; i < tiles.size(); i++) {
		const bool existing = HasSignalOnTrack(tiles[i], tracks[i]);
		CommandCost test = RunCompanyCommand<CMD_BUILD_SINGLE_SIGNAL>(
				company, tiles[i], true, tiles[i], tracks[i], signal_type, signal_variant,
				existing, false, false, SIGTYPE_BLOCK, SIGTYPE_BLOCK, dir_cycle, 0);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de signal refusée.");
	}

	Money spent = 0;
	for (size_t i = 0; i < tiles.size(); i++) {
		const bool existing = HasSignalOnTrack(tiles[i], tracks[i]);
		CommandCost result = RunCompanyCommand<CMD_BUILD_SINGLE_SIGNAL>(
				company, tiles[i], false, tiles[i], tracks[i], signal_type, signal_variant,
				existing, false, false, SIGTYPE_BLOCK, SIGTYPE_BLOCK, dir_cycle, 0);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = static_cast<int>(i);
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de signal interrompue.");
		}
		spent += result.GetCost();
	}

	reply.cost = spent;
	reply.tiles = static_cast<int>(tiles.size());
	return Succeed(reply, fmt::format("{} signal(aux) {} construit(s).", tiles.size(), type_name));
}

/**
 * Retire les signaux d'un alignement sans toucher à la voie (#156).
 * Utilise `CMD_REMOVE_SINGLE_SIGNAL`, qui facture la démolition du signal.
 */
bool BuildUnsignal(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");

	std::vector<TileIndex> tiles;
	if (has_to) {
		if (from_x != to_x && from_y != to_y) {
			return FailWith(reply, "INVALID_PARAMETER", "Un alignement de signaux doit suivre x ou y.");
		}
		MakeLPath(from_x, from_y, to_x, to_y, false, tiles);
	} else {
		tiles.push_back(TileXY(from_x, from_y));
	}

	Track forced_track = INVALID_TRACK;
	const std::string track_name = LowerAscii(OptionString(options, "track", ""));
	if (!track_name.empty() && !ParseTrackName(track_name, forced_track)) {
		return FailWith(reply, "INVALID_PARAMETER", "« options.track » inconnu (x, y, upper, lower, left, right).");
	}

	std::vector<Track> tracks;
	tracks.reserve(tiles.size());
	for (const TileIndex tile : tiles) {
		if (!IsPlainRailTile(tile) || !HasSignals(tile)) {
			return FailWith(reply, "NO_SIGNAL", "Aucun signal à retirer sur cette tuile.");
		}
		const uint8_t present = static_cast<uint8_t>(GetPresentSignals(tile));
		Track track = forced_track;
		if (track == INVALID_TRACK) {
			static constexpr Track kTracks[] = {
				TRACK_X, TRACK_Y, TRACK_UPPER, TRACK_LOWER, TRACK_LEFT, TRACK_RIGHT,
			};
			uint8_t count = 0;
			for (const Track candidate : kTracks) {
				if ((present & SignalOnTrack(candidate)) == 0) continue;
				track = candidate;
				count++;
			}
			if (count != 1) {
				return FailWith(reply, "AMBIGUOUS_TRACK",
						"Plusieurs voies portent un signal : précisez « options.track ».");
			}
		} else if ((present & SignalOnTrack(track)) == 0) {
			return FailWith(reply, "NO_SIGNAL", "La voie demandée ne porte pas de signal.");
		}
		tracks.push_back(track);
	}

	for (size_t i = 0; i < tiles.size(); i++) {
		CommandCost test = RunCompanyCommand<CMD_REMOVE_SINGLE_SIGNAL>(
				company, tiles[i], true, tiles[i], tracks[i]);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Retrait de signal refusé.");
	}

	Money spent = 0;
	for (size_t i = 0; i < tiles.size(); i++) {
		CommandCost result = RunCompanyCommand<CMD_REMOVE_SINGLE_SIGNAL>(
				company, tiles[i], false, tiles[i], tracks[i]);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = static_cast<int>(i);
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Retrait de signal interrompu.");
		}
		spent += result.GetCost();
	}

	reply.cost = spent;
	reply.tiles = static_cast<int>(tiles.size());
	return Succeed(reply, fmt::format("{} signal(aux) retiré(s).", tiles.size()));
}

/**
 * Convertit un tronçon vers un autre type de rail (#157) via `CMD_CONVERT_RAIL`.
 * Chaque tuile est testée avant toute exécution : une erreur laisse la carte
 * strictement inchangée.
 */
bool BuildConvertRail(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	bool rail_type_ok = true;
	const RailType rail_type = RequestedRailType(company, options, rail_type_ok);
	if (!rail_type_ok || rail_type == INVALID_RAILTYPE) {
		return FailWith(reply, "NO_RAIL_TYPE",
				"Type de rail indisponible (rail, électrifié, monorail, maglev).");
	}

	const std::string order = LowerAscii(OptionString(options, "order", "horizontal"));
	const bool vertical_first = order == "vertical" || order == "y";
	std::vector<TileIndex> tiles;
	MakeLPath(from_x, from_y, to_x, to_y, vertical_first, tiles);

	for (const TileIndex tile : tiles) {
		CommandCost test = RunCompanyCommand<CMD_CONVERT_RAIL>(
				company, tile, true, tile, tile, rail_type, false);
		if (test.Failed()) {
			return FailFromCommand(reply, test, "COMMAND_FAILED",
					"Conversion refusée : aucune tuile convertie.");
		}
	}

	Money spent = 0;
	for (const TileIndex tile : tiles) {
		CommandCost result = RunCompanyCommand<CMD_CONVERT_RAIL>(
				company, tile, false, tile, tile, rail_type, false);
		if (result.Failed()) {
			reply.cost = spent;
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Conversion interrompue.");
		}
		spent += result.GetCost();
	}

	reply.cost = spent;
	reply.tiles = static_cast<int>(tiles.size());
	return Succeed(reply, fmt::format("{} tuile(s) convertie(s) en {}.", tiles.size(), RailTypeName(rail_type)));
}

/** Familles de ponts exposées par l'UI, alignées sur le protocole #154. */
std::vector<BridgeType> BridgeMaterialCandidates(const std::string &material)
{
	if (material.empty()) {
		std::vector<BridgeType> all;
		for (BridgeType type = 0; type < MAX_BRIDGES; type++) all.push_back(type);
		return all;
	}
	if (material == "wood" || material == "bois") return {0};
	if (material == "concrete" || material == "beton" || material == "béton") return {1};
	if (material == "steel" || material == "acier" || material == "girder") return {2, 9};
	if (material == "suspension" || material == "suspendu") return {4, 5, 3};
	if (material == "cantilever") return {6, 8, 7};
	if (material == "tubular" || material == "tubulaire") return {10, 11, 12};
	return {};
}

/**
 * Choisit la spec de pont demandée, en respectant l'année et la portée comme
 * `CheckBridgeAvailability`. `options.bridge` (index brut) est prioritaire.
 */
std::optional<BridgeType> SelectBridgeType(const JsonValue *options, uint bridge_len)
{
	const int raw_index = OptionInt(options, "bridge", -1);
	if (raw_index >= 0) {
		if (static_cast<uint>(raw_index) >= MAX_BRIDGES) return std::nullopt;
		const BridgeType type = static_cast<BridgeType>(raw_index);
		if (CheckBridgeAvailability(type, bridge_len).Failed()) return std::nullopt;
		return type;
	}
	const std::string material = LowerAscii(OptionString(options, "material", ""));
	const std::vector<BridgeType> candidates = BridgeMaterialCandidates(material);
	if (candidates.empty()) return std::nullopt;
	for (const BridgeType type : candidates) {
		if (CheckBridgeAvailability(type, bridge_len).Succeeded()) return type;
	}
	return std::nullopt;
}

/**
 * Vérifie qu'un pont franchit un obstacle réel et que ses deux rampes
 * rejoignent une approche plane. Sans ce garde-fou, OpenTTD accepte un pont
 * posé sur du terrain plat, puis le rendu produit un ouvrage massif et inutile.
 * Les mêmes invariants sont appliqués côté mock (`planBridge`, #201).
 */
bool ValidateBridgeLanding(TileIndex tile, uint expected_height)
{
	if (IsWaterTile(tile)) return false;
	switch (GetTileType(tile)) {
		case MP_VOID:
		case MP_HOUSE:
		case MP_INDUSTRY:
		case MP_STATION:
		case MP_TUNNELBRIDGE:
		case MP_OBJECT:
			return false;
		default:
			break;
	}
	return TileHeight(tile) == expected_height;
}

bool ValidateBridgeSpan(CommandReply &reply, int from_x, int from_y, int to_x, int to_y)
{
	const TileIndex start = TileXY(from_x, from_y);
	const TileIndex end = TileXY(to_x, to_y);
	const int dx = (to_x > from_x) - (to_x < from_x);
	const int dy = (to_y > from_y) - (to_y < from_y);
	const uint start_height = TileHeight(start);
	const uint end_height = TileHeight(end);

	/* Une tuile d'approche plane derrière chaque culée. */
	const int ax = from_x - dx;
	const int ay = from_y - dy;
	const int bx = to_x + dx;
	const int by = to_y + dy;
	if (!IsTileInMap(ax, ay) || !IsTileInMap(bx, by)) {
		return FailWith(reply, "BRIDGE_APPROACH",
				"La rampe du pont sort de la carte : reculez la culée d’une tuile.");
	}
	if (!ValidateBridgeLanding(TileXY(ax, ay), start_height) ||
			!ValidateBridgeLanding(TileXY(bx, by), end_height)) {
		return FailWith(reply, "BRIDGE_APPROACH",
				"La rampe du pont doit rejoindre une approche plane au même niveau, sur la terre ferme.");
	}

	const uint bridge_len = GetTunnelBridgeLength(start, end);
	int first_obstacle = -1;
	int last_obstacle = -1;
	int index = 0;
	for (int x = from_x + dx, y = from_y + dy; x != to_x || y != to_y; x += dx, y += dy) {
		const TileIndex tile = TileXY(x, y);
		const auto type = GetTileType(tile);
		const bool obstacle = IsWaterTile(tile) || type == MP_ROAD || type == MP_RAILWAY ||
				type == MP_TUNNELBRIDGE || TileHeight(tile) + 2 <= start_height;
		if (obstacle) {
			if (first_obstacle < 0) first_obstacle = index;
			last_obstacle = index;
		}
		index++;
	}
	if (bridge_len == 0 || first_obstacle < 0) {
		return FailWith(reply, "BRIDGE_NO_OBSTACLE",
				"Un pont doit franchir un obstacle réel (eau, vallée, route ou voie ferrée).");
	}
	if (first_obstacle > 1 || index - 1 - last_obstacle > 1) {
		return FailWith(reply, "BRIDGE_OVERHANG",
				"Portée incohérente : le tablier déborde sur la terre ferme. Placez les culées au bord de l’obstacle.");
	}
	return true;
}

bool BuildBridge(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	if (!has_to) {
		return FailWith(reply, "INVALID_PARAMETER", "Un pont exige deux culées (« from » et « to »).");
	}
	const JsonValue *options = root.Find("options");
	const std::string kind = LowerAscii(OptionString(options, "kind", OptionString(options, "transport", "rail")));
	const bool rail = kind == "rail" || kind == "train" || kind == "ferroviaire";
	const bool road = kind == "road" || kind == "route" || kind == "routier" ||
			kind == "bus" || kind == "truck" || kind == "camion";
	if (!rail && !road) {
		return FailWith(reply, "INVALID_PARAMETER", "« options.kind » doit valoir rail ou road.");
	}

	uint8_t road_rail_type = 0;
	RailType rail_type = INVALID_RAILTYPE;
	RoadType road_type = INVALID_ROADTYPE;
	if (rail) {
		rail_type = SelectRailType(company);
		const int requested = OptionInt(options, "rail_type", -1);
		if (requested >= 0) {
			if (static_cast<uint>(requested) >= RAILTYPE_END || !HasRailTypeAvail(company, static_cast<RailType>(requested))) {
				return FailWith(reply, "NO_RAIL_TYPE", "Type de rail demandé indisponible pour cette entreprise.");
			}
			rail_type = static_cast<RailType>(requested);
		}
		if (rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE", "Aucun type de voie disponible pour cette entreprise.");
		}
		road_rail_type = static_cast<uint8_t>(rail_type);
	} else {
		road_type = SelectRoadType(company);
		const int requested = OptionInt(options, "road_type", -1);
		if (requested >= 0) {
			if (static_cast<uint>(requested) >= ROADTYPE_END || !HasRoadTypeAvail(company, static_cast<RoadType>(requested))) {
				return FailWith(reply, "NO_ROAD_TYPE", "Type de route demandé indisponible pour cette entreprise.");
			}
			road_type = static_cast<RoadType>(requested);
		}
		if (road_type == INVALID_ROADTYPE) {
			return FailWith(reply, "NO_ROAD_TYPE", "Aucun type de route disponible pour cette entreprise.");
		}
		road_rail_type = static_cast<uint8_t>(road_type);
	}

	const TileIndex start = TileXY(from_x, from_y);
	const TileIndex end = TileXY(to_x, to_y);
	if (start == end) {
		return FailWith(reply, "INVALID_PARAMETER", "Un pont relie deux tuiles distinctes.");
	}
	if (from_x != to_x && from_y != to_y) {
		return FailWith(reply, "INVALID_PARAMETER", "Un pont doit être aligné sur X ou Y.");
	}

	const uint bridge_len = GetTunnelBridgeLength(start, end);
	const std::string material = LowerAscii(OptionString(options, "material", ""));
	if (!material.empty() && OptionInt(options, "bridge", -1) < 0 &&
			BridgeMaterialCandidates(material).empty()) {
		return FailWith(reply, "INVALID_PARAMETER",
				"« options.material » inconnu (wood, concrete, steel, suspension, cantilever, tubular).");
	}
	const std::optional<BridgeType> bridge_type = SelectBridgeType(options, bridge_len);
	if (!bridge_type) {
		return FailWith(reply, "BRIDGE_TOO_LONG",
				fmt::format("Aucun pont disponible pour une portée de {} tuiles à cette date.", bridge_len));
	}

	if (!ValidateBridgeSpan(reply, from_x, from_y, to_x, to_y)) return false;

	const TransportType transport = rail ? TRANSPORT_RAIL : TRANSPORT_ROAD;
	const CommandCost test = RunCompanyCommand<CMD_BUILD_BRIDGE>(
			company, end, true, end, start, transport, *bridge_type, road_rail_type);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de pont refusée.");
	const CommandCost result = RunCompanyCommand<CMD_BUILD_BRIDGE>(
			company, end, false, end, start, transport, *bridge_type, road_rail_type);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de pont refusée.");

	const uint32_t track_bits = (bridge_len + 2);
	reply.cost = result.GetCost();
	reply.tiles = static_cast<int>(bridge_len + 2);
	reply.maintenance = rail
			? RailMaintenanceCost(rail_type, track_bits, track_bits)
			: RoadMaintenanceCost(road_type, track_bits * 2, track_bits * 2);
	return Succeed(reply, fmt::format("Pont construit sur {} tuiles.", bridge_len + 2));
}

bool BuildTunnel(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	if (!has_to) {
		return FailWith(reply, "INVALID_PARAMETER", "Un tunnel exige deux portails (« from » et « to »).");
	}
	const JsonValue *options = root.Find("options");
	const std::string kind = LowerAscii(OptionString(options, "kind", OptionString(options, "transport", "rail")));
	const bool rail = kind == "rail" || kind == "train" || kind == "ferroviaire";
	const bool road = kind == "road" || kind == "route" || kind == "routier" ||
			kind == "bus" || kind == "truck" || kind == "camion";
	if (!rail && !road) {
		return FailWith(reply, "INVALID_PARAMETER", "« options.kind » doit valoir rail ou road.");
	}

	RailType rail_type = INVALID_RAILTYPE;
	RoadType road_type = INVALID_ROADTYPE;
	uint8_t road_rail_type = 0;
	if (rail) {
		rail_type = SelectRailType(company);
		const int requested = OptionInt(options, "rail_type", -1);
		if (requested >= 0) {
			if (static_cast<uint>(requested) >= RAILTYPE_END || !HasRailTypeAvail(company, static_cast<RailType>(requested))) {
				return FailWith(reply, "NO_RAIL_TYPE", "Type de rail demandé indisponible pour cette entreprise.");
			}
			rail_type = static_cast<RailType>(requested);
		}
		if (rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE", "Aucun type de voie disponible pour cette entreprise.");
		}
		road_rail_type = static_cast<uint8_t>(rail_type);
	} else {
		road_type = SelectRoadType(company);
		const int requested = OptionInt(options, "road_type", -1);
		if (requested >= 0) {
			if (static_cast<uint>(requested) >= ROADTYPE_END || !HasRoadTypeAvail(company, static_cast<RoadType>(requested))) {
				return FailWith(reply, "NO_ROAD_TYPE", "Type de route demandé indisponible pour cette entreprise.");
			}
			road_type = static_cast<RoadType>(requested);
		}
		if (road_type == INVALID_ROADTYPE) {
			return FailWith(reply, "NO_ROAD_TYPE", "Aucun type de route disponible pour cette entreprise.");
		}
		road_rail_type = static_cast<uint8_t>(road_type);
	}

	if (from_x != to_x && from_y != to_y) {
		return FailWith(reply, "INVALID_PARAMETER", "Un tunnel doit être aligné sur X ou Y.");
	}
	const TileIndex from_tile = TileXY(from_x, from_y);
	const TileIndex to_tile = TileXY(to_x, to_y);
	if (from_tile == to_tile) {
		return FailWith(reply, "INVALID_PARAMETER", "Un tunnel relie deux tuiles distinctes.");
	}

	const TransportType transport = rail ? TRANSPORT_RAIL : TRANSPORT_ROAD;
	/* OpenTTD déduit le sens du tunnel depuis la pente du portail de départ.
	 * On essaie donc les deux extrémités et on ne retient que celle qui
	 * ressort exactement sur l'autre tuile demandée. */
	std::optional<CommandCost> failure;
	TileIndex start_tile = INVALID_TILE;
	for (const TileIndex candidate : {from_tile, to_tile}) {
		const TileIndex expected = candidate == from_tile ? to_tile : from_tile;
		const CommandCost estimate = RunCompanyCommand<CMD_BUILD_TUNNEL>(
				company, candidate, true, candidate, transport, road_rail_type);
		if (estimate.Failed()) {
			if (!failure.has_value()) failure = estimate;
			continue;
		}
		if (_build_tunnel_endtile != expected) continue;
		start_tile = candidate;
		break;
	}
	if (start_tile == INVALID_TILE) {
		if (failure.has_value()) {
			return FailFromCommand(reply, *failure, "COMMAND_FAILED", "Construction de tunnel refusée.");
		}
		return FailWith(reply, "SITE_UNSUITABLE_FOR_TUNNEL",
				"Les deux portails doivent être sur des pentes opposées, à la même hauteur.");
	}

	const CommandCost result = RunCompanyCommand<CMD_BUILD_TUNNEL>(
			company, start_tile, false, start_tile, transport, road_rail_type);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de tunnel refusée.");
	const TileIndex end_tile = _build_tunnel_endtile;
	const uint tunnel_len = GetTunnelBridgeLength(start_tile, end_tile) + 2;
	reply.cost = result.GetCost();
	reply.tiles = static_cast<int>(tunnel_len);
	reply.maintenance = rail
			? RailMaintenanceCost(rail_type, tunnel_len, tunnel_len)
			: RoadMaintenanceCost(road_type, tunnel_len * 2, tunnel_len * 2);
	return Succeed(reply, fmt::format("Tunnel construit sur {} tuiles.", tunnel_len));
}

bool BuildClear(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}

	const int min_x = std::min(from_x, to_x);
	const int max_x = std::max(from_x, to_x);
	const int min_y = std::min(from_y, to_y);
	const int max_y = std::max(from_y, to_y);
	const int64_t area = static_cast<int64_t>(max_x - min_x + 1) * (max_y - min_y + 1);
	if (area > 1024) {
		return FailWith(reply, "TOO_MANY_TILES", "Zone trop grande : 1 024 tuiles maximum par commande.");
	}

	std::vector<TileIndex> tiles;
	tiles.reserve(static_cast<size_t>(area));
	for (int y = min_y; y <= max_y; y++) {
		for (int x = min_x; x <= max_x; x++) tiles.push_back(TileXY(x, y));
	}

	for (const TileIndex tile : tiles) {
		CommandCost test = RunCompanyCommand<CMD_LANDSCAPE_CLEAR>(company, tile, true, tile);
		if (test.Failed()) {
			return FailFromCommand(reply, test, "COMMAND_FAILED", "Démolition refusée : aucune tuile modifiée.");
		}
	}

	Money spent = 0;
	int cleared = 0;
	for (const TileIndex tile : tiles) {
		CommandCost result = RunCompanyCommand<CMD_LANDSCAPE_CLEAR>(company, tile, false, tile);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = cleared;
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Démolition interrompue.");
		}
		spent += result.GetCost();
		cleared++;
	}

	reply.cost = spent;
	reply.tiles = cleared;
	return Succeed(reply, fmt::format("{} tuile(s) démolie(s).", cleared));
}

bool BuildTerraform(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	const std::string direction = LowerAscii(OptionString(options, "direction", OptionString(options, "mode", "up")));
	bool dir_up = true;
	if (direction == "up" || direction == "raise" || direction == "monter" || direction == "montee") {
		dir_up = true;
	} else if (direction == "down" || direction == "lower" || direction == "descendre" || direction == "descente") {
		dir_up = false;
	} else {
		return FailWith(reply, "INVALID_PARAMETER", "« options.direction » doit valoir up ou down.");
	}

	if (!has_to) {
		const int size = std::max(1, std::min(4, OptionInt(options, "size", 1)));
		to_x = std::min<int>(static_cast<int>(Map::SizeX()) - 1, from_x + size - 1);
		to_y = std::min<int>(static_cast<int>(Map::SizeY()) - 1, from_y + size - 1);
	}
	const int min_x = std::min(from_x, to_x);
	const int max_x = std::max(from_x, to_x);
	const int min_y = std::min(from_y, to_y);
	const int max_y = std::max(from_y, to_y);
	const int64_t area = static_cast<int64_t>(max_x - min_x + 1) * (max_y - min_y + 1);
	if (area > 256) {
		return FailWith(reply, "TOO_MANY_TILES", "Zone trop grande : 256 tuiles maximum par terrassement.");
	}

	std::vector<TileIndex> tiles;
	tiles.reserve(static_cast<size_t>(area));
	for (int y = min_y; y <= max_y; y++) {
		for (int x = min_x; x <= max_x; x++) tiles.push_back(TileXY(x, y));
	}

	const Slope slope = static_cast<Slope>(SLOPE_N | SLOPE_E | SLOPE_S | SLOPE_W);
	for (const TileIndex tile : tiles) {
		auto test = RunCompanyCommand<CMD_TERRAFORM_LAND>(company, tile, true, tile, slope, dir_up);
		const CommandCost cost = CostOf(test);
		if (cost.Failed()) return FailFromCommand(reply, cost, "COMMAND_FAILED", "Terrassement refusé : aucune tuile modifiée.");
	}

	Money spent = 0;
	int changed = 0;
	for (const TileIndex tile : tiles) {
		auto result = RunCompanyCommand<CMD_TERRAFORM_LAND>(company, tile, false, tile, slope, dir_up);
		const CommandCost cost = CostOf(result);
		if (cost.Failed()) {
			reply.cost = spent;
			reply.tiles = changed;
			return FailFromCommand(reply, cost, "COMMAND_FAILED", "Terrassement interrompu.");
		}
		spent += cost.GetCost();
		changed++;
	}
	reply.cost = spent;
	reply.tiles = changed;
	return Succeed(reply, fmt::format("Terrassement : {} tuile(s) {}.", changed, dir_up ? "surélevée(s)" : "abaissée(s)"));
}

bool BuildTree(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	if (!has_to) {
		const int size = std::max(1, std::min(4, OptionInt(options, "size", 1)));
		to_x = std::min<int>(static_cast<int>(Map::SizeX()) - 1, from_x + size - 1);
		to_y = std::min<int>(static_cast<int>(Map::SizeY()) - 1, from_y + size - 1);
	}
	const int min_x = std::min(from_x, to_x);
	const int max_x = std::max(from_x, to_x);
	const int min_y = std::min(from_y, to_y);
	const int max_y = std::max(from_y, to_y);
	const int64_t area = static_cast<int64_t>(max_x - min_x + 1) * (max_y - min_y + 1);
	if (area > 256) {
		return FailWith(reply, "TOO_MANY_TILES", "Zone trop grande : 256 tuiles maximum par plantation.");
	}
	const int raw_tree = OptionInt(options, "tree", -1);
	if (raw_tree > 255) {
		return FailWith(reply, "INVALID_PARAMETER", "« options.tree » doit être compris entre 0 et 255.");
	}
	const uint8_t tree = raw_tree < 0 ? TREE_INVALID : static_cast<uint8_t>(raw_tree);

	std::vector<TileIndex> tiles;
	tiles.reserve(static_cast<size_t>(area));
	for (int y = min_y; y <= max_y; y++) {
		for (int x = min_x; x <= max_x; x++) tiles.push_back(TileXY(x, y));
	}

	for (const TileIndex tile : tiles) {
		CommandCost test = RunCompanyCommand<CMD_PLANT_TREE>(company, tile, true, tile, tile, tree, false);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Plantation refusée : aucune tuile modifiée.");
	}

	Money spent = 0;
	int planted = 0;
	for (const TileIndex tile : tiles) {
		CommandCost result = RunCompanyCommand<CMD_PLANT_TREE>(company, tile, false, tile, tile, tree, false);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = planted;
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Plantation interrompue.");
		}
		spent += result.GetCost();
		planted++;
	}
	reply.cost = spent;
	reply.tiles = planted;
	return Succeed(reply, fmt::format("{} tuile(s) plantée(s) en arbres.", planted));
}

bool BuildCanal(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const JsonValue *options = root.Find("options");
	std::string order = LowerAscii(OptionString(options, "order", OptionString(options, "axis", "horizontal")));
	bool vertical_first = false;
	if (order == "vertical" || order == "y") {
		vertical_first = true;
	} else if (order != "horizontal" && order != "x") {
		return FailWith(reply, "INVALID_PARAMETER", "« options.order » doit valoir « horizontal » ou « vertical ».");
	}

	std::vector<TileIndex> path;
	MakeLPath(from_x, from_y, to_x, to_y, vertical_first, path);
	if (path.size() == 1) {
		CommandCost test = RunCompanyCommand<CMD_BUILD_CANAL>(company, path.front(), true, path.front(), path.front(), WaterClass::Canal, false);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de canal refusée.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_CANAL>(company, path.front(), false, path.front(), path.front(), WaterClass::Canal, false);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de canal refusée.");
		reply.cost = result.GetCost();
		reply.tiles = 1;
		return Succeed(reply, "Canal construit sur 1 tuile.");
	}

	for (size_t i = 1; i < path.size(); i++) {
		CommandCost test = RunCompanyCommand<CMD_BUILD_CANAL>(company, path[i], true, path[i], path[i - 1], WaterClass::Canal, false);
		if (test.Failed()) {
			return FailFromCommand(reply, test, "COMMAND_FAILED", "Tronçon de canal refusé : aucune tuile construite.");
		}
	}
	Money spent = 0;
	for (size_t i = 1; i < path.size(); i++) {
		CommandCost result = RunCompanyCommand<CMD_BUILD_CANAL>(company, path[i], false, path[i], path[i - 1], WaterClass::Canal, false);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = static_cast<int>(i);
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Tronçon de canal interrompu.");
		}
		spent += result.GetCost();
	}
	reply.cost = spent;
	reply.tiles = static_cast<int>(path.size());
	return Succeed(reply, fmt::format("Canal construit sur {} tuiles.", path.size()));
}

bool BuildLock(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const TileIndex tile = TileXY(from_x, from_y);
	CommandCost test = RunCompanyCommand<CMD_BUILD_LOCK>(company, tile, true, tile);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction d'écluse refusée.");
	CommandCost result = RunCompanyCommand<CMD_BUILD_LOCK>(company, tile, false, tile);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction d'écluse refusée.");
	reply.cost = result.GetCost();
	reply.tiles = 1;
	return Succeed(reply, "Écluse construite.");
}

bool BuildAqueduct(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	if (!has_to || (from_x != to_x && from_y != to_y)) {
		return FailWith(reply, "INVALID_PARAMETER", "Un aqueduc doit relier deux tuiles alignées sur x ou y.");
	}
	const TileIndex start = TileXY(from_x, from_y);
	const TileIndex end = TileXY(to_x, to_y);
	CommandCost test = RunCompanyCommand<CMD_BUILD_BRIDGE>(
			company, end, true, end, start, TRANSPORT_WATER, static_cast<BridgeType>(0), 0);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction d'aqueduc refusée.");
	CommandCost result = RunCompanyCommand<CMD_BUILD_BRIDGE>(
			company, end, false, end, start, TRANSPORT_WATER, static_cast<BridgeType>(0), 0);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction d'aqueduc refusée.");
	reply.cost = result.GetCost();
	reply.tiles = std::abs(to_x - from_x) + std::abs(to_y - from_y) + 1;
	return Succeed(reply, fmt::format("Aqueduc construit sur {} tuiles.", reply.tiles));
}

bool BuildCrossing(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int from_x, from_y, to_x, to_y;
	bool has_to = false;
	if (!ReadFromTo(root, from_x, from_y, to_x, to_y, has_to)) {
		return FailWith(reply, "INVALID_PARAMETER", "Coordonnées « from »/« to » invalides ou hors carte.");
	}
	const TileIndex tile = TileXY(from_x, from_y);

	/* OpenTTD 15.3 n'a pas de commande dédiée : le passage à niveau est créé
	 * en posant la route sur la voie (ou la voie sur la route). */
	if (IsPlainRailTile(tile)) {
		const TrackBits bits = GetTrackBits(tile);
		if (bits != TRACK_BIT_X && bits != TRACK_BIT_Y) {
			return FailWith(reply, "INVALID_PARAMETER", "Le passage à niveau exige une voie ferrée droite.");
		}
		const RoadType road_type = SelectRoadType(company);
		if (road_type == INVALID_ROADTYPE) {
			return FailWith(reply, "NO_ROAD_TYPE", "Aucun type de route disponible pour cette entreprise.");
		}
		const RoadBits road_bits = bits == TRACK_BIT_X ? ROAD_Y : ROAD_X;
		CommandCost test = RunCompanyCommand<CMD_BUILD_ROAD>(
				company, tile, true, tile, road_bits, road_type, DRD_NONE, TownID::Invalid());
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Passage à niveau refusé.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_ROAD>(
				company, tile, false, tile, road_bits, road_type, DRD_NONE, TownID::Invalid());
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Passage à niveau refusé.");
		reply.cost = result.GetCost();
		reply.tiles = 1;
		return Succeed(reply, "Passage à niveau construit.");
	}

	if (IsNormalRoadTile(tile)) {
		const RoadBits road_bits = GetRoadBits(tile, RTT_ROAD);
		if (road_bits != ROAD_X && road_bits != ROAD_Y) {
			return FailWith(reply, "INVALID_PARAMETER", "Le passage à niveau exige une route droite.");
		}
		const RailType rail_type = SelectRailType(company);
		if (rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE", "Aucun type de voie disponible pour cette entreprise.");
		}
		const Track track = road_bits == ROAD_X ? TRACK_Y : TRACK_X;
		CommandCost test = RunCompanyCommand<CMD_BUILD_SINGLE_RAIL>(
				company, tile, true, tile, rail_type, track, false);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Passage à niveau refusé.");
		CommandCost result = RunCompanyCommand<CMD_BUILD_SINGLE_RAIL>(
				company, tile, false, tile, rail_type, track, false);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Passage à niveau refusé.");
		reply.cost = result.GetCost();
		reply.tiles = 1;
		return Succeed(reply, "Passage à niveau construit.");
	}

	return FailWith(reply, "INVALID_PARAMETER", "Un passage à niveau se pose sur une voie ferrée ou une route.");
}

bool DispatchBuild(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	std::string tool;
	if (!JsonGetString(root.Find("tool"), tool)) {
		return FailWith(reply, "UNKNOWN_TOOL", "Le champ « tool » doit être une chaîne.");
	}
	tool = LowerAscii(tool);

	if (tool == "road" || tool == "route") return BuildRoad(company, root, reply);
	if (tool == "rail" || tool == "railway" || tool == "voie") return BuildRail(company, root, reply);
	if (tool == "station" || tool == "gare") return BuildStation(company, root, reply);
	if (tool == "depot" || tool == "depot_road" || tool == "depot_rail") return BuildDepot(company, root, reply);
	if (tool == "signal" || tool == "signaux") return BuildSignal(company, root, reply);
	if (tool == "unsignal" || tool == "remove_signal" || tool == "remove-signal") return BuildUnsignal(company, root, reply);
	if (tool == "convert" || tool == "railtype" || tool == "convert_rail") return BuildConvertRail(company, root, reply);
	if (tool == "clear" || tool == "demolish" || tool == "demolition") return BuildClear(company, root, reply);
	if (tool == "terraform" || tool == "terrassement" || tool == "land") return BuildTerraform(company, root, reply);
	if (tool == "tree" || tool == "trees" || tool == "arbre" || tool == "arbres") return BuildTree(company, root, reply);
	if (tool == "canal" || tool == "canaux") return BuildCanal(company, root, reply);
	if (tool == "lock" || tool == "ecluse" || tool == "écluse") return BuildLock(company, root, reply);
	if (tool == "aqueduct" || tool == "aqueduc" || tool == "aqueducs") return BuildAqueduct(company, root, reply);
	if (tool == "crossing" || tool == "level_crossing" || tool == "passage_a_niveau") return BuildCrossing(company, root, reply);
	if (tool == "bridge" || tool == "pont" || tool == "ponts") return BuildBridge(company, root, reply);
	if (tool == "tunnel" || tool == "tunnels") return BuildTunnel(company, root, reply);
	return FailWith(reply, "UNKNOWN_TOOL", fmt::format("Outil de construction inconnu « {} ».", tool));
}

/* ------------------------------------------------------------------------- */
/*  Véhicules                                                                */
/* ------------------------------------------------------------------------- */

Vehicle *FindVehicle(const JsonValue &root, CompanyID company, CommandReply &reply)
{
	int id = 0;
	if (!JsonGetInt(root.Find("vehicle"), id) || id < 0) {
		FailWith(reply, "INVALID_PARAMETER", "Le champ « vehicle » doit être un identifiant entier.");
		return nullptr;
	}
	Vehicle *vehicle = Vehicle::GetIfValid(VehicleID(static_cast<uint16_t>(id)));
	if (vehicle == nullptr) {
		FailWith(reply, "UNKNOWN_VEHICLE", fmt::format("Véhicule {} inexistant.", id));
		return nullptr;
	}
	if (vehicle->owner != company) {
		FailWith(reply, "WRONG_OWNER", "Ce véhicule appartient à une autre entreprise.");
		return nullptr;
	}
	return vehicle;
}

/**
 * Type de véhicule attendu d'après un mot-clé de modèle (`bus`, `train`…), ou
 * `VEH_INVALID` quand le libellé ne permet pas de conclure (id numérique, nom
 * NewGRF…). Sert à refuser tôt un véhicule incompatible avec le dépôt.
 */
VehicleType ModelVehicleType(const std::string &model)
{
	const std::string needle = LowerAscii(model);
	if (needle == "bus" || needle == "truck" || needle == "camion" || needle == "tram" ||
			needle == "fret" || needle == "marchandises") {
		return VEH_ROAD;
	}
	if (needle == "train" || needle == "locomotive" || needle == "loco") return VEH_TRAIN;
	if (needle == "ship" || needle == "bateau" || needle == "navire") return VEH_SHIP;
	if (needle == "aircraft" || needle == "avion") return VEH_AIRCRAFT;
	return VEH_INVALID;
}

/** Type exact d'un groupe (`train`, `road`, `ship`, `aircraft`). */
VehicleType ParseVehicleKind(const std::string &kind)
{
	const std::string needle = LowerAscii(kind);
	if (needle == "train" || needle == "rail") return VEH_TRAIN;
	if (needle == "road" || needle == "route") return VEH_ROAD;
	if (needle == "ship" || needle == "bateau") return VEH_SHIP;
	if (needle == "aircraft" || needle == "avion") return VEH_AIRCRAFT;
	return VEH_INVALID;
}

/**
 * Résout la tuile du dépôt désigné par `depotId` (prioritaire) ou `depot {x,y}`
 * et vérifie qu'il appartient à `company`.
 *
 * @return la tuile du dépôt, ou `INVALID_TILE` après avoir rempli `reply`.
 */
TileIndex ResolveDepotTile(const JsonValue &root, CompanyID company, CommandReply &reply)
{
	const JsonValue *id_value = root.Find("depotId");
	if (id_value != nullptr && !id_value->IsNull()) {
		int id = 0;
		if (!JsonGetInt(id_value, id) || id < 0 || id > 0xFFFF) {
			FailWith(reply, "INVALID_PARAMETER", "« depotId » doit être un entier entre 0 et 65535.");
			return INVALID_TILE;
		}
		if (!Depot::IsValidID(DepotID(static_cast<uint16_t>(id)))) {
			FailWith(reply, "UNKNOWN_DEPOT", fmt::format("Dépôt {} inexistant.", id));
			return INVALID_TILE;
		}
		const TileIndex tile = Depot::Get(DepotID(static_cast<uint16_t>(id)))->xy;
		if (!IsTileOwner(tile, company)) {
			FailWith(reply, "WRONG_OWNER", "Ce dépôt appartient à une autre entreprise.");
			return INVALID_TILE;
		}
		return tile;
	}

	int depot_x, depot_y;
	if (!JsonGetTile(root.Find("depot"), depot_x, depot_y) || !IsTileInMap(depot_x, depot_y)) {
		FailWith(reply, "INVALID_PARAMETER", "Indiquez « depotId » ou « depot » (tuile de la carte).");
		return INVALID_TILE;
	}
	const TileIndex tile = TileXY(depot_x, depot_y);
	if (!IsDepotTile(tile)) {
		FailWith(reply, "NOT_A_DEPOT", "L'achat d'un véhicule exige une tuile de dépôt.");
		return INVALID_TILE;
	}
	if (!IsTileOwner(tile, company)) {
		FailWith(reply, "WRONG_OWNER", "Ce dépôt appartient à une autre entreprise.");
		return INVALID_TILE;
	}
	return tile;
}

bool VehicleBuy(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	const TileIndex tile = ResolveDepotTile(root, company, reply);
	if (tile == INVALID_TILE) return false;

	const VehicleType type = GetDepotVehicleType(tile);
	std::string model;
	JsonGetString(root.Find("model"), model);
	const VehicleType requested = ModelVehicleType(model);
	if (requested != VEH_INVALID && requested != type) {
		const char *depot_label = type == VEH_TRAIN ? "ferroviaire"
				: type == VEH_ROAD ? "routier" : "de ce type";
		return FailWith(reply, "WRONG_DEPOT_TYPE",
				fmt::format("« {} » ne peut pas être acheté dans un dépôt {}.", model, depot_label));
	}

	const EngineID engine = SelectEngine(company, type, model);
	if (engine == EngineID::Invalid()) {
		return FailWith(reply, "NO_ENGINE",
				model.empty()
						? "Aucun véhicule disponible pour ce dépôt à cette date."
						: fmt::format("Aucun véhicule ne correspond à « {} » dans ce dépôt.", model));
	}

	auto test = RunCompanyCommand<CMD_BUILD_VEHICLE>(
			company, tile, true, tile, engine, true, INVALID_CARGO, CLIENT_ID_SERVER);
	if (std::get<0>(test).Failed()) {
		return FailFromCommand(reply, std::get<0>(test), "COMMAND_FAILED", "Achat du véhicule refusé.");
	}
	auto result = RunCompanyCommand<CMD_BUILD_VEHICLE>(
			company, tile, false, tile, engine, true, INVALID_CARGO, CLIENT_ID_SERVER);
	CommandCost cost = std::get<0>(result);
	if (cost.Failed()) return FailFromCommand(reply, cost, "COMMAND_FAILED", "Achat du véhicule refusé.");

	reply.cost = cost.GetCost();
	reply.vehicle = std::get<1>(result);
	reply.model = EngineName(engine);
	if (!IsHangarTile(tile)) reply.depot = GetDepotIndex(tile);
	return Succeed(reply, fmt::format("Véhicule acheté : {}.", reply.model));
}

bool VehicleSell(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Vehicle *vehicle = FindVehicle(root, company, reply);
	if (vehicle == nullptr) return false;

	const bool sell_chain = vehicle->type == VEH_TRAIN;
	CommandCost test = RunCompanyCommand<CMD_SELL_VEHICLE>(
			company, vehicle->tile, true, vehicle->index, sell_chain, false, CLIENT_ID_SERVER);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Vente du véhicule refusée.");
	CommandCost result = RunCompanyCommand<CMD_SELL_VEHICLE>(
			company, vehicle->tile, false, vehicle->index, sell_chain, false, CLIENT_ID_SERVER);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Vente du véhicule refusée.");

	reply.cost = result.GetCost();
	reply.vehicle = vehicle->index;
	return Succeed(reply, "Véhicule vendu.");
}

bool VehicleStartStop(CompanyID company, const JsonValue &root, CommandReply &reply, bool start)
{
	Vehicle *vehicle = FindVehicle(root, company, reply);
	if (vehicle == nullptr) return false;
	if (!vehicle->IsPrimaryVehicle()) {
		return FailWith(reply, "NOT_PRIMARY_VEHICLE", "Seul un véhicule de tête peut être démarré ou arrêté.");
	}

	const bool running = !vehicle->vehstatus.Test(VehState::Stopped);
	if (running == start) {
		reply.vehicle = vehicle->index;
		return Succeed(reply, start ? "Le véhicule est déjà en service." : "Le véhicule est déjà arrêté.");
	}

	CommandCost test = RunCompanyCommand<CMD_START_STOP_VEHICLE>(
			company, vehicle->tile, true, vehicle->index, false);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Démarrage ou arrêt refusé.");
	CommandCost result = RunCompanyCommand<CMD_START_STOP_VEHICLE>(
			company, vehicle->tile, false, vehicle->index, false);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Démarrage ou arrêt refusé.");

	reply.cost = result.GetCost();
	reply.vehicle = vehicle->index;
	return Succeed(reply, start ? "Véhicule démarré." : "Véhicule arrêté.");
}

/**
 * Envoi au dépôt (#163). `service=true` demande un entretien immédiat à
 * l'arrivée ; OpenTTD route le véhicule puis le service est appliqué par le
 * moteur, le coût exact n'est donc pas connu au moment de la commande.
 */
bool VehicleDepot(CompanyID company, const JsonValue &root, CommandReply &reply, bool service)
{
	Vehicle *vehicle = FindVehicle(root, company, reply);
	if (vehicle == nullptr) return false;
	if (!vehicle->IsPrimaryVehicle()) {
		return FailWith(reply, "NOT_PRIMARY_VEHICLE", "Seul un véhicule de tête peut rejoindre un dépôt.");
	}
	DepotCommandFlags flags{};
	if (service) flags.Set(DepotCommandFlag::Service);
	CommandCost test = RunCompanyCommand<CMD_SEND_VEHICLE_TO_DEPOT>(
			company, vehicle->tile, true, vehicle->index, flags, VehicleListIdentifier{});
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Envoi au dépôt refusé.");
	CommandCost result = RunCompanyCommand<CMD_SEND_VEHICLE_TO_DEPOT>(
			company, vehicle->tile, false, vehicle->index, flags, VehicleListIdentifier{});
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Envoi au dépôt refusé.");
	reply.cost = result.GetCost();
	reply.vehicle = vehicle->index;
	return Succeed(reply, service
			? "Véhicule envoyé au dépôt pour entretien."
			: "Véhicule envoyé au dépôt.");
}

/** Refit d'un véhicule vers une cargaison (#160). */
bool VehicleRefit(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Vehicle *vehicle = FindVehicle(root, company, reply);
	if (vehicle == nullptr) return false;
	if (!vehicle->IsPrimaryVehicle()) {
		return FailWith(reply, "NOT_PRIMARY_VEHICLE", "Seul un véhicule de tête peut être reconfiguré.");
	}
	if (!vehicle->IsStoppedInDepot()) {
		return FailWith(reply, "NOT_IN_DEPOT", "Le véhicule doit être arrêté dans un dépôt.");
	}
	std::string cargo;
	if (!JsonGetString(root.Find("cargo"), cargo) || cargo.empty()) {
		return FailWith(reply, "INVALID_PARAMETER", "Le champ « cargo » doit être un slug de cargaison.");
	}
	const CargoType cargo_type = CargoTypeFromSlug(LowerAscii(cargo));
	if (!IsValidCargoType(cargo_type)) {
		return FailWith(reply, "UNKNOWN_CARGO", fmt::format("Cargaison « {} » inconnue.", cargo));
	}

	auto test = RunCompanyCommand<CMD_REFIT_VEHICLE>(
			company, vehicle->tile, true, vehicle->index, cargo_type, 0, false, false, 0);
	const CommandCost test_cost = CostOf(test);
	if (test_cost.Failed()) {
		return FailFromCommand(reply, test_cost, "COMMAND_FAILED", "Refit refusé.");
	}
	if (std::get<1>(test) == 0) {
		return FailWith(reply, "REFIT_NOT_AVAILABLE",
				fmt::format("La cargaison « {} » n'est pas disponible pour ce véhicule.", cargo));
	}
	auto result = RunCompanyCommand<CMD_REFIT_VEHICLE>(
			company, vehicle->tile, false, vehicle->index, cargo_type, 0, false, false, 0);
	const CommandCost cost = CostOf(result);
	if (cost.Failed()) return FailFromCommand(reply, cost, "COMMAND_FAILED", "Refit refusé.");

	reply.cost = cost.GetCost();
	reply.vehicle = vehicle->index;
	const uint capacity = std::get<1>(result);
	return Succeed(reply, fmt::format("Véhicule reconfiguré vers « {} » : capacité {}.", cargo, capacity));
}

/** Duplication d'un véhicule dans son dépôt (#161). */
bool VehicleClone(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Vehicle *source = FindVehicle(root, company, reply);
	if (source == nullptr) return false;
	if (!source->IsPrimaryVehicle()) {
		return FailWith(reply, "NOT_PRIMARY_VEHICLE", "Seul un véhicule de tête peut être dupliqué.");
	}
	if (!source->IsStoppedInDepot()) {
		return FailWith(reply, "NOT_IN_DEPOT", "Le véhicule source doit être arrêté dans un dépôt.");
	}
	bool share_orders = true;
	const JsonValue *share = root.Find("shareOrders");
	if (share != nullptr && share->type == JsonValue::Type::Bool) share_orders = share->boolean;

	/* `CMD_CLONE_VEHICLE` est marquée `NoTest` : une seule exécution, pas
	 * d'estimation préalable. Un refus laisse l'état inchangé. */
	auto result = RunCompanyCommand<CMD_CLONE_VEHICLE>(
			company, source->tile, false, source->tile, source->index, share_orders);
	const CommandCost cost = CostOf(result);
	if (cost.Failed()) return FailFromCommand(reply, cost, "COMMAND_FAILED", "Duplication refusée.");

	reply.cost = cost.GetCost();
	reply.vehicle = std::get<1>(result);
	return Succeed(reply, fmt::format("Véhicule #{} dupliqué depuis #{}.", reply.vehicle.base(), source->index.base()));
}

/** Mapping d'un mode d'arrêt du protocole vers les drapeaux OpenTTD. */
struct OrderActionSpec {
	OrderLoadType load = OrderLoadType::LoadIfPossible;
	OrderUnloadType unload = OrderUnloadType::UnloadIfPossible;
};

bool ParseOrderAction(const std::string &name, OrderActionSpec &action)
{
	if (name.empty() || name == "normal") {
		action.load = OrderLoadType::LoadIfPossible;
		action.unload = OrderUnloadType::UnloadIfPossible;
		return true;
	}
	if (name == "full_load" || name == "fullload") {
		action.load = OrderLoadType::FullLoad;
		action.unload = OrderUnloadType::UnloadIfPossible;
		return true;
	}
	if (name == "no_load" || name == "noload") {
		action.load = OrderLoadType::NoLoad;
		action.unload = OrderUnloadType::UnloadIfPossible;
		return true;
	}
	if (name == "unload") {
		action.load = OrderLoadType::NoLoad;
		action.unload = OrderUnloadType::Unload;
		return true;
	}
	if (name == "transfer") {
		action.load = OrderLoadType::NoLoad;
		action.unload = OrderUnloadType::Transfer;
		return true;
	}
	return false;
}

std::optional<OrderConditionComparator> ParseOrderComparator(const std::string &name)
{
	if (name == "equal") return OrderConditionComparator::Equal;
	if (name == "not_equal" || name == "notequal") return OrderConditionComparator::NotEqual;
	if (name == "less") return OrderConditionComparator::LessThan;
	if (name == "less_or_equal") return OrderConditionComparator::LessThanOrEqual;
	if (name == "more") return OrderConditionComparator::MoreThan;
	if (name == "more_or_equal") return OrderConditionComparator::MoreThanOrEqual;
	return std::nullopt;
}

/** Ordre analysé, validé avant toute modification de la tournée. */
struct ParsedOrder {
	std::string kind;
	int target = -1;
	OrderActionSpec action;
	bool conditional = false;
	int jump = 0;
	OrderConditionComparator comparator = OrderConditionComparator::MoreThanOrEqual;
	uint16_t condition_value = 0;
	bool has_wait = false;
	uint16_t wait = 0;
	bool has_travel = false;
	uint16_t travel = 0;
	bool autostart = false;
};

bool VehicleOrders(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Vehicle *vehicle = FindVehicle(root, company, reply);
	if (vehicle == nullptr) return false;
	if (!vehicle->IsPrimaryVehicle()) {
		return FailWith(reply, "NOT_PRIMARY_VEHICLE", "Seul un véhicule de tête peut recevoir des ordres.");
	}

	const JsonValue *orders = root.Find("orders");
	if (orders == nullptr || orders->type != JsonValue::Type::Array || orders->items.empty()) {
		return FailWith(reply, "INVALID_PARAMETER", "Le champ « orders » doit être un tableau non vide.");
	}
	if (orders->items.size() > 64) {
		return FailWith(reply, "INVALID_PARAMETER", "Une tournée est limitée à 64 ordres.");
	}

	/* Valider tous les ordres avant de supprimer la tournée existante évite
	 * une tournée partielle. Les industries ne sont pas des destinations
	 * directes : il faut passer par une gare. */
	std::vector<ParsedOrder> parsed;
	parsed.reserve(orders->items.size());
	for (const JsonValue &item : orders->items) {
		ParsedOrder spec;
		std::string kind;
		if (!JsonGetString(item.Find("kind"), kind)) {
			return FailWith(reply, "INVALID_PARAMETER", "Chaque ordre exige un « kind ».");
		}
		kind = LowerAscii(kind);
		if (kind == "gare") kind = "station";
		if (kind == "industrie") kind = "industry";
		spec.kind = kind;

		int target = -1;
		const bool has_target = JsonGetInt(item.Find("target"), target);
		if (kind == "conditional") {
			spec.conditional = true;
			const JsonValue *options = item.Find("options");
			const JsonValue *condition = options != nullptr ? options->Find("condition") : nullptr;
			if (condition == nullptr || condition->type != JsonValue::Type::Object) {
				return FailWith(reply, "INVALID_PARAMETER", "Un ordre conditionnel exige une condition.");
			}
			std::string type;
			if (!JsonGetString(condition->Find("type"), type)) {
				return FailWith(reply, "INVALID_PARAMETER", "La condition exige un « type ».");
			}
			type = LowerAscii(type);
			if (type != "percentage") {
				return FailWith(reply, "NOT_SUPPORTED",
						"Le pont OpenTTD ne gère que les conditions de pourcentage ; "
						"argent, date et cargaison sont disponibles avec le moteur mock.");
			}
			std::string comparator;
			if (!JsonGetString(condition->Find("comparator"), comparator)) {
				return FailWith(reply, "INVALID_PARAMETER", "La condition exige un « comparator ».");
			}
			const std::optional<OrderConditionComparator> parsed_comparator =
					ParseOrderComparator(LowerAscii(comparator));
			if (!parsed_comparator.has_value()) {
				return FailWith(reply, "INVALID_PARAMETER", fmt::format("Comparateur « {} » inconnu.", comparator));
			}
			spec.comparator = *parsed_comparator;
			int value = 0;
			if (!JsonGetInt(condition->Find("value"), value) || value < 0 || value > 100) {
				return FailWith(reply, "INVALID_PARAMETER", "Le pourcentage conditionnel doit être entre 0 et 100.");
			}
			spec.condition_value = static_cast<uint16_t>(value);

			const JsonValue *jump = options != nullptr ? options->Find("jump") : nullptr;
			if (!JsonGetInt(jump, spec.jump) || spec.jump < 0 ||
					spec.jump >= static_cast<int>(orders->items.size())) {
				return FailWith(reply, "INVALID_PARAMETER",
						fmt::format("Saut conditionnel invalide (attendu 0..{}).", orders->items.size() - 1));
			}
		} else if (!has_target || target < 0) {
			return FailWith(reply, "INVALID_PARAMETER", "Chaque ordre exige « target » (entier ≥ 0).");
		} else {
			spec.target = target;
		}

		const JsonValue *options = item.Find("options");
		if (options != nullptr && !spec.conditional) {
			std::string action;
			if (JsonGetString(options->Find("action"), action)) {
				if (!ParseOrderAction(LowerAscii(action), spec.action)) {
					return FailWith(reply, "INVALID_PARAMETER", fmt::format("Mode d'arrêt « {} » inconnu.", action));
				}
			}
			const JsonValue *timetable = options->Find("timetable");
			if (timetable != nullptr && timetable->type == JsonValue::Type::Object) {
				int wait = 0;
				if (JsonGetInt(timetable->Find("waitTicks"), wait)) {
					spec.has_wait = true;
					spec.wait = static_cast<uint16_t>(std::clamp(wait, 0, 65535));
				}
				int travel = 0;
				if (JsonGetInt(timetable->Find("travelTicks"), travel)) {
					spec.has_travel = true;
					spec.travel = static_cast<uint16_t>(std::clamp(travel, 0, 65535));
				}
				const JsonValue *autostart = timetable->Find("autostart");
				if (autostart != nullptr && autostart->type == JsonValue::Type::Bool) {
					spec.autostart = autostart->boolean;
				}
			}
		}

		if (spec.kind == "station") {
			if (!Station::IsValidID(StationID(static_cast<uint16_t>(spec.target)))) {
				return FailWith(reply, "UNKNOWN_STATION", fmt::format("Gare {} inexistante.", spec.target));
			}
		} else if (spec.kind == "depot") {
			const DepotID depot_id(static_cast<uint16_t>(spec.target));
			if (!Depot::IsValidID(depot_id)) {
				return FailWith(reply, "UNKNOWN_DEPOT", fmt::format("Dépôt {} inexistant.", spec.target));
			}
			const TileIndex depot_tile = Depot::Get(depot_id)->xy;
			if (!IsTileOwner(depot_tile, company)) {
				return FailWith(reply, "WRONG_OWNER",
						fmt::format("Dépôt {} d'une autre entreprise.", spec.target));
			}
			if (GetDepotVehicleType(depot_tile) != vehicle->type) {
				return FailWith(reply, "WRONG_DEPOT_TYPE",
						fmt::format("Dépôt {} incompatible avec ce véhicule.", spec.target));
			}
		} else if (spec.kind == "industry") {
			return FailWith(reply, "NOT_SUPPORTED",
					"Les ordres vers une industrie passent par une gare : utilisez « kind: station ».");
		} else if (spec.kind != "conditional") {
			return FailWith(reply, "INVALID_PARAMETER", fmt::format("Type d'ordre inconnu « {} ».", kind));
		}
		parsed.push_back(std::move(spec));
	}

	const bool has_destination = std::any_of(parsed.begin(), parsed.end(),
			[](const ParsedOrder &order) { return !order.conditional; });
	if (!has_destination) {
		return FailWith(reply, "INVALID_PARAMETER", "Aucun arrêt physique : ajoutez une gare ou un dépôt.");
	}

	/* Remplacement complet : la tournée envoyée devient la seule tournée. */
	for (int guard = 0; vehicle->GetNumManualOrders() > 0 && guard < 256; guard++) {
		const CommandCost removed = RunCompanyCommand<CMD_DELETE_ORDER>(
				company, vehicle->tile, false, vehicle->index, VehicleOrderID(static_cast<uint16_t>(0)));
		if (removed.Failed()) {
			return FailFromCommand(reply, removed, "COMMAND_FAILED", "Suppression de l'ancienne tournée refusée.");
		}
	}

	VehicleOrderID position = 0;
	int inserted = 0;
	bool autostart = false;
	for (const ParsedOrder &spec : parsed) {
		Order order;
		if (spec.conditional) {
			/* Le saut est posé après l'insertion de toute la tournée : OpenTTD
			 * refuse un saut vers un index qui n'existe pas encore. */
			order.MakeConditional(VehicleOrderID(static_cast<uint16_t>(0)));
			order.SetConditionVariable(OrderConditionVariable::LoadPercentage);
			order.SetConditionComparator(spec.comparator);
			order.SetConditionValue(spec.condition_value);
		} else if (spec.kind == "station") {
			order.MakeGoToStation(StationID(static_cast<uint16_t>(spec.target)));
			/* Les véhicules routiers n'acceptent que FarEnd : la valeur par
			 * défaut (NearEnd) fait échouer CmdInsertOrder. */
			order.SetStopLocation(OrderStopLocation::FarEnd);
			order.SetLoadType(spec.action.load);
			order.SetUnloadType(spec.action.unload);
		} else {
			OrderDepotTypeFlags depot_flags;
			depot_flags.Set(OrderDepotTypeFlag::PartOfOrders);
			order.MakeGoToDepot(DepotID(static_cast<uint16_t>(spec.target)), depot_flags,
					OrderNonStopFlags{}, OrderDepotActionFlags{});
		}

		const CommandCost result = RunCompanyCommand<CMD_INSERT_ORDER>(
				company, vehicle->tile, false, vehicle->index, position, order);
		if (result.Failed()) {
			reply.orders = inserted;
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Ajout d'ordre refusé.");
		}
		if (spec.has_wait) {
			const CommandCost wait = RunCompanyCommand<CMD_CHANGE_TIMETABLE>(
					company, vehicle->tile, false, vehicle->index, position, MTF_WAIT_TIME, spec.wait);
			if (wait.Failed()) {
				reply.orders = inserted;
				return FailFromCommand(reply, wait, "COMMAND_FAILED", "Horaire d'attente refusé.");
			}
		}
		if (spec.has_travel) {
			const CommandCost travel = RunCompanyCommand<CMD_CHANGE_TIMETABLE>(
					company, vehicle->tile, false, vehicle->index, position, MTF_TRAVEL_TIME, spec.travel);
			if (travel.Failed()) {
				reply.orders = inserted;
				return FailFromCommand(reply, travel, "COMMAND_FAILED", "Horaire de trajet refusé.");
			}
		}
		autostart = autostart || spec.autostart;
		position++;
		inserted++;
	}

	/* Les sauts conditionnels sont appliqués quand tous les index existent. */
	for (size_t index = 0; index < parsed.size(); index++) {
		const ParsedOrder &spec = parsed[index];
		if (!spec.conditional) continue;
		const CommandCost jump = RunCompanyCommand<CMD_MODIFY_ORDER>(
				company, vehicle->tile, false, vehicle->index,
				VehicleOrderID(static_cast<uint16_t>(index)), MOF_COND_DESTINATION,
				static_cast<uint16_t>(spec.jump));
		if (jump.Failed()) {
			reply.orders = inserted;
			return FailFromCommand(reply, jump, "COMMAND_FAILED", "Saut conditionnel refusé.");
		}
	}

	bool timetable_started = false;
	if (autostart) {
		if (vehicle->vehstatus.Test(VehState::Stopped)) {
			RunCompanyCommand<CMD_START_STOP_VEHICLE>(
					company, vehicle->tile, false, vehicle->index, false);
		}
		const CommandCost timer = RunCompanyCommand<CMD_SET_TIMETABLE_START>(
				company, vehicle->tile, false, vehicle->index, true, TimerGameTick::counter);
		timetable_started = !timer.Failed();
	}

	reply.orders = inserted;
	return Succeed(reply, fmt::format("{} ordre(s) enregistré(s){}.",
			inserted, timetable_started ? " · horaire démarré" : ""));
}

bool DispatchFinance(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	std::string action;
	if (!JsonGetString(root.Find("action"), action)) {
		return FailWith(reply, "UNKNOWN_ACTION", "Le champ « action » doit être une chaîne.");
	}
	action = LowerAscii(action);

	LoanCommand loan_command = LoanCommand::Interval;
	Money amount = 0;
	const JsonValue *amount_value = root.Find("amount");
	if (amount_value != nullptr && !amount_value->IsNull()) {
		int parsed = 0;
		if (!JsonGetInt(amount_value, parsed) || parsed <= 0) {
			return FailWith(reply, "INVALID_PARAMETER", "« amount » doit être un entier positif.");
		}
		loan_command = LoanCommand::Amount;
		amount = static_cast<Money>(parsed);
	}

	const bool increase = action == "increase_loan" || action == "emprunter" || action == "borrow";
	const bool decrease = action == "decrease_loan" || action == "rembourser" || action == "repay";
	if (!increase && !decrease) {
		return FailWith(reply, "UNKNOWN_ACTION",
			fmt::format("Action financière inconnue « {} ».", action));
	}

	if (increase) {
		CommandCost test = RunCompanyCommand<CMD_INCREASE_LOAN>(
			company, INVALID_TILE, true, loan_command, amount);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Emprunt refusé.");
		CommandCost result = RunCompanyCommand<CMD_INCREASE_LOAN>(
			company, INVALID_TILE, false, loan_command, amount);
		if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Emprunt refusé.");
		reply.cost = result.GetCost();
		return Succeed(reply, loan_command == LoanCommand::Amount
			? fmt::format("Prêt augmenté de {} £.", static_cast<int64_t>(amount))
			: "Prêt augmenté d’un pas.");
	}

	CommandCost test = RunCompanyCommand<CMD_DECREASE_LOAN>(
		company, INVALID_TILE, true, loan_command, amount);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Remboursement refusé.");
	CommandCost result = RunCompanyCommand<CMD_DECREASE_LOAN>(
		company, INVALID_TILE, false, loan_command, amount);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Remboursement refusé.");
	reply.cost = result.GetCost();
	return Succeed(reply, loan_command == LoanCommand::Amount
		? fmt::format("Prêt remboursé de {} £.", static_cast<int64_t>(amount))
		: "Prêt remboursé d’un pas.");
}

bool DispatchTownAction(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int town_id = 0;
	if (!JsonGetInt(root.Find("town"), town_id) || town_id < 0) {
		return FailWith(reply, "INVALID_PARAMETER", "« town » doit être un entier positif.");
	}
	Town *town = Town::GetIfValid(TownID(static_cast<uint16_t>(town_id)));
	if (town == nullptr) {
		return FailWith(reply, "INVALID_PARAMETER",
			fmt::format("Ville #{} inexistante.", town_id));
	}
	std::string action;
	if (!JsonGetString(root.Find("action"), action)) {
		return FailWith(reply, "UNKNOWN_ACTION", "Le champ « action » doit être une chaîne.");
	}
	const std::optional<TownAction> parsed = ParseTownAction(LowerAscii(action));
	if (!parsed.has_value()) {
		return FailWith(reply, "UNKNOWN_ACTION",
			fmt::format("Action municipale inconnue « {} ».", action));
	}

	CommandCost test = RunCompanyCommand<CMD_DO_TOWN_ACTION>(
		company, town->xy, true, TownID(static_cast<uint16_t>(town_id)), *parsed);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Action municipale refusée.");
	CommandCost result = RunCompanyCommand<CMD_DO_TOWN_ACTION>(
		company, town->xy, false, TownID(static_cast<uint16_t>(town_id)), *parsed);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Action municipale refusée.");
	reply.cost = result.GetCost();
	reply.tiles = 1;
	return Succeed(reply, fmt::format("Action municipale exécutée ({} £).",
		static_cast<int64_t>(result.GetCost())));
}

/* ------------------------------------------------------------------------- */
/*  Groupes de véhicules (#164)                                              */
/* ------------------------------------------------------------------------- */

/** Groupe désigné par `group`, vérifié comme appartenant à `company`. */
Group *ResolveGroup(const JsonValue &root, CompanyID company, CommandReply &reply)
{
	int id = 0;
	if (!JsonGetInt(root.Find("group"), id) || id < 0 || id > 0xFFFF) {
		FailWith(reply, "INVALID_PARAMETER", "Le champ « group » doit être un identifiant entier.");
		return nullptr;
	}
	Group *group = Group::GetIfValid(GroupID(static_cast<uint16_t>(id)));
	if (group == nullptr) {
		FailWith(reply, "UNKNOWN_GROUP", fmt::format("Groupe {} inexistant.", id));
		return nullptr;
	}
	if (group->owner != company) {
		FailWith(reply, "WRONG_OWNER", "Ce groupe appartient à une autre entreprise.");
		return nullptr;
	}
	return group;
}

/** Identifiants des véhicules de tête d'un groupe, dans l'ordre du pool. */
std::vector<VehicleID> GroupVehicleIds(CompanyID company, const Group *group)
{
	std::vector<VehicleID> ids;
	for (const Vehicle *v : Vehicle::Iterate()) {
		if (v->owner != company || v->group_id != group->index) continue;
		if (!v->IsPrimaryVehicle()) continue;
		ids.push_back(v->index);
	}
	return ids;
}

bool GroupCreate(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	VehicleType type = VEH_ROAD;
	std::string kind;
	if (JsonGetString(root.Find("kind"), kind) && !kind.empty()) {
		type = ParseVehicleKind(kind);
		if (type == VEH_INVALID) {
			return FailWith(reply, "INVALID_PARAMETER",
					fmt::format("Type de groupe inconnu « {} ».", kind));
		}
	}

	GroupID parent = GroupID::Invalid();
	int parent_id = 0;
	if (JsonGetInt(root.Find("parent"), parent_id) && parent_id >= 0) {
		Group *parent_group = Group::GetIfValid(GroupID(static_cast<uint16_t>(parent_id)));
		if (parent_group == nullptr || parent_group->owner != company ||
				parent_group->vehicle_type != type) {
			return FailWith(reply, "INVALID_PARAMETER",
					"Le groupe parent doit appartenir à l'entreprise et partager le même type.");
		}
		parent = parent_group->index;
	}

	auto test = RunCompanyCommand<CMD_CREATE_GROUP>(
			company, INVALID_TILE, true, type, parent);
	if (std::get<0>(test).Failed()) {
		return FailFromCommand(reply, std::get<0>(test), "COMMAND_FAILED", "Création du groupe refusée.");
	}
	auto result = RunCompanyCommand<CMD_CREATE_GROUP>(
			company, INVALID_TILE, false, type, parent);
	const CommandCost cost = std::get<0>(result);
	if (cost.Failed()) {
		return FailFromCommand(reply, cost, "COMMAND_FAILED", "Création du groupe refusée.");
	}
	const GroupID group_id = std::get<1>(result);
	reply.group = group_id;
	reply.cost = cost.GetCost();

	std::string name;
	if (JsonGetString(root.Find("name"), name) && !name.empty()) {
		CommandCost rename = RunCompanyCommand<CMD_ALTER_GROUP>(
				company, INVALID_TILE, false, AlterGroupMode::Rename, group_id,
				GroupID::Invalid(), name);
		if (rename.Failed()) {
			return FailFromCommand(reply, rename, "COMMAND_FAILED", "Groupe créé, mais renommage refusé.");
		}
	}
	return Succeed(reply, fmt::format("Groupe #{} créé.", group_id.base()));
}

bool GroupRename(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Group *group = ResolveGroup(root, company, reply);
	if (group == nullptr) return false;
	std::string name;
	if (!JsonGetString(root.Find("name"), name) || name.empty()) {
		return FailWith(reply, "INVALID_PARAMETER", "Le champ « name » doit être un nom non vide.");
	}
	CommandCost test = RunCompanyCommand<CMD_ALTER_GROUP>(
			company, INVALID_TILE, true, AlterGroupMode::Rename, group->index,
			GroupID::Invalid(), name);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Renommage refusé.");
	CommandCost result = RunCompanyCommand<CMD_ALTER_GROUP>(
			company, INVALID_TILE, false, AlterGroupMode::Rename, group->index,
			GroupID::Invalid(), name);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Renommage refusé.");
	reply.group = group->index;
	return Succeed(reply, "Groupe renommé.");
}

bool GroupDelete(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Group *group = ResolveGroup(root, company, reply);
	if (group == nullptr) return false;
	const GroupID id = group->index;
	CommandCost test = RunCompanyCommand<CMD_DELETE_GROUP>(
			company, INVALID_TILE, true, id);
	if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Suppression refusée.");
	CommandCost result = RunCompanyCommand<CMD_DELETE_GROUP>(
			company, INVALID_TILE, false, id);
	if (result.Failed()) return FailFromCommand(reply, result, "COMMAND_FAILED", "Suppression refusée.");
	reply.group = id;
	return Succeed(reply, "Groupe supprimé.");
}

bool GroupAssign(CompanyID company, const JsonValue &root, CommandReply &reply, bool remove)
{
	GroupID target = DEFAULT_GROUP;
	if (!remove) {
		Group *group = ResolveGroup(root, company, reply);
		if (group == nullptr) return false;
		target = group->index;
	}

	const JsonValue *list_value = root.Find("vehicles");
	if (list_value == nullptr || list_value->type != JsonValue::Type::Array ||
			list_value->items.empty()) {
		return FailWith(reply, "INVALID_PARAMETER", "« vehicles » doit être un tableau non vide.");
	}

	int changed = 0;
	for (const JsonValue &item : list_value->items) {
		int id = 0;
		if (!JsonGetInt(&item, id) || id < 0) continue;
		Vehicle *vehicle = Vehicle::GetIfValid(VehicleID(static_cast<uint16_t>(id)));
		if (vehicle == nullptr || vehicle->owner != company) continue;
		if (!vehicle->IsPrimaryVehicle()) continue;
		if (!remove) {
			Group *group = Group::Get(target);
			if (group->vehicle_type != vehicle->type) continue;
		}
		CommandCost result = CostOf(RunCompanyCommand<CMD_ADD_VEHICLE_GROUP>(
				company, vehicle->tile, false, target, vehicle->index, false,
				VehicleListIdentifier{}));
		if (result.Succeeded()) changed++;
	}
	if (changed == 0) {
		return FailWith(reply, "COMMAND_FAILED", "Aucun véhicule n'a pu être affecté au groupe.");
	}
	reply.group = remove ? GroupID::Invalid() : target;
	return Succeed(reply, remove
			? fmt::format("{} véhicule(s) retiré(s) du groupe.", changed)
			: fmt::format("{} véhicule(s) affecté(s) au groupe.", changed));
}

bool GroupBulk(CompanyID company, const JsonValue &root, CommandReply &reply,
		const std::string &action)
{
	Group *group = ResolveGroup(root, company, reply);
	if (group == nullptr) return false;
	const std::vector<VehicleID> ids = GroupVehicleIds(company, group);
	if (ids.empty()) {
		return FailWith(reply, "EMPTY_GROUP", "Ce groupe ne contient aucun véhicule.");
	}

	Money total_cost = 0;
	int changed = 0;
	for (const VehicleID id : ids) {
		Vehicle *vehicle = Vehicle::GetIfValid(id);
		if (vehicle == nullptr || vehicle->owner != company) continue;
		CommandCost result = CommandCost();
		if (action == "start" || action == "stop") {
			result = RunCompanyCommand<CMD_START_STOP_VEHICLE>(
					company, vehicle->tile, false, id, false);
		} else if (action == "send_to_depot") {
			result = RunCompanyCommand<CMD_SEND_VEHICLE_TO_DEPOT>(
					company, vehicle->tile, false, id, DepotCommandFlags{}, VehicleListIdentifier{});
		} else if (action == "sell") {
			const bool sell_chain = vehicle->type == VEH_TRAIN;
			result = RunCompanyCommand<CMD_SELL_VEHICLE>(
					company, vehicle->tile, false, id, sell_chain, false, CLIENT_ID_SERVER);
		} else {
			return FailWith(reply, "UNKNOWN_ACTION",
					fmt::format("Action de groupe inconnue « {} ».", action));
		}
		if (result.Succeeded()) {
			changed++;
			total_cost += result.GetCost();
		}
	}
	if (changed == 0) {
		return FailWith(reply, "COMMAND_FAILED", "Aucune action de groupe n'a abouti.");
	}
	reply.cost = total_cost;
	reply.group = group->index;
	return Succeed(reply, fmt::format("{} véhicule(s) traités.", changed));
}

bool GroupAutoreplace(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	Group *group = ResolveGroup(root, company, reply);
	if (group == nullptr) return false;
	const std::vector<VehicleID> ids = GroupVehicleIds(company, group);
	if (ids.empty()) {
		return FailWith(reply, "EMPTY_GROUP",
				"Le groupe doit contenir au moins un véhicule pour définir l'autoreplace.");
	}
	Vehicle *sample = Vehicle::GetIfValid(ids.front());
	if (sample == nullptr) {
		return FailWith(reply, "UNKNOWN_VEHICLE", "Véhicule de référence introuvable.");
	}

	EngineID new_engine = EngineID::Invalid();
	const JsonValue *model_value = root.Find("model");
	std::string model;
	if (model_value != nullptr && !model_value->IsNull() &&
			JsonGetString(model_value, model) && !model.empty()) {
		new_engine = SelectEngine(company, sample->type, model);
		if (new_engine == EngineID::Invalid()) {
			return FailWith(reply, "NO_ENGINE",
					fmt::format("Aucun moteur ne correspond à « {} » pour ce groupe.", model));
		}
	}

	bool when_old = true;
	const JsonValue *when_old_value = root.Find("whenOld");
	if (when_old_value != nullptr && when_old_value->type == JsonValue::Type::Bool) {
		when_old = when_old_value->boolean;
	}

	/* Une règle OpenTTD est indexée par moteur d'origine : on configure tous
	 * les moteurs présents dans le groupe vers le même modèle cible. */
	std::vector<EngineID> old_engines;
	for (const VehicleID id : ids) {
		const Vehicle *vehicle = Vehicle::GetIfValid(id);
		if (vehicle == nullptr) continue;
		if (std::find(old_engines.begin(), old_engines.end(), vehicle->engine_type) !=
				old_engines.end()) {
			continue;
		}
		old_engines.push_back(vehicle->engine_type);
	}

	int configured = 0;
	Money total_cost = 0;
	for (const EngineID old_engine : old_engines) {
		CommandCost test = RunCompanyCommand<CMD_SET_AUTOREPLACE>(
				company, INVALID_TILE, true, group->index, old_engine, new_engine, when_old);
		if (test.Failed()) continue;
		CommandCost result = RunCompanyCommand<CMD_SET_AUTOREPLACE>(
				company, INVALID_TILE, false, group->index, old_engine, new_engine, when_old);
		if (result.Failed()) continue;
		configured++;
		total_cost += result.GetCost();
	}
	if (configured == 0) {
		return FailWith(reply, "COMMAND_FAILED",
				"Autoreplace refusé : aucun moteur du groupe n'est compatible avec ce modèle.");
	}
	reply.cost = total_cost;
	reply.group = group->index;
	if (new_engine == EngineID::Invalid()) {
		return Succeed(reply, fmt::format("Autoreplace désactivé pour {} moteur(s) du groupe.",
				configured));
	}
	reply.model = EngineName(new_engine);
	return Succeed(reply, fmt::format("Autoreplace configuré vers {} pour {} moteur(s){}.",
			reply.model, configured, when_old ? " (véhicules anciens)" : ""));
}

bool DispatchGroup(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	std::string action;
	if (!JsonGetString(root.Find("action"), action)) {
		return FailWith(reply, "UNKNOWN_ACTION", "Le champ « action » doit être une chaîne.");
	}
	action = LowerAscii(action);
	if (action == "create" || action == "creer" || action == "créer") return GroupCreate(company, root, reply);
	if (action == "rename" || action == "renommer") return GroupRename(company, root, reply);
	if (action == "delete" || action == "supprimer") return GroupDelete(company, root, reply);
	if (action == "assign" || action == "affecter") return GroupAssign(company, root, reply, false);
	if (action == "remove" || action == "retirer") return GroupAssign(company, root, reply, true);
	if (action == "autoreplace") return GroupAutoreplace(company, root, reply);
	if (action == "start" || action == "stop" || action == "send_to_depot" || action == "sell") {
		return GroupBulk(company, root, reply, action);
	}
	return FailWith(reply, "UNKNOWN_ACTION", fmt::format("Action de groupe inconnue « {} ».", action));
}

bool DispatchVehicle(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	std::string action;
	if (!JsonGetString(root.Find("action"), action)) {
		return FailWith(reply, "UNKNOWN_ACTION", "Le champ « action » doit être une chaîne.");
	}
	action = LowerAscii(action);

	if (action == "buy" || action == "acheter") return VehicleBuy(company, root, reply);
	if (action == "sell" || action == "vendre") return VehicleSell(company, root, reply);
	if (action == "start" || action == "demarrer" || action == "démarrer") return VehicleStartStop(company, root, reply, true);
	if (action == "stop" || action == "arreter" || action == "arrêter") return VehicleStartStop(company, root, reply, false);
	if (action == "order" || action == "ordre") return VehicleOrders(company, root, reply);
	if (action == "refit" || action == "reconfigurer") return VehicleRefit(company, root, reply);
	if (action == "clone" || action == "dupliquer") return VehicleClone(company, root, reply);
	if (action == "service" || action == "entretenir") return VehicleDepot(company, root, reply, true);
	if (action == "send_to_depot" || action == "depot" || action == "dépôt") return VehicleDepot(company, root, reply, false);
	return FailWith(reply, "UNKNOWN_ACTION", fmt::format("Action véhicule inconnue « {} ».", action));
}

/* ------------------------------------------------------------------------- */
/*  Point d'entrée JSON                                                      */
/* ------------------------------------------------------------------------- */

bool ResolveCompany(const JsonValue &root, CompanyID &company, std::string &error)
{
	const JsonValue *value = root.Find("company");
	if (value == nullptr || value->IsNull()) {
		company = _local_company;
		if (!Company::IsValidID(company)) return JsonFail(error, "aucune entreprise locale dans cette partie");
		return true;
	}
	int id = 0;
	if (!JsonGetInt(value, id)) return JsonFail(error, "« company » doit être un entier");
	/* `COMPANY_NONE` (255) est utilisé par le frontend quand aucune
	 * entreprise n'est sélectionnée : on retombe sur l'entreprise locale. */
	if (id == 255) {
		company = _local_company;
		if (!Company::IsValidID(company)) return JsonFail(error, "aucune entreprise locale dans cette partie");
		return true;
	}
	if (id < 0 || id >= static_cast<int>(MAX_COMPANIES) ||
			!Company::IsValidID(CompanyID(static_cast<uint8_t>(id)))) {
		return JsonFail(error, fmt::format("entreprise {} inexistante", id));
	}
	const Company *target = Company::Get(CompanyID(static_cast<uint8_t>(id)));
	if (target->is_ai) {
		return JsonFail(error, fmt::format(
			"entreprise {} contrôlée par une IA : commande refusée", id));
	}
	company = CompanyID(static_cast<uint8_t>(id));
	return true;
}

int FinishCommand(CommandReply &reply)
{
	int status = OTTD_CMD_OK;
	if (!reply.ok) {
		if (reply.code == "NO_GAME") {
			status = OTTD_CMD_NO_GAME;
		} else if (reply.code == "BAD_JSON") {
			status = OTTD_CMD_BAD_JSON;
		} else if (reply.code == "UNKNOWN_COMMAND" || reply.code == "UNKNOWN_TOOL" ||
				reply.code == "UNKNOWN_ACTION") {
			status = OTTD_CMD_UNKNOWN;
		} else if (reply.code == "INVALID_PARAMETER" || reply.code == "TOO_MANY_TILES") {
			status = OTTD_CMD_INVALID;
		} else if (reply.code == "INVALID_COMPANY") {
			status = OTTD_CMD_BAD_COMPANY;
		} else if (reply.code == "NOT_SUPPORTED") {
			status = OTTD_CMD_NOT_SUPPORTED;
		} else {
			status = OTTD_CMD_FAILED;
		}
	}

	std::string json;
	AppendReplyJson(json, reply);
	_ottd_last_command_json = std::move(json);
	_ottd_last_command_status = status;
	return status;
}

int ExecuteCommandJson(std::string_view json)
{
	CommandReply reply;
	_ottd_save_cache_valid = false;

	if (!_ottd_in_game) {
		FailWith(reply, "NO_GAME", "Aucune partie en cours : démarrez une partie avant d'envoyer une commande.");
		return FinishCommand(reply);
	}
	if (json.empty()) {
		FailWith(reply, "BAD_JSON", "Commande JSON vide.");
		return FinishCommand(reply);
	}

	JsonValue root;
	std::string error;
	if (!ParseCommandJson(json, root, error)) {
		FailWith(reply, "BAD_JSON", fmt::format("JSON invalide : {}.", error));
		return FinishCommand(reply);
	}

	std::string type;
	if (!JsonGetString(root.Find("type"), type)) {
		FailWith(reply, "UNKNOWN_COMMAND", "Le champ « type » doit être une chaîne (build, vehicle, finance, town_action).");
		return FinishCommand(reply);
	}
	type = LowerAscii(type);

	CompanyID company = _local_company;
	if (!ResolveCompany(root, company, error)) {
		FailWith(reply, "INVALID_COMPANY", error);
		return FinishCommand(reply);
	}

	if (type == "build") {
		DispatchBuild(company, root, reply);
	} else if (type == "vehicle") {
		DispatchVehicle(company, root, reply);
	} else if (type == "finance") {
		DispatchFinance(company, root, reply);
	} else if (type == "town_action" || type == "town") {
		DispatchTownAction(company, root, reply);
	} else if (type == "group" || type == "groups" || type == "groupe") {
		DispatchGroup(company, root, reply);
	} else if (type == "pause" || type == "speed" || type == "console") {
		FailWith(reply, "NOT_SUPPORTED",
				fmt::format("La commande « {} » est gérée par le pilote, pas par le pont (#11).", type));
	} else {
		FailWith(reply, "UNKNOWN_COMMAND", fmt::format("Commande inconnue « {} ».", type));
	}

	return FinishCommand(reply);
}

/* ------------------------------------------------------------------------- */
/*  Sauvegarde / chargement mémoire (issue #61)                              */
/* ------------------------------------------------------------------------- */

/** Codes de retour des fonctions de sauvegarde (voir wiki, Protocole). */
enum OttdSaveLoadStatus : int {
	OTTD_SL_OK = 0,            ///< Opération réussie.
	OTTD_SL_NO_GAME = -1,      ///< Aucune partie en cours (sauvegarde impossible).
	OTTD_SL_NOT_BOOTED = -2,   ///< `ottd_boot()` n'a pas été appelé.
	OTTD_SL_BAD_ARGUMENT = -3, ///< Pointeur nul ou longueur invalide.
	OTTD_SL_CORRUPT = -4,      ///< Conteneur invalide, tronqué ou corrompu.
	OTTD_SL_SAVE_FAILED = -5,  ///< OpenTTD a refusé d'écrire la sauvegarde.
	OTTD_SL_LOAD_FAILED = -6,  ///< OpenTTD a refusé la sauvegarde, état restauré.
	OTTD_SL_STATE_LOST = -7,   ///< Chargement refusé et restauration impossible.
};

/**
 * Conteneur de sauvegarde mémoire.
 *
 * Disposition little-endian (en-tête de 32 octets) :
 *   0  u32 magic         0x5333544F ("OT3S")
 *   4  u16 version       = 1
 *   6  u16 header_size   = 32
 *   8  u32 payload_size  taille du .sav OpenTTD standard qui suit les métadonnées
 *   12 u32 tick          tick courant au moment de la sauvegarde (diagnostic)
 *   16 u64 checksum      FNV-1a 64 des métadonnées puis du .sav
 *   24 u32 metadata_size taille des métadonnées du pont
 *   28 u32 reserved      = 0
 *   puis `metadata_size` octets de métadonnées, puis `payload_size` octets de
 *   sauvegarde OpenTTD standard (format .sav avec en-tête et compression).
 *
 * Les métadonnées conservent la configuration du pont (climat, année,
 * difficulté, IA, villes, industries, nom), les profils d'entreprises
 * humaines (#99), l'entreprise locale (`_local_company`) et les avertissements
 * de partie, que le .sav OpenTTD ne contient pas.
 *
 * Version 2 : ajoute après les avertissements `u32 nb_entreprises`, puis pour
 * chacune `u32 longueur + nom UTF-8 + u8 couleur`, puis `u8 entreprise_locale`
 * (0xFF = aucune). La version 1 reste lisible.
 */
static constexpr uint32_t OTTD_SAVE_MAGIC = 0x5333544F; ///< "OT3S" en little-endian.
static constexpr uint16_t OTTD_SAVE_VERSION = 2;
static constexpr uint16_t OTTD_SAVE_VERSION_MIN = 1;
static constexpr uint16_t OTTD_SAVE_HEADER_SIZE = 32;
/** Sentinelle « aucune entreprise locale » dans les métadonnées v2. */
static constexpr uint8_t OTTD_NO_LOCAL_COMPANY = 0xFF;

/** Filtre de sauvegarde qui accumule les octets dans un vecteur. */
class OttdMemorySaveFilter final : public SaveFilter {
public:
	OttdMemorySaveFilter(std::shared_ptr<SaveFilter> chain, std::vector<uint8_t> &out) :
		SaveFilter(std::move(chain)), out(out)
	{
	}

	void Write(uint8_t *buf, size_t len) override
	{
		if (len != 0) this->out.insert(this->out.end(), buf, buf + len);
	}

private:
	std::vector<uint8_t> &out;
};

/** Filtre de chargement qui lit un buffer mémoire (sans copie). */
class OttdMemoryLoadFilter final : public LoadFilter {
public:
	OttdMemoryLoadFilter(std::shared_ptr<LoadFilter> chain, const uint8_t *data, size_t size) :
		LoadFilter(std::move(chain)), data(data), size(size)
	{
	}

	size_t Read(uint8_t *buf, size_t len) override
	{
		const size_t count = std::min(len, this->size - this->pos);
		if (count != 0) std::copy(this->data + this->pos, this->data + this->pos + count, buf);
		this->pos += count;
		return count;
	}

	void Reset() override
	{
		this->pos = 0;
		if (this->chain != nullptr) this->chain->Reset();
	}

private:
	const uint8_t *data;
	size_t size;
	size_t pos = 0;
};

/** Message lisible de la dernière erreur saveload d'OpenTTD. */
std::string SaveLoadErrorMessage()
{
	std::string message = GetSaveLoadErrorMessage().GetDecodedString();
	if (message.empty()) message = "sauvegarde OpenTTD invalide ou incomplète";
	return message;
}

void AppendSaveU32(std::vector<uint8_t> &out, uint32_t value)
{
	const size_t offset = out.size();
	out.resize(offset + 4);
	WriteU32(out.data() + offset, value);
}

void AppendSaveString(std::vector<uint8_t> &out, std::string_view text)
{
	AppendSaveU32(out, static_cast<uint32_t>(text.size()));
	out.insert(out.end(), text.begin(), text.end());
}

/**
 * Sérialise la configuration du pont et les avertissements.
 *
 * Disposition fixe de 36 octets, puis le nom de partie et les avertissements :
 *   0  u8  flags (bit 0..7 : landscape, start_year, difficulty, ai_companies,
 *              towns, industries, map_size, disasters)
 *   1  u8  landscape
 *   2  u16 réservé
 *   4  i32 start_year
 *   8  i32 difficulty
 *   12 i32 ai_companies
 *   16 i32 towns
 *   20 i32 industries
 *   24 i32 map_size
 *   28 u8  disasters
 *   29 3 octets réservés
 *   32 u32 longueur du nom de partie
 *   36 nom (UTF-8), puis u32 nombre d'avertissements et, pour chacun,
 *      u32 longueur + octets UTF-8.
 *   v2 : u32 nombre d'entreprises humaines, puis pour chacune
 *      u32 longueur + nom UTF-8 + u8 couleur, puis u8 entreprise locale.
 */
void BuildSaveMetadata(std::vector<uint8_t> &meta)
{
	const GameSetupConfig &config = _ottd_active_config;
	uint8_t flags = 0;
	if (config.landscape.has_value()) flags |= 1 << 0;
	if (config.start_year.has_value()) flags |= 1 << 1;
	if (config.difficulty.has_value()) flags |= 1 << 2;
	if (config.ai_companies.has_value()) flags |= 1 << 3;
	if (config.towns.has_value()) flags |= 1 << 4;
	if (config.industries.has_value()) flags |= 1 << 5;
	if (config.map_size.has_value()) flags |= 1 << 6;
	if (config.disasters.has_value()) flags |= 1 << 7;

	meta.assign(36, 0);
	meta[0] = flags;
	meta[1] = config.landscape.has_value() ? static_cast<uint8_t>(*config.landscape) : 0;
	WriteU32(meta.data() + 4, static_cast<uint32_t>(config.start_year.value_or(0)));
	WriteU32(meta.data() + 8, static_cast<uint32_t>(config.difficulty.value_or(0)));
	WriteU32(meta.data() + 12, static_cast<uint32_t>(config.ai_companies.value_or(0)));
	WriteU32(meta.data() + 16, static_cast<uint32_t>(config.towns.value_or(0)));
	WriteU32(meta.data() + 20, static_cast<uint32_t>(config.industries.value_or(0)));
	WriteU32(meta.data() + 24, static_cast<uint32_t>(config.map_size.value_or(0)));
	meta[28] = config.disasters.value_or(false) ? 1 : 0;

	const std::string_view game_name = config.game_name.has_value() ? std::string_view(*config.game_name) : std::string_view{};
	WriteU32(meta.data() + 32, static_cast<uint32_t>(game_name.size()));
	meta.insert(meta.end(), game_name.begin(), game_name.end());

	AppendSaveU32(meta, static_cast<uint32_t>(_ottd_warnings.size()));
	for (const std::string &warning : _ottd_warnings) AppendSaveString(meta, warning);

	/* v2 : profils d'entreprises humaines et entreprise locale (#99). */
	AppendSaveU32(meta, static_cast<uint32_t>(config.companies.size()));
	for (const CompanyProfile &profile : config.companies) {
		AppendSaveString(meta, profile.name);
		meta.push_back(profile.colour >= 0 && profile.colour <= 15
			? static_cast<uint8_t>(profile.colour)
			: OTTD_NO_LOCAL_COMPANY);
	}
	meta.push_back(Company::IsValidID(_local_company)
		? _local_company.base()
		: OTTD_NO_LOCAL_COMPANY);
}

/**
 * Relit les métadonnées du pont.
 * @param version version du conteneur (1 ou 2).
 * @param[out] local_company entreprise locale sauvegardée, ou 0xFF.
 * @return true si le bloc est cohérent et entièrement consommé.
 */
bool ParseSaveMetadata(const uint8_t *data, size_t size, uint16_t version,
		GameSetupConfig &config, std::vector<std::string> &warnings, uint8_t &local_company)
{
	config = GameSetupConfig{};
	warnings.clear();
	local_company = OTTD_NO_LOCAL_COMPANY;
	if (size < 40) return false;

	const uint8_t flags = data[0];
	const uint8_t landscape = data[1];
	if ((flags & (1 << 0)) != 0) {
		if (landscape > static_cast<uint8_t>(LandscapeType::Toyland)) return false;
		config.landscape = static_cast<LandscapeType>(landscape);
	}
	if ((flags & (1 << 1)) != 0) config.start_year = static_cast<int32_t>(ReadU32(data + 4));
	if ((flags & (1 << 2)) != 0) config.difficulty = static_cast<int32_t>(ReadU32(data + 8));
	if ((flags & (1 << 3)) != 0) config.ai_companies = static_cast<int32_t>(ReadU32(data + 12));
	if ((flags & (1 << 4)) != 0) config.towns = static_cast<int32_t>(ReadU32(data + 16));
	if ((flags & (1 << 5)) != 0) config.industries = static_cast<int32_t>(ReadU32(data + 20));
	if ((flags & (1 << 6)) != 0) config.map_size = static_cast<int32_t>(ReadU32(data + 24));
	if ((flags & (1 << 7)) != 0) {
		if (data[28] > 1) return false;
		config.disasters = data[28] != 0;
	}

	size_t pos = 36;
	auto read_length = [&](uint32_t &length) {
		if (pos + 4 > size) return false;
		length = ReadU32(data + pos);
		pos += 4;
		return true;
	};
	auto read_string = [&](std::string &text) {
		uint32_t length = 0;
		if (!read_length(length) || pos + length > size) return false;
		text.assign(reinterpret_cast<const char *>(data + pos), length);
		pos += length;
		return true;
	};

	/* Le nom de partie est précédé de sa longueur à l'offset 32 (en-tête
	 * fixe) ; les octets suivent immédiatement à l'offset 36. */
	const uint32_t game_name_length = ReadU32(data + 32);
	if (pos + game_name_length > size) return false;
	if (game_name_length != 0) {
		config.game_name = std::string(reinterpret_cast<const char *>(data + pos), game_name_length);
	}
	pos += game_name_length;

	uint32_t warning_count = 0;
	if (!read_length(warning_count) || warning_count > 64) return false;
	warnings.reserve(warning_count);
	for (uint32_t i = 0; i < warning_count; i++) {
		std::string warning;
		if (!read_string(warning)) return false;
		warnings.push_back(std::move(warning));
	}

	if (version >= 2) {
		uint32_t company_count = 0;
		if (!read_length(company_count) || company_count > static_cast<uint32_t>(MAX_COMPANIES)) {
			return false;
		}
		config.companies.reserve(company_count);
		for (uint32_t i = 0; i < company_count; i++) {
			CompanyProfile profile;
			if (!read_string(profile.name)) return false;
			if (pos >= size) return false;
			const uint8_t colour = data[pos++];
			if (colour != OTTD_NO_LOCAL_COMPANY && colour > 15) return false;
			profile.colour = colour == OTTD_NO_LOCAL_COMPANY ? -1 : static_cast<int>(colour);
			config.companies.push_back(std::move(profile));
		}
		if (pos >= size) return false;
		local_company = data[pos++];
		if (local_company != OTTD_NO_LOCAL_COMPANY && local_company >= MAX_COMPANIES) return false;
	}

	return pos == size;
}

/** Sauvegarde l'état courant via le chemin officiel `SaveWithFilter`. */
bool SaveToMemory(std::vector<uint8_t> &payload, std::vector<uint8_t> &meta, std::string &error)
{
	payload.clear();
	meta.clear();

	const SaveOrLoadResult result = SaveWithFilter(
		std::make_shared<OttdMemorySaveFilter>(nullptr, payload), false);
	if (result != SL_OK) {
		error = fmt::format("échec de la sauvegarde OpenTTD : {}", SaveLoadErrorMessage());
		payload.clear();
		return false;
	}
	if (payload.empty()) {
		error = "sauvegarde OpenTTD vide";
		return false;
	}

	BuildSaveMetadata(meta);
	return true;
}

/** Assemble l'en-tête du pont autour d'un .sav et de ses métadonnées. */
std::vector<uint8_t> BuildSaveContainer(const std::vector<uint8_t> &payload, const std::vector<uint8_t> &meta)
{
	std::vector<uint8_t> out(OTTD_SAVE_HEADER_SIZE + meta.size() + payload.size(), 0);
	uint64_t checksum = HashBytes(0xcbf29ce484222325ULL, meta.data(), meta.size());
	checksum = HashBytes(checksum, payload.data(), payload.size());

	WriteU32(out.data() + 0, OTTD_SAVE_MAGIC);
	WriteU16(out.data() + 4, OTTD_SAVE_VERSION);
	WriteU16(out.data() + 6, OTTD_SAVE_HEADER_SIZE);
	WriteU32(out.data() + 8, static_cast<uint32_t>(payload.size()));
	WriteU32(out.data() + 12, static_cast<uint32_t>(TimerGameTick::counter));
	WriteU64(out.data() + 16, checksum);
	WriteU32(out.data() + 24, static_cast<uint32_t>(meta.size()));
	WriteU32(out.data() + 28, 0);

	std::copy(meta.begin(), meta.end(), out.begin() + OTTD_SAVE_HEADER_SIZE);
	std::copy(payload.begin(), payload.end(), out.begin() + OTTD_SAVE_HEADER_SIZE + meta.size());
	return out;
}

/** Reconstruit le cache (ou le renvoie s'il est encore valide). */
int EnsureSaveCache()
{
	if (_ottd_save_cache_valid) return static_cast<int>(_ottd_save_cache.size());

	std::vector<uint8_t> payload;
	std::vector<uint8_t> meta;
	std::string error;
	if (!SaveToMemory(payload, meta, error)) {
		SetError(error);
		return OTTD_SL_SAVE_FAILED;
	}

	_ottd_save_cache = BuildSaveContainer(payload, meta);
	_ottd_save_cache_valid = true;
	return static_cast<int>(_ottd_save_cache.size());
}

/**
 * Charge un .sav brut dans l'état OpenTTD.
 *
 * Reproduit le chemin de `SafeLoad` + `SM_LOAD_GAME` sans passer par la GUI :
 * `_game_mode` est forcé à `GM_NORMAL`, la configuration NewGRF est
 * réinitialisée, puis `LoadWithFilter` effectue le chargement officiel.
 */
SaveOrLoadResult LoadPayload(const uint8_t *data, size_t size)
{
	_game_mode = GM_NORMAL;
	_switch_mode = SM_NONE;
	ResetGRFConfig(true);
	ResetWindowSystem();
	return LoadWithFilter(std::make_shared<OttdMemoryLoadFilter>(nullptr, data, size));
}

/** Finalise un chargement réussi : entreprise locale, compteurs, métadonnées. */
void ApplyLoadedState(const GameSetupConfig &config, const std::vector<std::string> &warnings,
		uint8_t local_company = OTTD_NO_LOCAL_COMPANY)
{
	_ottd_active_config = config;
	_ottd_warnings = warnings;
	_ottd_json_sequence = 0;
	_ottd_map_sequence = 0;
	_ottd_last_command_json = "{}";
	_ottd_last_command_status = OTTD_CMD_OK;
	_ottd_save_cache_valid = false;
	_ottd_error.clear();

	/* Le .sav ne contient pas l'entreprise locale : on restaure celle des
	 * métadonnées (#99), sinon la première entreprise jouable. */
	_current_company = _local_company;
	const CompanyID saved = local_company != OTTD_NO_LOCAL_COMPANY
		? CompanyID(local_company)
		: CompanyID::Invalid();
	const CompanyID company = Company::IsValidID(saved) ? saved : GetFirstPlayableCompanyID();
	SetLocalCompany(Company::IsValidID(company) ? company : COMPANY_SPECTATOR);

	_ottd_in_game = _game_mode == GM_NORMAL;
}

} // namespace

extern "C" {

/**
 * Hook appelé par OpenTTD (`UserErrorI`/`FatalErrorI`) juste avant l'arrêt.
 *
 * Le message est copié dans `_ottd_error` pour rester lisible via
 * `ottd_last_error()` depuis JavaScript après l'exception/trap. Aucune
 * allocation non triviale n'est faite au-delà de `std::string::assign`, et
 * `Debug` n'est pas appelé (les pilotes peuvent déjà être arrêtés).
 */
extern "C" void OttdBridgeFatalErrorHook(const char *message)
{
	_ottd_error.assign(message != nullptr ? message : "erreur fatale sans message");
	_ottd_in_game = false;
	_exit_game = true;
}

/**
 * Initialise OpenTTD avec les pilotes null/web, puis rend la main.
 * @return 0 en cas de succès, code d'erreur sinon.
 */
EMSCRIPTEN_KEEPALIVE int ottd_boot(void)
{
	if (_ottd_booted) return 0;

	_ottd_error.clear();
	_ottd_warnings.clear();
	_ottd_has_pending_config = false;
	_ottd_save_cache.clear();
	_ottd_save_cache_valid = false;
	_exit_game = false;
	/* Installé avant `openttd_main` : une erreur de pilote ou de baseset est
	 * ainsi mémorisée avant `_exit`. */
	_ottd_fatal_error_hook = OttdBridgeFatalErrorHook;

	static const std::string arg0 = "openttd";
	static const std::string arg_v = "-v";
	static const std::string arg_web = "web";
	static const std::string arg_m = "-m";
	static const std::string arg_s = "-s";
	static const std::string arg_null = "null";
	static const std::string arg_b = "-b";
	static const std::string arg_c = "-c";
	static const std::string arg_config = "/openttd.cfg";
	static const std::string arg_r = "-r";
	static const std::string arg_res = "640x480";
	static const std::string arg_Q = "-Q";

	std::vector<std::string_view> args = {
		arg0,
		arg_v, arg_web,
		arg_m, arg_null,
		arg_s, arg_null,
		arg_b, arg_null,
		arg_c, arg_config,
		arg_r, arg_res,
		arg_Q,
	};

	const int result = openttd_main(args);
	if (result != 0) {
		SetError(fmt::format("openttd_main a échoué (code {})", result));
		return result;
	}

	/* Le premier GameLoop exécute le scan NewGRF et initialise la console/GUI. */
	PumpOneTick();
	if (_exit_game) {
		SetError("OpenTTD a demandé la sortie pendant l'initialisation");
		return 3;
	}

	_ottd_booted = true;
	return 0;
}

/**
 * Démarre une nouvelle partie déterministe.
 *
 * Cœur commun aux trois points d'entrée publics (`ottd_new_game`,
 * `ottd_new_game_ex`, `ottd_set_game_config` + `ottd_new_game`).
 *
 * @param seed graine de génération (uint32_t)
 * @param w largeur de la carte (puissance de 2, 64..4096)
 * @param h hauteur de la carte (puissance de 2, 64..4096)
 * @param config configuration validée à appliquer avant la génération
 * @return 0 en cas de succès, 5 si la partie est jouable mais que les IA n'ont
 *         pas toutes démarré, code d'erreur sinon.
 */
static int StartGame(uint32_t seed, uint32_t w, uint32_t h, const GameSetupConfig &config)
{
	if (!_ottd_booted) {
		SetError("ottd_boot() doit être appelé avant ottd_new_game()");
		return 1;
	}
	if (!IsPowerOfTwo(w) || !IsPowerOfTwo(h) || w < 64 || h < 64 || w > 4096 || h > 4096) {
		SetError(fmt::format("taille de carte invalide {}x{} (puissance de 2 attendue, 64..4096)", w, h));
		return 2;
	}

	_ottd_error.clear();
	_ottd_warnings.clear();
	_ottd_save_cache_valid = false;

	std::string config_error;
	if (!ApplyGameConfig(config, w, h, config_error)) {
		SetError(config_error);
		return 4;
	}

	_exit_game = false;
	_ottd_in_game = false;

	SetRandomSeed(seed);
	_settings_newgame.game_creation.generation_seed = seed;
	_settings_newgame.game_creation.map_x = Log2(w);
	_settings_newgame.game_creation.map_y = Log2(h);

	StartNewGameWithoutGUI(seed);

	/* La génération est synchrone dans OpenTTD 15 (GWM_NEWGAME) : un seul
	 * GameLoop déclenche SwitchToMode -> MakeNewGame -> GenerateWorld. */
	PumpOneTick();

	if (_game_mode != GM_NORMAL || _switch_mode != SM_NONE) {
		SetError(fmt::format("génération incomplète (mode {}, switch {})",
			static_cast<int>(_game_mode), static_cast<int>(_switch_mode)));
		return 3;
	}

	_ottd_active_config = config;

	int result = 0;

	/* Le pilote web n'a pas de GUI : OpenTTD se comporte comme un serveur
	 * dédié et ne crée aucune entreprise. On crée les entreprises humaines
	 * (#99) — une seule sans profil explicite — puis les IA. Chaque module
	 * choisit ensuite son entreprise avec `ottd_set_local_company()`. */
	CompanyID first_human = CompanyID::Invalid();
	if (config.companies.empty() && Company::GetNumItems() > 0) {
		first_human = CompanyID::Begin();
	} else {
		std::string company_error;
		const int human_expected = config.companies.empty() ? 1 : static_cast<int>(config.companies.size());
		const int human_started = StartHumanCompanies(config.companies, first_human, company_error);
		if (human_started < human_expected) {
			_ottd_warnings.push_back(fmt::format(
				"Entreprises humaines créées : {}/{} ({})", human_started, human_expected, company_error));
			result = 5;
			SetError(_ottd_warnings.back());
		}
	}
	if (Company::IsValidID(first_human)) SetLocalCompany(first_human);

	const int ai_count = config.ai_companies.value_or(0);
	if (ai_count > 0) {
		std::string ai_error;
		const int started = StartAiCompanies(ai_count, ai_error);
		if (started < ai_count) {
			_ottd_warnings.push_back(fmt::format(
				"IA démarrées : {}/{} ({})", started, ai_count, ai_error));
			/* La partie reste jouable : les entreprises déjà créées et la
			 * génération du monde sont valides. Le code 5 le signale. */
			result = 5;
			SetError(_ottd_warnings.back());
		}
	}

	_pause_mode = {};
	_ottd_in_game = true;
	_ottd_json_sequence = 0;
	_ottd_map_sequence = 0;
	_ottd_last_command_json = "{}";
	_ottd_last_command_status = OTTD_CMD_OK;

	/* Un tick pour laisser les initialisations de partie se terminer. */
	PumpOneTick();
	return result;
}

/**
 * Démarre une nouvelle partie déterministe avec la configuration en attente
 * (`ottd_set_game_config`) ou les défauts OpenTTD.
 *
 * API compatible avec la v1 : sans `ottd_set_game_config`, cette fonction
 * produit exactement le même monde que la version précédente du pont.
 *
 * @param seed graine de génération (uint32_t)
 * @param w largeur de la carte (puissance de 2, 64..4096)
 * @param h hauteur de la carte (puissance de 2, 64..4096)
 * @return 0 en cas de succès, code d'erreur sinon (voir `ottd_last_error`).
 */
EMSCRIPTEN_KEEPALIVE int ottd_new_game(uint32_t seed, uint32_t w, uint32_t h)
{
	const GameSetupConfig config = _ottd_has_pending_config ? _ottd_pending_config : GameSetupConfig{};
	return StartGame(seed, w, h, config);
}

/**
 * Démarre une nouvelle partie avec une configuration JSON explicite.
 *
 * La configuration remplace celle posée par `ottd_set_game_config()` et reste
 * active pour les prochains appels. `config_json` peut être `nullptr`, vide
 * ou `"null"` pour démarrer avec les défauts.
 *
 * @param seed graine de génération (uint32_t)
 * @param w largeur de la carte (puissance de 2, 64..4096)
 * @param h hauteur de la carte (puissance de 2, 64..4096)
 * @param config_json objet JSON plat (voir `GameSetupConfig`).
 * @return 0 en cas de succès, 4 si la configuration est invalide (la partie
 *         n'est pas démarrée), 5 si la partie est jouable sans toutes les IA.
 */
EMSCRIPTEN_KEEPALIVE int ottd_new_game_ex(uint32_t seed, uint32_t w, uint32_t h, const char *config_json)
{
	if (!_ottd_booted) {
		SetError("ottd_boot() doit être appelé avant ottd_new_game_ex()");
		return 1;
	}

	GameSetupConfig config;
	if (config_json != nullptr) {
		std::string config_error;
		if (!ParseGameConfig(config_json, config, config_error)) {
			SetError(config_error);
			return 4;
		}
		_ottd_pending_config = config;
		_ottd_has_pending_config = true;
	} else {
		config = _ottd_has_pending_config ? _ottd_pending_config : GameSetupConfig{};
	}

	return StartGame(seed, w, h, config);
}

/**
 * Enregistre la configuration du prochain `ottd_new_game()`.
 *
 * @param config_json objet JSON plat, ou `nullptr`/vide/`"null` pour revenir
 *        aux défauts OpenTTD.
 * @return 0 si la configuration est valide, 4 sinon (rien n'est modifié).
 */
EMSCRIPTEN_KEEPALIVE int ottd_set_game_config(const char *config_json)
{
	GameSetupConfig config;
	std::string config_error;
	if (config_json != nullptr && !ParseGameConfig(config_json, config, config_error)) {
		SetError(config_error);
		return 4;
	}

	if (config_json == nullptr) {
		_ottd_pending_config = GameSetupConfig{};
		_ottd_has_pending_config = false;
	} else {
		_ottd_pending_config = config;
		_ottd_has_pending_config = true;
	}
	return 0;
}

/**
 * Avance la simulation de `ticks` ticks.
 * @return nombre de ticks réellement exécutés.
 */
EMSCRIPTEN_KEEPALIVE int ottd_step(uint32_t ticks)
{
	if (!_ottd_booted) {
		SetError("ottd_step() appelé avant ottd_boot()");
		return 0;
	}
	if (ticks == 0) return 0;

	/* Après une erreur fatale, on conserve le message pour `ottd_last_error`. */
	if (!_exit_game) _ottd_error.clear();
	uint32_t executed = 0;
	while (executed < ticks) {
		if (_exit_game) break;
		PumpOneTick();
		executed++;
	}
	if (executed != 0) _ottd_save_cache_valid = false;
	return static_cast<int>(executed);
}

/** Tick courant de la simulation (TimerGameTick). */
EMSCRIPTEN_KEEPALIVE uint32_t ottd_tick(void)
{
	return static_cast<uint32_t>(TimerGameTick::counter);
}

/** Hash FNV-1a déterministe de l'état courant. */
EMSCRIPTEN_KEEPALIVE uint64_t ottd_hash(void)
{
	return ComputeStateHash();
}

/** Dernière erreur lisible par l'appelant (chaîne statique). */
EMSCRIPTEN_KEEPALIVE const char *ottd_last_error(void)
{
	return _ottd_error.c_str();
}

/**
 * Exécute une commande de construction ou de véhicule (issue #11).
 *
 * Le JSON d'entrée suit `EngineCommand` de `src/engine/protocol.ts` :
 * `{"type":"build","tool":…,"from":{…},"to":{…},"options":{…},"company":…}`
 * ou `{"type":"vehicle","action":…,"company":…,"vehicle":…,"depot":{…},…}`.
 * Le JSON de sortie `{ok, code, message, cost, tiles, stationId, vehicleId,
 * depotId, model, detail}` est toujours disponible via
 * `ottd_command_result()` ; il est aussi recopié dans `out` si la capacité le
 * permet.
 *
 * @param json      commande JSON (NUL-terminé).
 * @param out       buffer de sortie (facultatif, peut être NULL).
 * @param capacity  taille de `out` en octets.
 * @return 0 si la commande a été exécutée, sinon un code `OttdCommandStatus` :
 *         1 aucune partie, 2 JSON invalide, 3 commande inconnue, 4 paramètre
 *         invalide, 5 entreprise invalide, 6 refus d'OpenTTD, 7 buffer trop
 *         petit, 8 commande non supportée.
 */
EMSCRIPTEN_KEEPALIVE int ottd_command(const char *json, char *out, int capacity)
{
	const int status = ExecuteCommandJson(json != nullptr ? std::string_view(json) : std::string_view{});

	const size_t required = _ottd_last_command_json.size() + 1;
	if (out != nullptr && capacity >= static_cast<int>(required)) {
		std::copy(_ottd_last_command_json.begin(), _ottd_last_command_json.end(), out);
		out[_ottd_last_command_json.size()] = '\0';
	}
	if (out != nullptr && capacity < static_cast<int>(required)) return OTTD_CMD_BUFFER;
	return status;
}

/** Dernier résultat JSON de `ottd_command()` (valide jusqu'au prochain appel). */
EMSCRIPTEN_KEEPALIVE const char *ottd_command_result(void)
{
	return _ottd_last_command_json.c_str();
}

/**
 * Identifiant de l'entreprise locale (contexte par défaut des commandes).
 * @return 0..14, ou -1 si aucune partie n'est en cours.
 */
EMSCRIPTEN_KEEPALIVE int ottd_company_id(void)
{
	if (!_ottd_in_game || !Company::IsValidID(_local_company)) return -1;
	return static_cast<int>(_local_company.base());
}

/**
 * Choisit l'entreprise contrôlée par ce module (#99).
 *
 * Chaque pair réseau appelle cette fonction avec l'entreprise du joueur local.
 * L'état simulé est inchangé : seul le contexte local (`_local_company`,
 * `isLocal` dans le snapshot, entreprise par défaut des commandes) change.
 *
 * @param company 0..14, entreprise existante et non contrôlée par une IA.
 * @return 0 en cas de succès, 1 sans partie, 5 si l'entreprise est invalide.
 */
EMSCRIPTEN_KEEPALIVE int ottd_set_local_company(int company)
{
	if (!_ottd_booted) {
		SetError("ottd_set_local_company() appelé avant ottd_boot()");
		return 1;
	}
	if (!_ottd_in_game) {
		SetError("ottd_set_local_company() appelé sans partie en cours");
		return 1;
	}
	if (company < 0 || company >= static_cast<int>(MAX_COMPANIES) ||
			!Company::IsValidID(CompanyID(static_cast<uint8_t>(company)))) {
		SetError(fmt::format("entreprise locale {} inexistante", company));
		return 5;
	}
	const Company *target = Company::Get(CompanyID(static_cast<uint8_t>(company)));
	if (target->is_ai) {
		SetError(fmt::format("entreprise {} contrôlée par une IA", company));
		return 5;
	}

	SetLocalCompany(CompanyID(static_cast<uint8_t>(company)));
	return 0;
}

/**
 * Taille du conteneur de sauvegarde mémoire de l'état courant (issue #61).
 *
 * La sauvegarde est produite une fois puis mise en cache jusqu'au prochain
 * `ottd_step`, `ottd_command`, `ottd_new_game` ou `ottd_load`.
 *
 * @return nombre d'octets requis (> 0), ou un code `OttdSaveLoadStatus`
 *         négatif : -1 aucune partie, -2 module non démarré, -5 échec
 *         d'OpenTTD (détail dans `ottd_last_error`).
 */
EMSCRIPTEN_KEEPALIVE int ottd_save_size(void)
{
	if (!_ottd_booted) {
		SetError("ottd_save_size() appelé avant ottd_boot()");
		return OTTD_SL_NOT_BOOTED;
	}
	if (!_ottd_in_game) {
		SetError("ottd_save_size() appelé sans partie en cours");
		return OTTD_SL_NO_GAME;
	}

	_ottd_error.clear();
	return EnsureSaveCache();
}

/**
 * Écrit une sauvegarde mémoire de l'état complet dans `out`.
 *
 * Le format est un conteneur de 32 octets (magie `OT3S`, version, tailles,
 * tick, somme de contrôle) suivi des métadonnées du pont puis d'un fichier
 * `.sav` OpenTTD standard (en-tête et compression officiels). Il peut donc
 * être extrait et ouvert par OpenTTD, et rechargé par `ottd_load`.
 *
 * @param out      destination, ou `nullptr` pour ne mesurer que la taille.
 * @param capacity taille de `out` en octets.
 * @return nombre d'octets écrits (ou requis si `out` est `nullptr` ou trop
 *         petit), ou un code négatif (voir `ottd_save_size`).
 */
EMSCRIPTEN_KEEPALIVE int ottd_save(uint8_t *out, int capacity)
{
	const int required = ottd_save_size();
	if (required < 0) return required;
	if (out == nullptr || capacity < required) return required;

	std::copy(_ottd_save_cache.begin(), _ottd_save_cache.end(), out);
	return required;
}

/**
 * Charge une sauvegarde produite par `ottd_save` (issue #61).
 *
 * Le conteneur est intégralement validé (taille, magie, version, somme de
 * contrôle, métadonnées) avant de toucher à l'état OpenTTD. Si le chargement
 * échoue malgré tout, l'état précédent est sauvegardé puis restauré : une
 * sauvegarde tronquée ou corrompue laisse le module utilisable.
 *
 * @param data   conteneur `OT3S` (peut être un buffer WASM).
 * @param length taille du conteneur en octets.
 * @return 0 en cas de succès, sinon un code `OttdSaveLoadStatus` négatif :
 *         -2 module non démarré, -3 argument invalide, -4 conteneur corrompu,
 *         -5 sauvegarde de sécurité impossible (état inchangé), -6 chargement
 *         refusé (état précédent restauré), -7 chargement refusé et
 *         restauration impossible.
 */
EMSCRIPTEN_KEEPALIVE int ottd_load(const uint8_t *data, int length)
{
	if (!_ottd_booted) {
		SetError("ottd_load() appelé avant ottd_boot()");
		return OTTD_SL_NOT_BOOTED;
	}
	if (data == nullptr || length <= 0) {
		SetError("ottd_load() : buffer nul ou vide");
		return OTTD_SL_BAD_ARGUMENT;
	}

	_ottd_error.clear();
	_ottd_save_cache_valid = false;

	if (length < static_cast<int>(OTTD_SAVE_HEADER_SIZE)) {
		SetError(fmt::format("sauvegarde tronquée : {} octets, en-tête de {} requis",
			length, OTTD_SAVE_HEADER_SIZE));
		return OTTD_SL_CORRUPT;
	}

	const uint32_t magic = ReadU32(data + 0);
	if (magic != OTTD_SAVE_MAGIC) {
		SetError(fmt::format("sauvegarde invalide : magie 0x{:08x} au lieu de 0x{:08x}", magic, OTTD_SAVE_MAGIC));
		return OTTD_SL_CORRUPT;
	}
	const uint16_t version = ReadU16(data + 4);
	if (version < OTTD_SAVE_VERSION_MIN || version > OTTD_SAVE_VERSION) {
		SetError(fmt::format("version de sauvegarde {} non supportée (attendu {}..{})",
			version, OTTD_SAVE_VERSION_MIN, OTTD_SAVE_VERSION));
		return OTTD_SL_CORRUPT;
	}
	const uint16_t header_size = ReadU16(data + 6);
	if (header_size != OTTD_SAVE_HEADER_SIZE) {
		SetError(fmt::format("en-tête de sauvegarde invalide : {} octets", header_size));
		return OTTD_SL_CORRUPT;
	}

	const uint32_t payload_size = ReadU32(data + 8);
	const uint32_t metadata_size = ReadU32(data + 24);
	const uint64_t expected_size = static_cast<uint64_t>(header_size) + metadata_size + payload_size;
	if (expected_size != static_cast<uint64_t>(length)) {
		SetError(fmt::format("sauvegarde incohérente : {} octets annoncés, {} reçus (tronquée ou corrompue)",
			expected_size, length));
		return OTTD_SL_CORRUPT;
	}

	const uint8_t *metadata = data + header_size;
	const uint8_t *payload = metadata + metadata_size;
	uint64_t checksum = HashBytes(0xcbf29ce484222325ULL, metadata, metadata_size);
	checksum = HashBytes(checksum, payload, payload_size);
	if (checksum != ReadU64(data + 16)) {
		SetError("sauvegarde corrompue : somme de contrôle invalide");
		return OTTD_SL_CORRUPT;
	}

	GameSetupConfig config;
	std::vector<std::string> warnings;
	uint8_t saved_local_company = OTTD_NO_LOCAL_COMPANY;
	if (!ParseSaveMetadata(metadata, metadata_size, version, config, warnings, saved_local_company)) {
		SetError("sauvegarde corrompue : métadonnées du pont invalides");
		return OTTD_SL_CORRUPT;
	}

	/* Sauvegarde de sécurité : si OpenTTD échoue en cours de chargement,
	 * `SlError` remet les pointeurs à zéro et détruit l'état courant. */
	const bool had_game = _ottd_in_game;
	std::vector<uint8_t> backup_payload;
	std::vector<uint8_t> backup_meta;
	if (had_game) {
		std::string backup_error;
		if (!SaveToMemory(backup_payload, backup_meta, backup_error)) {
			SetError(fmt::format("chargement annulé : sauvegarde de sécurité impossible ({})", backup_error));
			return OTTD_SL_SAVE_FAILED;
		}
	}
	const GameSetupConfig previous_config = _ottd_active_config;
	const std::vector<std::string> previous_warnings = _ottd_warnings;
	const uint8_t previous_local_company = Company::IsValidID(_local_company)
		? _local_company.base()
		: OTTD_NO_LOCAL_COMPANY;

	_ottd_in_game = false;
	const SaveOrLoadResult result = LoadPayload(payload, payload_size);
	if (result == SL_OK) {
		ApplyLoadedState(config, warnings, saved_local_company);
		return OTTD_SL_OK;
	}

	const std::string load_error = SaveLoadErrorMessage();
	if (!had_game) {
		_ottd_in_game = false;
		SetError(fmt::format("chargement refusé : {}", load_error));
		return OTTD_SL_LOAD_FAILED;
	}

	const SaveOrLoadResult restored = LoadPayload(backup_payload.data(), backup_payload.size());
	if (restored == SL_OK) {
		ApplyLoadedState(previous_config, previous_warnings, previous_local_company);
		SetError(fmt::format("chargement refusé ({}), état précédent restauré", load_error));
		return OTTD_SL_LOAD_FAILED;
	}

	_ottd_in_game = false;
	_ottd_active_config = previous_config;
	_ottd_warnings = previous_warnings;
	SetError(fmt::format("chargement refusé ({}) et restauration impossible ({})",
		load_error, SaveLoadErrorMessage()));
	return OTTD_SL_STATE_LOST;
}

/**
 * Écrit les tableaux carte complets dans un buffer binaire versionné.
 *
 * @param out       destination (peut être nullptr pour ne mesurer que la taille)
 * @param capacity  taille du buffer, en octets
 * @return nombre d'octets requis (> 0), ou un code négatif si aucune partie
 *         n'est en cours. Si `out` est nullptr ou si `capacity` est
 *         insuffisante, rien n'est écrit ; réappeler avec la taille requise.
 *
 * Disposition détaillée en tête de fichier : en-tête de 64 octets, répertoire
 * de 6 entrées de 12 octets, puis 6 sections de `width * height` octets
 * (kind, heightMap, owner, slope, flags, trackBits).
 */
EMSCRIPTEN_KEEPALIVE int ottd_snapshot_map(uint8_t *out, int capacity)
{
	if (!_ottd_in_game) {
		SetError("ottd_snapshot_map() appelé sans partie en cours");
		return -1;
	}

	const uint32_t width = Map::SizeX();
	const uint32_t height = Map::SizeY();
	const uint32_t tiles = Map::Size();
	const uint32_t total = MapSnapshotBytes(width, height);

	if (out == nullptr || capacity < static_cast<int>(total)) return static_cast<int>(total);

	/* En-tête. */
	WriteU32(out + 0, OTTD_MAP_MAGIC);
	WriteU16(out + 4, OTTD_MAP_VERSION);
	WriteU16(out + 6, OTTD_MAP_HEADER_SIZE);
	WriteU32(out + 8, width);
	WriteU32(out + 12, height);
	WriteU32(out + 16, tiles);
	WriteU32(out + 20, OTTD_MAP_LAYER_COUNT);
	WriteU32(out + 24, ++_ottd_map_sequence);
	WriteU32(out + 28, static_cast<uint32_t>(TimerGameTick::counter));
	WriteU32(out + 32, 1); /* bit 0 : snapshot complet. */
	WriteU32(out + 36, OTTD_MAP_DATA_OFFSET);
	WriteU32(out + 40, OTTD_MAP_HEADER_SIZE);
	WriteU32(out + 44, tiles);
	WriteU32(out + 48, 0);
	WriteU32(out + 52, 0);
	WriteU32(out + 56, 0);
	WriteU32(out + 60, 0);

	/* Répertoire et pointeurs de section. */
	static constexpr uint8_t layer_ids[OTTD_MAP_LAYER_COUNT] = {
		MAP_LAYER_KIND, MAP_LAYER_HEIGHT, MAP_LAYER_OWNER,
		MAP_LAYER_SLOPE, MAP_LAYER_FLAGS, MAP_LAYER_TRACK, MAP_LAYER_SIGNAL,
	};

	uint8_t *sections[OTTD_MAP_LAYER_COUNT];
	for (uint8_t layer = 0; layer < OTTD_MAP_LAYER_COUNT; layer++) {
		uint8_t *entry = out + OTTD_MAP_HEADER_SIZE + layer * OTTD_MAP_DIRECTORY_ENTRY_SIZE;
		const uint32_t offset = OTTD_MAP_DATA_OFFSET + layer * tiles;

		entry[0] = layer_ids[layer];
		entry[1] = 1; /* elem_size */
		WriteU16(entry + 2, 0);
		WriteU32(entry + 4, offset);
		WriteU32(entry + 8, tiles);

		sections[layer] = out + offset;
	}

	uint8_t *kind = sections[0];
	uint8_t *height_map = sections[1];
	uint8_t *owner = sections[2];
	uint8_t *slope = sections[3];
	uint8_t *flags = sections[4];
	uint8_t *track = sections[5];
	uint8_t *signal = sections[6];

	const uint8_t snow_line = GetSnowLine();

	for (uint32_t index = 0; index < tiles; index++) {
		Tile tile{TileIndex(index)};

		kind[index] = TileKind(tile);
		height_map[index] = static_cast<uint8_t>(TileHeight(tile));
		owner[index] = TileOwnerByte(tile);
		slope[index] = static_cast<uint8_t>(GetTileSlope(tile));
		flags[index] = TileFlags(tile, snow_line);
		track[index] = tile.m8();
		signal[index] = PackSignalData(tile);
	}

	return static_cast<int>(total);
}

/**
 * Écrit le snapshot monde JSON (économie, entreprises, villes, industries,
 * gares, véhicules). Les tableaux carte sont fournis séparément par
 * `ottd_snapshot_map()` : les inclure en base64 coûterait trop cher.
 *
 * @param out buffer de destination (peut être nullptr pour ne mesurer que la taille)
 * @param capacity taille du buffer, en octets
 * @return taille requise (octets, terminateur inclus) ; si capacity est
 *         insuffisante, le buffer contient une chaîne vide et rien n'est tronqué.
 */
EMSCRIPTEN_KEEPALIVE int ottd_snapshot_json(char *out, int capacity)
{
	uint32_t width = 0;
	uint32_t height = 0;
	if (_ottd_in_game) {
		width = Map::SizeX();
		height = Map::SizeY();
	}

	std::string json;
	if (!_ottd_in_game) {
		json = "{\"meta\":{\"protocol\":1,\"tick\":0,\"hash\":\"0x0000000000000000\",\"sequence\":0},"
			"\"economy\":null,\"map\":null,\"counts\":{\"companies\":0,\"towns\":0,\"industries\":0,"
			"\"stations\":0,\"vehicles\":0},\"config\":null,\"warnings\":[],\"companies\":[],"
			"\"towns\":[],\"industries\":[],\"stations\":[],\"vehicles\":[],\"subsidies\":[],"
			"\"news\":[],\"events\":[]}";
	} else {
		BuildWorldJson(json, width, height);
	}

	const int required = static_cast<int>(json.size()) + 1;
	if (out == nullptr || capacity < required) {
		if (out != nullptr && capacity > 0) out[0] = '\0';
		return required;
	}

	std::copy(json.begin(), json.end(), out);
	out[json.size()] = '\0';
	if (_ottd_in_game) _ottd_json_sequence++;
	return required;
}

/**
 * Arrête la simulation et libère les ressources OpenTTD (pools, drivers).
 * Le module WASM n'est pas réutilisable après cet appel : instanciez-en un
 * nouveau pour rejouer une partie.
 */
EMSCRIPTEN_KEEPALIVE void ottd_shutdown(void)
{
	if (!_ottd_booted) return;
	_ottd_fatal_error_hook = nullptr;
	_exit_game = true;
	PostMainLoop();
	_ottd_in_game = false;
	_ottd_booted = false;
	_ottd_save_cache.clear();
	_ottd_save_cache_valid = false;
}

} // extern "C"
