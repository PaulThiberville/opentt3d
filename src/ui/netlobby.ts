/**
 * Helpers de l'UI multijoueur.
 *
 * Ce module ne touche pas au DOM : il traduit les paramètres d'URL, construit
 * les liens d'invitation, mappe le `StartInfo` du salon vers les options du
 * moteur et expose quelques descriptions prêtes pour l'affichage. Il est testé
 * sous Node avec le transport mémoire.
 */

import type { LobbyInfo } from '../net/directory';
import { buildInviteLink, parseInviteLink, type InviteLink } from '../net/lobby';
import {
  LOBBY_CHANNELS,
  LOBBY_PROTOCOL_VERSION,
  isRoomId,
  type LobbySettings,
  type LobbyState,
  type StartInfo,
} from '../net/lobby-types';
import type { Transport, TransportKind } from '../net/transport';
import type { GameSpeed } from '../game/Game';
import type { QualityLevel } from '../render/quality';
import type { NewGameOptions } from './gameOptions';

export type NetworkKind = 'local' | 'trystero';

export interface NetworkParams {
  kind: NetworkKind;
  /** Invitation complète (`?room=…&host=…`), si présente. */
  invite: InviteLink | null;
  /** Code seul, sans hôte : l'annuaire ou le premier état fera foi. */
  roomId: string | null;
  /** Message non bloquant destiné au menu. */
  warning: string | null;
}

export interface JoinTarget {
  roomId: string;
  hostId: string | null;
}

/**
 * Lit `?net=local`, `?room=CODE&host=ID` et `?room=CODE` sans jamais lever :
 * une URL absurde se contente d'un avertissement.
 */
export function readNetworkParams(search: string): NetworkParams {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return {
      kind: 'trystero',
      invite: null,
      roomId: null,
      warning: 'Paramètres d’URL illisibles.',
    };
  }

  const rawNet = (params.get('net') ?? '').trim().toLowerCase();
  let kind: NetworkKind = 'trystero';
  let warning: string | null = null;
  if (rawNet === 'local') kind = 'local';
  else if (rawNet !== '' && rawNet !== 'trystero') {
    warning = `Mode réseau inconnu « ${rawNet} » : Trystero est utilisé.`;
  }

  if (params.has('room') || params.has('host')) {
    const invite = parseInviteLink(search);
    if (invite) return { kind, invite, roomId: invite.roomId, warning };
    const roomId = (params.get('room') ?? '').trim().toLowerCase();
    if (isRoomId(roomId)) {
      return {
        kind,
        invite: null,
        roomId,
        warning: warning ?? 'Lien incomplet : l’identifiant de l’hôte manque.',
      };
    }
    return {
      kind,
      invite: null,
      roomId: null,
      warning: warning ?? 'Lien d’invitation invalide.',
    };
  }

  return { kind, invite: null, roomId: null, warning };
}

/** Accepte `?room=…&host=…`, une URL complète, ou un simple code de salon. */
export function parseJoinTarget(value: string): JoinTarget | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  const invite = parseInviteLink(trimmed);
  if (invite) return { roomId: invite.roomId, hostId: invite.hostId };
  if (isRoomId(trimmed)) return { roomId: trimmed.toLowerCase(), hostId: null };
  return null;
}

/**
 * Lien d'invitation canonique. `buildInviteLink` supprime la query existante :
 * on réinjecte `net=local` pour que l'ouvrir dans un second onglet conserve le
 * transport BroadcastChannel.
 */
export function buildRoomInvite(
  roomId: string,
  hostId: string,
  kind: NetworkKind,
  baseUrl = '',
): string {
  const link = buildInviteLink(roomId, hostId, baseUrl);
  return kind === 'local' ? `${link}&net=local` : link;
}

export function transportKindFor(kind: NetworkKind): TransportKind {
  return kind === 'local' ? 'local' : 'trystero';
}

export interface MappedGameOptions {
  options: NewGameOptions;
  warnings: string[];
}

const DIFFICULTY_TO_ENGINE: Record<LobbySettings['difficulty'], number> = {
  easy: 0,
  normal: 1,
  hard: 2,
};

const CLIMATE_TO_ENGINE: Record<LobbySettings['climate'], NewGameOptions['climate']> = {
  temperate: 'temperate',
  arctic: 'subarctic',
  tropical: 'subtropical',
  toyland: 'toyland',
};

/**
 * Les pairs doivent générer exactement le même monde : seed, taille, climat,
 * difficulté et nombre d'IA viennent tous du `StartInfo`, jamais des réglages
 * locaux. Le mock plafonne les cartes à 512 ; 1024/2048 sont ramenées à 512
 * avec un avertissement visible.
 */
export function mapStartInfoToGameOptions(
  info: Pick<StartInfo, 'seed' | 'settings' | 'players'>,
  quality: QualityLevel,
  startYear = 1950,
): MappedGameOptions {
  const warnings: string[] = [];
  let size: NewGameOptions['size'];
  if (info.settings.mapSize === 512) size = 512;
  else if (info.settings.mapSize === 256) size = 256;
  else {
    size = 512;
    warnings.push(
      `Carte ${info.settings.mapSize}×${info.settings.mapSize} ramenée à 512×512 en mode mock.`,
    );
  }

  const aiCount = info.players.filter((player) => player.ai !== null).length;
  if (aiCount > 3) {
    warnings.push('Le mock limite la partie à trois entreprises IA.');
  }

  return {
    options: {
      seed: info.seed >>> 0,
      size,
      quality,
      difficulty: DIFFICULTY_TO_ENGINE[info.settings.difficulty] as NewGameOptions['difficulty'],
      aiCompanies: Math.min(3, aiCount),
      climate: CLIMATE_TO_ENGINE[info.settings.climate],
      startYear,
    },
    warnings,
  };
}

export const MAP_SIZE_LABELS: Record<LobbySettings['mapSize'], string> = {
  256: '256×256',
  512: '512×512',
  1024: '1024×1024',
  2048: '2048×2048',
};

export const CLIMATE_LABELS: Record<LobbySettings['climate'], string> = {
  temperate: 'Tempéré',
  arctic: 'Arctique',
  tropical: 'Tropical',
  toyland: 'Jouet',
};

export const DIFFICULTY_LABELS: Record<LobbySettings['difficulty'], string> = {
  easy: 'Facile',
  normal: 'Normale',
  hard: 'Difficile',
};

/** L'hôte peut-il démarrer ? Renvoie aussi les joueurs attendus. */
export function lobbyStartReadiness(state: LobbyState): {
  ready: boolean;
  waiting: string[];
} {
  if (state.closed || state.started) return { ready: false, waiting: [] };
  const waiting = state.slots
    .filter((slot) => !slot.isHost && slot.ai === null && (!slot.ready || !slot.connected))
    .map((slot) => slot.name);
  return {
    ready: state.slots.length >= 2 && waiting.length === 0,
    waiting,
  };
}

/** Nom lisible d'un pair à partir de la table `peers` du `StartInfo`. */
export function peerNamesFromStart(
  info: Pick<StartInfo, 'players' | 'peers'>,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const player of info.players) {
    const peer = info.peers[player.player];
    if (peer) names[peer] = player.name;
  }
  return names;
}

export function playerNamesFromStart(info: Pick<StartInfo, 'players'>): Record<number, string> {
  const names: Record<number, string> = {};
  for (const player of info.players) names[player.player] = player.name;
  return names;
}

export interface NetworkStatusInput {
  isHost: boolean;
  tick: number;
  ping: number;
  desyncs: number;
  waiting: boolean;
  waitingFor: string[];
  names: Record<string, string>;
  playersOnline: number;
  lost: boolean;
}

export interface NetworkStatus {
  text: string;
  tone: 'ok' | 'wait' | 'warn' | 'error';
}

function listNames(ids: string[], names: Record<string, string>): string {
  const labels = ids.map((id) => names[id] ?? `pair ${id.slice(0, 6)}`);
  if (labels.length === 0) return 'un pair';
  if (labels.length === 1) return labels[0] ?? 'un pair';
  return `${labels.slice(0, -1).join(', ')} et ${labels[labels.length - 1]}`;
}

/** Texte compact de la pastille réseau du HUD. */
export function describeNetworkStatus(input: NetworkStatusInput): NetworkStatus {
  if (input.lost) {
    return { text: 'Hôte perdu — reconnexion impossible', tone: 'error' };
  }
  if (input.waiting) {
    const who = listNames(input.waitingFor, input.names);
    return {
      text: input.isHost ? `En attente de ${who}…` : 'En attente du tour de l’hôte…',
      tone: 'wait',
    };
  }
  const resyncs = input.desyncs === 0 ? 'aucun resync' : `${input.desyncs} resync`;
  if (input.isHost) {
    return {
      text: `Hôte · tick ${input.tick} · ${input.playersOnline} joueur${input.playersOnline > 1 ? 's' : ''} · ${resyncs}`,
      tone: input.desyncs > 0 ? 'warn' : 'ok',
    };
  }
  const ping = input.ping > 0 ? `ping ${Math.round(input.ping)} ms` : 'ping…';
  return {
    text: `Invité · ${ping} · tick ${input.tick} · ${resyncs}`,
    tone: input.desyncs > 0 ? 'warn' : 'ok',
  };
}

export interface GameSpeedNotice {
  text: string;
  speed: GameSpeed;
}

/** En réseau la vitesse est fixée par l'hôte : l'UI garde le contrôle local. */
export function networkControlsLocked(): GameSpeedNotice {
  return {
    text: 'En réseau, la pause et la vitesse sont verrouillées pour garder tous les pairs synchronisés.',
    speed: 1,
  };
}

export interface DetachableTransport {
  transport: Transport;
  /** Retire tous les handlers enregistrés via cette façade. */
  detach(): void;
  readonly detached: boolean;
}

/**
 * `createLobby` attache ses handlers au transport et n'expose pas de
 * désabonnement. Quand la partie démarre, le même transport passe au lockstep :
 * on remplace donc les abonnements du salon par une façade détachable, sans
 * fermer le transport.
 */
export function detachableTransport(transport: Transport): DetachableTransport {
  const offs: (() => void)[] = [];
  let detached = false;

  const wrapper: Transport = {
    get selfId() {
      return transport.selfId;
    },
    get kind() {
      return transport.kind;
    },
    get roomId() {
      return transport.roomId;
    },
    peers: () => transport.peers(),
    send: (channel, data, target) => transport.send(channel, data, target),
    on: (channel, fn) => {
      const off = transport.on(channel, fn);
      if (!detached) offs.push(off);
      return () => {
        off();
        const index = offs.indexOf(off);
        if (index >= 0) offs.splice(index, 1);
      };
    },
    onPeerJoin: (fn) => {
      const off = transport.onPeerJoin(fn);
      if (!detached) offs.push(off);
      return off;
    },
    onPeerLeave: (fn) => {
      const off = transport.onPeerLeave(fn);
      if (!detached) offs.push(off);
      return off;
    },
    onError: (fn) => {
      const off = transport.onError(fn);
      if (!detached) offs.push(off);
      return off;
    },
    ping: (peerId) => transport.ping(peerId),
    leave: () => transport.leave(),
  };

  return {
    transport: wrapper,
    detach() {
      if (detached) return;
      detached = true;
      for (const off of offs.splice(0)) off();
    },
    get detached() {
      return detached;
    },
  };
}

/**
 * Après le démarrage, le salon n'écoute plus : les retardataires doivent être
 * refusés explicitement (#38 branchera le transfert de sauvegarde). On répond
 * donc encore aux `join` et aux nouvelles présences par un `kick` clair.
 */
export function installStartedGate(
  transport: Transport,
  allowedPeers: Iterable<string>,
  reason = 'La partie a déjà démarré.',
): () => void {
  const allowed = new Set(allowedPeers);
  const reject = (peerId: string): void => {
    if (allowed.has(peerId) || peerId === transport.selfId) return;
    transport.send(LOBBY_CHANNELS.kick, { v: LOBBY_PROTOCOL_VERSION, k: 'kick', reason }, peerId);
  };

  const offJoin = transport.on(LOBBY_CHANNELS.join, (_data, from) => reject(from));
  const offPresence = transport.onPeerJoin((peerId) => reject(peerId));
  return () => {
    offJoin();
    offPresence();
  };
}

/** Vérifie qu'une annonce d'annuaire concerne bien le mode courant. */
export function isJoinableLobby(info: LobbyInfo, selfId: string): boolean {
  return info.status === 'open' && info.players < info.max && info.hostPeerId !== selfId;
}
