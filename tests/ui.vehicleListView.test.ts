import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type CompanySnapshot,
  type VehicleSnapshot,
  type WorldSnapshot,
} from '../src/engine/protocol';
import { resetI18n, setLanguage } from '../src/ui/i18n';
import type { VehicleListFilters } from '../src/ui/types';
import {
  createDefaultVehicleFilters,
  describeVehicleListPanel,
  OLD_AGE_DAYS,
  RECENT_AGE_DAYS,
  totalVehicleProfit,
  UNGROUPED_ID,
} from '../src/ui/vehicleListView';

function company(overrides: Partial<CompanySnapshot> = {}): CompanySnapshot {
  return {
    id: 0,
    name: 'Transports du Nord',
    president: 'A. Martin',
    colour: 8,
    money: 100_000,
    loan: 0,
    value: 200_000,
    income: 10_000,
    expenses: 8_000,
    vehicles: 4,
    stations: 2,
    isAI: false,
    isLocal: true,
    bankrupt: false,
    ...overrides,
  };
}

function vehicle(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: 10,
    kind: 'road',
    company: 0,
    x: 1,
    y: 1,
    z: 0,
    direction: 0,
    speed: 20,
    status: 1,
    cargo: { type: 'goods', amount: 4, capacity: 30 },
    orderTargets: [3],
    profitLastYear: 1_200,
    ageDays: 12,
    ...overrides,
  };
}

function snapshot(vehicles: VehicleSnapshot[]): WorldSnapshot {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 20, hash: 'abc', sequence: 3 },
    economy: { year: 1951, month: 0, day: 2, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies: [company(), company({ id: 1, name: 'Rivale', isLocal: false, colour: 2 })],
    towns: [],
    industries: [],
    stations: [],
    depots: [],
    vehicles,
    news: [],
    events: [],
  };
}

function filters(patch: Partial<VehicleListFilters> = {}): VehicleListFilters {
  return { ...createDefaultVehicleFilters(), ...patch };
}

beforeEach(() => {
  resetI18n();
  setLanguage('fr', { storage: null });
});

afterEach(() => {
  resetI18n();
});

describe('liste des véhicules', () => {
  const vehicles = [
    vehicle({ id: 10, kind: 'road', status: 1, profitLastYear: 1_200, ageDays: 12 }),
    vehicle({ id: 11, kind: 'train', status: 3, profitLastYear: -400, ageDays: 120 }),
    vehicle({ id: 12, kind: 'road', status: 0, profitLastYear: 3_000, ageDays: 45 }),
    vehicle({ id: 13, kind: 'ship', status: 2, profitLastYear: 0, ageDays: 90, company: 1 }),
  ];

  it('liste tous les véhicules et trie par bénéfice décroissant', () => {
    const view = describeVehicleListPanel(snapshot(vehicles), 0);
    expect(view.rows.map((row) => row.id)).toEqual([12, 10, 13, 11]);
    expect(view.summary.count).toBe(4);
    expect(view.summary.moving).toBe(2);
    expect(view.summary.profit).toBe(3_800);
    expect(view.summary.profitLabel).toContain('3');
    expect(view.rows[0]?.title).toBe('Véhicule routier #12');
    expect(view.rows[0]?.detail).toContain('à l’arrêt');
  });

  it('filtre par type, statut, bénéfice et âge', () => {
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ kind: 'road' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([12, 10]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ status: 'depot' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([11]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ profit: 'loss' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([11]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ profit: 'profit' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([12, 10]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ age: 'recent' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([10]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ age: 'old' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([13, 11]);
    expect(RECENT_AGE_DAYS).toBe(30);
    expect(OLD_AGE_DAYS).toBe(90);
  });

  it('filtre par groupe exposé ou non groupé', () => {
    const grouped = [
      Object.assign(vehicle({ id: 20 }), { group: 'Ligne A' }) as VehicleSnapshot,
      Object.assign(vehicle({ id: 21 }), { group: { id: 3, name: 'Ligne B' } }) as VehicleSnapshot,
      vehicle({ id: 22 }),
    ];
    const world = snapshot(grouped);
    expect(describeVehicleListPanel(world, 0).groups).toEqual([
      { id: 'Ligne A', label: 'Ligne A', count: 1, kind: 'road', autoreplaceLabel: null },
      { id: '3', label: 'Ligne B', count: 1, kind: 'road', autoreplaceLabel: null },
      {
        id: UNGROUPED_ID,
        label: 'Non groupé',
        count: 1,
        kind: null,
        autoreplaceLabel: null,
      },
    ]);
    expect(
      describeVehicleListPanel(world, 0, filters({ group: 'Ligne A' })).rows.map((row) => row.id),
    ).toEqual([20]);
    expect(
      describeVehicleListPanel(world, 0, filters({ group: UNGROUPED_ID })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([22]);
    const legacy = describeVehicleListPanel(world, 0);
    expect(legacy.canManageGroups).toBe(false);
    expect(legacy.groupActions.every((action) => !action.supported)).toBe(true);
    expect(legacy.groupActions[0]?.reason).toContain('groupes de véhicules');
  });

  it('gère les groupes exposés par le snapshot (#164)', () => {
    const grouped = [
      Object.assign(vehicle({ id: 40 }), { group: { id: 7, name: 'Ligne A' } }) as VehicleSnapshot,
      Object.assign(vehicle({ id: 41 }), { group: { id: 7, name: 'Ligne A' } }) as VehicleSnapshot,
      vehicle({ id: 42 }),
      Object.assign(vehicle({ id: 43, kind: 'train', status: 3 }), {
        group: { id: 8, name: 'Fret' },
      }) as VehicleSnapshot,
    ];
    const world = snapshot(grouped);
    world.groups = [
      {
        id: 7,
        company: 0,
        name: 'Ligne A',
        kind: 'road',
        parent: null,
        vehicles: 2,
        autoreplace: { model: 'bus_intercity', whenOld: true },
      },
      {
        id: 8,
        company: 0,
        name: 'Fret',
        kind: 'train',
        parent: null,
        vehicles: 1,
        autoreplace: null,
      },
      {
        id: 9,
        company: 0,
        name: 'Vide',
        kind: 'road',
        parent: null,
        vehicles: 0,
        autoreplace: null,
      },
    ];
    const view = describeVehicleListPanel(world, 0, filters({ group: '7' }));
    expect(view.canManageGroups).toBe(true);
    expect(view.selectedGroup?.label).toBe('Ligne A');
    expect(view.groups.map((group) => group.id)).toEqual(['8', '7', '9', UNGROUPED_ID]);
    expect(view.groups.find((group) => group.id === '7')?.autoreplaceLabel).toContain(
      'bus_intercity',
    );
    expect(view.autoreplace).toEqual({ model: 'bus_intercity', whenOld: true });
    expect(view.autoreplaceOptions.map((option) => option.value)).toContain('bus_intercity');
    expect(view.autoreplaceOptions.map((option) => option.value)).toEqual([
      'bus_city',
      'bus_intercity',
      'truck_flatbed',
      'truck_tanker',
    ]);
    expect(view.groupActions.every((action) => action.supported)).toBe(true);
    expect(view.rows.map((row) => row.id)).toEqual([40, 41]);
    expect(view.rows[0]?.groupId).toBe('7');
    expect(view.rows[0]?.reliability).toBeNull();
    const ungrouped = describeVehicleListPanel(world, 0, filters({ group: UNGROUPED_ID }));
    expect(ungrouped.rows.map((row) => row.id)).toEqual([42]);
    expect(ungrouped.groupActions.find((action) => action.id === 'start')?.supported).toBe(false);
  });

  it('recherche par numéro, entreprise ou groupe et trie par âge/numéro', () => {
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ query: '12' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([12]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ query: 'rivale' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([13]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ sort: 'id' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([10, 11, 12, 13]);
    expect(
      describeVehicleListPanel(snapshot(vehicles), 0, filters({ sort: 'age' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([11, 13, 12, 10]);
  });

  it('désactive les actions des véhicules d’une autre entreprise', () => {
    const view = describeVehicleListPanel(snapshot(vehicles), 0, filters({ sort: 'id' }));
    const other = view.rows.find((row) => row.id === 13);
    expect(other?.isLocal).toBe(false);
    expect(other?.canStart).toBe(false);
    expect(other?.canStop).toBe(false);
    expect(other?.canSell).toBe(false);
    expect(other?.canSelect).toBe(true);
    expect(other?.note).toContain('autre entreprise');
    const local = view.rows.find((row) => row.id === 12);
    expect(local?.canStart).toBe(true);
    expect(local?.canStop).toBe(false);
    expect(local?.canSell).toBe(true);
    const moving = view.rows.find((row) => row.id === 10);
    expect(moving?.canStart).toBe(false);
    expect(moving?.canStop).toBe(true);
  });

  it('bloque le démarrage sans tournée et tolère les champs absents', () => {
    const raw = Object.assign(vehicle({ id: 30, status: 0, orderTargets: [] }), {
      profitLastYear: undefined,
      ageDays: undefined,
    }) as VehicleSnapshot;
    const view = describeVehicleListPanel(snapshot([raw]), 0);
    const row = view.rows[0];
    expect(row?.profit).toBeNull();
    expect(row?.profitLabel).toBe('—');
    expect(row?.ageDays).toBeNull();
    expect(row?.ageLabel).toBe('—');
    expect(row?.canStart).toBe(false);
    expect(
      describeVehicleListPanel(snapshot([raw]), 0, filters({ profit: 'profit' })).rows,
    ).toEqual([]);
    expect(totalVehicleProfit(snapshot([raw]), 0)).toBe(0);
  });

  it('retourne une vue vide sans snapshot', () => {
    const view = describeVehicleListPanel(null, null);
    expect(view.rows).toEqual([]);
    expect(view.groups).toEqual([]);
    expect(view.summary.count).toBe(0);
    expect(view.empty).toContain('Aucun véhicule');
  });
});
