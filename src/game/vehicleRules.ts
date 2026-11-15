/**
 * Règles véhicules partagées par l'interface et par `MockEngine`.
 *
 * Module pur (aucun DOM, aucun Three.js) : catalogue des modèles, lecture des
 * tuiles de dépôt, validation des tournées et fabrique de commandes
 * `EngineCommand.vehicle`. Comme `buildRules`, il ne simule rien : l'interface
 * s'en sert pour composer une commande, le moteur reste seul juge de son
 * application (fonds, dépôt, ordres).
 *
 * Le protocole v1 ne transporte pas encore de liste de dépôts : une tuile
 * dépôt est une tuile route/rail portant le bit privé `DEPOT_TRACK_BIT` dans
 * `trackBits`. Le mock le pose ; un futur pont WASM exposera de vrais
 * identifiants (voir wiki Protocole > évolutions).
 */

import {
  TILE_KIND_INDEX,
  type CompanyId,
  type EngineCommand,
  type MapSnapshot,
  type StationSnapshot,
  type VehicleKind,
  type WorldSnapshot,
} from '../engine/protocol';
import { TILE_KINDS, inBounds, tileIndex } from './mapGrid';

export type DepotKind = 'road' | 'rail';

export type VehicleOrderKind = 'station' | 'industry' | 'depot';

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
}

/**
 * Bit privé de `trackBits` marquant une tuile de dépôt.
 *
 * Les bits 0..3 portent les connexions nord/est/sud/ouest ; les bits 4..7
 * sont libres dans le protocole v1. Le mock utilise le bit 7, ignoré par le
 * rendu des voies et par les règles de gare (qui ne lisent que 0..3).
 */
export const DEPOT_TRACK_BIT = 1 << 7;

/**
 * Base des identifiants de dépôt utilisés comme cible d'ordre.
 *
 * Les gares ont des identifiants fournis par le snapshot ; les dépôts v1 n'en
 * ont pas. Le mock encode donc la tuile dans un identifiant stable tant que le
 * dépôt existe : `base + y * largeur + x`.
 */
export const DEPOT_ORDER_TARGET_BASE = 1_000_000;

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

/** Modèles achetables dans un dépôt route ou rail. */
export function modelsForDepot(kind: DepotKind): VehicleModel[] {
  return VEHICLE_MODELS.filter((model) => model.depot === kind);
}

/** Axe de la tuile, utilisé seulement pour reconnaître un dépôt cohérent. */
function depotKindFromTile(kind: number): DepotKind | null {
  if (kind === TILE_KIND_INDEX.road) return 'road';
  if (kind === TILE_KIND_INDEX.rail) return 'rail';
  return null;
}

/** Type de dépôt porté par une tuile, ou `null` si ce n'est pas un dépôt. */
export function depotKindAt(map: MapSnapshot, x: number, y: number): DepotKind | null {
  if (!inBounds(x, y, map.width, map.height)) return null;
  const index = tileIndex(x, y, map.width);
  if (((map.trackBits[index] ?? 0) & DEPOT_TRACK_BIT) === 0) return null;
  return depotKindFromTile(map.kind[index] ?? TILE_KIND_INDEX.void);
}

export function isDepotTile(map: MapSnapshot, x: number, y: number): boolean {
  return depotKindAt(map, x, y) !== null;
}

/** Identifiant de cible d'ordre d'un dépôt (mock v1). */
export function depotOrderTarget(x: number, y: number, width: number): number {
  return DEPOT_ORDER_TARGET_BASE + y * width + x;
}

/** Tuile encodée dans une cible d'ordre de type dépôt, ou `null`. */
export function depotTileFromTarget(
  target: number,
  map: Pick<MapSnapshot, 'width' | 'height'>,
): { x: number; y: number } | null {
  if (!Number.isFinite(target) || target < DEPOT_ORDER_TARGET_BASE) return null;
  const tile = Math.floor(target) - DEPOT_ORDER_TARGET_BASE;
  if (tile < 0) return null;
  const x = tile % map.width;
  const y = Math.floor(tile / map.width);
  if (!inBounds(x, y, map.width, map.height)) return null;
  return { x, y };
}

/** Cible d'ordre stable pour une gare cliquée sur la carte. */
export function stationOrder(station: StationSnapshot): VehicleOrder {
  return { target: station.id, kind: 'station' };
}

/** Cible d'ordre stable pour un dépôt cliqué sur la carte. */
export function depotOrder(x: number, y: number, width: number): VehicleOrder {
  return { target: depotOrderTarget(x, y, width), kind: 'depot' };
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
export function orderTargetLabel(
  order: VehicleOrder,
  snapshot: WorldSnapshot | null,
  map: Pick<MapSnapshot, 'width' | 'height'> | null,
): string {
  if (order.kind === 'station') {
    const station = snapshot?.stations.find((item) => item.id === order.target);
    return station?.name ?? `Gare #${order.target}`;
  }
  if (order.kind === 'industry') {
    const industry = snapshot?.industries.find((item) => item.id === order.target);
    return industry?.name ?? `Industrie #${order.target}`;
  }
  const tile = map ? depotTileFromTarget(order.target, map) : null;
  return tile ? `Dépôt (${tile.x}, ${tile.y})` : `Dépôt #${order.target}`;
}

/**
 * Tournée lisible à partir du snapshot : `orderTargets` ne transporte pas le
 * type de cible, on le déduit des gares, industries et dépôts connus.
 */
export function ordersFromSnapshot(
  vehicle: { orderTargets: readonly number[] },
  snapshot: WorldSnapshot | null,
  map: Pick<MapSnapshot, 'width' | 'height'> | null,
): VehicleOrder[] {
  return vehicle.orderTargets.map((target) => {
    if (map && depotTileFromTarget(target, map)) return { target, kind: 'depot' };
    if (snapshot?.stations.some((station) => station.id === target)) {
      return { target, kind: 'station' };
    }
    if (snapshot?.industries.some((industry) => industry.id === target)) {
      return { target, kind: 'industry' };
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
  map: MapSnapshot | null,
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
    const tile = map ? depotTileFromTarget(order.target, map) : null;
    if (!tile || !map || depotKindAt(map, tile.x, tile.y) === null) {
      return { ok: false, reason: 'Dépôt cible inconnu : ajoutez-le depuis la carte.' };
    }
  }
  return { ok: true, reason: null };
}

/** Commande d'achat d'un modèle dans un dépôt. */
export function buyVehicleCommand(
  company: CompanyId,
  depot: { x: number; y: number },
  model: string,
): Extract<EngineCommand, { type: 'vehicle' }> {
  return { type: 'vehicle', action: 'buy', company, depot: { x: depot.x, y: depot.y }, model };
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

/** Libellé court d'un type de tuile dépôt (débogage, tests). */
export function depotTileKindLabel(map: MapSnapshot, x: number, y: number): string {
  const kind = depotKindAt(map, x, y);
  if (kind) return depotKindLabel(kind);
  if (!inBounds(x, y, map.width, map.height)) return 'Hors carte';
  return TILE_KINDS[map.kind[tileIndex(x, y, map.width)] ?? 0] ?? 'Void';
}
