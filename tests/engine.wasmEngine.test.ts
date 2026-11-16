import { describe, expect, it } from 'vitest';
import { WasmEngine } from '../src/engine/WasmEngine';
import { PROTOCOL_VERSION } from '../src/engine/protocol';
import { FakeEngineModule } from './fixtures/fakeEngineModule';

interface Harness {
  engine: WasmEngine;
  fake: FakeEngineModule;
  warnings: string[];
}

async function createEngine(memoryMiB?: number): Promise<Harness> {
  const fake = new FakeEngineModule();
  const warnings: string[] = [];
  const engine = new WasmEngine({ factory: async () => fake.asModule() });
  await engine.init({
    moduleUrl: 'fake://engine',
    ...(memoryMiB === undefined ? {} : { memoryMiB }),
    onWarning: (message) => warnings.push(message),
  });
  return { engine, fake, warnings };
}

async function createGame(width = 64, height = 64): Promise<Harness> {
  const harness = await createEngine();
  await harness.engine.newGame({ seed: 42, width, height });
  return harness;
}

describe('WasmEngine : chargement et cycle de vie', () => {
  it('charge le module, expose son état et démarre une partie', async () => {
    const { engine } = await createEngine();
    const status = engine.status();
    expect(status.ready).toBe(true);
    expect(status.loading).toBe(false);
    expect(status.progress).toBe(1);
    expect(status.lastError).toBeNull();
    expect(engine.loadedModuleUrl).toBe('fake://engine');
    expect(engine.memorySize).toBe(1 << 20);
  });

  it('expose un snapshot conforme au protocole', async () => {
    const { engine } = await createGame();
    const snapshot = engine.snapshot();

    expect(snapshot.meta.protocol).toBe(PROTOCOL_VERSION);
    expect(snapshot.meta.tick).toBe(0);
    expect(snapshot.meta.hash).toMatch(/^0x[0-9a-f]{16}$/);
    expect(snapshot.map).not.toBeNull();
    const map = snapshot.map;
    if (!map) throw new Error('carte absente');
    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    for (const layer of [map.kind, map.heightMap, map.owner, map.slope, map.flags, map.trackBits]) {
      expect(layer).toBeInstanceOf(Uint8Array);
      expect(layer).toHaveLength(64 * 64);
    }
    expect(map.railTypes).toBeInstanceOf(Uint8Array);
    expect(map.railTypes).toHaveLength(64 * 64);
    expect(map.signalData).toBeInstanceOf(Uint8Array);
    expect(snapshot.signals).toEqual([]);
    expect(snapshot.companies).toHaveLength(1);
    expect(snapshot.companies[0]).toMatchObject({ isLocal: true, name: 'OpenTT3D Transport' });
    expect(snapshot.towns[0]).toMatchObject({ name: 'Bois-le-Duc', x: 12, y: 18 });
    expect(snapshot.industries[0]).toMatchObject({ kind: 'Scierie' });
    expect(snapshot.vehicles[0]).toMatchObject({
      kind: 'train',
      speed: 12.5,
      cargo: { type: 'Passagers', amount: 30, capacity: 60 },
    });
  });

  it('avance la simulation et rafraîchit la carte', async () => {
    const { engine, fake } = await createGame();
    expect(engine.step(10)).toBe(10);
    expect(fake.state.stepCalls).toEqual([10]);
    const snapshot = engine.snapshot();
    expect(snapshot.meta.tick).toBe(10);
    expect(engine.status().tick).toBe(10);
  });

  it('ne conserve aucune vue sur le heap WASM après un snapshot', async () => {
    const { engine, fake } = await createGame();
    const snapshot = engine.snapshot();
    const map = snapshot.map;
    if (!map) throw new Error('carte absente');
    const copies = {
      kind: map.kind.slice(),
      heightMap: map.heightMap.slice(),
      trackBits: map.trackBits.slice(),
    };

    // Simule une réutilisation/croissance du heap entre deux frames.
    fake.HEAPU8.fill(0xee);

    expect(map.kind).toEqual(copies.kind);
    expect(map.heightMap).toEqual(copies.heightMap);
    expect(map.trackBits).toEqual(copies.trackBits);
  });

  it('refuse une carte dont le tick ne correspond pas au JSON', async () => {
    const { engine, fake } = await createGame();
    fake.state.mapTickOffset = 5;
    expect(() => engine.snapshot()).toThrow(/désynchronisées/);
  });

  it('refuse une taille de carte qui n’est pas une puissance de 2', async () => {
    const { engine } = await createEngine();
    await expect(engine.newGame({ seed: 1, width: 100, height: 128 })).rejects.toThrow(
      /puissances? de 2/,
    );
    await expect(engine.newGame({ seed: 1, width: 128, height: 32 })).rejects.toThrow(
      /puissances? de 2/,
    );
  });

  it('signale les options de partie non appliquées par le pont', async () => {
    const { engine, fake, warnings } = await createEngine();
    await engine.newGame({
      seed: 7,
      width: 64,
      height: 64,
      aiCompanies: 2,
      climate: 'toyland',
      startYear: 2000,
      difficulty: 3,
      disasters: true,
    });
    expect(fake.state.seed).toBe(7);
    const status = engine.status();
    expect(status.warnings?.length).toBe(1);
    const warning = status.warnings?.[0] ?? '';
    expect(warning).toContain('entreprises IA (2)');
    expect(warning).toContain('climat « toyland »');
    expect(warning).toContain('année de départ 2000');
    expect(warning).toContain('difficulté 3');
    expect(warning).toContain('désastres');
    expect(warning).toContain('#60');
    expect(warnings).toEqual(status.warnings);
  });

  it('n’avertit pas pour les options par défaut', async () => {
    const { engine } = await createGame();
    expect(engine.status().warnings).toEqual([]);
  });

  it('transmet les options de partie à ottd_new_game_ex quand le pont l’expose', async () => {
    const { engine, fake, warnings } = await createEngine();
    const calls: unknown[][] = [];
    Object.assign(fake, {
      _ottd_new_game_ex: (seed: number, width: number, height: number, configPointer: number) => {
        calls.push([seed, width, height, fake.UTF8ToString(configPointer)]);
        return fake._ottd_new_game(seed, width, height);
      },
    });

    await engine.newGame({
      seed: 7,
      width: 64,
      height: 64,
      aiCompanies: 2,
      climate: 'toyland',
      startYear: 2000,
      difficulty: 3,
      disasters: true,
    });

    expect(calls).toHaveLength(1);
    const config = JSON.parse(String(calls[0]?.[3])) as Record<string, unknown>;
    expect(config).toMatchObject({
      climate: 'toyland',
      start_year: 2000,
      difficulty: 3,
      ai_companies: 2,
      map_size: 64,
      disasters: true,
    });
    expect(warnings).toEqual([]);
    expect(engine.status().warnings).toEqual([]);
  });

  it('exécute une commande build et publie le résultat dans les news', async () => {
    const { engine, fake } = await createGame();
    let sent = '';
    Object.assign(fake, {
      _ottd_command: (jsonPointer: number) => {
        sent = fake.UTF8ToString(jsonPointer);
        return 0;
      },
      _ottd_command_result: () =>
        fake.heapString(
          JSON.stringify({
            ok: true,
            message: 'Route construite sur 2 tuiles.',
            cost: 240,
            tiles: 2,
          }),
        ),
    });

    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from: { x: 1, y: 1 },
      to: { x: 2, y: 1 },
      options: { axis: 'x' },
    });

    expect(JSON.parse(sent)).toMatchObject({
      type: 'build',
      tool: 'road',
      from: { x: 1, y: 1 },
      to: { x: 2, y: 1 },
      options: { axis: 'x' },
    });
    const snapshot = engine.snapshot();
    expect(snapshot.news.at(-1)?.text).toBe('Route construite sur 2 tuiles.');
    expect(snapshot.news.at(-1)?.kind).toBe('info');
    expect(engine.status().warnings).toEqual([]);
  });

  it('avertit quand la mémoire demandée dépasse la mémoire compilée', async () => {
    const { engine } = await createEngine(64);
    const warnings = engine.status().warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Mémoire demandée indisponible');
    expect(warnings[0]).toContain('INITIAL_MEMORY');
  });

  it('signale les commandes ignorées et suit pause/vitesse', async () => {
    const { engine, warnings } = await createGame();
    engine.send({ type: 'pause', paused: true });
    expect(engine.status().paused).toBe(true);
    engine.send({ type: 'speed', speed: 2 });
    expect(engine.status().speed).toBe(2);

    engine.send({
      type: 'build',
      tool: 'rail',
      company: 0,
      from: { x: 1, y: 2 },
      to: { x: 5, y: 2 },
    });
    expect(engine.status().warnings?.[0]).toContain('Commandes indisponibles');
    expect(warnings.length).toBe(1);
  });

  it('refuse save/load si le build ne les expose pas', async () => {
    const { engine } = await createGame();
    await expect(engine.save()).rejects.toThrow(/n’expose pas la sauvegarde/);
    await expect(engine.load(new Uint8Array(4))).rejects.toThrow(/n’expose pas le chargement/);
  });

  it('sérialise et recharge via le pont', async () => {
    const { engine, fake } = await createGame();
    let loaded: Uint8Array | null = null;
    Object.assign(fake, {
      _ottd_save_size: () => 4,
      _ottd_save: (pointer: number) => {
        fake.HEAPU8.set([1, 2, 3, 4], pointer);
        return 4;
      },
      _ottd_load: (pointer: number, length: number) => {
        loaded = fake.HEAPU8.slice(pointer, pointer + length);
        return 0;
      },
    });

    const bytes = await engine.save();
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    await engine.load(new Uint8Array([9, 8, 7]));
    expect(loaded).not.toBeNull();
    expect([...(loaded as unknown as Uint8Array)]).toEqual([9, 8, 7]);
  });

  it('formate le hash 64 bits en hexadécimal non signé', async () => {
    const { engine, fake } = await createGame();
    expect(engine.hash()).toBe('0x0000000000000000');
    fake.state.hash = 0xffffffffffffffffn;
    expect(engine.hash()).toBe('0xffffffffffffffff');
  });

  it('libère le module au dispose', async () => {
    const { engine, fake } = await createGame();
    engine.dispose();
    expect(fake.state.shutdownCalls).toBe(1);
    expect(engine.status().ready).toBe(false);
    expect(() => engine.snapshot()).toThrow(/n’est pas chargé/);
  });
});
