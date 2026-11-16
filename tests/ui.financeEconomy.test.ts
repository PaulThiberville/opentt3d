import { afterEach, describe, expect, it } from 'vitest';
import type { WorldSnapshot } from '../src/engine/protocol';
import { resetI18n, setLanguage } from '../src/ui/i18n';
import { describeBankruptcyAlert, describeFinanceView } from '../src/ui/financeView';
import { describeIndustryPanel, describeTownPanel } from '../src/ui/placeView';

function snapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    meta: { protocol: 1, tick: 1200, hash: 'abc', sequence: 1 },
    economy: {
      year: 1950,
      month: 5,
      day: 12,
      dayFraction: 0,
      speed: 1,
      paused: false,
      inflation: 7.5,
      difficulty: 2,
      interestRate: 6,
      maxLoan: 450_000,
      loanInterval: 50_000,
    },
    map: null,
    companies: [
      {
        id: 0,
        name: 'Transports Valmont',
        president: 'A. Martin',
        colour: 3,
        money: 320_000,
        loan: 180_000,
        maxLoan: 450_000,
        value: 1_250_000,
        income: 42_000,
        expenses: 31_000,
        vehicles: 6,
        stations: 2,
        isAI: false,
        isLocal: true,
        bankrupt: false,
        monthsOfBankruptcy: 0,
      },
      {
        id: 1,
        name: 'Ligne du Lac',
        president: 'IA',
        colour: 4,
        money: 900_000,
        loan: 0,
        maxLoan: 450_000,
        value: 1_800_000,
        income: 12_000,
        expenses: 8_000,
        vehicles: 4,
        stations: 2,
        isAI: true,
        isLocal: false,
        bankrupt: false,
        monthsOfBankruptcy: 0,
      },
    ],
    towns: [
      {
        id: 0,
        name: 'Valmont',
        x: 10.5,
        y: 10.5,
        population: 1200,
        growthRate: 2,
        buildings: 48,
        rating: 68,
        authority: {
          rating: 68,
          actions: {
            advertise: { available: true, cost: 22_500 },
            fund_roads: { available: true, cost: 56_250 },
            fund_buildings: { available: false, cost: 90_000 },
          },
        },
      },
    ],
    industries: [
      {
        id: 0,
        name: 'Mine de Valmont',
        kind: 'coal_mine',
        x: 20.5,
        y: 20.5,
        production: 320,
        transported: 210,
        serviceRate: 65.6,
        accepts: [],
        stocks: [{ cargo: 'coal', amount: 180 }],
      },
      {
        id: 1,
        name: 'Centrale',
        kind: 'power_station',
        x: 30.5,
        y: 20.5,
        production: 0,
        transported: 0,
        serviceRate: 0,
        accepts: ['coal'],
        stocks: [],
      },
    ],
    stations: [],
    depots: [],
    vehicles: [],
    subsidies: [
      {
        id: 0,
        cargo: 'coal',
        from: 'Mine de Valmont',
        to: 'Centrale',
        fromKind: 'industry',
        toKind: 'industry',
        remainingMonths: 9,
        awardedTo: 0,
      },
      {
        id: 1,
        cargo: 'grain',
        from: 'Ferme',
        to: 'Usine',
        fromKind: 'industry',
        toKind: 'industry',
        remainingMonths: 11,
        awardedTo: null,
      },
      {
        id: 2,
        cargo: 'bois',
        from: 'Scierie',
        to: 'Usine',
        fromKind: 'industry',
        toKind: 'industry',
        remainingMonths: 8,
        awardedTo: 1,
      },
    ],
    news: [],
    events: [],
    ...overrides,
  };
}

afterEach(() => {
  resetI18n();
});

describe('panneau finances (#165)', () => {
  it('formate les montants, l’inflation et les contrôles de prêt', () => {
    const view = describeFinanceView(snapshot(), 0);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.company).toBe('Transports Valmont');
    expect(view.money).toContain('320');
    expect(view.loan).toContain('180');
    expect(view.maxLoan).toContain('450');
    expect(view.value).toContain('1');
    expect(view.interestRate).toBe('6,0 %');
    expect(view.inflation).toBe('7,5 %');
    expect(view.difficulty).toBe('Difficile');
    expect(view.canIncrease).toBe(true);
    expect(view.canDecrease).toBe(true);
    expect(view.increaseLabel).toContain('50');
    expect(view.warning).toBeNull();
  });

  it('désactive le remboursement sans trésorerie et l’emprunt au plafond', () => {
    const base = snapshot();
    const company = base.companies[0];
    if (!company) throw new Error('fixture sans entreprise');
    const view = describeFinanceView(
      {
        ...base,
        companies: [{ ...company, money: 0, loan: 450_000 }],
      },
      0,
    );
    expect(view?.canIncrease).toBe(false);
    expect(view?.canDecrease).toBe(false);
  });

  it('borne et filtre l’historique du graphique', () => {
    const history = Array.from({ length: 80 }, (_, index) => ({
      money: index * 1_000,
      value: index * 2_000,
    }));
    history.push({ money: Number.NaN, value: 10 });
    const view = describeFinanceView(snapshot(), 0, history);
    expect(view?.history).toHaveLength(60);
    expect(view?.history.at(-1)?.money).toBe(79_000);
    expect(view?.history.every((point) => Number.isFinite(point.money))).toBe(true);
  });

  it('trie les subventions : attribuée, offre, concurrente', () => {
    const view = describeFinanceView(snapshot(), 0);
    expect(view?.subsidies.map((subsidy) => subsidy.state)).toEqual([
      'awarded',
      'offer',
      'foreign',
    ]);
    expect(view?.subsidies[0]?.tone).toBe('good');
    expect(view?.subsidies[1]?.detail).toContain('Ferme');
  });

  it('alerte avant la faillite puis en erreur au seuil critique', () => {
    const base = snapshot();
    const company = base.companies[0];
    if (!company) throw new Error('fixture sans entreprise');
    const warning = describeBankruptcyAlert(
      {
        ...base,
        companies: [{ ...company, money: -12_000, monthsOfBankruptcy: 3 }],
      },
      0,
    );
    expect(warning?.tone).toBe('warning');
    expect(warning?.text).toContain('3 mois');
    const critical = describeBankruptcyAlert(
      {
        ...base,
        companies: [{ ...company, money: -12_000, monthsOfBankruptcy: 5 }],
      },
      0,
    );
    expect(critical?.tone).toBe('error');
    const bankrupt = describeBankruptcyAlert(
      {
        ...base,
        companies: [{ ...company, bankrupt: true, money: -90_000, monthsOfBankruptcy: 6 }],
      },
      0,
    );
    expect(bankrupt?.text).toContain('Faillite');
    expect(describeBankruptcyAlert(snapshot(), 0)).toBeNull();
  });

  it('traduit le panneau en anglais', () => {
    setLanguage('en', { storage: null });
    const view = describeFinanceView(snapshot(), 0);
    expect(view?.company).toBe('Transports Valmont');
    expect(view?.difficulty).toBe('Hard');
    expect(view?.increaseLabel).toContain('Borrow');
    expect(view?.subsidies[1]?.title).toContain('Offer');
  });
});

describe('autorité locale dans le panneau ville (#166)', () => {
  it('expose trois actions payantes et leurs disponibilités', () => {
    const view = describeTownPanel(snapshot(), 0);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.actions.map((action) => action.kind)).toEqual(['focus', 'town', 'town', 'town']);
    const roads = view.actions.find((action) => action.townAction === 'fund_roads');
    expect(roads?.supported).toBe(true);
    expect(roads?.label).toContain('56');
    const buildings = view.actions.find((action) => action.townAction === 'fund_buildings');
    expect(buildings?.supported).toBe(false);
    expect(buildings?.reason).toContain('déjà');
  });

  it('retombe sur l’action historique quand le snapshot n’a pas d’autorité', () => {
    const base = snapshot();
    const town = base.towns[0];
    if (!town) throw new Error('fixture sans ville');
    const view = describeTownPanel({ ...base, towns: [{ ...town, authority: undefined }] }, 0);
    expect(view?.actions.map((action) => action.kind)).toEqual(['focus', 'unsupported']);
  });
});

describe('chaînes cargo dans le panneau industrie (#167)', () => {
  it('affiche le taux de service et les cargaisons acceptées', () => {
    const view = describeIndustryPanel(snapshot(), 1);
    expect(view).not.toBeNull();
    if (!view) return;
    const service = view.stats.find((entry) => entry.label === 'Taux de service');
    expect(service?.value).toBe('0 %');
    const accepts = view.sections.find((section) => section.id === 'accepts');
    expect(accepts?.items.map((item) => item.label)).toEqual(['Charbon']);
  });

  it('affiche un taux de service élevé en tone positif', () => {
    const view = describeIndustryPanel(snapshot(), 0);
    const service = view?.stats.find((entry) => entry.label === 'Taux de service');
    expect(service?.value).toBe('66 %');
    expect(service?.tone).toBe('good');
  });
});
