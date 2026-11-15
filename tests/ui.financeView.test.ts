import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type CompanySnapshot, type WorldSnapshot } from '../src/engine/protocol';
import {
  companyShares,
  describeFinancePanel,
  financeChartLabel,
  localCompany,
  sanitizeHistory,
} from '../src/ui/financeView';
import { resetI18n, setLanguage } from '../src/ui/i18n';
import type { FinanceHistoryPoint } from '../src/ui/types';

function company(overrides: Partial<CompanySnapshot> = {}): CompanySnapshot {
  return {
    id: 0,
    name: 'Transports du Nord',
    president: 'A. Martin',
    colour: 8,
    money: 120_000,
    loan: 50_000,
    value: 300_000,
    income: 40_000,
    expenses: 25_000,
    vehicles: 3,
    stations: 2,
    isAI: false,
    isLocal: true,
    bankrupt: false,
    ...overrides,
  };
}

function snapshot(companies: CompanySnapshot[]): WorldSnapshot {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 42, hash: 'abc', sequence: 2 },
    economy: { year: 1950, month: 2, day: 4, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies,
    towns: [],
    industries: [],
    stations: [],
    depots: [],
    vehicles: [],
    news: [],
    events: [],
  };
}

function extendedCompany(extra: Record<string, unknown>, overrides: Partial<CompanySnapshot> = {}) {
  return Object.assign(company(overrides), extra) as CompanySnapshot;
}

beforeEach(() => {
  resetI18n();
  setLanguage('fr', { storage: null });
});

afterEach(() => {
  resetI18n();
});

describe('panneau finances', () => {
  it('affiche les agrégats du protocole v1 et signale le détail absent', () => {
    const view = describeFinancePanel(snapshot([company()]));
    expect(view.companyName).toBe('Transports du Nord');
    expect(view.moneyLabel).toContain('120');
    expect(view.loanLabel).toContain('50');
    expect(view.result).toBe(15_000);
    expect(view.resultTone).toBe('good');
    expect(view.breakdownAvailable).toBe(false);
    expect(view.revenue).toEqual([
      expect.objectContaining({ id: 'revenue', label: 'Revenus', amount: 40_000 }),
    ]);
    expect(view.expensesByCategory).toEqual([
      expect.objectContaining({ id: 'expenses', label: 'Dépenses', amount: 25_000 }),
    ]);
    expect(view.actions.every((action) => !action.supported)).toBe(true);
    expect(view.actions[0]?.reason).toContain('protocole v1');
    expect(view.hint).toContain('agrégés');
  });

  it('normalise un détail par catégories en tableau et en objet', () => {
    const view = describeFinancePanel(
      snapshot([
        extendedCompany({
          finance: {
            revenue: [
              { id: 'passengers', amount: 9_000 },
              { key: 'goods', label: 'Fret', value: 3_000 },
            ],
            expenses: { vehicle_running: 1_200, loan_interest: 300 },
            loanLimit: 500_000,
            interestRate: 3.5,
          },
        }),
      ]),
    );
    expect(view.breakdownAvailable).toBe(true);
    expect(view.revenue.map((row) => row.label)).toEqual(['Voyageurs', 'Fret']);
    expect(view.revenue.map((row) => row.amount)).toEqual([9_000, 3_000]);
    expect(view.revenue[0]?.percent).toBe(100);
    expect(view.revenue[1]?.percent).toBeCloseTo(33.33, 1);
    expect(view.expensesByCategory.map((row) => row.label)).toEqual([
      'Exploitation des véhicules',
      'Intérêts d’emprunt',
    ]);
    expect(view.loanLimitLabel).toContain('500');
    expect(view.interestRateLabel).toContain('3,5');
  });

  it('accepte les catégories au niveau entreprise et ignore les montants invalides', () => {
    const view = describeFinancePanel(
      snapshot([
        extendedCompany({
          incomeBreakdown: { passengers: 100, mail: Number.NaN, goods: 50 },
          expenseBreakdown: [{ id: 'infrastructure', amount: 25 }],
        }),
      ]),
    );
    expect(view.revenue.map((row) => row.id)).toEqual(['passengers', 'goods']);
    expect(view.expensesByCategory[0]?.label).toBe('Infrastructures');
  });

  it('tolère les champs absents sans inventer de valeur', () => {
    const raw = {
      id: 4,
      name: '',
      colour: 3,
      isLocal: true,
      bankrupt: false,
    } as unknown as CompanySnapshot;
    const view = describeFinancePanel(snapshot([raw]));
    expect(view.companyName).toBe('Entreprise inconnue');
    expect(view.money).toBeNull();
    expect(view.moneyLabel).toBe('—');
    expect(view.incomeLabel).toBe('—');
    expect(view.result).toBeNull();
    expect(view.revenue).toEqual([]);
    expect(view.breakdownAvailable).toBe(false);
  });

  it('classe les entreprises par valeur et calcule les parts', () => {
    const view = describeFinancePanel(
      snapshot([
        company({ id: 0, name: 'Local', value: 100, isLocal: true }),
        company({ id: 1, name: 'Rivale', value: 300, isLocal: false }),
        company({ id: 2, name: 'Petite', value: 100, isLocal: false }),
      ]),
    );
    expect(view.ranking.map((row) => row.name)).toEqual(['Rivale', 'Local', 'Petite']);
    expect(view.ranking[0]?.share).toBe(60);
    expect(view.ranking[1]?.share).toBe(20);
    expect(view.ranking[1]?.isLocal).toBe(true);
    expect(companyShares(snapshot([company({ value: 0 })])).at(0)?.share).toBeNull();
  });

  it('alerte sur faillite, trésorerie négative et déficit', () => {
    const local = company({
      money: -2_000,
      income: 1_000,
      expenses: 4_000,
      isLocal: true,
    });
    const bankrupt = company({ id: 2, name: 'Faillie', bankrupt: true, isLocal: false });
    const view = describeFinancePanel(snapshot([local, bankrupt]));
    expect(view.alerts.map((alert) => alert.id)).toEqual([
      'bankrupt-2',
      'negative-cash',
      'deficit',
    ]);
    expect(view.alerts[0]?.tone).toBe('error');
    expect(view.alerts[2]?.detail).toContain('3');
  });

  it('préfère l’entreprise locale et retombe sur la première', () => {
    const other = company({ id: 1, isLocal: false });
    const local = company({ id: 2, isLocal: true });
    expect(localCompany(snapshot([other, local]))?.id).toBe(2);
    expect(localCompany(snapshot([company({ id: 5, isLocal: false })]))?.id).toBe(5);
    expect(localCompany(null)).toBeNull();
  });

  it('nettoie l’historique et décrit le graphique', () => {
    const history: FinanceHistoryPoint[] = [
      { tick: 1, money: 100, income: 10, expenses: 5 },
      { tick: 2, money: Number.NaN, income: 10, expenses: 5 },
      { tick: 3, money: 250, income: 20, expenses: 5 },
    ];
    const clean = sanitizeHistory(history);
    expect(clean.map((point) => point.tick)).toEqual([1, 3]);
    expect(financeChartLabel(clean)).toContain('100');
    expect(financeChartLabel(clean)).toContain('250');
    expect(financeChartLabel([])).toContain('Aucun historique');
  });
});
