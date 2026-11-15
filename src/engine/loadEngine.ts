/**
 * Chargement du module OpenTTD compilé en WebAssembly.
 *
 * Le module est un module ES6 autonome (Emscripten `MODULARIZE=1`,
 * `EXPORT_ES6=1`) : `export default createOpenTT3DEngine(options)`. Il est
 * servi comme fichier statique depuis `public/engine/` et **importé
 * dynamiquement à l'exécution**. Aucun import statique ne référence `public/` :
 * un dépôt sans artefacts continue donc de builder et de tourner (le mode mock
 * reste disponible) ; seule une partie WASM échouera, avec un message explicite.
 *
 * Résolution d'URL : on se base sur `document.baseURI` (page courante), ce qui
 * couvre le serveur de dev Vite (`/engine/…`), le build avec `base: './'` et un
 * déploiement GitHub Pages dans un sous-répertoire. `moduleUrl` permet de
 * forcer une autre origine (CDN, tests Node).
 *
 * Mémoire : les artefacts actuels sont compilés avec une mémoire fixe de
 * 32 Mio (aucune option `INITIAL_MEMORY` à l'exécution). `memoryMiB` est donc
 * une exigence vérifiée après instanciation, pas un redimensionnement.
 */

import type { EngineInitOptions } from './protocol';

/** Nom du module Emscripten dans `public/engine/`. */
export const ENGINE_MODULE_FILE = 'opentt3d-engine.js';
/** Dossier statique (relatif à la racine de l'application). */
export const ENGINE_ASSET_DIR = 'engine';

/** Moteurs sélectionnables par l'application (`?engine=`). */
export type EngineMode = 'mock' | 'wasm';
export const ENGINE_MODES: readonly EngineMode[] = ['mock', 'wasm'];

/** Normalise `?engine=` ; renvoie `null` si la valeur est inconnue. */
export function parseEngineMode(value: string | null | undefined): EngineMode | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'mock' || normalized === 'wasm' ? normalized : null;
}

/** Sous-ensemble typé de l'objet `Module` produit par Emscripten. */
export interface EmscriptenModule {
  /** Vue sur la mémoire linéaire ; réaffectée à chaque croissance. */
  HEAPU8: Uint8Array;
  /** Appel direct d'une fonction exportée (`UTF8ToString`, `_malloc`…). */
  UTF8ToString(pointer: number, maxBytesToRead?: number): string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  ccall?(name: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
  cwrap(name: string, returnType: string | null, argTypes: string[]): (...args: number[]) => number;
  stringToUTF8?(text: string, pointer: number, maxBytes: number): void;
  lengthBytesUTF8?(text: string): number;
  /** Pont OpenTT3D (voir `engine/bridge/ottd_bridge.cpp`). */
  _ottd_boot(): number;
  _ottd_new_game(seed: number, width: number, height: number): number;
  _ottd_new_game_ex?(seed: number, width: number, height: number, configPointer: number): number;
  _ottd_set_game_config?(configJson: string): number;
  _ottd_step(ticks: number): number;
  _ottd_tick(): number;
  _ottd_hash(): number | bigint;
  _ottd_snapshot_json(out: number, capacity: number): number;
  _ottd_snapshot_map(out: number, capacity: number): number;
  _ottd_command?(jsonPointer: number, out: number, capacity: number): number;
  _ottd_command_result?(): number;
  _ottd_company_id?(): number;
  _ottd_last_error(): number;
  _ottd_shutdown(): void;
  /** Libération optionnelle du runtime Emscripten. */
  destroy?(): void;
}

/** Options acceptées par la fabrique Emscripten. */
export interface EmscriptenModuleOptions {
  locateFile?(path: string, prefix: string): string;
  getPreloadedPackage?(name: string, size: number): ArrayBuffer | null;
  setStatus?(text: string): void;
  print?(text: string): void;
  printErr?(text: string): void;
  onAbort?(what: unknown): void;
  onExit?(code: number): void;
  noInitialRun?: boolean;
  /** Accepte les options spécifiques d'un build donné. */
  [key: string]: unknown;
}

export type EmscriptenModuleFactory = (
  options?: EmscriptenModuleOptions,
) => Promise<EmscriptenModule>;

export interface EngineLoadOptions extends Partial<EngineInitOptions> {
  /** Fabrique déjà chargée : court-circuite l'import dynamique (tests, embed). */
  factory?: EmscriptenModuleFactory;
  /** Import dynamique injectable (tests, chargeurs alternatifs). */
  importModule?: (url: string) => Promise<unknown>;
}

export interface LoadedEngine {
  module: EmscriptenModule;
  /** URL absolue effectivement utilisée. */
  moduleUrl: string;
  /** Taille de la mémoire linéaire après instanciation, en octets. */
  memoryBytes: number;
  /** Vrai si l'option `memoryMiB` demandée dépasse la mémoire compilée. */
  memoryShortfall: boolean;
}

export type EngineLoadErrorCode =
  'module-missing' | 'module-invalid' | 'instantiation-failed' | 'memory';

/** Erreur de chargement avec un message prêt pour l'UI et une piste de résolution. */
export class EngineLoadError extends Error {
  readonly code: EngineLoadErrorCode;
  readonly url: string;
  readonly hint: string | null;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: { code: EngineLoadErrorCode; url: string; hint?: string | null; cause?: unknown },
  ) {
    super(message);
    this.name = 'EngineLoadError';
    this.code = options.code;
    this.url = options.url;
    this.hint = options.hint ?? null;
    this.cause = options.cause;
  }
}

const BUILD_HINT =
  'Les artefacts WASM sont absents de public/engine/. Lancez `npm run engine:build`, ' +
  'puis rechargez la page (ou utilisez ?engine=mock).';

function baseHref(): string {
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI) {
    return document.baseURI;
  }
  const env = import.meta.env as { BASE_URL?: string } | undefined;
  const base = env?.BASE_URL && env.BASE_URL.length > 0 ? env.BASE_URL : './';
  if (typeof location !== 'undefined' && typeof location.href === 'string' && location.href) {
    return new URL(base, location.href).href;
  }
  // Node : les chunks du build vivent dans assets/, la racine est un niveau
  // au-dessus. Les tests passent de toute façon une `moduleUrl` explicite.
  const here: string = import.meta.url;
  return new URL('../', here).href;
}

/**
 * URL absolue du module. `moduleUrl` explicite est résolu par rapport à la
 * page (ou à la racine de l'application si absent).
 */
export function resolveEngineModuleUrl(moduleUrl?: string): string {
  const base = baseHref();
  if (typeof moduleUrl === 'string' && moduleUrl.trim() !== '') {
    try {
      return new URL(moduleUrl, base).href;
    } catch {
      return moduleUrl;
    }
  }
  return new URL(`${ENGINE_ASSET_DIR}/${ENGINE_MODULE_FILE}`, base).href;
}

/**
 * Message lisible pour une valeur jetée arbitraire (Emscripten jette parfois
 * `ExitStatus` ou des objets, pas toujours des `Error`).
 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : null;
    const message = typeof record.message === 'string' ? record.message : null;
    if (message) return name ? `${name}: ${message}` : message;
    if (name === 'ExitStatus' && typeof record.status === 'number') {
      return `Le runtime WebAssembly s’est arrêté (code ${record.status}).`;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // Boucle circulaire : repli sur String().
    }
  }
  return String(error);
}

/** Répertoire du module, pour résoudre `.wasm` et `.data` côté navigateur. */
function moduleDirectory(moduleUrl: string): string | null {
  try {
    return new URL('.', moduleUrl).href;
  } catch {
    return null;
  }
}

/** Vérifie tôt (HTTP) que le module est accessible, pour un message clair en 404. */
async function assertReachable(url: string): Promise<void> {
  if (!/^https?:/i.test(url) || typeof fetch !== 'function') return;
  let response: Response;
  try {
    response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  } catch {
    // Réseau indisponible : l'import dynamique donnera l'erreur détaillée.
    return;
  }
  if (response.ok || response.status === 405 || response.status === 501) return;
  throw new EngineLoadError(`Module moteur introuvable (HTTP ${response.status}) : ${url}`, {
    code: 'module-missing',
    url,
    hint: BUILD_HINT,
  });
}

function pickFactory(imported: unknown, url: string): EmscriptenModuleFactory {
  const candidates: unknown[] = [];
  if (imported && typeof imported === 'object') {
    const record = imported as Record<string, unknown>;
    candidates.push(record.default, record.createOpenTT3DEngine);
  }
  candidates.push(imported);
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return candidate as EmscriptenModuleFactory;
  }
  throw new EngineLoadError(`Le module ${url} n’exporte pas de fabrique utilisable.`, {
    code: 'module-invalid',
    url,
    hint: 'Vérifiez que le build Emscripten utilise MODULARIZE=1 et EXPORT_ES6=1.',
  });
}

function describeImportFailure(url: string, cause: unknown, importModule: boolean): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (
    /failed to fetch dynamically imported module|error loading dynamically imported module|ERR_MODULE_NOT_FOUND|cannot find module|importing a module script failed/i.test(
      detail,
    )
  ) {
    return `Impossible de charger le module moteur : ${url} (${detail}).`;
  }
  return importModule
    ? `Import du module moteur impossible : ${url} (${detail}).`
    : `Instanciation du module Emscripten impossible : ${url} (${detail}).`;
}

/** Message de progression déduit de `setStatus` (« Downloading data… (x/y) »). */
function downloadProgress(text: string): { ratio: number | null; label: string } {
  const match = /\((\d+)\s*\/\s*(\d+)\)/.exec(text);
  if (match) {
    const done = Number(match[1]);
    const total = Number(match[2]);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      return {
        ratio: Math.max(0, Math.min(1, done / total)),
        label: 'Téléchargement des données…',
      };
    }
  }
  if (/download/i.test(text)) return { ratio: null, label: 'Téléchargement des données…' };
  if (/running/i.test(text)) return { ratio: null, label: 'Démarrage du runtime WebAssembly…' };
  return { ratio: null, label: 'Initialisation du module WebAssembly…' };
}

/**
 * Charge et instancie le module OpenTT3D.
 *
 * La progression est bornée par les étapes connues ; le téléchargement du
 * paquet `.data` (6,8 Mio) est suivi via `setStatus` d'Emscripten.
 */
export async function loadEngine(options: EngineLoadOptions = {}): Promise<LoadedEngine> {
  const moduleUrl = resolveEngineModuleUrl(options.moduleUrl);
  const report = (progress: number, message: string): void => {
    options.onProgress?.(Math.max(0, Math.min(1, progress)), message);
  };
  const debug = options.debug === true;

  report(0.02, 'Résolution du moteur WebAssembly…');

  let factory = options.factory;
  if (!factory) {
    await assertReachable(moduleUrl);
    report(0.06, 'Téléchargement du module moteur…');
    const importer = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
    let imported: unknown;
    try {
      imported = await importer(moduleUrl);
    } catch (cause) {
      throw new EngineLoadError(describeImportFailure(moduleUrl, cause, true), {
        code: 'module-missing',
        url: moduleUrl,
        hint: BUILD_HINT,
        cause,
      });
    }
    factory = pickFactory(imported, moduleUrl);
  } else {
    report(0.08, 'Module moteur fourni par l’intégration…');
  }

  report(0.12, 'Instanciation du module WebAssembly…');
  const requestedMemory = typeof options.memoryMiB === 'number' ? options.memoryMiB : undefined;

  const directory = moduleDirectory(moduleUrl);
  const moduleOptions: EmscriptenModuleOptions = {
    // Sans `locateFile`, Emscripten résout `.wasm`/`.data` par rapport à la
    // page HTML (racine), pas au module : le paquet OpenGFX manquerait et
    // OpenTTD échouerait sur « No available language packs ».
    ...(directory ? { locateFile: (file: string) => new URL(file, directory).href } : {}),
    setStatus: (text: string) => {
      const { ratio, label } = downloadProgress(text);
      if (ratio === null) {
        report(0.3, label);
      } else {
        report(0.12 + ratio * 0.7, label);
      }
    },
    print: debug ? (text: string) => console.log(`[ottd] ${text}`) : () => {},
    printErr: (text: string) => console.warn(`[ottd] ${text}`),
    onAbort: (what: unknown) => {
      console.error('[ottd] abort', what);
    },
    noInitialRun: true,
  };
  if (requestedMemory !== undefined && requestedMemory > 0) {
    // Les builds Emscripten peuvent lire cette option ; celui du dépôt fige sa
    // mémoire, auquel cas la vérification ci-dessous signale l'écart.
    moduleOptions.INITIAL_MEMORY = Math.round(requestedMemory) * 1024 * 1024;
  }

  let module: EmscriptenModule;
  try {
    module = await factory(moduleOptions);
  } catch (cause) {
    throw new EngineLoadError(describeImportFailure(moduleUrl, cause, false), {
      code: 'instantiation-failed',
      url: moduleUrl,
      hint:
        'Vérifiez que opentt3d-engine.wasm et opentt3d-engine.data sont servis ' +
        'à côté du module et que le serveur envoie application/wasm.',
      cause,
    });
  }

  if (!module || typeof module.HEAPU8 === 'undefined' || module.HEAPU8.byteLength === 0) {
    throw new EngineLoadError(`Le module ${moduleUrl} n’expose pas de mémoire WASM.`, {
      code: 'module-invalid',
      url: moduleUrl,
      hint: 'Module Emscripten incomplet : reconstruisez avec npm run engine:build.',
    });
  }

  const memoryBytes = module.HEAPU8.byteLength;
  const memoryShortfall =
    requestedMemory !== undefined &&
    requestedMemory > 0 &&
    memoryBytes < requestedMemory * 1024 * 1024;

  report(1, 'Module WebAssembly prêt');
  return { module, moduleUrl, memoryBytes, memoryShortfall };
}
