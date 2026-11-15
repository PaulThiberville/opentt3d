/**
 * Host-authoritative lobby (issue #36).
 *
 * The lobby sits between the transport and the lockstep session: it gathers
 * players, lets them pick a name, a colour and a company, relays chat, and
 * freezes the start information (`seed`, `settings`, player indices) once
 * everybody is ready.
 *
 * Authority rules:
 *  - the host owns `LobbyState`; clients only send intents and adopt the state
 *    the host broadcasts, so a client can never invent a slot or a colour;
 *  - player indices are assigned once by the host and never shift, which keeps
 *    the lockstep peer mapping stable;
 *  - there is no host migration in the lobby: when the host leaves, the room
 *    closes cleanly (clients may then return to the menu or quick-match).
 *
 * No timers are used here: the transport already provides presence detection,
 * and rate limiting happens in the transport (see `transport.ts`). Every
 * message is validated by the guards of `lobby-types.ts` before it can touch
 * the state.
 */

import {
  LOBBY_DIRECTORY_VERSION,
  type Directory,
  type LobbyInfo,
  type LobbyStatus,
} from './directory.js';
import {
  DEFAULT_LOBBY_SETTINGS,
  LOBBY_CHANNELS,
  LOBBY_COLOURS,
  LOBBY_PROTOCOL_VERSION,
  MAX_COMPANY_NAME,
  MAX_LOBBY_NAME,
  MAX_LOBBY_PLAYERS,
  MAX_SLOT_NAME,
  MIN_LOBBY_PLAYERS,
  freeColour,
  isAIDifficulty,
  isClimate,
  isLobbyChatMessage,
  isLobbyClosedMessage,
  isLobbyEngine,
  isLobbyErrorMessage,
  isLobbyJoinMessage,
  isLobbyKickMessage,
  isLobbySlotMessage,
  isLobbyStartMessage,
  isLobbyStateMessage,
  isMapSize,
  isPeerRef,
  isRoomId,
  sanitizeChat,
  sanitizeName,
  type AIDifficulty,
  type LobbyChatEvent,
  type LobbySettings,
  type LobbyState,
  type Slot,
  type StartInfo,
  type StartPayload,
  type StartPeers,
  type StartPlayer,
} from './lobby-types.js';
import { engineBuildId } from '../engine/loadEngine.js';
import type { Transport } from './transport.js';
import { isFiniteNumber, isInt } from './types.js';

const MAX_STARTING_MONEY = 1_000_000_000;
const MAX_REJOIN_ATTEMPTS = 3;

export interface CreateLobbyOptions {
  transport: Transport;
  isHost: boolean;
  /** Expected host peer id (from the invite link); learned on first state otherwise. */
  hostId?: string;
  /** Checked against `transport.selfId`; both must match when provided. */
  selfId?: string;
  /** Lobby name for the host, player name for a client. */
  name?: string;
  settings?: Partial<LobbySettings>;
  /** Optional public directory; only a public host publishes to it. */
  directory?: Directory;
  isPublic?: boolean;
  /** Fallback when the transport does not expose it. */
  roomId?: string;
  /** Injected clock (ms), for deterministic tests. */
  now?: () => number;
  /** Fixed seed, for deterministic tests. */
  seed?: number;
}

export interface LobbyDiagnostics {
  role: 'host' | 'client';
  roomId: string;
  selfId: string;
  hostId: string;
  isPublic: boolean;
  maxPlayers: number;
  slots: number;
  humans: number;
  ai: number;
  connected: number;
  started: boolean;
  closed: boolean;
  sent: number;
  received: number;
  rejected: number;
  peers: number;
  lastError?: string;
  directory?: ReturnType<Directory['diagnostics']>;
}

export interface Lobby {
  /** Read-only snapshot; a new object on each access. */
  readonly state: LobbyState;
  readonly isHost: boolean;
  readonly selfId: string;
  onChange(fn: (state: LobbyState) => void): () => void;
  onStart(fn: (info: StartInfo) => void): () => void;
  onChat(fn: (event: LobbyChatEvent) => void): () => void;
  onError(fn: (message: string) => void): () => void;
  setName(name: string): void;
  setReady(ready: boolean): void;
  setColour(index: number): void;
  setCompanyName(name: string): void;
  addAI(difficulty: AIDifficulty): void;
  removeSlot(index: number): void;
  kick(index: number): void;
  setSlotColour(index: number, colour: number): void;
  setSettings(settings: Partial<LobbySettings>): void;
  start(): void;
  sendChat(text: string): void;
  leave(): void;
  diagnostics(): LobbyDiagnostics;
}

export interface InviteLink {
  roomId: string;
  hostId: string;
}

/**
 * Builds `?room=CODE&host=ID`, optionally on top of a base URL. Any query or
 * fragment already present in `baseUrl` is dropped: an invitation is a single
 * canonical link.
 */
export function buildInviteLink(roomId: string, hostId: string, baseUrl = ''): string {
  if (!isRoomId(roomId)) throw new TypeError('Code de salon invalide');
  if (!isPeerRef(hostId)) throw new TypeError('Identifiant d’hôte invalide');
  let base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  const hash = base.indexOf('#');
  if (hash >= 0) base = base.slice(0, hash);
  const query = base.indexOf('?');
  if (query >= 0) base = base.slice(0, query);
  const params = new URLSearchParams({ room: roomId.toLowerCase(), host: hostId });
  return `${base}?${params.toString()}`;
}

/**
 * Parses a full URL, a relative link, a bare query string or a `room=…&host=…`
 * fragment. Returns `null` on anything invalid, so the caller can show a
 * French message instead of throwing while reading `location.search`.
 */
export function parseInviteLink(value: string): InviteLink | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let search = trimmed;
  const query = search.indexOf('?');
  if (query >= 0) search = search.slice(query + 1);
  const hash = search.indexOf('#');
  if (hash >= 0) search = search.slice(0, hash);
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const roomId = params.get('room');
  const hostId = params.get('host');
  if (roomId === null || hostId === null) return null;
  if (!isRoomId(roomId) || !isPeerRef(hostId)) return null;
  return { roomId: roomId.toLowerCase(), hostId };
}

function randomSeed(): number {
  const buffer = new Uint32Array(1);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(buffer);
  } else {
    buffer[0] = Math.floor(Math.random() * 0x100000000);
  }
  return (buffer[0] ?? 0) >>> 0;
}

function normalizeSettings(input: Partial<LobbySettings> | undefined): LobbySettings {
  const base = DEFAULT_LOBBY_SETTINGS;
  const requestedMax = input?.maxPlayers;
  const maxPlayers =
    isInt(requestedMax) && requestedMax >= MIN_LOBBY_PLAYERS
      ? Math.min(MAX_LOBBY_PLAYERS, requestedMax)
      : base.maxPlayers;
  const requestedMoney = input?.startingMoney;
  const startingMoney =
    isFiniteNumber(requestedMoney) && requestedMoney >= 0 && requestedMoney <= MAX_STARTING_MONEY
      ? Math.floor(requestedMoney)
      : base.startingMoney;
  return {
    engine: isLobbyEngine(input?.engine) ? input.engine : base.engine,
    mapSize: isMapSize(input?.mapSize) ? input.mapSize : base.mapSize,
    climate: isClimate(input?.climate) ? input.climate : base.climate,
    difficulty: isAIDifficulty(input?.difficulty) ? input.difficulty : base.difficulty,
    startingMoney,
    maxPlayers,
  };
}

function cloneState(state: LobbyState): LobbyState {
  const copy: LobbyState = {
    roomId: state.roomId,
    hostId: state.hostId,
    name: state.name,
    maxPlayers: state.maxPlayers,
    slots: state.slots.map((slot) => ({ ...slot })),
    settings: { ...state.settings },
    started: state.started,
    closed: state.closed,
  };
  if (state.error !== undefined) copy.error = state.error;
  return copy;
}

function cloneSettings(settings: LobbySettings): LobbySettings {
  return { ...settings };
}

function toStartPlayer(slot: Slot): StartPlayer {
  return {
    player: slot.player,
    id: slot.id,
    name: slot.name,
    colour: slot.colour,
    companyName: slot.companyName,
    ai: slot.ai,
    isHost: slot.isHost,
  };
}

export function createLobby(options: CreateLobbyOptions): Lobby {
  const transport = options.transport;
  const selfId = transport.selfId;
  if (options.selfId !== undefined && options.selfId !== selfId) {
    throw new Error('selfId ne correspond pas à celui du transport');
  }

  const amHost = Boolean(options.isHost);
  const roomId = (options.roomId ?? transport.roomId ?? '').trim();
  if (!roomId) throw new Error('roomId manquant : le lobby ne peut pas être créé');
  if (!isRoomId(roomId)) throw new Error('roomId invalide : 2 à 64 caractères [A-Za-z0-9_-]');
  if (options.hostId !== undefined && !isPeerRef(options.hostId)) {
    throw new Error('hostId invalide');
  }

  const clock = options.now ?? (() => Date.now());
  const isPublic = Boolean(options.isPublic);
  const directory = options.directory;
  const settings = normalizeSettings(options.settings);
  const displayName = sanitizeName(options.name, amHost ? 'Ma partie' : 'Joueur', MAX_SLOT_NAME);
  const lobbyName = sanitizeName(options.name, 'Partie sans nom', MAX_LOBBY_NAME);
  const createdAt = clock();

  const state: LobbyState = {
    roomId,
    hostId: amHost ? selfId : (options.hostId ?? ''),
    name: lobbyName,
    maxPlayers: settings.maxPlayers,
    slots: [],
    settings,
    started: false,
    closed: false,
  };

  let lastError: string | undefined;
  let hostId = state.hostId;
  let closed = false;
  let joinAttempts = 0;
  let aiSeq = 0;
  let sent = 0;
  let received = 0;
  let rejected = 0;
  /** Client-side display name, re-sent once the host slot is known. */
  let preferredName = displayName;
  let profileSynced = false;

  const changeHandlers = new Set<(snapshot: LobbyState) => void>();
  const startHandlers = new Set<(info: StartInfo) => void>();
  const chatHandlers = new Set<(event: LobbyChatEvent) => void>();
  const errorHandlers = new Set<(message: string) => void>();

  function safeCall<T extends unknown[]>(fn: (...args: T) => void, ...args: T): void {
    try {
      fn(...args);
    } catch (error) {
      console.error('[net:lobby] handler error', error);
    }
  }

  function snapshotState(): LobbyState {
    const snapshot = cloneState(state);
    if (lastError !== undefined) snapshot.error = lastError;
    return snapshot;
  }

  function emitChange(): void {
    const snapshot = snapshotState();
    for (const fn of [...changeHandlers]) safeCall(fn, snapshot);
  }

  function emitStart(info: StartInfo): void {
    for (const fn of [...startHandlers]) safeCall(fn, info);
  }

  function emitChat(event: LobbyChatEvent): void {
    for (const fn of [...chatHandlers]) safeCall(fn, event);
  }

  function emitError(message: string): void {
    lastError = message;
    for (const fn of [...errorHandlers]) safeCall(fn, message);
  }

  function fail(message: string): void {
    emitError(message);
    emitChange();
  }

  function send(channel: string, message: object, target?: string | string[]): void {
    sent += 1;
    transport.send(channel, { v: LOBBY_PROTOCOL_VERSION, ...message }, target);
  }

  function slotIndexById(id: string): number {
    return state.slots.findIndex((slot) => slot.id === id);
  }

  function hostSlot(): Slot | undefined {
    return state.slots.find((slot) => slot.isHost);
  }

  function selfSlot(): Slot | undefined {
    return state.slots.find((slot) => slot.id === selfId);
  }

  function freePlayerIndex(): number {
    const used = new Set(state.slots.map((slot) => slot.player));
    for (let player = 0; player < MAX_LOBBY_PLAYERS; player++) {
      if (!used.has(player)) return player;
    }
    for (let player = 0; player < 64; player++) {
      if (!used.has(player)) return player;
    }
    return -1;
  }

  function publishDirectory(): void {
    if (!amHost || directory === undefined || !isPublic || state.closed) return;
    let status: LobbyStatus = 'open';
    if (state.started) status = 'started';
    else if (state.slots.length >= state.maxPlayers) status = 'full';
    const info: LobbyInfo = {
      roomId,
      name: state.name,
      hostPeerId: selfId,
      players: state.slots.length,
      max: state.maxPlayers,
      status,
      version: LOBBY_DIRECTORY_VERSION,
      created: createdAt,
      updatedAt: clock(),
    };
    directory.publish(info);
  }

  function broadcastState(): void {
    if (!amHost || closed) return;
    send(LOBBY_CHANNELS.state, { k: 'state', state: cloneState(state) });
  }

  /** Host side: broadcast state, refresh the directory entry, notify the UI. */
  function commit(): void {
    if (closed) return;
    lastError = undefined;
    broadcastState();
    publishDirectory();
    emitChange();
  }

  function canMutate(): boolean {
    if (closed || state.closed) {
      fail('Le salon est fermé.');
      return false;
    }
    if (state.started) {
      fail('La partie a déjà démarré.');
      return false;
    }
    return true;
  }

  function createSlot(
    id: string,
    player: number,
    colour: number,
    name: string,
    host: boolean,
    ai: AIDifficulty | null,
  ): Slot {
    return {
      id,
      player,
      name: sanitizeName(name, `Joueur ${player + 1}`, MAX_SLOT_NAME),
      colour,
      companyName: '',
      ready: host || ai !== null,
      isHost: host,
      ai,
      connected: true,
    };
  }

  // --------------------------------------------------------------- host slots

  if (amHost) {
    state.slots.push(createSlot(selfId, 0, 0, displayName, true, null));
  }

  function addHumanSlot(peerId: string, name?: string): Slot | null {
    if (state.started || state.closed) return null;
    const existing = slotIndexById(peerId);
    if (existing >= 0) return state.slots[existing] ?? null;
    if (state.slots.length >= state.maxPlayers) return null;
    const player = freePlayerIndex();
    const colour = freeColour(state.slots);
    if (player < 0 || colour < 0) return null;
    const slot = createSlot(
      peerId,
      player,
      colour,
      sanitizeName(name, `Joueur ${player + 1}`, MAX_SLOT_NAME),
      false,
      null,
    );
    state.slots.push(slot);
    return slot;
  }

  function rejectPeer(peerId: string, reason: string): void {
    if (peerId === selfId) return;
    send(LOBBY_CHANNELS.kick, { k: 'kick', reason }, peerId);
  }

  /** Refuses an intent without closing the room (colour taken, invalid value). */
  function sendError(peerId: string, message: string): void {
    if (peerId === selfId) return;
    send(LOBBY_CHANNELS.error, { k: 'error', message }, peerId);
  }

  function removeSlotAt(index: number, notify: boolean): void {
    if (!amHost) {
      fail('Action réservée à l’hôte.');
      return;
    }
    if (!canMutate()) return;
    const slot = state.slots[index];
    if (!slot) return;
    if (slot.isHost) {
      fail('L’hôte ne peut pas être retiré du salon.');
      return;
    }
    if (notify && !slot.ai) {
      rejectPeer(slot.id, 'Vous avez été retiré du salon.');
    }
    state.slots.splice(index, 1);
    commit();
  }

  // --------------------------------------------------------------- messages

  function handleJoin(data: unknown, from: string): void {
    if (!amHost || from === selfId || !isLobbyJoinMessage(data)) return;
    received += 1;
    if (closed || state.closed) return;
    if (state.started) {
      rejectPeer(from, 'La partie a déjà démarré.');
      return;
    }
    const index = slotIndexById(from);
    let slot = index >= 0 ? state.slots[index] : undefined;
    if (!slot) {
      slot = addHumanSlot(from, data.name) ?? undefined;
      if (!slot) {
        rejectPeer(from, 'Le salon est complet.');
        return;
      }
    }
    slot.name = sanitizeName(data.name, slot.name, MAX_SLOT_NAME);
    slot.connected = true;
    commit();
  }

  function handleSlotUpdate(data: unknown, from: string): void {
    if (!amHost || !isLobbySlotMessage(data)) {
      if (!isLobbySlotMessage(data)) rejected += 1;
      return;
    }
    received += 1;
    if (!canMutate()) return;
    const index = slotIndexById(from);
    const slot = index >= 0 ? state.slots[index] : undefined;
    if (!slot || slot.isHost) return;
    if (data.name !== undefined) {
      slot.name = sanitizeName(data.name, slot.name, MAX_SLOT_NAME);
    }
    if (data.companyName !== undefined) {
      slot.companyName = sanitizeName(data.companyName, '', MAX_COMPANY_NAME);
    }
    if (data.ready !== undefined) {
      slot.ready = data.ready;
    }
    if (data.colour !== undefined) {
      const taken = state.slots.some((item) => item !== slot && item.colour === data.colour);
      if (taken) {
        sendError(slot.id, 'Cette couleur est déjà prise.');
        return;
      }
      slot.colour = data.colour;
    }
    commit();
  }

  function relayChat(slot: Slot, text: string): void {
    const clean = sanitizeChat(text);
    if (!clean) return;
    send(LOBBY_CHANNELS.chat, {
      k: 'chat',
      text: clean,
      player: slot.player,
      name: slot.name,
    });
    emitChat({ player: slot.player, name: slot.name, text: clean, at: clock() });
  }

  function handleChat(data: unknown, from: string): void {
    if (closed) return;
    if (!amHost) {
      if (hostId && from !== hostId) return;
      if (!isLobbyChatMessage(data)) {
        rejected += 1;
        return;
      }
      received += 1;
      const author =
        data.player === undefined
          ? undefined
          : state.slots.find((slot) => slot.player === data.player);
      emitChat({
        player: data.player ?? author?.player ?? 0,
        name: author?.name ?? sanitizeName(data.name, 'Joueur', MAX_SLOT_NAME),
        text: sanitizeChat(data.text),
        at: clock(),
      });
      return;
    }
    if (!isLobbyChatMessage(data)) {
      rejected += 1;
      return;
    }
    received += 1;
    const index = slotIndexById(from);
    const slot = index >= 0 ? state.slots[index] : undefined;
    if (!slot) return;
    relayChat(slot, data.text);
  }

  function handleStart(data: unknown, from: string): void {
    if (amHost || !isLobbyStartMessage(data)) {
      if (!isLobbyStartMessage(data)) rejected += 1;
      return;
    }
    received += 1;
    if (hostId && from !== hostId) return;
    hostId = from;
    state.hostId = from;
    let localPlayer: number | undefined;
    for (const [index, peer] of Object.entries(data.peers)) {
      if (peer === selfId) localPlayer = Number(index);
    }
    if (localPlayer === undefined) {
      closeLocal('L’hôte ne vous a pas attribué de place.');
      return;
    }
    state.started = true;
    state.settings = cloneSettings(data.settings);
    state.maxPlayers = data.settings.maxPlayers;
    const payload: StartPayload = {
      seed: data.seed,
      settings: cloneSettings(data.settings),
      engineBuild: data.engineBuild,
      players: data.players.map((player) => ({ ...player })),
      peers: { ...data.peers },
    };
    emitChange();
    emitStart({
      ...payload,
      localPlayer,
      isHost: false,
      transport,
    });
  }

  function handleState(data: unknown, from: string): void {
    if (amHost || !isLobbyStateMessage(data)) {
      if (!isLobbyStateMessage(data)) rejected += 1;
      return;
    }
    received += 1;
    const incoming = data.state;
    const expected = hostId || from;
    if (from !== expected || incoming.hostId !== from) return;
    if (incoming.roomId !== roomId) return;
    hostId = from;
    if (incoming.closed) {
      closeLocal(incoming.error ?? 'Le salon est fermé.');
      return;
    }
    state.hostId = from;
    state.name = incoming.name;
    state.maxPlayers = incoming.maxPlayers;
    state.slots = incoming.slots.map((slot) => ({ ...slot }));
    state.settings = cloneSettings(incoming.settings);
    state.started = incoming.started;
    state.closed = false;
    if (state.started && selfSlot() === undefined) {
      closeLocal('La partie a démarré sans vous.');
      return;
    }
    if (!state.started && selfSlot() === undefined) {
      if (joinAttempts < MAX_REJOIN_ATTEMPTS) {
        joinAttempts += 1;
        sendJoin();
      } else {
        closeLocal('Le salon ne vous a pas attribué de place.');
        return;
      }
    } else if (!state.started && !profileSynced && selfSlot() !== undefined) {
      // The host may have created our slot from the transport presence alone
      // (deep link opened in two tabs): send our profile once it exists.
      profileSynced = true;
      if (selfSlot()?.name !== preferredName) sendSlotUpdate({ name: preferredName });
    }
    lastError = undefined;
    emitChange();
  }

  function handleClosed(data: unknown, from: string): void {
    if (amHost || !isLobbyClosedMessage(data)) {
      if (!isLobbyClosedMessage(data)) rejected += 1;
      return;
    }
    if (hostId && from !== hostId) return;
    closeLocal(data.reason ?? 'L’hôte a fermé le salon.');
  }

  function handleKick(data: unknown, from: string): void {
    if (amHost || !isLobbyKickMessage(data)) {
      if (!isLobbyKickMessage(data)) rejected += 1;
      return;
    }
    if (hostId && from !== hostId) return;
    closeLocal(data.reason ?? 'Vous avez été retiré du salon.');
  }

  function handleError(data: unknown, from: string): void {
    if (amHost || !isLobbyErrorMessage(data)) {
      if (!isLobbyErrorMessage(data)) rejected += 1;
      return;
    }
    if (hostId && from !== hostId) return;
    emitError(data.message);
    emitChange();
  }

  function closeLocal(reason: string): void {
    if (closed) return;
    closed = true;
    state.closed = true;
    lastError = reason;
    emitError(reason);
    emitChange();
    transport.leave();
  }

  function sendJoin(): void {
    if (closed || amHost) return;
    send(
      LOBBY_CHANNELS.join,
      { k: 'join', name: selfSlot()?.name ?? displayName },
      hostId || undefined,
    );
  }

  function sendSlotUpdate(patch: Record<string, unknown>): void {
    if (closed) return;
    if (state.started) {
      fail('La partie a déjà démarré.');
      return;
    }
    send(LOBBY_CHANNELS.slot, { k: 'slot', ...patch }, hostId || undefined);
  }

  // --------------------------------------------------------------- presence

  function onPeerJoin(peerId: string): void {
    if (closed) return;
    if (amHost) {
      if (state.started) {
        rejectPeer(peerId, 'La partie a déjà démarré.');
        return;
      }
      if (slotIndexById(peerId) >= 0) return;
      if (state.slots.length >= state.maxPlayers) {
        rejectPeer(peerId, 'Le salon est complet.');
        return;
      }
      addHumanSlot(peerId);
      commit();
      return;
    }
    if (!hostId || peerId === hostId) {
      joinAttempts += 1;
      sendJoin();
    }
  }

  function onPeerLeave(peerId: string): void {
    if (closed) return;
    if (amHost) {
      const index = slotIndexById(peerId);
      if (index < 0) return;
      const slot = state.slots[index];
      if (!slot || slot.isHost) return;
      if (state.started) {
        slot.connected = false;
        commit();
        return;
      }
      state.slots.splice(index, 1);
      commit();
      return;
    }
    if (hostId && peerId === hostId) {
      closeLocal('L’hôte a quitté le salon.');
    }
  }

  // --------------------------------------------------------------- wiring

  transport.on(LOBBY_CHANNELS.state, (data, from) => handleState(data, from));
  transport.on(LOBBY_CHANNELS.join, (data, from) => handleJoin(data, from));
  transport.on(LOBBY_CHANNELS.slot, (data, from) => handleSlotUpdate(data, from));
  transport.on(LOBBY_CHANNELS.chat, (data, from) => handleChat(data, from));
  transport.on(LOBBY_CHANNELS.start, (data, from) => handleStart(data, from));
  transport.on(LOBBY_CHANNELS.closed, (data, from) => handleClosed(data, from));
  transport.on(LOBBY_CHANNELS.kick, (data, from) => handleKick(data, from));
  transport.on(LOBBY_CHANNELS.error, (data, from) => handleError(data, from));
  transport.onPeerJoin(onPeerJoin);
  transport.onPeerLeave(onPeerLeave);
  transport.onError((message) => {
    emitError(message);
  });

  if (amHost) {
    // Peers may have connected before the host created its lobby (deep link
    // loaded in two tabs at once): give them a slot right away.
    let added = false;
    for (const peer of transport.peers()) {
      if (state.slots.length >= state.maxPlayers) break;
      if (addHumanSlot(peer)) added = true;
    }
    if (added) commit();
    else publishDirectory();
  } else {
    sendJoin();
  }

  // --------------------------------------------------------------- public API

  function setName(name: string): void {
    if (closed) return;
    const clean = sanitizeName(name, selfSlot()?.name ?? displayName, MAX_SLOT_NAME);
    preferredName = clean;
    if (amHost) {
      const slot = selfSlot();
      if (!slot) return;
      slot.name = clean;
      commit();
      return;
    }
    sendSlotUpdate({ name: clean });
  }

  function setReady(ready: boolean): void {
    if (closed) return;
    if (amHost) {
      // The host is implicitly ready: its start depends on the others only.
      return;
    }
    sendSlotUpdate({ ready: Boolean(ready) });
  }

  function setColour(colour: number): void {
    if (closed) return;
    if (!isInt(colour) || colour < 0 || colour >= LOBBY_COLOURS) {
      fail('Couleur invalide.');
      return;
    }
    if (amHost) {
      const index = state.slots.findIndex((slot) => slot.isHost);
      if (index >= 0) setSlotColour(index, colour);
      return;
    }
    sendSlotUpdate({ colour });
  }

  function setCompanyName(name: string): void {
    if (closed) return;
    const clean = sanitizeName(name, '', MAX_COMPANY_NAME);
    if (amHost) {
      const slot = selfSlot();
      if (!slot) return;
      slot.companyName = clean;
      commit();
      return;
    }
    sendSlotUpdate({ companyName: clean });
  }

  function addAI(difficulty: AIDifficulty): void {
    if (!amHost) {
      fail('Action réservée à l’hôte.');
      return;
    }
    if (!isAIDifficulty(difficulty)) {
      fail('Difficulté d’IA invalide.');
      return;
    }
    if (!canMutate()) return;
    if (state.slots.length >= state.maxPlayers) {
      fail('Le salon est complet.');
      return;
    }
    const player = freePlayerIndex();
    const colour = freeColour(state.slots);
    if (player < 0 || colour < 0) {
      fail('Plus de place disponible.');
      return;
    }
    aiSeq += 1;
    state.slots.push(createSlot(`ai-${aiSeq}`, player, colour, `IA ${aiSeq}`, false, difficulty));
    commit();
  }

  function removeSlot(index: number): void {
    removeSlotAt(index, true);
  }

  function kick(index: number): void {
    removeSlotAt(index, true);
  }

  function setSlotColour(index: number, colour: number): void {
    if (!amHost) {
      fail('Action réservée à l’hôte.');
      return;
    }
    if (!canMutate()) return;
    const slot = state.slots[index];
    if (!slot) return;
    if (!isInt(colour) || colour < 0 || colour >= LOBBY_COLOURS) {
      fail('Couleur invalide.');
      return;
    }
    if (state.slots.some((item) => item !== slot && item.colour === colour)) {
      fail('Cette couleur est déjà prise.');
      return;
    }
    if (slot.colour === colour) return;
    slot.colour = colour;
    commit();
  }

  function setSettings(partial: Partial<LobbySettings>): void {
    if (!amHost) {
      fail('Action réservée à l’hôte.');
      return;
    }
    if (!canMutate()) return;
    const next = cloneSettings(state.settings);
    if (partial.engine !== undefined) {
      if (!isLobbyEngine(partial.engine)) {
        fail('Moteur de partie invalide.');
        return;
      }
      next.engine = partial.engine;
    }
    if (partial.mapSize !== undefined) {
      if (!isMapSize(partial.mapSize)) {
        fail('Taille de carte invalide.');
        return;
      }
      next.mapSize = partial.mapSize;
    }
    if (partial.climate !== undefined) {
      if (!isClimate(partial.climate)) {
        fail('Climat invalide.');
        return;
      }
      next.climate = partial.climate;
    }
    if (partial.difficulty !== undefined) {
      if (!isAIDifficulty(partial.difficulty)) {
        fail('Difficulté invalide.');
        return;
      }
      next.difficulty = partial.difficulty;
    }
    if (partial.startingMoney !== undefined) {
      const money = partial.startingMoney;
      if (!isFiniteNumber(money) || money < 0 || money > MAX_STARTING_MONEY) {
        fail('Capital de départ invalide.');
        return;
      }
      next.startingMoney = Math.floor(money);
    }
    if (partial.maxPlayers !== undefined) {
      const max = partial.maxPlayers;
      if (!isInt(max) || max < MIN_LOBBY_PLAYERS || max > MAX_LOBBY_PLAYERS) {
        fail('Nombre de joueurs invalide (2 à 8).');
        return;
      }
      if (max < state.slots.length) {
        fail('Trop de joueurs déjà présents pour cette limite.');
        return;
      }
      next.maxPlayers = max;
    }
    state.settings = next;
    state.maxPlayers = next.maxPlayers;
    commit();
  }

  function start(): void {
    if (!amHost) {
      fail('Seul l’hôte peut démarrer la partie.');
      return;
    }
    if (!canMutate()) return;
    if (state.slots.length < MIN_LOBBY_PLAYERS) {
      fail('Il faut au moins deux participants pour démarrer (IA incluse).');
      return;
    }
    const waiting = state.slots.filter(
      (slot) => !slot.isHost && slot.ai === null && (!slot.ready || !slot.connected),
    );
    if (waiting.length > 0) {
      fail(`En attente de : ${waiting.map((slot) => slot.name).join(', ')}.`);
      return;
    }

    const seed = isFiniteNumber(options.seed) ? options.seed >>> 0 : randomSeed();
    const players = [...state.slots].sort((a, b) => a.player - b.player).map(toStartPlayer);
    const peers: StartPeers = {};
    for (const slot of state.slots) {
      if (slot.ai === null) peers[slot.player] = slot.id;
    }

    state.started = true;
    const payload: StartPayload = {
      seed,
      settings: cloneSettings(state.settings),
      engineBuild: engineBuildId(state.settings.engine),
      players,
      peers,
    };
    send(LOBBY_CHANNELS.start, { k: 'start', ...payload });
    publishDirectory();
    broadcastState();
    emitChange();

    const localPlayer = hostSlot()?.player ?? 0;
    emitStart({ ...payload, localPlayer, isHost: true, transport });
  }

  function sendChat(text: string): void {
    if (closed) return;
    const clean = sanitizeChat(text);
    if (!clean) return;
    if (amHost) {
      const slot = selfSlot();
      if (slot) relayChat(slot, clean);
      return;
    }
    if (!hostId) {
      fail('Connexion à l’hôte en cours…');
      return;
    }
    send(LOBBY_CHANNELS.chat, { k: 'chat', text: clean }, hostId);
  }

  function leave(): void {
    if (closed) {
      transport.leave();
      return;
    }
    if (amHost) {
      state.closed = true;
      closed = true;
      send(LOBBY_CHANNELS.closed, { k: 'closed', reason: 'L’hôte a fermé le salon.' });
      if (directory && isPublic) directory.unpublish(roomId);
      emitChange();
      transport.leave();
      return;
    }
    closed = true;
    state.closed = true;
    emitChange();
    transport.leave();
  }

  function diagnostics(): LobbyDiagnostics {
    const result: LobbyDiagnostics = {
      role: amHost ? 'host' : 'client',
      roomId,
      selfId,
      hostId,
      isPublic,
      maxPlayers: state.maxPlayers,
      slots: state.slots.length,
      humans: state.slots.filter((slot) => slot.ai === null).length,
      ai: state.slots.filter((slot) => slot.ai !== null).length,
      connected: state.slots.filter((slot) => slot.connected).length,
      started: state.started,
      closed: closed || state.closed,
      sent,
      received,
      rejected,
      peers: transport.peers().length,
    };
    if (lastError !== undefined) result.lastError = lastError;
    if (directory) result.directory = directory.diagnostics();
    return result;
  }

  const lobby: Lobby = {
    get state() {
      return snapshotState();
    },
    isHost: amHost,
    selfId,
    onChange(fn) {
      if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
      changeHandlers.add(fn);
      return () => {
        changeHandlers.delete(fn);
      };
    },
    onStart(fn) {
      if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
      startHandlers.add(fn);
      return () => {
        startHandlers.delete(fn);
      };
    },
    onChat(fn) {
      if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
      chatHandlers.add(fn);
      return () => {
        chatHandlers.delete(fn);
      };
    },
    onError(fn) {
      if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
      errorHandlers.add(fn);
      return () => {
        errorHandlers.delete(fn);
      };
    },
    setName,
    setReady,
    setColour,
    setCompanyName,
    addAI,
    removeSlot,
    kick,
    setSlotColour,
    setSettings,
    start,
    sendChat,
    leave,
    diagnostics,
  };

  // Detach everything when the transport itself goes away (host closing the
  // tab, page navigation, explicit transport.leave from the caller).
  return lobby;
}
