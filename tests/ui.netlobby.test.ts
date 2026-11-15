import { afterEach, describe, expect, it } from 'vitest';
import type { Directory } from '../src/net/directory';
import { newRoomId } from '../src/net/directory';
import { LOBBY_CHANNELS, type StartInfo, type StartPlayer } from '../src/net/lobby-types';
import { createMemoryBus, createTransport, type Transport } from '../src/net/transport';
import {
  buildRoomInvite,
  describeNetworkStatus,
  detachableTransport,
  installStartedGate,
  lobbyStartReadiness,
  mapStartInfoToGameOptions,
  parseJoinTarget,
  peerNamesFromStart,
  readNetworkParams,
} from '../src/ui/netlobby';

const transports: Transport[] = [];
const directories: Directory[] = [];

function memoryTransport(roomId: string, bus = createMemoryBus()): Transport {
  const transport = createTransport({ kind: 'memory', roomId, memory: { bus } });
  transports.push(transport);
  return transport;
}

afterEach(() => {
  for (const transport of transports.splice(0)) transport.leave();
  for (const directory of directories.splice(0)) directory.close();
});

function startFixture(): Pick<StartInfo, 'seed' | 'settings' | 'players' | 'peers'> {
  const players: StartPlayer[] = [
    {
      player: 0,
      id: 'host-peer',
      name: 'Hôte',
      colour: 0,
      companyName: 'Réseau Express',
      ai: null,
      isHost: true,
    },
    {
      player: 1,
      id: 'ai-1',
      name: 'IA 1',
      colour: 1,
      companyName: '',
      ai: 'hard',
      isHost: false,
    },
    {
      player: 2,
      id: 'guest-peer',
      name: 'Alice',
      colour: 2,
      companyName: '',
      ai: null,
      isHost: false,
    },
  ];
  return {
    seed: 42,
    settings: {
      mapSize: 256,
      climate: 'arctic',
      difficulty: 'hard',
      startingMoney: 100000,
      maxPlayers: 4,
    },
    players,
    peers: { 0: 'host-peer', 2: 'guest-peer' },
  };
}

describe('paramètres et invitations', () => {
  it('lit le mode local et une invitation complète', () => {
    const params = readNetworkParams('?net=local&room=m3k7-9qfx&host=peer-0001');
    expect(params.kind).toBe('local');
    expect(params.invite).toEqual({ roomId: 'm3k7-9qfx', hostId: 'peer-0001' });
    expect(params.warning).toBeNull();
  });

  it('accepte un code seul et refuse un code invalide', () => {
    expect(parseJoinTarget('  M3K7-9QFX ')).toEqual({ roomId: 'm3k7-9qfx', hostId: null });
    expect(parseJoinTarget('https://example.test/?room=abcd-efgh&host=peer-0001')).toEqual({
      roomId: 'abcd-efgh',
      hostId: 'peer-0001',
    });
    expect(parseJoinTarget('pas un salon !')).toBeNull();
    expect(parseJoinTarget('')).toBeNull();
  });

  it('conserve ?net=local dans le lien copié', () => {
    const local = buildRoomInvite('abcd-efgh', 'peer-0001', 'local', 'https://example.test/app');
    expect(local).toBe('https://example.test/app?room=abcd-efgh&host=peer-0001&net=local');
    expect(local.match(/\?/g)).toHaveLength(1);
    const online = buildRoomInvite(
      'abcd-efgh',
      'peer-0001',
      'trystero',
      'https://example.test/app',
    );
    expect(online).toBe('https://example.test/app?room=abcd-efgh&host=peer-0001');
  });

  it('génère un code de salon lisible', () => {
    const roomId = newRoomId();
    expect(roomId).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
  });
});

describe('mapping StartInfo → options moteur', () => {
  it('transmet seed, taille, climat, difficulté et IA', () => {
    const mapped = mapStartInfoToGameOptions(startFixture(), 'medium');
    expect(mapped.options.seed).toBe(42);
    expect(mapped.options.size).toBe(256);
    expect(mapped.options.climate).toBe('subarctic');
    expect(mapped.options.difficulty).toBe(2);
    expect(mapped.options.aiCompanies).toBe(1);
    expect(mapped.options.quality).toBe('medium');
    expect(mapped.warnings).toEqual([]);
  });

  it('ramène les grandes cartes au plafond du mock avec un avertissement', () => {
    const info = startFixture();
    const mapped = mapStartInfoToGameOptions(
      { ...info, settings: { ...info.settings, mapSize: 2048 } },
      'low',
    );
    expect(mapped.options.size).toBe(512);
    expect(mapped.warnings.join(' ')).toMatch(/512/);
  });

  it('nomme les pairs et calcule les attentes du salon', () => {
    const info = startFixture();
    expect(peerNamesFromStart(info)).toEqual({
      'host-peer': 'Hôte',
      'guest-peer': 'Alice',
    });
    const state = {
      roomId: 'abcd-efgh',
      hostId: 'host-peer',
      name: 'Test',
      maxPlayers: 4,
      slots: [
        {
          id: 'host-peer',
          player: 0,
          name: 'Hôte',
          colour: 0,
          companyName: '',
          ready: true,
          isHost: true,
          ai: null,
          connected: true,
        },
        {
          id: 'guest-peer',
          player: 1,
          name: 'Alice',
          colour: 1,
          companyName: '',
          ready: false,
          isHost: false,
          ai: null,
          connected: true,
        },
      ],
      settings: info.settings,
      started: false,
      closed: false,
    };
    expect(lobbyStartReadiness(state)).toEqual({ ready: false, waiting: ['Alice'] });
    state.slots[1]!.ready = true;
    expect(lobbyStartReadiness(state)).toEqual({ ready: true, waiting: [] });
  });
});

describe('statut réseau', () => {
  it('affiche l’attente côté hôte et les métriques côté invité', () => {
    const waiting = describeNetworkStatus({
      isHost: true,
      tick: 12,
      ping: 0,
      desyncs: 0,
      waiting: true,
      waitingFor: ['guest-peer'],
      names: { 'guest-peer': 'Alice' },
      playersOnline: 2,
      lost: false,
    });
    expect(waiting).toEqual({ text: 'En attente de Alice…', tone: 'wait' });

    const client = describeNetworkStatus({
      isHost: false,
      tick: 480,
      ping: 42,
      desyncs: 1,
      waiting: false,
      waitingFor: [],
      names: {},
      playersOnline: 2,
      lost: false,
    });
    expect(client.text).toContain('ping 42 ms');
    expect(client.text).toContain('1 resync');
    expect(client.tone).toBe('warn');

    expect(
      describeNetworkStatus({
        isHost: false,
        tick: 0,
        ping: 0,
        desyncs: 0,
        waiting: false,
        waitingFor: [],
        names: {},
        playersOnline: 2,
        lost: true,
      }),
    ).toEqual({ text: 'Hôte perdu — reconnexion impossible', tone: 'error' });
  });
});

describe('transport détachable et porte de démarrage', () => {
  it('retire les handlers du salon sans fermer le transport', () => {
    const bus = createMemoryBus();
    const room = 'detach-room';
    const host = memoryTransport(room, bus);
    const peer = memoryTransport(room, bus);
    const handle = detachableTransport(host);
    let received = 0;
    handle.transport.on('lobby-chat', () => {
      received += 1;
    });
    peer.send('lobby-chat', { v: 1, k: 'chat', text: 'avant' });
    expect(received).toBe(1);

    handle.detach();
    peer.send('lobby-chat', { v: 1, k: 'chat', text: 'après' });
    expect(received).toBe(1);

    // Le transport reste utilisable pour le lockstep, via la même façade :
    // les handlers du salon sont partis, ceux de la session arrivent après.
    let direct = 0;
    handle.transport.on('turn', () => {
      direct += 1;
    });
    peer.send('turn', { v: 1, k: 'turn', epoch: 0, tick: 0, commands: [], d: 0 });
    expect(direct).toBe(1);
    expect(host.selfId).toBe(handle.transport.selfId);
  });

  it('refuse les retardataires avec un kick explicite', () => {
    const bus = createMemoryBus();
    const room = 'gate-room';
    const host = memoryTransport(room, bus);
    const invited = memoryTransport(room, bus);
    const late = memoryTransport(room, bus);
    const off = installStartedGate(host, [host.selfId, invited.selfId]);

    const kicks: { reason?: string }[] = [];
    late.on(LOBBY_CHANNELS.kick, (data) => kicks.push(data as { reason?: string }));
    let invitedKicks = 0;
    invited.on(LOBBY_CHANNELS.kick, () => {
      invitedKicks += 1;
    });

    late.send(LOBBY_CHANNELS.join, { v: 1, k: 'join', name: 'Retardataire' });
    invited.send(LOBBY_CHANNELS.join, { v: 1, k: 'join', name: 'Déjà là' });

    expect(kicks[0]?.reason).toMatch(/déjà démarré/i);
    expect(invitedKicks).toBe(0);
    off();
  });
});
