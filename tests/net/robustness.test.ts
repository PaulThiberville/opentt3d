/**
 * Robustesse réseau (#39) : détection de pair perdu par heartbeat, pause
 * coopérative, migration d'hôte par timeout (sans `onPeerLeave`), statistiques
 * HUD et messages i18n.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EngineCommand } from '../../src/engine/protocol.js';
import {
  createNetSession,
  type NetSession,
  type NetSessionOptions,
  type PeerStateEvent,
} from '../../src/net/session.js';
import { createTransport, type Transport } from '../../src/net/transport.js';
import {
  isPeerConnectionState,
  isPeerStateMessage,
  isPeerStateReason,
} from '../../src/net/types.js';
import { resetI18n, setLanguage } from '../../src/ui/i18n.js';
import { describeNetworkStatus, describePeerLossAlert } from '../../src/ui/netlobby.js';
import { MockRunner, drive, hashes } from './helpers.js';

interface Cluster {
  room: string;
  transports: Transport[];
  runners: MockRunner[];
  sessions: NetSession[];
  peers: Record<number, string>;
}

const clusters: Cluster[] = [];
const TIMING = {
  heartbeatMs: 250,
  peerTimeoutMs: 1000,
  hostTimeoutMs: 800,
  peerLossGraceMs: 5000,
  inputDelay: 2,
} satisfies Pick<
  NetSessionOptions,
  'heartbeatMs' | 'peerTimeoutMs' | 'hostTimeoutMs' | 'peerLossGraceMs' | 'inputDelay'
>;

function createCluster(count: number, options: Partial<NetSessionOptions> = {}): Cluster {
  const room = `robustness-${Math.random().toString(36).slice(2, 10)}`;
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
      ...TIMING,
      ...options,
    }),
  );
  const cluster: Cluster = { room, transports, runners, sessions, peers };
  clusters.push(cluster);
  return cluster;
}

afterEach(() => {
  resetI18n();
  for (const cluster of clusters.splice(0)) {
    for (const session of cluster.sessions) session.dispose();
    for (const transport of cluster.transports) transport.leave();
  }
});

function issuePeriodically(
  _session: NetSession,
  index: number,
  now: number,
): EngineCommand | undefined {
  if (now % 400 !== 0) return undefined;
  return { type: 'console', command: `player=${index};now=${now}` };
}

/** Advances only the listed sessions (a dead pair is simply not updated). */
function tick(
  sessions: NetSession[],
  now: number,
  steps: number,
  stepMs = 20,
  issue = true,
): number {
  let clock = now;
  for (let step = 0; step < steps; step++) {
    sessions.forEach((session, index) => {
      if (issue) {
        const command = issuePeriodically(session, index, clock);
        if (command) session.issue(command);
      }
      session.update(clock);
    });
    clock += stepMs;
  }
  return clock;
}

/**
 * Transport wrapper that can silently drop every outbound message while still
 * listing its peers. This models a crashed/frozen tab: `onPeerLeave` never
 * fires, so only the heartbeat timeout can detect it.
 */
function muteableTransport(base: Transport): {
  transport: Transport;
  mute: () => void;
  unmute: () => void;
} {
  let muted = false;
  const wrapper: Transport = {
    get selfId() {
      return base.selfId;
    },
    get kind() {
      return base.kind;
    },
    get roomId() {
      return base.roomId;
    },
    peers: () => base.peers(),
    send: (channel, data, target) => {
      if (!muted) base.send(channel, data, target);
    },
    on: (channel, fn) => base.on(channel, fn),
    onPeerJoin: (fn) => base.onPeerJoin(fn),
    onPeerLeave: (fn) => base.onPeerLeave(fn),
    onError: (fn) => base.onError(fn),
    ping: (peerId) => base.ping(peerId),
    leave: () => base.leave(),
  };
  return {
    transport: wrapper,
    mute: () => {
      muted = true;
    },
    unmute: () => {
      muted = false;
    },
  };
}

/** Same cluster as `createCluster`, with a mute switch on the host transport. */
function createFrozenHostCluster(count: number): Cluster & {
  muteHost: () => void;
  unmuteHost: () => void;
} {
  const room = `robustness-frozen-${Math.random().toString(36).slice(2, 10)}`;
  const base = Array.from({ length: count }, () =>
    createTransport({ kind: 'memory', roomId: room }),
  );
  const peers: Record<number, string> = {};
  base.forEach((transport, index) => {
    peers[index] = transport.selfId;
  });
  const muted = muteableTransport(base[0] as Transport);
  const transports = [muted.transport, ...base.slice(1)];
  const runners = base.map(() => new MockRunner());
  const sessions = transports.map((transport, index) =>
    createNetSession({
      runner: runners[index] as MockRunner,
      localPlayer: index,
      transport,
      isHost: index === 0,
      hostId: base[0]?.selfId,
      peers,
      ...TIMING,
    }),
  );
  const cluster = { room, transports, runners, sessions, peers, muteHost: muted.mute };
  clusters.push(cluster);
  return { ...cluster, unmuteHost: muted.unmute };
}

describe('détection de pair perdu et pause coopérative', () => {
  it('déclare un pair silencieux déconnecté et propage l’état', () => {
    const cluster = createCluster(3);
    let now = drive(cluster.sessions, 120, { issue: issuePeriodically });

    const host = cluster.sessions[0];
    const client = cluster.sessions[1];
    if (!host || !client) throw new Error('cluster incomplet');
    const events: PeerStateEvent[] = [];
    const offHost = host.onPeerState((event) => events.push(event));
    const clientEvents: PeerStateEvent[] = [];
    const offClient = client.onPeerState((event) => clientEvents.push(event));

    // The third pair stops answering but its transport stays listed: only the
    // explicit heartbeat timeout may detect it.
    now = tick([host, client], now, 90);

    offHost();
    offClient();

    const lost = events.find((event) => event.player === 2 && event.state === 'disconnected');
    expect(lost).toBeDefined();
    expect(lost?.reason).toBe('timeout');
    expect(host.peerLossPause()?.players).toContain(2);
    expect(host.stats().lostPeers).toBe(1);
    expect(host.update(now).reason).toBe('peer-lost');
    expect(clientEvents.some((event) => event.player === 2)).toBe(true);
  });

  it('reprend automatiquement à la fin de la fenêtre de grâce', () => {
    const cluster = createCluster(3, { peerLossGraceMs: 1000 });
    let now = drive(cluster.sessions, 120, { issue: issuePeriodically });
    const host = cluster.sessions[0];
    const client = cluster.sessions[1];
    if (!host || !client) throw new Error('cluster incomplet');

    now = tick([host, client], now, 90);
    expect(host.peerLossPause()).not.toBeNull();
    // No host decision: the grace window bounds the block.
    now = tick([host, client], now, 80);
    expect(host.peerLossPause()).toBeNull();
    const before = host.stats().tick;
    tick([host, client], now, 120);
    expect(host.stats().tick).toBeGreaterThan(before);
  });

  it('reprend après décision de l’hôte et expulse le pair perdu', () => {
    const cluster = createCluster(3);
    let now = drive(cluster.sessions, 120, { issue: issuePeriodically });
    const host = cluster.sessions[0];
    const client = cluster.sessions[1];
    if (!host || !client) throw new Error('cluster incomplet');

    now = tick([host, client], now, 90);
    const pause = host.peerLossPause();
    expect(pause).not.toBeNull();
    const frozen = host.stats().tick;
    now = tick([host, client], now, 10);
    expect(host.stats().tick).toBe(frozen);

    const pauseExpires = pause?.expiresAt ?? 0;
    expect(host.waitForPeers()).toBe(true);
    expect((host.peerLossPause()?.expiresAt ?? 0) > pauseExpires).toBe(true);
    expect(host.resumeAfterPeerLoss()).toBe(true);
    expect(host.peerLossPause()).toBeNull();

    // The authoritative leave travels in the next finalized turn; both peers
    // keep converging without the departed player.
    tick([host, client], now, 300);
    const surviving = [cluster.sessions[0], cluster.sessions[1]] as NetSession[];
    const result = hashes(surviving, [
      cluster.runners[0] as MockRunner,
      cluster.runners[1] as MockRunner,
    ]);
    expect(new Set(result).size).toBe(1);
    expect(host.stats().lostPeers).toBe(0);
    expect(host.stats().tick).toBe(client.stats().tick);
  });
});

describe('migration d’hôte par timeout', () => {
  it('promeut le pair au plus faible index quand l’hôte devient silencieux', () => {
    const cluster = createFrozenHostCluster(3);
    let now = drive(cluster.sessions, 300, { issue: issuePeriodically });
    cluster.muteHost();

    // The host is frozen but still listed by the transport: `onPeerLeave`
    // never fires, so liveness must come from the heartbeat timeout.
    const survivors = cluster.sessions.slice(1);
    now = tick(survivors, now, 120);

    const newHost = survivors.find((session) => session.stats().isHost);
    expect(newHost).toBeDefined();
    expect(newHost?.localPlayer).toBe(1);
    expect(newHost?.stats().term).toBeGreaterThan(0);

    // The remaining client follows the new host on later turns and the
    // transient tick offset caused by the election is caught up.
    drive(survivors, (newHost?.stats().tick ?? 0) + 60, {
      issue: issuePeriodically,
      startNow: now,
    });
    const after = hashes(survivors, cluster.runners.slice(1));
    expect(new Set(after).size).toBe(1);
    expect(survivors.every((session) => session.stats().tick === newHost?.stats().tick)).toBe(true);
  });

  it('un ancien hôte qui revient cède le rôle au terme le plus récent', () => {
    const cluster = createFrozenHostCluster(3);
    let now = drive(cluster.sessions, 250, { issue: issuePeriodically });
    const [oldHost, ...rest] = cluster.sessions;
    if (!oldHost) throw new Error('cluster incomplet');
    cluster.muteHost();

    now = tick(rest, now, 120);
    const newHost = rest.find((session) => session.stats().isHost);
    expect(newHost?.localPlayer).toBe(1);

    // Bring the old host back: its lower term must not split the game.
    cluster.unmuteHost();
    drive([oldHost, ...rest], (newHost?.stats().tick ?? 0) + 80, {
      issue: issuePeriodically,
      startNow: now,
    });
    expect(oldHost.stats().isHost).toBe(false);
    const hosts = [oldHost, ...rest].filter((session) => session.stats().isHost);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.localPlayer).toBe(1);
    const result = hashes([oldHost, ...rest], cluster.runners);
    expect(new Set(result).size).toBe(1);
  });
});

describe('statistiques et i18n réseau', () => {
  it('expose ping, perte, retard, pairs et terme', () => {
    const cluster = createCluster(2);
    drive(cluster.sessions, 200, { issue: issuePeriodically });
    const host = cluster.sessions[0];
    const client = cluster.sessions[1];
    if (!host || !client) throw new Error('cluster incomplet');

    const hostStats = host.stats();
    expect(hostStats.peers).toBe(2);
    expect(hostStats.lostPeers).toBe(0);
    expect(hostStats.loss).toBeGreaterThanOrEqual(0);
    expect(hostStats.loss).toBeLessThanOrEqual(100);
    expect(hostStats.turnDelay).toBeGreaterThanOrEqual(0);
    expect(hostStats.term).toBe(0);
    const clientStats = client.stats();
    expect(clientStats.tick).toBe(hostStats.tick);
    expect(clientStats.peers).toBe(2);
  });

  it('traduit le statut compact en FR et EN', () => {
    const input = {
      isHost: false,
      tick: 480,
      ping: 42,
      desyncs: 1,
      waiting: false,
      waitingFor: [],
      names: {},
      playersOnline: 3,
      lost: false,
      peers: 3,
      loss: 0,
      turnDelay: 1200,
      term: 1,
    };

    const fr = describeNetworkStatus(input);
    expect(fr.text).toContain('ping 42 ms');
    expect(fr.text).toContain('perte 0 %');
    expect(fr.text).toContain('retard 1.2 s');
    expect(fr.text).toContain('3 joueurs');

    setLanguage('en', { persist: false });
    const en = describeNetworkStatus(input);
    expect(en.text).toContain('ping 42 ms');
    expect(en.text).toContain('0 % loss');
    expect(en.text).toContain('1.2 s delay');
    expect(en.text).toContain('3 players');

    const alert = describePeerLossAlert({
      isHost: true,
      names: { peer2: 'Alice' },
      peerIds: ['peer2'],
      seconds: 12,
      onContinue: () => undefined,
      onWait: () => undefined,
    });
    expect(alert.title).toBe('Peer offline');
    expect(alert.detail).toContain('Alice');
    expect(alert.detail).toContain('12 s');
    expect(alert.actions.map((action) => action.label)).toEqual([
      'Continue without this player',
      'Wait longer',
    ]);
  });
});

describe('protocole peer-state', () => {
  it('accepte les transitions connues et rejette le reste', () => {
    expect(
      isPeerStateMessage({
        v: 1,
        k: 'peer-state',
        player: 2,
        state: 'disconnected',
        reason: 'timeout',
        tick: 120,
      }),
    ).toBe(true);
    expect(
      isPeerStateMessage({
        v: 1,
        k: 'peer-state',
        player: 2,
        state: 'zombie',
        reason: 'timeout',
      }),
    ).toBe(false);
    expect(
      isPeerStateMessage({ v: 1, k: 'peer-state', player: 2, state: 'left', reason: 'nope' }),
    ).toBe(false);
    expect(isPeerConnectionState('connected')).toBe(true);
    expect(isPeerStateReason('expelled')).toBe(true);
  });
});
