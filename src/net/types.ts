/**
 * Wire protocol of the OpenTT3D peer-to-peer network layer.
 *
 * Everything exchanged between peers travels through the `Transport`
 * abstraction (see `transport.ts`). The lockstep session (see `session.ts`)
 * only ever sends the small, versioned messages defined here: commands, turn
 * boundaries, periodic hashes, acknowledgements, resynchronisation saves and
 * chat. No world state is streamed every frame.
 *
 * Rules:
 *  - every message carries the protocol version `v` and a kind `k`;
 *  - every `Command` is fully deterministic and JSON-serialisable;
 *  - a command's player index is always stamped by the host from the sender's
 *    peer id, never read from the payload;
 *  - payloads are validated before being used (see the `is*` guards).
 */

import type { EngineCommand } from '../engine/protocol.js';

export const NET_PROTOCOL_VERSION = 1;

/** Maximum size of a single transport message (256 KiB). */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** Channels are short identifiers so they fit Trystero action names. */
export const MAX_CHANNEL_LENGTH = 24;

/** A save is chunked because a real OpenTTD save can exceed the message cap.
 * 32 KiB of UTF-16 code units is at most ~192 KiB once JSON-escaped, safely
 * below the 256 KiB transport limit. */
export const MAX_SAVE_CHUNK_CHARS = 32 * 1024;
export const MAX_SAVE_CHUNKS = 1024;

/** Maximum size of one complete save: 1 024 chunks × 32 KiB ≈ 32 Mi characters. */
export const MAX_SAVE_CHARS = MAX_SAVE_CHUNK_CHARS * MAX_SAVE_CHUNKS;

/**
 * Version of the late-join handshake, independent from both the wire protocol
 * and the engine build. `NET_PROTOCOL_VERSION` stays 1 so existing messages and
 * peers keep working; a joining peer advertises `pv` explicitly.
 */
export const JOIN_PROTOCOL_VERSION = 1;

/** Channel names used by the late-join handshake. */
export const JOIN_CHANNELS = {
  request: 'join-request',
  accept: 'join-accept',
  chunk: 'join-chunk',
  ready: 'join-ready',
  reject: 'join-reject',
} as const;

export type JoinRejectReason =
  'version' | 'full' | 'started' | 'closed' | 'invalid-save' | 'timeout';

export const JOIN_REJECT_REASONS: readonly JoinRejectReason[] = [
  'version',
  'full',
  'started',
  'closed',
  'invalid-save',
  'timeout',
];

/** Player index attached to a command by the host. */
export type PlayerId = number;

/** An engine command once the host has stamped its author. */
export type Command = EngineCommand & { p: PlayerId };

/**
 * A command as it travels in a finalized turn. `s` is the sender's command
 * sequence number; it lets a client drop its pending copy once the command is
 * part of a turn, and lets the host deduplicate re-sent commands.
 */
export type WireCommand = Command & { s?: number };

/** A session-level command, never forwarded to the engine. */
export interface LeaveCommand {
  type: 'leave';
  p: PlayerId;
  s?: number;
}

export type TurnCommand = WireCommand | LeaveCommand;

export interface SaveChunk {
  /** Identifies all the chunks of one save. */
  id: string;
  index: number;
  total: number;
  data: string;
}

interface MessageBase {
  v: number;
}

/** Sent by a joining peer (and periodically until a host answers). */
export interface HelloMessage extends MessageBase {
  k: 'hello';
  player: PlayerId;
  tick: number;
  host: boolean;
  epoch: number;
  /** Host input delay, useful for diagnostics. */
  d?: number;
  /** True on an answer, to stop request/answer ping-pong. */
  reply?: boolean;
}

/** Client → host: a batch of local commands with their sequence numbers. */
export interface CmdMessage extends MessageBase {
  k: 'cmd';
  b: { s: number; c: EngineCommand }[];
}

/** Host → peers: one finalized turn (possibly empty). */
export interface TurnMessage extends MessageBase {
  k: 'turn';
  epoch: number;
  tick: number;
  commands: TurnCommand[];
  d: number;
}

/** Exchanged every `HASH_INTERVAL` ticks to detect divergence. */
export interface HashMessage extends MessageBase {
  k: 'hash';
  epoch: number;
  tick: number;
  hash: string;
}

/** Client → host: "I have executed ticks up to `tick`". */
export interface AckMessage extends MessageBase {
  k: 'ack';
  tick: number;
}

/**
 * Resynchronisation. A peer sends `{request: true}`; the host answers with a
 * serialized save split into chunks. Receiving the last chunk makes the peer
 * reload its runner and join the host's current tick.
 */
export interface ResyncMessage extends MessageBase {
  k: 'resync';
  epoch: number;
  tick: number;
  request?: boolean;
  save?: SaveChunk;
  /** Players whose `leave` was already finalized before this save. */
  left?: PlayerId[];
}

export interface ChatMessage extends MessageBase {
  k: 'chat';
  player: PlayerId;
  text: string;
}

/** Informational: a player left (the authoritative leave travels in a turn). */
export interface LeaveMessage extends MessageBase {
  k: 'leave';
  player: PlayerId;
}

// ---------------------------------------------------------------------------
// Late join (issue #38)
//
// A peer that missed the initial `start` asks to join a running game. The host
// serialises the state at a tick boundary N, ships it with the same chunking
// rules as `resync`, waits for the peer to load it and confirm the hash at N,
// and only then includes the peer in turns N+1 and later. The handshake is one
// peer at a time; the host pauses the simulation for the duration (see
// `session.ts`).

/** Client → host: "let me join the running game". */
export interface JoinRequestMessage extends MessageBase {
  k: 'join-request';
  /** Join handshake version (`JOIN_PROTOCOL_VERSION`). */
  pv: number;
  /** Requested player index; the host remains authoritative. */
  player?: PlayerId;
  /** Display name, informational only. */
  name?: string;
  /** Engine build identifier, when known (mismatch is a hard refusal). */
  engine?: string;
}

/** Host → client: transfer plan. The save starts at `tick`. */
export interface JoinAcceptMessage extends MessageBase {
  k: 'join-accept';
  /** Save epoch, so stale chunks can be discarded. */
  epoch: number;
  /** Tick boundary N covered by the save. */
  tick: number;
  /** Number of `join-chunk` messages to expect. */
  total: number;
  /** Player index assigned by the host (never trusted from the request). */
  player: PlayerId;
  /** Identifies all the chunks of this transfer. */
  id: string;
  /** Host state hash at `tick`, compared after the client loads the save. */
  hash: string;
  engine?: string;
  /**
   * Entreprise OpenTTD attribuée à ce joueur (#99). Absente sur les parties
   * antérieures à #99 : le client retombe alors sur le mapping du `StartInfo`.
   */
  company?: number;
}

/** Host → client: one chunk of the save taken at `tick` (same shape as resync). */
export interface JoinChunkMessage extends MessageBase {
  k: 'join-chunk';
  epoch: number;
  tick: number;
  save: SaveChunk;
}

/** Client → host: the save is loaded (or failed), with the resulting hash. */
export interface JoinReadyMessage extends MessageBase {
  k: 'join-ready';
  epoch?: number;
  tick: number;
  /** Empty when `ok` is false. */
  hash: string;
  /** Defaults to true; false reports an unusable save (corrupt/truncated). */
  ok?: boolean;
  error?: string;
}

/** Host → client: the join was refused, with a machine-readable reason. */
export interface JoinRejectMessage extends MessageBase {
  k: 'join-reject';
  reason: JoinRejectReason;
  /** French, UI-facing detail. */
  message?: string;
  /** Tick of the refused transfer, when relevant. */
  tick?: number;
}

export type NetMessage =
  | HelloMessage
  | CmdMessage
  | TurnMessage
  | HashMessage
  | AckMessage
  | ResyncMessage
  | ChatMessage
  | LeaveMessage
  | JoinRequestMessage
  | JoinAcceptMessage
  | JoinChunkMessage
  | JoinReadyMessage
  | JoinRejectMessage;

export type NetMessageKind = NetMessage['k'];

// ---------------------------------------------------------------------------
// Low-level guards

export interface JsonRecord {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function isNat(value: unknown): value is number {
  return isInt(value) && value >= 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

/** Channel names: 1..24 chars, `[A-Za-z0-9_-]`. */
export function isChannelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CHANNEL_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function isPlayerId(value: unknown): value is PlayerId {
  return isInt(value) && value >= 0 && value <= 63;
}

const BUILD_TOOLS = new Set([
  'road',
  'rail',
  'station',
  'depot',
  'signal',
  'bridge',
  'tunnel',
  'clear',
]);

const VEHICLE_ACTIONS = new Set(['buy', 'sell', 'refit', 'order', 'start', 'stop']);

/**
 * Structural validation of an `EngineCommand` (mirrors `protocol.ts` without
 * modifying it). Unknown extra properties are tolerated, as the engine bridge
 * is the final authority; the goal here is to reject hostile/absurd payloads.
 */
export function isEngineCommand(value: unknown): value is EngineCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'pause':
      return typeof value.paused === 'boolean';
    case 'speed':
      return value.speed === 0 || value.speed === 1 || value.speed === 2;
    case 'console':
      return typeof value.command === 'string' && value.command.length <= 4096;
    case 'build': {
      if (typeof value.tool !== 'string' || !BUILD_TOOLS.has(value.tool)) return false;
      if (!isNat(value.company) || value.company > 255) return false;
      if (!isPoint(value.from)) return false;
      if (value.to !== undefined && !isPoint(value.to)) return false;
      if (value.options !== undefined) {
        if (!isRecord(value.options)) return false;
        for (const item of Object.values(value.options)) {
          if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
            return false;
          }
        }
      }
      return true;
    }
    case 'vehicle': {
      if (typeof value.action !== 'string' || !VEHICLE_ACTIONS.has(value.action)) {
        return false;
      }
      if (!isNat(value.company) || value.company > 255) return false;
      if (value.vehicle !== undefined && !isNat(value.vehicle)) return false;
      if (value.depot !== undefined && !isPoint(value.depot)) return false;
      if (value.model !== undefined && typeof value.model !== 'string') return false;
      if (value.orders !== undefined) {
        if (!Array.isArray(value.orders)) return false;
        for (const order of value.orders) {
          if (
            !isRecord(order) ||
            !isNat(order.target) ||
            (order.kind !== 'station' && order.kind !== 'industry' && order.kind !== 'depot')
          ) {
            return false;
          }
        }
      }
      return true;
    }
    default:
      return false;
  }
}

export function isCommand(value: unknown): value is Command {
  return isRecord(value) && isPlayerId(value.p) && isEngineCommand(value);
}

export function isLeaveCommand(value: unknown): value is LeaveCommand {
  return isRecord(value) && value.type === 'leave' && isPlayerId(value.p);
}

export function isTurnCommand(value: unknown): value is TurnCommand {
  if (!isRecord(value)) return false;
  if (value.s !== undefined && !isNat(value.s)) return false;
  if (value.type === 'leave') return isPlayerId(value.p);
  return isPlayerId(value.p) && isEngineCommand(value);
}

// ---------------------------------------------------------------------------
// Message guards

function hasBase(value: unknown): value is JsonRecord & MessageBase {
  return isRecord(value) && value.v === NET_PROTOCOL_VERSION;
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  if (!hasBase(value) || value.k !== 'hello') return false;
  return (
    isPlayerId(value.player) &&
    isNat(value.tick) &&
    typeof value.host === 'boolean' &&
    isNat(value.epoch) &&
    (value.d === undefined || (isNat(value.d) && value.d <= 64)) &&
    (value.reply === undefined || typeof value.reply === 'boolean')
  );
}

export function isCmdMessage(value: unknown): value is CmdMessage {
  if (!hasBase(value) || value.k !== 'cmd' || !Array.isArray(value.b)) return false;
  if (value.b.length > 64) return false;
  return value.b.every(
    (entry: unknown) => isRecord(entry) && isNat(entry.s) && isEngineCommand(entry.c),
  );
}

export function isTurnMessage(value: unknown): value is TurnMessage {
  if (!hasBase(value) || value.k !== 'turn') return false;
  if (!isNat(value.epoch) || !isNat(value.tick)) return false;
  if (!isNat(value.d) || value.d > 64) return false;
  if (!Array.isArray(value.commands) || value.commands.length > 4096) return false;
  return value.commands.every(isTurnCommand);
}

export function isHashMessage(value: unknown): value is HashMessage {
  return (
    hasBase(value) &&
    value.k === 'hash' &&
    isNat(value.epoch) &&
    isNat(value.tick) &&
    typeof value.hash === 'string' &&
    value.hash.length <= 1024
  );
}

export function isAckMessage(value: unknown): value is AckMessage {
  return hasBase(value) && value.k === 'ack' && isNat(value.tick);
}

export function isSaveChunk(value: unknown): value is SaveChunk {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    isNat(value.index) &&
    isNat(value.total) &&
    value.total > 0 &&
    value.total <= MAX_SAVE_CHUNKS &&
    value.index < value.total &&
    typeof value.data === 'string' &&
    value.data.length <= MAX_SAVE_CHUNK_CHARS
  );
}

export function isResyncMessage(value: unknown): value is ResyncMessage {
  if (!hasBase(value) || value.k !== 'resync') return false;
  if (!isNat(value.epoch) || !isNat(value.tick)) return false;
  if (value.request !== undefined && typeof value.request !== 'boolean') return false;
  if (value.save !== undefined && !isSaveChunk(value.save)) return false;
  if (value.left !== undefined) {
    if (!Array.isArray(value.left) || value.left.length > 64) return false;
    if (!value.left.every(isPlayerId)) return false;
  }
  return true;
}

export function isChatMessage(value: unknown): value is ChatMessage {
  return (
    hasBase(value) &&
    value.k === 'chat' &&
    isPlayerId(value.player) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= 500
  );
}

export function isLeaveMessage(value: unknown): value is LeaveMessage {
  return hasBase(value) && value.k === 'leave' && isPlayerId(value.player);
}

export function isJoinRejectReason(value: unknown): value is JoinRejectReason {
  return typeof value === 'string' && (JOIN_REJECT_REASONS as readonly string[]).includes(value);
}

export function isJoinRequestMessage(value: unknown): value is JoinRequestMessage {
  if (!hasBase(value) || value.k !== 'join-request') return false;
  if (value.pv !== JOIN_PROTOCOL_VERSION) return false;
  if (value.player !== undefined && !isPlayerId(value.player)) return false;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 24)) {
    return false;
  }
  if (
    value.engine !== undefined &&
    (typeof value.engine !== 'string' || value.engine.length > 64)
  ) {
    return false;
  }
  return true;
}

export function isJoinAcceptMessage(value: unknown): value is JoinAcceptMessage {
  if (!hasBase(value) || value.k !== 'join-accept') return false;
  return (
    isNat(value.epoch) &&
    isNat(value.tick) &&
    isNat(value.total) &&
    value.total > 0 &&
    value.total <= MAX_SAVE_CHUNKS &&
    isPlayerId(value.player) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    typeof value.hash === 'string' &&
    value.hash.length <= 1024 &&
    (value.engine === undefined ||
      (typeof value.engine === 'string' && value.engine.length <= 64)) &&
    (value.company === undefined ||
      (isInt(value.company) && value.company >= 0 && value.company < 15))
  );
}

export function isJoinChunkMessage(value: unknown): value is JoinChunkMessage {
  return (
    hasBase(value) &&
    value.k === 'join-chunk' &&
    isNat(value.epoch) &&
    isNat(value.tick) &&
    isSaveChunk(value.save)
  );
}

export function isJoinReadyMessage(value: unknown): value is JoinReadyMessage {
  if (!hasBase(value) || value.k !== 'join-ready') return false;
  if (value.epoch !== undefined && !isNat(value.epoch)) return false;
  if (!isNat(value.tick)) return false;
  if (typeof value.hash !== 'string' || value.hash.length > 1024) return false;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return false;
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 240)) {
    return false;
  }
  return true;
}

export function isJoinRejectMessage(value: unknown): value is JoinRejectMessage {
  if (!hasBase(value) || value.k !== 'join-reject') return false;
  if (!isJoinRejectReason(value.reason)) return false;
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' || value.message.length > 240)
  ) {
    return false;
  }
  if (value.tick !== undefined && !isNat(value.tick)) return false;
  return true;
}

/** Validates a message received on a given channel (channels mirror kinds). */
export function validateChannelMessage(channel: string, value: unknown): NetMessage | null {
  switch (channel) {
    case 'hello':
      return isHelloMessage(value) ? value : null;
    case 'cmd':
      return isCmdMessage(value) ? value : null;
    case 'turn':
      return isTurnMessage(value) ? value : null;
    case 'hash':
      return isHashMessage(value) ? value : null;
    case 'ack':
      return isAckMessage(value) ? value : null;
    case 'resync':
      return isResyncMessage(value) ? value : null;
    case 'chat':
      return isChatMessage(value) ? value : null;
    case 'leave':
      return isLeaveMessage(value) ? value : null;
    case JOIN_CHANNELS.request:
      return isJoinRequestMessage(value) ? value : null;
    case JOIN_CHANNELS.accept:
      return isJoinAcceptMessage(value) ? value : null;
    case JOIN_CHANNELS.chunk:
      return isJoinChunkMessage(value) ? value : null;
    case JOIN_CHANNELS.ready:
      return isJoinReadyMessage(value) ? value : null;
    case JOIN_CHANNELS.reject:
      return isJoinRejectMessage(value) ? value : null;
    default:
      return null;
  }
}
