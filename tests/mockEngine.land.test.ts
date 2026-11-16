import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import {
  TILE_FLAG,
  TILE_KIND_INDEX,
  TRACK_BIT_CROSSING_RAIL,
  type MapSnapshot,
} from '../src/engine/protocol';
import {
  planAqueduct,
  planBuild,
  planCanal,
  planLock,
  planTerraform,
  planTree,
  type BuildPoint,
} from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';
import { findWaterLevelBreaks, waterComponents } from '../src/game/waterLevels';

async function createEngine(seed = 158, size = 128): Promise<MockEngine> {
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

function findNatural(map: MapSnapshot): BuildPoint {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      const plan = planTerraform({
        map,
        from: { x, y },
        settings: { direction: 'up', size: 1 },
        budget: 10_000_000,
      });
      if (plan.valid) return { x, y };
    }
  }
  throw new Error('aucune tuile naturelle dans la carte de test');
}

describe('MockEngine : terrassement et arbres (#158)', () => {
  it('surélève une zone, débite le coût et invalide la carte', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    const spot = findNatural(map);
    const before = map.heightMap[tileIndex(spot.x, spot.y, map.width)] ?? 0;
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const hashBefore = engine.hash();

    engine.send({
      type: 'build',
      tool: 'terraform',
      company: 0,
      from: spot,
      options: { direction: 'up', size: 1 },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le terrassement doit invalider la carte');
    expect(built.heightMap[tileIndex(spot.x, spot.y, built.width)]).toBe(before + 1);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);
    expect(engine.hash()).not.toBe(hashBefore);
    expect(after.news.some((item) => item.text.includes('Terrassement'))).toBe(true);
  });

  it('plante une zone et laisse la végétation reconstruire ses arbres', async () => {
    const engine = await createEngine(159);
    const map = mapOf(engine);
    const spot = findNatural(map);
    const plan = planTree({ map, from: spot, settings: { size: 1 }, budget: 10_000_000 });
    expect(plan.valid).toBe(true);
    engine.send({
      type: 'build',
      tool: 'tree',
      company: 0,
      from: spot,
      options: { size: 1 },
    });
    const built = engine.snapshot().map;
    if (!built) throw new Error('la plantation doit invalider la carte');
    expect(built.kind[tileIndex(spot.x, spot.y, built.width)]).toBe(TILE_KIND_INDEX.trees);
    expect(built.owner[tileIndex(spot.x, spot.y, built.width)]).toBe(0);
  });

  it('refuse un terrassement sur l’eau sans débiter', async () => {
    const engine = await createEngine(160);
    const map = mapOf(engine);
    let water: BuildPoint | null = null;
    for (let y = 0; y < map.height && !water; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (map.kind[tileIndex(x, y, map.width)] === TILE_KIND_INDEX.water) {
          water = { x, y };
          break;
        }
      }
    }
    if (!water) throw new Error('eau absente de la carte de test');
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'terraform',
      company: 0,
      from: water,
      options: { direction: 'up', size: 1 },
    });
    const after = engine.snapshot();
    expect(after.map).toBeNull();
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.news.some((item) => item.kind === 'error' && item.text.includes('eau'))).toBe(
      true,
    );
  });
});

describe('MockEngine : canaux, écluses et aqueducs (#158)', () => {
  function findCanal(map: MapSnapshot): { from: BuildPoint; to: BuildPoint } {
    for (let y = 1; y < map.height - 1; y += 1) {
      for (let x = 1; x < map.width - 6; x += 1) {
        const plan = planCanal({
          map,
          from: { x, y },
          to: { x: x + 3, y },
          budget: 10_000_000,
        });
        if (plan.valid) return { from: { x, y }, to: { x: x + 3, y } };
      }
    }
    throw new Error('aucun canal constructible dans la carte de test');
  }

  it('creuse un canal, remplit l’eau et débite le coût', async () => {
    const engine = await createEngine(161);
    const map = mapOf(engine);
    const { from, to } = findCanal(map);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'canal',
      company: 0,
      from,
      to,
      options: { axis: 'x', order: 'horizontal' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le canal doit invalider la carte');
    for (let x = from.x; x <= to.x; x += 1) {
      const index = tileIndex(x, from.y, built.width);
      expect(built.kind[index]).toBe(TILE_KIND_INDEX.canal);
      expect(built.flags[index] ?? 0).toBe(TILE_FLAG.WATER);
      expect(built.owner[index]).toBe(0);
    }
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);
    expect(after.news.some((item) => item.text.includes('Canal'))).toBe(true);
  });

  it('pose une écluse sur un canal relié et facture le coût fixe', async () => {
    const engine = await createEngine(162);
    const map = mapOf(engine);
    const { from, to } = findCanal(map);
    engine.send({
      type: 'build',
      tool: 'canal',
      company: 0,
      from,
      to,
      options: { axis: 'x' },
    });
    const canalMap = engine.snapshot().map ?? map;
    const lockSpot = { x: from.x + 1, y: from.y };
    const lockPlan = planLock({
      map: canalMap,
      from: lockSpot,
      settings: { direction: null },
      budget: 10_000_000,
    });
    expect(lockPlan.valid).toBe(true);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'lock',
      company: 0,
      from: lockSpot,
      options: { direction: lockPlan.lock?.direction ?? 'ne' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('l’écluse doit invalider la carte');
    expect(built.kind[tileIndex(lockSpot.x, lockSpot.y, built.width)]).toBe(TILE_KIND_INDEX.lock);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);
    expect(after.news.some((item) => item.text.includes('Écluse'))).toBe(true);
  });

  it('construit un aqueduc : canaux aux têtes, tablier au milieu', async () => {
    const engine = await createEngine(163);
    const map = mapOf(engine);
    let span: { from: BuildPoint; to: BuildPoint } | null = null;
    for (let y = 1; y < map.height - 2 && !span; y += 1) {
      for (let x = 1; x < map.width - 6; x += 1) {
        const plan = planAqueduct({
          map,
          from: { x, y },
          to: { x: x + 4, y },
          budget: 10_000_000,
        });
        if (plan.valid) {
          span = { from: { x, y }, to: { x: x + 4, y } };
          break;
        }
      }
    }
    if (!span) throw new Error('aucun aqueduc constructible dans la carte de test');
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'aqueduct',
      company: 0,
      from: span.from,
      to: span.to,
      options: { axis: 'x' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('l’aqueduc doit invalider la carte');
    const startIndex = tileIndex(span.from.x, span.from.y, built.width);
    const endIndex = tileIndex(span.to.x, span.to.y, built.width);
    const middleIndex = tileIndex(span.from.x + 2, span.from.y, built.width);
    expect(built.kind[startIndex]).toBe(TILE_KIND_INDEX.canal);
    expect(built.kind[endIndex]).toBe(TILE_KIND_INDEX.canal);
    expect(built.kind[middleIndex]).toBe(TILE_KIND_INDEX.aqueduct);
    expect(built.flags[middleIndex] ?? 0).toBe(TILE_FLAG.WATER | TILE_FLAG.BRIDGE);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);

    engine.send({
      type: 'build',
      tool: 'clear',
      company: 0,
      from: { x: span.from.x + 2, y: span.from.y },
    });
    const cleared = engine.snapshot().map;
    if (!cleared) throw new Error('la démolition doit invalider la carte');
    expect(cleared.kind[middleIndex]).toBe(TILE_KIND_INDEX.grass);
    expect((cleared.flags[middleIndex] ?? 0) & TILE_FLAG.WATER).toBe(0);
  });
});

describe('MockEngine : passages à niveau (#159)', () => {
  it('transforme un rail droit en passage à niveau puis le démonte proprement', async () => {
    const engine = await createEngine(164);
    const map = mapOf(engine);
    let path: { from: BuildPoint; to: BuildPoint } | null = null;
    for (let y = 1; y < map.height - 1 && !path; y += 1) {
      for (let x = 1; x < map.width - 5; x += 1) {
        const plan = planBuild({
          map,
          tool: 'rail',
          from: { x, y },
          to: { x: x + 3, y },
          budget: 10_000_000,
        });
        if (plan.valid) {
          path = { from: { x, y }, to: { x: x + 3, y } };
          break;
        }
      }
    }
    if (!path) throw new Error('aucun rail constructible dans la carte de test');
    engine.send({ type: 'build', tool: 'rail', company: 0, from: path.from, to: path.to });
    const crossingSpot = { x: path.from.x + 1, y: path.from.y };
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'crossing',
      company: 0,
      from: crossingSpot,
      options: { axis: 'x', network: 'rail' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le passage à niveau doit invalider la carte');
    const index = tileIndex(crossingSpot.x, crossingSpot.y, built.width);
    expect(built.kind[index]).toBe(TILE_KIND_INDEX.crossing);
    expect(((built.trackBits[index] ?? 0) & TRACK_BIT_CROSSING_RAIL) !== 0).toBe(true);
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);

    engine.send({ type: 'build', tool: 'clear', company: 0, from: crossingSpot });
    const cleared = engine.snapshot().map;
    if (!cleared) throw new Error('la démolition doit invalider la carte');
    expect(cleared.kind[index]).toBe(TILE_KIND_INDEX.rail);
    expect((cleared.trackBits[index] ?? 0) & TRACK_BIT_CROSSING_RAIL).toBe(0);
  });

  it('reste déterministe pour une même suite terrassement + canal + arbres', async () => {
    const build = async (): Promise<string> => {
      const engine = await createEngine(165);
      const map = mapOf(engine);
      const spot = findNatural(map);
      engine.send({
        type: 'build',
        tool: 'terraform',
        company: 0,
        from: spot,
        options: { direction: 'down', size: 1 },
      });
      engine.send({
        type: 'build',
        tool: 'tree',
        company: 0,
        from: { x: spot.x + 1, y: spot.y },
        options: { size: 1 },
      });
      const next = engine.snapshot().map ?? map;
      const canal = planCanal({
        map: next,
        from: { x: spot.x, y: spot.y + 1 },
        to: { x: spot.x + 2, y: spot.y + 1 },
        budget: 10_000_000,
      });
      if (canal.valid) {
        engine.send({
          type: 'build',
          tool: 'canal',
          company: 0,
          from: { x: spot.x, y: spot.y + 1 },
          to: { x: spot.x + 2, y: spot.y + 1 },
          options: { axis: 'x' },
        });
      }
      return engine.hash();
    };
    expect(await build()).toBe(await build());
  });
});

describe('MockEngine : niveaux d’eau cohérents (#205)', () => {
  function findCanal(map: MapSnapshot): { from: BuildPoint; to: BuildPoint } {
    for (let y = 2; y < map.height - 2; y += 1) {
      for (let x = 2; x < map.width - 6; x += 1) {
        const plan = planCanal({
          map,
          from: { x, y },
          to: { x: x + 4, y },
          budget: 10_000_000,
        });
        if (plan.valid) return { from: { x, y }, to: { x: x + 4, y } };
      }
    }
    throw new Error('aucun canal constructible dans la carte de test');
  }

  it('génère un plan d’eau unique, sans hauteur erratique', async () => {
    for (const seed of [205, 777, 4242]) {
      const engine = await createEngine(seed);
      const map = mapOf(engine);
      const levels = new Set<number>();
      for (let index = 0; index < map.kind.length; index += 1) {
        const kind = map.kind[index] ?? 0;
        if (
          kind === TILE_KIND_INDEX.water ||
          kind === TILE_KIND_INDEX.river ||
          kind === TILE_KIND_INDEX.canal ||
          kind === TILE_KIND_INDEX.lock
        ) {
          levels.add(map.heightMap[index] ?? 0);
        }
      }
      expect([...levels]).toEqual([0]);
      expect(findWaterLevelBreaks(map)).toEqual([]);
    }
  });

  it('recolle le canal aux nappes qu’il rejoint', async () => {
    const engine = await createEngine(206);
    let map = mapOf(engine);
    const { from, to } = findCanal(map);
    engine.send({
      type: 'build',
      tool: 'canal',
      company: 0,
      from,
      to,
      options: { axis: 'x' },
    });
    map = engine.snapshot().map ?? map;
    expect(findWaterLevelBreaks(map)).toEqual([]);
    for (const component of waterComponents(map)) {
      expect(component.levels).toHaveLength(1);
    }
  });

  it('laisse l’écluse séparer deux biefs sans rupture interne', async () => {
    const engine = await createEngine(207);
    let map = mapOf(engine);
    const { from } = findCanal(map);
    engine.send({
      type: 'build',
      tool: 'canal',
      company: 0,
      from,
      to: { x: from.x + 4, y: from.y },
      options: { axis: 'x' },
    });
    map = engine.snapshot().map ?? map;
    const lockSpot = { x: from.x + 2, y: from.y };
    const lockPlan = planLock({
      map,
      from: lockSpot,
      settings: { direction: null },
      budget: 10_000_000,
    });
    expect(lockPlan.valid).toBe(true);
    engine.send({
      type: 'build',
      tool: 'lock',
      company: 0,
      from: lockSpot,
      options: { direction: lockPlan.lock?.direction ?? 'ne' },
    });
    map = engine.snapshot().map ?? map;
    expect(map.kind[tileIndex(lockSpot.x, lockSpot.y, map.width)]).toBe(TILE_KIND_INDEX.lock);
    // L'écluse est exclue des ruptures : chaque bief reste d'un seul tenant.
    expect(findWaterLevelBreaks(map)).toEqual([]);
    for (const component of waterComponents(map)) {
      expect(component.levels).toHaveLength(1);
    }
  });

  it('reste déterministe après normalisation', async () => {
    const build = async (): Promise<string> => {
      const engine = await createEngine(208);
      const map = mapOf(engine);
      const { from, to } = findCanal(map);
      engine.send({
        type: 'build',
        tool: 'canal',
        company: 0,
        from,
        to,
        options: { axis: 'x' },
      });
      return engine.hash();
    };
    expect(await build()).toBe(await build());
  });
});
