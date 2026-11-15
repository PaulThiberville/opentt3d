/**
 * Public lobby directory (issue #36).
 *
 * A lobby announces itself with a NIP-78 replaceable event (kind 30078) on
 * public Nostr relays — no application server, no account:
 *
 *   tags:    ['d', 'opentt3d:<roomId>']
 *            ['t', 'opentt3d-lobby-v1']
 *            ['expiration', <unix seconds>]
 *   content: JSON LobbyInfo
 *
 * The host republishes every 20 s (heartbeat) and on every meaningful change;
 * it publishes `status: 'closed'` when it leaves. Readers subscribe with
 * `{ kinds: [30078], '#t': ['opentt3d-lobby-v1'], since: now - ttl }`, keep the
 * newest event per `d` tag and discard expired, closed or incompatible
 * entries.
 *
 * Keys are ephemeral per session (generated at `createDirectory()`), so an
 * announcement cannot be linked to a previous session.
 *
 * The `memory` backend implements the exact same semantics in-process, with an
 * injectable clock, so the lobby and quick-match flows are testable without
 * any network dependency.
 */

import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { MAX_LOBBY_PLAYERS, isPeerRef, isRoomId, sanitizeName } from './lobby-types.js';
import { isFiniteNumber, isNat, isRecord } from './types.js';

export const LOBBY_DIRECTORY_KIND = 30078;
export const LOBBY_DIRECTORY_TAG = 'opentt3d-lobby-v1';
export const LOBBY_DIRECTORY_VERSION = 1;
/** Republish interval used as a liveness proof. */
export const DIRECTORY_HEARTBEAT_MS = 20_000;
/** Readers ignore announcements older than this. */
export const DIRECTORY_TTL_MS = 120_000;

export const DEFAULT_DIRECTORY_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
];

const D_TAG_PREFIX = 'opentt3d:';
const ROOM_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const MIN_QUICK_MATCH_MS = 0;
const DEFAULT_QUICK_MATCH_MS = 3000;

export type LobbyStatus = 'open' | 'full' | 'started' | 'closed';

/** What a lobby publishes in the directory. */
export interface LobbyInfo {
  roomId: string;
  name: string;
  hostPeerId: string;
  /** Occupied slots, AI included. */
  players: number;
  max: number;
  status: LobbyStatus;
  version: number;
  /** Creation timestamp (ms). */
  created: number;
  /** Last publication timestamp (ms). */
  updatedAt: number;
  /** Set locally when this announcement belongs to the caller. */
  mine?: boolean;
}

export interface DirectoryDiagnostics {
  kind: 'nostr' | 'memory';
  relays: string[];
  version: number;
  heartbeatMs: number;
  ttlMs: number;
  subscribers: number;
  published: number;
  entries: number;
  heartbeats: number;
  received: number;
  rejected: number;
  lastError?: string;
}

export interface Directory {
  /** Called with a sorted snapshot, immediately then on every change. */
  subscribe(fn: (lobbies: LobbyInfo[]) => void): () => void;
  /** Publishes (or replaces) an announcement. Throws nothing; errors via diagnostics. */
  publish(info: LobbyInfo): void;
  /** Publishes `status: 'closed'` and forgets the announcement. */
  unpublish(roomId?: string): void;
  /** Drives heartbeat/expiry. Required with an injected clock, harmless otherwise. */
  tick(nowMs?: number): void;
  close(): void;
  diagnostics(): DirectoryDiagnostics;
}

/** Opaque shared store for the in-process backend (tests). */
export interface MemoryDirectoryStore {
  readonly id: string;
}

export interface DirectoryOptions {
  kind: 'nostr' | 'memory';
  /** Nostr relays; ignored by the memory backend. */
  relays?: string[];
  /** Injected clock (ms). When set, no automatic timer is installed. */
  now?: () => number;
  heartbeatMs?: number;
  ttlMs?: number;
  /** Directory namespace version written in `LobbyInfo.version`. */
  version?: number;
  /** Explicit shared store, to isolate a test. */
  memory?: { store?: MemoryDirectoryStore };
}

export interface QuickMatchOptions {
  timeoutMs?: number;
  /** Used to fill `hostPeerId` when no game is found and we host. */
  selfId?: string;
}

export interface QuickMatchResult {
  roomId: string;
  hostPeerId: string;
  /** True when no public game was found in time and the caller should host. */
  host: boolean;
}

interface StoredLobby {
  info: LobbyInfo;
  /** Wall-clock ms after which the announcement is stale. */
  expiresAt: number;
  /** Nostr pubkey (or memory owner id) that published it. */
  author: string;
  /** Ordering keys for the "newest event per d tag" rule. */
  createdAt: number;
  eventId: string;
}

interface Backend {
  publish(info: LobbyInfo, expiresAt: number, at: number): void;
  remove(roomId: string): void;
  /** Publishes a tombstone; used by `unpublish()`. */
  tombstone(info: LobbyInfo, at: number): void;
  entries(): Iterable<StoredLobby>;
  /** Prunes expired entries; returns true when something was removed. */
  tick(now: number): boolean;
  close(): void;
  counters(): { received: number; rejected: number; lastError: string | undefined };
}

// ---------------------------------------------------------------------------
// Validation

export function isLobbyInfo(value: unknown): value is LobbyInfo {
  if (!isRecord(value)) return false;
  if (!isRoomId(value.roomId)) return false;
  if (typeof value.name !== 'string' || value.name.length > 64) return false;
  if (!isPeerRef(value.hostPeerId)) return false;
  if (!isNat(value.players) || !isNat(value.max)) return false;
  if (value.max < 2 || value.max > MAX_LOBBY_PLAYERS) return false;
  if (value.players > value.max) return false;
  if (
    value.status !== 'open' &&
    value.status !== 'full' &&
    value.status !== 'started' &&
    value.status !== 'closed'
  ) {
    return false;
  }
  if (!isNat(value.version) || value.version < 1) return false;
  if (!isFiniteNumber(value.created) || value.created < 0) return false;
  if (!isFiniteNumber(value.updatedAt) || value.updatedAt < 0) return false;
  if (value.mine !== undefined && typeof value.mine !== 'boolean') return false;
  return true;
}

/**
 * Builds the NIP-78 tags of an announcement. Exported so the wire format can
 * be asserted in tests without any relay.
 */
export function buildLobbyTags(info: LobbyInfo, expiresAtMs: number): string[][] {
  return [
    ['d', `${D_TAG_PREFIX}${info.roomId}`],
    ['t', LOBBY_DIRECTORY_TAG],
    ['expiration', String(Math.ceil(expiresAtMs / 1000))],
  ];
}

function normalizeInfo(info: LobbyInfo, version: number, at: number): LobbyInfo {
  const max = Math.min(MAX_LOBBY_PLAYERS, Math.max(2, Math.floor(info.max)));
  return {
    roomId: info.roomId,
    name: sanitizeName(info.name, 'Partie sans nom', 64),
    hostPeerId: info.hostPeerId,
    players: Math.min(max, Math.max(0, Math.floor(info.players))),
    max,
    status: info.status,
    version,
    created: Math.max(0, Math.floor(info.created)),
    updatedAt: Math.max(at, Math.floor(info.updatedAt)),
  };
}

function sanitizeRelays(relays: readonly string[] | undefined): string[] {
  const source = relays && relays.length > 0 ? relays : DEFAULT_DIRECTORY_RELAYS;
  const seen = new Set<string>();
  for (const relay of source) {
    if (typeof relay !== 'string') continue;
    const trimmed = relay.trim().replace(/\/+$/, '');
    if (!/^wss?:\/\/[^\s]+$/i.test(trimmed)) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void };
  if (typeof candidate.unref === 'function') candidate.unref();
}

function randomId(length = 20): string {
  const bytes = new Uint8Array(length);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let index = 0; index < length; index++) {
    const byte = bytes[index] ?? 0;
    out += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length] ?? '2';
  }
  return out;
}

/** Readable room code, e.g. `k7m2-9qfx` (no ambiguous characters). */
export function newRoomId(): string {
  const raw = randomId(8);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

// ---------------------------------------------------------------------------
// Memory backend

interface MemoryStoreState {
  entries: Map<string, StoredLobby>;
  listeners: Set<() => void>;
}

const memoryStores = new WeakMap<MemoryDirectoryStore, MemoryStoreState>();
let memoryStoreSeq = 0;
let defaultMemoryStore: MemoryDirectoryStore | null = null;

export function createMemoryDirectoryStore(): MemoryDirectoryStore {
  const store: MemoryDirectoryStore = { id: `dir-${++memoryStoreSeq}` };
  memoryStores.set(store, { entries: new Map(), listeners: new Set() });
  return store;
}

function getMemoryStore(explicit: MemoryDirectoryStore | undefined): MemoryStoreState {
  const store = explicit ?? (defaultMemoryStore ??= createMemoryDirectoryStore());
  let state = memoryStores.get(store);
  if (!state) {
    state = { entries: new Map(), listeners: new Set() };
    memoryStores.set(store, state);
  }
  return state;
}

function createMemoryBackend(
  store: MemoryStoreState,
  owner: string,
  onUpdate: () => void,
): Backend {
  const counters = { received: 0, rejected: 0, lastError: undefined as string | undefined };
  const notifyAll = (): void => {
    for (const listener of [...store.listeners]) listener();
  };
  store.listeners.add(onUpdate);

  return {
    publish(info, expiresAt, at) {
      store.entries.set(info.roomId, {
        info,
        expiresAt,
        author: owner,
        createdAt: at,
        eventId: '',
      });
      notifyAll();
    },
    remove(roomId) {
      if (store.entries.delete(roomId)) notifyAll();
    },
    tombstone(info) {
      // In-process backend: a tombstone is simply a removal; there is no
      // remote relay that could still hold the previous announcement.
      if (store.entries.delete(info.roomId)) notifyAll();
    },
    entries() {
      return store.entries.values();
    },
    tick(now) {
      let changed = false;
      for (const [roomId, entry] of [...store.entries]) {
        if (entry.expiresAt <= now) {
          store.entries.delete(roomId);
          changed = true;
        }
      }
      if (changed) notifyAll();
      return changed;
    },
    close() {
      store.listeners.delete(onUpdate);
    },
    counters() {
      return counters;
    },
  };
}

// ---------------------------------------------------------------------------
// Nostr backend

function createNostrBackend(
  relays: string[],
  ttlMs: number,
  version: number,
  clock: () => number,
  onUpdate: () => void,
): Backend {
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  const secretKey = generateSecretKey();
  const ownPubkey = getPublicKey(secretKey);
  const entries = new Map<string, StoredLobby>();
  const counters = { received: 0, rejected: 0, lastError: undefined as string | undefined };

  pool.onRelayConnectionFailure = (url: string) => {
    counters.lastError = `Relais injoignable : ${url}`;
  };

  const sinceSeconds = Math.max(0, Math.ceil(clock() / 1000) - Math.ceil(ttlMs / 1000) - 60);
  const filter: Filter = {
    kinds: [LOBBY_DIRECTORY_KIND],
    '#t': [LOBBY_DIRECTORY_TAG],
    since: sinceSeconds,
  };

  const ingest = (event: Event): void => {
    counters.received += 1;
    if (event.kind !== LOBBY_DIRECTORY_KIND) {
      counters.rejected += 1;
      return;
    }
    const tag = event.tags.find((item) => item[0] === 'd');
    const dTag = tag?.[1];
    if (typeof dTag !== 'string' || !dTag.startsWith(D_TAG_PREFIX)) {
      counters.rejected += 1;
      return;
    }
    const hasNamespace = event.tags.some(
      (item) => item[0] === 't' && item[1] === LOBBY_DIRECTORY_TAG,
    );
    if (!hasNamespace) {
      counters.rejected += 1;
      return;
    }
    const roomId = dTag.slice(D_TAG_PREFIX.length);
    if (!isRoomId(roomId)) {
      counters.rejected += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.content);
    } catch {
      counters.rejected += 1;
      return;
    }
    if (!isLobbyInfo(parsed) || parsed.roomId !== roomId) {
      counters.rejected += 1;
      return;
    }
    if (parsed.version !== version) {
      counters.rejected += 1;
      return;
    }

    const previous = entries.get(roomId);
    if (
      previous &&
      (previous.createdAt > event.created_at * 1000 ||
        (previous.createdAt === event.created_at * 1000 && previous.eventId >= event.id))
    ) {
      return;
    }

    if (parsed.status === 'closed') {
      entries.delete(roomId);
      onUpdate();
      return;
    }

    const expiration = event.tags.find((item) => item[0] === 'expiration')?.[1];
    const expirationSeconds = expiration === undefined ? NaN : Number(expiration);
    const expiresAt = Number.isFinite(expirationSeconds)
      ? expirationSeconds * 1000
      : (event.created_at + Math.ceil(ttlMs / 1000)) * 1000;
    if (expiresAt <= clock()) return;

    entries.set(roomId, {
      info: { ...parsed, mine: undefined, version },
      expiresAt,
      author: event.pubkey,
      createdAt: event.created_at * 1000,
      eventId: event.id,
    });
    onUpdate();
  };

  const subscription = pool.subscribeMany(relays, filter, {
    onevent: ingest,
    onclose: (reasons) => {
      const first = reasons[0]?.reason;
      if (first) counters.lastError = `Abonnement annuaire fermé (${first}).`;
    },
  });

  function sign(info: LobbyInfo, expiresAt: number, at: number): Event {
    const content = JSON.stringify({
      roomId: info.roomId,
      name: info.name,
      hostPeerId: info.hostPeerId,
      players: info.players,
      max: info.max,
      status: info.status,
      version: info.version,
      created: info.created,
      updatedAt: info.updatedAt,
    });
    return finalizeEvent(
      {
        kind: LOBBY_DIRECTORY_KIND,
        created_at: Math.max(0, Math.floor(at / 1000)),
        tags: buildLobbyTags(info, expiresAt),
        content,
      },
      secretKey,
    );
  }

  function broadcast(info: LobbyInfo, expiresAt: number, at: number): void {
    const event = sign(info, expiresAt, at);
    void Promise.allSettled(pool.publish(relays, event)).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected').length;
      if (failures > 0) {
        counters.lastError = `Publication refusée par ${failures} relais sur ${relays.length}.`;
      }
    });
  }

  return {
    publish(info, expiresAt, at) {
      entries.set(info.roomId, {
        info,
        expiresAt,
        author: ownPubkey,
        createdAt: at,
        eventId: '',
      });
      broadcast(info, expiresAt, at);
      onUpdate();
    },
    remove(roomId) {
      if (entries.delete(roomId)) onUpdate();
    },
    tombstone(info, at) {
      const closed: LobbyInfo = {
        ...info,
        status: 'closed',
        updatedAt: Math.max(info.updatedAt, at),
      };
      entries.delete(info.roomId);
      broadcast(closed, at + ttlMs, at);
      onUpdate();
    },
    entries() {
      return entries.values();
    },
    tick(now) {
      let changed = false;
      for (const [roomId, entry] of [...entries]) {
        if (entry.expiresAt <= now) {
          entries.delete(roomId);
          changed = true;
        }
      }
      if (changed) onUpdate();
      return changed;
    },
    close() {
      subscription.close('directory closed');
      // Give pending tombstones a moment to reach the relays before dropping
      // the WebSockets; the timer is unreferenced so it never keeps a process
      // alive.
      const timer = setTimeout(() => pool.destroy(), 1500);
      unrefTimer(timer);
    },
    counters() {
      return counters;
    },
  };
}

// ---------------------------------------------------------------------------
// Directory

export function createDirectory(options: DirectoryOptions): Directory {
  const kind = options.kind;
  const version =
    isNat(options.version) && options.version >= 1 ? options.version : LOBBY_DIRECTORY_VERSION;
  const heartbeatMs = Math.max(
    1000,
    isFiniteNumber(options.heartbeatMs) ? Math.floor(options.heartbeatMs) : DIRECTORY_HEARTBEAT_MS,
  );
  const ttlMs = Math.max(
    heartbeatMs * 2,
    isFiniteNumber(options.ttlMs) ? Math.floor(options.ttlMs) : DIRECTORY_TTL_MS,
  );
  const clock = options.now ?? (() => Date.now());
  const relays = kind === 'nostr' ? sanitizeRelays(options.relays) : [];
  const owner = kind === 'memory' ? `mem-${randomId(12)}` : 'nostr';

  const subscribers = new Set<(lobbies: LobbyInfo[]) => void>();
  const owned = new Map<string, LobbyInfo>();
  const lastPublishAt = new Map<string, number>();
  let closed = false;
  let heartbeats = 0;

  function notify(): void {
    if (closed || subscribers.size === 0) return;
    const list = snapshot();
    for (const fn of [...subscribers]) {
      try {
        fn(list);
      } catch (error) {
        console.error('[net:directory] subscriber error', error);
      }
    }
  }

  let backend: Backend;
  if (kind === 'memory') {
    backend = createMemoryBackend(getMemoryStore(options.memory?.store), owner, notify);
  } else {
    backend = createNostrBackend(relays, ttlMs, version, clock, notify);
  }

  function snapshot(): LobbyInfo[] {
    const now = clock();
    const result: LobbyInfo[] = [];
    for (const entry of backend.entries()) {
      if (entry.expiresAt <= now) continue;
      if (entry.info.status === 'closed') continue;
      if (entry.info.version !== version) continue;
      result.push({ ...entry.info, mine: entry.author === owner });
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt || a.roomId.localeCompare(b.roomId));
    return result;
  }

  function publish(info: LobbyInfo): void {
    if (closed) return;
    if (!isLobbyInfo(info)) {
      backend.counters().lastError = 'Annonce de partie invalide.';
      return;
    }
    const at = clock();
    // The directory owns its namespace version: callers describe the game,
    // the directory stamps the wire version used by its readers.
    const normalized = normalizeInfo(info, version, at);
    if (normalized.status === 'closed') {
      unpublish(normalized.roomId);
      return;
    }
    owned.set(normalized.roomId, normalized);
    lastPublishAt.set(normalized.roomId, at);
    backend.publish(normalized, at + ttlMs, at);
    notify();
  }

  function unpublish(roomId?: string): void {
    if (closed) return;
    const at = clock();
    const targets = roomId === undefined ? [...owned.keys()] : [roomId];
    for (const target of targets) {
      const info = owned.get(target);
      if (info) {
        backend.tombstone({ ...info, updatedAt: Math.max(info.updatedAt, at) }, at);
        owned.delete(target);
        lastPublishAt.delete(target);
      } else {
        backend.remove(target);
      }
    }
    notify();
  }

  function heartbeat(at: number): boolean {
    let published = false;
    for (const [roomId, info] of [...owned]) {
      const last = lastPublishAt.get(roomId) ?? 0;
      if (at - last < heartbeatMs) continue;
      lastPublishAt.set(roomId, at);
      const refreshed: LobbyInfo = {
        ...info,
        updatedAt: Math.max(info.updatedAt, at),
      };
      owned.set(roomId, refreshed);
      backend.publish(refreshed, at + ttlMs, at);
      heartbeats += 1;
      published = true;
    }
    return published;
  }

  function tick(nowMs?: number): void {
    if (closed) return;
    const at = nowMs === undefined ? clock() : Math.max(0, nowMs);
    const pruned = backend.tick(at);
    const republished = heartbeat(at);
    if (pruned || republished) notify();
  }

  function subscribe(fn: (lobbies: LobbyInfo[]) => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    if (closed) {
      fn([]);
      return () => {};
    }
    subscribers.add(fn);
    fn(snapshot());
    return () => {
      subscribers.delete(fn);
    };
  }

  function close(): void {
    if (closed) return;
    for (const roomId of [...owned.keys()]) {
      const info = owned.get(roomId);
      if (info) backend.tombstone(info, clock());
    }
    owned.clear();
    lastPublishAt.clear();
    closed = true;
    subscribers.clear();
    backend.close();
  }

  // In production, drive the heartbeat and expiry. With an injected clock the
  // caller owns time (deterministic tests call `tick()`), so no timer is armed.
  let timer: ReturnType<typeof setInterval> | null = null;
  if (!options.now) {
    timer = setInterval(() => tick(), Math.min(1000, Math.max(250, heartbeatMs / 4)));
    unrefTimer(timer);
  }

  function diagnostics(): DirectoryDiagnostics {
    const counters = backend.counters();
    const result: DirectoryDiagnostics = {
      kind,
      relays: [...relays],
      version,
      heartbeatMs,
      ttlMs,
      subscribers: subscribers.size,
      published: owned.size,
      entries: snapshot().length,
      heartbeats,
      received: counters.received,
      rejected: counters.rejected,
    };
    if (counters.lastError !== undefined) result.lastError = counters.lastError;
    return result;
  }

  const directory: Directory = {
    subscribe,
    publish,
    unpublish,
    tick,
    close() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      close();
    },
    diagnostics,
  };
  return directory;
}

// ---------------------------------------------------------------------------
// Quick match

/**
 * Picks the most populated open game within `timeoutMs`. When none is found,
 * the caller is invited to host a fresh room (`host: true`), whose code is
 * returned; `hostPeerId` is then the caller's `selfId` when provided.
 */
export function quickMatch(
  directory: Directory,
  options: QuickMatchOptions = {},
): Promise<QuickMatchResult> {
  const timeoutMs = isFiniteNumber(options.timeoutMs)
    ? Math.max(MIN_QUICK_MATCH_MS, Math.floor(options.timeoutMs))
    : DEFAULT_QUICK_MATCH_MS;
  const selfId = typeof options.selfId === 'string' ? options.selfId : undefined;

  return new Promise<QuickMatchResult>((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    let pendingCleanup = false;

    const finish = (info: LobbyInfo | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (off) {
        off();
        off = null;
      } else {
        pendingCleanup = true;
      }
      if (info) {
        resolve({ roomId: info.roomId, hostPeerId: info.hostPeerId, host: false });
      } else {
        resolve({ roomId: newRoomId(), hostPeerId: selfId ?? '', host: true });
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    off = directory.subscribe((lobbies) => {
      const candidates = lobbies.filter(
        (info) =>
          info.status === 'open' &&
          info.players < info.max &&
          (selfId === undefined || info.hostPeerId !== selfId),
      );
      candidates.sort((a, b) => b.players - a.players || b.updatedAt - a.updatedAt);
      const best = candidates[0];
      if (best) finish(best);
    });

    if (pendingCleanup) {
      off?.();
      off = null;
    }
  });
}
