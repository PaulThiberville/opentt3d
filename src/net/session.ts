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
 */

import type { EngineCommand } from '../engine/protocol.js';
import type { Transport } from './transport.js';
import {
  NET_PROTOCOL_VERSION,
  MAX_SAVE_CHUNK_CHARS,
  MAX_SAVE_CHUNKS,
  isAckMessage,
  isChatMessage,
  isCmdMessage,
  isEngineCommand,
  isHashMessage,
  isHelloMessage,
  isResyncMessage,
  isTurnMessage,
  type ChatMessage,
  type Command,
  type HelloMessage,
  type NetMessage,
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
const LAG_RESUME_TICKS = 25;
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

export interface Runner {
  tick(): number;
  step(commands: Command[]): void;
  hash(): string;
  serialize(): string;
  load(data: string): void;
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
}

export interface ChatEvent {
  player: number;
  text: string;
}

export interface NetSession {
  readonly localPlayer: number;
  issue(cmd: EngineCommand): void;
  update(nowMs: number): NetUpdate;
  alpha(nowMs: number): number;
  stats(): NetStats;
  onDesync(fn: () => void): () => void;
  /** Asks the host for a save and reloads it (client side). */
  requestResync(): void;
  /** Host side: pushes an explicit save (all peers by default). */
  provideSave(data: string, target?: string): void;
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
  if (!players.has(localPlayer)) {
    players.set(localPlayer, {
      index: localPlayer,
      peerId: selfId,
      left: false,
      connected: true,
    });
    peerToPlayer.set(selfId, localPlayer);
  }
  return { players, peerToPlayer };
}

export function createNetSession(options: NetSessionOptions): NetSession {
  const { runner, transport, localPlayer } = options;
  const inputDelay = Number.isFinite(options.inputDelay)
    ? Math.min(32, Math.max(0, Math.floor(options.inputDelay as number)))
    : DEFAULT_INPUT_DELAY;

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

  const { players, peerToPlayer } = normalizePeers(
    options.peers,
    transport.selfId,
    localPlayer,
  );

  const selfRecord = players.get(localPlayer);
  if (amHost) {
    if (selfRecord) selfRecord.connected = true;
    hostPeerId = transport.selfId;
  } else {
    hostPeerId =
      options.hostId ??
      [...players.values()].sort((a, b) => a.index - b.index).find((p) => p.peerId !== transport.selfId)
        ?.peerId;
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
  const offs: (() => void)[] = [];

  // ------------------------------------------------------------------ helpers

  function send(channel: string, message: object, target?: string | string[]): void {
    if (disposed) return;
    transport.send(
      channel,
      { v: NET_PROTOCOL_VERSION, ...message },
      target,
    );
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
    outTurns.push({ v: NET_PROTOCOL_VERSION, k: 'turn', epoch, tick: index, commands, d: inputDelay });
  }

  function execTurn(): void {
    const index = runner.tick();
    const commands = turns.get(index);
    if (!commands) return;
    const forEngine: Command[] = [];
    for (const command of commands) {
      if (command.type === 'leave') continue;
      const { s: _s, ...rest } = command;
      forEngine.push(rest as Command);
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
      send(
        'turn',
        { k: 'turn', epoch, tick, commands, d: inputDelay },
        peerId,
      );
    }
  }

  function flushTurns(): void {
    if (outTurns.length === 0) return;
    for (const turn of outTurns) {
      send('turn', turn);
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

  // ------------------------------------------------------------------ commands

  function issue(cmd: EngineCommand): void {
    if (disposed) return;
    if (!isEngineCommand(cmd)) {
      throw new TypeError('Commande invalide : elle doit respecter le contrat moteur.');
    }
    if (players.get(localPlayer)?.left) return;
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
      const last = Math.max(
        queuedSeq.get(player.index) ?? -1,
        seenSeq.get(player.index) ?? -1,
      );
      if (entry.s <= last) continue;
      if (queued >= MAX_QUEUE_PER_PLAYER) break;
      hostQueue.push({ p: player.index, s: entry.s, cmd: entry.c });
      queuedSeq.set(player.index, entry.s);
      queued++;
    }
  }

  // ------------------------------------------------------------------ hello / host

  function sendHello(target?: string): void {
    if (disposed) return;
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
    if (currentNow - lastResyncRequestAt < RESYNC_RETRY_MS) return;
    lastResyncRequestAt = currentNow;
    send(
      'resync',
      { k: 'resync', epoch, tick: runner.tick(), request: true },
      hostPeerId,
    );
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
    const dt =
      lastNow === null ? 0 : Math.min(1000, Math.max(0, currentNow - lastNow));
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
            data: data.slice(
              index * MAX_SAVE_CHUNK_CHARS,
              (index + 1) * MAX_SAVE_CHUNK_CHARS,
            ),
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
    saveAssemblies.clear();
    transport.leave();
  }

  return {
    localPlayer,
    issue,
    update,
    alpha,
    stats,
    onDesync,
    requestResync,
    provideSave,
    sendChat,
    onChat,
    dispose,
  };
}
