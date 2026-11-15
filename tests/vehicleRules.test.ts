import { describe, expect, it } from 'vitest';
import {
  COMPANY_NONE,
  PROTOCOL_VERSION,
  TILE_KIND_INDEX,
  type MapSnapshot,
  type WorldSnapshot,
} from '../src/engine/protocol';
import {
  DEPOT_ORDER_TARGET_BASE,
  MAX_VEHICLE_ORDERS,
  DEPOT_TRACK_BIT,
  buyVehicleCommand,
  depotKindAt,
  depotOrder,
  depotOrderTarget,
  depotTileFromTarget,
  isDepotTile,
  modelsForDepot,
  orderTargetLabel,
  orderVehicleCommand,
  ordersFromSnapshot,
  stationAtTile,
  validateVehicleOrders,
  vehicleActionCommand,
  vehicleModel,
} from '../src/game/vehicleRules';

function makeMap(width = 16, height = 16): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function markDepot(map: MapSnapshot, x: number, y: number, kind: 'road' | 'rail'): void {
  const index = y * map.width + x;
  map.kind[index] = kind === 'road' ? TILE_KIND_INDEX.road : TILE_KIND_INDEX.rail;
  map.trackBits[index] = (map.trackBits[index] ?? 0) | DEPOT_TRACK_BIT;
  map.owner[index] = 0;
}

function snapshot(): WorldSnapshot {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 0, hash: '0', sequence: 0 },
    economy: { year: 1950, month: 0, day: 1, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies: [],
    towns: [],
    industries: [
      {
        id: 4,
        name: 'Usine',
        kind: 'factory',
        x: 8,
        y: 8,
        production: 100,
        transported: 10,
        stocks: [],
      },
    ],
    stations: [
      {
        id: 3,
        company: 0,
        name: 'Arrêt de Valmont',
        kind: 'road',
        x: 5,
        y: 5,
        width: 2,
        height: 2,
        waiting: [],
      },
    ],
    vehicles: [],
    news: [],
    events: [],
  };
}

describe('vehicleRules : catalogue', () => {
  it('propose bus et camions pour la route, trains pour le rail', () => {
    const road = modelsForDepot('road');
    const rail = modelsForDepot('rail');
    expect(road.length).toBeGreaterThan(0);
    expect(rail.length).toBeGreaterThan(0);
    expect(road.every((model) => model.depot === 'road' && model.kind === 'road')).toBe(true);
    expect(rail.every((model) => model.depot === 'rail' && model.kind === 'train')).toBe(true);
    expect(road.some((model) => model.cargo === 'passengers')).toBe(true);
    expect(road.some((model) => model.cargo === 'goods')).toBe(true);
  });

  it('retrouve un modèle par identifiant et ignore l’inconnu', () => {
    expect(vehicleModel('bus_city')?.name).toBe('Bus urbain');
    expect(vehicleModel('nope')).toBeNull();
    expect(vehicleModel(null)).toBeNull();
  });
});

describe('vehicleRules : tuiles dépôt', () => {
  it('reconnaît un dépôt routier et ferroviaire par son drapeau', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    markDepot(map, 3, 2, 'rail');
    map.kind[4 * map.width + 2] = TILE_KIND_INDEX.road;

    expect(depotKindAt(map, 2, 2)).toBe('road');
    expect(depotKindAt(map, 3, 2)).toBe('rail');
    expect(isDepotTile(map, 2, 2)).toBe(true);
    // Une route simple n'est pas un dépôt.
    expect(depotKindAt(map, 2, 4)).toBeNull();
    expect(depotKindAt(map, -1, 2)).toBeNull();
  });

  it('encode et décode une cible d’ordre de dépôt', () => {
    const map = makeMap();
    const target = depotOrderTarget(6, 7, map.width);
    expect(target).toBeGreaterThanOrEqual(DEPOT_ORDER_TARGET_BASE);
    expect(depotTileFromTarget(target, map)).toEqual({ x: 6, y: 7 });
    expect(depotTileFromTarget(3, map)).toBeNull();
    expect(depotTileFromTarget(DEPOT_ORDER_TARGET_BASE, map)).toEqual({ x: 0, y: 0 });
    expect(depotOrder(6, 7, map.width)).toEqual({ target, kind: 'depot' });
  });

  it('retrouve la gare dont l’emprise contient une tuile', () => {
    const snap = snapshot();
    expect(stationAtTile(snap, 4, 4)?.id).toBe(3);
    expect(stationAtTile(snap, 5, 5)?.id).toBe(3);
    expect(stationAtTile(snap, 9, 9)).toBeNull();
    expect(stationAtTile(null, 4, 4)).toBeNull();
  });
});

describe('vehicleRules : ordres et commandes', () => {
  it('valide gares, industries et dépôts existants', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const snap = snapshot();
    expect(
      validateVehicleOrders(
        [
          { target: 3, kind: 'station' },
          { target: 4, kind: 'industry' },
          depotOrder(2, 2, map.width),
        ],
        snap,
        map,
      ).ok,
    ).toBe(true);
    expect(validateVehicleOrders([], snap, map)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('au moins'),
    });
    expect(validateVehicleOrders([{ target: 99, kind: 'station' }], snap, map).ok).toBe(false);
    expect(validateVehicleOrders([{ target: 99, kind: 'industry' }], snap, map).ok).toBe(false);
    expect(validateVehicleOrders([depotOrder(9, 9, map.width)], snap, map).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_VEHICLE_ORDERS + 1 }, () => ({
      target: 3,
      kind: 'station' as const,
    }));
    expect(validateVehicleOrders(tooMany, snap, map).ok).toBe(false);
  });

  it('déduit le type des cibles depuis le snapshot', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const orders = ordersFromSnapshot(
      { orderTargets: [3, 4, depotOrder(2, 2, map.width).target] },
      snapshot(),
      map,
    );
    expect(orders).toEqual([
      { target: 3, kind: 'station' },
      { target: 4, kind: 'industry' },
      { target: depotOrder(2, 2, map.width).target, kind: 'depot' },
    ]);
    expect(orderTargetLabel(orders[0]!, snapshot(), map)).toBe('Arrêt de Valmont');
    expect(orderTargetLabel(orders[2]!, snapshot(), map)).toBe('Dépôt (2, 2)');
  });

  it('compose les commandes buy/order/start/stop/sell', () => {
    expect(buyVehicleCommand(0, { x: 3, y: 4 }, 'bus_city')).toEqual({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depot: { x: 3, y: 4 },
      model: 'bus_city',
    });
    expect(vehicleActionCommand(1, 'start', 12)).toEqual({
      type: 'vehicle',
      action: 'start',
      company: 1,
      vehicle: 12,
    });
    expect(orderVehicleCommand(1, 12, [{ target: 3, kind: 'station' }])).toEqual({
      type: 'vehicle',
      action: 'order',
      company: 1,
      vehicle: 12,
      orders: [{ target: 3, kind: 'station' }],
    });
  });
});
