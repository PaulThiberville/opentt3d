import { describe, expect, it } from 'vitest';
import { engineBuildId } from '../src/engine/loadEngine';
import type { StartInfo, StartPayload } from '../src/net/lobby-types';
import type { JoinProgress } from '../src/net/session';
import type { Transport } from '../src/net/transport';
import {
  LATE_JOIN_PROTOCOL_VERSION,
  checkLateJoinCompatibility,
  createLateJoinStartInfo,
  describeHostJoin,
  describeLateJoinState,
  freeStartPlayerIndex,
  hostPeerIdFromPayload,
  isLateJoinCandidate,
  isLateJoinOffer,
  isLateJoinQuery,
  joinRejectMessage,
  lateJoinStateFromSession,
  offerRejectMessage,
  playerCountLabel,
  startPayloadFromInfo,
  type HostJoinView,
  type LateJoinUiState,
} from '../src/ui/netjoin';

function payloadFixture(overrides: Partial<StartPayload> = {}): StartPayload {
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
    players: [
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
        id: 'guest-peer',
        name: 'Alice',
        colour: 1,
        companyName: '',
        ai: null,
        isHost: false,
      },
      {
        player: 2,
        id: 'ai-2',
        name: 'IA 1',
        colour: 2,
        companyName: '',
        ai: 'normal',
        isHost: false,
      },
    ],
    peers: { 0: 'host-peer', 1: 'guest-peer' },
    ...overrides,
  };
}

function viewFixture(overrides: Partial<HostJoinView> = {}): HostJoinView {
  return {
    autoAdmit: false,
    pending: [],
    windows: [],
    outcome: null,
    players: [
      { player: 0, name: 'Hôte' },
      { player: 2, name: 'IA 1' },
    ],
    ...overrides,
  };
}

describe('protocole de découverte du join tardif', () => {
  it('valide les requêtes minimales et les offres bien formées', () => {
    expect(isLateJoinQuery({ v: 1, k: 'late-query' })).toBe(true);
    expect(isLateJoinQuery({ v: 1, k: 'late-query', ready: true, engine: 'mock-1' })).toBe(true);
    expect(isLateJoinQuery({ v: 2, k: 'late-query' })).toBe(false);
    expect(isLateJoinQuery({ v: 1, k: 'late-query', name: 'x'.repeat(25) })).toBe(false);
    expect(isLateJoinQuery({ v: 1, k: 'late-query', ready: 'yes' })).toBe(false);

    const payload = payloadFixture();
    expect(isLateJoinOffer({ v: 1, k: 'late-offer', status: 'available', payload })).toBe(true);
    expect(isLateJoinOffer({ v: 1, k: 'late-offer', status: 'denied', reason: 'full' })).toBe(true);
    expect(isLateJoinOffer({ v: 1, k: 'late-offer', status: 'nope' })).toBe(false);
    expect(
      isLateJoinOffer({ v: 1, k: 'late-offer', status: 'available', payload: { seed: 1 } }),
    ).toBe(false);
  });

  it('trouve un index libre et l’hôte annoncé', () => {
    const payload = payloadFixture();
    expect(freeStartPlayerIndex(payload.peers)).toBe(2);
    expect(freeStartPlayerIndex({ ...payload.peers, 2: 'x', 3: 'y' })).toBe(4);
    expect(hostPeerIdFromPayload(payload)).toBe('host-peer');

    const saturated: Record<number, string> = {};
    for (let index = 0; index < 64; index++) saturated[index] = `peer-${index}`;
    expect(freeStartPlayerIndex(saturated)).toBe(-1);
  });

  it('refuse un build moteur différent de celui annoncé', () => {
    const payload = payloadFixture();
    expect(checkLateJoinCompatibility(payload)).toBeNull();
    expect(checkLateJoinCompatibility(payload, 'opentt3d-wasm-1')).toContain('Moteur incompatible');
    expect(checkLateJoinCompatibility({ ...payload, engineBuild: 'autre-build' })).toContain(
      'Moteur incompatible',
    );
  });

  it('construit un StartInfo local sans modifier le payload', () => {
    const payload = payloadFixture();
    const transport = { selfId: 'guest-peer' } as unknown as Transport;
    const info: StartInfo = createLateJoinStartInfo(payload, transport, 2);
    expect(info.localPlayer).toBe(2);
    expect(info.isHost).toBe(false);
    expect(info.players).toEqual(payload.players);
    expect(info.players).not.toBe(payload.players);
    expect(startPayloadFromInfo(info)).toEqual(payload);
  });

  it('reconnaît un pair qui n’est pas déjà dans la partie', () => {
    expect(isLateJoinCandidate('new-peer', 'host-peer', ['host-peer', 'guest-peer'])).toBe(true);
    expect(isLateJoinCandidate('guest-peer', 'host-peer', ['host-peer', 'guest-peer'])).toBe(false);
    expect(isLateJoinCandidate('host-peer', 'host-peer', ['host-peer'])).toBe(false);
    expect(isLateJoinCandidate('x', 'host-peer', [])).toBe(false);
  });
});

describe('messages de refus', () => {
  it('couvre toutes les raisons avec un texte français', () => {
    expect(joinRejectMessage('full')).toContain('complète');
    expect(joinRejectMessage('version')).toContain('Version incompatible');
    expect(joinRejectMessage('started')).toContain('déjà démarré');
    expect(joinRejectMessage('closed')).toContain('fermée');
    expect(joinRejectMessage('invalid-save')).toContain('invalide');
    expect(joinRejectMessage('timeout')).toContain('délai');
    expect(joinRejectMessage('full', 'Message de l’hôte')).toBe('Message de l’hôte');
    expect(
      offerRejectMessage({
        v: LATE_JOIN_PROTOCOL_VERSION,
        k: 'late-offer',
        status: 'denied',
        reason: 'full',
      }),
    ).toContain('complète');
  });
});

describe('progression affichée au client', () => {
  it('mappe chaque étape sur un titre, un ton et une progression', () => {
    const base: LateJoinUiState = {
      stage: 'idle',
      message: '',
      tone: 'info',
      progress: 0,
      received: 0,
      total: 0,
    };
    expect(describeLateJoinState(base).progress).toBeCloseTo(0.02);
    expect(
      describeLateJoinState({ ...base, stage: 'initializing', engineProgress: 0.5 }).progress,
    ).toBeCloseTo(0.175);
    expect(describeLateJoinState({ ...base, stage: 'waiting' }).tone).toBe('warn');
    const transfer = describeLateJoinState({
      ...base,
      stage: 'transfer',
      received: 3,
      total: 12,
    });
    expect(transfer.progress).toBeCloseTo(0.475);
    expect(transfer.message).toContain('3/12');
    const joined = describeLateJoinState({ ...base, stage: 'joined', tick: 500 });
    expect(joined.tone).toBe('ok');
    expect(joined.message).toContain('500');
    const rejected = describeLateJoinState({
      ...base,
      stage: 'rejected',
      message: 'Partie complète.',
    });
    expect(rejected.tone).toBe('error');
    expect(rejected.message).toBe('Partie complète.');
    expect(rejected.progress).toBe(1);
  });

  it('adapte la progression native de NetSession', () => {
    const requesting: JoinProgress = { phase: 'requesting', received: 0, total: 0 };
    expect(lateJoinStateFromSession(requesting).stage).toBe('requesting');
    const transfer: JoinProgress = { phase: 'transfer', received: 8, total: 10, tick: 300 };
    const state = lateJoinStateFromSession(transfer);
    expect(state.stage).toBe('transfer');
    expect(state.received).toBe(8);
    expect(state.tick).toBe(300);
    const joined: JoinProgress = {
      phase: 'joined',
      received: 10,
      total: 10,
      tick: 300,
      player: 2,
    };
    const done = lateJoinStateFromSession(joined);
    expect(done.stage).toBe('joined');
    expect(done.player).toBe(2);
    expect(done.message).toContain('300');
    expect(lateJoinStateFromSession({ phase: 'rejected', received: 0, total: 0 }).stage).toBe(
      'rejected',
    );
  });
});

describe('état du panneau hôte', () => {
  it('décrit l’ouverture, les demandes en attente et le transfert', () => {
    const idle = describeHostJoin(viewFixture());
    expect(idle.text).toContain('Aucune demande');
    expect(idle.primaryLabel).toBe('Ouvrir aux retardataires');
    expect(idle.tone).toBe('info');

    const pending = describeHostJoin(
      viewFixture({
        pending: [{ peerId: 'new-peer', name: 'Bob', ready: true, requestedAt: 1_000 }],
      }),
      5_000,
    );
    expect(pending.pendingCount).toBe(1);
    expect(pending.text).toContain('Bob');
    expect(pending.text).toContain('4 s');

    const transfer = describeHostJoin(
      viewFixture({
        windows: [{ peerId: 'new-peer', player: 2, phase: 'transfer', sent: 3, total: 10 }],
      }),
    );
    expect(transfer.active).toBe(true);
    expect(transfer.tone).toBe('wait');
    expect(transfer.text).toContain('3/10');

    const serializing = describeHostJoin(
      viewFixture({
        windows: [{ peerId: 'new-peer', player: 2, phase: 'serializing', sent: 0, total: 0 }],
      }),
    );
    expect(serializing.text).toContain('Sérialisation');

    const reserved = describeHostJoin(
      viewFixture({
        windows: [{ peerId: 'new-peer', player: 2, phase: 'reserved', sent: 0, total: 0 }],
      }),
    );
    expect(reserved.text).toContain('Place réservée');
  });

  it('affiche l’admission automatique et le succès récent', () => {
    const auto = describeHostJoin(viewFixture({ autoAdmit: true }));
    expect(auto.primaryLabel).toBe('Fermer aux retardataires');
    expect(auto.tone).toBe('wait');

    const success = describeHostJoin(
      viewFixture({
        outcome: { ok: true, message: 'Bob a rejoint la partie au tick 500.', at: 10_000 },
        players: [
          { player: 0, name: 'Hôte' },
          { player: 2, name: 'Bob' },
        ],
      }),
      11_000,
    );
    expect(success.tone).toBe('ok');
    expect(success.text).toContain('Bob');
    expect(
      playerCountLabel({
        players: [
          { player: 0, name: 'Hôte' },
          { player: 2, name: 'Bob' },
        ],
      }),
    ).toBe('2 joueurs dans la partie');

    const stale = describeHostJoin(
      viewFixture({
        outcome: { ok: false, message: 'Refusé.', at: 1_000 },
      }),
      30_000,
    );
    expect(stale.text).not.toBe('Refusé.');
  });
});
