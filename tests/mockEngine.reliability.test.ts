import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import type { DepotSnapshot, StationSnapshot } from '../src/engine/protocol';
import {
  assignGroupCommand,
  buyVehicleCommand,
  createGroupCommand,
  deleteGroupCommand,
  depotOrder,
  groupActionCommand,
  groupAutoreplaceCommand,
  orderVehicleCommand,
  renameGroupCommand,
  sendVehicleToDepotCommand,
  serviceVehicleCommand,
  stationOrder,
} from '../src/game/vehicleRules';
import { DEFAULT_SERVICE_INTERVAL_DAYS } from '../src/game/vehicleReliability';

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

function readSave(engine: MockEngine): Promise<Record<string, unknown>> {
  return engine.save().then((data) => JSON.parse(new TextDecoder().decode(data)));
}

async function writeSave(engine: MockEngine, saved: Record<string, unknown>): Promise<void> {
  await engine.load(new TextEncoder().encode(JSON.stringify(saved)));
}

function buy(engine: MockEngine, model = 'bus_city', depot = findDepot(engine)): number {
  engine.send(buyVehicleCommand(0, depot.id, model));
  const vehicles = engine
    .snapshot()
    .vehicles.filter((item) => item.company === 0 && item.status === 3);
  const bought = vehicles[vehicles.length - 1];
  if (!bought) throw new Error('véhicule acheté attendu');
  return bought.id;
}

describe('MockEngine : fiabilité et entretien (#163)', () => {
  it('expose l’usure, l’intervalle et le coût d’entretien d’un véhicule neuf', async () => {
    const engine = await createEngine();
    const id = buy(engine);
    const vehicle = engine.snapshot().vehicles.find((item) => item.id === id);
    expect(vehicle?.reliability?.wear).toBe(0);
    expect(vehicle?.reliability?.reliability).toBe(100);
    expect(vehicle?.reliability?.breakdown).toBe('none');
    expect(vehicle?.reliability?.serviceIntervalDays).toBeGreaterThan(0);
    expect(vehicle?.reliability?.maintenancePerYear).toBeGreaterThan(0);
    expect(DEFAULT_SERVICE_INTERVAL_DAYS).toBeGreaterThanOrEqual(30);
  });

  it('use le véhicule en service et le remet à neuf au dépôt', async () => {
    const engine = await createEngine(101);
    const id = buy(engine);
    const station = findStation(engine);
    engine.send(orderVehicleCommand(0, id, [stationOrder(station)]));
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: id });
    run(engine, 74 * 40);
    const worn = engine.snapshot().vehicles.find((item) => item.id === id);
    expect(worn?.reliability?.wear ?? 0).toBeGreaterThan(5);
    expect(worn?.reliability?.daysSinceService ?? 0).toBeGreaterThan(0);
    const before = engine.snapshot().companies[0]?.money ?? 0;
    engine.send(serviceVehicleCommand(0, id));
    const after = engine.snapshot();
    const serviced = after.vehicles.find((item) => item.id === id);
    expect(serviced?.reliability?.wear).toBe(0);
    expect(serviced?.reliability?.reliability).toBe(100);
    expect(serviced?.status).toBe(3);
    expect(after.companies[0]?.money ?? 0).toBeLessThan(before);
    expect(after.news.some((item) => item.text.includes('entretenu'))).toBe(true);
    expect(after.events.some((event) => event.type === 'vehicle_repaired')).toBe(true);
  });

  it('déclenche une panne temporaire sur un véhicule très usé', async () => {
    const engine = await createEngine(7331);
    const id = buy(engine);
    const station = findStation(engine);
    engine.send(orderVehicleCommand(0, id, [stationOrder(station)]));
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: id });
    const saved = await readSave(engine);
    const world = saved.world as {
      vehicles: { id: number; reliability?: { wear: number; cooldownDays: number } }[];
    };
    const raw = world.vehicles.find((item) => item.id === id);
    if (!raw?.reliability) throw new Error('fiabilité sauvegardée attendue');
    raw.reliability.wear = 100;
    raw.reliability.cooldownDays = 0;
    await writeSave(engine, saved);
    let seen: string | null = null;
    let sawNews = false;
    for (let day = 0; day < 15 && seen === null; day += 1) {
      run(engine, 74);
      const snap = engine.snapshot();
      const vehicle = snap.vehicles.find((item) => item.id === id);
      if (vehicle?.reliability && vehicle.reliability.breakdown !== 'none') {
        seen = vehicle.reliability.breakdown;
      }
      if (snap.news.some((item) => item.text.includes('Panne'))) sawNews = true;
    }
    expect(seen).not.toBeNull();
    expect(sawNews).toBe(true);
  });

  it('envoie un véhicule au dépôt depuis la route', async () => {
    const engine = await createEngine(88);
    const id = buy(engine);
    const station = findStation(engine);
    engine.send(orderVehicleCommand(0, id, [stationOrder(station)]));
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: id });
    run(engine, 4);
    engine.send(sendVehicleToDepotCommand(0, id));
    const snapshot = engine.snapshot();
    const vehicle = snapshot.vehicles.find((item) => item.id === id);
    expect(vehicle?.status).toBe(3);
    expect(snapshot.news.some((item) => item.text.includes('dépôt'))).toBe(true);
  });

  it('simule l’autoreplace d’un groupe sur un véhicule ancien', async () => {
    const engine = await createEngine(2024);
    const id = buy(engine, 'bus_city');
    engine.send(createGroupCommand(0, 'road', 'Ligne auto'));
    const group = engine.snapshot().groups?.[0];
    if (!group) throw new Error('groupe attendu');
    engine.send(assignGroupCommand(0, group.id, [id]));
    engine.send(groupAutoreplaceCommand(0, group.id, 'bus_intercity', false));
    const saved = await readSave(engine);
    const world = saved.world as { vehicles: { id: number; ageDays: number }[] };
    const raw = world.vehicles.find((item) => item.id === id);
    if (!raw) throw new Error('véhicule sauvegardé attendu');
    raw.ageDays = 400;
    await writeSave(engine, saved);
    run(engine, 74 * 2);
    const after = engine.snapshot();
    const replaced = after.vehicles.find((item) => item.id === id);
    expect(replaced?.model).toBe('bus_intercity');
    expect(after.groups?.[0]?.autoreplace).toEqual({
      model: 'bus_intercity',
      whenOld: false,
    });
    expect(after.news.some((item) => item.text.includes('Autoreplace'))).toBe(true);
    expect(after.events.some((event) => event.type === 'vehicle_autoreplaced')).toBe(true);
  });
});

describe('MockEngine : groupes de véhicules (#164)', () => {
  it('crée, renomme et supprime un groupe', async () => {
    const engine = await createEngine(55);
    engine.send(createGroupCommand(0, 'road', '  Ligne   A  '));
    const created = engine.snapshot();
    let group = created.groups?.[0];
    expect(group?.name).toBe('Ligne A');
    expect(group?.kind).toBe('road');
    expect(group?.vehicles).toBe(0);
    expect(created.events.some((event) => event.type === 'group_created')).toBe(true);
    if (!group) throw new Error('groupe attendu');
    engine.send(renameGroupCommand(0, group.id, 'Ligne B'));
    group = engine.snapshot().groups?.[0];
    expect(group?.name).toBe('Ligne B');
    if (!group) throw new Error('groupe renommé attendu');
    engine.send(deleteGroupCommand(0, group.id));
    const deleted = engine.snapshot();
    expect(deleted.groups).toEqual([]);
    expect(deleted.events.some((event) => event.type === 'group_deleted')).toBe(true);
  });

  it('affecte, démarre, arrête, envoie au dépôt et vend un groupe', async () => {
    const engine = await createEngine(66);
    const first = buy(engine);
    const second = buy(engine);
    const station = findStation(engine);
    for (const id of [first, second]) {
      engine.send(
        orderVehicleCommand(0, id, [stationOrder(station), depotOrder(findDepot(engine))]),
      );
    }
    engine.send(createGroupCommand(0, 'road', 'Flotte'));
    const group = engine.snapshot().groups?.[0];
    if (!group) throw new Error('groupe attendu');
    engine.send(assignGroupCommand(0, group.id, [first, second]));
    expect(engine.snapshot().groups?.[0]?.vehicles).toBe(2);

    engine.send(groupActionCommand(0, group.id, 'start'));
    let vehicles = engine.snapshot().vehicles.filter((item) => item.group?.id === group.id);
    expect(vehicles.every((vehicle) => vehicle.status === 1)).toBe(true);

    engine.send(groupActionCommand(0, group.id, 'stop'));
    vehicles = engine.snapshot().vehicles.filter((item) => item.group?.id === group.id);
    expect(vehicles.every((vehicle) => vehicle.status === 0)).toBe(true);

    engine.send(groupActionCommand(0, group.id, 'send_to_depot'));
    vehicles = engine.snapshot().vehicles.filter((item) => item.group?.id === group.id);
    expect(vehicles.every((vehicle) => vehicle.status === 3)).toBe(true);

    const money = engine.snapshot().companies[0]?.money ?? 0;
    engine.send(groupActionCommand(0, group.id, 'sell'));
    const after = engine.snapshot();
    expect(after.vehicles.filter((item) => item.group?.id === group.id)).toEqual([]);
    expect(after.companies[0]?.money ?? 0).toBeGreaterThan(money);
  });

  it('refuse un véhicule d’un autre type et conserve la sauvegarde compatible', async () => {
    const engine = await createEngine(77);
    const road = buy(engine, 'bus_city');
    engine.send(createGroupCommand(0, 'train', 'Rails'));
    const group = engine.snapshot().groups?.[0];
    if (!group) throw new Error('groupe attendu');
    engine.send(assignGroupCommand(0, group.id, [road]));
    expect(engine.snapshot().news.some((item) => item.text.includes('refusé'))).toBe(true);
    expect(engine.snapshot().vehicles.find((item) => item.id === road)?.group).toBeUndefined();

    const saved = await readSave(engine);
    const world = saved.world as Record<string, unknown>;
    delete world.groups;
    const vehicles = world.vehicles as Record<string, unknown>[];
    for (const vehicle of vehicles) {
      delete vehicle.reliability;
      delete vehicle.groupId;
    }
    await writeSave(engine, saved);
    const loaded = engine.snapshot();
    expect(loaded.groups).toEqual([]);
    const legacy = loaded.vehicles.find((item) => item.id === road);
    expect(legacy?.reliability?.wear).toBe(0);
    expect(legacy?.reliability?.breakdown).toBe('none');
    expect(legacy?.group).toBeUndefined();
  });
});
