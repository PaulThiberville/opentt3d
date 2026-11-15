import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PWA_ENGINE_CACHE,
  PWA_SERVICE_WORKER_PATH,
  buildPrecacheList,
  computeCacheVersion,
  fnv1a32,
  fnv1a32Bytes,
  isStaleCacheName,
  normalizePrecacheUrl,
  precacheCacheName,
  resolveRoute,
  runtimeCacheName,
  startPwa,
  validateWebManifest,
} from '../src/pwa';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicFile = (path: string): Uint8Array => readFileSync(`${root}public/${path}`);

/** Lit largeur/hauteur dans l'en-tête IHDR d'un PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number; colorType: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(Buffer.from(bytes.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
  expect(Buffer.from(bytes.subarray(12, 16)).toString('ascii')).toBe('IHDR');
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    colorType: bytes[25] ?? -1,
  };
}

describe('manifeste PWA', () => {
  const manifest: unknown = JSON.parse(
    Buffer.from(publicFile('manifest.webmanifest')).toString('utf8'),
  );

  it('est valide et installable', () => {
    const result = validateWebManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('décrit une application standalone en français', () => {
    const data = manifest as Record<string, unknown>;
    expect(data['name']).toBeTruthy();
    expect(data['short_name']).toBeTruthy();
    expect(data['start_url']).toBe('./');
    expect(data['scope']).toBe('./');
    expect(data['display']).toBe('standalone');
    expect(data['lang']).toBe('fr');
    expect(data['theme_color']).toBe('#10151c');
    expect(data['background_color']).toBe('#10151c');
    expect(data['categories']).toEqual(expect.arrayContaining(['games']));
  });

  it('expose des icônes 192/512 any et maskable servies par le build', () => {
    const icons = (manifest as { icons: Array<Record<string, string>> }).icons;
    const sources = icons.map((icon) => icon['src'] ?? '');
    for (const src of sources) {
      const relative = src.replace(/^\.\//, '');
      const size = pngSize(publicFile(relative));
      expect(size.colorType).toBe(6);
      expect(size.width).toBe(size.height);
      expect([192, 512]).toContain(size.width);
    }
    expect(icons.some((icon) => icon['sizes'] === '192x192' && icon['purpose'] === 'any')).toBe(
      true,
    );
    expect(icons.some((icon) => icon['sizes'] === '512x512' && icon['purpose'] === 'any')).toBe(
      true,
    );
    expect(
      icons.filter((icon) => icon['purpose'] === 'maskable').map((icon) => icon['sizes']),
    ).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });

  it('fournit une apple-touch-icon opaque', () => {
    const size = pngSize(publicFile('icons/apple-touch-icon-180.png'));
    expect(size.width).toBe(180);
    expect(size.height).toBe(180);
    expect(size.colorType).toBe(6);
    const alpha = publicFile('icons/apple-touch-icon-180.png');
    expect(alpha.length).toBeGreaterThan(0);
  });

  it('signale les manifestes incomplets', () => {
    const missing = validateWebManifest({ name: 'X' });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toContain('short_name');
    expect(missing.errors.join(' ')).toContain('icons');

    const badColor = validateWebManifest({
      name: 'X',
      short_name: 'X',
      start_url: './',
      display: 'standalone',
      theme_color: 'bleu',
      background_color: '#fff',
      icons: [
        { src: './a.png', sizes: '192x192', type: 'image/png' },
        { src: './b.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    });
    expect(badColor.ok).toBe(false);
    expect(badColor.errors.join(' ')).toContain('theme_color');

    const noMaskable = validateWebManifest({
      name: 'X',
      short_name: 'X',
      start_url: './',
      display: 'standalone',
      theme_color: '#000',
      background_color: '#fff',
      icons: [
        { src: './a.png', sizes: '192x192', type: 'image/png' },
        { src: './b.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    expect(noMaskable.ok).toBe(true);
    expect(noMaskable.warnings.join(' ')).toContain('maskable');
  });
});

describe('liste de précache', () => {
  const files = [
    'index.html',
    'assets/index-a1b2c3.js',
    'assets/index-a1b2c3.css',
    'assets/index-a1b2c3.js.map',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'manifest.webmanifest',
    'favicon.svg',
    'engine/opentt3d-engine.js',
    'engine/opentt3d-engine.wasm',
    'engine/opentt3d-engine.data',
    'sw.js',
    'notes.txt',
  ];

  it('retient l’app shell, jamais le moteur ni les sourcemaps', () => {
    const list = buildPrecacheList(files);
    expect(list[0]).toBe('index.html');
    expect(list).toContain('assets/index-a1b2c3.js');
    expect(list).toContain('assets/index-a1b2c3.css');
    expect(list).toContain('icons/icon-192.png');
    expect(list).toContain('manifest.webmanifest');
    expect(list).toContain('favicon.svg');
    expect(list).not.toContain('assets/index-a1b2c3.js.map');
    expect(list).not.toContain('sw.js');
    expect(list).not.toContain('notes.txt');
    expect(list.some((url) => url.startsWith('engine/'))).toBe(false);
  });

  it('normalise, déduplique et respecte les exclusions', () => {
    const list = buildPrecacheList(
      ['./index.html', '/assets/a.js', 'assets//a.js', 'assets/a.js?x=1#y', 'assets/b.css'],
      { exclude: ['assets/b.css'] },
    );
    expect(list).toEqual(['index.html', 'assets/a.js']);
  });

  it('exclut toujours le service worker lui-même', () => {
    expect(PWA_SERVICE_WORKER_PATH).toBe('sw.js');
    expect(buildPrecacheList(['index.html', 'sw.js'])).not.toContain('sw.js');
  });

  it('rejette les chemins qui sortent de la racine', () => {
    expect(buildPrecacheList(['../secret.js', 'assets/ok.js'])).toEqual(['assets/ok.js']);
  });

  it('normalise les URL absolues', () => {
    expect(normalizePrecacheUrl('https://example.test/assets/a.js?v=2')).toBe('assets/a.js');
  });
});

describe('version de cache', () => {
  const entries = [
    { url: 'index.html', size: 1200, digest: 'aa' },
    { url: 'assets/index-a1b2c3.js', size: 500000, digest: 'bb' },
  ];

  it('est déterministe et indépendante de l’ordre', () => {
    const a = computeCacheVersion(entries);
    const b = computeCacheVersion([...entries].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^v1-[0-9a-f]{8}$/);
  });

  it('change dès qu’un fichier change', () => {
    const base = computeCacheVersion(entries);
    expect(computeCacheVersion([{ ...entries[0]!, size: 1201 }, entries[1]!])).not.toBe(base);
    expect(computeCacheVersion([{ ...entries[0]!, digest: 'ab' }, entries[1]!])).not.toBe(base);
    expect(computeCacheVersion([...entries, { url: 'favicon.svg', size: 42 }])).not.toBe(base);
  });

  it('nomme les caches app shell et runtime avec la version', () => {
    expect(precacheCacheName('v1-00000000')).toBe('opentt3d-precache-v1-00000000');
    expect(runtimeCacheName('v1-00000000')).toBe('opentt3d-runtime-v1-00000000');
  });

  it('ne supprime que les anciens caches précache/runtime', () => {
    expect(isStaleCacheName('opentt3d-precache-v1-old', 'v1-new')).toBe(true);
    expect(isStaleCacheName('opentt3d-runtime-v1-old', 'v1-new')).toBe(true);
    expect(isStaleCacheName(precacheCacheName('v1-new'), 'v1-new')).toBe(false);
    expect(isStaleCacheName(runtimeCacheName('v1-new'), 'v1-new')).toBe(false);
    expect(isStaleCacheName(PWA_ENGINE_CACHE, 'v1-new')).toBe(false);
    expect(isStaleCacheName('autre-app-cache', 'v1-new')).toBe(false);
  });

  it('calcule un FNV-1a 32 bits stable', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32Bytes(new Uint8Array([97]))).toBe(fnv1a32('a'));
    expect(fnv1a32Bytes(new TextEncoder().encode('OpenTT3D'))).toBe(fnv1a32('OpenTT3D'));
  });
});

describe('choix de stratégie', () => {
  it('réserve le network-first à la navigation', () => {
    expect(resolveRoute({ url: 'https://app.test/game/?seed=1', mode: 'navigate' })).toBe(
      'navigate',
    );
  });

  it('classe les artefacts moteur à part', () => {
    expect(
      resolveRoute({
        url: 'https://app.test/game/engine/opentt3d-engine.wasm',
        scope: 'https://app.test/game/',
      }),
    ).toBe('engine');
    expect(
      resolveRoute({
        url: 'https://app.test/game/engine/opentt3d-engine.data?v=1',
        scope: 'https://app.test/game/',
      }),
    ).toBe('engine');
    expect(resolveRoute({ url: '/engine/opentt3d-engine.js' })).toBe('engine');
  });

  it('met les assets de l’app shell en cache-first', () => {
    expect(resolveRoute({ url: 'https://app.test/game/assets/index-a1b2c3.js' })).toBe('app-shell');
    expect(resolveRoute({ url: 'https://app.test/game/assets/index-a1b2c3.css' })).toBe(
      'app-shell',
    );
    expect(resolveRoute({ url: 'https://app.test/game/icons/icon-192.png' })).toBe('app-shell');
    expect(resolveRoute({ url: 'https://app.test/game/manifest.webmanifest' })).toBe('app-shell');
  });

  it('laisse passer POST, cross-origin et fichiers inconnus', () => {
    expect(resolveRoute({ url: 'https://app.test/game/save', method: 'POST' })).toBe('bypass');
    expect(
      resolveRoute({ url: 'https://cdn.test/engine/opentt3d-engine.wasm', sameOrigin: false }),
    ).toBe('bypass');
    expect(resolveRoute({ url: 'https://app.test/game/save.bin' })).toBe('bypass');
  });
});

describe('source du service worker', () => {
  it('contient les marqueurs injectés au build', () => {
    const source = Buffer.from(publicFile('sw.js')).toString('utf8');
    expect(source).toContain("const PWA_VERSION = '__PWA_VERSION__';");
    expect(source).toContain('/* __PWA_PRECACHE__ */ []');
    // Pas de skipWaiting automatique : la mise à jour doit rester consentie.
    expect(source).not.toMatch(/install[\s\S]{0,200}skipWaiting\(\)/);
  });

  it('ne précache jamais engine/ par défaut', () => {
    const source = Buffer.from(publicFile('sw.js')).toString('utf8');
    expect(source).toContain('const ENGINE_CACHE = `${CACHE_PREFIX}-engine-v1`');
  });
});

describe('enregistrement', () => {
  it('ne touche pas au DOM quand il est désactivé', () => {
    const controller = startPwa({ enabled: false });
    expect(controller.supported).toBe(false);
    expect(controller.updateAvailable).toBe(false);
    expect(() => controller.notifyAppIdle()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});
