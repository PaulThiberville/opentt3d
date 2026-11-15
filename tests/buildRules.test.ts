import { describe, expect, it } from 'vitest';
import {
  BUILD_SLOPE_COST,
  CONNECT_EAST,
  CONNECT_NORTH,
  CONNECT_SOUTH,
  CONNECT_WEST,
  axisForDrag,
  commandFromPlan,
  planBuild,
  traceBuildPath,
} from '../src/game/buildRules';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';

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

function setTile(
  map: MapSnapshot,
  x: number,
  y: number,
  kind: number,
  height = map.heightMap[y * map.width + x] ?? 4,
): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  map.heightMap[index] = height;
}

describe('buildRules : tracé en L', () => {
  it('parcourt l’axe X puis l’axe Y', () => {
    const points = traceBuildPath({ x: 2, y: 3 }, { x: 5, y: 6 }, 'x');
    expect(points).toEqual([
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
      { x: 5, y: 4 },
      { x: 5, y: 5 },
      { x: 5, y: 6 },
    ]);
  });

  it('parcourt l’axe Y puis l’axe X', () => {
    const points = traceBuildPath({ x: 2, y: 3 }, { x: 5, y: 6 }, 'y');
    expect(points).toEqual([
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 2, y: 5 },
      { x: 2, y: 6 },
      { x: 3, y: 6 },
      { x: 4, y: 6 },
      { x: 5, y: 6 },
    ]);
  });

  it('réduit un drag sur la même tuile à une tuile', () => {
    expect(traceBuildPath({ x: 4, y: 4 }, { x: 4.2, y: 4.1 }, 'x')).toEqual([{ x: 4, y: 4 }]);
  });

  it('privilégie l’axe dominant du drag', () => {
    expect(axisForDrag({ x: 0, y: 0 }, { x: 8, y: 3 })).toBe('x');
    expect(axisForDrag({ x: 0, y: 0 }, { x: 2, y: 9 })).toBe('y');
    expect(axisForDrag({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe('x');
  });
});

describe('buildRules : plan de route', () => {
  it('calcule les connexions et le coût d’un virage', () => {
    const plan = planBuild({
      map: makeMap(),
      tool: 'road',
      from: { x: 2, y: 3 },
      to: { x: 5, y: 6 },
      axis: 'x',
    });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(7);
    expect(plan.cost).toBe(7 * 120);
    expect(plan.tiles[0]?.connections).toBe(CONNECT_EAST);
    expect(plan.tiles[3]?.connections).toBe(CONNECT_WEST | CONNECT_SOUTH);
    expect(plan.tiles[6]?.connections).toBe(CONNECT_NORTH);
  });

  it('produit une route droite est-ouest sur une tuile isolée', () => {
    const plan = planBuild({ map: makeMap(), tool: 'road', from: { x: 4, y: 4 } });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]?.connections).toBe(CONNECT_EAST | CONNECT_WEST);
    expect(plan.cost).toBe(120);
  });

  it('facture le terrassement d’une pente franchie', () => {
    const map = makeMap();
    setTile(map, 3, 3, TILE_KIND_INDEX.grass, 5);
    const plan = planBuild({
      map,
      tool: 'road',
      from: { x: 2, y: 3 },
      to: { x: 4, y: 3 },
    });
    expect(plan.valid).toBe(true);
    // Montée puis descente : le terrassement est facturé dans les deux sens.
    expect(plan.cost).toBe(3 * 120 + 2 * BUILD_SLOPE_COST);
  });

  it('refuse une pente trop raide', () => {
    const map = makeMap();
    setTile(map, 3, 3, TILE_KIND_INDEX.grass, 6);
    const plan = planBuild({
      map,
      tool: 'rail',
      from: { x: 2, y: 3 },
      to: { x: 4, y: 3 },
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('Pente trop raide');
    expect(plan.tiles).toHaveLength(3);
  });

  it('refuse l’eau, le bâti et une voie déjà construite', () => {
    const water = makeMap();
    setTile(water, 3, 3, TILE_KIND_INDEX.water, 0);
    expect(
      planBuild({ map: water, tool: 'road', from: { x: 2, y: 3 }, to: { x: 4, y: 3 } }).reason,
    ).toContain('eau');

    const house = makeMap();
    setTile(house, 3, 3, TILE_KIND_INDEX.house);
    expect(
      planBuild({ map: house, tool: 'road', from: { x: 2, y: 3 }, to: { x: 4, y: 3 } }).reason,
    ).toContain('bâtiment');

    const road = makeMap();
    setTile(road, 3, 3, TILE_KIND_INDEX.road);
    expect(
      planBuild({ map: road, tool: 'road', from: { x: 2, y: 3 }, to: { x: 4, y: 3 } }).reason,
    ).toContain('déjà construite');

    expect(
      planBuild({ map: road, tool: 'rail', from: { x: 2, y: 3 }, to: { x: 4, y: 3 } }).reason,
    ).toContain('Croisement');
  });

  it('refuse un tracé hors carte ou trop long', () => {
    const map = makeMap();
    expect(planBuild({ map, tool: 'road', from: { x: -1, y: 2 } }).reason).toContain(
      'hors de la carte',
    );
    const long = planBuild({
      map: makeMap(80, 80),
      tool: 'road',
      from: { x: 0, y: 0 },
      to: { x: 79, y: 79 },
    });
    expect(long.reason).toContain('trop long');
    expect(long.valid).toBe(false);
  });

  it('signale une trésorerie insuffisante', () => {
    const plan = planBuild({
      map: makeMap(),
      tool: 'rail',
      from: { x: 2, y: 3 },
      to: { x: 5, y: 3 },
      budget: 500,
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('Trésorerie insuffisante');
  });
});

describe('buildRules : démolition', () => {
  it('accepte une voie et facture la démolition', () => {
    const map = makeMap();
    setTile(map, 3, 3, TILE_KIND_INDEX.road);
    setTile(map, 4, 3, TILE_KIND_INDEX.road);
    const plan = planBuild({
      map,
      tool: 'clear',
      from: { x: 3, y: 3 },
      to: { x: 4, y: 3 },
      company: 0,
    });
    expect(plan.valid).toBe(true);
    expect(plan.cost).toBe(80);
    expect(plan.tiles.every((tile) => tile.connections === 0)).toBe(true);
  });

  it('refuse une tuile vide et la voie d’une autre entreprise', () => {
    const empty = makeMap();
    expect(planBuild({ map: empty, tool: 'clear', from: { x: 2, y: 2 } }).reason).toContain(
      'Aucune voie',
    );

    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.rail);
    map.owner[2 * map.width + 2] = 1;
    expect(planBuild({ map, tool: 'clear', from: { x: 2, y: 2 }, company: 0 }).reason).toContain(
      'autre entreprise',
    );
  });
});

describe('buildRules : commande moteur', () => {
  const plan = planBuild({
    map: makeMap(),
    tool: 'road',
    from: { x: 2, y: 3 },
    to: { x: 5, y: 6 },
    axis: 'y',
  });

  it('transmet from, to et l’axe du tracé', () => {
    expect(commandFromPlan(plan, 0)).toEqual({
      type: 'build',
      tool: 'road',
      company: 0,
      from: { x: 2, y: 3 },
      to: { x: 5, y: 6 },
      options: { axis: 'y' },
    });
  });

  it('omet `to` pour une tuile isolée', () => {
    const single = planBuild({ map: makeMap(), tool: 'rail', from: { x: 4, y: 4 } });
    expect(commandFromPlan(single, 1)).toEqual({
      type: 'build',
      tool: 'rail',
      company: 1,
      from: { x: 4, y: 4 },
      options: { axis: 'x' },
    });
  });
});
