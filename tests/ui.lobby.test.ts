import { afterEach, describe, expect, it } from 'vitest';
import { createLobby, type Lobby } from '../src/net/lobby';
import { LOBBY_CHANNELS, type LobbyChatEvent, type StartInfo } from '../src/net/lobby-types';
import {
  createMemoryBus,
  createTransport,
  type MemoryBus,
  type Transport,
} from '../src/net/transport';
import { lobbyStartReadiness } from '../src/ui/netlobby';

interface Cluster {
  room: string;
  bus: MemoryBus;
  transports: Transport[];
  lobbies: Lobby[];
  starts: StartInfo[][];
  chats: LobbyChatEvent[][];
  errors: string[][];
}

const clusters: Cluster[] = [];

function createCluster(): Cluster {
  const room = `ui-lobby-${Math.random().toString(36).slice(2, 10)}`;
  const bus = createMemoryBus();
  const transports = [0, 1].map(() =>
    createTransport({ kind: 'memory', roomId: room, memory: { bus } }),
  );
  const hostTransport = transports[0];
  if (!hostTransport) throw new Error('transport hôte manquant');

  const lobbies = transports.map((transport, index) =>
    createLobby({
      transport,
      isHost: index === 0,
      hostId: index === 0 ? undefined : hostTransport.selfId,
      roomId: room,
      name: index === 0 ? 'Salon UI' : 'Alice',
      seed: 777,
      settings: { mapSize: 256, difficulty: 'normal', maxPlayers: 4 },
    }),
  );
  const starts: StartInfo[][] = [[], []];
  const chats: LobbyChatEvent[][] = [[], []];
  const errors: string[][] = [[], []];
  lobbies.forEach((lobby, index) => {
    lobby.onStart((info) => starts[index]?.push(info));
    lobby.onChat((event) => chats[index]?.push(event));
    lobby.onError((message) => errors[index]?.push(message));
  });
  lobbies[0]?.setName('Hôte');

  const cluster: Cluster = { room, bus, transports, lobbies, starts, chats, errors };
  clusters.push(cluster);
  return cluster;
}

function lobbyAt(cluster: Cluster, index: number): Lobby {
  const lobby = cluster.lobbies[index];
  if (!lobby) throw new Error(`lobby ${index} manquant`);
  return lobby;
}

function transportAt(cluster: Cluster, index: number): Transport {
  const transport = cluster.transports[index];
  if (!transport) throw new Error(`transport ${index} manquant`);
  return transport;
}

afterEach(() => {
  for (const cluster of clusters.splice(0)) {
    for (const lobby of cluster.lobbies) lobby.leave();
    for (const transport of cluster.transports) transport.leave();
  }
});

describe('machine à états du salon (transport mémoire)', () => {
  it('crée, rejoint, prête, discute et démarre la même partie', () => {
    const cluster = createCluster();
    const host = lobbyAt(cluster, 0);
    const client = lobbyAt(cluster, 1);

    expect(host.state.slots.map((slot) => slot.player)).toEqual([0, 1]);
    expect(client.state.slots.map((slot) => slot.player)).toEqual([0, 1]);
    expect(client.state.hostId).toBe(transportAt(cluster, 0).selfId);
    expect(lobbyStartReadiness(host.state)).toEqual({ ready: false, waiting: ['Alice'] });

    client.setReady(true);
    expect(host.state.slots[1]?.ready).toBe(true);
    expect(lobbyStartReadiness(host.state)).toEqual({ ready: true, waiting: [] });

    client.sendChat('salut depuis l’invité');
    expect(cluster.chats[0]?.[0]).toMatchObject({
      player: 1,
      name: 'Alice',
      text: 'salut depuis l’invité',
    });
    host.sendChat('bienvenue');
    expect(cluster.chats[1]?.at(-1)).toMatchObject({ player: 0, text: 'bienvenue' });

    host.start();
    expect(host.state.started).toBe(true);
    expect(client.state.started).toBe(true);
    const hostStart = cluster.starts[0]?.[0];
    const clientStart = cluster.starts[1]?.[0];
    expect(hostStart).toBeDefined();
    expect(clientStart).toBeDefined();
    if (!hostStart || !clientStart) return;

    expect(hostStart.seed).toBe(777);
    expect(clientStart.seed).toBe(777);
    expect(hostStart.localPlayer).toBe(0);
    expect(clientStart.localPlayer).toBe(1);
    expect(hostStart.isHost).toBe(true);
    expect(clientStart.isHost).toBe(false);
    expect(hostStart.peers).toEqual(clientStart.peers);
    expect(hostStart.players.map((player) => player.name)).toEqual(['Hôte', 'Alice']);
    expect(hostStart.transport).toBe(transportAt(cluster, 0));
    expect(clientStart.transport).toBe(transportAt(cluster, 1));
  });

  it('refuse proprement un pair qui arrive après le démarrage', () => {
    const cluster = createCluster();
    const host = lobbyAt(cluster, 0);
    lobbyAt(cluster, 1).setReady(true);
    host.start();
    expect(host.state.started).toBe(true);

    const room = cluster.room;
    const lateTransport = createTransport({
      kind: 'memory',
      roomId: room,
      memory: { bus: cluster.bus },
    });
    const lateLobby = createLobby({
      transport: lateTransport,
      isHost: false,
      hostId: transportAt(cluster, 0).selfId,
      roomId: room,
      name: 'Retardataire',
    });
    const lateErrors: string[] = [];
    lateLobby.onError((message) => lateErrors.push(message));

    expect(lateLobby.state.closed).toBe(true);
    expect(lateLobby.state.error ?? lateErrors.join(' ')).toMatch(/déjà démarré/i);
    lateLobby.leave();
    lateTransport.leave();
  });

  it('diffuse l’état et les couleurs sans doublon', () => {
    const cluster = createCluster();
    const host = lobbyAt(cluster, 0);
    const client = lobbyAt(cluster, 1);
    const hostColour = host.state.slots[0]?.colour ?? 0;

    client.setColour(7);
    expect(host.state.slots[1]?.colour).toBe(7);
    client.setColour(hostColour);
    expect(client.state.slots[1]?.colour).toBe(7);
    expect(cluster.errors[1]?.join(' ')).toMatch(/déjà prise/i);

    client.setCompanyName('  Transports   du   Nord ');
    expect(host.state.slots[1]?.companyName).toBe('Transports du Nord');
    expect(host.state.slots.every((slot) => slot.player >= 0)).toBe(true);
    expect(host.state.settings.mapSize).toBe(256);
  });
});

describe('salon et protocole', () => {
  it('le kick du salon ferme le client avec un motif lisible', () => {
    const cluster = createCluster();
    const client = lobbyAt(cluster, 1);
    transportAt(cluster, 0).send(
      LOBBY_CHANNELS.kick,
      { v: 1, k: 'kick', reason: 'Retiré par l’hôte.' },
      transportAt(cluster, 1).selfId,
    );
    expect(client.state.closed).toBe(true);
    expect(client.state.error).toMatch(/Retiré/);
  });
});
