import { afterEach, describe, expect, it } from 'vitest';
import {
  DIRECTORY_HEARTBEAT_MS,
  DIRECTORY_TTL_MS,
  LOBBY_DIRECTORY_TAG,
  LOBBY_DIRECTORY_VERSION,
  buildLobbyTags,
  createDirectory,
  createMemoryDirectoryStore,
  isLobbyInfo,
  newRoomId,
  quickMatch,
  type Directory,
  type LobbyInfo,
} from '../../src/net/directory.js';

const opened: Directory[] = [];

function track(directory: Directory): Directory {
  opened.push(directory);
  return directory;
}

function info(roomId: string, overrides: Partial<LobbyInfo> = {}): LobbyInfo {
  return {
    roomId,
    name: `Partie ${roomId}`,
    hostPeerId: `host-${roomId}`,
    players: 1,
    max: 8,
    status: 'open',
    version: LOBBY_DIRECTORY_VERSION,
    created: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('annuaire en mémoire', () => {
  it('partage les annonces entre plusieurs clients du même store', () => {
    const store = createMemoryDirectoryStore();
    const now = () => 1_000_000;
    const host = track(createDirectory({ kind: 'memory', now, memory: { store } }));
    const viewer = track(createDirectory({ kind: 'memory', now, memory: { store } }));

    const hostSnapshots: LobbyInfo[][] = [];
    const viewerSnapshots: LobbyInfo[][] = [];
    host.subscribe((list) => hostSnapshots.push(list));
    viewer.subscribe((list) => viewerSnapshots.push(list));
    expect(viewerSnapshots[0]).toEqual([]);

    host.publish(info('k7m2-9qfx'));
    expect(hostSnapshots.at(-1)).toHaveLength(1);
    expect(hostSnapshots.at(-1)?.[0]?.mine).toBe(true);
    expect(viewerSnapshots.at(-1)?.[0]?.mine).toBe(false);
    expect(viewerSnapshots.at(-1)?.[0]?.roomId).toBe('k7m2-9qfx');
    expect(host.diagnostics().published).toBe(1);
    expect(viewer.diagnostics().entries).toBe(1);
  });

  it('republie au heartbeat et prolonge l’expiration', () => {
    const store = createMemoryDirectoryStore();
    let now = 1_000_000;
    const host = track(createDirectory({ kind: 'memory', now: () => now, memory: { store } }));
    const viewer = track(createDirectory({ kind: 'memory', now: () => now, memory: { store } }));
    const snapshots: LobbyInfo[][] = [];
    viewer.subscribe((list) => snapshots.push(list));

    host.publish(info('k7m2-9qfx'));
    expect(snapshots.at(-1)?.[0]?.updatedAt).toBe(1_000_000);

    now += DIRECTORY_HEARTBEAT_MS - 1;
    host.tick();
    expect(host.diagnostics().heartbeats).toBe(0);
    expect(snapshots.at(-1)?.[0]?.updatedAt).toBe(1_000_000);

    now += 1;
    host.tick();
    expect(host.diagnostics().heartbeats).toBe(1);
    expect(snapshots.at(-1)?.[0]?.updatedAt).toBe(now);
  });

  it('retire les annonces expirées', () => {
    const store = createMemoryDirectoryStore();
    let now = 1_000_000;
    const publisher = track(createDirectory({ kind: 'memory', now: () => now, memory: { store } }));
    const viewer = track(createDirectory({ kind: 'memory', now: () => now, memory: { store } }));
    const snapshots: LobbyInfo[][] = [];
    viewer.subscribe((list) => snapshots.push(list));

    publisher.publish(info('k7m2-9qfx'));
    expect(snapshots.at(-1)).toHaveLength(1);

    now += DIRECTORY_TTL_MS + 1;
    viewer.tick();
    expect(snapshots.at(-1)).toEqual([]);
    expect(viewer.diagnostics().entries).toBe(0);
  });

  it('masque immédiatement une partie fermée', () => {
    const store = createMemoryDirectoryStore();
    const now = () => 1_000_000;
    const host = track(createDirectory({ kind: 'memory', now, memory: { store } }));
    const viewer = track(createDirectory({ kind: 'memory', now, memory: { store } }));
    const snapshots: LobbyInfo[][] = [];
    viewer.subscribe((list) => snapshots.push(list));

    host.publish(info('k7m2-9qfx'));
    expect(snapshots.at(-1)).toHaveLength(1);

    host.unpublish();
    expect(snapshots.at(-1)).toEqual([]);
    expect(host.diagnostics().published).toBe(0);

    host.publish(info('p3xw-8abc', { status: 'closed' }));
    expect(snapshots.at(-1)).toEqual([]);
    expect(host.diagnostics().published).toBe(0);
  });

  it('ignore les annonces d’une autre version', () => {
    const store = createMemoryDirectoryStore();
    const now = () => 1_000_000;
    const v1 = track(createDirectory({ kind: 'memory', now, memory: { store } }));
    const v2 = track(createDirectory({ kind: 'memory', now, memory: { store }, version: 2 }));
    const v1Snapshots: LobbyInfo[][] = [];
    const v2Snapshots: LobbyInfo[][] = [];
    v1.subscribe((list) => v1Snapshots.push(list));
    v2.subscribe((list) => v2Snapshots.push(list));

    v2.publish(info('k7m2-9qfx'));
    expect(v2Snapshots.at(-1)?.[0]?.version).toBe(2);
    expect(v1Snapshots.at(-1)).toEqual([]);
  });

  it('rejette une annonce malformée sans casser le store', () => {
    const directory = track(
      createDirectory({
        kind: 'memory',
        now: () => 1_000_000,
        memory: { store: createMemoryDirectoryStore() },
      }),
    );
    const broken = { roomId: '!!', name: 42 } as unknown as LobbyInfo;
    directory.publish(broken);
    expect(directory.diagnostics().entries).toBe(0);
    expect(directory.diagnostics().lastError).toMatch(/invalide/i);
  });
});

describe('format NIP-78', () => {
  it('expose les tags attendus', () => {
    const tags = buildLobbyTags(info('k7m2-9qfx'), 1_700_000_120_000);
    expect(tags).toContainEqual(['d', 'opentt3d:k7m2-9qfx']);
    expect(tags).toContainEqual(['t', LOBBY_DIRECTORY_TAG]);
    expect(tags).toContainEqual(['expiration', '1700000120']);
  });

  it('produit des codes de salon lisibles', () => {
    const first = newRoomId();
    const second = newRoomId();
    expect(first).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(second).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(first).not.toBe(second);
  });

  it('valide la forme d’une annonce', () => {
    expect(isLobbyInfo(info('k7m2-9qfx'))).toBe(true);
    expect(isLobbyInfo({ ...info('k7m2-9qfx'), max: 1 })).toBe(false);
    expect(isLobbyInfo({ ...info('k7m2-9qfx'), status: 'unknown' })).toBe(false);
    expect(isLobbyInfo({ ...info('k7m2-9qfx'), players: 9 })).toBe(false);
    expect(isLobbyInfo(null)).toBe(false);
  });
});

describe('quickMatch', () => {
  it('choisit la partie ouverte la plus remplie', async () => {
    const store = createMemoryDirectoryStore();
    const now = () => 1_000_000;
    const directory = track(createDirectory({ kind: 'memory', now, memory: { store } }));
    directory.publish(info('k7m2-9qfx', { players: 2 }));
    directory.publish(info('p3xw-8abc', { players: 4 }));

    const result = await quickMatch(directory, { timeoutMs: 100 });
    expect(result).toEqual({
      roomId: 'p3xw-8abc',
      hostPeerId: 'host-p3xw-8abc',
      host: false,
    });
  });

  it('ignore les parties fermées, pleines ou démarrées', async () => {
    const store = createMemoryDirectoryStore();
    const now = () => 1_000_000;
    const directory = track(createDirectory({ kind: 'memory', now, memory: { store } }));
    directory.publish(info('k7m2-9qfx', { status: 'full', players: 8 }));
    directory.publish(info('p3xw-8abc', { status: 'started', players: 2 }));

    const result = await quickMatch(directory, { timeoutMs: 20, selfId: 'SelfPeer1234' });
    expect(result.host).toBe(true);
    expect(result.hostPeerId).toBe('SelfPeer1234');
    expect(result.roomId).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(result.roomId).not.toBe('k7m2-9qfx');
  });

  it('retombe sur un hôte après le délai quand l’annuaire est vide', async () => {
    const directory = track(
      createDirectory({
        kind: 'memory',
        now: () => 1_000_000,
        memory: { store: createMemoryDirectoryStore() },
      }),
    );
    const started = Date.now();
    const result = await quickMatch(directory, { timeoutMs: 30 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(result.host).toBe(true);
    expect(result.hostPeerId).toBe('');
  });
});
