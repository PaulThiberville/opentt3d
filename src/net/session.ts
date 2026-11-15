/**
 * Deterministic lockstep session (issues #35 and #37).
 *
 * The host is the only sequencer. Clients send their commands to the host; the
 * host stamps the author from the peer id → player mapping (never from the
 * payload), places the commands in the first turn it has not finalized yet, and
 * broadcasts `turn` messages including empty turns. Every peer executes tick N
 * exactly once and only when turn N is known.
 *
 * The transport only carries small messages (see `types.ts`); the world is
 * never streamed. Every `HASH_INTERVAL` ticks each peer compares its state hash
 * with the host's. On disagreement the host sends a chunked save and the peer
 * reloads it (`onDesync` is fired, `desyncs` is incremented).
 *
 * Wall-clock time (`nowMs`) is used solely for pacing, pings and timeouts: the
 * simulation itself depends only on turns and commands.
 *
 * Late join (issue #38): a peer that missed the initial `start` can be admitted
 * after the game began. The host reserves a seat, serialises the state at the
 * current tick boundary N, pauses the whole simulation while the save travels
 * in chunks, and requires the newcomer to load it and confirm the hash at N.
 * Only then does the host include the peer in turns N and later; the save
 * already covers every tick before N. One transfer is allowed at a time and the
 * window is bounded by `joinTimeoutMs` (15 s by default) so a stuck newcomer
 * cannot freeze the game forever.
 *
 * Robustness (issue #39): liveness is message-driven, not transport-driven.
 * Every peer sends a periodic `hello`; the host declares a silent seat
 * disconnected after `peerTimeoutMs` and pauses the game explicitly (grace
 * window, then automatic resume). A client that stops hearing its host elects
 * the alive peer with the lowest player index; hosting terms make the newest
 * host authoritative and heal a split brain if the old host comes back.
 */

import type { EngineCommand } from '../engine/protocol.js';
import type { Transport } from './transport.js';
import {
  JOIN_CHANNELS,
  JOIN_PROTOCOL_VERSION,
  NET_PROTOCOL_VERSION,
  MAX_SAVE_CHARS,
  MAX_SAVE_CHUNK_CHARS,
  MAX_SAVE_CHUNKS,
  isAckMessage,
  isChatMessage,
  isCmdMessage,
  isEngineCommand,
  isHashMessage,
  isHelloMessage,
  isJoinAcceptMessage,
  isJoinChunkMessage,
  isJoinReadyMessage,
  isJoinRejectMessage,
  isJoinRequestMessage,
  isPeerStateMessage,
  isPlayerId,
  isRecord,
  isResyncMessage,
  isTurnMessage,
  type ChatMessage,
  type Command,
  type HelloMessage,
  type JoinAcceptMessage,
  type JoinChunkMessage,
  type JoinRejectReason,
  type NetMessage,
  type PeerConnectionState,
  type PeerStateMessage,
  type PeerStateReason,
  type SaveChunk,
  type TurnCommand,
  type TurnMessage,
} from './types.js';

/** Simulation tick duration used for pacing (10 ticks per second). */
export const NET_TICK_MS = 100;
/** A hash is exchanged every 50 ticks on both directions. */
export const HASH_INTERVAL = 50;
/** Clients acknowledge their executed tick every 10 ticks. */
export const ACK_INTERVAL = 10;

const DEFAULT_INPUT_DELAY = 3;
const MAX_NORMAL_STEPS = 5;
const CATCHUP_EXTRA = 4;
const LAG_PAUSE_TICKS = 50;
const TURN_HISTORY = 600;
const MAX_TURN_AHEAD = 8192;
const MAX_CMDS_PER_PLAYER_PER_TURN = 64;
const MAX_QUEUE_PER_PLAYER = 512;
const MAX_TURN_COMMANDS = 512;
const MAX_PENDING_COMMANDS = 1024;
const READY_TIMEOUT_MS = 5000;
const PING_EVERY_MS = 1000;
const NEED_AFTER_MS = 2000;
const STALL_NOTICE_MS = 250;
const RESYNC_RETRY_MS = 3000;
const RESYNC_MIN_GAP_MS = 5000;
const LOST_AFTER_MS = 15000;
const MAX_CHAT_CHARS = 300;
/** A join request is retried until the host answers. */
const JOIN_REQUEST_RETRY_MS = 1000;
/** Default lifetime of a join window and of the save transfer. */
const JOIN_TIMEOUT_MS = 15000;
/** Hard protocol cap on player indices (see `isPlayerId`). */
const MAX_PLAYERS = 64;

/** Presence/heartbeat cadence (#39). No timer: driven by `update()`. */
const DEFAULT_HEARTBEAT_MS = 1000;
/** A peer silent for this long is considered disconnected (host side). */
const DEFAULT_PEER_TIMEOUT_MS = 10000;
/** A client silent from its host this long starts a migration election. */
const DEFAULT_HOST_TIMEOUT_MS = 8000;
/** Grace period before the host resumes without an unresponsive peer. */
const DEFAULT_PEER_LOSS_GRACE_MS = 20000;
/** Minimum delay between two election attempts after a host timeout. */
const HOST_ELECT_RETRY_MS = 2000;
/** Sliding window used for the ping-loss ratio shown in the HUD. */
const PING_LOSS_WINDOW_MS = 60000;
/** A `waitForPeers()` call extends the cooperative pause by this much. */
const PEER_LOSS_EXTENSION_MS = 20000;

export interface Runner {
  tick(): number;
  step(commands: Command[]): void;
  hash(): string;
  serialize(): string;
  load(data: string): void;
  /**
   * Optional exact asynchronous snapshot used by the late-join transfer.
   *
   * A `MockEngine` save is only available as a promise: `serialize()` returns
   * the last cached snapshot, which may predate the join frontier tick. When
   * provided, the host pauses the simulation and uses this method so the save
   * and the announced tick always match. Runners without it keep the original
   * synchronous behaviour.
   */
  saveNow?(): Promise<string>;
}

export type PeersMap = Record<number, string> | Map<number, string>;

export interface NetSessionOptions {
  runner: Runner;
  localPlayer: number;
  transport: Transport;
  isHost: boolean;
  hostId?: string;
  peers: PeersMap;
  inputDelay?: number;
  /** Maximum number of human players (late joiners included). Defaults to 64. */
  maxPlayers?: number;
  /** Engine build identifier; a late joiner with a different one is refused. */
  engine?: string;
  /** Display name advertised in join requests (informational). */
  playerName?: string;
  /** Host only: accept join requests without a prior `admitPeer` call. */
  autoAdmit?: boolean;
  /** Lifetime of one join window and of its save transfer, in milliseconds. */
  joinTimeoutMs?: number;
  /**
   * Mapping joueur → entreprise OpenTTD (#99), figé par l'hôte dans le salon.
   * Quand il est fourni, l'hôte refuse toute commande build/vehicle qui cible
   * une autre entreprise que celle du joueur émetteur.
   */
  companies?: Record<number, number>;
  /**
   * Nombre d'entreprises humaines créées (#99), réserves pour retardataires
   * incluses. Un nouveau venu reçoit la première entreprise libre.
   */
  companySeats?: number;
  /** Presence heartbeat cadence, in milliseconds (#39). Defaults to 1 s. */
  heartbeatMs?: number;
  /** Silence after which the host declares a peer disconnected. Defaults to 10 s. */
  peerTimeoutMs?: number;
  /** Silence after which a client starts a host election. Defaults to 8 s. */
  hostTimeoutMs?: number;
  /** How long the host pauses before expelling an unresponsive peer. Defaults to 20 s. */
  peerLossGraceMs?: number;
}

/** Host-side result of `admitPeer`: the seat reserved for the newcomer. */
export interface JoinAdmission {
  peerId: string;
  player: number;
  /** Entreprise attribuée au nouveau venu (#99), si le mapping est actif. */
  company?: number;
}

/** Client-side progress of the late-join handshake. */
export type JoinPhase = 'idle' | 'requesting' | 'transfer' | 'joined' | 'rejected';

/** Chunk-level progress, ready for a join UI. */
export interface JoinProgress {
  phase: JoinPhase;
  received: number;
  total: number;
  /** Assigned player index once known. */
  player?: number;
  /** Save frontier tick once `join-accept` was received. */
  tick?: number;
}

/** Emitted when a join succeeds or is refused, on both sides. */
export interface JoinEvent {
  ok: boolean;
  /** Host side: the peer that joined or was refused. Client side: the host. */
  peerId?: string;
  player?: number;
  /** Entreprise attribuée par l'hôte (#99). */
  company?: number;
  tick?: number;
  reason?: JoinRejectReason;
  message?: string;
}

/** Host-side progress of a reserved seat or an in-flight save transfer. */
export type JoinWindowPhase = 'reserved' | 'serializing' | 'transfer';

export interface JoinWindowStatus {
  peerId: string;
  player: number;
  phase: JoinWindowPhase;
  /** Chunks handed to the transport (`0` before the save is serialized). */
  sent: number;
  /** Total chunks of the transfer (`0` before serialization). */
  total: number;
}

export interface NetUpdate {
  ticks: number;
  waiting: boolean;
  waitingFor: string[];
  desyncs: number;
  /** Why the simulation is waiting (#39), for an explicit HUD message. */
  reason?: NetWaitReason;
}

export type NetWaitReason =
  'ready' | 'join' | 'lag' | 'peer-lost' | 'host-lost' | 'stalled' | 'joining';

/** HUD-facing view of one seat's connection state (#39). */
export interface PeerStateSummary {
  player: number;
  peerId: string;
  state: PeerConnectionState;
}

/** Emitted whenever the host (or a migration) changes a seat's live state. */
export interface PeerStateEvent extends PeerStateSummary {
  reason: PeerStateReason;
  tick: number;
}

/** Cooperative pause opened when a human peer stops answering (#39). */
export interface PeerLossPause {
  players: number[];
  peerIds: string[];
  since: number;
  /** The host resumes without the lost peers at this timestamp. */
  expiresAt: number;
}

/** Transport-level diagnostic surfaced to the HUD (relay/NAT errors…). */
export interface NetNotice {
  level: 'info' | 'warning' | 'error';
  /** Stable code so the UI can translate it. */
  code?: NetNoticeCode;
  /** Already-human-readable detail (transport error, peer name…). */
  detail?: string;
  /** French fallback, used when the UI does not know the code. */
  message: string;
}

export type NetNoticeCode =
  'host-migration' | 'host-unreachable' | 'host-yield' | 'peer-resumed' | 'transport-error';

export interface NetStats {
  ping: number;
  delayTicks: number;
  tick: number;
  desyncs: number;
  isHost: boolean;
  lost: boolean;
  /** Commandes refusées par la validation d'entreprise de l'hôte (#99). */
  rejected: number;
  /** Seats currently connected (self included). */
  peers: number;
  /** Seats the host declared disconnected, still inside the grace window. */
  lostPeers: number;
  /** Ping losses over the last minute, in percent (0..100). */
  loss: number;
  /** Milliseconds since the simulation last made progress (0 while running). */
  turnDelay: number;
  /** Hosting term; increments on every migration (#39). */
  term: number;
}

export interface ChatEvent {
  player: number;
  text: string;
}

export interface NetSession {
  readonly localPlayer: number;
  /** Entreprise contrôlée par ce pair (#99), -1 sans mapping. */
  readonly localCompany: number;
  issue(cmd: EngineCommand): void;
  update(nowMs: number): NetUpdate;
  alpha(nowMs: number): number;
  stats(): NetStats;
  onDesync(fn: () => void): () => void;
  /** Notifies seat connection transitions (timeout, recovery, expulsion). */
  onPeerState(fn: (event: PeerStateEvent) => void): () => void;
  /** Transport diagnostics (relay unreachable, NAT failure…). */
  onNotice(fn: (notice: NetNotice) => void): () => void;
  /** Current host-side cooperative pause, or null. */
  peerLossPause(): PeerLossPause | null;
  /**
   * Host side: stops waiting for lost peers, expels them and resumes the
   * simulation. Returns false when there was nothing to resolve.
   */
  resumeAfterPeerLoss(): boolean;
  /** Host side: extends the grace window by 20 s. */
  waitForPeers(): boolean;
  /** Host side: expels one seat immediately (authoritative leave in a turn). */
  expelPeer(player: number, reason?: PeerStateReason): boolean;
  /** Asks the host for a save and reloads it (client side). */
  requestResync(): void;
  /** Host side: pushes an explicit save (all peers by default). */
  provideSave(data: string, target?: string): void;
  /** Client side: asks to join a game already in progress. */
  requestJoin(hostPeerId: string, playerIndex?: number): boolean;
  /**
   * Host side: reserves a seat and opens a join window for `peerId`. The save is
   * taken and shipped when the peer's `join-request` arrives. Returns null when
   * the room is full or the peer is already seated.
   */
  admitPeer(peerId: string, playerIndex?: number): JoinAdmission | null;
  /** Host side: closes one join window (or all) and refuses pending transfers. */
  closeJoinWindow(peerId?: string): void;
  /**
   * Host side: current reserved seats and save transfers, for the lobby UI.
   * `sent`/`total` describe the chunk count once the save was queued.
   */
  pendingJoins(): JoinWindowStatus[];
  onJoin(fn: (event: JoinEvent) => void): () => void;
  /** Client-side phase of the late-join handshake. */
  joinPhase(): JoinPhase;
  /** Client-side chunk progress of the late-join handshake. */
  joinProgress(): JoinProgress;
  sendChat(text: string): void;
  onChat(fn: (message: ChatEvent) => void): () => void;
  dispose(): void;
}

interface PlayerRecord {
  index: number;
  peerId: string;
  left: boolean;
  connected: boolean;
}

interface QueuedCommand {
  p: number;
  s: number;
  cmd: EngineCommand;
}

interface PendingCommand {
  s: number;
  cmd: EngineCommand;
}

interface SaveAssembly {
  epoch: number;
  tick: number;
  total: number;
  chunks: (string | undefined)[];
  received: number;
  left: number[];
}

/** Host-side join window: a reserved seat, then an in-flight save transfer. */
interface PendingJoin {
  peerId: string;
  player: number;
  /** Entreprise attribuée au retardataire (#99), si le mapping est actif. */
  company?: number;
  /** Set once the save has been serialised and sent. */
  sent: boolean;
  tick: number;
  hash: string;
  id: string;
  total: number;
  /** Kept for the lifetime of the transfer so a duplicate request can resend. */
  save?: string;
  startedAt: number;
  expiresAt: number;
}

/** Client-side assembly of a `join` save (same chunking as `resync`). */
interface JoinAssembly {
  epoch: number;
  tick: number;
  player: number;
  /** Entreprise attribuée par l'hôte (#99). */
  company?: number;
  id: string;
  hash: string;
  total: number;
  chunks: (string | undefined)[];
  received: number;
}

const NO_UPDATE: NetUpdate = Object.freeze({
  ticks: 0,
  waiting: false,
  waitingFor: Object.freeze([]) as unknown as string[],
  desyncs: 0,
});

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizePeers(
  peers: PeersMap,
  selfId: string,
  localPlayer: number,
): {
  players: Map<number, PlayerRecord>;
  peerToPlayer: Map<string, number>;
} {
  const entries: [number, string][] =
    peers instanceof Map
      ? [...peers.entries()]
      : Object.entries(peers).map(([key, value]) => [Number(key), value] as [number, string]);

  const players = new Map<number, PlayerRecord>();
  const peerToPlayer = new Map<string, number>();
  for (const [index, peerId] of entries) {
    if (!Number.isInteger(index) || index < 0 || index > 63) continue;
    if (typeof peerId !== 'string' || peerId.length === 0) continue;
    if (peerToPlayer.has(peerId)) continue;
    players.set(index, { index, peerId, left: false, connected: true });
    peerToPlayer.set(peerId, index);
  }
  // A late joiner may not know its player index yet: `localPlayer` is only a
  // provisional value. Never overwrite a seat already owned by another peer.
  const provisional = players.get(localPlayer);
  if (!provisional) {
    players.set(localPlayer, {
      index: localPlayer,
      peerId: selfId,
      left: false,
      connected: true,
    });
    peerToPlayer.set(selfId, localPlayer);
  } else if (provisional.peerId === selfId) {
    peerToPlayer.set(selfId, localPlayer);
  }
  return { players, peerToPlayer };
}

export function createNetSession(options: NetSessionOptions): NetSession {
  const { runner, transport } = options;
  let localPlayer = options.localPlayer;
  const inputDelay = Number.isFinite(options.inputDelay)
    ? Math.min(32, Math.max(0, Math.floor(options.inputDelay as number)))
    : DEFAULT_INPUT_DELAY;
  const maxPlayers = Number.isFinite(options.maxPlayers)
    ? Math.min(MAX_PLAYERS, Math.max(1, Math.floor(options.maxPlayers as number)))
    : MAX_PLAYERS;
  const engineId = typeof options.engine === 'string' ? options.engine.trim().slice(0, 64) : '';
  const autoAdmit = Boolean(options.autoAdmit);
  const joinTimeoutMs = Number.isFinite(options.joinTimeoutMs)
    ? Math.min(120000, Math.max(1000, Math.floor(options.joinTimeoutMs as number)))
    : JOIN_TIMEOUT_MS;
  const playerName =
    typeof options.playerName === 'string' ? options.playerName.trim().slice(0, 24) : '';

  let amHost = Boolean(options.isHost);
  let hostPeerId: string | undefined;
  let epoch = 0;
  let disposed = false;
  let lost = false;
  let currentNow = 0;
  let lastNow: number | null = null;
  let acc = 0;
  let stallSince: number | null = null;
  let hostLostSince: number | null = null;
  let migrationCandidate: string | undefined;
  let desyncs = 0;
  let ping = 0;
  let lastPingAt = -Infinity;
  let lastHelloAt = -Infinity;
  let lastNeedAt = -Infinity;
  let lastResyncRequestAt = -Infinity;
  let lastRateNoticeAt = -Infinity;
  /** Absolute tick a migrated client must reach without waiting (#39). */
  let catchUpUntil = -1;
  let saveSeq = 0;
  let hostStarted = false;
  let firstUpdateAt: number | null = null;
  let waitingFor: string[] = [];
  let lastAppliedSaveTick = -1;

  // Late join (issue #38)
  let joinPhaseState: JoinPhase = 'idle';
  let joinMode = false;
  let joinHostId: string | undefined;
  let joinAssembly: JoinAssembly | null = null;
  let lastJoinRequestAt = -Infinity;
  let joinDeadline = 0;
  let joinRequestedPlayer: number | undefined;
  let selfMapped = false;

  // Presence + host migration (#39). Purely clock-driven: `update()` is the
  // only place timers would have been needed, so no interval is ever leaked.
  const heartbeatMs = clampInt(options.heartbeatMs, 250, 10000, DEFAULT_HEARTBEAT_MS);
  const peerTimeoutMs = clampInt(options.peerTimeoutMs, 1000, 60000, DEFAULT_PEER_TIMEOUT_MS);
  const hostTimeoutMs = clampInt(options.hostTimeoutMs, 1000, 60000, DEFAULT_HOST_TIMEOUT_MS);
  const peerLossGraceMs = clampInt(
    options.peerLossGraceMs,
    1000,
    120000,
    DEFAULT_PEER_LOSS_GRACE_MS,
  );
  const lastSeenByPeer = new Map<string, number>();
  let lastHostSeen = 0;
  let lastHeartbeatAt = -Infinity;
  let lastElectAt = -Infinity;
  let hostingTerm = 0;
  /** Host we decided to replace; alive only for that election (#39). */
  let failedHostId: string | undefined;
  let peerLoss: { players: Set<number>; since: number; expiresAt: number } | null = null;
  /** Client mirror of the host's cooperative pause (#39). */
  let remotePeerLossAt: number | null = null;
  let waitSince: number | null = null;
  let waitReason: NetWaitReason | undefined;
  let pingSent = 0;
  let pingFailed = 0;
  let pingWindowStart = 0;

  const { players, peerToPlayer } = normalizePeers(options.peers, transport.selfId, localPlayer);
  selfMapped = peerToPlayer.get(transport.selfId) === localPlayer;
  for (const player of players.values()) {
    if (player.peerId !== transport.selfId) lastSeenByPeer.set(player.peerId, currentNow);
  }
  lastHostSeen = currentNow;

  // Mapping joueur → entreprise (#99). Il vient du `StartInfo` figé ; l'hôte
  // refuse une commande qui cible une autre entreprise que celle du joueur.
  const companyByPlayer = new Map<number, number>();
  for (const [key, value] of Object.entries(options.companies ?? {})) {
    const player = Number(key);
    if (isPlayerId(player) && Number.isInteger(value) && value >= 0 && value < 15) {
      companyByPlayer.set(player, value);
    }
  }
  const companySeats = Math.max(0, Math.min(15, Math.trunc(options.companySeats ?? 0)));
  let localCompany = companyByPlayer.get(localPlayer) ?? -1;
  let rejectedCommands = 0;

  /** Première entreprise humaine libre, ou null si tous les sièges sont pris. */
  function allocateCompany(): number | null {
    if (companySeats <= 0) return null;
    const used = new Set(companyByPlayer.values());
    for (let company = 0; company < companySeats; company += 1) {
      if (!used.has(company)) return company;
    }
    return null;
  }

  /** Entreprise attendue pour un joueur (undefined si le mapping est absent). */
  function expectedCompany(player: number): number | undefined {
    return companyByPlayer.get(player);
  }

  function commandCompany(cmd: EngineCommand): number | undefined {
    return cmd.type === 'build' || cmd.type === 'vehicle' ? cmd.company : undefined;
  }

  /**
   * Valide l'entreprise d'une commande. Une commande qui cible l'entreprise
   * d'un autre joueur est rejetée (compteur `rejected`) sans interrompre le
   * lockstep. Les moteurs antérieurs sans mapping restent permissifs.
   */
  function validateCompany(player: number, cmd: EngineCommand): boolean {
    const expected = expectedCompany(player);
    const actual = commandCompany(cmd);
    if (expected === undefined || actual === undefined || expected === actual) return true;
    rejectedCommands += 1;
    return false;
  }

  /** Host: reserved seats / join windows waiting for a `join-request`. */
  const joinWindows = new Map<string, PendingJoin>();
  /** Host: at most one save transfer is in flight (the simulation pauses). */
  const joinTransfers = new Map<string, PendingJoin>();
  /**
   * Host: exact save is being serialized (async runners only). The simulation
   * pauses during this short window so the save and its frontier tick match.
   * The value is the expiry timestamp.
   */
  const joinPreparing = new Map<string, number>();

  const selfRecord = selfMapped ? players.get(localPlayer) : undefined;
  if (amHost) {
    if (selfRecord) selfRecord.connected = true;
    hostPeerId = transport.selfId;
  } else {
    hostPeerId =
      options.hostId ??
      [...players.values()]
        .sort((a, b) => a.index - b.index)
        .find((p) => p.peerId !== transport.selfId)?.peerId;
  }

  // ---- turn state
  let turnsEnd = runner.tick();
  let historyStart = runner.tick();
  const turns = new Map<number, TurnCommand[]>();
  const ownHashes = new Map<number, string>();
  const hostHashes = new Map<number, string>();
  const clientHashes = new Map<string, Map<number, string>>();
  const seenSeq = new Map<number, number>();
  const queuedSeq = new Map<number, number>();
  let hostQueue: QueuedCommand[] = [];
  let outTurns: TurnMessage[] = [];
  const pendingLeaves = new Set<number>();
  const leftPlayers = new Set<number>();
  const ready = new Set<string>();
  const lastAckByPeer = new Map<string, number>();
  const lastSaveAt = new Map<string, number>();
  const saveAssemblies = new Map<string, SaveAssembly>();
  let pending: PendingCommand[] = [];
  let outbox: PendingCommand[] = [];
  let nextCommandSeq = 0;
  let outboxFlushPending = false;

  const desyncHandlers = new Set<() => void>();
  const chatHandlers = new Set<(message: ChatEvent) => void>();
  const joinHandlers = new Set<(event: JoinEvent) => void>();
  const peerStateHandlers = new Set<(event: PeerStateEvent) => void>();
  const noticeHandlers = new Set<(notice: NetNotice) => void>();
  const offs: (() => void)[] = [];

  // ------------------------------------------------------------------ helpers

  function send(channel: string, message: object, target?: string | string[]): void {
    if (disposed) return;
    transport.send(channel, { v: NET_PROTOCOL_VERSION, ...message }, target);
  }

  function playerOf(peerId: string): PlayerRecord | undefined {
    const index = peerToPlayer.get(peerId);
    return index === undefined ? undefined : players.get(index);
  }

  function markedLeft(index: number): boolean {
    return leftPlayers.has(index);
  }

  function markLeft(index: number): void {
    const player = players.get(index);
    if (!player) return;
    player.left = true;
    player.connected = false;
    leftPlayers.add(index);
    ready.delete(player.peerId);
    lastAckByPeer.delete(player.peerId);
    hostQueue = hostQueue.filter((item) => item.p !== index);
  }

  /** Host side: schedules a `leave` command for the next finalized turn. */
  function queueLeave(index: number): void {
    const player = players.get(index);
    if (!player) return;
    player.connected = false;
    ready.delete(player.peerId);
    lastAckByPeer.delete(player.peerId);
    pendingLeaves.add(index);
  }

  function expectedClients(): PlayerRecord[] {
    const result: PlayerRecord[] = [];
    for (const player of players.values()) {
      if (player.peerId === transport.selfId) continue;
      if (player.left || !player.connected) continue;
      if (!transport.peers().includes(player.peerId)) continue;
      result.push(player);
    }
    return result;
  }

  function emitDesync(): void {
    for (const fn of [...desyncHandlers]) {
      try {
        fn();
      } catch (error) {
        console.error('[net:session] onDesync handler error', error);
      }
    }
  }

  function emitChat(message: ChatEvent): void {
    for (const fn of [...chatHandlers]) {
      try {
        fn(message);
      } catch (error) {
        console.error('[net:session] onChat handler error', error);
      }
    }
  }

  function emitJoin(event: JoinEvent): void {
    for (const fn of [...joinHandlers]) {
      try {
        fn(event);
      } catch (error) {
        console.error('[net:session] onJoin handler error', error);
      }
    }
  }

  function emitPeerState(event: PeerStateEvent): void {
    for (const fn of [...peerStateHandlers]) {
      try {
        fn(event);
      } catch (error) {
        console.error('[net:session] onPeerState handler error', error);
      }
    }
  }

  function emitNotice(notice: NetNotice): void {
    for (const fn of [...noticeHandlers]) {
      try {
        fn(notice);
      } catch (error) {
        console.error('[net:session] onNotice handler error', error);
      }
    }
  }

  /** Measures RTT to one peer and updates the HUD loss ratio (#39). */
  function probePing(peerId: string, now: number): void {
    if (now - pingWindowStart > PING_LOSS_WINDOW_MS) {
      pingWindowStart = now;
      pingSent = 0;
      pingFailed = 0;
    }
    pingSent += 1;
    void transport
      .ping(peerId)
      .then((value) => {
        if (disposed) return;
        if (value >= 0) ping = value;
        else pingFailed += 1;
      })
      .catch(() => {
        if (!disposed) pingFailed += 1;
      });
  }

  /** Records any message from `peerId` and closes a pending loss window. */
  function touchPeer(peerId: string): void {
    if (peerId === transport.selfId) return;
    lastSeenByPeer.set(peerId, currentNow);
    if (peerId === hostPeerId) lastHostSeen = currentNow;
    if (!amHost) return;
    const player = playerOf(peerId);
    if (!player || player.left || player.connected) return;
    if (joinWindows.has(peerId) || joinTransfers.has(peerId)) return;
    player.connected = true;
    if (peerLoss) {
      peerLoss.players.delete(player.index);
      if (peerLoss.players.size === 0) peerLoss = null;
    }
    broadcastPeerState(player.index, 'connected', 'reconnected');
    emitPeerState({
      player: player.index,
      peerId,
      state: 'connected',
      reason: 'reconnected',
      tick: runner.tick(),
    });
  }

  function broadcastPeerState(
    player: number,
    state: PeerConnectionState,
    reason: PeerStateReason,
  ): void {
    if (!amHost) return;
    send('peer-state', {
      k: 'peer-state',
      player,
      state,
      reason,
      tick: runner.tick(),
    });
  }

  /** Host: a seat stopped answering; pause explicitly instead of blocking. */
  function markPeerLost(player: PlayerRecord, reason: PeerStateReason): void {
    if (player.left || !player.connected) return;
    player.connected = false;
    ready.delete(player.peerId);
    lastAckByPeer.delete(player.peerId);
    lastSaveAt.delete(player.peerId);
    clientHashes.delete(player.peerId);
    if (joinWindows.has(player.peerId) || joinTransfers.has(player.peerId)) {
      cancelJoin(player.peerId, 'closed', 'Le pair a disparu pendant la fenêtre de join.');
      return;
    }
    if (!peerLoss) {
      peerLoss = {
        players: new Set(),
        since: currentNow,
        expiresAt: currentNow + peerLossGraceMs,
      };
    }
    peerLoss.players.add(player.index);
    peerLoss.expiresAt = Math.max(peerLoss.expiresAt, currentNow + 1000);
    broadcastPeerState(player.index, 'disconnected', reason);
    emitPeerState({
      player: player.index,
      peerId: player.peerId,
      state: 'disconnected',
      reason,
      tick: runner.tick(),
    });
  }

  /** Host: expires peer-loss pauses and recovers a peer that answered again. */
  function checkPeerLoss(now: number): void {
    if (!amHost) return;
    for (const player of players.values()) {
      if (player.peerId === transport.selfId || player.left || !player.connected) continue;
      if (joinWindows.has(player.peerId) || joinTransfers.has(player.peerId)) continue;
      const seen = lastSeenByPeer.get(player.peerId);
      if (seen === undefined) continue;
      if (now - seen > peerTimeoutMs) markPeerLost(player, 'timeout');
    }
    if (peerLoss && now >= peerLoss.expiresAt) {
      resumeAfterPeerLoss();
    }
  }

  function resumeAfterPeerLoss(): boolean {
    if (!amHost || disposed || !peerLoss) return false;
    const indices = [...peerLoss.players].sort((a, b) => a - b);
    peerLoss = null;
    for (const index of indices) {
      const player = players.get(index);
      if (!player || player.left) continue;
      queueLeave(index);
      broadcastPeerState(index, 'left', 'expelled');
      emitPeerState({
        player: index,
        peerId: player.peerId,
        state: 'left',
        reason: 'expelled',
        tick: runner.tick(),
      });
    }
    emitNotice({
      level: 'info',
      code: 'peer-resumed',
      message:
        indices.length > 0
          ? `La partie reprend sans ${indices.length} joueur${indices.length > 1 ? 's' : ''} hors ligne.`
          : 'La partie reprend.',
    });
    return true;
  }

  function waitForPeers(): boolean {
    if (!amHost || disposed || !peerLoss) return false;
    peerLoss.expiresAt = currentNow + PEER_LOSS_EXTENSION_MS;
    return true;
  }

  function expelPeer(player: number, reason: PeerStateReason = 'expelled'): boolean {
    if (!amHost || disposed || !isPlayerId(player)) return false;
    const record = players.get(player);
    if (!record || record.left) return false;
    if (record.connected) markPeerLost(record, reason);
    if (peerLoss) {
      peerLoss.players.delete(player);
      if (peerLoss.players.size === 0) peerLoss = null;
    }
    queueLeave(player);
    broadcastPeerState(player, 'left', reason);
    emitPeerState({
      player,
      peerId: record.peerId,
      state: 'left',
      reason,
      tick: runner.tick(),
    });
    return true;
  }

  function peerLossPause(): PeerLossPause | null {
    if (!peerLoss) return null;
    const playersList: number[] = [];
    const peerIds: string[] = [];
    for (const index of [...peerLoss.players].sort((a, b) => a - b)) {
      const player = players.get(index);
      if (!player || player.left) continue;
      playersList.push(index);
      peerIds.push(player.peerId);
    }
    if (playersList.length === 0) return null;
    return {
      players: playersList,
      peerIds,
      since: peerLoss.since,
      expiresAt: peerLoss.expiresAt,
    };
  }

  /** Alive means: not left, not the failed host, reachable or recently seen. */
  function isPeerAlive(player: PlayerRecord, now: number): boolean {
    if (player.left) return false;
    if (player.peerId === transport.selfId) return true;
    if (failedHostId !== undefined && player.peerId === failedHostId) return false;
    if (transport.peers().includes(player.peerId)) return true;
    if (!player.connected) return false;
    const seen = lastSeenByPeer.get(player.peerId);
    if (seen !== undefined && now - seen <= peerTimeoutMs) return true;
    return false;
  }

  function rememberHash(map: Map<number, string>, tick: number, hash: string): void {
    map.set(tick, hash);
    const oldest = tick - HASH_INTERVAL * 80;
    for (const key of map.keys()) {
      if (key < oldest) map.delete(key);
    }
  }

  // ------------------------------------------------------------------ turns

  function storeTurn(tick: number, commands: TurnCommand[], received: boolean): void {
    if (tick < runner.tick()) return;
    if (turns.has(tick)) return;
    turns.set(tick, commands);

    for (const command of commands) {
      if (command.type === 'leave') {
        markLeft(command.p);
        continue;
      }
      if (command.s !== undefined) {
        const previous = seenSeq.get(command.p) ?? -1;
        if (command.s > previous) seenSeq.set(command.p, command.s);
      }
    }
    if (received) {
      const seen = seenSeq.get(localPlayer) ?? -1;
      if (pending.length > 0 && pending[0] !== undefined && pending[0].s <= seen) {
        pending = pending.filter((item) => item.s > seen);
      }
    }
    while (turns.has(turnsEnd)) turnsEnd++;
  }

  function finalizeTurn(): void {
    const index = turnsEnd;
    const commands: TurnCommand[] = [];

    for (const player of [...pendingLeaves].sort((a, b) => a - b)) {
      if (leftPlayers.has(player)) continue;
      commands.push({ type: 'leave', p: player });
    }
    pendingLeaves.clear();

    const counts = new Map<number, number>();
    const keep: QueuedCommand[] = [];
    for (const queued of hostQueue) {
      if (markedLeft(queued.p)) continue;
      const count = counts.get(queued.p) ?? 0;
      if (commands.length >= MAX_TURN_COMMANDS || count >= MAX_CMDS_PER_PLAYER_PER_TURN) {
        keep.push(queued);
        continue;
      }
      commands.push({ ...queued.cmd, p: queued.p, s: queued.s });
      counts.set(queued.p, count + 1);
    }
    hostQueue = keep;
    // Stable and identical on every peer.
    commands.sort((a, b) => a.p - b.p || (a.s ?? -1) - (b.s ?? -1));

    storeTurn(index, commands, false);
    outTurns.push({
      v: NET_PROTOCOL_VERSION,
      k: 'turn',
      epoch,
      tick: index,
      commands,
      d: inputDelay,
    });
  }

  function execTurn(): void {
    const index = runner.tick();
    const commands = turns.get(index);
    if (!commands) return;
    const forEngine: Command[] = [];
    for (const command of commands) {
      if (command.type === 'leave') continue;
      const rest = { ...command };
      delete (rest as { s?: number }).s;
      forEngine.push(rest);
    }
    runner.step(forEngine);
    const after = runner.tick();
    if (after - TURN_HISTORY > historyStart) {
      for (let old = historyStart; old < after - TURN_HISTORY; old++) turns.delete(old);
      historyStart = after - TURN_HISTORY;
    }
    if (after !== index + 1) {
      // A non monotonic runner would break lockstep: surface it loudly.
      console.warn(
        `[net:session] runner incohérent : tick ${index} exécuté, tick courant ${after}`,
      );
    }

    if (after % HASH_INTERVAL === 0) {
      const hash = runner.hash();
      rememberHash(ownHashes, after, hash);
      if (amHost) {
        send('hash', { k: 'hash', epoch, tick: after, hash });
        checkClientHashes(after, hash);
      } else {
        if (hostPeerId) send('hash', { k: 'hash', epoch, tick: after, hash }, hostPeerId);
        const known = hostHashes.get(after);
        if (known !== undefined && known !== hash) requestResync();
      }
    }
    if (!amHost && after % ACK_INTERVAL === 0 && hostPeerId) {
      send('ack', { k: 'ack', tick: after }, hostPeerId);
    }
  }

  function checkClientHashes(tick: number, hostHash: string): void {
    for (const [peerId, hashes] of clientHashes) {
      const clientHash = hashes.get(tick);
      if (clientHash === undefined) continue;
      if (clientHash !== hostHash) {
        const last = lastSaveAt.get(peerId) ?? -Infinity;
        if (currentNow - last >= RESYNC_MIN_GAP_MS) {
          sendSave(peerId);
        }
      }
    }
  }

  function pruneTurns(): void {
    if (turnsEnd <= historyStart) return;
    for (const key of turns.keys()) {
      if (key < historyStart) turns.delete(key);
    }
  }

  function sendTurnsTo(peerId: string, fromTick: number): void {
    if (!amHost) return;
    if (fromTick < historyStart) {
      sendSave(peerId);
      return;
    }
    const count = turnsEnd - fromTick;
    if (count > TURN_HISTORY) {
      sendSave(peerId);
      return;
    }
    for (let tick = Math.max(fromTick, historyStart); tick < turnsEnd; tick++) {
      const commands = turns.get(tick);
      if (!commands) {
        sendSave(peerId);
        return;
      }
      send('turn', { k: 'turn', epoch, tick, commands, d: inputDelay }, peerId);
    }
  }

  /** Peers that may receive turns right now (pending joiners excluded). */
  function turnTargets(): string[] | undefined {
    if (joinWindows.size === 0 && joinTransfers.size === 0) return undefined;
    const targets: string[] = [];
    for (const player of players.values()) {
      if (player.left || !player.connected) continue;
      if (player.peerId === transport.selfId) continue;
      if (joinWindows.has(player.peerId) || joinTransfers.has(player.peerId)) continue;
      targets.push(player.peerId);
    }
    return targets;
  }

  function flushTurns(): void {
    if (outTurns.length === 0) return;
    const targets = turnTargets();
    for (const turn of outTurns) {
      send('turn', turn, targets);
    }
    outTurns = [];
  }

  // ------------------------------------------------------------------ saves

  function sendSave(target?: string): void {
    if (!amHost || disposed) return;
    const tick = runner.tick();
    let save: string;
    try {
      save = runner.serialize();
    } catch (error) {
      console.error('[net:session] sérialisation impossible', error);
      return;
    }
    if (typeof save !== 'string') return;
    const total = Math.max(1, Math.ceil(save.length / MAX_SAVE_CHUNK_CHARS));
    if (total > MAX_SAVE_CHUNKS) {
      console.error('[net:session] sauvegarde trop volumineuse pour le protocole');
      return;
    }
    epoch += 1;
    const id = `${epoch}-${++saveSeq}`;
    const targets = target ? [target] : undefined;
    for (let index = 0; index < total; index++) {
      const start = index * MAX_SAVE_CHUNK_CHARS;
      send(
        'resync',
        {
          k: 'resync',
          epoch,
          tick,
          save: {
            id,
            index,
            total,
            data: save.slice(start, start + MAX_SAVE_CHUNK_CHARS),
          },
          left: [...leftPlayers],
        },
        targets,
      );
    }
    desyncs += 1;
    if (target) lastSaveAt.set(target, currentNow);
    else for (const peer of transport.peers()) lastSaveAt.set(peer, currentNow);
  }

  function applySave(data: string, newEpoch: number, left: number[]): void {
    try {
      runner.load(data);
    } catch (error) {
      console.error('[net:session] chargement de la sauvegarde impossible', error);
      return;
    }
    if (newEpoch > epoch) epoch = newEpoch;
    for (const index of left) {
      const player = players.get(index);
      if (!player) continue;
      player.left = true;
      player.connected = false;
      leftPlayers.add(index);
    }
    turns.clear();
    historyStart = runner.tick();
    turnsEnd = runner.tick();
    ownHashes.clear();
    hostHashes.clear();
    clientHashes.clear();
    acc = 0;
    stallSince = null;
    lost = false;
    desyncs += 1;
    emitDesync();
    // Commands sent before the save may have been lost with the divergent
    // history: send every still-pending command again; the host deduplicates.
    resendPending();
    lastHelloAt = -Infinity;
  }

  function resendPending(): void {
    if (pending.length === 0 || !hostPeerId) return;
    outbox = pending.slice();
    outboxFlushPending = true;
    flushOwnCommands();
  }

  /** A client becoming host keeps its unconfirmed commands. */
  function requeuePendingForHost(): void {
    const seen = seenSeq.get(localPlayer) ?? -1;
    for (const item of pending) {
      if (item.s <= seen) continue;
      hostQueue.push({ p: localPlayer, s: item.s, cmd: item.cmd });
      queuedSeq.set(localPlayer, item.s);
    }
    pending = [];
    outbox = [];
    outboxFlushPending = false;
  }

  // ------------------------------------------------------------------ late join

  /** Players whose seat is reserved or confirmed (departed seats excluded). */
  function activeSeatCount(): number {
    let count = 0;
    for (const player of players.values()) {
      if (!player.left) count += 1;
    }
    return count;
  }

  function freePlayerIndex(requested?: number): number | null {
    if (requested !== undefined && isPlayerId(requested) && !players.has(requested)) {
      return requested;
    }
    for (let index = 0; index < MAX_PLAYERS; index++) {
      if (!players.has(index)) return index;
    }
    return null;
  }

  function sendJoinReject(
    peerId: string,
    reason: JoinRejectReason,
    message: string,
    tick?: number,
    wireVersion?: number,
  ): void {
    const version =
      wireVersion !== undefined && Number.isInteger(wireVersion) && wireVersion >= 0
        ? wireVersion
        : NET_PROTOCOL_VERSION;
    send(
      JOIN_CHANNELS.reject,
      {
        v: version,
        k: 'join-reject',
        reason,
        message: message.slice(0, 240),
        ...(tick === undefined ? {} : { tick }),
      },
      peerId,
    );
  }

  function rejectJoin(
    peerId: string,
    reason: JoinRejectReason,
    message: string,
    player?: number,
    tick?: number,
    wireVersion?: number,
  ): void {
    sendJoinReject(peerId, reason, message, tick, wireVersion);
    emitJoin({ ok: false, peerId, reason, message, player, tick });
  }

  function removeJoinSeat(pending: PendingJoin): void {
    const record = players.get(pending.player);
    if (record && record.peerId === pending.peerId) players.delete(pending.player);
    if (peerToPlayer.get(pending.peerId) === pending.player) peerToPlayer.delete(pending.peerId);
    joinWindows.delete(pending.peerId);
    joinTransfers.delete(pending.peerId);
  }

  /** Host: refuses a reserved seat or aborts an in-flight transfer. */
  function cancelJoin(peerId: string, reason: JoinRejectReason, message: string): void {
    joinPreparing.delete(peerId);
    const pending = joinTransfers.get(peerId) ?? joinWindows.get(peerId);
    if (!pending) return;
    removeJoinSeat(pending);
    sendJoinReject(peerId, reason, message, pending.sent ? pending.tick : undefined);
    emitJoin({
      ok: false,
      peerId,
      player: pending.player,
      tick: pending.sent ? pending.tick : undefined,
      reason,
      message,
    });
  }

  function openJoinWindow(peerId: string, requested?: number): PendingJoin | null {
    const existing = joinWindows.get(peerId) ?? joinTransfers.get(peerId);
    if (existing) return existing;
    if (peerToPlayer.has(peerId)) return null; // already seated or already left
    if (activeSeatCount() >= maxPlayers) return null;
    const player = freePlayerIndex(requested);
    if (player === null) return null;
    const company = allocateCompany();
    if (companySeats > 0 && company === null) return null; // aucune entreprise libre
    players.set(player, { index: player, peerId, left: false, connected: false });
    peerToPlayer.set(peerId, player);
    if (company !== null) companyByPlayer.set(player, company);
    const pending: PendingJoin = {
      peerId,
      player,
      ...(company === null ? {} : { company }),
      sent: false,
      tick: 0,
      hash: '',
      id: '',
      total: 0,
      startedAt: currentNow,
      expiresAt: currentNow + joinTimeoutMs,
    };
    joinWindows.set(peerId, pending);
    return pending;
  }

  /** Host: (re)sends the accept plan and every chunk of a prepared transfer. */
  function sendJoinPlan(pending: PendingJoin): void {
    const save = pending.save;
    if (save === undefined) return;
    send(
      JOIN_CHANNELS.accept,
      {
        k: 'join-accept',
        epoch,
        tick: pending.tick,
        total: pending.total,
        player: pending.player,
        id: pending.id,
        hash: pending.hash,
        ...(engineId ? { engine: engineId } : {}),
        ...(pending.company === undefined ? {} : { company: pending.company }),
      },
      pending.peerId,
    );
    for (let index = 0; index < pending.total; index++) {
      const start = index * MAX_SAVE_CHUNK_CHARS;
      const chunk: SaveChunk = {
        id: pending.id,
        index,
        total: pending.total,
        data: save.slice(start, start + MAX_SAVE_CHUNK_CHARS),
      };
      send(
        JOIN_CHANNELS.chunk,
        { k: 'join-chunk', epoch, tick: pending.tick, save: chunk },
        pending.peerId,
      );
    }
  }

  /** Host: serialises the state at the current tick and pauses until ready. */
  function startJoinTransfer(pending: PendingJoin): boolean {
    if (joinTransfers.size > 0 && !joinTransfers.has(pending.peerId)) {
      cancelJoin(
        pending.peerId,
        'closed',
        'Un autre joueur est déjà en train de rejoindre la partie.',
      );
      return false;
    }
    if (joinPreparing.size > 0 && !joinPreparing.has(pending.peerId)) {
      cancelJoin(
        pending.peerId,
        'closed',
        'Un autre joueur est déjà en train de rejoindre la partie.',
      );
      return false;
    }
    if (pending.sent) {
      sendJoinPlan(pending);
      return true;
    }
    if (joinPreparing.has(pending.peerId)) return true;

    // Exact asynchronous snapshot (mock engine). The simulation pauses while it
    // runs, so the serialized state and the announced tick stay consistent.
    const saveNow = runner.saveNow;
    if (typeof saveNow === 'function') {
      joinPreparing.set(pending.peerId, currentNow + joinTimeoutMs);
      void saveNow
        .call(runner)
        .then((save) => {
          if (!joinPreparing.delete(pending.peerId) || disposed) return;
          const tick = runner.tick();
          let hash: string;
          try {
            hash = runner.hash();
          } catch (error) {
            console.error('[net:session] join : hash impossible', error);
            cancelJoin(pending.peerId, 'invalid-save', 'L’état de l’hôte ne produit pas de hash.');
            return;
          }
          commitJoinTransfer(pending, save, tick, hash);
        })
        .catch((error: unknown) => {
          joinPreparing.delete(pending.peerId);
          console.error('[net:session] join : sérialisation impossible', error);
          cancelJoin(pending.peerId, 'invalid-save', 'L’hôte ne peut pas sérialiser la partie.');
        });
      return true;
    }

    const tick = runner.tick();
    let save: string;
    let hash: string;
    try {
      save = runner.serialize();
      hash = runner.hash();
    } catch (error) {
      console.error('[net:session] join : sérialisation impossible', error);
      cancelJoin(pending.peerId, 'invalid-save', 'L’hôte ne peut pas sérialiser la partie.');
      return false;
    }
    return commitJoinTransfer(pending, save, tick, hash);
  }

  /** Host: stores a prepared save, opens the transfer and ships the chunks. */
  function commitJoinTransfer(
    pending: PendingJoin,
    save: unknown,
    tick: number,
    hash: string,
  ): boolean {
    if (typeof save !== 'string' || save.length === 0 || typeof hash !== 'string') {
      cancelJoin(pending.peerId, 'invalid-save', 'Sauvegarde d’hôte invalide.');
      return false;
    }
    const total = Math.max(1, Math.ceil(save.length / MAX_SAVE_CHUNK_CHARS));
    if (total > MAX_SAVE_CHUNKS || save.length > MAX_SAVE_CHARS) {
      cancelJoin(
        pending.peerId,
        'invalid-save',
        'La sauvegarde dépasse la taille maximale du protocole de join.',
      );
      return false;
    }

    pending.sent = true;
    pending.tick = tick;
    pending.hash = hash;
    pending.total = total;
    pending.save = save;
    pending.id = `join-${tick}-${++saveSeq}`;
    pending.startedAt = currentNow;
    pending.expiresAt = currentNow + joinTimeoutMs;
    joinWindows.delete(pending.peerId);
    joinTransfers.set(pending.peerId, pending);
    sendJoinPlan(pending);
    return true;
  }

  /** Host: expires idle windows and aborted transfers. */
  function expireJoins(now: number): void {
    for (const [peerId, expiresAt] of [...joinPreparing.entries()]) {
      if (now >= expiresAt) {
        joinPreparing.delete(peerId);
        cancelJoin(peerId, 'timeout', 'La sérialisation de la sauvegarde a expiré.');
      }
    }
    for (const pending of [...joinWindows.values()]) {
      if (now >= pending.expiresAt) {
        cancelJoin(pending.peerId, 'closed', 'La fenêtre de join a expiré.');
      }
    }
    for (const pending of [...joinTransfers.values()]) {
      if (now >= pending.expiresAt) {
        cancelJoin(pending.peerId, 'timeout', 'Le transfert de sauvegarde a expiré.');
      }
    }
  }

  /** Host: receives a late-join request (including incompatible versions). */
  function handleJoinRequest(raw: unknown, from: string): void {
    if (!amHost || disposed || from === transport.selfId) return;
    if (!isRecord(raw) || raw.k !== 'join-request') return;
    if (raw.v !== NET_PROTOCOL_VERSION) {
      rejectJoin(
        from,
        'version',
        'Version de protocole incompatible.',
        undefined,
        undefined,
        typeof raw.v === 'number' ? raw.v : undefined,
      );
      return;
    }
    if (raw.pv !== JOIN_PROTOCOL_VERSION) {
      rejectJoin(from, 'version', 'Version du protocole de join incompatible.');
      return;
    }
    if (!isJoinRequestMessage(raw)) {
      rejectJoin(from, 'version', 'Demande de join invalide.');
      return;
    }
    if (engineId && raw.engine !== engineId) {
      rejectJoin(from, 'version', 'Version du moteur incompatible.');
      return;
    }

    const existing = playerOf(from);
    if (existing && existing.connected && !existing.left) return; // already playing
    if (existing && existing.left) {
      rejectJoin(from, 'closed', 'Ce joueur a déjà quitté la partie.', existing.index);
      return;
    }

    let pending = joinTransfers.get(from) ?? joinWindows.get(from);
    if (!pending) {
      if (activeSeatCount() >= maxPlayers) {
        rejectJoin(from, 'full', 'La partie est complète.');
        return;
      }
      if (!autoAdmit) {
        rejectJoin(
          from,
          hostStarted ? 'started' : 'closed',
          hostStarted
            ? 'La partie a déjà démarré : l’hôte doit ouvrir une fenêtre de join.'
            : 'La partie n’a pas encore démarré.',
        );
        return;
      }
      if (!hostStarted) {
        rejectJoin(from, 'closed', 'La partie n’a pas encore démarré.');
        return;
      }
      pending = openJoinWindow(from, raw.player) ?? undefined;
      if (!pending) {
        rejectJoin(from, 'full', 'La partie est complète.');
        return;
      }
    }

    if (joinTransfers.size > 0 && !joinTransfers.has(from)) {
      cancelJoin(from, 'closed', 'Un autre joueur est déjà en train de rejoindre la partie.');
      return;
    }
    startJoinTransfer(pending);
  }

  /** Host: the newcomer loaded the save and reports its hash at tick N. */
  function handleJoinReady(raw: unknown, from: string): void {
    if (!amHost || disposed) return;
    if (!isJoinReadyMessage(raw)) return;
    const pending = joinTransfers.get(from);
    if (!pending) {
      const player = playerOf(from);
      if (!player || !player.connected) {
        sendJoinReject(from, 'closed', 'Aucun join en cours pour ce pair.');
      }
      return;
    }
    if (raw.ok === false || raw.tick !== pending.tick || raw.hash !== pending.hash) {
      cancelJoin(
        from,
        'invalid-save',
        'La sauvegarde chargée ne correspond pas à l’état de l’hôte.',
      );
      return;
    }
    if (pending.tick < historyStart) {
      cancelJoin(from, 'invalid-save', 'L’historique nécessaire au join a été purgé.');
      return;
    }

    joinTransfers.delete(from);
    joinWindows.delete(from);
    const player = players.get(pending.player);
    if (!player || player.peerId !== from) {
      sendJoinReject(from, 'invalid-save', 'Place de joueur introuvable.', pending.tick);
      return;
    }
    player.left = false;
    player.connected = true;
    ready.add(from);
    lastAckByPeer.set(from, pending.tick);
    clientHashes.delete(from);
    // The new peer must not receive turns before N: the save covers state N.
    sendTurnsTo(from, pending.tick);
    emitJoin({
      ok: true,
      peerId: from,
      player: pending.player,
      ...(pending.company === undefined ? {} : { company: pending.company }),
      tick: pending.tick,
    });
  }

  // ------------------------------------------------------------ client join

  function sendJoinRequest(): void {
    if (disposed || amHost || !joinHostId) return;
    lastJoinRequestAt = currentNow;
    send(
      JOIN_CHANNELS.request,
      {
        k: 'join-request',
        pv: JOIN_PROTOCOL_VERSION,
        ...(joinRequestedPlayer === undefined ? {} : { player: joinRequestedPlayer }),
        ...(playerName ? { name: playerName } : {}),
        ...(engineId ? { engine: engineId } : {}),
      },
      joinHostId,
    );
  }

  function sendJoinReady(ok: boolean, tick: number, hash: string, error?: string): void {
    if (!joinHostId) return;
    send(
      JOIN_CHANNELS.ready,
      {
        k: 'join-ready',
        epoch,
        tick,
        hash,
        ok,
        ...(error ? { error: error.slice(0, 240) } : {}),
      },
      joinHostId,
    );
  }

  function failJoin(reason: JoinRejectReason, message: string, notifyHost: boolean): void {
    joinAssembly = null;
    joinPhaseState = 'rejected';
    if (notifyHost) sendJoinReady(false, runner.tick(), '', message);
    emitJoin({ ok: false, peerId: joinHostId, reason, message });
  }

  /** Adopts the player index assigned by the host, never the requested one. */
  function assignLocalPlayer(index: number): boolean {
    if (!isPlayerId(index)) return false;
    const occupied = players.get(index);
    if (occupied && occupied.peerId !== transport.selfId) return false;
    const previous = players.get(localPlayer);
    if (previous && previous.peerId === transport.selfId && localPlayer !== index) {
      players.delete(localPlayer);
    }
    players.set(index, { index, peerId: transport.selfId, left: false, connected: true });
    peerToPlayer.set(transport.selfId, index);
    localPlayer = index;
    localCompany = companyByPlayer.get(index) ?? localCompany;
    selfMapped = true;
    return true;
  }

  function handleJoinAccept(message: JoinAcceptMessage, from: string): void {
    if (amHost || disposed || !joinMode) return;
    if (from !== joinHostId) return;
    if (joinPhaseState === 'joined' || joinPhaseState === 'rejected') return;
    if (engineId && message.engine !== undefined && message.engine !== engineId) {
      failJoin('version', 'Version du moteur incompatible.', false);
      return;
    }
    if (joinAssembly && joinAssembly.id === message.id && joinAssembly.total === message.total) {
      return; // duplicate accept (retransmission)
    }
    hostPeerId = from;
    joinPhaseState = 'transfer';
    joinDeadline = currentNow + joinTimeoutMs;
    joinAssembly = {
      epoch: message.epoch,
      tick: message.tick,
      player: message.player,
      ...(message.company === undefined ? {} : { company: message.company }),
      id: message.id,
      hash: message.hash,
      total: message.total,
      chunks: new Array<string | undefined>(message.total),
      received: 0,
    };
  }

  function completeJoin(assembly: JoinAssembly, data: string): void {
    let loadError: unknown = null;
    try {
      runner.load(data);
    } catch (error) {
      loadError = error;
    }
    if (loadError !== null) {
      console.error('[net:session] join : sauvegarde illisible', loadError);
      failJoin('invalid-save', 'La sauvegarde reçue est illisible.', true);
      return;
    }
    const loadedTick = runner.tick();
    let hash: string;
    try {
      hash = runner.hash();
    } catch (error) {
      console.error('[net:session] join : hash impossible', error);
      failJoin('invalid-save', 'L’état chargé ne produit pas de hash.', true);
      return;
    }
    if (loadedTick !== assembly.tick || hash !== assembly.hash) {
      failJoin(
        'invalid-save',
        'La sauvegarde chargée ne correspond pas au tick ou au hash annoncés.',
        true,
      );
      return;
    }
    if (!assignLocalPlayer(assembly.player)) {
      failJoin('invalid-save', 'La place attribuée est déjà occupée.', true);
      return;
    }
    if (assembly.company !== undefined) {
      localCompany = assembly.company;
      companyByPlayer.set(localPlayer, assembly.company);
    }

    if (assembly.epoch > epoch) epoch = assembly.epoch;
    turns.clear();
    ownHashes.clear();
    hostHashes.clear();
    clientHashes.clear();
    historyStart = loadedTick;
    turnsEnd = loadedTick;
    acc = 0;
    stallSince = null;
    lost = false;
    lastAppliedSaveTick = Math.max(lastAppliedSaveTick, loadedTick);
    lastHelloAt = currentNow;
    joinAssembly = null;
    joinPhaseState = 'joined';
    // Confirm first: the host only accepts commands once the seat is active.
    sendJoinReady(true, loadedTick, hash);
    // Commands issued while waiting for the save are still relevant.
    resendPending();
    emitJoin({
      ok: true,
      peerId: joinHostId,
      player: localPlayer,
      ...(localCompany < 0 ? {} : { company: localCompany }),
      tick: loadedTick,
    });
  }

  function handleJoinChunk(message: JoinChunkMessage, from: string): void {
    if (amHost || disposed || !joinMode) return;
    if (from !== joinHostId) return;
    if (joinPhaseState !== 'transfer' || !joinAssembly) return;
    const chunk = message.save;
    const assembly = joinAssembly;
    if (
      message.epoch !== assembly.epoch ||
      message.tick !== assembly.tick ||
      chunk.id !== assembly.id ||
      chunk.total !== assembly.total
    ) {
      return; // stale or inconsistent transfer
    }
    if (assembly.chunks[chunk.index] !== undefined) return;
    assembly.chunks[chunk.index] = chunk.data;
    assembly.received += 1;
    if (assembly.received < assembly.total) return;
    const complete = assembly.chunks.every((part): part is string => typeof part === 'string');
    if (!complete) {
      failJoin('invalid-save', 'Le transfert de sauvegarde est incomplet.', true);
      return;
    }
    joinAssembly = null;
    completeJoin(assembly, assembly.chunks.join(''));
  }

  function handleJoinReject(message: unknown, from: string): void {
    if (amHost || disposed || !joinMode) return;
    if (from !== joinHostId) return;
    if (joinPhaseState === 'rejected') return;
    if (!isJoinRejectMessage(message)) return;
    joinAssembly = null;
    joinPhaseState = 'rejected';
    const detail = message.message ?? 'Join refusé par l’hôte.';
    emitJoin({
      ok: false,
      peerId: from,
      reason: message.reason,
      message: detail,
      tick: message.tick,
    });
  }

  function requestJoin(hostId: string, playerIndex?: number): boolean {
    if (disposed || amHost) return false;
    if (typeof hostId !== 'string' || hostId.length === 0) return false;
    if (hostId === transport.selfId) return false;
    if (playerIndex !== undefined && !isPlayerId(playerIndex)) return false;
    if (joinPhaseState === 'joined') return false;
    joinMode = true;
    joinPhaseState = 'requesting';
    joinHostId = hostId;
    hostPeerId = hostId;
    joinRequestedPlayer = playerIndex;
    joinAssembly = null;
    lastJoinRequestAt = -Infinity;
    joinDeadline = currentNow + joinTimeoutMs;
    sendJoinRequest();
    return true;
  }

  function admitPeer(peerId: string, playerIndex?: number): JoinAdmission | null {
    if (!amHost || disposed) return null;
    if (typeof peerId !== 'string' || peerId.length === 0) return null;
    if (peerId === transport.selfId) return null;
    const existing = playerOf(peerId);
    if (existing) {
      if (existing.left) return null;
      const company = companyByPlayer.get(existing.index);
      return {
        peerId,
        player: existing.index,
        ...(company === undefined ? {} : { company }),
      };
    }
    const pending = joinWindows.get(peerId) ?? joinTransfers.get(peerId);
    if (pending) {
      return {
        peerId,
        player: pending.player,
        ...(pending.company === undefined ? {} : { company: pending.company }),
      };
    }
    if (!hostStarted) return null;
    const opened = openJoinWindow(peerId, playerIndex);
    return opened
      ? {
          peerId,
          player: opened.player,
          ...(opened.company === undefined ? {} : { company: opened.company }),
        }
      : null;
  }

  function closeJoinWindow(peerId?: string): void {
    if (!amHost || disposed) return;
    const targets =
      peerId === undefined
        ? [...new Set([...joinWindows.keys(), ...joinTransfers.keys(), ...joinPreparing.keys()])]
        : [peerId];
    for (const target of targets) {
      cancelJoin(target, 'closed', 'La fenêtre de join a été fermée par l’hôte.');
    }
  }

  function pendingJoins(): JoinWindowStatus[] {
    if (!amHost || disposed) return [];
    const result: JoinWindowStatus[] = [];
    for (const peerId of joinPreparing.keys()) {
      result.push({
        peerId,
        player: playerOf(peerId)?.index ?? -1,
        phase: 'serializing',
        sent: 0,
        total: 0,
      });
    }
    for (const pending of joinWindows.values()) {
      result.push({
        peerId: pending.peerId,
        player: pending.player,
        phase: 'reserved',
        sent: 0,
        total: 0,
      });
    }
    for (const pending of joinTransfers.values()) {
      result.push({
        peerId: pending.peerId,
        player: pending.player,
        phase: 'transfer',
        sent: pending.sent ? pending.total : 0,
        total: pending.total,
      });
    }
    return result;
  }

  // ------------------------------------------------------------------ commands

  function issue(cmd: EngineCommand): void {
    if (disposed) return;
    if (!isEngineCommand(cmd)) {
      throw new TypeError('Commande invalide : elle doit respecter le contrat moteur.');
    }
    if (players.get(localPlayer)?.left) return;
    if (!validateCompany(localPlayer, cmd)) {
      console.warn(
        `[net:session] commande refusée : entreprise ${commandCompany(cmd)} au lieu de ${expectedCompany(localPlayer)} pour le joueur ${localPlayer}.`,
      );
      return;
    }
    const s = ++nextCommandSeq;
    if (amHost) {
      const queued = hostQueue.filter((item) => item.p === localPlayer).length;
      if (queued >= MAX_QUEUE_PER_PLAYER) return;
      hostQueue.push({ p: localPlayer, s, cmd });
      return;
    }
    if (pending.length >= MAX_PENDING_COMMANDS) return;
    pending.push({ s, cmd });
    outbox.push({ s, cmd });
    outboxFlushPending = true;
  }

  function flushOwnCommands(): void {
    if (amHost || disposed || !hostPeerId) return;
    if (!outboxFlushPending || outbox.length === 0) return;
    const batch = outbox.slice(0, 64).map((item) => ({ s: item.s, c: item.cmd }));
    outbox = outbox.slice(batch.length);
    send('cmd', { k: 'cmd', b: batch }, hostPeerId);
    if (outbox.length === 0) outboxFlushPending = false;
  }

  function acceptClientCommands(from: string, b: { s: number; c: EngineCommand }[]): void {
    const player = playerOf(from);
    if (!player || player.left || !player.connected) return;
    let queued = hostQueue.filter((item) => item.p === player.index).length;
    for (const entry of b) {
      const last = Math.max(queuedSeq.get(player.index) ?? -1, seenSeq.get(player.index) ?? -1);
      if (entry.s <= last) continue;
      if (queued >= MAX_QUEUE_PER_PLAYER) break;
      if (!validateCompany(player.index, entry.c)) continue;
      hostQueue.push({ p: player.index, s: entry.s, cmd: entry.c });
      queuedSeq.set(player.index, entry.s);
      queued++;
    }
  }

  // ------------------------------------------------------------------ hello / host

  function sendHello(target?: string): void {
    if (disposed) return;
    // A late joiner has no authoritative player index until `join-accept`.
    if (!amHost && !selfMapped) return;
    lastHelloAt = currentNow;
    send(
      'hello',
      {
        k: 'hello',
        player: localPlayer,
        tick: runner.tick(),
        host: amHost,
        epoch,
        d: inputDelay,
        term: hostingTerm,
      },
      target,
    );
  }

  function onHello(message: HelloMessage, from: string): void {
    const player = playerOf(from);
    if (!player) return;
    if (message.player !== player.index) return; // mapping is authoritative
    if (message.host && from !== transport.selfId) lastHostSeen = currentNow;

    if (amHost) {
      const incomingTerm = message.term ?? 0;
      if (
        message.host &&
        from !== transport.selfId &&
        (incomingTerm > hostingTerm || (incomingTerm === hostingTerm && player.index < localPlayer))
      ) {
        // Split-brain healing: a peer elected after our own timeout advertises
        // a newer hosting term (or the same term with a lower deterministic
        // index). Step down instead of keeping two sequencers.
        stepDown(from, incomingTerm, message.tick);
        return;
      }
      // A reserved seat is not playing yet: only `join-request`/`join-ready`
      // can confirm the handshake and unblock its turns.
      if (joinWindows.has(from) || joinTransfers.has(from)) return;
      ready.add(from);
      if (!lastAckByPeer.has(from)) lastAckByPeer.set(from, message.tick);
      if (!message.reply) {
        send(
          'hello',
          {
            k: 'hello',
            player: localPlayer,
            tick: runner.tick(),
            host: true,
            epoch,
            d: inputDelay,
            term: hostingTerm,
            reply: true,
          },
          from,
        );
      }
      if (message.tick < turnsEnd) sendTurnsTo(from, message.tick);
      return;
    }

    if (!message.host) return;
    // While joining, the join handshake is the only authority: ignore hello.
    if (joinMode && joinPhaseState !== 'joined') return;
    if (from === hostPeerId && hostLostSince === null) {
      // A heartbeat also tells a lagging client where the host frontier is
      // (typically after a migration or a resync): close the gap deterministically.
      if (message.tick > runner.tick()) catchUpUntil = Math.max(catchUpUntil, message.tick);
      return;
    }
    const incomingTerm = message.term ?? 0;
    if (hostLostSince !== null || hostPeerId === undefined || incomingTerm > hostingTerm) {
      adoptHost(from, incomingTerm, message.tick);
    }
  }

  /** Client: accepts a (new) host and resets the local turn window. */
  function adoptHost(peerId: string, term: number, hostTick: number): void {
    hostPeerId = peerId;
    hostingTerm = Math.max(hostingTerm, term);
    migrationCandidate = undefined;
    failedHostId = undefined;
    hostLostSince = null;
    lost = false;
    lastHostSeen = currentNow;
    turns.clear();
    historyStart = runner.tick();
    turnsEnd = runner.tick();
    acc = 0;
    stallSince = null;
    waitSince = null;
    remotePeerLossAt = null;
    catchUpUntil = Math.max(catchUpUntil, hostTick);
    sendHello(peerId);
    outbox = pending.slice();
    outboxFlushPending = outbox.length > 0;
    if (hostTick !== runner.tick()) {
      // The new host may be behind or ahead: reload its exact state instead of
      // silently diverging on the next turns.
      lastResyncRequestAt = -Infinity;
      requestResync();
    }
  }

  /** A former host yields to the newly elected one (higher hosting term). */
  function stepDown(peerId: string, term: number, hostTick: number): void {
    amHost = false;
    hostingTerm = Math.max(hostingTerm, term);
    hostPeerId = peerId;
    migrationCandidate = undefined;
    hostLostSince = null;
    lost = false;
    peerLoss = null;
    joinWindows.clear();
    joinTransfers.clear();
    joinPreparing.clear();
    outTurns = [];
    // Keep the local player's unconfirmed actions when yielding: they were
    // meant for the shared history and can still be replayed to the new host.
    const ownQueued = hostQueue.filter((item) => item.p === localPlayer);
    hostQueue = [];
    for (const item of ownQueued) {
      if (!pending.some((entry) => entry.s === item.s)) {
        pending.push({ s: item.s, cmd: item.cmd });
      }
    }
    adoptHost(peerId, term, hostTick);
    emitNotice({
      level: 'info',
      code: 'host-yield',
      message: 'Un autre pair a repris l’hébergement de la partie.',
    });
  }

  function electHost(): void {
    const alive: PlayerRecord[] = [];
    for (const player of players.values()) {
      if (isPeerAlive(player, currentNow)) alive.push(player);
    }
    alive.sort((a, b) => a.index - b.index);
    const candidate = alive[0];
    if (!candidate) {
      migrationCandidate = undefined;
      lost = true;
      return;
    }
    if (candidate.index === localPlayer) {
      becomeHost();
      return;
    }
    migrationCandidate = candidate.peerId;
    hostPeerId = candidate.peerId;
    hostLostSince = null;
    outbox = pending.slice();
    outboxFlushPending = outbox.length > 0;
    sendHello(candidate.peerId);
  }

  function becomeHost(): void {
    if (amHost) return;
    const previousHostIndex = hostPeerId ? peerToPlayer.get(hostPeerId) : undefined;
    amHost = true;
    hostPeerId = transport.selfId;
    failedHostId = undefined;
    hostingTerm += 1;
    migrationCandidate = undefined;
    hostLostSince = null;
    lost = false;
    lastHostSeen = currentNow;
    lastHeartbeatAt = currentNow;
    // Every peer must answer after a migration: hello inference cannot rely on
    // the previous host's ready set.
    for (const [peerId] of [...lastSeenByPeer]) lastSeenByPeer.set(peerId, currentNow);
    lastSeenByPeer.set(transport.selfId, currentNow);
    peerLoss = null;
    joinWindows.clear();
    joinTransfers.clear();
    joinPreparing.clear();
    if (joinMode && joinPhaseState !== 'joined') {
      joinAssembly = null;
      joinPhaseState = 'rejected';
    }
    ready.clear();
    lastAckByPeer.clear();
    hostQueue = [];
    queuedSeq.clear();
    requeuePendingForHost();
    outTurns = [];
    hostStarted = true;
    // New epoch: any save produced by the previous host is stale.
    epoch += 1;
    turnsEnd = Math.max(turnsEnd, runner.tick());
    historyStart = Math.max(0, Math.min(historyStart, runner.tick()));
    if (previousHostIndex !== undefined) {
      queueLeave(previousHostIndex);
      broadcastPeerState(previousHostIndex, 'disconnected', 'timeout');
      const previous = players.get(previousHostIndex);
      if (previous) {
        emitPeerState({
          player: previousHostIndex,
          peerId: previous.peerId,
          state: 'disconnected',
          reason: 'timeout',
          tick: runner.tick(),
        });
      }
    }
    for (const peer of transport.peers()) {
      ready.add(peer);
      lastAckByPeer.set(peer, runner.tick());
    }
    sendHello();
    emitNotice({
      level: 'info',
      code: 'host-migration',
      message: 'L’hôte a disparu : ce pair reprend la partie et devient le nouvel hôte.',
    });
  }

  function onPeerLeave(peerId: string): void {
    const player = playerOf(peerId);
    if (player) player.connected = false;
    lastSeenByPeer.delete(peerId);
    if (amHost) {
      if (joinWindows.has(peerId) || joinTransfers.has(peerId)) {
        cancelJoin(peerId, 'closed', 'Le pair a quitté pendant la fenêtre de join.');
        return;
      }
      if (player && !player.left) {
        if (peerLoss) {
          peerLoss.players.delete(player.index);
          if (peerLoss.players.size === 0) peerLoss = null;
        }
        queueLeave(player.index);
        broadcastPeerState(player.index, 'left', 'transport');
        emitPeerState({
          player: player.index,
          peerId,
          state: 'left',
          reason: 'transport',
          tick: runner.tick(),
        });
      }
      ready.delete(peerId);
      lastAckByPeer.delete(peerId);
      lastSaveAt.delete(peerId);
      clientHashes.delete(peerId);
      return;
    }
    if (peerId === hostPeerId) {
      hostLostSince = currentNow;
      failedHostId = peerId;
      if (player) player.connected = false;
      lastElectAt = -Infinity;
      electHost();
    }
  }

  function onPeerJoin(peerId: string): void {
    lastSeenByPeer.set(peerId, currentNow);
    if (amHost) {
      if (joinWindows.has(peerId) || joinTransfers.has(peerId)) return;
      const player = playerOf(peerId);
      if (player && !player.left) {
        player.connected = true;
        lastAckByPeer.set(peerId, runner.tick());
        sendHello(peerId);
      }
    } else if (!hostPeerId || peerId === migrationCandidate) {
      sendHello(peerId);
    }
  }

  // ------------------------------------------------------------------ messages

  function onTurn(message: TurnMessage, from: string): void {
    if (amHost) return;
    if (joinMode && joinPhaseState !== 'joined') return;
    if (from !== hostPeerId) return;
    if (message.tick < runner.tick()) return;
    if (message.tick > runner.tick() + MAX_TURN_AHEAD) return;
    if (message.commands.length > MAX_TURN_COMMANDS) return;
    storeTurn(message.tick, message.commands, true);
    lost = false;
    if (hostLostSince !== null) hostLostSince = null;
    pruneTurns();
  }

  function onHash(message: NetMessage, from: string): void {
    if (!isHashMessage(message)) return;
    if (amHost) {
      const player = playerOf(from);
      if (!player || player.left) return;
      let hashes = clientHashes.get(from);
      if (!hashes) {
        hashes = new Map();
        clientHashes.set(from, hashes);
      }
      rememberHash(hashes, message.tick, message.hash);
      const mine = ownHashes.get(message.tick);
      if (mine !== undefined && mine !== message.hash) {
        const last = lastSaveAt.get(from) ?? -Infinity;
        if (currentNow - last >= RESYNC_MIN_GAP_MS) sendSave(from);
      }
      return;
    }
    if (from !== hostPeerId) return;
    if (joinMode && joinPhaseState !== 'joined') return;
    rememberHash(hostHashes, message.tick, message.hash);
    const mine = ownHashes.get(message.tick);
    if (mine !== undefined && mine !== message.hash) requestResync();
  }

  function onResync(message: NetMessage, from: string): void {
    if (!isResyncMessage(message)) return;
    if (amHost) {
      if (message.request) {
        const last = lastSaveAt.get(from) ?? -Infinity;
        if (currentNow - last >= 500) sendSave(from);
      }
      return;
    }
    if (from !== hostPeerId) return;
    if (joinMode && joinPhaseState !== 'joined') return;
    if (message.request || !message.save) return;
    const chunk = message.save;
    if (chunk.total > MAX_SAVE_CHUNKS) return;
    const key = `${message.epoch}:${chunk.id}`;
    let assembly = saveAssemblies.get(key);
    if (!assembly || assembly.total !== chunk.total) {
      assembly = {
        epoch: message.epoch,
        tick: message.tick,
        total: chunk.total,
        chunks: new Array<string | undefined>(chunk.total),
        received: 0,
        left: message.left ? [...message.left] : [],
      };
      saveAssemblies.set(key, assembly);
    }
    if (assembly.chunks[chunk.index] !== undefined) return;
    assembly.chunks[chunk.index] = chunk.data;
    assembly.received += 1;
    if (assembly.received < assembly.total) return;
    const complete = assembly.chunks.every((part): part is string => typeof part === 'string');
    saveAssemblies.clear();
    if (!complete) return;
    if (assembly.tick < lastAppliedSaveTick) return;
    lastAppliedSaveTick = assembly.tick;
    applySave(assembly.chunks.join(''), message.epoch, assembly.left);
  }

  function handlePeerStateMessage(message: PeerStateMessage, from: string): void {
    if (amHost || disposed) return;
    if (from !== hostPeerId) return;
    if (joinMode && joinPhaseState !== 'joined') return;
    const player = players.get(message.player);
    if (!player) return;
    if (message.state === 'left') {
      markLeft(message.player);
      remotePeerLossAt = null;
    } else {
      player.connected = message.state === 'connected';
      if (!player.connected) {
        ready.delete(player.peerId);
        lastAckByPeer.delete(player.peerId);
        remotePeerLossAt = currentNow;
      } else {
        remotePeerLossAt = null;
      }
    }
    emitPeerState({
      player: message.player,
      peerId: player.peerId,
      state: message.state,
      reason: message.reason,
      tick: message.tick ?? runner.tick(),
    });
  }

  function handleChatMessage(message: ChatMessage, from: string): void {
    if (!isChatMessage(message)) return;
    const player = playerOf(from);
    if (!player) return;
    if (amHost) {
      // Restamp from the authoritative mapping before relaying.
      send('chat', { k: 'chat', player: player.index, text: message.text });
      emitChat({ player: player.index, text: message.text });
    } else if (from === hostPeerId) {
      emitChat({ player: message.player, text: message.text });
    }
  }

  function requestResync(): void {
    if (disposed || amHost || !hostPeerId) return;
    if (joinMode && joinPhaseState !== 'joined') return;
    if (currentNow - lastResyncRequestAt < RESYNC_RETRY_MS) return;
    lastResyncRequestAt = currentNow;
    send('resync', { k: 'resync', epoch, tick: runner.tick(), request: true }, hostPeerId);
  }

  // ------------------------------------------------------------------ handlers

  /** Every inbound message proves the sender is alive (#39). */
  function listen(channel: string, fn: (data: unknown, from: string) => void): void {
    offs.push(
      transport.on(channel, (data, from) => {
        touchPeer(from);
        fn(data, from);
      }),
    );
  }

  listen('hello', (data, from) => {
    if (!isHelloMessage(data)) return;
    onHello(data, from);
  });
  listen('cmd', (data, from) => {
    if (amHost && isCmdMessage(data)) acceptClientCommands(from, data.b);
  });
  listen('turn', (data, from) => {
    if (isTurnMessage(data)) onTurn(data, from);
  });
  listen('hash', (data, from) => {
    onHash(data as NetMessage, from);
  });
  listen('ack', (data, from) => {
    if (amHost && isAckMessage(data)) {
      const player = playerOf(from);
      if (!player || player.left) return;
      const previous = lastAckByPeer.get(from) ?? 0;
      if (data.tick > previous) lastAckByPeer.set(from, data.tick);
    }
  });
  listen('resync', (data, from) => {
    onResync(data as NetMessage, from);
  });
  listen('chat', (data, from) => {
    if (isChatMessage(data)) handleChatMessage(data, from);
  });
  listen('leave', (data, from) => {
    if (typeof data === 'object' && data !== null) {
      const player = playerOf(from);
      if (player) player.connected = false;
    }
  });
  listen('peer-state', (data, from) => {
    if (isPeerStateMessage(data)) handlePeerStateMessage(data, from);
  });
  listen(JOIN_CHANNELS.request, (data, from) => {
    handleJoinRequest(data, from);
  });
  listen(JOIN_CHANNELS.accept, (data, from) => {
    if (isJoinAcceptMessage(data)) handleJoinAccept(data, from);
  });
  listen(JOIN_CHANNELS.chunk, (data, from) => {
    if (isJoinChunkMessage(data)) handleJoinChunk(data, from);
  });
  listen(JOIN_CHANNELS.ready, (data, from) => {
    handleJoinReady(data, from);
  });
  listen(JOIN_CHANNELS.reject, (data, from) => {
    handleJoinReject(data, from);
  });
  offs.push(transport.onPeerJoin(onPeerJoin));
  offs.push(transport.onPeerLeave(onPeerLeave));
  offs.push(
    transport.onError((message) => {
      const now = currentNow;
      if (now - lastRateNoticeAt < 2000) return;
      lastRateNoticeAt = now;
      console.warn(`[net:session] ${message}`);
      emitNotice({ level: 'warning', code: 'transport-error', detail: message, message });
    }),
  );

  // Initial presence. The host waits for these hellos before starting.
  if (!amHost) {
    sendHello(hostPeerId);
  }

  // ------------------------------------------------------------------ update

  function updateHost(now: number, dt: number): NetUpdate {
    if (firstUpdateAt === null) firstUpdateAt = now;
    if (now - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = now;
      // Host heartbeat: clients use it to detect a silent host even when the
      // simulation is paused and no turn is flowing.
      sendHello();
    }
    expireJoins(now);
    checkPeerLoss(now);
    if (now - lastPingAt >= PING_EVERY_MS) {
      lastPingAt = now;
      for (const player of expectedClients()) probePing(player.peerId, now);
    }
    if (joinTransfers.size > 0 || joinPreparing.size > 0) {
      // Simple, deterministic policy: a join pauses the whole simulation. The
      // state is serialised at the current tick N; no turn is executed or sent
      // until the newcomer has confirmed the hash at N (or the window expires).
      acc = 0;
      waitingFor = [...joinPreparing.keys(), ...joinTransfers.keys()];
      if (waitSince === null) waitSince = now;
      waitReason = 'join';
      return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs, reason: 'join' };
    }
    const pause = peerLossPause();
    if (pause) {
      // A human peer stopped answering: freeze explicitly and let the host
      // decide (continue without it, wait, or expel). The grace window bounds
      // the automatic block, so a party can never hang forever.
      acc = 0;
      waitingFor = pause.peerIds;
      if (waitSince === null) waitSince = now;
      waitReason = 'peer-lost';
      flushTurns();
      return {
        ticks: 0,
        waiting: true,
        waitingFor: [...waitingFor],
        desyncs,
        reason: 'peer-lost',
      };
    }
    const expected = expectedClients();
    if (!hostStarted) {
      const missing = expected.filter((player) => !ready.has(player.peerId));
      if (missing.length > 0 && now - firstUpdateAt < READY_TIMEOUT_MS) {
        waitingFor = missing.map((player) => player.peerId);
        acc = 0;
        flushTurns();
        if (waitSince === null) waitSince = now;
        waitReason = 'ready';
        return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs, reason: 'ready' };
      }
      hostStarted = true;
      for (const player of expected) {
        if (!lastAckByPeer.has(player.peerId)) {
          lastAckByPeer.set(player.peerId, runner.tick());
        }
      }
    }

    const tick = runner.tick();
    const laggers = expected.filter((player) => {
      const ack = lastAckByPeer.get(player.peerId);
      if (ack === undefined) return false;
      return tick - ack > LAG_PAUSE_TICKS;
    });
    if (laggers.length > 0) {
      waitingFor = laggers.map((player) => player.peerId);
      acc = Math.min(acc, NET_TICK_MS);
      flushTurns();
      if (waitSince === null) waitSince = now;
      waitReason = 'lag';
      return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs, reason: 'lag' };
    }
    if (waitingFor.length > 0) waitingFor = [];

    acc = Math.min(acc + dt, NET_TICK_MS * MAX_NORMAL_STEPS);
    let ticks = 0;
    let extra = 0;
    while (ticks < MAX_NORMAL_STEPS + CATCHUP_EXTRA) {
      const index = runner.tick();
      while (turnsEnd <= index + inputDelay) finalizeTurn();
      if (!turns.has(index)) break;
      const canStep = acc >= NET_TICK_MS;
      const catchingUp =
        turnsEnd - index > inputDelay + 1 && ticks >= MAX_NORMAL_STEPS && extra < CATCHUP_EXTRA;
      if (!canStep && !catchingUp) break;
      if (canStep) acc -= NET_TICK_MS;
      else extra += 1;
      execTurn();
      ticks += 1;
      if (disposed) break;
    }
    if (acc >= NET_TICK_MS) acc %= NET_TICK_MS;
    if (ticks > 0) {
      waitSince = null;
      waitReason = undefined;
    }
    flushTurns();
    return { ticks, waiting: false, waitingFor: [], desyncs };
  }

  function updateClient(now: number, dt: number): NetUpdate {
    if (joinMode && joinPhaseState !== 'joined') {
      if (
        (joinPhaseState === 'requesting' || joinPhaseState === 'transfer') &&
        now - lastJoinRequestAt >= JOIN_REQUEST_RETRY_MS
      ) {
        // A retry makes the host resend its plan if chunks were lost.
        sendJoinRequest();
      }
      if (
        (joinPhaseState === 'requesting' || joinPhaseState === 'transfer') &&
        now >= joinDeadline
      ) {
        failJoin('timeout', 'Le délai de join est dépassé.', false);
      }
      const waiting = joinPhaseState === 'requesting' || joinPhaseState === 'transfer';
      waitingFor = waiting && joinHostId ? [joinHostId] : [];
      if (waiting && waitSince === null) waitSince = now;
      if (!waiting) waitSince = null;
      waitReason = waiting ? 'joining' : undefined;
      return {
        ticks: 0,
        waiting,
        waitingFor: [...waitingFor],
        desyncs,
        ...(waiting ? { reason: 'joining' as const } : {}),
      };
    }

    flushOwnCommands();

    if (now - lastHelloAt >= heartbeatMs) {
      sendHello(hostPeerId);
    }

    // Host heartbeat timeout: the transport may keep a dead WebRTC channel
    // listed for a long time, so liveness is decided by messages, not by
    // `onPeerLeave`. A deterministic election (lowest alive player index) then
    // takes over without freezing the remaining peers.
    if (hostPeerId && hostPeerId !== transport.selfId) {
      if (now - lastHostSeen > hostTimeoutMs && hostLostSince === null) {
        hostLostSince = now;
        failedHostId = hostPeerId;
        const hostRecord = playerOf(hostPeerId);
        if (hostRecord) hostRecord.connected = false;
        emitNotice({
          level: 'warning',
          code: 'host-unreachable',
          message: 'L’hôte ne répond plus : recherche d’un nouveau pair pour reprendre la partie…',
        });
      }
    }
    if (hostLostSince !== null && now - lastElectAt >= HOST_ELECT_RETRY_MS) {
      lastElectAt = now;
      electHost();
    }

    if (!hostPeerId || hostLostSince !== null) {
      if (hostLostSince === null) hostLostSince = now;
      if (hostLostSince !== null && now - hostLostSince > LOST_AFTER_MS) lost = true;
      waitingFor = migrationCandidate ? [migrationCandidate] : [];
      if (waitSince === null) waitSince = now;
      waitReason = 'host-lost';
      return {
        ticks: 0,
        waiting: true,
        waitingFor: [...waitingFor],
        desyncs,
        reason: 'host-lost',
      };
    }

    if (remotePeerLossAt !== null) {
      // The host explicitly paused because a peer stopped answering: every
      // client freezes too, otherwise peers would drift ahead of the host and
      // ignore the turns finalized after the resume.
      waitingFor = [];
      if (waitSince === null) waitSince = now;
      waitReason = 'peer-lost';
      return {
        ticks: 0,
        waiting: true,
        waitingFor: [],
        desyncs,
        reason: 'peer-lost',
      };
    }

    if (now - lastPingAt >= PING_EVERY_MS) {
      lastPingAt = now;
      probePing(hostPeerId, now);
    }

    acc = Math.min(acc + dt, NET_TICK_MS * (MAX_NORMAL_STEPS + CATCHUP_EXTRA));
    let ticks = 0;
    let extra = 0;
    let stalled = false;
    for (;;) {
      if (disposed || amHost) break;
      const index = runner.tick();
      if (!turns.has(index)) {
        stalled = true;
        break;
      }
      const canStep = acc >= NET_TICK_MS;
      const behindTarget = index < catchUpUntil;
      const catchingUp =
        behindTarget || (turnsEnd - index > inputDelay + 1 && extra < CATCHUP_EXTRA);
      if (!canStep && !catchingUp) break;
      if (canStep) acc -= NET_TICK_MS;
      else if (!behindTarget) extra += 1;
      execTurn();
      if (runner.tick() >= catchUpUntil) catchUpUntil = -1;
      ticks += 1;
      if (ticks >= MAX_NORMAL_STEPS + CATCHUP_EXTRA) break;
    }

    // Un client qui suit exactement la frontière exécute des ticks à chaque
    // mise à jour puis s'arrête faute du tour suivant : ce n'est pas un stall.
    // Seule une absence totale de progrès doit déclencher hello/resync.
    if (ticks > 0) {
      stallSince = null;
      waitSince = null;
      waitReason = undefined;
      remotePeerLossAt = null;
    }
    if (stalled) {
      acc = Math.min(acc, NET_TICK_MS);
      if (stallSince === null) stallSince = now;
      else if (now - stallSince >= NEED_AFTER_MS && now - lastNeedAt >= NEED_AFTER_MS) {
        lastNeedAt = now;
        sendHello(hostPeerId);
        if (now - stallSince >= NEED_AFTER_MS * 2) requestResync();
      }
    } else {
      stallSince = null;
    }

    const waiting = stalled && stallSince !== null && now - stallSince >= STALL_NOTICE_MS;
    waitingFor = waiting && hostPeerId ? [hostPeerId] : [];
    if (waiting) {
      if (waitSince === null) waitSince = now;
      waitReason = remotePeerLossAt !== null ? 'peer-lost' : 'stalled';
    } else if (waitReason === 'stalled' || waitReason === 'peer-lost') {
      waitSince = null;
      waitReason = undefined;
    }
    return {
      ticks,
      waiting,
      waitingFor: [...waitingFor],
      desyncs,
      ...(waiting ? { reason: waitReason } : {}),
    };
  }

  function update(nowMs: number): NetUpdate {
    if (disposed) return { ...NO_UPDATE, desyncs };
    currentNow = Number.isFinite(nowMs) ? nowMs : currentNow;
    const previous = lastNow;
    const firstUpdate = previous === null;
    const dt = previous === null ? 0 : Math.min(1000, Math.max(0, currentNow - previous));
    lastNow = currentNow;
    if (firstUpdate) {
      // Absolute clocks (`performance.now()`) do not start at zero: presence
      // bookkeeping must start at the first update, not at construction.
      lastHostSeen = currentNow;
      lastHeartbeatAt = currentNow - heartbeatMs;
      for (const peerId of [...lastSeenByPeer.keys()]) {
        lastSeenByPeer.set(peerId, currentNow);
      }
    }

    if (amHost) return updateHost(currentNow, dt);
    return updateClient(currentNow, dt);
  }

  function alpha(nowMs: number): number {
    if (disposed || lost) return 0;
    if (lastNow === null) return 0;
    const elapsed = Math.max(0, (Number.isFinite(nowMs) ? nowMs : lastNow) - lastNow);
    return clamp01((acc + elapsed) / NET_TICK_MS);
  }

  function stats(): NetStats {
    let peers = 0;
    let lostPeers = 0;
    for (const player of players.values()) {
      if (player.left) continue;
      if (player.connected) peers += 1;
      else lostPeers += 1;
    }
    const loss = pingSent > 0 ? Math.min(100, Math.round((pingFailed / pingSent) * 100)) : 0;
    const turnDelay = waitSince === null ? 0 : Math.max(0, Math.round(currentNow - waitSince));
    return {
      ping,
      delayTicks: inputDelay,
      tick: runner.tick(),
      desyncs,
      isHost: amHost,
      lost,
      rejected: rejectedCommands,
      peers,
      lostPeers,
      loss,
      turnDelay,
      term: hostingTerm,
    };
  }

  function sendChat(text: string): void {
    if (disposed) return;
    const clean = typeof text === 'string' ? text.trim().slice(0, MAX_CHAT_CHARS) : '';
    if (!clean) return;
    if (amHost) {
      send('chat', { k: 'chat', player: localPlayer, text: clean });
      emitChat({ player: localPlayer, text: clean });
      return;
    }
    if (hostPeerId) {
      send('chat', { k: 'chat', player: localPlayer, text: clean }, hostPeerId);
    }
  }

  function onDesync(fn: () => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    desyncHandlers.add(fn);
    return () => {
      desyncHandlers.delete(fn);
    };
  }

  function onChat(fn: (message: ChatEvent) => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    chatHandlers.add(fn);
    return () => {
      chatHandlers.delete(fn);
    };
  }

  function onPeerState(fn: (event: PeerStateEvent) => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    peerStateHandlers.add(fn);
    return () => {
      peerStateHandlers.delete(fn);
    };
  }

  function onNotice(fn: (notice: NetNotice) => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    noticeHandlers.add(fn);
    return () => {
      noticeHandlers.delete(fn);
    };
  }

  function onJoin(fn: (event: JoinEvent) => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    joinHandlers.add(fn);
    return () => {
      joinHandlers.delete(fn);
    };
  }

  function joinPhase(): JoinPhase {
    return joinPhaseState;
  }

  function joinProgress(): JoinProgress {
    const progress: JoinProgress = {
      phase: joinPhaseState,
      received: joinAssembly?.received ?? 0,
      total: joinAssembly?.total ?? 0,
    };
    if (selfMapped) progress.player = localPlayer;
    if (joinAssembly) progress.tick = joinAssembly.tick;
    return progress;
  }

  function provideSave(data: string, target?: string): void {
    if (disposed || !amHost || typeof data !== 'string') return;
    const total = Math.max(1, Math.ceil(data.length / MAX_SAVE_CHUNK_CHARS));
    if (total > MAX_SAVE_CHUNKS) return;
    epoch += 1;
    const id = `${epoch}-${++saveSeq}`;
    const tick = runner.tick();
    for (let index = 0; index < total; index++) {
      send(
        'resync',
        {
          k: 'resync',
          epoch,
          tick,
          save: {
            id,
            index,
            total,
            data: data.slice(index * MAX_SAVE_CHUNK_CHARS, (index + 1) * MAX_SAVE_CHUNK_CHARS),
          },
          left: [...leftPlayers],
        },
        target,
      );
    }
  }

  function dispose(): void {
    if (disposed) return;
    if (!amHost) send('leave', { k: 'leave', player: localPlayer });
    disposed = true;
    for (const off of offs) off();
    offs.length = 0;
    desyncHandlers.clear();
    chatHandlers.clear();
    joinHandlers.clear();
    peerStateHandlers.clear();
    noticeHandlers.clear();
    saveAssemblies.clear();
    joinWindows.clear();
    joinTransfers.clear();
    joinPreparing.clear();
    joinAssembly = null;
    peerLoss = null;
    lastSeenByPeer.clear();
    transport.leave();
  }

  return {
    get localPlayer() {
      return localPlayer;
    },
    get localCompany() {
      return localCompany;
    },
    issue,
    update,
    alpha,
    stats,
    onDesync,
    onPeerState,
    onNotice,
    peerLossPause,
    resumeAfterPeerLoss,
    waitForPeers,
    expelPeer,
    requestResync,
    provideSave,
    requestJoin,
    admitPeer,
    closeJoinWindow,
    pendingJoins,
    onJoin,
    joinPhase,
    joinProgress,
    sendChat,
    onChat,
    dispose,
  };
}
