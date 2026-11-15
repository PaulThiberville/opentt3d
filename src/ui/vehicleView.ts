/**
 * Vues des panneaux dépôt et véhicule.
 *
 * Pures : snapshot + carte + identifiants → textes et listes prêtes pour le
 * DOM. Aucune valeur de simulation n'est recalculée : les prix viennent du
 * catalogue partagé (`vehicleRules`), l'état du snapshot.
 */

import type { MapSnapshot, OrderOptions, WorldSnapshot } from '../engine/protocol';
import {
  ORDER_ACTION_LABELS,
  cloneOrderOptions,
  depotById,
  depotKindLabel,
  inferVehicleModel,
  modelsForDepot,
  orderConditionLabel,
  orderTargetLabel,
  ordersFromSnapshot,
  refitCost,
  refitOptions,
  vehicleModel,
} from '../game/vehicleRules';
import { RAIL_TYPE_LABELS } from '../game/railRules';
import { modelKindFor } from '../game/vehicleInterpolation';
import { companyColour } from '../render/tileVisuals';
import { vehicleVariantFor, type VehicleVariant } from '../render/vehicleModels';
import { cargoLabel, vehicleLabel, vehicleStatusLabel } from './labels';
import { formatInt, formatMoney } from './format';
import { describeSelection } from './selection';
import type { DepotPanelView, VehiclePanelView, VehicleOrderView } from './types';

/** Distance maximale (tuiles) pour considérer un véhicule « dans » le dépôt. */
const DEPOT_RADIUS = 1.25;

/**
 * Archétype visuel de chaque modèle du catalogue.
 *
 * Le catalogue du contrat ne transporte pas encore de variante : on l'aligne
 * ici sur les archétypes du rendu principal, sans modifier les règles de jeu.
 */
const CATALOGUE_VARIANTS: Record<string, VehicleVariant> = {
  bus_city: 'bus-city',
  bus_intercity: 'bus-coach',
  truck_flatbed: 'truck-flat',
  truck_tanker: 'truck-tanker',
  rail_autorail: 'train-coach',
  rail_freight: 'train-steam',
};

/** Variante d'un modèle du catalogue, avec repli sur la famille du contrat. */
function catalogueVariant(modelId: string, kind: string): VehicleVariant {
  return CATALOGUE_VARIANTS[modelId] ?? (kind === 'train' ? 'train-coach' : 'truck-flat');
}

/** Panneau d'un dépôt : modèles achetables et véhicules sur place. */
export function describeDepotPanel(
  snapshot: WorldSnapshot | null,
  companyId: number | null,
  depotId: number,
): DepotPanelView | null {
  if (!snapshot || companyId === null) return null;
  const depot = depotById(snapshot, depotId);
  if (!depot) return null;
  const company = snapshot.companies.find((item) => item.id === companyId) ?? null;
  const money = company?.money ?? 0;
  // Livrée des vignettes : couleur d'entreprise, ou bleu par défaut.
  const colour = companyColour(company?.colour ?? 8);
  const kindLabel = depotKindLabel(depot.kind);
  const models = modelsForDepot(depot.kind, depot.railType).map((model) => ({
    id: model.id,
    name: model.name,
    cargo: cargoLabel(model.cargo),
    capacity: model.capacity,
    speed: model.speed,
    cost: model.cost,
    maintenance: model.maintenance,
    description: model.description,
    affordable: money >= model.cost,
    variant: catalogueVariant(model.id, model.kind),
    colour,
  }));
  const centreX = depot.x + depot.width / 2;
  const centreY = depot.y + depot.height / 2;
  const vehicles = snapshot.vehicles
    .filter(
      (vehicle) =>
        vehicle.company === companyId &&
        vehicle.status === 3 &&
        Math.abs(vehicle.x - centreX) <= DEPOT_RADIUS &&
        Math.abs(vehicle.y - centreY) <= DEPOT_RADIUS,
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
        variant: vehicleVariantFor(modelKindFor(vehicle), vehicle.id),
        colour,
      };
    });
  return {
    id: depot.id,
    x: depot.x,
    y: depot.y,
    kindLabel,
    title: `${kindLabel} (${depot.x}, ${depot.y})`,
    detail: `${depot.railType ? `${RAIL_TYPE_LABELS[depot.railType]} · ` : ''}${models.length} modèle(s) · ${vehicles.length} véhicule(s) sur place`,
    money: company ? formatMoney(company.money) : '—',
    models,
    vehicles,
    hint:
      vehicles.length > 0
        ? 'Sélectionnez un véhicule pour éditer sa tournée, ou achetez-en un autre.'
        : 'Achetez un véhicule, ajoutez une gare à sa tournée puis démarrez-le.',
  };
}

/** Résumé d'horaire d'un ordre (#162). */
function timetableLabel(options: OrderOptions): string | null {
  const timetable = options.timetable;
  if (!timetable) return null;
  const parts: string[] = [];
  if (timetable.waitTicks !== undefined) parts.push(`attente ${formatInt(timetable.waitTicks)} t`);
  if (timetable.travelTicks !== undefined) {
    parts.push(`trajet ${formatInt(timetable.travelTicks)} t`);
  }
  if (timetable.autostart) parts.push('départ auto');
  return parts.length > 0 ? parts.join(' · ') : null;
}

function describeOrder(
  order: ReturnType<typeof ordersFromSnapshot>[number],
  index: number,
  currentOrder: number | null,
  snapshot: WorldSnapshot | null,
): VehicleOrderView {
  const options = order.options ?? {};
  const action = options.action ?? 'normal';
  return {
    index,
    label: orderTargetLabel(order, snapshot),
    kind: order.kind,
    action,
    actionLabel: ORDER_ACTION_LABELS[action],
    conditionLabel: orderConditionLabel(options.condition, cargoLabel),
    jumpLabel: options.jump !== undefined ? `saut vers l’ordre ${options.jump + 1}` : null,
    timetableLabel: timetableLabel(options),
    current: currentOrder === index,
    options: cloneOrderOptions(options),
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
  const orders = ordersFromSnapshot(vehicle, snapshot);
  const currentOrder =
    vehicle.currentOrder !== undefined && vehicle.currentOrder >= 0 ? vehicle.currentOrder : null;
  const orderViews = orders.map((order, index) =>
    describeOrder(order, index, currentOrder, snapshot),
  );
  const model =
    vehicleModel(vehicle.model) ?? inferVehicleModel(vehicle.kind, vehicle.cargo?.type ?? null);
  const company = snapshot.companies.find((item) => item.id === vehicle.company) ?? null;
  const money = company?.money ?? 0;
  const inDepot = vehicle.status === 3;
  const cargoAmount = vehicle.cargo?.amount ?? 0;
  const cargoCapacity = vehicle.cargo?.capacity ?? 0;
  const cargoType = vehicle.cargo?.type ?? '';
  const refits = model
    ? refitOptions(model).map((option) => {
        const cost = refitCost(model);
        let reason: string | null = null;
        if (!inDepot) reason = 'Le véhicule doit être dans un dépôt.';
        else if (option.cargo === cargoType) reason = 'Cargaison déjà configurée.';
        else if (money < cost) reason = 'Trésorerie insuffisante.';
        return {
          cargo: option.cargo,
          label: cargoLabel(option.cargo),
          capacity: option.capacity,
          cost,
          available: reason === null,
          reason,
        };
      })
    : [];
  const status = vehicleStatusLabel(vehicle.status);
  return {
    ...summary,
    status,
    modelName: model?.name ?? null,
    cargo: {
      label: cargoLabel(cargoType || 'goods'),
      amount: cargoAmount,
      capacity: cargoCapacity,
      percent:
        cargoCapacity > 0 ? Math.min(100, Math.round((cargoAmount / cargoCapacity) * 100)) : 0,
    },
    orders: orderViews,
    currentOrder,
    refits,
    inDepot,
    cargoAtRisk: cargoAmount,
    shareCandidates: snapshot.vehicles
      .filter((item) => item.id !== vehicleId && item.company === vehicle.company)
      .map((item) => ({ id: item.id, label: `${vehicleLabel(item.kind)} #${item.id}` })),
    canStart:
      orders.some((order) => order.kind !== 'conditional') &&
      vehicle.status !== 1 &&
      vehicle.status !== 2,
    canStop: vehicle.status === 1 || vehicle.status === 2,
    canSell: true,
    orderPicking,
    hint:
      orders.length === 0
        ? 'Aucun ordre : cliquez sur « Ajouter une gare », puis sur une gare ou un dépôt de la carte.'
        : orderPicking
          ? 'Cliquez sur une gare ou un dépôt de la carte pour l’ajouter à la tournée.'
          : inDepot
            ? 'Reconfigurez la cargaison, partagez la tournée ou démarrez le véhicule.'
            : 'Modifiez les options d’un ordre avec ✎, puis démarrez ou arrêtez le véhicule.',
  };
}
