import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';
import { Picking } from '../src/render/Picking';
import { VehicleLayer } from '../src/render/VehicleLayer';

function bus(id: number, x: number, y: number): RenderVehicle {
  return {
    id,
    kind: 'road',
    model: 'bus',
    company: 0,
    x,
    y,
    z: 0,
    direction: 64,
    status: 1,
    speed: 30,
  };
}

describe('picking des nouveaux modèles', () => {
  it('touche un bus instancié et renvoie son id', () => {
    const layer = new VehicleLayer();
    layer.update([bus(7, 10, 5)]);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(10, 6, 11);
    camera.lookAt(10, 0.3, 5);
    camera.updateMatrixWorld();
    const picking = new Picking(
      {
        vehicles: () => layer.pickTargets(),
        buildings: () => [],
        terrain: () => [],
      },
      () => 0,
    );
    const result = picking.pickWithCamera({ x: 0, y: 0 }, camera);
    expect(result?.kind).toBe('vehicle');
    if (result?.kind === 'vehicle') expect(result.id).toBe(7);
    picking.dispose();
    layer.dispose();
  });

  it('touche chaque archétype à travers son maillage instancié', () => {
    const models = ['train', 'truck', 'bus', 'ship', 'plane'] as const;
    for (let index = 0; index < models.length; index += 1) {
      const layer = new VehicleLayer();
      const model = models[index];
      if (!model) continue;
      const x = 20;
      const z = 10;
      const vehicle: RenderVehicle = {
        ...bus(0, x, z),
        model,
      };
      layer.update([vehicle]);
      const mesh = layer.group.children.find((child) => child instanceof THREE.InstancedMesh);
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      const raycaster = new THREE.Raycaster();
      raycaster.set(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, -1, 0));
      const hits = raycaster.intersectObject(mesh as THREE.InstancedMesh, false);
      expect(hits.length, model).toBeGreaterThan(0);
      expect(hits[0]?.instanceId).toBe(0);
      layer.dispose();
    }
  });
});
