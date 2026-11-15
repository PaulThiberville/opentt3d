import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import { TILE_KIND_INDEX, type MapSnapshot, type StationSnapshot } from '../src/engine/protocol';
import { cornerHeightWorld, sampleHeightWorld } from '../src/game/mapGrid';
import { TrackLayer, TRACK_CHUNK_SIZE, trackGroundHeight } from '../src/render/TrackLayer';
import {
  TRACK_CONNECT,
  TRACK_CORNER,
  buildTrackMasks,
  buildTrackPlans,
  classifyConnections,
  inferTilePlan,
} from '../src/render/trackPlan';

function makeMap(width = 16, height = 16, fill = TILE_KIND_INDEX.grass): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(fill),
    heightMap: new Uint8Array(size).fill(2),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function setKind(map: MapSnapshot, x: number, y: number, kind: number): void {
  map.kind[y * map.width + x] = kind;
}

function road(map: MapSnapshot, x: number, y: number): void {
  setKind(map, x, y, TILE_KIND_INDEX.road);
}

function rail(map: MapSnapshot, x: number, y: number): void {
  setKind(map, x, y, TILE_KIND_INDEX.rail);
}

function planAt(map: MapSnapshot, x: number, y: number) {
  const plans = buildTrackPlans(map);
  return plans.find((plan) => plan.x === x && plan.y === y) ?? null;
}

function meshVertices(layer: TrackLayer): number[] {
  const values: number[] = [];
  for (const child of layer.group.children) {
    const mesh = child as Mesh;
    if (!mesh.geometry) continue;
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1)
      values.push(position.getX(i), position.getY(i), position.getZ(i));
  }
  return values;
}

describe('inférence d’orientation des voies', () => {
  it('classe droit, virage, T et croisement', () => {
    expect(classifyConnections(TRACK_CONNECT.east | TRACK_CONNECT.west)).toBe('straight');
    expect(classifyConnections(TRACK_CONNECT.north | TRACK_CONNECT.south)).toBe('straight');
    expect(classifyConnections(TRACK_CONNECT.north | TRACK_CONNECT.east)).toBe('curve');
    expect(classifyConnections(TRACK_CONNECT.north | TRACK_CONNECT.east | TRACK_CONNECT.west)).toBe(
      'tee',
    );
    expect(
      classifyConnections(
        TRACK_CONNECT.north | TRACK_CONNECT.east | TRACK_CONNECT.south | TRACK_CONNECT.west,
      ),
    ).toBe('cross');
    expect(classifyConnections(0)).toBe('isolated');
    expect(classifyConnections(TRACK_CONNECT.south)).toBe('dead-end');
  });

  it('déduit une route droite est-ouest du voisinage', () => {
    const map = makeMap(9, 9);
    for (let x = 1; x <= 7; x += 1) road(map, x, 4);
    const plan = planAt(map, 4, 4);
    expect(plan).not.toBeNull();
    expect(plan?.network).toBe('road');
    expect(plan?.shape).toBe('straight');
    expect(plan?.axis).toBe('x');
    expect(plan?.connections).toBe(TRACK_CONNECT.east | TRACK_CONNECT.west);
  });

  it('déduit un virage, un T et un croisement routiers', () => {
    const curve = makeMap(9, 9);
    road(curve, 4, 4);
    road(curve, 5, 4);
    road(curve, 4, 3);
    expect(planAt(curve, 4, 4)?.shape).toBe('curve');

    const tee = makeMap(9, 9);
    road(tee, 4, 4);
    road(tee, 3, 4);
    road(tee, 5, 4);
    road(tee, 4, 3);
    expect(planAt(tee, 4, 4)?.shape).toBe('tee');

    const cross = makeMap(9, 9);
    road(cross, 4, 4);
    road(cross, 3, 4);
    road(cross, 5, 4);
    road(cross, 4, 3);
    road(cross, 4, 5);
    expect(planAt(cross, 4, 4)?.shape).toBe('cross');
  });

  it('gère les abouts et les tuiles isolées (convention est-ouest)', () => {
    const map = makeMap(9, 9);
    road(map, 4, 4);
    road(map, 5, 4);
    expect(planAt(map, 4, 4)?.shape).toBe('dead-end');
    expect(planAt(map, 5, 4)?.axis).toBe('x');

    const isolated = makeMap(9, 9);
    road(isolated, 4, 4);
    const plan = planAt(isolated, 4, 4);
    expect(plan?.shape).toBe('isolated');
    expect(plan?.axis).toBe('x');
  });

  it('détecte les diagonales de rails par les quatre coins', () => {
    const map = makeMap(9, 9);
    rail(map, 2, 2);
    rail(map, 3, 3);
    rail(map, 4, 4);
    const plan = planAt(map, 3, 3);
    expect(plan?.network).toBe('rail');
    expect(plan?.shape).toBe('diagonal');
    expect(plan?.corners).toBe(TRACK_CORNER.nw | TRACK_CORNER.se);

    const cross = makeMap(9, 9);
    rail(cross, 4, 4);
    rail(cross, 5, 3);
    rail(cross, 5, 5);
    rail(cross, 3, 5);
    rail(cross, 3, 3);
    const centre = planAt(cross, 4, 4);
    expect(centre?.shape).toBe('diagonal-cross');
    expect(centre?.corners).toBe(
      TRACK_CORNER.ne | TRACK_CORNER.se | TRACK_CORNER.sw | TRACK_CORNER.nw,
    );
  });

  it('raccorde les diagonales aux voies droites sans éperon parasite', () => {
    const map = makeMap(9, 9);
    rail(map, 3, 3);
    rail(map, 4, 4);
    rail(map, 5, 4);
    const plan = planAt(map, 4, 4);
    expect(plan?.connections).toBe(TRACK_CONNECT.east);
    expect(plan?.corners).toBe(TRACK_CORNER.nw);
  });

  it('classe une gare ferroviaire avec son axe, et une gare routière', () => {
    const map = makeMap(12, 12);
    for (let y = 3; y < 7; y += 1) setKind(map, 4, y, TILE_KIND_INDEX.station);
    const station: StationSnapshot = {
      id: 1,
      company: 0,
      name: 'Gare',
      kind: 'train',
      x: 4.5,
      y: 4.5,
      width: 1,
      height: 4,
      waiting: [],
    };
    const masks = buildTrackMasks(map, [station]);
    expect(masks.rail[4 * 12 + 4]).toBe(1);
    expect(masks.stationAxis[4 * 12 + 4]).toBe(2);
    const plan = inferTilePlan(map, masks, 4, 4, 'rail');
    expect(plan.station).toBe(true);
    expect(plan.shape).toBe('straight');
    expect(plan.axis).toBe('y');

    const roadStation: StationSnapshot = {
      ...station,
      id: 2,
      kind: 'road',
      x: 8.5,
      y: 8.5,
      width: 2,
      height: 1,
    };
    for (let x = 8; x < 10; x += 1) setKind(map, x, 8, TILE_KIND_INDEX.station);
    const roadMasks = buildTrackMasks(map, [station, roadStation]);
    expect(roadMasks.road[8 * 12 + 8]).toBe(1);
    expect(roadMasks.stationAxis[8 * 12 + 8]).toBe(1);
  });

  it('classe tout un tablier de pont long, pas seulement ses extrémités', () => {
    const map = makeMap(16, 8);
    rail(map, 1, 4);
    for (let x = 2; x <= 12; x += 1) {
      setKind(map, x, 4, TILE_KIND_INDEX.bridge);
      map.flags[4 * 16 + x] = 1 << 4;
    }
    rail(map, 13, 4);
    const masks = buildTrackMasks(map);
    for (let x = 2; x <= 12; x += 1) expect(masks.rail[4 * 16 + x]).toBe(1);
    expect(masks.road.some((value) => value !== 0)).toBe(false);
  });
});

describe('TrackLayer', () => {
  function networkMap(size = 64): MapSnapshot {
    const map = makeMap(size, size);
    for (let y = 2; y < size - 2; y += 2) {
      for (let x = 2; x < size - 2; x += 2) road(map, x, y);
    }
    for (let x = 0; x < size; x += 1) {
      road(map, x, Math.floor(size / 2));
      rail(map, x, Math.floor(size / 2) + 2);
    }
    return map;
  }

  it('construit un maillage fusionné par chunk et suit le terrain', () => {
    const map = networkMap(64);
    const layer = new TrackLayer();
    layer.setMap(map);
    expect(layer.chunkCount).toBe(4);
    expect(layer.chunksBuilt).toBe(4);
    expect(layer.drawCallCount).toBe(4);
    expect(layer.triangleCount).toBeGreaterThan(0);

    // Toutes les voies restent au-dessus du sol et sous les véhicules.
    const ground = sampleHeightWorld(map, 10.5, 10.5);
    const vertices = meshVertices(layer);
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 1; i < vertices.length; i += 3) {
      const y = vertices[i] ?? 0;
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
    expect(minY).toBeCloseTo(ground, 4);
    expect(maxY).toBeLessThanOrEqual(ground + 0.09 + 1e-6);
    layer.dispose();
  });

  it('suit exactement la triangulation du terrain', () => {
    const map = makeMap(8, 8);
    map.heightMap.fill(4);
    map.heightMap[3 * 8 + 3] = 7;
    const points: Array<[number, number]> = [
      [3.5, 3.5],
      [3.2, 3.7],
      [3.7, 3.2],
      [4.5, 4.5],
    ];
    for (const [x, z] of points) {
      const x0 = Math.floor(x);
      const z0 = Math.floor(z);
      const u = x - x0;
      const v = z - z0;
      const hA = cornerHeightWorld(map, x0, z0);
      const hB = cornerHeightWorld(map, x0 + 1, z0);
      const hC = cornerHeightWorld(map, x0 + 1, z0 + 1);
      const hD = cornerHeightWorld(map, x0, z0 + 1);
      const expected =
        v <= u ? hA + (hB - hA) * u + (hC - hB) * v : hA + (hD - hA) * v + (hC - hD) * u;
      expect(trackGroundHeight(map, x, z)).toBeCloseTo(expected, 6);
    }
    // Sur la diagonale de découpe, les deux interpolations coïncident.
    expect(trackGroundHeight(map, 3.5, 3.5)).toBeCloseTo(sampleHeightWorld(map, 3.5, 3.5), 6);
  });

  it('bascule le LOD détaillé selon la distance caméra', () => {
    const layer = new TrackLayer();
    layer.setMap(networkMap(64));
    layer.setQuality('medium');
    layer.update({ x: 32, y: 0, z: 32 });
    expect(layer.detailVisible(0, 0)).toBe(true);
    expect(layer.detailChunkCount).toBeGreaterThan(0);
    const detailTriangles = layer.triangleCount;

    layer.update({ x: 3200, y: 0, z: 3200 });
    expect(layer.detailVisible(0, 0)).toBe(false);
    expect(layer.triangleCount).toBeLessThan(detailTriangles);
    expect(layer.drawCallCount).toBe(layer.chunkCount);
    layer.dispose();
  });

  it('réduit les détails en qualité basse', () => {
    const layer = new TrackLayer();
    layer.setMap(networkMap(64));
    layer.setQuality('low');
    layer.update({ x: 32, y: 0, z: 32 });
    expect(layer.detailChunkCount).toBe(0);
    expect(layer.triangleCount).toBeGreaterThan(0);
    expect(layer.chunkTriangles(0, 0, true)).toBe(0);
    layer.dispose();
  });

  it('reste déterministe d’une construction à l’autre', () => {
    const map = networkMap(64);
    const first = new TrackLayer();
    const second = new TrackLayer();
    first.setMap(map);
    second.setMap(map);
    expect(second.chunkCount).toBe(first.chunkCount);
    expect(second.triangleCount).toBe(first.triangleCount);
    expect(second.chunkTriangles(0, 0, true)).toBe(first.chunkTriangles(0, 0, true));
    const a = meshVertices(first);
    const b = meshVertices(second);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < Math.min(a.length, 3000); i += 1) expect(a[i]).toBe(b[i]);
    first.dispose();
    second.dispose();
  });

  it('ne reconstruit que les chunks modifiés et gère le delta de gares', () => {
    const map = networkMap(64);
    const layer = new TrackLayer();
    layer.setMap(map);
    expect(layer.chunksBuilt).toBe(4);

    const identical = networkMap(64);
    layer.applyDelta(identical);
    expect(layer.chunksBuilt).toBe(4);

    const changed = networkMap(64);
    road(changed, 41, 41);
    layer.applyDelta(changed);
    expect(layer.chunksBuilt).toBe(5);

    const withStation = networkMap(64);
    setKind(withStation, 2, 2, TILE_KIND_INDEX.station);
    const station: StationSnapshot = {
      id: 7,
      company: 0,
      name: 'Gare',
      kind: 'train',
      x: 2.5,
      y: 2.5,
      width: 1,
      height: 1,
      waiting: [],
    };
    layer.applyDelta(withStation, [station]);
    expect(layer.chunksBuilt).toBeGreaterThan(5);
    expect(layer.trackTileCount).toBeGreaterThan(0);
    layer.dispose();
  });

  it('ignore les tunnels et se libère entièrement', () => {
    const map = makeMap(32, 32);
    for (let x = 0; x < 32; x += 1) setKind(map, x, 10, TILE_KIND_INDEX.tunnel);
    const layer = new TrackLayer();
    layer.setMap(map);
    expect(layer.chunkCount).toBe(0);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.chunkCount).toBe(0);
    expect(layer.triangleCount).toBe(0);
    expect(layer.drawCallCount).toBe(0);
  });

  it('borne le facteur de nuit sans changer les draw calls', () => {
    const layer = new TrackLayer();
    layer.setMap(networkMap(64));
    const before = layer.drawCallCount;
    layer.setNight(0.7);
    expect(layer.night).toBeCloseTo(0.7, 6);
    layer.setNight(4);
    expect(layer.night).toBe(1);
    layer.setNight(Number.NaN);
    expect(layer.night).toBe(0);
    expect(layer.drawCallCount).toBe(before);
    layer.dispose();
  });

  it('respecte le budget de triangles et de draw calls', () => {
    const size = 256;
    const map = makeMap(size, size);
    // Réseau réaliste : routes tous les 8 tiles, rails sur une double voie.
    for (let y = 4; y < size - 4; y += 8) {
      for (let x = 4; x < size - 4; x += 1) road(map, x, y);
    }
    for (let x = 4; x < size - 4; x += 8) {
      for (let y = 4; y < size - 4; y += 1) road(map, x, y);
    }
    for (let x = 4; x < size - 4; x += 1) {
      rail(map, x, 120);
      rail(map, x, 121);
    }
    const layer = new TrackLayer();
    layer.setMap(map);
    layer.setQuality('medium');
    layer.update({ x: 128, y: 0, z: 128 });
    expect(layer.chunkCount).toBe(Math.pow(size / TRACK_CHUNK_SIZE, 2));
    expect(layer.drawCallCount).toBe(layer.chunkCount);
    // Un chunk = un draw call, même avec route et rail dans le même chunk.
    expect(layer.drawCallCount).toBeLessThanOrEqual(64);
    expect(layer.triangleCount).toBeLessThan(400_000);
    layer.dispose();
  });
});
