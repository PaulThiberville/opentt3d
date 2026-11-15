/**
 * Fabrique Emscripten Node pour les tests d'intégration du moteur réel.
 *
 * Node ne fournit ni `window` ni `require('fs')` au chargeur `.data` généré :
 * on injecte `locateFile` + `getPreloadedPackage` et un shim `window`, comme
 * le font `engine/scripts/smoke.mjs` et les tests existants.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EmscriptenModuleFactory, EmscriptenModuleOptions } from '../../src/engine/loadEngine';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENGINE_DIR = path.join(ROOT, 'public', 'engine');
export const ENGINE_MODULE_PATH = path.join(ENGINE_DIR, 'opentt3d-engine.js');

/** Les artefacts sont gitignorés : la suite est ignorée quand ils manquent. */
export const ARTIFACTS_AVAILABLE =
  existsSync(ENGINE_MODULE_PATH) &&
  existsSync(path.join(ENGINE_DIR, 'opentt3d-engine.wasm')) &&
  existsSync(path.join(ENGINE_DIR, 'opentt3d-engine.data'));

function setupWindowShim(): void {
  const scope = globalThis as unknown as { window?: Record<string, unknown>; crypto?: Crypto };
  if (scope.window) return;
  scope.window = {
    crypto: scope.crypto,
    encodeURIComponent,
    location: { pathname: '/' },
  };
}

/** Fabrique un module Emscripten réel servi depuis `public/engine/`. */
export async function createNodeEngineFactory(): Promise<EmscriptenModuleFactory> {
  const imported = (await import(/* @vite-ignore */ pathToFileURL(ENGINE_MODULE_PATH).href)) as {
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
