import { describe, expect, it } from 'vitest';
import {
  COMPANY_NONE,
  PROTOCOL_VERSION,
  TILE_KIND_INDEX,
  type CompanySnapshot,
  type DepotSnapshot,
  type MapSnapshot,
  type VehicleSnapshot,
  type WorldSnapshot,
} from '../src/engine/protocol';
import { describeDepotPanel, describeVehiclePanel } from '../src/ui/vehicleView';

function makeMap(width = 16, height = 16): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function depot(overrides: Partial<DepotSnapshot> = {}): DepotSnapshot {
  return {
    id: 5,
    company: 0,
    kind: 'road',
    x: 2,
    y: 2,
    direction: 0,
    width: 1,
    height: 1,
    ...overrides,
  };
}

function markDepot(map: MapSnapshot, x: number, y: number, kind: 'road' | 'rail'): void {
  const index = y * map.width + x;
  map.kind[index] = kind === 'road' ? TILE_KIND_INDEX.road : TILE_KIND_INDEX.rail;
  map.owner[index] = 0;
}

function company(money = 100_000): CompanySnapshot {
  return {
    id: 0,
    name: 'Transports du Nord',
    president: 'A. Martin',
    colour: 8,
    money,
    loan: 0,
    value: 200_000,
    income: 0,
    expenses: 0,
    vehicles: 1,
    stations: 1,
    isAI: false,
    isLocal: true,
    bankrupt: false,
  };
}

function vehicle(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: 7,
    kind: 'road',
    company: 0,
    x: 2.5,
    y: 2.5,
    z: 0.1,
    direction: 0,
    speed: 18,
    status: 3,
    cargo: { type: 'goods', amount: 4, capacity: 30 },
    orderTargets: [],
    profitLastYear: 1200,
    ageDays: 3,
    ...overrides,
  };
}

function snapshot(
  vehicles: VehicleSnapshot[],
  money = 100_000,
  depots: DepotSnapshot[] = [depot()],
): WorldSnapshot {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 10, hash: 'abc', sequence: 1 },
    economy: { year: 1950, month: 0, day: 1, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies: [company(money)],
    towns: [],
    industries: [],
    stations: [
      {
        id: 3,
        company: 0,
        name: 'Arrêt de Valmont',
        kind: 'road',
        x: 5,
        y: 5,
        width: 2,
        height: 2,
        waiting: [],
      },
    ],
    depots,
    vehicles,
    news: [],
    events: [],
  };
}

describe('panneau dépôt', () => {
  it('liste les modèles routiers, leur coût et les véhicules sur place', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const view = describeDepotPanel(snapshot([vehicle()]), 0, 5);
    expect(view).not.toBeNull();
    expect(view?.id).toBe(5);
    expect(view?.title).toBe('Dépôt routier (2, 2)');
    expect(view?.kindLabel).toBe('Dépôt routier');
    expect(view?.models.length).toBeGreaterThan(0);
    expect(view?.models.every((model) => model.affordable)).toBe(true);
    expect(view?.vehicles.map((item) => item.id)).toEqual([7]);
    expect(view?.vehicles[0]?.detail).toContain('en dépôt');
  });

  it('signale un modèle hors budget et ferme le panneau sans dépôt', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const view = describeDepotPanel(snapshot([], 1_000), 0, 5);
    expect(view?.models.every((model) => !model.affordable)).toBe(true);
    expect(describeDepotPanel(snapshot([], 100_000, []), 0, 5)).toBeNull();
    expect(describeDepotPanel(snapshot([]), null, 5)).toBeNull();
  });

  it('ne liste que les modèles ferroviaires dans un dépôt rail', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'rail');
    const view = describeDepotPanel(snapshot([], 100_000, [depot({ id: 6, kind: 'rail' })]), 0, 6);
    expect(view?.models.length).toBeGreaterThan(0);
    expect(view?.models.every((model) => model.id.startsWith('rail_'))).toBe(true);
  });
});

describe('panneau véhicule', () => {
  it('affiche les statistiques et bloque le démarrage sans ordre', () => {
    const map = makeMap();
    const view = describeVehiclePanel(snapshot([vehicle()]), map, 7, false);
    expect(view?.title).toBe('Véhicule #7 — Véhicule routier');
    expect(view?.status).toBe('en dépôt');
    expect(view?.stats.some((stat) => stat.label === 'Bénéfice')).toBe(true);
    expect(view?.orders).toEqual([]);
    expect(view?.canStart).toBe(false);
    expect(view?.canStop).toBe(false);
    expect(view?.hint).toContain('Aucun ordre');
  });

  it('résout les libellés de tournée et autorise le démarrage', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const orders = [3, 5];
    const view = describeVehiclePanel(
      snapshot([vehicle({ orderTargets: orders, orderKinds: ['station', 'depot'], status: 0 })]),
      map,
      7,
      true,
    );
    expect(view?.orders).toEqual([
      { index: 0, label: 'Arrêt de Valmont', kind: 'station' },
      { index: 1, label: 'Dépôt (2, 2)', kind: 'depot' },
    ]);
    expect(view?.canStart).toBe(true);
    expect(view?.canStop).toBe(false);
    expect(view?.orderPicking).toBe(true);
    expect(view?.hint).toContain('Cliquez sur une gare');
  });

  it('retourne null pour un véhicule disparu', () => {
    expect(describeVehiclePanel(snapshot([]), makeMap(), 7, false)).toBeNull();
    expect(describeVehiclePanel(null, makeMap(), 7, false)).toBeNull();
  });
});
