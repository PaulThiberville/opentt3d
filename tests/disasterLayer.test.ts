import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { DisasterLayer } from '../src/render/DisasterLayer';

function makeMap(): MapSnapshot {
  const width = 32;
  const height = 32;
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

describe('DisasterLayer (#172)', () => {
  it('reste invisible sans désastre actif', () => {
    const layer = new DisasterLayer();
    layer.setDisasters(undefined, makeMap());
    expect(layer.group.visible).toBe(false);
    const mesh = layer.group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(0);
    layer.dispose();
  });

  it('place une balise par désastre actif', () => {
    const layer = new DisasterLayer();
    layer.setDisasters(
      [
        {
          id: 1,
          kind: 'fire',
          x: 4.5,
          y: 6.5,
          company: 255,
          severity: 2,
          startedTick: 12,
          remainingDays: 4,
        },
        {
          id: 2,
          kind: 'train_crash',
          x: 10.5,
          y: 12.5,
          company: 1,
          vehicle: 3,
          severity: 3,
          startedTick: 20,
          remainingDays: 2,
        },
      ],
      makeMap(),
    );
    expect(layer.group.visible).toBe(true);
    const mesh = layer.group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(4.5, 1);
    expect(position.z).toBeCloseTo(6.5, 1);
    expect(position.y).toBeGreaterThan(0);
    layer.update(0.5);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
  });
});
