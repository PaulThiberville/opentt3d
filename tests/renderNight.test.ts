import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { CityLayer } from '../src/render/CityLayer';
import { TerrainLayer } from '../src/render/TerrainLayer';
import { VehicleLayer } from '../src/render/VehicleLayer';

function makeMap(): MapSnapshot {
  const width = 32;
  const height = 32;
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
  map.kind[2 * width + 2] = TILE_KIND_INDEX.road;
  map.kind[3 * width + 3] = TILE_KIND_INDEX.rail;
  map.kind[4 * width + 4] = TILE_KIND_INDEX.water;
  map.heightMap[4 * width + 4] = 0;
  return map;
}

function groundMesh(layer: TerrainLayer): Mesh {
  const mesh = layer.group.children.find((child) => child.name === 'terrain-0-0');
  if (!mesh) throw new Error('chunk terrain manquant');
  return mesh as Mesh;
}

describe('rendu nocturne', () => {
  it('émet une couleur de nuit sur les routes, rails et l’eau uniquement', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap());
    const geometry = groundMesh(layer).geometry;
    const glow = geometry.getAttribute('aNightGlow');
    expect(glow.count).toBe(geometry.getAttribute('position').count);
    let lit = 0;
    for (let i = 0; i < glow.count; i += 1) {
      const value = glow.getX(i) + glow.getY(i) + glow.getZ(i);
      if (value > 0) lit += 1;
    }
    // Une tuile = 6 sommets ; route, rail et eau ont chacun une émission.
    expect(lit).toBe(18);
    layer.dispose();
  });

  it('borne le facteur de nuit et ne change pas le nombre de draw calls', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap());
    const before = layer.group.children.length;
    layer.setNight(1);
    expect(layer.night).toBe(1);
    layer.setNight(4);
    expect(layer.night).toBe(1);
    layer.setNight(Number.NaN);
    expect(layer.night).toBe(0);
    expect(layer.group.children.length).toBe(before);
    layer.dispose();
  });

  it('expose le facteur de nuit des véhicules et des villes', () => {
    const vehicles = new VehicleLayer();
    vehicles.setNight(0.6);
    expect(vehicles.night).toBeCloseTo(0.6, 6);
    vehicles.setNight(-2);
    expect(vehicles.night).toBe(0);
    vehicles.dispose();

    const city = new CityLayer();
    city.setNight(0.8);
    expect(city.night).toBeCloseTo(0.8, 6);
    city.setNightLights(false);
    expect(city.night).toBeCloseTo(0.8, 6);
    city.dispose();
  });
});
