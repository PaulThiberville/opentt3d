import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { VegetationLayer, computeTreeSignature } from '../src/render/VegetationLayer';

function makeMap(width = 128, height = 128): MapSnapshot {
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

/** Petit bosquet dense autour d'un centre, pour maîtriser les chunks. */
function plantGrove(map: MapSnapshot, cx: number, cy: number, radius = 3): void {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      map.kind[y * map.width + x] = TILE_KIND_INDEX.trees;
    }
  }
}

function canopyMeshes(layer: VegetationLayer): THREE.InstancedMesh[] {
  return layer.group.children.filter(
    (child): child is THREE.InstancedMesh =>
      (child as THREE.InstancedMesh).isInstancedMesh === true && child.name === 'trees-canopies',
  );
}

function maxCanopyHeight(layer: VegetationLayer): number {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  let maximum = Number.NEGATIVE_INFINITY;
  for (const mesh of canopyMeshes(layer)) {
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      maximum = Math.max(maximum, position.y);
    }
  }
  return maximum;
}

describe('VegetationLayer : rebuild idempotent', () => {
  it('ne reconstruit pas pour un snapshot identique', () => {
    const map = makeMap();
    plantGrove(map, 32, 32);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    expect(layer.builds).toBe(1);
    expect(layer.count).toBeGreaterThan(0);
    const children = layer.group.children.slice();

    layer.build(map, 'medium');
    layer.build(map, 'medium');
    expect(layer.builds).toBe(1);
    expect(layer.group.children).toEqual(children);
    layer.dispose();
  });

  it('reconstruit quand une hauteur de tuile d’arbre change', () => {
    const map = makeMap();
    plantGrove(map, 32, 32, 1);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    expect(layer.builds).toBe(1);
    const before = maxCanopyHeight(layer);

    map.heightMap[32 * map.width + 32] = 9;
    layer.build(map, 'medium');
    expect(layer.builds).toBe(2);
    expect(maxCanopyHeight(layer)).toBeGreaterThan(before);
    layer.dispose();
  });

  it('signe les arbres à partir des tuiles, hauteurs et preset', () => {
    const map = makeMap(32, 32);
    plantGrove(map, 10, 10, 1);
    const medium = computeTreeSignature(map, 'medium');
    expect(computeTreeSignature(map, 'medium')).toBe(medium);
    expect(computeTreeSignature(map, 'high')).not.toBe(medium);
    map.kind[10 * 32 + 10] = TILE_KIND_INDEX.grass;
    expect(computeTreeSignature(map, 'medium')).not.toBe(medium);
    const other = makeMap(32, 32);
    plantGrove(other, 10, 10, 1);
    other.heightMap[10 * 32 + 10] = 7;
    expect(computeTreeSignature(other, 'medium')).not.toBe(medium);
  });
});

describe('VegetationLayer : culling et LOD', () => {
  it('découpe la carte en chunks culled et bornés', () => {
    const map = makeMap(256, 256);
    plantGrove(map, 20, 20, 4);
    plantGrove(map, 130, 130, 4);
    plantGrove(map, 230, 40, 4);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    expect(layer.chunkCount).toBeGreaterThan(1);
    expect(layer.chunkCount).toBeLessThanOrEqual(16);
    for (const mesh of canopyMeshes(layer)) {
      expect(mesh.frustumCulled).toBe(true);
      const sphere = mesh.geometry.boundingSphere;
      expect(sphere).not.toBeNull();
      expect(Number.isFinite(sphere?.radius ?? Number.NaN)).toBe(true);
    }
    layer.dispose();
  });

  it('applique une hystérésis sans popping entre near et far', () => {
    const map = makeMap(128, 128);
    plantGrove(map, 16, 16, 2);
    plantGrove(map, 112, 112, 2);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    expect(layer.nearChunkCount).toBe(2);
    expect(layer.lodSwitches).toBe(0);

    const camera = new THREE.Vector3(16, 20, 16);
    // Le second chunk est à ~136 tuiles : il passe en silhouette basse.
    layer.update(0, camera);
    expect(layer.farChunkCount).toBe(1);
    expect(layer.lodSwitches).toBe(1);
    expect(layer.drawCallCount).toBe(3);

    // 95 tuiles : entre near (90) et far (112), l'état courant est conservé.
    layer.update(0, new THREE.Vector3(16, 20, 111));
    expect(layer.farChunkCount).toBe(1);
    expect(layer.lodSwitches).toBe(1);

    // 120 tuiles : au-delà du seuil far, le chunk bascule.
    layer.update(0, new THREE.Vector3(16, 20, 136));
    expect(layer.farChunkCount).toBe(2);
    expect(layer.lodSwitches).toBe(2);

    // Retour à 95 tuiles : on reste far, aucune bascule prématurée.
    layer.update(0, new THREE.Vector3(16, 20, 111));
    expect(layer.farChunkCount).toBe(2);
    expect(layer.lodSwitches).toBe(2);

    // Sous le seuil near, retour au détail.
    layer.update(0, new THREE.Vector3(16, 20, 96));
    expect(layer.nearChunkCount).toBe(1);
    expect(layer.lodSwitches).toBe(3);
    layer.dispose();
  });

  it('libère tous les meshes et attributs au dispose', () => {
    const map = makeMap(128, 128);
    plantGrove(map, 32, 32);
    plantGrove(map, 96, 96);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    expect(layer.group.children.length).toBeGreaterThan(0);
    // Aucun attribut instancié spécifique n'est alloué (le vent dérive de
    // la matrice d'instance) : le rebuild ne peut pas fuir de buffer GPU.
    for (const mesh of canopyMeshes(layer)) {
      expect(mesh.geometry.getAttribute('aPhase')).toBeUndefined();
    }
    const children = layer.group.children.slice();
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.count).toBe(0);
    expect(layer.chunkCount).toBe(0);
    for (const mesh of children as THREE.InstancedMesh[]) {
      expect(mesh.instanceMatrix.array).toBeDefined();
    }
  });
});

describe('VegetationLayer : mémoire des rebuilds', () => {
  it('garde un nombre de meshes constant sur des rebuilds répétés', () => {
    const map = makeMap(128, 128);
    plantGrove(map, 32, 32);
    plantGrove(map, 96, 96);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    const baseline = layer.group.children.length;
    expect(layer.drawCallCount).toBe(layer.chunkCount * 2);
    for (let step = 0; step < 40; step += 1) {
      // Une tuile change à chaque snapshot : le rebuild est légitime.
      const index = 32 * map.width + 32;
      map.kind[index] = step % 2 === 0 ? TILE_KIND_INDEX.grass : TILE_KIND_INDEX.trees;
      layer.build(map, 'medium');
      expect(layer.group.children.length).toBe(baseline);
      expect(layer.drawCallCount).toBe(layer.chunkCount * 2);
    }
    layer.dispose();
  });
});
