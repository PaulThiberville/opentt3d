import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryBus,
  createTransport,
  type MemoryBus,
  type Transport,
} from '../../src/net/transport.js';
import {
  createNetSession,
  type JoinAdmission,
  type JoinEvent,
  type NetSession,
} from '../../src/net/session.js';
import { JOIN_CHANNELS, JOIN_PROTOCOL_VERSION, NET_PROTOCOL_VERSION } from '../../src/net/types.js';
import type { EngineCommand } from '../../src/engine/protocol.js';
import { MockRunner, drive } from './helpers.js';

interface Peer {
  transport: Transport;
  runner: MockRunner;
  session: NetSession;
}

interface Cleanup {
  transports: Transport[];
  sessions: NetSession[];
}

const cleanups: Cleanup[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    for (const session of cleanup.sessions) session.dispose();
    for (const transport of cleanup.transports) transport.leave();
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

function createRoom(bus: MemoryBus, roomId: string): Transport {
  return createTransport({ kind: 'memory', roomId, memory: { bus } });
}

interface ClusterOptions {
  inputDelay?: number;
  hostMaxPlayers?: number;
  joinTimeoutMs?: number;
  autoAdmit?: boolean;
  engine?: string;
}

interface Cluster {
  bus: MemoryBus;
  roomId: string;
  peers: Peer[];
}

function createCluster(count: number, options: ClusterOptions = {}): Cluster {
  const bus = createMemoryBus();
  const roomId = `join-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const transports = Array.from({ length: count }, () => createRoom(bus, roomId));
  const peersMap: Record<number, string> = {};
  transports.forEach((transport, index) => {
    peersMap[index] = transport.selfId;
  });
  const peers = transports.map((transport, index) => {
    const runner = new MockRunner();
    const session = createNetSession({
      runner,
      localPlayer: index,
      transport,
      isHost: index === 0,
      hostId: transports[0]?.selfId,
      peers: peersMap,
      inputDelay: options.inputDelay ?? 3,
      maxPlayers: index === 0 ? (options.hostMaxPlayers ?? 64) : 64,
      joinTimeoutMs: options.joinTimeoutMs,
      autoAdmit: index === 0 ? options.autoAdmit : false,
      engine: options.engine,
    });
    return { transport, runner, session };
  });
  const cluster: Cluster = { bus, roomId, peers };
  cleanups.push({
    transports,
    sessions: peers.map((peer) => peer.session),
  });
  return cluster;
}

function lateJoiner(
  cluster: Cluster,
  localPlayer: number,
  peers: Record<number, string>,
  options: { joinTimeoutMs?: number } = {},
): Peer {
  const transport = createRoom(cluster.bus, cluster.roomId);
  const runner = new MockRunner();
  const session = createNetSession({
    runner,
    localPlayer,
    transport,
    isHost: false,
    hostId: cluster.peers[0]?.transport.selfId,
    peers,
    joinTimeoutMs: options.joinTimeoutMs ?? 5000,
  });
  const peer = { transport, runner, session };
  cleanups.push({ transports: [transport], sessions: [session] });
  return peer;
}

function expectSameState(peers: Peer[], expectedTick: number): void {
  for (const peer of peers) {
    expect(peer.session.stats().tick).toBe(expectedTick);
  }
  const states = new Set(peers.map((peer) => `${peer.session.stats().tick}:${peer.runner.hash()}`));
  expect(states.size).toBe(1);
}

describe('join en cours de partie', () => {
  it('fait rejoindre un troisième pair au tick 500 puis converge à 1 000', () => {
    const cluster = createCluster(2, { hostMaxPlayers: 3 });
    const host = cluster.peers[0];
    const second = cluster.peers[1];
    if (!host || !second) throw new Error('cluster incomplet');

    drive([host.session, second.session], 500, { issue: issuePeriodically });
    expectSameState([host, second], 500);

    const peersMap = {
      0: host.transport.selfId,
      1: second.transport.selfId,
    };
    const third = lateJoiner(cluster, 2, peersMap);
    const events: JoinEvent[] = [];
    third.session.onJoin((event) => events.push(event));

    const admission: JoinAdmission | null = host.session.admitPeer(third.transport.selfId, 2);
    expect(admission).toEqual({ peerId: third.transport.selfId, player: 2 });
    expect(third.session.requestJoin(host.transport.selfId, 2)).toBe(true);

    // The transfer is synchronous on the memory bus: the save is loaded and the
    // hash at the frontier tick is already identical before any new tick.
    expect(third.session.joinPhase()).toBe('joined');
    expect(third.session.localPlayer).toBe(2);
    expect(third.session.stats().tick).toBe(500);
    expect(third.runner.hash()).toBe(host.runner.hash());
    expect(events.at(-1)).toMatchObject({ ok: true, player: 2, tick: 500 });

    const everyone = [host, second, third];
    drive(
      everyone.map((peer) => peer.session),
      1000,
      { issue: issuePeriodically },
    );
    expectSameState(everyone, 1000);
    expect(everyone.map((peer) => peer.session.stats().desyncs)).toEqual([0, 0, 0]);
    // The save covers ticks 0..499: the newcomer only executes 500..999.
    expect(third.runner.executedTicks).toBe(500);
    expect(host.runner.executedTicks).toBe(1000);
  });

  it('refuse une version de protocole ou de join incompatible', () => {
    const cluster = createCluster(2, { engine: 'build-a' });
    const host = cluster.peers[0];
    if (!host) throw new Error('hôte manquant');
    drive(
      cluster.peers.map((peer) => peer.session),
      50,
      { issue: issuePeriodically },
    );

    const intruder = createRoom(cluster.bus, cluster.roomId);
    cleanups.push({ transports: [intruder], sessions: [] });
    const rejects: unknown[] = [];
    intruder.on(JOIN_CHANNELS.reject, (data) => rejects.push(data));

    intruder.send(
      JOIN_CHANNELS.request,
      { v: NET_PROTOCOL_VERSION + 1, k: 'join-request', pv: JOIN_PROTOCOL_VERSION },
      host.transport.selfId,
    );
    expect(rejects.at(-1)).toMatchObject({ reason: 'version' });

    intruder.send(
      JOIN_CHANNELS.request,
      { v: NET_PROTOCOL_VERSION, k: 'join-request', pv: JOIN_PROTOCOL_VERSION + 1 },
      host.transport.selfId,
    );
    expect(rejects.at(-1)).toMatchObject({ reason: 'version' });

    intruder.send(
      JOIN_CHANNELS.request,
      {
        v: NET_PROTOCOL_VERSION,
        k: 'join-request',
        pv: JOIN_PROTOCOL_VERSION,
        engine: 'other-build',
      },
      host.transport.selfId,
    );
    expect(rejects.at(-1)).toMatchObject({ reason: 'version' });
  });

  it('refuse un join quand la partie est pleine', () => {
    const cluster = createCluster(2, { hostMaxPlayers: 2 });
    const host = cluster.peers[0];
    if (!host) throw new Error('hôte manquant');
    drive(
      cluster.peers.map((peer) => peer.session),
      100,
      { issue: issuePeriodically },
    );

    const third = lateJoiner(cluster, 2, {
      0: host.transport.selfId,
      1: cluster.peers[1]?.transport.selfId ?? '',
    });
    const events: JoinEvent[] = [];
    third.session.onJoin((event) => events.push(event));

    expect(host.session.admitPeer(third.transport.selfId, 2)).toBeNull();
    expect(third.session.requestJoin(host.transport.selfId, 2)).toBe(true);
    expect(events.at(-1)).toMatchObject({ ok: false, reason: 'full' });
    expect(third.session.joinPhase()).toBe('rejected');
  });

  it('refuse un join sans fenêtre ou après fermeture de la fenêtre', () => {
    const cluster = createCluster(2, { joinTimeoutMs: 1000 });
    const host = cluster.peers[0];
    if (!host) throw new Error('hôte manquant');
    drive(
      cluster.peers.map((peer) => peer.session),
      100,
      { issue: issuePeriodically },
    );

    // No window was opened by the host: the running game refuses the peer.
    const third = lateJoiner(cluster, 2, { 0: host.transport.selfId });
    const events: JoinEvent[] = [];
    third.session.onJoin((event) => events.push(event));
    third.session.requestJoin(host.transport.selfId, 2);
    expect(events.at(-1)).toMatchObject({ ok: false, reason: 'started' });

    // An open window can be closed explicitly, even mid-transfer.
    const late = createRoom(cluster.bus, cluster.roomId);
    cleanups.push({ transports: [late], sessions: [] });
    const rejects: unknown[] = [];
    late.on(JOIN_CHANNELS.reject, (data) => rejects.push(data));
    expect(host.session.admitPeer(late.selfId, 2)).toEqual({
      peerId: late.selfId,
      player: 2,
    });
    late.send(
      JOIN_CHANNELS.request,
      { v: NET_PROTOCOL_VERSION, k: 'join-request', pv: JOIN_PROTOCOL_VERSION },
      host.transport.selfId,
    );
    host.session.closeJoinWindow(late.selfId);
    expect(rejects.at(-1)).toMatchObject({ reason: 'closed' });
  });

  it('met la simulation en pause pendant le transfert puis reprend', () => {
    const cluster = createCluster(2, { autoAdmit: true, joinTimeoutMs: 5000 });
    const host = cluster.peers[0];
    const second = cluster.peers[1];
    if (!host || !second) throw new Error('cluster incomplet');
    let now = drive([host.session, second.session], 100, { issue: issuePeriodically });

    // A raw peer requests a join (auto-admit) but never confirms the save.
    const stalled = createRoom(cluster.bus, cluster.roomId);
    cleanups.push({ transports: [stalled], sessions: [] });
    stalled.send(
      JOIN_CHANNELS.request,
      {
        v: NET_PROTOCOL_VERSION,
        k: 'join-request',
        pv: JOIN_PROTOCOL_VERSION,
        player: 2,
      },
      host.transport.selfId,
    );

    for (let step = 0; step < 5; step++) {
      now += 100;
      const update = host.session.update(now);
      expect(update.waiting).toBe(true);
      expect(update.waitingFor).toContain(stalled.selfId);
      expect(host.session.stats().tick).toBe(100);
    }

    // Closing the window resumes the simulation without the newcomer.
    host.session.closeJoinWindow(stalled.selfId);
    now += 100;
    host.session.update(now);
    expect(host.session.stats().tick).toBeGreaterThanOrEqual(100);
    drive([host.session, second.session], 200, { issue: issuePeriodically, startNow: now });
    expectSameState([host, second], 200);
  });

  it('refuse un pair dont le hash après chargement ne correspond pas', () => {
    const cluster = createCluster(2, { joinTimeoutMs: 5000 });
    const host = cluster.peers[0];
    const second = cluster.peers[1];
    if (!host || !second) throw new Error('cluster incomplet');
    let now = drive([host.session, second.session], 80, { issue: issuePeriodically });

    const fake = createRoom(cluster.bus, cluster.roomId);
    cleanups.push({ transports: [fake], sessions: [] });
    const rejects: unknown[] = [];
    let received = 0;
    let plan: { tick?: number; total?: number; id?: string } = {};
    fake.on(JOIN_CHANNELS.reject, (data) => rejects.push(data));
    fake.on(JOIN_CHANNELS.accept, (data) => {
      plan = data as { tick?: number; total?: number; id?: string };
      received = 0;
    });
    fake.on(JOIN_CHANNELS.chunk, (data) => {
      const message = data as { save?: { id?: string; total?: number } };
      if (message.save?.id !== plan.id) return;
      received += 1;
      if (received < (plan.total ?? 0)) return;
      // Simulate a build whose state hash differs after loading the same save.
      fake.send(
        JOIN_CHANNELS.ready,
        {
          v: NET_PROTOCOL_VERSION,
          k: 'join-ready',
          tick: plan.tick ?? 0,
          hash: 'divergent',
          ok: true,
        },
        host.transport.selfId,
      );
    });

    expect(host.session.admitPeer(fake.selfId, 2)).toEqual({ peerId: fake.selfId, player: 2 });
    fake.send(
      JOIN_CHANNELS.request,
      { v: NET_PROTOCOL_VERSION, k: 'join-request', pv: JOIN_PROTOCOL_VERSION },
      host.transport.selfId,
    );
    expect(rejects.at(-1)).toMatchObject({ reason: 'invalid-save' });

    now += 100;
    host.session.update(now);
    drive([host.session, second.session], 200, { issue: issuePeriodically, startNow: now });
    expectSameState([host, second], 200);
  });

  it('rejette une sauvegarde corrompue sans planter', () => {
    const bus = createMemoryBus();
    const roomId = `join-corrupt-${Math.random().toString(36).slice(2)}`;
    const fakeHostTransport = createRoom(bus, roomId);
    const clientTransport = createRoom(bus, roomId);
    const runner = new MockRunner();
    const client = createNetSession({
      runner,
      localPlayer: 2,
      transport: clientTransport,
      isHost: false,
      peers: {},
      joinTimeoutMs: 1000,
    });
    cleanups.push({ transports: [fakeHostTransport, clientTransport], sessions: [client] });

    const events: JoinEvent[] = [];
    client.onJoin((event) => events.push(event));
    const answers: unknown[] = [];
    fakeHostTransport.on(JOIN_CHANNELS.ready, (data) => answers.push(data));
    fakeHostTransport.on(JOIN_CHANNELS.request, (_data, from) => {
      fakeHostTransport.send(
        JOIN_CHANNELS.accept,
        {
          v: NET_PROTOCOL_VERSION,
          k: 'join-accept',
          epoch: 0,
          tick: 10,
          total: 1,
          player: 2,
          id: 'corrupt',
          hash: '10:deadbeef',
        },
        from,
      );
      fakeHostTransport.send(
        JOIN_CHANNELS.chunk,
        {
          v: NET_PROTOCOL_VERSION,
          k: 'join-chunk',
          epoch: 0,
          tick: 10,
          save: { id: 'corrupt', index: 0, total: 1, data: 'not-json' },
        },
        from,
      );
    });

    expect(client.requestJoin(fakeHostTransport.selfId, 2)).toBe(true);
    expect(events.at(-1)).toMatchObject({ ok: false, reason: 'invalid-save' });
    expect(client.joinPhase()).toBe('rejected');
    expect(answers.at(-1)).toMatchObject({ k: 'join-ready', ok: false });
  });

  it('rejette un transfert tronqué après le délai de join', () => {
    const bus = createMemoryBus();
    const roomId = `join-truncated-${Math.random().toString(36).slice(2)}`;
    const fakeHostTransport = createRoom(bus, roomId);
    const clientTransport = createRoom(bus, roomId);
    const runner = new MockRunner();
    const client = createNetSession({
      runner,
      localPlayer: 2,
      transport: clientTransport,
      isHost: false,
      hostId: fakeHostTransport.selfId,
      peers: {},
      joinTimeoutMs: 1000,
    });
    cleanups.push({ transports: [fakeHostTransport, clientTransport], sessions: [client] });

    const events: JoinEvent[] = [];
    client.onJoin((event) => events.push(event));
    fakeHostTransport.on(JOIN_CHANNELS.request, (_data, from) => {
      fakeHostTransport.send(
        JOIN_CHANNELS.accept,
        {
          v: NET_PROTOCOL_VERSION,
          k: 'join-accept',
          epoch: 0,
          tick: 10,
          total: 2,
          player: 2,
          id: 'truncated',
          hash: '10:deadbeef',
        },
        from,
      );
      fakeHostTransport.send(
        JOIN_CHANNELS.chunk,
        {
          v: NET_PROTOCOL_VERSION,
          k: 'join-chunk',
          epoch: 0,
          tick: 10,
          save: { id: 'truncated', index: 0, total: 2, data: '{"tick":10,"state":1}' },
        },
        from,
      );
    });

    client.requestJoin(fakeHostTransport.selfId, 2);
    expect(client.joinPhase()).toBe('transfer');
    expect(client.joinProgress()).toMatchObject({ phase: 'transfer', received: 1, total: 2 });
    client.update(1500);
    expect(events.at(-1)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(client.joinPhase()).toBe('rejected');
  });

  it('enchaîne deux joins successifs puis accepte le départ du nouveau pair', () => {
    const cluster = createCluster(2, { hostMaxPlayers: 4 });
    const host = cluster.peers[0];
    const second = cluster.peers[1];
    if (!host || !second) throw new Error('cluster incomplet');
    drive([host.session, second.session], 200, { issue: issuePeriodically });

    const third = lateJoiner(cluster, 2, {
      0: host.transport.selfId,
      1: second.transport.selfId,
    });
    host.session.admitPeer(third.transport.selfId, 2);
    expect(third.session.requestJoin(host.transport.selfId, 2)).toBe(true);
    expect(third.session.joinPhase()).toBe('joined');

    drive([host.session, second.session, third.session], 400, { issue: issuePeriodically });
    expectSameState([host, second, third], 400);

    const fourth = lateJoiner(cluster, 3, {
      0: host.transport.selfId,
      1: second.transport.selfId,
      2: third.transport.selfId,
    });
    host.session.admitPeer(fourth.transport.selfId, 3);
    expect(fourth.session.requestJoin(host.transport.selfId, 3)).toBe(true);
    expect(fourth.session.joinPhase()).toBe('joined');

    const all = [host, second, third, fourth];
    drive(
      all.map((peer) => peer.session),
      600,
      { issue: issuePeriodically },
    );
    expectSameState(all, 600);
    expect(all.every((peer) => peer.session.stats().desyncs === 0)).toBe(true);

    // The first newcomer leaves; the others keep running without desync.
    third.session.dispose();
    third.transport.leave();
    const remaining = [host, second, fourth];
    drive(
      remaining.map((peer) => peer.session),
      800,
      { issue: issuePeriodically },
    );
    expectSameState(remaining, 800);
    expect(fourth.session.joinPhase()).toBe('joined');
    expect(remaining.every((peer) => peer.session.stats().desyncs === 0)).toBe(true);
  });
});
