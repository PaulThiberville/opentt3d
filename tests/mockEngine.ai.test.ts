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

function ai(snapshot: WorldSnapshot) {
  return snapshot.companies.find((company) => company.isAI);
}

describe('MockEngine : IA concurrentes (#168)', () => {
  it('expose un niveau et un budget aux entreprises IA', async () => {
    const engine = await createEngine();
    run(engine, TICKS_PER_DAY);
    const snapshot = engine.snapshot();
    const company = ai(snapshot);
    expect(company).toBeDefined();
    expect(company?.aiLevel).toBe(1);
    expect(company?.vehicles).toBeGreaterThan(0);
    expect(company?.stations).toBeGreaterThan(0);
    expect(company?.isLocal).toBe(false);
  });

  it('construit une liaison supplémentaire de façon autonome', async () => {
    const engine = await createEngine();
    const before = engine.snapshot();
    const companyBefore = ai(before);
    if (!companyBefore) throw new Error('IA absente');
    run(engine, 20 * TICKS_PER_DAY);
    const after = engine.snapshot();
    const companyAfter = ai(after);
    if (!companyAfter) throw new Error('IA disparue');
    expect(companyAfter.stations).toBeGreaterThan(companyBefore.stations);
    expect(companyAfter.vehicles).toBeGreaterThan(companyBefore.vehicles);
    expect(after.events.some((event) => event.type === 'vehicle_departed')).toBe(true);
  });

  it('donne un niveau supérieur aux IA des parties difficiles', async () => {
    const easy = (await createEngine({ difficulty: 0 })).snapshot();
    const expert = (await createEngine({ difficulty: 3 })).snapshot();
    expect(ai(easy)?.aiLevel).toBe(1);
    expect(ai(expert)?.aiLevel).toBe(3);
  });

  it('reste déterministe avec trois IA', async () => {
    const options = { aiCompanies: 3, difficulty: 2 } as const;
    const a = await createEngine(options);
    const b = await createEngine(options);
    const initial = a.snapshot();
    expect(initial.companies.filter((company) => company.isAI)).toHaveLength(3);
    run(a, 15 * TICKS_PER_DAY);
    run(b, 15 * TICKS_PER_DAY);
    expect(a.hash()).toBe(b.hash());
    const snapA = a.snapshot();
    const snapB = b.snapshot();
    expect(snapA.companies.map((company) => [company.aiLevel, company.vehicles])).toEqual(
      snapB.companies.map((company) => [company.aiLevel, company.vehicles]),
    );
  });

  it('conserve les chantiers IA après une sauvegarde', async () => {
    const engine = await createEngine();
    run(engine, 20 * TICKS_PER_DAY);
    engine.snapshot();
    const before = engine.hash();
    const saved = await engine.save();
    const restored = new MockEngine();
    await restored.load(saved);
    expect(restored.hash()).toBe(before);
    expect(ai(restored.snapshot())?.stations).toBe(ai(engine.snapshot())?.stations);
    run(engine, 5 * TICKS_PER_DAY);
    run(restored, 5 * TICKS_PER_DAY);
    expect(restored.hash()).toBe(engine.hash());
  });

  it('met une IA en faillite et arrête ses chantiers', async () => {
    const engine = await createEngine();
    const saved = await engine.save();
    const parsed = JSON.parse(new TextDecoder().decode(saved)) as {
      world: { companies: { isAI: boolean; money: number; loan: number; maxLoan: number }[] };
    };
    const company = parsed.world.companies.find((item) => item.isAI);
    if (!company) throw new Error('IA absente de la sauvegarde');
    company.money = -50_000_000;
    company.loan = company.maxLoan;
    const restored = new MockEngine();
    await restored.load(new TextEncoder().encode(JSON.stringify(parsed)));
    run(restored, 400 * TICKS_PER_DAY);
    const after = ai(restored.snapshot());
    expect(after?.bankrupt).toBe(true);
    const frozen = { stations: after?.stations ?? 0, vehicles: after?.vehicles ?? 0 };
    run(restored, 100 * TICKS_PER_DAY);
    const later = ai(restored.snapshot());
    expect(later?.stations).toBe(frozen.stations);
    expect(later?.vehicles).toBe(frozen.vehicles);
  });
});
