#!/usr/bin/env node
/**
 * Test du snapshot monde v1 du moteur OpenTT3D (issue #10).
 *
 * Vérifie :
 *  - le format binaire de `ottd_snapshot_map` (en-tête, répertoire, sections) ;
 *  - les tableaux carte (tailles, bornes des types/valeurs, présence d'eau et
 *    de terre) ;
 *  - la cohérence du JSON d'entités (`meta`, `economy`, entreprises, villes,
 *    industries, gares, véhicules) ;
 *  - le déterminisme : deux instances indépendantes produisent le même hash et
 *    les mêmes octets de carte ;
 *  - les temps de snapshot carte et JSON en 128×128 et 256×256.
 *
 * Usage : node engine/scripts/snapshot.mjs [--verbose]
 *
 * Prérequis : npm run engine:build (artefacts dans public/engine/).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(SCRIPT_DIR, '..');
const ARTIFACT_DIR = path.resolve(ENGINE_DIR, '..', 'public', 'engine');
const MODULE_PATH = path.join(ARTIFACT_DIR, 'opentt3d-engine.js');

const VERBOSE = process.argv.includes('--verbose');
const SEED = 7;
const TICKS = 500;
const ITERATIONS = 5;

/* Constantes du protocole (src/engine/protocol.ts). */
const PROTOCOL_VERSION = 1;
const TILE_KIND_COUNT = 19;
const COMPANY_NONE = 255;

const MAP_MAGIC = 0x314d544f; // "OTM1"
const MAP_VERSION = 1;
const MAP_HEADER_SIZE = 64;
const MAP_DIRECTORY_ENTRY_SIZE = 12;
const MAP_LAYER_COUNT = 6;
const MAP_DATA_OFFSET = MAP_HEADER_SIZE + MAP_LAYER_COUNT * MAP_DIRECTORY_ENTRY_SIZE;

const LAYER_IDS = { kind: 1, heightMap: 2, owner: 3, slope: 4, flags: 5, trackBits: 6 };
const TILE_FLAGS = {
  WATER: 1 << 0,
  SNOW: 1 << 1,
  DESERT: 1 << 2,
  RAINFOREST: 1 << 3,
  BRIDGE: 1 << 4,
  TUNNEL: 1 << 5,
  SIGNAL: 1 << 6,
  ELECTRIFIED: 1 << 7,
};
const ALL_FLAGS = Object.values(TILE_FLAGS).reduce((all, bit) => all | bit, 0);

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function loadFactory() {
  try {
    const mod = await import(MODULE_PATH);
    return mod.default ?? mod.createOpenTT3DEngine;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      fail(`artefacts absents : ${MODULE_PATH}\n   Lancez : npm run engine:build`);
    }
    throw error;
  }
}

const factory = await loadFactory();

async function createInstance(label) {
  const engine = await factory({
    locateFile: (file) => path.join(ARTIFACT_DIR, file),
    getPreloadedPackage: (name) => {
      const file = path.join(ARTIFACT_DIR, path.basename(name));
      const data = fs.readFileSync(file);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    },
    print: VERBOSE ? (line) => console.log(`[${label}] ${line}`) : () => {},
    printErr: (line) => {
      if (VERBOSE) console.error(`[${label}] ${line}`);
    },
  });

  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      crypto: globalThis.crypto,
      encodeURIComponent,
      location: { pathname: '/' },
    };
  }
  return engine;
}

function wrap(engine) {
  return {
    engine,
    boot: engine.cwrap('ottd_boot', 'number', []),
    newGame: engine.cwrap('ottd_new_game', 'number', ['number', 'number', 'number']),
    newGameEx: engine.cwrap('ottd_new_game_ex', 'number', ['number', 'number', 'number', 'string']),
    setGameConfig: engine.cwrap('ottd_set_game_config', 'number', ['string']),
    step: engine.cwrap('ottd_step', 'number', ['number']),
    lastError: engine.cwrap('ottd_last_error', 'string', []),
  };
}

function readError(api) {
  const message = api.lastError();
  return message && message.length > 0 ? message : '(aucune erreur exposée)';
}

function hashHex(engine) {
  const hash = engine._ottd_hash();
  return `0x${BigInt.asUintN(64, BigInt(hash)).toString(16).padStart(16, '0')}`;
}

/** Lecteur JSON avec buffer réutilisé et croissance automatique. */
function makeJsonReader(engine) {
  let capacity = engine._ottd_snapshot_json(0, 0);
  assert(capacity > 0, `ottd_snapshot_json a retourné ${capacity}`);
  let pointer = engine._malloc(capacity);

  return {
    get capacity() {
      return capacity;
    },
    read() {
      let required = engine._ottd_snapshot_json(pointer, capacity);
      if (required > capacity) {
        // Le JSON a grossi (noms résolus, chiffres plus longs…) : on
        // réalloue à la taille requise, puis on relit.
        engine._free(pointer);
        capacity = required;
        pointer = engine._malloc(capacity);
        required = engine._ottd_snapshot_json(pointer, capacity);
        assert(
          required <= capacity,
          `ottd_snapshot_json a encore besoin de ${required} octets (capacité ${capacity})`,
        );
      }
      return JSON.parse(engine.UTF8ToString(pointer));
    },
    free() {
      engine._free(pointer);
    },
  };
}

/** Lecteur binaire avec buffer réutilisé (une seule allocation). */
function makeMapReader(engine) {
  const required = engine._ottd_snapshot_map(0, 0);
  assert(required > 0, `ottd_snapshot_map a retourné ${required}`);
  const pointer = engine._malloc(required);

  return {
    capacity: required,
    read() {
      const written = engine._ottd_snapshot_map(pointer, required);
      assert(
        written === required,
        `ottd_snapshot_map a écrit ${written} octets au lieu de ${required}`,
      );
      return parseMapSnapshot(engine, pointer, written);
    },
    free() {
      engine._free(pointer);
    },
  };
}

/**
 * Décode l'en-tête et le répertoire du snapshot binaire. Les vues renvoyées
 * pointent dans le heap WASM et sont invalidées par le prochain `read()`.
 */
function parseMapSnapshot(engine, pointer, size) {
  const bytes = engine.HEAPU8.subarray(pointer, pointer + size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const header = {
    magic: view.getUint32(0, true),
    version: view.getUint16(4, true),
    headerSize: view.getUint16(6, true),
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    tileCount: view.getUint32(16, true),
    layerCount: view.getUint32(20, true),
    sequence: view.getUint32(24, true),
    tick: view.getUint32(28, true),
    flags: view.getUint32(32, true),
    dataOffset: view.getUint32(36, true),
    directoryOffset: view.getUint32(40, true),
    bytesPerLayer: view.getUint32(44, true),
  };

  const layers = {};
  for (let i = 0; i < MAP_LAYER_COUNT; i++) {
    const entry = MAP_HEADER_SIZE + i * MAP_DIRECTORY_ENTRY_SIZE;
    const id = view.getUint8(entry);
    const elemSize = view.getUint8(entry + 1);
    const offset = view.getUint32(entry + 4, true);
    const length = view.getUint32(entry + 8, true);
    assert(elemSize === 1, `section ${id} : elem_size ${elemSize} ≠ 1`);
    assert(
      offset + length <= size,
      `section ${id} dépasse le buffer (${offset}+${length} > ${size})`,
    );
    const name = Object.keys(LAYER_IDS).find((key) => LAYER_IDS[key] === id);
    assert(name, `section inconnue : ${id}`);
    layers[name] = bytes.subarray(offset, offset + length);
  }

  return { header, layers, size };
}

/** FNV-1a 32 bits : empreinte rapide des octets carte. */
function digest(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function timeMs(fn) {
  const start = globalThis.performance.now();
  fn();
  return globalThis.performance.now() - start;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

/** Vérifie le format binaire et les tableaux carte. */
function validateMap(snapshot, label, expectedSize) {
  const { header, layers, size } = snapshot;

  assert(header.magic === MAP_MAGIC, `${label} : magic 0x${header.magic.toString(16)}`);
  assert(header.version === MAP_VERSION, `${label} : version ${header.version}`);
  assert(header.headerSize === MAP_HEADER_SIZE, `${label} : headerSize ${header.headerSize}`);
  assert(header.layerCount === MAP_LAYER_COUNT, `${label} : layerCount ${header.layerCount}`);
  assert(header.width === expectedSize, `${label} : width ${header.width}`);
  assert(header.height === expectedSize, `${label} : height ${header.height}`);
  assert(
    header.tileCount === header.width * header.height,
    `${label} : tileCount ${header.tileCount}`,
  );
  assert(header.dataOffset === MAP_DATA_OFFSET, `${label} : dataOffset ${header.dataOffset}`);
  assert(
    header.directoryOffset === MAP_HEADER_SIZE,
    `${label} : directoryOffset ${header.directoryOffset}`,
  );
  assert(header.bytesPerLayer === header.tileCount, `${label} : bytesPerLayer`);
  assert((header.flags & 1) === 1, `${label} : snapshot non marqué complet`);
  assert(
    size === MAP_DATA_OFFSET + MAP_LAYER_COUNT * header.tileCount,
    `${label} : taille ${size} incohérente`,
  );

  const count = header.tileCount;
  for (const [name, layer] of Object.entries(layers)) {
    assert(layer.length === count, `${label} : section ${name} = ${layer.length} ≠ ${count}`);
  }

  const kindCounts = new Map();
  let maxHeight = 0;
  let waterTiles = 0;
  let landTiles = 0;
  let badOwner = 0;
  let maxSlope = 0;
  let badFlags = 0;

  for (let i = 0; i < count; i++) {
    const kind = layers.kind[i];
    assert(kind < TILE_KIND_COUNT, `${label} : kind ${kind} hors enum à l'index ${i}`);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);

    if (layers.heightMap[i] > maxHeight) maxHeight = layers.heightMap[i];
    if (layers.slope[i] > maxSlope) maxSlope = layers.slope[i];
    if ((layers.flags[i] & ~ALL_FLAGS) !== 0) badFlags++;

    const owner = layers.owner[i];
    if (owner !== COMPANY_NONE && owner >= 15) badOwner++;

    if (layers.flags[i] & TILE_FLAGS.WATER) waterTiles++;
    else landTiles++;
  }

  assert(maxHeight <= 15, `${label} : hauteur max ${maxHeight} > 15`);
  assert(maxSlope <= 63, `${label} : pente max ${maxSlope} > 63`);
  assert(badOwner === 0, `${label} : ${badOwner} propriétaires hors entreprise/255`);
  assert(badFlags === 0, `${label} : ${badFlags} drapeaux avec des bits inconnus`);
  assert(waterTiles > 0, `${label} : aucune tuile d'eau`);
  assert(landTiles > 0, `${label} : aucune tuile de terre`);

  return {
    waterTiles,
    landTiles,
    maxHeight,
    maxSlope,
    kindCounts,
    sequence: header.sequence,
    tick: header.tick,
  };
}

/** Vérifie la cohérence du JSON d'entités. */
function validateJson(state, label, size) {
  const width = size;
  const height = size;
  assert(state.meta.protocol === PROTOCOL_VERSION, `${label} : protocole ${state.meta.protocol}`);
  assert(typeof state.meta.hash === 'string', `${label} : hash manquant`);
  assert(state.meta.sequence > 0, `${label} : séquence ${state.meta.sequence}`);

  const { economy } = state;
  assert(economy, `${label} : économie absente`);
  assert(economy.year >= 0, `${label} : année ${economy.year}`);
  assert(economy.month >= 0 && economy.month <= 11, `${label} : mois ${economy.month}`);
  assert(economy.day >= 1 && economy.day <= 31, `${label} : jour ${economy.day}`);
  assert(
    economy.dayFraction >= 0 && economy.dayFraction < 74,
    `${label} : fraction de jour ${economy.dayFraction}`,
  );
  assert(economy.speed >= 0, `${label} : vitesse ${economy.speed}`);
  assert(typeof economy.paused === 'boolean', `${label} : pause non booléenne`);

  assert(
    state.map && state.map.width === width,
    `${label} : map.width ${state.map?.width} ≠ ${width}`,
  );
  assert(state.map.height === height, `${label} : map.height ${state.map.height} ≠ ${height}`);
  assert(state.map.encoding === 'binary', `${label} : encodage carte`);
  assert(
    state.map.bytes === MAP_DATA_OFFSET + MAP_LAYER_COUNT * width * height,
    `${label} : map.bytes ${state.map.bytes}`,
  );

  const arrays = ['companies', 'towns', 'industries', 'stations', 'depots', 'vehicles'];
  const companyIds = new Set(state.companies.map((company) => company.id));

  for (const key of arrays) {
    assert(Array.isArray(state[key]), `${label} : ${key} n'est pas un tableau`);
    assert(
      state.counts[key] === state[key].length,
      `${label} : counts.${key}=${state.counts[key]} ≠ ${state[key].length} entrées`,
    );
  }

  assert(state.companies.length >= 1, `${label} : aucune entreprise`);
  for (const company of state.companies) {
    assert(Number.isInteger(company.id) && company.id >= 0, `${label} : id entreprise`);
    assert(
      typeof company.name === 'string' && company.name.length > 0,
      `${label} : nom entreprise`,
    );
    assert(company.colour >= 0 && company.colour <= 15, `${label} : couleur entreprise`);
    assert(typeof company.isAI === 'boolean', `${label} : isAI`);
    assert(typeof company.isLocal === 'boolean', `${label} : isLocal`);
    assert(
      state.companies.filter((c) => c.isLocal).length <= 1,
      `${label} : plusieurs entreprises locales`,
    );
  }

  const checkPoint = (x, y, what) => {
    assert(Number.isFinite(x) && Number.isFinite(y), `${label} : ${what} coordonnées non finies`);
    assert(
      x >= 0 && x <= width && y >= 0 && y <= height,
      `${label} : ${what} hors carte (${x}, ${y})`,
    );
  };

  for (const town of state.towns) {
    assert(Number.isInteger(town.id), `${label} : id ville`);
    assert(typeof town.name === 'string' && town.name.length > 0, `${label} : nom ville`);
    checkPoint(town.x, town.y, `ville ${town.id}`);
    assert(town.population >= 0, `${label} : population ville`);
    assert(town.buildings >= 0, `${label} : bâtiments ville`);
  }

  for (const industry of state.industries) {
    assert(Number.isInteger(industry.id), `${label} : id industrie`);
    assert(
      typeof industry.kind === 'string' && industry.kind.length > 0,
      `${label} : type industrie`,
    );
    checkPoint(industry.x, industry.y, `industrie ${industry.id}`);
    assert(industry.width > 0 && industry.height > 0, `${label} : emprise industrie`);
    assert(Array.isArray(industry.stocks), `${label} : stocks industrie`);
  }

  for (const station of state.stations) {
    assert(Number.isInteger(station.id), `${label} : id gare`);
    assert(
      station.company === COMPANY_NONE || companyIds.has(station.company),
      `${label} : gare ${station.id} d'une entreprise inconnue (${station.company})`,
    );
    assert(
      ['train', 'road', 'ship', 'airport', 'buoy'].includes(station.kind),
      `${label} : type de gare ${station.kind}`,
    );
    checkPoint(station.x, station.y, `gare ${station.id}`);
    assert(station.width > 0 && station.height > 0, `${label} : emprise gare`);
  }

  const depotIds = new Set();
  for (const depot of state.depots) {
    assert(Number.isInteger(depot.id) && depot.id >= 0, `${label} : id dépôt`);
    assert(!depotIds.has(depot.id), `${label} : id dépôt ${depot.id} dupliqué`);
    depotIds.add(depot.id);
    assert(companyIds.has(depot.company), `${label} : dépôt ${depot.id} orphelin`);
    assert(['road', 'rail'].includes(depot.kind), `${label} : type de dépôt ${depot.kind}`);
    checkPoint(depot.x, depot.y, `dépôt ${depot.id}`);
    assert(
      Number.isInteger(depot.x) && Number.isInteger(depot.y),
      `${label} : coordonnées non entières du dépôt ${depot.id}`,
    );
    assert(
      Number.isInteger(depot.direction) && depot.direction >= 0 && depot.direction <= 3,
      `${label} : direction du dépôt ${depot.id} (${depot.direction})`,
    );
    assert(depot.width === 1 && depot.height === 1, `${label} : emprise du dépôt ${depot.id}`);
  }

  for (const vehicle of state.vehicles) {
    assert(Number.isInteger(vehicle.id), `${label} : id véhicule`);
    assert(
      ['train', 'road', 'ship', 'aircraft'].includes(vehicle.kind),
      `${label} : type de véhicule ${vehicle.kind}`,
    );
    assert(companyIds.has(vehicle.company), `${label} : véhicule ${vehicle.id} orphelin`);
    checkPoint(vehicle.x, vehicle.y, `véhicule ${vehicle.id}`);
    assert(vehicle.z >= 0, `${label} : z véhicule négatif`);
    assert(
      vehicle.direction >= 0 && vehicle.direction <= 255,
      `${label} : direction ${vehicle.direction}`,
    );
    assert(vehicle.speed >= 0, `${label} : vitesse négative`);
    assert(vehicle.status >= 0 && vehicle.status <= 4, `${label} : statut ${vehicle.status}`);
    if (vehicle.cargo) {
      assert(typeof vehicle.cargo.type === 'string', `${label} : type de cargaison`);
      assert(vehicle.cargo.amount >= 0, `${label} : quantité de cargaison`);
      assert(
        vehicle.cargo.amount <= vehicle.cargo.capacity,
        `${label} : cargaison ${vehicle.cargo.amount} > capacité ${vehicle.cargo.capacity}`,
      );
    }
    assert(Array.isArray(vehicle.orderTargets), `${label} : orderTargets`);
  }

  assert(Array.isArray(state.news), `${label} : news`);
  assert(Array.isArray(state.events), `${label} : events`);
}

function waitForMap(api, reader, width, height) {
  for (let i = 0; i < 2000; i++) {
    const state = reader.read();
    if (state.map.width === width && state.map.height === height) return state;
    if (api.step(1) !== 1) fail(`la pompe s'est arrêtée : ${readError(api)}`);
  }
  return fail(`la carte ${width}×${height} n'est jamais devenue disponible`);
}

async function bootGame(label, size) {
  const api = wrap(await createInstance(label));
  if (api.boot() !== 0) fail(`ottd_boot() : ${readError(api)}`);
  if (api.newGame(SEED, size, size) !== 0) fail(`ottd_new_game() : ${readError(api)}`);

  const json = makeJsonReader(api.engine);
  const initial = waitForMap(api, json, size, size);
  if (api.step(TICKS) !== TICKS) fail(`ottd_step(${TICKS}) : ${readError(api)}`);

  return { api, json, map: makeMapReader(api.engine), initial };
}

/** Démarre une partie configurée via `ottd_new_game_ex` (issue #60). */
async function bootConfigured(label, seed, size, config, ticks) {
  const api = wrap(await createInstance(label));
  if (api.boot() !== 0) fail(`ottd_boot() : ${readError(api)}`);
  const created = api.newGameEx(seed, size, size, JSON.stringify(config));
  if (created !== 0) fail(`ottd_new_game_ex() = ${created} : ${readError(api)}`);

  const json = makeJsonReader(api.engine);
  const initial = waitForMap(api, json, size, size);
  if (ticks > 0 && api.step(ticks) !== ticks) {
    fail(`ottd_step(${ticks}) : ${readError(api)}`);
  }

  return { api, json, map: makeMapReader(api.engine), initial };
}

/** Mesure les deux snapshots sur une instance déjà initialisée. */
function collect(game) {
  const { json, map } = game;
  const mapTimes = [];
  const jsonTimes = [];
  let lastJson = null;
  let lastMap = null;

  // Pré-chauffage : stabilise la capacité des buffers et les noms cachés
  // avant de mesurer.
  map.read();
  json.read();

  for (let i = 0; i < ITERATIONS; i++) {
    mapTimes.push(timeMs(() => (lastMap = map.read())));
    jsonTimes.push(timeMs(() => (lastJson = json.read())));
  }

  return {
    state: lastJson,
    map: lastMap,
    jsonCapacity: json.capacity,
    mapTimes,
    jsonTimes,
    mapDigest: digest(lastMap.layers.kind),
  };
}

function printSummary(label, size, result) {
  const { mapTimes, jsonTimes, map } = result;
  const mapMedian = median(mapTimes);
  const jsonMedian = median(jsonTimes);

  log(
    `[${label}] ${size}×${size} : carte ${formatMs(Math.min(...mapTimes))} min / ` +
      `${formatMs(mapMedian)} médiane (${map.size} octets, ${map.header.tileCount} tuiles)`,
  );
  log(
    `[${label}] ${size}×${size} : JSON ${formatMs(Math.min(...jsonTimes))} min / ` +
      `${formatMs(jsonMedian)} médiane (${result.jsonCapacity} octets alloués)`,
  );

  return { mapMedian, jsonMedian };
}

function truncate(state, maxItems = 1) {
  const copy = { ...state };
  for (const key of ['companies', 'towns', 'industries', 'stations', 'vehicles']) {
    copy[key] = state[key].slice(0, maxItems);
  }
  return copy;
}

log(`Module   : ${MODULE_PATH}`);
log(`Scénario : seed ${SEED}, ${TICKS} ticks, ${ITERATIONS} itérations de mesure\n`);

/* --- Instance de référence 256×256 --------------------------------------- */
const reference = await bootGame('ref-256', 256);
const referenceResult = collect(reference);
const referenceMapStats = validateMap(referenceResult.map, 'ref-256', 256);
validateJson(referenceResult.state, 'ref-256', 256);
assert(
  referenceResult.state.meta.tick === referenceResult.map.header.tick,
  `ref-256 : tick JSON ${referenceResult.state.meta.tick} ≠ tick carte ${referenceResult.map.header.tick}`,
);
const referenceTiming = printSummary('ref-256', 256, referenceResult);
const referenceHash = hashHex(reference.api.engine);

/* --- Seconde instance : déterminisme ------------------------------------- */
const replay = await bootGame('replay-256', 256);
const replayResult = collect(replay);
validateMap(replayResult.map, 'replay-256', 256);
const replayHash = hashHex(replay.api.engine);

assert(referenceHash === replayHash, `déterminisme rompu : ${referenceHash} ≠ ${replayHash}`);
assert(
  referenceResult.mapDigest === replayResult.mapDigest,
  `carte différente : ${referenceResult.mapDigest} ≠ ${replayResult.mapDigest}`,
);
log(`\n✅ Déterminisme : hash ${referenceHash} et carte ${referenceResult.mapDigest} identiques.`);

/* --- Mesures 128×128 ------------------------------------------------------ */
const small = await bootGame('bench-128', 128);
const smallResult = collect(small);
validateMap(smallResult.map, 'bench-128', 128);
validateJson(smallResult.state, 'bench-128', 128);
const smallTiming = printSummary('bench-128', 128, smallResult);

/* --- Objectif < 10 ms ----------------------------------------------------- */
for (const [label, timing] of [
  ['128×128', smallTiming],
  ['256×256', referenceTiming],
]) {
  assert(timing.mapMedian < 10, `${label} : snapshot carte ${timing.mapMedian} ms ≥ 10 ms`);
  assert(timing.jsonMedian < 10, `${label} : snapshot JSON ${timing.jsonMedian} ms ≥ 10 ms`);
}
log('\n✅ Objectif < 10 ms tenu pour la carte et le JSON (128×128 et 256×256).');

/* --- Issue #60 : configuration, IA et erreurs ---------------------------- */
const SETUP_TICKS = 5000;
/* Graine du scénario #60 : identique au smoke 128×128 (seed 42) pour que le
 * comportement sans configuration reste comparable. */
const AI_SEED = 42;
const AI_CONFIG = {
  climate: 'subarctic',
  start_year: 2000,
  difficulty: 2,
  ai_companies: 2,
  towns: 12,
  industries: 16,
  map_size: 128,
  game_name: 'scénario #60',
};

log(
  `\n#60 : ${AI_CONFIG.ai_companies} IA, ${AI_CONFIG.climate}, ${AI_CONFIG.start_year}, ` +
    `${AI_CONFIG.towns} villes, ${AI_CONFIG.industries} industries, ` +
    `${SETUP_TICKS} ticks sur 128×128`,
);

const configured = await bootConfigured('cfg-128', AI_SEED, 128, AI_CONFIG, SETUP_TICKS);
const configuredResult = collect(configured);
validateMap(configuredResult.map, 'cfg-128', 128);
validateJson(configuredResult.state, 'cfg-128', 128);

const configuredState = configuredResult.state;
const aiCompanies = configuredState.companies.filter((company) => company.isAI);
assert(
  configuredState.counts.companies === 3,
  `cfg-128 : ${configuredState.counts.companies} entreprises au lieu de 3 (1 locale + 2 IA)`,
);
assert(aiCompanies.length === 2, `cfg-128 : ${aiCompanies.length} entreprise(s) IA au lieu de 2`);
assert(
  configuredState.companies.filter((company) => company.isLocal).length === 1,
  'cfg-128 : entreprise locale absente ou multiple',
);
assert(
  configuredState.counts.vehicles > 0,
  'cfg-128 : aucune entreprise IA n’a de véhicule après 5 000 ticks',
);
assert(
  configuredState.counts.stations > 0,
  'cfg-128 : aucune gare construite par les IA après 5 000 ticks',
);
assert(
  aiCompanies.every((company) => company.vehicles > 0),
  'cfg-128 : une entreprise IA n’a aucun véhicule',
);
assert(
  aiCompanies.some((company) => company.stations > 0),
  'cfg-128 : aucune entreprise IA n’a de gare',
);

/* Configuration effectivement appliquée, telle que renvoyée par le moteur. */
assert(configuredState.config.climate === AI_CONFIG.climate, 'cfg-128 : climat non appliqué');
assert(configuredState.config.startYear === AI_CONFIG.start_year, 'cfg-128 : année non appliquée');
assert(
  configuredState.config.difficulty === AI_CONFIG.difficulty,
  'cfg-128 : difficulté non appliquée',
);
assert(
  configuredState.config.aiCompanies === AI_CONFIG.ai_companies,
  'cfg-128 : IA non appliquées',
);
assert(configuredState.config.towns === AI_CONFIG.towns, 'cfg-128 : nombre de villes non appliqué');
assert(
  configuredState.config.industries === AI_CONFIG.industries,
  'cfg-128 : nombre d’industries non appliqué',
);
assert(configuredState.config.mapSize === 128, 'cfg-128 : mapSize incohérent');
assert(configuredState.config.seed === AI_SEED, 'cfg-128 : graine incohérente');
assert(configuredState.config.gameName === AI_CONFIG.game_name, 'cfg-128 : nom de partie perdu');
assert(
  configuredState.economy.year === AI_CONFIG.start_year,
  `cfg-128 : année simulée ${configuredState.economy.year} ≠ ${AI_CONFIG.start_year}`,
);
assert(
  configuredState.counts.towns === AI_CONFIG.towns,
  `cfg-128 : ${configuredState.counts.towns} villes au lieu de ${AI_CONFIG.towns}`,
);
/* Le nombre d'industries demandé est une cible : la génération peut en
 * placer une de moins si le terrain manque (15/16 observé en subarctique). */
assert(
  configuredState.counts.industries > 0 &&
    configuredState.counts.industries <= AI_CONFIG.industries,
  `cfg-128 : ${configuredState.counts.industries} industries pour ${AI_CONFIG.industries} demandées`,
);

const configuredHash = hashHex(configured.api.engine);
log(
  `[cfg-128] ${configuredState.counts.vehicles} véhicules, ` +
    `${configuredState.counts.stations} gares, ` +
    `${configuredState.counts.towns} villes, ${configuredState.counts.industries} industries`,
);
log(
  `[cfg-128] entreprises : ${configuredState.companies
    .map(
      (company) =>
        `${company.name}${company.isAI ? ' (IA)' : ''} ` +
        `v=${company.vehicles} g=${company.stations}`,
    )
    .join(' | ')}`,
);

/* --- Déterminisme à configuration égale ---------------------------------- */
const configuredReplay = await bootConfigured(
  'cfg-128-replay',
  AI_SEED,
  128,
  AI_CONFIG,
  SETUP_TICKS,
);
const configuredReplayResult = collect(configuredReplay);
validateJson(configuredReplayResult.state, 'cfg-128-replay', 128);
const configuredReplayHash = hashHex(configuredReplay.api.engine);

assert(
  configuredHash === configuredReplayHash,
  `#60 : déterminisme rompu avec configuration (${configuredHash} ≠ ${configuredReplayHash})`,
);
assert(
  configuredResult.mapDigest === configuredReplayResult.mapDigest,
  `#60 : carte différente pour une configuration identique`,
);
assert(
  configuredReplayResult.state.counts.vehicles === configuredState.counts.vehicles &&
    configuredReplayResult.state.counts.stations === configuredState.counts.stations,
  '#60 : compteurs d’entités différents pour une configuration identique',
);
log(`\n✅ #60 : configuration reproductible (hash ${configuredHash}).`);

/* --- Deux configurations produisent des mondes différents ---------------- */
const OTHER_CONFIG = {
  climate: 'toyland',
  start_year: 1950,
  difficulty: 0,
  ai_companies: 0,
  map_size: 128,
};
const other = await bootConfigured('cfg-alt', AI_SEED, 128, OTHER_CONFIG, SETUP_TICKS);
const otherResult = collect(other);
validateJson(otherResult.state, 'cfg-alt', 128);
const otherHash = hashHex(other.api.engine);

assert(otherHash !== configuredHash, '#60 : deux configurations distinctes donnent le même hash');
assert(
  otherResult.mapDigest !== configuredResult.mapDigest,
  '#60 : deux configurations distinctes donnent la même carte',
);
assert(otherResult.state.counts.companies === 1, '#60 : IA créées alors que ai_companies=0');
assert(otherResult.state.counts.vehicles === 0, '#60 : véhicules sans IA');
assert(otherResult.state.config.climate === 'toyland', '#60 : climat toyland non appliqué');
log(`✅ #60 : configuration alternative (toyland, 1950, 0 IA) → hash ${otherHash}.`);

/* --- Validation stricte : erreur sans crash, module réutilisable ---------- */
const invalid = wrap(await createInstance('cfg-invalid'));
if (invalid.boot() !== 0) fail(`ottd_boot() : ${readError(invalid)}`);

const expectError = (code, contains, what) => {
  assert(code !== 0, `${what} : configuration invalide acceptée (code 0)`);
  const message = invalid.lastError();
  assert(
    typeof message === 'string' && message.includes(contains),
    `${what} : message « ${message} » sans « ${contains} »`,
  );
};

expectError(invalid.setGameConfig('{"climate":"lunaire"}'), 'climat inconnu', 'climat');
expectError(invalid.setGameConfig('{"champ_inconnu":1}'), 'champ inconnu', 'champ inconnu');
expectError(invalid.setGameConfig('{"ai_companies":"deux"}'), 'entier', 'type IA');
expectError(invalid.setGameConfig('{'), 'incomplet', 'JSON tronqué');
expectError(invalid.newGameEx(AI_SEED, 128, 128, '{"ai_companies":99}'), 'IA 99', 'IA hors bornes');
expectError(invalid.newGameEx(AI_SEED, 128, 128, '{"map_size":256}'), 'incompatible', 'taille');

/* Aucune de ces erreurs ne doit avoir démarré de partie ni cassé le module. */
const stillAlive = invalid.newGameEx(AI_SEED, 128, 128, '{"ai_companies":0}');
assert(stillAlive === 0, `#60 : partie valide refusée après une erreur (${readError(invalid)})`);
const invalidJson = makeJsonReader(invalid.engine);
waitForMap(invalid, invalidJson, 128, 128);
invalid.step(10);
const recovered = invalidJson.read();
assert(recovered.counts.companies === 1, '#60 : partie de secours invalide');
assert(recovered.config.startYear === 1950, '#60 : défauts non restaurés après erreur');

/* `ottd_set_game_config` + `ottd_new_game` : API compatible. */
assert(invalid.setGameConfig('{"start_year":2010}') === 0, '#60 : set_game_config valide refusé');
assert(
  invalid.newGame(SEED, 128, 128) === 0,
  `#60 : new_game après set_game_config : ${readError(invalid)}`,
);
waitForMap(invalid, invalidJson, 128, 128);
const afterSet = invalidJson.read();
assert(afterSet.config.startYear === 2010, '#60 : configuration en attente non appliquée');
assert(afterSet.counts.companies === 1, '#60 : IA inattendues via new_game');

invalidJson.free();
invalid.engine._ottd_shutdown();
log('✅ #60 : configurations invalides rejetées, module toujours utilisable.');

/* --- Aperçu JSON ---------------------------------------------------------- */
log('\nExtrait JSON (tableaux tronqués à 1 élément) :');
log(JSON.stringify(truncate(referenceResult.state), null, 2));

log(
  `\n[ref-256] kind : ${[...referenceMapStats.kindCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([kind, count]) => `${kind}:${count}`)
    .join(' ')}`,
);
log(
  `[ref-256] eau=${referenceMapStats.waterTiles} terre=${referenceMapStats.landTiles} ` +
    `hauteur max=${referenceMapStats.maxHeight} pente max=${referenceMapStats.maxSlope}`,
);

for (const game of [reference, replay, small, configured, configuredReplay, other]) {
  game.map.free();
  game.json.free();
  game.api.engine._ottd_shutdown();
}
log('\n✅ ottd_shutdown() OK');
