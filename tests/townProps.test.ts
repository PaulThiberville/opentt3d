import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_FLAG, TILE_KIND_INDEX } from '../src/engine/protocol';
import {
  TownPropsLayer,
  computeTownPropsSignature,
  generateTownProps,
  isPropFreeKind,
  isRoadKind,
  isWaterloggedPropTile,
} from '../src/render/TownPropsLayer';
import {
  createTownPropGeometry,
  geometryTriangleCount,
  TOWN_PROP_KINDS,
} from '../src/render/models/buildings';

function makeMap(width = 64, height = 64): MapSnapshot {
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

/** Ville circulaire avec deux routes qui la traversent. */
function makeTownMap(): { map: MapSnapshot; town: TownSnapshot } {
  const map = makeMap();
  const cx = 32;
  const cy = 32;
  let houses = 0;
  for (let dy = -6; dy <= 6; dy += 1) {
    for (let dx = -6; dx <= 6; dx += 1) {
      if (dx * dx + dy * dy > 30) continue;
      const x = cx + dx;
      const y = cy + dy;
      map.kind[y * map.width + x] = TILE_KIND_INDEX.house;
      map.heightMap[y * map.width + x] = 4 + ((x + y) % 2);
      houses += 1;
    }
  }
  for (let d = -10; d <= 10; d += 1) {
    map.kind[(cy + d) * map.width + cx] = TILE_KIND_INDEX.road;
    map.kind[cy * map.width + cx + d] = TILE_KIND_INDEX.road;
  }
  return {
    map,
    town: {
      id: 5,
      name: 'Test',
      x: cx + 0.5,
      y: cy + 0.5,
      population: 2_000,
      growthRate: 1,
      buildings: houses,
      rating: 70,
    },
  };
}

function instanceMatrices(layer: TownPropsLayer): number[][] {
  return layer.group.children
    .filter((child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh)
    .map((mesh) => Array.from(mesh.instanceMatrix.array as Float32Array));
}

describe('TownPropsLayer : semis déterministe', () => {
  it('ne pose jamais un prop sur une route, un bâtiment ou dans l’eau', () => {
    const { map, town } = makeTownMap();
    // Une mare dans le rayon de semis : aucun prop ne doit y flotter.
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        map.kind[(40 + dy) * map.width + (40 + dx)] = TILE_KIND_INDEX.water;
      }
    }
    const placements = generateTownProps(town, map, 60);
    expect(placements.length).toBeGreaterThan(8);
    const tiles = new Set<number>();
    for (const placement of placements) {
      const x = Math.floor(placement.x);
      const y = Math.floor(placement.z);
      const kind = map.kind[y * map.width + x] ?? 0;
      if (isRoadKind(kind)) {
        // Les lampadaires et panneaux se posent au coin de la tuile de voirie,
        // en dehors de la chaussée et de la bordure.
        expect(placement.kind === 'lamp' || placement.kind === 'sign').toBe(true);
        expect(Math.abs(placement.x - (x + 0.5))).toBeGreaterThanOrEqual(0.36);
        expect(Math.abs(placement.z - (y + 0.5))).toBeGreaterThanOrEqual(0.36);
      } else {
        expect(isPropFreeKind(kind)).toBe(true);
      }
      expect(Math.hypot(x - town.x, y - town.y)).toBeLessThanOrEqual(10);
      // Un prop au plus par tuile.
      const key = y * map.width + x;
      expect(tiles.has(key)).toBe(false);
      tiles.add(key);
    }
    // Les rues de la ville reçoivent bien du mobilier.
    expect(placements.some((placement) => placement.kind === 'lamp')).toBe(true);
  });

  it('rejette une berge basse noyée par une nappe surélevée (#215)', () => {
    const { map, town } = makeTownMap();
    // Canal surélevé au niveau 7 : la bande de terre au niveau 0 qui le longe
    // est sous la surface et ne doit recevoir aucun mobilier.
    const baseX = 27;
    const baseY = 32;
    for (let x = baseX; x < baseX + 8; x += 1) {
      map.kind[baseY * map.width + x] = TILE_KIND_INDEX.canal;
      map.heightMap[baseY * map.width + x] = 7;
      map.kind[(baseY + 1) * map.width + x] = TILE_KIND_INDEX.grass;
      map.heightMap[(baseY + 1) * map.width + x] = 0;
    }
    expect(isWaterloggedPropTile(map, baseX + 2, baseY + 1)).toBe(true);
    const placements = generateTownProps(town, map, 80);
    for (const placement of placements) {
      const x = Math.floor(placement.x);
      const y = Math.floor(placement.z);
      expect(isWaterloggedPropTile(map, x, y)).toBe(false);
    }
    // Un drapeau d'eau suffit, même sur une tuile libre en apparence.
    map.flags[(baseY - 2) * map.width + baseX] = TILE_FLAG.WATER;
    expect(isWaterloggedPropTile(map, baseX, baseY - 2)).toBe(true);
    expect(
      generateTownProps(town, map, 80).some(
        (placement) =>
          placement.x >= baseX &&
          placement.x < baseX + 1 &&
          placement.z >= baseY - 2 &&
          placement.z < baseY - 1,
      ),
    ).toBe(false);
    // La signature réagit au drapeau, sans attendre un changement de hauteur.
    const before = computeTownPropsSignature([town], map, 'medium');
    map.flags[(baseY - 2) * map.width + baseX] = 0;
    expect(computeTownPropsSignature([town], map, 'medium')).not.toBe(before);
  });

  it('garde chaque prop dans sa tuile et centre les arrêts de bus', () => {
    const { map, town } = makeTownMap();
    const placements = generateTownProps(town, map, 80);
    expect(placements.length).toBeGreaterThan(8);
    for (const placement of placements) {
      const tileX = Math.floor(placement.x);
      const tileY = Math.floor(placement.z);
      const kind = map.kind[tileY * map.width + tileX] ?? 0;
      // Les lampadaires de voirie se posent au coin d'une tuile route : leur
      // pied reste sur la tuile, la tête peut surplomber la chaussée.
      if (isRoadKind(kind)) continue;
      const geometry = createTownPropGeometry(placement.kind, 2);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox ?? new THREE.Box3();
      const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      const halfZ = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      const cos = Math.abs(Math.cos(placement.yaw));
      const sin = Math.abs(Math.sin(placement.yaw));
      const extentX = (halfX * cos + halfZ * sin) * placement.scale;
      const extentZ = (halfX * sin + halfZ * cos) * placement.scale;
      expect(placement.x - extentX).toBeGreaterThanOrEqual(tileX - 1e-6);
      expect(placement.x + extentX).toBeLessThanOrEqual(tileX + 1 + 1e-6);
      expect(placement.z - extentZ).toBeGreaterThanOrEqual(tileY - 1e-6);
      expect(placement.z + extentZ).toBeLessThanOrEqual(tileY + 1 + 1e-6);
      if (placement.kind === 'busStop') {
        expect(placement.x).toBeCloseTo(tileX + 0.5, 6);
        expect(placement.z).toBeCloseTo(tileY + 0.5, 6);
      }
      geometry.dispose();
    }
  });

  it('est déterministe et respecte la limite demandée', () => {
    const { map, town } = makeTownMap();
    const first = generateTownProps(town, map, 24);
    const second = generateTownProps(town, map, 24);
    expect(second).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(24);
    // La signature ne dépend que des villes, des tuiles et du preset.
    expect(computeTownPropsSignature([town], map, 'medium')).toBe(
      computeTownPropsSignature([town], map, 'medium'),
    );
    expect(computeTownPropsSignature([town], map, 'high')).not.toBe(
      computeTownPropsSignature([town], map, 'medium'),
    );
  });

  it('varie les types de props dans une ville et les teinte par quartier', () => {
    const { map, town } = makeTownMap();
    const placements = generateTownProps(town, map, 60);
    const kinds = new Set(placements.map((placement) => placement.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(kinds.has('lamp')).toBe(true);
    const tints = new Set(
      placements.map((placement) =>
        [placement.tintR, placement.tintG, placement.tintB]
          .map((value) => value.toFixed(3))
          .join(','),
      ),
    );
    expect(tints.size).toBeGreaterThan(1);
  });
});

describe('TownPropsLayer : instancing et LOD', () => {
  it('instancie un seul lot par type de prop, pas un par objet', () => {
    const { map, town } = makeTownMap();
    const layer = new TownPropsLayer();
    layer.build([town], map, 'high');
    expect(layer.propCount).toBeGreaterThan(8);
    expect(layer.visibleCount).toBe(layer.propCount);
    expect(layer.drawCallCount).toBeGreaterThan(0);
    expect(layer.drawCallCount).toBeLessThanOrEqual(TOWN_PROP_KINDS.length);
    expect(layer.triangleCount).toBeGreaterThan(0);
    // Budget : ~60 triangles par prop au maximum.
    expect(layer.triangleCount).toBeLessThanOrEqual(layer.propCount * 120);
    layer.dispose();
  });

  it('masque les props des villes lointaines puis les restaure', () => {
    const { map, town } = makeTownMap();
    const layer = new TownPropsLayer();
    layer.build([town], map, 'medium');
    const nearDraws = layer.drawCallCount;
    layer.update(new THREE.Vector3(500, 20, 500));
    expect(layer.distantTownCount).toBe(1);
    expect(layer.drawCallCount).toBe(0);
    expect(layer.visibleCount).toBe(0);
    expect(layer.lodSwitches).toBe(1);
    layer.update(new THREE.Vector3(town.x, 20, town.y));
    expect(layer.distantTownCount).toBe(0);
    expect(layer.visibleCount).toBe(layer.propCount);
    expect(layer.drawCallCount).toBe(nearDraws);
    expect(layer.lodSwitches).toBe(2);
    layer.dispose();
  });

  it('reste déterministe pour une même carte', () => {
    const { map, town } = makeTownMap();
    const first = new TownPropsLayer();
    const second = new TownPropsLayer();
    first.build([town], map, 'medium');
    second.build([town], map, 'medium');
    expect(instanceMatrices(second)).toEqual(instanceMatrices(first));
    first.dispose();
    second.dispose();
  });

  it('réduit les props en basse qualité et les enrichit en haute', () => {
    const { map, town } = makeTownMap();
    const layer = new TownPropsLayer();
    layer.build([town], map, 'low');
    const lowProps = layer.propCount;
    const lowTriangles = layer.triangleCount;
    layer.setQuality('high');
    expect(layer.propCount).toBeGreaterThan(lowProps);
    expect(layer.triangleCount).toBeGreaterThan(lowTriangles);
    layer.dispose();
  });

  it('ne reconstruit pas pour un snapshot identique', () => {
    const { map, town } = makeTownMap();
    const layer = new TownPropsLayer();
    layer.build([town], map, 'medium');
    expect(layer.builds).toBe(1);
    const meshes = [...layer.group.children];
    layer.build([{ ...town, population: town.population + 400 }], map, 'medium');
    expect(layer.builds).toBe(1);
    expect([...layer.group.children]).toEqual(meshes);
    // Une route qui apparaît sous un prop invalide le semis.
    map.kind[34 * map.width + 34] = TILE_KIND_INDEX.road;
    layer.build([town], map, 'medium');
    expect(layer.builds).toBe(2);
    layer.dispose();
  });

  it('transmet la nuit et les ombres sans mesh supplémentaire', () => {
    const { map, town } = makeTownMap();
    const layer = new TownPropsLayer();
    layer.build([town], map, 'high');
    const draws = layer.drawCallCount;
    layer.setNight(1);
    layer.setShadows(true);
    expect(layer.night).toBe(1);
    expect(layer.drawCallCount).toBe(draws);
    expect(layer.surfaceMaterial.userData.modelSurface).toBe(true);
    for (const child of layer.group.children) {
      expect((child as THREE.InstancedMesh).castShadow).toBe(true);
    }
    layer.dispose();
  });

  it('libère ses géométries au dispose', () => {
    const { map, town } = makeTownMap();
    const geometrySpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const layer = new TownPropsLayer();
    layer.build([town], map, 'high');
    layer.dispose();
    expect(geometrySpy).toHaveBeenCalled();
    expect(layer.group.children.length).toBe(0);
    expect(layer.propCount).toBe(0);
    geometrySpy.mockRestore();
  });
});

describe('géométries de props', () => {
  it('borne chaque prop à une empreinte de tuile et à un budget triangles', () => {
    for (const kind of TOWN_PROP_KINDS) {
      for (const detail of [0, 1, 2] as const) {
        const geometry = createTownPropGeometry(kind, detail);
        const position = geometry.getAttribute('position');
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let minY = Infinity;
        for (let index = 0; index < position.count; index += 1) {
          minX = Math.min(minX, position.getX(index));
          maxX = Math.max(maxX, position.getX(index));
          minZ = Math.min(minZ, position.getZ(index));
          maxZ = Math.max(maxZ, position.getZ(index));
          minY = Math.min(minY, position.getY(index));
        }
        expect(minX).toBeGreaterThanOrEqual(-0.5);
        expect(maxX).toBeLessThanOrEqual(0.5);
        expect(minZ).toBeGreaterThanOrEqual(-0.5);
        expect(maxZ).toBeLessThanOrEqual(0.5);
        expect(minY).toBeGreaterThanOrEqual(-1e-6);
        expect(geometryTriangleCount(geometry)).toBeLessThan(400);
        geometry.dispose();
      }
    }
  });

  it('est déterministe et expose les attributs du matériau partagé', () => {
    for (const kind of TOWN_PROP_KINDS) {
      const first = createTownPropGeometry(kind, 2);
      const second = createTownPropGeometry(kind, 2);
      expect(Array.from(second.getAttribute('position').array)).toEqual(
        Array.from(first.getAttribute('position').array),
      );
      expect(first.getAttribute('aFinish')).toBeDefined();
      expect(first.getAttribute('aGlow')).toBeDefined();
      first.dispose();
      second.dispose();
    }
    // Un lampadaire émet la nuit, sans draw call dédié.
    const lamp = createTownPropGeometry('lamp', 2);
    const glow = lamp.getAttribute('aGlow');
    let lit = 0;
    for (let index = 0; index < glow.count; index += 1) if (glow.getX(index) > 0) lit += 1;
    expect(lit).toBeGreaterThan(0);
    lamp.dispose();
  });

  it('ne dépend ni d’un drapeau de carte ni d’un asset externe', () => {
    const { map, town } = makeTownMap();
    map.flags[0] = TILE_FLAG.SNOW;
    expect(generateTownProps(town, map, 16).length).toBeGreaterThan(0);
  });
});
