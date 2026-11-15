import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import { TILE_KIND_INDEX, type DepotSnapshot, type MapSnapshot } from '../src/engine/protocol';
import { depotOrder, stationOrder } from '../src/game/vehicleRules';
import { tileIndex } from '../src/game/mapGrid';

async function createEngine(seed = 2024, size = 128): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: size, height: size });
  return engine;
}

function mapOf(engine: MockEngine): MapSnapshot {
  const map = engine.snapshot().map;
  if (!map) throw new Error('carte attendue dans le premier snapshot');
  return map;
}

function findDepot(engine: MockEngine, kind: 'road' | 'rail', owner = 0): DepotSnapshot {
  const depot = engine
    .snapshot()
    .depots.find((item) => item.kind === kind && item.company === owner);
  if (!depot) throw new Error(`aucun dépôt ${kind} de l’entreprise ${owner}`);
  return depot;
}

function findGrass(map: MapSnapshot): { x: number; y: number } {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      if (map.kind[tileIndex(x, y, map.width)] === TILE_KIND_INDEX.grass) return { x, y };
    }
  }
  throw new Error('aucune tuile d’herbe');
}

function run(engine: MockEngine, ticks: number): void {
  let remaining = ticks;
  while (remaining > 0) {
    const executed = engine.step(Math.min(240, remaining));
    if (executed <= 0) break;
    remaining -= executed;
  }
}

describe('MockEngine : dépôts exposés', () => {
  it('publie les dépôts de démonstration avec des ids stables', async () => {
    const engine = await createEngine();
    const first = engine.snapshot();
    expect(first.depots.length).toBeGreaterThanOrEqual(2);
    expect(first.depots.some((item) => item.kind === 'road')).toBe(true);
    expect(first.depots.some((item) => item.kind === 'rail')).toBe(true);
    for (const depot of first.depots) {
      expect(depot.id).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(depot.x)).toBe(true);
      expect(Number.isInteger(depot.y)).toBe(true);
      expect(depot.width).toBe(1);
      expect(depot.height).toBe(1);
      expect(depot.direction).toBeGreaterThanOrEqual(0);
      expect(depot.direction).toBeLessThanOrEqual(3);
    }
    // Les ids ne changent pas entre deux snapshots sans construction.
    expect(engine.snapshot().depots.map((item) => item.id)).toEqual(
      first.depots.map((item) => item.id),
    );
  });
});

describe('MockEngine : achat et vente de véhicules', () => {
  it('achète un bus par depotId et débite le prix catalogue', async () => {
    const engine = await createEngine();
    const depot = findDepot(engine, 'road');
    const before = engine.snapshot();
    const moneyBefore = before.companies[0]?.money ?? 0;
    const hashBefore = engine.hash();

    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'bus_city',
    });
    const after = engine.snapshot();
    const vehicle = after.vehicles.find(
      (item) => item.company === 0 && item.status === 3 && item.cargo?.type === 'passengers',
    );
    expect(vehicle).toBeDefined();
    expect(vehicle?.kind).toBe('road');
    expect(vehicle?.orderTargets).toEqual([]);
    expect(vehicle?.x).toBeCloseTo(depot.x + 0.5);
    expect(vehicle?.y).toBeCloseTo(depot.y + 0.5);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-24_000);
    expect(engine.hash()).not.toBe(hashBefore);
    expect(after.news.some((item) => item.text.includes('Bus urbain acheté'))).toBe(true);
  });

  it('accepte encore la tuile depot {x,y} pour compatibilité', async () => {
    const engine = await createEngine(99);
    const depot = findDepot(engine, 'road');
    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depot: { x: depot.x, y: depot.y },
      model: 'bus_city',
    });
    expect(
      engine
        .snapshot()
        .vehicles.some(
          (item) => item.company === 0 && item.status === 3 && item.cargo?.type === 'passengers',
        ),
    ).toBe(true);
  });

  it('refuse mauvais dépôt, tuile non-dépôt, depotId inconnu, modèle inconnu et fonds insuffisants', async () => {
    const engine = await createEngine(77);
    const map = mapOf(engine);
    const roadDepot = findDepot(engine, 'road');
    const railDepot = findDepot(engine, 'rail');
    const grass = findGrass(map);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const vehiclesBefore = engine.snapshot().vehicles.length;

    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: railDepot.id,
      model: 'bus_city',
    });
    expect(
      engine.snapshot().news.some((item) => item.text.includes('exige un dépôt routier')),
    ).toBe(true);

    engine.send({ type: 'vehicle', action: 'buy', company: 0, depot: grass, model: 'bus_city' });
    expect(engine.snapshot().news.some((item) => item.text.includes('n’est pas un dépôt'))).toBe(
      true,
    );

    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: 99_999,
      model: 'bus_city',
    });
    expect(engine.snapshot().news.some((item) => item.text.includes('inexistant'))).toBe(true);

    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: roadDepot.id,
      model: 'modele_inconnu',
    });
    expect(engine.snapshot().news.some((item) => item.text.includes('inconnu au catalogue'))).toBe(
      true,
    );

    const after = engine.snapshot();
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.vehicles.length).toBe(vehiclesBefore);
  });

  it('vend un véhicule avec reprise et met à jour le compteur', async () => {
    const engine = await createEngine(808);
    const depot = findDepot(engine, 'road');
    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'truck_flatbed',
    });
    const bought = engine
      .snapshot()
      .vehicles.find((item) => item.company === 0 && item.status === 3);
    if (!bought) throw new Error('véhicule acheté attendu');
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const countBefore = engine.snapshot().vehicles.length;

    engine.send({ type: 'vehicle', action: 'sell', company: 0, vehicle: bought.id });
    const after = engine.snapshot();
    expect(after.vehicles.some((item) => item.id === bought.id)).toBe(false);
    expect(after.vehicles.length).toBe(countBefore - 1);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(14_000);
    expect(after.news.some((item) => item.text.includes('vendu'))).toBe(true);
  });
});

describe('MockEngine : tournées et revenus', () => {
  it('démarre un camion, parcourt sa tournée et génère du revenu', async () => {
    const engine = await createEngine(4242);
    const depot = findDepot(engine, 'road');
    const station = engine
      .snapshot()
      .stations.find((item) => item.company === 0 && item.kind === 'road');
    if (!station) throw new Error('arrêt routier attendu');

    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'truck_flatbed',
    });
    const bought = engine
      .snapshot()
      .vehicles.find((item) => item.company === 0 && item.status === 3);
    if (!bought) throw new Error('camion acheté attendu');

    engine.send({
      type: 'vehicle',
      action: 'order',
      company: 0,
      vehicle: bought.id,
      orders: [stationOrder(station), depotOrder(depot)],
    });
    const orderedSnapshot = engine.snapshot();
    const ordered = orderedSnapshot.vehicles.find((item) => item.id === bought.id);
    expect(ordered?.orderTargets).toEqual([station.id, depot.id]);
    expect(ordered?.orderKinds).toEqual(['station', 'depot']);
    expect(orderedSnapshot.news.some((item) => item.text.includes('Tournée du véhicule'))).toBe(
      true,
    );

    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bought.id });
    const started = engine.snapshot().vehicles.find((item) => item.id === bought.id);
    expect(started?.status).toBe(1);
    expect(engine.hash()).toMatch(/^[0-9a-f]{8}$/);

    run(engine, 7200);
    const after = engine.snapshot();
    const running = after.vehicles.find((item) => item.id === bought.id);
    expect(running).toBeDefined();
    expect(running?.profitLastYear ?? 0).toBeGreaterThan(0);
    expect(running?.status === 1 || running?.status === 2).toBe(true);
  });

  it('refuse un ordre inconnu et un départ sans tournée', async () => {
    const engine = await createEngine(303);
    const depot = findDepot(engine, 'road');
    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'bus_city',
    });
    const bought = engine
      .snapshot()
      .vehicles.find((item) => item.company === 0 && item.status === 3);
    if (!bought) throw new Error('bus acheté attendu');

    engine.send({
      type: 'vehicle',
      action: 'order',
      company: 0,
      vehicle: bought.id,
      orders: [{ target: 99_999, kind: 'depot' }],
    });
    let after = engine.snapshot();
    expect(after.news.some((item) => item.kind === 'error')).toBe(true);
    expect(after.vehicles.find((item) => item.id === bought.id)?.orderTargets).toEqual([]);

    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bought.id });
    after = engine.snapshot();
    expect(after.news.some((item) => item.text.includes('ajoutez au moins une gare'))).toBe(true);
    expect(after.vehicles.find((item) => item.id === bought.id)?.status).toBe(3);
  });

  it('arrête un véhicule : sa position ne bouge plus', async () => {
    const engine = await createEngine(505);
    const depot = findDepot(engine, 'road');
    const station = engine
      .snapshot()
      .stations.find((item) => item.company === 0 && item.kind === 'road');
    if (!station) throw new Error('arrêt routier attendu');
    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'bus_city',
    });
    const bought = engine
      .snapshot()
      .vehicles.find((item) => item.company === 0 && item.status === 3);
    if (!bought) throw new Error('bus acheté attendu');

    engine.send({
      type: 'vehicle',
      action: 'order',
      company: 0,
      vehicle: bought.id,
      orders: [stationOrder(station)],
    });
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bought.id });
    run(engine, 240);
    engine.send({ type: 'vehicle', action: 'stop', company: 0, vehicle: bought.id });
    const stopped = engine.snapshot().vehicles.find((item) => item.id === bought.id);
    expect(stopped?.status).toBe(0);
    run(engine, 480);
    const after = engine.snapshot().vehicles.find((item) => item.id === bought.id);
    expect(after?.x).toBeCloseTo(stopped?.x ?? -1);
    expect(after?.y).toBeCloseTo(stopped?.y ?? -1);
  });
});

describe('MockEngine : déterminisme des commandes véhicules', () => {
  it('produit le même hash pour la même suite achat + ordres + démarrage', async () => {
    const scenario = async (): Promise<string> => {
      const engine = await createEngine(606);
      const depot = findDepot(engine, 'road');
      const station = engine
        .snapshot()
        .stations.find((item) => item.company === 0 && item.kind === 'road');
      if (!station) throw new Error('arrêt routier attendu');
      engine.send({
        type: 'vehicle',
        action: 'buy',
        company: 0,
        depotId: depot.id,
        model: 'bus_city',
      });
      const bought = engine
        .snapshot()
        .vehicles.find((item) => item.company === 0 && item.status === 3);
      if (!bought) throw new Error('bus attendu');
      engine.send({
        type: 'vehicle',
        action: 'order',
        company: 0,
        vehicle: bought.id,
        orders: [stationOrder(station), depotOrder(depot)],
      });
      engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bought.id });
      run(engine, 960);
      return engine.hash();
    };
    expect(await scenario()).toBe(await scenario());
  });
});
