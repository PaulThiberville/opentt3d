/**
 * Libellés français des valeurs du protocole.
 *
 * Les clés restent les identifiants anglais du protocole ; seuls les textes
 * affichés sont traduits. `labelOf` retombe proprement sur la clé inconnue.
 */

export const VEHICLE_LABELS: Record<string, string> = {
  train: 'Train',
  road: 'Véhicule routier',
  ship: 'Bateau',
  aircraft: 'Avion',
};

export const STATION_LABELS: Record<string, string> = {
  train: 'Gare',
  road: 'Arrêt',
  ship: 'Dock',
  airport: 'Aéroport',
  buoy: 'Bouée',
};

export const CARGO_LABELS: Record<string, string> = {
  passengers: 'Voyageurs',
  mail: 'Courrier',
  coal: 'Charbon',
  wood: 'Bois',
  grain: 'Céréales',
  goods: 'Marchandises',
  oil: 'Pétrole',
  livestock: 'Bétail',
  valuables: 'Objets de valeur',
  iron_ore: 'Minerai de fer',
  steel: 'Acier',
  water: 'Eau',
  fruit: 'Fruits',
  maize: 'Maïs',
  food: 'Nourriture',
};

export const VEHICLE_STATUS_LABELS: Record<number, string> = {
  0: 'à l’arrêt',
  1: 'en route',
  2: 'en gare',
  3: 'en dépôt',
  4: 'en attente',
};

export const TILE_KIND_LABELS: Record<string, string> = {
  void: 'Vide',
  clear: 'Terrain dégagé',
  grass: 'Herbe',
  rough: 'Broussailles',
  water: 'Eau',
  coast: 'Côte',
  rail: 'Voie ferrée',
  road: 'Route',
  house: 'Bâtiment',
  trees: 'Arbres',
  station: 'Gare',
  industry: 'Industrie',
  bridge: 'Pont',
  tunnel: 'Tunnel',
  object: 'Objet',
  airport: 'Aéroport',
  dock: 'Dock',
  canal: 'Canal',
  river: 'Rivière',
};

export const INDUSTRY_KIND_LABELS: Record<string, string> = {
  coal_mine: 'Mine de charbon',
  power_station: 'Centrale électrique',
  sawmill: 'Scierie',
  farm: 'Ferme',
  factory: 'Usine',
  oil_well: 'Puits de pétrole',
  refinery: 'Raffinerie',
  steel_mill: 'Aciérie',
  forest: 'Forêt',
};

export function labelOf(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key;
}

export function cargoLabel(type: string): string {
  return labelOf(CARGO_LABELS, type);
}

export function vehicleLabel(kind: string): string {
  return labelOf(VEHICLE_LABELS, kind);
}

export function stationLabel(kind: string): string {
  return labelOf(STATION_LABELS, kind);
}

export function industryKindLabel(kind: string): string {
  return labelOf(INDUSTRY_KIND_LABELS, kind);
}

export function tileKindLabel(kind: string): string {
  return labelOf(TILE_KIND_LABELS, kind);
}

export function vehicleStatusLabel(status: number): string {
  return VEHICLE_STATUS_LABELS[status] ?? 'état inconnu';
}
