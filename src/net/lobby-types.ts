/**
 * Lobby wire protocol and shared lobby types (issue #36).
 *
 * The lobby is a small, host-authoritative state machine that sits on top of
 * the transport, before the lockstep session starts. The host owns the state;
 * clients only send intents (`join`, `slot`, `chat`) and adopt the state the
 * host broadcasts. Every message carries `v` and `k`, and every payload is
 * validated by a guard before it can touch the state — a malformed or hostile
 * peer can at most waste a message.
 *
 * Channels are short so they fit Trystero action names (see `types.ts`).
 */

import type { Transport } from './transport.js';
import { isFiniteNumber, isInt, isNat, isRecord } from './types.js';

/** Version of the lobby protocol, independent from the engine protocol. */
export const LOBBY_PROTOCOL_VERSION = 1;

export const MIN_LOBBY_PLAYERS = 2;
/** Hard cap from the design: eight slots per room (AI included). */
export const MAX_LOBBY_PLAYERS = 8;
/** Number of distinct company colours the host hands out. */
export const LOBBY_COLOURS = 16;

export const MAX_LOBBY_NAME = 32;
export const MAX_SLOT_NAME = 24;
export const MAX_COMPANY_NAME = 32;
export const MAX_CHAT_CHARS = 300;

/** Channels used by the lobby. `lobby` mirrors the wiki table. */
export const LOBBY_CHANNELS = {
  /** Host → all: full authoritative state. */
  state: 'lobby',
  /** Client → host: join/rename request. */
  join: 'lobby-join',
  /** Client → host: self-service slot update. */
  slot: 'lobby-slot',
  /** Both directions: chat, relayed and stamped by the host. */
  chat: 'lobby-chat',
  /** Host → all: frozen start information. */
  start: 'lobby-start',
  /** Host → all: the room is closing. */
  closed: 'lobby-closed',
  /** Host → one client: the client was removed. */
  kick: 'lobby-kick',
  /** Host → one client: an intent was refused, the lobby stays open. */
  error: 'lobby-error',
} as const;

export type AIDifficulty = 'easy' | 'normal' | 'hard';

export const AI_DIFFICULTIES: readonly AIDifficulty[] = ['easy', 'normal', 'hard'];

export type Climate = 'temperate' | 'arctic' | 'tropical' | 'toyland';

export const CLIMATES: readonly Climate[] = ['temperate', 'arctic', 'tropical', 'toyland'];

export type MapSize = 256 | 512 | 1024 | 2048;

export const MAP_SIZES: readonly MapSize[] = [256, 512, 1024, 2048];

/** Moteur choisi dans le salon (#93) : mock déterministe ou OpenTTD WASM. */
export type LobbyEngine = 'mock' | 'wasm';

export const LOBBY_ENGINES: readonly LobbyEngine[] = ['mock', 'wasm'];

export function isLobbyEngine(value: unknown): value is LobbyEngine {
  return value === 'mock' || value === 'wasm';
}

/** Game settings chosen in the lobby and frozen in `StartInfo.settings`. */
export interface LobbySettings {
  /**
   * Moteur de la partie. Il est identique sur tous les pairs : un mélange
   * mock/WASM ferait diverger les hashes dès le premier tick.
   */
  engine: LobbyEngine;
  mapSize: MapSize;
  climate: Climate;
  difficulty: AIDifficulty;
  /** Starting cash, in the engine's currency unit. */
  startingMoney: number;
  maxPlayers: number;
}

export const DEFAULT_LOBBY_SETTINGS: LobbySettings = Object.freeze({
  engine: 'mock',
  mapSize: 512,
  climate: 'temperate',
  difficulty: 'normal',
  startingMoney: 100000,
  maxPlayers: MAX_LOBBY_PLAYERS,
});

/**
 * One seat in the lobby. `player` is the stable player index used by the
 * lockstep session; it is never reused while the slot lives, so a peer keeps
 * its index even when earlier slots are removed.
 */
export interface Slot {
  /** Peer id for a human, synthetic id for an AI. */
  id: string;
  /** Stable player index (0..63), assigned once by the host. */
  player: number;
  name: string;
  /** 0..LOBBY_COLOURS-1, unique among slots. */
  colour: number;
  companyName: string;
  ready: boolean;
  isHost: boolean;
  ai: AIDifficulty | null;
  connected: boolean;
}

export interface LobbyState {
  roomId: string;
  hostId: string;
  name: string;
  maxPlayers: number;
  slots: Slot[];
  settings: LobbySettings;
  started: boolean;
  closed: boolean;
  /** French, UI-facing reason when the lobby failed or was closed. */
  error?: string;
}

export interface LobbyChatEvent {
  player: number;
  name: string;
  text: string;
  /** Wall-clock timestamp (ms), useful for ordering in the UI. */
  at: number;
}

/** A player as frozen at start time, AI included. */
export interface StartPlayer {
  player: number;
  id: string;
  name: string;
  colour: number;
  companyName: string;
  ai: AIDifficulty | null;
  isHost: boolean;
  /**
   * Entreprise OpenTTD contrôlée par ce joueur (#99). Le mapping est construit
   * par l'hôte et figé dans le `StartPayload` : il est identique sur tous les
   * pairs. Absent sur les payloads antérieurs à #99 (le pont retombe alors sur
   * une entreprise locale unique).
   */
  company?: number;
}

/** Nombre maximal d'entreprises (humaines ou IA) exposées par le pont. */
export const MAX_START_COMPANIES = 15;

/** Human player index → peer id. AI slots have no peer. */
export type StartPeers = Record<number, string>;

/** The part of the start information that travels on the wire. */
export interface StartPayload {
  seed: number;
  settings: LobbySettings;
  /**
   * Identifiant du build moteur (`engineBuildId`). Il encode le mode et la
   * version d'artefacts : un pair différent est refusé avant le premier tick.
   */
  engineBuild: string;
  players: StartPlayer[];
  peers: StartPeers;
  /**
   * Nombre d'entreprises humaines créées au démarrage (#99), réserves pour les
   * retardataires incluses. Absent : une entreprise par joueur humain.
   */
  companySeats?: number;
}

/** Everything a peer needs to build its lockstep session. */
export interface StartInfo extends StartPayload {
  localPlayer: number;
  /** Entreprise contrôlée par le joueur local (#99). */
  localCompany?: number;
  isHost: boolean;
  transport: Transport;
}

// ---------------------------------------------------------------------------
// Messages

interface LobbyBase {
  v: number;
}

export interface LobbyStateMessage extends LobbyBase {
  k: 'state';
  state: LobbyState;
}

export interface LobbyJoinMessage extends LobbyBase {
  k: 'join';
  name: string;
}

export interface LobbySlotMessage extends LobbyBase {
  k: 'slot';
  name?: string;
  ready?: boolean;
  colour?: number;
  companyName?: string;
}

export interface LobbyChatWireMessage extends LobbyBase {
  k: 'chat';
  text: string;
  /** Stamped by the host when relaying; ignored from clients. */
  player?: number;
  name?: string;
}

export interface LobbyStartMessage extends LobbyBase, StartPayload {
  k: 'start';
}

export interface LobbyClosedMessage extends LobbyBase {
  k: 'closed';
  reason?: string;
}

export interface LobbyKickMessage extends LobbyBase {
  k: 'kick';
  reason?: string;
}

export interface LobbyErrorMessage extends LobbyBase {
  k: 'error';
  message: string;
}

export type LobbyMessage =
  | LobbyStateMessage
  | LobbyJoinMessage
  | LobbySlotMessage
  | LobbyChatWireMessage
  | LobbyStartMessage
  | LobbyClosedMessage
  | LobbyKickMessage
  | LobbyErrorMessage;

// ---------------------------------------------------------------------------
// Shared validation helpers

/** Room ids are readable codes; transport accepts anything short enough. */
export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(value);
}

/** Peer ids are opaque base62 strings generated by the transport. */
export function isPeerRef(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
}

export function isAIDifficulty(value: unknown): value is AIDifficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

export function isClimate(value: unknown): value is Climate {
  return typeof value === 'string' && (CLIMATES as readonly string[]).includes(value);
}

export function isMapSize(value: unknown): value is MapSize {
  return value === 256 || value === 512 || value === 1024 || value === 2048;
}

/** Strips control characters/newlines, collapses spaces and caps the length. */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  return printable.replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxLength));
}

/** Returns `fallback` when, after cleaning, the name is empty. */
export function sanitizeName(value: unknown, fallback: string, maxLength = MAX_SLOT_NAME): string {
  const cleaned = cleanText(value, maxLength);
  return cleaned.length > 0 ? cleaned : cleanText(fallback, maxLength) || 'Joueur';
}

export function sanitizeChat(value: unknown): string {
  return cleanText(value, MAX_CHAT_CHARS);
}

/** First colour not used by `slots`, or -1 when the palette is exhausted. */
export function freeColour(slots: readonly Pick<Slot, 'colour'>[]): number {
  const used = new Set(slots.map((slot) => slot.colour));
  for (let colour = 0; colour < LOBBY_COLOURS; colour++) {
    if (!used.has(colour)) return colour;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Guards

export function isLobbySettings(value: unknown): value is LobbySettings {
  if (!isRecord(value)) return false;
  return (
    isLobbyEngine(value.engine) &&
    isMapSize(value.mapSize) &&
    isClimate(value.climate) &&
    isAIDifficulty(value.difficulty) &&
    isFiniteNumber(value.startingMoney) &&
    value.startingMoney >= 0 &&
    value.startingMoney <= 1_000_000_000 &&
    isInt(value.maxPlayers) &&
    value.maxPlayers >= MIN_LOBBY_PLAYERS &&
    value.maxPlayers <= MAX_LOBBY_PLAYERS
  );
}

export function isSlot(value: unknown): value is Slot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    isInt(value.player) &&
    value.player >= 0 &&
    value.player <= 63 &&
    typeof value.name === 'string' &&
    value.name.length <= 64 &&
    isInt(value.colour) &&
    value.colour >= 0 &&
    value.colour < LOBBY_COLOURS &&
    typeof value.companyName === 'string' &&
    value.companyName.length <= 64 &&
    typeof value.ready === 'boolean' &&
    typeof value.isHost === 'boolean' &&
    (value.ai === null || isAIDifficulty(value.ai)) &&
    typeof value.connected === 'boolean'
  );
}

export function isLobbyState(value: unknown): value is LobbyState {
  if (!isRecord(value)) return false;
  if (!isRoomId(value.roomId)) return false;
  if (!isPeerRef(value.hostId)) return false;
  if (typeof value.name !== 'string' || value.name.length > 64) return false;
  if (!isInt(value.maxPlayers)) return false;
  if (value.maxPlayers < MIN_LOBBY_PLAYERS || value.maxPlayers > MAX_LOBBY_PLAYERS) return false;
  if (!Array.isArray(value.slots) || value.slots.length > MAX_LOBBY_PLAYERS) return false;
  if (value.slots.length > value.maxPlayers) return false;
  if (!isLobbySettings(value.settings)) return false;
  if (typeof value.started !== 'boolean' || typeof value.closed !== 'boolean') return false;
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 240)) {
    return false;
  }
  if (value.settings.maxPlayers !== value.maxPlayers) return false;

  const ids = new Set<string>();
  const players = new Set<number>();
  const colours = new Set<number>();
  for (const slot of value.slots) {
    if (!isSlot(slot)) return false;
    if (ids.has(slot.id) || players.has(slot.player) || colours.has(slot.colour)) return false;
    ids.add(slot.id);
    players.add(slot.player);
    colours.add(slot.colour);
  }
  return true;
}

function hasLobbyBase(value: unknown): value is Record<string, unknown> & LobbyBase {
  return isRecord(value) && value.v === LOBBY_PROTOCOL_VERSION;
}

export function isLobbyStateMessage(value: unknown): value is LobbyStateMessage {
  return hasLobbyBase(value) && value.k === 'state' && isLobbyState(value.state);
}

export function isLobbyJoinMessage(value: unknown): value is LobbyJoinMessage {
  return (
    hasLobbyBase(value) &&
    value.k === 'join' &&
    typeof value.name === 'string' &&
    value.name.length <= 64
  );
}

export function isLobbySlotMessage(value: unknown): value is LobbySlotMessage {
  if (!hasLobbyBase(value) || value.k !== 'slot') return false;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 64)) {
    return false;
  }
  if (value.ready !== undefined && typeof value.ready !== 'boolean') return false;
  if (
    value.colour !== undefined &&
    (!isInt(value.colour) || value.colour < 0 || value.colour >= LOBBY_COLOURS)
  ) {
    return false;
  }
  if (
    value.companyName !== undefined &&
    (typeof value.companyName !== 'string' || value.companyName.length > 64)
  ) {
    return false;
  }
  return (
    value.name !== undefined ||
    value.ready !== undefined ||
    value.colour !== undefined ||
    value.companyName !== undefined
  );
}

export function isLobbyChatMessage(value: unknown): value is LobbyChatWireMessage {
  if (!hasLobbyBase(value) || value.k !== 'chat') return false;
  if (typeof value.text !== 'string') return false;
  if (value.text.length === 0 || value.text.length > MAX_CHAT_CHARS) return false;
  if (
    value.player !== undefined &&
    (!isInt(value.player) || value.player < 0 || value.player > 63)
  ) {
    return false;
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 64)) {
    return false;
  }
  return true;
}

export function isStartPeers(value: unknown): value is StartPeers {
  if (!isRecord(value)) return false;
  for (const [key, peer] of Object.entries(value)) {
    if (!/^\d{1,2}$/.test(key)) return false;
    const index = Number(key);
    if (index < 0 || index > 63) return false;
    if (!isPeerRef(peer)) return false;
  }
  return true;
}

export function isStartPlayer(value: unknown): value is StartPlayer {
  if (!isRecord(value)) return false;
  return (
    isInt(value.player) &&
    value.player >= 0 &&
    value.player <= 63 &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.name === 'string' &&
    value.name.length <= 64 &&
    isInt(value.colour) &&
    value.colour >= 0 &&
    value.colour < LOBBY_COLOURS &&
    typeof value.companyName === 'string' &&
    value.companyName.length <= 64 &&
    (value.ai === null || isAIDifficulty(value.ai)) &&
    typeof value.isHost === 'boolean' &&
    (value.company === undefined ||
      (isInt(value.company) && value.company >= 0 && value.company < MAX_START_COMPANIES))
  );
}

export function isStartPayload(value: unknown): value is StartPayload {
  if (!isRecord(value)) return false;
  if (!isNat(value.seed) || value.seed > 0xffffffff) return false;
  if (!isLobbySettings(value.settings)) return false;
  if (
    typeof value.engineBuild !== 'string' ||
    value.engineBuild.length === 0 ||
    value.engineBuild.length > 64
  ) {
    return false;
  }
  if (!Array.isArray(value.players)) return false;
  if (value.players.length < 1 || value.players.length > MAX_LOBBY_PLAYERS) return false;
  if (!value.players.every(isStartPlayer)) return false;
  if (
    value.companySeats !== undefined &&
    (!isInt(value.companySeats) ||
      value.companySeats < 1 ||
      value.companySeats > MAX_START_COMPANIES)
  ) {
    return false;
  }
  // Le mapping joueur → entreprise doit être unique et tenir dans les sièges.
  const companies = new Set<number>();
  for (const player of value.players) {
    if (player.company === undefined) continue;
    if (companies.has(player.company)) return false;
    if (value.companySeats !== undefined && player.company >= value.companySeats) return false;
    companies.add(player.company);
  }
  return isStartPeers(value.peers);
}

export function isLobbyStartMessage(value: unknown): value is LobbyStartMessage {
  return hasLobbyBase(value) && value.k === 'start' && isStartPayload(value);
}

export function isLobbyClosedMessage(value: unknown): value is LobbyClosedMessage {
  return (
    hasLobbyBase(value) &&
    value.k === 'closed' &&
    (value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 240))
  );
}

export function isLobbyKickMessage(value: unknown): value is LobbyKickMessage {
  return (
    hasLobbyBase(value) &&
    value.k === 'kick' &&
    (value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 240))
  );
}

export function isLobbyErrorMessage(value: unknown): value is LobbyErrorMessage {
  return (
    hasLobbyBase(value) &&
    value.k === 'error' &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    value.message.length <= 240
  );
}

/** Validates a lobby message received on a given channel. */
export function validateLobbyMessage(channel: string, value: unknown): LobbyMessage | null {
  switch (channel) {
    case LOBBY_CHANNELS.state:
      return isLobbyStateMessage(value) ? value : null;
    case LOBBY_CHANNELS.join:
      return isLobbyJoinMessage(value) ? value : null;
    case LOBBY_CHANNELS.slot:
      return isLobbySlotMessage(value) ? value : null;
    case LOBBY_CHANNELS.chat:
      return isLobbyChatMessage(value) ? value : null;
    case LOBBY_CHANNELS.start:
      return isLobbyStartMessage(value) ? value : null;
    case LOBBY_CHANNELS.closed:
      return isLobbyClosedMessage(value) ? value : null;
    case LOBBY_CHANNELS.kick:
      return isLobbyKickMessage(value) ? value : null;
    case LOBBY_CHANNELS.error:
      return isLobbyErrorMessage(value) ? value : null;
    default:
      return null;
  }
}
