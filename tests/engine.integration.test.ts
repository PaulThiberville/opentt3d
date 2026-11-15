/**
 * Test d'intégration **optionnel** du moteur OpenTTD réel.
 *
 * Il ne s'exécute que si les artefacts WASM sont présents dans
 * `public/engine/` (build local via `npm run engine:build`, artefacts
 * gitignorés). Sinon la suite est simplement ignorée : la CI sans build moteur
 * reste verte.
 *
 * Node ne fournit pas `window` ni `require('fs')` au chargeur `.data` généré :
 * on injecte donc une fabrique Emscripten dédiée, comme le fait
 * `engine/scripts/smoke.mjs`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EmscriptenModuleFactory, EmscriptenModuleOptions } from '../src/engine/loadEngine';
import { WasmEngine } from '../src/engine/WasmEngine';
import { PROTOCOL_VERSION, TILE_FLAG, TILE_KIND_INDEX } from '../src/engine/protocol';
import type { MapSnapshot } from '../src/engine/protocol';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = path.join(ROOT, 'public', 'engine');
const MODULE_PATH = path.join(ENGINE_DIR, 'opentt3d-engine.js');

const ARTIFACTS_AVAILABLE =
  existsSync(MODULE_PATH) &&
  existsSync(path.join(ENGINE_DIR, 'opentt3d-engine.wasm')) &&
  existsSync(path.join(ENGINE_DIR, 'opentt3d-engine.data'));

const suite = ARTIFACTS_AVAILABLE ? describe : describe.skip;

/** Fabrique Node : locateFile + paquet `.data` + shim `window`. */
async function createNodeFactory(): Promise<EmscriptenModuleFactory> {
  const imported = (await import(/* @vite-ignore */ pathToFileURL(MODULE_PATH).href)) as {
    default?: EmscriptenModuleFactory;
    createOpenTT3DEngine?: EmscriptenModuleFactory;
  };
  const base = imported.default ?? imported.createOpenTT3DEngine;
  if (!base) throw new Error('opentt3d-engine.js n’exporte pas de fabrique.');

  return async (options: EmscriptenModuleOptions = {}) => {
    const engine = await base({
      ...options,
      locateFile: (file: string) => path.join(ENGINE_DIR, path.basename(file)),
      getPreloadedPackage: (name: string) => {
        const data = readFileSync(path.join(ENGINE_DIR, path.basename(name)));
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
    });
    setupWindowShim();
    return engine;
  };
}

function setupWindowShim(): void {
  const scope = globalThis as unknown as { window?: Record<string, unknown>; crypto?: Crypto };
  if (scope.window) return;
  // OpenTTD lit `window.crypto` pour l'entropie et le chargeur `.data` lit
  // `location.pathname` / `encodeURIComponent`.
  scope.window = {
    crypto: scope.crypto,
    encodeURIComponent,
    location: { pathname: '/' },
  };
}

/** Zone rectangulaire d'herbe plate, sans eau, pour bâtir route + dépôt. */
function findFlatArea(
  map: MapSnapshot,
  width: number,
  height: number,
): { x: number; y: number } | null {
  for (let y = 1; y + height < map.height; y += 1) {
    for (let x = 1; x + width < map.width; x += 1) {
      const base = map.heightMap[y * map.width + x];
      let ok = true;
      for (let dy = 0; dy < height && ok; dy += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          const index = (y + dy) * map.width + x + dx;
          if (
            map.kind[index] !== TILE_KIND_INDEX.grass ||
            map.slope[index] !== 0 ||
            ((map.flags[index] ?? 0) & TILE_FLAG.WATER) !== 0 ||
            map.heightMap[index] !== base
          ) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  return null;
}

suite('intégration moteur WASM réel', () => {
  it('boot, nouvelle partie 128×128, snapshot, step', async () => {
    const engine = new WasmEngine({ factory: await createNodeFactory() });
    try {
      await engine.init({ moduleUrl: pathToFileURL(MODULE_PATH).href });
      expect(engine.status().ready).toBe(true);
      expect(engine.memorySize).toBeGreaterThan(0);

      await engine.newGame({ seed: 42, width: 128, height: 128 });
      const first = engine.snapshot();
      expect(first.meta.protocol).toBe(PROTOCOL_VERSION);
      expect(first.economy.year).toBeGreaterThanOrEqual(1950);
      expect(first.map).not.toBeNull();
      expect(first.map?.width).toBe(128);
      expect(first.map?.kind).toHaveLength(128 * 128);
      expect(first.towns.length).toBeGreaterThan(0);
      expect(first.industries.length).toBeGreaterThan(0);
      // Une partie neuve headless crée une entreprise locale (aucune IA, #60).
      expect(first.companies.some((company) => company.isLocal)).toBe(true);
      expect(engine.hash()).toMatch(/^0x[0-9a-f]{16}$/);

      const tickBefore = first.meta.tick;
      expect(engine.step(100)).toBe(100);
      const second = engine.snapshot();
      expect(second.meta.tick).toBe(tickBefore + 100);
      expect(second.map?.kind).toHaveLength(128 * 128);
    } finally {
      engine.dispose();
    }
  }, 120_000);

  it('construit une route réelle via ottd_command', async () => {
    const engine = new WasmEngine({ factory: await createNodeFactory() });
    try {
      await engine.init({ moduleUrl: pathToFileURL(MODULE_PATH).href });
      await engine.newGame({ seed: 42, width: 128, height: 128 });
      const first = engine.snapshot();
      const map = first.map;
      if (!map) throw new Error('carte absente');

      let start: { x: number; y: number } | null = null;
      for (let y = 0; y < map.height - 1 && !start; y += 1) {
        for (let x = 0; x < map.width - 3; x += 1) {
          const indexes = [0, 1, 2].map((dx) => y * map.width + x + dx);
          const ok = indexes.every((index) => {
            return (
              map.kind[index] === TILE_KIND_INDEX.grass &&
              ((map.flags[index] ?? 0) & TILE_FLAG.WATER) === 0 &&
              map.heightMap[index] === map.heightMap[indexes[0] ?? 0]
            );
          });
          if (ok) {
            start = { x, y };
            break;
          }
        }
      }
      if (!start) throw new Error('aucune zone de 3 tuiles d’herbe plate trouvée');
      const company = first.companies.find((item) => item.isLocal)?.id ?? 0;
      engine.send({
        type: 'build',
        tool: 'road',
        company,
        from: start,
        to: { x: start.x + 2, y: start.y },
        options: { axis: 'x' },
      });

      const after = engine.snapshot();
      const kinds = [0, 1, 2].map((dx) => after.map?.kind[start.y * map.width + start.x + dx]);
      expect(kinds).toEqual([TILE_KIND_INDEX.road, TILE_KIND_INDEX.road, TILE_KIND_INDEX.road]);
      expect(after.news.some((item) => /Route/i.test(item.text))).toBe(true);
    } finally {
      engine.dispose();
    }
  }, 120_000);

  it('expose les dépôts réels et achète un bus par depotId', async () => {
    const engine = new WasmEngine({ factory: await createNodeFactory() });
    try {
      await engine.init({ moduleUrl: pathToFileURL(MODULE_PATH).href });
      await engine.newGame({ seed: 42, width: 128, height: 128 });
      const first = engine.snapshot();
      expect(Array.isArray(first.depots)).toBe(true);
      expect(first.depots).toHaveLength(0);

      const map = first.map;
      if (!map) throw new Error('carte absente');
      const site = findFlatArea(map, 8, 4);
      if (!site) throw new Error('aucune zone plate 8×4 trouvée');
      const company = first.companies.find((item) => item.isLocal)?.id ?? 0;

      const roadFrom = { x: site.x + 1, y: site.y };
      engine.send({
        type: 'build',
        tool: 'road',
        company,
        from: roadFrom,
        to: { x: roadFrom.x + 3, y: roadFrom.y },
        options: { axis: 'x' },
      });
      const depotTile = { x: roadFrom.x, y: roadFrom.y + 1 };
      engine.send({
        type: 'build',
        tool: 'depot',
        company,
        from: depotTile,
        options: { kind: 'road' },
      });

      const built = engine.snapshot();
      expect(built.news.some((item) => /Dépôt routier/i.test(item.text))).toBe(true);
      expect(built.depots.length).toBe(1);
      const depot = built.depots[0];
      if (!depot) throw new Error('dépôt attendu dans le snapshot');
      expect(depot.kind).toBe('road');
      expect(depot.company).toBe(company);
      expect(depot.x).toBe(depotTile.x);
      expect(depot.y).toBe(depotTile.y);
      expect(depot.direction).toBeGreaterThanOrEqual(0);
      expect(depot.direction).toBeLessThanOrEqual(3);

      engine.send({
        type: 'vehicle',
        action: 'buy',
        company,
        depotId: depot.id,
        model: 'bus',
      });
      const bought = engine.snapshot();
      expect(bought.news.some((item) => /Véhicule acheté/i.test(item.text))).toBe(true);
      const bus = bought.vehicles.find((item) => item.kind === 'road');
      if (!bus) throw new Error('bus acheté attendu dans le snapshot');

      engine.send({
        type: 'vehicle',
        action: 'order',
        company,
        vehicle: bus.id,
        orders: [{ target: depot.id, kind: 'depot' }],
      });
      const ordered = engine.snapshot();
      expect(ordered.news.some((item) => /ordre\(s\) ajouté\(s\)/i.test(item.text))).toBe(true);

      engine.send({
        type: 'vehicle',
        action: 'buy',
        company,
        depotId: 60_000,
        model: 'bus',
      });
      const unknown = engine.snapshot();
      expect(unknown.news.some((item) => /Dépôt 60000 inexistant/i.test(item.text))).toBe(true);
    } finally {
      engine.dispose();
    }
  }, 120_000);

  it('sauvegarde et recharge l’état réel', async () => {
    const first = new WasmEngine({ factory: await createNodeFactory() });
    const second = new WasmEngine({ factory: await createNodeFactory() });
    try {
      await first.init({ moduleUrl: pathToFileURL(MODULE_PATH).href });
      await first.newGame({ seed: 42, width: 128, height: 128 });
      first.step(100);
      const hash = first.hash();
      const tick = first.status().tick;
      const saved = await first.save();
      expect(saved.length).toBeGreaterThan(1000);

      await second.init({ moduleUrl: pathToFileURL(MODULE_PATH).href });
      await second.load(saved);
      expect(second.hash()).toBe(hash);
      expect(second.status().tick).toBe(tick);

      first.step(100);
      second.step(100);
      expect(second.hash()).toBe(first.hash());
    } finally {
      first.dispose();
      second.dispose();
    }
  }, 120_000);
});
