import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MapSnapshot, StationSnapshot, TownSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { CityLayer } from '../src/render/CityLayer';
import { cornerHeightWorld, sampleHeightWorld } from '../src/game/mapGrid';

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

function makeTownMap(): { map: MapSnapshot; town: TownSnapshot; houses: number } {
  const map = makeMap();
  const cx = 32;
  const cy = 32;
  let houses = 0;
  for (let dy = -7; dy <= 7; dy += 1) {
    for (let dx = -7; dx <= 7; dx += 1) {
      if (dx * dx + dy * dy > 49) continue;
      const x = cx + dx;
      const y = cy + dy;
      map.kind[y * map.width + x] = TILE_KIND_INDEX.house;
      map.heightMap[y * map.width + x] = 4 + ((x + y) % 2);
      houses += 1;
    }
  }
  return {
    map,
    town: {
      id: 3,
      name: 'Belle-Rive',
      x: cx + 0.5,
      y: cy + 0.5,
      population: 4_200,
      growthRate: 1,
      buildings: houses,
      rating: 80,
    },
    houses,
  };
}

function station(overrides: Partial<StationSnapshot> = {}): StationSnapshot {
  return {
    id: 0,
    company: 0,
    name: 'Gare',
    kind: 'train',
    // `x/y` est le centre de l'emprise (contrat du snapshot).
    x: 10.5,
    y: 12.5,
    width: 3,
    height: 2,
    waiting: [],
    ...overrides,
  };
}

function buckets(layer: CityLayer): THREE.InstancedMesh[] {
  return layer.group.children.filter(
    (child): child is THREE.InstancedMesh =>
      (child as THREE.InstancedMesh).isInstancedMesh === true &&
      child.name.startsWith('city-') &&
      child.name !== 'city-plinths',
  );
}

describe('CityLayer : bâtiments instanciés', () => {
  it('instancie les maisons par archétype sans draw call par bâtiment', () => {
    const { map, town, houses } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.buildingCount).toBe(houses);
    expect(layer.drawCallCount).toBeGreaterThan(0);
    expect(layer.drawCallCount).toBeLessThanOrEqual(16);
    expect(layer.triangleCount).toBeGreaterThan(houses * 10);
    // Une grande ville a toujours un point de repère religieux.
    expect(layer.group.children.some((child) => child.name.includes('church'))).toBe(true);
    for (const mesh of buckets(layer)) {
      expect(mesh.count).toBeGreaterThan(0);
      expect(mesh.geometry.getAttribute('aWindow')).toBeDefined();
    }
    layer.dispose();
  });

  it('ne déborde jamais de la tuile, même après rotation', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const mesh of buckets(layer)) {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) continue;
      const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      const halfZ = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        // Rotations par multiples de 90° : on échange les demi-extents.
        const quarterTurn = Math.round(quaternionToYaw(quaternion) / (Math.PI / 2)) % 2 !== 0;
        const extentX = (quarterTurn ? halfZ : halfX) * scale.x;
        const extentZ = (quarterTurn ? halfX : halfZ) * scale.z;
        expect(position.x - extentX).toBeGreaterThanOrEqual(Math.floor(position.x) - 1e-3);
        expect(position.x + extentX).toBeLessThanOrEqual(Math.floor(position.x) + 1 + 1e-3);
        expect(position.z - extentZ).toBeGreaterThanOrEqual(Math.floor(position.z) - 1e-3);
        expect(position.z + extentZ).toBeLessThanOrEqual(Math.floor(position.z) + 1 + 1e-3);
      }
    }
    layer.dispose();
  });

  it('reste déterministe pour une même carte', () => {
    const { map, town } = makeTownMap();
    const first = new CityLayer();
    const second = new CityLayer();
    first.build([town], map);
    second.build([town], map);
    const firstMatrices = buckets(first).map((mesh) =>
      Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    const secondMatrices = buckets(second).map((mesh) =>
      Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    expect(secondMatrices).toEqual(firstMatrices);
    first.dispose();
    second.dispose();
  });

  it('bascule les villes lointaines en silhouette simplifiée', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const detailed = layer.drawCallCount;
    layer.update(new THREE.Vector3(32, 20, 42));
    expect(layer.distantTownCount).toBe(0);
    layer.update(new THREE.Vector3(-500, 40, -500));
    expect(layer.distantTownCount).toBe(1);
    expect(layer.group.children.some((child) => child.name === 'city-far')).toBe(true);
    expect(layer.drawCallCount).toBe(1);
    expect(detailed).toBeGreaterThan(1);
    layer.update(new THREE.Vector3(32, 20, 42));
    expect(layer.distantTownCount).toBe(0);
    expect(layer.group.children.some((child) => child.name === 'city-far')).toBe(false);
    layer.dispose();
  });

  it('ne crée aucune instance plus large qu’une tuile (pas de dalle globale)', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    layer.setStations([station(), station({ id: 1, kind: 'airport', width: 3, height: 3 })], map);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const child of layer.group.children) {
      if (!(child as THREE.InstancedMesh).isInstancedMesh) continue;
      const mesh = child as THREE.InstancedMesh;
      if (mesh.count === 0) continue;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) continue;
      const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      const halfZ = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        const quarterTurn = Math.round(quaternionToYaw(quaternion) / (Math.PI / 2)) % 2 !== 0;
        expect((quarterTurn ? halfZ : halfX) * scale.x).toBeLessThanOrEqual(0.5 + 1e-3);
        expect((quarterTurn ? halfX : halfZ) * scale.z).toBeLessThanOrEqual(0.5 + 1e-3);
      }
    }
    layer.dispose();
  });

  it('pose chaque bâtiment sur sampleHeightWorld et comble les pentes par une plinthe', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.plinthCount).toBeGreaterThan(0);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const mesh of buckets(layer)) {
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        expect(position.y).toBeCloseTo(sampleHeightWorld(map, position.x, position.z), 5);
      }
    }
    const plinths = layer.group.children.find((child) => child.name === 'city-plinths');
    expect(plinths).toBeDefined();
    const plinthMesh = plinths as THREE.InstancedMesh;
    for (let index = 0; index < plinthMesh.count; index += 1) {
      plinthMesh.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(scale.x).toBeLessThanOrEqual(0.9);
      expect(scale.z).toBeLessThanOrEqual(0.9);
      expect(scale.y).toBeGreaterThan(0);
      expect(position.y + scale.y).toBeGreaterThanOrEqual(
        sampleHeightWorld(map, position.x, position.z) - 0.03,
      );
    }
    layer.dispose();
  });

  it('réduit la géométrie en basse qualité et l’augmente en haute', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const medium = layer.triangleCount;
    layer.setQuality('low');
    const low = layer.triangleCount;
    layer.setQuality('high');
    const high = layer.triangleCount;
    expect(low).toBeLessThan(medium);
    expect(high).toBeGreaterThan(medium);
    layer.dispose();
  });
});

describe('CityLayer : gares', () => {
  it('pose halle et quais multi-tuiles orientés', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    layer.setStations(
      [station(), station({ id: 1, kind: 'road', x: 20.5, y: 20.5, width: 1, height: 1 })],
      map,
    );
    expect(layer.stationCountValue).toBe(2);
    expect(layer.drawCallCount).toBe(2);
    const halls = layer.group.children.find((child) => child.name === 'station-halls');
    const platforms = layer.group.children.find((child) => child.name === 'station-platforms');
    expect((halls as THREE.InstancedMesh).count).toBe(2);
    expect((platforms as THREE.InstancedMesh).count).toBe(3 * 2 + 1);
    const matrix = new THREE.Matrix4();
    (halls as THREE.InstancedMesh).getMatrixAt(0, matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    // Gare 3×2 : la halle tient sur la première tuile, pas sur toute l'emprise.
    expect(position.x).toBeCloseTo(10.5, 5);
    expect(position.z).toBeCloseTo(12.5, 5);
    expect(scale.x).toBeLessThanOrEqual(1);
    expect(scale.z).toBeLessThanOrEqual(1);
    expect(Math.abs(quaternionToYaw(quaternion))).toBeLessThan(1e-6);
    layer.dispose();
  });

  it('tourne la halle pour une gare plus haute que large', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    layer.setStations([station({ width: 1, height: 3 })], map);
    const halls = layer.group.children.find(
      (child) => child.name === 'station-halls',
    ) as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    halls.getMatrixAt(0, matrix);
    matrix.decompose(position, quaternion, scale);
    expect(Math.abs(quaternionToYaw(quaternion))).toBeCloseTo(Math.PI / 2, 5);
    layer.dispose();
  });

  it('pose les quais par tuile à la hauteur exacte du terrain', () => {
    const { map } = makeTownMap();
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 3; dx += 1) {
        map.heightMap[(11 + dy) * map.width + (9 + dx)] = 4 + dx + dy;
      }
    }
    const layer = new CityLayer();
    layer.setStations([station()], map);
    const platforms = layer.group.children.find(
      (child) => child.name === 'station-platforms',
    ) as THREE.InstancedMesh;
    expect(platforms.count).toBe(6);
    expect(layer.stationBaseCount).toBeGreaterThan(0);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let index = 0; index < platforms.count; index += 1) {
      platforms.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(position.y).toBeCloseTo(sampleHeightWorld(map, position.x, position.z), 5);
      expect(Math.floor(position.x)).toBeGreaterThanOrEqual(9);
      expect(Math.floor(position.x)).toBeLessThanOrEqual(11);
      expect(Math.floor(position.z)).toBeGreaterThanOrEqual(11);
      expect(Math.floor(position.z)).toBeLessThanOrEqual(12);
      const tileX = Math.floor(position.x);
      const tileY = Math.floor(position.z);
      const minCorner = Math.min(
        cornerHeightWorld(map, tileX, tileY),
        cornerHeightWorld(map, tileX + 1, tileY),
        cornerHeightWorld(map, tileX, tileY + 1),
        cornerHeightWorld(map, tileX + 1, tileY + 1),
      );
      expect(position.y).toBeGreaterThanOrEqual(minCorner - 1e-6);
    }
    layer.dispose();
  });

  it('ne pose pas de canopée de quai sur un aéroport', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    layer.setStations([station({ kind: 'airport', x: 10.5, y: 12.5, width: 3, height: 3 })], map);
    expect(layer.stationCountValue).toBe(1);
    expect(
      layer.group.children.find((child) => child.name === 'station-platforms'),
    ).toBeUndefined();
    expect(
      (layer.group.children.find((child) => child.name === 'station-halls') as THREE.InstancedMesh)
        .count,
    ).toBe(1);
    layer.dispose();
  });

  it('ne reconstruit pas les gares quand seule la fréquentation change', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    const base = [station()];
    layer.setStations(base, map);
    const halls = layer.group.children.find((child) => child.name === 'station-halls');
    layer.setStations([{ ...base[0]!, waiting: [{ cargo: 'passengers', amount: 42 }] }], map);
    expect(layer.group.children.find((child) => child.name === 'station-halls')).toBe(halls);
    layer.dispose();
  });

  it('centre la halle 1×1 sur sa tuile et les quais dans l’emprise du snapshot', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    const multi = station();
    const single = station({ id: 1, kind: 'road', x: 20.5, y: 16.5, width: 1, height: 1 });
    layer.setStations([multi, single], map);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    const halls = layer.group.children.find(
      (child) => child.name === 'station-halls',
    ) as THREE.InstancedMesh;
    halls.getMatrixAt(0, matrix);
    matrix.decompose(position, quaternion, scale);
    expect(position.x).toBe(10.5);
    expect(position.z).toBe(12.5);
    halls.getMatrixAt(1, matrix);
    matrix.decompose(position, quaternion, scale);
    // Une gare 1×1 est exactement au centre de sa tuile, jamais sur l'arête.
    expect(position.x).toBe(20.5);
    expect(position.z).toBe(16.5);

    const platforms = layer.group.children.find(
      (child) => child.name === 'station-platforms',
    ) as THREE.InstancedMesh;
    const tiles = new Set<string>();
    for (let index = 0; index < platforms.count; index += 1) {
      platforms.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(position.x - Math.floor(position.x)).toBeCloseTo(0.5, 6);
      expect(position.z - Math.floor(position.z)).toBeCloseTo(0.5, 6);
      tiles.add(`${Math.floor(position.x)},${Math.floor(position.z)}`);
    }
    // Emprise 3×2 centrée en (10,5 ; 12,5) + arrêt 1×1.
    expect([...tiles].sort()).toEqual(
      ['10,11', '10,12', '11,11', '11,12', '20,16', '9,11', '9,12'].sort(),
    );
    layer.dispose();
  });

  it('associe chaque instance de bâtiment à sa tuile réelle', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    let seen = 0;
    for (const target of layer.pickTargets()) {
      if (!target.mesh.name.startsWith('city-')) continue;
      for (let index = 0; index < target.mesh.count; index += 1) {
        target.mesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        const info = target.infoForInstance(index);
        expect(info?.kind).toBe('building');
        if (info?.kind !== 'building') continue;
        expect(info.x).toBe(Math.floor(position.x));
        expect(info.y).toBe(Math.floor(position.z));
        expect(map.kind[info.y * map.width + info.x]).toBe(TILE_KIND_INDEX.house);
        seen += 1;
      }
    }
    expect(seen).toBe(layer.buildingCount);
    // Le socle de ville n'est jamais une cible de bâtiment.
    expect(layer.pickTargets().some((target) => target.mesh.name === 'city-plinths')).toBe(false);
    layer.dispose();
  });

  it('rend les gares pickables avec leur id et une tuile de leur emprise', () => {
    const { map } = makeTownMap();
    const layer = new CityLayer();
    const train = station();
    layer.setStations([train], map);
    const stationTargets = layer
      .pickTargets()
      .filter((target) => target.mesh.name.startsWith('station-'));
    expect(stationTargets.length).toBeGreaterThan(0);
    const left = Math.floor(train.x - train.width / 2);
    const top = Math.floor(train.y - train.height / 2);
    for (const target of stationTargets) {
      for (let index = 0; index < target.mesh.count; index += 1) {
        const info = target.infoForInstance(index);
        expect(info?.kind).toBe('station');
        if (info?.kind !== 'station') continue;
        expect(info.stationId).toBe(train.id);
        expect(info.x).toBeGreaterThanOrEqual(left);
        expect(info.x).toBeLessThan(left + train.width);
        expect(info.y).toBeGreaterThanOrEqual(top);
        expect(info.y).toBeLessThan(top + train.height);
      }
    }
    layer.dispose();
  });
});

describe('CityLayer : signatures et LOD', () => {
  it('ne reconstruit pas les bâtiments pour un snapshot identique', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.builds).toBe(1);
    const buckets = layer.group.children.filter((child) => child.name.startsWith('city-'));
    layer.build([{ ...town, population: town.population + 500 }], map);
    expect(layer.builds).toBe(1);
    expect(layer.group.children.filter((child) => child.name.startsWith('city-'))).toEqual(buckets);
    // Un changement de qualité réinstancie les lots mais ne doit pas être
    // suivi d'une reconstruction complète au snapshot suivant.
    layer.setQuality('high');
    layer.build([town], map);
    expect(layer.builds).toBe(1);
    layer.dispose();
  });

  it('reconstruit quand une tuile house ou une hauteur change', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    expect(layer.builds).toBe(1);

    const houseIndex = 32 * map.width + 32;
    map.heightMap[houseIndex] = 8;
    layer.build([town], map);
    expect(layer.builds).toBe(2);

    map.kind[houseIndex] = TILE_KIND_INDEX.road;
    layer.build([town], map);
    expect(layer.builds).toBe(3);
    layer.dispose();
  });

  it('conserve l’état near/far entre les deux seuils (hystérésis)', () => {
    const { map, town } = makeTownMap();
    const layer = new CityLayer();
    layer.build([town], map);
    const centre = new THREE.Vector3(town.x, 20, town.y);
    layer.update(centre);
    expect(layer.distantTownCount).toBe(0);

    // 88 tuiles : entre near (80) et far (~94), on garde le détail.
    layer.update(new THREE.Vector3(town.x, 20, town.y + 88));
    expect(layer.distantTownCount).toBe(0);
    expect(layer.lodSwitches).toBe(0);

    layer.update(new THREE.Vector3(town.x, 20, town.y + 110));
    expect(layer.distantTownCount).toBe(1);
    expect(layer.lodSwitches).toBe(1);

    // Retour à 88 : on reste en silhouette tant qu'on ne repasse pas sous 80.
    layer.update(new THREE.Vector3(town.x, 20, town.y + 88));
    expect(layer.distantTownCount).toBe(1);
    expect(layer.lodSwitches).toBe(1);

    layer.update(new THREE.Vector3(town.x, 20, town.y + 70));
    expect(layer.distantTownCount).toBe(0);
    expect(layer.lodSwitches).toBe(2);
    layer.dispose();
  });

  it('ne réinstancie que les lots touchés par une bascule', () => {
    const map = makeMap(160, 160);
    const towns: TownSnapshot[] = [];
    for (const [id, cx, cy] of [
      [1, 32, 32],
      [2, 122, 32],
      [3, 116, 32],
    ] as const) {
      towns.push(makeTownAt(map, id, cx, cy));
    }
    const layer = new CityLayer();
    layer.build(towns, map);

    // Éloigne tout le monde, puis rapproche deux villes : la troisième reste
    // en silhouette basse.
    layer.update(new THREE.Vector3(500, 20, 500));
    expect(layer.distantTownCount).toBe(3);
    layer.update(new THREE.Vector3(42, 20, 32));
    expect(layer.distantTownCount).toBe(1);

    const nearBefore = layer.group.children.filter(
      (child) => child.name.startsWith('city-') && child.name !== 'city-far',
    );
    layer.bucketRebuilds = 0;
    // La troisième ville (x=122) passe sous le seuil near ; les deux autres
    // restent near. Seuls ses lots doivent être réinstanciés.
    layer.update(new THREE.Vector3(64, 20, 32));
    expect(layer.distantTownCount).toBe(0);
    const nearAfter = layer.group.children.filter(
      (child) => child.name.startsWith('city-') && child.name !== 'city-far',
    );
    expect(layer.bucketRebuilds).toBeGreaterThan(0);
    expect(layer.bucketRebuilds).toBeLessThan(nearAfter.length);
    expect(nearAfter.some((mesh) => nearBefore.includes(mesh))).toBe(true);
    layer.dispose();
  });
});

/** Ville carrée compacte autour d'un centre. */
function makeTownAt(map: MapSnapshot, id: number, cx: number, cy: number): TownSnapshot {
  let count = 0;
  for (let dy = -6; dy <= 6; dy += 1) {
    for (let dx = -6; dx <= 6; dx += 1) {
      if (dx * dx + dy * dy > 36) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      map.kind[y * map.width + x] = TILE_KIND_INDEX.house;
      count += 1;
    }
  }
  return {
    id,
    name: `Ville ${id}`,
    x: cx + 0.5,
    y: cy + 0.5,
    population: 3_000,
    growthRate: 1,
    buildings: count,
    rating: 70,
  };
}

/** Lacet d'un quaternion de rotation Y uniquement. */
function quaternionToYaw(quaternion: THREE.Quaternion): number {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
  return euler.y;
}
