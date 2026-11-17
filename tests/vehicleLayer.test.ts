import { describe, expect, it } from 'vitest';
import type { InstancedMesh } from 'three';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';
import {
  SHIP_WATERLINE_OFFSET,
  VehicleLayer,
  vehicleGroundOffset,
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

  it('libère tous les meshes au dispose', () => {
    const layer = new VehicleLayer();
    layer.update([vehicle(), vehicle({ id: 2, model: 'train' })]);
    expect(layer.group.children.length).toBeGreaterThan(0);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.instanceCount).toBe(0);
  });
});
