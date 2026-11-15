import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type {
  IndustrySnapshot,
  MapSnapshot,
  StationSnapshot,
  TownSnapshot,
} from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import {
  ATMOSPHERE_BUDGETS,
  AtmosphereLayer,
  computeAtmosphereSignature,
} from '../src/render/AtmosphereLayer';
import { IndustryLayer } from '../src/render/IndustryLayer';
import { QUALITY_LEVELS, qualitySettings } from '../src/render/quality';
import { VegetationLayer } from '../src/render/VegetationLayer';
import { VehicleLayer } from '../src/render/VehicleLayer';
import { sunState } from '../src/render/dayNight';
import type { RenderVehicle } from '../src/game/vehicleInterpolation';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeMap(width = 96, height = 96): MapSnapshot {
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

const towns: TownSnapshot[] = [
  {
    id: 1,
    name: 'Ville',
    x: 20.5,
    y: 20.5,
    population: 4_000,
    growthRate: 1,
    buildings: 40,
    rating: 80,
  },
  {
    id: 2,
    name: 'Bourg',
    x: 60.5,
    y: 60.5,
    population: 900,
    growthRate: 1,
    buildings: 10,
    rating: 60,
  },
];

const stations: StationSnapshot[] = [
  {
    id: 10,
    company: 0,
    name: 'Gare centrale',
    kind: 'train',
    x: 20.5,
    y: 24.5,
    width: 3,
    height: 2,
    waiting: [],
  },
];

function makeWorld(): { map: MapSnapshot; towns: TownSnapshot[]; stations: StationSnapshot[] } {
  const map = makeMap();
  plantGrove(map, 34, 34, 4);
  plantGrove(map, 74, 26, 3);
  return { map, towns, stations };
}

function update(
  layer: AtmosphereLayer,
  frames = 1,
  camera = new THREE.Vector3(30, 40, 30),
  phase = 0.5,
): void {
  for (let index = 0; index < frames; index += 1) layer.update(0.016, camera, phase);
}

describe('AtmosphereLayer : budgets par qualité', () => {
  it('coupe tout en low et borne chaque système en medium/high', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0);

    for (const level of QUALITY_LEVELS) {
      layer.setQuality(level);
      layer.setWeather('clear');
      update(layer, 2);
      const budget = ATMOSPHERE_BUDGETS[level];
      expect(layer.budgetSnapshot).toEqual(budget);
      expect(layer.particleCount).toBeLessThanOrEqual(layer.budgetParticles);
      expect(layer.drawCallCount).toBeLessThanOrEqual(4);
      if (level === 'low') {
        expect(layer.particleCount).toBe(0);
        expect(layer.drawCallCount).toBe(0);
        expect(layer.domeVisible).toBe(false);
      } else {
        expect(layer.domeVisible).toBe(true);
        expect(layer.particleCount).toBeGreaterThan(0);
        expect(layer.positionsOf('clouds')).toBeInstanceOf(Float32Array);
      }
    }
    expect(ATMOSPHERE_BUDGETS.high.clouds).toBeGreaterThan(ATMOSPHERE_BUDGETS.medium.clouds);
    layer.dispose();
  });

  it('garde une capacité GPU constante quand la qualité change', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    const capacity = layer.particleCapacity;
    const children = layer.group.children.slice();
    const attributes = layer.group.children.map(
      (child) => (child as THREE.Points).geometry?.attributes.position?.array,
    );
    for (const level of QUALITY_LEVELS) {
      layer.setQuality(level);
      update(layer, 3);
      expect(layer.particleCapacity).toBe(capacity);
      expect(layer.group.children).toEqual(children);
    }
    expect(
      layer.group.children.map(
        (child) => (child as THREE.Points).geometry?.attributes.position?.array,
      ),
    ).toEqual(attributes);
    layer.dispose();
  });

  it('n’alloue ni géométrie ni buffer pendant les frames', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0.2);
    update(layer, 5);
    const children = layer.group.children.slice();
    const positions = layer.positionsOf('clouds');
    const birdPositions = layer.positionsOf('birds');
    const uploads = layer.cloudUploads;
    update(layer, 120);
    expect(layer.group.children).toEqual(children);
    expect(layer.positionsOf('clouds')).toBe(positions);
    expect(layer.positionsOf('birds')).toBe(birdPositions);
    // Le buffer est réécrit en place, sans nouvelle ressource.
    expect(layer.cloudUploads).toBeGreaterThan(uploads);
    layer.dispose();
  });
});

describe('AtmosphereLayer : vie et nuit', () => {
  it('anime les nuages et les oiseaux le jour, les coupe la nuit', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0);
    update(layer, 1);
    expect(layer.systemVisible('clouds')).toBe(true);
    expect(layer.systemVisible('birds')).toBe(true);
    expect(layer.systemVisible('butterflies')).toBe(true);

    const before = layer.positionsOf('clouds').slice(0, 3);
    update(layer, 10);
    const after = layer.positionsOf('clouds').slice(0, 3);
    expect(Array.from(after)).not.toEqual(Array.from(before));

    layer.setNight(1);
    update(layer, 1);
    expect(layer.systemVisible('birds')).toBe(false);
    expect(layer.systemVisible('butterflies')).toBe(false);
    expect(layer.systemVisible('lights')).toBe(true);
    expect(layer.lightCount).toBeGreaterThan(0);
    expect(layer.lightCount).toBeLessThanOrEqual(ATMOSPHERE_BUDGETS.medium.nightLights);
    layer.dispose();
  });

  it('n’affiche aucune lumière de nuit le jour', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0);
    update(layer, 1);
    expect(layer.systemVisible('lights')).toBe(false);
    expect(layer.particleCount).toBeLessThan(layer.budgetParticles);
    layer.dispose();
  });

  it('suit la phase pour la couleur du dôme', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    update(layer, 1, undefined, 0.5);
    expect(layer.skyColour).toBe(sunState(0.5).skyColour);
    expect(layer.sunGlow).toBeGreaterThan(0);
    update(layer, 1, undefined, 0);
    expect(layer.skyColour).toBe(sunState(0).skyColour);
    expect(layer.skyColour).not.toBe(sunState(0.5).skyColour);
    layer.dispose();
  });

  it('place la poussière de chantier et l’éteint avec reduced motion', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0);
    layer.setConstructionSite({ x: 30, z: 30 });
    update(layer, 1);
    expect(layer.hasConstructionSite).toBe(true);
    expect(layer.systemVisible('dust')).toBe(true);
    expect(layer.particleCount).toBeGreaterThan(0);

    layer.setReducedMotion(true);
    update(layer, 1);
    expect(layer.systemVisible('dust')).toBe(false);

    layer.setReducedMotion(false);
    layer.setConstructionSite(null);
    update(layer, 1);
    expect(layer.systemVisible('dust')).toBe(false);
    layer.dispose();
  });
});

describe('AtmosphereLayer : météo optionnelle', () => {
  it('reste au beau temps par défaut', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0.5);
    update(layer, 1);
    expect(layer.weatherKind).toBe('clear');
    expect(layer.systemVisible('rain')).toBe(false);
    expect(layer.systemVisible('snow')).toBe(false);
    layer.dispose();
  });

  it('active pluie ou neige dans le budget, jamais en low', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0.5);
    layer.setWeather('rain');
    update(layer, 2);
    expect(layer.systemVisible('rain')).toBe(true);
    expect(layer.systemVisible('snow')).toBe(false);
    expect(layer.pointSystems.rain).toBe(ATMOSPHERE_BUDGETS.medium.rain);

    layer.setWeather('snow');
    update(layer, 2);
    expect(layer.systemVisible('rain')).toBe(false);
    expect(layer.systemVisible('snow')).toBe(true);
    expect(layer.pointSystems.snow).toBe(ATMOSPHERE_BUDGETS.medium.snow);

    layer.setQuality('low');
    update(layer, 1);
    expect(layer.systemVisible('rain')).toBe(false);
    expect(layer.systemVisible('snow')).toBe(false);
    layer.dispose();
  });

  it('ne simule aucune précipitation sous reduced motion', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setReducedMotion(true);
    layer.setWeather('rain');
    update(layer, 2);
    expect(layer.systemVisible('rain')).toBe(false);
    layer.setWeather('snow');
    update(layer, 2);
    expect(layer.systemVisible('snow')).toBe(false);
    layer.dispose();
  });
});

describe('AtmosphereLayer : respect de prefers-reduced-motion', () => {
  it('fige les nuages et coupe toutes les particules animées', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setNight(0);
    layer.setReducedMotion(true);
    update(layer, 1);
    const clouds = Array.from(layer.positionsOf('clouds').slice(0, 6));
    const birds = Array.from(layer.positionsOf('birds').slice(0, 6));
    update(layer, 60);
    expect(Array.from(layer.positionsOf('clouds').slice(0, 6))).toEqual(clouds);
    expect(Array.from(layer.positionsOf('birds').slice(0, 6))).toEqual(birds);
    expect(layer.systemVisible('birds')).toBe(false);
    expect(layer.systemVisible('butterflies')).toBe(false);
    expect(layer.systemVisible('clouds')).toBe(true);
    layer.dispose();
  });
});

describe('AtmosphereLayer : déterminisme', () => {
  it('produit des placements identiques pour les mêmes données', () => {
    const world = makeWorld();
    const first = new AtmosphereLayer();
    const second = new AtmosphereLayer();
    first.applyWorld(world.map, world.towns, world.stations);
    second.applyWorld(world.map, world.towns, world.stations);
    first.setNight(0);
    second.setNight(0);
    update(first, 3);
    update(second, 3);
    expect(Array.from(second.positionsOf('clouds'))).toEqual(
      Array.from(first.positionsOf('clouds')),
    );
    expect(Array.from(second.positionsOf('birds'))).toEqual(Array.from(first.positionsOf('birds')));
    expect(second.builds).toBe(first.builds);
    first.dispose();
    second.dispose();
  });

  it('ne reconstruit pas pour un monde identique', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    expect(layer.builds).toBe(1);
    layer.applyWorld(world.map, world.towns, world.stations);
    expect(layer.builds).toBe(1);
    const otherTown = [{ ...world.towns[0]!, x: 40.5 }];
    layer.applyWorld(world.map, otherTown, world.stations);
    expect(layer.builds).toBe(2);
    layer.dispose();
  });

  it('signe les données de placement de façon stable', () => {
    const world = makeWorld();
    const signature = computeAtmosphereSignature(world.map, world.towns, world.stations, 'medium');
    expect(computeAtmosphereSignature(world.map, world.towns, world.stations, 'medium')).toBe(
      signature,
    );
    expect(computeAtmosphereSignature(world.map, world.towns, world.stations, 'high')).not.toBe(
      signature,
    );
    expect(computeAtmosphereSignature(world.map, [], world.stations, 'medium')).not.toBe(signature);
  });
});

describe('AtmosphereLayer : dispose', () => {
  it('libère géométries, matériaux et textures', () => {
    const world = makeWorld();
    const layer = new AtmosphereLayer();
    layer.applyWorld(world.map, world.towns, world.stations);
    layer.setWeather('rain');
    layer.setNight(1);
    update(layer, 2);
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(geometryDispose.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(materialDispose.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(layer.particleCount).toBe(0);
    expect(layer.builds).toBe(0);
  });
});

function train(overrides: Partial<RenderVehicle> = {}): RenderVehicle {
  return {
    id: 1,
    kind: 'train',
    model: 'train',
    company: 0,
    x: 20,
    y: 20,
    z: 4,
    direction: 64,
    status: 1,
    speed: 2,
    ...overrides,
  };
}

describe('VehicleLayer : vapeur de locomotive', () => {
  it('émet des bouffées bornées, déterministes et sans mesh par particule', () => {
    const first = new VehicleLayer();
    const second = new VehicleLayer();
    first.update([train(), train({ id: 2, x: 40 })]);
    second.update([train(), train({ id: 2, x: 40 })]);
    for (let frame = 0; frame < 40; frame += 1) {
      first.updateAnimation(0.016);
      second.updateAnimation(0.016);
    }
    expect(first.steamParticleCount).toBeGreaterThan(0);
    expect(first.steamParticleCount).toBeLessThanOrEqual(first.steamCapacity);
    expect(first.steamCapacity).toBeLessThanOrEqual(96);
    expect(Array.from(second.steamPositionsSnapshot())).toEqual(
      Array.from(first.steamPositionsSnapshot()),
    );
    expect(first.accessoryDrawCalls).toBe(1);
    // Un seul `Points` pour toute la vapeur.
    const steam = first.group.children.filter((child) => child.name === 'vehicle-steam');
    expect(steam).toHaveLength(1);
    expect((steam[0] as THREE.Points).isPoints).toBe(true);
    first.dispose();
    second.dispose();
  });

  it('coupe la vapeur en low et sous reduced motion', () => {
    const layer = new VehicleLayer();
    layer.update([train()]);
    for (let frame = 0; frame < 12; frame += 1) layer.updateAnimation(0.016);
    expect(layer.steamParticleCount).toBeGreaterThan(0);

    layer.setReducedMotion(true);
    layer.updateAnimation(0.016);
    expect(layer.steamParticleCount).toBe(0);
    expect(layer.accessoryDrawCalls).toBe(0);

    layer.setReducedMotion(false);
    layer.setQuality('low');
    layer.updateAnimation(0.016);
    expect(layer.steamCapacity).toBe(0);
    expect(layer.steamParticleCount).toBe(0);
    layer.dispose();
  });

  it('se libère intégralement', () => {
    const layer = new VehicleLayer();
    layer.update([train()]);
    layer.updateAnimation(0.05);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.steamParticleCount).toBe(0);
    expect(layer.accessoryDrawCalls).toBe(0);
  });
});

describe('IndustryLayer : fumée et reduced motion', () => {
  function makeIndustryWorld(): { map: MapSnapshot; industry: IndustrySnapshot } {
    const map = makeMap(64, 64);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        map.kind[(20 + dy) * map.width + (20 + dx)] = TILE_KIND_INDEX.industry;
        map.heightMap[(20 + dy) * map.width + (20 + dx)] = 5;
      }
    }
    return {
      map,
      industry: {
        id: 3,
        name: 'Centrale',
        kind: 'power_station',
        x: 21,
        y: 21,
        production: 240,
        transported: 80,
        stocks: [],
      },
    };
  }

  it('coupe la fumée sans la recréer quand reduced motion est actif', () => {
    const { map, industry } = makeIndustryWorld();
    const layer = new IndustryLayer();
    layer.build([industry], map, 'medium');
    expect(layer.smokeParticleCount).toBeGreaterThan(0);
    const children = layer.group.children.length;

    layer.setReducedMotion(true);
    layer.update(1, new THREE.Vector3(21, 30, 21));
    expect(layer.smokeParticleCount).toBe(0);
    expect(layer.group.children.length).toBe(children);

    layer.setReducedMotion(false);
    layer.update(0.016, new THREE.Vector3(21, 30, 21));
    expect(layer.smokeParticleCount).toBeGreaterThan(0);
    layer.dispose();
  });

  it('n’alloue pas de fumée en basse qualité', () => {
    const { map, industry } = makeIndustryWorld();
    const layer = new IndustryLayer();
    layer.build([industry], map, 'low');
    expect(qualitySettings('low').industrySmoke).toBe(false);
    expect(layer.smokeParticleCount).toBe(0);
    layer.dispose();
  });
});

describe('VegetationLayer : vent et reduced motion', () => {
  it('fige le temps de vent sans reconstruire les arbres', () => {
    const map = makeMap(64, 64);
    plantGrove(map, 20, 20, 2);
    const layer = new VegetationLayer();
    layer.build(map, 'medium');
    const trees = layer.count;
    const children = layer.group.children.slice();
    layer.update(0.5);
    expect(layer.windElapsed).toBeGreaterThan(0);

    const frozen = layer.windElapsed;
    layer.setReducedMotion(true);
    layer.update(0.5);
    expect(layer.windElapsed).toBe(frozen);
    expect(layer.isReducedMotion).toBe(true);
    expect(layer.count).toBe(trees);
    expect(layer.group.children).toEqual(children);

    layer.setReducedMotion(false);
    layer.update(0.5);
    expect(layer.windElapsed).toBeGreaterThan(frozen);
    layer.dispose();
  });
});
