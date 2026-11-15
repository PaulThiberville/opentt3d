/**
 * Annuaire local pour `?net=local`.
 *
 * L'annuaire mémoire de `src/net/directory.ts` ne partage rien entre deux
 * onglets (`WeakMap` locale au processus JavaScript). Le mode local utilise
 * donc un annuaire de développement au-dessus de `BroadcastChannel`, avec la
 * même sémantique visible que l'annuaire Nostr : annonces horodatées,
 * heartbeat, expiration et tombstones.
 *
 * Ce n'est pas un backend : tout reste entre les onglets du même navigateur.
 */

import type { Directory, DirectoryDiagnostics, LobbyInfo } from '../net/directory';
import { DIRECTORY_HEARTBEAT_MS, DIRECTORY_TTL_MS, isLobbyInfo } from '../net/directory';

const DEFAULT_CHANNEL = 'opentt3d:directory-v1';

type DirectoryMessage =
  | { t: 'pub'; info: LobbyInfo }
  | { t: 'unpub'; roomId: string }
  | { t: 'query' }
  | { t: 'offers'; entries: LobbyInfo[] };

export interface LocalDirectoryOptions {
  channelName?: string;
  heartbeatMs?: number;
  ttlMs?: number;
  now?: () => number;
}

interface StoredAnnouncement {
  info: LobbyInfo;
  expiresAt: number;
  lastPublishAt: number;
}

function isMessage(value: unknown): value is DirectoryMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { t?: unknown };
  return (
    message.t === 'pub' || message.t === 'unpub' || message.t === 'query' || message.t === 'offers'
  );
}

export function createLocalDirectory(options: LocalDirectoryOptions = {}): Directory {
  if (typeof BroadcastChannel !== 'function') {
    throw new Error(
      'BroadcastChannel est indisponible : utilisez Trystero ou le mode mémoire pour l’annuaire local.',
    );
  }

  const clock = options.now ?? (() => Date.now());
  const heartbeatMs = Math.max(1000, options.heartbeatMs ?? DIRECTORY_HEARTBEAT_MS);
  const ttlMs = Math.max(heartbeatMs * 2, options.ttlMs ?? DIRECTORY_TTL_MS);
  const channel = new BroadcastChannel(options.channelName ?? DEFAULT_CHANNEL);
  const entries = new Map<string, StoredAnnouncement>();
  const owned = new Map<string, StoredAnnouncement>();
  const subscribers = new Set<(lobbies: LobbyInfo[]) => void>();
  let closed = false;
  let heartbeats = 0;
  let received = 0;
  let rejected = 0;
  let lastError: string | undefined;

  function snapshot(): LobbyInfo[] {
    const now = clock();
    const result: LobbyInfo[] = [];
    for (const entry of entries.values()) {
      if (entry.expiresAt <= now) continue;
      if (entry.info.status === 'closed') continue;
      result.push({ ...entry.info, mine: owned.has(entry.info.roomId) });
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt || a.roomId.localeCompare(b.roomId));
    return result;
  }

  function notify(): void {
    if (closed || subscribers.size === 0) return;
    const list = snapshot();
    for (const fn of [...subscribers]) {
      try {
        fn(list);
      } catch (error) {
        console.error('[ui:local-directory] subscriber error', error);
      }
    }
  }

  function post(message: DirectoryMessage): void {
    if (closed) return;
    try {
      channel.postMessage(message);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  function store(info: LobbyInfo, at: number): void {
    if (!isLobbyInfo(info) || info.status === 'closed') return;
    entries.set(info.roomId, {
      info: { ...info, mine: undefined },
      expiresAt: at + ttlMs,
      lastPublishAt: at,
    });
    notify();
  }

  function onMessage(event: MessageEvent): void {
    if (closed) return;
    const message: unknown = event.data;
    if (!isMessage(message)) {
      rejected += 1;
      return;
    }
    received += 1;
    if (message.t === 'pub') {
      if (!isLobbyInfo(message.info)) {
        rejected += 1;
        return;
      }
      store(message.info, clock());
      return;
    }
    if (message.t === 'unpub') {
      if (entries.delete(message.roomId)) notify();
      return;
    }
    if (message.t === 'query') {
      const offers: LobbyInfo[] = [];
      for (const entry of owned.values()) offers.push(entry.info);
      if (offers.length > 0) post({ t: 'offers', entries: offers });
      return;
    }
    if (!Array.isArray(message.entries)) {
      rejected += 1;
      return;
    }
    for (const info of message.entries) {
      if (!isLobbyInfo(info)) {
        rejected += 1;
        continue;
      }
      store(info, clock());
    }
  }

  channel.onmessage = onMessage;
  post({ t: 'query' });

  function publish(info: LobbyInfo): void {
    if (closed) return;
    if (!isLobbyInfo(info)) {
      lastError = 'Annonce de partie invalide.';
      return;
    }
    if (info.status === 'closed') {
      unpublish(info.roomId);
      return;
    }
    const at = clock();
    const stored: StoredAnnouncement = {
      info: {
        ...info,
        players: Math.max(0, Math.min(info.max, Math.floor(info.players))),
        created: Math.max(0, Math.floor(info.created)),
        updatedAt: Math.max(at, Math.floor(info.updatedAt)),
      },
      expiresAt: at + ttlMs,
      lastPublishAt: at,
    };
    owned.set(info.roomId, stored);
    entries.set(info.roomId, stored);
    post({ t: 'pub', info: stored.info });
    notify();
  }

  function unpublish(roomId?: string): void {
    if (closed) return;
    const targets = roomId === undefined ? [...owned.keys()] : [roomId];
    for (const target of targets) {
      owned.delete(target);
      entries.delete(target);
      post({ t: 'unpub', roomId: target });
    }
    notify();
  }

  function tick(nowMs?: number): void {
    if (closed) return;
    const now = nowMs === undefined ? clock() : Math.max(0, nowMs);
    let changed = false;
    for (const [roomId, entry] of [...entries]) {
      if (entry.expiresAt <= now) {
        entries.delete(roomId);
        changed = true;
      }
    }
    for (const [roomId, entry] of [...owned]) {
      if (now - entry.lastPublishAt < heartbeatMs) continue;
      const refreshed: StoredAnnouncement = {
        info: { ...entry.info, updatedAt: Math.max(entry.info.updatedAt, now) },
        expiresAt: now + ttlMs,
        lastPublishAt: now,
      };
      owned.set(roomId, refreshed);
      entries.set(roomId, refreshed);
      post({ t: 'pub', info: refreshed.info });
      heartbeats += 1;
      changed = true;
    }
    if (changed) notify();
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
    for (const roomId of [...owned.keys()]) post({ t: 'unpub', roomId });
    owned.clear();
    entries.clear();
    closed = true;
    subscribers.clear();
    channel.onmessage = null;
    channel.close();
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (!options.now) {
    timer = setInterval(() => tick(), 1000);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  }

  return {
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
    diagnostics(): DirectoryDiagnostics {
      const result: DirectoryDiagnostics = {
        kind: 'memory',
        relays: [],
        version: 1,
        heartbeatMs,
        ttlMs,
        subscribers: subscribers.size,
        published: owned.size,
        entries: snapshot().length,
        heartbeats,
        received,
        rejected,
      };
      if (lastError !== undefined) result.lastError = lastError;
      return result;
    },
  };
}
