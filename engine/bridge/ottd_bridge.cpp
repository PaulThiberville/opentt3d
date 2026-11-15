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
#include "direction_func.h"
#include "direction_type.h"
#include "elrail_func.h"
#include "engine_base.h"
#include "engine_func.h"
#include "engine_type.h"
#include "gfx_func.h"
#include "genworld.h"
#include "industry.h"
#include "industrytype.h"
#include "landscape.h"
#include "landscape_cmd.h"
#include "landscape_type.h"
#include "map_func.h"
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
#include "table/strings.h"
#include "tile_map.h"
#include "timer/timer_game_calendar.h"
#include "timer/timer_game_tick.h"
#include "town.h"
#include "track_func.h"
#include "track_type.h"
#include "tunnelbridge_map.h"
#include "vehicle_base.h"
#include "vehicle_cmd.h"
#include "vehicle_type.h"
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
 */
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
static constexpr uint16_t OTTD_MAP_VERSION = 1;
static constexpr uint16_t OTTD_MAP_HEADER_SIZE = 64;
static constexpr uint16_t OTTD_MAP_DIRECTORY_ENTRY_SIZE = 12;
static constexpr uint8_t OTTD_MAP_LAYER_COUNT = 6;
static constexpr uint32_t OTTD_MAP_DATA_OFFSET = OTTD_MAP_HEADER_SIZE + OTTD_MAP_LAYER_COUNT * OTTD_MAP_DIRECTORY_ENTRY_SIZE;

enum MapLayer : uint8_t {
	MAP_LAYER_KIND = 1,
	MAP_LAYER_HEIGHT = 2,
	MAP_LAYER_OWNER = 3,
	MAP_LAYER_SLOPE = 4,
	MAP_LAYER_FLAGS = 5,
	MAP_LAYER_TRACK = 6,
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
			return TK_ROAD;

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
			return IsBridgeTile(tile) ? TK_BRIDGE : TK_TUNNEL;

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

/** Nom d'une entreprise, avec repli stable quand le nom n'est pas encore généré. */
std::string CompanyName(const Company *c)
{
	if (!c->name.empty()) return c->name;
	if (c->name_1 != INVALID_STRING_ID) return GetString(c->name_1, c->name_2);
	return fmt::format("Company {}", c->index.base() + 1);
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
	AppendJsonString(out, CargoName(cargo));
	out += fmt::format(",\"amount\":{},\"capacity\":{}}}", amount, capacity);
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

	const uint32_t companies = static_cast<uint32_t>(Company::GetNumItems());
	const uint32_t towns = static_cast<uint32_t>(Town::GetNumItems());
	const uint32_t industries = static_cast<uint32_t>(Industry::GetNumItems());
	const uint32_t stations = static_cast<uint32_t>(Station::GetNumItems());

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

	out.reserve(4096 + companies * 256 + towns * 160 + industries * 256 + stations * 256 + vehicles * 256);

	out += fmt::format(
		"{{\"meta\":{{\"protocol\":1,\"tick\":{},\"hash\":\"0x{:016x}\",\"sequence\":{}}},"
		"\"economy\":{{\"year\":{},\"month\":{},\"day\":{},\"dayFraction\":{},\"speed\":{:.2f},\"paused\":{}}},"
		"\"map\":{{\"width\":{},\"height\":{},\"encoding\":\"binary\",\"api\":\"ottd_snapshot_map\",\"bytes\":{},\"layers\":{},\"elementSize\":1}},",
		tick, hash, sequence,
		ymd.year.base(), ymd.month, ymd.day, day_fraction, speed, _pause_mode.Any() ? "true" : "false",
		width, height, MapSnapshotBytes(width, height),
		static_cast<unsigned>(OTTD_MAP_LAYER_COUNT));

	out += fmt::format(
		"\"counts\":{{\"companies\":{},\"towns\":{},\"industries\":{},\"stations\":{},\"vehicles\":{}}},",
		companies, towns, industries, stations, vehicles);

	/* --- Configuration appliquée (issue #60) ------------------------------ */
	const GameSetupConfig &active = _ottd_active_config;
	out += "\"config\":{\"climate\":";
	AppendJsonString(out, LandscapeName(_settings_game.game_creation.landscape));
	out += fmt::format(
		",\"startYear\":{},\"difficulty\":{},\"aiCompanies\":{},\"towns\":{},\"industries\":{},"
		"\"seed\":{},\"mapSize\":{},\"gameName\":",
		_settings_game.game_creation.starting_year.base(),
		active.difficulty.value_or(-1),
		active.ai_companies.value_or(0),
		active.towns.value_or(-1),
		active.industries.value_or(-1),
		_settings_game.game_creation.generation_seed,
		Map::SizeX() == Map::SizeY() ? Map::SizeX() : 0);
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
		out += fmt::format(
			",\"colour\":{},\"money\":{},\"loan\":{},\"value\":{},\"income\":{},\"expenses\":{},"
			"\"vehicles\":{},\"stations\":{},\"isAI\":{},\"isLocal\":{},\"bankrupt\":{}}}",
			static_cast<unsigned>(c->colour),
			static_cast<int64_t>(c->money),
			static_cast<int64_t>(c->current_loan),
			static_cast<int64_t>(CalculateCompanyValue(c)),
			static_cast<int64_t>(c->cur_economy.income),
			static_cast<int64_t>(c->cur_economy.expenses),
			vehicles_owned, stations_owned,
			c->is_ai ? "true" : "false",
			c->index == _local_company ? "true" : "false",
			c->months_of_bankruptcy > 0 ? "true" : "false");
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
			",\"x\":{},\"y\":{},\"population\":{},\"growthRate\":{},\"buildings\":{},\"rating\":{}}}",
			TileX(t->xy), TileY(t->xy),
			t->cache.population, t->growth_rate, t->cache.num_houses, rating);
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

		out += fmt::format("{{\"id\":{},\"name\":", ind->index.base());
		AppendJsonString(out, ind->GetCachedName());
		out += ",\"kind\":";
		AppendJsonString(out, spec != nullptr ? GetString(spec->name) : "unknown");
		out += fmt::format(
			",\"type\":{},\"x\":{:.2f},\"y\":{:.2f},\"width\":{},\"height\":{},"
			"\"production\":{},\"transported\":{},\"stocks\":[",
			static_cast<unsigned>(ind->type),
			TileX(ind->location.tile) + (ind->location.w > 1 ? (ind->location.w - 1) / 2.0 : 0.0),
			TileY(ind->location.tile) + (ind->location.h > 1 ? (ind->location.h - 1) / 2.0 : 0.0),
			ind->location.w, ind->location.h,
			production, transported);

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
		out += fmt::format("],\"profitLastYear\":{:.2f},\"ageDays\":{}}}",
			static_cast<double>(v->profit_last_year) / 256.0,
			v->age.base());
	}
	out.push_back(']');

	/* `news` et `events` restent vides en v1 : le moteur ne journalise pas
	 * encore ces informations de façon exploitable (voir wiki). */
	out += ",\"news\":[],\"events\":[]}";
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
	int tiles = 0;
	int orders = 0;
	VehicleID vehicle = VehicleID::Invalid();
	StationID station = StationID::Invalid();
	DepotID depot = DepotID::Invalid();
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
	const RailType rail_type = SelectRailType(company);
	if (rail_type == INVALID_RAILTYPE) {
		return FailWith(reply, "NO_RAIL_TYPE", "Aucun type de voie disponible pour cette entreprise.");
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
		const RailType rail_type = SelectRailType(company);
		if (rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE", "Aucun type de voie disponible pour cette entreprise.");
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
		const RailType rail_type = SelectRailType(company);
		if (rail_type == INVALID_RAILTYPE) {
			return FailWith(reply, "NO_RAIL_TYPE", "Aucun type de voie disponible pour cette entreprise.");
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
	const std::string type = LowerAscii(OptionString(options, "type", "block"));
	if (type != "block" && type != "bloc") {
		return FailWith(reply, "NOT_SUPPORTED",
				"Seuls les signaux de bloc sont supportés (« options.type » = block).");
	}

	std::vector<TileIndex> tiles;
	if (has_to) {
		if (from_x != to_x && from_y != to_y) {
			return FailWith(reply, "INVALID_PARAMETER", "Un alignement de signaux doit suivre x ou y.");
		}
		MakeLPath(from_x, from_y, to_x, to_y, false, tiles);
	} else {
		tiles.push_back(TileXY(from_x, from_y));
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

	for (size_t i = 0; i < tiles.size(); i++) {
		CommandCost test = RunCompanyCommand<CMD_BUILD_SINGLE_SIGNAL>(
				company, tiles[i], true, tiles[i], tracks[i], SIGTYPE_BLOCK, SIG_ELECTRIC,
				false, false, false, SIGTYPE_BLOCK, SIGTYPE_BLOCK, 0, 0);
		if (test.Failed()) return FailFromCommand(reply, test, "COMMAND_FAILED", "Construction de signal refusée.");
	}

	Money spent = 0;
	for (size_t i = 0; i < tiles.size(); i++) {
		CommandCost result = RunCompanyCommand<CMD_BUILD_SINGLE_SIGNAL>(
				company, tiles[i], false, tiles[i], tracks[i], SIGTYPE_BLOCK, SIG_ELECTRIC,
				false, false, false, SIGTYPE_BLOCK, SIGTYPE_BLOCK, 0, 0);
		if (result.Failed()) {
			reply.cost = spent;
			reply.tiles = static_cast<int>(i);
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Construction de signal interrompue.");
		}
		spent += result.GetCost();
	}

	reply.cost = spent;
	reply.tiles = static_cast<int>(tiles.size());
	return Succeed(reply, fmt::format("{} signal(aux) de bloc construit(s).", tiles.size()));
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
	if (tool == "clear" || tool == "demolish" || tool == "demolition") return BuildClear(company, root, reply);
	if (tool == "bridge" || tool == "tunnel" || tool == "pont") {
		return FailWith(reply, "NOT_SUPPORTED",
				"Les ponts et tunnels ne sont pas supportés par le pont pour l'instant (#11).");
	}
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

bool VehicleBuy(CompanyID company, const JsonValue &root, CommandReply &reply)
{
	int depot_x, depot_y;
	if (!JsonGetTile(root.Find("depot"), depot_x, depot_y) || !IsTileInMap(depot_x, depot_y)) {
		return FailWith(reply, "INVALID_PARAMETER", "Le champ « depot » doit être une tuile de la carte.");
	}
	const TileIndex tile = TileXY(depot_x, depot_y);
	if (!IsDepotTile(tile)) {
		return FailWith(reply, "NOT_A_DEPOT", "L'achat d'un véhicule exige une tuile de dépôt.");
	}
	if (!IsTileOwner(tile, company)) {
		return FailWith(reply, "WRONG_OWNER", "Ce dépôt appartient à une autre entreprise.");
	}

	const VehicleType type = GetDepotVehicleType(tile);
	std::string model;
	JsonGetString(root.Find("model"), model);
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

	/* Valider toutes les cibles avant d'insérer le premier ordre évite une
	 * tournée partielle. Les industries ne sont pas des destinations
	 * directes : il faut passer par une gare. */
	for (const JsonValue &item : orders->items) {
		std::string kind;
		int target = 0;
		if (!JsonGetString(item.Find("kind"), kind) || !JsonGetInt(item.Find("target"), target) || target < 0) {
			return FailWith(reply, "INVALID_PARAMETER", "Chaque ordre exige « kind » et « target » (entier ≥ 0).");
		}
		kind = LowerAscii(kind);
		if (kind == "station" || kind == "gare") {
			if (!Station::IsValidID(StationID(static_cast<uint16_t>(target)))) {
				return FailWith(reply, "UNKNOWN_STATION", fmt::format("Gare {} inexistante.", target));
			}
		} else if (kind == "depot") {
			if (!Depot::IsValidID(DepotID(static_cast<uint16_t>(target)))) {
				return FailWith(reply, "UNKNOWN_DEPOT", fmt::format("Dépôt {} inexistant.", target));
			}
		} else if (kind == "industry" || kind == "industrie") {
			return FailWith(reply, "NOT_SUPPORTED",
					"Les ordres vers une industrie passent par une gare : utilisez « kind: station ».");
		} else {
			return FailWith(reply, "INVALID_PARAMETER", fmt::format("Type d'ordre inconnu « {} ».", kind));
		}
	}

	VehicleOrderID position = vehicle->GetNumManualOrders();
	int inserted = 0;
	for (const JsonValue &item : orders->items) {
		std::string kind;
		int target = 0;
		JsonGetString(item.Find("kind"), kind);
		JsonGetInt(item.Find("target"), target);
		kind = LowerAscii(kind);

		Order order;
		if (kind == "station" || kind == "gare") {
			order.MakeGoToStation(StationID(static_cast<uint16_t>(target)));
			/* Les véhicules routiers n'acceptent que FarEnd : la valeur par
			 * défaut (NearEnd) fait échouer CmdInsertOrder. */
			order.SetStopLocation(OrderStopLocation::FarEnd);
		} else {
			OrderDepotTypeFlags depot_flags;
			depot_flags.Set(OrderDepotTypeFlag::PartOfOrders);
			order.MakeGoToDepot(DepotID(static_cast<uint16_t>(target)), depot_flags,
					OrderNonStopFlags{}, OrderDepotActionFlags{});
		}

		CommandCost result = RunCompanyCommand<CMD_INSERT_ORDER>(
				company, vehicle->tile, false, vehicle->index, position, order);
		if (result.Failed()) {
			reply.orders = inserted;
			return FailFromCommand(reply, result, "COMMAND_FAILED", "Ajout d'ordre refusé.");
		}
		position++;
		inserted++;
	}

	reply.orders = inserted;
	return Succeed(reply, fmt::format("{} ordre(s) ajouté(s).", inserted));
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
	if (action == "refit") {
		return FailWith(reply, "NOT_SUPPORTED", "Le rééquipement (refit) n'est pas supporté par le pont (#11).");
	}
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
		FailWith(reply, "UNKNOWN_COMMAND", "Le champ « type » doit être une chaîne (build, vehicle).");
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
 * difficulté, IA, villes, industries, nom) et les avertissements de partie,
 * que le .sav OpenTTD ne contient pas.
 */
static constexpr uint32_t OTTD_SAVE_MAGIC = 0x5333544F; ///< "OT3S" en little-endian.
static constexpr uint16_t OTTD_SAVE_VERSION = 1;
static constexpr uint16_t OTTD_SAVE_HEADER_SIZE = 32;

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
}

/**
 * Relit les métadonnées du pont.
 * @return true si le bloc est cohérent et entièrement consommé.
 */
bool ParseSaveMetadata(const uint8_t *data, size_t size, GameSetupConfig &config, std::vector<std::string> &warnings)
{
	config = GameSetupConfig{};
	warnings.clear();
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
void ApplyLoadedState(const GameSetupConfig &config, const std::vector<std::string> &warnings)
{
	_ottd_active_config = config;
	_ottd_warnings = warnings;
	_ottd_json_sequence = 0;
	_ottd_map_sequence = 0;
	_ottd_last_command_json = "{}";
	_ottd_last_command_status = OTTD_CMD_OK;
	_ottd_save_cache_valid = false;
	_ottd_error.clear();

	/* Comme `OnStartGame` : le .sav ne contient pas l'entreprise locale. */
	_current_company = _local_company;
	const CompanyID company = GetFirstPlayableCompanyID();
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

	/* Le pilote web n'a pas de GUI : OpenTTD se comporte comme un serveur
	 * dédié et ne crée aucune entreprise. On en crée une pour que la partie
	 * soit jouable et pour que le HUD ait quelque chose à afficher. */
	if (Company::GetNumItems() == 0) {
		DoStartupNewCompany(false, CompanyID::Begin());
		SetLocalCompany(CompanyID::Begin());
	}

	_ottd_active_config = config;

	int result = 0;
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
	if (version != OTTD_SAVE_VERSION) {
		SetError(fmt::format("version de sauvegarde {} non supportée (attendu {})", version, OTTD_SAVE_VERSION));
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
	if (!ParseSaveMetadata(metadata, metadata_size, config, warnings)) {
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

	_ottd_in_game = false;
	const SaveOrLoadResult result = LoadPayload(payload, payload_size);
	if (result == SL_OK) {
		ApplyLoadedState(config, warnings);
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
		ApplyLoadedState(previous_config, previous_warnings);
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
		MAP_LAYER_SLOPE, MAP_LAYER_FLAGS, MAP_LAYER_TRACK,
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

	const uint8_t snow_line = GetSnowLine();

	for (uint32_t index = 0; index < tiles; index++) {
		Tile tile{TileIndex(index)};

		kind[index] = TileKind(tile);
		height_map[index] = static_cast<uint8_t>(TileHeight(tile));
		owner[index] = TileOwnerByte(tile);
		slope[index] = static_cast<uint8_t>(GetTileSlope(tile));
		flags[index] = TileFlags(tile, snow_line);
		track[index] = tile.m8();
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
			"\"towns\":[],\"industries\":[],\"stations\":[],\"vehicles\":[],\"news\":[],\"events\":[]}";
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
