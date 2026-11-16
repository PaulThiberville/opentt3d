import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot, StationSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { CityLayer } from '../src/render/CityLayer';
import { Picking } from '../src/render/Picking';
import { TownPropsLayer } from '../src/render/TownPropsLayer';

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

function makeTown(map: MapSnapshot): TownSnapshot {
  const cx = 32;
  const cy = 32;
  let houses = 0;
  for (let dy = -5; dy <= 5; dy += 1) {
    for (let dx = -5; dx <= 5; dx += 1) {
      if (dx * dx + dy * dy > 25) continue;
      map.kind[(cy + dy) * map.width + cx + dx] = TILE_KIND_INDEX.house;
      map.heightMap[(cy + dy) * map.width + cx + dx] = 4;
      houses += 1;
    }
  }
  return {
    id: 3,
    name: 'Belle-Rive',
    x: cx + 0.5,
    y: cy + 0.5,
    population: 2_000,
    growthRate: 1,
    buildings: houses,
    rating: 80,
  };
}

function station(): StationSnapshot {
  return {
    id: 7,
    company: 0,
    name: 'Gare',
    kind: 'train',
    x: 12.5,
    y: 12.5,
    width: 1,
    height: 1,
    waiting: [],
  };
}

function cameraAbove(x: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(x, 30, z);
  camera.up.set(0, 0, -1);
  camera.lookAt(x, 0, z);
  camera.updateMatrixWorld();
  return camera;
}

describe('picking ville et gares', () => {
  it('ouvre la tuile réelle d’un bâtiment, pas la projection du toit', () => {
    const map = makeMap();
    const town = makeTown(map);
    const city = new CityLayer();
    city.build([town], map);
    const picking = new Picking(
      { vehicles: () => [], buildings: () => city.pickTargets(), terrain: () => [] },
      () => 0,
    );
    const target = city.pickTargets().find((entry) => entry.mesh.name.startsWith('city-'));
    expect(target).toBeDefined();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    target?.mesh.getMatrixAt(0, matrix);
    matrix.decompose(position, quaternion, scale);
    const info = target?.infoForInstance(0);
    expect(info?.kind).toBe('building');
    if (info?.kind !== 'building') return;
    expect(info.x).toBe(Math.floor(position.x));
    expect(info.y).toBe(Math.floor(position.z));

    const result = picking.pickWithCamera({ x: 0, y: 0 }, cameraAbove(position.x, position.z));
    expect(result?.kind).toBe('building');
    if (result?.kind === 'building') {
      expect(result.townId).toBe(town.id);
      expect(result.x).toBe(info.x);
      expect(result.y).toBe(info.y);
      picking.setHover(result);
      // Le losange est posé sur la tuile du bâtiment, jamais sur la voisine.
      const outline = picking.group.children[0] as THREE.LineLoop;
      const positions = outline.geometry.getAttribute('position');
      for (let index = 0; index < 4; index += 1) {
        expect(Math.floor(positions.getX(index))).toBe(info.x);
        expect(Math.floor(positions.getZ(index))).toBe(info.y);
      }
    }
    picking.dispose();
    city.dispose();
  });

  it('sélectionne une gare 1×1 et la tuile de son emprise', () => {
    const map = makeMap();
    const town = makeTown(map);
    const city = new CityLayer();
    city.build([town], map);
    city.setStations([station()], map);
    const picking = new Picking(
      { vehicles: () => [], buildings: () => city.pickTargets(), terrain: () => [] },
      () => 0,
    );
    const result = picking.pickWithCamera({ x: 0, y: 0 }, cameraAbove(12.5, 12.5));
    expect(result?.kind).toBe('station');
    if (result?.kind === 'station') {
      expect(result.stationId).toBe(7);
      expect(result.x).toBe(12);
      expect(result.y).toBe(12);
    }
    picking.dispose();
    city.dispose();
  });

  it('ne rend jamais un prop décoratif pickable', () => {
    const map = makeMap();
    const town = makeTown(map);
    const city = new CityLayer();
    city.build([town], map);
    const props = new TownPropsLayer();
    props.build([town], map, 'high');
    const placement = props.placementsSnapshot.find((prop) => prop.kind !== 'plaza');
    expect(placement).toBeDefined();
    if (!placement) return;
    const picking = new Picking(
      { vehicles: () => [], buildings: () => city.pickTargets(), terrain: () => [] },
      () => 0,
    );
    const result = picking.pickWithCamera({ x: 0, y: 0 }, cameraAbove(placement.x, placement.z));
    expect(result).toBeNull();
    expect(city.pickTargets().some((target) => target.mesh.name.startsWith('town-prop'))).toBe(
      false,
    );
    picking.dispose();
    props.dispose();
    city.dispose();
  });
});
