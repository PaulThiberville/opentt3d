/**
 * Budgets de performance statiques (issue #24).
 *
 * Ces tests ne lancent aucun navigateur : ils figent les invariants de coût du
 * rendu et du moteur sur des fixtures déterministes. Ils complètent
 * `scripts/perf.mjs`, qui mesure le vrai GPU dans Chrome headless.
 *
 * Les budgets sont volontairement généreux par rapport aux valeurs observées
 * sur un Apple M4 (voir le rapport de mesures) : ils détectent les régressions
 * de structure (un draw call par véhicule, une reconstruction complète de la
 * carte, un snapshot qui explose) sans être sensibles à la charge de la CI.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { IndustrySnapshot, MapSnapshot } from '../src/engine/protocol';
import { TILE_FLAG, TILE_KIND_INDEX } from '../src/engine/protocol';
import { MockEngine } from '../src/engine/MockEngine';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';
import { CatenaryLayer } from '../src/render/CatenaryLayer';
import { CityLayer } from '../src/render/CityLayer';
import { DepotLayer } from '../src/render/DepotLayer';
import { IndustryLayer } from '../src/render/IndustryLayer';
import { SignalLayer } from '../src/render/SignalLayer';
import { CHUNK_SIZE, TerrainLayer } from '../src/render/TerrainLayer';
import { VehicleLayer } from '../src/render/VehicleLayer';
import { VEHICLE_VARIANTS } from '../src/render/vehicleModels';
import { VegetationLayer } from '../src/render/VegetationLayer';
import { QUALITY_LEVELS, qualitySettings } from '../src/render/quality';

// ---------------------------------------------------------------------------
// Budgets statiques
// ---------------------------------------------------------------------------
const BUDGETS = {
  /** Un chunk de terrain = 2 triangles par tuile, aucun sommet superflu. */
  terrainTrianglesPerTile: 2,
  /**
   * Géométrie indexée (#122) : (32+1)² sommets partagés par chunk, soit ~1,06
   * sommet par tuile au lieu des 6 du maillage non indexé.
   */
  terrainVerticesPerChunk: (CHUNK_SIZE + 1) * (CHUNK_SIZE + 1),
  /** Bâtiment : modèles détaillés (moyenne observée ~103 triangles) + marge. */
  cityTrianglesPerBuilding: 150,
  /** Lots fusionnés par archétype × variante (deux villes tolérées). */
  cityDrawCalls: 24,
  /** Arbre : tronc (20) + houppier (12) + marge. */
  vegetationTrianglesPerTree: 40,
  /** Modèles de véhicules détaillés (plafond de modélisation : 3 000). */
  vehicleTrianglesPerModel: 1_500,
  vehicleDrawCalls: 9,
  vehicleTrianglesFor300: 450_000,
  /** Bâtiments : un seul draw call par archétype fusionné. */
  maxIndustryTrianglesPerIndustry: 4_000,
  maxIndustryPartsPerIndustry: 70,
  /** Snapshot/step du moteur mock (p95, millisecondes). */
  snapshotP95Ms: 50,
  snapshotMapP95Ms: 120,
  stepP95Ms: 25,
};

// ---------------------------------------------------------------------------
// Fixtures et mesures
// ---------------------------------------------------------------------------
function makeMap(width: number, height: number, paint?: (map: MapSnapshot) => void): MapSnapshot {
  const size = width * height;
  const heightMap = new Uint8Array(size);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      heightMap[y * width + x] = 3 + ((x * 7 + y * 3) % 3);
    }
  }
  const map: MapSnapshot = {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap,
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
  paint?.(map);
  return map;
}

function fillRect(
  map: MapSnapshot,
  x0: number,
  y0: number,
  width: number,
  height: number,
  kind: number,
): void {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const index = y * map.width + x;
      map.kind[index] = kind;
      if (kind === TILE_KIND_INDEX.water) map.heightMap[index] = 0;
      else if (map.heightMap[index] === 0) map.heightMap[index] = 3;
    }
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const position = geometry.getAttribute('position');
  return position ? Math.floor(position.count / 3) : 0;
}

interface MeshStats {
  drawCalls: number;
  instances: number;
  triangles: number;
  geometries: number;
}

/** Statistiques d'un groupe telles que le renderer les soumettrait. */
function groupStats(group: THREE.Object3D): MeshStats {
  const stats: MeshStats = { drawCalls: 0, instances: 0, triangles: 0, geometries: 0 };
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh && !(child as THREE.Line).isLine) return;
    if (!child.visible) return;
    const geometry = mesh.geometry;
    if (!geometry) return;
    stats.geometries += 1;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      const count = Math.max(0, instanced.count);
      stats.drawCalls += 1;
      stats.instances += count;
      stats.triangles += triangleCount(geometry) * count;
      return;
    }
    if ((child as THREE.Line).isLine) return;
    stats.drawCalls += 1;
    stats.instances += 1;
    stats.triangles += triangleCount(geometry);
  });
  return stats;
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function now(): number {
  return performance.now();
}

function renderVehicle(
  id: number,
  model: 'train' | 'truck' | 'bus' | 'ship' | 'plane',
): RenderVehicle {
  return {
    id,
    kind:
      model === 'train'
        ? 'train'
        : model === 'ship'
          ? 'ship'
          : model === 'plane'
            ? 'aircraft'
            : 'road',
    model,
    company: id % 2,
    x: 10 + (id % 60),
    y: 12 + ((id * 3) % 60),
    z: 1.5,
    direction: (id * 11) % 256,
    status: 1,
    speed: 20,
  };
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
describe('budgets TerrainLayer', () => {
  for (const size of [128, 256, 512]) {
    it(`${size}×${size} : 2 triangles par tuile, sommets indexés partagés`, () => {
      const layer = new TerrainLayer();
      layer.setMap(makeMap(size, size));
      const chunksPerAxis = Math.ceil(size / CHUNK_SIZE);
      try {
        expect(layer.chunkCount).toBe(chunksPerAxis * chunksPerAxis);
        const stats = groupStats(layer.group);
        // Fond océanique (1 mesh, 2 triangles) + un mesh de sol par chunk.
        expect(stats.drawCalls).toBe(chunksPerAxis * chunksPerAxis + 1);
        expect(stats.triangles).toBe(size * size * BUDGETS.terrainTrianglesPerTile + 2);
        let vertices = 0;
        layer.group.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh || !mesh.name.startsWith('terrain-')) return;
          vertices += mesh.geometry.getAttribute('position').count;
        });
        expect(vertices).toBe(chunksPerAxis * chunksPerAxis * BUDGETS.terrainVerticesPerChunk);
        // Budget par chunk : (32+1)² sommets partagés, ni plus ni moins.
        for (const child of layer.group.children) {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh || !mesh.name.startsWith('terrain-')) continue;
          expect(mesh.geometry.getAttribute('position').count).toBeLessThanOrEqual(
            BUDGETS.terrainVerticesPerChunk,
          );
        }
      } finally {
        layer.dispose();
      }
    });
  }

  it('une tuile modifiée ne reconstruit qu’un chunk (pas la carte entière)', () => {
    const layer = new TerrainLayer();
    const map = makeMap(256, 256);
    layer.setMap(map);
    const built = layer.chunksBuilt;
    try {
      const identical = makeMap(256, 256);
      layer.applyDelta(identical);
      expect(layer.chunksBuilt).toBe(built);

      const changed = makeMap(256, 256);
      changed.kind[40 * 256 + 40] = TILE_KIND_INDEX.road;
      layer.applyDelta(changed);
      expect(layer.chunksBuilt).toBe(built + 1);
    } finally {
      layer.dispose();
    }
  });

  it('l’eau ajoute 2 triangles par tuile d’eau et sa couronne de berge', () => {
    const layer = new TerrainLayer();
    const map = makeMap(64, 64, (fixture) => {
      fillRect(fixture, 0, 0, 64, 8, TILE_KIND_INDEX.water);
      // Même niveau pour l'eau et sa couronne : chaque berge est recouverte.
      for (let y = 0; y <= 8; y += 1) {
        for (let x = 0; x < fixture.width; x += 1) {
          fixture.heightMap[y * fixture.width + x] = 4;
        }
      }
    });
    layer.setMap(map);
    try {
      let waterTriangles = 0;
      for (const child of layer.group.children) {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.name.startsWith('water-')) continue;
        waterTriangles += triangleCount(mesh.geometry);
      }
      // 8 rangées d'eau + 1 rangée de berge recouverte (#204).
      expect(waterTriangles).toBe(64 * 9 * 2);
    } finally {
      layer.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Villes
// ---------------------------------------------------------------------------
describe('budgets CityLayer', () => {
  it('regroupe les bâtiments par archétype/variante, pas par tuile', () => {
    const map = makeMap(64, 64, (fixture) => {
      fillRect(fixture, 14, 14, 12, 12, TILE_KIND_INDEX.house);
    });
    const town = {
      id: 0,
      name: 'Test',
      x: 20.5,
      y: 20.5,
      population: 500,
      growthRate: 2,
      buildings: 144,
      rating: 60,
    };
    const layer = new CityLayer();
    layer.build([town], map);
    try {
      expect(layer.buildingCount).toBe(144);
      // 12 lots (archétype × variante) pour 144 bâtiments : le budget ne doit
      // jamais devenir proportionnel au nombre de tuiles.
      expect(layer.drawCallCount).toBeGreaterThan(0);
      expect(layer.drawCallCount).toBeLessThanOrEqual(BUDGETS.cityDrawCalls);
      const stats = groupStats(layer.group);
      // Les plinthes locales (#106) ajoutent au plus un InstancedMesh, jamais
      // un lot par bâtiment.
      expect(stats.drawCalls).toBeGreaterThanOrEqual(layer.drawCallCount);
      expect(stats.drawCalls).toBeLessThanOrEqual(layer.drawCallCount + 1);
      expect(stats.instances).toBeGreaterThanOrEqual(144);
      expect(stats.instances).toBeLessThanOrEqual(144 * 2);
      expect(stats.triangles).toBeLessThanOrEqual(144 * BUDGETS.cityTrianglesPerBuilding);
      expect(stats.triangles).toBeGreaterThan(0);
    } finally {
      layer.dispose();
    }
  });

  it('deux villes restent sous le plafond de lots fusionnés', () => {
    const map = makeMap(96, 96, (fixture) => {
      fillRect(fixture, 10, 10, 8, 8, TILE_KIND_INDEX.house);
      fillRect(fixture, 60, 60, 8, 8, TILE_KIND_INDEX.house);
    });
    const layer = new CityLayer();
    layer.build(
      [
        {
          id: 0,
          name: 'A',
          x: 14.5,
          y: 14.5,
          population: 300,
          growthRate: 1,
          buildings: 64,
          rating: 50,
        },
        {
          id: 1,
          name: 'B',
          x: 64.5,
          y: 64.5,
          population: 300,
          growthRate: 1,
          buildings: 64,
          rating: 50,
        },
      ],
      map,
    );
    try {
      expect(layer.buildingCount).toBe(128);
      expect(layer.drawCallCount).toBeGreaterThan(0);
      expect(layer.drawCallCount).toBeLessThanOrEqual(BUDGETS.cityDrawCalls * 2);
      const instances = groupStats(layer.group).instances;
      expect(instances).toBeGreaterThanOrEqual(128);
      // Au plus une plinthe locale par bâtiment.
      expect(instances).toBeLessThanOrEqual(256);
    } finally {
      layer.dispose();
    }
  });

  it('bascule les villes lointaines en un seul lot simplifié', () => {
    const map = makeMap(64, 64, (fixture) => {
      fillRect(fixture, 14, 14, 12, 12, TILE_KIND_INDEX.house);
    });
    const layer = new CityLayer();
    layer.build(
      [
        {
          id: 0,
          name: 'Test',
          x: 20.5,
          y: 20.5,
          population: 500,
          growthRate: 2,
          buildings: 144,
          rating: 60,
        },
      ],
      map,
    );
    try {
      const nearDraws = layer.drawCallCount;
      layer.update(new THREE.Vector3(10_000, 0, 10_000));
      expect(layer.distantTownCount).toBe(1);
      expect(layer.drawCallCount).toBe(1);
      expect(layer.drawCallCount).toBeLessThan(nearDraws);
      expect(layer.buildingCount).toBe(144);

      layer.update(new THREE.Vector3(20, 0, 20));
      expect(layer.distantTownCount).toBe(0);
      expect(layer.drawCallCount).toBe(nearDraws);
    } finally {
      layer.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Végétation
// ---------------------------------------------------------------------------
describe('budgets VegetationLayer', () => {
  it('respecte le plafond d’arbres du preset et le budget de chunks', () => {
    const map = makeMap(64, 64, (fixture) => {
      fillRect(fixture, 0, 0, 64, 64, TILE_KIND_INDEX.trees);
    });
    for (const quality of QUALITY_LEVELS) {
      const layer = new VegetationLayer();
      layer.build(map, quality);
      try {
        const settings = qualitySettings(quality);
        expect(layer.count).toBeLessThanOrEqual(settings.maxTrees);
        expect(layer.count).toBeGreaterThan(0);
        // #24 : la végétation est chunkée pour le frustum culling. Chaque
        // chunk proche porte tronc + houppier, un chunk lointain seulement le
        // houppier basse définition. Le plafond reste 16 chunks (32 draw calls).
        expect(layer.chunkCount).toBeLessThanOrEqual(16);
        expect(layer.drawCallCount).toBe(layer.chunkCount * 2);
        const stats = groupStats(layer.group);
        expect(stats.drawCalls).toBe(layer.drawCallCount);
        expect(stats.triangles).toBeLessThanOrEqual(
          layer.count * BUDGETS.vegetationTrianglesPerTree,
        );
        expect(stats.triangles).toBeGreaterThan(0);

        // Vue carte : les troncs disparaissent, un draw call par chunk.
        layer.update(0, new THREE.Vector3(10_000, 0, 10_000));
        expect(layer.farChunkCount).toBe(layer.chunkCount);
        expect(layer.drawCallCount).toBe(layer.chunkCount);
        expect(groupStats(layer.group).drawCalls).toBe(layer.chunkCount);
        expect(layer.count).toBeLessThanOrEqual(settings.maxTrees);
      } finally {
        layer.dispose();
      }
    }
  });

  it('la densité et le plafond croissent avec la qualité', () => {
    const map = makeMap(128, 128, (fixture) => {
      fillRect(fixture, 0, 0, 128, 128, TILE_KIND_INDEX.trees);
    });
    const counts: number[] = [];
    for (const quality of QUALITY_LEVELS) {
      const layer = new VegetationLayer();
      layer.build(map, quality);
      counts.push(layer.count);
      layer.dispose();
    }
    expect(counts[0]).toBeLessThanOrEqual(counts[1] ?? 0);
    expect(counts[1]).toBeLessThanOrEqual(counts[2] ?? 0);
    expect(counts[2]).toBeLessThanOrEqual(qualitySettings('high').maxTrees);
  });
});

// ---------------------------------------------------------------------------
// Véhicules
// ---------------------------------------------------------------------------
describe('budgets VehicleLayer', () => {
  it('un draw call par variante, quel que soit le nombre de véhicules', () => {
    const layer = new VehicleLayer();
    const models = ['train', 'truck', 'bus', 'ship', 'plane'] as const;
    try {
      const small: RenderVehicle[] = [];
      for (let index = 0; index < 40; index += 1) {
        small.push(renderVehicle(index, models[index % models.length] ?? 'bus'));
      }
      layer.update(small);
      const smallDraws = layer.drawCallCount;

      const large: RenderVehicle[] = [];
      for (let index = 0; index < 300; index += 1) {
        large.push(renderVehicle(index, models[index % models.length] ?? 'bus'));
      }
      layer.update(large);
      expect(layer.instanceCount).toBe(300);
      expect(layer.drawCallCount).toBe(smallDraws);
      expect(layer.drawCallCount).toBeLessThanOrEqual(BUDGETS.vehicleDrawCalls);
      expect(layer.drawCallCount).toBeLessThanOrEqual(VEHICLE_VARIANTS.length);
      expect(groupStats(layer.group).drawCalls).toBeLessThanOrEqual(VEHICLE_VARIANTS.length);

      let triangles = 0;
      for (const child of layer.group.children) {
        const mesh = child as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || mesh.name.startsWith('vehicle-halo')) continue;
        triangles += triangleCount(mesh.geometry) * mesh.count;
        expect(triangleCount(mesh.geometry)).toBeLessThanOrEqual(BUDGETS.vehicleTrianglesPerModel);
      }
      expect(triangles).toBeLessThanOrEqual(BUDGETS.vehicleTrianglesFor300);
      expect(triangles).toBeGreaterThan(0);
    } finally {
      layer.dispose();
    }
  });

  it('les géométries détaillées restent sous le budget par variante', () => {
    const layer = new VehicleLayer();
    const models = ['train', 'truck', 'bus', 'ship', 'plane'] as const;
    try {
      const vehicles: RenderVehicle[] = [];
      for (let index = 0; index < 60; index += 1) {
        vehicles.push(renderVehicle(index, models[index % models.length] ?? 'bus'));
      }
      layer.update(vehicles);
      for (const child of layer.group.children) {
        const mesh = child as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || mesh.name.startsWith('vehicle-halo')) continue;
        const triangles = triangleCount(mesh.geometry);
        expect(triangles, `${mesh.name} : ${triangles} triangles`).toBeLessThanOrEqual(
          BUDGETS.vehicleTrianglesPerModel,
        );
      }
    } finally {
      layer.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Industries
// ---------------------------------------------------------------------------
describe('budgets IndustryLayer', () => {
  function industrialFixture(): { map: MapSnapshot; industries: IndustrySnapshot[] } {
    const definitions = [
      { kind: 'coal_mine', x: 12, y: 12 },
      { kind: 'power_station', x: 30, y: 12 },
      { kind: 'sawmill', x: 48, y: 12 },
      { kind: 'farm', x: 12, y: 30 },
      { kind: 'factory', x: 30, y: 30 },
    ];
    const map = makeMap(64, 64, (fixture) => {
      for (const definition of definitions) {
        fillRect(fixture, definition.x - 1, definition.y - 1, 3, 3, TILE_KIND_INDEX.industry);
      }
    });
    const industries: IndustrySnapshot[] = definitions.map((definition, id) => ({
      id,
      name: `Industrie ${id}`,
      kind: definition.kind,
      x: definition.x + 0.5,
      y: definition.y + 0.5,
      production: 200,
      transported: 80,
      stocks: [{ cargo: 'coal', amount: 40 }],
    }));
    return { map, industries };
  }

  it('fusionne les parties par archétype et borne les triangles par industrie', () => {
    const { map, industries } = industrialFixture();
    for (const quality of QUALITY_LEVELS) {
      const layer = new IndustryLayer();
      layer.build(industries, map, quality);
      try {
        expect(layer.industryCount).toBe(industries.length);
        expect(layer.partCount).toBeLessThanOrEqual(
          industries.length * BUDGETS.maxIndustryPartsPerIndustry,
        );
        const stats = groupStats(layer.group);
        // 5 archétypes distincts + la fumée instanciée.
        expect(stats.drawCalls).toBeLessThanOrEqual(6);
        expect(stats.triangles).toBeLessThanOrEqual(
          industries.length * BUDGETS.maxIndustryTrianglesPerIndustry,
        );
        expect(stats.triangles).toBeGreaterThan(0);
        for (const [archetype, detail] of Object.entries(layer.archetypeStats)) {
          expect(
            detail.triangles,
            `${archetype} : ${detail.triangles} triangles`,
          ).toBeLessThanOrEqual(BUDGETS.maxIndustryTrianglesPerIndustry);
        }
      } finally {
        layer.dispose();
      }
    }
  });

  it('le niveau de détail ne fait qu’ajouter des parties', () => {
    const { map, industries } = industrialFixture();
    const counts: number[] = [];
    for (const quality of QUALITY_LEVELS) {
      const layer = new IndustryLayer();
      layer.build(industries, map, quality);
      counts.push(layer.partCount);
      layer.dispose();
    }
    expect(counts[0]).toBeLessThanOrEqual(counts[1] ?? 0);
    expect(counts[1]).toBeLessThanOrEqual(counts[2] ?? 0);
  });

  it('bascule les lots lointains en géométrie simplifiée', () => {
    const { map, industries } = industrialFixture();
    const layer = new IndustryLayer();
    layer.build(industries, map, 'high');
    try {
      layer.update(0.016, new THREE.Vector3(12, 40, 12));
      expect(layer.coarseLods).toBe(0);
      layer.update(0.016, new THREE.Vector3(100_000, 40, 100_000));
      expect(layer.coarseLods).toBeGreaterThan(0);
      expect(layer.industryCount).toBe(industries.length);
    } finally {
      layer.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Dépôts et signaux : capes d'instances fixes
// ---------------------------------------------------------------------------
describe('budgets des couches instanciées', () => {
  it('les dépôts tiennent dans quatre InstancedMesh plafonnés à 512', () => {
    const layer = new DepotLayer();
    const map = makeMap(64, 64);
    const depots = Array.from({ length: 600 }, (_, id) => ({
      id,
      company: 0,
      kind: 'road' as const,
      x: id % 60,
      y: Math.floor(id / 60),
      direction: id % 4,
      width: 1,
      height: 1,
    }));
    layer.setDepots(depots, map);
    try {
      expect(layer.count).toBe(512);
      // Corps + livrée route, corps + livrée rail : quatre lots fixes.
      expect(layer.group.children.length).toBe(4);
      expect(
        layer.group.children.every((child) => (child as THREE.InstancedMesh).isInstancedMesh),
      ).toBe(true);
      const used = layer.group.children
        .map((child) => (child as THREE.InstancedMesh).count)
        .reduce((total, count) => total + count, 0);
      // Un dépôt route = un corps + une livrée.
      expect(used).toBe(512 * 2);
      expect(layer.drawCallCount).toBe(2);
    } finally {
      layer.dispose();
    }
  });

  it('les caténaires tiennent dans deux InstancedMesh bornés', () => {
    const layer = new CatenaryLayer();
    const map = makeMap(64, 64, (fixture) => {
      for (let x = 1; x < 60; x += 1) {
        const index = 32 * 64 + x;
        fixture.kind[index] = TILE_KIND_INDEX.rail;
        fixture.flags[index] = TILE_FLAG.ELECTRIFIED;
      }
    });
    layer.setMap(map);
    try {
      expect(layer.countPosts).toBeGreaterThan(0);
      expect(layer.countPosts).toBeLessThanOrEqual(8192);
      expect(layer.countWires).toBeLessThanOrEqual(16384);
      expect(layer.group.children.length).toBe(2);
      expect(
        layer.group.children.every((child) => (child as THREE.InstancedMesh).isInstancedMesh),
      ).toBe(true);
    } finally {
      layer.dispose();
    }
  });

  it('les signaux tiennent dans deux InstancedMesh (poteaux + pastilles)', () => {
    const layer = new SignalLayer();
    const map = makeMap(64, 64, (fixture) => {
      for (let index = 0; index < 500; index += 1) {
        const x = index % 60;
        const y = Math.floor(index / 60);
        fixture.kind[y * 64 + x] = TILE_KIND_INDEX.rail;
        fixture.flags[y * 64 + x] = TILE_FLAG.SIGNAL;
      }
    });
    layer.setMap(map);
    try {
      expect(layer.count).toBe(500);
      expect(layer.group.children.length).toBe(2);
      expect(
        layer.group.children.every((child) => (child as THREE.InstancedMesh).isInstancedMesh),
      ).toBe(true);
    } finally {
      layer.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Moteur mock : snapshot et step
// ---------------------------------------------------------------------------
describe('budgets moteur mock', () => {
  async function createEngine(size: number): Promise<MockEngine> {
    const engine = new MockEngine();
    await engine.init({ moduleUrl: 'mock://engine' });
    await engine.newGame({ seed: 4242, width: size, height: size });
    return engine;
  }

  for (const size of [128, 256]) {
    it(`${size}×${size} : snapshot et step sous budget`, async () => {
      const engine = await createEngine(size);
      try {
        // Échauffement : JIT et premières allocations.
        engine.snapshot();
        for (let index = 0; index < 5; index += 1) engine.step(1);

        const snapshots: number[] = [];
        for (let index = 0; index < 15; index += 1) {
          const start = now();
          engine.snapshot();
          snapshots.push(now() - start);
        }
        const steps: number[] = [];
        for (let index = 0; index < 15; index += 1) {
          const start = now();
          engine.step(1);
          steps.push(now() - start);
        }
        expect(percentile(snapshots, 0.95)).toBeLessThanOrEqual(BUDGETS.snapshotP95Ms);
        expect(percentile(steps, 0.95)).toBeLessThanOrEqual(BUDGETS.stepP95Ms);
      } finally {
        engine.dispose();
      }
    });
  }

  it('ne renvoie la carte que lorsqu’elle change (mock)', async () => {
    const engine = await createEngine(128);
    try {
      const first = engine.snapshot();
      expect(first.map).not.toBeNull();
      const second = engine.snapshot();
      expect(second.map).toBeNull();
    } finally {
      engine.dispose();
    }
  });

  it('un snapshot avec carte reste sous budget après une construction', async () => {
    const engine = await createEngine(128);
    try {
      const snapshot = engine.snapshot();
      const map = snapshot.map;
      if (!map) throw new Error('carte absente');
      // Trouve une ligne de 6 tuiles herbeuses constructibles.
      let run: { x: number; y: number } | null = null;
      for (let y = 8; y < map.height - 8 && !run; y += 1) {
        for (let x = 8; x < map.width - 14; x += 1) {
          let valid = true;
          for (let dx = 0; dx < 6; dx += 1) {
            if (map.kind[y * map.width + x + dx] !== TILE_KIND_INDEX.grass) {
              valid = false;
              break;
            }
          }
          if (valid) {
            run = { x, y };
            break;
          }
        }
      }
      if (!run) throw new Error('aucune ligne constructible dans la fixture');
      engine.send({
        type: 'build',
        tool: 'road',
        company: 0,
        from: run,
        to: { x: run.x + 5, y: run.y },
      });
      const timings: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        const start = now();
        const dirty = engine.snapshot();
        timings.push(now() - start);
        // Le mock ne renvoie la carte que lorsqu'elle a changé.
        expect(dirty.map === null || dirty.map.kind.length === 128 * 128).toBe(true);
      }
      expect(percentile(timings, 0.95)).toBeLessThanOrEqual(BUDGETS.snapshotMapP95Ms);
    } finally {
      engine.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Presets : budgets statiques de qualité
// ---------------------------------------------------------------------------
describe('budgets de qualité', () => {
  it('les plafonds de végétation et de distance croissent avec le preset', () => {
    const low = qualitySettings('low');
    const medium = qualitySettings('medium');
    const high = qualitySettings('high');
    expect(low.maxTrees).toBe(4_000);
    expect(medium.maxTrees).toBe(9_000);
    expect(high.maxTrees).toBe(16_000);
    expect(low.drawDistance).toBeLessThan(medium.drawDistance);
    expect(medium.drawDistance).toBeLessThan(high.drawDistance);
    expect(high.maxTrees * BUDGETS.vegetationTrianglesPerTree).toBe(640_000);
  });

  it('les ombres et l’antialiasing restent cantonnés aux presets hauts', () => {
    expect(qualitySettings('low').shadows).toBe(false);
    expect(qualitySettings('medium').shadows).toBe(false);
    expect(qualitySettings('high').shadows).toBe(true);
    expect(qualitySettings('low').antialias).toBe(false);
  });
});
