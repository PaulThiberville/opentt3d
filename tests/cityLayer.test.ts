import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot, StationSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { CityLayer } from '../src/render/CityLayer';
import { cornerHeightWorld, sampleHeightWorld } from '../src/game/mapGrid';

function makeMap(width = 64, height = 64): MapSnapshot {
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
  };
}

function makeTownMap(): { map: MapSnapshot; town: TownSnapshot; houses: number } {
  const map = makeMap();
  const cx = 32;
  const cy = 32;
  let houses = 0;
  for (let dy = -7; dy <= 7; dy += 1) {
    for (let dx = -7; dx <= 7; dx += 1) {
      if (dx * dx + dy * dy > 49) continue;
      const x = cx + dx;
      const y = cy + dy;
      map.kind[y * map.width + x] = TILE_KIND_INDEX.house;
      map.heightMap[y * map.width + x] = 4 + ((x + y) % 2);
      houses += 1;
    }
  }
  return {
    map,
    town: {
      id: 3,
      name: 'Belle-Rive',
      x: cx + 0.5,
      y: cy + 0.5,
      population: 4_200,
      growthRate: 1,
      buildings: houses,
      rating: 80,
    },
    houses,
  };
}

function station(overrides: Partial<StationSnapshot> = {}): StationSnapshot {
  return {
    id: 0,
    company: 0,
    name: 'Gare',
    kind: 'train',
    x: 10,
    y: 12,
    width: 3,
    height: 2,
    waiting: [],
    ...overrides,
  };
}

function buckets(layer: CityLayer): THREE.InstancedMesh[] {
  return layer.group.children.filter(
    (child): child is THREE.InstancedMesh =>
      (child as THREE.InstancedMesh).isInstancedMesh === true &&
      child.name.startsWith('city-') &&
      child.name !== 'city-plinths',
  );
}

describe('CityLayer : bâtiments instanciés', () => {
  it('instancie les maisons par archétype sans draw call par bâtiment', () => {
    const { map, town, houses } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.buildingCount).toBe(houses);
    expect(layer.drawCallCount).toBeGreaterThan(0);
    expect(layer.drawCallCount).toBeLessThanOrEqual(16);
    expect(layer.triangleCount).toBeGreaterThan(houses * 10);
    // Une grande ville a toujours un point de repère religieux.
    expect(layer.group.children.some((child) => child.name.includes('church'))).toBe(true);
    for (const mesh of buckets(layer)) {
      expect(mesh.count).toBeGreaterThan(0);
      expect(mesh.geometry.getAttribute('aWindow')).toBeDefined();
    }
    layer.dispose();
  });

  it('ne déborde jamais de la tuile, même après rotation', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const mesh of buckets(layer)) {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) continue;
      const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      const halfZ = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        // Rotations par multiples de 90° : on échange les demi-extents.
        const quarterTurn = Math.round(quaternionToYaw(quaternion) / (Math.PI / 2)) % 2 !== 0;
        const extentX = (quarterTurn ? halfZ : halfX) * scale.x;
        const extentZ = (quarterTurn ? halfX : halfZ) * scale.z;
        expect(position.x - extentX).toBeGreaterThanOrEqual(Math.floor(position.x) - 1e-3);
        expect(position.x + extentX).toBeLessThanOrEqual(Math.floor(position.x) + 1 + 1e-3);
        expect(position.z - extentZ).toBeGreaterThanOrEqual(Math.floor(position.z) - 1e-3);
        expect(position.z + extentZ).toBeLessThanOrEqual(Math.floor(position.z) + 1 + 1e-3);
      }
    }
    layer.dispose();
  });

  it('reste déterministe pour une même carte', () => {
    const { map, town } = makeTownMap();
    const first = new CityLayer();
    const second = new CityLayer();
    first.build([town], map);
    second.build([town], map);
    const firstMatrices = buckets(first).map((mesh) =>
      Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    const secondMatrices = buckets(second).map((mesh) =>
      Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    expect(secondMatrices).toEqual(firstMatrices);
    first.dispose();
    second.dispose();
  });

  it('bascule les villes lointaines en silhouette simplifiée', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const detailed = layer.drawCallCount;
    layer.update(new THREE.Vector3(32, 20, 42));
    expect(layer.distantTownCount).toBe(0);
    layer.update(new THREE.Vector3(-500, 40, -500));
    expect(layer.distantTownCount).toBe(1);
    expect(layer.group.children.some((child) => child.name === 'city-far')).toBe(true);
    expect(layer.drawCallCount).toBe(1);
    expect(detailed).toBeGreaterThan(1);
    layer.update(new THREE.Vector3(32, 20, 42));
    expect(layer.distantTownCount).toBe(0);
    expect(layer.group.children.some((child) => child.name === 'city-far')).toBe(false);
    layer.dispose();
  });

  it('ne crée aucune instance plus large qu’une tuile (pas de dalle globale)', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    layer.setStations([station(), station({ id: 1, kind: 'airport', width: 3, height: 3 })], map);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const child of layer.group.children) {
      if (!(child as THREE.InstancedMesh).isInstancedMesh) continue;
      const mesh = child as THREE.InstancedMesh;
      if (mesh.count === 0) continue;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) continue;
      const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      const halfZ = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        const quarterTurn = Math.round(quaternionToYaw(quaternion) / (Math.PI / 2)) % 2 !== 0;
        expect((quarterTurn ? halfZ : halfX) * scale.x).toBeLessThanOrEqual(0.5 + 1e-3);
        expect((quarterTurn ? halfX : halfZ) * scale.z).toBeLessThanOrEqual(0.5 + 1e-3);
      }
    }
    layer.dispose();
  });

  it('pose chaque bâtiment sur sampleHeightWorld et comble les pentes par une plinthe', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.plinthCount).toBeGreaterThan(0);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const mesh of buckets(layer)) {
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        expect(position.y).toBeCloseTo(sampleHeightWorld(map, position.x, position.z), 5);
      }
    }
    const plinths = layer.group.children.find((child) => child.name === 'city-plinths');
    expect(plinths).toBeDefined();
    const plinthMesh = plinths as THREE.InstancedMesh;
    for (let index = 0; index < plinthMesh.count; index += 1) {
      plinthMesh.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(scale.x).toBeLessThanOrEqual(0.9);
      expect(scale.z).toBeLessThanOrEqual(0.9);
      expect(scale.y).toBeGreaterThan(0);
      expect(position.y + scale.y).toBeGreaterThanOrEqual(
        sampleHeightWorld(map, position.x, position.z) - 0.03,
      );
    }
    layer.dispose();
  });

  it('réduit la géométrie en basse qualité et l’augmente en haute', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const medium = layer.triangleCount;
    layer.setQuality('low');
    const low = layer.triangleCount;
    layer.setQuality('high');
    const high = layer.triangleCount;
    expect(low).toBeLessThan(medium);
    expect(high).toBeGreaterThan(medium);
    layer.dispose();
  });
});

describe('CityLayer : gares', () => {
  it('pose halle et quais multi-tuiles orientés', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    layer.setStations(
      [station(), station({ id: 1, kind: 'road', x: 20, y: 20, width: 1, height: 1 })],
      map,
    );
    expect(layer.stationCountValue).toBe(2);
    expect(layer.drawCallCount).toBe(2);
    const halls = layer.group.children.find((child) => child.name === 'station-halls');
    const platforms = layer.group.children.find((child) => child.name === 'station-platforms');
    expect((halls as THREE.InstancedMesh).count).toBe(2);
    expect((platforms as THREE.InstancedMesh).count).toBe(3 * 2 + 1);
    const matrix = new THREE.Matrix4();
    (halls as THREE.InstancedMesh).getMatrixAt(0, matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    // Gare 3×2 : la halle tient sur la première tuile, pas sur toute l'emprise.
    expect(position.x).toBeCloseTo(10.5, 5);
    expect(position.z).toBeCloseTo(12.5, 5);
    expect(scale.x).toBeLessThanOrEqual(1);
    expect(scale.z).toBeLessThanOrEqual(1);
    expect(Math.abs(quaternionToYaw(quaternion))).toBeLessThan(1e-6);
    layer.dispose();
  });

  it('tourne la halle pour une gare plus haute que large', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    layer.setStations([station({ width: 1, height: 3 })], map);
    const halls = layer.group.children.find(
      (child) => child.name === 'station-halls',
    ) as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    halls.getMatrixAt(0, matrix);
    matrix.decompose(position, quaternion, scale);
    expect(Math.abs(quaternionToYaw(quaternion))).toBeCloseTo(Math.PI / 2, 5);
    layer.dispose();
  });

  it('pose les quais par tuile à la hauteur exacte du terrain', () => {
    const { map } = makeTownMap();
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 3; dx += 1) {
        map.heightMap[(12 + dy) * map.width + (10 + dx)] = 4 + dx + dy;
      }
    }
    const layer = new CityLayer();
    layer.setStations([station()], map);
    const platforms = layer.group.children.find(
      (child) => child.name === 'station-platforms',
    ) as THREE.InstancedMesh;
    expect(platforms.count).toBe(6);
    expect(layer.stationBaseCount).toBeGreaterThan(0);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let index = 0; index < platforms.count; index += 1) {
      platforms.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(position.y).toBeCloseTo(sampleHeightWorld(map, position.x, position.z), 5);
      expect(Math.floor(position.x)).toBeGreaterThanOrEqual(10);
      expect(Math.floor(position.x)).toBeLessThanOrEqual(12);
      expect(Math.floor(position.z)).toBeGreaterThanOrEqual(12);
      expect(Math.floor(position.z)).toBeLessThanOrEqual(13);
      const tileX = Math.floor(position.x);
      const tileY = Math.floor(position.z);
      const minCorner = Math.min(
        cornerHeightWorld(map, tileX, tileY),
        cornerHeightWorld(map, tileX + 1, tileY),
        cornerHeightWorld(map, tileX, tileY + 1),
        cornerHeightWorld(map, tileX + 1, tileY + 1),
      );
      expect(position.y).toBeGreaterThanOrEqual(minCorner - 1e-6);
    }
    layer.dispose();
  });

  it('ne pose pas de canopée de quai sur un aéroport', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    layer.setStations([station({ kind: 'airport', x: 10, y: 12, width: 3, height: 3 })], map);
    expect(layer.stationCountValue).toBe(1);
    expect(
      layer.group.children.find((child) => child.name === 'station-platforms'),
    ).toBeUndefined();
    expect(
      (layer.group.children.find((child) => child.name === 'station-halls') as THREE.InstancedMesh)
        .count,
    ).toBe(1);
    layer.dispose();
  });

  it('ne reconstruit pas les gares quand seule la fréquentation change', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    const base = [station()];
    layer.setStations(base, map);
    const halls = layer.group.children.find((child) => child.name === 'station-halls');
    layer.setStations([{ ...base[0]!, waiting: [{ cargo: 'passengers', amount: 42 }] }], map);
    expect(layer.group.children.find((child) => child.name === 'station-halls')).toBe(halls);
    layer.dispose();
  });
});

/** Lacet d'un quaternion de rotation Y uniquement. */
function quaternionToYaw(quaternion: THREE.Quaternion): number {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
  return euler.y;
}
