import { describe, expect, it } from 'vitest';
import type { MapSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { CityLayer } from '../src/render/CityLayer';
import { VegetationLayer } from '../src/render/VegetationLayer';

const SIZE = 512;
const SNAPSHOTS = 112;

function makeBigMap(): MapSnapshot {
  const size = SIZE * SIZE;
  return {
    width: SIZE,
    height: SIZE,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function plantForests(map: MapSnapshot): void {
  // Vingt bosquets répartis : la carte reste représentative d'une partie 512.
  for (let grove = 0; grove < 20; grove += 1) {
    const cx = 20 + ((grove * 67) % (SIZE - 40));
    const cy = 20 + ((grove * 113) % (SIZE - 40));
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        if (dx * dx + dy * dy > 16) continue;
        map.kind[(cy + dy) * SIZE + (cx + dx)] = TILE_KIND_INDEX.trees;
      }
    }
  }
}

function makeTown(map: MapSnapshot): TownSnapshot {
  const cx = 256;
  const cy = 256;
  let houses = 0;
  for (let dy = -8; dy <= 8; dy += 1) {
    for (let dx = -8; dx <= 8; dx += 1) {
      if (dx * dx + dy * dy > 64) continue;
      map.kind[(cy + dy) * SIZE + (cx + dx)] = TILE_KIND_INDEX.house;
      houses += 1;
    }
  }
  return {
    id: 1,
    name: 'Grande-Ville',
    x: cx + 0.5,
    y: cy + 0.5,
    population: 12_000,
    growthRate: 1,
    buildings: houses,
    rating: 80,
  };
}

describe('budget de reconstructions sur 512', () => {
  it('ne reconstruit ni végétation ni villes pour 112 snapshots identiques', () => {
    const map = makeBigMap();
    plantForests(map);
    const town = makeTown(map);
    const vegetation = new VegetationLayer();
    const city = new CityLayer();

    const firstVegetation = performance.now();
    vegetation.build(map, 'high');
    const vegetationMs = performance.now() - firstVegetation;
    const firstCity = performance.now();
    city.build([town], map);
    const cityMs = performance.now() - firstCity;
    expect(vegetation.builds).toBe(1);
    expect(city.builds).toBe(1);
    expect(vegetation.count).toBeGreaterThan(0);
    expect(city.buildingCount).toBeGreaterThan(0);

    const vegetationMeshes = vegetation.group.children.length;
    const cityMeshes = city.group.children.length;
    const started = performance.now();
    for (let snapshot = 0; snapshot < SNAPSHOTS; snapshot += 1) {
      // Un delta WASM arrive avec de nouveaux tableaux de même contenu.
      const delta: MapSnapshot = {
        ...map,
        kind: map.kind.slice(),
        heightMap: map.heightMap.slice(),
      };
      vegetation.build(delta, 'high');
      city.build([town], delta);
    }
    const elapsed = performance.now() - started;

    // Aucun rebuild : l'empreinte stable court-circuite tout le travail.
    expect(vegetation.builds).toBe(1);
    expect(city.builds).toBe(1);
    expect(vegetation.group.children.length).toBe(vegetationMeshes);
    expect(city.group.children.length).toBe(cityMeshes);
    // Bruit de diagnostic dans le rapport de perf (pas une assertion serrée).
    console.log(
      `[perf] 512 : végétation ${vegetationMs.toFixed(1)} ms, villes ${cityMs.toFixed(1)} ms, ` +
        `${SNAPSHOTS} snapshots sans rebuild en ${elapsed.toFixed(1)} ms`,
    );
    vegetation.dispose();
    city.dispose();
  });
});
