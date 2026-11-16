import { describe, expect, it } from 'vitest';
import { MockEngine, TICKS_PER_DAY } from '../src/engine/MockEngine';
import type { WorldSnapshot } from '../src/engine/protocol';

async function createEngine(seed = 4242, difficulty = 1): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: 128, height: 128, difficulty });
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

function localCompany(snapshot: WorldSnapshot) {
  return snapshot.companies.find((company) => company.isLocal) ?? snapshot.companies[0]!;
}

describe('MockEngine : prêts et économie (#165)', () => {
  it('expose inflation, difficulté, intérêt et plafond de prêt', async () => {
    const snapshot = (await createEngine()).snapshot();
    expect(snapshot.economy.inflation).toBe(0);
    expect(snapshot.economy.difficulty).toBe(1);
    expect(snapshot.economy.interestRate).toBeGreaterThan(0);
    expect(snapshot.economy.loanInterval).toBe(50_000);
    const company = localCompany(snapshot);
    expect(company.loan).toBeGreaterThan(0);
    expect(company.maxLoan).toBeGreaterThan(company.loan);
    expect(company.monthsOfBankruptcy).toBe(0);
  });

  it('emprunte et rembourse par pas sans dépasser le plafond', async () => {
    const engine = await createEngine();
    const before = engine.snapshot();
    const companyBefore = localCompany(before);
    engine.send({ type: 'finance', action: 'increase_loan', company: 0, amount: 50_000 });
    const afterIncrease = engine.snapshot();
    const companyAfter = localCompany(afterIncrease);
    expect(companyAfter.loan).toBe(companyBefore.loan + 50_000);
    expect(companyAfter.money).toBe(companyBefore.money + 50_000);
    expect(afterIncrease.events.some((event) => event.type === 'loan_changed')).toBe(true);

    engine.send({ type: 'finance', action: 'decrease_loan', company: 0, amount: 50_000 });
    const restored = localCompany(engine.snapshot());
    expect(restored.loan).toBe(companyBefore.loan);
    expect(restored.money).toBe(companyBefore.money);
  });

  it('refuse un remboursement sans dette et un emprunt au-delà du plafond', async () => {
    const engine = await createEngine();
    const snapshot = engine.snapshot();
    const company = localCompany(snapshot);
    engine.send({
      type: 'finance',
      action: 'increase_loan',
      company: 0,
      amount: (company.maxLoan ?? 0) + 100_000,
    });
    const after = engine.snapshot();
    expect(localCompany(after).loan).toBeLessThanOrEqual(company.maxLoan ?? 0);
    expect(after.news.some((item) => item.kind === 'info' || item.kind === 'error')).toBe(true);

    // Rembourse tout, puis vérifie qu'un nouveau remboursement est refusé.
    engine.send({
      type: 'finance',
      action: 'decrease_loan',
      company: 0,
      amount: 10_000_000,
    });
    expect(localCompany(engine.snapshot()).loan).toBe(0);
    engine.send({ type: 'finance', action: 'decrease_loan', company: 0, amount: 50_000 });
    expect(engine.snapshot().news.some((item) => item.text.includes('aucun prêt'))).toBe(true);
  });

  it('fait évoluer l’inflation au fil des années', async () => {
    const engine = await createEngine(77);
    run(engine, 30 * 12 * TICKS_PER_DAY);
    const snapshot = engine.snapshot();
    expect(snapshot.economy.inflation ?? 0).toBeGreaterThan(0);
    const company = localCompany(snapshot);
    expect(company.maxLoan ?? 0).toBeGreaterThan(0);
  });
});

describe('MockEngine : autorité locale (#166)', () => {
  it('expose les actions municipales avec un coût et une disponibilité', async () => {
    const snapshot = (await createEngine()).snapshot();
    const town = snapshot.towns[0];
    expect(town?.authority).toBeDefined();
    if (!town?.authority) return;
    expect(town.authority.rating).toBeGreaterThanOrEqual(0);
    for (const action of ['advertise', 'fund_roads', 'fund_buildings'] as const) {
      expect(town.authority.actions[action].cost).toBeGreaterThan(0);
      expect(town.authority.actions[action].available).toBe(true);
    }
  });

  it('débite le coût, améliore la ville et verrouille l’action pour le mois', async () => {
    const engine = await createEngine(5150);
    const before = engine.snapshot();
    const town = before.towns[0];
    if (!town?.authority) throw new Error('autorité absente');
    const moneyBefore = localCompany(before).money;
    const cost = town.authority.actions.fund_roads.cost;
    const growthBefore = town.growthRate;

    engine.send({ type: 'town_action', action: 'fund_roads', company: 0, town: town.id });
    const after = engine.snapshot();
    const updated = after.towns[0];
    expect(updated).toBeDefined();
    expect(localCompany(after).money).toBe(moneyBefore - cost);
    expect(updated?.growthRate ?? 0).toBeGreaterThanOrEqual(growthBefore);
    expect(updated?.authority?.actions.fund_roads.available).toBe(false);
    expect(after.events.some((event) => event.type === 'town_action')).toBe(true);

    const moneyAfter = localCompany(after).money;
    engine.send({ type: 'town_action', action: 'fund_roads', company: 0, town: town.id });
    const rejected = engine.snapshot();
    expect(localCompany(rejected).money).toBe(moneyAfter);
    expect(rejected.news.some((item) => item.text.includes('déjà été financée'))).toBe(true);
  });
});

describe('MockEngine : subventions et chaînes cargo (#167)', () => {
  it('propose des subventions cohérentes entre industries', async () => {
    const snapshot = (await createEngine()).snapshot();
    expect(snapshot.subsidies?.length).toBeGreaterThan(0);
    for (const subsidy of snapshot.subsidies ?? []) {
      expect(subsidy.cargo).not.toBe('');
      expect(subsidy.from).not.toBe('—');
      expect(subsidy.to).not.toBe('—');
      expect(subsidy.remainingMonths).toBeGreaterThan(0);
      expect(subsidy.awardedTo).toBeNull();
    }
  });

  it('transporte effectivement la cargaison et attribue une subvention', async () => {
    const engine = await createEngine(909);
    run(engine, 6 * 30 * TICKS_PER_DAY);
    const snapshot = engine.snapshot();
    const serviced = snapshot.industries.filter((industry) => (industry.transported ?? 0) > 0);
    expect(serviced.length).toBeGreaterThan(0);
    const awarded = (snapshot.subsidies ?? []).filter((subsidy) => subsidy.awardedTo !== null);
    expect(awarded.length).toBeGreaterThan(0);
    expect(awarded[0]?.awardedTo).toBeLessThanOrEqual(1);
  });

  it('expose un taux de service et des cargaisons acceptées', async () => {
    const snapshot = (await createEngine()).snapshot();
    const power = snapshot.industries.find((industry) => industry.accepts?.includes('coal'));
    expect(power).toBeDefined();
    expect(power?.serviceRate).toBeGreaterThanOrEqual(0);
    expect(power?.serviceRate).toBeLessThanOrEqual(100);
  });
});
