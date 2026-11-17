import { describe, expect, it } from 'vitest';
import { InstancedMesh } from 'three';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';
import {
  SHIP_WATERLINE_OFFSET,
  VehicleLayer,
  vehicleGroundOffset,
  vehicleInsideTunnel,
} from '../src/render/VehicleLayer';
import { waterSurfaceHeight } from '../src/render/waterSurface';

function vehicle(overrides: Partial<RenderVehicle> = {}): RenderVehicle {
  return {
    id: 1,
    kind: 'road',
    model: 'bus',
    company: 0,
    x: 10,
    y: 12,
    z: 2,
    direction: 64,
    status: 1,
    speed: 1,
    ...overrides,
  };
}

describe('VehicleLayer : uploads conditionnels', () => {
  it('ne réuploade rien quand rien ne change', () => {
    const layer = new VehicleLayer();
    const vehicles = [vehicle(), vehicle({ id: 2, model: 'truck', company: 1 })];
    layer.update(vehicles);
    expect(layer.matrixUploads).toBeGreaterThan(0);
    expect(layer.colourUploads).toBeGreaterThan(0);

    const matrices = layer.matrixUploads;
    const colours = layer.colourUploads;
    layer.update(vehicles);
    expect(layer.matrixUploads).toBe(matrices);
    expect(layer.colourUploads).toBe(colours);
    layer.dispose();
  });

  it('réuploade les matrices sans toucher aux couleurs lors d’un déplacement', () => {
    const layer = new VehicleLayer();
    const vehicles = [vehicle(), vehicle({ id: 2, model: 'truck', company: 1 })];
    layer.update(vehicles);
    const matrices = layer.matrixUploads;
    const colours = layer.colourUploads;

    vehicles[0]!.x += 0.25;
    layer.update(vehicles);
    expect(layer.matrixUploads).toBeGreaterThan(matrices);
    expect(layer.colourUploads).toBe(colours);
    layer.dispose();
  });

  it('réuploade les couleurs quand la livrée change', () => {
    const layer = new VehicleLayer();
    const vehicles = [vehicle()];
    layer.update(vehicles);
    const colours = layer.colourUploads;
    vehicles[0]!.company = 3;
    layer.update(vehicles);
    expect(layer.colourUploads).toBeGreaterThan(colours);
    layer.dispose();
  });

  it('détecte un changement de famille même à modèle visuel identique', () => {
    const layer = new VehicleLayer();
    const vehicles = [vehicle()];
    layer.update(vehicles);
    const matrices = layer.matrixUploads;
    vehicles[0]!.kind = 'train';
    layer.update(vehicles);
    expect(layer.matrixUploads).toBeGreaterThan(matrices);
    layer.dispose();
  });

  it('cale la coque des bateaux sous la ligne de flottaison (#215)', () => {
    // Le mock expose z = 0,12 pour les navires au niveau de la mer.
    const z = 0.12;
    expect(vehicleGroundOffset('ship', 0.01)).toBe(SHIP_WATERLINE_OFFSET);
    expect(vehicleGroundOffset('bus-city', 0.01)).toBe(0.01);
    expect(z + SHIP_WATERLINE_OFFSET).toBeLessThan(z);
    // La coque est immergée : son bas passe sous la surface de l'eau.
    expect(z + SHIP_WATERLINE_OFFSET).toBeLessThanOrEqual(waterSurfaceHeight(0) + 0.02);

    const layer = new VehicleLayer();
    layer.update([vehicle({ id: 7, kind: 'ship', model: 'ship', x: 20, y: 20, z })]);
    const ships = layer.group.children.find((child) => child.name === 'vehicles-ship') as
      InstancedMesh | undefined;
    expect(ships).toBeDefined();
    const matrix = ships!.instanceMatrix.array as Float32Array;
    expect(matrix[13]).toBeCloseTo(z + SHIP_WATERLINE_OFFSET, 6);
    // Aucun autre décalage ne vient flotter le modèle au-dessus de l'eau.
    expect(matrix[13]).toBeLessThan(waterSurfaceHeight(0) + 0.02);
    layer.dispose();
  });

  it('incline le véhicule selon le tangage (#232), sans quart de tour parasite', () => {
    const layer = new VehicleLayer();
    layer.update([vehicle({ id: 12, kind: 'road', model: 'bus', direction: 64, pitch: 0.3 })]);
    const mesh = layer.group.children.find(
      (child): child is InstancedMesh => child instanceof InstancedMesh,
    );
    if (!mesh) throw new Error('mesh de véhicule absent');
    const matrix = mesh.instanceMatrix.array as Float32Array;
    // Le modèle est orienté +X : sa colonne locale X porte le tangage.
    expect(matrix[0]).toBeCloseTo(Math.cos(0.3), 4);
    expect(matrix[1]).toBeCloseTo(Math.sin(0.3), 4);
    expect(matrix[2]).toBeCloseTo(0, 4);
    layer.dispose();
  });

  it('masque le véhicule entre les portails d’un tunnel (#244)', () => {
    const tunnel = {
      id: 9,
      kind: 'tunnel' as const,
      company: 0,
      transport: 'rail' as const,
      from: { x: 3, y: 8 },
      to: { x: 8, y: 8 },
      length: 6,
      portalHeight: 4,
    };
    expect(vehicleInsideTunnel({ x: 3.5, y: 8.5 }, [tunnel])).toBe(false);
    expect(vehicleInsideTunnel({ x: 5.5, y: 8.5 }, [tunnel])).toBe(true);
    expect(vehicleInsideTunnel({ x: 8.5, y: 8.5 }, [tunnel])).toBe(false);
    // Un véhicule sur la voie voisine, à côté du tunnel, reste visible.
    expect(vehicleInsideTunnel({ x: 5.5, y: 9.6 }, [tunnel])).toBe(false);

    const layer = new VehicleLayer();
    layer.update([vehicle({ id: 4, x: 5.5, y: 8.5 })], null, [tunnel]);
    expect(layer.instanceCount).toBe(0);
    layer.update([vehicle({ id: 4, x: 3.5, y: 8.5 })], null, [tunnel]);
    expect(layer.instanceCount).toBe(1);
    layer.dispose();
  });

  it('libère tous les meshes au dispose', () => {
    const layer = new VehicleLayer();
    layer.update([vehicle(), vehicle({ id: 2, model: 'train' })]);
    expect(layer.group.children.length).toBeGreaterThan(0);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.instanceCount).toBe(0);
  });
});
