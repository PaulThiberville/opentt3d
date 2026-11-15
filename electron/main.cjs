'use strict';
// Enveloppe desktop (Electron) d'OpenTT3D.
//
// Le jeu est exactement le build Vite (`dist/`), pas une variante desktop. Il
// est servi par le schéma privilégié `app://opentt3d/` plutôt que par `file://` :
// l'origine est stable et sécurisée, donc les modules ES, le WebAssembly, les
// workers, localStorage et WebRTC se comportent comme sur https.
//
// `--dev` charge le serveur Vite (http://localhost:5173) au lieu de `dist/`.

const { app, BrowserWindow, Menu, dialog, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.cjs');

const IS_MAC = process.platform === 'darwin';
const IS_DEV = process.argv.includes('--dev') || process.env.OPENTT3D_DEV === '1';
const WANTS_DEVTOOLS = process.argv.includes('--devtools');
const ENGINE_CHOICE =
  config.parseEngineChoice(process.argv) ||
  config.parseEngineChoice(process.env.OPENTT3D_ENGINE || '');
const AUTOSTART = !app.isPackaged && process.argv.includes('--autostart');
const SCREENSHOT_PATH = app.isPackaged ? null : process.env.OPENTT3D_SCREENSHOT || null;
const WIKI_URL = 'https://github.com/PaulThiberville/opentt3d/wiki';
const ISSUES_URL = 'https://github.com/PaulThiberville/opentt3d/issues';

app.setName('OpenTT3D');

// Le schéma doit être déclaré avant `ready`. `standard` donne une origine
// réelle (nécessaire aux modules ES et à la CSP), `secure` le traite comme
// https, `supportFetchAPI` couvre le fetch des artefacts WASM.
protocol.registerSchemesAsPrivileged([
  {
    scheme: config.SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// Une partie en lockstep ne doit pas s'arrêter quand la fenêtre passe en
// arrière-plan : le worker de simulation continue de ticker, comme un onglet
// caché. Le rendu reste géré par Chromium.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// GPU dédié sur les portables à double carte ; WebGL et WASM restent activés.
app.commandLine.appendSwitch('force_high_performance_gpu');
if (process.env.OPENTT3D_SOFTWARE_RENDERING === '1') app.disableHardwareAcceleration();

/** @type {BrowserWindow | null} */
let win = null;
let recoveryDialogOpen = false;

// ---------------------------------------------------------------- protocole

function cspHeaders(pathname) {
  const headers = {};
  if (pathname === '/' || pathname.endsWith('/index.html')) {
    headers['content-security-policy'] = config.CSP;
  }
  return headers;
}

/** Sert un fichier de `dist/` pour `app://opentt3d/<chemin>`. */
async function serveApp(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Requête invalide', { status: 400 });
  }
  if (url.protocol !== `${config.SCHEME}:` || url.host !== config.HOST) {
    return new Response('Introuvable', { status: 404 });
  }
  const file = config.resolveDistFile(url.pathname);
  if (!file) return new Response('Interdit', { status: 403 });

  let body;
  try {
    body = await fs.promises.readFile(file);
  } catch {
    return new Response('Introuvable', { status: 404 });
  }
  const headers = {
    'content-type': config.mimeTypeFor(file),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...cspHeaders(url.pathname),
  };
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

// ---------------------------------------------------------------- état fenêtre

const statePath = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return config.sanitizeWindowState(raw, screen.getAllDisplays());
  } catch {
    return config.sanitizeWindowState(null, []);
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    const state = {
      ...bounds,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    };
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // État non critique : une fenêtre mal mémorisée ne doit jamais bloquer le jeu.
  }
}

// ---------------------------------------------------------------- liens

function openExternal(url) {
  if (!config.isExternalUrl(url)) return;
  shell.openExternal(url).catch(() => {
    // Navigateur indisponible : l'utilisateur garde la main dans le jeu.
  });
}

function allowedNavigation(url) {
  if (url === config.APP_URL || url.startsWith(`${config.ORIGIN}/`)) return true;
  return IS_DEV && url.startsWith(config.DEV_URL);
}

/** URL de démarrage : WASM si le build l'embarque, sinon mock (ou `--engine=`). */
function startUrl() {
  const hasWasm =
    !IS_DEV && fs.existsSync(path.join(config.DIST_DIR, 'engine', 'opentt3d-engine.js'));
  return config.buildStartUrl(IS_DEV ? config.DEV_URL : config.APP_URL, {
    engine: ENGINE_CHOICE,
    hasWasm,
    autostart: AUTOSTART,
  });
}

// ---------------------------------------------------------------- erreurs

function reportFailure(title, detail, actions = ['Recharger', 'Quitter']) {
  if (!win || win.isDestroyed() || recoveryDialogOpen) return;
  recoveryDialogOpen = true;
  dialog
    .showMessageBox(win, {
      type: 'error',
      title,
      message: title,
      detail,
      buttons: actions,
      defaultId: 0,
      cancelId: actions.length - 1,
      noLink: true,
    })
    .then(({ response }) => {
      recoveryDialogOpen = false;
      if (!win || win.isDestroyed()) return;
      if (actions[response] === 'Quitter') app.quit();
      else if (actions[response] === 'Recharger') win.reload();
    })
    .catch(() => {
      recoveryDialogOpen = false;
    });
}

function wireErrorHandling(wc) {
  wc.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED (navigation remplacée), cas normal.
    if (!isMainFrame || code === -3) return;
    reportFailure(
      'OpenTT3D n’a pas pu démarrer',
      `Chargement impossible (${code} ${description}).\n${failedUrl}\n\n` +
        (IS_DEV
          ? 'Vérifiez que le serveur Vite tourne : npm run dev.'
          : 'Le build est absent ou incomplet : lancez npm run build.'),
    );
  });

  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    reportFailure(
      'Le rendu 3D s’est arrêté',
      `Le processus de rendu a quitté (${details.reason}, code ${details.exitCode}).`,
    );
  });

  wc.on('unresponsive', () => {
    reportFailure(
      'OpenTT3D ne répond plus',
      'La simulation ou le rendu est bloqué. Vous pouvez attendre, recharger ou quitter.',
      ['Attendre', 'Recharger', 'Quitter'],
    );
  });
}

// ---------------------------------------------------------------- menu

function showAbout() {
  const options = {
    type: 'info',
    title: 'À propos d’OpenTT3D',
    message: `OpenTT3D ${app.getVersion()}`,
    detail:
      'OpenTTD en 3D, moteur headless WebAssembly et multijoueur pair-à-pair.\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
      'GPL-2.0-or-later — projet indépendant, non affilié à OpenTTD ou Transport Tycoon.',
    buttons: ['Fermer'],
    noLink: true,
  };
  const pending =
    win && !win.isDestroyed()
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options);
  pending.catch(() => {
    // Boîte de dialogue déjà fermée ou application en cours d'arrêt.
  });
}

function buildMenu() {
  const fileMenu = {
    label: 'Fichier',
    submenu: [
      { role: 'close', label: 'Fermer la fenêtre' },
      { type: 'separator' },
      { role: 'quit', label: 'Quitter OpenTT3D' },
    ],
  };
  const editMenu = {
    label: 'Édition',
    submenu: [
      { role: 'undo', label: 'Annuler' },
      { role: 'redo', label: 'Rétablir' },
      { type: 'separator' },
      { role: 'cut', label: 'Couper' },
      { role: 'copy', label: 'Copier' },
      { role: 'paste', label: 'Coller' },
      { role: 'selectAll', label: 'Tout sélectionner' },
    ],
  };
  const viewMenu = {
    label: 'Affichage',
    submenu: [
      {
        role: 'togglefullscreen',
        label: 'Plein écran',
        accelerator: IS_MAC ? 'Ctrl+Cmd+F' : 'F11',
      },
      ...(IS_DEV
        ? [
            { type: 'separator' },
            { role: 'reload', label: 'Recharger' },
            { role: 'toggleDevTools', label: 'Outils de développement' },
          ]
        : []),
    ],
  };
  const helpMenu = {
    label: 'Aide',
    submenu: [
      { label: 'Wiki OpenTT3D', click: () => openExternal(WIKI_URL) },
      { label: 'Signaler un problème', click: () => openExternal(ISSUES_URL) },
      { type: 'separator' },
      { label: 'À propos d’OpenTT3D', click: showAbout },
    ],
  };

  const template = [];
  if (IS_MAC) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: 'À propos d’OpenTT3D' },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer OpenTT3D' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter OpenTT3D' },
      ],
    });
  }
  template.push(fileMenu, editMenu, viewMenu, helpMenu);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- capture dev

function scheduleCapture(wc) {
  if (!SCREENSHOT_PATH) return;
  const delay = Math.max(0, Number(process.env.OPENTT3D_SCREENSHOT_DELAY || 2500) || 0);
  setTimeout(async () => {
    try {
      const image = await wc.capturePage();
      fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
      fs.writeFileSync(SCREENSHOT_PATH, image.toPNG());
      console.log(`[opentt3d] capture enregistrée : ${SCREENSHOT_PATH}`);
    } catch (error) {
      console.error('[opentt3d] capture impossible :', error);
    } finally {
      app.quit();
    }
  }, delay);
}

// ---------------------------------------------------------------- fenêtre

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: config.WINDOW_DEFAULTS.minWidth,
    minHeight: config.WINDOW_DEFAULTS.minHeight,
    show: false,
    title: 'OpenTT3D',
    backgroundColor: config.WINDOW_DEFAULTS.backgroundColor,
    autoHideMenuBar: false,
    ...(IS_MAC ? {} : { icon: path.join(config.ROOT_DIR, 'build', 'icon.png') }),
    webPreferences: { ...config.WEB_PREFERENCES },
  });

  if (state.maximized) win.maximize();
  if (state.fullscreen) win.setFullScreen(true);

  const wc = win.webContents;
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {
    // La fenêtre peut se fermer avant l'application de la limite.
  });
  wireErrorHandling(wc);

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.show();
  });
  wc.once('did-finish-load', () => {
    if (WANTS_DEVTOOLS) wc.openDevTools({ mode: 'detach' });
    scheduleCapture(wc);
  });

  // Tout lien sortant part dans le navigateur système ; la page ne navigue
  // jamais hors de son origine.
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (allowedNavigation(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());

  // F11 (Windows/Linux), plein écran natif sur macOS, devtools réservés au
  // développement. Rechargement et zoom clavier désactivés : ils cassent une
  // partie en cours ou la mise en page du HUD.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const mod = input.control || input.meta;
    if (key === 'f11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (IS_DEV && mod && input.shift && key === 'i') {
      wc.toggleDevTools();
      event.preventDefault();
    } else if (key === 'f5' || (mod && ['r', '+', '=', '-', '0'].includes(key))) {
      event.preventDefault();
    }
  });

  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
  });

  wc.loadURL(startUrl()).catch(() => {
    // did-fail-load affiche le diagnostic et propose de réessayer.
  });
}

// ---------------------------------------------------------------- démarrage

function start() {
  protocol.handle(config.SCHEME, serveApp);

  const ses = session.defaultSession;
  const allowed = new Set(config.ALLOWED_PERMISSIONS);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('before-quit', saveWindowState);

  app
    .whenReady()
    .then(() => {
      if (!IS_DEV && !fs.existsSync(path.join(config.DIST_DIR, 'index.html'))) {
        dialog.showErrorBox(
          'Build introuvable',
          `Le dossier dist/ ne contient pas index.html.\n\nLancez « npm run build » puis relancez « npm run desktop ».`,
        );
        app.quit();
        return;
      }
      start();
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Démarrage impossible',
        String(error && error.stack ? error.stack : error),
      );
      app.quit();
    });
}

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
