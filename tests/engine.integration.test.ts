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
import { PROTOCOL_VERSION } from '../src/engine/protocol';

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
});
