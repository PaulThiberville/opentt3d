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
import { companyColour } from '../src/render/tileVisuals';
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

  it('désactive avec explication les modèles incompatibles avec le rail du dépôt', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'rail');
    const view = describeDepotPanel(
      snapshot([], 100_000, [depot({ id: 6, kind: 'rail', railType: 'rail' })]),
      0,
      6,
    );
    const byId = new Map(view?.models.map((model) => [model.id, model]));
    // Un dépôt en rail classique accepte les matériels rail/électrifié.
    expect(byId.get('rail_autorail')?.available).toBe(true);
    expect(byId.get('rail_autorail')?.blockedReason).toBeNull();
    expect(byId.get('rail_freight')?.available).toBe(true);
    // Les matériels spécialisés restent visibles, mais désactivés (#219).
    expect(byId.get('rail_electric')?.available).toBe(false);
    expect(byId.get('rail_electric')?.blockedReason).toContain('Rail électrifié');
    expect(byId.get('rail_monorail')?.available).toBe(false);
    expect(byId.get('rail_monorail')?.blockedReason).toContain('Monorail');
    expect(byId.get('rail_maglev')?.available).toBe(false);
    expect(byId.get('rail_maglev')?.blockedReason).toContain('Maglev');
  });

  it('expose la variante visuelle et la livrée de chaque vignette', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const view = describeDepotPanel(snapshot([vehicle()]), 0, 5);
    const byId = new Map(view?.models.map((model) => [model.id, model]));
    expect(byId.get('bus_city')?.variant).toBe('bus-city');
    expect(byId.get('bus_intercity')?.variant).toBe('bus-coach');
    expect(byId.get('truck_flatbed')?.variant).toBe('truck-flat');
    expect(byId.get('truck_tanker')?.variant).toBe('truck-tanker');
    const expectedColour = companyColour(8);
    expect(view?.models.every((model) => model.colour === expectedColour)).toBe(true);
    // Véhicule routier de test : marchandises, id impair → citerne.
    expect(view?.vehicles[0]?.variant).toBe('truck-tanker');
    expect(view?.vehicles[0]?.colour).toBe(expectedColour);
  });

  it('choisit une variante ferroviaire pour le catalogue rail', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'rail');
    const view = describeDepotPanel(snapshot([], 100_000, [depot({ id: 6, kind: 'rail' })]), 0, 6);
    const byId = new Map(view?.models.map((model) => [model.id, model]));
    expect(byId.get('rail_autorail')?.variant).toBe('train-coach');
    expect(byId.get('rail_freight')?.variant).toBe('train-steam');
  });

  it('suit la livrée de l’entreprise pour les vignettes', () => {
    const map = makeMap();
    markDepot(map, 2, 2, 'road');
    const world = snapshot([]);
    world.companies = [{ ...company(), colour: 3 }];
    const view = describeDepotPanel(world, 0, 5);
    expect(view?.models.every((model) => model.colour === companyColour(3))).toBe(true);
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
    expect(view?.orders).toMatchObject([
      {
        index: 0,
        label: 'Arrêt de Valmont',
        kind: 'station',
        action: 'normal',
        current: false,
      },
      { index: 1, label: 'Dépôt (2, 2)', kind: 'depot', action: 'normal', current: false },
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

  it('liste les refits du modèle avec capacité, coût et perte', () => {
    const view = describeVehiclePanel(
      snapshot([
        vehicle({
          model: 'truck_flatbed',
          cargo: { type: 'goods', amount: 12, capacity: 30 },
          status: 3,
        }),
      ]),
      makeMap(),
      7,
      false,
    );
    expect(view?.modelName).toBe('Camion plateau');
    expect(view?.cargo).toEqual({ label: 'Marchandises', amount: 12, capacity: 30, percent: 40 });
    expect(view?.cargoAtRisk).toBe(12);
    expect(view?.inDepot).toBe(true);
    expect(view?.refits.map((refit) => refit.cargo)).toEqual([
      'goods',
      'coal',
      'grain',
      'wood',
      'steel',
    ]);
    expect(view?.refits.find((refit) => refit.cargo === 'goods')?.available).toBe(false);
    const coal = view?.refits.find((refit) => refit.cargo === 'coal');
    expect(coal?.available).toBe(true);
    expect(coal?.capacity).toBe(34);
    expect(coal?.cost).toBe(560);
  });

  it('désactive le refit hors dépôt et pour un modèle inconnu', () => {
    const view = describeVehiclePanel(
      snapshot([vehicle({ model: 'truck_flatbed', status: 1 })]),
      makeMap(),
      7,
      false,
    );
    expect(view?.refits.every((refit) => !refit.available)).toBe(true);
    expect(view?.refits[0]?.reason).toContain('dépôt');

    const unknown = describeVehiclePanel(
      snapshot([vehicle({ model: 'modele_inconnu', status: 3 })]),
      makeMap(),
      7,
      false,
    );
    // Repli par type/cargaison : le panneau reste utilisable.
    expect(unknown?.refits.length).toBeGreaterThan(0);
  });

  it('affiche les options d’ordre et marque l’ordre courant', () => {
    const view = describeVehiclePanel(
      snapshot([
        vehicle({
          status: 1,
          currentOrder: 2,
          orderTargets: [3, 5],
          orderKinds: ['station', 'depot'],
          orderDetails: [
            {
              index: 0,
              target: 3,
              kind: 'station',
              options: { action: 'full_load', timetable: { waitTicks: 120, autostart: true } },
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
            { index: 2, target: 5, kind: 'depot', options: { action: 'transfer' } },
          ],
        }),
      ]),
      makeMap(),
      7,
      false,
    );
    expect(view?.orders.map((order) => order.kind)).toEqual(['station', 'conditional', 'depot']);
    expect(view?.orders[0]?.actionLabel).toBe('Plein chargement');
    expect(view?.orders[0]?.timetableLabel).toContain('attente 120 t');
    expect(view?.orders[1]?.conditionLabel).toContain('Chargement');
    expect(view?.orders[1]?.jumpLabel).toContain('ordre 3');
    expect(view?.orders[2]?.actionLabel).toBe('Transfert');
    expect(view?.orders[2]?.current).toBe(true);
    expect(view?.currentOrder).toBe(2);
    expect(view?.shareCandidates.length).toBe(0);
  });

  it('affiche la fiabilité, la panne et le groupe (#163/#164)', () => {
    const world = snapshot([
      vehicle({
        group: { id: 4, name: 'Ligne A' },
        orderTargets: [3],
        orderKinds: ['station'],
        reliability: {
          wear: 72,
          reliability: 28,
          breakdown: 'stopped',
          breakdownTicks: 42,
          lastServiceTick: 0,
          serviceIntervalDays: 120,
          daysSinceService: 160,
          maintenancePerYear: 480,
        },
      }),
    ]);
    world.groups = [
      {
        id: 4,
        company: 0,
        name: 'Ligne A',
        kind: 'road',
        parent: null,
        vehicles: 1,
        autoreplace: null,
      },
    ];
    const view = describeVehiclePanel(world, makeMap(), 7, false);
    expect(view?.groupLabel).toBe('Ligne A');
    expect(view?.groupOptions).toEqual([{ id: 4, label: 'Ligne A' }]);
    expect(view?.reliability?.reliability).toBe(28);
    expect(view?.reliability?.wearLabel).toBe('72 %');
    expect(view?.reliability?.breakdownLabel).toContain('arrêt temporaire');
    expect(view?.reliability?.maintenanceLabel).toContain('480 £/an');
    expect(view?.reliability?.serviceCost).toBeGreaterThan(0);
    expect(view?.canSendToDepot).toBe(false);
    expect(view?.hint).toContain('entret');
  });

  it('masque l’entretien pour un snapshot antérieur à #163', () => {
    const view = describeVehiclePanel(snapshot([vehicle()]), makeMap(), 7, false);
    expect(view?.reliability).toBeNull();
    expect(view?.groupLabel).toBeNull();
    expect(view?.canSendToDepot).toBe(false);
  });
});
