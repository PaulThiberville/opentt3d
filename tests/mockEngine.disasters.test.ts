import { describe, expect, it } from 'vitest';
import { MockEngine, TICKS_PER_DAY } from '../src/engine/MockEngine';
import type { NewGameOptions, WorldSnapshot } from '../src/engine/protocol';

async function createEngine(options: Partial<NewGameOptions> = {}): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({
    seed: 4242,
    width: 128,
    height: 128,
    aiCompanies: 1,
    difficulty: 1,
    ...options,
  });
  return engine;
}

function run(engine: MockEngine, ticks: number): void {
  let remaining = ticks;
  while (remaining > 0) {
    const done = engine.step(Math.min(240, remaining));
    if (done <= 0) break;
    remaining -= done;
  }
}

/** Avance jusqu'au premier désastre actif (ou 500 jours). */
function advanceToDisaster(engine: MockEngine): {
  snapshot: WorldSnapshot;
  news: WorldSnapshot['news'];
} {
  const news: WorldSnapshot['news'] = [];
  for (let day = 0; day < 500; day += 1) {
    run(engine, TICKS_PER_DAY);
    const snapshot = engine.snapshot();
    news.push(...snapshot.news);
    if ((snapshot.disasters ?? []).length > 0) return { snapshot, news };
  }
  throw new Error('aucun désastre déclenché en 500 jours');
}

describe('MockEngine : désastres optionnels (#172)', () => {
  it('ne déclenche rien par défaut', async () => {
    const engine = await createEngine({ difficulty: 3 });
    const news: WorldSnapshot['news'] = [];
    for (let day = 0; day < 120; day += 1) {
      run(engine, TICKS_PER_DAY);
      news.push(...engine.snapshot().news);
    }
    expect(engine.snapshot().disasters).toEqual([]);
    expect(
      news.some((item) => /Incendie|accident|Déraillement|Crash aérien/i.test(item.text)),
    ).toBe(false);
  });

  it('déclenche incendies, accidents ou crashes avec l’option', async () => {
    const engine = await createEngine({ difficulty: 3, disasters: true });
    const { snapshot, news } = advanceToDisaster(engine);
    const disaster = snapshot.disasters?.[0];
    expect(disaster).toBeDefined();
    if (!disaster) return;
    expect(['fire', 'road_accident', 'train_crash', 'aircraft_crash']).toContain(disaster.kind);
    expect(disaster.severity).toBeGreaterThanOrEqual(1);
    expect(disaster.severity).toBeLessThanOrEqual(3);
    expect(disaster.remainingDays).toBeGreaterThan(0);
    expect(news.some((item) => /gravité/i.test(item.text))).toBe(true);
  });

  it('reste déterministe avec la même graine et la même difficulté', async () => {
    const a = await createEngine({ difficulty: 2, disasters: true });
    const b = await createEngine({ difficulty: 2, disasters: true });
    for (let day = 0; day < 160; day += 1) {
      run(a, TICKS_PER_DAY);
      run(b, TICKS_PER_DAY);
      const snapA = a.snapshot();
      const snapB = b.snapshot();
      expect(snapA.disasters?.map((item) => [item.id, item.kind, item.remainingDays])).toEqual(
        snapB.disasters?.map((item) => [item.id, item.kind, item.remainingDays]),
      );
    }
    expect(a.hash()).toBe(b.hash());
  });

  it('conserve un désastre actif après sauvegarde et chargement', async () => {
    const engine = await createEngine({ difficulty: 3, disasters: true });
    advanceToDisaster(engine);
    engine.snapshot();
    const before = engine.hash();
    const saved = await engine.save();
    const restored = new MockEngine();
    await restored.load(saved);
    expect(restored.hash()).toBe(before);
    expect(restored.snapshot().disasters).toEqual(engine.snapshot().disasters);
    run(engine, 10 * TICKS_PER_DAY);
    run(restored, 10 * TICKS_PER_DAY);
    expect(restored.hash()).toBe(engine.hash());
  });
});
