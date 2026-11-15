/**
 * Vues des panneaux dépôt et véhicule.
 *
 * Pures : snapshot + carte + identifiants → textes et listes prêtes pour le
 * DOM. Aucune valeur de simulation n'est recalculée : les prix viennent du
 * catalogue partagé (`vehicleRules`), l'état du snapshot.
 */

import type { MapSnapshot, WorldSnapshot } from '../engine/protocol';
import {
  depotKindAt,
  depotKindLabel,
  modelsForDepot,
  orderTargetLabel,
  ordersFromSnapshot,
} from '../game/vehicleRules';
import { cargoLabel, vehicleLabel, vehicleStatusLabel } from './labels';
import { formatInt, formatMoney } from './format';
import { describeSelection } from './selection';
import type { DepotPanelView, VehiclePanelView } from './types';

export interface DepotTarget {
  x: number;
  y: number;
}

/** Distance maximale (tuiles) pour considérer un véhicule « dans » le dépôt. */
const DEPOT_RADIUS = 1.25;

/** Panneau d'un dépôt : modèles achetables et véhicules sur place. */
export function describeDepotPanel(
  snapshot: WorldSnapshot | null,
  map: MapSnapshot | null,
  companyId: number | null,
  depot: DepotTarget,
): DepotPanelView | null {
  if (!snapshot || !map || companyId === null) return null;
  const kind = depotKindAt(map, depot.x, depot.y);
  if (!kind) return null;
  const company = snapshot.companies.find((item) => item.id === companyId) ?? null;
  const money = company?.money ?? 0;
  const kindLabel = depotKindLabel(kind);
  const models = modelsForDepot(kind).map((model) => ({
    id: model.id,
    name: model.name,
    cargo: cargoLabel(model.cargo),
    capacity: model.capacity,
    speed: model.speed,
    cost: model.cost,
    maintenance: model.maintenance,
    description: model.description,
    affordable: money >= model.cost,
  }));
  const vehicles = snapshot.vehicles
    .filter(
      (vehicle) =>
        vehicle.company === companyId &&
        vehicle.status === 3 &&
        Math.abs(vehicle.x - (depot.x + 0.5)) <= DEPOT_RADIUS &&
        Math.abs(vehicle.y - (depot.y + 0.5)) <= DEPOT_RADIUS,
    )
    .map((vehicle) => {
      const cargo = vehicle.cargo
        ? `${cargoLabel(vehicle.cargo.type)} ${formatInt(vehicle.cargo.amount)} / ${formatInt(
            vehicle.cargo.capacity,
          )}`
        : 'Vide';
      return {
        id: vehicle.id,
        name: `${vehicleLabel(vehicle.kind)} #${vehicle.id}`,
        detail: `${vehicleStatusLabel(vehicle.status)} · ${cargo}`,
        canStart: vehicle.orderTargets.length > 0,
        canStop: false,
      };
    });
  return {
    x: depot.x,
    y: depot.y,
    kindLabel,
    title: `${kindLabel} (${depot.x}, ${depot.y})`,
    detail: `${models.length} modèle(s) · ${vehicles.length} véhicule(s) sur place`,
    money: company ? formatMoney(company.money) : '—',
    models,
    vehicles,
    hint:
      vehicles.length > 0
        ? 'Sélectionnez un véhicule pour éditer sa tournée, ou achetez-en un autre.'
        : 'Achetez un véhicule, ajoutez une gare à sa tournée puis démarrez-le.',
  };
}

/** Panneau d'un véhicule sélectionné : état, actions et tournée ordonnée. */
export function describeVehiclePanel(
  snapshot: WorldSnapshot | null,
  map: MapSnapshot | null,
  vehicleId: number,
  orderPicking: boolean,
): VehiclePanelView | null {
  if (!snapshot) return null;
  const vehicle = snapshot.vehicles.find((item) => item.id === vehicleId);
  if (!vehicle) return null;
  const summary = describeSelection(snapshot, { kind: 'vehicle', id: vehicleId }, null, map);
  if (!summary) return null;
  const orders = ordersFromSnapshot(vehicle, snapshot, map).map((order, index) => ({
    index,
    label: orderTargetLabel(order, snapshot, map),
    kind: order.kind,
  }));
  const status = vehicleStatusLabel(vehicle.status);
  return {
    ...summary,
    status,
    orders,
    canStart: orders.length > 0 && vehicle.status !== 1 && vehicle.status !== 2,
    canStop: vehicle.status === 1 || vehicle.status === 2,
    canSell: true,
    orderPicking,
    hint:
      orders.length === 0
        ? 'Aucun ordre : cliquez sur « Ajouter une gare », puis sur une gare ou un dépôt de la carte.'
        : orderPicking
          ? 'Cliquez sur une gare ou un dépôt de la carte pour l’ajouter à la tournée.'
          : 'Démarrez le véhicule pour qu’il parcoure sa tournée et génère du revenu.',
  };
}
