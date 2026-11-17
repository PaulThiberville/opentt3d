import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import { TILE_FLAG, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import {
  planBuild,
  planDepot,
  planStation,
  railConvertCost,
  type BuildPoint,
  type StationSettings,
} from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';
import { SIGNAL_KIND_COST } from '../src/game/signalRules';

async function createEngine(seed = 1234, size = 128): Promise<MockEngine> {
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

function findStationSpot(map: MapSnapshot, settings: StationSettings): BuildPoint {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      const plan = planStation({
        map,
        from: { x, y },
        settings,
        budget: 10_000_000,
      });
      if (plan.valid) return { x, y };
    }
  }
  throw new Error('aucune emprise de gare constructible dans la carte de test');
}

function findDepotSpot(map: MapSnapshot, kind: 'rail' | 'road'): BuildPoint {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      const plan = planDepot({
        map,
        from: { x, y },
        settings: { kind, direction: null },
        budget: 10_000_000,
      });
      if (plan.valid) return { x, y };
    }
  }
  throw new Error('aucune tuile de dépôt constructible dans la carte de test');
}

function findPath(
  map: MapSnapshot,
  tool: 'rail' | 'road',
  length = 4,
): { from: BuildPoint; to: BuildPoint } {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - length - 1; x += 1) {
      const from = { x, y };
      const to = { x: x + length - 1, y };
      const plan = planBuild({ map, tool, from, to, budget: 10_000_000 });
      if (plan.valid) return { from, to };
    }
  }
  throw new Error('aucun tronçon constructible dans la carte de test');
}

function findKind(map: MapSnapshot, kind: number): BuildPoint {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (map.kind[tileIndex(x, y, map.width)] === kind) return { x, y };
    }
  }
  throw new Error('type de tuile absent de la carte');
}

const RAIL_STATION: StationSettings = {
  kind: 'rail',
  platforms: 2,
  length: 3,
  direction: 'ne',
  driveThrough: false,
};

describe('MockEngine : gares', () => {
  it('construit une gare 3×2, débite le coût et publie une news', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const spot = findStationSpot(map, RAIL_STATION);
    const hashBefore = engine.hash();

    engine.send({
      type: 'build',
      tool: 'station',
      company: 0,
      from: spot,
      options: {
        kind: 'rail',
        platforms: 2,
        length: 3,
        direction: 'ne',
        axis: 'x',
      },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('la gare doit invalider la carte');

    for (let y = spot.y; y < spot.y + 2; y += 1) {
      for (let x = spot.x; x < spot.x + 3; x += 1) {
        const index = tileIndex(x, y, built.width);
        expect(built.kind[index]).toBe(TILE_KIND_INDEX.station);
        expect(built.owner[index]).toBe(0);
        expect(built.trackBits[index]).toBeGreaterThan(0);
      }
    }
    const station = after.stations.find(
      (item) => item.company === 0 && item.kind === 'train' && item.width === 3,
    );
    expect(station?.kind).toBe('train');
    expect(station?.height).toBe(2);
    expect(station?.waiting).toEqual([]);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-6 * 650);
    expect(engine.hash()).not.toBe(hashBefore);
    expect(after.news.some((item) => item.text.includes('Gare ferroviaire construite'))).toBe(true);
  });

  it('construit une gare routière en passage sur une tuile', async () => {
    const engine = await createEngine(77);
    const map = mapOf(engine);
    const spot = findStationSpot(map, { ...RAIL_STATION, kind: 'road' });
    engine.send({
      type: 'build',
      tool: 'station',
      company: 0,
      from: spot,
      options: { kind: 'road', direction: 'ne', drive_through: true },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('la gare routière doit invalider la carte');
    expect(built.kind[tileIndex(spot.x, spot.y, built.width)]).toBe(TILE_KIND_INDEX.station);
    const station = after.stations.find((item) => item.kind === 'road' && item.width === 1);
    expect(station?.height).toBe(1);
    expect(station?.driveThrough).toBe(true);
    expect(station?.roadAxis).toBe('x');
    expect(after.news.some((item) => item.text.includes('en passage'))).toBe(true);
  });

  it('pose un arrêt en passage sur une route verticale malgré une direction perpendiculaire', async () => {
    const engine = await createEngine(321);
    const map = mapOf(engine);
    let road: ReturnType<typeof planBuild> | null = null;
    for (let x = 1; x < map.width - 1 && !road; x += 1) {
      for (let y = 1; y < map.height - 4 && !road; y += 1) {
        const plan = planBuild({
          map,
          tool: 'road',
          from: { x, y },
          to: { x, y: y + 2 },
          budget: 10_000_000,
        });
        if (plan.valid) road = plan;
      }
    }
    if (!road) throw new Error('aucune route verticale constructible');
    engine.send({
      type: 'build',
      tool: 'road',
      company: 0,
      from: road.from,
      to: road.to,
    });
    engine.snapshot();
    const middle = { x: road.from.x, y: road.from.y + 1 };
    engine.send({
      type: 'build',
      tool: 'station',
      company: 0,
      from: middle,
      // Direction volontairement perpendiculaire : le mock doit s'aligner.
      options: { kind: 'road', direction: 'ne', drive_through: true },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('l’arrêt doit invalider la carte');
    const index = tileIndex(middle.x, middle.y, built.width);
    expect(built.kind[index]).toBe(TILE_KIND_INDEX.station);
    expect((built.trackBits[index] ?? 0) & 0x0f).toBe(1 | 4);
    const station = after.stations.find(
      (item) => item.kind === 'road' && item.x === middle.x + 0.5,
    );
    expect(station?.driveThrough).toBe(true);
    expect(station?.roadAxis).toBe('y');
    expect(after.news.some((item) => item.text.includes('en passage'))).toBe(true);
    expect(after.news.some((item) => item.text.includes('Construction impossible'))).toBe(false);
  });

  it('refuse une gare sur l’eau sans débiter ni modifier la carte', async () => {
    const engine = await createEngine(99);
    const map = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const water = findKind(map, TILE_KIND_INDEX.water);
    engine.send({
      type: 'build',
      tool: 'station',
      company: 0,
      from: water,
      options: { kind: 'rail', platforms: 1, length: 1, direction: 'ne' },
    });
    const after = engine.snapshot();
    expect(after.map).toBeNull();
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.news.some((item) => item.kind === 'error' && item.text.includes('eau'))).toBe(
      true,
    );
  });

  it('démolit une gare tuile par tuile (Ctrl+Z)', async () => {
    const engine = await createEngine(808);
    const map = mapOf(engine);
    const settings: StationSettings = {
      kind: 'rail',
      platforms: 1,
      length: 2,
      direction: 'ne',
      driveThrough: false,
    };
    const spot = findStationSpot(map, settings);
    engine.send({
      type: 'build',
      tool: 'station',
      company: 0,
      from: spot,
      options: { kind: 'rail', platforms: 1, length: 2, direction: 'ne' },
    });
    engine.snapshot();
    for (let x = spot.x; x < spot.x + 2; x += 1) {
      engine.send({ type: 'build', tool: 'clear', company: 0, from: { x, y: spot.y } });
    }
    const cleared = engine.snapshot().map;
    if (!cleared) throw new Error('la démolition doit invalider la carte');
    for (let x = spot.x; x < spot.x + 2; x += 1) {
      const index = tileIndex(x, spot.y, cleared.width);
      expect(cleared.kind[index]).toBe(TILE_KIND_INDEX.grass);
      expect(cleared.owner[index]).toBe(255);
    }
  });
});

describe('MockEngine : dépôts et signaux', () => {
  it('construit un dépôt routier et oriente la traversée', async () => {
    const engine = await createEngine(2024);
    const map = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const spot = findDepotSpot(map, 'road');
    engine.send({
      type: 'build',
      tool: 'depot',
      company: 0,
      from: spot,
      options: { kind: 'road', direction: 'se' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le dépôt doit invalider la carte');
    const index = tileIndex(spot.x, spot.y, built.width);
    expect(built.kind[index]).toBe(TILE_KIND_INDEX.road);
    expect(built.owner[index]).toBe(0);
    expect((built.trackBits[index] ?? 0) & 0x0f).toBe(1 | 4);
    const depot = after.depots.find((item) => item.x === spot.x && item.y === spot.y);
    expect(depot).toMatchObject({ company: 0, kind: 'road', direction: 1, width: 1, height: 1 });
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-520);
    expect(after.news.some((item) => item.text.includes('Dépôt routier'))).toBe(true);
  });

  it('retire un dépôt du snapshot quand il est démoli', async () => {
    const engine = await createEngine(909);
    const map = mapOf(engine);
    const spot = findDepotSpot(map, 'road');
    engine.send({
      type: 'build',
      tool: 'depot',
      company: 0,
      from: spot,
      options: { kind: 'road', direction: 'ne' },
    });
    const built = engine.snapshot().depots.find((item) => item.x === spot.x && item.y === spot.y);
    if (!built) throw new Error('dépôt construit attendu');
    engine.send({ type: 'build', tool: 'clear', company: 0, from: spot });
    const after = engine.snapshot();
    expect(after.depots.some((item) => item.id === built.id)).toBe(false);
  });

  it('pose un signal de bloc sur une voie de l’entreprise', async () => {
    const engine = await createEngine(303);
    const map = mapOf(engine);
    const { from, to } = findPath(map, 'rail', 4);
    engine.send({ type: 'build', tool: 'rail', company: 0, from, to, options: { axis: 'x' } });
    engine.snapshot();
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const hashBefore = engine.hash();

    engine.send({
      type: 'build',
      tool: 'signal',
      company: 0,
      from,
      options: { type: 'block', track: 'x' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le signal doit invalider la carte');
    const index = tileIndex(from.x, from.y, built.width);
    expect(built.kind[index]).toBe(TILE_KIND_INDEX.rail);
    expect((built.flags[index] ?? 0) & TILE_FLAG.SIGNAL).toBe(TILE_FLAG.SIGNAL);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-320);
    expect(engine.hash()).not.toBe(hashBefore);
    expect(after.news.some((item) => item.text.includes('signal(aux) de bloc'))).toBe(true);
  });

  it('refuse un signal hors rail ou sur la voie d’une autre entreprise', async () => {
    const engine = await createEngine(404);
    const map = mapOf(engine);
    const grass = findKind(map, TILE_KIND_INDEX.grass);
    engine.send({
      type: 'build',
      tool: 'signal',
      company: 0,
      from: grass,
      options: { type: 'block' },
    });
    let after = engine.snapshot();
    expect(
      after.news.some((item) => item.kind === 'error' && item.text.includes('voie ferrée')),
    ).toBe(true);

    const { from, to } = findPath(map, 'rail', 4);
    engine.send({ type: 'build', tool: 'rail', company: 0, from, to, options: { axis: 'x' } });
    engine.snapshot();
    engine.send({
      type: 'build',
      tool: 'signal',
      company: 1,
      from,
      options: { type: 'block' },
    });
    after = engine.snapshot();
    expect(
      after.news.some((item) => item.kind === 'error' && item.text.includes('autre entreprise')),
    ).toBe(true);
  });

  it('reste déterministe pour une même suite gare + dépôt + signal', async () => {
    const build = async (): Promise<string> => {
      const engine = await createEngine(505);
      const map = mapOf(engine);
      const station = findStationSpot(map, RAIL_STATION);
      engine.send({
        type: 'build',
        tool: 'station',
        company: 0,
        from: station,
        options: { kind: 'rail', platforms: 2, length: 3, direction: 'ne', axis: 'x' },
      });
      const afterStation = engine.snapshot().map ?? map;
      const depot = findDepotSpot(afterStation, 'road');
      engine.send({
        type: 'build',
        tool: 'depot',
        company: 0,
        from: depot,
        options: { kind: 'road', direction: 'ne' },
      });
      const afterDepot = engine.snapshot().map ?? afterStation;
      const { from } = findPath(afterDepot, 'rail', 4);
      engine.send({
        type: 'build',
        tool: 'rail',
        company: 0,
        from,
        to: { x: from.x + 3, y: from.y },
      });
      engine.send({
        type: 'build',
        tool: 'signal',
        company: 0,
        from,
        options: { type: 'block' },
      });
      return engine.hash();
    };
    expect(await build()).toBe(await build());
  });
});

describe('MockEngine : signaux avancés et types de rail (#156/#157)', () => {
  it('pose un signal path bidirectionnel avec densité, puis le retire', async () => {
    const engine = await createEngine(606);
    const map = mapOf(engine);
    const { from, to } = findPath(map, 'rail', 6);
    engine.send({
      type: 'build',
      tool: 'rail',
      company: 0,
      from,
      to,
      options: { axis: 'x', railType: 'rail' },
    });
    engine.snapshot();

    const before = engine.snapshot();
    const moneyBefore = before.companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'signal',
      company: 0,
      from,
      to,
      options: { type: 'path', direction: 'both', spacing: 2 },
    });
    const after = engine.snapshot();
    const signalTiles = after.signals ?? [];
    expect(signalTiles.map((signal) => signal.x)).toEqual([from.x, from.x + 2, from.x + 4]);
    expect(signalTiles.every((signal) => signal.kind === 'path')).toBe(true);
    expect(signalTiles.every((signal) => signal.direction === 'both')).toBe(true);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-3 * SIGNAL_KIND_COST.path);

    engine.send({
      type: 'build',
      tool: 'unsignal',
      company: 0,
      from,
      to,
    });
    const cleared = engine.snapshot();
    expect(cleared.signals ?? []).toHaveLength(0);
    const built = cleared.map;
    if (!built) throw new Error('la démolition doit invalider la carte');
    for (let x = from.x; x <= to.x; x += 1) {
      const index = tileIndex(x, from.y, built.width);
      expect(built.kind[index]).toBe(TILE_KIND_INDEX.rail);
      expect((built.flags[index] ?? 0) & TILE_FLAG.SIGNAL).toBe(0);
    }
  });

  it('convertit un tronçon en électrifié, débite le coût et conserve les signaux', async () => {
    const engine = await createEngine(707);
    const map = mapOf(engine);
    const { from, to } = findPath(map, 'rail', 5);
    engine.send({
      type: 'build',
      tool: 'rail',
      company: 0,
      from,
      to,
      options: { axis: 'x' },
    });
    engine.send({
      type: 'build',
      tool: 'signal',
      company: 0,
      from,
      options: { type: 'block' },
    });
    engine.snapshot();
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const hashBefore = engine.hash();

    engine.send({
      type: 'build',
      tool: 'convert',
      company: 0,
      from,
      to,
      options: { railType: 'electrified' },
    });
    const after = engine.snapshot();
    const converted = after.map;
    if (!converted) throw new Error('la conversion doit invalider la carte');
    for (let x = from.x; x <= to.x; x += 1) {
      const index = tileIndex(x, from.y, converted.width);
      expect(converted.railTypes?.[index]).toBe(1);
      expect((converted.flags[index] ?? 0) & TILE_FLAG.ELECTRIFIED).toBe(TILE_FLAG.ELECTRIFIED);
    }
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(
      -5 * railConvertCost('electrified'),
    );
    expect(engine.hash()).not.toBe(hashBefore);
    expect(after.signals ?? []).toHaveLength(1);
    expect(after.depots.every((depot) => depot.kind !== 'rail' || depot.railType)).toBe(true);
  });

  it('reste déterministe après sauvegarde/rechargement des signaux et types de rail', async () => {
    const engine = await createEngine(808);
    const map = mapOf(engine);
    const { from, to } = findPath(map, 'rail', 4);
    engine.send({
      type: 'build',
      tool: 'rail',
      company: 0,
      from,
      to,
      options: { axis: 'x', railType: 'electrified' },
    });
    engine.send({
      type: 'build',
      tool: 'signal',
      company: 0,
      from,
      options: { type: 'entry', direction: 'both' },
    });
    const hashBefore = engine.hash();
    const saved = await engine.save();

    const reloaded = new MockEngine();
    await reloaded.init({ moduleUrl: 'mock://engine' });
    await reloaded.load(saved);
    expect(reloaded.hash()).toBe(hashBefore);
    const snapshot = reloaded.snapshot();
    expect(snapshot.signals?.[0]?.kind).toBe('entry');
    const index = tileIndex(from.x, from.y, snapshot.map?.width ?? 0);
    expect(snapshot.map?.railTypes?.[index]).toBe(1);
  });
});
