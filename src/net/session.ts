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
const READY_RESEND_MS = 1000;
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
}

export interface NetStats {
  ping: number;
  delayTicks: number;
  tick: number;
  desyncs: number;
  isHost: boolean;
  lost: boolean;
  /** Commandes refusées par la validation d'entreprise de l'hôte (#99). */
  rejected: number;
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

  const { players, peerToPlayer } = normalizePeers(options.peers, transport.selfId, localPlayer);
  selfMapped = peerToPlayer.get(transport.selfId) === localPlayer;

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
      },
      target,
    );
  }

  function onHello(message: HelloMessage, from: string): void {
    const player = playerOf(from);
    if (!player) return;
    if (message.player !== player.index) return; // mapping is authoritative

    if (amHost) {
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
    if (from === hostPeerId) return;
    if (hostLostSince !== null || hostPeerId === undefined) {
      // Host migration: accept the peer that took over.
      hostPeerId = from;
      migrationCandidate = undefined;
      hostLostSince = null;
      lost = false;
      turns.clear();
      historyStart = runner.tick();
      turnsEnd = runner.tick();
      acc = 0;
      stallSince = null;
      sendHello(from);
      outbox = pending.slice();
      outboxFlushPending = outbox.length > 0;
    }
  }

  function electHost(): void {
    const alive: PlayerRecord[] = [];
    for (const player of players.values()) {
      if (player.left) continue;
      if (player.peerId === transport.selfId) {
        alive.push(player);
        continue;
      }
      if (player.connected && transport.peers().includes(player.peerId)) alive.push(player);
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
    outbox = pending.slice();
    outboxFlushPending = outbox.length > 0;
    sendHello(candidate.peerId);
  }

  function becomeHost(): void {
    const previousHostIndex = hostPeerId ? peerToPlayer.get(hostPeerId) : undefined;
    amHost = true;
    hostPeerId = transport.selfId;
    migrationCandidate = undefined;
    hostLostSince = null;
    lost = false;
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
    turnsEnd = Math.max(turnsEnd, runner.tick());
    historyStart = Math.max(0, Math.min(historyStart, runner.tick()));
    if (previousHostIndex !== undefined) queueLeave(previousHostIndex);
    for (const peer of transport.peers()) {
      ready.add(peer);
      lastAckByPeer.set(peer, runner.tick());
    }
    sendHello();
  }

  function onPeerLeave(peerId: string): void {
    const player = playerOf(peerId);
    if (player) player.connected = false;
    if (amHost) {
      if (joinWindows.has(peerId) || joinTransfers.has(peerId)) {
        cancelJoin(peerId, 'closed', 'Le pair a quitté pendant la fenêtre de join.');
        return;
      }
      if (player) {
        queueLeave(player.index);
      }
      ready.delete(peerId);
      lastAckByPeer.delete(peerId);
      lastSaveAt.delete(peerId);
      return;
    }
    if (peerId === hostPeerId) {
      hostLostSince = currentNow;
      electHost();
    }
  }

  function onPeerJoin(peerId: string): void {
    if (amHost) {
      if (joinWindows.has(peerId) || joinTransfers.has(peerId)) return;
      const player = playerOf(peerId);
      if (player && !player.left) {
        player.connected = true;
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

  offs.push(
    transport.on('hello', (data, from) => {
      if (!isHelloMessage(data)) return;
      onHello(data, from);
    }),
  );
  offs.push(
    transport.on('cmd', (data, from) => {
      if (amHost && isCmdMessage(data)) acceptClientCommands(from, data.b);
    }),
  );
  offs.push(
    transport.on('turn', (data, from) => {
      if (isTurnMessage(data)) onTurn(data, from);
    }),
  );
  offs.push(
    transport.on('hash', (data, from) => {
      onHash(data as NetMessage, from);
    }),
  );
  offs.push(
    transport.on('ack', (data, from) => {
      if (amHost && isAckMessage(data)) {
        const player = playerOf(from);
        if (!player || player.left) return;
        const previous = lastAckByPeer.get(from) ?? 0;
        if (data.tick > previous) lastAckByPeer.set(from, data.tick);
      }
    }),
  );
  offs.push(
    transport.on('resync', (data, from) => {
      onResync(data as NetMessage, from);
    }),
  );
  offs.push(
    transport.on('chat', (data, from) => {
      if (isChatMessage(data)) handleChatMessage(data, from);
    }),
  );
  offs.push(
    transport.on('leave', (data, from) => {
      if (typeof data === 'object' && data !== null) {
        const player = playerOf(from);
        if (player) player.connected = false;
      }
    }),
  );
  offs.push(
    transport.on(JOIN_CHANNELS.request, (data, from) => {
      handleJoinRequest(data, from);
    }),
  );
  offs.push(
    transport.on(JOIN_CHANNELS.accept, (data, from) => {
      if (isJoinAcceptMessage(data)) handleJoinAccept(data, from);
    }),
  );
  offs.push(
    transport.on(JOIN_CHANNELS.chunk, (data, from) => {
      if (isJoinChunkMessage(data)) handleJoinChunk(data, from);
    }),
  );
  offs.push(
    transport.on(JOIN_CHANNELS.ready, (data, from) => {
      handleJoinReady(data, from);
    }),
  );
  offs.push(
    transport.on(JOIN_CHANNELS.reject, (data, from) => {
      handleJoinReject(data, from);
    }),
  );
  offs.push(transport.onPeerJoin(onPeerJoin));
  offs.push(transport.onPeerLeave(onPeerLeave));
  offs.push(
    transport.onError((message) => {
      const now = currentNow;
      if (now - lastRateNoticeAt < 1000) return;
      lastRateNoticeAt = now;
      console.warn(`[net:session] ${message}`);
    }),
  );

  // Initial presence. The host waits for these hellos before starting.
  if (!amHost) {
    sendHello(hostPeerId);
  }

  // ------------------------------------------------------------------ update

  function updateHost(now: number, dt: number): NetUpdate {
    if (firstUpdateAt === null) firstUpdateAt = now;
    expireJoins(now);
    if (joinTransfers.size > 0 || joinPreparing.size > 0) {
      // Simple, deterministic policy: a join pauses the whole simulation. The
      // state is serialised at the current tick N; no turn is executed or sent
      // until the newcomer has confirmed the hash at N (or the window expires).
      acc = 0;
      waitingFor = [...joinPreparing.keys(), ...joinTransfers.keys()];
      return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs };
    }
    const expected = expectedClients();
    if (!hostStarted) {
      const missing = expected.filter((player) => !ready.has(player.peerId));
      if (missing.length > 0 && now - firstUpdateAt < READY_TIMEOUT_MS) {
        waitingFor = missing.map((player) => player.peerId);
        acc = 0;
        flushTurns();
        return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs };
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
      return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs };
    }
    if (waitingFor.length > 0) waitingFor = [];

    acc = Math.min(acc + dt, NET_TICK_MS * MAX_NORMAL_STEPS);
    let ticks = 0;
    while (acc >= NET_TICK_MS && ticks < MAX_NORMAL_STEPS) {
      const index = runner.tick();
      while (turnsEnd <= index + inputDelay) finalizeTurn();
      if (!turns.has(index)) break;
      execTurn();
      acc -= NET_TICK_MS;
      ticks += 1;
      if (disposed) break;
    }
    if (acc >= NET_TICK_MS) acc %= NET_TICK_MS;
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
      return { ticks: 0, waiting, waitingFor: [...waitingFor], desyncs };
    }

    flushOwnCommands();

    if (now - lastHelloAt >= READY_RESEND_MS) {
      sendHello(hostPeerId);
    }

    if (!hostPeerId || hostLostSince !== null) {
      if (hostLostSince === null) hostLostSince = now;
      if (hostLostSince !== null && now - hostLostSince > LOST_AFTER_MS) lost = true;
      waitingFor = migrationCandidate ? [migrationCandidate] : [];
      return { ticks: 0, waiting: true, waitingFor: [...waitingFor], desyncs };
    }

    if (now - lastPingAt >= PING_EVERY_MS) {
      lastPingAt = now;
      void transport
        .ping(hostPeerId)
        .then((value) => {
          if (!disposed && value >= 0) ping = value;
        })
        .catch(() => {
          // The host may be leaving; migration handles it.
        });
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
      const catchingUp = turnsEnd - index > inputDelay + 1 && extra < CATCHUP_EXTRA;
      if (!canStep && !catchingUp) break;
      if (canStep) acc -= NET_TICK_MS;
      else extra += 1;
      execTurn();
      ticks += 1;
      if (ticks >= MAX_NORMAL_STEPS + CATCHUP_EXTRA) break;
    }

    // Un client qui suit exactement la frontière exécute des ticks à chaque
    // mise à jour puis s'arrête faute du tour suivant : ce n'est pas un stall.
    // Seule une absence totale de progrès doit déclencher hello/resync.
    if (ticks > 0) stallSince = null;
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
    return { ticks, waiting, waitingFor: [...waitingFor], desyncs };
  }

  function update(nowMs: number): NetUpdate {
    if (disposed) return { ...NO_UPDATE, desyncs };
    currentNow = Number.isFinite(nowMs) ? nowMs : currentNow;
    const dt = lastNow === null ? 0 : Math.min(1000, Math.max(0, currentNow - lastNow));
    lastNow = currentNow;

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
    return {
      ping,
      delayTicks: inputDelay,
      tick: runner.tick(),
      desyncs,
      isHost: amHost,
      lost,
      rejected: rejectedCommands,
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
    saveAssemblies.clear();
    joinWindows.clear();
    joinTransfers.clear();
    joinPreparing.clear();
    joinAssembly = null;
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
