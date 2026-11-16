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
  MAX_START_COMPANIES,
  isRoomId,
  type LobbyEngine,
  type LobbySettings,
  type LobbyState,
  type StartInfo,
  type StartPayload,
  type StartPlayer,
} from '../net/lobby-types';
import type { Transport, TransportKind } from '../net/transport';
import type { NetWaitReason } from '../net/session';
import { engineBuildId } from '../engine/loadEngine';
import type { CompanyProfile } from '../engine/protocol';
import type { GameSpeed } from '../game/Game';
import type { QualityLevel } from '../render/quality';
import { t, tn } from './i18n';
import type { NewGameOptions } from './gameOptions';
import { parseRelayUrls } from './settings';

export type NetworkKind = 'local' | 'trystero';

export interface NetworkParams {
  kind: NetworkKind;
  /** Invitation complète (`?room=…&host=…`), si présente. */
  invite: InviteLink | null;
  /** Code seul, sans hôte : l'annuaire ou le premier état fera foi. */
  roomId: string | null;
  /** Relais Nostr explicites (`?relays=wss://…`) ; vide = défauts Trystero. */
  relays: string[];
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
      relays: [],
      warning: t('net.params.unreadable'),
    };
  }

  const rawNet = (params.get('net') ?? '').trim().toLowerCase();
  let kind: NetworkKind = 'trystero';
  let warning: string | null = null;
  if (rawNet === 'local') kind = 'local';
  else if (rawNet !== '' && rawNet !== 'trystero') {
    warning = t('net.params.unknownMode', { mode: rawNet });
  }

  const rawRelays = params.get('relays');
  const relays = parseRelayUrls(rawRelays ?? '');
  if (rawRelays && relays.length === 0) {
    warning = `${warning ? `${warning} ` : ''}${t('net.params.relaysIgnored')}`;
  }

  if (params.has('room') || params.has('host')) {
    const invite = parseInviteLink(search);
    if (invite) return { kind, invite, roomId: invite.roomId, relays, warning };
    const roomId = (params.get('room') ?? '').trim().toLowerCase();
    if (isRoomId(roomId)) {
      return {
        kind,
        invite: null,
        roomId,
        relays,
        warning: warning ?? t('net.params.incomplete'),
      };
    }
    return {
      kind,
      invite: null,
      roomId: null,
      relays,
      warning: warning ?? t('net.params.invalid'),
    };
  }

  return { kind, invite: null, roomId: null, relays, warning };
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

/** Joueurs humains d'un payload, triés par index (ordre des entreprises). */
function humanPlayers(players: readonly StartPlayer[]): StartPlayer[] {
  return players.filter((player) => player.ai === null).sort((a, b) => a.player - b.player);
}

/** Les payloads antérieurs à #99 n'ont aucun mapping d'entreprise. */
export function hasCompanyMapping(info: Pick<StartPayload, 'players'>): boolean {
  return info.players.some((player) => player.company !== undefined);
}

/** Nombre d'entreprises humaines créées, réserves pour retardataires incluses. */
export function companySeatsForStart(info: Pick<StartPayload, 'players' | 'companySeats'>): number {
  const humans = humanPlayers(info.players);
  const highestCompany = humans.reduce(
    (max, player) => Math.max(max, (player.company ?? -1) + 1),
    0,
  );
  const fallback = Math.max(humans.length, highestCompany);
  const seats = info.companySeats ?? fallback;
  return Math.max(0, Math.min(MAX_START_COMPANIES, seats));
}

/** Entreprise contrôlée par un joueur, d'après le mapping figé du salon. */
export function companyForPlayer(
  info: Pick<StartPayload, 'players'>,
  player: number,
): number | undefined {
  return info.players.find((entry) => entry.player === player)?.company;
}

/** Entreprise du joueur local (mapping du salon, sinon première entreprise). */
export function localCompanyForStart(
  info: Pick<StartPayload, 'players'> & { localPlayer: number; localCompany?: number },
): number | undefined {
  return info.localCompany ?? companyForPlayer(info, info.localPlayer);
}

/**
 * Profils des entreprises humaines à créer au démarrage (#99).
 *
 * Les sièges sans joueur (réserves pour les retardataires) reçoivent un nom et
 * une couleur stables, dérivés de la configuration du salon : tous les pairs
 * construisent exactement la même liste. Renvoie `[]` pour les payloads #93
 * sans mapping, afin de conserver l'entreprise locale unique historique.
 */
export function companyProfilesFromStart(
  info: Pick<StartPayload, 'players' | 'companySeats'>,
): CompanyProfile[] {
  if (!hasCompanyMapping(info)) return [];
  const seats = companySeatsForStart(info);
  const humans = humanPlayers(info.players);
  const usedColours = new Set<number>();
  for (const player of humans) {
    if (player.company !== undefined && player.company < seats) usedColours.add(player.colour);
  }
  const profiles: CompanyProfile[] = [];
  for (let company = 0; company < seats; company += 1) {
    const player = humans.find((entry) => entry.company === company);
    if (player) {
      profiles.push({
        name: player.companyName.trim() || `${player.name} Transport`,
        colour: player.colour,
      });
      continue;
    }
    let colour = 0;
    while (colour < 16 && usedColours.has(colour)) colour += 1;
    usedColours.add(colour);
    profiles.push({
      name: `Entreprise ${company + 1} (réserve)`,
      colour: colour % 16,
    });
  }
  return profiles;
}

/** Première entreprise humaine libre, pour un joueur qui rejoint en cours. */
export function freeCompanyForPayload(
  payload: Pick<StartPayload, 'players' | 'companySeats'>,
): number | undefined {
  const seats = companySeatsForStart(payload);
  const used = new Set<number>();
  for (const player of payload.players) {
    if (player.company !== undefined) used.add(player.company);
  }
  for (let company = 0; company < seats; company += 1) {
    if (!used.has(company)) return company;
  }
  return undefined;
}

/**
 * Les pairs doivent générer exactement le même monde : seed, taille, climat,
 * difficulté et nombre d'IA viennent tous du `StartInfo`, jamais des réglages
 * locaux. Le mock plafonne les cartes à 512 et les IA à trois ; le WASM accepte
 * davantage d'IA. Les cartes du salon au-delà de 512 sont ramenées à 512 sur
 * tous les pairs, car le contrat `NewGameOptions` de l'interface n'expose que
 * 128/256/512.
 */
export function mapStartInfoToGameOptions(
  info: Pick<StartInfo, 'seed' | 'settings' | 'players' | 'companySeats'>,
  quality: QualityLevel,
  startYear = 1950,
): MappedGameOptions {
  const warnings: string[] = [];
  const wasm = info.settings.engine === 'wasm';
  let size: NewGameOptions['size'];
  if (info.settings.mapSize === 512) {
    size = 512;
  } else if (info.settings.mapSize === 256) {
    size = 256;
  } else {
    // L'interface de partie n'expose que 128/256/512. Les grandes cartes du
    // salon sont ramenées à 512 partout : c'est le seul moyen de garantir la
    // même configuration sur tous les pairs sans modifier le contrat UI.
    size = 512;
    warnings.push(
      t('net.params.mapClamped', {
        size: info.settings.mapSize,
        mode: t(wasm ? 'net.params.modeWasm' : 'net.params.modeMock'),
      }),
    );
  }

  const aiCount = info.players.filter((player) => player.ai !== null).length;
  if (!wasm && aiCount > 3) {
    warnings.push(t('net.params.mockAI'));
  }
  const companies = companyProfilesFromStart(info);

  return {
    options: {
      seed: info.seed >>> 0,
      size,
      quality,
      difficulty: DIFFICULTY_TO_ENGINE[info.settings.difficulty] as NewGameOptions['difficulty'],
      aiCompanies: wasm ? aiCount : Math.min(3, aiCount),
      climate: CLIMATE_TO_ENGINE[info.settings.climate],
      startYear,
      disasters: false,
      ...(companies.length > 0 ? { companies } : {}),
    },
    warnings,
  };
}

export interface NetworkEnginePlan {
  mode: LobbyEngine;
  /** Identifiant de build annoncé par le salon. */
  build: string;
  /** Message bloquant quand le mode ou la version d'artefacts diffère. */
  error: string | null;
}

/**
 * Vérifie que le build moteur annoncé correspond au mode figé dans le salon.
 * C'est la garde explicite contre un mélange mock/WASM ou deux versions
 * d'artefacts : sans elle, les pairs divergeraient au premier tick. Le
 * chargement des artefacts reste fait par `GameSession` (erreur dédiée si le
 * WASM est absent).
 */
export function planNetworkEngine(
  info: Pick<StartInfo, 'settings' | 'engineBuild'>,
): NetworkEnginePlan {
  const mode = info.settings.engine;
  const expected = engineBuildId(mode);
  if (info.engineBuild !== expected) {
    return {
      mode,
      build: info.engineBuild,
      error: t('net.params.engineMismatch', {
        actual: info.engineBuild || t('net.params.unknownBuild'),
        expected,
        mode,
      }),
    };
  }
  return { mode, build: expected, error: null };
}

export const MAP_SIZE_LABELS: Record<LobbySettings['mapSize'], string> = {
  256: '256×256',
  512: '512×512',
  1024: '1024×1024',
  2048: '2048×2048',
};

export function engineLabel(engine: LobbyEngine): string {
  return t(engine === 'wasm' ? 'lobby.engine.wasm' : 'lobby.engine.mock');
}

export function climateLabel(climate: LobbySettings['climate']): string {
  return t(CLIMATE_KEYS[climate]);
}

export function difficultyLabel(difficulty: LobbySettings['difficulty']): string {
  return t(DIFFICULTY_KEYS[difficulty]);
}

const CLIMATE_KEYS: Record<
  LobbySettings['climate'],
  'climate.temperate' | 'climate.subarctic' | 'climate.subtropical' | 'climate.toyland'
> = {
  temperate: 'climate.temperate',
  arctic: 'climate.subarctic',
  tropical: 'climate.subtropical',
  toyland: 'climate.toyland',
};

const DIFFICULTY_KEYS: Record<
  LobbySettings['difficulty'],
  'difficulty.easy' | 'difficulty.normal' | 'difficulty.hard'
> = {
  easy: 'difficulty.easy',
  normal: 'difficulty.normal',
  hard: 'difficulty.hard',
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
  /** Why the simulation waits (#39), when known. */
  reason?: NetWaitReason;
  /** Connected seats, self included (#39). */
  peers?: number;
  /** Ping-loss ratio over the last minute, 0..100 (#39). */
  loss?: number;
  /** Milliseconds since the last executed turn (#39). */
  turnDelay?: number;
  /** Current hosting term (#39). */
  term?: number;
}

export interface NetworkStatus {
  text: string;
  tone: 'ok' | 'wait' | 'warn' | 'error';
}

function listNames(ids: string[], names: Record<string, string>): string {
  const labels = ids.map((id) => names[id] ?? t('net.pair', { id: id.slice(0, 6) }));
  if (labels.length === 0) return t('net.pairUnknown');
  if (labels.length === 1) return labels[0] ?? t('net.pairUnknown');
  return `${labels.slice(0, -1).join(', ')} ${t('net.listAnd')} ${labels[labels.length - 1]}`;
}

function resyncLabel(desyncs: number): string {
  return desyncs === 0
    ? t('net.status.resyncNone')
    : tn(desyncs, 'net.status.resyncOne', 'net.status.resyncOther', { count: desyncs });
}

function peerLabel(count: number): string {
  return tn(count, 'net.status.peerOne', 'net.status.peerOther', { count });
}

function pingLabel(ping: number): string {
  return ping > 0 ? t('net.status.ping', { value: Math.round(ping) }) : t('net.status.pingPending');
}

function lossLabel(loss: number): string {
  return t('net.status.loss', { value: Math.max(0, Math.min(100, Math.round(loss))) });
}

function delayLabel(turnDelay: number): string {
  const seconds = Math.max(0, Math.round((turnDelay / 1000) * 10) / 10);
  return t('net.status.delay', { value: seconds });
}

/** Texte compact de la pastille réseau du HUD (#39 : RTT, perte, retard, pairs). */
export function describeNetworkStatus(input: NetworkStatusInput): NetworkStatus {
  if (input.lost) {
    return { text: t('net.status.lost'), tone: 'error' };
  }
  const peers = input.peers ?? input.playersOnline;
  const metrics = [
    pingLabel(input.ping),
    lossLabel(input.loss ?? 0),
    delayLabel(input.turnDelay ?? 0),
  ].join(' · ');
  if (input.waiting) {
    const who = listNames(input.waitingFor, input.names);
    switch (input.reason) {
      case 'peer-lost':
        return { text: t('net.status.peerLost', { who }), tone: 'warn' };
      case 'host-lost':
        return { text: t('net.status.hostLost'), tone: 'error' };
      case 'joining':
      case 'join':
        return { text: t('net.status.join', { who }), tone: 'wait' };
      case 'ready':
      case 'lag':
        return { text: t('net.status.waitingHost', { who }), tone: 'wait' };
      default:
        return {
          text: input.isHost ? t('net.status.waitingHost', { who }) : t('net.status.waitingTurn'),
          tone: 'wait',
        };
    }
  }
  if (input.isHost) {
    return {
      text: t('net.status.host', {
        tick: input.tick,
        peers: peerLabel(peers),
        metrics,
        resync: resyncLabel(input.desyncs),
      }),
      tone: input.desyncs > 0 || (input.loss ?? 0) > 0 ? 'warn' : 'ok',
    };
  }
  return {
    text: t('net.status.guest', {
      tick: input.tick,
      peers: peerLabel(peers),
      metrics,
      resync: resyncLabel(input.desyncs),
    }),
    tone: input.desyncs > 0 || (input.loss ?? 0) > 0 ? 'warn' : 'ok',
  };
}

/** Explicit HUD banner shown while the host waits for a lost peer (#39). */
export interface NetworkAlertAction {
  label: string;
  primary?: boolean;
  onSelect: () => void;
}

export interface NetworkAlertView {
  title: string;
  detail: string;
  tone: 'wait' | 'warn';
  actions: NetworkAlertAction[];
}

export interface PeerLossAlertInput {
  isHost: boolean;
  names: Record<string, string>;
  peerIds: string[];
  seconds: number;
  onContinue?: () => void;
  onWait?: () => void;
}

export function describePeerLossAlert(input: PeerLossAlertInput): NetworkAlertView {
  const resolved = listNames(input.peerIds, input.names);
  const detail = input.isHost
    ? t('net.alert.hostDetail', { who: resolved, seconds: input.seconds })
    : t('net.alert.guestDetail', { who: resolved, seconds: input.seconds });
  const actions: NetworkAlertAction[] = [];
  if (input.isHost && input.onContinue) {
    actions.push({ label: t('net.alert.continue'), primary: true, onSelect: input.onContinue });
  }
  if (input.isHost && input.onWait) {
    actions.push({ label: t('net.alert.wait'), onSelect: input.onWait });
  }
  return { title: t('net.alert.title'), detail, tone: 'warn', actions };
}

export interface GameSpeedNotice {
  text: string;
  speed: GameSpeed;
}

/** En réseau la vitesse est fixée par l'hôte : l'UI garde le contrôle local. */
export function networkControlsLocked(): GameSpeedNotice {
  return {
    text: t('net.controlsLocked'),
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
  reason = t('lobby.reason.started'),
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
