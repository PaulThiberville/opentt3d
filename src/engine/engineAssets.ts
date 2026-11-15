/**
 * Détection des artefacts WebAssembly servis depuis `public/engine/` (#78).
 *
 * Le module Emscripten est chargé dynamiquement, donc un dépôt sans artefacts
 * reste parfaitement fonctionnel en mode mock. L'UI a seulement besoin de
 * savoir, au démarrage, si le moteur réel est réellement téléchargeable pour
 * proposer (ou désactiver) le choix « OpenTTD réel ».
 *
 * Ce module est volontairement pur côté DOM : il ne fait que construire des
 * URLs et interroger le réseau. Aucune erreur n'est propagée : une panne réseau
 * ne doit jamais bloquer le menu, elle est signalée comme « non vérifié ».
 *
 * Stratégie :
 *  - URLs relatives à `import.meta.env.BASE_URL` (build `base: './'`, Pages,
 *    sous-répertoire), avec repli sur `document.baseURI` puis `./` ;
 *  - `HEAD` par fichier, avec repli `GET Range: bytes=0-0` pour les serveurs
 *    qui refusent `HEAD` (405/501) sans télécharger les 7 Mio du paquet `.data` ;
 *  - cache mémoire par base d'URL : le menu, la nouvelle partie et les réglages
 *    partagent une seule vérification.
 */

import { ENGINE_ASSET_DIR, ENGINE_MODULE_FILE } from './loadEngine';

/** Fichiers nécessaires au moteur WASM, servis côte à côte. */
export const ENGINE_ASSET_FILES = [
  ENGINE_MODULE_FILE,
  'opentt3d-engine.wasm',
  'opentt3d-engine.data',
] as const;

export type EngineAssetFile = (typeof ENGINE_ASSET_FILES)[number];

/**
 * Résultat de la vérification :
 *  - `available` : les trois fichiers répondent ;
 *  - `missing`   : au moins un fichier est explicitement absent (404/410) ;
 *  - `network`   : vérification impossible (hors ligne, 5xx, HEAD refusé sans
 *    repli…). Le mode WASM reste proposé : l'utilisateur peut tenter sa chance.
 */
export type EngineArtifactsReason = 'available' | 'missing' | 'network';

export interface EngineArtifacts {
  reason: EngineArtifactsReason;
  /** Vrai uniquement si les trois artefacts sont joignables. */
  available: boolean;
  /** Fichiers confirmés absents par le serveur. */
  missing: EngineAssetFile[];
  /** Fichiers dont l'état n'a pas pu être déterminé. */
  unreachable: EngineAssetFile[];
  /** URLs absolues interrogées, utiles aux messages et aux diagnostics. */
  urls: string[];
  /** Horodatage de la vérification (ms epoch). */
  checkedAt: number;
}

export interface EngineArtifactsOptions {
  /** Force la base (tests, CDN, sous-répertoire). */
  baseUrl?: string;
  /** `fetch` injectable pour les tests. */
  fetchImpl?: typeof fetch;
  /** Budget total de la vérification ; 0 désactive le délai. */
  timeoutMs?: number;
  /** Horloge injectable (tests déterministes). */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Base des artefacts : `import.meta.env.BASE_URL` d'abord, puis la page
 * courante, puis un chemin relatif utilisable tel quel par le navigateur.
 */
export function engineAssetBaseUrl(): string {
  const env = import.meta.env as { BASE_URL?: string } | undefined;
  const base = env?.BASE_URL?.trim();
  if (base) return base;
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI) {
    return document.baseURI;
  }
  return './';
}

/** Résout un fichier d'artefact en URL absolue quand la base le permet. */
export function resolveEngineAssetUrl(file: EngineAssetFile, baseUrl?: string): string {
  const base = baseUrl ?? engineAssetBaseUrl();
  const path = `${ENGINE_ASSET_DIR}/${file}`;
  const absolute = absoluteBase(base);
  if (absolute) {
    try {
      return new URL(path, absolute).href;
    } catch {
      // Base exotique : on garde une URL relative, suffisante pour `fetch`.
    }
  }
  return `${base.endsWith('/') ? base : `${base}/`}${path}`;
}

/** URLs des trois artefacts, dans l'ordre de `ENGINE_ASSET_FILES`. */
export function resolveEngineAssetUrls(baseUrl?: string): string[] {
  return ENGINE_ASSET_FILES.map((file) => resolveEngineAssetUrl(file, baseUrl));
}

function absoluteBase(base: string): string | null {
  try {
    return new URL(base).href;
  } catch {
    // Base relative : on la résout par rapport à la page si elle existe.
  }
  if (typeof location !== 'undefined' && typeof location.href === 'string' && location.href) {
    try {
      return new URL(base, location.href).href;
    } catch {
      return null;
    }
  }
  return null;
}

type ProbeOutcome = 'ok' | 'missing' | 'unknown';

/**
 * Un serveur de développement (ou un fallback SPA) peut répondre 200 avec la
 * page HTML à la place d'un fichier absent. Ce n'est pas un artefact valide :
 * on le traite comme absent, sinon le sélecteur promettrait un WASM inexistant.
 */
function isArtifactResponse(response: Response): boolean {
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  return !type.includes('text/html');
}

/** `HEAD` puis repli `GET Range` : ne télécharge jamais le paquet complet. */
async function probeAsset(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<ProbeOutcome> {
  const init: RequestInit = { cache: 'no-store' };
  if (signal) init.signal = signal;
  try {
    const head = await fetchImpl(url, { ...init, method: 'HEAD' });
    if (head.ok) return isArtifactResponse(head) ? 'ok' : 'missing';
    if (head.status === 404 || head.status === 410) return 'missing';
    if (head.status !== 405 && head.status !== 501) return 'unknown';
    const ranged = await fetchImpl(url, {
      ...init,
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    if (ranged.ok || ranged.status === 206) {
      return isArtifactResponse(ranged) ? 'ok' : 'missing';
    }
    if (ranged.status === 404 || ranged.status === 410) return 'missing';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function emptyArtifacts(
  reason: EngineArtifactsReason,
  missing: EngineAssetFile[],
  unreachable: EngineAssetFile[],
  urls: string[],
  checkedAt: number,
): EngineArtifacts {
  return {
    reason,
    available: reason === 'available',
    missing,
    unreachable,
    urls,
    checkedAt,
  };
}

/**
 * Interroge les artefacts. Ne lève jamais : toute erreur devient `network`.
 * `missing` prime sur `network` (un 404 explicite est plus utile qu'un doute).
 */
export async function detectEngineArtifacts(
  options: EngineArtifactsOptions = {},
): Promise<EngineArtifacts> {
  const urls = resolveEngineAssetUrls(options.baseUrl);
  const checkedAt = (options.now ?? Date.now)();
  const fetchImpl =
    options.fetchImpl ?? (typeof fetch === 'function' ? (fetch as typeof fetch) : null);
  if (!fetchImpl) {
    return emptyArtifacts('network', [], [...ENGINE_ASSET_FILES], urls, checkedAt);
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const outcomes = await Promise.all(
      ENGINE_ASSET_FILES.map((_, index) =>
        probeAsset(fetchImpl, urls[index] ?? '', controller?.signal),
      ),
    );
    const missing: EngineAssetFile[] = [];
    const unreachable: EngineAssetFile[] = [];
    outcomes.forEach((outcome, index) => {
      const file = ENGINE_ASSET_FILES[index];
      if (!file || outcome === 'ok') return;
      if (outcome === 'missing') missing.push(file);
      else unreachable.push(file);
    });
    if (missing.length > 0) return emptyArtifacts('missing', missing, unreachable, urls, checkedAt);
    if (unreachable.length > 0) {
      return emptyArtifacts('network', missing, unreachable, urls, checkedAt);
    }
    return emptyArtifacts('available', missing, unreachable, urls, checkedAt);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

let memo: { key: string; promise: Promise<EngineArtifacts> } | null = null;
let latest: EngineArtifacts | null = null;

/**
 * Vérification partagée en mémoire, une seule fois par base d'URL. Les appels
 * concurrents (menu + écran déjà ouvert) recyclent la même promesse.
 */
export function cachedEngineArtifacts(
  options: EngineArtifactsOptions = {},
): Promise<EngineArtifacts> {
  const key = options.baseUrl ?? engineAssetBaseUrl();
  if (memo && memo.key === key) return memo.promise;
  const promise = detectEngineArtifacts(options).then((result) => {
    latest = result;
    return result;
  });
  memo = { key, promise };
  return promise;
}

/** Dernier résultat connu, sans relancer de requête. */
export function peekEngineArtifacts(): EngineArtifacts | null {
  return latest;
}

/** Vide le cache (tests, changement de base ou nouvelle tentative explicite). */
export function resetEngineArtifactsCache(): void {
  memo = null;
  latest = null;
}
