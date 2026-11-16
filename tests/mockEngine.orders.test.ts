import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import type { DepotSnapshot, StationSnapshot } from '../src/engine/protocol';
import {
  depotOrder,
  orderVehicleCommand,
  refitCost,
  refitVehicleCommand,
  stationOrder,
  vehicleModel,
  type VehicleOrder,
} from '../src/game/vehicleRules';

async function createEngine(seed = 4242, size = 128): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: size, height: size });
  return engine;
}

function findDepot(engine: MockEngine, kind: 'road' | 'rail' = 'road'): DepotSnapshot {
  const depot = engine.snapshot().depots.find((item) => item.kind === kind && item.company === 0);
  if (!depot) throw new Error(`aucun dépôt ${kind}`);
  return depot;
}

function findStation(engine: MockEngine, kind: 'road' | 'train' = 'road'): StationSnapshot {
  const station = engine
    .snapshot()
    .stations.find((item) => item.kind === kind && item.company === 0);
  if (!station) throw new Error(`aucune gare ${kind}`);
  return station;
}

function run(engine: MockEngine, ticks: number): void {
  let remaining = ticks;
  while (remaining > 0) {
    const executed = engine.step(Math.min(240, remaining));
    if (executed <= 0) break;
    remaining -= executed;
  }
}

/** Avance en filtrant les arrivées d'un véhicule précis. */
function collectVehicleArrivals(engine: MockEngine, ticks: number, vehicleId: number): Set<number> {
  const stations = new Set<number>();
  let remaining = ticks;
  while (remaining > 0) {
    const executed = engine.step(Math.min(240, remaining));
    if (executed <= 0) break;
    remaining -= executed;
    for (const event of engine.snapshot().events) {
      if (event.type === 'vehicle_arrived' && event.vehicle === vehicleId) {
        stations.add(event.station);
      }
    }
  }
  return stations;
}

function buy(engine: MockEngine, model: string, depot = findDepot(engine)): number {
  engine.send({
    type: 'vehicle',
    action: 'buy',
    company: 0,
    depotId: depot.id,
    model,
  });
  const vehicles = engine
    .snapshot()
    .vehicles.filter((item) => item.company === 0 && item.status === 3);
  const bought = vehicles[vehicles.length - 1];
  if (!bought) throw new Error('véhicule acheté attendu');
  return bought.id;
}

describe('MockEngine : refit de cargaison (#160)', () => {
  it('reconfigure la cargaison, la capacité et débite le coût estimé', async () => {
    const engine = await createEngine();
    const depot = findDepot(engine);
    const id = buy(engine, 'truck_flatbed', depot);
    const model = vehicleModel('truck_flatbed');
    if (!model) throw new Error('modèle attendu');
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;

    engine.send(refitVehicleCommand(0, id, 'coal'));
    const after = engine.snapshot();
    const vehicle = after.vehicles.find((item) => item.id === id);
    expect(vehicle?.cargo?.type).toBe('coal');
    expect(vehicle?.cargo?.capacity).toBe(34);
    expect(vehicle?.model).toBe('truck_flatbed');
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-refitCost(model));
    expect(after.news.some((item) => item.text.includes('reconfiguré vers « coal »'))).toBe(true);
  });

  it('perd la cargaison en cours et refuse une cargaison déjà configurée', async () => {
    const engine = await createEngine(777);
    const depot = findDepot(engine);
    const id = buy(engine, 'truck_tanker', depot);
    // Une sauvegarde éditée place le véhicule dans le dépôt avec une
    // cargaison : c'est le seul état où un refit perd réellement du fret.
    const saved = JSON.parse(new TextDecoder().decode(await engine.save())) as {
      world: { vehicles: { id: number; status: number; cargoType: string; cargoAmount: number }[] };
    };
    const raw = saved.world.vehicles.find((item) => item.id === id);
    if (!raw) throw new Error('véhicule sauvegardé attendu');
    raw.status = 3;
    raw.cargoType = 'oil';
    raw.cargoAmount = 11;
    await engine.load(new TextEncoder().encode(JSON.stringify(saved)));

    engine.send(refitVehicleCommand(0, id, 'water'));
    const after = engine.snapshot();
    const vehicle = after.vehicles.find((item) => item.id === id);
    expect(vehicle?.cargo?.type).toBe('water');
    expect(vehicle?.cargo?.amount).toBe(0);
    expect(after.news.some((item) => item.text.includes('11 unité(s) perdue(s)'))).toBe(true);

    engine.send(refitVehicleCommand(0, id, 'water'));
    expect(engine.snapshot().news.some((item) => item.text.includes('déjà'))).toBe(true);
  });

  it('refuse une cargaison indisponible et un véhicule en route', async () => {
    const engine = await createEngine(31337);
    const depot = findDepot(engine);
    const station = findStation(engine);
    const id = buy(engine, 'bus_city', depot);

    engine.send(refitVehicleCommand(0, id, 'coal'));
    expect(
      engine.snapshot().news.some((item) => item.text.includes('n’accepte pas « coal »')),
    ).toBe(true);

    engine.send({
      type: 'vehicle',
      action: 'order',
      company: 0,
      vehicle: id,
      orders: [stationOrder(station)],
    });
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: id });
    run(engine, 4);
    engine.send(refitVehicleCommand(0, id, 'passengers'));
    expect(engine.snapshot().news.some((item) => item.text.includes('arrêté dans un dépôt'))).toBe(
      true,
    );
  });
});

describe('MockEngine : ordres avancés (#161)', () => {
  it('démarre automatiquement avec un horaire et attend le plein chargement', async () => {
    const engine = await createEngine(9001);
    const depot = findDepot(engine);
    const station = findStation(engine);
    const id = buy(engine, 'bus_city', depot);
    const orders: VehicleOrder[] = [
      {
        ...stationOrder(station),
        options: {
          action: 'full_load',
          timetable: { autostart: true, waitTicks: 60 },
        },
      },
      depotOrder(depot),
    ];
    engine.send(orderVehicleCommand(0, id, orders));
    const started = engine.snapshot().vehicles.find((item) => item.id === id);
    expect(started?.status).toBe(1);
    expect(started?.orderDetails?.[0]?.options?.action).toBe('full_load');
    expect(started?.orderDetails?.[0]?.options?.timetable?.autostart).toBe(true);

    let maxRatio = 0;
    for (let i = 0; i < 30; i += 1) {
      run(engine, 240);
      const vehicle = engine.snapshot().vehicles.find((item) => item.id === id);
      const capacity = vehicle?.cargo?.capacity ?? 0;
      const amount = vehicle?.cargo?.amount ?? 0;
      if (capacity > 0) maxRatio = Math.max(maxRatio, amount / capacity);
    }
    expect(maxRatio).toBeGreaterThanOrEqual(0.99);
  });

  it('transfère la cargaison en gare sans revenu immédiat', async () => {
    const engine = await createEngine(6161);
    const depot = findDepot(engine);
    const station = findStation(engine);
    const id = buy(engine, 'truck_flatbed', depot);
    // Cargaison initiale placée en dépôt : le transfert doit la déposer sans
    // la vendre, contrairement à un arrêt normal.
    const saved = JSON.parse(new TextDecoder().decode(await engine.save())) as {
      world: { vehicles: { id: number; status: number; cargoType: string; cargoAmount: number }[] };
    };
    const raw = saved.world.vehicles.find((item) => item.id === id);
    if (!raw) throw new Error('véhicule sauvegardé attendu');
    raw.status = 3;
    raw.cargoType = 'goods';
    raw.cargoAmount = 20;
    await engine.load(new TextEncoder().encode(JSON.stringify(saved)));

    engine.send(
      orderVehicleCommand(0, id, [{ ...stationOrder(station), options: { action: 'transfer' } }]),
    );
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: id });
    const arrivals = collectVehicleArrivals(engine, 7200, id);
    const after = engine.snapshot();
    const vehicle = after.vehicles.find((item) => item.id === id);
    expect(arrivals.has(station.id)).toBe(true);
    expect(vehicle?.profitLastYear ?? 0).toBe(0);
  });

  // TODO(#203) : le scénario à deux arrêts routiers doit être reconstruit avec
  // une seconde gare routière ; le mock n'en génère qu'une sur cette graine.
  it.skip('saute une destination quand la condition est vraie et la visite sinon', async () => {
    const scenario = async (skip: boolean): Promise<boolean> => {
      const engine = await createEngine(4242);
      const depot = findDepot(engine);
      const stations = engine.snapshot().stations.filter((item) => item.company === 0);
      if (stations.length < 2) throw new Error('deux gares attendues');
      // Un bus ne peut desservir qu'une gare routière ou un dépôt routier (#203).
      const first = stations.find((item) => item.kind === 'road');

      if (!first) throw new Error('gare routière attendue');
      const id = buy(engine, 'bus_city', depot);
      const orders: VehicleOrder[] = [
        depotOrder(depot),
        {
          target: -1,
          kind: 'conditional',
          options: {
            condition: {
              type: 'money',
              comparator: skip ? 'more_or_equal' : 'more',
              value: skip ? 0 : 999_999_999,
            },
            jump: 3,
          },
        },
        stationOrder(first),
        depotOrder(depot),
      ];
      engine.send(orderVehicleCommand(0, id, orders));
      engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: id });
      const arrivals = collectVehicleArrivals(engine, 7200, id);
      expect(arrivals.has(first.id)).toBe(true);
      return arrivals.has(first.id);
    };

    // La condition saute la gare : elle n'est visitée que si elle est fausse.
    expect(await scenario(false)).toBe(true);
    expect(await scenario(true)).toBe(false);
  });

  it('valide les sauts conditionnels et les destinations physiques', async () => {
    const engine = await createEngine(8080);
    const depot = findDepot(engine);
    const station = findStation(engine);
    const id = buy(engine, 'bus_city', depot);
    engine.send(
      orderVehicleCommand(0, id, [
        stationOrder(station),
        { target: -1, kind: 'conditional', options: { jump: 0 } },
      ]),
    );
    expect(engine.snapshot().news.some((item) => item.text.includes('condition manquante'))).toBe(
      true,
    );
    engine.send(
      orderVehicleCommand(0, id, [
        stationOrder(station),
        {
          target: -1,
          kind: 'conditional',
          options: {
            condition: { type: 'percentage', comparator: 'more_or_equal', value: 0 },
            jump: 99,
          },
        },
      ]),
    );
    expect(engine.snapshot().news.some((item) => item.text.includes('saut invalide'))).toBe(true);

    engine.send(
      orderVehicleCommand(0, id, [
        {
          target: -1,
          kind: 'conditional',
          options: {
            condition: { type: 'percentage', comparator: 'more_or_equal', value: 0 },
            jump: 0,
          },
        },
      ]),
    );
    expect(engine.snapshot().news.some((item) => item.text.includes('Aucun arrêt physique'))).toBe(
      true,
    );
  });

  it('duplique un véhicule et sa tournée dans le dépôt', async () => {
    const engine = await createEngine(5150);
    const depot = findDepot(engine);
    const station = findStation(engine);
    const id = buy(engine, 'truck_flatbed', depot);
    engine.send(
      orderVehicleCommand(0, id, [
        { ...stationOrder(station), options: { action: 'full_load' } },
        depotOrder(depot),
      ]),
    );
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const before = engine.snapshot().vehicles.length;
    engine.send({ type: 'vehicle', action: 'clone', company: 0, vehicle: id });
    const after = engine.snapshot();
    expect(after.vehicles.length).toBe(before + 1);
    const clone = after.vehicles.find(
      (item) => item.id !== id && item.company === 0 && item.status === 3,
    );
    expect(clone?.model).toBe('truck_flatbed');
    expect(clone?.orderDetails?.[0]?.options?.action).toBe('full_load');
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-28_000);
    expect(after.news.some((item) => item.text.includes('dupliqué'))).toBe(true);
  });
});
