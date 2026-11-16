#!/usr/bin/env node
/**
 * Test de la sauvegarde / du chargement mémoire du moteur OpenTT3D (issue #61).
 *
 * Scénarios :
 *  1. partie seed 42, 128×128, 200 ticks → hash H1 et sauvegarde ;
 *  2. instance neuve → `ottd_load` → hash H2 == H1, même tick, même snapshot ;
 *  3. 1 000 ticks sur les deux instances → hashes identiques ;
 *  4. commandes route/rail → sauvegarde → instance neuve → carte, gares,
 *     véhicules et trésorerie cohérents, puis 500 ticks identiques ;
 *  5. sauvegardes tronquée, corrompue, aléatoire, mauvaise version et `.sav`
 *     altéré refusées sans modifier l'état, module encore utilisable ;
 *  6. mesures de taille et de temps de sauvegarde/chargement.
 *
 * Usage : node engine/scripts/save.mjs [--verbose]
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
const SEED = 42;
const MAP_SIZE = 128;
const WARMUP_TICKS = 200;
const COMPARE_TICKS = 1_000;
const SETTLE_TICKS = 200;
const POST_LOAD_TICKS = 500;
const ROAD_LENGTH = 5;
const RAIL_LENGTH = 5;

const SAVE_MAGIC = 0x5333544f; // "OT3S"
const SAVE_VERSION = 2;
const SAVE_HEADER_SIZE = 32;
const TILE_KIND = { void: 0, grass: 2, water: 4, coast: 5, rail: 6, road: 7, station: 10 };
const TILE_FLAG_WATER = 1 << 0;
const MAP_MAGIC = 0x314d544f;
const MAP_HEADER_SIZE = 64;
const MAP_DIRECTORY_ENTRY_SIZE = 12;
const LAYER_IDS = {
  kind: 1,
  heightMap: 2,
  owner: 3,
  slope: 4,
  flags: 5,
  trackBits: 6,
  // #156 : signaux (version 2 du snapshot carte).
  signalData: 7,
};

/**
 * Hashes de référence du scénario de sauvegarde (seed 42, 128×128, 200 ticks)
 * et du scénario avec commandes (200 ticks après construction). Ils doivent
 * rester stables : toute modification du pont, du baseset ou d'OpenTTD les met
 * à jour consciemment (voir wiki, Moteur-WASM > Déterminisme).
 */
const REFERENCE_HASH_BASE = '0xd23f6a173accdd2d';
const REFERENCE_HASH_COMMANDS = '0xf54980769ea7b599';

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

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
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
const FORBIDDEN_OUTPUT = /Backed-up value was not restored/i;

function makeDiagnostics() {
  return { stdout: [], stderr: [] };
}

function assertNoBackupWarnings(lines, what) {
  const offenders = lines.filter((line) => FORBIDDEN_OUTPUT.test(line));
  assert(
    offenders.length === 0,
    `${what} : ${offenders.length} avertissement(s) « Backed-up value was not restored » (${offenders[0]})`,
  );
}

async function createInstance(label, diagnostics = makeDiagnostics()) {
  const engine = await factory({
    locateFile: (file) => path.join(ARTIFACT_DIR, file),
    getPreloadedPackage: (name) => {
      const file = path.join(ARTIFACT_DIR, path.basename(name));
      const data = fs.readFileSync(file);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    },
    print: (line) => {
      diagnostics.stdout.push(line);
      if (VERBOSE) console.log(`[${label}] ${line}`);
    },
    printErr: (line) => {
      diagnostics.stderr.push(line);
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
    step: engine.cwrap('ottd_step', 'number', ['number']),
    lastError: engine.cwrap('ottd_last_error', 'string', []),
    companyId: engine.cwrap('ottd_company_id', 'number', []),
    saveSize: engine.cwrap('ottd_save_size', 'number', []),
    save: engine.cwrap('ottd_save', 'number', ['number', 'number']),
    load: engine.cwrap('ottd_load', 'number', ['number', 'number']),
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
    read() {
      let required = engine._ottd_snapshot_json(pointer, capacity);
      if (required > capacity) {
        engine._free(pointer);
        capacity = required;
        pointer = engine._malloc(capacity);
        required = engine._ottd_snapshot_json(pointer, capacity);
        assert(required <= capacity, `ottd_snapshot_json exige ${required} octets`);
      }
      return JSON.parse(engine.UTF8ToString(pointer));
    },
    free() {
      engine._free(pointer);
    },
  };
}

/** Lecteur binaire : les couches sont copiées hors du heap WASM. */
function makeMapReader(engine) {
  const required = engine._ottd_snapshot_map(0, 0);
  assert(required > 0, `ottd_snapshot_map a retourné ${required}`);
  const pointer = engine._malloc(required);

  return {
    read() {
      const written = engine._ottd_snapshot_map(pointer, required);
      assert(written === required, `ottd_snapshot_map a écrit ${written} octets ≠ ${required}`);
      const bytes = engine.HEAPU8.subarray(pointer, pointer + written);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const header = {
        magic: view.getUint32(0, true),
        width: view.getUint32(8, true),
        height: view.getUint32(12, true),
        tileCount: view.getUint32(16, true),
        tick: view.getUint32(28, true),
      };
      assert(header.magic === MAP_MAGIC, `magic carte 0x${header.magic.toString(16)}`);

      const layerCount = view.getUint32(20, true);
      const layers = {};
      for (let i = 0; i < layerCount; i++) {
        const entry = MAP_HEADER_SIZE + i * MAP_DIRECTORY_ENTRY_SIZE;
        const id = view.getUint8(entry);
        const offset = view.getUint32(entry + 4, true);
        const length = view.getUint32(entry + 8, true);
        const name = Object.keys(LAYER_IDS).find((key) => LAYER_IDS[key] === id);
        assert(name, `section carte inconnue : ${id}`);
        layers[name] = bytes.slice(offset, offset + length);
      }
      return { header, layers };
    },
    free() {
      engine._free(pointer);
    },
  };
}

function makeCommandRunner(engine) {
  return {
    run(command) {
      const json = typeof command === 'string' ? command : JSON.stringify(command);
      const size = engine.lengthBytesUTF8(json) + 1;
      const pointer = engine._malloc(size);
      let status;
      try {
        engine.stringToUTF8(json, pointer, size);
        status = engine._ottd_command(pointer, 0, 0);
      } finally {
        engine._free(pointer);
      }
      const reply = JSON.parse(engine.UTF8ToString(engine._ottd_command_result()));
      return { ...reply, status };
    },
  };
}

/**
 * `ottd_saveSize` puis `ottd_save` : renvoie le conteneur complet et les
 * mesures. Le pont met la sauvegarde en cache entre les deux appels.
 */
function saveGame(api) {
  const started = nowMs();
  const required = api.saveSize();
  assert(required > 0, `ottd_save_size() = ${required} : ${readError(api)}`);
  const pointer = api.engine._malloc(required);
  let written;
  try {
    written = api.save(pointer, required);
    assert(
      written === required,
      `ottd_save() a écrit ${written} octets au lieu de ${required} : ${readError(api)}`,
    );
    const bytes = Buffer.from(api.engine.HEAPU8.slice(pointer, pointer + written));
    const elapsed = nowMs() - started;
    return { bytes, size: written, elapsed };
  } finally {
    api.engine._free(pointer);
  }
}

function loadGame(api, bytes) {
  const pointer = api.engine._malloc(bytes.length);
  try {
    api.engine.HEAPU8.set(bytes, pointer);
    const started = nowMs();
    const status = api.load(pointer, bytes.length);
    return { status, elapsed: nowMs() - started };
  } finally {
    api.engine._free(pointer);
  }
}

/** En-tête du conteneur OT3S (diagnostic). */
function saveHeader(bytes) {
  assert(bytes.length >= SAVE_HEADER_SIZE, `conteneur trop court : ${bytes.length} octets`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: view.getUint32(0, true),
    version: view.getUint16(4, true),
    headerSize: view.getUint16(6, true),
    payloadSize: view.getUint32(8, true),
    tick: view.getUint32(12, true),
    checksum: view.getBigUint64(16, true),
    metadataSize: view.getUint32(24, true),
  };
}

/** FNV-1a 64 bits, pour recalculer la somme de contrôle d'un conteneur. */
function fnv1a64(bytes) {
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash;
}

/** Recalcule la somme de contrôle du conteneur (test du chemin de restauration). */
function resealSave(bytes) {
  const header = saveHeader(bytes);
  const start = header.headerSize + header.metadataSize;
  const copy = Buffer.from(bytes);
  const checksum = fnv1a64(
    Buffer.concat([copy.subarray(header.headerSize, start), copy.subarray(start)]),
  );
  copy.writeBigUInt64LE(checksum, 16);
  return copy;
}

function findFlatArea(map, width, height, avoid = null) {
  const { width: mapWidth, height: mapHeight } = map.header;
  const { kind, heightMap, slope, flags } = map.layers;

  const overlaps = (x, y) => {
    if (avoid === null) return false;
    return (
      x < avoid.x + avoid.width &&
      x + width > avoid.x &&
      y < avoid.y + avoid.height &&
      y + height > avoid.y
    );
  };

  for (let y = 1; y + height < mapHeight; y++) {
    for (let x = 1; x + width < mapWidth; x++) {
      if (overlaps(x, y)) continue;
      const baseHeight = heightMap[y * mapWidth + x];
      let ok = true;
      for (let dy = 0; dy < height && ok; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const index = (y + dy) * mapWidth + x + dx;
          if (
            kind[index] !== TILE_KIND.grass ||
            slope[index] !== 0 ||
            (flags[index] & TILE_FLAG_WATER) !== 0 ||
            heightMap[index] !== baseHeight
          ) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y, width, height };
    }
  }
  return null;
}

function countKind(map, kind) {
  return map.layers.kind.reduce((total, value) => total + (value === kind ? 1 : 0), 0);
}

function digest(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function expectOk(reply, what) {
  const detail = reply.detail ? ` [${reply.detail}]` : '';
  assert(reply.ok === true, `${what} : ${reply.code} — ${reply.message}${detail}`);
  assert(reply.status === 0, `${what} : statut ${reply.status} au lieu de 0`);
  return reply;
}

function localCompany(state) {
  const company = state.companies.find((entry) => entry.isLocal);
  assert(company, 'aucune entreprise locale dans le snapshot');
  return company;
}

/**
 * Snapshot comparable : la séquence est propre à chaque instance et le hash
 * dépend du moteur, on ne compare donc que l'état simulé.
 */
function comparableState(state) {
  const { meta, map, ...rest } = state;
  return {
    ...rest,
    meta: { protocol: meta.protocol, tick: meta.tick, hash: meta.hash },
    map: map === null ? null : { ...map },
  };
}

function assertSameState(first, second, what) {
  const a = JSON.stringify(comparableState(first));
  const b = JSON.stringify(comparableState(second));
  if (a !== b) {
    fail(`${what} : snapshots différents\n  A : ${a}\n  B : ${b}`);
  }
}

/** Prépare une instance bootée avec une partie neuve. */
async function newGameInstance(label) {
  const diagnostics = makeDiagnostics();
  const api = wrap(await createInstance(label, diagnostics));
  if (api.boot() !== 0) fail(`[${label}] ottd_boot() : ${readError(api)}`);
  const created = api.newGame(SEED, MAP_SIZE, MAP_SIZE);
  if (created !== 0) fail(`[${label}] ottd_new_game() = ${created} : ${readError(api)}`);
  return { label, api, diagnostics };
}

/**
 * Scénario 1-3 : partie sans commande, sauvegarde, chargement dans une
 * instance neuve, puis 1 000 ticks sur les deux.
 */
async function runRoundTrip() {
  const first = await newGameInstance('roundtrip-source');
  const jsonA = makeJsonReader(first.api.engine);
  assert(first.api.step(WARMUP_TICKS) === WARMUP_TICKS, `warmup : ${readError(first.api)}`);

  const stateA = jsonA.read();
  const hashA = hashHex(first.api.engine);
  const tickA = first.api.engine._ottd_tick();
  assert(hashA === REFERENCE_HASH_BASE, `hash de référence : ${hashA} ≠ ${REFERENCE_HASH_BASE}`);

  const saved = saveGame(first.api);
  const header = saveHeader(saved.bytes);
  assert(header.magic === SAVE_MAGIC, `magie de sauvegarde 0x${header.magic.toString(16)}`);
  assert(header.version === SAVE_VERSION, `version de sauvegarde ${header.version}`);
  assert(header.headerSize === SAVE_HEADER_SIZE, `en-tête de ${header.headerSize} octets`);
  assert(header.metadataSize > 0, 'métadonnées absentes');
  assert(
    header.payloadSize === saved.bytes.length - header.headerSize - header.metadataSize,
    'taille de .sav incohérente dans l’en-tête',
  );
  assert(header.tick === tickA, `tick de sauvegarde ${header.tick} ≠ ${tickA}`);
  assert(
    saved.bytes.subarray(header.headerSize + header.metadataSize).length === header.payloadSize,
    'charge utile .sav incohérente',
  );

  /* Instance neuve : aucune partie, uniquement bootée. */
  const dry = makeDiagnostics();
  const targetApi = wrap(await createInstance('roundtrip-target', dry));
  if (targetApi.boot() !== 0) fail(`target boot : ${readError(targetApi)}`);
  const sizeWithoutGame = targetApi.saveSize();
  assert(
    sizeWithoutGame === -1,
    `ottd_save_size() sans partie devrait renvoyer -1, reçu ${sizeWithoutGame}`,
  );

  const loaded = loadGame(targetApi, saved.bytes);
  assert(loaded.status === 0, `ottd_load() = ${loaded.status} : ${readError(targetApi)}`);
  const hashB = hashHex(targetApi.engine);
  const tickB = targetApi.engine._ottd_tick();
  assert(hashB === hashA, `hash après chargement ${hashB} ≠ ${hashA}`);
  assert(tickB === tickA, `tick après chargement ${tickB} ≠ ${tickA}`);
  assert(
    targetApi.companyId() === first.api.companyId(),
    `entreprise locale ${targetApi.companyId()} ≠ ${first.api.companyId()}`,
  );

  const jsonB = makeJsonReader(targetApi.engine);
  assertSameState(stateA, jsonB.read(), 'état après chargement');

  /* 1 000 ticks : même PRNG, mêmes compteurs, même carte. */
  const stepA = first.api.step(COMPARE_TICKS);
  const stepB = targetApi.step(COMPARE_TICKS);
  assert(stepA === COMPARE_TICKS, `source : ottd_step(${COMPARE_TICKS}) = ${stepA}`);
  assert(stepB === COMPARE_TICKS, `cible : ottd_step(${COMPARE_TICKS}) = ${stepB}`);
  const hashA2 = hashHex(first.api.engine);
  const hashB2 = hashHex(targetApi.engine);
  assert(hashA2 === hashB2, `hash après ${COMPARE_TICKS} ticks : ${hashA2} ≠ ${hashB2}`);
  assertSameState(jsonA.read(), jsonB.read(), `${COMPARE_TICKS} ticks après chargement`);

  assertNoBackupWarnings([...first.diagnostics.stdout, ...first.diagnostics.stderr], 'source');
  assertNoBackupWarnings([...dry.stdout, ...dry.stderr], 'cible');

  jsonA.free();
  jsonB.free();
  first.api.engine._ottd_shutdown();
  targetApi.engine._ottd_shutdown();

  return {
    hash: hashA,
    hashAfter: hashA2,
    tick: tickA,
    size: saved.size,
    payloadSize: header.payloadSize,
    metadataSize: header.metadataSize,
    saveMs: saved.elapsed,
    loadMs: loaded.elapsed,
  };
}

/**
 * Scénario 4 : commandes route/rail, sauvegarde, chargement dans une instance
 * neuve, comparaison de la carte et des entités.
 */
async function runCommandsRoundTrip() {
  const source = await newGameInstance('commands-source');
  const json = makeJsonReader(source.api.engine);
  const map = makeMapReader(source.api.engine);
  const commands = makeCommandRunner(source.api.engine);

  assert(source.api.step(WARMUP_TICKS) === WARMUP_TICKS, `warmup : ${readError(source.api)}`);

  const initialMap = map.read();
  const companyId = localCompany(json.read()).id;
  const roadSite = findFlatArea(initialMap, 8, 4);
  assert(roadSite, 'aucune zone plate 8×4 pour la route');
  const railSite = findFlatArea(initialMap, 8, 4, roadSite);
  assert(railSite, 'aucune seconde zone plate 8×4 pour le rail');

  const roadFrom = { x: roadSite.x + 1, y: roadSite.y };
  const roadTo = { x: roadFrom.x + ROAD_LENGTH - 1, y: roadFrom.y };
  expectOk(
    commands.run({ type: 'build', tool: 'road', company: companyId, from: roadFrom, to: roadTo }),
    'route',
  );

  const stationTile = { x: roadFrom.x + 2, y: roadFrom.y };
  const roadStation = expectOk(
    commands.run({
      type: 'build',
      tool: 'station',
      company: companyId,
      from: stationTile,
      options: { kind: 'bus', direction: 'ne', drive_through: true },
    }),
    'gare routière',
  );
  const depotTile = { x: roadFrom.x, y: roadFrom.y + 1 };
  const depot = expectOk(
    commands.run({
      type: 'build',
      tool: 'depot',
      company: companyId,
      from: depotTile,
      options: { kind: 'road' },
    }),
    'dépôt routier',
  );
  const bus = expectOk(
    commands.run({
      type: 'vehicle',
      action: 'buy',
      company: companyId,
      depot: depotTile,
      model: 'bus',
    }),
    'achat bus',
  );
  expectOk(
    commands.run({
      type: 'vehicle',
      action: 'order',
      company: companyId,
      vehicle: bus.vehicleId,
      orders: [{ target: roadStation.stationId, kind: 'station' }],
    }),
    'ordre bus',
  );
  expectOk(
    commands.run({ type: 'vehicle', action: 'start', company: companyId, vehicle: bus.vehicleId }),
    'démarrage bus',
  );

  const railFrom = { x: railSite.x + 1, y: railSite.y };
  const railTo = { x: railFrom.x + RAIL_LENGTH - 1, y: railFrom.y };
  expectOk(
    commands.run({ type: 'build', tool: 'rail', company: companyId, from: railFrom, to: railTo }),
    'rail',
  );
  const railStation = expectOk(
    commands.run({
      type: 'build',
      tool: 'station',
      company: companyId,
      from: { x: railFrom.x + 1, y: railFrom.y },
      to: { x: railFrom.x + 3, y: railFrom.y },
      options: { kind: 'rail', axis: 'x', platforms: 1 },
    }),
    'gare ferroviaire',
  );
  expectOk(
    commands.run({
      type: 'build',
      tool: 'signal',
      company: companyId,
      from: railTo,
      options: { type: 'block' },
    }),
    'signal',
  );
  const railDepotTile = { x: railFrom.x, y: railFrom.y + 1 };
  const railDepot = expectOk(
    commands.run({
      type: 'build',
      tool: 'depot',
      company: companyId,
      from: railDepotTile,
      options: { kind: 'rail' },
    }),
    'dépôt ferroviaire',
  );
  const train = expectOk(
    commands.run({
      type: 'vehicle',
      action: 'buy',
      company: companyId,
      depot: railDepotTile,
      model: 'train',
    }),
    'achat train',
  );
  expectOk(
    commands.run({
      type: 'vehicle',
      action: 'order',
      company: companyId,
      vehicle: train.vehicleId,
      orders: [{ target: railStation.stationId, kind: 'station' }],
    }),
    'ordre train',
  );
  expectOk(
    commands.run({
      type: 'vehicle',
      action: 'start',
      company: companyId,
      vehicle: train.vehicleId,
    }),
    'démarrage train',
  );

  assert(source.api.step(SETTLE_TICKS) === SETTLE_TICKS, `settle : ${readError(source.api)}`);

  const state = json.read();
  const finalMap = map.read();
  const hash = hashHex(source.api.engine);
  const tick = source.api.engine._ottd_tick();
  const saved = saveGame(source.api);
  const header = saveHeader(saved.bytes);
  assert(header.tick === tick, `tick de sauvegarde ${header.tick} ≠ ${tick}`);

  /* Cible neuve (bootée, sans partie). */
  const diagnostics = makeDiagnostics();
  const targetApi = wrap(await createInstance('commands-target', diagnostics));
  if (targetApi.boot() !== 0) fail(`cible boot : ${readError(targetApi)}`);

  const loaded = loadGame(targetApi, saved.bytes);
  assert(loaded.status === 0, `ottd_load() = ${loaded.status} : ${readError(targetApi)}`);
  const targetJson = makeJsonReader(targetApi.engine);
  const targetMap = makeMapReader(targetApi.engine);
  const targetState = targetJson.read();
  const targetMapState = targetMap.read();

  assert(hashHex(targetApi.engine) === hash, `hash de la cible ≠ ${hash}`);
  assert(targetApi.engine._ottd_tick() === tick, `tick de la cible ≠ ${tick}`);
  assert(targetState.meta.tick === targetMapState.header.tick, 'tick JSON ≠ tick carte');
  assertSameState(state, targetState, 'état avec commandes après chargement');
  assert(
    digest(targetMapState.layers.kind) === digest(finalMap.layers.kind),
    'carte différente après chargement',
  );

  const stationIdsA = state.stations.map((entry) => entry.id).sort((a, b) => a - b);
  const stationIdsB = targetState.stations.map((entry) => entry.id).sort((a, b) => a - b);
  assert(
    JSON.stringify(stationIdsA) === JSON.stringify(stationIdsB),
    `gares différentes : ${stationIdsA} ≠ ${stationIdsB}`,
  );
  const vehicleIdsA = state.vehicles.map((entry) => entry.id).sort((a, b) => a - b);
  const vehicleIdsB = targetState.vehicles.map((entry) => entry.id).sort((a, b) => a - b);
  assert(
    JSON.stringify(vehicleIdsA) === JSON.stringify(vehicleIdsB),
    `véhicules différents : ${vehicleIdsA} ≠ ${vehicleIdsB}`,
  );
  assert(
    localCompany(state).money === localCompany(targetState).money,
    `trésorerie ${localCompany(state).money} ≠ ${localCompany(targetState).money}`,
  );
  for (const [id, kind] of [
    [roadStation.stationId, 'road'],
    [railStation.stationId, 'train'],
  ]) {
    const entry = targetState.stations.find((station) => station.id === id);
    assert(entry, `gare ${id} absente après chargement`);
    assert(entry.kind === kind, `gare ${id} : type ${entry.kind} au lieu de ${kind}`);
  }

  /* Les dépôts (#90) et leurs ids doivent survivre à l'aller-retour. */
  const depotSignature = (entry) =>
    `${entry.id}:${entry.kind}:${entry.x}:${entry.y}:${entry.direction}:${entry.company}`;
  const depotsA = state.depots.map(depotSignature).sort();
  const depotsB = targetState.depots.map(depotSignature).sort();
  assert(
    JSON.stringify(depotsA) === JSON.stringify(depotsB),
    `dépôts différents après chargement : ${depotsA} ≠ ${depotsB}`,
  );
  assert(
    state.counts.depots === targetState.counts.depots,
    `counts.depots ${state.counts.depots} ≠ ${targetState.counts.depots}`,
  );
  for (const [id, kind, tile] of [
    [depot.depotId, 'road', depotTile],
    [railDepot.depotId, 'rail', railDepotTile],
  ]) {
    const entry = targetState.depots.find((candidate) => candidate.id === id);
    assert(entry, `dépôt ${id} absent après chargement`);
    assert(entry.kind === kind, `dépôt ${id} : type ${entry.kind} au lieu de ${kind}`);
    assert(
      entry.x === tile.x && entry.y === tile.y,
      `dépôt ${id} : coordonnées (${entry.x}, ${entry.y}) ≠ (${tile.x}, ${tile.y})`,
    );
  }
  assert(
    targetState.vehicles
      .find((entry) => entry.id === bus.vehicleId)
      ?.orderTargets.includes(roadStation.stationId),
    'bus : ordre perdu après chargement',
  );
  assert(
    targetState.vehicles
      .find((entry) => entry.id === train.vehicleId)
      ?.orderTargets.includes(railStation.stationId),
    'train : ordre perdu après chargement',
  );

  /* Le module reste utilisable : 500 ticks identiques de part et d'autre. */
  assert(source.api.step(POST_LOAD_TICKS) === POST_LOAD_TICKS, 'source : step après save');
  assert(targetApi.step(POST_LOAD_TICKS) === POST_LOAD_TICKS, 'cible : step après load');
  assert(
    hashHex(source.api.engine) === hashHex(targetApi.engine),
    `hash après ${POST_LOAD_TICKS} ticks différents`,
  );
  assertSameState(json.read(), targetJson.read(), 'état après ticks post-chargement');

  assertNoBackupWarnings([...source.diagnostics.stdout, ...source.diagnostics.stderr], 'source');
  assertNoBackupWarnings([...diagnostics.stdout, ...diagnostics.stderr], 'cible');

  json.free();
  map.free();
  targetJson.free();
  targetMap.free();
  source.api.engine._ottd_shutdown();
  targetApi.engine._ottd_shutdown();

  return {
    hash,
    hashAfter: hashHex(source.api.engine),
    tick,
    size: saved.size,
    payloadSize: header.payloadSize,
    metadataSize: header.metadataSize,
    saveMs: saved.elapsed,
    loadMs: loaded.elapsed,
    companyId,
    counts: {
      stations: state.stations.length,
      depots: state.depots.length,
      vehicles: state.vehicles.length,
      roadTiles: countKind(finalMap, TILE_KIND.road),
      railTiles: countKind(finalMap, TILE_KIND.rail),
      stationTiles: countKind(finalMap, TILE_KIND.station),
    },
    ids: {
      roadStation: roadStation.stationId,
      railStation: railStation.stationId,
      bus: bus.vehicleId,
      train: train.vehicleId,
      roadDepot: depot.depotId,
      railDepot: railDepot.depotId,
    },
    mapDigest: digest(finalMap.layers.kind),
  };
}

/**
 * Scénario 4 bis : partie avec deux IA, sauvegarde, chargement, puis 500 ticks.
 * Vérifie que les scripts IA reprennent sans reconstruire une seconde ligne
 * (`Save`/`Load` de `engine/ai/opentt3d`).
 */
async function runAiRoundTrip() {
  const diagnostics = makeDiagnostics();
  const source = wrap(await createInstance('ai-source', diagnostics));
  if (source.boot() !== 0) fail(`ai source boot : ${readError(source)}`);
  const created = source.newGameEx(
    SEED,
    MAP_SIZE,
    MAP_SIZE,
    JSON.stringify({ climate: 'temperate', start_year: 2000, difficulty: 2, ai_companies: 2 }),
  );
  if (created !== 0) fail(`ai new_game_ex() = ${created} : ${readError(source)}`);
  assert(source.step(WARMUP_TICKS) === WARMUP_TICKS, `ai warmup : ${readError(source)}`);

  const sourceJson = makeJsonReader(source.engine);
  const state = sourceJson.read();
  assert(state.counts.companies === 3, `IA : ${state.counts.companies} entreprises au lieu de 3`);
  assert(state.counts.stations >= 2, `IA : ${state.counts.stations} gares construites`);
  assert(state.counts.vehicles >= 2, `IA : ${state.counts.vehicles} véhicules construits`);
  assert(
    state.config.aiCompanies === 2,
    `IA : configuration ${state.config.aiCompanies} au lieu de 2`,
  );
  const aiCompanies = state.companies.filter((company) => company.isAI);
  assert(aiCompanies.length === 2, `IA : ${aiCompanies.length} entreprises isAI au lieu de 2`);
  assert(
    aiCompanies.every((company) => company.aiLevel === 2),
    `IA : niveaux ${aiCompanies.map((company) => company.aiLevel).join(',')} au lieu de 2`,
  );
  const hash = hashHex(source.engine);
  const tick = source.engine._ottd_tick();
  const saved = saveGame(source);

  const targetDiagnostics = makeDiagnostics();
  const target = wrap(await createInstance('ai-target', targetDiagnostics));
  if (target.boot() !== 0) fail(`ai target boot : ${readError(target)}`);
  const loaded = loadGame(target, saved.bytes);
  assert(loaded.status === 0, `ai load : ${loaded.status} — ${readError(target)}`);
  assert(hashHex(target.engine) === hash, `IA : hash après chargement ≠ ${hash}`);
  assert(target.engine._ottd_tick() === tick, 'IA : tick après chargement différent');

  const targetJson = makeJsonReader(target.engine);
  assertSameState(state, targetJson.read(), 'IA : état après chargement');

  assert(source.step(POST_LOAD_TICKS) === POST_LOAD_TICKS, 'IA source : step après save');
  assert(target.step(POST_LOAD_TICKS) === POST_LOAD_TICKS, 'IA cible : step après load');
  assert(
    hashHex(source.engine) === hashHex(target.engine),
    `IA : hash après ${POST_LOAD_TICKS} ticks différent`,
  );
  assertSameState(sourceJson.read(), targetJson.read(), 'IA : état après ticks');
  const after = targetJson.read();
  assert(
    after.counts.stations === state.counts.stations,
    `IA : ${after.counts.stations} gares après ticks au lieu de ${state.counts.stations}`,
  );
  assert(
    after.counts.vehicles === state.counts.vehicles,
    `IA : ${after.counts.vehicles} véhicules après ticks au lieu de ${state.counts.vehicles}`,
  );

  assertNoBackupWarnings([...diagnostics.stdout, ...diagnostics.stderr], 'IA source');
  assertNoBackupWarnings([...targetDiagnostics.stdout, ...targetDiagnostics.stderr], 'IA cible');

  sourceJson.free();
  targetJson.free();
  source.engine._ottd_shutdown();
  target.engine._ottd_shutdown();

  return {
    hash,
    hashAfter: hashHex(source.engine),
    tick,
    size: saved.size,
    saveMs: saved.elapsed,
    loadMs: loaded.elapsed,
    counts: state.counts,
  };
}

/**
 * Scénario 5 : refus propre des sauvegardes invalides, état préservé.
 */
function runCorruptionChecks(api, validSave, diagnostics) {
  const before = hashHex(api.engine);
  const tick = api.engine._ottd_tick();
  const json = makeJsonReader(api.engine);
  const stateBefore = json.read();
  json.free();

  const cases = [];
  const checkRefused = (what, bytes, expectedStatus) => {
    const loaded = loadGame(api, bytes);
    assert(
      loaded.status === expectedStatus,
      `${what} : statut ${loaded.status} au lieu de ${expectedStatus} (${readError(api)})`,
    );
    assert(readError(api) !== '(aucune erreur exposée)', `${what} : ottd_last_error vide`);
    assert(hashHex(api.engine) === before, `${what} : hash modifié (${hashHex(api.engine)})`);
    assert(api.engine._ottd_tick() === tick, `${what} : tick modifié`);
    cases.push(`${what} → ${loaded.status}`);
  };

  checkRefused(
    'sauvegarde tronquée',
    validSave.bytes.subarray(0, validSave.bytes.length - 100),
    -4,
  );

  const corrupted = Buffer.from(validSave.bytes);
  const header = saveHeader(validSave.bytes);
  corrupted[header.headerSize + header.metadataSize + 16] ^= 0xff;
  checkRefused('octet altéré', corrupted, -4);

  const random = Buffer.alloc(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff;
  checkRefused('buffer aléatoire', random, -4);

  const wrongVersion = Buffer.from(validSave.bytes);
  wrongVersion.writeUInt16LE(99, 4);
  checkRefused('version inconnue', wrongVersion, -4);

  /* En-tête du pont valide mais .sav OpenTTD illisible : le chargement doit
   * échouer après être entré dans OpenTTD, et l'état précédent être restauré. */
  const resealed = resealSave(validSave.bytes);
  const start = header.headerSize + header.metadataSize;
  for (let i = start; i < resealed.length; i++) resealed[i] = (i * 53 + 7) & 0xff;
  const repaired = resealSave(resealed);
  checkRefused('sav OpenTTD altéré (somme recalculée)', repaired, -6);

  /* Arguments invalides. */
  assert(api.load(0, 0) === -3, `ottd_load(NULL, 0) devrait renvoyer -3`);
  assert(api.load(0, 64) === -3, `ottd_load(NULL, 64) devrait renvoyer -3`);

  /* Le module reste utilisable après tous ces refus. */
  assert(api.step(10) === 10, `step après refus : ${readError(api)}`);
  assert(api.engine._ottd_tick() === tick + 10, 'tick non avancé après les refus');
  const after = hashHex(api.engine);
  assert(after !== before, 'hash inchangé après 10 ticks');

  /* Une sauvegarde valide reste chargeable dans cet état. */
  const reload = loadGame(api, validSave.bytes);
  assert(reload.status === 0, `rechargement valide : ${reload.status} — ${readError(api)}`);
  assert(hashHex(api.engine) === before, 'rechargement valide : hash différent');
  assert(api.engine._ottd_tick() === tick, 'rechargement valide : tick différent');
  const jsonAfter = makeJsonReader(api.engine);
  assertSameState(stateBefore, jsonAfter.read(), 'rechargement valide');
  jsonAfter.free();

  assertNoBackupWarnings([...diagnostics.stdout, ...diagnostics.stderr], 'refus');
  return { cases, before, after };
}

log(`Module   : ${MODULE_PATH}`);
log(`Scénario : seed ${SEED}, ${MAP_SIZE}×${MAP_SIZE}, ${WARMUP_TICKS} ticks avant sauvegarde\n`);

const roundTrip = await runRoundTrip();
log(
  `[aller-retour] ${roundTrip.size} octets (${roundTrip.payloadSize} de .sav + ` +
    `${roundTrip.metadataSize} de métadonnées)`,
);
log(
  `[aller-retour] sauvegarde ${roundTrip.saveMs.toFixed(1)} ms, ` +
    `chargement ${roundTrip.loadMs.toFixed(1)} ms`,
);
log(`[aller-retour] hash ${roundTrip.hash} (tick ${roundTrip.tick}) conservé au chargement`);
log(
  `[aller-retour] ${COMPARE_TICKS} ticks sur les deux instances → ${roundTrip.hashAfter} (identiques)`,
);

const commandsTrip = await runCommandsRoundTrip();
log(
  `[commandes] ${commandsTrip.counts.roadTiles} tuiles de route, ` +
    `${commandsTrip.counts.railTiles} de rail, ${commandsTrip.counts.stationTiles} de gare ; ` +
    `${commandsTrip.counts.stations} gares, ${commandsTrip.counts.depots} dépôts, ` +
    `${commandsTrip.counts.vehicles} véhicules`,
);
log(
  `[commandes] ${commandsTrip.size} octets, sauvegarde ${commandsTrip.saveMs.toFixed(1)} ms, ` +
    `chargement ${commandsTrip.loadMs.toFixed(1)} ms`,
);
log(`[commandes] hash ${commandsTrip.hash} (carte ${commandsTrip.mapDigest}) conservé`);
log(
  `[commandes] ${POST_LOAD_TICKS} ticks après chargement → ${commandsTrip.hashAfter} (identiques)`,
);

if (REFERENCE_HASH_COMMANDS !== null && commandsTrip.hash !== REFERENCE_HASH_COMMANDS) {
  fail(
    `hash de référence commandes : ${commandsTrip.hash} ≠ ${REFERENCE_HASH_COMMANDS}\n` +
      '  Mettez à jour REFERENCE_HASH_COMMANDS consciemment.',
  );
}

const aiTrip = await runAiRoundTrip();
log(
  `[IA] ${aiTrip.counts.companies} entreprises, ${aiTrip.counts.stations} gares, ` +
    `${aiTrip.counts.vehicles} véhicules ; ${aiTrip.size} octets`,
);
log(
  `[IA] hash ${aiTrip.hash} conservé au chargement, ` +
    `${POST_LOAD_TICKS} ticks → ${aiTrip.hashAfter} (identiques, pas de reconstruction)`,
);

/* Instance dédiée aux refus : on repart d'une partie neuve sauvegardée. */
const corruptionDiagnostics = makeDiagnostics();
const corruptionApi = wrap(await createInstance('corruption', corruptionDiagnostics));
if (corruptionApi.boot() !== 0) fail(`corruption boot : ${readError(corruptionApi)}`);
assert(
  corruptionApi.load(0, 0) === -3,
  'ottd_load(NULL, 0) devrait renvoyer -3 avant toute partie',
);

const corruptionSource = await newGameInstance('corruption-source');
const corruptionJson = makeJsonReader(corruptionSource.api.engine);
assert(corruptionSource.api.step(WARMUP_TICKS) === WARMUP_TICKS, 'corruption : warmup');
const corruptionSave = saveGame(corruptionSource.api);
const corruptionHash = hashHex(corruptionSource.api.engine);
corruptionJson.free();
corruptionSource.api.engine._ottd_shutdown();

const initialLoad = loadGame(corruptionApi, corruptionSave.bytes);
assert(
  initialLoad.status === 0,
  `chargement initial pour les refus : ${initialLoad.status} — ${readError(corruptionApi)}`,
);
assert(
  hashHex(corruptionApi.engine) === corruptionHash,
  `chargement initial : hash ${hashHex(corruptionApi.engine)} ≠ ${corruptionHash}`,
);

const corruption = runCorruptionChecks(corruptionApi, corruptionSave, corruptionDiagnostics);
log(`[refus] ${corruption.cases.join(' ; ')}`);
log(`[refus] état ${corruption.before} préservé, puis 10 ticks → ${corruption.after}`);
corruptionApi.engine._ottd_shutdown();

log('\n✅ Sauvegarde et chargement mémoire validés (#61).');
