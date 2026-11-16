/**
 * Libellés localisés des valeurs du protocole.
 *
 * Les clés restent les identifiants anglais du protocole ; seuls les textes
 * affichés passent par le catalogue i18n. Une valeur inconnue retombe
 * proprement sur sa clé brute.
 */

import { t, type TranslationKey } from './i18n';

export const VEHICLE_LABEL_KEYS: Record<string, TranslationKey> = {
  train: 'label.vehicle.train',
  road: 'label.vehicle.road',
  ship: 'label.vehicle.ship',
  aircraft: 'label.vehicle.aircraft',
};

export const STATION_LABEL_KEYS: Record<string, TranslationKey> = {
  train: 'label.station.train',
  road: 'label.station.road',
  ship: 'label.station.ship',
  airport: 'label.station.airport',
  buoy: 'label.station.buoy',
};

export const CARGO_LABEL_KEYS: Record<string, TranslationKey> = {
  passengers: 'label.cargo.passengers',
  mail: 'label.cargo.mail',
  coal: 'label.cargo.coal',
  wood: 'label.cargo.wood',
  grain: 'label.cargo.grain',
  goods: 'label.cargo.goods',
  oil: 'label.cargo.oil',
  livestock: 'label.cargo.livestock',
  valuables: 'label.cargo.valuables',
  iron_ore: 'label.cargo.iron_ore',
  steel: 'label.cargo.steel',
  water: 'label.cargo.water',
  fruit: 'label.cargo.fruit',
  maize: 'label.cargo.maize',
  food: 'label.cargo.food',
};

export const VEHICLE_STATUS_KEYS: Record<number, TranslationKey> = {
  0: 'label.status.stopped',
  1: 'label.status.route',
  2: 'label.status.station',
  3: 'label.status.depot',
  4: 'label.status.waiting',
};

export const TILE_KIND_KEYS: Record<string, TranslationKey> = {
  void: 'label.tile.void',
  clear: 'label.tile.clear',
  grass: 'label.tile.grass',
  rough: 'label.tile.rough',
  water: 'label.tile.water',
  coast: 'label.tile.coast',
  rail: 'label.tile.rail',
  road: 'label.tile.road',
  house: 'label.tile.house',
  trees: 'label.tile.trees',
  station: 'label.tile.station',
  industry: 'label.tile.industry',
  bridge: 'label.tile.bridge',
  tunnel: 'label.tile.tunnel',
  object: 'label.tile.object',
  airport: 'label.tile.airport',
  dock: 'label.tile.dock',
  canal: 'label.tile.canal',
  river: 'label.tile.river',
  lock: 'label.tile.lock',
  aqueduct: 'label.tile.aqueduct',
  crossing: 'label.tile.crossing',
};

export const INDUSTRY_KIND_KEYS: Record<string, TranslationKey> = {
  coal_mine: 'label.industry.coal_mine',
  power_station: 'label.industry.power_station',
  sawmill: 'label.industry.sawmill',
  farm: 'label.industry.farm',
  factory: 'label.industry.factory',
  oil_well: 'label.industry.oil_well',
  refinery: 'label.industry.refinery',
  steel_mill: 'label.industry.steel_mill',
  forest: 'label.industry.forest',
};

export function keyOf(labels: Record<string, TranslationKey>, key: string): string {
  const translation = labels[key];
  return translation ? t(translation) : key;
}

export function cargoLabel(type: string): string {
  return keyOf(CARGO_LABEL_KEYS, type);
}

export function vehicleLabel(kind: string): string {
  return keyOf(VEHICLE_LABEL_KEYS, kind);
}

export function stationLabel(kind: string): string {
  return keyOf(STATION_LABEL_KEYS, kind);
}

export function industryKindLabel(kind: string): string {
  return keyOf(INDUSTRY_KIND_KEYS, kind);
}

export function tileKindLabel(kind: string): string {
  return keyOf(TILE_KIND_KEYS, kind);
}

export function vehicleStatusLabel(status: number): string {
  const key = VEHICLE_STATUS_KEYS[status];
  return key ? t(key) : t('label.status.unknown');
}
