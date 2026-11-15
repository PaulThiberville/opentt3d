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

#include "company_base.h"
#include "company_func.h"
#include "core/random_func.hpp"
#include "debug.h"
#include "gfx_func.h"
#include "genworld.h"
#include "industry.h"
#include "map_func.h"
#include "openttd.h"
#include "settings_type.h"
#include "station_base.h"
#include "tile_map.h"
#include "timer/timer_game_calendar.h"
#include "timer/timer_game_tick.h"
#include "town.h"
#include "vehicle_base.h"
#include "window_func.h"

#include <algorithm>
#include <emscripten.h>

#include "safeguards.h"

/* Déclarés dans openttd.cpp ; non exportés par un en-tête public. */
extern Company *DoStartupNewCompany(bool is_ai, CompanyID company);
extern void PostMainLoop();

namespace {

bool _ottd_booted = false;
bool _ottd_in_game = false;
std::string _ottd_error;

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

} // namespace

extern "C" {

/**
 * Initialise OpenTTD avec les pilotes null/web, puis rend la main.
 * @return 0 en cas de succès, code d'erreur sinon.
 */
EMSCRIPTEN_KEEPALIVE int ottd_boot(void)
{
	if (_ottd_booted) return 0;

	_ottd_error.clear();
	_exit_game = false;

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
 * @param seed graine de génération (uint32_t)
 * @param w largeur de la carte (puissance de 2, 64..4096)
 * @param h hauteur de la carte (puissance de 2, 64..4096)
 * @return 0 en cas de succès, code d'erreur sinon.
 */
EMSCRIPTEN_KEEPALIVE int ottd_new_game(uint32_t seed, uint32_t w, uint32_t h)
{
	if (!_ottd_booted) {
		SetError("ottd_boot() doit être appelé avant ottd_new_game()");
		return 1;
	}
	if (!IsPowerOfTwo(w) || !IsPowerOfTwo(h) || w < 64 || h < 64 || w > 4096 || h > 4096) {
		SetError(fmt::format("taille de carte invalide {}x{} (puissance de 2 attendue, 64..4096)", w, h));
		return 2;
	}

	_exit_game = false;
	_ottd_in_game = false;
	_ottd_error.clear();

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
	_pause_mode = {};
	_ottd_in_game = true;

	/* Un tick pour laisser les initialisations de partie se terminer. */
	PumpOneTick();
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

	_ottd_error.clear();
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
 * Écrit un snapshot JSON minimal dans `out`.
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

	int year = 0;
	int month = 0;
	int day = 0;
	if (_ottd_in_game) {
		const TimerGameCalendar::YearMonthDay ymd = TimerGameCalendar::ConvertDateToYMD(TimerGameCalendar::date);
		year = ymd.year.base();
		month = ymd.month;
		day = ymd.day;
	}

	const auto companies = static_cast<uint32_t>(Company::GetNumItems());
	const auto towns = static_cast<uint32_t>(Town::GetNumItems());
	const auto vehicles = CountCompanyVehicles();
	const auto stations = static_cast<uint32_t>(Station::GetNumItems());
	const auto industries = static_cast<uint32_t>(Industry::GetNumItems());

	const std::string json = fmt::format(
		"{{\"tick\":{},\"date\":{{\"year\":{},\"month\":{},\"day\":{}}},"
		"\"companies\":{},\"towns\":{},\"vehicles\":{},\"stations\":{},\"industries\":{},"
		"\"map\":{{\"width\":{},\"height\":{}}}}}",
		static_cast<uint32_t>(TimerGameTick::counter),
		year, month, day,
		companies, towns, vehicles, stations, industries,
		width, height);

	const int required = static_cast<int>(json.size()) + 1;
	if (out == nullptr || capacity < required) {
		if (out != nullptr && capacity > 0) out[0] = '\0';
		return required;
	}

	std::copy(json.begin(), json.end(), out);
	out[json.size()] = '\0';
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
	_exit_game = true;
	PostMainLoop();
	_ottd_in_game = false;
	_ottd_booted = false;
}

} // extern "C"
