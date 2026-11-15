import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { RenderVehicle, VehicleModelKind } from '../src/game/vehicleInterpolation';
import { directionToYaw, VehicleLayer } from '../src/render/VehicleLayer';
import { ModelLibrary } from '../src/render/models/modelLibrary';
import { MODEL_COLOURS } from '../src/render/models/modelUtils';
import {
  VEHICLE_VARIANTS,
  buildVehicleModel,
  buildVehicleModels,
  disposeVehicleModels,
  vehicleVariantFor,
  type VehicleModelDefinition,
  type VehicleVariant,
} from '../src/render/models/vehicles';
import { companyColour, hexToRgb } from '../src/render/tileVisuals';

const MAX_TRIANGLES = 3000;

const GROUND_VARIANTS: readonly VehicleVariant[] = [
  'bus-city',
  'bus-coach',
  'truck-flat',
  'truck-tanker',
  'train-steam',
  'train-coach',
  'train-freight',
];

function positionsWithColour(geometry: THREE.BufferGeometry, colour: number): number[] {
  const position = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color');
  const rgb = hexToRgb(colour);
  const xs: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    const dr = Math.abs(colors.getX(i) - rgb.r);
    const dg = Math.abs(colors.getY(i) - rgb.g);
    const db = Math.abs(colors.getZ(i) - rgb.b);
    if (dr < 1e-4 && dg < 1e-4 && db < 1e-4) xs.push(position.getX(i));
  }
  return xs;
}

/** Amplitude en Z des sommets dont X tombe dans [minX, maxX]. */
function zSpan(
  geometry: THREE.BufferGeometry,
  minX: number,
  maxX: number,
): { span: number; points: number } {
  const position = geometry.getAttribute('position');
  let min = Infinity;
  let max = -Infinity;
  let points = 0;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    if (x < minX || x > maxX) continue;
    points += 1;
    const z = position.getZ(i);
    min = Math.min(min, z);
    max = Math.max(max, z);
  }
  return { span: points > 0 ? max - min : 0, points };
}

function makeVehicle(
  id: number,
  model: VehicleModelKind,
  overrides: Partial<RenderVehicle> = {},
): RenderVehicle {
  return {
    id,
    kind:
      model === 'plane'
        ? 'aircraft'
        : model === 'ship'
          ? 'ship'
          : model === 'train'
            ? 'train'
            : 'road',
    model,
    company: id % 2,
    x: id,
    y: 0,
    z: 0,
    direction: 64,
    status: 1,
    speed: 40,
    ...overrides,
  };
}

describe('bibliothèque de modèles de véhicules', () => {
  it('décrit les neuf archétypes attendus', () => {
    expect(VEHICLE_VARIANTS).toEqual([
      'train-steam',
      'train-coach',
      'train-freight',
      'truck-flat',
      'truck-tanker',
      'bus-city',
      'bus-coach',
      'ship',
      'plane',
    ]);
  });

  it('respecte le budget de triangles et les dimensions en tuiles', () => {
    const models = buildVehicleModels();
    let total = 0;
    try {
      for (const variant of VEHICLE_VARIANTS) {
        const model = models[variant];
        expect(model.variant).toBe(variant);
        expect(model.triangles).toBeGreaterThan(100);
        expect(model.triangles).toBeLessThan(MAX_TRIANGLES);
        total += model.triangles;

        // Longueur ~1 à 2 tuiles, hauteur ~0,5 à 0,72.
        expect(model.size.length).toBeGreaterThanOrEqual(1);
        expect(model.size.length).toBeLessThanOrEqual(2);
        expect(model.size.height).toBeGreaterThanOrEqual(0.5);
        expect(model.size.height).toBeLessThanOrEqual(0.72);
        if (variant === 'plane') {
          // Envergure nettement supérieure à la largeur d'un véhicule routier.
          expect(model.size.width).toBeGreaterThan(1.3);
          expect(model.size.width).toBeLessThan(1.8);
        } else {
          expect(model.size.width).toBeGreaterThan(0.3);
          expect(model.size.width).toBeLessThan(0.5);
        }

        // Roues/coque posées sur le sol, aucun débordement sous Y = 0.
        expect(Math.abs(model.bounds.minY)).toBeLessThan(0.01);
        expect(model.groundOffset).toBeGreaterThanOrEqual(0);
        expect(model.groundOffset).toBeLessThan(0.05);
        expect(model.haloRadius).toBeGreaterThanOrEqual(0.7);
        expect(model.haloRadius).toBeLessThanOrEqual(1.2);
      }
      expect(total).toBeLessThan(12_000);
    } finally {
      disposeVehicleModels(models);
    }
  });

  it('produit des géométries fusionnées, colorées et symétriques', () => {
    const models = buildVehicleModels();
    try {
      for (const variant of VEHICLE_VARIANTS) {
        const geometry = models[variant].geometry;
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        const colour = geometry.getAttribute('color');
        expect(position.count).toBeGreaterThan(0);
        expect(position.count % 3).toBe(0);
        expect(normal.count).toBe(position.count);
        expect(colour.count).toBe(position.count);
        expect(geometry.getIndex()).toBeNull();
        expect(geometry.boundingSphere).not.toBeNull();
        expect(geometry.boundingSphere?.radius ?? 0).toBeGreaterThan(0);

        for (let i = 0; i < position.count; i += 1) {
          expect(Number.isFinite(position.getX(i))).toBe(true);
          expect(Number.isFinite(position.getY(i))).toBe(true);
          expect(Number.isFinite(position.getZ(i))).toBe(true);
        }
        // Les modèles sont centrés sur l'axe de roulage / de vol.
        expect(Math.abs(models[variant].bounds.minZ + models[variant].bounds.maxZ)).toBeLessThan(
          1e-4,
        );
      }
    } finally {
      disposeVehicleModels(models);
    }
  });

  it('est strictement déterministe', () => {
    for (const variant of VEHICLE_VARIANTS) {
      const first = buildVehicleModel(variant);
      const second = buildVehicleModel(variant);
      try {
        expect(second.triangles).toBe(first.triangles);
        expect(second.bounds).toEqual(first.bounds);
        expect(second.size).toEqual(first.size);
        expect(second.geometry.getAttribute('position').array).toEqual(
          first.geometry.getAttribute('position').array,
        );
        expect(second.geometry.getAttribute('color').array).toEqual(
          first.geometry.getAttribute('color').array,
        );
      } finally {
        first.geometry.dispose();
        second.geometry.dispose();
      }
    }
  });

  it('oriente les phares et les nez vers +X', () => {
    for (const variant of GROUND_VARIANTS) {
      if (variant === 'train-coach' || variant === 'train-freight') continue;
      const model = buildVehicleModel(variant);
      try {
        const lampXs = positionsWithColour(model.geometry, MODEL_COLOURS.lamp);
        expect(lampXs.length).toBeGreaterThan(0);
        for (const x of lampXs) expect(x).toBeGreaterThan(0);
      } finally {
        model.geometry.dispose();
      }
    }

    const ship = buildVehicleModel('ship');
    try {
      const { maxX } = ship.bounds;
      const front = zSpan(ship.geometry, maxX - ship.size.length * 0.15, maxX);
      const middle = zSpan(ship.geometry, -0.2, 0.2);
      expect(front.points).toBeGreaterThan(0);
      expect(front.span).toBeLessThan(middle.span * 0.6);
    } finally {
      ship.geometry.dispose();
    }

    const plane = buildVehicleModel('plane');
    try {
      const { maxX } = plane.bounds;
      const front = zSpan(plane.geometry, maxX - plane.size.length * 0.25, maxX);
      const middle = zSpan(plane.geometry, -0.2, 0.2);
      expect(front.points).toBeGreaterThan(0);
      expect(front.span).toBeLessThan(middle.span * 0.5);
    } finally {
      plane.geometry.dispose();
    }
  });

  it('choisit un archétype stable et couvre toutes les variantes', () => {
    const seen = new Set<VehicleVariant>();
    const kinds: readonly VehicleModelKind[] = ['train', 'truck', 'bus', 'ship', 'plane'];
    for (let id = 0; id < 120; id += 1) {
      for (const kind of kinds) {
        const variant = vehicleVariantFor(kind, id);
        seen.add(variant);
        expect(vehicleVariantFor(kind, id)).toBe(variant);
      }
    }
    expect(seen.size).toBe(VEHICLE_VARIANTS.length);
    expect(vehicleVariantFor('train', 0)).toBe('train-steam');
    expect(vehicleVariantFor('train', 1)).toBe('train-coach');
    expect(vehicleVariantFor('train', 4)).toBe('train-freight');
    expect(vehicleVariantFor('train', 5)).toBe('train-steam');
    expect(vehicleVariantFor('bus', 0)).toBe('bus-coach');
    expect(vehicleVariantFor('bus', 1)).toBe('bus-city');
    expect(vehicleVariantFor('truck', 0)).toBe('truck-flat');
    expect(vehicleVariantFor('truck', 1)).toBe('truck-tanker');
    expect(vehicleVariantFor('ship', 42)).toBe('ship');
    expect(vehicleVariantFor('plane', 42)).toBe('plane');
    // Les bornes ne dépendent ni du signe ni des fractions.
    expect(vehicleVariantFor('bus', -1)).toBe(vehicleVariantFor('bus', 1));
    expect(vehicleVariantFor('bus', 4.9)).toBe(vehicleVariantFor('bus', 4));
  });
});

describe('cache de modèles', () => {
  it('construit une fois, compte les triangles et libère tout', () => {
    let builds = 0;
    const factory = (): VehicleModelDefinition => {
      builds += 1;
      const model = buildVehicleModel('bus-city');
      return model;
    };
    const library = new ModelLibrary<VehicleVariant, VehicleModelDefinition>(factory);
    const first = library.get('bus-city');
    const second = library.get('bus-city');
    expect(second).toBe(first);
    expect(builds).toBe(1);
    expect(library.size).toBe(1);
    expect(library.has('bus-city')).toBe(true);
    expect(library.has('train-steam')).toBe(false);
    expect(library.triangleCount).toBe(first.triangles);
    expect(library.stats()).toEqual({
      models: 1,
      triangles: first.triangles,
      builds: 1,
    });

    const dispose = vi.spyOn(first.geometry, 'dispose');
    library.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(library.size).toBe(0);
    expect(library.triangleCount).toBe(0);
  });

  it('précharge une liste sans reconstruire', () => {
    const library = new ModelLibrary<VehicleVariant, VehicleModelDefinition>(buildVehicleModel);
    library.preload(['bus-city', 'truck-flat']);
    expect(library.size).toBe(2);
    expect(library.buildCount).toBe(2);
    library.get('bus-city');
    expect(library.buildCount).toBe(2);
    library.dispose();
  });
});

describe('VehicleLayer et nouveaux modèles', () => {
  it('rend 300 véhicules en gardant l’instancing et les ids de picking', () => {
    const layer = new VehicleLayer();
    const models: VehicleModelKind[] = ['train', 'truck', 'bus', 'ship', 'plane'];
    const vehicles: RenderVehicle[] = [];
    for (let id = 0; id < 300; id += 1) {
      const model = models[Math.floor(id / 60)] ?? 'bus';
      vehicles.push(
        makeVehicle(id, model, {
          x: (id % 20) + 0.5,
          y: Math.floor(id / 20) + 0.5,
          direction: (id * 7) % 256,
        }),
      );
    }

    layer.update(vehicles);
    expect(layer.instanceCount).toBe(300);
    expect(layer.drawCallCount).toBe(VEHICLE_VARIANTS.length);
    const targets = layer.pickTargets();
    expect(targets).toHaveLength(VEHICLE_VARIANTS.length);

    const seenIds = new Set<number>();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const target of targets) {
      expect(target.mesh.name.startsWith('vehicles-')).toBe(true);
      expect(target.mesh.count).toBeGreaterThan(0);
      for (let instance = 0; instance < target.mesh.count; instance += 1) {
        const id = target.idForInstance(instance);
        expect(id).not.toBeNull();
        if (id !== null) seenIds.add(id);
        target.mesh.getMatrixAt(instance, matrix);
        matrix.decompose(position, quaternion, scale);
        expect(position.y).toBeGreaterThan(0);
        expect(position.y).toBeLessThan(0.1);
      }
    }
    expect(seenIds.size).toBe(300);
    layer.dispose();
  });

  it('applique la couleur d’entreprise par instance', () => {
    const layer = new VehicleLayer();
    layer.update([makeVehicle(0, 'bus', { company: 3 })]);
    const mesh = layer.group.children.find(
      (child): child is THREE.InstancedMesh =>
        child instanceof THREE.InstancedMesh && child.name === 'vehicles-bus-coach',
    );
    expect(mesh).toBeDefined();
    const colour = new THREE.Color();
    mesh?.getColorAt(0, colour);
    const rgb = hexToRgb(companyColour(3));
    expect(colour.r).toBeCloseTo(rgb.r, 4);
    expect(colour.g).toBeCloseTo(rgb.g, 4);
    expect(colour.b).toBeCloseTo(rgb.b, 4);
    layer.dispose();
  });

  it('vide les slots quand la flotte disparaît', () => {
    const layer = new VehicleLayer();
    layer.update([makeVehicle(1, 'truck')]);
    expect(layer.instanceCount).toBe(1);
    layer.update([]);
    expect(layer.instanceCount).toBe(0);
    expect(layer.pickTargets()).toHaveLength(0);
    for (const child of layer.group.children) {
      if (child instanceof THREE.InstancedMesh) expect(child.visible).toBe(false);
    }
    layer.dispose();
  });

  it('conserve la convention OpenTTD 0..255 et l’orientation +X', () => {
    const forward = new THREE.Vector3(1, 0, 0);
    const expectDirection = (direction: number, x: number, z: number): void => {
      const yaw = directionToYaw(direction);
      const rotated = forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      expect(rotated.x).toBeCloseTo(x, 5);
      expect(rotated.z).toBeCloseTo(z, 5);
    };
    // 0 = nord (-Z), 64 = est (+X), 128 = sud (+Z), 192 = ouest (-X).
    expectDirection(0, 0, -1);
    expectDirection(64, 1, 0);
    expectDirection(128, 0, 1);
    expectDirection(192, -1, 0);
    expectDirection(256, 0, -1);
  });
});
