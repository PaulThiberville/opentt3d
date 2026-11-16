import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import { TILE_FLAG, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { planBridge, planBuild, type BuildPoint } from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';

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

/** Première paire de tuiles constructible, trouvée avec les règles partagées. */
function findRoadPair(map: MapSnapshot, length = 3): { from: BuildPoint; to: BuildPoint } {
  return findPath(map, 'road', length);
}

function findPath(
  map: MapSnapshot,
  tool: 'road' | 'rail',
  length = 3,
): { from: BuildPoint; to: BuildPoint } {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - length - 1; x += 1) {
      const from = { x, y };
      const to = { x: x + length - 1, y };
      const plan = planBuild({ map, tool, from, to, budget: 10_000_000 });
      if (plan.valid) return { from, to };
    }
  }
  throw new Error('aucune tuile constructible dans la carte de test');
}

function findKind(map: MapSnapshot, kind: number): BuildPoint {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (map.kind[tileIndex(x, y, map.width)] === kind) return { x, y };
    }
  }
  throw new Error('type de tuile absent de la carte');
}

describe('MockEngine : construction', () => {
  it('construit une route, débite le coût et met la carte à jour', async () => {
    const engine = await createEngine();
    const before = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const { from, to } = findRoadPair(before);
    const hashBefore = engine.hash();

    engine.send({ type: 'build', tool: 'road', company: 0, from, to, options: { axis: 'x' } });
    const after = engine.snapshot();
    const map = after.map;
    if (!map) throw new Error('la construction doit invalider la carte');

    for (let x = from.x; x <= to.x; x += 1) {
      const index = tileIndex(x, from.y, map.width);
      expect(map.kind[index]).toBe(TILE_KIND_INDEX.road);
      expect(map.owner[index]).toBe(0);
      expect(map.trackBits[index]).toBeGreaterThan(0);
    }
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-3 * 120);
    expect(engine.hash()).not.toBe(hashBefore);
    expect(after.news.some((item) => item.kind === 'info' && item.text.includes('Route'))).toBe(
      true,
    );
  });

  it('construit un rail et respecte l’axe Y du tracé', async () => {
    const engine = await createEngine(77);
    const map = mapOf(engine);
    const { from, to } = findPath(map, 'rail', 5);
    const plan = planBuild({ map, tool: 'rail', from, to, axis: 'x' });
    expect(plan.valid).toBe(true);

    engine.send({ type: 'build', tool: 'rail', company: 0, from, to, options: { axis: 'x' } });
    const built = engine.snapshot().map;
    if (!built) throw new Error('carte attendue');
    for (let x = from.x; x <= to.x; x += 1) {
      expect(built.kind[tileIndex(x, from.y, built.width)]).toBe(TILE_KIND_INDEX.rail);
    }
  });

  it('refuse une commande invalide sans modifier la carte ni l’argent', async () => {
    const engine = await createEngine(99);
    const map = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    const water = findKind(map, TILE_KIND_INDEX.water);

    engine.send({ type: 'build', tool: 'road', company: 0, from: water });
    const after = engine.snapshot();
    expect(after.map).toBeNull();
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.news.some((item) => item.kind === 'error' && item.text.includes('eau'))).toBe(
      true,
    );
  });

  it('démolit une voie construite', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    const { from, to } = findRoadPair(map);
    engine.send({ type: 'build', tool: 'road', company: 0, from, to });
    engine.snapshot();

    engine.send({ type: 'build', tool: 'clear', company: 0, from, to });
    const cleared = engine.snapshot().map;
    if (!cleared) throw new Error('la démolition doit invalider la carte');
    expect(cleared.kind[tileIndex(from.x, from.y, cleared.width)]).toBe(TILE_KIND_INDEX.grass);
    expect(cleared.trackBits[tileIndex(from.x, from.y, cleared.width)]).toBe(0);
  });

  it('construit un pont et le démolit', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    // Première paire de culées acceptée par les règles partagées.
    let spot: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
    for (let y = 2; y < map.height - 2 && !spot; y += 1) {
      for (let x = 2; x < map.width - 6 && !spot; x += 1) {
        for (let span = 2; span <= 8 && !spot; span += 1) {
          const plan = planBridge({
            map,
            from: { x, y },
            to: { x: x + span, y },
            settings: { kind: 'rail', material: 'wood' },
            budget: 10_000_000,
          });
          if (plan.valid) {
            spot = { from: { x, y }, to: { x: x + span, y } };
          }
        }
      }
    }
    if (!spot) throw new Error('aucun site de pont dans la carte de test');
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'bridge',
      company: 0,
      from: spot.from,
      to: spot.to,
      options: { kind: 'rail', material: 'wood' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le pont doit invalider la carte');
    for (let x = spot.from.x; x <= spot.to.x; x += 1) {
      const index = tileIndex(x, spot.from.y, built.width);
      expect((built.flags[index] ?? 0) & TILE_FLAG.BRIDGE).toBe(TILE_FLAG.BRIDGE);
    }
    expect(built.kind[tileIndex(spot.from.x, spot.from.y, built.width)]).toBe(
      TILE_KIND_INDEX.bridge,
    );
    expect(built.kind[tileIndex(spot.to.x, spot.to.y, built.width)]).toBe(TILE_KIND_INDEX.bridge);
    expect(after.structures?.[0]).toMatchObject({ kind: 'bridge', material: 'wood', company: 0 });
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBeLessThan(0);
    expect(after.news.some((item) => item.text.includes('Pont en bois construit'))).toBe(true);

    engine.send({ type: 'build', tool: 'clear', company: 0, from: spot.from, to: spot.to });
    const cleared = engine.snapshot();
    expect(cleared.structures).toEqual([]);
    const restored = cleared.map;
    if (!restored) throw new Error('la démolition doit invalider la carte');
    expect(restored.kind[tileIndex(spot.from.x, spot.from.y, restored.width)]).toBe(
      map.kind[tileIndex(spot.from.x, spot.from.y, map.width)],
    );
  });

  it('reste déterministe pour une même suite de commandes', async () => {
    const a = await createEngine(2024);
    const b = await createEngine(2024);
    const map = mapOf(a);
    mapOf(b);
    const { from, to } = findRoadPair(map);
    for (const engine of [a, b]) {
      engine.send({ type: 'build', tool: 'road', company: 0, from, to, options: { axis: 'x' } });
      engine.send({ type: 'build', tool: 'clear', company: 0, from, to });
    }
    expect(a.hash()).toBe(b.hash());
  });
});
