import { afterEach, describe, expect, it } from 'vitest';
import {
  ENGINE_ASSET_FILES,
  cachedEngineArtifacts,
  detectEngineArtifacts,
  engineAssetBaseUrl,
  peekEngineArtifacts,
  resetEngineArtifactsCache,
  resolveEngineAssetUrl,
  resolveEngineAssetUrls,
} from '../src/engine/engineAssets';

type FetchCall = { url: string; init: RequestInit | undefined };

const BASE = 'https://example.test/opentt3d/';

function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => {
  resetEngineArtifactsCache();
});

describe('artefacts du moteur (#78)', () => {
  it('résout les trois fichiers sous la base de l’application', () => {
    expect(resolveEngineAssetUrl('opentt3d-engine.wasm', BASE)).toBe(
      'https://example.test/opentt3d/engine/opentt3d-engine.wasm',
    );
    expect(resolveEngineAssetUrls(BASE)).toEqual(
      ENGINE_ASSET_FILES.map((file) => `https://example.test/opentt3d/engine/${file}`),
    );
    expect(ENGINE_ASSET_FILES).toContain('opentt3d-engine.js');
    expect(ENGINE_ASSET_FILES).toContain('opentt3d-engine.data');
  });

  it('expose une base utilisable même sans DOM', () => {
    expect(engineAssetBaseUrl()).toBeTruthy();
  });

  it('détecte les artefacts présents', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const result = await detectEngineArtifacts({
      baseUrl: BASE,
      fetchImpl,
      now: () => 42,
    });
    expect(result.reason).toBe('available');
    expect(result.available).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unreachable).toEqual([]);
    expect(result.checkedAt).toBe(42);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.init?.method).toBe('HEAD');
  });

  it('refuse un fallback HTML renvoyé à la place du fichier', async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
    const result = await detectEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(result.reason).toBe('missing');
    expect(result.missing).toEqual([...ENGINE_ASSET_FILES]);
  });

  it('signale un fichier absent sans confondre avec une panne réseau', async () => {
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith('.data')
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200 }),
    );
    const result = await detectEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(result.reason).toBe('missing');
    expect(result.available).toBe(false);
    expect(result.missing).toEqual(['opentt3d-engine.data']);
    expect(result.unreachable).toEqual([]);
  });

  it('ne lève jamais quand le réseau échoue', async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new TypeError('offline')));
    const result = await detectEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(result.reason).toBe('network');
    expect(result.available).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.unreachable).toEqual([...ENGINE_ASSET_FILES]);
  });

  it('privilégie un 404 explicite sur un doute réseau', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith('.wasm')) return new Response(null, { status: 404 });
      return Promise.reject(new TypeError('timeout'));
    });
    const result = await detectEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(result.reason).toBe('missing');
    expect(result.missing).toEqual(['opentt3d-engine.wasm']);
    expect(result.unreachable).toEqual(['opentt3d-engine.js', 'opentt3d-engine.data']);
  });

  it('replie HEAD refusé sur un GET Range sans télécharger le paquet', async () => {
    const { fetchImpl, calls } = fakeFetch((_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(null, { status: 206 });
    });
    const result = await detectEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(result.reason).toBe('available');
    expect(calls.filter((call) => call.init?.method === 'GET')).toHaveLength(3);
    for (const call of calls.filter((entry) => entry.init?.method === 'GET')) {
      expect((call.init?.headers as Record<string, string>).Range).toBe('bytes=0-0');
    }
  });

  it('met le résultat en cache en mémoire par base d’URL', async () => {
    let probes = 0;
    const { fetchImpl } = fakeFetch(() => {
      probes += 1;
      return new Response(null, { status: 200 });
    });
    const first = await cachedEngineArtifacts({ baseUrl: BASE, fetchImpl });
    const second = await cachedEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(second).toBe(first);
    expect(probes).toBe(3);
    expect(peekEngineArtifacts()).toBe(first);

    resetEngineArtifactsCache();
    expect(peekEngineArtifacts()).toBeNull();
    await cachedEngineArtifacts({ baseUrl: BASE, fetchImpl });
    expect(probes).toBe(6);
  });

  it('ne bloque pas indéfiniment avec un fetch qui ne répond pas', async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await detectEngineArtifacts({ baseUrl: BASE, fetchImpl, timeoutMs: 10 });
    expect(result.reason).toBe('network');
  });
});
