import { describe, expect, it } from 'vitest';
import type { MapSnapshot } from '../src/engine/protocol';
import {
  HEIGHT_SCALE,
  cornerHeightWorld,
  inBounds,
  isWaterKind,
  sampleHeightWorld,
  tileHeightWorld,
  tileIndex,
  tileKindAt,
  tileKindFromIndex,
} from '../src/game/mapGrid';

function makeMap(
  width: number,
  height: number,
  fill: (x: number, y: number) => { kind: number; height: number },
): MapSnapshot {
  const kind = new Uint8Array(width * height);
  const heightMap = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = fill(x, y);
      kind[y * width + x] = value.kind;
      heightMap[y * width + x] = value.height;
    }
  }
  return {
    width,
    height,
    kind,
    heightMap,
    owner: new Uint8Array(width * height).fill(255),
    slope: new Uint8Array(width * height),
    flags: new Uint8Array(width * height),
    trackBits: new Uint8Array(width * height),
  };
}

describe('indexation de la carte', () => {
  it('indexe en y * width + x', () => {
    expect(tileIndex(0, 0, 10)).toBe(0);
    expect(tileIndex(3, 2, 10)).toBe(23);
    expect(tileIndex(9, 9, 10)).toBe(99);
  });

  it('valide les bornes', () => {
    expect(inBounds(0, 0, 10, 10)).toBe(true);
    expect(inBounds(9, 9, 10, 10)).toBe(true);
    expect(inBounds(10, 0, 10, 10)).toBe(false);
    expect(inBounds(-1, 0, 10, 10)).toBe(false);
  });

  it('décode les types de tuile', () => {
    expect(tileKindFromIndex(2)).toBe('grass');
    expect(tileKindFromIndex(4)).toBe('water');
    expect(tileKindFromIndex(99)).toBe('void');
    expect(isWaterKind('river')).toBe(true);
    expect(isWaterKind('canal')).toBe(true);
    expect(isWaterKind('grass')).toBe(false);
  });

  it('lit un type hors carte comme void', () => {
    const map = makeMap(4, 4, () => ({ kind: 2, height: 3 }));
    expect(tileKindAt(map, 1, 1)).toBe('grass');
    expect(tileKindAt(map, -1, 0)).toBe('void');
    expect(tileKindAt(map, 4, 0)).toBe('void');
  });
});

describe('hauteurs', () => {
  it('convertit les niveaux OpenTTD en unités monde', () => {
    const map = makeMap(4, 4, () => ({ kind: 2, height: 6 }));
    expect(tileHeightWorld(map, 0, 0)).toBe(6 * HEIGHT_SCALE);
  });

  it('partage les coins entre tuiles adjacentes', () => {
    const map = makeMap(2, 2, (x) => ({ kind: 2, height: x === 0 ? 2 : 6 }));
    // Coin intérieur (1,1) : moyenne des quatre tuiles.
    expect(cornerHeightWorld(map, 1, 1)).toBeCloseTo(((2 + 6 + 2 + 6) / 4) * HEIGHT_SCALE, 6);
    // Coin extérieur : une seule tuile.
    expect(cornerHeightWorld(map, 0, 0)).toBeCloseTo(2 * HEIGHT_SCALE, 6);
  });

  it('interpole linéairement au centre d’une tuile plate', () => {
    const map = makeMap(4, 4, () => ({ kind: 2, height: 4 }));
    expect(sampleHeightWorld(map, 1.5, 2.5)).toBeCloseTo(4 * HEIGHT_SCALE, 6);
  });

  it('interpole entre deux hauteurs', () => {
    const map = makeMap(2, 1, (x) => ({ kind: 2, height: x === 0 ? 0 : 8 }));
    const left = sampleHeightWorld(map, 0.5, 0.5);
    const right = sampleHeightWorld(map, 1.5, 0.5);
    expect(right).toBeGreaterThan(left);
    // Cohérence : la hauteur échantillonnée reste dans l'enveloppe des niveaux.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(8 * HEIGHT_SCALE);
  });
});
