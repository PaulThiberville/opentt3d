#!/usr/bin/env node
/**
 * Test des commandes de construction et de véhicules du moteur OpenTT3D
 * (issues #11 et #90).
 *
 * Scénario, sur une carte 128×128 sans IA :
 *  1. trouve deux zones plates et dégagées (route et rail) dans le snapshot ;
 *  2. construit un tronçon de route, une gare routière en passage, un dépôt,
 *     achète un bus (par coordonnées puis par `depotId`), lui donne un ordre
 *     et le démarre ;
 *  3. construit une voie ferrée, une gare, un signal de bloc, un dépôt
 *     ferroviaire, achète une locomotive et la démarre ;
 *  4. construit puis démolit un dépôt dédié pour vérifier que `depots` et
 *     `counts.depots` suivent le cycle de vie (ids stables, disparition) ;
 *  5. vérifie via les snapshots que les tuiles, gares, dépôts, véhicules et
 *     l'argent ont changé ;
 *  6. envoie des commandes invalides (dont un `depotId` inconnu) et vérifie
 *     qu'elles échouent proprement sans modifier l'état (hash identique) ;
 *  7. rejoue tout le journal de commandes sur une seconde instance et compare
 *     les hashs, les identifiants et la carte.
 *
 * Usage : node engine/scripts/commands.mjs [--verbose]
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
const SEED = 1234;
const MAP_SIZE = 128;
const SETTLE_TICKS = 200;
const ROAD_LENGTH = 5;
const RAIL_LENGTH = 5;
const TILE_KIND = { void: 0, water: 4, coast: 5, grass: 2, rail: 6, road: 7, station: 10 };
const TILE_FLAG_WATER = 1 << 0;
const TILE_FLAG_SIGNAL = 1 << 6;
const MAP_MAGIC = 0x314d544f;
const MAP_HEADER_SIZE = 64;
const MAP_DIRECTORY_ENTRY_SIZE = 12;
const MAP_LAYER_COUNT = 6;
const LAYER_IDS = { kind: 1, heightMap: 2, owner: 3, slope: 4, flags: 5, trackBits: 6 };

/**
 * Hash de référence du scénario complet (seed 1234, 128×128, sans IA,
 * 200 ticks après le journal de commandes). Il doit rester stable : toute
 * modification du pont, du baseset ou d'OpenTTD le met à jour consciemment
 * (voir wiki, Moteur-WASM > Déterminisme).
 *
 * Dernière mise à jour : #90 (achat par `depotId`, cycle de vie d'un dépôt).
 */
const REFERENCE_HASH = '0xd92119299eee8941';

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

/**
 * Sortie interdite : `Backup<T>` d'OpenTTD journalise ce message quand une
 * valeur sauvegardée n'est pas restaurée. Aucune commande du pont ne doit en
 * produire (voir wiki, Moteur-WASM > Commandes).
 */
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

  // OpenTTD utilise `window.crypto` pour l'entropie (identifiant de partie).
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
    newGameEx: engine.cwrap('ottd_new_game_ex', 'number', ['number', 'number', 'number', 'string']),
    step: engine.cwrap('ottd_step', 'number', ['number']),
    lastError: engine.cwrap('ottd_last_error', 'string', []),
    companyId: engine.cwrap('ottd_company_id', 'number', []),
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

      const layers = {};
      for (let i = 0; i < MAP_LAYER_COUNT; i++) {
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

/**
 * Envoie une commande et renvoie la réponse JSON.
 *
 * Le buffer de sortie est volontairement NULL : le pont conserve le résultat
 * dans `ottd_command_result()`, ce qui évite tout problème de capacité.
 */
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
      const resultPointer = engine._ottd_command_result();
      const reply = JSON.parse(engine.UTF8ToString(resultPointer));
      return { ...reply, status };
    },
  };
}

/** Cherche une zone rectangulaire d'herbe plate, hors d'un rectangle exclu. */
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

/**
 * Première tuile d'eau franche (pas une côte) ayant un voisin terrestre.
 * Les côtes sont volontairement exclues : OpenTTD autorise à les assécher,
 * donc elles ne permettent pas de tester un refus. Le voisin idéal est une
 * herbe plate ; à défaut, toute tuile terrestre convient (le tronçon échouera
 * de toute façon sur l'eau, sans rien construire).
 */
function findWaterWithLandNeighbour(map) {
  const { width, height } = map.header;
  const { kind, slope } = map.layers;
  const offsets = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  const isLandKind = (value) =>
    value !== TILE_KIND.void && value !== TILE_KIND.water && value !== TILE_KIND.coast;
  let fallback = null;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (kind[y * width + x] !== TILE_KIND.water) continue;
      for (const [dx, dy] of offsets) {
        const landX = x + dx;
        const landY = y + dy;
        const neighbour = landY * width + landX;
        if (!isLandKind(kind[neighbour])) continue;
        const candidate = { water: { x, y }, land: { x: landX, y: landY } };
        if (kind[neighbour] === TILE_KIND.grass && slope[neighbour] === 0) return candidate;
        if (fallback === null) fallback = candidate;
      }
    }
  }
  return fallback;
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

function expectFailure(reply, expectedStatus, what) {
  assert(reply.ok === false, `${what} : commande acceptée alors qu'elle devait échouer`);
  assert(
    reply.status === expectedStatus,
    `${what} : statut ${reply.status} au lieu de ${expectedStatus} (${reply.code})`,
  );
  assert(typeof reply.message === 'string' && reply.message.length > 0, `${what} : message vide`);
  assert(typeof reply.code === 'string' && reply.code.length > 0, `${what} : code vide`);
  return reply;
}

function localCompany(state) {
  const company = state.companies.find((entry) => entry.isLocal);
  assert(company, 'aucune entreprise locale dans le snapshot');
  return company;
}

/**
 * Joue le scénario complet sur une instance neuve et renvoie les mesures.
 */
async function runScenario(label) {
  const diagnostics = makeDiagnostics();
  const api = wrap(await createInstance(label, diagnostics));
  if (api.boot() !== 0) fail(`ottd_boot() : ${readError(api)}`);

  const created = api.newGameEx(
    SEED,
    MAP_SIZE,
    MAP_SIZE,
    JSON.stringify({ climate: 'temperate', start_year: 1950, difficulty: 1, ai_companies: 0 }),
  );
  if (created !== 0) fail(`ottd_new_game_ex() = ${created} : ${readError(api)}`);

  const json = makeJsonReader(api.engine);
  const map = makeMapReader(api.engine);
  const commands = makeCommandRunner(api.engine);
  /**
   * Envoie une commande et vérifie qu'elle n'a produit aucun avertissement de
   * `Backup` non restauré (attribution immédiate à la commande fautive).
   */
  const run = (command) => {
    const markOut = diagnostics.stdout.length;
    const markErr = diagnostics.stderr.length;
    const reply = commands.run(command);
    const what =
      typeof command === 'string'
        ? 'commande JSON brute'
        : command.type === 'build'
          ? `build ${command.tool}`
          : `vehicle ${command.action}`;
    assertNoBackupWarnings(
      [...diagnostics.stdout.slice(markOut), ...diagnostics.stderr.slice(markErr)],
      `${label} : ${what}`,
    );
    return reply;
  };

  const initial = json.read();
  const initialMap = map.read();
  const company = localCompany(initial);
  const companyId = company.id;
  assert(
    api.companyId() === companyId,
    `ottd_company_id() = ${api.companyId()} ≠ entreprise locale ${companyId}`,
  );
  const moneyBefore = company.money;

  /* --- Dépôts : état initial vide (pas d'IA) ---------------------------- */
  assert(Array.isArray(initial.depots), 'snapshot : tableau « depots » absent');
  assert(initial.depots.length === 0, `snapshot initial : ${initial.depots.length} dépôt(s)`);
  assert(initial.counts.depots === 0, `counts.depots initial : ${initial.counts.depots}`);

  const expectDepotEntry = (state, depotId, kind, tile, what) => {
    assert(
      state.counts.depots === state.depots.length,
      `${what} : counts.depots=${state.counts.depots} ≠ ${state.depots.length} entrées`,
    );
    const entry = state.depots.find((depot) => depot.id === depotId);
    assert(entry, `${what} : dépôt ${depotId} absent du snapshot`);
    assert(entry.kind === kind, `${what} : type ${entry.kind} au lieu de ${kind}`);
    assert(
      Number.isInteger(entry.x) && entry.x === tile.x && entry.y === tile.y,
      `${what} : coordonnées (${entry.x}, ${entry.y}) ≠ (${tile.x}, ${tile.y})`,
    );
    assert(entry.company === companyId, `${what} : entreprise ${entry.company} ≠ ${companyId}`);
    assert(
      Number.isInteger(entry.direction) && entry.direction >= 0 && entry.direction <= 3,
      `${what} : direction ${entry.direction}`,
    );
    assert(
      entry.width === 1 && entry.height === 1,
      `${what} : emprise ${entry.width}×${entry.height} au lieu de 1×1`,
    );
    return entry;
  };

  /* --- Zones de construction ------------------------------------------- */
  const roadSite = findFlatArea(initialMap, 8, 4);
  assert(roadSite, 'aucune zone plate 8×4 pour la route');
  const railSite = findFlatArea(initialMap, 8, 4, roadSite);
  assert(railSite, 'aucune seconde zone plate 8×4 pour le rail');

  const replies = [];
  const costs = [];
  const record = (what, reply) => {
    replies.push({ what, reply });
    if (reply.ok && typeof reply.cost === 'number') costs.push(reply.cost);
    return reply;
  };

  /* --- Route, gare routière, dépôt, bus -------------------------------- */
  const roadFrom = { x: roadSite.x + 1, y: roadSite.y };
  const roadTo = { x: roadSite.x + 1 + (ROAD_LENGTH - 1), y: roadSite.y };
  const road = record(
    'route',
    run({ type: 'build', tool: 'road', company: companyId, from: roadFrom, to: roadTo }),
  );
  expectOk(road, 'construction de route');
  assert(road.tiles === ROAD_LENGTH, `route : ${road.tiles} tuiles au lieu de ${ROAD_LENGTH}`);

  const stationTile = { x: roadFrom.x + 2, y: roadFrom.y };
  const roadStation = record(
    'gare routière',
    run({
      type: 'build',
      tool: 'station',
      company: companyId,
      from: stationTile,
      options: { kind: 'bus', direction: 'ne', drive_through: true },
    }),
  );
  expectOk(roadStation, 'gare routière');
  assert(Number.isInteger(roadStation.stationId), 'gare routière : stationId manquant');

  const depotTile = { x: roadFrom.x, y: roadFrom.y + 1 };
  const depot = record(
    'dépôt routier',
    run({
      type: 'build',
      tool: 'depot',
      company: companyId,
      from: depotTile,
      options: { kind: 'road' },
    }),
  );
  expectOk(depot, 'dépôt routier');
  assert(Number.isInteger(depot.depotId), 'dépôt routier : depotId manquant');
  const roadDepotEntry = expectDepotEntry(
    json.read(),
    depot.depotId,
    'road',
    depotTile,
    'dépôt routier',
  );

  const busBuy = record(
    'achat bus',
    run({ type: 'vehicle', action: 'buy', company: companyId, depot: depotTile, model: 'bus' }),
  );
  expectOk(busBuy, 'achat du bus');
  assert(Number.isInteger(busBuy.vehicleId), 'achat du bus : vehicleId manquant');
  assert(
    typeof busBuy.model === 'string' && busBuy.model.length > 0,
    'achat du bus : modèle manquant',
  );

  /* Achat par identifiant de dépôt (le chemin utilisé par l'UI, #90). */
  const busByIdBuy = record(
    'achat bus par depotId',
    run({
      type: 'vehicle',
      action: 'buy',
      company: companyId,
      depotId: depot.depotId,
      model: 'bus',
    }),
  );
  expectOk(busByIdBuy, 'achat du bus par depotId');
  assert(Number.isInteger(busByIdBuy.vehicleId), 'achat par depotId : vehicleId manquant');
  assert(
    busByIdBuy.vehicleId !== busBuy.vehicleId,
    'achat par depotId : identifiant de véhicule réutilisé',
  );
  assert(
    busByIdBuy.depotId === depot.depotId,
    `achat par depotId : dépôt ${busByIdBuy.depotId} au lieu de ${depot.depotId}`,
  );

  const busOrder = record(
    'ordre bus',
    run({
      type: 'vehicle',
      action: 'order',
      company: companyId,
      vehicle: busBuy.vehicleId,
      orders: [{ target: roadStation.stationId, kind: 'station' }],
    }),
  );
  expectOk(busOrder, 'ordre du bus');
  assert(busOrder.orders === 1, `ordre du bus : ${busOrder.orders} ordre(s)`);

  const busStart = record(
    'démarrage bus',
    run({ type: 'vehicle', action: 'start', company: companyId, vehicle: busBuy.vehicleId }),
  );
  expectOk(busStart, 'démarrage du bus');

  /* --- Rail, gare, signal, dépôt, train -------------------------------- */
  const railFrom = { x: railSite.x + 1, y: railSite.y };
  const railTo = { x: railSite.x + 1 + (RAIL_LENGTH - 1), y: railSite.y };
  const rail = record(
    'voie',
    run({ type: 'build', tool: 'rail', company: companyId, from: railFrom, to: railTo }),
  );
  expectOk(rail, 'construction de voie');
  assert(rail.tiles === RAIL_LENGTH, `voie : ${rail.tiles} tuiles au lieu de ${RAIL_LENGTH}`);

  const railStationFrom = { x: railFrom.x + 1, y: railFrom.y };
  const railStationTo = { x: railFrom.x + 3, y: railFrom.y };
  const railStation = record(
    'gare ferroviaire',
    run({
      type: 'build',
      tool: 'station',
      company: companyId,
      from: railStationFrom,
      to: railStationTo,
      options: { kind: 'rail', axis: 'x', platforms: 1 },
    }),
  );
  expectOk(railStation, 'gare ferroviaire');
  assert(Number.isInteger(railStation.stationId), 'gare ferroviaire : stationId manquant');

  const signalTile = { x: railTo.x, y: railTo.y };
  const signal = record(
    'signal',
    run({
      type: 'build',
      tool: 'signal',
      company: companyId,
      from: signalTile,
      options: { type: 'block' },
    }),
  );
  expectOk(signal, 'signal de bloc');
  assert(signal.tiles === 1, `signal : ${signal.tiles} tuile(s)`);

  const railDepotTile = { x: railFrom.x, y: railFrom.y + 1 };
  const railDepot = record(
    'dépôt ferroviaire',
    run({
      type: 'build',
      tool: 'depot',
      company: companyId,
      from: railDepotTile,
      options: { kind: 'rail' },
    }),
  );
  expectOk(railDepot, 'dépôt ferroviaire');
  assert(Number.isInteger(railDepot.depotId), 'dépôt ferroviaire : depotId manquant');
  const railDepotEntry = expectDepotEntry(
    json.read(),
    railDepot.depotId,
    'rail',
    railDepotTile,
    'dépôt ferroviaire',
  );
  assert(
    roadDepotEntry.id !== railDepotEntry.id,
    `dépôts routier et ferroviaire : id ${roadDepotEntry.id} réutilisé`,
  );

  const trainBuy = record(
    'achat train',
    run({
      type: 'vehicle',
      action: 'buy',
      company: companyId,
      depot: railDepotTile,
      model: 'train',
    }),
  );
  expectOk(trainBuy, 'achat du train');
  assert(Number.isInteger(trainBuy.vehicleId), 'achat du train : vehicleId manquant');

  const trainOrder = record(
    'ordre train',
    run({
      type: 'vehicle',
      action: 'order',
      company: companyId,
      vehicle: trainBuy.vehicleId,
      orders: [{ target: railStation.stationId, kind: 'station' }],
    }),
  );
  expectOk(trainOrder, 'ordre du train');

  const trainStart = record(
    'démarrage train',
    run({ type: 'vehicle', action: 'start', company: companyId, vehicle: trainBuy.vehicleId }),
  );
  expectOk(trainStart, 'démarrage du train');

  /* --- Démolition ------------------------------------------------------ */
  const stubTile = { x: roadSite.x + 6, y: roadSite.y + 3 };
  const stub = record(
    'route isolée',
    run({ type: 'build', tool: 'road', company: companyId, from: stubTile }),
  );
  expectOk(stub, 'route isolée');
  assert(stub.tiles === 1, `route isolée : ${stub.tiles} tuile(s)`);

  const cleared = record(
    'démolition',
    run({ type: 'build', tool: 'clear', company: companyId, from: stubTile }),
  );
  expectOk(cleared, 'démolition');
  assert(cleared.tiles === 1, `démolition : ${cleared.tiles} tuile(s)`);
  const clearedMap = map.read();
  const stubIndex = stubTile.y * clearedMap.header.width + stubTile.x;
  assert(
    clearedMap.layers.kind[stubIndex] === TILE_KIND.grass,
    `démolition : type ${clearedMap.layers.kind[stubIndex]} au lieu d'herbe`,
  );

  /* --- Arrêt et vente d'un véhicule ------------------------------------ */
  const spareBuy = record(
    'achat bus jetable',
    run({ type: 'vehicle', action: 'buy', company: companyId, depot: depotTile, model: 'bus' }),
  );
  expectOk(spareBuy, 'achat du bus jetable');

  const spareOrder = record(
    'ordres bus jetable',
    run({
      type: 'vehicle',
      action: 'order',
      company: companyId,
      vehicle: spareBuy.vehicleId,
      orders: [
        { target: roadStation.stationId, kind: 'station' },
        { target: depot.depotId, kind: 'depot' },
      ],
    }),
  );
  expectOk(spareOrder, 'ordres du bus jetable');
  assert(spareOrder.orders === 2, `ordres du bus jetable : ${spareOrder.orders} ordre(s)`);

  expectOk(
    record(
      'démarrage bus jetable',
      run({ type: 'vehicle', action: 'start', company: companyId, vehicle: spareBuy.vehicleId }),
    ),
    'démarrage du bus jetable',
  );
  expectOk(
    record(
      'arrêt bus jetable',
      run({ type: 'vehicle', action: 'stop', company: companyId, vehicle: spareBuy.vehicleId }),
    ),
    'arrêt du bus jetable',
  );
  const stoppedState = json.read();
  const spare = stoppedState.vehicles.find((entry) => entry.id === spareBuy.vehicleId);
  assert(spare, 'bus jetable absent après arrêt');
  assert(spare.status === 0, `bus jetable : statut ${spare.status} après arrêt`);

  expectOk(
    record(
      'vente bus jetable',
      run({ type: 'vehicle', action: 'sell', company: companyId, vehicle: spareBuy.vehicleId }),
    ),
    'vente du bus jetable',
  );
  const afterSell = json.read();
  assert(
    !afterSell.vehicles.some((entry) => entry.id === spareBuy.vehicleId),
    'bus jetable toujours présent après vente',
  );

  /* --- Cycle de vie d'un dépôt dédié ----------------------------------- */
  /* Dépôt isolé dans la zone plate déjà repérée : construit, exposé dans le
   * snapshot, puis démoli. Il ne gêne ni le bus ni le train du scénario. */
  const tempDepotTile = { x: roadSite.x + 6, y: roadSite.y + 2 };
  const tempDepot = record(
    'dépôt temporaire',
    run({
      type: 'build',
      tool: 'depot',
      company: companyId,
      from: tempDepotTile,
      options: { kind: 'road' },
    }),
  );
  expectOk(tempDepot, 'dépôt temporaire');
  const afterTempBuild = json.read();
  const tempDepotEntry = expectDepotEntry(
    afterTempBuild,
    tempDepot.depotId,
    'road',
    tempDepotTile,
    'dépôt temporaire',
  );
  assert(
    tempDepotEntry.id !== depot.depotId && tempDepotEntry.id !== railDepot.depotId,
    `dépôt temporaire : id ${tempDepotEntry.id} réutilisé`,
  );
  assert(
    afterTempBuild.counts.depots === 3,
    `dépôts après construction : ${afterTempBuild.counts.depots} au lieu de 3`,
  );

  expectOk(
    record(
      'démolition du dépôt temporaire',
      run({ type: 'build', tool: 'clear', company: companyId, from: tempDepotTile }),
    ),
    'démolition du dépôt temporaire',
  );
  const afterTempClear = json.read();
  assert(
    !afterTempClear.depots.some((entry) => entry.id === tempDepot.depotId),
    `dépôt ${tempDepot.depotId} toujours présent après démolition`,
  );
  assert(
    afterTempClear.counts.depots === 2,
    `dépôts après démolition : ${afterTempClear.counts.depots} au lieu de 2`,
  );
  assert(
    afterTempClear.counts.depots === afterTempClear.depots.length,
    'counts.depots incohérent après démolition',
  );

  /* --- Comptabilité immédiate ------------------------------------------ */
  const afterBuild = json.read();
  const moneyAfterBuild = localCompany(afterBuild).money;
  const totalCost = costs.reduce((total, cost) => total + cost, 0);
  assert(
    moneyBefore - moneyAfterBuild === totalCost,
    `trésorerie : ${moneyBefore - moneyAfterBuild} débités pour ${totalCost} annoncés`,
  );

  /* --- Commandes invalides : erreur propre, état inchangé -------------- */
  const hashBeforeInvalid = hashHex(api.engine);
  const water = findWaterWithLandNeighbour(initialMap);
  assert(water, 'aucune tuile d’eau avec un voisin de terre');
  const unknownDepotId = 4000;
  assert(
    !afterTempClear.depots.some((entry) => entry.id === unknownDepotId),
    `dépôt ${unknownDepotId} déjà utilisé : choisir un autre identifiant inconnu`,
  );

  const invalidCases = [
    ['JSON tronqué', '{', 2],
    ['outil inconnu', { type: 'build', tool: 'inconnu', from: roadFrom }, 3],
    ['hors carte', { type: 'build', tool: 'road', from: { x: -1, y: roadFrom.y } }, 4],
    ['pont non supporté', { type: 'build', tool: 'bridge', from: roadFrom, to: roadTo }, 8],
    [
      'rail sur route',
      { type: 'build', tool: 'rail', from: roadFrom, to: { x: roadFrom.x + 1, y: roadFrom.y } },
      6,
    ],
    [
      'route sur eau',
      {
        type: 'build',
        tool: 'road',
        from: { x: water.land.x, y: water.land.y },
        to: { x: water.water.x, y: water.water.y },
      },
      6,
    ],
    ['achat hors dépôt', { type: 'vehicle', action: 'buy', depot: roadFrom, model: 'bus' }, 6],
    [
      'achat avec dépôt inconnu',
      { type: 'vehicle', action: 'buy', depotId: unknownDepotId, model: 'bus' },
      6,
    ],
    [
      'achat avec dépôt incompatible',
      { type: 'vehicle', action: 'buy', depotId: railDepot.depotId, model: 'bus' },
      6,
    ],
    [
      'ordre vers dépôt inconnu',
      {
        type: 'vehicle',
        action: 'order',
        vehicle: busBuy.vehicleId,
        orders: [{ target: unknownDepotId, kind: 'depot' }],
      },
      6,
    ],
    [
      'refit non supporté',
      { type: 'vehicle', action: 'refit', vehicle: busBuy.vehicleId, model: 'mail' },
      8,
    ],
    [
      'entreprise inconnue',
      { type: 'build', tool: 'road', company: 14, from: { x: roadSite.x, y: roadSite.y + 3 } },
      5,
    ],
  ];

  for (const [what, command, status] of invalidCases) {
    const reply = run(command);
    expectFailure(reply, status, what);
  }

  const hashAfterInvalid = hashHex(api.engine);
  assert(
    hashBeforeInvalid === hashAfterInvalid,
    `état modifié par une commande invalide (${hashBeforeInvalid} ≠ ${hashAfterInvalid})`,
  );

  /* --- Simulation ------------------------------------------------------- */
  const stepped = api.step(SETTLE_TICKS);
  assert(stepped === SETTLE_TICKS, `ottd_step(${SETTLE_TICKS}) = ${stepped} : ${readError(api)}`);

  const finalState = json.read();
  const finalMap = map.read();
  assert(
    finalState.meta.tick === finalMap.header.tick,
    `tick JSON ${finalState.meta.tick} ≠ tick carte ${finalMap.header.tick}`,
  );
  const finalHash = hashHex(api.engine);

  const roadTiles = countKind(finalMap, TILE_KIND.road) - countKind(initialMap, TILE_KIND.road);
  const railTiles = countKind(finalMap, TILE_KIND.rail) - countKind(initialMap, TILE_KIND.rail);
  const stationTiles =
    countKind(finalMap, TILE_KIND.station) - countKind(initialMap, TILE_KIND.station);

  assert(roadTiles >= ROAD_LENGTH, `route : ${roadTiles} nouvelles tuiles`);
  assert(railTiles >= 2, `rail : ${railTiles} nouvelles tuiles`);
  assert(stationTiles >= 4, `gares : ${stationTiles} nouvelles tuiles`);

  const signalIndex = signalTile.y * finalMap.header.width + signalTile.x;
  assert(
    (finalMap.layers.flags[signalIndex] & TILE_FLAG_SIGNAL) !== 0,
    'signal : drapeau SIGNAL absent du snapshot carte',
  );
  assert(
    finalMap.layers.owner[signalIndex] === companyId,
    'signal : tuile non possédée par l’entreprise locale',
  );

  const stations = finalState.stations.filter((entry) => entry.company === companyId);
  const stationIds = new Set(stations.map((entry) => entry.id));
  assert(stationIds.has(roadStation.stationId), 'gare routière absente du snapshot');
  assert(stationIds.has(railStation.stationId), 'gare ferroviaire absente du snapshot');
  assert(
    stations.some((entry) => entry.kind === 'road'),
    'aucune gare routière dans le snapshot',
  );
  assert(
    stations.some((entry) => entry.kind === 'train'),
    'aucune gare ferroviaire dans le snapshot',
  );

  const vehicles = finalState.vehicles.filter((entry) => entry.company === companyId);
  const bus = vehicles.find((entry) => entry.id === busBuy.vehicleId);
  const busById = vehicles.find((entry) => entry.id === busByIdBuy.vehicleId);
  const train = vehicles.find((entry) => entry.id === trainBuy.vehicleId);
  assert(bus, 'bus absent du snapshot');
  assert(busById, 'bus acheté par depotId absent du snapshot');
  assert(train, 'train absent du snapshot');
  assert(bus.kind === 'road', `bus : type ${bus.kind}`);
  assert(busById.kind === 'road', `bus par depotId : type ${busById.kind}`);
  assert(train.kind === 'train', `train : type ${train.kind}`);
  assert(bus.status !== 0, 'bus : toujours arrêté après démarrage');
  assert(bus.orderTargets.includes(roadStation.stationId), 'bus : ordre vers la gare absent');
  assert(train.orderTargets.includes(railStation.stationId), 'train : ordre vers la gare absent');

  /* Dépôts : ids et coordonnées stables après 200 ticks. */
  assert(
    finalState.counts.depots === 2,
    `dépôts après simulation : ${finalState.counts.depots} au lieu de 2`,
  );
  assert(
    finalState.counts.depots === finalState.depots.length,
    'counts.depots incohérent après simulation',
  );
  const finalRoadDepot = expectDepotEntry(
    finalState,
    depot.depotId,
    'road',
    depotTile,
    'dépôt routier après simulation',
  );
  const finalRailDepot = expectDepotEntry(
    finalState,
    railDepot.depotId,
    'rail',
    railDepotTile,
    'dépôt ferroviaire après simulation',
  );
  const depotSignature = (entry) =>
    JSON.stringify([entry.id, entry.kind, entry.x, entry.y, entry.direction, entry.company]);
  assert(
    depotSignature(finalRoadDepot) === depotSignature(roadDepotEntry),
    `id/coordonnées du dépôt routier instables : ${depotSignature(roadDepotEntry)} → ${depotSignature(finalRoadDepot)}`,
  );
  assert(
    depotSignature(finalRailDepot) === depotSignature(railDepotEntry),
    `id/coordonnées du dépôt ferroviaire instables : ${depotSignature(railDepotEntry)} → ${depotSignature(finalRailDepot)}`,
  );

  const moneyAfter = localCompany(finalState).money;
  assert(moneyAfter < moneyBefore, `trésorerie inchangée (${moneyBefore} → ${moneyAfter})`);
  assert(
    localCompany(finalState).vehicles >= 2,
    'compteur véhicules de l’entreprise locale incohérent',
  );
  assert(
    localCompany(finalState).stations >= 2,
    'compteur gares de l’entreprise locale incohérent',
  );

  const summary = {
    label,
    hash: finalHash,
    tick: finalState.meta.tick,
    companyId,
    moneyBefore,
    moneyAfterBuild,
    moneyAfter,
    totalCost,
    roadSite,
    railSite,
    ids: {
      bus: busBuy.vehicleId,
      busById: busByIdBuy.vehicleId,
      train: trainBuy.vehicleId,
      roadStation: roadStation.stationId,
      railStation: railStation.stationId,
      roadDepot: depot.depotId,
      railDepot: railDepot.depotId,
      tempDepot: tempDepot.depotId,
    },
    counts: {
      stations: stations.length,
      depots: finalState.depots.length,
      vehicles: vehicles.length,
      roadTiles,
      railTiles,
      stationTiles,
    },
    mapDigest: digest(finalMap.layers.kind),
    hashBeforeInvalid,
    models: { bus: busBuy.model, train: trainBuy.model },
  };

  assertNoBackupWarnings(
    [...diagnostics.stdout, ...diagnostics.stderr],
    `${label} : scénario complet`,
  );

  replies.length = 0;
  json.free();
  map.free();
  api.engine._ottd_shutdown();
  return summary;
}

log(`Module   : ${MODULE_PATH}`);
log(
  `Scénario : seed ${SEED}, ${MAP_SIZE}×${MAP_SIZE}, sans IA, ${SETTLE_TICKS} ticks après commandes\n`,
);

const first = await runScenario('run-1');
log(
  `[run-1] ${first.counts.roadTiles} tuiles de route, ${first.counts.railTiles} de rail, ` +
    `${first.counts.stationTiles} de gare`,
);
log(
  `[run-1] ${first.counts.stations} gares, ${first.counts.depots} dépôts, ` +
    `${first.counts.vehicles} véhicules (${first.models.bus} / ${first.models.train})`,
);
log(
  `[run-1] trésorerie ${first.moneyBefore} → ${first.moneyAfterBuild} (coût ${first.totalCost}) ` +
    `→ ${first.moneyAfter}`,
);
log(
  `[run-1] gares ${first.ids.roadStation}/${first.ids.railStation}, ` +
    `dépôts ${first.ids.roadDepot}/${first.ids.railDepot}, ` +
    `véhicules ${first.ids.bus}/${first.ids.busById}/${first.ids.train}`,
);
log(`[run-1] hash ${first.hash} (carte ${first.mapDigest})`);

assert(
  first.hash === REFERENCE_HASH,
  `hash de référence : ${first.hash} ≠ ${REFERENCE_HASH} (mettez à jour REFERENCE_HASH consciemment)`,
);

/* --- Déterminisme : même journal, même résultat ------------------------- */
const second = await runScenario('run-2');
assert(second.hash === first.hash, `déterminisme rompu : ${first.hash} ≠ ${second.hash}`);
assert(second.mapDigest === first.mapDigest, 'carte différente pour le même journal');
assert(
  JSON.stringify(second.ids) === JSON.stringify(first.ids),
  `identifiants différents : ${JSON.stringify(first.ids)} ≠ ${JSON.stringify(second.ids)}`,
);
assert(
  second.moneyAfter === first.moneyAfter &&
    second.totalCost === first.totalCost &&
    second.counts.vehicles === first.counts.vehicles &&
    second.counts.stations === first.counts.stations,
  'compteurs ou trésorerie différents pour le même journal',
);
log(`[run-2] hash ${second.hash}, identifiants et trésorerie identiques.`);

log('\n✅ Commandes de construction et de véhicules reproductibles (#11).');
