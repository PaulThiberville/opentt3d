/**
 * Vues des panneaux lieu : ville, industrie et gare.
 *
 * Pures : `snapshot` + sélection → textes et listes prêtes pour le DOM. Aucune
 * valeur de simulation n'est recalculée et aucune dépense n'est inventée :
 * quand le protocole v1 n'expose pas une action (financement municipal,
 * subvention), la vue la marque `supported: false` avec une explication.
 */

import type { IndustrySnapshot, StationSnapshot, WorldSnapshot } from '../engine/protocol';
import type { Selection } from '../game/Game';
import { ordersFromSnapshot } from '../game/vehicleRules';
import { companyColour } from '../render/tileVisuals';
import {
  cargoLabel,
  industryKindLabel,
  stationLabel,
  vehicleLabel,
  vehicleStatusLabel,
} from './labels';
import { formatDecimal, formatInt, formatPercent, formatRating } from './format';
import { t } from './i18n';
import type {
  PlacePanelAction,
  PlacePanelItem,
  PlacePanelView,
  PlaceTarget,
  SelectionStat,
} from './types';

/** Rayon d'affichage des gares et industries proches d'une ville (tuiles). */
const NEARBY_RADIUS = 24;

/** Demi-emprise d'une industrie autour de son centre (tuiles). */
const INDUSTRY_HALF_EXTENT = 1.6;

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function stat(label: string, value: string, tone?: SelectionStat['tone']): SelectionStat {
  return tone ? { label, value, tone } : { label, value };
}

function waitingTotal(station: StationSnapshot): number {
  return station.waiting.reduce((total, entry) => total + entry.amount, 0);
}

function waitingText(station: StationSnapshot): string {
  return t('selection.unit.units', { count: formatInt(waitingTotal(station)) });
}

function distanceText(distance: number): string {
  return t('place.distance', { value: formatDecimal(distance) });
}

function vehicleCargoText(vehicle: {
  cargo: { type: string; amount: number; capacity: number } | null;
}): string {
  if (!vehicle.cargo) return t('selection.vacant');
  return `${cargoLabel(vehicle.cargo.type)} ${formatInt(vehicle.cargo.amount)} / ${formatInt(
    vehicle.cargo.capacity,
  )}`;
}

/** Gare la plus proche d'un lieu, avec sa distance en tuiles. */
interface NearbyStation {
  station: StationSnapshot;
  distance: number;
}

interface NearbyIndustry {
  industry: IndustrySnapshot;
  distance: number;
}

function stationsNear(snapshot: WorldSnapshot, centre: { x: number; y: number }): NearbyStation[] {
  return snapshot.stations
    .map((station) => ({ station, distance: distanceBetween(centre, station) }))
    .filter((entry) => entry.distance <= NEARBY_RADIUS)
    .sort((a, b) => a.distance - b.distance);
}

function industriesNear(
  snapshot: WorldSnapshot,
  centre: { x: number; y: number },
): NearbyIndustry[] {
  return snapshot.industries
    .map((industry) => ({ industry, distance: distanceBetween(centre, industry) }))
    .filter((entry) => entry.distance <= NEARBY_RADIUS)
    .sort((a, b) => a.distance - b.distance);
}

function stationItem(entry: NearbyStation): PlacePanelItem {
  return {
    id: `station-${entry.station.id}`,
    label: entry.station.name,
    detail: t('place.item.station', {
      kind: stationLabel(entry.station.kind),
      waiting: waitingText(entry.station),
      distance: distanceText(entry.distance),
    }),
    target: { kind: 'station', id: entry.station.id },
  };
}

function industryItem(entry: NearbyIndustry): PlacePanelItem {
  return {
    id: `industry-${entry.industry.id}`,
    label: entry.industry.name,
    detail: t('place.item.industry', {
      kind: industryKindLabel(entry.industry.kind),
      value: formatInt(entry.industry.production),
      distance: distanceText(entry.distance),
    }),
    target: { kind: 'industry', id: entry.industry.id },
  };
}

/**
 * Industrie dont l'emprise contient la tuile cliquée.
 *
 * Le protocole expose un centre (`x`, `y`) sans dimensions : v1 utilise une
 * emprise de 3×3 tuiles autour de ce centre, comme le moteur mock.
 */
export function industryAtTile(
  snapshot: WorldSnapshot | null,
  x: number,
  y: number,
): IndustrySnapshot | null {
  if (!snapshot) return null;
  const centreX = x + 0.5;
  const centreY = y + 0.5;
  return (
    snapshot.industries.find(
      (industry) =>
        Math.abs(centreX - industry.x) <= INDUSTRY_HALF_EXTENT &&
        Math.abs(centreY - industry.y) <= INDUSTRY_HALF_EXTENT,
    ) ?? null
  );
}

/** Vrai pour une sélection qui ouvre un panneau lieu. */
export function isPlaceSelection(
  selection: Selection | null,
): selection is Selection & { kind: 'town' | 'industry' | 'station' } {
  return (
    selection?.kind === 'town' || selection?.kind === 'industry' || selection?.kind === 'station'
  );
}

/** Vue du panneau correspondant à la sélection, ou `null` si le lieu a disparu. */
export function describePlacePanel(
  snapshot: WorldSnapshot | null,
  selection: Selection | null,
): PlacePanelView | null {
  if (!snapshot || !selection) return null;
  switch (selection.kind) {
    case 'town':
      return describeTownPanel(snapshot, selection.id);
    case 'industry':
      return describeIndustryPanel(snapshot, selection.id);
    case 'station':
      return describeStationPanel(snapshot, selection.id);
    default:
      return null;
  }
}

/** Panneau ville : démographie, satisfaction, gares et industries proches. */
export function describeTownPanel(
  snapshot: WorldSnapshot | null,
  townId: number,
): PlacePanelView | null {
  const town = snapshot?.towns.find((item) => item.id === townId);
  if (!snapshot || !town) return null;
  const stations = stationsNear(snapshot, town);
  const industries = industriesNear(snapshot, town);
  const actions: PlacePanelAction[] = [
    {
      id: 'focus',
      label: t('place.action.show'),
      kind: 'focus',
      supported: true,
    },
    {
      id: 'fund-town',
      label: t('place.action.fundTown'),
      kind: 'unsupported',
      supported: false,
      reason: t('place.reason.fundTown'),
    },
  ];
  return {
    kind: 'town',
    id: town.id,
    x: town.x,
    y: town.y,
    title: town.name,
    detail: t('selection.townDetail', {
      population: formatInt(town.population),
      buildings: formatInt(town.buildings),
    }),
    colour: null,
    stats: [
      stat(t('selection.stat.population'), formatInt(town.population)),
      stat(
        t('selection.stat.growth'),
        t('selection.unit.perDay', { value: formatInt(town.growthRate) }),
        town.growthRate > 0 ? 'good' : 'muted',
      ),
      stat(
        t('place.stat.satisfaction'),
        formatRating(town.rating),
        town.rating >= 60 ? 'good' : town.rating >= 30 ? undefined : 'bad',
      ),
      stat(t('selection.stat.buildings'), formatInt(town.buildings)),
      stat(t('place.stat.nearbyStations'), formatInt(stations.length)),
      stat(t('place.stat.nearbyIndustries'), formatInt(industries.length)),
    ],
    sections: [
      {
        id: 'stations',
        title: t('place.section.stations'),
        empty: t('place.empty.stations'),
        items: stations.map(stationItem),
      },
      {
        id: 'industries',
        title: t('place.section.industries'),
        empty: t('place.empty.industries'),
        items: industries.map(industryItem),
      },
    ],
    actions,
    hint: t('place.hint.town'),
  };
}

/** Véhicules dont la tournée passe par une cible donnée. */
function vehiclesServing(
  snapshot: WorldSnapshot,
  kind: 'station' | 'industry',
  target: number,
): WorldSnapshot['vehicles'] {
  return snapshot.vehicles.filter((vehicle) =>
    ordersFromSnapshot(vehicle, snapshot).some(
      (order) => order.kind === kind && order.target === target,
    ),
  );
}

function vehicleItems(vehicles: WorldSnapshot['vehicles']): PlacePanelItem[] {
  return vehicles.map((vehicle) => ({
    id: `vehicle-${vehicle.id}`,
    label: t('place.item.vehicle', {
      kind: vehicleLabel(vehicle.kind),
      id: vehicle.id,
    }),
    detail: t('place.item.vehicleDetail', {
      status: vehicleStatusLabel(vehicle.status),
      cargo: vehicleCargoText(vehicle),
    }),
    target: { kind: 'vehicle', id: vehicle.id },
  }));
}

/** Gares visitées par les tournées des véhicules fournis. */
function stationsServedBy(
  snapshot: WorldSnapshot,
  vehicles: WorldSnapshot['vehicles'],
): PlacePanelItem[] {
  const ids = new Set<number>();
  for (const vehicle of vehicles) {
    for (const order of ordersFromSnapshot(vehicle, snapshot)) {
      if (order.kind === 'station') ids.add(order.target);
    }
  }
  return snapshot.stations
    .filter((station) => ids.has(station.id))
    .map((station) => ({
      id: `served-station-${station.id}`,
      label: station.name,
      detail: t('place.item.servedStation', {
        kind: stationLabel(station.kind),
        waiting: waitingText(station),
      }),
      target: { kind: 'station', id: station.id },
    }));
}

/** Panneau industrie : production, stocks, gares desservies et véhicules. */
export function describeIndustryPanel(
  snapshot: WorldSnapshot | null,
  industryId: number,
): PlacePanelView | null {
  const industry = snapshot?.industries.find((item) => item.id === industryId);
  if (!snapshot || !industry) return null;
  const serving = vehiclesServing(snapshot, 'industry', industry.id);
  const servedStations = stationsServedBy(snapshot, serving);
  const stockTotal = industry.stocks.reduce((total, entry) => total + entry.amount, 0);
  return {
    kind: 'industry',
    id: industry.id,
    x: industry.x,
    y: industry.y,
    title: industry.name,
    detail: t('selection.industryDetail', {
      kind: industryKindLabel(industry.kind),
      value: formatInt(industry.production),
    }),
    colour: null,
    stats: [
      stat(t('selection.stat.type'), industryKindLabel(industry.kind)),
      stat(t('selection.stat.production'), formatInt(industry.production)),
      stat(t('selection.stat.transported'), formatInt(industry.transported), 'good'),
      stat(
        t('selection.stat.stocks'),
        t('selection.unit.units', { count: formatInt(stockTotal) }),
        'muted',
      ),
      stat(t('place.stat.servedStations'), formatInt(servedStations.length)),
      stat(t('place.stat.vehicles'), formatInt(serving.length)),
    ],
    sections: [
      {
        id: 'stocks',
        title: t('place.section.stocks'),
        empty: t('place.empty.stocks'),
        items: industry.stocks.map((entry) => ({
          id: `stock-${entry.cargo}`,
          label: cargoLabel(entry.cargo),
          detail: t('selection.unit.units', { count: formatInt(entry.amount) }),
        })),
      },
      {
        id: 'served-stations',
        title: t('place.section.servedStations'),
        empty: t('place.empty.servedStations'),
        items: servedStations,
      },
      {
        id: 'vehicles',
        title: t('place.section.vehicles'),
        empty: t('place.empty.vehicles'),
        items: vehicleItems(serving),
      },
    ],
    actions: [
      {
        id: 'focus',
        label: t('place.action.show'),
        kind: 'focus',
        supported: true,
      },
      {
        id: 'subsidize',
        label: t('place.action.subsidize'),
        kind: 'unsupported',
        supported: false,
        reason: t('place.reason.subsidize'),
      },
    ],
    hint: t('place.hint.industry'),
  };
}

/**
 * Taux de service optionnel. Le protocole v1 ne l'expose pas encore : la vue
 * affiche « non exposé » plutôt qu'une valeur inventée. Une valeur 0..1 est
 * traitée comme un ratio, 1..100 comme un pourcentage.
 */
function serviceRateOf(station: StationSnapshot): number | null {
  const value = (station as StationSnapshot & { serviceRate?: unknown }).serviceRate;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

/** Panneau gare : attente par cargo, véhicules desservants et taux de service. */
export function describeStationPanel(
  snapshot: WorldSnapshot | null,
  stationId: number,
): PlacePanelView | null {
  const station = snapshot?.stations.find((item) => item.id === stationId);
  if (!snapshot || !station) return null;
  const company = snapshot.companies.find((item) => item.id === station.company);
  const serving = vehiclesServing(snapshot, 'station', station.id);
  const total = waitingTotal(station);
  const serviceRate = serviceRateOf(station);
  return {
    kind: 'station',
    id: station.id,
    x: station.x,
    y: station.y,
    title: station.name,
    detail: t('place.company', {
      company: company?.name ?? t('selection.unknownCompany'),
      kind: stationLabel(station.kind),
    }),
    colour: company ? companyColour(company.colour) : null,
    stats: [
      stat(t('selection.stat.type'), stationLabel(station.kind)),
      stat(t('selection.stat.company'), company?.name ?? '—', 'muted'),
      stat(
        t('selection.stat.waiting'),
        t('selection.unit.units', { count: formatInt(total) }),
        total > 0 ? 'good' : 'muted',
      ),
      stat(
        t('place.stat.service'),
        serviceRate === null ? t('place.service.unavailable') : formatPercent(serviceRate),
        serviceRate === null ? 'muted' : undefined,
      ),
      stat(t('place.stat.vehicles'), formatInt(serving.length)),
      stat(
        t('place.stat.footprint'),
        t('place.unit.footprint', {
          width: formatInt(station.width),
          height: formatInt(station.height),
        }),
        'muted',
      ),
    ],
    sections: [
      {
        id: 'waiting',
        title: t('place.section.waiting'),
        empty: t('place.empty.waiting'),
        items: station.waiting.map((entry) => ({
          id: `waiting-${entry.cargo}`,
          label: cargoLabel(entry.cargo),
          detail: t('selection.unit.units', { count: formatInt(entry.amount) }),
        })),
      },
      {
        id: 'vehicles',
        title: t('place.section.vehicles'),
        empty: t('place.empty.vehicles'),
        items: vehicleItems(serving),
      },
    ],
    actions: [
      {
        id: 'focus',
        label: t('place.action.show'),
        kind: 'focus',
        supported: true,
      },
    ],
    hint: serviceRate === null ? t('place.hint.station') : t('place.hint.stationService'),
  };
}

/** Cible cliquable d'une section, validée contre le snapshot courant. */
export function placeTargetExists(snapshot: WorldSnapshot | null, target: PlaceTarget): boolean {
  if (!snapshot) return false;
  if (target.kind === 'station') {
    return snapshot.stations.some((station) => station.id === target.id);
  }
  if (target.kind === 'industry') {
    return snapshot.industries.some((industry) => industry.id === target.id);
  }
  return snapshot.vehicles.some((vehicle) => vehicle.id === target.id);
}
