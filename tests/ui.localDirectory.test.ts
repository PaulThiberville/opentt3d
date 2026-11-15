import { afterEach, describe, expect, it } from 'vitest';
import type { Directory, LobbyInfo } from '../src/net/directory';
import { createLocalDirectory } from '../src/ui/localDirectory';
import { waitFor } from './net/helpers';

const directories: Directory[] = [];

function uniqueChannel(): string {
  return `opentt3d:test-dir-${Math.random().toString(36).slice(2, 12)}`;
}

function announcement(roomId: string, now: number, players = 1): LobbyInfo {
  return {
    roomId,
    name: 'Partie test',
    hostPeerId: 'host-peer-0001',
    players,
    max: 4,
    status: 'open',
    version: 1,
    created: now,
    updatedAt: now,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) directory.close();
});

describe('annuaire local (BroadcastChannel)', () => {
  it('publie une partie visible par un second onglet et la retire', async () => {
    const channelName = uniqueChannel();
    const now = 1_000;
    const host = createLocalDirectory({ channelName, now: () => now });
    const reader = createLocalDirectory({ channelName, now: () => now });
    directories.push(host, reader);

    const snapshots: LobbyInfo[][] = [];
    reader.subscribe((lobbies) => snapshots.push(lobbies));
    expect(snapshots[0]).toEqual([]);

    host.publish(announcement('abcd-efgh', now));
    await waitFor(() => (snapshots.at(-1) ?? []).some((lobby) => lobby.roomId === 'abcd-efgh'));
    const seen = (snapshots.at(-1) ?? []).find((lobby) => lobby.roomId === 'abcd-efgh');
    expect(seen?.players).toBe(1);
    expect(host.diagnostics().entries).toBe(1);
    expect(host.diagnostics().published).toBe(1);

    host.unpublish('abcd-efgh');
    await waitFor(() => (snapshots.at(-1) ?? []).length === 0);
    expect(host.diagnostics().entries).toBe(0);
  });

  it('expire une annonce distante sans heartbeat et accepte la mise à jour', async () => {
    const channelName = uniqueChannel();
    const hostNow = 1_000;
    let readerNow = 1_000;
    const host = createLocalDirectory({ channelName, now: () => hostNow });
    const reader = createLocalDirectory({
      channelName,
      now: () => readerNow,
      heartbeatMs: 1_000,
      ttlMs: 2_000,
    });
    directories.push(host, reader);
    const snapshots: LobbyInfo[][] = [];
    reader.subscribe((lobbies) => snapshots.push(lobbies));

    host.publish(announcement('wxyz-2345', hostNow));
    await waitFor(() => (snapshots.at(-1) ?? []).length === 1);

    readerNow = 4_000;
    reader.tick();
    expect((snapshots.at(-1) ?? []).length).toBe(0);

    host.publish(announcement('wxyz-2345', hostNow, 2));
    await waitFor(() => (snapshots.at(-1) ?? [])[0]?.players === 2);
  });
});
