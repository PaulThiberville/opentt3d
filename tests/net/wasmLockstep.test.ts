/**
 * Intégration réseau avec le moteur OpenTTD réel (#93).
 *
 * Deux (puis trois) instances WASM indépendantes exécutent exactement la même
 * partie via le lockstep et le transport mémoire. La suite est ignorée si les
 * artefacts de `public/engine/` sont absents (CI sans build moteur).
 *
 * Ce fichier couvre :
 *  - 500 ticks déterministes avec des commandes de chaque pair ;
 *  - une commande de construction de route appliquée aux deux mondes ;
 *  - `serialize()` → `load()` dans une nouvelle instance (hash/tick) ;
 *  - le refus d'un build/lancement sans artefacts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { NewGameOptions, WorldSnapshot } from '../../src/engine/protocol';
import { TILE_FLAG, TILE_KIND_INDEX } from '../../src/engine/protocol';
import { WasmEngine } from '../../src/engine/WasmEngine';
import type { EngineCommand } from '../../src/engine/protocol';
import { createNetSession, type NetSession } from '../../src/net/session';
import { createMemoryBus, createTransport, type Transport } from '../../src/net/transport';
import { createEngineRunner, type EngineRunner } from '../../src/ui/networkRunner';
import { ARTIFACTS_AVAILABLE, createNodeEngineFactory } from '../fixtures/nodeEngine';
import { drive } from './helpers';

const suite = ARTIFACTS_AVAILABLE ? describe : describe.skip;

const GAME_OPTIONS: NewGameOptions = {
  seed: 20261115,
  width: 128,
  height: 128,
  aiCompanies: 1,
  difficulty: 1,
  startYear: 1950,
  climate: 'temperate',
};

const engines: WasmEngine[] = [];
const sessions: NetSession[] = [];
const transports: Transport[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const transport of transports.splice(0)) transport.leave();
  for (const engine of engines.splice(0)) engine.dispose();
});

interface BootedEngine {
  engine: WasmEngine;
  runner: EngineRunner;
  bootMs: number;
}

async function bootEngine(options: NewGameOptions = GAME_OPTIONS): Promise<BootedEngine> {
  const engine = new WasmEngine({ factory: await createNodeEngineFactory() });
  engines.push(engine);
  const started = performance.now();
  await engine.init({ moduleUrl: 'node://opentt3d-engine.js' });
  await engine.newGame(options);
  const bootMs = performance.now() - started;
  return { engine, runner: createEngineRunner(engine), bootMs };
}

interface Pair {
  host: BootedEngine;
  client: BootedEngine;
  sessions: [NetSession, NetSession];
  runs: [EngineRunner, EngineRunner];
}

function createPair(host: BootedEngine, client: BootedEngine): Pair {
  const bus = createMemoryBus();
  const room = `wasm-lockstep-${Math.random().toString(36).slice(2, 10)}`;
  const hostTransport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
  const clientTransport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
  transports.push(hostTransport, clientTransport);
  const peers: Record<number, string> = {
    0: hostTransport.selfId,
    1: clientTransport.selfId,
  };
  const hostSession = createNetSession({
    runner: host.runner,
    localPlayer: 0,
    transport: hostTransport,
    isHost: true,
    peers,
    inputDelay: 3,
  });
  const clientSession = createNetSession({
    runner: client.runner,
    localPlayer: 1,
    transport: clientTransport,
    isHost: false,
    hostId: hostTransport.selfId,
    peers,
    inputDelay: 3,
  });
  sessions.push(hostSession, clientSession);
  return {
    host,
    client,
    sessions: [hostSession, clientSession],
    runs: [host.runner, client.runner],
  };
}

/** Trois tuiles d'herbe plate alignées horizontalement, pour une route. */
function findFlatRoad(map: NonNullable<WorldSnapshot['map']>, minY = 2): { x: number; y: number } {
  for (let y = Math.max(2, minY); y < map.height - 2; y += 1) {
    for (let x = 2; x < map.width - 4; x += 1) {
      const base = map.heightMap[y * map.width + x];
      let ok = true;
      for (let dx = 0; dx < 3 && ok; dx += 1) {
        const index = y * map.width + x + dx;
        ok =
          map.kind[index] === TILE_KIND_INDEX.grass &&
          map.slope[index] === 0 &&
          ((map.flags[index] ?? 0) & TILE_FLAG.WATER) === 0 &&
          map.heightMap[index] === base;
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('aucune zone de 3 tuiles d’herbe plate trouvée');
}

function roadCommand(company: number, from: { x: number; y: number }): EngineCommand {
  return {
    type: 'build',
    tool: 'road',
    company,
    from,
    to: { x: from.x + 2, y: from.y },
    options: { axis: 'x' },
  };
}

function assertSameWorld(first: WorldSnapshot, second: WorldSnapshot, tick: number): void {
  expect(first.meta.tick).toBe(tick);
  expect(second.meta.tick).toBe(tick);
  const a = first.map;
  const b = second.map;
  if (!a || !b) throw new Error('carte absente du snapshot');
  expect(b.width).toBe(a.width);
  expect(b.height).toBe(a.height);
  expect(b.kind).toEqual(a.kind);
  expect(b.heightMap).toEqual(a.heightMap);
  expect(b.owner).toEqual(a.owner);
  expect(b.slope).toEqual(a.slope);
  expect(b.trackBits).toEqual(a.trackBits);
}

suite('lockstep réseau avec WasmEngine réel', () => {
  it('deux moteurs WASM restent identiques sur 500 ticks avec des commandes de chaque pair', async () => {
    const host = await bootEngine();
    const client = await bootEngine();
    expect(host.engine.hash()).toBe(client.engine.hash());

    const pair = createPair(host, client);
    const startTick = host.runner.tick();
    expect(client.runner.tick()).toBe(startTick);
    const hostSnapshot = host.engine.snapshot();
    const clientSnapshot = client.engine.snapshot();
    // Une entreprise locale + une IA, identiques sur les deux pairs.
    expect(hostSnapshot.companies.filter((item) => item.isAI)).toHaveLength(1);
    expect(clientSnapshot.companies.map((item) => item.id)).toEqual(
      hostSnapshot.companies.map((item) => item.id),
    );
    const company = hostSnapshot.companies.find((item) => item.isLocal)?.id ?? 0;
    const map = hostSnapshot.map;
    if (!map) throw new Error('carte absente');
    const hostRoad = findFlatRoad(map);
    // Le pair client a exactement la même carte (même seed, même config).
    const clientMap = clientSnapshot.map;
    if (!clientMap) throw new Error('carte client absente');
    const clientRoad = findFlatRoad(clientMap, hostRoad.y + 4);
    expect(findFlatRoad(clientMap)).toEqual(hostRoad);

    // Chaque pair construit sa route : les deux commandes sont séquencées par
    // l'hôte et rejouées au même tick sur les deux mondes.
    pair.sessions[0].issue(roadCommand(company, hostRoad));
    pair.sessions[1].issue(roadCommand(company, clientRoad));

    const started = performance.now();
    drive(pair.sessions, startTick + 500, {
      issue: (_session, index, now) =>
        now > 0 && now % 900 === 0
          ? { type: 'console', command: `pair=${index};now=${now}` }
          : undefined,
    });
    const elapsed = performance.now() - started;

    const [hostRunner, clientRunner] = pair.runs;
    const [hostSession, clientSession] = pair.sessions;
    expect(hostSession.stats().tick).toBe(startTick + 500);
    expect(clientSession.stats().tick).toBe(startTick + 500);
    expect(hostRunner.hash()).toBe(clientRunner.hash());
    expect(hostSession.stats().desyncs).toBe(0);
    expect(clientSession.stats().desyncs).toBe(0);

    const hostWorld = host.engine.snapshot();
    const clientWorld = client.engine.snapshot();
    assertSameWorld(hostWorld, clientWorld, startTick + 500);
    for (const road of [hostRoad, clientRoad]) {
      for (let dx = 0; dx < 3; dx += 1) {
        const index = road.y * map.width + road.x + dx;
        expect(hostWorld.map?.kind[index]).toBe(TILE_KIND_INDEX.road);
        expect(clientWorld.map?.kind[index]).toBe(TILE_KIND_INDEX.road);
      }
    }

    // Resync explicite : l'hôte sérialise au tick courant, le client recharge
    // la sauvegarde WASM et repart exactement sur le même état.
    const desyncsBefore = clientSession.stats().desyncs;
    clientSession.requestResync();
    drive(pair.sessions, startTick + 560);
    expect(clientSession.stats().desyncs).toBeGreaterThan(desyncsBefore);
    expect(clientSession.stats().tick).toBe(startTick + 560);
    expect(hostRunner.hash()).toBe(clientRunner.hash());

    console.info(
      `[wasm-lockstep] boot=${Math.round(host.bootMs + client.bootMs)} ms ` +
        `500 ticks=${Math.round(elapsed)} ms hash=${hostRunner.hash()}`,
    );
  }, 180_000);

  it('sérialise le runner, recharge une nouvelle instance et poursuit avec le même hash', async () => {
    const host = await bootEngine();
    const client = await bootEngine();
    const pair = createPair(host, client);
    const startTick = pair.runs[0].tick();
    drive(pair.sessions, startTick + 120);

    const saveStarted = performance.now();
    const save = pair.runs[0].serialize();
    const saveMs = performance.now() - saveStarted;
    expect(save.length).toBeGreaterThan(1000);
    const tick = pair.runs[0].tick();
    const hash = pair.runs[0].hash();

    // Instance neuve, configurée différemment : `load()` doit tout remplacer.
    const restored = await bootEngine({ ...GAME_OPTIONS, seed: 7, width: 64, height: 64 });
    expect(restored.runner.tick()).not.toBe(tick);
    restored.runner.load(save);
    expect(restored.runner.tick()).toBe(tick);
    expect(restored.runner.hash()).toBe(hash);

    // Les deux runners poursuivent exactement la même simulation.
    pair.runs[0].step([]);
    restored.runner.step([]);
    expect(restored.runner.hash()).toBe(pair.runs[0].hash());
    expect(restored.runner.tick()).toBe(pair.runs[0].tick());

    // La variante asynchrone du pilote reste compatible.
    const bytes = await pair.runs[0].driver.save();
    expect(bytes.length).toBeGreaterThan(1000);

    console.info(
      `[wasm-lockstep] save=${save.length} caractères en ${Math.round(saveMs)} ms (tick ${tick})`,
    );
  }, 180_000);

  it('refuse un moteur WASM sans artefacts avec une erreur explicite', async () => {
    const engine = new WasmEngine({
      importModule: async () => {
        throw new Error('module introuvable');
      },
    });
    engines.push(engine);
    await expect(engine.init({ moduleUrl: 'test://engine/absent.js' })).rejects.toMatchObject({
      name: 'EngineLoadError',
      code: 'module-missing',
    });
    expect(engine.status().ready).toBe(false);
  });
});
