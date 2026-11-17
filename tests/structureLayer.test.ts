import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COMPANY_NONE, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { StructureLayer, inferStructures } from '../src/render/StructureLayer';

function makeMap(width = 16, height = 16): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

const bridge = {
  id: 0,
  kind: 'bridge' as const,
  company: 0,
  transport: 'rail' as const,
  material: 'steel' as const,
  from: { x: 2, y: 5 },
  to: { x: 9, y: 5 },
  length: 8,
  deckHeight: 6,
};

const tunnel = {
  id: 1,
  kind: 'tunnel' as const,
  company: 0,
  transport: 'road' as const,
  from: { x: 3, y: 9 },
  to: { x: 8, y: 9 },
  length: 6,
  portalHeight: 4,
};

describe('StructureLayer', () => {
  it('fusionne tablier, rampes et portails en deux géométries LOD', () => {
    const map = makeMap();
    const layer = new StructureLayer();
    try {
      layer.setStructures([bridge, tunnel], map);
      expect(layer.count).toBe(2);
      expect(layer.triangleCount).toBeGreaterThan(20);
      expect(layer.drawCallCount).toBe(2);
      expect(layer.detailShown).toBe(true);

      layer.setQuality('low');
      expect(layer.detailShown).toBe(false);
      expect(layer.drawCallCount).toBe(1);
    } finally {
      layer.dispose();
    }
  });

  it('couvre exactement les tuiles du plan (culées comprises) sur les deux axes', () => {
    const map = makeMap(24, 24);
    const layer = new StructureLayer();
    const bounds = (): { minX: number; maxX: number; minZ: number; maxZ: number } => {
      const base = layer.group.children.find((child) => child.name === 'structure-base');
      if (!(base instanceof THREE.Mesh)) throw new Error('géométrie de base attendue');
      const positions = base.geometry.getAttribute('position');
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < positions.count; i += 1) {
        minX = Math.min(minX, positions.getX(i));
        maxX = Math.max(maxX, positions.getX(i));
        minZ = Math.min(minZ, positions.getZ(i));
        maxZ = Math.max(maxZ, positions.getZ(i));
      }
      return { minX, maxX, minZ, maxZ };
    };
    try {
      layer.setStructures([bridge], map);
      const alongX = bounds();
      expect(alongX.minX).toBeCloseTo(2, 5);
      expect(alongX.maxX).toBeCloseTo(10, 5);
      expect(alongX.minZ).toBeGreaterThanOrEqual(5);
      expect(alongX.maxZ).toBeLessThanOrEqual(6);

      layer.setStructures([{ ...bridge, from: { x: 5, y: 2 }, to: { x: 5, y: 9 } }], map);
      const alongY = bounds();
      expect(alongY.minZ).toBeCloseTo(2, 5);
      expect(alongY.maxZ).toBeCloseTo(10, 5);
      expect(alongY.minX).toBeGreaterThanOrEqual(5);
      expect(alongY.maxX).toBeLessThanOrEqual(6);
    } finally {
      layer.dispose();
    }
  });

  it('bascule le détail selon la distance caméra', () => {
    const map = makeMap();
    const layer = new StructureLayer();
    try {
      layer.setStructures([bridge], map);
      layer.setQuality('medium');
      layer.update({ x: 5, z: 5 });
      expect(layer.detailShown).toBe(true);
      layer.update({ x: 500, z: 500 });
      expect(layer.detailShown).toBe(false);
    } finally {
      layer.dispose();
    }
  });

  it('infère un pont rectiligne quand le moteur ne fournit pas structures[]', () => {
    const map = makeMap();
    for (let x = 2; x <= 9; x += 1) {
      const index = x + 5 * map.width;
      map.kind[index] = TILE_KIND_INDEX.bridge;
      map.flags[index] = 1 << 4;
      map.owner[index] = 0;
    }
    for (let x = 3; x <= 8; x += 1) {
      const index = x + 9 * map.width;
      map.kind[index] = TILE_KIND_INDEX.tunnel;
      map.flags[index] = 1 << 5;
    }
    const inferred = inferStructures(map);
    expect(inferred).toHaveLength(2);
    expect(inferred[0]).toMatchObject({
      kind: 'bridge',
      from: { x: 2, y: 5 },
      to: { x: 9, y: 5 },
      length: 8,
    });
    expect(inferred[1]).toMatchObject({
      kind: 'tunnel',
      from: { x: 3, y: 9 },
      to: { x: 8, y: 9 },
      length: 6,
    });
  });

  it('étend un pont hérité jusqu’aux culées sans déborder du tracé', () => {
    const map = makeMap(24, 16);
    for (let x = 5; x <= 8; x += 1) {
      const index = x + 5 * map.width;
      map.kind[index] = TILE_KIND_INDEX.bridge;
      map.flags[index] = (1 << 4) | 1;
      map.heightMap[index] = 0;
    }
    for (const x of [3, 10]) {
      map.kind[x + 5 * map.width] = TILE_KIND_INDEX.road;
    }
    const inferred = inferStructures(map);
    expect(inferred).toHaveLength(1);
    expect(inferred[0]).toMatchObject({
      kind: 'bridge',
      from: { x: 4, y: 5 },
      to: { x: 9, y: 5 },
      transport: 'road',
      length: 6,
      deckHeight: 6,
    });

    const layer = new StructureLayer();
    try {
      layer.setStructures([], map);
      const base = layer.group.children.find((child) => child.name === 'structure-base');
      if (!(base instanceof THREE.Mesh)) throw new Error('géométrie de base attendue');
      const positions = base.geometry.getAttribute('position');
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < positions.count; i += 1) {
        minX = Math.min(minX, positions.getX(i));
        maxX = Math.max(maxX, positions.getX(i));
        minZ = Math.min(minZ, positions.getZ(i));
        maxZ = Math.max(maxZ, positions.getZ(i));
      }
      // L'empreinte couvre exactement les tuiles du plan (culées comprises).
      expect(minX).toBeCloseTo(4, 5);
      expect(maxX).toBeCloseTo(10, 5);
      expect(minZ).toBeGreaterThanOrEqual(5);
      expect(maxZ).toBeLessThanOrEqual(6);
    } finally {
      layer.dispose();
    }
  });

  it('ignore les composantes en L et libère toute la géométrie', () => {
    const map = makeMap();
    for (const [x, y] of [
      [2, 2],
      [3, 2],
      [3, 3],
      [4, 3],
    ] as const) {
      map.kind[x + y * map.width] = TILE_KIND_INDEX.bridge;
    }
    expect(inferStructures(map)).toEqual([]);
    const layer = new StructureLayer();
    layer.setStructures([bridge], map);
    expect(layer.triangleCount).toBeGreaterThan(0);
    layer.dispose();
    expect(layer.count).toBe(0);
  });
});
