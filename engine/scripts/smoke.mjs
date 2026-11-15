#!/usr/bin/env node
/**
 * Smoke test du moteur OpenTT3D compilé en WebAssembly.
 *
 * Charge le module sous Node, boote OpenTTD, démarre une partie seed 42 en
 * 128×128, avance 2000 ticks, affiche l'état, puis rejoue une seconde instance
 * et compare les hashs (déterminisme).
 *
 * Usage : node engine/scripts/smoke.mjs [--verbose]
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
const TICKS = 2000;

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
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
    // Les fichiers .wasm/.data sont copiés à côté du .js.
    locateFile: (file) => path.join(ARTIFACT_DIR, file),
    // Emscripten 3.1.57 : le chargeur de paquet .data généré utilise
    // `require('fs')`, indisponible en portée ESM sous Node. On fournit donc
    // le paquet nous-mêmes ; le navigateur continue d'utiliser fetch.
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
  // OpenTTD utilise `window.crypto` pour l'entropie (identifiant de partie).
  // On fournit un window minimal APRÈS l'instanciation : sinon Emscripten
  // croirait être dans un navigateur pendant l'initialisation. Node 19+
  // expose crypto ; location/encodeURIComponent servent au chargeur .data.
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
    step: engine.cwrap('ottd_step', 'number', ['number']),
    lastError: engine.cwrap('ottd_last_error', 'string', []),
  };
}

function readError(api) {
  const message = api.lastError();
  return message && message.length > 0 ? message : '(aucune erreur exposée)';
}

function snapshot(engine) {
  const capacity = 1024;
  const pointer = engine._malloc(capacity);
  try {
    const required = engine._ottd_snapshot_json(pointer, capacity);
    if (required <= 0) fail(`ottd_snapshot_json a retourné ${required}`);
    if (required > capacity) fail(`snapshot trop grand : ${required} octets`);
    return JSON.parse(engine.UTF8ToString(pointer));
  } finally {
    engine._free(pointer);
  }
}

function hashHex(engine) {
  const hash = engine._ottd_hash();
  return `0x${BigInt.asUintN(64, BigInt(hash)).toString(16).padStart(16, '0')}`;
}

/** Pompe jusqu'à ce que la carte demandée soit prête (génération synchrone). */
function waitForMap(api, width, height) {
  for (let i = 0; i < 1000; i++) {
    const state = snapshot(api.engine);
    if (state.map.width === width && state.map.height === height) return state;
    if (api.step(1) !== 1) fail(`la pompe s'est arrêtée : ${readError(api)}`);
  }
  return fail(`la carte ${width}×${height} n'est jamais devenue disponible`);
}

async function run(label) {
  const started = Date.now();
  const api = wrap(await createInstance(label));

  const boot = api.boot();
  if (boot !== 0) fail(`ottd_boot() = ${boot} : ${readError(api)}`);
  log(`[${label}] boot OK`);

  const created = api.newGame(SEED, MAP_SIZE, MAP_SIZE);
  if (created !== 0) fail(`ottd_new_game() = ${created} : ${readError(api)}`);

  const initial = waitForMap(api, MAP_SIZE, MAP_SIZE);
  log(
    `[${label}] carte ${initial.map.width}×${initial.map.height} générée ` +
      `(tick ${initial.tick}, ${initial.towns} villes, ${initial.industries} industries)`,
  );

  const tickBeforeZeroStep = api.engine._ottd_tick();
  const zero = api.step(0);
  const tickAfterZeroStep = api.engine._ottd_tick();
  if (zero !== 0 || tickBeforeZeroStep !== tickAfterZeroStep) {
    fail(`ottd_step(0) doit être un no-op (retour ${zero}, tick ${tickBeforeZeroStep}→${tickAfterZeroStep})`);
  }

  // Contrat : un buffer trop petit renvoie la taille requise et n'écrit rien.
  const tiny = api.engine._malloc(8);
  try {
    const required = api.engine._ottd_snapshot_json(tiny, 8);
    if (required <= 8 || api.engine.UTF8ToString(tiny) !== '') {
      fail(`ottd_snapshot_json(8) devrait renvoyer une taille > 8 et un buffer vide (reçu ${required})`);
    }
  } finally {
    api.engine._free(tiny);
  }

  const stepStart = Date.now();
  const executed = api.step(TICKS);
  const stepMs = Date.now() - stepStart;
  if (executed !== TICKS) fail(`ottd_step(${TICKS}) = ${executed} : ${readError(api)}`);

  const state = snapshot(api.engine);
  const hash = hashHex(api.engine);
  const elapsed = Date.now() - started;

  log(
    `[${label}] ${executed} ticks en ${stepMs} ms ` +
      `(${((TICKS / stepMs) * 1000).toFixed(1)} ticks/s)`,
  );
  log(
    `[${label}] tick=${state.tick} date=${state.date.day}/${state.date.month + 1}/${state.date.year} ` +
      `entreprises=${state.companies} villes=${state.towns} véhicules=${state.vehicles} ` +
      `gares=${state.stations} industries=${state.industries}`,
  );
  log(`[${label}] hash=${hash} (total ${elapsed} ms)`);

  return { state, hash, api };
}

log(`Module   : ${MODULE_PATH}`);
log(`Scénario : seed ${SEED}, ${MAP_SIZE}×${MAP_SIZE}, ${TICKS} ticks\n`);

const first = await run('instance-1');
const second = await run('instance-2');

if (first.hash !== second.hash) {
  fail(
    `déterminisme rompu : ${first.hash} ≠ ${second.hash}\n` +
      `  instance-1 : ${JSON.stringify(first.state)}\n` +
      `  instance-2 : ${JSON.stringify(second.state)}`,
  );
}
if (first.state.tick !== second.state.tick) {
  fail(`ticks différents : ${first.state.tick} ≠ ${second.state.tick}`);
}

log(`\n✅ Déterminisme vérifié : ${first.hash} sur deux instances indépendantes.`);

// Test de charge : 10 000 ticks supplémentaires sur la première instance.
const longStart = Date.now();
const longTicks = first.api.step(10_000);
if (longTicks !== 10_000) fail(`ottd_step(10000) = ${longTicks} : ${readError(first.api)}`);
log(`[instance-1] 10 000 ticks supplémentaires en ${Date.now() - longStart} ms (tick ${first.api.engine._ottd_tick()})`);

// Libération explicite : vérifie `ottd_shutdown` et rend la mémoire au système.
first.api.engine._ottd_shutdown();
second.api.engine._ottd_shutdown();
log('✅ ottd_shutdown() OK');
