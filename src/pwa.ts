/**
 * Support PWA d'OpenTT3D : enregistrement du service worker, détection de mise
 * à jour et invitation non bloquante à recharger.
 *
 * Le jeu est un build Vite statique : aucun backend. Le service worker vit dans
 * `public/sw.js`, ses URLs précachées et sa version de cache sont injectées au
 * build par un plugin défini dans `vite.config.ts`. Ce module ne contient que du
 * code client et des helpers purs, réutilisés par le plugin de build et par les
 * tests.
 *
 * Règles de mise à jour :
 * - un nouveau service worker reste en attente (`waiting`) tant que l'utilisateur
 *   n'a pas confirmé : une partie en cours n'est jamais interrompue ;
 * - l'invitation n'apparaît qu'en zone « sûre » (menu principal, après une
 *   sauvegarde), signalée par `notifyAppIdle()` ;
 * - le rechargement n'a lieu qu'après `SKIP_WAITING`, puis `controllerchange`.
 */

/** Préfixe commun à tous les caches de l'application. */
export const PWA_CACHE_PREFIX = 'opentt3d';
/** Cache des artefacts moteur : nom stable pour survivre aux mises à jour d'app. */
export const PWA_ENGINE_CACHE = 'opentt3d-engine-v1';
/** Schéma des noms de cache ; à incrémenter en cas de changement incompatible. */
export const PWA_CACHE_SCHEMA = 'v1';
/** Chemins relatifs à la racine du déploiement (base `./`). */
export const PWA_MANIFEST_PATH = 'manifest.webmanifest';
export const PWA_SERVICE_WORKER_PATH = 'sw.js';
export const PWA_OFFLINE_DOCUMENT = 'index.html';
/** Extensions constituant l'app shell précachée. */
const PRECACHE_EXTENSIONS = ['.html', '.js', '.css', '.webmanifest', '.png', '.svg', '.ico'];
/** Fichiers jamais précachés : le SW lui-même et les artefacts moteur (16 Mio). */
const PRECACHE_EXCLUDED_PREFIXES = ['engine/'];

export interface PrecacheEntry {
  /** Chemin relatif à la racine du déploiement, sans `./` ni `/`. */
  url: string;
  /** Taille en octets, utilisée pour la version de cache. */
  size?: number;
  /** Empreinte du contenu (fichiers non hashés par Vite). */
  digest?: string;
}

export interface PrecacheOptions {
  /** URL supplémentaires à exclure. */
  exclude?: readonly string[];
}

/**
 * Normalise un chemin public en URL relative stable : pas de `./`, pas de `/`
 * initial, pas de requête ni de fragment, séparateurs `/`.
 */
export function normalizePrecacheUrl(url: string): string {
  const withoutOrigin = url.trim().replace(/^[a-z]+:\/\/[^/]+/i, '');
  const withoutQuery = withoutOrigin.split('#')[0]?.split('?')[0] ?? '';
  return withoutQuery
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

function extensionOf(url: string): string {
  const clean = url.split('#')[0]?.split('?')[0] ?? url;
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  return dot > slash ? clean.slice(dot).toLowerCase() : '';
}

/**
 * Sélectionne les fichiers de l'app shell à précacher. Volontairement
 * conservateur : seuls le HTML, les bundles hashés, les icônes et le manifest
 * sont retenus ; les sourcemaps, le WASM, les données OpenGFX et le service
 * worker lui-même restent hors du précache.
 */
export function buildPrecacheList(
  files: readonly (string | PrecacheEntry)[],
  options: PrecacheOptions = {},
): string[] {
  const excluded = new Set(
    [...(options.exclude ?? []), PWA_SERVICE_WORKER_PATH].map(normalizePrecacheUrl),
  );
  const seen = new Set<string>();
  for (const file of files) {
    const raw = typeof file === 'string' ? file : file.url;
    const url = normalizePrecacheUrl(raw);
    if (!url || url.includes('..')) continue;
    if (seen.has(url) || excluded.has(url)) continue;
    if (PRECACHE_EXCLUDED_PREFIXES.some((prefix) => url === prefix || url.startsWith(prefix))) {
      continue;
    }
    if (!PRECACHE_EXTENSIONS.includes(extensionOf(url))) continue;
    seen.add(url);
  }
  const list = [...seen].sort((a, b) => a.localeCompare(b));
  // `index.html` en tête : c'est le fallback de navigation hors ligne.
  const index = list.indexOf(PWA_OFFLINE_DOCUMENT);
  if (index > 0) {
    list.splice(index, 1);
    list.unshift(PWA_OFFLINE_DOCUMENT);
  }
  return list;
}

/** FNV-1a 32 bits sur une chaîne (déterministe, sans dépendance). */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** FNV-1a 32 bits sur un buffer (utilisé au build pour les fichiers non hashés). */
export function fnv1a32Bytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Version de cache explicite, dérivée du contenu de l'app shell. Deux builds
 * dont un fichier change produisent deux versions différentes ; un build
 * identique réutilise le même cache.
 *
 * Format : `v1-xxxxxxxx` (schéma + 8 hex). Documenté dans le wiki
 * (`Developpement#pwa`).
 */
export function computeCacheVersion(entries: readonly PrecacheEntry[]): string {
  const normalized = entries
    .map((entry) => ({
      url: normalizePrecacheUrl(entry.url),
      size: entry.size ?? 0,
      digest: entry.digest ?? '',
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
  let hash = 0x811c9dc5;
  for (const entry of normalized) {
    const line = `${entry.url}\u0000${entry.size}\u0000${entry.digest}\n`;
    for (let i = 0; i < line.length; i++) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${PWA_CACHE_SCHEMA}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Nom du cache de l'app shell pour une version donnée. */
export function precacheCacheName(version: string): string {
  return `${PWA_CACHE_PREFIX}-precache-${version}`;
}

/** Nom du cache runtime (assets non précachés) pour une version donnée. */
export function runtimeCacheName(version: string): string {
  return `${PWA_CACHE_PREFIX}-runtime-${version}`;
}

/**
 * Vrai pour un cache appartenant à l'application mais périmé : les anciens
 * caches précache/runtime sont supprimés à l'activation. Le cache moteur est
 * conservé (il est borné et revalidé par le réseau).
 */
export function isStaleCacheName(name: string, version: string): boolean {
  if (!name.startsWith(`${PWA_CACHE_PREFIX}-`)) return false;
  if (name === PWA_ENGINE_CACHE) return false;
  return name !== precacheCacheName(version) && name !== runtimeCacheName(version);
}

/** Stratégie appliquée à une requête, miroir de `routeOf()` dans `public/sw.js`. */
export type PwaRequestRoute = 'navigate' | 'engine' | 'app-shell' | 'bypass';

export interface RouteInput {
  url: string;
  method?: string;
  mode?: string;
  sameOrigin?: boolean;
  /** Portée du service worker, pour retirer son préfixe d'URL. */
  scope?: string;
}

/**
 * Classe une requête : navigation → network-first avec fallback app shell ;
 * `engine/*` → network-first avec cache runtime borné ; assets de l'app →
 * cache-first/stale-while-revalidate ; tout le reste passe au réseau.
 */
export function resolveRoute(input: RouteInput): PwaRequestRoute {
  if ((input.method ?? 'GET').toUpperCase() !== 'GET') return 'bypass';
  if (input.sameOrigin === false) return 'bypass';
  if (input.mode === 'navigate') return 'navigate';
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(input.url, 'https://opentt3d.invalid/').pathname);
  } catch {
    return 'bypass';
  }
  if (input.scope) {
    try {
      const scopePath = new URL(input.scope, 'https://opentt3d.invalid/').pathname;
      if (scopePath !== '/' && pathname.startsWith(scopePath)) {
        pathname = pathname.slice(scopePath.length);
      }
    } catch {
      // Portée invalide : on garde le chemin complet.
    }
  }
  const path = pathname.replace(/^\/+/, '');
  if (path === 'engine' || path.startsWith('engine/')) return 'engine';
  const extension = extensionOf(path);
  return PRECACHE_EXTENSIONS.includes(extension) ? 'app-shell' : 'bypass';
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Valide le manifeste PWA (sans dépendre du DOM ni du chargement réseau). Les
 * erreurs bloquent l'installabilité ; les avertissements sont des
 * recommandations (maskable, description courte, etc.).
 */
export function validateWebManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['Le manifeste doit être un objet JSON.'], warnings };
  }
  const stringField = (key: string, label: string): string | null => {
    const field = value[key];
    if (typeof field !== 'string' || field.trim() === '') {
      errors.push(`${label} manquant (${key}).`);
      return null;
    }
    return field;
  };
  stringField('name', 'Nom');
  const shortName = stringField('short_name', 'Nom court');
  if (shortName && shortName.length > 12) {
    warnings.push('short_name dépasse 12 caractères : il sera tronqué sur l’écran d’accueil.');
  }
  if (typeof value['description'] !== 'string' || value['description'].trim() === '') {
    warnings.push('description absente : le manifeste reste installable mais moins lisible.');
  }
  if (typeof value['lang'] !== 'string' || value['lang'].trim() === '') {
    warnings.push('lang absente : les lecteurs d’écran et stores ne connaissent pas la langue.');
  }

  const startUrl = stringField('start_url', 'start_url');
  if (startUrl && !/^(?:\.{0,2}\/|https?:)/.test(startUrl)) {
    errors.push('start_url doit être relatif (./) ou absolu.');
  }
  const scope = value['scope'];
  if (scope !== undefined && (typeof scope !== 'string' || !/^(?:\.{0,2}\/|https?:)/.test(scope))) {
    errors.push('scope doit être un chemin relatif ou une URL absolue.');
  }

  const display = value['display'];
  if (!['standalone', 'fullscreen', 'minimal-ui', 'browser'].includes(String(display))) {
    errors.push('display doit valoir standalone, fullscreen, minimal-ui ou browser.');
  }

  for (const key of ['theme_color', 'background_color'] as const) {
    const color = value[key];
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
      errors.push(`${key} doit être une couleur hexadécimale (#rrggbb).`);
    }
  }

  const categories = value['categories'];
  if (!Array.isArray(categories) || categories.length === 0) {
    warnings.push('categories absente : sans effet sur l’installabilité.');
  }

  const icons = value['icons'];
  if (!Array.isArray(icons) || icons.length === 0) {
    errors.push('icons doit contenir au moins une icône 192x192 et une 512x512.');
  } else {
    const pngs = icons.filter(
      (icon): icon is Record<string, unknown> =>
        isRecord(icon) && typeof icon['src'] === 'string' && icon['type'] === 'image/png',
    );
    const hasSize = (size: string): boolean =>
      pngs.some((icon) => typeof icon['sizes'] === 'string' && icon['sizes'].includes(size));
    if (!hasSize('192x192')) errors.push('icône PNG 192x192 manquante.');
    if (!hasSize('512x512')) errors.push('icône PNG 512x512 manquante.');
    const maskable = pngs.some(
      (icon) => typeof icon['purpose'] === 'string' && icon['purpose'].includes('maskable'),
    );
    if (!maskable) warnings.push('aucune icône maskable : rendu rogné possible sur Android.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface PwaOptions {
  /** Force la désactivation (tests, `?pwa=off`). */
  enabled?: boolean;
  /** Conteneur de la bannière (défaut : `document.body`). */
  container?: HTMLElement | null;
  /** Document injectable (tests). */
  doc?: Document;
  /** Conteneur service worker injectable (tests). */
  serviceWorker?: ServiceWorkerContainer | null;
  /** URL du service worker, relative à la page. */
  serviceWorkerUrl?: string;
}

export interface PwaController {
  /** Vrai si un service worker est enregistré (ou en cours d'enregistrement). */
  readonly supported: boolean;
  /** Vrai si une nouvelle version attend d'être activée. */
  readonly updateAvailable: boolean;
  /** Signale que l'application est dans une zone sûre (menu, après sauvegarde). */
  notifyAppIdle(): void;
  /** Signale qu'une partie est en cours : l'invitation est retirée puis différée. */
  notifyAppBusy(): void;
  /** Active la nouvelle version et recharge la page. */
  applyUpdate(): void;
  /** Masque l'invitation pour cette session. */
  dismissUpdate(): void;
  dispose(): void;
}

const UPDATE_STYLE_ID = 'opentt3d-pwa-update-style';
const UPDATE_BANNER_CLASS = 'opentt3d-pwa-update';

function injectBannerStyle(doc: Document): void {
  if (doc.getElementById(UPDATE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = UPDATE_STYLE_ID;
  style.textContent = `
.${UPDATE_BANNER_CLASS} {
  position: fixed;
  left: 50%;
  bottom: max(18px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: min(92vw, 620px);
  padding: 12px 16px;
  border: 1px solid rgba(242, 181, 68, 0.55);
  border-radius: 12px;
  background: rgba(16, 21, 28, 0.97);
  color: #e7edf5;
  font: 500 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
.${UPDATE_BANNER_CLASS} p { margin: 0; flex: 1 1 auto; }
.${UPDATE_BANNER_CLASS} button {
  flex: 0 0 auto;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid rgba(231, 237, 245, 0.25);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.${UPDATE_BANNER_CLASS} button[data-action="reload"] {
  background: #f2b544;
  border-color: #f2b544;
  color: #10151c;
  font-weight: 700;
}
.${UPDATE_BANNER_CLASS} button:disabled { opacity: 0.6; cursor: progress; }
.${UPDATE_BANNER_CLASS} button:focus-visible { outline: 2px solid #f2b544; outline-offset: 2px; }
`;
  (doc.head ?? doc.documentElement).append(style);
}

interface UpdateBanner {
  element: HTMLElement;
  setBusy(busy: boolean): void;
}

function createUpdateBanner(
  doc: Document,
  onReload: () => void,
  onDismiss: () => void,
): UpdateBanner {
  injectBannerStyle(doc);
  const element = doc.createElement('aside');
  element.className = UPDATE_BANNER_CLASS;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  const message = doc.createElement('p');
  message.textContent = 'Une nouvelle version d’OpenTT3D est disponible.';
  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.dataset['action'] = 'reload';
  reload.textContent = 'Recharger';
  reload.addEventListener('click', onReload);
  const later = doc.createElement('button');
  later.type = 'button';
  later.dataset['action'] = 'later';
  later.textContent = 'Plus tard';
  later.addEventListener('click', onDismiss);
  element.append(message, reload, later);
  return {
    element,
    setBusy(busy: boolean) {
      reload.disabled = busy;
      later.disabled = busy;
      message.textContent = busy
        ? 'Mise à jour… rechargement de la page.'
        : 'Une nouvelle version d’OpenTT3D est disponible.';
    },
  };
}

/**
 * Enregistre le service worker et pilote l'invitation de mise à jour.
 *
 * Le mode développement est ignoré (HMR et SW ne font pas bon ménage) ; un
 * `?pwa=off` dans l'URL désactive l'enregistrement pour une session.
 */
export function startPwa(options: PwaOptions = {}): PwaController {
  const doc = options.doc ?? (typeof document === 'undefined' ? null : document);
  const win = doc?.defaultView ?? null;
  const serviceWorker =
    options.serviceWorker ??
    (typeof navigator === 'undefined' ? null : (navigator.serviceWorker ?? null));
  const query = win?.location?.search ?? '';
  const disabledByQuery = /[?&]pwa=off(?:&|$)/.test(query);
  const devBuild = (import.meta.env as { DEV?: boolean } | undefined)?.DEV === true;
  const enabled = options.enabled ?? (!devBuild && !disabledByQuery);
  const supported = enabled && serviceWorker !== null && doc !== null;

  let registration: ServiceWorkerRegistration | null = null;
  let waitingWorker: ServiceWorker | null = null;
  let appIdle = false;
  let dismissed = false;
  let banner: UpdateBanner | null = null;
  let reloadRequested = false;
  let disposed = false;

  const removeBanner = (): void => {
    banner?.element.remove();
    banner = null;
  };

  const showBanner = (): void => {
    if (!doc || !waitingWorker || banner || dismissed || !appIdle || disposed) return;
    banner = createUpdateBanner(
      doc,
      () => {
        if (!waitingWorker) return;
        banner?.setBusy(true);
        reloadRequested = true;
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        // Filet de sécurité si `controllerchange` n'est pas émis (navigateur
        // ancien, SW déjà actif) : ne jamais rester bloqué sur « Mise à jour… ».
        win?.setTimeout(() => {
          if (reloadRequested && !disposed) win?.location.reload();
        }, 4000);
      },
      () => {
        dismissed = true;
        removeBanner();
      },
    );
    (options.container ?? doc.body ?? doc.documentElement).append(banner.element);
  };

  const markUpdateReady = (worker: ServiceWorker): void => {
    if (worker === waitingWorker) return;
    waitingWorker = worker;
    dismissed = false;
    showBanner();
  };

  const onControllerChange = (): void => {
    if (!reloadRequested || disposed) return;
    reloadRequested = false;
    win?.location.reload();
  };

  const onVisibilityChange = (): void => {
    if (!registration || doc?.visibilityState !== 'visible') return;
    void registration.update().catch(() => {
      // Hors ligne ou réseau instable : la version en cache reste utilisable.
    });
  };

  const checkWaiting = (): void => {
    if (registration?.waiting) markUpdateReady(registration.waiting);
  };

  if (!supported || !serviceWorker || !doc) {
    return {
      supported: false,
      get updateAvailable() {
        return false;
      },
      notifyAppIdle: () => {},
      notifyAppBusy: () => {},
      applyUpdate: () => {},
      dismissUpdate: () => {},
      dispose: () => {},
    };
  }

  const register = async (): Promise<void> => {
    try {
      registration = await serviceWorker.register(options.serviceWorkerUrl ?? './sw.js', {
        scope: './',
        updateViaCache: 'none',
      });
      if (disposed) return;
      checkWaiting();
      registration.addEventListener('updatefound', () => {
        const installing = registration?.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // Un premier SW remplace `null` → pas de mise à jour à proposer.
          if (installing.state === 'installed' && serviceWorker.controller) {
            markUpdateReady(installing);
          }
        });
      });
      // Demande un stockage persistant : sans lui, le navigateur peut évincer
      // le cache moteur (~17 Mio) sous pression disque.
      void navigator.storage?.persist?.().catch(() => {});
    } catch (error) {
      console.warn('[OpenTT3D] Service worker non enregistré :', error);
    }
  };

  serviceWorker.addEventListener('controllerchange', onControllerChange);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  if (doc.readyState === 'complete') {
    void register();
  } else {
    win?.addEventListener('load', () => void register(), { once: true });
  }

  return {
    supported: true,
    get updateAvailable() {
      return waitingWorker !== null;
    },
    notifyAppIdle() {
      appIdle = true;
      showBanner();
    },
    notifyAppBusy() {
      appIdle = false;
      removeBanner();
    },
    applyUpdate() {
      if (waitingWorker) {
        banner?.setBusy(true);
        reloadRequested = true;
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      }
    },
    dismissUpdate() {
      dismissed = true;
      removeBanner();
    },
    dispose() {
      disposed = true;
      removeBanner();
      serviceWorker.removeEventListener('controllerchange', onControllerChange);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      registration = null;
      waitingWorker = null;
    },
  };
}
