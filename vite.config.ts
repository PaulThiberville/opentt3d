import { readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import {
  buildPrecacheList,
  computeCacheVersion,
  fnv1a32Bytes,
  type PrecacheEntry,
} from './src/pwa.ts';

/** Liste récursive des fichiers d'un dossier, en chemins relatifs POSIX. */
async function listFiles(directory: string, base: string = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute, base)));
    } else if (entry.isFile()) {
      files.push(relative(base, absolute).split(sep).join('/'));
    }
  }
  return files;
}

/**
 * Génère `dist/sw.js` : injecte dans `public/sw.js` la liste des fichiers de
 * l'app shell et une version de cache dérivée de leur contenu.
 *
 * Le service worker reste un fichier statique lisible (pas de bundling) ; seule
 * cette injection dépend du build, ce qui garantit que les noms hashés par
 * Vite et la version de cache sont toujours cohérents.
 */
function pwaServiceWorker(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  let publicDir = 'public';

  return {
    name: 'opentt3d:pwa-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
      publicDir = config.publicDir;
    },
    async closeBundle() {
      const distDir = isAbsolute(outDir) ? outDir : resolve(root, outDir);
      const publicPath = isAbsolute(publicDir) ? publicDir : resolve(root, publicDir);
      const templatePath = join(publicPath, 'sw.js');
      let template: string;
      try {
        template = await readFile(templatePath, 'utf8');
      } catch {
        this.warn(`modèle de service worker introuvable : ${templatePath}`);
        return;
      }

      const files = await listFiles(distDir);
      const urls = buildPrecacheList(files);
      const entries: PrecacheEntry[] = [];
      for (const url of urls) {
        const bytes = await readFile(join(distDir, url.split('/').join(sep)));
        entries.push({ url, size: bytes.byteLength, digest: fnv1a32Bytes(bytes).toString(16) });
      }
      const version = computeCacheVersion(entries);

      const generated = template
        .replace("const PWA_VERSION = '__PWA_VERSION__';", `const PWA_VERSION = '${version}';`)
        .replace('/* __PWA_PRECACHE__ */ []', JSON.stringify(urls));
      if (generated.includes('__PWA_VERSION__') || generated.includes('__PWA_PRECACHE__')) {
        throw new Error('Injection PWA incomplète : marqueurs introuvables dans public/sw.js.');
      }
      await writeFile(join(distDir, 'sw.js'), generated, 'utf8');

      const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
      this.info(
        `PWA : ${urls.length} fichiers précachés (${(totalBytes / 1024).toFixed(0)} Ko), ` +
          `cache ${version}.`,
      );
    },
  };
}

const APP_VERSION =
  (
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version?: string;
    }
  ).version ?? '0.0.0';

// Relative base keeps the build deployable on GitHub Pages project sites,
// in a sub-directory, or from the local file system.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [pwaServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    host: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
