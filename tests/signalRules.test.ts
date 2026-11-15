import { describe, expect, it } from 'vitest';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import {
  SIGNAL_KINDS,
  SIGNAL_KIND_INDEX,
  decodeSignalBits,
  encodeSignalBits,
  isBlockOccupied,
  nextSignalDirection,
  nextSignalKind,
  parseSignalDirection,
  parseSignalKind,
  signalAspectForBlock,
  signalBlockTiles,
  signalKindFromIndex,
  signalsFromMap,
  withSignalAspect,
} from '../src/game/signalRules';
import { TILE_FLAG } from '../src/engine/protocol';

function makeMap(width = 12, height = 3): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
    signalData: new Uint8Array(size),
  };
}

function setRail(map: MapSnapshot, x: number, y: number): number {
  const index = y * map.width + x;
  map.kind[index] = TILE_KIND_INDEX.rail;
  return index;
}

describe('signalRules : encodage des bits de signal', () => {
  it('encode et décode chaque type, sens, état et variante', () => {
    for (const kind of SIGNAL_KINDS) {
      for (const direction of ['one-way', 'both'] as const) {
        for (const aspect of ['green', 'red', 'yellow'] as const) {
          const encoded = encodeSignalBits({ kind, direction, aspect, semaphore: true });
          expect(decodeSignalBits(encoded)).toEqual({ kind, direction, aspect, semaphore: true });
        }
      }
    }
    expect(decodeSignalBits(0)).toBeNull();
    expect(signalKindFromIndex(SIGNAL_KIND_INDEX.path)).toBe('path');
    expect(signalKindFromIndex(99)).toBeNull();
  });

  it('change l’état sans perdre le type ni le sens', () => {
    const encoded = encodeSignalBits({
      kind: 'combo',
      direction: 'both',
      aspect: 'green',
      semaphore: false,
    });
    const red = withSignalAspect(encoded, 'red');
    expect(decodeSignalBits(red)).toMatchObject({
      kind: 'combo',
      direction: 'both',
      aspect: 'red',
    });
  });

  it('cycle les types et les sens, et lit les alias', () => {
    expect(nextSignalKind('block')).toBe('path');
    expect(nextSignalKind('combo')).toBe('block');
    expect(nextSignalDirection('one-way')).toBe('both');
    expect(nextSignalDirection('both')).toBe('one-way');
    expect(parseSignalKind('PBS')).toBe('path');
    expect(parseSignalKind('entrée')).toBe('entry');
    expect(parseSignalDirection('bidirectionnel')).toBe('both');
    expect(parseSignalKind('inconnu')).toBeNull();
  });

  it('extrait les signaux de la carte dans un ordre déterministe', () => {
    const map = makeMap(4, 2);
    map.signalData![5] = encodeSignalBits({
      kind: 'exit',
      direction: 'both',
      aspect: 'red',
      semaphore: false,
    });
    map.flags[5] = TILE_FLAG.SIGNAL;
    expect(signalsFromMap(map)).toEqual([
      { x: 1, y: 1, kind: 'exit', direction: 'both', aspect: 'red', semaphore: false },
    ]);
  });
});

describe('signalRules : cantons et blocage', () => {
  it('borne le canton au signal suivant et détecte l’occupation', () => {
    const map = makeMap(12, 3);
    for (let x = 1; x <= 8; x += 1) setRail(map, x, 1);
    // Signal à x=1 (départ) et à x=5 (borne).
    map.signalData![1 * map.width + 1] = encodeSignalBits({
      kind: 'block',
      direction: 'one-way',
      aspect: 'green',
      semaphore: false,
    });
    map.signalData![1 * map.width + 5] = encodeSignalBits({
      kind: 'block',
      direction: 'one-way',
      aspect: 'green',
      semaphore: false,
    });

    const block = signalBlockTiles(map, 1, 1);
    // Le canton contient la tuile du signal suivant mais pas au-delà.
    expect(block).toContain(1 * map.width + 5);
    expect(block).not.toContain(1 * map.width + 6);
    expect(block).toHaveLength(5);

    expect(isBlockOccupied(block, map.width, [{ x: 3.2, y: 1.4 }])).toBe(true);
    expect(signalAspectForBlock(block, map.width, [{ x: 3.2, y: 1.4 }])).toBe('red');
    expect(signalAspectForBlock(block, map.width, [{ x: 7.5, y: 1.5 }])).toBe('green');
  });

  it('renvoie un canton vide hors voie ferrée', () => {
    const map = makeMap();
    expect(signalBlockTiles(map, 0, 0)).toEqual([]);
  });
});
