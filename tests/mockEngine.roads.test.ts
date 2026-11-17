import { describe, expect, it } from 'vitest';
import { MockEngine, roadOneWayAllows } from '../src/engine/MockEngine';
import {
  ROAD_ONEWAY_INDEX,
  TILE_KIND_INDEX,
  type MapSnapshot,
  type VehicleSnapshot,
} from '../src/engine/protocol';
import { planBuild, type BuildPoint } from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';

async function createEngine(seed = 231): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: 96, height: 96 });
  return engine;
}

function mapOf(engine: MockEngine): MapSnapshot {
  const map = engine.snapshot().map;
  if (!map) throw new Error('carte attendue dans le premier snapshot');
  return map;
}

function findRoadRun(map: MapSnapshot, length = 5): { from: BuildPoint; to: BuildPoint } {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - length - 1; x += 1) {
      const from = { x, y };
      const to = { x: x + length - 1, y };
      if (planBuild({ map, tool: 'road', from, to, budget: 10_000_000 }).valid) {
        return { from, to };
      }
    }
  }
  throw new Error('aucun tronçon routier constructible');
}

function vehicleAt(engine: MockEngine, id: number): VehicleSnapshot {
  const vehicle = engine.snapshot().vehicles.find((item) => item.id === id);
  if (!vehicle) throw new Error(`véhicule #${id} introuvable`);
  return vehicle;
}

describe('MockEngine : routes à sens unique (#231)', () => {
  it('publie roadData et débite le surcoût', async () => {
    const engine = await createEngine();
    const before = mapOf(engine);
    const { from, to } = findRoadRun(before);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const hashBefore = engine.hash();

    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'east' },
    });

    const after = engine.snapshot();
    const map = after.map;
    if (!map) throw new Error('carte attendue après construction');
    for (let x = from.x; x <= to.x; x += 1) {
      expect(map.kind[tileIndex(x, from.y, map.width)]).toBe(TILE_KIND_INDEX.road);
      expect(map.roadData?.[tileIndex(x, from.y, map.width)]).toBe(ROAD_ONEWAY_INDEX.east);
    }
    expect(engine.hash()).not.toBe(hashBefore);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);
  });

  it('convertit un tronçon existant sans changer la carte', async () => {
    const engine = await createEngine(232);
    const before = mapOf(engine);
    const { from, to } = findRoadRun(before);
    engine.send({ type: 'build', tool: 'road', company: 0, from, to, options: { axis: 'x' } });
    const built = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;

    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'west', convert: true },
    });

    const converted = engine.snapshot();
    const map = converted.map;
    if (!map) throw new Error('carte attendue après conversion');
    for (let x = from.x; x <= to.x; x += 1) {
      const index = tileIndex(x, from.y, map.width);
      expect(map.kind[index]).toBe(TILE_KIND_INDEX.road);
      expect(map.roadData?.[index]).toBe(ROAD_ONEWAY_INDEX.west);
      expect(map.trackBits[index]).toBe(built.trackBits[index]);
    }
    const cost = moneyBefore - (converted.companies[0]?.money ?? 0);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(500);
  });

  it('change le sens d’un tronçon déjà à sens unique', async () => {
    const engine = await createEngine(233);
    const { from, to } = findRoadRun(mapOf(engine));
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'east' },
    });
    const hash = engine.hash();
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'west' },
    });
    const map = mapOf(engine);
    expect(map.roadData?.[tileIndex(from.x, from.y, map.width)]).toBe(ROAD_ONEWAY_INDEX.west);
    expect(engine.hash()).not.toBe(hash);
  });

  it('remet un tronçon à sens unique en double sens', async () => {
    const engine = await createEngine(238);
    const { from, to } = findRoadRun(mapOf(engine));
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'east' },
    });
    const before = mapOf(engine);
    const index = tileIndex(from.x, from.y, before.width);
    expect(before.roadData?.[index]).toBe(ROAD_ONEWAY_INDEX.east);
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'both', convert: true },
    });
    const after = mapOf(engine);
    expect(after.roadData?.[index]).toBe(0);
    expect(after.kind[index]).toBe(TILE_KIND_INDEX.road);
  });

  it('efface roadData à la démolition', async () => {
    const engine = await createEngine(234);
    const { from, to } = findRoadRun(mapOf(engine));
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'east' },
    });
    const index = tileIndex(from.x, from.y, mapOf(engine).width);
    engine.send({ type: 'build', tool: 'clear', company: 0, from, to: from });
    expect(mapOf(engine).roadData?.[index]).toBe(0);
  });

  it('conserve le sens en sauvegarde et restaure les anciennes sauvegardes', async () => {
    const engine = await createEngine(235);
    const { from, to } = findRoadRun(mapOf(engine));
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x', one_way: 'east' },
    });
    const saved = await engine.save();
    const index = tileIndex(from.x, from.y, 96);

    const restored = await createEngine(1);
    await restored.load(saved);
    expect(mapOf(restored).roadData?.[index]).toBe(ROAD_ONEWAY_INDEX.east);

    // Sauvegarde antérieure à #231 : la couche est absente, tout est double sens.
    const parsed = JSON.parse(new TextDecoder().decode(saved)) as {
      world: { roadData?: string };
    };
    delete parsed.world.roadData;
    const legacy = new TextEncoder().encode(JSON.stringify(parsed));
    const old = await createEngine(2);
    await old.load(legacy);
    const legacyMap = mapOf(old);
    expect(legacyMap.roadData).toBeDefined();
    expect(legacyMap.roadData?.[index]).toBe(0);
  });

  it('contraint le sens de circulation des véhicules', () => {
    const roadData = new Uint8Array([
      0,
      ROAD_ONEWAY_INDEX.east,
      ROAD_ONEWAY_INDEX.north,
      ROAD_ONEWAY_INDEX.west,
    ]);
    expect(roadOneWayAllows(roadData, 0, 1, 0)).toBe(true);
    expect(roadOneWayAllows(roadData, 1, 1, 0)).toBe(true);
    expect(roadOneWayAllows(roadData, 1, -1, 0)).toBe(false);
    expect(roadOneWayAllows(roadData, 2, 0, -1)).toBe(true);
    expect(roadOneWayAllows(roadData, 2, 0, 1)).toBe(false);
    expect(roadOneWayAllows(roadData, 3, -1, 0)).toBe(true);
    expect(roadOneWayAllows(roadData, 3, 1, 0)).toBe(false);
  });
});

describe('MockEngine : orientation des véhicules (#232)', () => {
  it('oriente les véhicules au dépôt vers la sortie', async () => {
    const engine = await createEngine(236);
    const depot = engine.snapshot().depots.find((item) => item.kind === 'road');
    if (!depot) throw new Error('dépôt routier absent');
    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'bus_city',
    });
    const vehicle = engine
      .snapshot()
      .vehicles.find((item) => item.kind === 'road' && item.status === 3);
    if (!vehicle) throw new Error('bus au dépôt absent');
    // DiagDirection 0 = NE (32), 1 = SE (96), 2 = SW (160), 3 = NW (224).
    expect(vehicle.direction).toBe((depot.direction & 3) * 64 + 32);
    expect(vehicle.pitch ?? 0).toBe(0);
  });

  it('ne laisse pas la direction dériver de 90° sur un axe droit', async () => {
    const engine = await createEngine(237);
    const { from, to } = findRoadRun(mapOf(engine), 6);
    engine.send({ type: 'build', tool: 'road', company: 0, from, to, options: { axis: 'x' } });
    const vehicle = engine.snapshot().vehicles.find((item) => item.kind === 'road');
    if (!vehicle) throw new Error('véhicule routier de démonstration absent');
    let previous = vehicleAt(engine, vehicle.id);
    let checked = false;
    for (let tick = 0; tick < 80 && !checked; tick += 1) {
      engine.step(1);
      const next = vehicleAt(engine, vehicle.id);
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.05) {
        checked = true;
        // Déplacement horizontal : le véhicule ne doit pas continuer à pointer
        // vers le nord/sud (ancien lissage à 12/256 par tick).
        expect(next.direction).toBe(dx > 0 ? 64 : 192);
      } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 0.05) {
        checked = true;
        expect(next.direction).toBe(dy > 0 ? 128 : 0);
      }
      previous = next;
    }
    expect(checked).toBe(true);
  });
});
