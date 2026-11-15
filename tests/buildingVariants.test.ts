import { describe, expect, it } from 'vitest';
import type { MapSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import {
  BUILDING_ARCHETYPES,
  BUILDING_VARIANT_COUNTS,
  BUILDING_VARIANTS,
  buildingVariantCount,
  chooseBuildingArchetype,
  createBuildingGeometry,
  geometryTriangleCount,
  type BuildingArchetype,
} from '../src/render/models/buildings';
import { CityLayer, districtIndex, districtPalette } from '../src/render/CityLayer';

function makeTownMap(size = 96, radius = 12): { map: MapSnapshot; town: TownSnapshot } {
  const map: MapSnapshot = {
    width: size,
    height: size,
    kind: new Uint8Array(size * size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size * size).fill(4),
    owner: new Uint8Array(size * size).fill(255),
    slope: new Uint8Array(size * size),
    flags: new Uint8Array(size * size),
    trackBits: new Uint8Array(size * size),
  };
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2);
  let houses = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      map.kind[(cy + dy) * size + cx + dx] = TILE_KIND_INDEX.house;
      houses += 1;
    }
  }
  return {
    map,
    town: {
      id: 3,
      name: 'Grande-Ville',
      x: cx + 0.5,
      y: cy + 0.5,
      population: 12_000,
      growthRate: 1,
      buildings: houses,
      rating: 80,
    },
  };
}

describe('archétypes et variantes', () => {
  it('déclare huit archétypes et au plus 16 combinaisons instanciables', () => {
    expect(BUILDING_ARCHETYPES.length).toBe(8);
    let combinations = 0;
    for (const archetype of BUILDING_ARCHETYPES) {
      expect(buildingVariantCount(archetype)).toBeGreaterThanOrEqual(1);
      expect(buildingVariantCount(archetype)).toBeLessThanOrEqual(BUILDING_VARIANTS);
      combinations += buildingVariantCount(archetype);
    }
    // 16 lots au maximum par ville : la variété ne coûte pas un draw call par
    // bâtiment, et le budget de 24 lots (deux villes) reste tenable.
    expect(combinations).toBe(16);
    expect(Object.keys(BUILDING_VARIANT_COUNTS).length).toBe(8);
  });

  it('produit chaque archétype dans une grande ville, sans dépasser 16 lots', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const seen = new Set<BuildingArchetype>();
    for (const child of layer.group.children) {
      if (!child.name.startsWith('city-') || child.name === 'city-plinths') continue;
      const archetype = child.name.slice('city-'.length).split(':')[0];
      if (archetype) seen.add(archetype as BuildingArchetype);
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
    expect(layer.drawCallCount).toBeLessThanOrEqual(16);
    // Les immeubles et bureaux restent concentrés au centre.
    expect(seen.has('office')).toBe(true);
    expect(seen.has('apartment')).toBe(true);
    expect(seen.has('terrace')).toBe(true);
    layer.dispose();
  });

  it('n’attribue un édifice public qu’aux villes qui en ont un', () => {
    // Toutes les tuiles d’un même centre-ville partagent le même "flavour",
    // mais seules certaines villes possèdent un édifice public.
    const allowed = new Set<number>();
    for (let id = 0; id < 24; id += 1) {
      for (let x = 16; x < 46; x += 1) {
        for (let y = 16; y < 46; y += 1) {
          const archetype = chooseBuildingArchetype({
            seed: id * 131 + 7,
            x,
            y,
            centrality: 0.55,
            hasChurch: true,
          });
          if (archetype === 'civic') allowed.add(id);
        }
      }
    }
    expect(allowed.size).toBeGreaterThan(0);
    expect(allowed.size).toBeLessThan(24);
  });

  it('enrichit les façades au détail maximal', () => {
    for (const archetype of BUILDING_ARCHETYPES) {
      const low = createBuildingGeometry(archetype, 0, 1);
      const high = createBuildingGeometry(archetype, 0, 2);
      expect(geometryTriangleCount(high)).toBeGreaterThan(geometryTriangleCount(low));
      expect(geometryTriangleCount(high)).toBeLessThan(2_000);
      low.dispose();
      high.dispose();
    }
  });

  it('garde des fenêtres émissives sur les nouveaux archétypes', () => {
    for (const archetype of ['terrace', 'office', 'civic'] as BuildingArchetype[]) {
      const geometry = createBuildingGeometry(archetype, 0, 2);
      const windows = geometry.getAttribute('aWindow');
      let lit = 0;
      for (let index = 0; index < windows.count; index += 1) {
        if (windows.getX(index) > 0) lit += 1;
      }
      expect(lit).toBeGreaterThan(2);
      geometry.dispose();
    }
  });

  it('varie la palette par quartier de façon déterministe', () => {
    const palette = districtPalette(3, 48, 48, 50, 48);
    expect(districtPalette(3, 48, 48, 50, 48)).toEqual(palette);
    const seen = new Set<string>();
    for (let x = 36; x < 60; x += 2) {
      for (let y = 36; y < 60; y += 2) {
        seen.add(districtPalette(3, 48, 48, x, y).join(','));
        expect(districtIndex(48, 48, x, y)).toBeGreaterThanOrEqual(0);
        expect(districtIndex(48, 48, x, y)).toBeLessThan(8);
      }
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it('reste sous le budget de 150 triangles par bâtiment en qualité moyenne', () => {
    const { map, town } = makeTownMap(128, 12);
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.triangleCount / layer.buildingCount).toBeLessThanOrEqual(150);
    layer.dispose();
  });
});
