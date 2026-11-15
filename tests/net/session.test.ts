import { afterEach, describe, expect, it } from 'vitest';
import { createTransport, type Transport } from '../../src/net/transport.js';
import { createNetSession, type NetSession } from '../../src/net/session.js';
import type { EngineCommand } from '../../src/engine/protocol.js';
import { MockRunner, drive, hashes } from './helpers.js';

interface Cluster {
  room: string;
  transports: Transport[];
  runners: MockRunner[];
  sessions: NetSession[];
  peers: Record<number, string>;
}

const clusters: Cluster[] = [];

function createCluster(count: number, inputDelay = 3): Cluster {
  const room = `session-${Math.random()}-${Date.now()}`;
  const transports = Array.from({ length: count }, () =>
    createTransport({ kind: 'memory', roomId: room }),
  );
  const peers: Record<number, string> = {};
  transports.forEach((transport, index) => {
    peers[index] = transport.selfId;
  });
  const runners = transports.map(() => new MockRunner());
  const sessions = transports.map((transport, index) =>
    createNetSession({
      runner: runners[index] as MockRunner,
      localPlayer: index,
      transport,
      isHost: index === 0,
      hostId: transports[0]?.selfId,
      peers,
      inputDelay,
    }),
  );
  const cluster: Cluster = { room, transports, runners, sessions, peers };
  clusters.push(cluster);
  return cluster;
}

afterEach(() => {
  for (const cluster of clusters.splice(0)) {
    for (const session of cluster.sessions) session.dispose();
    for (const transport of cluster.transports) transport.leave();
  }
});

function issuePeriodically(
  session: NetSession,
  index: number,
  now: number,
): EngineCommand | undefined {
  if (now % 400 !== 0) return undefined;
  return { type: 'console', command: `player=${index};now=${now}` };
}

function expectConverged(cluster: Cluster, expectedTick: number): void {
  const result = hashes(cluster.sessions, cluster.runners);
  for (const session of cluster.sessions) {
    expect(session.stats().tick).toBe(expectedTick);
  }
  expect(new Set(result).size).toBe(1);
}

describe('session lockstep', () => {
  it('garde deux pairs synchronisés sur 2 000 ticks', () => {
    const cluster = createCluster(2);
    drive(cluster.sessions, 2000, { issue: issuePeriodically });
    expectConverged(cluster, 2000);
    expect(cluster.sessions.every((session) => session.stats().desyncs === 0)).toBe(true);
  });

  it('garde trois pairs synchronisés sur 2 000 ticks', () => {
    const cluster = createCluster(3);
    drive(cluster.sessions, 2000, { issue: issuePeriodically });
    expectConverged(cluster, 2000);
    expect(cluster.sessions.every((session) => session.stats().desyncs === 0)).toBe(true);
  });

  it('remonte les commandes de chaque joueur au bon tick', () => {
    const cluster = createCluster(3, 2);
    drive(cluster.sessions, 400, { issue: issuePeriodically });
    expectConverged(cluster, 400);
    const hash = cluster.runners[0]?.hash();
    expect(cluster.runners[1]?.hash()).toBe(hash);
    expect(cluster.runners[2]?.hash()).toBe(hash);
  });

  it('resynchronise un pair après un hash divergent', () => {
    const cluster = createCluster(2);
    drive(cluster.sessions, 40, { issue: issuePeriodically });
    const client = cluster.sessions[1];
    const clientRunner = cluster.runners[1];
    if (!client || !clientRunner) throw new Error('cluster incomplet');

    let desyncNotified = 0;
    const off = client.onDesync(() => {
      desyncNotified += 1;
    });
    clientRunner.corruptAt = 50;

    drive(cluster.sessions, 200, { issue: issuePeriodically });
    off();

    expect(desyncNotified).toBeGreaterThan(0);
    expect(client.stats().desyncs).toBeGreaterThanOrEqual(1);
    expectConverged(cluster, 200);

    // The game keeps running normally after the reload.
    drive(cluster.sessions, 350, { issue: issuePeriodically });
    expectConverged(cluster, 350);
  });

  it('resynchronise un seul pair sans bloquer les autres', () => {
    const cluster = createCluster(3);
    drive(cluster.sessions, 40, { issue: issuePeriodically });
    const corrupt = cluster.runners[1];
    if (!corrupt) throw new Error('runner manquant');
    corrupt.corruptAt = 50;

    drive(cluster.sessions, 220, { issue: issuePeriodically });
    const client = cluster.sessions[1];
    expect(client?.stats().desyncs).toBeGreaterThanOrEqual(1);
    expectConverged(cluster, 220);
  });

  it("migre l'hôte vers le pair humain au plus faible index", () => {
    const cluster = createCluster(3);
    drive(cluster.sessions, 300, { issue: issuePeriodically });

    const oldHost = cluster.sessions[0];
    if (!oldHost) throw new Error('hôte manquant');
    oldHost.dispose();
    cluster.transports[0]?.leave();

    const remaining = cluster.sessions.slice(1);
    drive(remaining, 800, { issue: issuePeriodically });

    const newHost = remaining.find((session) => session.stats().isHost);
    expect(newHost).toBeDefined();
    expect(newHost?.localPlayer).toBe(1);
    expect(remaining.every((session) => session.stats().tick === 800)).toBe(true);
    const result = hashes(remaining, cluster.runners.slice(1));
    expect(new Set(result).size).toBe(1);
  });

  it('continue après le départ d’un client', () => {
    const cluster = createCluster(3);
    drive(cluster.sessions, 200, { issue: issuePeriodically });
    cluster.sessions[2]?.dispose();
    cluster.transports[2]?.leave();

    const remaining = cluster.sessions.slice(0, 2);
    drive(remaining, 500, { issue: issuePeriodically });
    expect(remaining.every((session) => session.stats().tick === 500)).toBe(true);
    const result = hashes(remaining, cluster.runners.slice(0, 2));
    expect(new Set(result).size).toBe(1);
  });

  it('met la simulation en pause quand un pair est trop en retard', () => {
    const cluster = createCluster(2);
    let now = drive(cluster.sessions, 20, { issue: issuePeriodically });
    const host = cluster.sessions[0];
    const client = cluster.sessions[1];
    if (!host || !client) throw new Error('cluster incomplet');

    let last;
    for (let i = 0; i < 100; i++) {
      now += 100;
      last = host.update(now);
    }
    expect(last?.waiting).toBe(true);
    expect(last?.waitingFor).toContain(cluster.transports[1]?.selfId);

    drive(cluster.sessions, 300, { issue: issuePeriodically, startNow: now });
    expectConverged(cluster, 300);
  });

  it('ignore les messages malformés et les pairs inconnus', () => {
    const cluster = createCluster(2);
    drive(cluster.sessions, 30, { issue: issuePeriodically });

    const intruder = createTransport({ kind: 'memory', roomId: cluster.room });
    const hostTransport = cluster.transports[0];
    const clientTransport = cluster.transports[1];
    if (!hostTransport || !clientTransport) throw new Error('transports manquants');

    // Unknown peer trying to inject commands: ignored (no player mapping).
    intruder.send(
      'cmd',
      { v: 1, k: 'cmd', b: [{ s: 1, c: { type: 'pause', paused: true } }] },
      hostTransport.selfId,
    );
    // Malformed control messages: rejected by the guards.
    intruder.send(
      'turn',
      { v: 1, k: 'turn', epoch: 0, tick: 99999, commands: 'nope', d: 3 },
      clientTransport.selfId,
    );
    intruder.send(
      'hash',
      { v: 1, k: 'hash', epoch: 0, tick: 'x', hash: 12 },
      clientTransport.selfId,
    );
    intruder.send('resync', { v: 1, k: 'resync', epoch: 'x' }, clientTransport.selfId);
    intruder.send('ack', { v: 1, k: 'ack', tick: -3 }, hostTransport.selfId);
    intruder.leave();

    drive(cluster.sessions, 120, { issue: issuePeriodically });
    expectConverged(cluster, 120);
  });

  it('expose alpha et les statistiques de session', () => {
    const cluster = createCluster(2);
    drive(cluster.sessions, 100, { issue: issuePeriodically });
    const host = cluster.sessions[0];
    if (!host) throw new Error('hôte manquant');
    const stats = host.stats();
    expect(stats.isHost).toBe(true);
    expect(stats.delayTicks).toBe(3);
    expect(stats.tick).toBe(100);
    expect(stats.lost).toBe(false);
    expect(host.alpha(100_000)).toBeGreaterThanOrEqual(0);
    expect(host.alpha(100_000)).toBeLessThanOrEqual(1);
  });
});
