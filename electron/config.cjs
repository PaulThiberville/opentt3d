'use strict';
// Configuration partagée de l'enveloppe Electron.
//
// Ce module ne dépend pas du paquet `electron` : il est chargé tel quel par les
// tests Node (Vitest) pour vérifier les invariants de sécurité, les chemins et
// les types MIME. `main.cjs` y ajoute uniquement le cycle de vie de l'app.

const path = require('node:path');

/** Schéma privilégié servi depuis `dist/` : origine stable, contrairement à file://. */
const SCHEME = 'app';
const HOST = 'opentt3d';
const ORIGIN = `${SCHEME}://${HOST}`;
const APP_URL = `${ORIGIN}/index.html`;
const DEV_URL = 'http://localhost:5173/';

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

// Défense en profondeur : la page ne charge que son propre bundle. Le WASM
// exige `wasm-unsafe-eval` dans Chromium ; le réseau reste limité aux relais
// Nostr (wss) et aux ressources https.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' wss: https: data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
});

const WINDOW_DEFAULTS = Object.freeze({
  width: 1600,
  height: 900,
  minWidth: 1024,
  minHeight: 640,
  backgroundColor: '#0b1218',
});

// Une seule API exposée au renderer (voir preload.cjs) : aucune intégration
// Node, aucun IPC, isolation de contexte et sandbox Chromium.
const WEB_PREFERENCES = Object.freeze({
  preload: PRELOAD_PATH,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
  devTools: true,
});

// Autorisations navigateur réellement utiles au jeu. Tout le reste est refusé.
const ALLOWED_PERMISSIONS = Object.freeze([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
]);

/** Type MIME d'un fichier servi par le protocole `app://`. */
function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Résout un chemin d'URL vers un fichier de `dist/`, ou `null` si la requête
 * sort du répertoire (traversée `..`, chemin absolu, octet nul, encodage
 * invalide). `path.resolve` normalise avant la comparaison finale.
 */
function resolveDistFile(pathname, distDir = DIST_DIR) {
  if (typeof pathname !== 'string' || pathname.includes('\0')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  let relative = decoded.replace(/^\/+/, '');
  if (relative === '' || relative === './') relative = 'index.html';
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) return null;
  const root = path.resolve(distDir);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

/** Seules les URL http(s) sont ouvertes dans le navigateur du système. */
function isExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Lit `--engine=mock|wasm` (ou la valeur brute d'une variable d'environnement). */
function parseEngineChoice(args) {
  if (typeof args === 'string') {
    const normalized = args.trim().toLowerCase();
    return normalized === 'mock' || normalized === 'wasm' ? normalized : null;
  }
  if (!Array.isArray(args)) return null;
  for (const arg of args) {
    const match = /^--engine=(mock|wasm)$/i.exec(String(arg));
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Construit l'URL de démarrage. En production, le moteur WASM est choisi par
 * défaut dès que ses artefacts sont empaquetés ; `--engine=` force l'autre mode.
 * `autostart` est réservé aux vérifications locales.
 */
function buildStartUrl(baseUrl, options = {}) {
  const url = new URL(baseUrl);
  const requested = options.engine === 'mock' || options.engine === 'wasm' ? options.engine : null;
  const mode = requested || (options.hasWasm ? 'wasm' : null);
  if (mode) url.searchParams.set('engine', mode);
  if (options.autostart) url.searchParams.set('autostart', '1');
  return url.href;
}

/**
 * Valide l'état de fenêtre lu sur disque : dimensions minimales, coordonnées
 * finies et fenêtre encore visible sur un écran branché. Les valeurs douteuses
 * sont ignorées plutôt que propagées à BrowserWindow.
 */
function sanitizeWindowState(state, displays) {
  const result = {
    width: WINDOW_DEFAULTS.width,
    height: WINDOW_DEFAULTS.height,
    maximized: false,
    fullscreen: false,
  };
  if (!state || typeof state !== 'object') return result;

  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  if (finite(state.width))
    result.width = Math.min(10000, Math.max(WINDOW_DEFAULTS.minWidth, Math.round(state.width)));
  if (finite(state.height))
    result.height = Math.min(10000, Math.max(WINDOW_DEFAULTS.minHeight, Math.round(state.height)));
  result.maximized = state.maximized === true;
  result.fullscreen = state.fullscreen === true;

  const visible =
    finite(state.x) &&
    finite(state.y) &&
    Array.isArray(displays) &&
    displays.some((display) => {
      const area = display && display.workArea;
      if (!area) return false;
      return (
        state.x < area.x + area.width - 100 &&
        state.x + result.width > area.x + 100 &&
        state.y < area.y + area.height - 100 &&
        state.y + result.height > area.y + 50
      );
    });
  if (visible) {
    result.x = Math.round(state.x);
    result.y = Math.round(state.y);
  }
  return result;
}

module.exports = {
  SCHEME,
  HOST,
  ORIGIN,
  APP_URL,
  DEV_URL,
  ROOT_DIR,
  DIST_DIR,
  PRELOAD_PATH,
  CSP,
  MIME_TYPES,
  WINDOW_DEFAULTS,
  WEB_PREFERENCES,
  ALLOWED_PERMISSIONS,
  mimeTypeFor,
  resolveDistFile,
  isExternalUrl,
  parseEngineChoice,
  buildStartUrl,
  sanitizeWindowState,
};
