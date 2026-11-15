/**
 * Entreprises par joueur côté lobby et réseau (#99).
 *
 * Couvre le mapping `playerIndex → companyId` construit par l'hôte, la liste
 * d'entreprises transmise au moteur, la marque `isLocal` du snapshot, la
 * validation des commandes par l'hôte et l'attribution d'une entreprise à un
 * retardataire.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EngineCommand } from '../src/engine/protocol';
import { MockEngine } from '../src/engine/MockEngine';
import { engineBuildId } from '../src/engine/loadEngine';
import { assignLobbyCompanies } from '../src/net/lobby';
import type { Slot, StartInfo, StartPayload } from '../src/net/lobby-types';
import { createNetSession, type JoinEvent, type NetSession } from '../src/net/session';
import {
  createMemoryBus,
  createTransport,
  type MemoryBus,
  type Transport,
} from '../src/net/transport';
import {
  companyForPlayer,
  companyProfilesFromStart,
  companySeatsForStart,
  freeCompanyForPayload,
  hasCompanyMapping,
  localCompanyForStart,
  mapStartInfoToGameOptions,
} from '../src/ui/netlobby';
import { createLateJoinStartInfo, startPayloadFromInfo } from '../src/ui/netjoin';
import { MockRunner, drive } from './net/helpers';

const cleanups: { transports: Transport[]; sessions: NetSession[]; engines: MockEngine[] }[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    for (const session of cleanup.sessions) session.dispose();
    for (const transport of cleanup.transports) transport.leave();
    for (const engine of cleanup.engines) engine.dispose();
  }
});

function slot(partial: Partial<Slot> & Pick<Slot, 'id' | 'player' | 'name'>): Slot {
  return {
    colour: 0,
    companyName: '',
    ready: true,
    isHost: false,
    ai: null,
    connected: true,
    ...partial,
  };
}

const SLOTS: Slot[] = [
  slot({
    id: 'host-peer',
    player: 0,
    name: 'Hôte',
    colour: 0,
    companyName: 'Réseau Express',
    isHost: true,
  }),
  slot({ id: 'ai-peer', player: 1, name: 'IA 1', colour: 1, ai: 'normal' }),
  slot({ id: 'guest-peer', player: 2, name: 'Alice', colour: 2 }),
];

function payloadFixture(): StartPayload {
  const { seats, players } = assignLobbyCompanies(SLOTS, 4, 1);
  return {
    seed: 4242,
    settings: {
      engine: 'mock',
      mapSize: 256,
      climate: 'temperate',
      difficulty: 'normal',
      startingMoney: 100000,
      maxPlayers: 4,
    },
    engineBuild: engineBuildId('mock'),
    players,
    peers: { 0: 'host-peer', 2: 'guest-peer' },
    companySeats: seats,
  };
}

describe('mapping joueur → entreprise du salon (#99)', () => {
  it('attribue les entreprises humaines d’abord, puis les IA après les réserves', () => {
    const { seats, players } = assignLobbyCompanies(SLOTS, 4, 1);
    // 4 sièges - 1 IA = 3 entreprises humaines (dont une réserve).
    expect(seats).toBe(3);
    expect(players.map((player) => [player.player, player.company])).toEqual([
      [0, 0],
      [1, 3], // l'IA vient après les entreprises humaines
      [2, 1],
    ]);
    const payload = payloadFixture();
    expect(hasCompanyMapping(payload)).toBe(true);
    expect(companySeatsForStart(payload)).toBe(3);
    expect(companyForPlayer(payload, 2)).toBe(1);
    expect(companyForPlayer(payload, 1)).toBe(3);
    expect(companyForPlayer(payload, 9)).toBeUndefined();
  });

  it('construit des profils d’entreprise identiques sur tous les pairs', () => {
    const payload = payloadFixture();
    expect(companyProfilesFromStart(payload)).toEqual([
      { name: 'Réseau Express', colour: 0 },
      { name: 'Alice Transport', colour: 2 },
      { name: 'Entreprise 3 (réserve)', colour: 1 },
    ]);
    // Le payload ne contient encore aucun retardataire : la réserve 3 est libre.
    expect(freeCompanyForPayload(payload)).toBe(2);

    const info: StartInfo = {
      ...payload,
      localPlayer: 2,
      localCompany: companyForPlayer(payload, 2),
      isHost: false,
      transport: {} as Transport,
    };
    expect(localCompanyForStart(info)).toBe(1);
    const mapped = mapStartInfoToGameOptions(info, 'medium');
    expect(mapped.options.companies).toEqual(companyProfilesFromStart(payload));
    expect(mapped.options.aiCompanies).toBe(1);
  });

  it('ignore les payloads #93 sans mapping (entreprise unique historique)', () => {
    const payload = payloadFixture();
    const legacy: StartPayload = {
      ...payload,
      players: payload.players.map((player) => ({
        player: player.player,
        id: player.id,
        name: player.name,
        colour: player.colour,
        companyName: player.companyName,
        ai: player.ai,
        isHost: player.isHost,
      })),
    };
    expect(hasCompanyMapping(legacy)).toBe(false);
    expect(companyProfilesFromStart(legacy)).toEqual([]);
    const legacyInfo: StartInfo = {
      ...legacy,
      localPlayer: 0,
      isHost: true,
      transport: {} as Transport,
    };
    expect(mapStartInfoToGameOptions(legacyInfo, 'medium').options.companies).toBeUndefined();
  });
});

describe('entreprise locale du moteur (#99)', () => {
  it('marque la bonne entreprise isLocal et signe les constructions avec elle', async () => {
    const payload = payloadFixture();
    const companies = companyProfilesFromStart(payload);
    const engine = new MockEngine();
    cleanups.push({ transports: [], sessions: [], engines: [engine] });
    await engine.init({ moduleUrl: 'mock://companies' });
    await engine.newGame({
      seed: payload.seed,
      width: 128,
      height: 128,
      aiCompanies: 1,
      companies,
    });

    const before = engine.snapshot();
    expect(before.companies.map((company) => company.name)).toEqual([
      'Réseau Express',
      'Alice Transport',
      'Entreprise 3 (réserve)',
      'Ligne du Lac',
    ]);
    expect(before.companies.find((company) => company.isLocal)?.id).toBe(0);
    expect(engine.setLocalCompany(1)).toBe(true);
    const after = engine.snapshot();
    expect(after.companies.find((company) => company.isLocal)?.id).toBe(1);
    expect(engine.hash()).toBe(before.meta.hash);

    // L'entreprise 1 construit et paie ; l'entreprise 0 reste intacte.
    const map = before.map;
    if (!map) throw new Error('carte absente');
    let tile = { x: 8, y: 8 };
    for (let y = 2; y < map.height - 2 && tile.x === 8 && tile.y === 8; y += 1) {
      for (let x = 2; x < map.width - 4; x += 1) {
        if (
          map.kind[y * map.width + x] === 2 &&
          map.kind[y * map.width + x + 1] === 2 &&
          map.kind[y * map.width + x + 2] === 2 &&
          map.owner[y * map.width + x] === 255
        ) {
          tile = { x, y };
          break;
        }
      }
    }
    const money0 = after.companies.find((company) => company.id === 0)?.money ?? 0;
    const money1 = after.companies.find((company) => company.id === 1)?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'road',
      company: 1,
      from: tile,
      to: { x: tile.x + 2, y: tile.y },
      options: { axis: 'x' },
    });
    const built = engine.snapshot();
    expect(built.map?.owner[tile.y * built.map.width + tile.x]).toBe(1);
    expect(built.companies.find((company) => company.id === 0)?.money).toBe(money0);
    expect(built.companies.find((company) => company.id === 1)?.money).not.toBe(money1);
  });
});

describe('join tardif et entreprise assignée (#99)', () => {
  it('attribue une réserve au retardataire et rejette les commandes d’une autre entreprise', () => {
    const bus: MemoryBus = createMemoryBus();
    const roomId = `companies-${Math.random().toString(36).slice(2, 10)}`;
    const hostTransport = createTransport({ kind: 'memory', roomId, memory: { bus } });
    const guestTransport = createTransport({ kind: 'memory', roomId, memory: { bus } });
    const hostRunner = new MockRunner();
    const guestRunner = new MockRunner();
    const peers = { 0: hostTransport.selfId, 1: guestTransport.selfId };
    const hostSession = createNetSession({
      runner: hostRunner,
      localPlayer: 0,
      transport: hostTransport,
      isHost: true,
      peers,
      inputDelay: 3,
      maxPlayers: 4,
      companies: { 0: 0, 1: 1 },
      companySeats: 3,
    });
    // Le client annonce volontairement une mauvaise entreprise (0) : l'hôte doit
    // refuser sa commande alors que le mapping hôte est autoritaire.
    const guestSession = createNetSession({
      runner: guestRunner,
      localPlayer: 1,
      transport: guestTransport,
      isHost: false,
      hostId: hostTransport.selfId,
      peers,
      inputDelay: 3,
      companies: { 0: 0, 1: 0 },
      companySeats: 3,
    });
    const sessions = [hostSession, guestSession];
    cleanups.push({ transports: [hostTransport, guestTransport], sessions, engines: [] });

    drive(sessions, 100);
    const hostile: EngineCommand = {
      type: 'build',
      tool: 'road',
      company: 0,
      from: { x: 5, y: 5 },
      to: { x: 7, y: 5 },
      options: { axis: 'x' },
    };
    guestSession.issue(hostile);
    drive(sessions, 140);
    expect(hostSession.stats().rejected).toBeGreaterThan(0);
    expect(hostRunner.hash()).toBe(guestRunner.hash());

    const payload = payloadFixture();
    expect(payload.players.find((player) => player.player === 1)?.company).toBe(3);
    // Le mapping de ce cluster : deux humains (0 et 1) et une réserve (2).
    const networkPayload: StartPayload = {
      ...payload,
      players: [
        {
          player: 0,
          id: hostTransport.selfId,
          name: 'Hôte',
          colour: 0,
          companyName: 'Réseau Express',
          ai: null,
          isHost: true,
          company: 0,
        },
        {
          player: 1,
          id: guestTransport.selfId,
          name: 'Alice',
          colour: 2,
          companyName: '',
          ai: null,
          isHost: false,
          company: 1,
        },
      ],
      peers: { 0: hostTransport.selfId, 1: guestTransport.selfId },
      companySeats: 3,
    };
    const lateTransport = createTransport({ kind: 'memory', roomId, memory: { bus } });
    const lateRunner = new MockRunner();
    const lateSession = createNetSession({
      runner: lateRunner,
      localPlayer: 2,
      transport: lateTransport,
      isHost: false,
      hostId: hostTransport.selfId,
      peers,
      inputDelay: 3,
      companies: { 0: 0, 1: 1 },
      companySeats: 3,
      joinTimeoutMs: 5000,
    });
    cleanups.push({ transports: [lateTransport], sessions: [lateSession], engines: [] });
    const events: JoinEvent[] = [];
    lateSession.onJoin((event) => events.push(event));

    const admission = hostSession.admitPeer(lateTransport.selfId, 2);
    expect(admission).toEqual({ peerId: lateTransport.selfId, player: 2, company: 2 });
    expect(lateSession.requestJoin(hostTransport.selfId, 2)).toBe(true);
    expect(lateSession.joinPhase()).toBe('joined');
    expect(lateSession.localCompany).toBe(2);
    expect(events.at(-1)).toMatchObject({ ok: true, player: 2, company: 2 });

    const start = createLateJoinStartInfo(
      networkPayload,
      lateTransport,
      lateSession.localPlayer,
      lateSession.localCompany,
    );
    expect(start.localCompany).toBe(2);
    expect(start.companySeats).toBe(3);
    expect(localCompanyForStart(start)).toBe(2);

    // Le `StartInfo` reconstruit conserve le mapping figé sur le fil.
    expect(startPayloadFromInfo(start)).toEqual({
      seed: networkPayload.seed,
      settings: networkPayload.settings,
      engineBuild: networkPayload.engineBuild,
      players: networkPayload.players,
      peers: networkPayload.peers,
      companySeats: 3,
    });

    drive([hostSession, guestSession, lateSession], 260);
    expect(hostRunner.hash()).toBe(guestRunner.hash());
    expect(lateRunner.hash()).toBe(hostRunner.hash());
    expect(lateSession.stats().desyncs).toBe(0);
  });
});
