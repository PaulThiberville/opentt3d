/**
 * Intégration UI du join tardif (#92) avec le transport mémoire et le moteur
 * mock réel : deux pairs jouent, un troisième découvre la partie, attend
 * l'autorisation de l'hôte, charge la sauvegarde, vérifie le hash puis
 * rattrape les ticks. Aucun DOM n'est nécessaire.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { NewGameOptions } from '../src/engine/protocol';
import { MockEngine } from '../src/engine/MockEngine';
import { engineBuildId } from '../src/engine/loadEngine';
import type { StartInfo, StartPayload } from '../src/net/lobby-types';
import { createNetSession, type NetSession } from '../src/net/session';
import {
  createMemoryBus,
  createTransport,
  type MemoryBus,
  type Transport,
} from '../src/net/transport';
import { LateJoinClient, LateJoinError, LateJoinProbe } from '../src/ui/lateJoinClient';
import { LateJoinHost } from '../src/ui/lateJoinHost';
import {
  LATE_JOIN_CHANNELS,
  LATE_JOIN_PROTOCOL_VERSION,
  describeHostJoin,
  isLateJoinOffer,
  type HostJoinView,
  type LateJoinOffer,
} from '../src/ui/netjoin';
import { createEngineRunner, type EngineRunner } from '../src/ui/networkRunner';
import { drive, waitFor } from './net/helpers';

const sessions: NetSession[] = [];
const transports: Transport[] = [];
const engines: MockEngine[] = [];
const clients: LateJoinClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.cancel();
  for (const session of sessions.splice(0)) session.dispose();
  for (const transport of transports.splice(0)) transport.leave();
  for (const engine of engines.splice(0)) engine.dispose();
});

const GAME_OPTIONS: NewGameOptions = {
  seed: 20261115,
  width: 64,
  height: 64,
  aiCompanies: 0,
  difficulty: 1,
  startYear: 1950,
  climate: 'temperate',
};

interface Cluster {
  bus: MemoryBus;
  roomId: string;
  hostTransport: Transport;
  secondTransport: Transport;
  hostSession: NetSession;
  secondSession: NetSession;
  hostRunner: EngineRunner;
  secondRunner: EngineRunner;
  payload: StartPayload;
  hostStart: StartInfo;
}

async function makeEngine(): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://join-ui-test' });
  await engine.newGame(GAME_OPTIONS);
  engines.push(engine);
  return engine;
}

async function createCluster(maxPlayers = 4): Promise<Cluster> {
  const bus = createMemoryBus();
  const roomId = `join-ui-${Math.random().toString(36).slice(2, 10)}`;
  const hostTransport = createTransport({ kind: 'memory', roomId, memory: { bus } });
  const secondTransport = createTransport({ kind: 'memory', roomId, memory: { bus } });
  transports.push(hostTransport, secondTransport);

  const hostEngine = await makeEngine();
  const secondEngine = await makeEngine();
  const hostRunner = createEngineRunner(hostEngine);
  const secondRunner = createEngineRunner(secondEngine);

  const peers: Record<number, string> = {
    0: hostTransport.selfId,
    1: secondTransport.selfId,
  };
  const hostSession = createNetSession({
    runner: hostRunner,
    localPlayer: 0,
    transport: hostTransport,
    isHost: true,
    peers,
    inputDelay: 2,
    maxPlayers,
  });
  const secondSession = createNetSession({
    runner: secondRunner,
    localPlayer: 1,
    transport: secondTransport,
    isHost: false,
    hostId: hostTransport.selfId,
    peers,
    inputDelay: 2,
  });
  sessions.push(hostSession, secondSession);

  const payload: StartPayload = {
    seed: GAME_OPTIONS.seed,
    settings: {
      engine: 'mock',
      mapSize: 256,
      climate: 'temperate',
      difficulty: 'normal',
      startingMoney: 100000,
      maxPlayers,
    },
    engineBuild: engineBuildId('mock'),
    players: [
      {
        player: 0,
        id: hostTransport.selfId,
        name: 'Hôte',
        colour: 0,
        companyName: 'Réseau Express',
        ai: null,
        isHost: true,
      },
      {
        player: 1,
        id: secondTransport.selfId,
        name: 'Alice',
        colour: 1,
        companyName: '',
        ai: null,
        isHost: false,
      },
    ],
    peers,
  };
  const hostStart: StartInfo = {
    ...payload,
    localPlayer: 0,
    isHost: true,
    transport: hostTransport,
  };
  return {
    bus,
    roomId,
    hostTransport,
    secondTransport,
    hostSession,
    secondSession,
    hostRunner,
    secondRunner,
    payload,
    hostStart,
  };
}

function discover(cluster: Cluster, name = 'Bob'): { transport: Transport; offer: StartPayload } {
  const transport = createTransport({
    kind: 'memory',
    roomId: cluster.roomId,
    memory: { bus: cluster.bus },
  });
  transports.push(transport);
  let payload: StartPayload | null = null;
  const probe = new LateJoinProbe({
    transport,
    hostId: cluster.hostTransport.selfId,
    playerName: name,
    engine: engineBuildId('mock'),
    onOffer: (offer) => {
      payload = offer.payload ?? null;
    },
  });
  probe.start();
  probe.stop();
  if (!payload) throw new Error('aucune offre de join reçue');
  return { transport, offer: payload };
}

describe('join tardif depuis l’UI (mock, transport mémoire)', () => {
  it('autorise manuellement un troisième joueur puis converge sur les mêmes hashes', async () => {
    const cluster = await createCluster(4);
    const arrival = drive([cluster.hostSession, cluster.secondSession], 200);
    expect(cluster.hostSession.stats().tick).toBe(200);
    expect(cluster.hostRunner.hash()).toBe(cluster.secondRunner.hash());

    const host = new LateJoinHost({
      transport: cluster.hostTransport,
      start: cluster.hostStart,
    });
    host.attachSession(cluster.hostSession);

    const { transport, offer } = discover(cluster);
    expect(offer.peers[0]).toBe(cluster.hostTransport.selfId);

    const states: string[] = [];
    const client = new LateJoinClient({
      transport,
      payload: offer,
      hostId: cluster.hostTransport.selfId,
      playerName: 'Bob',
      queryMs: 5,
      admissionMs: 3000,
      joinMaxMs: 5000,
      now: () => 0,
      createEngine: () => new MockEngine(),
      onState: (state) => states.push(state.stage),
    });
    clients.push(client);
    const preparedPromise = client.prepare();

    await waitFor(() => host.state().pending.length === 1, 2000, 5);
    const pending = host.state().pending[0];
    expect(pending?.name).toBe('Bob');
    expect(pending?.ready).toBe(true);
    expect(describeHostJoin(host.state()).pendingCount).toBe(1);

    expect(host.admit(transport.selfId)).toBe(true);
    const prepared = await preparedPromise;

    expect(prepared.session.localPlayer).toBe(2);
    expect(prepared.restored.tick).toBe(200);
    expect(prepared.restored.hash).toBe(cluster.hostRunner.hash());
    expect(prepared.session.joinPhase()).toBe('joined');
    expect(prepared.session.stats().tick).toBe(200);
    expect(prepared.runner.hash()).toBe(cluster.hostRunner.hash());
    expect(states.at(-1)).toBe('joined');

    const view: HostJoinView = host.state();
    expect(view.players.map((player) => player.name)).toContain('Bob');
    expect(describeHostJoin(view).tone).toBe('ok');

    drive([cluster.hostSession, cluster.secondSession, prepared.session], 400, {
      startNow: arrival,
    });
    expect(
      [cluster.hostSession, cluster.secondSession, prepared.session].map(
        (session) => session.stats().tick,
      ),
    ).toEqual([400, 400, 400]);
    expect(prepared.runner.hash()).toBe(cluster.hostRunner.hash());
    expect(prepared.runner.hash()).toBe(cluster.secondRunner.hash());
    expect(
      [cluster.hostSession, cluster.secondSession, prepared.session].map(
        (session) => session.stats().desyncs,
      ),
    ).toEqual([0, 0, 0]);

    // Le panneau hôte a bien reçu l'événement de succès et la liste des joueurs.
    await waitFor(() => host.state().players.length === 3, 1000, 5);
    expect(describeHostJoin(host.state()).text).toContain('Bob');
  });

  it('refuse proprement une partie pleine sans casser le tick de l’hôte', async () => {
    const cluster = await createCluster(2);
    const arrival = drive([cluster.hostSession, cluster.secondSession], 100);
    const host = new LateJoinHost({
      transport: cluster.hostTransport,
      start: cluster.hostStart,
      autoAdmit: true,
    });
    host.attachSession(cluster.hostSession);

    const { transport, offer } = discover(cluster);
    const client = new LateJoinClient({
      transport,
      payload: offer,
      hostId: cluster.hostTransport.selfId,
      playerName: 'Bob',
      queryMs: 5,
      admissionMs: 1000,
      now: () => 0,
      createEngine: () => new MockEngine(),
    });
    clients.push(client);

    const failure = client.prepare();
    await expect(failure).rejects.toMatchObject({
      name: 'LateJoinError',
      reason: 'full',
    });
    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LateJoinError);
    expect(client.currentState.stage).toBe('rejected');
    expect(client.currentState.message).toContain('complète');
    expect(host.state().pending).toHaveLength(0);
    expect(describeHostJoin(host.state()).tone).toBe('error');

    // Aucun transfert n'a été ouvert : l'hôte continue d'avancer normalement.
    drive([cluster.hostSession, cluster.secondSession], 150, {
      startNow: arrival + 500,
    });
    expect(cluster.hostSession.stats().tick).toBe(150);
    expect(cluster.hostRunner.hash()).toBe(cluster.secondRunner.hash());
  });

  it('refuse un moteur incompatible puis expire une demande non autorisée', async () => {
    const cluster = await createCluster(4);
    drive([cluster.hostSession, cluster.secondSession], 50);
    const host = new LateJoinHost({
      transport: cluster.hostTransport,
      start: cluster.hostStart,
    });
    host.attachSession(cluster.hostSession);

    const intruder = createTransport({
      kind: 'memory',
      roomId: cluster.roomId,
      memory: { bus: cluster.bus },
    });
    transports.push(intruder);
    const offers: LateJoinOffer[] = [];
    intruder.on(LATE_JOIN_CHANNELS.offer, (data) => {
      if (isLateJoinOffer(data)) offers.push(data);
    });

    intruder.send(
      LATE_JOIN_CHANNELS.query,
      {
        v: LATE_JOIN_PROTOCOL_VERSION,
        k: 'late-query',
        engine: 'autre-build',
      },
      cluster.hostTransport.selfId,
    );
    expect(offers.at(-1)).toMatchObject({ status: 'denied', reason: 'version' });

    intruder.send(
      LATE_JOIN_CHANNELS.query,
      {
        v: LATE_JOIN_PROTOCOL_VERSION,
        k: 'late-query',
        ready: true,
        name: 'Bob',
        engine: engineBuildId('mock'),
      },
      cluster.hostTransport.selfId,
    );
    expect(offers.at(-1)).toMatchObject({ status: 'pending' });
    const pending = host.state().pending[0];
    expect(pending?.name).toBe('Bob');
    if (!pending) throw new Error('demande en attente absente');

    host.tick(pending.requestedAt + 61_000);
    expect(offers.at(-1)).toMatchObject({ status: 'denied', reason: 'timeout' });
    expect(host.state().pending).toHaveLength(0);
    expect(describeHostJoin(host.state(), pending.requestedAt + 61_000).tone).toBe('error');
    expect(cluster.hostSession.stats().tick).toBe(50);
  });
});
