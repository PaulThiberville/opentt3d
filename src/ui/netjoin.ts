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
    return (
      `Moteur incompatible : la partie utilise « ${payload.engineBuild || 'inconnu'} » ` +
      `mais ce client attend « ${expectedBuild} ». ` +
      'Tous les joueurs doivent ouvrir la même version de l’application.'
    );
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
      return 'La partie est complète : aucune place de joueur n’est disponible.';
    case 'version':
      return 'Version incompatible : le moteur ou le protocole diffère de ceux de l’hôte.';
    case 'started':
      return 'La partie a déjà démarré et l’hôte n’a pas ouvert de fenêtre de join.';
    case 'closed':
      return 'La fenêtre de join est fermée. Demandez à l’hôte de l’ouvrir à nouveau.';
    case 'invalid-save':
      return 'La sauvegarde reçue est invalide ou ne correspond pas à l’état de l’hôte.';
    case 'timeout':
      return 'Le délai de join est dépassé. Vérifiez la connexion puis réessayez.';
    default:
      return 'Impossible de rejoindre la partie en cours.';
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
        title: 'Préparation du moteur',
        message: state.message || 'Initialisation du moteur pour charger la sauvegarde…',
        tone: 'info',
        progress: 0.05 + engine * 0.25,
      };
    }
    case 'waiting':
      return {
        title: 'En attente de l’hôte',
        message: state.message || 'L’hôte doit autoriser votre arrivée dans la partie.',
        tone: 'warn',
        progress: 0.3,
      };
    case 'requesting':
      return {
        title: 'Connexion à la partie',
        message: state.message || 'Demande de join envoyée à l’hôte…',
        tone: 'info',
        progress: 0.35,
      };
    case 'transfer':
      return {
        title: 'Réception de la sauvegarde',
        message:
          state.message ||
          `Blocs ${state.received}/${state.total || '?'} (${Math.round(ratio * 100)} %)`,
        tone: 'info',
        progress: 0.35 + ratio * 0.5,
      };
    case 'joined':
      return {
        title: 'Partie rejointe',
        message:
          state.message ||
          `État chargé au tick ${state.tick ?? 0}, hash vérifié. Reprise des ticks…`,
        tone: 'ok',
        progress: 0.9,
      };
    case 'rejected':
      return {
        title: 'Join impossible',
        message: state.message || 'Impossible de rejoindre la partie en cours.',
        tone: 'error',
        progress: 1,
      };
    default:
      return {
        title: 'Rejoindre la partie',
        message: state.message || 'Recherche de la partie en cours…',
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
      return { ...base, stage: 'requesting', message: 'Demande de join envoyée à l’hôte…' };
    case 'transfer':
      return {
        ...base,
        stage: 'transfer',
        message: `Réception de la sauvegarde : ${progress.received}/${progress.total || '?'} blocs.`,
      };
    case 'joined':
      return {
        ...base,
        stage: 'joined',
        tone: 'ok',
        message: `Partie rejointe au tick ${progress.tick ?? 0} : hash vérifié, reprise des ticks.`,
      };
    case 'rejected':
      return {
        ...base,
        stage: 'rejected',
        tone: 'error',
        message: previous?.message || 'Join refusé par l’hôte.',
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
      primaryLabel: view.autoAdmit ? 'Fermer aux retardataires' : 'Ouvrir aux retardataires',
      hint: view.outcome.ok
        ? 'La liste des joueurs est à jour, la simulation a repris.'
        : 'La demande a été refusée sans interrompre la partie. Vous pouvez réessayer.',
    };
  }
  if (transfer) {
    return {
      text: `Envoi de la sauvegarde (${transfer.sent}/${transfer.total} blocs) — confirmation en attente…`,
      tone: 'wait',
      active: true,
      pendingCount,
      primaryLabel: 'Annuler le transfert',
      hint: 'La simulation est en pause le temps que le retardataire charge et vérifie le hash.',
    };
  }
  if (serializing) {
    return {
      text: 'Sérialisation de l’état de la partie…',
      tone: 'wait',
      active: true,
      pendingCount,
      primaryLabel: 'Annuler le transfert',
      hint: 'La simulation est brièvement en pause pour produire une sauvegarde exacte.',
    };
  }
  if (reserved) {
    return {
      text: 'Place réservée : attente de la demande de join du pair…',
      tone: 'wait',
      active: true,
      pendingCount,
      primaryLabel: 'Annuler la fenêtre',
      hint: 'Le pair dispose de quelques secondes pour charger la sauvegarde.',
    };
  }
  if (pendingCount > 0) {
    const first = view.pending[0];
    const label = first ? `${first.name} (${age(first.requestedAt)})` : 'un joueur';
    return {
      text: view.autoAdmit
        ? `Admission automatique : ${label}…`
        : `${pendingCount} demande${pendingCount > 1 ? 's' : ''} en attente : ${label}.`,
      tone: view.autoAdmit ? 'wait' : 'info',
      active: false,
      pendingCount,
      primaryLabel: view.autoAdmit ? 'Fermer aux retardataires' : 'Ouvrir aux retardataires',
      hint: view.autoAdmit
        ? 'Chaque joueur qui demande à rejoindre est admis automatiquement.'
        : 'Choisissez « Autoriser » à côté du joueur, ou activez l’admission automatique.',
    };
  }
  return {
    text: view.autoAdmit
      ? 'Ouvert aux retardataires : en attente d’un joueur…'
      : 'Aucune demande de join pour l’instant.',
    tone: view.autoAdmit ? 'wait' : 'info',
    active: false,
    pendingCount: 0,
    primaryLabel: view.autoAdmit ? 'Fermer aux retardataires' : 'Ouvrir aux retardataires',
    hint: view.autoAdmit
      ? 'Les nouveaux joueurs entrent sans validation, après vérification du hash.'
      : 'Un joueur qui ouvre le code du salon verra « Rejoindre la partie en cours ».',
  };
}

/** Compteur de joueurs humains/IA affiché dans le panneau hôte. */
export function playerCountLabel(view: Pick<HostJoinView, 'players'>): string {
  const count = view.players.length;
  return `${count} joueur${count > 1 ? 's' : ''} dans la partie`;
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
