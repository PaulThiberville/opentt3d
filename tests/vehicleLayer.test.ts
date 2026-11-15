import { describe, expect, it } from 'vitest';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';
import { VehicleLayer } from '../src/render/VehicleLayer';

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

  it('libère tous les meshes au dispose', () => {
    const layer = new VehicleLayer();
    layer.update([vehicle(), vehicle({ id: 2, model: 'train' })]);
    expect(layer.group.children.length).toBeGreaterThan(0);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.instanceCount).toBe(0);
  });
});
