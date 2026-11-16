import { describe, expect, it } from 'vitest';
import { COMPANY_NONE, PROTOCOL_VERSION } from '../src/engine/protocol';
import { WorldJsonError, parseWorldJson } from '../src/engine/worldJson';

/** JSON minimal tel que le produit `ottd_snapshot_json` pour une partie neuve. */
function engineJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 1282, hash: '0xd60509d5b2eb3fe1', sequence: 1 },
    economy: {
      year: 1950,
      month: 0,
      day: 1,
      dayFraction: 12,
      speed: 1,
      paused: false,
    },
    map: { width: 128, height: 128, encoding: 'binary', bytes: 98440, layers: 6 },
    counts: { companies: 1, towns: 1, industries: 1, stations: 0, vehicles: 0 },
    companies: [],
    towns: [],
    industries: [],
    stations: [],
    depots: [],
    vehicles: [],
    news: [],
    events: [],
    ...overrides,
  };
}

describe('mapping JSON → WorldSnapshot', () => {
  it('mappe méta et économie sans carte', () => {
    const world = parseWorldJson(engineJson());
    expect(world.meta.protocol).toBe(PROTOCOL_VERSION);
    expect(world.meta.tick).toBe(1282);
    expect(world.meta.hash).toBe('0xd60509d5b2eb3fe1');
    expect(world.meta.sequence).toBe(1);
    expect(world.map).toBeNull();
    expect(world.economy).toEqual({
      year: 1950,
      month: 0,
      day: 1,
      dayFraction: 12,
      speed: 1,
      paused: false,
    });
  });

  it('accepte la chaîne JSON brute', () => {
    const world = parseWorldJson(JSON.stringify(engineJson()));
    expect(world.meta.tick).toBe(1282);
  });

  it('remplit des valeurs par défaut documentées pour les champs absents', () => {
    const world = parseWorldJson({
      meta: { protocol: PROTOCOL_VERSION },
      economy: null,
      companies: [{ id: 0 }],
      towns: [{ id: 3 }],
      industries: [{}],
      stations: [{}],
      vehicles: [{ id: 1, kind: 'train', company: 255 }],
    });

    expect(world.meta.hash).toBe('0x0000000000000000');
    expect(world.meta.sequence).toBe(0);
    expect(world.economy).toEqual({
      year: 1950,
      month: 0,
      day: 1,
      dayFraction: 0,
      speed: 1,
      paused: false,
    });
    expect(world.companies[0]).toMatchObject({
      id: 0,
      name: 'Entreprise 1',
      president: '',
      colour: 0,
      money: 0,
      bankrupt: false,
    });
    expect(world.towns[0]).toMatchObject({ name: 'Ville', population: 0, rating: 0 });
    expect(world.industries[0]).toMatchObject({ kind: 'unknown', stocks: [] });
    expect(world.stations[0]).toMatchObject({
      kind: 'train',
      company: COMPANY_NONE,
      width: 1,
      height: 1,
      waiting: [],
    });
    expect(world.vehicles[0]).toMatchObject({
      kind: 'train',
      company: COMPANY_NONE,
      cargo: null,
      status: 0,
      orderTargets: [],
    });
    expect(world.news).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.depots).toEqual([]);
  });

  it('mappe le niveau IA et les désastres (#168/#172)', () => {
    const world = parseWorldJson(
      engineJson({
        companies: [
          {
            id: 2,
            name: 'Ligne du Lac',
            isAI: true,
            aiLevel: 3,
            vehicles: 4,
            stations: 2,
          },
          { id: 0, name: 'Humaine' },
        ],
        disasters: [
          {
            id: 5,
            kind: 'fire',
            x: 12.5,
            y: 8.5,
            company: 2,
            industry: 3,
            severity: 2,
            startedTick: 90,
            remainingDays: 4,
          },
          { id: 6, kind: 'inconnu', vehicle: 7, severity: 9 },
        ],
        events: [
          { type: 'disaster_started', disaster: 5, kind: 'fire', tick: 90 },
          { type: 'disaster_ended', disaster: 5, tick: 120 },
        ],
      }),
    );

    expect(world.companies[0]).toMatchObject({ isAI: true, aiLevel: 3 });
    expect(world.companies[1]?.aiLevel).toBeUndefined();
    expect(world.disasters).toHaveLength(2);
    expect(world.disasters?.[0]).toMatchObject({
      id: 5,
      kind: 'fire',
      company: 2,
      industry: 3,
      severity: 2,
      remainingDays: 4,
    });
    expect(world.disasters?.[1]).toMatchObject({ kind: 'fire', severity: 3 });
    expect(world.events).toEqual([
      { type: 'disaster_started', disaster: 5, kind: 'fire', tick: 90 },
      { type: 'disaster_ended', disaster: 5, tick: 120 },
    ]);
  });

  it('mappe les entités du pont', () => {
    const world = parseWorldJson(
      engineJson({
        companies: [
          {
            id: 0,
            name: 'Compagnie de Paul',
            president: 'Paul',
            colour: 8,
            money: 250_000,
            loan: 50_000,
            value: 300_000,
            income: 1_200,
            expenses: 400,
            vehicles: 2,
            stations: 1,
            isAI: false,
            isLocal: true,
            bankrupt: false,
          },
        ],
        towns: [
          {
            id: 4,
            name: 'Trondheim',
            x: 21,
            y: 33,
            population: 512,
            growthRate: 4,
            buildings: 40,
            rating: 750,
          },
        ],
        industries: [
          {
            id: 2,
            name: 'Mine de charbon',
            kind: 'Mine de charbon',
            x: 10.5,
            y: 20.5,
            production: 120,
            transported: 30,
            stocks: [{ cargo: 'Charbon', amount: 44, rate: 3 }],
          },
        ],
        stations: [
          {
            id: 1,
            company: 0,
            name: 'Trondheim Central',
            kind: 'airport',
            x: 22,
            y: 34,
            width: 4,
            height: 3,
            waiting: [{ cargo: 'Passagers', amount: 12 }],
          },
        ],
        depots: [
          {
            id: 7,
            company: 0,
            kind: 'road',
            x: 18,
            y: 27,
            direction: 2,
            width: 1,
            height: 1,
          },
          {
            id: 3,
            company: 1,
            kind: 'rail',
            x: 40,
            y: 12,
            direction: 1,
            width: 1,
            height: 1,
          },
        ],
        vehicles: [
          {
            id: 12,
            kind: 'aircraft',
            company: 0,
            x: 15.25,
            y: 9.75,
            z: 4,
            direction: 192,
            speed: 30.5,
            status: 1,
            cargo: { type: 'Passagers', amount: 40, capacity: 80 },
            orderTargets: [1, 2],
            profitLastYear: 12_345.5,
            ageDays: 90,
          },
        ],
      }),
    );

    expect(world.companies[0]).toMatchObject({
      name: 'Compagnie de Paul',
      colour: 8,
      isLocal: true,
    });
    expect(world.towns[0]).toMatchObject({ name: 'Trondheim', x: 21, y: 33, rating: 750 });
    expect(world.industries[0]).toMatchObject({
      x: 10.5,
      y: 20.5,
      stocks: [{ cargo: 'Charbon', amount: 44 }],
    });
    expect(world.stations[0]).toMatchObject({
      kind: 'airport',
      width: 4,
      height: 3,
      waiting: [{ cargo: 'Passagers', amount: 12 }],
    });
    expect(world.depots).toEqual([
      {
        id: 7,
        company: 0,
        kind: 'road',
        x: 18,
        y: 27,
        direction: 2,
        width: 1,
        height: 1,
      },
      {
        id: 3,
        company: 1,
        kind: 'rail',
        x: 40,
        y: 12,
        direction: 1,
        width: 1,
        height: 1,
      },
    ]);
    expect(world.vehicles[0]).toMatchObject({
      id: 12,
      kind: 'aircraft',
      x: 15.25,
      y: 9.75,
      direction: 192,
      cargo: { type: 'Passagers', amount: 40, capacity: 80 },
      orderTargets: [1, 2],
    });
  });

  it('mappe les ponts et tunnels optionnels et ignore les types inconnus', () => {
    const world = parseWorldJson(
      engineJson({
        structures: [
          {
            id: 4,
            kind: 'bridge',
            company: 1,
            transport: 'rail',
            material: 'suspension',
            from: { x: 3, y: 8 },
            to: { x: 14, y: 8 },
            length: 12,
            deckHeight: 9,
          },
          {
            id: 5,
            kind: 'tunnel',
            company: 0,
            transport: 'road',
            from: { x: 20, y: 3 },
            to: { x: 28, y: 3 },
            length: 9,
            portalHeight: 4,
          },
          { id: 6, kind: 'aqueduct' },
        ],
      }),
    );
    expect(world.structures).toEqual([
      {
        id: 4,
        kind: 'bridge',
        company: 1,
        transport: 'rail',
        material: 'suspension',
        from: { x: 3, y: 8 },
        to: { x: 14, y: 8 },
        length: 12,
        deckHeight: 9,
      },
      {
        id: 5,
        kind: 'tunnel',
        company: 0,
        transport: 'road',
        from: { x: 20, y: 3 },
        to: { x: 28, y: 3 },
        length: 9,
        portalHeight: 4,
      },
    ]);
    expect(parseWorldJson(engineJson()).structures).toEqual([]);
  });

  it('ignore les véhicules sans type de rendu et les événements inconnus', () => {
    const world = parseWorldJson(
      engineJson({
        vehicles: [
          { id: 1, kind: 'unknown' },
          { id: 2, kind: 'ship', company: 0 },
        ],
        news: [
          { tick: 10, kind: 'warning', text: 'Route fermée' },
          { tick: 11, kind: 'inconnu', text: 'Sans gravité' },
          { tick: 12, kind: 'info' },
          'pas un objet',
        ],
        events: [
          { type: 'vehicle_arrived', vehicle: 2, station: 1, tick: 10 },
          { type: 'company_bankrupt', company: 0, tick: 11 },
          { type: 'extraterrestre', tick: 12 },
        ],
      }),
    );

    expect(world.vehicles.map((vehicle) => vehicle.id)).toEqual([2]);
    expect(world.news).toEqual([
      { tick: 10, kind: 'warning', text: 'Route fermée' },
      { tick: 11, kind: 'info', text: 'Sans gravité' },
    ]);
    expect(world.events).toEqual([
      { type: 'vehicle_arrived', vehicle: 2, station: 1, tick: 10 },
      { type: 'company_bankrupt', company: 0, tick: 11 },
    ]);
  });

  it('mappe les dépôts et ignore les types non exposés', () => {
    const world = parseWorldJson(
      engineJson({
        depots: [
          { id: 5, company: 0, kind: 'road', x: 3.6, y: 4.2 },
          { id: 2, company: 1, kind: 'rail', x: 9, y: 10, direction: 3 },
          { id: 8, company: 0, kind: 'ship', x: 1, y: 1 },
          'pas un objet',
        ],
        vehicles: [
          {
            id: 4,
            kind: 'road',
            company: 0,
            orderTargets: [12, 5],
            orderKinds: ['station', 'depot'],
          },
        ],
      }),
    );

    expect(world.depots).toEqual([
      {
        id: 5,
        company: 0,
        kind: 'road',
        x: 3,
        y: 4,
        direction: 0,
        width: 1,
        height: 1,
      },
      {
        id: 2,
        company: 1,
        kind: 'rail',
        x: 9,
        y: 10,
        direction: 3,
        width: 1,
        height: 1,
      },
    ]);
    expect(world.vehicles[0]?.orderKinds).toEqual(['station', 'depot']);
  });

  it('mappe l’économie, l’autorité locale et les subventions (#165/#166/#167)', () => {
    const world = parseWorldJson(
      engineJson({
        economy: {
          year: 1962,
          month: 4,
          day: 9,
          dayFraction: 3,
          speed: 1,
          paused: false,
          inflation: 12.5,
          difficulty: 2,
          interestRate: 6,
          maxLoan: 450000,
          loanInterval: 50000,
        },
        companies: [
          {
            id: 0,
            name: 'Transports',
            colour: 2,
            money: -12000,
            loan: 180000,
            maxLoan: 450000,
            monthsOfBankruptcy: 3,
            value: 800000,
            income: 0,
            expenses: 5000,
            vehicles: 1,
            stations: 1,
            isAI: false,
            isLocal: true,
            bankrupt: false,
          },
        ],
        towns: [
          {
            id: 0,
            name: 'Valmont',
            x: 10,
            y: 10,
            population: 1200,
            growthRate: 2,
            buildings: 40,
            rating: 680,
            authority: {
              rating: 680,
              actions: {
                advertise: { available: true, cost: 22500 },
                fund_roads: { available: false, cost: 56250 },
              },
            },
          },
        ],
        industries: [
          {
            id: 0,
            name: 'Centrale',
            kind: 'power_station',
            x: 20,
            y: 20,
            production: 0,
            transported: 0,
            serviceRate: 72,
            accepts: ['coal'],
            stocks: [],
          },
        ],
        subsidies: [
          {
            id: 0,
            cargo: 'coal',
            from: 'Mine',
            to: 'Centrale',
            fromKind: 'industry',
            toKind: 'industry',
            remainingMonths: 9,
            awardedTo: 1,
          },
        ],
      }),
    );

    expect(world.economy.inflation).toBe(12.5);
    expect(world.economy.difficulty).toBe(2);
    expect(world.economy.interestRate).toBe(6);
    expect(world.companies[0]?.maxLoan).toBe(450000);
    expect(world.companies[0]?.monthsOfBankruptcy).toBe(3);
    expect(world.towns[0]?.authority?.actions.advertise.available).toBe(true);
    expect(world.towns[0]?.authority?.actions.fund_roads.available).toBe(false);
    expect(world.towns[0]?.authority?.actions.fund_buildings).toEqual({
      available: false,
      cost: 0,
    });
    expect(world.industries[0]?.serviceRate).toBe(72);
    expect(world.industries[0]?.accepts).toEqual(['coal']);
    expect(world.subsidies?.[0]?.awardedTo).toBe(1);
    expect(world.subsidies?.[0]?.fromKind).toBe('industry');
  });

  it('mappe orderDetails, options et ordre courant (#161)', () => {
    const world = parseWorldJson(
      engineJson({
        vehicles: [
          {
            id: 4,
            kind: 'road',
            company: 0,
            model: 'truck_flatbed',
            cargo: { type: 'coal', amount: 12, capacity: 34 },
            orderTargets: [12, 5],
            orderKinds: ['station', 'depot'],
            currentOrder: 2,
            orderDetails: [
              {
                index: 0,
                target: 12,
                kind: 'station',
                options: {
                  action: 'full_load',
                  timetable: { waitTicks: 120, travelTicks: 40, autostart: true },
                },
              },
              {
                index: 1,
                target: -1,
                kind: 'conditional',
                options: {
                  condition: { type: 'percentage', comparator: 'more_or_equal', value: 80 },
                  jump: 2,
                },
              },
              {
                index: 2,
                target: 5,
                kind: 'depot',
                options: { action: 'transfer' },
              },
              { index: 3, target: 1, kind: 'inconnu' },
            ],
          },
        ],
      }),
    );
    const vehicle = world.vehicles[0];
    expect(vehicle?.model).toBe('truck_flatbed');
    expect(vehicle?.currentOrder).toBe(2);
    expect(vehicle?.orderDetails).toHaveLength(3);
    expect(vehicle?.orderDetails?.[0]?.options).toEqual({
      action: 'full_load',
      timetable: { waitTicks: 120, travelTicks: 40, autostart: true },
    });
    expect(vehicle?.orderDetails?.[1]).toMatchObject({
      kind: 'conditional',
      target: -1,
      options: {
        jump: 2,
        condition: { type: 'percentage', comparator: 'more_or_equal', value: 80 },
      },
    });
    expect(vehicle?.orderDetails?.[2]?.options?.action).toBe('transfer');
  });

  it('mappe les groupes, la fiabilité et les événements #163/#164', () => {
    const world = parseWorldJson({
      ...engineJson(),
      groups: [
        {
          id: 2,
          company: 0,
          name: 'Ligne A',
          kind: 'road',
          parent: -1,
          vehicles: 1,
          autoreplace: { model: 'bus_intercity', whenOld: true },
        },
        { id: 3, company: 0, name: '', kind: 'inconnu' },
      ],
      vehicles: [
        {
          id: 9,
          kind: 'road',
          company: 0,
          group: { id: 2, name: 'Ligne A' },
          reliability: {
            wear: 61,
            reliability: 39,
            breakdown: 'slowing',
            breakdownTicks: 12,
            lastServiceTick: null,
            serviceIntervalDays: 120,
            daysSinceService: 70,
            maintenancePerYear: 480,
          },
        },
      ],
      events: [
        { type: 'vehicle_breakdown', vehicle: 9, breakdown: 'stopped', tick: 40 },
        { type: 'group_created', group: 2, company: 0, tick: 41 },
        { type: 'group_deleted', group: 2, company: 0, tick: 42 },
      ],
    });
    expect(world.groups).toEqual([
      {
        id: 2,
        company: 0,
        name: 'Ligne A',
        kind: 'road',
        parent: null,
        vehicles: 1,
        autoreplace: { model: 'bus_intercity', whenOld: true },
      },
    ]);
    const vehicle = world.vehicles[0];
    expect(vehicle?.group).toEqual({ id: 2, name: 'Ligne A' });
    expect(vehicle?.reliability).toEqual({
      wear: 61,
      reliability: 39,
      breakdown: 'slowing',
      breakdownTicks: 12,
      lastServiceTick: null,
      serviceIntervalDays: 120,
      daysSinceService: 70,
      maintenancePerYear: 480,
    });
    expect(world.events.map((event) => event.type)).toEqual([
      'vehicle_breakdown',
      'group_created',
      'group_deleted',
    ]);
    expect(world.events[0]).toMatchObject({ breakdown: 'stopped' });
  });

  it('refuse un protocole incompatible', () => {
    const json = engineJson();
    (json.meta as Record<string, unknown>).protocol = PROTOCOL_VERSION + 1;
    expect(() => parseWorldJson(json)).toThrow(WorldJsonError);
    expect(() => parseWorldJson(json)).toThrow(/Protocole moteur incompatible/);
  });

  it('refuse un JSON invalide ou une racine non-objet', () => {
    expect(() => parseWorldJson('{')).toThrow(/JSON invalide/);
    expect(() => parseWorldJson(42)).toThrow(/objet JSON attendu/);
  });
});
