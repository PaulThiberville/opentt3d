import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_FLAG, TILE_KIND_INDEX } from '../src/engine/protocol';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';
import { BuildOverlay } from '../src/render/BuildOverlay';
import { CityLayer } from '../src/render/CityLayer';
import { DepotLayer } from '../src/render/DepotLayer';
import { DisasterLayer } from '../src/render/DisasterLayer';
import { IndustryLayer } from '../src/render/IndustryLayer';
import { SignalLayer } from '../src/render/SignalLayer';
import { VegetationLayer } from '../src/render/VegetationLayer';
import { VehicleLayer } from '../src/render/VehicleLayer';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeMap(): MapSnapshot {
  const width = 64;
  const height = 64;
  const size = width * height;
  const map: MapSnapshot = {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
  // Bosquet, ville, gare, industrie, signal : chaque couche a de quoi allouer.
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      map.kind[(8 + dy) * width + (8 + dx)] = TILE_KIND_INDEX.trees;
      map.kind[(28 + dy) * width + (28 + dx)] = TILE_KIND_INDEX.house;
      map.kind[(48 + dy) * width + (48 + dx)] = TILE_KIND_INDEX.industry;
    }
  }
  for (let dx = 0; dx < 3; dx += 1) {
    for (let dy = 0; dy < 2; dy += 1) {
      map.kind[(20 + dy) * width + (20 + dx)] = TILE_KIND_INDEX.station;
    }
  }
  map.flags[10 * width + 10] = TILE_FLAG.SIGNAL;
  return map;
}

const town: TownSnapshot = {
  id: 7,
  name: 'Test',
  x: 28.5,
  y: 28.5,
  population: 2_000,
  growthRate: 1,
  buildings: 25,
  rating: 80,
};

const vehicles: RenderVehicle[] = [
  {
    id: 1,
    kind: 'road',
    model: 'bus',
    company: 0,
    x: 12,
    y: 12,
    z: 2,
    direction: 40,
    status: 1,
    speed: 1,
  },
];

describe('dispose des couches de rendu', () => {
  it('retire tous les meshes et libère les buffers GPU', () => {
    const map = makeMap();
    const attributeSpy = vi.spyOn(THREE.BufferAttribute.prototype, 'dispose');
    const geometrySpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');

    const vegetation = new VegetationLayer();
    vegetation.build(map, 'medium');
    const city = new CityLayer();
    city.build([town], map);
    city.setStations([], map);
    const industry = new IndustryLayer();
    industry.build(
      [
        {
          id: 1,
          name: 'Usine',
          kind: 'factory',
          x: 48,
          y: 48,
          production: 10,
          transported: 0,
          stocks: [],
        },
      ],
      map,
      'medium',
    );
    const vehiclesLayer = new VehicleLayer();
    vehiclesLayer.update(vehicles);
    const signals = new SignalLayer();
    signals.setMap(map);
    const depots = new DepotLayer();
    depots.setDepots(
      [{ id: 3, company: 0, kind: 'road', x: 30, y: 30, direction: 0, width: 1, height: 1 }],
      map,
    );
    const overlay = new BuildOverlay();
    const disasters = new DisasterLayer();
    disasters.setDisasters(
      [
        {
          id: 1,
          kind: 'fire',
          x: 20.5,
          y: 20.5,
          company: 255,
          severity: 2,
          startedTick: 10,
          remainingDays: 3,
        },
      ],
      map,
    );

    const layers = [
      { layer: vegetation, name: 'vegetation' },
      { layer: city, name: 'city' },
      { layer: industry, name: 'industry' },
      { layer: vehiclesLayer, name: 'vehicles' },
      { layer: signals, name: 'signals' },
      { layer: depots, name: 'depots' },
      { layer: disasters, name: 'disasters' },
      { layer: overlay, name: 'overlay' },
    ];
    const meshesBefore: THREE.Object3D[] = [];
    for (const { layer, name } of layers) {
      expect(layer.group.children.length, `${name} doit avoir des enfants`).toBeGreaterThan(0);
      meshesBefore.push(...layer.group.children);
    }

    for (const { layer, name } of layers) {
      layer.dispose();
      expect(layer.group.children, `${name} doit être vide après dispose`).toHaveLength(0);
      expect(layer.group.parent, `${name} doit être détaché`).toBeNull();
    }
    expect(attributeSpy).toHaveBeenCalled();
    expect(geometrySpy).toHaveBeenCalled();
    // Aucun mesh n'est resté rattaché à un groupe.
    for (const mesh of meshesBefore) {
      expect(mesh.parent).toBeNull();
    }
  });
});
