import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import {
  TILE_KIND_INDEX,
  type DepotSnapshot,
  type MapSnapshot,
  type StationSnapshot,
  type VehicleKind,
  type VehicleSnapshot,
} from '../src/engine/protocol';
import { tileIndex } from '../src/game/mapGrid';
import { depotOrder, orderVehicleCommand, stationOrder } from '../src/game/vehicleRules';

async function createEngine(seed = 2024, size = 128): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: size, height: size });
  return engine;
}

function run(engine: MockEngine, ticks: number): void {
  let remaining = ticks;
  while (remaining > 0) {
    const executed = engine.step(Math.min(240, remaining));
    if (executed <= 0) break;
    remaining -= executed;
  }
}

function mapOf(engine: MockEngine): MapSnapshot {
  const map = engine.snapshot().map;
  if (!map) throw new Error('carte attendue');
  return map;
}

function findDepot(engine: MockEngine, kind: 'road' | 'rail', owner = 0): DepotSnapshot {
  const depot = engine
    .snapshot()
    .depots.find((item) => item.kind === kind && item.company === owner);
  if (!depot) throw new Error(`aucun dépôt ${kind}`);
  return depot;
}

function buy(engine: MockEngine, depot: DepotSnapshot, model: string): VehicleSnapshot {
  engine.send({
    type: 'vehicle',
    action: 'buy',
    company: 0,
    depotId: depot.id,
    model,
  });
  const vehicle = engine.snapshot().vehicles.find((item) => item.model === model);
  if (!vehicle) throw new Error(`véhicule ${model} attendu`);
  return vehicle;
}

function stationAtTile(
  stations: readonly StationSnapshot[],
  x: number,
  y: number,
): StationSnapshot | null {
  for (const station of stations) {
    const left = Math.floor(station.x - station.width / 2);
    const top = Math.floor(station.y - station.height / 2);
    if (x >= left && x < left + station.width && y >= top && y < top + station.height) {
      return station;
    }
  }
  return null;
}

/**
 * Vérifie qu'un véhicule repose sur une surface de son réseau. Les ponts et
 * tunnels sont acceptés (leur transport n'est pas exposé dans `kind`), mais
 * jamais une tuile rail pour un véhicule routier, ni une route pour un train.
 */
function surfaceViolation(
  map: MapSnapshot,
  stations: readonly StationSnapshot[],
  vehicle: VehicleSnapshot,
): string | null {
  if (vehicle.kind === 'aircraft') return null;
  const x = Math.floor(vehicle.x);
  const y = Math.floor(vehicle.y);
  const tile = map.kind[tileIndex(x, y, map.width)] ?? TILE_KIND_INDEX.void;
  const name = (value: number): string =>
    Object.entries(TILE_KIND_INDEX).find(([, index]) => index === value)?.[0] ?? String(value);

  if (tile === TILE_KIND_INDEX.crossing) {
    return vehicle.kind === 'road' || vehicle.kind === 'train'
      ? null
      : `${vehicle.kind} sur passage à niveau`;
  }
  if (tile === TILE_KIND_INDEX.bridge || tile === TILE_KIND_INDEX.tunnel) return null;
  if (tile === TILE_KIND_INDEX.station) {
    const station = stationAtTile(stations, x, y);
    if (!station)
      return vehicle.kind === 'road' || vehicle.kind === 'train' ? null : 'gare inconnue';
    const expected: Record<VehicleKind, StationSnapshot['kind']> = {
      train: 'train',
      road: 'road',
      ship: 'ship',
      aircraft: 'airport',
    };
    return station.kind === expected[vehicle.kind]
      ? null
      : `${vehicle.kind} sur gare ${station.kind}`;
  }

  switch (vehicle.kind) {
    case 'road':
      return tile === TILE_KIND_INDEX.road ? null : `bus/camion sur ${name(tile)}`;
    case 'train':
      return tile === TILE_KIND_INDEX.rail ? null : `train sur ${name(tile)}`;
    case 'ship':
      return tile === TILE_KIND_INDEX.water ||
        tile === TILE_KIND_INDEX.river ||
        tile === TILE_KIND_INDEX.coast ||
        tile === TILE_KIND_INDEX.dock ||
        tile === TILE_KIND_INDEX.canal ||
        tile === TILE_KIND_INDEX.lock ||
        tile === TILE_KIND_INDEX.aqueduct
        ? null
        : `bateau sur ${name(tile)}`;
    default:
      return null;
  }
}

function violations(engine: MockEngine, ticks: number): string[] {
  const found: string[] = [];
  let remaining = ticks;
  while (remaining > 0) {
    const executed = engine.step(Math.min(120, remaining));
    if (executed <= 0) break;
    remaining -= executed;
    const snapshot = engine.snapshot();
    const map = snapshot.map;
    if (!map) continue;
    for (const vehicle of snapshot.vehicles) {
      const violation = surfaceViolation(map, snapshot.stations, vehicle);
      if (violation)
        found.push(`#${vehicle.id} ${violation} (${vehicle.x.toFixed(1)},${vehicle.y.toFixed(1)})`);
    }
  }
  return found;
}

describe('MockEngine : cohérence type de véhicule ↔ infrastructure (#203)', () => {
  it('ne place aucun véhicule initial sur une surface incompatible', async () => {
    for (const seed of [2024, 303, 505, 4242]) {
      const engine = await createEngine(seed);
      const found = violations(engine, 1_800);
      expect(found.slice(0, 8), `graine ${seed}`).toEqual([]);
    }
  });

  it('fait suivre la route à un bus, même vers une gare lointaine', async () => {
    const engine = await createEngine(2024);
    const snapshot = engine.snapshot();
    const depot = findDepot(engine, 'road');
    const bus = buy(engine, depot, 'bus_city');
    const roadStations = snapshot.stations.filter((station) => station.kind === 'road');
    expect(roadStations.length).toBeGreaterThan(1);
    // La gare la plus éloignée force historiquement un tracé en L à travers
    // les voies ferrées : c'est le cas exact rapporté par #203.
    const target = roadStations.reduce((best, station) => {
      const distance = Math.hypot(station.x - depot.x, station.y - depot.y);
      const bestDistance = Math.hypot(best.x - depot.x, best.y - depot.y);
      return distance > bestDistance ? station : best;
    });
    engine.send(orderVehicleCommand(0, bus.id, [stationOrder(target), depotOrder(depot)]));
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bus.id });

    const found = violations(engine, 14_400);
    expect(found.slice(0, 8)).toEqual([]);
    const running = engine.snapshot().vehicles.find((item) => item.id === bus.id);
    expect(running).toBeDefined();
    expect(running?.kind).toBe('road');
  });

  it('fait suivre les rails à un train entre deux gares ferroviaires', async () => {
    const engine = await createEngine(505);
    const snapshot = engine.snapshot();
    const depot = findDepot(engine, 'rail');
    const train = buy(engine, depot, 'rail_autorail');
    const stations = snapshot.stations.filter((station) => station.kind === 'train');
    expect(stations.length).toBeGreaterThan(1);
    const orders = stations.map((station) => stationOrder(station));
    orders.push(depotOrder(depot));
    engine.send(orderVehicleCommand(0, train.id, orders));
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: train.id });

    const found = violations(engine, 10_800);
    expect(found.slice(0, 8)).toEqual([]);
    expect(engine.snapshot().vehicles.find((item) => item.id === train.id)?.kind).toBe('train');
  });

  it('refuse explicitement un ordre incompatible avec le type du véhicule', async () => {
    const engine = await createEngine(2024);
    const snapshot = engine.snapshot();
    const roadDepot = findDepot(engine, 'road');
    const railDepot = findDepot(engine, 'rail');
    const trainStation = snapshot.stations.find((station) => station.kind === 'train');
    const roadStation = snapshot.stations.find((station) => station.kind === 'road');
    if (!trainStation || !roadStation) throw new Error('gares attendues');

    const bus = buy(engine, roadDepot, 'bus_city');
    engine.send(orderVehicleCommand(0, bus.id, [stationOrder(trainStation)]));
    let after = engine.snapshot();
    expect(after.vehicles.find((item) => item.id === bus.id)?.orderTargets).toEqual([]);
    expect(after.news.some((item) => item.text.includes('Ordre incompatible'))).toBe(true);

    engine.send(orderVehicleCommand(0, bus.id, [depotOrder(railDepot)]));
    after = engine.snapshot();
    expect(after.vehicles.find((item) => item.id === bus.id)?.orderTargets).toEqual([]);
    expect(
      after.news.some(
        (item) => item.text.includes('Ordre incompatible') && item.text.includes('routier'),
      ),
    ).toBe(true);

    const train = buy(engine, railDepot, 'rail_autorail');
    engine.send(orderVehicleCommand(0, train.id, [stationOrder(roadStation)]));
    after = engine.snapshot();
    expect(after.vehicles.find((item) => item.id === train.id)?.orderTargets).toEqual([]);
    expect(after.news.some((item) => item.text.includes('ferroviaire'))).toBe(true);
  });

  it('conserve le type et un itinéraire compatible après clone et refit', async () => {
    const engine = await createEngine(4242);
    const depot = findDepot(engine, 'road');
    const truck = buy(engine, depot, 'truck_flatbed');
    const station = engine.snapshot().stations.find((item) => item.kind === 'road');
    if (!station) throw new Error('gare routière attendue');

    engine.send(orderVehicleCommand(0, truck.id, [stationOrder(station), depotOrder(depot)]));
    engine.send({
      type: 'vehicle',
      action: 'refit',
      company: 0,
      vehicle: truck.id,
      cargo: 'coal',
    });
    engine.send({ type: 'vehicle', action: 'clone', company: 0, vehicle: truck.id });
    run(engine, 240);

    const snapshot = engine.snapshot();
    const clone = snapshot.vehicles.find(
      (item) => item.id !== truck.id && item.model === 'truck_flatbed',
    );
    expect(clone).toBeDefined();
    expect(clone?.kind).toBe('road');
    expect(clone?.cargo?.type).toBe('coal');
    expect(violations(engine, 2_400)).toEqual([]);
  });

  it('pose un passage à niveau là où les réseaux générés se croisent', async () => {
    const engine = await createEngine(2024);
    const map = mapOf(engine);
    let crossings = 0;
    for (const tile of map.kind) {
      if (tile === TILE_KIND_INDEX.crossing) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(0);
  });
});
