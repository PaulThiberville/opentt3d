import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  fullscreen: boolean;
}

interface DesktopConfig {
  SCHEME: string;
  HOST: string;
  ORIGIN: string;
  APP_URL: string;
  DEV_URL: string;
  DIST_DIR: string;
  PRELOAD_PATH: string;
  CSP: string;
  MIME_TYPES: Record<string, string>;
  WINDOW_DEFAULTS: { width: number; height: number; minWidth: number; minHeight: number };
  WEB_PREFERENCES: Record<string, unknown>;
  ALLOWED_PERMISSIONS: readonly string[];
  mimeTypeFor(filePath: string): string;
  resolveDistFile(pathname: string, distDir?: string): string | null;
  isExternalUrl(url: string): boolean;
  parseEngineChoice(args: string | readonly string[]): 'mock' | 'wasm' | null;
  buildStartUrl(
    baseUrl: string,
    options?: { engine?: string | null; hasWasm?: boolean; autostart?: boolean },
  ): string;
  sanitizeWindowState(state: unknown, displays: readonly unknown[]): WindowState;
}

const config = require('../electron/config.cjs') as DesktopConfig;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  main: string;
  desktopName: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    appId: string;
    productName: string;
    afterPack: string;
    directories: { output: string; buildResources: string };
    files: string[];
    mac: { target: Array<{ target: string; arch: string[] }> };
    win: { target: Array<{ target: string; arch: string[] }> };
    linux: { syncDesktopName?: boolean; target: Array<{ target: string; arch: string[] }> };
  };
};

function cspDirectives(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift();
    if (name) directives.set(name, tokens);
  }
  return directives;
}

describe('sécurité de l’enveloppe Electron', () => {
  it('isole le renderer du processus principal', () => {
    expect(config.WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(config.WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(config.WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(config.WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
    expect(config.WEB_PREFERENCES.sandbox).toBe(true);
    expect(config.WEB_PREFERENCES.webSecurity).toBe(true);
    expect(config.WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
    expect(config.WEB_PREFERENCES.webviewTag).toBe(false);
    expect(config.WEB_PREFERENCES.experimentalFeatures).toBe(false);
    expect(config.WEB_PREFERENCES.preload).toBe(config.PRELOAD_PATH);
    expect(existsSync(config.PRELOAD_PATH)).toBe(true);
  });

  it('applique une CSP stricte, compatible WASM', () => {
    const csp = cspDirectives(config.CSP);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toContain("'self'");
    expect(csp.get('script-src')).toContain("'wasm-unsafe-eval'");
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'");
    expect(csp.get('worker-src')).toContain('blob:');
    expect(csp.get('connect-src')).toEqual(expect.arrayContaining(["'self'", 'wss:', 'https:']));
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
  });

  it('ne demande que les permissions utiles au jeu', () => {
    expect([...config.ALLOWED_PERMISSIONS].sort()).toEqual(
      ['clipboard-sanitized-write', 'fullscreen', 'pointerLock'].sort(),
    );
    expect(config.ALLOWED_PERMISSIONS).not.toContain('media');
    expect(config.ALLOWED_PERMISSIONS).not.toContain('geolocation');
    expect(config.ALLOWED_PERMISSIONS).not.toContain('notifications');
  });

  it('sert le jeu depuis une origine privilégiée app://', () => {
    expect(config.SCHEME).toBe('app');
    expect(config.HOST).toBe('opentt3d');
    expect(config.ORIGIN).toBe('app://opentt3d');
    expect(config.APP_URL).toBe('app://opentt3d/index.html');
    expect(config.DEV_URL).toBe('http://localhost:5173/');
    expect(path.resolve(config.DIST_DIR)).toBe(path.join(root, 'dist'));
  });
});

describe('résolution des fichiers de dist/', () => {
  it('sert l’index et les assets attendus', () => {
    const rootDir = path.join(root, 'dist');
    expect(config.resolveDistFile('/')).toBe(path.join(rootDir, 'index.html'));
    expect(config.resolveDistFile('/index.html')).toBe(path.join(rootDir, 'index.html'));
    expect(config.resolveDistFile('/assets/index-abc.js')).toBe(
      path.join(rootDir, 'assets', 'index-abc.js'),
    );
    expect(config.resolveDistFile('/engine/opentt3d-engine.wasm')).toBe(
      path.join(rootDir, 'engine', 'opentt3d-engine.wasm'),
    );
  });

  it('refuse les traversées de répertoire et les encodages invalides', () => {
    for (const attack of [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2fpackage.json',
      '/assets/../../package.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/\u0000index.html',
      '/%E0%A4%A',
    ]) {
      expect(config.resolveDistFile(attack)).toBeNull();
    }
  });

  it('ne sert jamais un fichier hors de dist/', () => {
    const resolved = config.resolveDistFile('/assets/app.js');
    expect(resolved).not.toBeNull();
    expect(resolved?.startsWith(path.join(root, 'dist') + path.sep)).toBe(true);
  });

  it('déclare les types MIME indispensables au WASM et aux modules ES', () => {
    expect(config.mimeTypeFor('/engine/game.wasm')).toBe('application/wasm');
    expect(config.mimeTypeFor('/assets/main.js')).toContain('text/javascript');
    expect(config.mimeTypeFor('/assets/main.mjs')).toContain('text/javascript');
    expect(config.mimeTypeFor('/assets/main.css')).toContain('text/css');
    expect(config.mimeTypeFor('/engine/game.data')).toBe('application/octet-stream');
    expect(config.mimeTypeFor('/inconnu.bin')).toBe('application/octet-stream');
  });
});

describe('liens externes', () => {
  it('n’autorise que http(s)', () => {
    expect(config.isExternalUrl('https://github.com/PaulThiberville/opentt3d/wiki')).toBe(true);
    expect(config.isExternalUrl('http://example.com')).toBe(true);
    for (const unsafe of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'app://opentt3d/index.html',
      'mailto:test@example.com',
      'data:text/html,<script>alert(1)</script>',
      'pas une url',
    ]) {
      expect(config.isExternalUrl(unsafe)).toBe(false);
    }
  });
});

describe('moteur de démarrage', () => {
  it('lit --engine= et la valeur brute', () => {
    expect(config.parseEngineChoice(['electron', '.', '--engine=wasm'])).toBe('wasm');
    expect(config.parseEngineChoice(['--engine=MOCK'])).toBe('mock');
    expect(config.parseEngineChoice(['--engine=autre'])).toBeNull();
    expect(config.parseEngineChoice([])).toBeNull();
    expect(config.parseEngineChoice('wasm')).toBe('wasm');
    expect(config.parseEngineChoice('inconnu')).toBeNull();
  });

  it('privilégie le WASM empaqueté, sauf demande explicite', () => {
    expect(config.buildStartUrl('app://opentt3d/index.html', { hasWasm: true })).toBe(
      'app://opentt3d/index.html?engine=wasm',
    );
    expect(config.buildStartUrl('app://opentt3d/index.html', { hasWasm: false })).toBe(
      'app://opentt3d/index.html',
    );
    expect(
      config.buildStartUrl('app://opentt3d/index.html', { engine: 'mock', hasWasm: true }),
    ).toBe('app://opentt3d/index.html?engine=mock');
    expect(
      config.buildStartUrl('http://localhost:5173/', { engine: 'wasm', autostart: true }),
    ).toBe('http://localhost:5173/?engine=wasm&autostart=1');
  });
});

describe('état de fenêtre', () => {
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

  it('renvoie les valeurs par défaut si l’état est illisible', () => {
    const state = config.sanitizeWindowState(null, [display]);
    expect(state.width).toBe(config.WINDOW_DEFAULTS.width);
    expect(state.height).toBe(config.WINDOW_DEFAULTS.height);
    expect(state.maximized).toBe(false);
    expect(state.fullscreen).toBe(false);
    expect(state.x).toBeUndefined();
    expect(state.y).toBeUndefined();
  });

  it('borne les dimensions minimales et maximales', () => {
    const tooSmall = config.sanitizeWindowState({ width: 10, height: 10 }, [display]);
    expect(tooSmall.width).toBe(config.WINDOW_DEFAULTS.minWidth);
    expect(tooSmall.height).toBe(config.WINDOW_DEFAULTS.minHeight);

    const tooLarge = config.sanitizeWindowState({ width: 999999, height: 999999 }, [display]);
    expect(tooLarge.width).toBe(10000);
    expect(tooLarge.height).toBe(10000);
  });

  it('conserve une position visible et écarte une position hors écran', () => {
    const visible = config.sanitizeWindowState(
      { x: 100, y: 80, width: 1280, height: 720, maximized: true },
      [display],
    );
    expect(visible).toMatchObject({ x: 100, y: 80, width: 1280, height: 720, maximized: true });

    const offscreen = config.sanitizeWindowState({ x: -5000, y: 9000, width: 1280, height: 720 }, [
      display,
    ]);
    expect(offscreen.x).toBeUndefined();
    expect(offscreen.y).toBeUndefined();
    expect(offscreen.width).toBe(1280);
  });

  it('ignore les coordonnées non finies', () => {
    const state = config.sanitizeWindowState(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 1400, height: 800 },
      [display],
    );
    expect(state.x).toBeUndefined();
    expect(state.y).toBeUndefined();
    expect(state.width).toBe(1400);
  });
});

describe('configuration de packaging', () => {
  it('déclare le point d’entrée Electron et les scripts desktop', () => {
    expect(pkg.main).toBe('electron/main.cjs');
    expect(pkg.scripts.desktop).toBe('npm run build && electron .');
    expect(pkg.scripts['desktop:dev']).toBe('electron . --dev');
    expect(pkg.scripts['dist:mac']).toBe('npm run build && electron-builder --mac --publish never');
    expect(pkg.scripts['dist:win']).toBe('npm run build && electron-builder --win --publish never');
    expect(pkg.scripts['dist:linux']).toBe(
      'npm run build && electron-builder --linux --publish never',
    );
    expect(pkg.scripts.build).toBe('tsc --noEmit && vite build');
  });

  it('épingle electron et electron-builder en devDependencies', () => {
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('cible les formats DMG/ZIP, NSIS et AppImage', () => {
    expect(pkg.build.appId).toBe('io.github.paulthiberville.opentt3d');
    expect(pkg.build.productName).toBe('OpenTT3D');
    expect(pkg.desktopName).toBe('OpenTT3D.desktop');
    expect(pkg.build.directories).toEqual({ output: 'release', buildResources: 'build' });
    expect(pkg.build.files).toEqual(expect.arrayContaining(['dist/**/*', 'electron/**/*']));
    expect(pkg.build.mac.target.map((target) => target.target).sort()).toEqual(['dmg', 'zip']);
    expect(pkg.build.win.target.map((target) => target.target).sort()).toEqual(['nsis', 'zip']);
    expect(pkg.build.linux.target.map((target) => target.target)).toEqual(['AppImage']);
    expect(pkg.build.linux.syncDesktopName).toBe(true);
    expect(existsSync(path.join(root, pkg.build.afterPack))).toBe(true);
  });
});
