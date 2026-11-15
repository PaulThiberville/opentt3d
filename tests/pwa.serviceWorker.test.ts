import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const SW_SOURCE = readFileSync(`${root}public/sw.js`, 'utf8');
const SCOPE = 'https://app.test/game/';
const VERSION = 'v1-abc12345';
const PRECACHE = ['index.html', 'assets/app-abc.js', 'icons/icon-192.png', 'manifest.webmanifest'];

type FakeRequest = {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
};

type FetchEventLike = {
  request: FakeRequest;
  responded: boolean;
  response: Promise<Response> | null;
  respondWith(response: Promise<Response> | Response): void;
};

function appUrl(path: string): string {
  return new URL(path, SCOPE).href;
}

function request(path: string, options: { method?: string; mode?: string; range?: boolean } = {}) {
  const headers = new Headers();
  if (options.range) headers.set('range', 'bytes=0-1023');
  return {
    url: appUrl(path),
    method: options.method ?? 'GET',
    mode: options.mode ?? 'cors',
    headers,
  } satisfies FakeRequest;
}

function requestUrl(request: unknown): string {
  if (typeof request === 'string') return appUrl(request);
  if (request instanceof URL) return request.href;
  const url = (request as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? url : String(request);
}

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async match(
    request: unknown,
    options: { ignoreSearch?: boolean } = {},
  ): Promise<Response | undefined> {
    const key = requestUrl(request);
    const direct = this.entries.get(key);
    if (direct) return direct.clone();
    if (options.ignoreSearch) {
      const bare = key.split('?')[0];
      for (const [candidate, response] of this.entries) {
        if (candidate.split('?')[0] === bare) return response.clone();
      }
    }
    return undefined;
  }

  async put(request: unknown, response: Response): Promise<void> {
    this.entries.set(requestUrl(request), response.clone());
  }

  async keys(): Promise<Array<{ url: string }>> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }

  async delete(request: unknown): Promise<boolean> {
    return this.entries.delete(requestUrl(request));
  }
}

class MemoryCaches {
  private readonly stores = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async match(
    request: unknown,
    options: { ignoreSearch?: boolean } = {},
  ): Promise<Response | undefined> {
    for (const cache of this.stores.values()) {
      const found = await cache.match(request, options);
      if (found) return found;
    }
    return undefined;
  }

  async seed(name: string, path: string, body: string): Promise<void> {
    const cache = await this.open(name);
    await cache.put(request(path), new Response(body, { status: 200 }));
  }

  async contents(name: string): Promise<string[]> {
    const cache = this.stores.get(name);
    return cache ? [...cache.entries.keys()] : [];
  }
}

class Network {
  mode: 'online' | 'offline' = 'online';
  readonly calls: string[] = [];
  readonly routes = new Map<string, () => Response>();
  readonly failures = new Set<string>();

  async fetch(request: unknown): Promise<Response> {
    const url = requestUrl(request);
    this.calls.push(url);
    await Promise.resolve();
    if (this.mode === 'offline' || this.failures.has(url)) {
      throw new TypeError(`Failed to fetch ${url}`);
    }
    const route = this.routes.get(url);
    if (route) return route();
    return new Response(`network:${url}`, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  respond(path: string, body: string, status = 200): void {
    this.routes.set(
      appUrl(path),
      () => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } }),
    );
  }
}

interface Harness {
  caches: MemoryCaches;
  network: Network;
  skipWaitingCalls: number;
  claimed: number;
  clientMessages: unknown[];
  dispatch(type: string, event: unknown): void;
  install(): Promise<unknown>;
  activate(): Promise<unknown>;
  fetch(request: FakeRequest): FetchEventLike;
}

function createHarness(precache: string[] = PRECACHE): Harness {
  const caches = new MemoryCaches();
  const network = new Network();
  const handlers = new Map<string, Array<(event: never) => void>>();
  const clientMessages: unknown[] = [];
  const state = { skipWaitingCalls: 0, claimed: 0 };
  const client = {
    postMessage(message: unknown) {
      clientMessages.push(message);
    },
  };
  const selfObject = {
    registration: { scope: SCOPE },
    location: { origin: 'https://app.test', href: appUrl('sw.js') },
    clients: {
      claim: async () => {
        state.claimed += 1;
      },
      matchAll: async () => [client],
    },
    skipWaiting: () => {
      state.skipWaitingCalls += 1;
    },
    addEventListener(type: string, handler: (event: never) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
  };

  const source = SW_SOURCE.replace(
    "const PWA_VERSION = '__PWA_VERSION__';",
    `const PWA_VERSION = '${VERSION}';`,
  ).replace('/* __PWA_PRECACHE__ */ []', JSON.stringify(precache));

  runInNewContext(source, {
    self: selfObject,
    caches,
    fetch: (input: unknown) => network.fetch(input),
    Request,
    Response,
    URL,
    Headers,
    TextEncoder,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const dispatch = (type: string, event: unknown): void => {
    for (const handler of handlers.get(type) ?? []) {
      (handler as (value: unknown) => void)(event);
    }
  };

  return {
    caches,
    network,
    get skipWaitingCalls() {
      return state.skipWaitingCalls;
    },
    get claimed() {
      return state.claimed;
    },
    clientMessages,
    dispatch,
    install() {
      const event: { promise?: Promise<unknown>; waitUntil(promise: Promise<unknown>): void } = {
        waitUntil(promise) {
          event.promise = promise;
        },
      };
      dispatch('install', event);
      return event.promise ?? Promise.resolve();
    },
    activate() {
      const event: { promise?: Promise<unknown>; waitUntil(promise: Promise<unknown>): void } = {
        waitUntil(promise) {
          event.promise = promise;
        },
      };
      dispatch('activate', event);
      return event.promise ?? Promise.resolve();
    },
    fetch(input: FakeRequest): FetchEventLike {
      const event: FetchEventLike = {
        request: input,
        responded: false,
        response: null,
        respondWith(response) {
          event.responded = true;
          event.response = Promise.resolve(response);
        },
      };
      dispatch('fetch', event);
      return event;
    },
  };
}

/** Laisse tourner les microtâches des revalidations en arrière-plan. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('service worker — installation', () => {
  it('précache l’app shell sous des URL absolues de la portée', async () => {
    const harness = createHarness();
    await harness.install();
    expect(await harness.caches.keys()).toEqual([`opentt3d-precache-${VERSION}`]);
    expect((await harness.caches.contents(`opentt3d-precache-${VERSION}`)).sort()).toEqual(
      PRECACHE.map(appUrl).sort(),
    );
  });

  it('ne précache pas le moteur et n’appelle pas skipWaiting', async () => {
    const harness = createHarness();
    await harness.install();
    expect(await harness.caches.keys()).not.toContain('opentt3d-engine-v1');
    expect(harness.skipWaitingCalls).toBe(0);
  });

  it('tolère une entrée manquante sans bloquer l’installation', async () => {
    const harness = createHarness();
    harness.network.failures.add(appUrl('icons/icon-192.png'));
    harness.network.respond('manifest.webmanifest', 'manifest', 404);
    await harness.install();
    const contents = await harness.caches.contents(`opentt3d-precache-${VERSION}`);
    expect(contents).toContain(appUrl('index.html'));
    expect(contents).toContain(appUrl('assets/app-abc.js'));
    expect(contents).not.toContain(appUrl('icons/icon-192.png'));
    expect(contents).not.toContain(appUrl('manifest.webmanifest'));
  });
});

describe('service worker — activation', () => {
  it('supprime les anciens caches précache/runtime et conserve le moteur', async () => {
    const harness = createHarness();
    await harness.caches.seed('opentt3d-precache-v1-00000000', 'index.html', 'ancien');
    await harness.caches.seed('opentt3d-runtime-v1-00000000', 'assets/old.js', 'ancien');
    await harness.caches.seed('opentt3d-engine-v1', 'engine/opentt3d-engine.wasm', 'engine');
    await harness.caches.seed('autre-application', 'x.js', 'autre');
    await harness.caches.seed(`opentt3d-precache-${VERSION}`, 'index.html', 'nouveau');
    await harness.install();
    await harness.activate();

    const keys = await harness.caches.keys();
    expect(keys).not.toContain('opentt3d-precache-v1-00000000');
    expect(keys).not.toContain('opentt3d-runtime-v1-00000000');
    expect(keys).toContain('opentt3d-engine-v1');
    expect(keys).toContain('autre-application');
    expect(harness.claimed).toBe(1);
    expect(harness.clientMessages).toEqual([{ type: 'PWA_ACTIVATED', version: VERSION }]);
  });
});

describe('service worker — navigation', () => {
  it('sert le réseau quand il répond', async () => {
    const harness = createHarness();
    await harness.install();
    harness.network.respond('', '<!doctype html><title>réseau</title>');
    const event = harness.fetch(request('', { mode: 'navigate' }));
    expect(event.responded).toBe(true);
    const response = await event.response!;
    expect(await response.text()).toContain('réseau');
  });

  it('retombe sur index.html précaché hors ligne', async () => {
    const harness = createHarness();
    harness.network.respond('index.html', '<!doctype html><title>cache</title>');
    await harness.install();
    harness.network.mode = 'offline';
    const event = harness.fetch(request('?seed=1337', { mode: 'navigate' }));
    const response = await event.response!;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('cache');
  });

  it('retombe sur index.html même pour une URL profonde', async () => {
    const harness = createHarness();
    harness.network.respond('index.html', '<!doctype html><title>shell</title>');
    await harness.install();
    harness.network.mode = 'offline';
    const response = await harness.fetch(request('jouer/salon', { mode: 'navigate' })).response!;
    expect(await response.text()).toContain('shell');
  });

  it('affiche un message hors ligne si rien n’est précaché', async () => {
    const harness = createHarness([]);
    await harness.install();
    harness.network.mode = 'offline';
    const response = await harness.fetch(request('', { mode: 'navigate' })).response!;
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('OpenTT3D');
    expect(body).toContain('hors ligne');
  });
});

describe('service worker — assets de l’app', () => {
  it('sert le cache immédiatement puis revalide en arrière-plan', async () => {
    const harness = createHarness();
    await harness.install();
    harness.network.respond('assets/lazy-def.js', 'version-1');

    const first = await harness.fetch(request('assets/lazy-def.js')).response!;
    expect(await first.text()).toBe('version-1');
    await flush();

    harness.network.mode = 'offline';
    const second = await harness.fetch(request('assets/lazy-def.js')).response!;
    expect(await second.text()).toBe('version-1');
  });

  it('met à jour le cache pendant que l’ancienne version est servie', async () => {
    const harness = createHarness();
    await harness.install();
    harness.network.respond('assets/lazy-def.js', 'version-1');
    await (await harness.fetch(request('assets/lazy-def.js')).response!).text();
    await flush();

    harness.network.respond('assets/lazy-def.js', 'version-2');
    const stale = await (await harness.fetch(request('assets/lazy-def.js')).response!).text();
    expect(stale).toBe('version-1');
    await flush();

    harness.network.mode = 'offline';
    const updated = await (await harness.fetch(request('assets/lazy-def.js')).response!).text();
    expect(updated).toBe('version-2');
  });

  it('ne cache pas une réponse en erreur', async () => {
    const harness = createHarness();
    await harness.install();
    harness.network.respond('assets/lazy-def.js', 'erreur', 500);
    const response = await harness.fetch(request('assets/lazy-def.js')).response!;
    expect(response.status).toBe(500);
    await flush();
    const runtime = await harness.caches.contents(`opentt3d-runtime-${VERSION}`);
    expect(runtime).toEqual([]);
  });
});

describe('service worker — artefacts moteur', () => {
  it('sert depuis le cache après une première visite hors ligne', async () => {
    const harness = createHarness();
    await harness.install();
    harness.network.respond('engine/opentt3d-engine.wasm', 'wasm-binaire');
    const online = await harness.fetch(request('engine/opentt3d-engine.wasm')).response!;
    expect(await online.text()).toBe('wasm-binaire');
    await flush();

    harness.network.mode = 'offline';
    const offline = await harness.fetch(request('engine/opentt3d-engine.wasm')).response!;
    expect(await offline.text()).toBe('wasm-binaire');
  });

  it('privilégie le réseau quand il répond', async () => {
    const harness = createHarness();
    harness.network.respond('engine/opentt3d-engine.js', 'v1');
    await (await harness.fetch(request('engine/opentt3d-engine.js')).response!).text();
    await flush();
    harness.network.respond('engine/opentt3d-engine.js', 'v2');
    const response = await harness.fetch(request('engine/opentt3d-engine.js')).response!;
    expect(await response.text()).toBe('v2');
  });

  it('borne le cache moteur et ignore la requête en cas d’absence', async () => {
    const harness = createHarness();
    for (let i = 0; i < 10; i++) {
      harness.network.respond(`engine/chunk-${i}.bin`, `chunk-${i}`);
      await (await harness.fetch(request(`engine/chunk-${i}.bin`)).response!).text();
      await flush();
    }
    const contents = await harness.caches.contents('opentt3d-engine-v1');
    expect(contents.length).toBeLessThanOrEqual(8);
    expect(contents.at(-1)).toBe(appUrl('engine/chunk-9.bin'));

    harness.network.mode = 'offline';
    const missing = await harness.fetch(request('engine/absent.wasm')).response!;
    expect(missing.status).toBe(504);
  });
});

describe('service worker — requêtes non interceptées', () => {
  const harness = createHarness();

  it('laisse passer les POST', () => {
    expect(harness.fetch(request('save', { method: 'POST' })).responded).toBe(false);
  });

  it('laisse passer le cross-origin', () => {
    const event = harness.fetch({
      url: 'https://cdn.test/engine/opentt3d-engine.wasm',
      method: 'GET',
      mode: 'cors',
      headers: new Headers(),
    });
    expect(event.responded).toBe(false);
  });

  it('laisse passer les requêtes Range', () => {
    expect(harness.fetch(request('engine/opentt3d-engine.data', { range: true })).responded).toBe(
      false,
    );
  });

  it('laisse passer les fichiers inconnus', () => {
    expect(harness.fetch(request('sauvegarde.ot3s')).responded).toBe(false);
  });
});

describe('service worker — messages', () => {
  it('n’active la nouvelle version que sur SKIP_WAITING', () => {
    const harness = createHarness();
    harness.dispatch('message', { data: { type: 'SKIP_WAITING' } });
    expect(harness.skipWaitingCalls).toBe(1);
  });

  it('répond à GET_VERSION', () => {
    const harness = createHarness();
    const replies: unknown[] = [];
    harness.dispatch('message', {
      data: { type: 'GET_VERSION' },
      ports: [{ postMessage: (message: unknown) => replies.push(message) }],
    });
    expect(replies).toEqual([{ type: 'PWA_VERSION', version: VERSION, schema: 'v1' }]);
  });

  it('ignore les messages inconnus', () => {
    const harness = createHarness();
    harness.dispatch('message', { data: null });
    harness.dispatch('message', { data: { type: 'AUTRE' } });
    expect(harness.skipWaitingCalls).toBe(0);
  });
});
