import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryBus,
  createTransport,
  describeTransportError,
  type Transport,
} from '../../src/net/transport.js';
import { MAX_MESSAGE_BYTES } from '../../src/net/types.js';
import { wait, waitFor } from './helpers.js';

const opened: Transport[] = [];

function make(
  roomId: string,
  kind: 'memory' | 'local',
  extra: Record<string, unknown> = {},
): Transport {
  const transport = createTransport({ kind, roomId, ...extra });
  opened.push(transport);
  return transport;
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.leave();
});

describe('messages d’erreur réseau (#39)', () => {
  it('ajoute une piste NAT ou relais selon la cause', () => {
    expect(describeTransportError('peer', 'ICE connection failed')).toMatch(/NAT|pare-feu/i);
    expect(describeTransportError('room', 'relay websocket closed')).toMatch(
      /relais Nostr|relays=/i,
    );
    expect(describeTransportError('send', 'channel closed', 'turn')).toMatch(/canal « turn »/);
  });
});

describe('transport mémoire', () => {
  it('découvre les pairs, émet join/leave et expose selfId', () => {
    const room = `mem-join-${Math.random()}`;
    const a = make(room, 'memory');
    const joined: string[] = [];
    const left: string[] = [];
    a.onPeerJoin((peer) => joined.push(peer));

    const b = make(room, 'memory');
    expect(a.peers()).toContain(b.selfId);
    expect(b.peers()).toContain(a.selfId);
    expect(joined).toContain(b.selfId);

    a.onPeerLeave((peer) => left.push(peer));
    b.leave();
    expect(left).toContain(b.selfId);
    expect(a.peers()).not.toContain(b.selfId);
  });

  it('livre un message ciblé au seul destinataire', () => {
    const room = `mem-target-${Math.random()}`;
    const a = make(room, 'memory');
    const b = make(room, 'memory');
    const c = make(room, 'memory');
    const gotB: unknown[] = [];
    const gotC: unknown[] = [];
    b.on('game', (data) => gotB.push(data));
    c.on('game', (data) => gotC.push(data));

    a.send('game', { hello: 'b' }, b.selfId);
    expect(gotB).toEqual([{ hello: 'b' }]);
    expect(gotC).toEqual([]);

    a.send('game', { hello: 'all' });
    expect(gotB).toHaveLength(2);
    expect(gotC).toHaveLength(1);
  });

  it('applique la latence injectée', async () => {
    const room = `mem-latency-${Math.random()}`;
    const bus = createMemoryBus();
    const a = make(room, 'memory', { memory: { bus, latencyMs: 40 } });
    const b = make(room, 'memory', { memory: { bus } });
    const received: unknown[] = [];
    b.on('game', (data) => received.push(data));

    a.send('game', { n: 1 });
    await wait(10);
    expect(received).toHaveLength(0);
    await wait(60);
    expect(received).toEqual([{ n: 1 }]);
  });

  it('perd les messages quand la perte est à 100 %', async () => {
    const room = `mem-loss-${Math.random()}`;
    const bus = createMemoryBus();
    const a = make(room, 'memory', { memory: { bus, loss: 1, random: () => 0 } });
    const b = make(room, 'memory', { memory: { bus } });
    const received: unknown[] = [];
    b.on('game', (data) => received.push(data));

    a.send('game', { n: 1 });
    await wait(20);
    expect(received).toHaveLength(0);
  });

  it('rejette les canaux invalides et remonte les erreurs de format', () => {
    const room = `mem-invalid-${Math.random()}`;
    const a = make(room, 'memory');
    const b = make(room, 'memory');
    const senderErrors: string[] = [];
    a.onError((message) => senderErrors.push(message));
    b.onError(() => {});
    b.on('game', () => {});

    expect(() => a.send('bad channel!', {})).toThrow(/canal invalide/i);
    a.send('game', { bigint: 1n });
    a.send('game', 'x'.repeat(MAX_MESSAGE_BYTES + 10));
    expect(senderErrors.join(' ')).toMatch(/sérialiser|volumineux/i);
  });

  it('limite le débit par pair', () => {
    const room = `mem-rate-${Math.random()}`;
    const a = make(room, 'memory');
    const b = make(room, 'memory', {
      rateLimit: { burst: 3, perSecond: 0.001 },
    });
    const errors: string[] = [];
    const received: unknown[] = [];
    b.onError((message) => errors.push(message));
    b.on('game', (data) => received.push(data));

    for (let i = 0; i < 10; i++) a.send('game', { i });
    expect(received.length).toBeLessThanOrEqual(3);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('répond au ping', async () => {
    const room = `mem-ping-${Math.random()}`;
    const a = make(room, 'memory');
    const b = make(room, 'memory');
    const rtt = await a.ping(b.selfId);
    expect(rtt).toBeGreaterThanOrEqual(0);
    await expect(a.ping('inconnu')).rejects.toThrow(/inconnu/i);
  });
});

describe('transport local (BroadcastChannel)', () => {
  it('fait parler deux instances du même onglet', async () => {
    if (typeof BroadcastChannel !== 'function') return;
    const room = `local-${Math.random()}`;
    const a = make(room, 'local');
    const b = make(room, 'local');
    const received: unknown[] = [];
    b.on('game', (data) => received.push(data));

    await waitFor(() => a.peers().includes(b.selfId) && b.peers().includes(a.selfId));
    a.send('game', { hello: 'local' });
    await waitFor(() => received.length === 1);

    b.send('game', { targeted: true }, a.selfId);
    await waitFor(() => a.peers().includes(b.selfId));
    expect(await a.ping(b.selfId)).toBeGreaterThanOrEqual(0);
  });

  it('nettoie les pairs après un départ', async () => {
    if (typeof BroadcastChannel !== 'function') return;
    const room = `local-leave-${Math.random()}`;
    const a = make(room, 'local');
    const b = make(room, 'local');
    await waitFor(() => a.peers().includes(b.selfId) && b.peers().includes(a.selfId));

    b.leave();
    await waitFor(() => !a.peers().includes(b.selfId), 2000);
    expect(a.peers()).not.toContain(b.selfId);
  });

  it('expire un pair silencieux après le timeout de heartbeat', async () => {
    if (typeof BroadcastChannel !== 'function') return;
    const room = `local-expire-${Math.random()}`;
    const a = make(room, 'local', {
      local: { heartbeatMs: 40, peerTimeoutMs: 120 },
    });
    const raw = new BroadcastChannel(`opentt3d:opentt3d:${room}`);
    try {
      raw.postMessage({ f: 'ghost-peer', k: 'hello' });
      await waitFor(() => a.peers().includes('ghost-peer'), 1000);
      await waitFor(() => !a.peers().includes('ghost-peer'), 2000);
    } finally {
      raw.close();
    }
  });
});
