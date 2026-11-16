import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type CompanySnapshot, type WorldSnapshot } from '../src/engine/protocol';
import { resetI18n, setLanguage } from '../src/ui/i18n';
import { describeStatsPanel } from '../src/ui/statsView';

function company(overrides: Partial<CompanySnapshot> = {}): CompanySnapshot {
  return {
    id: 0,
    name: 'Transports du Nord',
    president: 'A. Martin',
    colour: 8,
    money: 100_000,
    loan: 0,
    value: 300_000,
    income: 10_000,
    expenses: 8_000,
    vehicles: 1,
    stations: 2,
    isAI: false,
    isLocal: true,
    bankrupt: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 30, hash: 'abc', sequence: 4 },
    economy: { year: 1952, month: 5, day: 8, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies: [
      company(),
      company({
        id: 1,
        name: 'Rivale',
        value: 100_000,
        isLocal: false,
        isAI: true,
        aiLevel: 2,
      }),
    ],
    towns: [
      {
        id: 1,
        name: 'Alpha',
        x: 0,
        y: 0,
        population: 1_000,
        growthRate: 2,
        buildings: 30,
        rating: 80,
      },
      {
        id: 2,
        name: 'Beta',
        x: 100,
        y: 100,
        population: 500,
        growthRate: 1,
        buildings: 12,
        rating: 55,
      },
    ],
    industries: [
      {
        id: 1,
        name: 'Mine',
        kind: 'coal_mine',
        x: 3,
        y: 3,
        production: 900,
        transported: 450,
        stocks: [],
      },
      {
        id: 2,
        name: 'Ferme',
        kind: 'farm',
        x: 5,
        y: 5,
        production: 300,
        transported: 300,
        stocks: [],
      },
    ],
    stations: [
      {
        id: 3,
        company: 0,
        name: 'Alpha Gare',
        kind: 'train',
        x: 1,
        y: 1,
        width: 1,
        height: 1,
        waiting: [],
      },
      {
        id: 4,
        company: 1,
        name: 'Loin',
        kind: 'road',
        x: 50,
        y: 50,
        width: 1,
        height: 1,
        waiting: [],
      },
    ],
    depots: [],
    vehicles: [
      {
        id: 7,
        kind: 'train',
        company: 0,
        x: 1,
        y: 1,
        z: 0,
        direction: 0,
        speed: 20,
        status: 1,
        cargo: null,
        orderTargets: [3],
        orderKinds: ['station'],
        profitLastYear: 100,
        ageDays: 10,
      },
    ],
    news: [],
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetI18n();
  setLanguage('fr', { storage: null });
});

afterEach(() => {
  resetI18n();
});

describe('panneau statistiques', () => {
  it('agrège production et transport par industrie', () => {
    const view = describeStatsPanel(snapshot());
    expect(view.industryCount).toBe(2);
    expect(view.totalProduction).toBe(1_200);
    expect(view.totalTransported).toBe(750);
    expect(view.industries.map((row) => row.name)).toEqual(['Mine', 'Ferme']);
    expect(view.industries[0]?.rate).toBe(50);
    expect(view.industries[0]?.rateLabel).toContain('50');
    expect(view.industries[0]?.percent).toBe(100);
    expect(view.industries[1]?.percent).toBeCloseTo(33.33, 1);
    expect(view.industries[0]?.detail).toContain('Mine de charbon');
  });

  it('liste les villes, leur population et les gares desservies', () => {
    const view = describeStatsPanel(snapshot());
    expect(view.townCount).toBe(2);
    expect(view.totalPopulation).toBe(1_500);
    expect(view.towns.map((row) => row.name)).toEqual(['Alpha', 'Beta']);
    expect(view.towns[0]?.stations).toBe(1);
    expect(view.towns[0]?.served).toBe(1);
    expect(view.towns[1]?.stations).toBe(0);
    expect(view.towns[1]?.served).toBe(0);
    expect(view.towns[0]?.detail).toContain('habitants');
    expect(view.towns[0]?.detail).toContain('80 / 100');
  });

  it('calcule les parts de marché sur la valeur d’entreprise', () => {
    const view = describeStatsPanel(snapshot());
    expect(view.market.map((row) => row.name)).toEqual(['Transports du Nord', 'Rivale']);
    expect(view.market[0]?.share).toBe(75);
    expect(view.market[0]?.shareLabel).toContain('75');
    expect(view.market[1]?.share).toBe(25);
    expect(view.market[1]?.isAI).toBe(true);
    expect(view.market[1]?.aiLevel).toBe(2);
    expect(view.marketBasis).toContain('valeur');
    expect(view.alerts).toEqual([]);
  });

  it('liste les désastres actifs avec leur cible et leur compte à rebours', () => {
    const view = describeStatsPanel(
      snapshot({
        disasters: [
          {
            id: 4,
            kind: 'fire',
            x: 3.5,
            y: 3.5,
            company: 255,
            industry: 1,
            severity: 2,
            startedTick: 10,
            remainingDays: 5,
          },
          {
            id: 5,
            kind: 'road_accident',
            x: 1.5,
            y: 1.5,
            company: 0,
            vehicle: 7,
            severity: 1,
            startedTick: 20,
            remainingDays: 1,
          },
        ],
      }),
    );
    expect(view.activeDisasterCount).toBe(2);
    expect(view.activeDisasterCountLabel).toBe('2');
    expect(view.disasters[0]?.kindLabel).toBe('Incendie');
    expect(view.disasters[0]?.location).toContain('Mine');
    expect(view.disasters[0]?.detail).toContain('Gravité 2');
    expect(view.disasters[0]?.remainingLabel).toContain('5');
    expect(view.disasters[1]?.kindLabel).toBe('Accident routier');
    expect(view.disasters[1]?.location).toContain('#7');
    expect(view.disasters[1]?.companyLabel).toContain('Transports du Nord');
    expect(view.disasters[1]?.remainingLabel).toContain('1');
  });

  it('tolère les champs absents et les valeurs nulles', () => {
    const world = snapshot({
      companies: [company({ value: 0 }), company({ id: 1, value: 0, isLocal: false })],
      industries: [
        {
          id: 9,
          name: 'Usine',
          kind: 'factory',
          x: 0,
          y: 0,
          production: undefined as unknown as number,
          transported: undefined as unknown as number,
          stocks: [],
        },
      ],
      towns: [
        {
          id: 9,
          name: 'Vide',
          x: 0,
          y: 0,
          population: undefined as unknown as number,
          growthRate: 0,
          buildings: 0,
          rating: 0,
        },
      ],
    });
    const view = describeStatsPanel(world);
    expect(view.totalProduction).toBe(0);
    expect(view.totalTransported).toBe(0);
    expect(view.industries[0]?.rate).toBeNull();
    expect(view.industries[0]?.rateLabel).toBe('Non exposé');
    expect(view.totalPopulation).toBe(0);
    expect(view.market.every((row) => row.share === null)).toBe(true);
    expect(view.alerts.map((alert) => alert.id)).toEqual(['no-market']);
  });

  it('affiche un état vide sans snapshot', () => {
    const view = describeStatsPanel(null);
    expect(view.industries).toEqual([]);
    expect(view.towns).toEqual([]);
    expect(view.market).toEqual([]);
    expect(view.activeDisasterCount).toBe(0);
    expect(view.disasters).toEqual([]);
    expect(view.alerts[0]?.id).toBe('no-snapshot');
  });
});
