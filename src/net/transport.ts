/**
 * Transport abstraction for OpenTT3D.
 *
 * Three implementations share one tiny API:
 *  - `memory`  — in-process bus for tests (injectable latency and packet loss);
 *  - `local`   — BroadcastChannel between tabs of the same browser (`?net=local`);
 *  - `trystero` — WebRTC data channels, Nostr public relays for signalling.
 *
 * The transport is deliberately dumb: it delivers opaque JSON values on named
 * channels, it does not know about commands or lockstep. Validation (channel
 * names, JSON serialisability, 256 KiB cap, per-peer rate limit) happens here
 * so a malformed or hostile peer cannot crash or flood the game.
 *
 * There is no application server and no secret of any kind: the only external
 * dependency is the set of public Nostr relays used for WebRTC signalling.
 */

import { joinRoom } from 'trystero';
import type { DataPayload, MessageAction, Room } from 'trystero';
import {
  MAX_MESSAGE_BYTES,
  isChannelName,
} from './types.js';

export type TransportKind = 'trystero' | 'local' | 'memory';

export interface Transport {
  readonly selfId: string;
  readonly kind: TransportKind;
  peers(): string[];
  send(channel: string, data: unknown, target?: string | string[]): void;
  on(channel: string, fn: (data: unknown, peerId: string) => void): () => void;
  onPeerJoin(fn: (peerId: string) => void): () => void;
  onPeerLeave(fn: (peerId: string) => void): () => void;
  /** UI-facing errors are French strings. */
  onError(fn: (message: string) => void): () => void;
  ping(peerId: string): Promise<number>;
  leave(): void;
}

export interface RateLimitOptions {
  /** How many messages a peer may send in a burst. */
  burst?: number;
  /** Sustained messages per second and per peer. */
  perSecond?: number;
}

export interface MemoryTransportOptions {
  /** Explicit bus, to isolate a test from the global per-room bus. */
  bus?: MemoryBus;
  /** One-way delivery delay in milliseconds (0 = synchronous). */
  latencyMs?: number;
  /** Packet loss probability, 0..1. */
  loss?: number;
  /** Deterministic RNG for loss tests (defaults to Math.random). */
  random?: () => number;
}

export interface LocalTransportOptions {
  heartbeatMs?: number;
  peerTimeoutMs?: number;
  pingTimeoutMs?: number;
  /** Opened by the caller to drive timers in tests. */
  now?: () => number;
}

export interface CreateTransportOptions {
  kind: TransportKind;
  roomId: string;
  appId?: string;
  relays?: string[];
  password?: string;
  memory?: MemoryTransportOptions;
  local?: LocalTransportOptions;
  rateLimit?: RateLimitOptions;
}

const DEFAULT_APP_ID = 'opentt3d';
const DEFAULT_RATE_LIMIT: Required<RateLimitOptions> = {
  // A lockstep host can legitimately emit several hundred turns per second of
  // simulated time, so the default is generous. Tests can lower it.
  burst: 8192,
  perSecond: 20000,
};
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_PEER_TIMEOUT_MS = 10000;
const DEFAULT_PING_TIMEOUT_MS = 5000;

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomId(length = 20): string {
  const bytes = new Uint8Array(length);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += ID_CHARS[byte % ID_CHARS.length] ?? '0';
  }
  return out;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function textBytes(value: string): number {
  return typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(value).byteLength
    : value.length * 2;
}

interface RateLimiter {
  allow(peerId: string): boolean;
}

function createRateLimit(options: RateLimitOptions | undefined): RateLimiter {
  const burst = Math.max(1, Math.floor(options?.burst ?? DEFAULT_RATE_LIMIT.burst));
  const perSecond = Math.max(
    0.001,
    options?.perSecond ?? DEFAULT_RATE_LIMIT.perSecond,
  );
  const buckets = new Map<string, { tokens: number; last: number }>();

  return {
    allow(peerId) {
      const now = nowMs();
      let bucket = buckets.get(peerId);
      if (!bucket) {
        bucket = { tokens: burst, last: now };
        buckets.set(peerId, bucket);
      }
      const elapsed = Math.max(0, now - bucket.last) / 1000;
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * perSecond);
      bucket.last = now;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

interface Registry {
  on(channel: string, fn: (data: unknown, peerId: string) => void): () => void;
  hasChannel(channel: string): boolean;
  dispatch(channel: string, data: unknown, peerId: string): void;
  onPeerJoin(fn: (peerId: string) => void): () => void;
  onPeerLeave(fn: (peerId: string) => void): () => void;
  onError(fn: (message: string) => void): () => void;
  emitJoin(peerId: string): void;
  emitLeave(peerId: string): void;
  emitError(message: string): void;
  clear(): void;
}

function createRegistry(label: string): Registry {
  const channels = new Map<string, Set<(data: unknown, peerId: string) => void>>();
  const joins = new Set<(peerId: string) => void>();
  const leaves = new Set<(peerId: string) => void>();
  const errors = new Set<(message: string) => void>();

  function safeCall<T extends unknown[]>(fn: (...args: T) => void, ...args: T): void {
    try {
      fn(...args);
    } catch (error) {
      console.error(`[net:${label}] handler error`, error);
    }
  }

  function subscribe<T>(set: Set<T>, fn: T): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  return {
    on(channel, fn) {
      if (!isChannelName(channel)) {
        throw new TypeError(`Nom de canal invalide : ${String(channel)}`);
      }
      if (channel === 'sys') {
        throw new TypeError('Le canal « sys » est réservé au transport');
      }
      let handlers = channels.get(channel);
      if (!handlers) {
        handlers = new Set();
        channels.set(channel, handlers);
      }
      return subscribe(handlers, fn);
    },
    hasChannel(channel) {
      return channels.has(channel);
    },
    dispatch(channel, data, peerId) {
      const handlers = channels.get(channel);
      if (!handlers) return;
      for (const fn of [...handlers]) safeCall(fn, data, peerId);
    },
    onPeerJoin: (fn) => subscribe(joins, fn),
    onPeerLeave: (fn) => subscribe(leaves, fn),
    onError: (fn) => subscribe(errors, fn),
    emitJoin(peerId) {
      for (const fn of [...joins]) safeCall(fn, peerId);
    },
    emitLeave(peerId) {
      for (const fn of [...leaves]) safeCall(fn, peerId);
    },
    emitError(message) {
      if (errors.size === 0) console.warn(`[net:${label}] ${message}`);
      for (const fn of [...errors]) safeCall(fn, message);
    },
    clear() {
      channels.clear();
      joins.clear();
      leaves.clear();
      errors.clear();
    },
  };
}

/** Serialises and validates an outbound payload. Returns null on refusal. */
function preparePayload(
  reg: Registry,
  channel: string,
  data: unknown,
): string | null {
  let raw: string;
  try {
    raw = JSON.stringify(data);
  } catch {
    reg.emitError('Message impossible à sérialiser en JSON.');
    return null;
  }
  if (typeof raw !== 'string') {
    reg.emitError('Le message doit être sérialisable en JSON.');
    return null;
  }
  const bytes = textBytes(raw);
  if (bytes > MAX_MESSAGE_BYTES) {
    reg.emitError(
      `Message trop volumineux (${bytes} octets, limite ${MAX_MESSAGE_BYTES}).`,
    );
    return null;
  }
  return raw;
}

function normalizeTargets(target: string | string[] | undefined): string[] | null {
  if (target === undefined) return null;
  if (typeof target === 'string') return target ? [target] : [];
  if (Array.isArray(target)) {
    return target.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Memory transport — one process, injectable latency/loss

/** Opaque bus handle returned by `createMemoryBus()`. */
export interface MemoryBus {
  readonly id: string;
}

interface MemoryEndpoint {
  id: string;
  receive(raw: string): void;
  notifyJoin(peerId: string): void;
  notifyLeave(peerId: string): void;
  closed: boolean;
}

const memoryBuses = new WeakMap<MemoryBus, Set<MemoryEndpoint>>();
const defaultBuses = new Map<string, MemoryBus>();
let busSeq = 0;

/** Creates an isolated in-memory bus (tests, deterministic scenarios). */
export function createMemoryBus(): MemoryBus {
  const bus: MemoryBus = { id: `bus-${++busSeq}` };
  memoryBuses.set(bus, new Set());
  return bus;
}

function getMemoryBus(roomKey: string, explicit: MemoryBus | undefined): MemoryBus {
  if (explicit) {
    if (!memoryBuses.has(explicit)) memoryBuses.set(explicit, new Set());
    return explicit;
  }
  let bus = defaultBuses.get(roomKey);
  if (!bus) {
    bus = createMemoryBus();
    defaultBuses.set(roomKey, bus);
  }
  return bus;
}

interface Envelope {
  f: string;
  k:
    | 'hello'
    | 'here'
    | 'hb'
    | 'bye'
    | 'ping'
    | 'pong'
    | 'm';
  c?: string;
  d?: unknown;
  t?: string | string[];
  n?: number;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { f?: unknown }).f === 'string' &&
    typeof (value as { k?: unknown }).k === 'string'
  );
}

function targetMatches(target: string | string[] | undefined, selfId: string): boolean {
  if (target === undefined) return true;
  if (Array.isArray(target)) return target.includes(selfId);
  return target === selfId;
}

function createMemoryTransport(
  selfId: string,
  roomKey: string,
  options: MemoryTransportOptions | undefined,
  rateLimit: RateLimiter,
): Transport {
  const reg = createRegistry('memory');
  const bus = getMemoryBus(roomKey, options?.bus);
  const foundMembers = memoryBuses.get(bus);
  if (!foundMembers) throw new Error('Bus mémoire invalide');
  const members: Set<MemoryEndpoint> = foundMembers;

  const latency = Math.max(0, options?.latencyMs ?? 0);
  const loss = Math.min(1, Math.max(0, options?.loss ?? 0));
  const random = options?.random ?? Math.random;
  const pings = new Map<
    number,
    {
      peer: string;
      start: number;
      timer: ReturnType<typeof setTimeout>;
      resolve: (ms: number) => void;
    }
  >();
  let pingSeq = 0;
  let closed = false;
  let lastRateError = -Infinity;

  const endpoint: MemoryEndpoint = {
    id: selfId,
    closed: false,
    notifyJoin(peerId) {
      if (!closed) reg.emitJoin(peerId);
    },
    notifyLeave(peerId) {
      if (!closed) reg.emitLeave(peerId);
    },
    receive(raw) {
      if (closed) return;
      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isEnvelope(envelope) || envelope.f === selfId) return;
      if (textBytes(raw) > MAX_MESSAGE_BYTES + 1024) return;
      if (envelope.k === 'm') {
        if (typeof envelope.c !== 'string' || !reg.hasChannel(envelope.c)) return;
        if (!targetMatches(envelope.t, selfId)) return;
        if (!rateLimit.allow(envelope.f)) {
          const now = nowMs();
          if (now - lastRateError > 1000) {
            lastRateError = now;
            reg.emitError(`Débit de messages trop élevé (pair ${envelope.f}).`);
          }
          return;
        }
        reg.dispatch(envelope.c, envelope.d, envelope.f);
        return;
      }
      if (envelope.k === 'ping' && typeof envelope.n === 'number') {
        deliver({
          f: selfId,
          k: 'pong',
          t: envelope.f,
          n: envelope.n,
        });
        return;
      }
      if (envelope.k === 'pong' && typeof envelope.n === 'number') {
        const pending = pings.get(envelope.n);
        if (pending && pending.peer === envelope.f) {
          pings.delete(envelope.n);
          clearTimeout(pending.timer);
          pending.resolve(Math.max(0, nowMs() - pending.start));
        }
      }
    },
  };

  function sendToEndpoint(target: MemoryEndpoint, raw: string): void {
    if (target.closed) return;
    if (latency <= 0) {
      target.receive(raw);
      return;
    }
    setTimeout(() => target.receive(raw), latency);
  }

  function deliver(envelope: Envelope): void {
    if (closed) return;
    const raw = JSON.stringify(envelope);
    for (const target of [...members]) {
      if (target.id === selfId) continue;
      if (!targetMatches(envelope.t, target.id)) continue;
      if (loss > 0 && random() < loss) continue;
      sendToEndpoint(target, raw);
    }
  }

  // Existing peers learn about the newcomer; the newcomer reads `peers()`.
  for (const other of members) other.notifyJoin(selfId);
  members.add(endpoint);

  return {
    kind: 'memory',
    selfId,
    peers: () => [...members].filter((e) => e.id !== selfId && !e.closed).map((e) => e.id),
    send(channel, data, target) {
      if (closed) return;
      if (!isChannelName(channel)) {
        throw new TypeError(`Nom de canal invalide : ${String(channel)}`);
      }
      const targets = normalizeTargets(target);
      if (targets && targets.length === 0) return;
      const raw = preparePayload(reg, channel, data);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as unknown;
      const envelope: Envelope = { f: selfId, k: 'm', c: channel, d: parsed };
      if (targets) envelope.t = targets.length === 1 ? targets[0] : targets;
      deliver(envelope);
    },
    on: reg.on,
    onPeerJoin: reg.onPeerJoin,
    onPeerLeave: reg.onPeerLeave,
    onError: reg.onError,
    ping(peerId) {
      if (closed) return Promise.reject(new Error('Transport fermé'));
      const target = [...members].find((e) => e.id === peerId && !e.closed);
      if (!target) return Promise.reject(new Error(`Pair inconnu : ${peerId}`));
      return new Promise<number>((resolve) => {
        const nonce = ++pingSeq;
        const timer = setTimeout(() => {
          const pending = pings.get(nonce);
          if (pending) {
            pings.delete(nonce);
            pending.resolve(-1);
          }
        }, Math.max(1000, latency * 4));
        pings.set(nonce, { peer: peerId, start: nowMs(), timer, resolve });
        deliver({ f: selfId, k: 'ping', t: peerId, n: nonce });
      });
    },
    leave() {
      if (closed) return;
      closed = true;
      endpoint.closed = true;
      members.delete(endpoint);
      for (const other of [...members]) other.notifyLeave(selfId);
      for (const pending of pings.values()) {
        clearTimeout(pending.timer);
        pending.resolve(-1);
      }
      pings.clear();
      reg.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Local transport — BroadcastChannel between tabs

function createLocalTransport(
  selfId: string,
  roomKey: string,
  rateLimit: RateLimiter,
  options: LocalTransportOptions | undefined,
): Transport {
  if (typeof BroadcastChannel !== 'function') {
    throw new Error(
      'BroadcastChannel est indisponible dans cet environnement : utilisez le mode mémoire ou Trystero.',
    );
  }

  const reg = createRegistry('local');
  const clock = options?.now ?? nowMs;
  const heartbeatMs = Math.max(50, options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const peerTimeoutMs = Math.max(
    heartbeatMs * 2,
    options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS,
  );
  const pingTimeoutMs = Math.max(1000, options?.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS);

  const channel = new BroadcastChannel(`opentt3d:${roomKey}`);
  const peers = new Map<string, number>(); // peerId -> last seen
  const pings = new Map<
    number,
    {
      peer: string;
      start: number;
      timer: ReturnType<typeof setTimeout>;
      resolve: (ms: number) => void;
      reject: (error: Error) => void;
    }
  >();
  let pingSeq = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let lastRateError = -Infinity;

  function post(envelope: Envelope): void {
    if (closed) return;
    channel.postMessage(envelope);
  }

  function addPeer(peerId: string): void {
    peers.set(peerId, clock());
    reg.emitJoin(peerId);
  }

  function dropPeer(peerId: string): void {
    if (!peers.delete(peerId)) return;
    for (const [nonce, pending] of [...pings]) {
      if (pending.peer !== peerId) continue;
      clearTimeout(pending.timer);
      pings.delete(nonce);
      pending.reject(new Error('Le pair a quitté la partie'));
    }
    reg.emitLeave(peerId);
  }

  function onMessage(event: MessageEvent): void {
    if (closed) return;
    const envelope: unknown = event.data;
    if (!isEnvelope(envelope) || envelope.f === selfId) return;
    try {
      if (textBytes(JSON.stringify(envelope)) > MAX_MESSAGE_BYTES + 4096) return;
    } catch {
      return;
    }
    const from = envelope.f;
    if (envelope.k === 'bye') {
      dropPeer(from);
      return;
    }
    if (peers.has(from)) peers.set(from, clock());
    else addPeer(from);
    if (closed) return;

    if (envelope.k === 'hello') {
      post({ f: selfId, k: 'here', t: from });
      return;
    }
    if (envelope.k === 'ping' && typeof envelope.n === 'number') {
      post({ f: selfId, k: 'pong', t: from, n: envelope.n });
      return;
    }
    if (envelope.k === 'pong' && typeof envelope.n === 'number') {
      const pending = pings.get(envelope.n);
      if (pending && pending.peer === from) {
        clearTimeout(pending.timer);
        pings.delete(envelope.n);
        pending.resolve(Math.max(0, clock() - pending.start));
      }
      return;
    }
    if (envelope.k === 'm') {
      if (typeof envelope.c !== 'string' || !reg.hasChannel(envelope.c)) return;
      if (!targetMatches(envelope.t, selfId)) return;
      if (!rateLimit.allow(from)) {
        const now = clock();
        if (now - lastRateError > 1000) {
          lastRateError = now;
          reg.emitError(`Débit de messages trop élevé (pair ${from}).`);
        }
        return;
      }
      reg.dispatch(envelope.c, envelope.d, from);
    }
  }

  function heartbeat(): void {
    post({ f: selfId, k: 'hb' });
    const now = clock();
    for (const [peerId, seen] of [...peers]) {
      if (now - seen > peerTimeoutMs) dropPeer(peerId);
    }
  }

  channel.onmessage = onMessage;

  let onPageHide: (() => void) | null = null;
  if (typeof addEventListener === 'function' && typeof window !== 'undefined') {
    onPageHide = () => transport.leave();
    addEventListener('pagehide', onPageHide);
  }

  post({ f: selfId, k: 'hello' });
  heartbeatTimer = setInterval(heartbeat, heartbeatMs);

  const transport: Transport = {
    kind: 'local',
    selfId,
    peers: () => [...peers.keys()],
    send(channelName, data, target) {
      if (closed) return;
      if (!isChannelName(channelName)) {
        throw new TypeError(`Nom de canal invalide : ${String(channelName)}`);
      }
      const targets = normalizeTargets(target);
      if (targets && targets.length === 0) return;
      const raw = preparePayload(reg, channelName, data);
      if (raw === null) return;
      const envelope: Envelope = {
        f: selfId,
        k: 'm',
        c: channelName,
        d: JSON.parse(raw) as unknown,
      };
      if (targets) envelope.t = targets.length === 1 ? targets[0] : targets;
      post(envelope);
    },
    on: reg.on,
    onPeerJoin: reg.onPeerJoin,
    onPeerLeave: reg.onPeerLeave,
    onError: reg.onError,
    ping(peerId) {
      if (closed) return Promise.reject(new Error('Transport fermé'));
      if (!peers.has(peerId)) {
        return Promise.reject(new Error(`Pair inconnu : ${peerId}`));
      }
      return new Promise<number>((resolve, reject) => {
        const nonce = ++pingSeq;
        const timer = setTimeout(() => {
          pings.delete(nonce);
          reject(new Error('Délai de ping dépassé'));
        }, pingTimeoutMs);
        pings.set(nonce, { peer: peerId, start: clock(), timer, resolve, reject });
        post({ f: selfId, k: 'ping', t: peerId, n: nonce });
      });
    },
    leave() {
      if (closed) return;
      post({ f: selfId, k: 'bye' });
      closed = true;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      for (const pending of pings.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Transport fermé'));
      }
      pings.clear();
      peers.clear();
      reg.clear();
      if (onPageHide) removeEventListener('pagehide', onPageHide);
      try {
        channel.onmessage = null;
        channel.close();
      } catch {
        // already closed
      }
    },
  };

  return transport;
}

// ---------------------------------------------------------------------------
// Trystero transport — WebRTC + Nostr public relays

interface PhysicalPeer {
  physicalId: string;
  logicalId: string;
}

function createTrysteroTransport(
  selfId: string,
  roomId: string,
  appId: string,
  rateLimit: RateLimiter,
  options: CreateTransportOptions,
): Transport {
  const reg = createRegistry('trystero');
  const config: Parameters<typeof joinRoom>[0] = { appId, maxReceiveBytes: MAX_MESSAGE_BYTES };
  if (options.password) config.password = options.password;
  if (options.relays && options.relays.length > 0) {
    config.relayConfig = { urls: options.relays };
  }

  const room: Room = joinRoom(config, roomId);
  const actions = new Map<string, MessageAction<DataPayload>>();
  const physicalToLogical = new Map<string, string>();
  const logicalToPhysical = new Map<string, string>();
  const peers = new Set<string>();
  let closed = false;
  let lastRateError = -Infinity;

  const sysAction = room.makeAction('sys') as MessageAction<DataPayload>;
  sysAction.onMessage((data, context) => {
    if (closed) return;
    const value = data as { k?: unknown; id?: unknown } | null;
    if (!value || value.k !== 'hi' || typeof value.id !== 'string' || !value.id) return;
    registerPeer(context.peerId, value.id);
  });

  function registerPeer(physicalId: string, logicalId: string): void {
    if (closed || logicalId === selfId) return;
    const previous = physicalToLogical.get(physicalId);
    if (previous && previous !== logicalId) {
      physicalToLogical.delete(physicalId);
      logicalToPhysical.delete(previous);
      peers.delete(previous);
      reg.emitLeave(previous);
    }
    if (!peers.has(logicalId)) {
      physicalToLogical.set(physicalId, logicalId);
      logicalToPhysical.set(logicalId, physicalId);
      peers.add(logicalId);
      reg.emitJoin(logicalId);
    }
  }

  function sayHello(physicalId?: string): void {
    if (closed) return;
    const payload = { k: 'hi', id: selfId };
    void Promise.resolve(
      sysAction.send(payload as DataPayload, physicalId ? { target: physicalId } : undefined),
    ).catch(() => {
      // The peer may have disconnected between join and handshake.
    });
  }

  function ensureAction(channelName: string): MessageAction<DataPayload> {
    let action = actions.get(channelName);
    if (action) return action;
    action = room.makeAction(channelName) as MessageAction<DataPayload>;
    action.onMessage((data, context) => {
      if (closed) return;
      const logicalId = physicalToLogical.get(context.peerId);
      if (!logicalId) return;
      let bytes: number;
      try {
        bytes = textBytes(JSON.stringify(data));
      } catch {
        return;
      }
      if (bytes > MAX_MESSAGE_BYTES + 1024) return;
      if (!rateLimit.allow(logicalId)) {
        const now = nowMs();
        if (now - lastRateError > 1000) {
          lastRateError = now;
          reg.emitError(`Débit de messages trop élevé (pair ${logicalId}).`);
        }
        return;
      }
      reg.dispatch(channelName, data, logicalId);
    });
    action.onReceive((context) => !closed && context.byteLength <= MAX_MESSAGE_BYTES);
    actions.set(channelName, action);
    return action;
  }

  const offJoin = room.onPeerJoin((context) => {
    if (closed) return;
    sayHello(context.peerId);
  });
  const offLeave = room.onPeerLeave((context) => {
    const logicalId = physicalToLogical.get(context.peerId);
    physicalToLogical.delete(context.peerId);
    if (!logicalId) return;
    logicalToPhysical.delete(logicalId);
    if (peers.delete(logicalId)) reg.emitLeave(logicalId);
  });
  const offError = room.onError((error) => {
    const message = typeof error?.message === 'string' ? error.message : 'erreur inconnue';
    reg.emitError(`Connexion à un pair impossible (${message}).`);
  });

  // Announce ourselves to peers that connected before our handlers existed.
  void room.ready
    .then(() => {
      for (const physicalId of Object.keys(room.getPeers())) sayHello(physicalId);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      reg.emitError(`Connexion au salon impossible (${message}).`);
    });

  const transport: Transport = {
    kind: 'trystero',
    selfId,
    peers: () => [...peers],
    send(channelName, data, target) {
      if (closed) return;
      if (!isChannelName(channelName)) {
        throw new TypeError(`Nom de canal invalide : ${String(channelName)}`);
      }
      const targets = normalizeTargets(target);
      if (targets && targets.length === 0) return;
      const raw = preparePayload(reg, channelName, data);
      if (raw === null) return;
      const payload = JSON.parse(raw) as unknown;
      let physicalTarget: string | string[] | undefined;
      if (targets) {
        const resolved = targets
          .map((logicalId) => logicalToPhysical.get(logicalId))
          .filter((id): id is string => typeof id === 'string');
        if (resolved.length === 0) return;
        physicalTarget = resolved.length === 1 ? resolved[0] : resolved;
      }
      const action = ensureAction(channelName);
      void Promise.resolve(
        action.send(payload as DataPayload, physicalTarget ? { target: physicalTarget } : undefined),
      ).catch((error: unknown) => {
        if (closed) return;
        const message = error instanceof Error ? error.message : String(error);
        reg.emitError(`Envoi impossible sur le canal « ${channelName} » (${message}).`);
      });
    },
    on(channelName, fn) {
      const off = reg.on(channelName, fn);
      ensureAction(channelName);
      return off;
    },
    onPeerJoin: reg.onPeerJoin,
    onPeerLeave: reg.onPeerLeave,
    onError: reg.onError,
    ping(peerId) {
      if (closed) return Promise.reject(new Error('Transport fermé'));
      const physicalId = logicalToPhysical.get(peerId);
      if (!physicalId) return Promise.reject(new Error(`Pair inconnu : ${peerId}`));
      return Promise.resolve(room.ping(physicalId));
    },
    leave() {
      if (closed) return;
      closed = true;
      offJoin();
      offLeave();
      offError();
      peers.clear();
      physicalToLogical.clear();
      logicalToPhysical.clear();
      actions.clear();
      reg.clear();
      void Promise.resolve(room.leave()).catch(() => {
        // Closing a room that never connected is not an error worth surfacing.
      });
    },
  };

  return transport;
}

// ---------------------------------------------------------------------------
// Factory

export function createTransport(options: CreateTransportOptions): Transport {
  const roomId = typeof options.roomId === 'string' ? options.roomId.trim() : '';
  if (!roomId) throw new Error('roomId manquant');
  if (roomId.length > 128) throw new Error('roomId trop long (128 caractères maximum)');

  const appId =
    typeof options.appId === 'string' && options.appId.trim()
      ? options.appId.trim()
      : DEFAULT_APP_ID;
  const roomKey = `${appId}:${roomId}`;
  const selfId = randomId(20);
  const rateLimit = createRateLimit(options.rateLimit);

  switch (options.kind) {
    case 'memory':
      return createMemoryTransport(selfId, roomKey, options.memory, rateLimit);
    case 'local':
      return createLocalTransport(selfId, roomKey, rateLimit, options.local);
    case 'trystero':
      return createTrysteroTransport(selfId, roomId, appId, rateLimit, options);
    default:
      throw new Error(`Type de transport inconnu : ${String(options.kind)}`);
  }
}
