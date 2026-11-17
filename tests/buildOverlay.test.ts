import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { planBuild } from '../src/game/buildRules';
import { BuildOverlay } from '../src/render/BuildOverlay';
import { ONEWAY_ARROW_HEAD, ONEWAY_ARROW_LENGTH, ROAD_LANE_OFFSET } from '../src/render/TrackLayer';

function makeMap(width = 16, height = 16): MapSnapshot {
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

function arrowsOf(overlay: BuildOverlay): THREE.InstancedMesh {
  const mesh = overlay.group.children.find((child) => child.name === 'build-oneway-arrows') as
    THREE.InstancedMesh | undefined;
  if (!mesh) throw new Error('flèches du fantôme absentes');
  return mesh;
}

function decompose(mesh: THREE.InstancedMesh, index: number) {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(position, quaternion, scale);
  return { matrix, position, quaternion, scale };
}

describe('BuildOverlay : flèches du fantôme à sens unique (#246)', () => {
  it('affiche deux flèches blanches par tuile, orientées vers l’est', () => {
    const map = makeMap();
    const overlay = new BuildOverlay();
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 5, y: 5 },
      to: { x: 7, y: 5 },
      roadDirection: 'east',
    });
    expect(plan.valid).toBe(true);
    overlay.setPlan(plan, map);

    const mesh = arrowsOf(overlay);
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(3 * 2);
    expect((mesh.material as THREE.MeshBasicMaterial).color.getHexString()).toBe('ffffff');
    for (let index = 0; index < mesh.count; index += 1) {
      const { position, quaternion } = decompose(mesh, index);
      const direction = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
      expect(direction.x).toBeGreaterThan(0.99);
      expect(Math.abs(direction.z)).toBeLessThan(1e-6);
      const lane = index % 2 === 0 ? -ROAD_LANE_OFFSET : ROAD_LANE_OFFSET;
      expect(position.z).toBeCloseTo(5.5 + lane, 5);
      expect(position.x).toBeGreaterThanOrEqual(5.5);
      expect(position.x).toBeLessThanOrEqual(7.5);
    }
    // Même longueur et même pointe que le marquage posé sur la chaussée.
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    expect(box).not.toBeNull();
    if (box) {
      expect(box.max.x - box.min.x).toBeCloseTo(ONEWAY_ARROW_LENGTH, 5);
      expect(box.max.z - box.min.z).toBeCloseTo(ONEWAY_ARROW_HEAD * 2, 5);
    }
    overlay.dispose();
  });

  it('oriente les flèches vers l’ouest, le sud et le nord', () => {
    const map = makeMap();
    const overlay = new BuildOverlay();
    const expected = [
      { direction: 'west', x: -1, z: 0, axis: 'x' },
      { direction: 'south', x: 0, z: 1, axis: 'y' },
      { direction: 'north', x: 0, z: -1, axis: 'y' },
    ] as const;
    for (const item of expected) {
      const plan = planBuild({
        map,
        tool: 'road',
        from: { x: 5, y: 5 },
        to: item.axis === 'x' ? { x: 8, y: 5 } : { x: 5, y: 8 },
        roadDirection: item.direction,
      });
      expect(plan.valid).toBe(true);
      overlay.setPlan(plan, map);
      const mesh = arrowsOf(overlay);
      expect(mesh.visible).toBe(true);
      const { position, quaternion } = decompose(mesh, 0);
      const direction = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
      expect(direction.x).toBeCloseTo(item.x, 5);
      expect(direction.z).toBeCloseTo(item.z, 5);
      const lane = -ROAD_LANE_OFFSET;
      if (item.axis === 'x') {
        expect(position.z).toBeCloseTo(5.5 + lane, 5);
      } else {
        expect(position.x).toBeCloseTo(5.5 + lane, 5);
      }
    }
    overlay.dispose();
  });

  it('masque les flèches pour une route à double sens et après clear', () => {
    const map = makeMap();
    const overlay = new BuildOverlay();
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 5, y: 5 },
      to: { x: 8, y: 5 },
      roadDirection: 'both',
    });
    overlay.setPlan(plan, map);
    const mesh = arrowsOf(overlay);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
    overlay.clear();
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
    overlay.dispose();
    expect(overlay.group.children).toHaveLength(0);
  });
});
