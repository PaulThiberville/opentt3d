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
 * Licence : GPL v2 (comme OpenTTD).
 */

#include "stdafx.h"

#include "ai/ai_info.hpp"
#include "cargotype.h"
#include "clear_map.h"
#include "company_base.h"
#include "company_func.h"
#include "company_type.h"
#include "core/random_func.hpp"
#include "debug.h"
#include "elrail_func.h"
#include "gfx_func.h"
#include "genworld.h"
#include "industry.h"
#include "industrytype.h"
#include "landscape.h"
#include "landscape_type.h"
#include "map_func.h"
#include "openttd.h"
#include "order_base.h"
#include "rail_map.h"
#include "settings_type.h"
#include "station_base.h"
#include "station_map.h"
#include "station_type.h"
#include "strings_func.h"
#include "tile_map.h"
#include "timer/timer_game_calendar.h"
#include "timer/timer_game_tick.h"
#include "town.h"
#include "tunnelbridge_map.h"
#include "vehicle_base.h"
#include "vehicle_type.h"
#include "water_map.h"
#include "window_func.h"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <emscripten.h>
#include <optional>
#include <string_view>
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

/** Compteurs de séquence indépendants pour les deux formats de snapshot. */
uint32_t _ottd_json_sequence = 0;
uint32_t _ottd_map_sequence = 0;

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
}

} // extern "C"
