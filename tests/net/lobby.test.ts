import { afterEach, describe, expect, it } from 'vitest';
import { buildInviteLink, createLobby, parseInviteLink, type Lobby } from '../../src/net/lobby.js';
import type { LobbyChatEvent, LobbySettings, StartInfo } from '../../src/net/lobby-types.js';
import type { Directory, LobbyInfo } from '../../src/net/directory.js';
import { createDirectory, createMemoryDirectoryStore } from '../../src/net/directory.js';
import {
  createMemoryBus,
  createTransport,
  type MemoryBus,
  type Transport,
} from '../../src/net/transport.js';

interface Cluster {
  room: string;
  bus: MemoryBus;
  transports: Transport[];
  lobbies: Lobby[];
  starts: StartInfo[][];
  chats: LobbyChatEvent[][];
  errors: string[][];
}

interface ClusterOptions {
  directory?: Directory;
  isPublic?: boolean;
  now?: () => number;
  settings?: Partial<LobbySettings>;
  names?: string[];
}

const clusters: Cluster[] = [];
const directories: Directory[] = [];

function createCluster(count: number, options: ClusterOptions = {}): Cluster {
  const room = `lobby-${Math.random().toString(36).slice(2, 10)}`;
  const bus = createMemoryBus();
  const cluster: Cluster = {
    room,
    bus,
    transports: [],
    lobbies: [],
    starts: [],
    chats: [],
    errors: [],
  };

  for (let index = 0; index < count; index++) {
    const transport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
    cluster.transports.push(transport);
    const hostTransport = cluster.transports[0];
    if (!hostTransport) throw new Error('transport hôte manquant');
    const lobby = createLobby({
      transport,
      isHost: index === 0,
      hostId: index === 0 ? undefined : hostTransport.selfId,
      name: options.names?.[index] ?? (index === 0 ? 'Hôte' : `Joueur ${index + 1}`),
      roomId: room,
      settings: options.settings,
      directory: options.directory,
      isPublic: options.isPublic,
      now: options.now,
      seed: 1234,
    });
    cluster.lobbies.push(lobby);

    const starts: StartInfo[] = [];
    const chats: LobbyChatEvent[] = [];
    const errors: string[] = [];
    cluster.starts.push(starts);
    cluster.chats.push(chats);
    cluster.errors.push(errors);
    lobby.onStart((info) => starts.push(info));
    lobby.onChat((event) => chats.push(event));
    lobby.onError((message) => errors.push(message));
  }

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
  for (const directory of directories.splice(0)) directory.close();
});

describe('lobby à deux pairs', () => {
  it('rejoint, prête, discute et démarre avec des index stables', () => {
    const cluster = createCluster(2);
    const host = lobbyAt(cluster, 0);
    const client = lobbyAt(cluster, 1);

    expect(host.state.slots).toHaveLength(2);
    expect(client.state.slots).toHaveLength(2);
    expect(host.state.slots.map((slot) => slot.player)).toEqual([0, 1]);
    expect(host.state.slots.map((slot) => slot.name)).toEqual(['Hôte', 'Joueur 2']);
    expect(new Set(host.state.slots.map((slot) => slot.colour)).size).toBe(2);
    expect(host.state.hostId).toBe(transportAt(cluster, 0).selfId);
    expect(client.state.hostId).toBe(transportAt(cluster, 0).selfId);

    client.setReady(true);
    expect(host.state.slots[1]?.ready).toBe(true);
    expect(client.state.slots[1]?.ready).toBe(true);

    client.setCompanyName('  Transports   Rapides ');
    expect(host.state.slots[1]?.companyName).toBe('Transports Rapides');

    host.start();
    expect(host.state.started).toBe(true);
    expect(client.state.started).toBe(true);

    const hostStart = cluster.starts[0]?.[0];
    const clientStart = cluster.starts[1]?.[0];
    expect(hostStart).toBeDefined();
    expect(clientStart).toBeDefined();
    if (!hostStart || !clientStart) return;

    expect(hostStart.localPlayer).toBe(0);
    expect(clientStart.localPlayer).toBe(1);
    expect(hostStart.isHost).toBe(true);
    expect(clientStart.isHost).toBe(false);
    expect(hostStart.seed).toBe(1234);
    expect(hostStart.seed).toBe(clientStart.seed);
    expect(hostStart.transport).toBe(transportAt(cluster, 0));
    expect(clientStart.transport).toBe(transportAt(cluster, 1));
    expect(hostStart.peers[1]).toBe(transportAt(cluster, 1).selfId);
    expect(clientStart.peers[0]).toBe(transportAt(cluster, 0).selfId);
    expect(hostStart.players.map((player) => player.player)).toEqual([0, 1]);
  });

  it('nettoie les noms et borne le chat', () => {
    const cluster = createCluster(2, { names: ['  Hôte\n', 'x'.repeat(80)] });
    const host = lobbyAt(cluster, 0);
    expect(host.state.slots[0]?.name).toBe('Hôte');
    expect(host.state.slots[1]?.name).toHaveLength(24);

    const client = lobbyAt(cluster, 1);
    client.sendChat(`  ${'y'.repeat(400)}  `);
    const chat = cluster.chats[0]?.[0];
    expect(chat).toBeDefined();
    expect(chat?.text).toHaveLength(300);
    expect(chat?.player).toBe(1);
    expect(chat?.text.startsWith('y')).toBe(true);
  });

  it('refuse une couleur déjà prise sans fermer le salon', () => {
    const cluster = createCluster(2);
    const host = lobbyAt(cluster, 0);
    const client = lobbyAt(cluster, 1);
    const hostColour = host.state.slots[0]?.colour ?? 0;

    client.setColour(hostColour);
    expect(host.state.slots[1]?.colour).not.toBe(hostColour);
    expect(client.state.closed).toBe(false);
    expect(cluster.errors[1]?.join(' ')).toMatch(/déjà prise/i);

    client.setColour(7);
    expect(host.state.slots[1]?.colour).toBe(7);
  });
});

describe('lobby à trois pairs', () => {
  it('relaie le chat de l’hôte et des clients', () => {
    const cluster = createCluster(3);

    lobbyAt(cluster, 1).sendChat('  salut   à tous ');
    for (const chats of cluster.chats) {
      expect(chats[0]).toEqual({
        player: 1,
        name: 'Joueur 2',
        text: 'salut à tous',
        at: expect.any(Number),
      });
    }

    lobbyAt(cluster, 0).sendChat('bienvenue');
    expect(cluster.chats[2]?.[1]?.player).toBe(0);
    expect(cluster.chats[2]?.[1]?.text).toBe('bienvenue');
    expect(cluster.chats[1]?.map((event) => event.player)).toEqual([1, 0]);
  });

  it('exige que tous les humains soient prêts', () => {
    const cluster = createCluster(3);
    const host = lobbyAt(cluster, 0);

    host.start();
    expect(host.state.started).toBe(false);
    expect(cluster.errors[0]?.join(' ')).toMatch(/En attente/i);

    lobbyAt(cluster, 1).setReady(true);
    host.start();
    expect(host.state.started).toBe(false);

    lobbyAt(cluster, 2).setReady(true);
    host.start();
    expect(host.state.started).toBe(true);
    expect(cluster.starts[2]?.[0]?.localPlayer).toBe(2);
  });

  it('retire un pair parti et ferme tout quand l’hôte s’en va', () => {
    const cluster = createCluster(3);
    const host = lobbyAt(cluster, 0);
    const leaving = lobbyAt(cluster, 1);

    leaving.leave();
    expect(host.state.slots.map((slot) => slot.id)).not.toContain(transportAt(cluster, 1).selfId);
    expect(host.state.slots).toHaveLength(2);
    // Player indices are stable: the last peer keeps its index 2.
    expect(host.state.slots.map((slot) => slot.player)).toEqual([0, 2]);

    host.leave();
    for (const index of [1, 2]) {
      expect(lobbyAt(cluster, index).state.closed).toBe(true);
      expect(lobbyAt(cluster, index).diagnostics().closed).toBe(true);
    }
    expect(cluster.errors[2]?.join(' ')).toMatch(/hôte/i);
  });

  it('exclut un pair sans toucher aux autres slots', () => {
    const cluster = createCluster(3);
    const host = lobbyAt(cluster, 0);
    const kicked = lobbyAt(cluster, 2);

    host.kick(2);
    expect(host.state.slots).toHaveLength(2);
    expect(kicked.state.closed).toBe(true);
    expect(cluster.errors[2]?.join(' ')).toMatch(/retiré/i);
    expect(lobbyAt(cluster, 1).state.slots).toHaveLength(2);
  });
});

describe('IA, réglages et capacités', () => {
  it('récupère les pairs déjà présents quand l’hôte crée son salon en dernier', () => {
    const room = `late-${Math.random().toString(36).slice(2, 10)}`;
    const bus = createMemoryBus();
    const clientTransport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
    const hostTransport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
    const cluster: Cluster = {
      room,
      bus,
      transports: [hostTransport, clientTransport],
      lobbies: [],
      starts: [[], []],
      chats: [[], []],
      errors: [[], []],
    };
    clusters.push(cluster);

    const client = createLobby({
      transport: clientTransport,
      isHost: false,
      hostId: hostTransport.selfId,
      name: 'Invité',
      roomId: room,
    });
    cluster.lobbies.push(client);

    const host = createLobby({
      transport: hostTransport,
      isHost: true,
      name: 'Hôte',
      roomId: room,
    });
    cluster.lobbies.push(host);

    expect(host.state.slots).toHaveLength(2);
    expect(client.state.slots).toHaveLength(2);
    expect(client.state.slots.find((slot) => slot.id === clientTransport.selfId)?.name).toBe(
      'Invité',
    );
  });

  it('démarre avec une IA et ne lui attribue pas de pair', () => {
    const cluster = createCluster(1);
    const host = lobbyAt(cluster, 0);

    host.start();
    expect(host.state.started).toBe(false);
    expect(cluster.errors[0]?.join(' ')).toMatch(/deux participants/i);

    host.addAI('hard');
    const ai = host.state.slots[1];
    expect(ai?.ai).toBe('hard');
    expect(ai?.ready).toBe(true);
    expect(ai?.player).toBe(1);

    host.start();
    const start = cluster.starts[0]?.[0];
    expect(start).toBeDefined();
    expect(start?.players).toHaveLength(2);
    expect(start?.peers[0]).toBe(transportAt(cluster, 0).selfId);
    expect(start?.peers[1]).toBeUndefined();
  });

  it('refuse les réglages invalides et une limite inférieure aux slots', () => {
    const cluster = createCluster(2);
    const host = lobbyAt(cluster, 0);

    host.setSettings({ maxPlayers: 1 });
    expect(host.state.maxPlayers).toBe(8);
    expect(cluster.errors[0]?.join(' ')).toMatch(/2 à 8/i);

    host.setSettings({ mapSize: 123 as never });
    expect(host.state.settings.mapSize).toBe(512);

    host.setSettings({ mapSize: 1024, climate: 'arctic' });
    expect(host.state.settings.mapSize).toBe(1024);
    expect(lobbyAt(cluster, 1).state.settings.climate).toBe('arctic');
  });

  it('ferme le salon quand il est complet', () => {
    const cluster = createCluster(3, { settings: { maxPlayers: 2 } });
    const host = lobbyAt(cluster, 0);
    expect(host.state.slots).toHaveLength(2);
    const rejected = lobbyAt(cluster, 2);
    expect(rejected.state.closed).toBe(true);
    expect(rejected.state.error).toMatch(/complet/i);
  });
});

describe('lien d’invitation', () => {
  it('fait l’aller-retour, y compris sur une URL complète', () => {
    const link = buildInviteLink('k7m2-9qfx', 'AbCdEf123456', 'https://example.com/play?old=1#x');
    expect(link).toBe('https://example.com/play?room=k7m2-9qfx&host=AbCdEf123456');
    expect(parseInviteLink(link)).toEqual({ roomId: 'k7m2-9qfx', hostId: 'AbCdEf123456' });
    expect(parseInviteLink('?room=K7M2-9QFX&host=AbCdEf123456')).toEqual({
      roomId: 'k7m2-9qfx',
      hostId: 'AbCdEf123456',
    });
    expect(buildInviteLink('k7m2-9qfx', 'AbCdEf123456')).toBe('?room=k7m2-9qfx&host=AbCdEf123456');
    expect(parseInviteLink('room=k7m2-9qfx&host=AbCdEf123456')).not.toBeNull();
  });

  it('rejette les codes invalides', () => {
    expect(parseInviteLink('')).toBeNull();
    expect(parseInviteLink('?room=!!&host=AbCdEf123456')).toBeNull();
    expect(parseInviteLink('?room=k7m2-9qfx')).toBeNull();
    expect(parseInviteLink('?room=k7m2-9qfx&host=')).toBeNull();
    expect(() => buildInviteLink('bad room', 'AbCdEf123456')).toThrow();
    expect(() => buildInviteLink('k7m2-9qfx', '')).toThrow();
  });

  it('rejoint directement le lobby à partir du lien', () => {
    const cluster = createCluster(2);
    const host = lobbyAt(cluster, 0);
    const link = buildInviteLink(
      cluster.room,
      transportAt(cluster, 0).selfId,
      'https://tt3d.test/',
    );
    const parsed = parseInviteLink(link);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    const transport = createTransport({
      kind: 'memory',
      roomId: parsed.roomId,
      memory: { bus: cluster.bus },
    });
    cluster.transports.push(transport);
    const guest = createLobby({
      transport,
      isHost: false,
      hostId: parsed.hostId,
      name: 'Invité',
      roomId: parsed.roomId,
    });
    cluster.lobbies.push(guest);
    cluster.starts.push([]);
    cluster.chats.push([]);
    cluster.errors.push([]);

    expect(host.state.slots).toHaveLength(3);
    expect(guest.state.slots.find((slot) => slot.id === transport.selfId)?.name).toBe('Invité');
  });

  it('ignore l’état d’un hôte qui ne correspond pas au lien', () => {
    const cluster = createCluster(2);
    const transport = createTransport({
      kind: 'memory',
      roomId: cluster.room,
      memory: { bus: cluster.bus },
    });
    cluster.transports.push(transport);
    const guest = createLobby({
      transport,
      isHost: false,
      hostId: 'WrongHost1234',
      name: 'Égaré',
      roomId: cluster.room,
    });
    cluster.lobbies.push(guest);
    cluster.starts.push([]);
    cluster.chats.push([]);
    cluster.errors.push([]);

    expect(guest.state.slots).toEqual([]);
    expect(guest.state.hostId).toBe('WrongHost1234');
    // The host still sees the transport, but the guest never adopts its state.
    expect(lobbyAt(cluster, 0).state.slots).toHaveLength(3);
  });
});

describe('robustesse du lobby', () => {
  it('ignore les messages malformés ou usurpés', () => {
    const cluster = createCluster(3);
    const host = lobbyAt(cluster, 0);
    const victim = lobbyAt(cluster, 2);
    const before = JSON.stringify(host.state.slots);
    const victimHost = victim.state.hostId;
    const intruder = transportAt(cluster, 1);

    intruder.send('lobby-slot', { v: 1, k: 'slot', colour: 999 });
    intruder.send('lobby-slot', { v: 1, k: 'slot', ready: 'yes' });
    intruder.send('lobby-slot', { v: 2, k: 'slot', ready: true });
    intruder.send('lobby', { v: 1, k: 'state', state: { roomId: cluster.room } });
    intruder.send('lobby-start', { v: 1, k: 'start', seed: 1 });
    intruder.send('lobby-chat', { v: 1, k: 'chat', text: '' });
    intruder.send('lobby-closed', { v: 1, k: 'closed' });
    intruder.send('lobby-kick', { v: 1, k: 'kick' });
    intruder.send('lobby', 'garbage');
    intruder.send('lobby', { v: 1, k: 'state', state: victim.state });

    expect(JSON.stringify(host.state.slots)).toBe(before);
    expect(victim.state.started).toBe(false);
    expect(victim.state.closed).toBe(false);
    expect(victim.state.hostId).toBe(victimHost);
    expect(host.diagnostics().rejected).toBeGreaterThan(0);
  });

  it('refuse de démarrer ou de muter après le démarrage', () => {
    const cluster = createCluster(2);
    const host = lobbyAt(cluster, 0);
    lobbyAt(cluster, 1).setReady(true);
    host.start();
    expect(host.state.started).toBe(true);

    host.addAI('easy');
    host.setSettings({ mapSize: 256 });
    host.removeSlot(1);
    expect(cluster.errors[0]?.join(' ')).toMatch(/déjà démarré/i);
    expect(host.state.settings.mapSize).toBe(512);
    expect(host.state.slots).toHaveLength(2);
  });
});

describe('lobby et annuaire', () => {
  it('publie la partie, son démarrage puis sa fermeture', () => {
    let now = 1_000_000;
    const store = createMemoryDirectoryStore();
    const directory = createDirectory({ kind: 'memory', now: () => now, memory: { store } });
    directories.push(directory);

    const snapshots: LobbyInfo[][] = [];
    directory.subscribe((list) => snapshots.push(list));

    const cluster = createCluster(2, {
      directory,
      isPublic: true,
      now: () => now,
    });
    expect(snapshots.at(-1)).toHaveLength(1);
    expect(snapshots.at(-1)?.[0]?.status).toBe('open');
    expect(snapshots.at(-1)?.[0]?.players).toBe(2);
    expect(snapshots.at(-1)?.[0]?.hostPeerId).toBe(transportAt(cluster, 0).selfId);
    expect(snapshots.at(-1)?.[0]?.mine).toBe(true);

    lobbyAt(cluster, 1).setReady(true);
    now += 1000;
    lobbyAt(cluster, 0).start();
    expect(snapshots.at(-1)?.[0]?.status).toBe('started');

    lobbyAt(cluster, 0).leave();
    expect(snapshots.at(-1)).toEqual([]);
    expect(directory.diagnostics().published).toBe(0);
  });
});
