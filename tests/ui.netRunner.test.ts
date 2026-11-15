import { afterEach, describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import type { NewGameOptions } from '../src/engine/protocol';
import { createNetSession, type NetSession } from '../src/net/session';
import { createMemoryBus, createTransport, type Transport } from '../src/net/transport';
import { createEngineRunner, createLockstepDriver } from '../src/ui/networkRunner';
import { drive } from './net/helpers';

const gameOptions: NewGameOptions = {
  seed: 4242,
  width: 64,
  height: 64,
  aiCompanies: 1,
  difficulty: 1,
  startYear: 1950,
  climate: 'temperate',
};

const sessions: NetSession[] = [];
const transports: Transport[] = [];
const engines: MockEngine[] = [];

async function makeEngine(options: NewGameOptions = gameOptions): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://ui-test' });
  await engine.newGame(options);
  engines.push(engine);
  return engine;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const transport of transports.splice(0)) transport.leave();
  for (const engine of engines.splice(0)) engine.dispose();
});

describe('adaptation EngineDriver → Runner', () => {
  it('suit le tick, applique les commandes et expose le hash du moteur', async () => {
    const engine = await makeEngine();
    const runner = createEngineRunner(engine);
    expect(runner.tick()).toBe(0);

    runner.step([
      { p: 0, type: 'console', command: 'hello' },
      { p: 0, type: 'build', tool: 'road', company: 0, from: { x: 1, y: 1 } },
    ]);

    expect(runner.tick()).toBe(1);
    expect(runner.hash()).toBe(engine.hash());
  });

  it('n’applique jamais pause/vitesse : la simulation réseau reste déterministe', async () => {
    const engine = await makeEngine();
    const runner = createEngineRunner(engine);

    runner.step([
      { p: 0, type: 'pause', paused: true },
      { p: 0, type: 'speed', speed: 0 },
    ]);

    expect(runner.tick()).toBe(1);
    expect(engine.status().paused).toBe(false);
    expect(engine.status().speed).toBe(1);
  });

  it('sérialise et recharge un état identique', async () => {
    const first = await makeEngine();
    const runner = createEngineRunner(first);
    for (let tick = 0; tick < 5; tick++) {
      runner.step([{ p: 0, type: 'console', command: `tick-${tick}` }]);
    }
    const save = await runner.saveNow();
    expect(save.length).toBeGreaterThan(0);

    const second = await makeEngine({ ...gameOptions, seed: 1 });
    const third = await makeEngine({ ...gameOptions, seed: 2 });
    const secondRunner = createEngineRunner(second);
    const thirdRunner = createEngineRunner(third);
    secondRunner.load(save);
    thirdRunner.load(save);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondRunner.tick()).toBe(runner.tick());
    expect(secondRunner.hash()).toBe(thirdRunner.hash());
    expect(save).toContain('"tick"');
  });

  it('la façade Game ne consomme que les ticks déjà exécutés', async () => {
    const engine = await makeEngine();
    const driver = createLockstepDriver(engine);
    expect(driver.step(6)).toBe(0);

    driver.addExecuted(3);
    expect(driver.step(6)).toBe(3);
    expect(driver.executed).toBe(3);
    expect(driver.step(6)).toBe(0);
    expect(driver.executed).toBe(3);
  });
});

describe('lockstep sur deux moteurs mock', () => {
  it('garde deux pairs synchronisés sur 600 ticks', async () => {
    const bus = createMemoryBus();
    const room = `ui-session-${Math.random().toString(36).slice(2, 10)}`;
    const pairTransports = [0, 1].map(() => {
      const transport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
      transports.push(transport);
      return transport;
    });
    const hostTransport = pairTransports[0];
    if (!hostTransport) throw new Error('transport hôte manquant');
    const peers: Record<number, string> = {};
    pairTransports.forEach((transport, index) => {
      peers[index] = transport.selfId;
    });

    const pairEngines = await Promise.all([makeEngine(), makeEngine()]);
    const runners = pairEngines.map((engine) => createEngineRunner(engine));
    for (let index = 0; index < pairTransports.length; index++) {
      const transport = pairTransports[index];
      const runner = runners[index];
      if (!transport || !runner) throw new Error('paire incomplète');
      sessions.push(
        createNetSession({
          runner,
          localPlayer: index,
          transport,
          isHost: index === 0,
          hostId: hostTransport.selfId,
          peers,
          inputDelay: 3,
        }),
      );
    }

    drive(sessions, 600, {
      issue: (session, index, now) =>
        now % 500 === 0 ? { type: 'console', command: `pair=${index};now=${now}` } : undefined,
    });

    const hostRunner = runners[0];
    const clientRunner = runners[1];
    const host = sessions[0];
    const client = sessions[1];
    if (!hostRunner || !clientRunner || !host || !client) throw new Error('session incomplète');
    expect(host.stats().tick).toBe(600);
    expect(client.stats().tick).toBe(600);
    expect(hostRunner.hash()).toBe(clientRunner.hash());
    expect(host.stats().desyncs).toBe(0);
    expect(client.stats().desyncs).toBe(0);
  }, 30_000);
});
