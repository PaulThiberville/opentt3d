import { describe, expect, it } from 'vitest';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import {
  SHORE_MAX_DISTANCE,
  WATER_DEPTH_RANGE,
  WATER_FOAM_DEPTH,
  WATER_LEVEL_OFFSET,
  WATER_RIPPLE_FADE_FAR,
  WATER_RIPPLE_FADE_NEAR,
  WATER_RIPPLE_SCALE,
  WATER_SHADER_CONSTANTS,
  WATER_WAVE_AMPLITUDE,
  buildShoreFields,
  sampleField,
  waterDepthFactor,
  waterFoamAmount,
  waterSurfaceHeight,
  waterWaveHeight,
} from '../src/render/waterSurface';

function makeMap(width: number, height: number, seaFrom: number): MapSnapshot {
  const size = width * height;
  const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
  const heightMap = new Uint8Array(size).fill(4);
  for (let y = 0; y < height; y += 1) {
    for (let x = seaFrom; x < width; x += 1) {
      kind[y * width + x] = TILE_KIND_INDEX.water;
      heightMap[y * width + x] = 0;
    }
  }
  return {
    width,
    height,
    kind,
    heightMap,
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

describe('hauteur et profondeur de l’eau', () => {
  it('place la surface à un demi-niveau au-dessus du lit', () => {
    expect(WATER_LEVEL_OFFSET).toBeGreaterThanOrEqual(0.4);
    expect(waterSurfaceHeight(0)).toBeCloseTo(WATER_LEVEL_OFFSET, 6);
    expect(waterSurfaceHeight(2)).toBeCloseTo(WATER_LEVEL_OFFSET + 1, 6);
    expect(waterSurfaceHeight(4)).toBeGreaterThan(waterSurfaceHeight(2));
    // Entrées invalides : jamais de NaN dans la géométrie.
    expect(Number.isFinite(waterSurfaceHeight(Number.NaN))).toBe(true);
    expect(waterSurfaceHeight(-3)).toBeCloseTo(WATER_LEVEL_OFFSET, 6);
  });

  it('convertit la distance à la côte en profondeur bornée', () => {
    expect(waterDepthFactor(0)).toBe(0);
    expect(waterDepthFactor(-2)).toBe(0);
    expect(waterDepthFactor(WATER_DEPTH_RANGE)).toBe(1);
    expect(waterDepthFactor(WATER_DEPTH_RANGE * 4)).toBe(1);
    expect(waterDepthFactor(1)).toBeLessThan(waterDepthFactor(4));
    for (let distance = 0; distance <= 12; distance += 0.25) {
      const depth = waterDepthFactor(distance);
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
  });

  it('borne la houle et la rend déterministe', () => {
    expect(WATER_WAVE_AMPLITUDE).toBeGreaterThan(0);
    expect(WATER_WAVE_AMPLITUDE).toBeLessThanOrEqual(0.08);
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let i = 0; i < 512; i += 1) {
      const height = waterWaveHeight(i * 0.37, (i % 13) - 6, ((i * 7) % 17) - 8);
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
      expect(Number.isFinite(height)).toBe(true);
    }
    expect(minimum).toBeGreaterThanOrEqual(-WATER_WAVE_AMPLITUDE - 1e-9);
    expect(maximum).toBeLessThanOrEqual(WATER_WAVE_AMPLITUDE + 1e-9);
    expect(maximum - minimum).toBeGreaterThan(WATER_WAVE_AMPLITUDE);
    expect(waterWaveHeight(3.5, 2, 7)).toBeCloseTo(waterWaveHeight(3.5, 2, 7), 12);
  });

  it('réserve l’écume à la frange côtière', () => {
    expect(waterFoamAmount(0, 1)).toBeGreaterThan(0.9);
    expect(waterFoamAmount(WATER_FOAM_DEPTH, 1)).toBe(0);
    expect(waterFoamAmount(1, 1)).toBe(0);
    expect(waterFoamAmount(0, 0)).toBe(0);
    for (const depth of [0, 0.02, 0.1, 0.4, 1]) {
      const foam = waterFoamAmount(depth, 0.6);
      expect(foam).toBeGreaterThanOrEqual(0);
      expect(foam).toBeLessThanOrEqual(1);
    }
  });
});

describe('champs de distance côte/terre', () => {
  it('mesure la profondeur depuis la terre et plafonne au large', () => {
    const map = makeMap(64, 64, 40);
    const fields = buildShoreFields(map);
    const across: number[] = [];
    for (let x = 40; x < 52; x += 1) across.push(fields.waterDistance[32 * 64 + x] ?? -1);
    // Les premières tuiles d'eau sont à 1..7 de la terre, puis le champ sature.
    expect(across).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7]);
    // Régression : les tuiles inatteignables restaient à 0 (eau « peu profonde »
    // partout, écume sur tout le large).
    expect(fields.waterDistance[32 * 64 + 63]).toBe(WATER_DEPTH_RANGE);
  });

  it('mesure la distance à l’eau sur la terre et sature à la limite', () => {
    const map = makeMap(64, 64, 40);
    const fields = buildShoreFields(map);
    expect(fields.landDistance[32 * 64 + 39]).toBe(1);
    expect(fields.landDistance[32 * 64 + 38]).toBe(2);
    expect(fields.landDistance[32 * 64 + 0]).toBe(SHORE_MAX_DISTANCE);
    for (let index = 0; index < map.kind.length; index += 1) {
      const water = map.kind[index] === TILE_KIND_INDEX.water;
      const distance = fields.landDistance[index] ?? 0;
      expect(distance).toBeGreaterThanOrEqual(0);
      expect(distance).toBeLessThanOrEqual(SHORE_MAX_DISTANCE);
      if (water) expect(distance).toBe(0);
      else expect(distance).toBeGreaterThanOrEqual(1);
      expect(fields.waterDistance[index] ?? 0).toBeLessThanOrEqual(WATER_DEPTH_RANGE);
    }
  });

  it('échantillonne au coin sans discontinuité entre tuiles', () => {
    const map = makeMap(64, 64, 40);
    const fields = buildShoreFields(map);
    for (let x = 36; x < 44; x += 0.5) {
      const value = sampleField(fields.waterDistance, 64, 64, x, 32);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(WATER_DEPTH_RANGE);
    }
    // Un même coin est échantillonné à l'identique par les quatre tuiles.
    const corner = sampleField(fields.landDistance, 64, 64, 40, 32);
    expect(sampleField(fields.landDistance, 64, 64, 40, 32)).toBeCloseTo(corner, 12);
    expect(sampleField(fields.landDistance, 64, 64, 64, 64)).toBe(
      fields.landDistance[63 * 64 + 63],
    );
  });
});

describe('bornes du shader d’eau', () => {
  it('garde des constantes glissées dans le shader dans des plages sûres', () => {
    expect(WATER_FOAM_DEPTH).toBeGreaterThan(0);
    expect(WATER_FOAM_DEPTH).toBeLessThan(0.12);
    expect(WATER_RIPPLE_SCALE).toBeGreaterThan(1);
    expect(WATER_RIPPLE_SCALE).toBeLessThan(12);
    expect(WATER_RIPPLE_FADE_NEAR).toBeLessThan(WATER_RIPPLE_FADE_FAR);
    expect(WATER_SHADER_CONSTANTS).toContain(
      `const float WATER_WAVE_AMPLITUDE = ${WATER_WAVE_AMPLITUDE.toFixed(5)};`,
    );
    expect(WATER_SHADER_CONSTANTS).toContain('WATER_FOAM_DEPTH');
    expect(WATER_SHADER_CONSTANTS).not.toContain('NaN');
    expect(WATER_SHADER_CONSTANTS).not.toContain('Infinity');
  });
});
