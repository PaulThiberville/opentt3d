import { describe, expect, it } from 'vitest';
import {
  JOIN_CHANNELS,
  JOIN_PROTOCOL_VERSION,
  NET_PROTOCOL_VERSION,
  isAckMessage,
  isChannelName,
  isCmdMessage,
  isCommand,
  isEngineCommand,
  isHashMessage,
  isHelloMessage,
  isJoinAcceptMessage,
  isJoinChunkMessage,
  isJoinReadyMessage,
  isJoinRejectMessage,
  isJoinRequestMessage,
  isResyncMessage,
  isTurnMessage,
  isTurnCommand,
  validateChannelMessage,
} from '../../src/net/types.js';

const base = { v: NET_PROTOCOL_VERSION };

describe('guards du protocole réseau', () => {
  it('valide les noms de canaux', () => {
    expect(isChannelName('turn')).toBe(true);
    expect(isChannelName('a-b_c')).toBe(true);
    expect(isChannelName('')).toBe(false);
    expect(isChannelName('a'.repeat(25))).toBe(false);
    expect(isChannelName('bad channel')).toBe(false);
    expect(isChannelName(42)).toBe(false);
  });

  it('valide les commandes moteur', () => {
    expect(isEngineCommand({ type: 'pause', paused: true })).toBe(true);
    expect(isEngineCommand({ type: 'speed', speed: 2 })).toBe(true);
    expect(isEngineCommand({ type: 'console', command: 'help' })).toBe(true);
    expect(
      isEngineCommand({
        type: 'build',
        tool: 'road',
        company: 0,
        from: { x: 1, y: 2 },
      }),
    ).toBe(true);
    expect(isEngineCommand({ type: 'speed', speed: 9 })).toBe(false);
    // #90 : l'achat par id de dépôt et les ordres typés traversent le lockstep.
    expect(
      isEngineCommand({
        type: 'vehicle',
        action: 'buy',
        company: 0,
        depotId: 7,
        model: 'bus_city',
      }),
    ).toBe(true);
    expect(
      isEngineCommand({
        type: 'vehicle',
        action: 'order',
        company: 0,
        vehicle: 3,
        orders: [{ target: 7, kind: 'depot' }],
      }),
    ).toBe(true);
    expect(
      isEngineCommand({
        type: 'build',
        tool: 'convert',
        company: 0,
        from: { x: 1, y: 2 },
        to: { x: 4, y: 2 },
        options: { railType: 'electrified' },
      }),
    ).toBe(true);
    expect(
      isEngineCommand({
        type: 'build',
        tool: 'unsignal',
        company: 0,
        from: { x: 1, y: 2 },
        options: { type: 'path' },
      }),
    ).toBe(true);
    expect(
      isEngineCommand({ type: 'build', tool: 'laser', company: 0, from: { x: 0, y: 0 } }),
    ).toBe(false);
    expect(isEngineCommand({ type: 'console', command: 42 })).toBe(false);
    expect(isCommand({ type: 'pause', paused: true, p: 0 })).toBe(true);
    expect(isCommand({ type: 'pause', paused: true, p: 99 })).toBe(false);
  });

  it('valide les entrées de tour et refuse les commandes forgées', () => {
    expect(isTurnCommand({ type: 'leave', p: 1 })).toBe(true);
    expect(isTurnCommand({ type: 'leave', p: 1, s: 3 })).toBe(true);
    expect(isTurnCommand({ type: 'console', command: 'x', p: 0, s: 1 })).toBe(true);
    expect(isTurnCommand({ type: 'leave', p: -1 })).toBe(false);
    expect(isTurnCommand({ type: 'console', command: 'x', p: 0, s: -2 })).toBe(false);
  });

  it('valide hello / cmd / turn', () => {
    expect(isHelloMessage({ ...base, k: 'hello', player: 0, tick: 3, host: true, epoch: 0 })).toBe(
      true,
    );
    expect(isHelloMessage({ ...base, k: 'hello', player: 0, tick: -1, host: true, epoch: 0 })).toBe(
      false,
    );

    expect(
      isCmdMessage({
        ...base,
        k: 'cmd',
        b: [{ s: 0, c: { type: 'pause', paused: false } }],
      }),
    ).toBe(true);
    expect(
      isCmdMessage({
        ...base,
        k: 'cmd',
        b: [{ s: -1, c: { type: 'pause', paused: false } }],
      }),
    ).toBe(false);

    expect(
      isTurnMessage({
        ...base,
        k: 'turn',
        epoch: 0,
        tick: 10,
        d: 3,
        commands: [{ type: 'leave', p: 2 }],
      }),
    ).toBe(true);
    expect(
      isTurnMessage({
        ...base,
        k: 'turn',
        epoch: 0,
        tick: 10,
        d: 3,
        commands: [{ type: 'leave', p: 2, s: -1 }],
      }),
    ).toBe(false);
  });

  it('valide hash / ack / resync', () => {
    expect(isHashMessage({ ...base, k: 'hash', epoch: 0, tick: 50, hash: 'abc' })).toBe(true);
    expect(isHashMessage({ ...base, k: 'hash', epoch: 0, tick: 50, hash: 12 })).toBe(false);
    expect(isAckMessage({ ...base, k: 'ack', tick: 10 })).toBe(true);
    expect(isAckMessage({ ...base, k: 'ack', tick: -1 })).toBe(false);
    expect(
      isResyncMessage({
        ...base,
        k: 'resync',
        epoch: 1,
        tick: 50,
        save: { id: 'a', index: 0, total: 1, data: '{}' },
      }),
    ).toBe(true);
    expect(
      isResyncMessage({
        ...base,
        k: 'resync',
        epoch: 1,
        tick: 50,
        save: { id: 'a', index: 2, total: 1, data: '{}' },
      }),
    ).toBe(false);
    expect(isResyncMessage({ ...base, k: 'resync', epoch: 0, tick: 50, request: true })).toBe(true);
  });

  it('rejette une version de protocole inconnue', () => {
    expect(isHelloMessage({ v: 999, k: 'hello', player: 0, tick: 0, host: false, epoch: 0 })).toBe(
      false,
    );
  });

  it('route la validation par canal', () => {
    const hello = { ...base, k: 'hello', player: 0, tick: 0, host: false, epoch: 0 };
    expect(validateChannelMessage('hello', hello)?.k).toBe('hello');
    expect(validateChannelMessage('turn', hello)).toBeNull();
    expect(validateChannelMessage('unknown', hello)).toBeNull();
  });

  it('valide les messages de join en cours de partie', () => {
    const request = {
      ...base,
      k: 'join-request',
      pv: JOIN_PROTOCOL_VERSION,
      player: 2,
      name: 'Alice',
    };
    expect(isJoinRequestMessage(request)).toBe(true);
    expect(isJoinRequestMessage({ ...request, pv: JOIN_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isJoinRequestMessage({ ...request, player: 64 })).toBe(false);
    expect(isJoinRequestMessage({ ...request, name: 'x'.repeat(25) })).toBe(false);
    expect(isJoinRequestMessage({ ...request, engine: 42 })).toBe(false);

    const accept = {
      ...base,
      k: 'join-accept',
      epoch: 3,
      tick: 500,
      total: 2,
      player: 2,
      id: 'join-500-1',
      hash: '500:abcdef',
      engine: 'build-a',
    };
    expect(isJoinAcceptMessage(accept)).toBe(true);
    expect(isJoinAcceptMessage({ ...accept, total: 0 })).toBe(false);
    expect(isJoinAcceptMessage({ ...accept, tick: -1 })).toBe(false);
    expect(isJoinAcceptMessage({ ...accept, player: 64 })).toBe(false);
    expect(isJoinAcceptMessage({ ...accept, id: '' })).toBe(false);

    const chunk = {
      ...base,
      k: 'join-chunk',
      epoch: 3,
      tick: 500,
      save: { id: 'join-500-1', index: 1, total: 2, data: '{}' },
    };
    expect(isJoinChunkMessage(chunk)).toBe(true);
    expect(
      isJoinChunkMessage({
        ...chunk,
        save: { id: 'join-500-1', index: 2, total: 2, data: '{}' },
      }),
    ).toBe(false);
    expect(
      isJoinChunkMessage({
        ...chunk,
        save: { id: 'join-500-1', index: 0, total: 2, data: 'x'.repeat(32 * 1024 + 1) },
      }),
    ).toBe(false);

    expect(
      isJoinReadyMessage({ ...base, k: 'join-ready', tick: 500, hash: '500:abcdef', ok: true }),
    ).toBe(true);
    expect(
      isJoinReadyMessage({
        ...base,
        k: 'join-ready',
        tick: 500,
        hash: '',
        ok: false,
        error: 'sauvegarde illisible',
      }),
    ).toBe(true);
    expect(isJoinReadyMessage({ ...base, k: 'join-ready', tick: 500, hash: 42 })).toBe(false);

    expect(
      isJoinRejectMessage({
        ...base,
        k: 'join-reject',
        reason: 'invalid-save',
        message: 'La sauvegarde est invalide.',
      }),
    ).toBe(true);
    expect(isJoinRejectMessage({ ...base, k: 'join-reject', reason: 'unknown-reason' })).toBe(
      false,
    );

    expect(validateChannelMessage(JOIN_CHANNELS.request, request)?.k).toBe('join-request');
    expect(validateChannelMessage(JOIN_CHANNELS.accept, accept)?.k).toBe('join-accept');
    expect(validateChannelMessage(JOIN_CHANNELS.chunk, chunk)?.k).toBe('join-chunk');
    expect(validateChannelMessage(JOIN_CHANNELS.reject, request)).toBeNull();
  });
});
