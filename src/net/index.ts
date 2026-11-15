/**
 * Public surface of the OpenTT3D network layer.
 *
 * The transport is UI-agnostic and testable in memory; the lockstep session is
 * owned by the lobby and handed the transport once the room is ready.
 */

export type {
  CreateTransportOptions,
  LocalTransportOptions,
  MemoryBus,
  MemoryTransportOptions,
  RateLimitOptions,
  Transport,
  TransportKind,
} from './transport.js';
export { createMemoryBus, createTransport } from './transport.js';

export type {
  ChatEvent,
  NetSession,
  NetSessionOptions,
  NetStats,
  NetUpdate,
  PeersMap,
  Runner,
} from './session.js';
export {
  ACK_INTERVAL,
  HASH_INTERVAL,
  NET_TICK_MS,
  createNetSession,
} from './session.js';

export type {
  AckMessage,
  ChatMessage,
  CmdMessage,
  Command,
  HashMessage,
  HelloMessage,
  LeaveCommand,
  LeaveMessage,
  NetMessage,
  NetMessageKind,
  PlayerId,
  ResyncMessage,
  SaveChunk,
  TurnCommand,
  TurnMessage,
  WireCommand,
} from './types.js';
export {
  MAX_CHANNEL_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_SAVE_CHUNKS,
  MAX_SAVE_CHUNK_CHARS,
  NET_PROTOCOL_VERSION,
  isAckMessage,
  isChannelName,
  isChatMessage,
  isCmdMessage,
  isCommand,
  isEngineCommand,
  isHashMessage,
  isHelloMessage,
  isLeaveCommand,
  isLeaveMessage,
  isResyncMessage,
  isTurnCommand,
  isTurnMessage,
  validateChannelMessage,
} from './types.js';
