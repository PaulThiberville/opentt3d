import { describe, expect, it } from 'vitest';
import {
  CONNECT_EAST,
  CONNECT_NORTH,
  CONNECT_SOUTH,
  CONNECT_WEST,
  DEPOT_COST,
  SIGNAL_COST,
  STATION_COST_PER_TILE,
  commandFromPlan,
  createBuildSettings,
  directionAxis,
  directionFromIndex,
  directionToIndex,
  nextDirection,
  planBuild,
  planDepot,
  planSignal,
  planStation,
  stationFootprint,
  type StationSettings,
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
  bits = 0,
  owner = 255,
): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  map.trackBits[index] = bits;
  map.owner[index] = owner;
}

function railStation(overrides: Partial<StationSettings> = {}): StationSettings {
  return {
    kind: 'rail',
    platforms: 2,
    length: 3,
    direction: 'ne',
    driveThrough: false,
    ...overrides,
  };
}

describe('buildRules : emprise des gares', () => {
  it('oriente les quais et la longueur selon la direction', () => {
    expect(stationFootprint(railStation({ direction: 'ne' }))).toEqual({ width: 3, height: 2 });
    expect(stationFootprint(railStation({ direction: 'sw' }))).toEqual({ width: 3, height: 2 });
    expect(stationFootprint(railStation({ direction: 'nw' }))).toEqual({ width: 2, height: 3 });
    expect(stationFootprint(railStation({ direction: 'se' }))).toEqual({ width: 2, height: 3 });
    expect(stationFootprint(railStation({ kind: 'road' }))).toEqual({ width: 1, height: 1 });
    expect(directionAxis('ne')).toBe('x');
    expect(directionAxis('se')).toBe('y');
  });

  it('pivote dans l’ordre ne → se → sw → nw', () => {
    expect(nextDirection('ne')).toBe('se');
    expect(nextDirection('se')).toBe('sw');
    expect(nextDirection('sw')).toBe('nw');
    expect(nextDirection('nw')).toBe('ne');
    expect(directionFromIndex(0)).toBe('ne');
    expect(directionToIndex('nw')).toBe(3);
    expect(directionFromIndex(5)).toBe('se');
  });
});

describe('buildRules : gare ferroviaire', () => {
  it('planifie un rectangle 3×2 et facture chaque tuile', () => {
    const plan = planStation({ map: makeMap(), from: { x: 2, y: 2 }, settings: railStation() });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(6);
    expect(plan.cost).toBe(6 * STATION_COST_PER_TILE.rail);
    expect(plan.tiles.map((tile) => tile.x)).toEqual([2, 3, 4, 2, 3, 4]);
    expect(plan.tiles.map((tile) => tile.y)).toEqual([2, 2, 2, 3, 3, 3]);
    expect(plan.station?.direction).toBe('ne');
    // Les rails courent le long de X, une connexion par extrémité.
    expect(plan.tiles[0]?.connections).toBe(CONNECT_EAST);
    expect(plan.tiles[1]?.connections).toBe(CONNECT_EAST | CONNECT_WEST);
    expect(plan.tiles[2]?.connections).toBe(CONNECT_WEST);
  });

  it('tourne le rectangle quand la direction suit Y', () => {
    const plan = planStation({
      map: makeMap(),
      from: { x: 2, y: 2 },
      settings: railStation({ direction: 'nw' }),
    });
    expect(plan.tiles).toHaveLength(6);
    expect(plan.tiles.map((tile) => tile.x)).toEqual([2, 3, 2, 3, 2, 3]);
    expect(plan.tiles[0]?.connections).toBe(CONNECT_SOUTH);
    expect(plan.tiles[2]?.connections).toBe(CONNECT_SOUTH | CONNECT_NORTH);
    expect(plan.tiles[4]?.connections).toBe(CONNECT_NORTH);
  });

  it('accepte de surbâtir une voie alignée et refuse une voie perpendiculaire', () => {
    const aligned = makeMap();
    setTile(aligned, 2, 2, TILE_KIND_INDEX.rail, CONNECT_EAST | CONNECT_WEST, 0);
    expect(
      planStation({ map: aligned, from: { x: 2, y: 2 }, settings: railStation({ platforms: 1 }) })
        .valid,
    ).toBe(true);

    const crossed = makeMap();
    setTile(crossed, 2, 2, TILE_KIND_INDEX.rail, CONNECT_NORTH | CONNECT_SOUTH, 0);
    const plan = planStation({
      map: crossed,
      from: { x: 2, y: 2 },
      settings: railStation({ platforms: 1 }),
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('mal orientée');
  });

  it('refuse l’eau, une emprise hors carte et un budget insuffisant', () => {
    const water = makeMap();
    setTile(water, 3, 3, TILE_KIND_INDEX.water);
    expect(
      planStation({ map: water, from: { x: 2, y: 2 }, settings: railStation() }).reason,
    ).toContain('eau');

    expect(
      planStation({ map: makeMap(), from: { x: 15, y: 15 }, settings: railStation() }).reason,
    ).toContain('hors de la carte');

    const budget = planStation({
      map: makeMap(),
      from: { x: 2, y: 2 },
      settings: railStation(),
      budget: 1000,
    });
    expect(budget.valid).toBe(false);
    expect(budget.reason).toContain('Trésorerie insuffisante');
  });
});

describe('buildRules : gare routière', () => {
  it('occupe une seule tuile et émet l’option de passage', () => {
    const plan = planStation({
      map: makeMap(),
      from: { x: 4, y: 4 },
      settings: railStation({ kind: 'road', driveThrough: true }),
    });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.cost).toBe(STATION_COST_PER_TILE.road);
    expect(plan.tiles[0]?.x).toBe(4);

    const command = commandFromPlan(plan, 0);
    expect(command.tool).toBe('station');
    expect(command.options).toEqual({
      kind: 'road',
      platforms: 2,
      length: 3,
      direction: 'ne',
      axis: 'x',
      drive_through: true,
    });
  });

  it('refuse une route perpendiculaire en passage', () => {
    const map = makeMap();
    setTile(map, 4, 4, TILE_KIND_INDEX.road, CONNECT_NORTH | CONNECT_SOUTH, 0);
    const plan = planStation({
      map,
      from: { x: 4, y: 4 },
      settings: railStation({ kind: 'road', driveThrough: true, direction: 'ne' }),
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('mal orientée');
  });
});

describe('buildRules : dépôt', () => {
  it('détecte la voie voisine et oriente la traversée', () => {
    const map = makeMap();
    setTile(map, 6, 5, TILE_KIND_INDEX.rail, CONNECT_EAST | CONNECT_WEST, 0);
    const plan = planDepot({
      map,
      from: { x: 5, y: 5 },
      settings: { kind: 'rail', direction: null },
    });
    expect(plan.valid).toBe(true);
    expect(plan.depot).toEqual({ kind: 'rail', direction: 'ne' });
    expect(plan.tiles[0]?.connections).toBe(CONNECT_EAST | CONNECT_WEST);
    expect(plan.cost).toBe(DEPOT_COST.rail);
    expect(commandFromPlan(plan, 0).options).toEqual({ kind: 'rail', direction: 'ne' });
  });

  it('refuse une tuile déjà occupée par une voie', () => {
    const map = makeMap();
    setTile(map, 5, 5, TILE_KIND_INDEX.road, CONNECT_EAST | CONNECT_WEST, 0);
    const plan = planDepot({
      map,
      from: { x: 5, y: 5 },
      settings: { kind: 'road', direction: 'se' },
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('voisine');
  });
});

describe('buildRules : signal', () => {
  it('exige une voie ferrée appartenant à l’entreprise', () => {
    const grass = planSignal({
      map: makeMap(),
      from: { x: 2, y: 2 },
      settings: { type: 'block', track: null },
      company: 0,
    });
    expect(grass.valid).toBe(false);
    expect(grass.reason).toContain('voie ferrée');

    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.rail, CONNECT_EAST | CONNECT_WEST, 1);
    const other = planSignal({
      map,
      from: { x: 2, y: 2 },
      settings: { type: 'block', track: null },
      company: 0,
    });
    expect(other.valid).toBe(false);
    expect(other.reason).toContain('autre entreprise');
  });

  it('aligne plusieurs signaux sur X et refuse une diagonale', () => {
    const map = makeMap();
    for (let x = 2; x <= 4; x += 1) {
      setTile(map, x, 2, TILE_KIND_INDEX.rail, CONNECT_EAST | CONNECT_WEST, 0);
    }
    const line = planSignal({
      map,
      from: { x: 2, y: 2 },
      to: { x: 4, y: 2 },
      settings: { type: 'block', track: 'x' },
      company: 0,
    });
    expect(line.valid).toBe(true);
    expect(line.tiles).toHaveLength(3);
    expect(line.cost).toBe(3 * SIGNAL_COST);
    expect(commandFromPlan(line, 0)).toMatchObject({
      tool: 'signal',
      from: { x: 2, y: 2 },
      to: { x: 4, y: 2 },
      options: { type: 'block', track: 'x' },
    });

    const diagonal = planSignal({
      map,
      from: { x: 2, y: 2 },
      to: { x: 4, y: 4 },
      settings: { type: 'block', track: null },
      company: 0,
    });
    expect(diagonal.valid).toBe(false);
    expect(diagonal.reason).toContain('X ou Y');
  });
});

describe('buildRules : démolition d’une infrastructure', () => {
  it('accepte une tuile de gare ou de dépôt pour Ctrl+Z', () => {
    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.station, 0, 0);
    const station = planBuild({
      map,
      tool: 'clear',
      from: { x: 2, y: 2 },
      company: 0,
    });
    expect(station.valid).toBe(true);
    expect(station.cost).toBe(40);

    setTile(map, 3, 2, TILE_KIND_INDEX.road, 0, 0);
    expect(planBuild({ map, tool: 'clear', from: { x: 3, y: 2 }, company: 0 }).valid).toBe(true);
  });
});

describe('buildRules : options par défaut et commandes', () => {
  it('part d’une gare rail 1×3 et d’un dépôt sans orientation forcée', () => {
    const settings = createBuildSettings();
    expect(settings.station.kind).toBe('rail');
    expect(settings.station.length).toBe(3);
    expect(settings.depot.direction).toBeNull();
    expect(settings.signal.type).toBe('block');
  });

  it('émet la direction et l’axe de la gare ferroviaire', () => {
    const plan = planStation({
      map: makeMap(),
      from: { x: 2, y: 2 },
      settings: railStation({ direction: 'nw', platforms: 1, length: 2 }),
    });
    expect(commandFromPlan(plan, 1)).toEqual({
      type: 'build',
      tool: 'station',
      company: 1,
      from: { x: 2, y: 2 },
      options: {
        kind: 'rail',
        platforms: 1,
        length: 2,
        direction: 'nw',
        axis: 'y',
      },
    });
  });
});
