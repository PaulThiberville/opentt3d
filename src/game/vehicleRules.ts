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
  type OrderTargetKind,
  type RailType,
  type StationSnapshot,
  type VehicleKind,
  type WorldSnapshot,
} from '../engine/protocol';

export type { DepotKind } from '../engine/protocol';

export type VehicleOrderKind = OrderTargetKind;

export interface VehicleOrder {
  target: number;
  kind: VehicleOrderKind;
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
 * Modèles achetables dans un dépôt route ou rail. Pour un dépôt ferroviaire
 * dont le type est connu, seuls les matériels compatibles sont proposés.
 */
export function modelsForDepot(kind: DepotKind, railType?: RailType | null): VehicleModel[] {
  return VEHICLE_MODELS.filter(
    (model) => model.depot === kind && modelCompatibleWithRail(model, railType),
  );
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

/**
 * Tournée typée à partir du snapshot.
 *
 * `orderKinds` (fourni par le mock) lève l'ambiguïté entre les pools
 * d'identifiants gares/industries/dépôts. À défaut, on retombe sur l'ordre de
 * résolution historique — gare, industrie, dépôt — car le pont v1 n'expose que
 * des arrêts de gare dans `orderTargets`.
 */
export function ordersFromSnapshot(
  vehicle: { orderTargets: readonly number[]; orderKinds?: readonly OrderTargetKind[] },
  snapshot: WorldSnapshot | null,
): VehicleOrder[] {
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
  for (const order of orders) {
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
  return { ok: true, reason: null };
}

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
    orders: orders.map((order) => ({ target: order.target, kind: order.kind })),
  };
}
