import { describe, expect, it } from 'vitest';
import { ROAD_ONEWAY_INDEX, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import {
  BUILD_COST_PER_TILE,
  CONNECT_EAST,
  CONNECT_NORTH,
  CONNECT_SOUTH,
  CONNECT_WEST,
  ROAD_ONEWAY_SURCHARGE,
  commandFromPlan,
  nextRoadDirection,
  planBuild,
} from '../src/game/buildRules';

function makeMap(width = 16, height = 16, level = 4): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(level),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function fillRoad(map: MapSnapshot, fromX: number, toX: number, y: number): void {
  for (let x = fromX; x <= toX; x += 1) {
    map.kind[y * map.width + x] = TILE_KIND_INDEX.road;
  }
}

describe('buildRules : routes à sens unique (#231)', () => {
  it('construit un segment est-ouest avec deux voies et un surcoût', () => {
    const map = makeMap();
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 2, y: 4 },
      to: { x: 5, y: 4 },
      roadDirection: 'east',
    });

    expect(plan.valid).toBe(true);
    expect(plan.road).toEqual({ direction: 'east', oneWay: 'east', convert: false });
    expect(plan.tiles).toHaveLength(4);
    expect(plan.tiles[0]?.connections).toBe(CONNECT_EAST);
    expect(plan.tiles[1]?.connections).toBe(CONNECT_EAST | CONNECT_WEST);
    expect(plan.tiles[2]?.connections).toBe(CONNECT_EAST | CONNECT_WEST);
    expect(plan.tiles[3]?.connections).toBe(CONNECT_WEST);
    for (const tile of plan.tiles) {
      expect(tile.cost).toBe(BUILD_COST_PER_TILE.road + ROAD_ONEWAY_SURCHARGE);
    }
    expect(plan.cost).toBe(4 * (BUILD_COST_PER_TILE.road + ROAD_ONEWAY_SURCHARGE));
  });

  it('transmet le sens et l’ordre du tracé au moteur', () => {
    const map = makeMap();
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 2, y: 4 },
      to: { x: 6, y: 4 },
      roadDirection: 'west',
    });
    expect(commandFromPlan(plan, 0)).toEqual({
      type: 'build',
      tool: 'road',
      company: 0,
      from: { x: 2, y: 4 },
      to: { x: 6, y: 4 },
      options: { axis: 'x', order: 'horizontal', one_way: 'west' },
    });
  });

  it('oriente une tuile isolée sur l’axe du sens unique', () => {
    const map = makeMap();
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 3, y: 3 },
      roadDirection: 'north',
    });
    expect(plan.valid).toBe(true);
    expect(plan.axis).toBe('y');
    expect(plan.tiles[0]?.connections).toBe(CONNECT_NORTH | CONNECT_SOUTH);
    expect(plan.tiles[0]?.cost).toBe(BUILD_COST_PER_TILE.road + ROAD_ONEWAY_SURCHARGE);
  });

  it('refuse un tracé en L ou un axe incompatible', () => {
    const map = makeMap();
    const lShape = planBuild({
      map,
      tool: 'road',
      from: { x: 2, y: 2 },
      to: { x: 5, y: 5 },
      roadDirection: 'east',
    });
    expect(lShape.valid).toBe(false);
    expect(lShape.reason).toContain('segment droit');

    const wrongAxis = planBuild({
      map,
      tool: 'road',
      from: { x: 2, y: 2 },
      to: { x: 5, y: 2 },
      roadDirection: 'north',
    });
    expect(wrongAxis.valid).toBe(false);
    expect(wrongAxis.reason).toContain('verticale');
  });

  it('convertit un tronçon droit existant pour un coût réduit', () => {
    const map = makeMap();
    fillRoad(map, 2, 6, 4);
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 3, y: 4 },
      to: { x: 5, y: 4 },
      roadDirection: 'west',
      company: 0,
    });
    expect(plan.valid).toBe(true);
    expect(plan.road?.convert).toBe(true);
    expect(plan.cost).toBe(3 * ROAD_ONEWAY_SURCHARGE);
    expect(commandFromPlan(plan, 0).options).toMatchObject({ one_way: 'west', convert: true });
  });

  it('refuse une conversion sur un virage ou un mélange route/terrain', () => {
    const map = makeMap();
    fillRoad(map, 2, 6, 4);
    fillRoad(map, 3, 3, 5);
    const corner = planBuild({
      map,
      tool: 'road',
      from: { x: 3, y: 4 },
      to: { x: 4, y: 4 },
      roadDirection: 'east',
    });
    expect(corner.valid).toBe(false);
    expect(corner.reason).toContain('virage');

    const mixed = planBuild({
      map,
      tool: 'road',
      from: { x: 6, y: 4 },
      to: { x: 7, y: 4 },
      roadDirection: 'east',
    });
    expect(mixed.valid).toBe(false);
    expect(mixed.reason).toContain('d’un seul tenant');
  });

  it('remet un tronçon à sens unique en double sens gratuitement', () => {
    const map = makeMap();
    fillRoad(map, 2, 6, 4);
    map.roadData = new Uint8Array(map.width * map.height);
    for (let x = 2; x <= 6; x += 1) {
      map.roadData[4 * map.width + x] = ROAD_ONEWAY_INDEX.east;
    }
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 3, y: 4 },
      to: { x: 5, y: 4 },
      company: 0,
    });
    expect(plan.valid).toBe(true);
    expect(plan.road).toEqual({ direction: 'both', oneWay: null, convert: true });
    expect(plan.cost).toBe(0);
    expect(commandFromPlan(plan, 0).options).toMatchObject({ one_way: 'both', convert: true });
  });

  it('refuse de « reconstruire » une route à double sens existante', () => {
    const map = makeMap();
    fillRoad(map, 2, 6, 4);
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 3, y: 4 },
      to: { x: 5, y: 4 },
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('déjà construite');
  });

  it('cycle les sens avec R, sans revenir au double sens', () => {
    expect(nextRoadDirection('both')).toBe('east');
    expect(nextRoadDirection('east')).toBe('south');
    expect(nextRoadDirection('south')).toBe('west');
    expect(nextRoadDirection('west')).toBe('north');
    expect(nextRoadDirection('north')).toBe('east');
  });
});
