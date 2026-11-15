import { describe, expect, it } from 'vitest';
import {
  NET_PROTOCOL_VERSION,
  isAckMessage,
  isChannelName,
  isCmdMessage,
  isCommand,
  isEngineCommand,
  isHashMessage,
  isHelloMessage,
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
    expect(isEngineCommand({ type: 'build', tool: 'laser', company: 0, from: { x: 0, y: 0 } })).toBe(false);
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
    expect(
      isHelloMessage({ ...base, k: 'hello', player: 0, tick: 3, host: true, epoch: 0 }),
    ).toBe(true);
    expect(
      isHelloMessage({ ...base, k: 'hello', player: 0, tick: -1, host: true, epoch: 0 }),
    ).toBe(false);

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
    expect(
      isHelloMessage({ v: 999, k: 'hello', player: 0, tick: 0, host: false, epoch: 0 }),
    ).toBe(false);
  });

  it('route la validation par canal', () => {
    const hello = { ...base, k: 'hello', player: 0, tick: 0, host: false, epoch: 0 };
    expect(validateChannelMessage('hello', hello)?.k).toBe('hello');
    expect(validateChannelMessage('turn', hello)).toBeNull();
    expect(validateChannelMessage('unknown', hello)).toBeNull();
  });
});
