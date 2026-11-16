import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import { TILE_KIND_INDEX, type MapSnapshot, type StationSnapshot } from '../src/engine/protocol';
import { cornerHeightWorld, sampleHeightWorld } from '../src/game/mapGrid';
import {
  TrackLayer,
  TRACK_CHUNK_SIZE,
  trackGroundHeight,
  roadTileLayout,
  roadMarkingPaths,
  ROAD_LIFT,
  SIDEWALK_LIFT,
  MARK_LIFT,
} from '../src/render/TrackLayer';
import { buildRoadSurface } from '../src/render/roadSurface';
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

// ---------------------------------------------------------------------------
// #181 — carrefours routiers : chaussée pleine tuile, trottoirs sur les seuls
// bords non connectés, marquages arrêtés avant la place centrale.
// ---------------------------------------------------------------------------

type Shape = 'straight' | 'curve' | 'tee' | 'cross' | 'dead-end' | 'isolated';

function shapeMap(shape: Shape): MapSnapshot {
  const map = makeMap(9, 9);
  switch (shape) {
    case 'straight':
      for (let x = 2; x <= 6; x += 1) road(map, x, 4);
      break;
    case 'curve':
      road(map, 4, 4);
      road(map, 5, 4);
      road(map, 4, 3);
      break;
    case 'tee':
      road(map, 4, 4);
      road(map, 3, 4);
      road(map, 5, 4);
      road(map, 4, 3);
      break;
    case 'cross':
      road(map, 4, 4);
      road(map, 3, 4);
      road(map, 5, 4);
      road(map, 4, 3);
      road(map, 4, 5);
      break;
    case 'dead-end':
      road(map, 4, 4);
      road(map, 5, 4);
      break;
    case 'isolated':
      road(map, 4, 4);
      break;
  }
  return map;
}

function unconnectedBits(connections: number): number[] {
  const bits: number[] = [];
  if (!(connections & TRACK_CONNECT.north)) bits.push(TRACK_CONNECT.north);
  if (!(connections & TRACK_CONNECT.east)) bits.push(TRACK_CONNECT.east);
  if (!(connections & TRACK_CONNECT.south)) bits.push(TRACK_CONNECT.south);
  if (!(connections & TRACK_CONNECT.west)) bits.push(TRACK_CONNECT.west);
  return bits;
}

interface TestTriangle {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
}

/** Triangles bruts d'un maillage de chunk (base ou détaillé). */
function chunkTriangles(layer: TrackLayer, prefix: 'track-base' | 'track-detail'): TestTriangle[] {
  const triangles: TestTriangle[] = [];
  for (const child of layer.group.children) {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.name.startsWith(prefix)) continue;
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i + 2 < position.count; i += 3) {
      triangles.push({
        a: [position.getX(i), position.getY(i), position.getZ(i)],
        b: [position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)],
        c: [position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2)],
      });
    }
  }
  return triangles;
}

/** Hauteurs des surfaces horizontales couvrant (x, z), projections XZ. */
function surfaceHeights(triangles: readonly TestTriangle[], x: number, z: number): number[] {
  const heights: number[] = [];
  for (const triangle of triangles) {
    const [ax, ay, az] = triangle.a;
    const [bx, by, bz] = triangle.b;
    const [cx, cy, cz] = triangle.c;
    const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(denominator) < 1e-9) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    heights.push(l1 * ay + l2 * by + l3 * cy);
  }
  return heights;
}

describe('géométrie des carrefours routiers (#181)', () => {
  it('découpe chaque tuile en chaussée pleine + trottoirs sur les bords libres', () => {
    for (const shape of ['straight', 'curve', 'tee', 'cross', 'dead-end', 'isolated'] as const) {
      const map = shapeMap(shape);
      const plan = planAt(map, 4, 4);
      expect(plan, shape).not.toBeNull();
      if (!plan) continue;
      const layout = roadTileLayout(plan);
      // Chaussée continue sur toute la tuile, sans trou central ni aux angles.
      expect(layout.asphalt).toEqual({ x0: 4, z0: 4, x1: 5, z1: 5 });
      // Un trottoir et un seul par bord non connecté.
      const expected = unconnectedBits(plan.connections).sort();
      const actual = layout.sidewalks.map((strip) => strip.bit).sort();
      expect(actual, shape).toEqual(expected);
      // Aucun trottoir ne recouvre un bord relié, donc aucun trottoir au
      // milieu d'un carrefour.
      for (const bit of layout.arms) {
        expect(actual).not.toContain(bit);
      }
      // Les trottoirs restent dans la tuile et ne se chevauchent jamais.
      for (const strip of layout.sidewalks) {
        expect(strip.rect.x0).toBeGreaterThanOrEqual(4);
        expect(strip.rect.z0).toBeGreaterThanOrEqual(4);
        expect(strip.rect.x1).toBeLessThanOrEqual(5);
        expect(strip.rect.z1).toBeLessThanOrEqual(5);
      }
      for (let i = 0; i < layout.sidewalks.length; i += 1) {
        for (let j = i + 1; j < layout.sidewalks.length; j += 1) {
          const first = layout.sidewalks[i]?.rect;
          const second = layout.sidewalks[j]?.rect;
          if (!first || !second) continue;
          const overlapX = Math.min(first.x1, second.x1) - Math.max(first.x0, second.x0);
          const overlapZ = Math.min(first.z1, second.z1) - Math.max(first.z0, second.z0);
          expect(Math.min(overlapX, overlapZ), `${shape} ${i}/${j}`).toBeLessThanOrEqual(0);
        }
      }
      // Le centre de la tuile est toujours de la chaussée, jamais un trottoir.
      for (const strip of layout.sidewalks) {
        const inside =
          4.5 > strip.rect.x0 && 4.5 < strip.rect.x1 && 4.5 > strip.rect.z0 && 4.5 < strip.rect.z1;
        expect(inside, shape).toBe(false);
      }
    }
  });

  it('couvre chaque tuile route sans trou, en LOD proche comme éloigné', () => {
    for (const shape of ['straight', 'curve', 'tee', 'cross', 'dead-end', 'isolated'] as const) {
      const map = shapeMap(shape);
      const layer = new TrackLayer();
      layer.setMap(map);
      layer.setQuality('high');
      try {
        const base = chunkTriangles(layer, 'track-base');
        const detail = chunkTriangles(layer, 'track-detail');
        expect(base.length, shape).toBeGreaterThan(0);
        expect(detail.length, shape).toBeGreaterThan(base.length);
        for (const triangles of [base, detail]) {
          for (let y = 0; y < map.height; y += 1) {
            for (let x = 0; x < map.width; x += 1) {
              const index = y * map.width + x;
              if (map.kind[index] !== TILE_KIND_INDEX.road) continue;
              for (const fx of [0.07, 0.2, 0.5, 0.8, 0.93]) {
                for (const fz of [0.07, 0.2, 0.5, 0.8, 0.93]) {
                  const sampleX = x + fx;
                  const sampleZ = y + fz;
                  const ground = trackGroundHeight(map, sampleX, sampleZ);
                  const heights = surfaceHeights(triangles, sampleX, sampleZ);
                  const covered = heights.some(
                    (height) => height >= ground + 0.03 - 1e-4 && height <= ground + 0.075 + 1e-4,
                  );
                  expect(covered, `${shape} tuile ${x},${y} échantillon ${fx},${fz}`).toBe(true);
                }
              }
            }
          }
        }
      } finally {
        layer.dispose();
      }
    }
  });

  it('ne marque jamais la place d’un carrefour', () => {
    for (const shape of ['tee', 'cross', 'dead-end', 'isolated'] as const) {
      const map = shapeMap(shape);
      const plan = planAt(map, 4, 4);
      expect(plan).not.toBeNull();
      expect(plan ? roadMarkingPaths(plan) : []).toHaveLength(0);
    }

    // Droite : les tirets restent dans la tuile et suivent l'axe central.
    const straight = planAt(shapeMap('straight'), 4, 4);
    expect(straight).not.toBeNull();
    const straightPaths = straight ? roadMarkingPaths(straight) : [];
    expect(straightPaths.length).toBeGreaterThan(0);
    for (const path of straightPaths) {
      for (const point of path) {
        expect(point.z).toBeCloseTo(4.5, 6);
        expect(point.x).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(point.x).toBeLessThanOrEqual(5 + 1e-9);
      }
    }

    // Virage : une ligne continue qui traverse la tuile.
    const curve = planAt(shapeMap('curve'), 4, 4);
    expect(curve).not.toBeNull();
    const curvePaths = curve ? roadMarkingPaths(curve) : [];
    expect(curvePaths).toHaveLength(1);
    expect(curvePaths[0]?.length).toBeGreaterThan(2);
    for (const point of curvePaths[0] ?? []) {
      expect(point.x).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(point.z).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(point.x).toBeLessThanOrEqual(5 + 1e-9);
      expect(point.z).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it('raccorde les portails de tunnel sans bordure parasite', () => {
    const map = makeMap(9, 9);
    road(map, 3, 4);
    setKind(map, 4, 4, TILE_KIND_INDEX.tunnel);
    setKind(map, 5, 4, TILE_KIND_INDEX.tunnel);
    road(map, 6, 4);

    const masks = buildTrackMasks(map);
    expect(masks.road[4 * 9 + 4]).toBe(1);
    expect(masks.road[4 * 9 + 5]).toBe(1);
    expect(masks.rail[4 * 9 + 4]).toBe(0);

    const plan = inferTilePlan(map, masks, 3, 4, 'road');
    expect(plan.connections).toBe(TRACK_CONNECT.east);
    const layout = roadTileLayout(plan);
    expect(layout.sidewalks.map((strip) => strip.bit)).not.toContain(TRACK_CONNECT.east);

    // Les tuiles tunnel ne reçoivent aucune géométrie de surface.
    const plans = buildTrackPlans(map);
    expect(
      plans.some((candidate) => candidate.y === 4 && (candidate.x === 4 || candidate.x === 5)),
    ).toBe(false);
  });

  it('reste sous le budget de triangles d’un réseau de carrefours', () => {
    const size = 64;
    const map = makeMap(size, size);
    // Une route tous les 4 tiles dans les deux axes : beaucoup de T et de
    // croisements, le pire cas pour la géométrie.
    for (let y = 4; y < size - 4; y += 4) {
      for (let x = 4; x < size - 4; x += 1) road(map, x, y);
    }
    for (let x = 4; x < size - 4; x += 4) {
      for (let y = 4; y < size - 4; y += 1) road(map, x, y);
    }
    const layer = new TrackLayer();
    layer.setMap(map);
    layer.setQuality('high');
    layer.update({ x: 32, y: 0, z: 32 });
    try {
      const tiles = layer.trackTileCount;
      expect(tiles).toBeGreaterThan(1000);
      expect(layer.drawCallCount).toBe(layer.chunkCount);
      // Avant #181 : ~45 triangles/tuile en détail, ~14 en base. La chaussée
      // pleine tuile supprime les places et bras redondants.
      expect(layer.triangleCount / tiles).toBeLessThan(32);
    } finally {
      layer.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// #202 — pas de dévers : la chaussée est horizontale dans sa largeur et ne
// s'incline que dans le sens de la longueur. Les hauteurs sont continues aux
// jonctions, et les véhicules restent posés sur l'axe médian.
// ---------------------------------------------------------------------------

/** Carte à très forte pente transversale (2 niveaux par rangée) et longitudinale. */
function slopedMap(shape: 'straight' | 'cross'): MapSnapshot {
  const map = makeMap(16, 16);
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      map.heightMap[y * map.width + x] = Math.min(15, 2 + y * 2 + Math.floor(x / 2));
    }
  }
  if (shape === 'straight') {
    for (let x = 2; x <= 13; x += 1) road(map, x, 4);
  } else {
    road(map, 4, 4);
    for (let x = 2; x <= 6; x += 1) road(map, x, 4);
    for (let y = 2; y <= 6; y += 1) road(map, 4, y);
  }
  return map;
}

/**
 * Marche d'un niveau le long d'une route : c'est le dévers minimal qu'un
 * terrain OpenTTD puisse produire (un seul rang surélevé). L'écart de coins
 * en travers vaut alors 0,25 unité monde.
 */
function steppedMap(shape: 'straight' | 'cross'): MapSnapshot {
  const map = makeMap(16, 16);
  map.heightMap.fill(4);
  if (shape === 'straight') {
    for (let x = 2; x <= 13; x += 1) {
      road(map, x, 4);
      map.heightMap[3 * map.width + x] = 5;
    }
  } else {
    road(map, 4, 4);
    for (let x = 2; x <= 6; x += 1) road(map, x, 4);
    for (let y = 2; y <= 6; y += 1) road(map, 4, y);
    for (let y = 1; y <= 7; y += 1) map.heightMap[y * map.width + 3] = 5;
  }
  return map;
}

describe('chaussée sans dévers (#202)', () => {
  it('garde les deux bords de la largeur à la même hauteur, quelle que soit la pente', () => {
    const map = slopedMap('straight');
    const plan = planAt(map, 5, 4);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const surface = buildRoadSurface(map, plan);
    expect(surface.mode).toBe('straight');
    expect(surface.axis).toBe('x');

    // Pente transversale réelle : les deux bords du terrain diffèrent de plus
    // d'une demi-unité monde, et pourtant la chaussée reste plate.
    const groundNorth = sampleHeightWorld(map, 5.5, 4);
    const groundSouth = sampleHeightWorld(map, 5.5, 5);
    expect(Math.abs(groundNorth - groundSouth)).toBeGreaterThan(0.5);

    for (let step = 0; step <= 10; step += 1) {
      const x = 5 + step / 10;
      const north = surface.heightAt(x, 4 + 0.08);
      const south = surface.heightAt(x, 4 + 0.92);
      expect(north).toBeCloseTo(south, 12);
    }

    // La pente longitudinale, elle, suit bien le terrain entre les deux bords.
    const west = surface.heightAt(5, 4.5);
    const east = surface.heightAt(6, 4.5);
    expect(east).not.toBeCloseTo(west, 6);
    expect(east - west).toBeCloseTo(
      sampleHeightWorld(map, 6, 4.5) - sampleHeightWorld(map, 5, 4.5),
      9,
    );
  });

  it('garde les véhicules posés sur la chaussée et le sol hors de la dalle', () => {
    const map = steppedMap('straight');
    for (let tileX = 2; tileX <= 13; tileX += 1) {
      const plan = planAt(map, tileX, 4);
      expect(plan).not.toBeNull();
      if (!plan) continue;
      const surface = buildRoadSurface(map, plan);
      for (const offset of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const x = tileX + offset;
        // Les moteurs posent les véhicules à `sampleHeightWorld + 0.08`. La
        // chaussée est calée sous le bord haut : l'écart reste faible (les
        // roues mordent la dalle de quelques centimètres au plus).
        const roadTop = surface.heightAt(x, 4.5) + ROAD_LIFT;
        const vehicleBase = sampleHeightWorld(map, x, 4.5) + 0.08;
        expect(roadTop - vehicleBase).toBeGreaterThanOrEqual(-0.01);
        expect(roadTop - vehicleBase).toBeLessThan(0.055);

        // Hors de la fine bande amont reprise par le trottoir, le terrain ne
        // traverse plus la chaussée (aucun trou dans le revêtement).
        for (const z of [4.14, 4.3, 4.5, 4.7, 4.86]) {
          expect(roadTop).toBeGreaterThanOrEqual(sampleHeightWorld(map, x, z) - 1e-9);
        }
      }
    }

    // Une route nord-sud suit la même règle sur son axe x = tuile + 0,5.
    const vertical = steppedMap('cross');
    const plan = planAt(vertical, 4, 5);
    expect(plan?.axis).toBe('y');
    if (!plan) return;
    const surface = buildRoadSurface(vertical, plan);
    for (const offset of [0.1, 0.5, 0.9]) {
      expect(surface.heightAt(4.1, 5 + offset)).toBeCloseTo(surface.heightAt(4.9, 5 + offset), 12);
      const roadTop = surface.heightAt(4.5, 5 + offset) + ROAD_LIFT;
      const vehicleBase = sampleHeightWorld(vertical, 4.5, 5 + offset) + 0.08;
      expect(roadTop - vehicleBase).toBeGreaterThanOrEqual(-0.01);
      expect(roadTop - vehicleBase).toBeLessThan(0.055);
    }
  });

  it('raccorde exactement les tuiles voisines, y compris aux carrefours', () => {
    const map = slopedMap('straight');
    for (let tileX = 2; tileX < 13; tileX += 1) {
      const left = planAt(map, tileX, 4);
      const right = planAt(map, tileX + 1, 4);
      expect(left).not.toBeNull();
      expect(right).not.toBeNull();
      if (!left || !right) continue;
      const leftSurface = buildRoadSurface(map, left);
      const rightSurface = buildRoadSurface(map, right);
      for (const z of [4.1, 4.5, 4.9]) {
        expect(leftSurface.heightAt(tileX + 1, z)).toBeCloseTo(
          rightSurface.heightAt(tileX + 1, z),
          12,
        );
      }
    }

    const cross = slopedMap('cross');
    const junction = planAt(cross, 4, 4);
    expect(junction?.shape).toBe('cross');
    if (!junction) return;
    const surface = buildRoadSurface(cross, junction);
    expect(surface.mode).toBe('junction');

    // Chaque bord connecté est plat et raccordé à la tuile droite voisine.
    const arms: Array<{
      bit: number;
      boundary: [number, number];
      samples: Array<[number, number]>;
      neighbour: [number, number];
    }> = [
      {
        bit: TRACK_CONNECT.west,
        boundary: [4, 4.5],
        samples: [
          [4, 4.15],
          [4, 4.5],
          [4, 4.85],
        ],
        neighbour: [3, 4],
      },
      {
        bit: TRACK_CONNECT.east,
        boundary: [5, 4.5],
        samples: [
          [5, 4.15],
          [5, 4.5],
          [5, 4.85],
        ],
        neighbour: [5, 4],
      },
      {
        bit: TRACK_CONNECT.north,
        boundary: [4.5, 4],
        samples: [
          [4.15, 4],
          [4.5, 4],
          [4.85, 4],
        ],
        neighbour: [4, 3],
      },
      {
        bit: TRACK_CONNECT.south,
        boundary: [4.5, 5],
        samples: [
          [4.15, 5],
          [4.5, 5],
          [4.85, 5],
        ],
        neighbour: [4, 5],
      },
    ];

    for (const arm of arms) {
      const edge = surface.sideHeight(arm.bit);
      for (const [x, z] of arm.samples) {
        expect(surface.heightAt(x, z)).toBeCloseTo(edge, 12);
      }
      const other = planAt(cross, arm.neighbour[0], arm.neighbour[1]);
      expect(other).not.toBeNull();
      if (!other) continue;
      const otherSurface = buildRoadSurface(cross, other);
      const [bx, bz] = arm.boundary;
      expect(surface.heightAt(bx, bz)).toBeCloseTo(otherSurface.heightAt(bx, bz), 12);
    }

    // Au centre du carrefour, la chaussée coïncide avec le sol des véhicules.
    expect(surface.heightAt(4.5, 4.5)).toBeCloseTo(sampleHeightWorld(cross, 4.5, 4.5), 9);
  });

  it('couvre le carrefour sans trou et sans facette visible de dessus', () => {
    const map = slopedMap('cross');
    const layer = new TrackLayer();
    layer.setMap(map);
    layer.setQuality('high');
    try {
      const triangles = chunkTriangles(layer, 'track-detail');
      const plan = planAt(map, 4, 4);
      expect(plan?.shape).toBe('cross');
      if (!plan) return;
      const surface = buildRoadSurface(map, plan);
      for (const fx of [0.15, 0.35, 0.65, 0.85]) {
        for (const fz of [0.15, 0.35, 0.65, 0.85]) {
          const x = 4 + fx;
          const z = 4 + fz;
          const expected = surface.heightAt(x, z) + ROAD_LIFT;
          const heights = surfaceHeights(triangles, x, z);
          expect(
            heights.some((height) => Math.abs(height - expected) < 1e-3),
            `carrefour ${fx},${fz}`,
          ).toBe(true);
        }
      }
    } finally {
      layer.dispose();
    }
  });

  it('aligne trottoirs et marquages sur le profil de la chaussée', () => {
    const map = slopedMap('straight');
    const plan = planAt(map, 5, 4);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const surface = buildRoadSurface(map, plan);

    const layer = new TrackLayer();
    layer.setMap(map);
    layer.setQuality('high');
    try {
      const triangles = chunkTriangles(layer, 'track-detail');

      // Le trottoir nord est plat dans sa largeur et suit la pente
      // longitudinale : deux points de même abscisse ont la même hauteur.
      const sidewalkA = surface.heightAt(5.5, 4.03) + SIDEWALK_LIFT;
      const sidewalkB = surface.heightAt(5.5, 4.08) + SIDEWALK_LIFT;
      expect(sidewalkA).toBeCloseTo(sidewalkB, 12);
      for (const [x, z] of [
        [5.5, 4.03],
        [5.5, 4.08],
      ] as const) {
        const expected = surface.heightAt(x, z) + SIDEWALK_LIFT;
        expect(
          surfaceHeights(triangles, x, z).some((height) => Math.abs(height - expected) < 1e-3),
          `trottoir ${x},${z}`,
        ).toBe(true);
      }

      // Un tiret de marquage est posé exactement au-dessus du profil.
      const path = roadMarkingPaths(plan)[0];
      expect(path).toBeDefined();
      if (!path) return;
      const first = path[0];
      const last = path[path.length - 1];
      if (!first || !last) return;
      const x = (first.x + last.x) / 2;
      const z = (first.z + last.z) / 2;
      const expected = surface.heightAt(x, z) + MARK_LIFT;
      expect(
        surfaceHeights(triangles, x, z).some((height) => Math.abs(height - expected) < 1e-3),
        `marquage ${x},${z}`,
      ).toBe(true);
    } finally {
      layer.dispose();
    }
  });
});
