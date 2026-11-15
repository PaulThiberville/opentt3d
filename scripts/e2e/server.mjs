/**
 * Serveur de développement Vite lancé par le harnais E2E.
 *
 * On utilise l'API programmatique de Vite plutôt qu'un `child_process` : l'URL
 * exacte (port éphémère) et l'arrêt propre sont ainsi garantis, sans parser la
 * sortie console. Le mode `preview` n'est pas proposé car les scénarios
 * s'appuient sur `window.__opentt3d`, exposé uniquement en développement ; le
 * serveur de dev sert exactement le même code source que la CI.
 */

import { createServer as createHttpServer } from 'node:net';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createHttpServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Port libre introuvable'))));
    });
  });
}

export async function startDevServer(options = {}) {
  const root = options.root;
  if (!root) throw new Error('startDevServer : racine du dépôt manquante');
  await access(join(root, 'index.html'));

  const port = options.port ?? (await findFreePort());
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: options.logLevel ?? 'error',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
  });
  await server.listen();
  const resolved = server.resolvedUrls?.local?.[0];
  const url = (resolved ?? `http://127.0.0.1:${port}/`).replace(/\/$/, '');
  return {
    url,
    port,
    mode: 'dev',
    async close() {
      await server.close();
    },
  };
}
