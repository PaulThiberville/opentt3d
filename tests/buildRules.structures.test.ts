import { describe, expect, it } from 'vitest';
import { COMPANY_NONE, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import {
  BRIDGE_MATERIALS,
  TUNNEL_COST_PER_TILE,
  commandFromPlan,
  createBuildSettings,
  planBridge,
  planLinkedRoute,
  planTunnel,
  type BridgeMaterial,
} from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';

function makeMap(
  width = 24,
  height = 12,
  fillKind = TILE_KIND_INDEX.grass,
  fillHeight = 4,
): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(fillKind),
    heightMap: new Uint8Array(size).fill(fillHeight),
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
  height = map.heightMap[tileIndex(x, y, map.width)] ?? 4,
): void {
  const index = tileIndex(x, y, map.width);
  map.kind[index] = kind;
  map.heightMap[index] = height;
}

describe('planBridge', () => {
  it('accepte un tablier au-dessus de l’eau et calcule coût et entretien', () => {
    const map = makeMap();
    setTile(map, 4, 5, TILE_KIND_INDEX.water, 0);
    setTile(map, 5, 5, TILE_KIND_INDEX.water, 0);
    const plan = planBridge({
      map,
      from: { x: 2, y: 5 },
      to: { x: 7, y: 5 },
      settings: { kind: 'rail', material: 'wood' },
      company: 0,
      budget: 1_000_000,
    });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(6);
    expect(plan.bridge).toMatchObject({ kind: 'rail', material: 'wood', span: 5, length: 6 });
    expect(plan.bridge?.deckHeight).toBe(6);
    expect(plan.cost).toBe(2 * 460 + 4 * BRIDGE_MATERIALS.wood.railCost);
    expect(plan.bridge?.maintenance).toBe(Math.round(6 * BRIDGE_MATERIALS.wood.railMaintenance));
    expect(plan.tiles.every((tile) => tile.elevation !== undefined)).toBe(true);
  });

  it('refuse un tablier sur du terrain plat sans obstacle réel', () => {
    const plan = planBridge({
      map: makeMap(),
      from: { x: 2, y: 4 },
      to: { x: 7, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(plan.valid).toBe(false);
    expect(plan.reason).toContain('obstacle réel');
  });

  it('accepte une vallée et un croisement de voie, refuse un tablier qui déborde', () => {
    const valley = makeMap();
    for (let x = 4; x <= 6; x += 1) setTile(valley, x, 4, TILE_KIND_INDEX.grass, 2);
    const overValley = planBridge({
      map: valley,
      from: { x: 3, y: 4 },
      to: { x: 7, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(overValley.valid).toBe(true);

    const crossing = makeMap();
    setTile(crossing, 5, 4, TILE_KIND_INDEX.road);
    const overRoad = planBridge({
      map: crossing,
      from: { x: 3, y: 4 },
      to: { x: 7, y: 4 },
      settings: { kind: 'rail', material: 'steel' },
      budget: 1_000_000,
    });
    expect(overRoad.valid).toBe(true);

    const overhang = makeMap();
    setTile(overhang, 7, 4, TILE_KIND_INDEX.water, 0);
    setTile(overhang, 8, 4, TILE_KIND_INDEX.water, 0);
    const tooMuchLand = planBridge({
      map: overhang,
      from: { x: 2, y: 4 },
      to: { x: 12, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(tooMuchLand.valid).toBe(false);
    expect(tooMuchLand.reason).toContain('Portée incohérente');
  });

  it('refuse une rampe en falaise ou posée sur l’eau', () => {
    const cliff = makeMap();
    setTile(cliff, 5, 4, TILE_KIND_INDEX.water, 0);
    setTile(cliff, 6, 4, TILE_KIND_INDEX.water, 0);
    setTile(cliff, 1, 4, TILE_KIND_INDEX.grass, 6);
    setTile(cliff, 2, 4, TILE_KIND_INDEX.grass, 6);
    const cliffPlan = planBridge({
      map: cliff,
      from: { x: 3, y: 4 },
      to: { x: 8, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(cliffPlan.valid).toBe(false);
    expect(cliffPlan.reason).toContain('rampe');

    const flooded = makeMap();
    setTile(flooded, 5, 4, TILE_KIND_INDEX.water, 0);
    setTile(flooded, 6, 4, TILE_KIND_INDEX.water, 0);
    setTile(flooded, 2, 4, TILE_KIND_INDEX.water, 0);
    const floodedPlan = planBridge({
      map: flooded,
      from: { x: 3, y: 4 },
      to: { x: 8, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(floodedPlan.valid).toBe(false);
    expect(floodedPlan.reason).toContain('rampe');
  });

  it('refuse une diagonale, des culées à des hauteurs différentes et une portée trop longue', () => {
    const map = makeMap();
    const diagonal = planBridge({
      map,
      from: { x: 2, y: 2 },
      to: { x: 5, y: 5 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(diagonal.valid).toBe(false);
    expect(diagonal.reason).toContain('droit');

    setTile(map, 8, 3, TILE_KIND_INDEX.grass, 5);
    const slope = planBridge({
      map,
      from: { x: 2, y: 3 },
      to: { x: 8, y: 3 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(slope.valid).toBe(false);
    expect(slope.reason).toContain('même hauteur');

    const flat = makeMap();
    const tooLong = planBridge({
      map: flat,
      from: { x: 1, y: 4 },
      to: { x: 9, y: 4 },
      settings: { kind: 'road', material: 'steel' },
      budget: 1_000_000,
    });
    expect(tooLong.valid).toBe(false);
    expect(tooLong.reason).toContain('portée');
  });

  it('refuse une culée sur l’eau et un tablier sous le relief', () => {
    const map = makeMap();
    setTile(map, 2, 4, TILE_KIND_INDEX.water, 0);
    const abutment = planBridge({
      map,
      from: { x: 2, y: 4 },
      to: { x: 7, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(abutment.valid).toBe(false);
    expect(abutment.reason).toContain('culée');

    const raised = makeMap();
    setTile(raised, 5, 4, TILE_KIND_INDEX.grass, 6);
    const terrain = planBridge({
      map: raised,
      from: { x: 2, y: 4 },
      to: { x: 8, y: 4 },
      settings: { kind: 'road', material: 'wood' },
      budget: 1_000_000,
    });
    expect(terrain.valid).toBe(false);
    expect(terrain.reason).toContain('Terrain trop haut');
  });

  it('applique les limites propres au matériau et le budget', () => {
    const map = makeMap(60, 12);
    const suspensionShort = planBridge({
      map,
      from: { x: 1, y: 4 },
      to: { x: 3, y: 4 },
      settings: { kind: 'rail', material: 'suspension' },
      budget: 1_000_000,
    });
    expect(suspensionShort.valid).toBe(false);
    expect(suspensionShort.reason).toContain('au moins 3');

    const steelLong = planBridge({
      map,
      from: { x: 1, y: 4 },
      to: { x: 10, y: 4 },
      settings: { kind: 'rail', material: 'steel' },
      budget: 1_000_000,
    });
    expect(steelLong.valid).toBe(false);
    expect(steelLong.reason).toContain('ne dépasse pas 5');

    const expensiveMap = makeMap();
    setTile(expensiveMap, 5, 4, TILE_KIND_INDEX.water, 0);
    setTile(expensiveMap, 6, 4, TILE_KIND_INDEX.water, 0);
    const expensive = planBridge({
      map: expensiveMap,
      from: { x: 3, y: 4 },
      to: { x: 8, y: 4 },
      settings: { kind: 'rail', material: 'wood' },
      budget: 100,
    });
    expect(expensive.valid).toBe(false);
    expect(expensive.reason).toContain('Trésorerie insuffisante');
  });

  it('transmet le matériau et la direction dans la commande moteur', () => {
    const map = makeMap();
    const plan = planBridge({
      map,
      from: { x: 2, y: 4 },
      to: { x: 8, y: 4 },
      settings: { kind: 'road', material: 'steel' },
    });
    const command = commandFromPlan(plan, 3);
    expect(command.tool).toBe('bridge');
    expect(command.options).toMatchObject({
      kind: 'road',
      material: 'steel',
      length: 7,
      direction: 'x',
    });
  });
});

describe('planLinkedRoute', () => {
  it('ne pose un pont que si le trajet rencontre un cours d’eau étroit', () => {
    const dry = planLinkedRoute({
      map: makeMap(24, 12),
      from: { x: 2, y: 5 },
      to: { x: 12, y: 5 },
      kind: 'road',
      company: 0,
      budget: 1_000_000,
    });
    expect(dry?.pieces).toHaveLength(1);
    expect(dry?.pieces[0]?.tool).toBe('road');

    const map = makeMap(24, 12);
    for (const x of [7, 8]) setTile(map, x, 5, TILE_KIND_INDEX.water, 0);
    const crossed = planLinkedRoute({
      map,
      from: { x: 2, y: 5 },
      to: { x: 12, y: 5 },
      kind: 'road',
      company: 0,
      budget: 1_000_000,
    });
    expect(crossed?.pieces.map((piece) => piece.tool)).toEqual(['road', 'bridge', 'road']);
    expect(crossed?.pieces[1]).toMatchObject({
      tool: 'bridge',
      from: { x: 6, y: 5 },
      to: { x: 9, y: 5 },
      material: 'steel',
    });
    expect(crossed?.cost ?? 0).toBeGreaterThan(0);
  });

  it('refuse un lac trop large ou une berge en falaise', () => {
    const wide = makeMap(24, 12);
    for (let x = 3; x <= 10; x += 1) setTile(wide, x, 5, TILE_KIND_INDEX.water, 0);
    expect(
      planLinkedRoute({
        map: wide,
        from: { x: 2, y: 5 },
        to: { x: 12, y: 5 },
        kind: 'road',
        company: 0,
        budget: 1_000_000,
      }),
    ).toBeNull();

    const cliff = makeMap(24, 12);
    for (const x of [7, 8]) setTile(cliff, x, 5, TILE_KIND_INDEX.water, 0);
    setTile(cliff, 6, 5, TILE_KIND_INDEX.grass, 6);
    expect(
      planLinkedRoute({
        map: cliff,
        from: { x: 2, y: 5 },
        to: { x: 12, y: 5 },
        kind: 'road',
        company: 0,
        budget: 1_000_000,
      }),
    ).toBeNull();
  });
});

describe('planTunnel', () => {
  function moundMap(): MapSnapshot {
    const map = makeMap(24, 12);
    for (let x = 4; x <= 6; x += 1) setTile(map, x, 5, TILE_KIND_INDEX.grass, 7);
    return map;
  }

  it('accepte deux portails à la même hauteur séparés par du relief', () => {
    const plan = planTunnel({
      map: moundMap(),
      from: { x: 2, y: 5 },
      to: { x: 8, y: 5 },
      settings: { kind: 'rail' },
      company: 0,
      budget: 1_000_000,
    });
    expect(plan.valid).toBe(true);
    expect(plan.tiles).toHaveLength(7);
    expect(plan.tunnel).toMatchObject({ kind: 'rail', length: 7, depth: 3 });
    expect(plan.cost).toBe(7 * TUNNEL_COST_PER_TILE.rail + 3 * 120);
    expect(plan.tunnel?.maintenance).toBe(Math.round(7 * 34));
  });

  it('refuse un terrain plat, une diagonale et des portails décalés', () => {
    const flat = planTunnel({
      map: makeMap(),
      from: { x: 2, y: 5 },
      to: { x: 8, y: 5 },
      settings: { kind: 'road' },
      budget: 1_000_000,
    });
    expect(flat.valid).toBe(false);
    expect(flat.reason).toContain('relief');

    const diagonal = planTunnel({
      map: moundMap(),
      from: { x: 2, y: 2 },
      to: { x: 5, y: 5 },
      settings: { kind: 'road' },
      budget: 1_000_000,
    });
    expect(diagonal.valid).toBe(false);
    expect(diagonal.reason).toContain('droit');

    const map = moundMap();
    setTile(map, 8, 5, TILE_KIND_INDEX.grass, 5);
    const mismatched = planTunnel({
      map,
      from: { x: 2, y: 5 },
      to: { x: 8, y: 5 },
      settings: { kind: 'road' },
      budget: 1_000_000,
    });
    expect(mismatched.valid).toBe(false);
    expect(mismatched.reason).toContain('même hauteur');
  });

  it('refuse un portail sur l’eau et un tunnel trop court', () => {
    const map = moundMap();
    setTile(map, 2, 5, TILE_KIND_INDEX.water, 0);
    const water = planTunnel({
      map,
      from: { x: 2, y: 5 },
      to: { x: 8, y: 5 },
      settings: { kind: 'rail' },
      budget: 1_000_000,
    });
    expect(water.valid).toBe(false);
    expect(water.reason).toContain('portail');

    const short = planTunnel({
      map: moundMap(),
      from: { x: 2, y: 5 },
      to: { x: 3, y: 5 },
      settings: { kind: 'rail' },
      budget: 1_000_000,
    });
    expect(short.valid).toBe(false);
    expect(short.reason).toContain('au moins');
  });

  it('transmet la longueur et la direction dans la commande moteur', () => {
    const plan = planTunnel({
      map: moundMap(),
      from: { x: 2, y: 5 },
      to: { x: 8, y: 5 },
      settings: { kind: 'rail' },
    });
    const command = commandFromPlan(plan, 0);
    expect(command.tool).toBe('tunnel');
    expect(command.options).toMatchObject({ kind: 'rail', length: 7, direction: 'x' });
  });
});

describe('réglages de construction', () => {
  it('clone les options pont et tunnel sans partager les objets', () => {
    const settings = createBuildSettings();
    const clone = createBuildSettings();
    for (const material of Object.keys(BRIDGE_MATERIALS) as BridgeMaterial[]) {
      expect(BRIDGE_MATERIALS[material].maxSpan).toBeGreaterThan(0);
    }
    expect(settings.bridge).toEqual({ kind: 'rail', material: 'wood' });
    expect(clone.bridge).not.toBe(settings.bridge);
    expect(settings.tunnel).toEqual({ kind: 'rail' });
  });
});
