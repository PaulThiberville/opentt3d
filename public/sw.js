/**
 * Service worker OpenTT3D.
 *
 * Source versionnée : `PWA_VERSION` et `PRECACHE_URLS` sont injectés au build
 * par le plugin défini dans `vite.config.ts` (le fichier publié est
 * `dist/sw.js`). Le cache est explicitement versionné `v1-xxxxxxxx` à partir
 * du contenu de l'app shell : un build différent produit une nouvelle version,
 * les anciens caches précache/runtime sont supprimés à l'activation.
 *
 * Stratégies :
 * - navigation → réseau d'abord (timeout court), puis `index.html` précaché ;
 * - assets de l'app (bundles hashés, icônes, manifest) → cache d'abord avec
 *   revalidation en arrière-plan (stale-while-revalidate) ;
 * - artefacts moteur `engine/*` → réseau d'abord, cache runtime borné en
 *   secours (jamais précachés : ~17 Mio) ;
 * - tout le reste (POST, cross-origin, Range) → réseau, sans interception.
 *
 * Aucun `skipWaiting()` automatique : une nouvelle version attend l'accord de
 * l'utilisateur (`SKIP_WAITING` envoyé par `src/pwa.ts`), pour ne pas
 * interrompre une partie en cours.
 */

'use strict';

const CACHE_PREFIX = 'opentt3d';
const CACHE_SCHEMA = 'v1';
const PWA_VERSION = '__PWA_VERSION__';
/** Remplacé au build par la liste des fichiers de l'app shell. */
const PRECACHE_URLS = /* __PWA_PRECACHE__ */ [];
const PRECACHE_CACHE = `${CACHE_PREFIX}-precache-${PWA_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${PWA_VERSION}`;
const ENGINE_CACHE = `${CACHE_PREFIX}-engine-v1`;
/** Le moteur = 3 fichiers (~17 Mio) + quelques variantes ; on borne le cache. */
const ENGINE_MAX_ENTRIES = 8;
const ENGINE_TIMEOUT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 4000;
const OFFLINE_DOCUMENT = 'index.html';

const APP_SHELL_EXTENSIONS = ['.html', '.js', '.css', '.webmanifest', '.png', '.svg', '.ico'];

/** URL absolue d'un chemin relatif à la racine du déploiement. */
function appUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function extensionOf(pathname) {
  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  return dot > slash ? pathname.slice(dot).toLowerCase() : '';
}

/**
 * Classe une requête. Miroir de `resolveRoute()` dans `src/pwa.ts` (testé des
 * deux côtés : helpers unitaires et comportement réel du worker).
 */
function routeOf(request) {
  if (request.method !== 'GET') return 'bypass';
  if (request.headers && request.headers.get('range')) return 'bypass';
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return 'bypass';
  }
  if (url.origin !== self.location.origin) return 'bypass';
  if (request.mode === 'navigate') return 'navigate';
  let path = url.pathname;
  const scopePath = new URL(self.registration.scope).pathname;
  if (path.startsWith(scopePath)) path = path.slice(scopePath.length);
  path = path.replace(/^\/+/, '');
  if (path === 'engine' || path.startsWith('engine/')) return 'engine';
  return APP_SHELL_EXTENSIONS.includes(extensionOf(path)) ? 'app-shell' : 'bypass';
}

function isCacheable(response) {
  return Boolean(
    response && response.status === 200 && response.ok && response.type !== 'opaque',
  );
}

async function putSafe(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch (error) {
    // Quota dépassé ou cache refusé (navigation privée stricte) : le jeu reste
    // jouable en ligne, seule la promesse hors ligne est dégradée.
    console.warn('[pwa] écriture de cache ignorée', request.url, error);
  }
}

/** Navigue vers le réseau, avec repli app shell si hors ligne ou trop lent. */
async function handleNavigation(event) {
  try {
    const response = await Promise.race([
      fetch(event.request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('navigation timeout')), NAVIGATION_TIMEOUT_MS),
      ),
    ]);
    if (response && response.status < 500) return response;
    throw new Error(`navigation HTTP ${response ? response.status : '?'}`);
  } catch {
    const cache = await caches.open(PRECACHE_CACHE);
    const fallback = await cache.match(appUrl(OFFLINE_DOCUMENT));
    if (fallback) return fallback;
    return new Response(
      '<!doctype html><html lang="fr"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>OpenTT3D — hors ligne</title>' +
        '<body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
        'background:#10151c;color:#e7edf5;font:16px/1.5 system-ui,sans-serif;text-align:center">' +
        '<main><h1>OpenTT3D</h1><p>Cette version n’est pas encore disponible hors ligne.</p>' +
        '<p>Reconnectez-vous puis rechargez la page une première fois.</p></main></body></html>',
      {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    );
  }
}

/** Cache d'abord + revalidation silencieuse pour les assets de l'app shell. */
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) {
        const cache = await caches.open(RUNTIME_CACHE);
        await putSafe(cache, request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    // La revalidation continue en arrière-plan sans bloquer la réponse.
    return cached;
  }
  const response = await network;
  if (response) return response;
  return new Response('Ressource indisponible hors ligne.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function pruneCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  for (const key of keys.slice(0, keys.length - maxEntries)) {
    await cache.delete(key);
  }
}

/**
 * Artefacts moteur : le réseau fait foi (une nouvelle release garde les mêmes
 * noms de fichiers), mais une copie en cache prend le relais hors ligne.
 */
async function networkFirstEngine(request) {
  const cache = await caches.open(ENGINE_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) {
        await putSafe(cache, request, response.clone());
        await pruneCache(cache, ENGINE_MAX_ENTRIES);
      }
      return response;
    })
    .catch(() => null);

  if (!cached) {
    const response = await network;
    if (response) return response;
    return new Response('Artefact moteur indisponible hors ligne.', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const response = await Promise.race([
    network,
    new Promise((resolve) => setTimeout(() => resolve(null), ENGINE_TIMEOUT_MS)),
  ]);
  return response ?? cached;
}

/** Précache résilient : une entrée manquante ne bloque pas l'installation. */
async function precacheAppShell() {
  const cache = await caches.open(PRECACHE_CACHE);
  await Promise.all(
    PRECACHE_URLS.map(async (path) => {
      const url = appUrl(String(path));
      try {
        const request = new Request(url, { cache: 'reload' });
        const response = await fetch(request);
        if (isCacheable(response)) await putSafe(cache, request, response);
      } catch (error) {
        console.warn('[pwa] précache ignoré', url, error);
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheAppShell().catch((error) => {
      console.warn('[pwa] précache incomplet', error);
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith(`${CACHE_PREFIX}-`) &&
              name !== PRECACHE_CACHE &&
              name !== RUNTIME_CACHE &&
              name !== ENGINE_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'PWA_ACTIVATED', version: PWA_VERSION });
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: 'PWA_VERSION', version: PWA_VERSION, schema: CACHE_SCHEMA });
  }
});

self.addEventListener('fetch', (event) => {
  const route = routeOf(event.request);
  if (route === 'navigate') {
    event.respondWith(handleNavigation(event));
  } else if (route === 'engine') {
    event.respondWith(networkFirstEngine(event.request));
  } else if (route === 'app-shell') {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});
