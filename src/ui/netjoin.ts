/**
 * Protocole d'annonce du join tardif (#92), côté UI uniquement.
 *
 * Le transfert de sauvegarde lui-même reste celui de `NetSession` (#38) :
 * `join-request` / `join-accept` / `join-chunk` / `join-ready` / `join-reject`.
 * Ce module ajoute seulement la découverte : un onglet qui ouvre un code de
 * salon demande « une partie est-elle en cours ? », et l'hôte répond avec le
 * `StartPayload` figé au démarrage (graine, réglages, joueurs, build moteur).
 * Les canaux sont distincts de ceux du salon, donc un lobby non démarré n'est
 * pas perturbé : personne n'y répond.
 *
 * Rien ici ne touche au DOM : les écrans et les contrôleurs testent ces
 * helpers purs sous Node avec le transport mémoire.
 */

import type { EngineMode } from '../engine/loadEngine';
import { engineBuildId } from '../engine/loadEngine';
import { isPeerRef, isStartPayload, type StartInfo, type StartPayload } from '../net/lobby-types';
import type { JoinProgress, JoinWindowStatus } from '../net/session';
import type { JoinRejectReason } from '../net/types';
import { isJoinRejectReason } from '../net/types';
import type { Transport } from '../net/transport';
import { t, tn } from './i18n';
import { freeCompanyForPayload } from './netlobby';

/** Version du petit protocole de découverte, indépendante du lockstep. */
export const LATE_JOIN_PROTOCOL_VERSION = 1;

export const LATE_JOIN_CHANNELS = {
  /** Retardataire → hôte (ou diffusion) : « la partie tourne-t-elle ? ». */
  query: 'late-query',
  /** Hôte → retardataire : capacité, configuration et admission. */
  offer: 'late-offer',
} as const;

/**
 * - `available` : la partie tourne, la configuration suit ; le client peut
 *   initialiser son moteur puis redemander avec `ready: true`.
 * - `pending` : l'hôte doit autoriser explicitement (aucune place réservée).
 * - `open` : place réservée, le client peut envoyer `join-request`.
 * - `busy` : l'hôte charge encore ; réessayer.
 * - `denied` : refus définitif (version, partie pleine, fenêtre fermée…).
 */
export type LateJoinOfferStatus = 'available' | 'pending' | 'open' | 'busy' | 'denied';

export interface LateJoinQuery {
  v: number;
  k: 'late-query';
  /** Nom affiché à l'hôte, informatif. */
  name?: string;
  /** Build moteur du client, refusé tôt s'il diffère. */
  engine?: string;
  /** Vrai quand le moteur local est initialisé et prêt à charger la sauvegarde. */
  ready?: boolean;
}

export interface LateJoinOffer {
  v: number;
  k: 'late-offer';
  status: LateJoinOfferStatus;
  /** Configuration figée de la partie en cours. */
  payload?: StartPayload;
  reason?: JoinRejectReason;
  message?: string;
}

// ---------------------------------------------------------------------------
// Guards

function hasLateBase(value: unknown): value is Record<string, unknown> & { v: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { v?: unknown }).v === LATE_JOIN_PROTOCOL_VERSION
  );
}

export function isLateJoinQuery(value: unknown): value is LateJoinQuery {
  if (!hasLateBase(value) || value.k !== 'late-query') return false;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 24)) {
    return false;
  }
  if (
    value.engine !== undefined &&
    (typeof value.engine !== 'string' || value.engine.length > 64)
  ) {
    return false;
  }
  if (value.ready !== undefined && typeof value.ready !== 'boolean') return false;
  return true;
}

export function isLateJoinOfferStatus(value: unknown): value is LateJoinOfferStatus {
  return (
    value === 'available' ||
    value === 'pending' ||
    value === 'open' ||
    value === 'busy' ||
    value === 'denied'
  );
}

export function isLateJoinOffer(value: unknown): value is LateJoinOffer {
  if (!hasLateBase(value) || value.k !== 'late-offer') return false;
  if (!isLateJoinOfferStatus(value.status)) return false;
  if (value.payload !== undefined && !isStartPayload(value.payload)) return false;
  if (value.reason !== undefined && !isJoinRejectReason(value.reason)) return false;
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' || value.message.length > 240)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Construction / vérification

/** Premier index de joueur libre (0..63), ou -1 si le protocole est saturé. */
export function freeStartPlayerIndex(peers: Record<number, string>): number {
  for (let player = 0; player < 64; player++) {
    if (!(player in peers)) return player;
  }
  return -1;
}

/** Pair qui héberge la partie, d'après le `StartPayload`. */
export function hostPeerIdFromPayload(
  payload: Pick<StartPayload, 'players' | 'peers'>,
): string | null {
  const host = payload.players.find((player) => player.isHost);
  if (!host) return null;
  return payload.peers[host.player] ?? null;
}

/**
 * Vérifie la cohérence du build annoncé avec le mode figé et avec le client.
 * Un mélange mock/WASM ou deux versions d'artefacts doivent être refusés avant
 * toute allocation de moteur, sinon les pairs divergeraient au premier tick.
 */
export function checkLateJoinCompatibility(
  payload: Pick<StartPayload, 'settings' | 'engineBuild'>,
  expectedBuild = engineBuildId(payload.settings.engine),
): string | null {
  if (payload.engineBuild !== expectedBuild) {
    return t('join.incompatible', {
      actual: payload.engineBuild || '?',
      expected: expectedBuild,
    });
  }
  return null;
}

/** `StartInfo` local du retardataire ; l'hôte reste l'autorité sur son index. */
export function createLateJoinStartInfo(
  payload: StartPayload,
  transport: Transport,
  localPlayer: number,
  localCompany: number | undefined = freeCompanyForPayload(payload),
): StartInfo {
  return {
    seed: payload.seed,
    settings: { ...payload.settings },
    engineBuild: payload.engineBuild,
    players: payload.players.map((player) => ({ ...player })),
    peers: { ...payload.peers },
    ...(payload.companySeats === undefined ? {} : { companySeats: payload.companySeats }),
    localPlayer,
    ...(localCompany === undefined ? {} : { localCompany }),
    isHost: false,
    transport,
  };
}

/** Le pair qui répond à la requête est-il bien l'hôte annoncé ? */
export function isOfferFromHost(payload: StartPayload, from: string): boolean {
  const host = hostPeerIdFromPayload(payload);
  return host === null || host === from;
}

// ---------------------------------------------------------------------------
// Messages lisibles

export function joinRejectMessage(reason: JoinRejectReason, detail?: string): string {
  if (detail && detail.trim()) return detail.trim();
  switch (reason) {
    case 'full':
      return t('join.reject.full');
    case 'version':
      return t('join.reject.version');
    case 'started':
      return t('join.reject.started');
    case 'closed':
      return t('join.reject.closed');
    case 'invalid-save':
      return t('join.reject.invalidSave');
    case 'timeout':
      return t('join.reject.timeout');
    default:
      return t('join.reject.default');
  }
}

export function offerRejectMessage(offer: LateJoinOffer): string {
  return joinRejectMessage(offer.reason ?? 'closed', offer.message);
}

// ---------------------------------------------------------------------------
// États de l'écran client

export type LateJoinStage =
  'idle' | 'initializing' | 'waiting' | 'requesting' | 'transfer' | 'joined' | 'rejected';

export interface LateJoinUiState {
  stage: LateJoinStage;
  message: string;
  tone: 'info' | 'ok' | 'warn' | 'error';
  /** Progression affichable, 0..1. */
  progress: number;
  received: number;
  total: number;
  player?: number;
  tick?: number;
  /** Progression de l'initialisation du moteur (WASM), 0..1. */
  engineProgress?: number;
}

export interface JoinDescription {
  title: string;
  message: string;
  tone: LateJoinUiState['tone'];
  progress: number;
}

/** Traduit l'état interne du contrôleur en textes et progression pour l'écran. */
export function describeLateJoinState(state: LateJoinUiState): JoinDescription {
  const ratio = state.total > 0 ? Math.max(0, Math.min(1, state.received / state.total)) : 0;
  switch (state.stage) {
    case 'initializing': {
      const engine = Math.max(0, Math.min(1, state.engineProgress ?? 0));
      return {
        title: t('join.stage.initializing.title'),
        message: state.message || t('join.stage.initializing.message'),
        tone: 'info',
        progress: 0.05 + engine * 0.25,
      };
    }
    case 'waiting':
      return {
        title: t('join.stage.waiting.title'),
        message: state.message || t('join.stage.waiting.message'),
        tone: 'warn',
        progress: 0.3,
      };
    case 'requesting':
      return {
        title: t('join.stage.requesting.title'),
        message: state.message || t('join.stage.requesting.message'),
        tone: 'info',
        progress: 0.35,
      };
    case 'transfer':
      return {
        title: t('join.stage.transfer.title'),
        message:
          state.message ||
          t('join.stage.transfer.message', {
            received: state.received,
            total: state.total || '?',
            percent: Math.round(ratio * 100),
          }),
        tone: 'info',
        progress: 0.35 + ratio * 0.5,
      };
    case 'joined':
      return {
        title: t('join.stage.joined.title'),
        message:
          state.message ||
          t('join.stage.joined.message', {
            tick: state.tick ?? 0,
          }),
        tone: 'ok',
        progress: 0.9,
      };
    case 'rejected':
      return {
        title: t('join.stage.rejected.title'),
        message: state.message || t('join.stage.rejected.message'),
        tone: 'error',
        progress: 1,
      };
    default:
      return {
        title: t('join.stage.idle.title'),
        message: state.message || t('join.stage.idle.message'),
        tone: 'info',
        progress: 0.02,
      };
  }
}

/** Adapte la progression native de `NetSession` à l'écran de join. */
export function lateJoinStateFromSession(
  progress: JoinProgress,
  previous?: LateJoinUiState,
): LateJoinUiState {
  const base: LateJoinUiState = {
    stage: 'idle',
    message: '',
    tone: 'info',
    progress: 0,
    received: progress.received,
    total: progress.total,
    ...(progress.player !== undefined ? { player: progress.player } : {}),
    ...(progress.tick !== undefined ? { tick: progress.tick } : {}),
  };
  switch (progress.phase) {
    case 'requesting':
      return { ...base, stage: 'requesting', message: t('join.msg.requesting') };
    case 'transfer':
      return {
        ...base,
        stage: 'transfer',
        message: t('join.msg.transfer', {
          received: progress.received,
          total: progress.total || '?',
        }),
      };
    case 'joined':
      return {
        ...base,
        stage: 'joined',
        tone: 'ok',
        message: t('join.msg.joined', { tick: progress.tick ?? 0 }),
      };
    case 'rejected':
      return {
        ...base,
        stage: 'rejected',
        tone: 'error',
        message: previous?.message || t('join.msg.rejected'),
      };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// États de l'écran hôte

export interface HostJoinPending {
  peerId: string;
  name: string;
  ready: boolean;
  requestedAt: number;
}

export interface HostJoinOutcome {
  ok: boolean;
  message: string;
  at: number;
}

export interface HostJoinView {
  autoAdmit: boolean;
  pending: HostJoinPending[];
  windows: JoinWindowStatus[];
  outcome: HostJoinOutcome | null;
  players: { player: number; name: string }[];
}

export interface HostJoinSummary {
  text: string;
  tone: 'ok' | 'info' | 'wait' | 'warn' | 'error';
  /** Une fenêtre ou un transfert est en cours. */
  active: boolean;
  /** Nombre de demandes en attente d'autorisation. */
  pendingCount: number;
  /** Libellé du bouton principal. */
  primaryLabel: string;
  /** Explication affichée sous le contrôle. */
  hint: string;
}

export function describeHostJoin(view: HostJoinView, now = Date.now()): HostJoinSummary {
  const pendingCount = view.pending.length;
  const transfer = view.windows.find((item) => item.phase === 'transfer');
  const serializing = view.windows.find((item) => item.phase === 'serializing');
  const reserved = view.windows.find((item) => item.phase === 'reserved');
  const active = view.windows.length > 0;
  const age = (at: number): string => {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)} min` : `${seconds} s`;
  };

  if (view.outcome && now - view.outcome.at < 12_000) {
    return {
      text: view.outcome.message,
      tone: view.outcome.ok ? 'ok' : 'error',
      active,
      pendingCount,
      primaryLabel: view.autoAdmit ? t('late.close') : t('late.open'),
      hint: view.outcome.ok ? t('late.outcome.ok') : t('late.outcome.error'),
    };
  }
  if (transfer) {
    return {
      text: t('late.transfer', { sent: transfer.sent, total: transfer.total }),
      tone: 'wait',
      active: true,
      pendingCount,
      primaryLabel: t('late.cancelTransfer'),
      hint: t('late.transferHint'),
    };
  }
  if (serializing) {
    return {
      text: t('late.serializing'),
      tone: 'wait',
      active: true,
      pendingCount,
      primaryLabel: t('late.cancelTransfer'),
      hint: t('late.serializingHint'),
    };
  }
  if (reserved) {
    return {
      text: t('late.reserved'),
      tone: 'wait',
      active: true,
      pendingCount,
      primaryLabel: t('late.cancelWindow'),
      hint: t('late.reservedHint'),
    };
  }
  if (pendingCount > 0) {
    const first = view.pending[0];
    const label = first ? `${first.name} (${age(first.requestedAt)})` : t('late.unknownPlayer');
    return {
      text: view.autoAdmit
        ? t('late.pendingAuto', { name: label })
        : tn(pendingCount, 'late.pending.one', 'late.pending.other', { name: label }),
      tone: view.autoAdmit ? 'wait' : 'info',
      active: false,
      pendingCount,
      primaryLabel: view.autoAdmit ? t('late.close') : t('late.open'),
      hint: view.autoAdmit ? t('late.pendingHintAuto') : t('late.pendingHintManual'),
    };
  }
  return {
    text: view.autoAdmit ? t('late.idleAuto') : t('late.idle'),
    tone: view.autoAdmit ? 'wait' : 'info',
    active: false,
    pendingCount: 0,
    primaryLabel: view.autoAdmit ? t('late.close') : t('late.open'),
    hint: view.autoAdmit ? t('late.idleHintAuto') : t('late.idleHint'),
  };
}

/** Compteur de joueurs humains/IA affiché dans le panneau hôte. */
export function playerCountLabel(view: Pick<HostJoinView, 'players'>): string {
  const count = view.players.length;
  return tn(count, 'late.playerCount.one', 'late.playerCount.other');
}

/** Un pair découvert doit-il être proposé à l'hôte ? */
export function isLateJoinCandidate(
  peerId: string,
  selfId: string,
  knownPeers: Iterable<string>,
): boolean {
  if (!isPeerRef(peerId) || peerId === selfId) return false;
  for (const known of knownPeers) if (known === peerId) return false;
  return true;
}

/** Construit le `StartPayload` figé à partir du `StartInfo` de l'hôte. */
export function startPayloadFromInfo(info: StartInfo): StartPayload {
  return {
    seed: info.seed,
    settings: { ...info.settings },
    engineBuild: info.engineBuild,
    players: info.players.map((player) => ({ ...player })),
    peers: { ...info.peers },
    ...(info.companySeats === undefined ? {} : { companySeats: info.companySeats }),
  };
}

/** Rappel de compatibilité pour un mode moteur donné. */
export function expectedBuildForMode(mode: EngineMode): string {
  return engineBuildId(mode);
}
