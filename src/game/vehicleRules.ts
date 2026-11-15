/**
 * Règles véhicules partagées par l'interface et par `MockEngine`.
 *
 * Module pur (aucun DOM, aucun Three.js) : catalogue des modèles, lecture des
 * dépôts du snapshot, validation des tournées et fabrique de commandes
 * `EngineCommand.vehicle`. Comme `buildRules`, il ne simule rien : l'interface
 * s'en sert pour composer une commande, le moteur reste seul juge de son
 * application (fonds, dépôt, ordres).
 *
 * Depuis #90, les dépôts sont exposés par `WorldSnapshot.depots` avec un `id`
 * de pool stable. L'UI n'utilise plus aucun encodage privé (bit de `trackBits`
 * ou identifiant synthétique) : un achat envoie `depotId` et un ordre envoie
 * `{ kind: 'depot', target: depots[].id }`.
 */

import {
  type CompanyId,
  type DepotKind,
  type DepotSnapshot,
  type EngineCommand,
  type OrderAction,
  type OrderComparator,
  type OrderCondition,
  type OrderConditionType,
  type OrderOptions,
  type OrderTargetKind,
  type RailType,
  type StationSnapshot,
  type VehicleKind,
  type VehicleOrderSnapshot,
  type WorldSnapshot,
} from '../engine/protocol';

export type { DepotKind } from '../engine/protocol';

export type VehicleOrderKind = OrderTargetKind;

export interface VehicleOrder {
  target: number;
  kind: VehicleOrderKind;
  /** Comportement, condition et horaire (#161/#162). */
  options?: OrderOptions;
}

/** Cargaison disponible pour un modèle après refit (#160). */
export interface VehicleRefitOption {
  /** Slug stable du protocole (`passengers`, `coal`…). */
  cargo: string;
  /** Capacité du véhicule une fois reconfiguré pour cette cargaison. */
  capacity: number;
}

export interface VehicleModel {
  /** Identifiant stable transmis dans `EngineCommand.vehicle.model`. */
  id: string;
  name: string;
  /** Type de dépôt requis pour l'achat. */
  depot: DepotKind;
  /** Type de véhicule du protocole. */
  kind: VehicleKind;
  /** Cargaison de référence (bus = voyageurs, camion = marchandises…). */
  cargo: string;
  capacity: number;
  /** Vitesse de croisière en tuiles par jour. */
  speed: number;
  /** Prix d'achat en livres. */
  cost: number;
  /** Entretien indicatif en livres par an. */
  maintenance: number;
  description: string;
  /**
   * Types de rail compatibles (#157). Absent = tous les types du dépôt.
   * Une locomotive électrique ne peut pas rouler sur un rail non électrifié.
   */
  railTypes?: RailType[];
  /**
   * Cargaisons acceptées au refit (#160), capacité comprise. La première
   * entrée est la cargaison d'achat par défaut.
   */
  refits: readonly VehicleRefitOption[];
}

/** Nombre maximal d'ordres dans une tournée (protège l'UI et le moteur). */
export const MAX_VEHICLE_ORDERS = 24;

export const VEHICLE_MODELS: readonly VehicleModel[] = [
  {
    id: 'bus_city',
    name: 'Bus urbain',
    depot: 'road',
    kind: 'road',
    cargo: 'passengers',
    capacity: 42,
    speed: 22,
    cost: 24_000,
    maintenance: 480,
    description: 'Omnibus compact, idéal pour les centre-villes.',
    refits: [{ cargo: 'passengers', capacity: 42 }],
  },
  {
    id: 'bus_intercity',
    name: 'Autocar interurbain',
    depot: 'road',
    kind: 'road',
    cargo: 'passengers',
    capacity: 58,
    speed: 28,
    cost: 38_000,
    maintenance: 720,
    description: 'Plus rapide, pour relier deux quartiers éloignés.',
    refits: [{ cargo: 'passengers', capacity: 58 }],
  },
  {
    id: 'truck_flatbed',
    name: 'Camion plateau',
    depot: 'road',
    kind: 'road',
    cargo: 'goods',
    capacity: 30,
    speed: 18,
    cost: 28_000,
    maintenance: 560,
    description: 'Polyvalent : marchandises, charbon ou céréales.',
    refits: [
      { cargo: 'goods', capacity: 30 },
      { cargo: 'coal', capacity: 34 },
      { cargo: 'grain', capacity: 32 },
      { cargo: 'wood', capacity: 28 },
      { cargo: 'steel', capacity: 24 },
    ],
  },
  {
    id: 'truck_tanker',
    name: 'Camion citerne',
    depot: 'road',
    kind: 'road',
    cargo: 'oil',
    capacity: 26,
    speed: 16,
    cost: 32_000,
    maintenance: 640,
    description: 'Citerne lourde pour les liquides et le pétrole.',
    refits: [
      { cargo: 'oil', capacity: 26 },
      { cargo: 'water', capacity: 30 },
    ],
  },
  {
    id: 'rail_autorail',
    name: 'Autorail voyageurs',
    depot: 'rail',
    kind: 'train',
    cargo: 'passengers',
    capacity: 180,
    speed: 34,
    cost: 160_000,
    maintenance: 2_400,
    description: 'Rame légère pour les lignes voyageurs régulières.',
    railTypes: ['rail', 'electrified'],
    refits: [
      { cargo: 'passengers', capacity: 180 },
      { cargo: 'mail', capacity: 120 },
    ],
  },
  {
    id: 'rail_freight',
    name: 'Locomotive fret',
    depot: 'rail',
    kind: 'train',
    cargo: 'goods',
    capacity: 140,
    speed: 28,
    cost: 145_000,
    maintenance: 2_200,
    description: 'Traction lourde pour le charbon et les marchandises.',
    railTypes: ['rail', 'electrified'],
    refits: [
      { cargo: 'goods', capacity: 140 },
      { cargo: 'coal', capacity: 150 },
      { cargo: 'grain', capacity: 145 },
      { cargo: 'wood', capacity: 130 },
      { cargo: 'steel', capacity: 120 },
    ],
  },
  {
    id: 'rail_electric',
    name: 'Locomotive électrique',
    depot: 'rail',
    kind: 'train',
    cargo: 'passengers',
    capacity: 220,
    speed: 44,
    cost: 210_000,
    maintenance: 2_900,
    description: 'Rapide et puissante, exige une voie électrifiée.',
    railTypes: ['electrified'],
    refits: [
      { cargo: 'passengers', capacity: 220 },
      { cargo: 'mail', capacity: 150 },
    ],
  },
  {
    id: 'rail_monorail',
    name: 'Rame monorail',
    depot: 'rail',
    kind: 'train',
    cargo: 'passengers',
    capacity: 190,
    speed: 52,
    cost: 245_000,
    maintenance: 3_200,
    description: 'Suspendue à une poutre unique, réservée au monorail.',
    railTypes: ['monorail'],
    refits: [
      { cargo: 'passengers', capacity: 190 },
      { cargo: 'mail', capacity: 130 },
    ],
  },
  {
    id: 'rail_maglev',
    name: 'Rame maglev',
    depot: 'rail',
    kind: 'train',
    cargo: 'goods',
    capacity: 160,
    speed: 64,
    cost: 320_000,
    maintenance: 4_100,
    description: 'Sustentation magnétique, la plus rapide du catalogue.',
    railTypes: ['maglev'],
    refits: [
      { cargo: 'goods', capacity: 160 },
      { cargo: 'coal', capacity: 170 },
      { cargo: 'grain', capacity: 165 },
      { cargo: 'steel', capacity: 150 },
    ],
  },
];

export const DEPOT_KIND_LABELS: Record<DepotKind, string> = {
  road: 'Dépôt routier',
  rail: 'Dépôt ferroviaire',
};

export function depotKindLabel(kind: DepotKind): string {
  return DEPOT_KIND_LABELS[kind];
}

/** Modèle du catalogue par identifiant, ou `null` si inconnu. */
export function vehicleModel(id: string | null | undefined): VehicleModel | null {
  if (!id) return null;
  return VEHICLE_MODELS.find((model) => model.id === id) ?? null;
}

/** `true` si le modèle peut circuler sur le type de rail donné (#157). */
export function modelCompatibleWithRail(
  model: VehicleModel,
  railType: RailType | null | undefined,
): boolean {
  if (model.depot !== 'rail' || !railType) return true;
  return model.railTypes === undefined || model.railTypes.includes(railType);
}

/**
 * Infère un modèle catalogue quand le snapshot ne fournit pas `model` (pont
 * antérieur à #160) : premier modèle du même type et de la même cargaison.
 */
export function inferVehicleModel(
  kind: VehicleKind,
  cargo: string | null | undefined,
): VehicleModel | null {
  if (cargo) {
    return (
      VEHICLE_MODELS.find(
        (model) =>
          model.kind === kind && refitOptions(model).some((option) => option.cargo === cargo),
      ) ?? null
    );
  }
  return VEHICLE_MODELS.find((model) => model.kind === kind) ?? null;
}

/**
 * Modèles achetables dans un dépôt route ou rail. Pour un dépôt ferroviaire
 * dont le type est connu, seuls les matériels compatibles sont proposés.
 */
export function modelsForDepot(kind: DepotKind, railType?: RailType | null): VehicleModel[] {
  return VEHICLE_MODELS.filter(
    (model) => model.depot === kind && modelCompatibleWithRail(model, railType),
  );
}

/** Cargaisons proposées au refit pour un modèle (#160). */
export function refitOptions(model: VehicleModel): readonly VehicleRefitOption[] {
  if (model.refits.length > 0) return model.refits;
  return [{ cargo: model.cargo, capacity: model.capacity }];
}

/** Option de refit d'un modèle pour une cargaison, ou `null`. */
export function refitOption(
  model: VehicleModel | null,
  cargo: string | null | undefined,
): VehicleRefitOption | null {
  if (!model || !cargo) return null;
  return refitOptions(model).find((option) => option.cargo === cargo) ?? null;
}

/**
 * Coût indicatif d'un refit (#160) : 2 % du prix catalogue, avec un plancher
 * de 500 £. Le moteur reste seul juge du coût réel ; l'UI affiche cette
 * estimation avant émission.
 */
export function refitCost(model: VehicleModel | null): number {
  if (!model) return 0;
  return Math.max(500, Math.round(model.cost * 0.02));
}

/** Coût indicatif d'un clone (#161) : prix catalogue du modèle. */
export function cloneCost(model: VehicleModel | null): number {
  return model ? model.cost : 0;
}

/** Copie profonde d'un ordre (les options sont des objets imbriqués). */
export function cloneOrder(order: VehicleOrder): VehicleOrder {
  return {
    target: order.target,
    kind: order.kind,
    ...(order.options ? { options: cloneOrderOptions(order.options) } : {}),
  };
}

export function cloneOrderOptions(options: OrderOptions): OrderOptions {
  return {
    ...(options.action ? { action: options.action } : {}),
    ...(options.condition
      ? {
          condition: {
            type: options.condition.type,
            comparator: options.condition.comparator,
            value: options.condition.value,
            ...(options.condition.cargo !== undefined ? { cargo: options.condition.cargo } : {}),
            ...(options.condition.month !== undefined ? { month: options.condition.month } : {}),
          },
        }
      : {}),
    ...(options.jump !== undefined ? { jump: options.jump } : {}),
    ...(options.timetable
      ? {
          timetable: {
            ...(options.timetable.waitTicks !== undefined
              ? { waitTicks: options.timetable.waitTicks }
              : {}),
            ...(options.timetable.travelTicks !== undefined
              ? { travelTicks: options.timetable.travelTicks }
              : {}),
            ...(options.timetable.autostart !== undefined
              ? { autostart: options.timetable.autostart }
              : {}),
          },
        }
      : {}),
  };
}

/** Dépôt du snapshot par identifiant stable, ou `null`. */
export function depotById(snapshot: WorldSnapshot | null, id: number): DepotSnapshot | null {
  if (!snapshot || !Number.isFinite(id)) return null;
  return snapshot.depots.find((depot) => depot.id === id) ?? null;
}

/** Dépôt dont l'emprise contient la tuile, ou `null`. */
export function depotAtTile(
  snapshot: WorldSnapshot | null,
  x: number,
  y: number,
): DepotSnapshot | null {
  if (!snapshot) return null;
  for (const depot of snapshot.depots) {
    if (x >= depot.x && x < depot.x + depot.width && y >= depot.y && y < depot.y + depot.height) {
      return depot;
    }
  }
  return null;
}

/** Cible d'ordre stable pour une gare cliquée sur la carte. */
export function stationOrder(station: StationSnapshot): VehicleOrder {
  return { target: station.id, kind: 'station' };
}

/** Cible d'ordre stable pour un dépôt du snapshot. */
export function depotOrder(depot: DepotSnapshot): VehicleOrder {
  return { target: depot.id, kind: 'depot' };
}

/** Gare dont l'emprise contient la tuile, ou `null`. */
export function stationAtTile(
  snapshot: WorldSnapshot | null,
  x: number,
  y: number,
): StationSnapshot | null {
  if (!snapshot) return null;
  for (const station of snapshot.stations) {
    const left = Math.floor(station.x - station.width / 2);
    const top = Math.floor(station.y - station.height / 2);
    if (x >= left && x < left + station.width && y >= top && y < top + station.height) {
      return station;
    }
  }
  return null;
}

/** Libellé d'une cible d'ordre pour l'éditeur de tournée. */
export function orderTargetLabel(order: VehicleOrder, snapshot: WorldSnapshot | null): string {
  if (order.kind === 'conditional') {
    return 'Ordre conditionnel';
  }
  if (order.kind === 'station') {
    const station = snapshot?.stations.find((item) => item.id === order.target);
    return station?.name ?? `Gare #${order.target}`;
  }
  if (order.kind === 'industry') {
    const industry = snapshot?.industries.find((item) => item.id === order.target);
    return industry?.name ?? `Industrie #${order.target}`;
  }
  const depot = depotById(snapshot, order.target);
  return depot ? `Dépôt (${depot.x}, ${depot.y})` : `Dépôt #${order.target}`;
}

function orderFromSpec(order: VehicleOrderSnapshot): VehicleOrder {
  return {
    target: order.target,
    kind: order.kind,
    ...(order.options ? { options: cloneOrderOptions(order.options) } : {}),
  };
}

/**
 * Tournée typée à partir du snapshot.
 *
 * Depuis #161, `orderDetails` porte la tournée complète (conditionnels et
 * options). À défaut, `orderKinds` (fourni par le mock) lève l'ambiguïté entre
 * les pools d'identifiants ; en dernier recours on retombe sur l'ordre de
 * résolution historique — gare, industrie, dépôt — car le pont v1 n'expose que
 * des arrêts de gare dans `orderTargets`.
 */
export function ordersFromSnapshot(
  vehicle: {
    orderTargets: readonly number[];
    orderKinds?: readonly OrderTargetKind[];
    orderDetails?: readonly VehicleOrderSnapshot[];
  },
  snapshot: WorldSnapshot | null,
): VehicleOrder[] {
  if (vehicle.orderDetails && vehicle.orderDetails.length > 0) {
    return vehicle.orderDetails.map(orderFromSpec);
  }
  const kinds = vehicle.orderKinds;
  return vehicle.orderTargets.map((target, index) => {
    const declared = kinds?.[index];
    if (declared) return { target, kind: declared };
    if (snapshot?.stations.some((station) => station.id === target)) {
      return { target, kind: 'station' };
    }
    if (snapshot?.industries.some((industry) => industry.id === target)) {
      return { target, kind: 'industry' };
    }
    if (snapshot?.depots.some((depot) => depot.id === target)) {
      return { target, kind: 'depot' };
    }
    return { target, kind: 'station' };
  });
}

export interface OrderValidation {
  ok: boolean;
  reason: string | null;
}

/** Valide une tournée complète avant émission (cibles existantes). */
export function validateVehicleOrders(
  orders: readonly VehicleOrder[],
  snapshot: WorldSnapshot | null,
): OrderValidation {
  if (orders.length === 0) {
    return { ok: false, reason: 'Ajoutez au moins une gare ou un dépôt à la tournée.' };
  }
  if (orders.length > MAX_VEHICLE_ORDERS) {
    return { ok: false, reason: `Tournée trop longue : ${MAX_VEHICLE_ORDERS} ordres maximum.` };
  }
  let destinations = 0;
  for (const order of orders) {
    if (order.kind === 'conditional') {
      if (!order.options?.condition) {
        return { ok: false, reason: 'Un ordre conditionnel exige une condition.' };
      }
      const jump = order.options.jump;
      if (jump === undefined || !Number.isInteger(jump) || jump < 0 || jump >= orders.length) {
        return {
          ok: false,
          reason: `Conditionnel : la cible du saut doit être un ordre entre 1 et ${orders.length}.`,
        };
      }
      continue;
    }
    destinations += 1;
    if (order.kind === 'station') {
      if (!snapshot?.stations.some((station) => station.id === order.target)) {
        return { ok: false, reason: `Gare #${order.target} inconnue.` };
      }
      continue;
    }
    if (order.kind === 'industry') {
      if (!snapshot?.industries.some((industry) => industry.id === order.target)) {
        return { ok: false, reason: `Industrie #${order.target} inconnue.` };
      }
      continue;
    }
    if (!depotById(snapshot, order.target)) {
      return { ok: false, reason: 'Dépôt cible inconnu : ajoutez-le depuis la carte.' };
    }
  }
  if (destinations === 0) {
    return {
      ok: false,
      reason: 'Ajoutez au moins un arrêt : les conditions seules ne suffisent pas.',
    };
  }
  return { ok: true, reason: null };
}

/** Libellé français d'un mode d'arrêt (#161), pour les vues et les tests. */
export const ORDER_ACTION_LABELS: Record<OrderAction, string> = {
  normal: 'Chargement normal',
  full_load: 'Plein chargement',
  no_load: 'Sans chargement',
  unload: 'Déchargement',
  transfer: 'Transfert',
};

/** Libellé court d'une condition (#161). */
export function orderConditionLabel(
  condition: OrderCondition | undefined,
  labelCargo: (cargo: string) => string = (cargo) => cargo,
): string | null {
  if (!condition) return null;
  const symbols: Record<OrderComparator, string> = {
    equal: '=',
    not_equal: '≠',
    less: '<',
    less_or_equal: '≤',
    more: '>',
    more_or_equal: '≥',
  };
  const operator = symbols[condition.comparator];
  if (condition.type === 'date') {
    const month = `${(condition.month ?? 0) + 1}`.padStart(2, '0');
    return `Date ${operator} ${condition.value}-${month}`;
  }
  if (condition.type === 'cargo') {
    return `Cargaison ${labelCargo(condition.cargo ?? '?')} ${operator} ${condition.value}`;
  }
  if (condition.type === 'money') return `Argent ${operator} ${condition.value} £`;
  return `Chargement ${operator} ${condition.value} %`;
}

/** Types de condition proposés par l'éditeur. */
export const ORDER_CONDITION_TYPES: readonly OrderConditionType[] = [
  'cargo',
  'money',
  'date',
  'percentage',
];

/** Comparateurs proposés par l'éditeur. */
export const ORDER_COMPARATORS: readonly OrderComparator[] = [
  'equal',
  'not_equal',
  'less',
  'less_or_equal',
  'more',
  'more_or_equal',
];

/** Commande d'achat d'un modèle dans un dépôt identifié par son id stable. */
export function buyVehicleCommand(
  company: CompanyId,
  depotId: number,
  model: string,
): Extract<EngineCommand, { type: 'vehicle' }> {
  return { type: 'vehicle', action: 'buy', company, depotId, model };
}

/** Commande de vente, d'arrêt ou de démarrage d'un véhicule existant. */
export function vehicleActionCommand(
  company: CompanyId,
  action: 'sell' | 'start' | 'stop',
  vehicle: number,
): Extract<EngineCommand, { type: 'vehicle' }> {
  return { type: 'vehicle', action, company, vehicle };
}

/** Commande de refit vers une cargaison disponible du modèle (#160). */
export function refitVehicleCommand(
  company: CompanyId,
  vehicle: number,
  cargo: string,
): Extract<EngineCommand, { type: 'vehicle' }> {
  return { type: 'vehicle', action: 'refit', company, vehicle, cargo };
}

/**
 * Commande de duplication d'un véhicule (#161). Par défaut OpenTTD partage la
 * tournée (`shareOrders: true`) ; `false` la copie indépendamment.
 */
export function cloneVehicleCommand(
  company: CompanyId,
  vehicle: number,
  shareOrders = true,
): Extract<EngineCommand, { type: 'vehicle' }> {
  return { type: 'vehicle', action: 'clone', company, vehicle, shareOrders };
}

/** Commande qui remplace la tournée d'un véhicule. */
export function orderVehicleCommand(
  company: CompanyId,
  vehicle: number,
  orders: readonly VehicleOrder[],
): Extract<EngineCommand, { type: 'vehicle' }> {
  return {
    type: 'vehicle',
    action: 'order',
    company,
    vehicle,
    orders: orders.map((order) => ({
      target: order.target,
      kind: order.kind,
      ...(order.options ? { options: cloneOrderOptions(order.options) } : {}),
    })),
  };
}
