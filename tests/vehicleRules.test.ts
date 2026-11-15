import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type DepotSnapshot, type WorldSnapshot } from '../src/engine/protocol';
import {
  MAX_VEHICLE_ORDERS,
  buyVehicleCommand,
  cloneOrderOptions,
  cloneVehicleCommand,
  depotAtTile,
  depotById,
  depotKindLabel,
  depotOrder,
  inferVehicleModel,
  modelsForDepot,
  orderTargetLabel,
  orderVehicleCommand,
  ordersFromSnapshot,
  refitCost,
  refitOption,
  refitOptions,
  refitVehicleCommand,
  stationAtTile,
  validateVehicleOrders,
  vehicleActionCommand,
  vehicleModel,
} from '../src/game/vehicleRules';

function depot(overrides: Partial<DepotSnapshot> = {}): DepotSnapshot {
  return {
    id: 12,
    company: 0,
    kind: 'road',
    x: 2,
    y: 2,
    direction: 0,
    width: 1,
    height: 1,
    ...overrides,
  };
}

function snapshot(depots: DepotSnapshot[] = [depot()]): WorldSnapshot {
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
    depots,
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

describe('vehicleRules : dépôts du snapshot', () => {
  it('retrouve un dépôt par id stable et par tuile', () => {
    const snap = snapshot([
      depot({ id: 12, kind: 'road', x: 2, y: 2 }),
      depot({ id: 4, kind: 'rail', x: 7, y: 9 }),
    ]);
    expect(depotById(snap, 12)).toMatchObject({ kind: 'road', x: 2, y: 2 });
    expect(depotById(snap, 4)).toMatchObject({ kind: 'rail', x: 7, y: 9 });
    expect(depotById(snap, 99)).toBeNull();
    expect(depotAtTile(snap, 2, 2)?.id).toBe(12);
    expect(depotAtTile(snap, 7, 9)?.id).toBe(4);
    // Une tuile route/rail ordinaire n'est pas un dépôt.
    expect(depotAtTile(snap, 3, 2)).toBeNull();
    expect(depotAtTile(null, 2, 2)).toBeNull();
  });

  it('respecte l’emprise exposée par le snapshot', () => {
    const snap = snapshot([depot({ id: 1, x: 4, y: 3, width: 2, height: 2 })]);
    expect(depotAtTile(snap, 4, 3)?.id).toBe(1);
    expect(depotAtTile(snap, 5, 4)?.id).toBe(1);
    expect(depotAtTile(snap, 6, 4)).toBeNull();
  });

  it('construit une cible d’ordre depuis l’id du dépôt', () => {
    const target = depot({ id: 42, x: 6, y: 7 });
    expect(depotOrder(target)).toEqual({ target: 42, kind: 'depot' });
    expect(depotKindLabel(target.kind)).toBe('Dépôt routier');
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
    const snap = snapshot();
    expect(
      validateVehicleOrders(
        [{ target: 3, kind: 'station' }, { target: 4, kind: 'industry' }, depotOrder(depot())],
        snap,
      ).ok,
    ).toBe(true);
    expect(validateVehicleOrders([], snap)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('au moins'),
    });
    expect(validateVehicleOrders([{ target: 99, kind: 'station' }], snap).ok).toBe(false);
    expect(validateVehicleOrders([{ target: 99, kind: 'industry' }], snap).ok).toBe(false);
    expect(validateVehicleOrders([{ target: 99, kind: 'depot' }], snap).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_VEHICLE_ORDERS + 1 }, () => ({
      target: 3,
      kind: 'station' as const,
    }));
    expect(validateVehicleOrders(tooMany, snap).ok).toBe(false);
  });

  it('déduit le type des cibles depuis les kinds du snapshot', () => {
    const snap = snapshot();
    const orders = ordersFromSnapshot(
      { orderTargets: [3, 4, 12], orderKinds: ['station', 'industry', 'depot'] },
      snap,
    );
    expect(orders).toEqual([
      { target: 3, kind: 'station' },
      { target: 4, kind: 'industry' },
      { target: 12, kind: 'depot' },
    ]);
    expect(orderTargetLabel(orders[0]!, snap)).toBe('Arrêt de Valmont');
    expect(orderTargetLabel(orders[2]!, snap)).toBe('Dépôt (2, 2)');
  });

  it('infère sans kinds en privilégiant les gares (pont v1)', () => {
    // Le pont n'expose que des arrêts de gare dans orderTargets et pas de
    // orderKinds : même si un dépôt partage l'id 3, c'est une gare.
    const snap = snapshot([depot({ id: 3 }), depot({ id: 12, kind: 'rail', x: 8, y: 8 })]);
    expect(ordersFromSnapshot({ orderTargets: [3, 4, 12] }, snap)).toEqual([
      { target: 3, kind: 'station' },
      { target: 4, kind: 'industry' },
      { target: 12, kind: 'depot' },
    ]);
  });

  it('compose les commandes buy par depotId, order/start/stop/sell', () => {
    expect(buyVehicleCommand(0, 12, 'bus_city')).toEqual({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: 12,
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

  it('copie profondément les options d’ordre dans la commande', () => {
    const source = {
      target: 3,
      kind: 'station' as const,
      options: {
        action: 'full_load' as const,
        timetable: { waitTicks: 120, autostart: true },
      },
    };
    const command = orderVehicleCommand(0, 4, [
      source,
      {
        target: -1,
        kind: 'conditional',
        options: {
          condition: { type: 'cargo', comparator: 'more', value: 10, cargo: 'coal' },
          jump: 0,
        },
      },
    ]);
    expect(command.orders).toEqual([
      {
        target: 3,
        kind: 'station',
        options: { action: 'full_load', timetable: { waitTicks: 120, autostart: true } },
      },
      {
        target: -1,
        kind: 'conditional',
        options: {
          condition: { type: 'cargo', comparator: 'more', value: 10, cargo: 'coal' },
          jump: 0,
        },
      },
    ]);
    source.options.timetable.waitTicks = 1;
    expect(command.orders?.[0]?.options?.timetable?.waitTicks).toBe(120);
    expect(
      cloneOrderOptions({
        action: 'transfer',
        timetable: { autostart: true },
      }).timetable?.autostart,
    ).toBe(true);
  });

  it('valide les ordres conditionnels et exige un saut dans la tournée', () => {
    const snap = snapshot();
    const orders = [
      { target: 3, kind: 'station' as const },
      {
        target: -1,
        kind: 'conditional' as const,
        options: {
          condition: {
            type: 'percentage' as const,
            comparator: 'more_or_equal' as const,
            value: 80,
          },
          jump: 0,
        },
      },
    ];
    expect(validateVehicleOrders(orders, snap).ok).toBe(true);
    expect(
      validateVehicleOrders(
        [
          { target: 3, kind: 'station' },
          { target: -1, kind: 'conditional', options: { jump: 0 } },
        ],
        snap,
      ).ok,
    ).toBe(false);
    expect(
      validateVehicleOrders(
        [
          { target: 3, kind: 'station' },
          {
            target: -1,
            kind: 'conditional',
            options: {
              condition: { type: 'money', comparator: 'more', value: 0 },
              jump: 9,
            },
          },
        ],
        snap,
      ).ok,
    ).toBe(false);
    expect(
      validateVehicleOrders(
        [
          {
            target: -1,
            kind: 'conditional',
            options: {
              condition: { type: 'money', comparator: 'more', value: 0 },
              jump: 0,
            },
          },
        ],
        snap,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('au moins un arrêt') });
  });

  it('préfère orderDetails pour les tournées enrichies', () => {
    const orders = ordersFromSnapshot(
      {
        orderTargets: [3, 5],
        orderKinds: ['station', 'depot'],
        orderDetails: [
          { index: 0, target: 3, kind: 'station', options: { action: 'full_load' } },
          { index: 1, target: -1, kind: 'conditional', options: { jump: 0 } },
          { index: 2, target: 5, kind: 'depot', options: { action: 'transfer' } },
        ],
      },
      snapshot(),
    );
    expect(orders.map((order) => order.kind)).toEqual(['station', 'conditional', 'depot']);
    expect(orders[2]?.options?.action).toBe('transfer');
    expect(orderTargetLabel(orders[1]!, snapshot())).toBe('Ordre conditionnel');
  });

  it('expose les refits du catalogue, leur capacité et leur coût', () => {
    const model = vehicleModel('truck_flatbed');
    if (!model) throw new Error('modèle attendu');
    expect(refitOptions(model).map((option) => option.cargo)).toEqual([
      'goods',
      'coal',
      'grain',
      'wood',
      'steel',
    ]);
    expect(refitOption(model, 'coal')?.capacity).toBe(34);
    expect(refitOption(model, 'passengers')).toBeNull();
    expect(refitOption(null, 'coal')).toBeNull();
    expect(refitCost(model)).toBe(560);
    expect(refitCost(null)).toBe(0);
    expect(refitVehicleCommand(1, 8, 'coal')).toEqual({
      type: 'vehicle',
      action: 'refit',
      company: 1,
      vehicle: 8,
      cargo: 'coal',
    });
    expect(cloneVehicleCommand(1, 8, false)).toEqual({
      type: 'vehicle',
      action: 'clone',
      company: 1,
      vehicle: 8,
      shareOrders: false,
    });
    expect(inferVehicleModel('road', 'coal')?.id).toBe('truck_flatbed');
    expect(inferVehicleModel('train', 'passengers')?.id).toBe('rail_autorail');
  });
});
