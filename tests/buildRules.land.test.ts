import { describe, expect, it } from 'vitest';
import {
  AQUEDUCT_COST_PER_TILE,
  CANAL_COST_PER_TILE,
  CANAL_EXCAVATION_COST,
  CROSSING_COST,
  LOCK_COST,
  TERRAFORM_COST_PER_TILE,
  TREE_COST,
  commandFromPlan,
  planAqueduct,
  planCanal,
  planCrossing,
  planLock,
  planTerraform,
  planTree,
  type BuildPoint,
} from '../src/game/buildRules';
import {
  COMPANY_NONE,
  TILE_FLAG,
  TILE_KIND_INDEX,
  TRACK_BIT_CROSSING_RAIL,
  type MapSnapshot,
} from '../src/engine/protocol';

function makeMap(width = 20, height = 20, level = 4): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(level),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
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
  owner = COMPANY_NONE,
  level?: number,
): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  map.trackBits[index] = bits;
  map.owner[index] = owner;
  if (level !== undefined) map.heightMap[index] = level;
}

function point(x: number, y: number): BuildPoint {
  return { x, y };
}

describe('buildRules : terrassement (#158)', () => {
  it('planifie un carré, facture chaque tuile et émet le sens', () => {
    const plan = planTerraform({
      map: makeMap(),
      from: point(2, 2),
      settings: { direction: 'up', size: 2 },
    });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(4);
    expect(plan.cost).toBe(4 * TERRAFORM_COST_PER_TILE);
    expect(plan.terraform).toEqual({ direction: 'up', size: 2 });
    expect(commandFromPlan(plan, 0)).toMatchObject({
      tool: 'terraform',
      from: { x: 2, y: 2 },
      to: { x: 3, y: 3 },
      options: { direction: 'up', size: 2 },
    });
  });

  it('accepte un drag rectangle et descend le terrain', () => {
    const plan = planTerraform({
      map: makeMap(),
      from: point(1, 1),
      to: point(3, 2),
      settings: { direction: 'down', size: 1 },
    });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(6);
    expect(plan.terraform?.direction).toBe('down');
  });

  it('refuse l’eau, les voies, les bords de hauteur et un budget insuffisant', () => {
    const water = makeMap();
    setTile(water, 2, 2, TILE_KIND_INDEX.water);
    expect(
      planTerraform({ map: water, from: point(2, 2), settings: { direction: 'up', size: 1 } })
        .reason,
    ).toContain('eau');

    const rail = makeMap();
    setTile(rail, 2, 2, TILE_KIND_INDEX.rail, 2 | 8);
    expect(
      planTerraform({ map: rail, from: point(2, 2), settings: { direction: 'up', size: 1 } })
        .reason,
    ).toContain('voie');

    const high = makeMap(20, 20, 15);
    expect(
      planTerraform({ map: high, from: point(2, 2), settings: { direction: 'up', size: 1 } })
        .reason,
    ).toContain('Sommet');

    const low = makeMap(20, 20, 0);
    expect(
      planTerraform({ map: low, from: point(2, 2), settings: { direction: 'down', size: 1 } })
        .reason,
    ).toContain('minimal');

    const budget = planTerraform({
      map: makeMap(),
      from: point(2, 2),
      settings: { direction: 'up', size: 2 },
      budget: 10,
    });
    expect(budget.valid).toBe(false);
    expect(budget.reason).toContain('Trésorerie insuffisante');
  });
});

describe('buildRules : arbres (#158)', () => {
  it('plante un rectangle, facture et accepte de densifier une forêt', () => {
    const map = makeMap();
    const plan = planTree({ map, from: point(3, 3), to: point(4, 4), settings: { size: 1 } });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(4);
    expect(plan.cost).toBe(4 * TREE_COST);

    setTile(map, 5, 3, TILE_KIND_INDEX.trees);
    const densify = planTree({
      map,
      from: point(5, 3),
      settings: { size: 1 },
    });
    expect(densify.valid).toBe(true);
    expect(densify.cost).toBe(TREE_COST * 2);
    expect(commandFromPlan(plan, 2).options).toEqual({ size: 2 });
  });

  it('refuse une voie et un budget insuffisant', () => {
    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.road, 2 | 8);
    expect(planTree({ map, from: point(2, 2), settings: { size: 1 } }).reason).toContain('voie');
    expect(
      planTree({ map: makeMap(), from: point(2, 2), settings: { size: 1 }, budget: 10 }).reason,
    ).toContain('Trésorerie insuffisante');
  });
});

describe('buildRules : canaux (#158)', () => {
  it('creuse un bief au niveau des berges et facture l’excavation', () => {
    const plan = planCanal({ map: makeMap(20, 20, 4), from: point(2, 2), to: point(4, 2) });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(3);
    expect(plan.waterLevel).toBe(2);
    expect(plan.cost).toBe(3 * (CANAL_COST_PER_TILE + 2 * CANAL_EXCAVATION_COST));
    expect(commandFromPlan(plan, 0).options).toEqual({ axis: 'x', order: 'horizontal' });
  });

  it('s’aligne sur un lac existant sans le recreuser', () => {
    const map = makeMap(20, 20, 4);
    setTile(map, 2, 2, TILE_KIND_INDEX.water, 0, COMPANY_NONE, 0);
    const plan = planCanal({ map, from: point(2, 2), to: point(4, 2) });
    expect(plan.valid).toBe(true);
    expect(plan.waterLevel).toBe(0);
    expect(plan.tiles[0]?.cost).toBe(CANAL_COST_PER_TILE);
  });

  it('refuse une voie traversée à niveau et une zone hors carte', () => {
    const map = makeMap();
    setTile(map, 3, 2, TILE_KIND_INDEX.rail, 2 | 8);
    expect(planCanal({ map, from: point(2, 2), to: point(4, 2) }).reason).toContain('aqueduc');
    expect(planCanal({ map, from: point(25, 2), to: point(25, 4) }).reason).toContain(
      'hors de la carte',
    );
  });
});

describe('buildRules : écluses (#158)', () => {
  it('exige un bief voisin et résout l’orientation', () => {
    const map = makeMap();
    setTile(map, 3, 2, TILE_KIND_INDEX.canal, 2 | 8);
    setTile(map, 2, 2, TILE_KIND_INDEX.canal, 2 | 8);
    const plan = planLock({ map, from: point(3, 2), settings: { direction: null } });
    expect(plan.valid).toBe(true);
    expect(plan.lock).toEqual({ direction: 'sw', upper: 4, lower: 4 });
    expect(plan.cost).toBe(LOCK_COST);
    expect(commandFromPlan(plan, 0).options).toEqual({ direction: 'sw' });
  });

  it('refuse une tuile sans bief voisin et un budget insuffisant', () => {
    const isolated = makeMap();
    setTile(isolated, 3, 2, TILE_KIND_INDEX.canal, 2 | 8);
    expect(
      planLock({ map: isolated, from: point(3, 2), settings: { direction: null } }).reason,
    ).toContain('bief voisin');

    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.canal, 2 | 8);
    setTile(map, 3, 2, TILE_KIND_INDEX.canal, 2 | 8);
    expect(
      planLock({ map, from: point(3, 2), settings: { direction: null }, budget: 5 }).reason,
    ).toContain('Trésorerie insuffisante');
  });
});

describe('buildRules : aqueducs (#158)', () => {
  it('accepte un tablier rectiligne au-dessus d’une voie et facture la portée', () => {
    const map = makeMap();
    setTile(map, 4, 3, TILE_KIND_INDEX.rail, 2 | 8);
    const plan = planAqueduct({ map, from: point(2, 3), to: point(6, 3) });
    expect(plan.valid).toBe(true);
    expect(plan.aqueduct).toEqual({ axis: 'x', level: 4 });
    expect(plan.tiles).toHaveLength(5);
    expect(plan.cost).toBe(5 * AQUEDUCT_COST_PER_TILE);
    expect(commandFromPlan(plan, 0).options).toEqual({ axis: 'x' });
  });

  it('refuse une diagonale, une tuile unique et un bâtiment sous le tablier', () => {
    expect(planAqueduct({ map: makeMap(), from: point(2, 2), to: point(4, 4) }).reason).toContain(
      'X ou Y',
    );
    expect(planAqueduct({ map: makeMap(), from: point(2, 2), to: point(2, 2) }).reason).toContain(
      'distinctes',
    );

    const map = makeMap();
    setTile(map, 3, 3, TILE_KIND_INDEX.house);
    expect(planAqueduct({ map, from: point(2, 3), to: point(4, 3) }).reason).toContain('bloque');
  });
});

describe('buildRules : passages à niveau (#159)', () => {
  it('pose un passage sur une voie ferrée droite et mémorise le réseau', () => {
    const map = makeMap();
    setTile(map, 4, 4, TILE_KIND_INDEX.rail, 2 | 8, 0);
    const plan = planCrossing({ map, from: point(4, 4), company: 0 });
    expect(plan.valid).toBe(true);
    expect(plan.crossing).toEqual({ network: 'rail', axis: 'x' });
    expect(plan.cost).toBe(CROSSING_COST);
    expect(commandFromPlan(plan, 0).options).toEqual({ axis: 'x', network: 'rail' });
  });

  it('accepte une route droite et refuse une courbe ou une autre entreprise', () => {
    const map = makeMap();
    setTile(map, 4, 4, TILE_KIND_INDEX.road, 1 | 4, 0);
    expect(planCrossing({ map, from: point(4, 4), company: 0 }).crossing).toEqual({
      network: 'road',
      axis: 'y',
    });

    const curve = makeMap();
    setTile(curve, 4, 4, TILE_KIND_INDEX.rail, 1 | 2, 0);
    expect(planCrossing({ map: curve, from: point(4, 4) }).reason).toContain('droite');

    const foreign = makeMap();
    setTile(foreign, 4, 4, TILE_KIND_INDEX.rail, 2 | 8, 1);
    expect(planCrossing({ map: foreign, from: point(4, 4), company: 0 }).reason).toContain(
      'autre entreprise',
    );
  });

  it('réserve un bit de réseau distinct des connexions basses', () => {
    expect(TRACK_BIT_CROSSING_RAIL).toBe(16);
    expect(TRACK_BIT_CROSSING_RAIL & 0x0f).toBe(0);
    expect(TILE_FLAG.SIGNAL).toBe(64);
  });
});
