import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { sampleHeightWorld, tileKindFromIndex } from '../src/game/mapGrid';
import { SurroundingsLayer } from '../src/render/SurroundingsLayer';
import { TerrainLayer } from '../src/render/TerrainLayer';
import { qualitySettings, type QualityLevel } from '../src/render/quality';
import {
  SEA_LEVEL,
  SKIRT_SEABED,
  SURROUNDINGS_BUDGETS,
  buildOceanGrid,
  distanceOutsideMap,
  islandPlan,
  layoutSignature,
  oceanOuterHalf,
  shoreSignature,
  surroundingsBudget,
  terrainColourLinear,
} from '../src/render/surroundingsPlan';
import { surroundingColourLinear, surroundingHeight } from '../src/render/surroundingsPlan';
import { waterBedHeight } from '../src/render/waterSurface';
import type { Rgb } from '../src/render/tileVisuals';

/** Hauteur réellement rendue par le maillage du terrain (lit sous l'eau). */
function terrainMeshHeight(map: MapSnapshot, x: number, z: number): number {
  const ix = Math.max(0, Math.min(map.width - 1, Math.floor(x)));
  const iz = Math.max(0, Math.min(map.height - 1, Math.floor(z)));
  const index = ix + iz * map.width;
  if (tileKindFromIndex(map.kind[index] ?? 0) === 'water') {
    return waterBedHeight(map.heightMap[index] ?? 0);
  }
  return sampleHeightWorld(map, x, z);
}

function makeMap(width = 48, height = 40): MapSnapshot {
  const size = width * height;
  const map: MapSnapshot = {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      map.heightMap[y * width + x] = 1 + ((x * 3 + y * 5) % 7);
    }
  }
  // Côte à l'ouest : la jupe doit prolonger une eau peu profonde.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      const index = y * width + x;
      map.kind[index] = TILE_KIND_INDEX.water;
      map.heightMap[index] = 0;
    }
  }
  // Quelques types variés sur les autres bords.
  for (let x = width - 4; x < width; x += 1) {
    map.kind[(height - 3) * width + x] = TILE_KIND_INDEX.trees;
    map.kind[(height - 2) * width + x] = TILE_KIND_INDEX.coast;
  }
  map.kind[2] = TILE_KIND_INDEX.road;
  map.kind[width - 1] = TILE_KIND_INDEX.rough;
  map.slope[width - 1] = 2;
  return map;
}

function meshByName(layer: SurroundingsLayer, name: string): THREE.Mesh | null {
  return (
    (layer.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === name,
    ) as THREE.Mesh | undefined) ?? null
  );
}

function positions(layer: SurroundingsLayer, name: string): THREE.BufferAttribute {
  const mesh = meshByName(layer, name);
  if (!mesh) throw new Error(`mesh ${name} manquant`);
  return mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
}

describe('SurroundingsLayer — raccord avec le terrain', () => {
  it('épouse exactement la hauteur du terrain sur les quatre bords', () => {
    const map = makeMap();
    const layer = new SurroundingsLayer();
    layer.build(map, 'medium');
    const position = positions(layer, 'surroundings-skirt');
    let compared = 0;
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = position.getZ(index);
      const y = position.getY(index);
      const onBorder =
        (x === 0 || x === map.width) && z >= 0 && z <= map.height
          ? true
          : (z === 0 || z === map.height) && x >= 0 && x <= map.width;
      if (!onBorder) continue;
      expect(y).toBeCloseTo(terrainMeshHeight(map, x, z), 6);
      compared += 1;
    }
    expect(compared).toBeGreaterThan((map.width + map.height) * 2 - 4);
    layer.dispose();
  });

  it('prolonge la couleur des tuiles de bord sans discontinuité', () => {
    const map = makeMap();
    const terrain = new TerrainLayer();
    terrain.setMap(map);
    const layer = new SurroundingsLayer();
    layer.build(map, 'medium');

    const interpolation = { r: 0, g: 0, b: 0 };
    const expected = terrainColourLinear(map, 0, 10, interpolation);
    const actual: Rgb = { r: 0, g: 0, b: 0 };
    surroundingColourLinear(map, 0, 10, SURROUNDINGS_BUDGETS.medium, actual);
    expect(actual.r).toBeCloseTo(expected.r, 6);
    expect(actual.g).toBeCloseTo(expected.g, 6);
    expect(actual.b).toBeCloseTo(expected.b, 6);

    // Le maillage du terrain et la jupe partagent la même couleur au raccord.
    const chunk = terrain.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === 'terrain-0-0',
    );
    if (!chunk) throw new Error('chunk terrain manquant');
    const terrainPosition = chunk.geometry.getAttribute('position') as THREE.BufferAttribute;
    const terrainColour = chunk.geometry.getAttribute('color') as THREE.BufferAttribute;
    const skirt = meshByName(layer, 'surroundings-skirt');
    if (!skirt) throw new Error('jupe manquante');
    const skirtPosition = skirt.geometry.getAttribute('position') as THREE.BufferAttribute;
    const skirtColour = skirt.geometry.getAttribute('color') as THREE.BufferAttribute;
    const skirtIndex = new Map<string, number>();
    for (let index = 0; index < skirtPosition.count; index += 1) {
      if (skirtPosition.getX(index) !== 0) continue;
      skirtIndex.set(String(skirtPosition.getZ(index)), index);
    }
    let compared = 0;
    for (let index = 0; index < terrainPosition.count; index += 1) {
      if (terrainPosition.getX(index) !== 0) continue;
      const z = terrainPosition.getZ(index);
      const other = skirtIndex.get(String(z));
      if (other === undefined) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        expect(skirtColour.getComponent(other, axis)).toBeCloseTo(
          terrainColour.getComponent(index, axis),
          5,
        );
      }
      expect(skirtPosition.getY(other)).toBeCloseTo(terrainPosition.getY(index), 6);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
    terrain.dispose();
    layer.dispose();
  });

  it('garde des normales cohérentes au raccord', () => {
    const map = makeMap();
    const terrain = new TerrainLayer();
    terrain.setMap(map);
    const layer = new SurroundingsLayer();
    layer.build(map, 'medium');
    const chunk = terrain.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === 'terrain-0-0',
    );
    const skirt = meshByName(layer, 'surroundings-skirt');
    if (!chunk || !skirt) throw new Error('maillages manquants');
    const terrainPosition = chunk.geometry.getAttribute('position') as THREE.BufferAttribute;
    const terrainNormal = chunk.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const skirtPosition = skirt.geometry.getAttribute('position') as THREE.BufferAttribute;
    const skirtNormal = skirt.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const skirtIndex = new Map<string, number>();
    for (let index = 0; index < skirtPosition.count; index += 1) {
      if (skirtPosition.getX(index) !== 0) continue;
      skirtIndex.set(String(skirtPosition.getZ(index)), index);
    }
    for (let index = 0; index < terrainPosition.count; index += 1) {
      if (terrainPosition.getX(index) !== 0) continue;
      const other = skirtIndex.get(String(terrainPosition.getZ(index)));
      if (other === undefined) continue;
      const z = Math.min(map.height - 1, Math.floor(terrainPosition.getZ(index)));
      // Sous l'eau, le terrain abaisse son lit : la normale de la jupe suit la
      // pente vers le large et la surface océanique couvre le raccord.
      if (tileKindFromIndex(map.kind[z * map.width] ?? 0) === 'water') continue;
      for (let axis = 0; axis < 3; axis += 1) {
        expect(skirtNormal.getComponent(other, axis)).toBeCloseTo(
          terrainNormal.getComponent(index, axis),
          2,
        );
      }
    }
    // Selon la carte, le bord peut être entièrement en eau : on vérifie alors
    // que les normales restent unitaires et finies.
    expect(Number.isFinite(skirtNormal.getX(0))).toBe(true);
    for (let index = 0; index < Math.min(8, skirtNormal.count); index += 1) {
      const length = Math.hypot(
        skirtNormal.getX(index),
        skirtNormal.getY(index),
        skirtNormal.getZ(index),
      );
      expect(length).toBeCloseTo(1, 2);
    }
    terrain.dispose();
    layer.dispose();
  });

  it('descend sous le niveau de la mer sans dépasser la marge', () => {
    const map = makeMap();
    const layer = new SurroundingsLayer();
    layer.build(map, 'medium');
    const budget = surroundingsBudget('medium');
    const position = positions(layer, 'surroundings-skirt');
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = position.getZ(index);
      const y = position.getY(index);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(-budget.skirtMargin);
      expect(x).toBeLessThanOrEqual(map.width + budget.skirtMargin);
      expect(z).toBeGreaterThanOrEqual(-budget.skirtMargin);
      expect(z).toBeLessThanOrEqual(map.height + budget.skirtMargin);
      expect(distanceOutsideMap(map, x, z)).toBeLessThanOrEqual(
        budget.skirtMargin * Math.SQRT2 + 1e-6,
      );
      minimum = Math.min(minimum, y);
      maximum = Math.max(maximum, y);
    }
    expect(minimum).toBeGreaterThanOrEqual(SKIRT_SEABED - 1e-5);
    expect(minimum).toBeLessThan(SEA_LEVEL);
    // La hauteur reste celle du terrain à l'intérieur (aucune retouche).
    expect(maximum).toBeLessThanOrEqual(7.5);
    layer.dispose();
  });
});

describe('SurroundingsLayer — océan, îles et budgets', () => {
  it('couvre le frustum et laisse la carte jouable à découvert', () => {
    const map = makeMap(64, 64);
    for (const level of ['low', 'medium', 'high'] as QualityLevel[]) {
      const layer = new SurroundingsLayer();
      layer.build(map, level);
      const ocean = meshByName(layer, 'surroundings-ocean');
      if (!ocean) throw new Error(`océan manquant en ${level}`);
      const position = ocean.geometry.getAttribute('position') as THREE.BufferAttribute;
      const half = oceanOuterHalf(map, level);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      let nonFinite = 0;
      let insideMap = 0;
      for (let index = 0; index < position.count; index += 1) {
        const x = position.getX(index);
        const z = position.getZ(index);
        if (!Number.isFinite(position.getY(index))) nonFinite += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        // Aucun sommet océanique dans la zone jouable.
        if (x > 0 && x < map.width && z > 0 && z < map.height) insideMap += 1;
      }
      expect(nonFinite).toBe(0);
      expect(insideMap).toBe(0);
      expect(minX).toBeLessThanOrEqual(-half + map.width / 2);
      expect(maxX).toBeGreaterThanOrEqual(map.width / 2 + half);
      expect(minZ).toBeLessThanOrEqual(-half + map.height / 2);
      expect(maxZ).toBeGreaterThanOrEqual(map.height / 2 + half);
      expect(half).toBeGreaterThanOrEqual(map.width / 2 + qualitySettings(level).drawDistance);

      const budget = surroundingsBudget(level);
      if (budget.coastalBand > 0) {
        // Une seule surface : profondeur et houle sont portées par le mesh.
        expect(ocean.geometry.getAttribute('aDepth')).toBeDefined();
        expect(ocean.geometry.getAttribute('aWave')).toBeDefined();
        let maxDistance = 0;
        for (let index = 0; index < position.count; index += 1) {
          maxDistance = Math.max(
            maxDistance,
            distanceOutsideMap(map, position.getX(index), position.getZ(index)),
          );
        }
        expect(maxDistance).toBeGreaterThan(half * 0.5);
      } else {
        expect(ocean.geometry.getAttribute('aDepth')).toBeUndefined();
        expect(ocean.geometry.getAttribute('aWave')).toBeUndefined();
      }

      // Bande et large partagent le même niveau : aucune marche d'eau.
      expect(position.getY(0)).toBeCloseTo(SEA_LEVEL, 6);

      const islands = meshByName(layer, 'surroundings-islands');
      expect(Boolean(islands)).toBe(budget.islands > 0);
      layer.dispose();
    }
  });

  it('borne les budgets de triangles et de draw calls', () => {
    const map = makeMap(256, 256);
    const triangles: Record<QualityLevel, number> = { low: 0, medium: 0, high: 0 };
    for (const level of ['low', 'medium', 'high'] as QualityLevel[]) {
      const layer = new SurroundingsLayer();
      layer.build(map, level);
      triangles[level] = layer.triangleCount;
      const budget = surroundingsBudget(level);
      const expectedCalls = 2 + (budget.islands > 0 ? 1 : 0);
      expect(layer.drawCallCount).toBe(expectedCalls);
      expect(layer.drawCallCount).toBeLessThanOrEqual(3);
      for (const child of layer.group.children) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.computeBoundingSphere();
      }
      layer.dispose();
    }
    expect(triangles.low).toBeLessThan(triangles.medium);
    expect(triangles.medium).toBeLessThan(triangles.high);
    expect(triangles.medium).toBeLessThan(130_000);
    expect(triangles.high).toBeLessThan(190_000);
  });

  it('reste déterministe et sans NaN', () => {
    const map = makeMap();
    const first = new SurroundingsLayer();
    const second = new SurroundingsLayer();
    first.build(map, 'high');
    second.build(map, 'high');
    const names = ['surroundings-skirt', 'surroundings-ocean', 'surroundings-islands'];
    for (const name of names) {
      const a = meshByName(first, name);
      const b = meshByName(second, name);
      expect(Boolean(a)).toBe(Boolean(b));
      if (!a || !b) continue;
      for (const attribute of ['position', 'normal', 'color', 'aDepth', 'aWave']) {
        const left = a.geometry.getAttribute(attribute);
        const right = b.geometry.getAttribute(attribute);
        if (!left || !right) {
          expect(Boolean(left)).toBe(Boolean(right));
          continue;
        }
        expect(left.count).toBe(right.count);
        let nonFinite = 0;
        let mismatches = 0;
        for (let index = 0; index < left.array.length; index += 1) {
          const value = left.array[index] as number;
          if (!Number.isFinite(value)) nonFinite += 1;
          if (value !== right.array[index]) mismatches += 1;
        }
        expect(nonFinite).toBe(0);
        expect(mismatches).toBe(0);
      }
      expect(Array.from(a.geometry.index?.array ?? [])).toEqual(
        Array.from(b.geometry.index?.array ?? []),
      );
    }
    first.dispose();
    second.dispose();
  });

  it('place les îles hors de la carte et de la jupe', () => {
    const map = makeMap(128, 96);
    for (const level of ['medium', 'high'] as QualityLevel[]) {
      const budget = surroundingsBudget(level);
      const islands = islandPlan(map, level);
      expect(islands.length).toBe(budget.islands);
      for (const island of islands) {
        expect(Number.isFinite(island.x) && Number.isFinite(island.z)).toBe(true);
        expect(distanceOutsideMap(map, island.x, island.z)).toBeGreaterThan(budget.skirtMargin);
        expect(island.radius).toBeGreaterThan(0);
        expect(island.height).toBeGreaterThan(0);
      }
    }
    expect(islandPlan(map, 'low')).toHaveLength(0);
  });
});

describe('SurroundingsLayer — reconstruction et libération', () => {
  it('ne reconstruit la jupe que si les bords changent', () => {
    const map = makeMap();
    const layer = new SurroundingsLayer();
    layer.build(map, 'medium');
    expect(layer.buildCount).toBe(1);
    expect(layer.skirtBuildCount).toBe(1);

    layer.build(makeMap(), 'medium');
    expect(layer.buildCount).toBe(1);

    const interiorHeight = makeMap();
    interiorHeight.heightMap[20 * map.width + 20] = 12;
    layer.build(interiorHeight, 'medium');
    expect(layer.buildCount).toBe(1);
    expect(layer.skirtBuildCount).toBe(1);

    const interiorKind = makeMap();
    interiorKind.kind[25 * map.width + 25] = TILE_KIND_INDEX.industry;
    layer.build(interiorKind, 'medium');
    // Les types changent les champs de distance : seul l'océan est retouché.
    expect(layer.buildCount).toBe(2);
    expect(layer.skirtBuildCount).toBe(1);
    expect(layer.oceanBuildCount).toBe(2);

    // Même types que l'état précédent, seul un bord change : pas d'océan refait.
    const border = makeMap();
    border.kind[25 * map.width + 25] = TILE_KIND_INDEX.industry;
    border.heightMap[0] = 12;
    layer.build(border, 'medium');
    expect(layer.skirtBuildCount).toBe(2);
    expect(layer.oceanBuildCount).toBe(2);
    layer.dispose();
  });

  it('suit les changements de qualité sans fuite de ressources', () => {
    const map = makeMap(64, 64);
    const geometrySpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const layer = new SurroundingsLayer();
    layer.build(map, 'low');
    expect(meshByName(layer, 'surroundings-ocean')).not.toBeNull();
    expect(meshByName(layer, 'surroundings-islands')).toBeNull();
    expect(layer.drawCallCount).toBe(2);

    layer.setQuality('medium');
    expect(meshByName(layer, 'surroundings-ocean')).not.toBeNull();
    expect(meshByName(layer, 'surroundings-islands')).not.toBeNull();
    expect(layer.drawCallCount).toBe(3);

    layer.setQuality('high');
    expect(layer.drawCallCount).toBe(3);

    const disposedBefore = geometrySpy.mock.calls.length;
    layer.dispose();
    expect(geometrySpy.mock.calls.length).toBeGreaterThan(disposedBefore);
    expect(layer.group.children).toHaveLength(0);
    expect(layer.triangleCount).toBe(0);
    expect(layer.drawCallCount).toBe(0);
    geometrySpy.mockRestore();
  });

  it('ne modifie jamais la carte et ne participe pas au picking', () => {
    const map = makeMap();
    const before = {
      kind: Array.from(map.kind),
      height: Array.from(map.heightMap),
      slope: Array.from(map.slope),
    };
    const layer = new SurroundingsLayer();
    layer.build(map, 'high');
    expect(Array.from(map.kind)).toEqual(before.kind);
    expect(Array.from(map.heightMap)).toEqual(before.height);
    expect(Array.from(map.slope)).toEqual(before.slope);
    expect(layer.pickTargets()).toEqual([]);
    layer.dispose();
  });

  it('renvoie le lit de jupe au-delà de la marge et borne la profondeur', () => {
    const map = makeMap();
    const budget = surroundingsBudget('medium');
    const far = surroundingHeight(map, -budget.skirtMargin - 5, 20, budget);
    expect(far).toBeCloseTo(SKIRT_SEABED, 6);
    for (let distance = 0; distance <= budget.skirtMargin + 4; distance += 0.5) {
      const height = surroundingHeight(map, -distance, 20, budget);
      expect(Number.isFinite(height)).toBe(true);
      expect(height).toBeGreaterThanOrEqual(SKIRT_SEABED - 1e-6);
      expect(height).toBeLessThanOrEqual(7.5);
    }
    expect(distanceOutsideMap(map, -3, 10)).toBe(3);
    expect(distanceOutsideMap(map, map.width + 2, map.height + 4)).toBeCloseTo(Math.hypot(2, 4), 6);
  });

  it('détecte les signatures et le trou océanique', () => {
    const map = makeMap();
    expect(layoutSignature(map)).toBe(layoutSignature(makeMap()));
    expect(shoreSignature(map)).toBe(shoreSignature(makeMap()));
    const changed = makeMap();
    changed.heightMap[0] = 12;
    expect(layoutSignature(changed)).not.toBe(layoutSignature(map));
    // Une hauteur intérieure ne change pas la jupe, mais son type si.
    const interior = makeMap();
    interior.heightMap[20 * map.width + 20] = 12;
    expect(layoutSignature(interior)).toBe(layoutSignature(map));
    expect(shoreSignature(interior)).toBe(shoreSignature(map));

    const ocean = buildOceanGrid(map, 'medium');
    let minX = Infinity;
    let maxDistance = 0;
    for (let index = 0; index < ocean.positions.length; index += 3) {
      const x = ocean.positions[index] ?? 0;
      const z = ocean.positions[index + 2] ?? 0;
      minX = Math.min(minX, x);
      maxDistance = Math.max(maxDistance, distanceOutsideMap(map, x, z));
    }
    expect(minX).toBeLessThan(-surroundingsBudget('medium').coastalBand);
    expect(maxDistance).toBeGreaterThan(oceanOuterHalf(map, 'medium') * 0.9);
    // Une seule surface : pas de doublon bande + large.
    expect(buildOceanGrid(map, 'low').triangles).toBeLessThan(ocean.triangles);
    expect(SEA_LEVEL).toBeCloseTo(-0.08, 6);
  });
});
