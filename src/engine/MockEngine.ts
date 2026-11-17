/**
 * Moteur mock déterministe.
 *
 * Il implémente intégralement `EngineDriver` (src/engine/protocol.ts) pour
 * permettre au frontend de tourner sans WASM : carte générée par bruit de
 * valeur, villes, industries, gares, routes/rails et véhicules qui les
 * parcourent. Toute la génération et la simulation sont pilotées par une
 * graine et par le nombre de ticks exécutés : deux moteurs identiques
 * produisent le même `hash()`.
 *
 * Ce fichier ne dépend ni du DOM ni de Three.js.
 */

import {
  COMPANY_NONE,
  PROTOCOL_VERSION,
  ROAD_ONEWAY_DIRECTIONS,
  ROAD_ONEWAY_INDEX,
  TILE_FLAG,
  TILE_KIND_INDEX,
  TRACK_BIT_CROSSING_RAIL,
  roadOneWayFromIndex,
  roadOneWayVector,
  type CompanySnapshot,
  type DepotSnapshot,
  type DisasterKind,
  type EconomySnapshot,
  type EngineCommand,
  type EngineDriver,
  type EngineInitOptions,
  type EngineStatus,
  type IndustrySnapshot,
  type MapSnapshot,
  type NewGameOptions,
  type OrderAction,
  type OrderComparator,
  type OrderCondition,
  type RailType,
  type RoadOneWay,
  type SignalDirection,
  type StationSnapshot,
  type StructureSnapshot,
  type SubsidySnapshot,
  type TownActionKind,
  type TownActionSnapshot,
  type TownAuthoritySnapshot,
  type TownSnapshot,
  type VehicleKind,
  type VehicleGroupSnapshot,
  type VehicleSnapshot,
  type WorldEvent,
  type WorldSnapshot,
} from './protocol';
import { Prng, StateHash, fbm, valueNoise } from '../game/prng';
import { decodeBase64, encodeBase64 } from '../game/base64';
import { sampleHeightWorld } from '../game/mapGrid';
import { normalizeWaterLevels } from '../game/waterLevels';
import {
  BANKRUPTCY_MONTHS,
  DEFAULT_LOAN_INTERVAL,
  cargoRate,
  isPassengerCargo,
} from '../game/economyRules';
import {
  BUILD_TOOL_LABELS,
  BRIDGE_APPROACH_TILES,
  BRIDGE_MATERIALS,
  BRIDGE_MATERIAL_LABELS,
  directionFromIndex,
  directionFromOffset,
  directionOffset,
  directionToIndex,
  planAqueduct,
  planBridge,
  planBuild,
  planCanal,
  planConvertRail,
  planCrossing,
  planDepot,
  planLock,
  planRemoveSignal,
  planLinkedRoute,
  planSignal,
  planStation,
  planTerraform,
  planTree,
  planTunnel,
} from '../game/buildRules';
import { directionAxis, stationFootprint } from '../game/buildRules';
import {
  depotConnections,
  parseBuildDirection,
  type BridgeMaterial,
  type BuildDirection,
  type BuildTransport,
  type DepotSettings,
  type LockSettings,
  type RoadDirection,
  type SignalSettings,
  type SignalTrack,
  type StationSettings,
  type TerraformSettings,
  type TreeSettings,
} from '../game/buildRules';
import { RAIL_TYPE_INDEX, RAIL_TYPE_LABELS, parseRailType } from '../game/railRules';
import {
  SIGNAL_KIND_LABELS,
  decodeSignalBits,
  encodeSignalBits,
  parseSignalDirection,
  parseSignalKind,
  signalBlockTiles,
  signalAspectForBlock,
  signalsFromMap,
  withSignalAspect,
} from '../game/signalRules';
import {
  MAX_VEHICLE_ORDERS,
  cloneOrder,
  cloneOrderOptions,
  cloneCost,
  modelCompatibleWithRail,
  refitCost,
  refitOption,
  vehicleModel,
  type DepotKind,
  type VehicleOrder,
} from '../game/vehicleRules';
import {
  BREAKDOWN_COOLDOWN_DAYS,
  BREAKDOWN_SLOW_TICKS,
  advanceBreakdown,
  advanceWear,
  breakdownSpeedFactor,
  clampServiceInterval,
  initialReliability,
  reliabilitySnapshot,
  rollBreakdown,
  serviceCost,
  shouldAutoreplace,
  type ReliabilityTrack,
} from '../game/vehicleReliability';
import {
  MAX_GROUPS,
  compatibleAutoreplaceModel,
  defaultGroupName,
  isValidGroupName,
  normalizeGroupName,
} from '../game/vehicleGroups';

/** Ticks moteur par jour de jeu (OpenTTD : `TICKS_PER_DAY`). */
export const TICKS_PER_DAY = 74;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const MAX_STEP_TICKS = 240;
/** Nombre total de véhicules demandés pour la tranche verticale. */
const VEHICLE_TARGET = 40;
/**
 * Facteur de démonstration : les vitesses du contrat sont exprimées en
 * tuiles/jour (74 ticks par jour), ce qui serait trop rapide à l'écran.
 * On ralentit le déplacement d'affichage sans toucher à la date.
 */
const MOTION_SCALE = 0.3;

const K = TILE_KIND_INDEX;
const COMPANY_COLOURS = [8, 4] as const;

interface P2 {
  x: number;
  y: number;
}

/** Cible d'arrêt d'un véhicule : gare, industrie ou dépôt. */
interface MockStop {
  kind: 'station' | 'industry' | 'depot';
  id: number;
  /** Index de l'ordre correspondant dans `vehicle.orders` (#161). */
  order?: number;
}

interface MockVehicle {
  id: number;
  kind: VehicleKind;
  company: number;
  /** Modèle du catalogue (`vehicleRules`) ou chaîne vide pour la flotte initiale. */
  model: string;
  /** Dépôt d'achat, utilisé pour le retour et la liste du panneau dépôt. */
  homeDepot: P2 | null;
  path: P2[];
  /** Longueur de chaque segment, recalculée au chargement. */
  pathLengths: number[];
  /** Index du segment courant et progression 0..1 dessus. */
  segment: number;
  segmentT: number;
  /** Arrêt par index de segment, `null` si le segment n'est pas une cible. */
  segmentStops: (MockStop | null)[];
  /** Index de l'ordre courant dans `orders` (#161). */
  currentOrder: number;
  /** Ordres (index complets) dans l'ordre du tracé courant (#161). */
  routeOrders: number[];
  speed: number;
  direction: number;
  /** Tangage de rendu (#232), recalculé à chaque tick. */
  pitch: number;
  status: number;
  waitTicks: number;
  x: number;
  y: number;
  z: number;
  cargoType: string;
  /** Classe de cargaison du véhicule (immuable), pour filtrer les chargements. */
  cargoClass: string;
  cargoAmount: number;
  cargoCapacity: number;
  /** Industrie où la cargaison a été chargée (subventions et traçabilité). */
  cargoSource: number | null;
  /** Distance parcourue depuis le dernier chargement, en tuiles. */
  tripDistance: number;
  /** Tick du dernier chargement, pour le bonus de rapidité. */
  loadedTick: number;
  orderTargets: number[];
  /** Tournée typée (gare, industrie, dépôt) ; `orderTargets` reste la vue publique. */
  orders: VehicleOrder[];
  profitLastYear: number;
  ageDays: number;
  /** Groupe de véhicules (#164), null = non groupé. */
  groupId: number | null;
  /** Usure, fiabilité et panne en cours (#163). */
  reliability: ReliabilityTrack;
}

/** Groupe de véhicules du mock (#164). */
interface MockGroup {
  id: number;
  company: number;
  name: string;
  kind: VehicleKind;
  parent: number | null;
  replaceModel: string | null;
  replaceWhenOld: boolean;
}

interface MockCompany {
  id: number;
  name: string;
  president: string;
  colour: number;
  money: number;
  loan: number;
  maxLoan: number;
  value: number;
  income: number;
  expenses: number;
  isAI: boolean;
  isLocal: boolean;
  bankrupt: boolean;
  /** Mois consécutifs de trésorerie négative (0 = sain). */
  monthsOfBankruptcy: number;
  deliveredToday: number;
  vehicleCount: number;
  stationCount: number;
  interestPaid: number;
  /** Niveau de l'IA 1..3 (#168), absent/inutile pour une entreprise humaine. */
  aiLevel?: number;
  /** Jour de simulation du prochain chantier IA (#168). */
  aiNextBuildDay?: number;
  /** Paires de villes déjà reliées par cette IA, sous la forme « a:b ». */
  aiLinks?: string[];
}

interface MockTown {
  id: number;
  name: string;
  x: number;
  y: number;
  population: number;
  growthRate: number;
  buildings: number;
  rating: number;
  /** Dernier mois (année*12 + mois) où chaque action a été utilisée. */
  actionMonths: Record<TownActionKind, number>;
}

interface MockIndustry {
  id: number;
  name: string;
  kind: string;
  x: number;
  y: number;
  production: number;
  transported: number;
  /** Cargaison produite (chaîne vide pour un consommateur pur). */
  cargo: string;
  /** Cargaisons acceptées en entrée. */
  accepts: string[];
  /** Stock disponible à l'enlèvement. */
  stock: number;
}

/** Offre ou subvention active du mock (#166/#167). */
interface MockSubsidy {
  id: number;
  cargo: string;
  fromIndustry: number;
  toIndustry: number;
  remainingMonths: number;
  awardedTo: number | null;
}

interface MockStation {
  id: number;
  company: number;
  name: string;
  kind: StationSnapshot['kind'];
  x: number;
  y: number;
  width: number;
  height: number;
  waiting: { cargo: string; amount: number }[];
  /** Arrêt de bus en passage (#218) : abri de trottoir, pas une halle. */
  driveThrough?: boolean;
  /** Axe de la route sous un arrêt en passage. */
  roadAxis?: 'x' | 'y';
}

/**
 * Dépôt route/rail du mock. `id` est stable tant que le dépôt existe et suit
 * le même contrat que `DepotSnapshot` (le pont utilise l'index du pool).
 */
interface MockDepot {
  id: number;
  company: number;
  kind: DepotKind;
  x: number;
  y: number;
  direction: number;
  width: number;
  height: number;
  /** Type de rail d'un dépôt ferroviaire (#157). */
  railType?: RailType;
}

interface MockNews {
  tick: number;
  kind: 'info' | 'warning' | 'error' | 'company';
  text: string;
}

/** Désastre actif du mock (#172). */
interface MockDisaster {
  id: number;
  kind: DisasterKind;
  x: number;
  y: number;
  company: number;
  vehicle?: number;
  town?: number;
  industry?: number;
  severity: number;
  startedTick: number;
  remainingDays: number;
}

/**
 * Pont ou tunnel construit par le mock. `underlay` mémorise les types de
 * tuiles d'origine pour restaurer exactement l'eau ou l'herbe à la démolition.
 */
interface MockStructure {
  id: number;
  type: 'bridge' | 'tunnel';
  company: number;
  transport: BuildTransport;
  material?: BridgeMaterial;
  from: P2;
  to: P2;
  length: number;
  deckHeight?: number;
  portalHeight?: number;
  maintenancePerYear: number;
  underlay: { index: number; kind: number; owner: number; flags: number; trackBits: number }[];
}

interface MockWorld {
  seed: number;
  width: number;
  height: number;
  tick: number;
  year: number;
  month: number;
  day: number;
  paused: boolean;
  speed: number;
  rngState: number;

  /** Inflation cumulée en pourcentage (#165), recalculée chaque année. */
  inflation: number;
  /** Difficulté 0..3 (#165). */
  difficulty: number;
  /** Taux d'intérêt annuel des prêts en pourcentage (#165). */
  interestRate: number;
  /** Pas de prêt/remboursement (#165). */
  loanInterval: number;

  /** Catastrophes activées (#172) ; désactivées par défaut. */
  disastersEnabled: boolean;
  disasters: MockDisaster[];
  /** Prochain jour de simulation où un désastre peut apparaître. */
  nextDisasterDay: number;
  /** Compteur d'identifiants de désastres, stable en sauvegarde. */
  nextDisasterId: number;

  kind: Uint8Array;
  heightMap: Uint8Array;
  owner: Uint8Array;
  slope: Uint8Array;
  flags: Uint8Array;
  trackBits: Uint8Array;
  /** Type de rail par tuile (#157). */
  railTypes: Uint8Array;
  /** Sens de circulation par tuile (#231), 0 = double sens. */
  roadData: Uint8Array;
  /** Nombre de tuiles à sens unique (accélère le hash sans sens unique). */
  roadCount: number;
  /** Bits de signal par tuile (#156), voir `signalRules.ts`. */
  signalData: Uint8Array;
  /** Nombre de tuiles portant un signal (accélère les snapshots sans signal). */
  signalCount: number;

  companies: MockCompany[];
  towns: MockTown[];
  industries: MockIndustry[];
  stations: MockStation[];
  depots: MockDepot[];
  structures: MockStructure[];
  vehicles: MockVehicle[];
  subsidies: MockSubsidy[];
  /** Groupes de véhicules (#164). */
  groups: MockGroup[];

  news: MockNews[];
  newsCursor: number;
  events: WorldEvent[];
  eventCursor: number;

  mapDirty: boolean;
  mapSent: boolean;
  mapVersion: number;
  sequence: number;
}

interface SerializedWorld {
  seed: number;
  width: number;
  height: number;
  tick: number;
  year: number;
  month: number;
  day: number;
  paused: boolean;
  speed: number;
  rngState: number;
  sequence: number;
  mapVersion: number;
  /** Champs économiques ajoutés par #165 ; absents des anciennes sauvegardes. */
  inflation?: number;
  difficulty?: number;
  interestRate?: number;
  loanInterval?: number;
  kind: string;
  heightMap: string;
  owner: string;
  slope: string;
  flags: string;
  trackBits: string;
  /** Absents des sauvegardes mock antérieures à #156/#157. */
  railTypes?: string;
  signalData?: string;
  /** Sens de circulation (#231), absent des sauvegardes antérieures. */
  roadData?: string;
  signalCount?: number;
  companies: (Omit<MockCompany, 'maxLoan' | 'monthsOfBankruptcy' | 'interestPaid'> & {
    maxLoan?: number;
    monthsOfBankruptcy?: number;
    interestPaid?: number;
  })[];
  towns: (Omit<MockTown, 'actionMonths'> & {
    actionMonths?: Partial<Record<TownActionKind, number>>;
  })[];
  industries: (Omit<MockIndustry, 'stock' | 'accepts'> & {
    stock?: number;
    accepts?: string[];
  })[];
  stations: MockStation[];
  /** Absent des sauvegardes mock antérieures à #90 (migration héritée). */
  depots?: MockDepot[];
  /** Absent des sauvegardes mock antérieures à #154/#155. */
  structures?: MockStructure[];
  vehicles: (Omit<MockVehicle, 'pathLengths' | 'segmentStops' | 'reliability' | 'groupId'> & {
    segmentStops?: (MockStop | null)[];
    /** Ancien format (#29) : arrêts de gare uniquement. */
    segmentStations?: number[];
    /** Absents des sauvegardes antérieures à #163/#164. */
    groupId?: number | null;
    reliability?: Partial<ReliabilityTrack>;
  })[];
  subsidies?: MockSubsidy[];
  /** Absent des sauvegardes antérieures à #164. */
  groups?: MockGroup[];
  news: MockNews[];
  /** Désastres (#172) ; absents des sauvegardes antérieures. */
  disastersEnabled?: boolean;
  disasters?: MockDisaster[];
  nextDisasterDay?: number;
  nextDisasterId?: number;
}

const TOWN_NAMES = ['Valmont', 'Riveclaire', 'Saint-Aubin', 'Bellecombe', 'Miraval', 'Peyrolles'];
interface IndustryDefinition {
  kind: string;
  name: string;
  /** Cargaison produite, chaîne vide pour un consommateur pur. */
  cargo: string;
  /** Cargaisons acceptées (chaînes de production, #167). */
  accepts: string[];
}

const INDUSTRY_DEFINITIONS: IndustryDefinition[] = [
  { kind: 'coal_mine', name: 'Mine de Valmont', cargo: 'coal', accepts: [] },
  { kind: 'power_station', name: 'Centrale de Riveclaire', cargo: '', accepts: ['coal'] },
  { kind: 'sawmill', name: 'Scierie du Lac', cargo: 'wood', accepts: [] },
  { kind: 'farm', name: 'Ferme des Coteaux', cargo: 'grain', accepts: [] },
  {
    kind: 'factory',
    name: 'Usine Saint-Aubin',
    cargo: 'goods',
    accepts: ['grain', 'wood'],
  },
];

/**
 * Préréglages de difficulté du mock (#165). Ils reprennent l'esprit des
 * préréglages du pont : plafond de prêt, intérêt et inflation croissants.
 */
interface MockDifficultyPreset {
  maxLoan: number;
  interestRate: number;
  inflation: number;
  startLoan: number;
  revenueFactor: number;
}

const MOCK_DIFFICULTIES: readonly MockDifficultyPreset[] = [
  { maxLoan: 800_000, interestRate: 2.5, inflation: 1.5, startLoan: 400_000, revenueFactor: 1.1 },
  { maxLoan: 600_000, interestRate: 4, inflation: 2.5, startLoan: 400_000, revenueFactor: 1 },
  { maxLoan: 450_000, interestRate: 6, inflation: 3.5, startLoan: 300_000, revenueFactor: 0.92 },
  { maxLoan: 350_000, interestRate: 8, inflation: 5, startLoan: 250_000, revenueFactor: 0.85 },
];

/** Coûts de base des actions municipales, avant inflation (#166). */
const TOWN_ACTION_BASE_COST: Record<TownActionKind, number> = {
  advertise: 20_000,
  fund_roads: 50_000,
  fund_buildings: 80_000,
};

/** Durée d'une offre de subvention, en mois (comme OpenTTD). */
const SUBSIDY_OFFER_MONTHS = 12;

function difficultyPreset(level: number | undefined): MockDifficultyPreset {
  const index = Math.min(3, Math.max(0, Math.round(level ?? 1)));
  return MOCK_DIFFICULTIES[index] ?? MOCK_DIFFICULTIES[1]!;
}

const RANDOM_NEWS = [
  'Le conseil municipal approuve un nouveau plan de zonage.',
  'La demande de passagers augmente sur la ligne principale.',
  'Une cargaison de charbon attend à quai.',
  'Les habitants réclament plus de liaisons de bus.',
  'Le prix du carburant reste stable ce mois-ci.',
];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function tileIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function distanceBetween(a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Direction OpenTTD-like : 0 = nord, 64 = est, 128 = sud, 192 = ouest. */
function directionFromVector(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const angle = Math.atan2(dx, -dy);
  return Math.round((angle / (Math.PI * 2)) * 256) & 255;
}

/**
 * Direction de sortie d'un dépôt (#232/#247) : `direction` est un
 * DiagDirection mock (0 = NE, 1 = SE, 2 = SW, 3 = NW) qui désigne la **tuile
 * voisine** de la porte. La porte est donc toujours cardinale (est, sud,
 * ouest, nord) ; un véhicule garé fait face à cette sortie, pas à la diagonale
 * du nom de l'orientation (l'ancien calcul ajoutait 45° et faisait pivoter le
 * bus dans le mur au démarrage).
 */
export function depotDirection(direction: number): number {
  const offset = directionOffset(directionFromIndex(direction));
  return directionFromVector(offset.dx, offset.dy);
}

/** Trace un chemin en L (horizontal puis vertical) le long des tuiles. */
function traceTiles(from: P2, to: P2): P2[] {
  const points: P2[] = [];
  let x = Math.floor(from.x);
  let y = Math.floor(from.y);
  const targetX = Math.floor(to.x);
  const targetY = Math.floor(to.y);
  const push = (tx: number, ty: number): void => {
    const last = points[points.length - 1];
    if (last && last.x === tx && last.y === ty) return;
    points.push({ x: tx, y: ty });
  };
  push(x, y);
  while (x !== targetX) {
    x += Math.sign(targetX - x);
    push(x, y);
  }
  while (y !== targetY) {
    y += Math.sign(targetY - y);
    push(x, y);
  }
  return points;
}

function directionBit(from: P2, to: P2): number {
  if (to.x > from.x) return 2; // est
  if (to.x < from.x) return 8; // ouest
  if (to.y > from.y) return 4; // sud
  return 1; // nord
}

/** Longueur de chaque segment d'une boucle fermée. */
function computePathLengths(path: P2[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    lengths.push(a && b ? distanceBetween(a, b) : 0);
  }
  return lengths;
}

/** Boucle fermée qui retrace l'aller puis le retour du chemin. */
function loopPath(tiles: P2[]): P2[] {
  const forward = tiles.map((tile) => ({ x: tile.x + 0.5, y: tile.y + 0.5 }));
  const backward = forward.slice(1, -1).reverse();
  return forward.concat(backward);
}

/** Vue minimale du monde nécessaire pour planifier un itinéraire. */
interface RouteWorld {
  width: number;
  height: number;
  kind: Uint8Array;
  roadData: Uint8Array;
  stations: readonly MockStation[];
  depots: readonly MockDepot[];
  structures: readonly MockStructure[];
}

/**
 * Coût de traversée d'une tuile pour un type de véhicule.
 *
 * L'infrastructure dédiée coûte 1 et une surface incompatible est
 * infranchissable : un bus ne peut donc jamais traverser une tuile rail, un
 * train une route, etc. Les terrains neutres sont eux aussi interdits : une
 * tournée n'est acceptée que si le réseau permet réellement de la parcourir.
 */
const SURFACE_ROUTE = 1;
const SURFACE_GOAL = 0;

const SURFACE_LABELS: Record<VehicleKind, string> = {
  train: 'ferroviaire',
  road: 'routier',
  ship: 'maritime',
  aircraft: 'aérien',
};

const VEHICLE_KIND_LABELS: Record<VehicleKind, string> = {
  train: 'un train',
  road: 'un véhicule routier',
  ship: 'un bateau',
  aircraft: 'un avion',
};

const STATION_KIND_FOR_VEHICLE: Record<VehicleKind, StationSnapshot['kind']> = {
  train: 'train',
  road: 'road',
  ship: 'ship',
  aircraft: 'airport',
};

function stationAtMapTile(world: RouteWorld, x: number, y: number): MockStation | null {
  for (const station of world.stations) {
    const left = Math.floor(station.x - station.width / 2);
    const top = Math.floor(station.y - station.height / 2);
    if (x >= left && x < left + station.width && y >= top && y < top + station.height) {
      return station;
    }
  }
  return null;
}

/** Dépôt occupant une tuile de la carte (même logique que `depotAtTile`). */
function depotAtMapTile(world: RouteWorld, x: number, y: number): MockDepot | null {
  for (const depot of world.depots) {
    if (x >= depot.x && x < depot.x + depot.width && y >= depot.y && y < depot.y + depot.height) {
      return depot;
    }
  }
  return null;
}

function structureTransportAt(world: RouteWorld, index: number): BuildTransport | null {
  for (const structure of world.structures) {
    if (structure.underlay.some((entry) => entry.index === index)) return structure.transport;
  }
  return null;
}

/**
 * Coût d'une tuile pour un véhicule. `Infinity` = surface interdite.
 *
 * Les ponts et tunnels sans `MockStructure` (routes de démonstration posées
 * directement sur l'eau) restent franchissables : le mock ne connaît pas leur
 * réseau, et les interdire casserait les lignes existantes.
 */
function surfaceCost(
  world: RouteWorld,
  kind: VehicleKind,
  x: number,
  y: number,
  isGoal: boolean,
): number {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return Infinity;
  const index = y * world.width + x;
  const tile = world.kind[index] ?? K.void;

  // Un dépôt n'est jamais une route traversante : un véhicule ne peut y
  // entrer que par sa porte, et seulement s'il s'agit de sa destination. Sans
  // cette règle, A* empruntait le bâtiment comme raccourci, la tuile du dépôt
  // apparaissait au milieu du tracé et déclenchait une arrivée fantôme juste
  // après la sortie (#247).
  const depot = depotAtMapTile(world, x, y);
  if (depot) {
    if (!isGoal) return Infinity;
    if (kind === 'road' && depot.kind === 'road') return SURFACE_GOAL;
    if (kind === 'train' && depot.kind === 'rail') return SURFACE_GOAL;
    return Infinity;
  }

  if (isGoal) {
    if (tile === K.void) return Infinity;
    if (kind === 'aircraft') return SURFACE_GOAL;
    if (tile === K.industry) return SURFACE_GOAL;
  }

  if (kind === 'aircraft') return SURFACE_GOAL;

  switch (tile) {
    case K.road:
      return kind === 'road' ? SURFACE_ROUTE : Infinity;
    case K.rail:
      return kind === 'train' ? SURFACE_ROUTE : Infinity;
    case K.crossing:
      return kind === 'road' || kind === 'train' ? SURFACE_ROUTE : Infinity;
    case K.station: {
      const station = stationAtMapTile(world, x, y);
      if (!station) return Infinity;
      const expected = STATION_KIND_FOR_VEHICLE[kind];
      if (kind === 'ship' && station.kind === 'buoy') return SURFACE_ROUTE;
      return station.kind === expected ? SURFACE_ROUTE : Infinity;
    }
    case K.bridge:
    case K.tunnel: {
      const transport = structureTransportAt(world, index);
      if (transport === null) return kind === 'road' || kind === 'train' ? SURFACE_ROUTE : Infinity;
      if (kind === 'road') return transport === 'road' ? SURFACE_ROUTE : Infinity;
      if (kind === 'train') return transport === 'rail' ? SURFACE_ROUTE : Infinity;
      return Infinity;
    }
    case K.water:
    case K.river:
    case K.canal:
    case K.lock:
    case K.aqueduct:
      return kind === 'ship' ? SURFACE_ROUTE : Infinity;
    case K.coast:
      return kind === 'ship' ? SURFACE_ROUTE : Infinity;
    case K.dock:
      return kind === 'ship' ? SURFACE_ROUTE : Infinity;
    case K.grass:
    case K.clear:
    case K.rough:
    case K.trees:
      return Infinity;
    case K.industry:
      return Infinity;
    default:
      return Infinity;
  }
}

/**
 * Une route à sens unique n'autorise que le déplacement porté par `roadData`.
 * Les ouvrages, gares et dépôts n'ont pas de sens (#231) : seule la tuile
 * réellement routière contraint le passage.
 */
export function roadOneWayAllows(
  roadData: Uint8Array,
  index: number,
  dx: number,
  dy: number,
): boolean {
  const value = roadData[index] ?? 0;
  if (value === 0) return true;
  const direction = roadOneWayFromIndex(value);
  if (!direction) return true;
  const vector = roadOneWayVector(direction);
  return vector.x === dx && vector.y === dy;
}

/** Vérifie l'entrée et la sortie d'une tuile route à sens unique. */
function canTravelRoad(
  world: RouteWorld,
  fromIndex: number,
  toIndex: number,
  dx: number,
  dy: number,
): boolean {
  if (
    (world.kind[fromIndex] ?? 0) === K.road &&
    !roadOneWayAllows(world.roadData, fromIndex, dx, dy)
  ) {
    return false;
  }
  if ((world.kind[toIndex] ?? 0) === K.road && !roadOneWayAllows(world.roadData, toIndex, dx, dy)) {
    return false;
  }
  return true;
}

/** File de priorité binaire minimale, sans allocation par nœud. */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    this.nodes.push(node);
    this.priorities.push(priority);
    let index = this.nodes.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if ((this.priorities[parent] ?? 0) <= (this.priorities[index] ?? 0)) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  pop(): number | null {
    if (this.nodes.length === 0) return null;
    const first = this.nodes[0] ?? null;
    const lastNode = this.nodes.pop();
    const lastPriority = this.priorities.pop();
    if (this.nodes.length > 0 && lastNode !== undefined && lastPriority !== undefined) {
      this.nodes[0] = lastNode;
      this.priorities[0] = lastPriority;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (
          left < this.nodes.length &&
          (this.priorities[left] ?? 0) < (this.priorities[best] ?? 0)
        ) {
          best = left;
        }
        if (
          right < this.nodes.length &&
          (this.priorities[right] ?? 0) < (this.priorities[best] ?? 0)
        ) {
          best = right;
        }
        if (best === index) break;
        this.swap(best, index);
        index = best;
      }
    }
    return first;
  }

  private swap(a: number, b: number): void {
    const node = this.nodes[a];
    const priority = this.priorities[a];
    this.nodes[a] = this.nodes[b] ?? 0;
    this.priorities[a] = this.priorities[b] ?? 0;
    this.nodes[b] = node ?? 0;
    this.priorities[b] = priority ?? 0;
  }
}

/** Itinéraire 4-connexe le moins coûteux respectant les surfaces du véhicule. */
function findSurfacePath(world: RouteWorld, kind: VehicleKind, start: P2, goal: P2): P2[] | null {
  const size = world.width * world.height;
  const startIndex = start.y * world.width + start.x;
  const goalIndex = goal.y * world.width + goal.x;
  if (startIndex === goalIndex) return [{ ...start }];

  const costs = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  costs[startIndex] = 0;
  const heap = new MinHeap();
  const heuristic = (index: number): number =>
    Math.abs((index % world.width) - goal.x) + Math.abs(Math.floor(index / world.width) - goal.y);
  heap.push(startIndex, heuristic(startIndex));

  const neighbours = [-world.width, 1, world.width, -1];
  let guard = size * 4;
  while (heap.size > 0 && guard > 0) {
    guard -= 1;
    const current = heap.pop();
    if (current === null) break;
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goalIndex) break;

    const x = current % world.width;
    for (let direction = 0; direction < neighbours.length; direction += 1) {
      const step = neighbours[direction] ?? 0;
      const next = current + step;
      if (next < 0 || next >= size) continue;
      if (direction === 1 && x + 1 >= world.width) continue;
      if (direction === 3 && x - 1 < 0) continue;
      if (closed[next]) continue;
      const nx = next % world.width;
      const ny = Math.floor(next / world.width);
      // Un sens unique interdit l'entrée et la sortie à contresens (#231).
      if (!canTravelRoad(world, current, next, nx - x, ny - Math.floor(current / world.width))) {
        continue;
      }
      const stepCost = surfaceCost(world, kind, nx, ny, next === goalIndex);
      if (!Number.isFinite(stepCost)) continue;
      const tentative = (costs[current] ?? Infinity) + stepCost;
      if (tentative >= (costs[next] ?? Infinity)) continue;
      costs[next] = tentative;
      cameFrom[next] = current;
      heap.push(next, tentative + heuristic(next));
    }
  }

  if (cameFrom[goalIndex] === -1 && startIndex !== goalIndex) return null;

  const tiles: P2[] = [];
  let cursor = goalIndex;
  let guardSteps = size;
  while (cursor !== -1 && cursor !== startIndex && guardSteps > 0) {
    guardSteps -= 1;
    tiles.push({ x: cursor % world.width, y: Math.floor(cursor / world.width) });
    cursor = cameFrom[cursor] ?? -1;
  }
  if (cursor !== startIndex) return null;
  tiles.push({ ...start });
  tiles.reverse();
  return tiles;
}

/**
 * Sortie d’un dépôt : la tuile du dépôt et la tuile de voie située devant sa
 * porte. Le tracé commence et finit par cette porte pour que le véhicule ne
 * traverse jamais un mur ni ne boucle dans la tuile du dépôt.
 */
interface RouteOrigin {
  depot: P2;
  door: P2;
}

/** Tuile adjacente à l’entrée du dépôt, si elle est praticable. */
function depotDoorTile(world: RouteWorld, depot: MockDepot, kind: VehicleKind): P2 | null {
  const offset = directionOffset(directionFromIndex(depot.direction));
  const x = depot.x + Math.floor(depot.width / 2) + offset.dx;
  const y = depot.y + Math.floor(depot.height / 2) + offset.dy;
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return null;
  return Number.isFinite(surfaceCost(world, kind, x, y, false)) ? { x, y } : null;
}

/**
 * Origine d’un véhicule garé dans un dépôt. Le chemin de sortie part de la
 * porte ; sans voie devant celle-ci, la tournée est refusée explicitement.
 */
function routeOriginForVehicle(
  world: MockWorld,
  vehicle: MockVehicle,
): { origin: RouteOrigin | null; error: string | null } {
  // Un véhicule en dépôt (garé ou à l'arrêt) doit sortir par sa porte, même
  // si un changement de tournée survient pendant l'attente (#247).
  if (vehicle.status !== 3 && vehicle.status !== 2) return { origin: null, error: null };
  const depot = depotAtTile(world, Math.floor(vehicle.x), Math.floor(vehicle.y));
  if (!depot || depot.company !== vehicle.company) return { origin: null, error: null };
  const door = depotDoorTile(world, depot, vehicle.kind);
  if (!door) {
    return {
      origin: null,
      error:
        `Dépôt #${depot.id} : aucune voie praticable devant l’entrée ` +
        `(${depot.x}, ${depot.y}).`,
    };
  }
  return { origin: { depot: { x: depot.x, y: depot.y }, door }, error: null };
}

/**
 * Tracé d'une tournée respectant l'infrastructure du véhicule.
 *
 * Part de la position courante, rejoint chaque cible dans l'ordre puis revient
 * au départ (boucle aller-retour). Les avions vont en ligne directe ; les
 * autres types empruntent `findSurfacePath`. Pour un véhicule garé en dépôt,
 * `origin` impose une sortie et un retour par la porte du dépôt.
 */
function buildRoutePath(
  world: RouteWorld,
  start: P2,
  targets: readonly P2[],
  kind: VehicleKind,
  origin: RouteOrigin | null = null,
): { path: P2[] | null; error: string | null } {
  const anchor = { x: Math.floor(start.x), y: Math.floor(start.y) };
  const tiles: P2[] = [];
  let cursor: P2;
  let endsAtOriginDepot = false;
  if (origin) {
    tiles.push({ ...origin.depot }, { ...origin.door });
    cursor = { ...origin.door };
  } else {
    tiles.push(anchor);
    cursor = anchor;
  }
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (!target) continue;
    const targetTile = { x: Math.floor(target.x), y: Math.floor(target.y) };
    const targetDepot = depotAtMapTile(world, targetTile.x, targetTile.y);
    const isOriginDepot =
      origin !== null &&
      targetDepot !== null &&
      targetDepot.x === origin.depot.x &&
      targetDepot.y === origin.depot.y;
    const isLastTarget = targetIndex === targets.length - 1;
    let goal = targetTile;
    if (isOriginDepot && origin) {
      goal = { ...origin.door };
    } else if (targetDepot) {
      // Un dépôt visité en cours de tournée s'aborde aussi par sa porte : le
      // véhicule ne doit jamais traverser le bâtiment (#247).
      const door = depotDoorTile(world, targetDepot, kind);
      if (door) goal = door;
    }
    if (goal.x === cursor.x && goal.y === cursor.y) {
      // Un ordre de dépôt déjà satisfait ne crée pas un aller-retour sur la
      // tuile du dépôt.
      if (isOriginDepot && isLastTarget && origin) {
        tiles.push({ ...origin.depot });
        endsAtOriginDepot = true;
      } else if (targetDepot && !isOriginDepot) {
        const depotTile = { x: targetDepot.x, y: targetDepot.y };
        if (cursor.x !== depotTile.x || cursor.y !== depotTile.y) {
          // Entrée puis ressortie immédiate par la même porte : le tracé reste
          // continu pour les cibles suivantes.
          tiles.push(depotTile, { ...goal });
        }
      }
      continue;
    }
    const segment =
      kind === 'aircraft' ? traceTiles(cursor, goal) : findSurfacePath(world, kind, cursor, goal);
    if (!segment) {
      return {
        path: null,
        error:
          `Aucun itinéraire ${SURFACE_LABELS[kind]} compatible entre ` +
          `(${cursor.x}, ${cursor.y}) et (${goal.x}, ${goal.y}).`,
      };
    }
    for (let index = 1; index < segment.length; index += 1) {
      const point = segment[index];
      if (point) tiles.push(point);
    }
    cursor = goal;
    if (isOriginDepot && isLastTarget && origin) {
      // Retour à la tuile du dépôt juste après la porte : le véhicule rentre
      // par l'entrée au lieu de repartir en sens inverse.
      tiles.push({ ...origin.depot });
      endsAtOriginDepot = true;
    } else if (targetDepot) {
      // Cible dépôt : entrée par la porte, puis sortie par la même porte pour
      // poursuivre la tournée. L'arrêt est marqué sur la tuile du dépôt.
      tiles.push({ x: targetDepot.x, y: targetDepot.y }, { ...goal });
    }
  }
  // Une tournée qui se termine au dépôt est déjà fermée : inutile de retracer
  // tout l'aller en sens inverse.
  return {
    path: endsAtOriginDepot
      ? tiles.map((tile) => ({ x: tile.x + 0.5, y: tile.y + 0.5 }))
      : loopPath(tiles),
    error: null,
  };
}

/** Erreur explicite si un ordre cible une infrastructure incompatible. */
function orderInfrastructureError(
  world: RouteWorld,
  kind: VehicleKind,
  order: VehicleOrder,
): string | null {
  if (order.kind === 'conditional' || order.kind === 'industry') return null;

  if (order.kind === 'station') {
    const station = world.stations.find((item) => item.id === order.target);
    if (!station) return `Gare #${order.target} introuvable.`;
    const expected = STATION_KIND_FOR_VEHICLE[kind];
    const allowed = station.kind === expected || (kind === 'ship' && station.kind === 'buoy');
    if (allowed) return null;
    const expectedLabel =
      expected === 'airport'
        ? 'un aéroport'
        : expected === 'ship'
          ? 'un port'
          : `une gare ${expected === 'train' ? 'ferroviaire' : 'routière'}`;
    return (
      `Ordre incompatible : ${VEHICLE_KIND_LABELS[kind]} ne peut desservir que ` +
      `${expectedLabel} (gare #${station.id} de type ${station.kind}).`
    );
  }

  const depot = world.depots.find((item) => item.id === order.target);
  if (!depot) return `Dépôt ${order.target} introuvable ou démoli.`;
  const expectedDepot: DepotKind | null =
    kind === 'train' ? 'rail' : kind === 'road' ? 'road' : null;
  if (expectedDepot === null) {
    return `Ordre incompatible : ${VEHICLE_KIND_LABELS[kind]} n’utilise pas de dépôt.`;
  }
  if (depot.kind !== expectedDepot) {
    return (
      `Ordre incompatible : ${VEHICLE_KIND_LABELS[kind]} exige un dépôt ` +
      `${expectedDepot === 'rail' ? 'ferroviaire' : 'routier'} (dépôt #${depot.id} de type ${depot.kind}).`
    );
  }
  return null;
}

/** Point d'arrêt résolu sur le tracé d'une tournée. */
interface StopPoint {
  x: number;
  y: number;
  kind: MockStop['kind'];
  id: number;
  /** Index de l'ordre d'origine (#161). */
  order?: number;
}

/** Marque les segments dont le nœud de départ est la tuile d'un arrêt. */
function segmentsForStopsOnPath(path: P2[], stops: StopPoint[]): (MockStop | null)[] {
  const result = new Array<MockStop | null>(path.length).fill(null);
  const count = path.length;
  const distanceSquared = (point: P2, x: number, y: number): number => {
    const dx = point.x - x;
    const dy = point.y - y;
    return dx * dx + dy * dy;
  };
  for (let i = 0; i < count; i += 1) {
    const point = path[i];
    if (!point) continue;
    for (const stop of stops) {
      if (stop.kind === 'depot') {
        // Un arrêt en dépôt ne vaut que sur la tuile exacte : les tuiles
        // voisines (sortie de la porte) ne doivent pas déclencher une arrivée,
        // sinon le véhicule « revient » au dépôt dès qu’il en sort (#233).
        if (Math.floor(point.x) === stop.x && Math.floor(point.y) === stop.y) {
          result[i] = { kind: stop.kind, id: stop.id, order: stop.order };
        }
        continue;
      }
      // Gare/industrie : on ne marque que le point le plus proche de chaque
      // passage. Marquer toutes les tuiles du rayon provoquait plusieurs
      // arrivées consécutives au même arrêt, avec des demi-tours et une
      // rotation incohérente (#247).
      const centreX = stop.x + 0.5;
      const centreY = stop.y + 0.5;
      const distance = distanceSquared(point, centreX, centreY);
      if (distance > 1.1) continue;
      const previous = path[(i - 1 + count) % count];
      const next = path[(i + 1) % count];
      const previousDistance = previous
        ? distanceSquared(previous, centreX, centreY)
        : Number.POSITIVE_INFINITY;
      const nextDistance = next
        ? distanceSquared(next, centreX, centreY)
        : Number.POSITIVE_INFINITY;
      if (distance > previousDistance || distance > nextDistance) continue;
      if (distance === previousDistance && distance === nextDistance) continue;
      result[i] = { kind: stop.kind, id: stop.id, order: stop.order };
    }
  }
  return result;
}

interface ResolvedOrders {
  targets: P2[];
  stops: StopPoint[];
  /** Index complets des destinations, dans l'ordre du tracé. */
  orderIndices: number[];
  error: string | null;
}

/** Résout une destination physique ; `null` pour un conditionnel. */
function resolveOrderTarget(world: MockWorld, order: VehicleOrder): P2 | null {
  if (order.kind === 'conditional') return null;
  if (order.kind === 'station') {
    const station = world.stations.find((item) => item.id === order.target);
    return station ? { x: station.x, y: station.y } : null;
  }
  if (order.kind === 'industry') {
    const industry = world.industries.find((item) => item.id === order.target);
    return industry ? { x: industry.x, y: industry.y } : null;
  }
  const depot = world.depots.find((item) => item.id === order.target);
  return depot ? { x: depot.x + depot.width / 2, y: depot.y + depot.height / 2 } : null;
}

/**
 * Résout les cibles d'une tournée en points du monde et arrêts, en partant de
 * l'ordre `startIndex` (rotation). Les conditionnels n'ont pas de cible
 * physique et sont ignorés ici.
 */
function resolveOrders(
  world: MockWorld,
  orders: readonly VehicleOrder[],
  kind: VehicleKind,
  startIndex = 0,
): ResolvedOrders {
  const targets: P2[] = [];
  const stops: StopPoint[] = [];
  const orderIndices: number[] = [];
  if (orders.length === 0) return { targets, stops, orderIndices, error: null };
  const start = ((startIndex % orders.length) + orders.length) % orders.length;
  for (let offset = 0; offset < orders.length; offset += 1) {
    const index = (start + offset) % orders.length;
    const order = orders[index];
    if (!order || order.kind === 'conditional') continue;
    const incompatible = orderInfrastructureError(world, kind, order);
    if (incompatible) {
      return { targets: [], stops: [], orderIndices: [], error: incompatible };
    }
    if (order.kind === 'station') {
      const station = world.stations.find((item) => item.id === order.target);
      if (!station) {
        return {
          targets: [],
          stops: [],
          orderIndices: [],
          error: `Gare #${order.target} introuvable.`,
        };
      }
      targets.push({ x: station.x, y: station.y });
      stops.push({
        x: Math.floor(station.x),
        y: Math.floor(station.y),
        kind: 'station',
        id: station.id,
        order: index,
      });
      orderIndices.push(index);
      continue;
    }
    if (order.kind === 'industry') {
      const industry = world.industries.find((item) => item.id === order.target);
      if (!industry) {
        return {
          targets: [],
          stops: [],
          orderIndices: [],
          error: `Industrie #${order.target} introuvable.`,
        };
      }
      targets.push({ x: industry.x, y: industry.y });
      stops.push({
        x: Math.floor(industry.x),
        y: Math.floor(industry.y),
        kind: 'industry',
        id: industry.id,
        order: index,
      });
      orderIndices.push(index);
      continue;
    }
    const depot = world.depots.find((item) => item.id === order.target);
    if (!depot) {
      return {
        targets: [],
        stops: [],
        orderIndices: [],
        error: `Dépôt ${order.target} introuvable ou démoli.`,
      };
    }
    targets.push({ x: depot.x + depot.width / 2, y: depot.y + depot.height / 2 });
    stops.push({
      x: depot.x,
      y: depot.y,
      kind: 'depot',
      id: depot.id,
      order: index,
    });
    orderIndices.push(index);
  }
  return { targets, stops, orderIndices, error: null };
}

/** Compare deux valeurs selon un comparateur de condition. */
function compareOrderValues(left: number, right: number, comparator: OrderComparator): boolean {
  switch (comparator) {
    case 'equal':
      return left === right;
    case 'not_equal':
      return left !== right;
    case 'less':
      return left < right;
    case 'less_or_equal':
      return left <= right;
    case 'more':
      return left > right;
    case 'more_or_equal':
      return left >= right;
    default:
      return false;
  }
}

/** Évalue une condition d'ordre (#161) sur l'état du monde et du véhicule. */
function evaluateOrderCondition(
  world: MockWorld,
  vehicle: MockVehicle,
  condition: OrderCondition,
): boolean {
  const company = world.companies[vehicle.company];
  switch (condition.type) {
    case 'money':
      return compareOrderValues(company?.money ?? 0, condition.value, condition.comparator);
    case 'date': {
      const left = world.year * MONTHS_PER_YEAR + world.month;
      const right = condition.value * MONTHS_PER_YEAR + (condition.month ?? 0);
      return compareOrderValues(left, right, condition.comparator);
    }
    case 'percentage': {
      const percent =
        vehicle.cargoCapacity > 0
          ? Math.round((vehicle.cargoAmount / vehicle.cargoCapacity) * 100)
          : 0;
      return compareOrderValues(percent, condition.value, condition.comparator);
    }
    case 'cargo':
    default: {
      const amount =
        !condition.cargo || condition.cargo === vehicle.cargoType ? vehicle.cargoAmount : 0;
      return compareOrderValues(amount, condition.value, condition.comparator);
    }
  }
}

/**
 * Prochain ordre à exécuter après l'arrêt `fromIndex` (#161). Les
 * conditionnels rencontrés sont évalués dans l'ordre ; un saut reboucle sur la
 * cible indiquée, avec une garde contre les boucles infinies.
 */
function nextOrderIndex(world: MockWorld, vehicle: MockVehicle, fromIndex: number): number | null {
  const count = vehicle.orders.length;
  if (count === 0) return null;
  let index = (fromIndex + 1) % count;
  let guard = 0;
  while (guard < count * 2 + 1) {
    guard += 1;
    const order = vehicle.orders[index];
    if (!order) return null;
    if (order.kind !== 'conditional') return index;
    const condition = order.options?.condition;
    const jump = order.options?.jump;
    if (condition && evaluateOrderCondition(world, vehicle, condition)) {
      if (jump === undefined || jump < 0 || jump >= count) {
        addNews(
          world,
          'warning',
          `Véhicule #${vehicle.id} : saut conditionnel invalide vers l'ordre ${String(jump)}.`,
        );
        index = (index + 1) % count;
        continue;
      }
      index = jump;
      continue;
    }
    index = (index + 1) % count;
  }
  addNews(
    world,
    'error',
    `Véhicule #${vehicle.id} : boucle de conditions sans destination, tournée ignorée.`,
  );
  return null;
}

/** Recalcule la boucle d'un véhicule depuis sa tournée et son ordre courant. */
function rebuildRoute(world: MockWorld, vehicle: MockVehicle): boolean {
  if (vehicle.orders.length === 0) {
    addNews(world, 'warning', `Véhicule #${vehicle.id} : ajoutez au moins un ordre.`);
    if (vehicle.status !== 3) vehicle.status = 0;
    return false;
  }
  const resolved = resolveOrders(world, vehicle.orders, vehicle.kind, vehicle.currentOrder);
  if (resolved.error) {
    addNews(world, 'error', `Tournée du véhicule #${vehicle.id} refusée : ${resolved.error}`);
    if (vehicle.status !== 3) vehicle.status = 0;
    return false;
  }
  if (resolved.orderIndices.length === 0) {
    addNews(
      world,
      'error',
      `Tournée du véhicule #${vehicle.id} refusée : aucun arrêt physique (conditions seules).`,
    );
    if (vehicle.status !== 3) vehicle.status = 0;
    return false;
  }
  const { origin, error: originError } = routeOriginForVehicle(world, vehicle);
  if (originError) {
    addNews(world, 'error', `Tournée du véhicule #${vehicle.id} refusée : ${originError}`);
    if (vehicle.status !== 3) vehicle.status = 0;
    return false;
  }
  if (
    origin &&
    resolved.targets.length > 0 &&
    resolved.targets.every(
      (target) =>
        Math.floor(target.x) === origin.depot.x && Math.floor(target.y) === origin.depot.y,
    )
  ) {
    addNews(
      world,
      'info',
      `Véhicule #${vehicle.id} : tournée limitée à son dépôt, il reste sur place.`,
    );
    vehicle.status = 3;
    vehicle.waitTicks = 0;
    return false;
  }
  const route = buildRoutePath(
    world,
    { x: vehicle.x, y: vehicle.y },
    resolved.targets,
    vehicle.kind,
    origin,
  );
  if (!route.path) {
    addNews(
      world,
      'error',
      `Tournée du véhicule #${vehicle.id} refusée : ${route.error ?? 'itinéraire introuvable.'}`,
    );
    if (vehicle.status !== 3) vehicle.status = 0;
    return false;
  }
  const path = route.path;
  vehicle.path = path;
  vehicle.pathLengths = computePathLengths(path);
  vehicle.segmentStops = segmentsForStopsOnPath(path, resolved.stops);
  vehicle.routeOrders = resolved.orderIndices;
  vehicle.currentOrder = resolved.orderIndices[0] ?? 0;
  vehicle.segment = 0;
  vehicle.segmentT = 0;
  vehicle.waitTicks = 0;
  vehicle.status = 1;
  return true;
}

/** Aligne `routeOrders` sur la tournée, sans recalculer le tracé. */
function syncRouteOrders(vehicle: MockVehicle): void {
  const positional = vehicle.orders
    .map((order, index) => ({ order, index }))
    .filter((item) => item.order.kind !== 'conditional')
    .map((item) => item.index);
  vehicle.routeOrders = positional;
  if (!positional.includes(vehicle.currentOrder)) vehicle.currentOrder = positional[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Construction du monde
// ---------------------------------------------------------------------------

class WorldBuilder {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly startYear: number;
  readonly rng: Prng;
  readonly difficulty: number;
  readonly economy: MockDifficultyPreset;

  readonly kind: Uint8Array;
  readonly heightMap: Uint8Array;
  readonly owner: Uint8Array;
  readonly flags: Uint8Array;
  readonly trackBits: Uint8Array;
  readonly railTypes: Uint8Array;
  readonly roadData: Uint8Array;
  readonly signalData: Uint8Array;

  readonly companies: MockCompany[];
  readonly towns: MockTown[] = [];
  readonly industries: MockIndustry[] = [];
  readonly stations: MockStation[] = [];
  readonly depots: MockDepot[] = [];
  readonly structures: MockStructure[] = [];
  readonly vehicles: MockVehicle[] = [];
  readonly subsidies: MockSubsidy[] = [];
  /** Option #172 : les désastres sont désactivés par défaut. */
  readonly disastersEnabled: boolean;

  constructor(options: NewGameOptions, seed: number) {
    this.seed = seed;
    this.width = clampInt(options.width ?? 192, 64, 512);
    this.height = clampInt(options.height ?? 192, 64, 512);
    this.startYear = clampInt(options.startYear ?? 1950, 1, 9999);
    this.difficulty = Math.min(3, Math.max(0, Math.round(options.difficulty ?? 1)));
    this.economy = difficultyPreset(this.difficulty);
    this.disastersEnabled = options.disasters === true;
    this.rng = new Prng(seed ^ 0x51ed270b);
    const size = this.width * this.height;
    this.kind = new Uint8Array(size);
    this.heightMap = new Uint8Array(size);
    this.owner = new Uint8Array(size).fill(COMPANY_NONE);
    this.flags = new Uint8Array(size);
    this.trackBits = new Uint8Array(size);
    this.railTypes = new Uint8Array(size);
    this.roadData = new Uint8Array(size);
    this.signalData = new Uint8Array(size);
    this.companies = [];

    /* Entreprises humaines (#99) : une par profil fourni, ids 0..n-1. Sans
     * profil, le mock conserve son entreprise de démonstration historique. */
    const profiles = options.companies ?? [];
    if (profiles.length > 0) {
      for (const [index, profile] of profiles.entries()) {
        this.companies.push({
          id: index,
          name: profile.name.trim() !== '' ? profile.name : `Entreprise ${index + 1}`,
          president: index === 0 ? 'Vous' : `Joueur ${index + 1}`,
          colour: clampInt(profile.colour, 0, 15),
          money: 2_400_000,
          loan: this.economy.startLoan,
          maxLoan: this.economy.maxLoan,
          value: 2_400_000 + this.economy.startLoan,
          income: 0,
          expenses: 0,
          isAI: false,
          isLocal: index === 0,
          bankrupt: false,
          monthsOfBankruptcy: 0,
          deliveredToday: 0,
          vehicleCount: 0,
          stationCount: 0,
          interestPaid: 0,
        });
      }

      const aiNames = ['Ligne du Lac', 'Express Côtier', 'Route des Cimes'];
      const aiPresidents = ['IA · C. Dubois', 'IA · M. Lefèvre', 'IA · S. Bernard'];
      const aiCount = clampInt(options.aiCompanies ?? 0, 0, aiNames.length);
      for (let i = 0; i < aiCount; i += 1) {
        const id = this.companies.length;
        this.companies.push({
          id,
          name: aiNames[i] ?? `IA ${i + 1}`,
          president: aiPresidents[i] ?? `IA · Joueur ${i + 1}`,
          colour: (profiles.length + i) % 16,
          money: 1_850_000,
          loan: Math.round(this.economy.startLoan * 0.65),
          maxLoan: Math.round(this.economy.maxLoan * 0.8),
          value: 2_300_000,
          income: 0,
          expenses: 0,
          isAI: true,
          isLocal: false,
          bankrupt: false,
          monthsOfBankruptcy: 0,
          deliveredToday: 0,
          vehicleCount: 0,
          stationCount: 0,
          interestPaid: 0,
          aiLevel: clampInt(
            1 + i + (this.difficulty >= 3 ? 2 : this.difficulty >= 2 ? 1 : 0),
            1,
            3,
          ),
          aiNextBuildDay:
            2 +
            (3 -
              clampInt(1 + i + (this.difficulty >= 3 ? 2 : this.difficulty >= 2 ? 1 : 0), 1, 3)) *
              3 +
            id,
          aiLinks: [],
        });
      }
    } else {
      this.companies.push({
        id: 0,
        name: 'Transports du Nord',
        president: 'A. Martin',
        colour: COMPANY_COLOURS[0],
        money: 2_400_000,
        loan: this.economy.startLoan,
        maxLoan: this.economy.maxLoan,
        value: 2_400_000 + this.economy.startLoan,
        income: 0,
        expenses: 0,
        isAI: false,
        isLocal: true,
        bankrupt: false,
        monthsOfBankruptcy: 0,
        deliveredToday: 0,
        vehicleCount: 0,
        stationCount: 0,
        interestPaid: 0,
      });

      /* Solo sans profils explicites : le nombre d'IA demandé s'applique aussi.
       * Sans option (`aiCompanies` absent), on conserve l'IA de démonstration
       * historique pour ne pas casser les parties et captures existantes. */
      const aiNames = ['Ligne du Lac', 'Express Côtier', 'Route des Cimes'];
      const aiPresidents = ['IA · C. Dubois', 'IA · M. Lefèvre', 'IA · S. Bernard'];
      const aiCount = clampInt(options.aiCompanies ?? 1, 0, aiNames.length);
      for (let i = 0; i < aiCount; i += 1) {
        const id = this.companies.length;
        const level = clampInt(
          1 + i + (this.difficulty >= 3 ? 2 : this.difficulty >= 2 ? 1 : 0),
          1,
          3,
        );
        this.companies.push({
          id,
          name: aiNames[i] ?? `IA ${i + 1}`,
          president: aiPresidents[i] ?? `IA · Joueur ${i + 1}`,
          colour: COMPANY_COLOURS[i + 1] ?? (i + 1) % 16,
          money: 1_850_000,
          loan: Math.round(this.economy.startLoan * 0.65),
          maxLoan: Math.round(this.economy.maxLoan * 0.8),
          value: 2_300_000,
          income: 0,
          expenses: 0,
          isAI: true,
          isLocal: false,
          bankrupt: false,
          monthsOfBankruptcy: 0,
          deliveredToday: 0,
          vehicleCount: 0,
          stationCount: 0,
          interestPaid: 0,
          aiLevel: level,
          aiNextBuildDay: 2 + (3 - level) * 3 + id,
          aiLinks: [],
        });
      }
    }
  }

  private index(x: number, y: number): number {
    return tileIndex(x, y, this.width);
  }

  setTile(x: number, y: number, kindIndex: number, owner = COMPANY_NONE): void {
    if (!inBounds(this.width, this.height, x, y)) return;
    const index = this.index(x, y);
    this.kind[index] = kindIndex;
    if (owner !== COMPANY_NONE) this.owner[index] = owner;
  }

  kindAt(x: number, y: number): number {
    if (!inBounds(this.width, this.height, x, y)) return K.void;
    return this.kind[this.index(x, y)] ?? K.void;
  }

  isWater(x: number, y: number): boolean {
    const value = this.kindAt(x, y);
    return value === K.water || value === K.river || value === K.canal || value === K.void;
  }

  flatten(cx: number, cy: number, radiusX: number, radiusY: number, level: number): void {
    for (let y = cy - radiusY; y <= cy + radiusY; y += 1) {
      for (let x = cx - radiusX; x <= cx + radiusX; x += 1) {
        if (!inBounds(this.width, this.height, x, y)) continue;
        const index = this.index(x, y);
        // L'eau garde son plan : un aplatissement de ville ou d'industrie ne
        // doit pas relever une tuile d'eau voisine et créer une nappe flottante.
        const kind = this.kind[index] ?? K.void;
        if (kind === K.water || kind === K.river || kind === K.canal || kind === K.lock) continue;
        this.heightMap[index] = level;
      }
    }
  }

  findLand(centerX: number, centerY: number, radius: number, margin: number): P2 | null {
    const startX = Math.round(centerX);
    const startY = Math.round(centerY);
    for (let r = 0; r <= radius; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = startX + dx;
          const y = startY + dy;
          if (x < margin || y < margin || x >= this.width - margin || y >= this.height - margin)
            continue;
          let ok = true;
          for (let oy = -margin; oy <= margin && ok; oy += 1) {
            for (let ox = -margin; ox <= margin; ox += 1) {
              if (this.isWater(x + ox, y + oy)) {
                ok = false;
                break;
              }
            }
          }
          if (ok) return { x, y };
        }
      }
    }
    return null;
  }

  findWater(centerX: number, centerY: number, radius: number): P2 | null {
    const startX = clampInt(centerX, 1, this.width - 2);
    const startY = clampInt(centerY, 1, this.height - 2);
    for (let r = 0; r <= radius; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const value = this.kindAt(startX + dx, startY + dy);
          if (value === K.water || value === K.river) return { x: startX + dx, y: startY + dy };
        }
      }
    }
    return null;
  }

  findCoast(centerX: number, centerY: number, radius: number): P2 | null {
    const startX = Math.round(centerX);
    const startY = Math.round(centerY);
    for (let r = 0; r <= radius; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = startX + dx;
          const y = startY + dy;
          const value = this.kindAt(x, y);
          if (value !== K.coast && value !== K.grass && value !== K.trees) continue;
          if (
            this.isWater(x + 1, y) ||
            this.isWater(x - 1, y) ||
            this.isWater(x, y + 1) ||
            this.isWater(x, y - 1)
          ) {
            return { x, y };
          }
        }
      }
    }
    return null;
  }

  paintArea(center: P2, width: number, height: number, kindIndex: number, owner: number): void {
    const left = center.x - Math.floor(width / 2);
    const top = center.y - Math.floor(height / 2);
    const level = Math.max(1, this.heightMap[this.index(center.x, center.y)] ?? 4);
    this.flatten(center.x, center.y, Math.floor(width / 2) + 1, Math.floor(height / 2) + 1, level);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        this.setTile(left + x, top + y, kindIndex, owner);
      }
    }
  }

  /** Eau franchissable par un pont (l'`void` reste infranchissable). */
  private isBridgeWater(x: number, y: number): boolean {
    const kind = this.kindAt(x, y);
    return kind === K.water || kind === K.river || kind === K.canal || kind === K.lock;
  }

  /**
   * Aplanit les abords d'un pont de démonstration pour que la rampe rejoigne
   * une approche crédible. Seules les tuiles naturelles sont terrassées ; un
   * bâtiment, une gare ou une falaise font préférer un détour au tracé.
   */
  private prepareBridgeApproach(path: P2[], run: { start: number; end: number }): boolean {
    const from = path[run.start - 1];
    const to = path[run.end + 1];
    if (!from || !to) return false;
    const fromHeight = this.heightMap[this.index(from.x, from.y)] ?? 0;
    const toHeight = this.heightMap[this.index(to.x, to.y)] ?? 0;
    if (fromHeight !== toHeight) return false;
    for (const [index, height] of [
      [run.start - 2, fromHeight],
      [run.end + 2, toHeight],
    ] as const) {
      const point = path[index];
      if (!point) return false;
      const kind = this.kindAt(point.x, point.y);
      const natural =
        kind === K.grass ||
        kind === K.clear ||
        kind === K.rough ||
        kind === K.trees ||
        kind === K.coast;
      if (!natural) return false;
      const tile = this.index(point.x, point.y);
      const current = this.heightMap[tile] ?? 0;
      if (Math.abs(current - height) > 2) return false;
      this.heightMap[tile] = height;
    }
    return true;
  }

  /**
   * Chemin déterministe qui contourne l'eau. Le réseau de démonstration
   * préfère un détour à une traversée de lac : les ponts ne servent qu'aux
   * cours d'eau étroits dont les deux berges sont au même niveau.
   */
  private findDryPath(from: P2, to: P2): P2[] | null {
    const size = this.width * this.height;
    const start = this.index(
      clampInt(Math.floor(from.x), 0, this.width - 1),
      clampInt(Math.floor(from.y), 0, this.height - 1),
    );
    const goal = this.index(
      clampInt(Math.floor(to.x), 0, this.width - 1),
      clampInt(Math.floor(to.y), 0, this.height - 1),
    );
    if (start === goal) return [{ x: from.x, y: from.y }];
    if (this.isWater(start % this.width, Math.floor(start / this.width))) return null;
    if (this.isWater(goal % this.width, Math.floor(goal / this.width))) return null;

    const costAt = (index: number): number => {
      const kind = this.kind[index] ?? K.void;
      if (kind === K.water || kind === K.river || kind === K.canal || kind === K.lock) return -1;
      if (kind === K.void) return -1;
      if (kind === K.bridge || kind === K.tunnel || kind === K.aqueduct) return 24;
      if (
        kind === K.house ||
        kind === K.industry ||
        kind === K.station ||
        kind === K.airport ||
        kind === K.dock ||
        kind === K.object
      ) {
        return 16;
      }
      return 1;
    };

    const gScore = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const heap: { index: number; f: number; g: number }[] = [];
    const push = (node: { index: number; f: number; g: number }): void => {
      heap.push(node);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        const a = heap[parent];
        const b = heap[child];
        if (!a || !b || a.f < b.f || (a.f === b.f && a.index <= b.index)) break;
        heap[parent] = b;
        heap[child] = a;
        child = parent;
      }
    };
    const pop = (): { index: number; f: number; g: number } | null => {
      const top = heap[0] ?? null;
      const last = heap.pop();
      if (heap.length > 0 && last) {
        heap[0] = last;
        let parent = 0;
        for (;;) {
          const left = parent * 2 + 1;
          const right = left + 1;
          let best = parent;
          const current = heap[best];
          const l = heap[left];
          const r = heap[right];
          if (l && (!current || l.f < current.f || (l.f === current.f && l.index < current.index)))
            best = left;
          const bestNode = heap[best];
          if (
            r &&
            (!bestNode || r.f < bestNode.f || (r.f === bestNode.f && r.index < bestNode.index))
          )
            best = right;
          if (best === parent) break;
          const swap = heap[parent];
          const other = heap[best];
          if (!swap || !other) break;
          heap[parent] = other;
          heap[best] = swap;
          parent = best;
        }
      }
      return top;
    };
    const gx = goal % this.width;
    const gy = Math.floor(goal / this.width);
    const heuristic = (index: number): number =>
      Math.abs((index % this.width) - gx) + Math.abs(Math.floor(index / this.width) - gy);

    gScore[start] = 0;
    push({ index: start, f: heuristic(start), g: 0 });
    let guard = size * 4;
    while (heap.length > 0 && guard > 0) {
      guard -= 1;
      const node = pop();
      if (!node) break;
      if (closed[node.index]) continue;
      if (node.index === goal) {
        const path: P2[] = [];
        let cursor = goal;
        while (cursor >= 0) {
          path.push({ x: cursor % this.width, y: Math.floor(cursor / this.width) });
          if (cursor === start) break;
          cursor = cameFrom[cursor] ?? -1;
        }
        return path.reverse();
      }
      closed[node.index] = 1;
      const x = node.index % this.width;
      const y = Math.floor(node.index / this.width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(this.width, this.height, nx, ny)) continue;
        const next = this.index(nx, ny);
        if (closed[next]) continue;
        const step = costAt(next);
        if (step < 0) continue;
        const tentative = node.g + step;
        if (tentative >= (gScore[next] ?? Number.POSITIVE_INFINITY)) continue;
        gScore[next] = tentative;
        cameFrom[next] = node.index;
        push({ index: next, f: tentative + heuristic(next), g: tentative });
      }
    }
    return null;
  }

  paintRoute(tiles: P2[], kindIndex: number, owner: number): P2[] {
    const maxBridgeSpan = 6;
    const collectRuns = (path: P2[]): { start: number; end: number }[] => {
      const runs: { start: number; end: number }[] = [];
      for (let i = 0; i < path.length; i += 1) {
        const point = path[i];
        if (!point || !this.isBridgeWater(point.x, point.y)) continue;
        let end = i;
        while (end + 1 < path.length) {
          const next = path[end + 1];
          if (!next || !this.isBridgeWater(next.x, next.y)) break;
          end += 1;
        }
        runs.push({ start: i, end });
        i = end;
      }
      // Deux trous séparés d'une seule tuile forment un seul ouvrage.
      for (let i = 1; i < runs.length; i += 1) {
        const previous = runs[i - 1];
        const current = runs[i];
        if (!previous || !current) continue;
        if (current.start - previous.end <= 2) {
          previous.end = current.end;
          runs.splice(i, 1);
          i -= 1;
        }
      }
      return runs;
    };
    const validRun = (path: P2[], run: { start: number; end: number }): boolean => {
      if (run.start <= 0 || run.end >= path.length - 1) return false;
      if (run.end - run.start + 1 > maxBridgeSpan) return false;
      const from = path[run.start - 1];
      const to = path[run.end + 1];
      if (!from || !to) return false;
      const fromHeight = this.heightMap[this.index(from.x, from.y)] ?? 0;
      const toHeight = this.heightMap[this.index(to.x, to.y)] ?? 0;
      if (fromHeight !== toHeight) return false;
      // Approche plane : la rampe du rendu rejoint le sol sans traverser une
      // falaise ni surplomber l'eau.
      for (let distance = 1; distance <= BRIDGE_APPROACH_TILES; distance += 1) {
        const before = path[run.start - 1 - distance];
        const after = path[run.end + 1 + distance];
        if (!before || !after) return false;
        for (const [point, height] of [
          [before, fromHeight],
          [after, toHeight],
        ] as const) {
          if (this.isBridgeWater(point.x, point.y) || this.kindAt(point.x, point.y) === K.void) {
            return false;
          }
          if ((this.heightMap[this.index(point.x, point.y)] ?? 0) !== height) return false;
        }
      }
      return true;
    };

    let path = tiles;
    let runs = collectRuns(path);
    if (runs.some((run) => !validRun(path, run))) {
      for (const run of runs) {
        if (!validRun(path, run)) this.prepareBridgeApproach(path, run);
      }
    }
    if (runs.some((run) => !validRun(path, run))) {
      const first = path[0];
      const last = path[path.length - 1];
      if (first && last) {
        const detour = this.findDryPath(first, last);
        if (detour) {
          path = detour;
          runs = collectRuns(path);
        }
      }
    }
    const accepted = runs.some((run) => !validRun(path, run))
      ? runs
      : runs.filter((run) => validRun(path, run));
    const rangeByStart = new Map<
      number,
      { start: number; end: number; underlay: MockStructure['underlay'] }
    >();
    for (const run of accepted) {
      const start = run.start - 1;
      const end = run.end + 1;
      const underlay: MockStructure['underlay'] = [];
      for (let i = start; i <= end; i += 1) {
        const point = path[i];
        if (!point) continue;
        const index = this.index(point.x, point.y);
        underlay.push({
          index,
          kind: this.kind[index] ?? K.grass,
          owner: this.owner[index] ?? COMPANY_NONE,
          flags: this.flags[index] ?? 0,
          trackBits: this.trackBits[index] ?? 0,
        });
      }
      rangeByStart.set(start, { start, end, underlay });
    }

    let range: { start: number; end: number; underlay: MockStructure['underlay'] } | null = null;
    for (let i = 0; i < path.length; i += 1) {
      const point = path[i];
      if (!point) continue;
      const index = this.index(point.x, point.y);
      const active = rangeByStart.get(i) ?? null;
      if (active) {
        range = active;
      }
      if (range && i >= range.start && i <= range.end) {
        const abutment = i === range.start || i === range.end;
        if (abutment) {
          this.kind[index] = K.bridge;
          this.owner[index] = owner;
          this.trackBits[index] = 0;
          this.flags[index] = TILE_FLAG.BRIDGE;
        } else {
          this.flags[index] = (this.flags[index] ?? 0) | TILE_FLAG.BRIDGE;
          this.owner[index] = owner;
        }
      } else {
        range = null;
        const existing = this.kind[index] ?? K.grass;
        const existingNetwork =
          existing === K.rail
            ? 'rail'
            : existing === K.road
              ? 'road'
              : existing === K.crossing
                ? 'crossing'
                : null;
        const network = kindIndex === K.rail ? 'rail' : 'road';
        if (
          existingNetwork !== null &&
          existingNetwork !== network &&
          existingNetwork !== 'crossing'
        ) {
          // Deux réseaux se croisent : passage à niveau, pas d'écrasement.
          const bits = (this.trackBits[index] ?? 0) & 0x0f;
          this.kind[index] = K.crossing;
          this.trackBits[index] = bits | (existing === K.rail ? TRACK_BIT_CROSSING_RAIL : 0);
          this.owner[index] = owner;
          continue;
        }
        this.kind[index] = kindIndex;
        this.owner[index] = owner;
        this.roadData[index] = 0;
        const previous = path[i - 1];
        const next = path[i + 1];
        let bits = 0;
        if (previous) bits |= directionBit(point, previous);
        if (next) bits |= directionBit(point, next);
        this.trackBits[index] = (this.trackBits[index] ?? 0) | bits;
      }
      if (range && i === range.end) {
        const from = path[range.start];
        const to = path[range.end];
        if (from && to) {
          const length = range.end - range.start + 1;
          const span = length - 1;
          let maxGround = 0;
          for (let j = range.start; j <= range.end; j += 1) {
            const item = path[j];
            if (!item) continue;
            maxGround = Math.max(maxGround, this.heightMap[this.index(item.x, item.y)] ?? 0);
          }
          const material: BridgeMaterial =
            kindIndex === K.rail
              ? span <= 5
                ? 'steel'
                : 'tubular'
              : span <= 2
                ? 'concrete'
                : span <= 5
                  ? 'steel'
                  : 'tubular';
          const spec = BRIDGE_MATERIALS[material];
          this.structures.push({
            id: this.structures.length,
            type: 'bridge',
            company: owner,
            transport: kindIndex === K.rail ? 'rail' : 'road',
            material,
            from: { ...from },
            to: { ...to },
            length,
            deckHeight: maxGround + spec.deckLift,
            maintenancePerYear: Math.round(
              length * (kindIndex === K.rail ? spec.railMaintenance : spec.roadMaintenance),
            ),
            underlay: range.underlay,
          });
        }
        range = null;
      }
    }
    return path;
  }

  private generateTerrain(): void {
    const { width, height, seed } = this;
    const seaNoiseSeed = seed + 0x2f6a;

    for (let y = 0; y < height; y += 1) {
      const seaEdge = width - 22 - Math.round(valueNoise(seaNoiseSeed, y * 0.06, 3.7) * 16);
      const riverX =
        width * 0.44 +
        Math.sin(y * 0.055) * width * 0.07 +
        (valueNoise(seed + 0x71, y * 0.11, 0.5) - 0.5) * 5;
      const lakeX = width * 0.24;
      const lakeY = height * 0.7;
      const lakeRx = Math.max(6, width * 0.085);
      const lakeRy = Math.max(5, height * 0.075);

      for (let x = 0; x < width; x += 1) {
        const index = this.index(x, y);
        const isSea = x >= seaEdge;
        const isRiver = Math.abs(x - riverX) <= 1.1 && y < height * 0.94;
        const lakeNoise = (valueNoise(seed + 0x13, x * 0.09, y * 0.09) - 0.5) * 0.45;
        const inLake =
          ((x - lakeX) * (x - lakeX)) / (lakeRx * lakeRx) +
            ((y - lakeY) * (y - lakeY)) / (lakeRy * lakeRy) <
          1 + lakeNoise;

        if (isSea || isRiver || inLake) {
          this.kind[index] = isRiver && !isSea ? K.river : K.water;
          this.heightMap[index] = 0;
          this.flags[index] = (this.flags[index] ?? 0) | TILE_FLAG.WATER;
          continue;
        }

        const inland = 1 - x / width;
        const macro = fbm(seed + 0x3a, x * 0.018, y * 0.018, 4);
        const ridge = 1 - Math.abs(2 * fbm(seed + 0x77, x * 0.045, y * 0.045, 3) - 1);
        const detail = valueNoise(seed + 0x51, x * 0.12, y * 0.12);
        const raw = 1.2 + macro * 8.5 + Math.pow(ridge, 3) * 5.5 + detail * 1.2 + inland * 1.2;
        const level = Math.max(1, Math.min(15, Math.round(raw)));
        this.heightMap[index] = level;

        const treeNoise = valueNoise(seed + 0x91, x * 0.115, y * 0.115);
        if (level >= 12) {
          this.kind[index] = K.rough;
        } else if (treeNoise > 0.635) {
          this.kind[index] = K.trees;
        } else if (level >= 11 && treeNoise > 0.6) {
          this.kind[index] = K.rough;
        } else {
          this.kind[index] = K.grass;
        }
      }
    }

    // Cuvettes côtières : la hauteur décroît avec la distance à l'eau, ce qui
    // garantit des plages et des vallées fluviales crédibles.
    this.lowerTowardsWater();

    // Plages : les tuiles terrestres basses adjacentes à l'eau deviennent des côtes.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = this.index(x, y);
        const level = this.heightMap[index] ?? 0;
        if (level === 0 || level > 3) continue;
        const nearWater =
          this.isWater(x - 1, y) ||
          this.isWater(x + 1, y) ||
          this.isWater(x, y - 1) ||
          this.isWater(x, y + 1);
        if (nearWater) this.kind[index] = K.coast;
      }
    }
  }

  /** Distance de Manhattan approchée à l'eau, puis rabote les hauteurs. */
  private lowerTowardsWater(): void {
    const { width, height, heightMap, kind } = this;
    const distances = new Int16Array(width * height).fill(-1);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    for (let index = 0; index < distances.length; index += 1) {
      if ((kind[index] ?? 0) === K.water || (kind[index] ?? 0) === K.river) {
        distances[index] = 0;
        queue[tail++] = index;
      }
    }
    while (head < tail) {
      const index = queue[head++] ?? 0;
      const x = index % width;
      const y = (index - x) / width;
      const next = (distances[index] ?? 0) + 1;
      if (next > 4) continue;
      const visit = (nx: number, ny: number): void => {
        if (!inBounds(width, height, nx, ny)) return;
        const neighbour = tileIndex(nx, ny, width);
        if ((distances[neighbour] ?? -1) >= 0) return;
        distances[neighbour] = next;
        queue[tail++] = neighbour;
      };
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    for (let index = 0; index < heightMap.length; index += 1) {
      const distance = distances[index] ?? 9;
      if (distance <= 0 || distance > 4) continue;
      const cap = 1 + distance * 2;
      heightMap[index] = Math.min(heightMap[index] ?? 0, Math.max(1, Math.round(cap)));
    }
  }

  private generateTowns(): void {
    const anchors: P2[] = [
      { x: this.width * 0.26, y: this.height * 0.26 },
      { x: this.width * 0.6, y: this.height * 0.48 },
      { x: this.width * 0.34, y: this.height * 0.78 },
    ];
    for (let i = 0; i < 3; i += 1) {
      const anchor = anchors[i] ?? { x: this.width / 2, y: this.height / 2 };
      const spot = this.findLand(anchor.x, anchor.y, 22, 5) ?? {
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
      };
      const level = Math.max(2, this.heightMap[this.index(spot.x, spot.y)] ?? 3);
      this.flatten(spot.x, spot.y, 8, 8, level);
      const radius = 5;
      let buildings = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > radius + 0.35) continue;
          if (this.rng.chance(0.42 + (radius - d) * 0.1)) {
            this.setTile(spot.x + dx, spot.y + dy, K.house);
            buildings += 1;
          }
        }
      }
      this.towns.push({
        id: i,
        name: TOWN_NAMES[i] ?? `Ville ${i + 1}`,
        x: spot.x + 0.5,
        y: spot.y + 0.5,
        population: 420 + this.rng.int(0, 900),
        growthRate: 1 + this.rng.int(0, 3),
        buildings,
        rating: this.rng.int(35, 80),
        actionMonths: { advertise: -1, fund_roads: -1, fund_buildings: -1 },
      });
    }
  }

  private generateIndustries(): void {
    const spots: P2[] = [
      { x: this.width * 0.18, y: this.height * 0.5 },
      { x: this.width * 0.5, y: this.height * 0.24 },
      { x: this.width * 0.72, y: this.height * 0.36 },
      { x: this.width * 0.44, y: this.height * 0.68 },
      { x: this.width * 0.72, y: this.height * 0.8 },
    ];
    for (let i = 0; i < INDUSTRY_DEFINITIONS.length; i += 1) {
      const definition = INDUSTRY_DEFINITIONS[i];
      const anchor = spots[i];
      if (!definition || !anchor) continue;
      const spot = this.findLand(anchor.x, anchor.y, 24, 2) ?? {
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
      };
      this.paintArea(spot, 3, 3, K.industry, COMPANY_NONE);
      const production = definition.cargo === '' ? 0 : this.rng.int(120, 640);
      this.industries.push({
        id: i,
        name: definition.name,
        kind: definition.kind,
        x: spot.x + 0.5,
        y: spot.y + 0.5,
        production,
        transported: definition.cargo === '' ? 0 : this.rng.int(40, 300),
        cargo: definition.cargo,
        accepts: [...definition.accepts],
        stock: production === 0 ? 0 : Math.round(production * this.rng.float(0.25, 0.6)),
      });
    }
    this.generateSubsidies();
  }

  /**
   * Offres initiales de subvention : une source qui produit une cargaison et
   * un consommateur qui l'accepte. L'attribution reste automatique, comme
   * dans OpenTTD : le premier transporteur qui relie les deux extrémités.
   */
  private generateSubsidies(): void {
    const pairs: { from: number; to: number; cargo: string }[] = [];
    for (const source of this.industries) {
      if (source.cargo === '') continue;
      const destination = this.industries.find(
        (industry) => industry.id !== source.id && industry.accepts.includes(source.cargo),
      );
      if (destination) pairs.push({ from: source.id, to: destination.id, cargo: source.cargo });
    }
    for (const pair of pairs.slice(0, 3)) {
      this.subsidies.push({
        id: this.subsidies.length,
        cargo: pair.cargo,
        fromIndustry: pair.from,
        toIndustry: pair.to,
        remainingMonths: SUBSIDY_OFFER_MONTHS,
        awardedTo: null,
      });
    }
  }

  private addStation(
    kind: MockStation['kind'],
    near: P2,
    owner: number,
    name: string,
    stationWidth: number,
    stationHeight: number,
    paintKind: number,
    searchRadius = 20,
  ): MockStation | null {
    const spot = this.findLand(near.x, near.y, searchRadius, 3);
    if (!spot) return null;
    this.paintArea(spot, stationWidth, stationHeight, paintKind, owner);
    const station: MockStation = {
      id: this.stations.length,
      company: owner,
      name,
      kind,
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      width: stationWidth,
      height: stationHeight,
      waiting: [],
    };
    this.stations.push(station);
    return station;
  }

  /** Cherche une tuile constructible (hors eau, voie, gare, ville, industrie). */
  private findDepotSpot(near: P2): P2 | null {
    const startX = clampInt(near.x, 1, this.width - 2);
    const startY = clampInt(near.y, 1, this.height - 2);
    for (let radius = 0; radius <= 12; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = startX + dx;
          const y = startY + dy;
          if (!inBounds(this.width, this.height, x, y)) continue;
          const kind = this.kindAt(x, y);
          if (kind === K.grass || kind === K.clear || kind === K.trees || kind === K.rough) {
            return { x, y };
          }
        }
      }
    }
    return null;
  }

  /**
   * Pose un dépôt de démonstration traversé est-ouest et l'enregistre dans
   * `depots` : le panneau dépôt et l'achat de véhicules fonctionnent ainsi dès
   * le premier snapshot.
   */
  private addDepot(kind: DepotKind, near: P2, owner: number): MockDepot | null {
    const spot = this.findDepotSpot(near);
    if (!spot) return null;
    const index = this.index(spot.x, spot.y);
    this.kind[index] = kind === 'rail' ? K.rail : K.road;
    this.owner[index] = owner;
    this.trackBits[index] = depotConnections('ne');
    const depot: MockDepot = {
      id: this.depots.length,
      company: owner,
      kind,
      x: spot.x,
      y: spot.y,
      direction: 0,
      width: 1,
      height: 1,
      ...(kind === 'rail' ? { railType: 'rail' as const } : {}),
    };
    this.depots.push(depot);
    return depot;
  }

  /**
   * Relie un dépôt de démonstration au réseau de son type le plus proche.
   *
   * OpenTTD exige qu'un dépôt soit raccordé pour qu'un véhicule puisse sortir.
   * Le mock applique désormais la même règle : sans ce raccord, un bus acheté
   * dans le dépôt de démonstration n'aurait aucun itinéraire routier valide.
   */
  private connectDepotToNetwork(depot: MockDepot): void {
    const network = depot.kind === 'rail' ? K.rail : K.road;
    let best: P2 | null = null;
    let bestDistance = Infinity;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (this.kindAt(x, y) !== network) continue;
        if (
          x >= depot.x &&
          x < depot.x + depot.width &&
          y >= depot.y &&
          y < depot.y + depot.height
        ) {
          continue;
        }
        const distance = Math.abs(x - depot.x) + Math.abs(y - depot.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }
    if (!best) return;
    const path = traceTiles({ x: depot.x, y: depot.y }, best);
    this.paintRoute(path, network, depot.company);
    // L'entrée du dépôt est la première tuile du raccordement : elle détermine
    // la porte rendue et le côté par lequel les véhicules sortent (#233).
    const first = path[1] ?? best;
    const direction = directionFromOffset(first.x - depot.x, first.y - depot.y);
    depot.direction = directionToIndex(direction);
    const index = this.index(depot.x, depot.y);
    this.trackBits[index] = depotConnections(direction);
  }

  private addVehiclesOnLoop(
    path: P2[],
    company: number,
    kind: VehicleKind,
    count: number,
    speedRange: [number, number],
    cargo: { type: string; capacity: number },
    orders: VehicleOrder[],
    segmentStops: (MockStop | null)[],
  ): void {
    const lengths = computePathLengths(path);
    const total = lengths.reduce((acc, value) => acc + value, 0);
    const orderedStops = segmentStops.map((stop) =>
      stop
        ? {
            ...stop,
            order: orders.findIndex(
              (order) => order.kind === stop.kind && order.target === stop.id,
            ),
          }
        : null,
    );
    for (let n = 0; n < count; n += 1) {
      const speed = this.rng.float(speedRange[0], speedRange[1]);
      const vehicle: MockVehicle = {
        id: this.vehicles.length,
        kind,
        company,
        model: '',
        homeDepot: null,
        path,
        pathLengths: lengths,
        segment: 0,
        segmentT: 0,
        segmentStops: orderedStops,
        currentOrder: 0,
        routeOrders: orders.map((_, index) => index),
        speed,
        direction: 0,
        pitch: 0,
        status: 1,
        waitTicks: 0,
        x: 0,
        y: 0,
        z: 0,
        cargoType: cargo.type,
        cargoClass: cargo.type,
        cargoAmount: Math.round(cargo.capacity * this.rng.float(0.2, 0.8)),
        cargoCapacity: cargo.capacity,
        cargoSource: null,
        tripDistance: 0,
        loadedTick: 0,
        orderTargets: orders.map((order) => order.target),
        orders: orders.map((order) => cloneOrder(order)),
        profitLastYear: Math.round(this.rng.float(8_000, 90_000)),
        ageDays: this.rng.int(40, 1_400),
        groupId: null,
        reliability: {
          ...initialReliability(),
          wear: this.rng.int(0, 65),
          lastServiceTick: 0,
        },
      };
      const offset = (n / count) * total + this.rng.float(-2, 2);
      placeOnPath(vehicle, ((offset % total) + total) % total);
      this.vehicles.push(vehicle);
    }
  }

  /** Marque les segments dont le nœud de départ est un arrêt. */
  private segmentsForStops(path: P2[], stops: StopPoint[]): (MockStop | null)[] {
    return segmentsForStopsOnPath(path, stops);
  }

  private generateNetwork(): void {
    const townA = this.towns[0];
    const townB = this.towns[1];
    const townC = this.towns[2];
    /** Compagnie de démonstration secondaire, ou la locale si elle n'existe pas. */
    const second = this.companies.length > 1 ? 1 : 0;

    const trainA = townA
      ? this.addStation(
          'train',
          { x: townA.x + 4, y: townA.y + 2 },
          0,
          `Gare de ${townA.name}`,
          2,
          3,
          K.station,
        )
      : null;
    const trainB = townB
      ? this.addStation(
          'train',
          { x: townB.x - 4, y: townB.y + 2 },
          second,
          `Gare de ${townB.name}`,
          2,
          3,
          K.station,
        )
      : null;
    const roadA = townB
      ? this.addStation(
          'road',
          { x: townB.x + 5, y: townB.y - 3 },
          0,
          `Arrêt de ${townB.name}`,
          2,
          2,
          K.station,
        )
      : null;
    const roadB = townC
      ? this.addStation(
          'road',
          { x: townC.x - 5, y: townC.y - 2 },
          second,
          `Arrêt de ${townC.name}`,
          2,
          2,
          K.station,
        )
      : null;
    const airport = townA
      ? this.addStation(
          'airport',
          { x: townA.x, y: townA.y - 5 },
          0,
          `Aéroport de ${townA.name}`,
          3,
          3,
          K.airport,
        )
      : null;

    const coast =
      this.findCoast(this.width * 0.24, this.height * 0.7, 22) ??
      this.findCoast(this.width - 8, this.height / 2, 32);
    let dock: MockStation | null = null;
    if (coast) {
      this.paintArea(coast, 2, 2, K.dock, second);
      dock = {
        id: this.stations.length,
        company: second,
        name: 'Dock du Lac',
        kind: 'ship',
        x: coast.x + 0.5,
        y: coast.y + 0.5,
        width: 2,
        height: 2,
        waiting: [{ cargo: 'goods', amount: 120 }],
      };
      this.stations.push(dock);
    }

    // Dépôts de démonstration : un routier près de l'arrêt A, un ferroviaire
    // près de la gare A. Ils rendent l'achat de véhicules immédiatement
    // testable, sans attendre que le joueur en construise un.
    const roadDepot = roadA ? this.addDepot('road', { x: roadA.x + 4, y: roadA.y + 4 }, 0) : null;
    const railDepot = trainA
      ? this.addDepot('rail', { x: trainA.x + 4, y: trainA.y + 4 }, 0)
      : null;

    // Réseau ferroviaire : gare A ↔ gare B.
    if (trainA && trainB) {
      const tiles = traceTiles({ x: trainA.x, y: trainA.y }, { x: trainB.x, y: trainB.y });
      const route = this.paintRoute(tiles, K.rail, 0);
      const path = loopPath(route);
      const stops = this.segmentsForStops(path, [
        { x: Math.floor(trainA.x), y: Math.floor(trainA.y), kind: 'station', id: trainA.id },
        { x: Math.floor(trainB.x), y: Math.floor(trainB.y), kind: 'station', id: trainB.id },
      ]);
      const orders = [
        { target: trainA.id, kind: 'station' as const },
        { target: trainB.id, kind: 'station' as const },
      ];
      this.addVehiclesOnLoop(
        path,
        0,
        'train',
        4,
        [22, 34],
        { type: 'passengers', capacity: 180 },
        orders,
        stops,
      );
      this.addVehiclesOnLoop(
        path,
        second,
        'train',
        4,
        [20, 32],
        { type: 'passengers', capacity: 180 },
        orders,
        stops,
      );
    }

    // Réseau routier voyageurs : arrêt A ↔ arrêt B.
    if (roadA && roadB) {
      const tiles = traceTiles({ x: roadA.x, y: roadA.y }, { x: roadB.x, y: roadB.y });
      const route = this.paintRoute(tiles, K.road, 0);
      const path = loopPath(route);
      const stops = this.segmentsForStops(path, [
        { x: Math.floor(roadA.x), y: Math.floor(roadA.y), kind: 'station', id: roadA.id },
        { x: Math.floor(roadB.x), y: Math.floor(roadB.y), kind: 'station', id: roadB.id },
      ]);
      const orders = [
        { target: roadA.id, kind: 'station' as const },
        { target: roadB.id, kind: 'station' as const },
      ];
      this.addVehiclesOnLoop(
        path,
        0,
        'road',
        4,
        [12, 20],
        { type: 'passengers', capacity: 42 },
        orders,
        stops,
      );
      this.addVehiclesOnLoop(
        path,
        second,
        'road',
        4,
        [11, 19],
        { type: 'passengers', capacity: 40 },
        orders,
        stops,
      );
    }

    // Chaîne de fret : mine → centrale, puis ferme → usine (#167).
    const freightChains: [number, number, string][] = [
      [0, 1, 'coal'],
      [3, 4, 'grain'],
    ];
    for (const [fromId, toId, cargo] of freightChains) {
      const from = this.industries[fromId];
      const to = this.industries[toId];
      if (!from || !to) continue;
      const tiles = traceTiles({ x: from.x, y: from.y }, { x: to.x, y: to.y });
      const route = this.paintRoute(tiles, K.road, 0);
      const path = loopPath(route);
      const stops = this.segmentsForStops(path, [
        { x: Math.floor(from.x), y: Math.floor(from.y), kind: 'industry', id: from.id },
        { x: Math.floor(to.x), y: Math.floor(to.y), kind: 'industry', id: to.id },
      ]);
      const orders = [
        { target: from.id, kind: 'industry' as const },
        { target: to.id, kind: 'industry' as const },
      ];
      this.addVehiclesOnLoop(
        path,
        0,
        'road',
        3,
        [10, 16],
        { type: cargo, capacity: 30 },
        orders,
        stops,
      );
      this.addVehiclesOnLoop(
        path,
        second,
        'road',
        2,
        [10, 15],
        { type: cargo, capacity: 26 },
        orders,
        stops,
      );
    }

    // Les dépôts de démonstration sont raccordés après la pose des réseaux :
    // un véhicule acheté peut ainsi rejoindre sa tournée sans traverser une
    // surface incompatible (#203).
    if (roadDepot) this.connectDepotToNetwork(roadDepot);
    if (railDepot) this.connectDepotToNetwork(railDepot);

    // Bateaux : boucle sur l'eau.
    const shipStops: P2[] = [
      this.findWater(this.width - 12, Math.round(this.height * 0.3), 20) ?? {
        x: this.width - 12,
        y: Math.round(this.height * 0.3),
      },
      this.findWater(this.width - 12, Math.round(this.height * 0.72), 20) ?? {
        x: this.width - 12,
        y: Math.round(this.height * 0.72),
      },
      this.findWater(this.width * 0.9, Math.round(this.height * 0.72), 20) ?? {
        x: Math.round(this.width * 0.9),
        y: Math.round(this.height * 0.72),
      },
      this.findWater(this.width * 0.9, Math.round(this.height * 0.3), 20) ?? {
        x: Math.round(this.width * 0.9),
        y: Math.round(this.height * 0.3),
      },
    ];
    const shipPath = loopPath(shipStops);
    this.addVehiclesOnLoop(
      shipPath,
      second,
      'ship',
      6,
      [10, 18],
      { type: 'goods', capacity: 60 },
      dock ? [{ target: dock.id, kind: 'station' }] : [],
      new Array<MockStop | null>(shipPath.length).fill(
        dock ? { kind: 'station', id: dock.id } : null,
      ),
    );

    // Avions : boucle au-dessus de la ville A.
    if (airport) {
      const ax = Math.floor(airport.x);
      const ay = Math.floor(airport.y);
      const airTiles: P2[] = [
        { x: clampInt(ax, 1, this.width - 2), y: clampInt(ay, 1, this.height - 2) },
        { x: clampInt(ax + 14, 1, this.width - 2), y: clampInt(ay - 8, 1, this.height - 2) },
        { x: clampInt(ax + 2, 1, this.width - 2), y: clampInt(ay + 16, 1, this.height - 2) },
        { x: clampInt(ax - 16, 1, this.width - 2), y: clampInt(ay - 10, 1, this.height - 2) },
      ];
      const airPath = loopPath(airTiles);
      const airStops = this.segmentsForStops(airPath, [
        { x: ax, y: ay, kind: 'station', id: airport.id },
      ]);
      this.addVehiclesOnLoop(
        airPath,
        0,
        'aircraft',
        6,
        [40, 60],
        { type: 'passengers', capacity: 90 },
        [{ target: airport.id, kind: 'station' }],
        airStops,
      );
    }

    // Complète la flotte à 40 véhicules avec des camions supplémentaires.
    const template = this.vehicles.find((vehicle) => vehicle.kind === 'road');
    let guard = 0;
    while (this.vehicles.length < VEHICLE_TARGET && template && guard < 100) {
      guard += 1;
      const clone: MockVehicle = {
        ...template,
        id: this.vehicles.length,
        segment: template.segment,
        segmentT: template.segmentT,
        path: template.path,
        pathLengths: template.pathLengths,
        segmentStops: template.segmentStops,
        currentOrder: template.currentOrder,
        routeOrders: [...template.routeOrders],
        orderTargets: [...template.orderTargets],
        orders: template.orders.map((order) => cloneOrder(order)),
        cargoSource: null,
        tripDistance: 0,
        loadedTick: 0,
        speed: this.rng.float(10, 18),
        cargoAmount: this.rng.int(0, 20),
        ageDays: this.rng.int(5, 600),
      };
      placeOnPath(clone, this.rng.float(0, 30));
      this.vehicles.push(clone);
    }
  }

  build(): MockWorld {
    this.generateTerrain();
    this.generateTowns();
    this.generateIndustries();
    // Recolle les nappes héritées des aplatissements de ville/industrie :
    // l'eau générée doit être un plan continu, jamais une mosaïque de niveaux.
    normalizeWaterLevels({
      width: this.width,
      height: this.height,
      kind: this.kind,
      heightMap: this.heightMap,
    });
    this.generateNetwork();

    const world: MockWorld = {
      seed: this.seed,
      width: this.width,
      height: this.height,
      tick: 0,
      year: this.startYear,
      month: 0,
      day: 1,
      paused: false,
      speed: 1,
      rngState: this.rng.getState(),
      inflation: 0,
      difficulty: this.difficulty,
      interestRate: this.economy.interestRate,
      loanInterval: DEFAULT_LOAN_INTERVAL,
      disastersEnabled: this.disastersEnabled,
      disasters: [],
      nextDisasterDay: this.disastersEnabled ? 14 + this.difficulty * 6 : -1,
      nextDisasterId: 0,
      kind: this.kind,
      heightMap: this.heightMap,
      owner: this.owner,
      slope: new Uint8Array(this.width * this.height),
      flags: this.flags,
      trackBits: this.trackBits,
      railTypes: this.railTypes,
      roadData: this.roadData,
      signalData: this.signalData,
      roadCount: 0,
      signalCount: 0,
      companies: this.companies,
      towns: this.towns,
      industries: this.industries,
      stations: this.stations,
      depots: this.depots,
      structures: this.structures,
      vehicles: this.vehicles,
      subsidies: this.subsidies,
      groups: [],
      news: [
        {
          tick: 0,
          kind: 'info',
          text: `Nouvelle partie : ${this.width}×${this.height} tuiles, graine ${this.seed}.`,
        },
        {
          tick: 0,
          kind: 'company',
          text: `${this.companies[0]?.name ?? 'Votre entreprise'} démarre avec 2 400 000 £.`,
        },
        {
          tick: 0,
          kind: 'info',
          text: 'Clic droit / Alt + glisser pour tourner, molette pour zoomer, clic pour sélectionner.',
        },
      ],
      newsCursor: 0,
      events: [],
      eventCursor: 0,
      mapDirty: true,
      mapSent: false,
      mapVersion: 1,
      sequence: 0,
    };

    computeSlopes(world);
    updateVehiclesTransforms(world);
    return world;
  }
}

/**
 * Bit privé des sauvegardes mock antérieures à #90 (l'UI ne l'utilise plus).
 * Il n'est jamais écrit : il sert uniquement à reconstruire `depots` à partir
 * des cartes sauvegardées par la branche #29.
 */
const LEGACY_DEPOT_TRACK_BIT = 1 << 7;

/** Reconstruit les dépôts d'une sauvegarde mock héritée (bit 7 de `trackBits`). */
function legacyDepots(world: MockWorld): MockDepot[] {
  const depots: MockDepot[] = [];
  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      const index = tileIndex(x, y, world.width);
      if (((world.trackBits[index] ?? 0) & LEGACY_DEPOT_TRACK_BIT) === 0) continue;
      const kind =
        world.kind[index] === K.rail ? 'rail' : world.kind[index] === K.road ? 'road' : null;
      if (!kind) continue;
      depots.push({
        id: depots.length,
        company: world.owner[index] ?? COMPANY_NONE,
        kind,
        x,
        y,
        direction: 0,
        width: 1,
        height: 1,
        ...(kind === 'rail' ? { railType: 'rail' as const } : {}),
      });
      world.trackBits[index] = (world.trackBits[index] ?? 0) & ~LEGACY_DEPOT_TRACK_BIT;
    }
  }
  return depots;
}

/**
 * Réoriente les dépôts dont la porte ne donne sur aucune voie praticable
 * (sauvegardes antérieures à #233). La priorité reste est, ouest, sud, nord,
 * comme à la pose.
 */
function normaliseDepotDirections(world: MockWorld): void {
  const offsets = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  for (const depot of world.depots) {
    const kind: VehicleKind = depot.kind === 'rail' ? 'train' : 'road';
    if (depotDoorTile(world, depot, kind)) continue;
    for (const offset of offsets) {
      const x = depot.x + offset.dx;
      const y = depot.y + offset.dy;
      if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
      if (!Number.isFinite(surfaceCost(world, kind, x, y, false))) continue;
      depot.direction = directionToIndex(directionFromOffset(offset.dx, offset.dy));
      break;
    }
    const index = tileIndex(depot.x, depot.y, world.width);
    const tile = world.kind[index];
    if (tile === K.road || tile === K.rail) {
      world.trackBits[index] = depotConnections(directionFromIndex(depot.direction));
    }
  }
}

function placeOnPath(vehicle: MockVehicle, distanceAlong: number): void {
  const lengths = vehicle.pathLengths;
  const total = lengths.reduce((acc, value) => acc + value, 0);
  let remaining = total > 0 ? ((distanceAlong % total) + total) % total : 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i] ?? 0;
    const point = vehicle.path[i];
    const next = vehicle.path[(i + 1) % vehicle.path.length];
    if (remaining <= length || i === lengths.length - 1) {
      vehicle.segment = i;
      vehicle.segmentT = length > 0 ? Math.min(1, remaining / length) : 0;
      if (point) {
        vehicle.x = point.x;
        vehicle.y = point.y;
      }
      if (point && next)
        vehicle.direction = directionFromVector(next.x - point.x, next.y - point.y);
      return;
    }
    remaining -= length;
  }
}

function positionAlong(vehicle: MockVehicle): { x: number; y: number; dx: number; dy: number } {
  const count = vehicle.path.length;
  const from = vehicle.path[vehicle.segment % count];
  const to = vehicle.path[(vehicle.segment + 1) % count];
  if (!from || !to) return { x: 0, y: 0, dx: 0, dy: 0 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { x: from.x + dx * vehicle.segmentT, y: from.y + dy * vehicle.segmentT, dx, dy };
}

/**
 * Le mock n'implémente pas les bits de pente OpenTTD : `slope` porte une
 * indication de déclivité 0..4 utilisée par le rendu (roche sur les pentes).
 */
function computeSlopes(world: MockWorld): void {
  const { width, height, heightMap, slope, kind } = world;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = tileIndex(x, y, width);
      if ((kind[index] ?? 0) === K.water) continue;
      const base = heightMap[index] ?? 0;
      let steep = 0;
      if (x + 1 < width && (heightMap[index + 1] ?? base) !== base) steep += 1;
      if (x > 0 && (heightMap[index - 1] ?? base) !== base) steep += 1;
      if (y + 1 < height && (heightMap[index + width] ?? base) !== base) steep += 1;
      if (y > 0 && (heightMap[index - width] ?? base) !== base) steep += 1;
      slope[index] = steep;
    }
  }
}

function mapSnapshotView(world: MockWorld): MapSnapshot {
  return {
    width: world.width,
    height: world.height,
    kind: world.kind,
    heightMap: world.heightMap,
    owner: world.owner,
    slope: world.slope,
    flags: world.flags,
    trackBits: world.trackBits,
    railTypes: world.railTypes,
    roadData: world.roadData,
    signalData: world.signalData,
  };
}

function updateVehiclesTransforms(world: MockWorld): void {
  const map = mapSnapshotView(world);
  for (const vehicle of world.vehicles) {
    const position = positionAlong(vehicle);
    vehicle.x = position.x;
    vehicle.y = position.y;
    const moving = position.dx !== 0 || position.dy !== 0;
    // Direction exacte du segment : l'ancien lissage par tick (12/256) faisait
    // rouler les véhicules en travers des virages à 90° (#232). L'interpolation
    // de rendu lisse la rotation entre deux snapshots.
    if (moving) {
      vehicle.direction = directionFromVector(position.dx, position.dy);
    }
    const ground = sampleHeightWorld(map, vehicle.x, vehicle.y);
    if (vehicle.kind === 'aircraft') {
      vehicle.z = ground + 6.5 + Math.sin(world.tick * 0.02 + vehicle.id) * 0.4;
      vehicle.pitch = 0;
    } else if (vehicle.kind === 'ship') {
      vehicle.z = 0.12;
      vehicle.pitch = 0;
    } else {
      vehicle.z = ground + 0.08;
      const horizontal = Math.hypot(position.dx, position.dy);
      if (horizontal > 1e-6) {
        const ahead = sampleHeightWorld(map, position.x + position.dx, position.y + position.dy);
        vehicle.pitch = Math.atan2(ahead - ground, horizontal);
      } else {
        vehicle.pitch = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const UNAVAILABLE_BUILD: Partial<Record<string, string>> = {};

const BUILT_KIND: Record<'road' | 'rail', number> = { road: K.road, rail: K.rail };
const SIGNAL_TRACKS: readonly SignalTrack[] = ['x', 'y', 'upper', 'lower', 'left', 'right'];
const BRIDGE_MATERIAL_IDS = Object.keys(BRIDGE_MATERIALS) as BridgeMaterial[];

function optionText(
  options: Record<string, number | string | boolean> | undefined,
  key: string,
): string | undefined {
  const value = options?.[key];
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionInt(
  options: Record<string, number | string | boolean> | undefined,
  key: string,
  fallback: number,
): number {
  const value = options?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return fallback;
}

function optionBool(
  options: Record<string, number | string | boolean> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = options?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return fallback;
}

function stationSettingsFromCommand(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
): StationSettings {
  const options = command.options;
  const kindText = optionText(options, 'kind') ?? optionText(options, 'station') ?? 'road';
  const kind: BuildTransport =
    kindText === 'rail' || kindText === 'train' || kindText === 'ferroviaire' ? 'rail' : 'road';
  const driveThrough = optionBool(
    options,
    'drive_through',
    optionBool(options, 'driveThrough', false),
  );

  let direction = parseBuildDirection(options?.direction);
  if (!direction) {
    const axis = optionText(options, 'axis');
    if (axis === 'y') direction = 'nw';
    else if (axis === 'x') direction = 'ne';
  }
  if (!direction && command.to) {
    if (command.from.y === command.to.y) direction = 'ne';
    else if (command.from.x === command.to.x) direction = 'nw';
  }
  if (!direction && kind === 'road' && driveThrough) {
    // Gare routière en passage sur une route existante : l'axe vient des bits.
    const index = tileIndex(command.from.x, command.from.y, world.width);
    const bits = world.trackBits[index] ?? 0;
    if ((bits & (2 | 8)) !== 0) direction = 'ne';
    else if ((bits & (1 | 4)) !== 0) direction = 'nw';
  }
  direction ??= 'ne';

  let length = optionInt(options, 'length', optionInt(options, 'platform_length', 1));
  if (options?.length === undefined && command.to && kind === 'rail') {
    length = Math.abs(command.to.x - command.from.x) + Math.abs(command.to.y - command.from.y) + 1;
  }

  return {
    kind,
    platforms: optionInt(options, 'platforms', optionInt(options, 'tracks', 1)),
    length,
    direction,
    driveThrough,
  };
}

function depotSettingsFromCommand(
  command: Extract<EngineCommand, { type: 'build' }>,
): DepotSettings {
  const options = command.options;
  const kindText = optionText(options, 'kind') ?? optionText(options, 'vehicle') ?? 'road';
  const kind: BuildTransport =
    kindText === 'rail' || kindText === 'train' || kindText === 'ferroviaire' ? 'rail' : 'road';
  const direction: BuildDirection | null = parseBuildDirection(options?.direction);
  return { kind, direction };
}

/** Réseau (`rail`/`road`) commun aux ponts et tunnels. */
function structureTransportFromCommand(
  command: Extract<EngineCommand, { type: 'build' }>,
): BuildTransport {
  const options = command.options;
  const kindText =
    optionText(options, 'kind') ??
    optionText(options, 'transport') ??
    optionText(options, 'vehicle') ??
    'rail';
  return kindText === 'road' || kindText === 'route' || kindText === 'routier' ? 'road' : 'rail';
}

/** Famille de pont demandée ; `null` si le libellé est inconnu. */
function bridgeMaterialFromCommand(
  command: Extract<EngineCommand, { type: 'build' }>,
): BridgeMaterial | null {
  const options = command.options;
  const raw = optionText(options, 'material') ?? optionText(options, 'bridge_material');
  if (!raw) return 'wood';
  if ((BRIDGE_MATERIAL_IDS as string[]).includes(raw)) return raw as BridgeMaterial;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    // Indices alignés sur `BRIDGE_MATERIAL_ORDER`.
    return BRIDGE_MATERIAL_IDS[Math.floor(numeric) % BRIDGE_MATERIAL_IDS.length] ?? 'wood';
  }
  return null;
}

function signalSettingsFromCommand(command: Extract<EngineCommand, { type: 'build' }>): {
  settings: SignalSettings;
  error: string | null;
} {
  const options = command.options;
  const typeText = optionText(options, 'type') ?? optionText(options, 'kind') ?? 'block';
  const type = parseSignalKind(typeText);
  if (!type) {
    return {
      settings: { type: 'block', track: null, direction: 'one-way', spacing: 1 },
      error: '« options.type » inconnu (block, path, entry, exit, combo).',
    };
  }
  const rawTrack = optionText(options, 'track');
  if (rawTrack && !SIGNAL_TRACKS.includes(rawTrack as SignalTrack)) {
    return {
      settings: { type, track: null, direction: 'one-way', spacing: 1 },
      error: '« options.track » inconnu (x, y, upper, lower, left, right).',
    };
  }
  const directionText = optionText(options, 'direction');
  const direction: SignalDirection = parseSignalDirection(directionText) ?? 'both';
  const spacing = Math.max(1, Math.min(8, optionInt(options, 'spacing', 1)));
  return {
    settings: {
      type,
      track: (rawTrack as SignalTrack | undefined) ?? null,
      direction,
      spacing,
    },
    error: null,
  };
}

function terraformSettingsFromCommand(
  command: Extract<EngineCommand, { type: 'build' }>,
): TerraformSettings {
  const direction =
    optionText(command.options, 'direction') === 'down' ||
    optionText(command.options, 'mode') === 'down' ||
    optionBool(command.options, 'down', false)
      ? 'down'
      : 'up';
  return {
    direction,
    size: optionInt(command.options, 'size', 1),
  };
}

function treeSettingsFromCommand(command: Extract<EngineCommand, { type: 'build' }>): TreeSettings {
  return { size: optionInt(command.options, 'size', 1) };
}

function lockSettingsFromCommand(command: Extract<EngineCommand, { type: 'build' }>): LockSettings {
  return { direction: parseBuildDirection(command.options?.direction) };
}

function railTypeFromCommand(
  command: Extract<EngineCommand, { type: 'build' }>,
  fallback: RailType = 'rail',
): RailType {
  return (
    parseRailType(command.options?.railType) ??
    parseRailType(command.options?.type) ??
    parseRailType(command.options?.rail) ??
    fallback
  );
}

/** Sens unique demandé par une commande route (#231). */
function roadOneWayFromCommand(command: Extract<EngineCommand, { type: 'build' }>): {
  oneWay: RoadOneWay | null;
  error: string | null;
} {
  const options = command.options;
  const raw =
    optionText(options, 'one_way') ??
    optionText(options, 'oneway') ??
    optionText(options, 'road_direction') ??
    optionText(options, 'sense');
  if (!raw || raw === 'both' || raw === 'two-way' || raw === 'twoway' || raw === 'bidirectional') {
    return { oneWay: null, error: null };
  }
  const named = ROAD_ONEWAY_DIRECTIONS.find((direction) => direction === raw);
  if (named) return { oneWay: named, error: null };
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return { oneWay: roadOneWayFromIndex(Math.trunc(numeric)), error: null };
  }
  return {
    oneWay: null,
    error: '« options.one_way » inconnu (north, east, south, west, both).',
  };
}

function nearestTownName(world: MockWorld, x: number, y: number): string {
  let best: MockTown | null = null;
  let bestDistance = Infinity;
  for (const town of world.towns) {
    const dx = town.x - x;
    const dy = town.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = town;
    }
  }
  return best?.name ?? `secteur ${x},${y}`;
}

function completeBuild(
  world: MockWorld,
  company: MockCompany,
  cost: number,
  message: string,
): void {
  company.money -= Math.round(cost * priceFactor(world));
  world.mapDirty = true;
  world.mapVersion += 1;
  addNews(world, 'info', message);
}

function applyStation(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const settings = stationSettingsFromCommand(world, command);
  const plan = planStation({
    map: mapSnapshotView(world),
    from: command.from,
    settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Construction impossible : ${plan.reason ?? 'gare refusée.'}`);
    return;
  }
  for (const tile of plan.tiles) {
    world.kind[tile.index] = K.station;
    world.owner[tile.index] = command.company;
    world.trackBits[tile.index] = tile.connections;
    world.flags[tile.index] = 0;
    writeSignalData(world, tile.index, 0);
  }
  // `planStation` a pu aligner un arrêt en passage sur la chaussée : c'est
  // cette orientation résolue qui doit figurer dans le snapshot, pas celle,
  // éventuellement perpendiculaire, envoyée par le client.
  const resolved = plan.station ?? settings;
  const footprint = stationFootprint(resolved);
  const id = world.stations.length;
  const town = nearestTownName(world, plan.from.x, plan.from.y);
  const baseName = resolved.kind === 'rail' ? `Gare de ${town}` : `Arrêt de ${town}`;
  let name = baseName;
  let suffix = 2;
  while (world.stations.some((station) => station.name === name)) {
    name = `${baseName} (${suffix})`;
    suffix += 1;
  }
  world.stations.push({
    id,
    company: command.company,
    name,
    kind: resolved.kind === 'rail' ? 'train' : 'road',
    x: plan.from.x + footprint.width / 2,
    y: plan.from.y + footprint.height / 2,
    width: footprint.width,
    height: footprint.height,
    waiting: [],
    ...(resolved.kind === 'road'
      ? {
          driveThrough: resolved.driveThrough,
          ...(resolved.driveThrough ? { roadAxis: directionAxis(resolved.direction) } : {}),
        }
      : {}),
  });
  const message =
    resolved.kind === 'rail'
      ? `Gare ferroviaire construite (${resolved.platforms} voie(s) × ${resolved.length} tuile(s)).`
      : resolved.driveThrough
        ? 'Gare routière en passage construite.'
        : 'Gare routière construite.';
  completeBuild(world, company, plan.cost, message);
}

function applyDepot(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const settings = depotSettingsFromCommand(command);
  const railType = settings.kind === 'rail' ? railTypeFromCommand(command) : 'rail';
  const plan = planDepot({
    map: mapSnapshotView(world),
    from: command.from,
    settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Construction impossible : ${plan.reason ?? 'dépôt refusé.'}`);
    return;
  }
  for (const tile of plan.tiles) {
    world.kind[tile.index] = settings.kind === 'rail' ? K.rail : K.road;
    world.owner[tile.index] = command.company;
    world.trackBits[tile.index] = tile.connections;
    writeSignalData(world, tile.index, 0);
    if (settings.kind === 'rail') {
      world.railTypes[tile.index] = RAIL_TYPE_INDEX[railType];
      world.flags[tile.index] = railType === 'electrified' ? TILE_FLAG.ELECTRIFIED : 0;
    }
  }
  const depot = plan.tiles[0];
  if (depot) {
    const x = depot.index % world.width;
    const y = Math.floor(depot.index / world.width);
    world.depots.push({
      id: nextDepotId(world),
      company: command.company,
      kind: settings.kind,
      x,
      y,
      direction: directionToIndex(plan.depot?.direction ?? settings.direction ?? 'se'),
      width: 1,
      height: 1,
      ...(settings.kind === 'rail' ? { railType } : {}),
    });
  }
  completeBuild(
    world,
    company,
    plan.cost,
    settings.kind === 'rail' ? 'Dépôt ferroviaire construit.' : 'Dépôt routier construit.',
  );
}

function applySignal(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const parsed = signalSettingsFromCommand(command);
  if (parsed.error) {
    addNews(world, 'error', parsed.error);
    return;
  }
  const plan = planSignal({
    map: mapSnapshotView(world),
    from: command.from,
    ...(command.to ? { to: command.to } : {}),
    settings: parsed.settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Construction impossible : ${plan.reason ?? 'signal refusé.'}`);
    return;
  }
  let converted = 0;
  for (const tile of plan.tiles) {
    const previous = world.signalData[tile.index] ?? 0;
    if (previous !== 0) converted += 1;
    const bits = encodeSignalBits({
      kind: parsed.settings.type,
      direction: parsed.settings.direction,
      aspect: previous !== 0 ? (decodeSignalBits(previous)?.aspect ?? 'green') : 'green',
      semaphore: previous !== 0 ? (decodeSignalBits(previous)?.semaphore ?? false) : false,
    });
    writeSignalData(world, tile.index, bits);
    world.flags[tile.index] = (world.flags[tile.index] ?? 0) | TILE_FLAG.SIGNAL;
  }
  const localLabel =
    parsed.settings.type === 'block'
      ? 'de bloc'
      : `de type ${SIGNAL_KIND_LABELS[parsed.settings.type].toLowerCase()}`;
  const message =
    converted > 0
      ? `${plan.tiles.length} signal(aux) ${localLabel} posé(s), ${converted} converti(s).`
      : `${plan.tiles.length} signal(aux) ${localLabel} construit(s).`;
  completeBuild(world, company, plan.cost, message);
}

function applyUnsignal(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const settings: SignalSettings = {
    type: 'block',
    track: null,
    direction: 'one-way',
    spacing: 1,
  };
  const plan = planRemoveSignal({
    map: mapSnapshotView(world),
    from: command.from,
    ...(command.to ? { to: command.to } : {}),
    settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Démolition impossible : ${plan.reason ?? 'signal refusé.'}`);
    return;
  }
  for (const tile of plan.tiles) {
    writeSignalData(world, tile.index, 0);
    world.flags[tile.index] = (world.flags[tile.index] ?? 0) & ~TILE_FLAG.SIGNAL;
  }
  completeBuild(world, company, plan.cost, `${plan.tiles.length} signal(aux) retiré(s).`);
}

function applyConvertRail(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const target = railTypeFromCommand(command);
  const plan = planConvertRail({
    map: mapSnapshotView(world),
    from: command.from,
    ...(command.to ? { to: command.to } : {}),
    railType: target,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Conversion impossible : ${plan.reason ?? 'type de rail refusé.'}`);
    return;
  }
  for (const tile of plan.tiles) {
    world.railTypes[tile.index] = RAIL_TYPE_INDEX[target];
    if (target === 'electrified') {
      world.flags[tile.index] = (world.flags[tile.index] ?? 0) | TILE_FLAG.ELECTRIFIED;
    } else {
      world.flags[tile.index] = (world.flags[tile.index] ?? 0) & ~TILE_FLAG.ELECTRIFIED;
    }
  }
  completeBuild(
    world,
    company,
    plan.cost,
    `${plan.tiles.length} tuile(s) convertie(s) en ${RAIL_TYPE_LABELS[target]}.`,
  );
}

function applyTerraform(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
  settings: TerraformSettings,
): void {
  const plan = planTerraform({
    map: mapSnapshotView(world),
    from: command.from,
    ...(command.to ? { to: command.to } : {}),
    settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Terrassement impossible : ${plan.reason ?? 'terrain refusé.'}`);
    return;
  }
  const delta = settings.direction === 'down' ? -1 : 1;
  for (const tile of plan.tiles) {
    const height = Math.max(0, Math.min(15, (world.heightMap[tile.index] ?? 0) + delta));
    world.heightMap[tile.index] = height;
    if (world.kind[tile.index] === K.trees) world.kind[tile.index] = K.grass;
    world.trackBits[tile.index] = 0;
  }
  computeSlopes(world);
  updateVehiclesTransforms(world);
  completeBuild(
    world,
    company,
    plan.cost,
    `Terrassement : ${plan.tiles.length} tuile(s) ${delta > 0 ? 'surélevée(s)' : 'abaissée(s)'}.`,
  );
}

function applyTrees(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
  settings: TreeSettings,
): void {
  const plan = planTree({
    map: mapSnapshotView(world),
    from: command.from,
    ...(command.to ? { to: command.to } : {}),
    settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Plantation impossible : ${plan.reason ?? 'terrain refusé.'}`);
    return;
  }
  for (const tile of plan.tiles) {
    world.kind[tile.index] = K.trees;
    world.owner[tile.index] = command.company;
    world.trackBits[tile.index] = 0;
    world.flags[tile.index] = 0;
  }
  completeBuild(world, company, plan.cost, `${plan.tiles.length} tuile(s) plantée(s) en arbres.`);
}

function applyCanal(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const axis = command.options?.axis === 'y' ? 'y' : 'x';
  const plan = planCanal({
    map: mapSnapshotView(world),
    from: command.from,
    ...(command.to ? { to: command.to } : {}),
    axis,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Canal impossible : ${plan.reason ?? 'tracé refusé.'}`);
    return;
  }
  const level = Math.max(0, Math.min(15, plan.waterLevel ?? 0));
  for (const tile of plan.tiles) {
    world.kind[tile.index] = K.canal;
    world.heightMap[tile.index] = level;
    world.owner[tile.index] = command.company;
    world.flags[tile.index] = TILE_FLAG.WATER;
    world.trackBits[tile.index] = tile.connections;
  }
  // Un canal qui rejoint une nappe existante ne doit pas créer de marche :
  // toutes les tuiles 4-connexes hors écluse partagent le même niveau.
  normalizeWaterLevels(world);
  computeSlopes(world);
  updateVehiclesTransforms(world);
  completeBuild(
    world,
    company,
    plan.cost,
    `Canal : ${plan.tiles.length} tuile(s) pour ${Math.round(plan.cost)} £.`,
  );
}

function applyLock(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
  settings: LockSettings,
): void {
  const plan = planLock({
    map: mapSnapshotView(world),
    from: command.from,
    settings,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Écluse impossible : ${plan.reason ?? 'tuile refusée.'}`);
    return;
  }
  const tile = plan.tiles[0];
  if (!tile) return;
  world.kind[tile.index] = K.lock;
  world.heightMap[tile.index] = Math.max(0, Math.min(15, plan.lock?.upper ?? tile.height));
  world.owner[tile.index] = command.company;
  world.flags[tile.index] = TILE_FLAG.WATER;
  world.trackBits[tile.index] = tile.connections;
  // L'écluse est une barrière : chaque bief de part et d'autre garde son
  // niveau, mais les tuiles d'un même bief restent alignées.
  normalizeWaterLevels(world);
  computeSlopes(world);
  updateVehiclesTransforms(world);
  completeBuild(world, company, plan.cost, `Écluse construite pour ${Math.round(plan.cost)} £.`);
}

function applyAqueduct(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  if (!command.to) {
    addNews(world, 'error', 'Aqueduc impossible : indiquez la tuile d’arrivée.');
    return;
  }
  const plan = planAqueduct({
    map: mapSnapshotView(world),
    from: command.from,
    to: command.to,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Aqueduc impossible : ${plan.reason ?? 'tracé refusé.'}`);
    return;
  }
  const level = Math.max(0, Math.min(15, plan.aqueduct?.level ?? plan.waterLevel ?? 0));
  const last = plan.tiles.length - 1;
  for (let i = 0; i < plan.tiles.length; i += 1) {
    const tile = plan.tiles[i];
    if (!tile) continue;
    if (i === 0 || i === last) {
      world.kind[tile.index] = K.canal;
      world.heightMap[tile.index] = level;
      world.flags[tile.index] = TILE_FLAG.WATER;
    } else {
      world.kind[tile.index] = K.aqueduct;
      world.flags[tile.index] = TILE_FLAG.WATER | TILE_FLAG.BRIDGE;
      world.trackBits[tile.index] = level;
    }
    world.owner[tile.index] = command.company;
  }
  normalizeWaterLevels(world);
  computeSlopes(world);
  updateVehiclesTransforms(world);
  completeBuild(
    world,
    company,
    plan.cost,
    `Aqueduc : ${plan.tiles.length} tuiles pour ${Math.round(plan.cost)} £.`,
  );
}

function applyCrossing(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  const plan = planCrossing({
    map: mapSnapshotView(world),
    from: command.from,
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid) {
    addNews(world, 'error', `Passage à niveau impossible : ${plan.reason ?? 'voie refusée.'}`);
    return;
  }
  const tile = plan.tiles[0];
  if (!tile) return;
  const rail = plan.crossing?.network === 'rail';
  world.kind[tile.index] = K.crossing;
  world.trackBits[tile.index] = (tile.connections & 0x0f) | (rail ? TRACK_BIT_CROSSING_RAIL : 0);
  world.owner[tile.index] = command.company;
  world.flags[tile.index] = 0;
  writeRoadData(world, tile.index, 0);
  completeBuild(
    world,
    company,
    plan.cost,
    `Passage à niveau construit pour ${Math.round(plan.cost)} £.`,
  );
}

/** Prochain id d'ouvrage : monotone, jamais réutilisé après démolition. */
function nextStructureId(world: MockWorld): number {
  let next = 0;
  for (const structure of world.structures) next = Math.max(next, structure.id + 1);
  return next;
}

/** Ouvrage dont l'emprise contient la tuile, ou `null`. */
function structureAtTile(world: MockWorld, index: number): MockStructure | null {
  for (const structure of world.structures) {
    if (structure.underlay.some((entry) => entry.index === index)) return structure;
  }
  return null;
}

/** Restaure les tuiles d'origine et retire l'ouvrage (démolition). */
function removeStructure(world: MockWorld, structure: MockStructure): void {
  for (const entry of structure.underlay) {
    world.kind[entry.index] = entry.kind;
    world.owner[entry.index] = entry.owner;
    world.flags[entry.index] = entry.flags;
    world.trackBits[entry.index] = entry.trackBits;
  }
  world.structures = world.structures.filter((item) => item !== structure);
}

function captureUnderlay(
  world: MockWorld,
  tiles: readonly { index: number }[],
): MockStructure['underlay'] {
  return tiles.map((tile) => ({
    index: tile.index,
    kind: world.kind[tile.index] ?? K.grass,
    owner: world.owner[tile.index] ?? COMPANY_NONE,
    flags: world.flags[tile.index] ?? 0,
    trackBits: world.trackBits[tile.index] ?? 0,
  }));
}

/** Construit un pont rectiligne (#154). */
function applyBridge(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  if (!command.to) {
    addNews(
      world,
      'error',
      'Construction impossible : un pont exige deux culées (« from » et « to »).',
    );
    return;
  }
  const material = bridgeMaterialFromCommand(command);
  if (!material) {
    addNews(world, 'error', 'Construction impossible : matériau de pont inconnu.');
    return;
  }
  const kind = structureTransportFromCommand(command);
  const plan = planBridge({
    map: mapSnapshotView(world),
    from: command.from,
    to: command.to,
    settings: { kind, material },
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid || !plan.bridge) {
    addNews(world, 'error', `Construction impossible : ${plan.reason ?? 'pont refusé.'}`);
    return;
  }

  const underlay = captureUnderlay(world, plan.tiles);
  for (let i = 0; i < plan.tiles.length; i += 1) {
    const tile = plan.tiles[i];
    if (!tile) continue;
    const end = i === 0 || i === plan.tiles.length - 1;
    if (end) {
      world.kind[tile.index] = K.bridge;
      world.owner[tile.index] = command.company;
      world.trackBits[tile.index] = 0;
      world.flags[tile.index] = TILE_FLAG.BRIDGE;
    } else {
      // Le tablier survole le terrain : on conserve l'eau, l'herbe ou la voie
      // en dessous et on ne pose que le drapeau BRIDGE, comme OpenTTD.
      world.flags[tile.index] = (world.flags[tile.index] ?? 0) | TILE_FLAG.BRIDGE;
    }
  }
  world.structures.push({
    id: nextStructureId(world),
    type: 'bridge',
    company: command.company,
    transport: kind,
    material,
    from: { ...plan.from },
    to: { ...plan.to },
    length: plan.bridge.length,
    deckHeight: plan.bridge.deckHeight,
    maintenancePerYear: plan.bridge.maintenance,
    underlay,
  });
  completeBuild(
    world,
    company,
    plan.cost,
    `Pont en ${BRIDGE_MATERIAL_LABELS[material]} construit (${plan.bridge.length} tuiles, portée ${plan.bridge.span}) pour ${Math.round(plan.cost)} £.`,
  );
}

/** Construit un tunnel rectiligne (#155). */
function applyTunnel(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'build' }>,
  company: MockCompany,
): void {
  if (!command.to) {
    addNews(
      world,
      'error',
      'Construction impossible : un tunnel exige deux portails (« from » et « to »).',
    );
    return;
  }
  const kind = structureTransportFromCommand(command);
  const plan = planTunnel({
    map: mapSnapshotView(world),
    from: command.from,
    to: command.to,
    settings: { kind },
    company: command.company,
    budget: company.money,
  });
  if (!plan.valid || !plan.tunnel) {
    addNews(world, 'error', `Construction impossible : ${plan.reason ?? 'tunnel refusé.'}`);
    return;
  }

  const underlay = captureUnderlay(world, plan.tiles);
  for (let i = 0; i < plan.tiles.length; i += 1) {
    const tile = plan.tiles[i];
    if (!tile) continue;
    const end = i === 0 || i === plan.tiles.length - 1;
    if (end) {
      world.kind[tile.index] = K.tunnel;
      world.owner[tile.index] = command.company;
      world.trackBits[tile.index] = 0;
      world.flags[tile.index] = TILE_FLAG.TUNNEL;
    } else {
      world.flags[tile.index] = (world.flags[tile.index] ?? 0) | TILE_FLAG.TUNNEL;
    }
  }
  const portalHeight = plan.tunnel.portalHeight;
  world.structures.push({
    id: nextStructureId(world),
    type: 'tunnel',
    company: command.company,
    transport: kind,
    from: { ...plan.from },
    to: { ...plan.to },
    length: plan.tunnel.length,
    portalHeight,
    maintenancePerYear: plan.tunnel.maintenance,
    underlay,
  });
  completeBuild(
    world,
    company,
    plan.cost,
    `Tunnel ${kind === 'rail' ? 'ferroviaire' : 'routier'} construit (${plan.tunnel.length} tuiles, profondeur ${plan.tunnel.depth}) pour ${Math.round(plan.cost)} £.`,
  );
}

/**
 * Applique une commande de construction. Le mock rejoue les règles partagées
 * (`buildRules.ts`) avant de toucher la carte : une commande invalide ne change
 * ni les tableaux, ni la trésorerie, et publie une news d'erreur que le HUD
 * affiche telle quelle.
 */
function applyBuild(world: MockWorld, command: Extract<EngineCommand, { type: 'build' }>): void {
  const company = world.companies[command.company];
  if (!company) {
    addNews(world, 'error', `Construction refusée : entreprise #${command.company} inconnue.`);
    return;
  }
  if (company.bankrupt) {
    addNews(world, 'error', 'Construction refusée : votre entreprise est en faillite.');
    return;
  }

  if (command.tool === 'station') {
    applyStation(world, command, company);
    return;
  }
  if (command.tool === 'depot') {
    applyDepot(world, command, company);
    return;
  }
  if (command.tool === 'signal') {
    applySignal(world, command, company);
    return;
  }
  if (command.tool === 'unsignal') {
    applyUnsignal(world, command, company);
    return;
  }
  if (command.tool === 'convert') {
    applyConvertRail(world, command, company);
    return;
  }
  if (command.tool === 'terraform') {
    applyTerraform(world, command, company, terraformSettingsFromCommand(command));
    return;
  }
  if (command.tool === 'tree') {
    applyTrees(world, command, company, treeSettingsFromCommand(command));
    return;
  }
  if (command.tool === 'canal') {
    applyCanal(world, command, company);
    return;
  }
  if (command.tool === 'lock') {
    applyLock(world, command, company, lockSettingsFromCommand(command));
    return;
  }
  if (command.tool === 'aqueduct') {
    applyAqueduct(world, command, company);
    return;
  }
  if (command.tool === 'crossing') {
    applyCrossing(world, command, company);
    return;
  }
  if (command.tool === 'bridge') {
    applyBridge(world, command, company);
    return;
  }
  if (command.tool === 'tunnel') {
    applyTunnel(world, command, company);
    return;
  }
  if (command.tool !== 'road' && command.tool !== 'rail' && command.tool !== 'clear') {
    addNews(
      world,
      'error',
      UNAVAILABLE_BUILD[command.tool] ?? `Outil de construction « ${command.tool} » indisponible.`,
    );
    return;
  }

  const tool = command.tool;
  const axis = command.options?.axis === 'y' ? 'y' : 'x';
  let roadDirection: RoadDirection = 'both';
  if (tool === 'road') {
    const parsed = roadOneWayFromCommand(command);
    if (parsed.error) {
      addNews(world, 'error', `Construction impossible : ${parsed.error}`);
      return;
    }
    roadDirection = parsed.oneWay ?? 'both';
  }
  const plan = planBuild({
    map: mapSnapshotView(world),
    tool,
    from: command.from,
    to: command.to,
    axis,
    company: command.company,
    budget: company.money,
    ...(tool === 'rail' ? { railType: railTypeFromCommand(command) } : {}),
    ...(tool === 'road' ? { roadDirection } : {}),
  });

  if (!plan.valid) {
    addNews(world, 'error', `Construction impossible : ${plan.reason ?? 'tracé refusé.'}`);
    return;
  }

  if (tool === 'clear') {
    const handled = new Set<number>();
    for (const tile of plan.tiles) {
      if (handled.has(tile.index)) continue;
      const structure = structureAtTile(world, tile.index);
      if (structure) {
        for (const entry of structure.underlay) handled.add(entry.index);
        removeStructure(world, structure);
        continue;
      }
      const wasBridge = ((world.flags[tile.index] ?? 0) & TILE_FLAG.BRIDGE) !== 0;
      const current = world.kind[tile.index] ?? K.grass;
      const bits = world.trackBits[tile.index] ?? 0;
      if (current === K.crossing) {
        // Un passage à niveau rend la voie d'origine (route ou rail).
        world.kind[tile.index] = (bits & TRACK_BIT_CROSSING_RAIL) !== 0 ? K.rail : K.road;
        world.trackBits[tile.index] = bits & 0x0f;
      } else if (current === K.aqueduct) {
        // Le tablier disparaît : le val reste sec sous l'ouvrage.
        world.kind[tile.index] = K.grass;
        world.trackBits[tile.index] = 0;
        world.owner[tile.index] = COMPANY_NONE;
        world.flags[tile.index] = 0;
      } else {
        // Un pont démoli laisse apparaître l'eau qu'il franchissait ; un
        // tunnel rend simplement l'herbe (les ouvrages récents ont leur
        // propre `underlay` traité ci-dessus).
        world.kind[tile.index] = wasBridge ? K.water : K.grass;
        world.trackBits[tile.index] = 0;
        world.owner[tile.index] = COMPANY_NONE;
        world.flags[tile.index] = wasBridge ? TILE_FLAG.WATER : 0;
      }
      world.railTypes[tile.index] = 0;
      writeRoadData(world, tile.index, 0);
      writeSignalData(world, tile.index, 0);
      const x = tile.index % world.width;
      const y = Math.floor(tile.index / world.width);
      world.depots = world.depots.filter(
        (depot) =>
          x < depot.x || x >= depot.x + depot.width || y < depot.y || y >= depot.y + depot.height,
      );
    }
    company.money -= plan.cost;
    world.mapDirty = true;
    world.mapVersion += 1;
    addNews(
      world,
      'info',
      `${BUILD_TOOL_LABELS.clear} : ${plan.tiles.length} tuile${plan.tiles.length > 1 ? 's' : ''} pour ${Math.round(plan.cost)} £.`,
    );
    return;
  }

  // Conversion d'un tronçon existant au sens unique : aucun terrassement,
  // seule la couche `roadData` change (#231).
  if (tool === 'road' && plan.road?.convert) {
    const oneWay = plan.road.oneWay ?? null;
    for (const tile of plan.tiles) {
      writeRoadData(world, tile.index, oneWay ? ROAD_ONEWAY_INDEX[oneWay] : 0);
    }
    company.money -= Math.round(plan.cost * priceFactor(world));
    world.mapDirty = true;
    world.mapVersion += 1;
    addNews(
      world,
      'info',
      `${oneWay ? 'Sens unique' : 'Double sens'} : ${plan.tiles.length} tuile${plan.tiles.length > 1 ? 's' : ''} pour ${Math.round(plan.cost)} £.`,
    );
    return;
  }

  for (const tile of plan.tiles) {
    world.kind[tile.index] = BUILT_KIND[tool];
    world.owner[tile.index] = command.company;
    world.trackBits[tile.index] = tile.connections;
    world.flags[tile.index] = 0;
    if (tool === 'rail') {
      const type = plan.railType ?? 'rail';
      world.railTypes[tile.index] = RAIL_TYPE_INDEX[type];
      if (type === 'electrified') {
        world.flags[tile.index] = TILE_FLAG.ELECTRIFIED;
      }
      writeRoadData(world, tile.index, 0);
    } else {
      world.railTypes[tile.index] = 0;
      const oneWay = plan.road?.oneWay ?? null;
      writeRoadData(world, tile.index, oneWay ? ROAD_ONEWAY_INDEX[oneWay] : 0);
    }
    writeSignalData(world, tile.index, 0);
  }

  company.money -= Math.round(plan.cost * priceFactor(world));
  world.mapDirty = true;
  world.mapVersion += 1;

  const label = BUILD_TOOL_LABELS[tool];
  const tiles = plan.tiles.length;
  addNews(
    world,
    'info',
    `${label} : ${tiles} tuile${tiles > 1 ? 's' : ''} pour ${Math.round(plan.cost)} £.`,
  );
}

// ---------------------------------------------------------------------------
// Véhicules
// ---------------------------------------------------------------------------

function nextVehicleId(world: MockWorld): number {
  let next = 0;
  for (const vehicle of world.vehicles) next = Math.max(next, vehicle.id + 1);
  return next;
}

/** Prochain id de dépôt : monotone, jamais réutilisé après démolition. */
function nextDepotId(world: MockWorld): number {
  let next = 0;
  for (const depot of world.depots) next = Math.max(next, depot.id + 1);
  return next;
}

/** Dépôt dont l'emprise contient la tuile, ou `null`. */
function depotAtTile(world: MockWorld, x: number, y: number): MockDepot | null {
  for (const depot of world.depots) {
    if (x >= depot.x && x < depot.x + depot.width && y >= depot.y && y < depot.y + depot.height) {
      return depot;
    }
  }
  return null;
}

function syncVehicleCounts(world: MockWorld): void {
  for (const company of world.companies) {
    company.vehicleCount = world.vehicles.filter(
      (vehicle) => vehicle.company === company.id,
    ).length;
  }
}

/** Valeur de reprise d'un véhicule : moitié du prix catalogue indexé. */
function vehicleRefund(world: MockWorld, vehicle: MockVehicle): number {
  const model = vehicleModel(vehicle.model);
  if (model) return Math.round(model.cost * 0.5 * priceFactor(world));
  return Math.round(Math.max(4_000, vehicle.cargoCapacity * 150) * priceFactor(world));
}

function findVehicle(world: MockWorld, id: number | undefined): MockVehicle | null {
  if (id === undefined || !Number.isFinite(id)) return null;
  return world.vehicles.find((vehicle) => vehicle.id === id) ?? null;
}

function buyVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const model = vehicleModel(command.model);
  if (!model) {
    addNews(world, 'error', `Modèle « ${command.model ?? '?'} » inconnu au catalogue.`);
    return;
  }

  let depot: MockDepot | null;
  if (command.depotId !== undefined) {
    if (!Number.isFinite(command.depotId)) {
      addNews(world, 'error', 'Achat refusé : « depotId » doit être un entier.');
      return;
    }
    depot = world.depots.find((item) => item.id === Math.trunc(command.depotId!)) ?? null;
    if (!depot) {
      addNews(world, 'error', `Achat refusé : dépôt #${command.depotId} inexistant.`);
      return;
    }
  } else if (command.depot) {
    const x = Math.round(command.depot.x);
    const y = Math.round(command.depot.y);
    depot = depotAtTile(world, x, y);
    if (!depot) {
      addNews(world, 'error', 'Achat refusé : la tuile ciblée n’est pas un dépôt.');
      return;
    }
  } else {
    addNews(world, 'error', 'Achat refusé : indiquez un « depotId » ou une tuile de dépôt.');
    return;
  }

  if (depot.kind !== model.depot) {
    addNews(
      world,
      'error',
      `Achat refusé : ${model.name} exige un dépôt ${model.depot === 'rail' ? 'ferroviaire' : 'routier'}.`,
    );
    return;
  }
  if (depot.company !== company.id) {
    addNews(world, 'error', 'Achat refusé : ce dépôt appartient à une autre entreprise.');
    return;
  }
  const cost = Math.round(model.cost * priceFactor(world));
  if (!modelCompatibleWithRail(model, depot.railType)) {
    addNews(
      world,
      'error',
      `Achat refusé : ${model.name} n’est pas compatible avec un ${RAIL_TYPE_LABELS[depot.railType ?? 'rail']}.`,
    );
    return;
  }
  if (company.money < cost) {
    addNews(
      world,
      'error',
      `Trésorerie insuffisante : ${Math.round(cost)} £ requis pour ${model.name}.`,
    );
    return;
  }

  const centre = { x: depot.x + depot.width / 2, y: depot.y + depot.height / 2 };
  const vehicle: MockVehicle = {
    id: nextVehicleId(world),
    kind: model.kind,
    company: company.id,
    model: model.id,
    homeDepot: { x: depot.x, y: depot.y },
    path: [{ ...centre }],
    pathLengths: [0],
    segment: 0,
    segmentT: 0,
    segmentStops: [null],
    currentOrder: 0,
    routeOrders: [],
    speed: model.speed,
    direction: depotDirection(depot.direction),
    pitch: 0,
    status: 3,
    waitTicks: 0,
    x: centre.x,
    y: centre.y,
    z: 0,
    cargoType: model.cargo,
    cargoClass: model.cargo,
    cargoAmount: 0,
    cargoCapacity: model.capacity,
    cargoSource: null,
    tripDistance: 0,
    loadedTick: 0,
    orderTargets: [],
    orders: [],
    profitLastYear: 0,
    ageDays: 0,
    groupId: null,
    reliability: {
      ...initialReliability(model.depot === 'rail' ? 150 : 110),
      lastServiceTick: world.tick,
    },
  };
  world.vehicles.push(vehicle);
  company.money -= cost;
  syncVehicleCounts(world);
  updateVehiclesTransforms(world);
  addNews(
    world,
    'info',
    `${model.name} acheté (#${vehicle.id}) pour ${Math.round(cost)} £ dans le dépôt ${depot.id} (${depot.x}, ${depot.y}).`,
  );
}

function sellVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Vente refusée : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Vente refusée : ce véhicule appartient à une autre entreprise.');
    return;
  }
  const refund = vehicleRefund(world, vehicle);
  world.vehicles = world.vehicles.filter((item) => item.id !== vehicle.id);
  company.money += refund;
  syncVehicleCounts(world);
  addNews(world, 'info', `Véhicule #${vehicle.id} vendu pour ${Math.round(refund)} £.`);
}

function startVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Démarrage refusé : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Démarrage refusé : ce véhicule ne vous appartient pas.');
    return;
  }
  if (vehicle.orders.length === 0) {
    addNews(
      world,
      'error',
      `Véhicule #${vehicle.id} : ajoutez au moins une gare ou un dépôt à sa tournée avant de le démarrer.`,
    );
    return;
  }
  if (rebuildRoute(world, vehicle)) {
    addNews(
      world,
      'info',
      `Véhicule #${vehicle.id} démarré : ${vehicle.orders.length} ordre(s) au programme.`,
    );
  }
}

function stopVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Arrêt refusé : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Arrêt refusé : ce véhicule ne vous appartient pas.');
    return;
  }
  vehicle.status = 0;
  vehicle.waitTicks = 0;
  addNews(world, 'info', `Véhicule #${vehicle.id} arrêté.`);
}

/** Entretien explicite d'un véhicule déjà au dépôt (#163). */
function serviceVehicleCommand(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Entretien refusé : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Entretien refusé : ce véhicule ne vous appartient pas.');
    return;
  }
  if (vehicle.status !== 3 && !sendVehicleToDepot(world, vehicle)) return;
  serviceVehicle(world, vehicle, company);
  updateVehiclesTransforms(world);
}

/** Envoi au dépôt sans entretien immédiat (#163). */
function sendToDepotCommand(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Dépôt refusé : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Dépôt refusé : ce véhicule ne vous appartient pas.');
    return;
  }
  if (sendVehicleToDepot(world, vehicle)) updateVehiclesTransforms(world);
}

// ---------------------------------------------------------------------------
// Groupes de véhicules et actions groupées (#164)
// ---------------------------------------------------------------------------

function nextGroupId(world: MockWorld): number {
  let next = 0;
  for (const group of world.groups) next = Math.max(next, group.id + 1);
  return next;
}

function groupById(world: MockWorld, id: number | undefined): MockGroup | null {
  if (id === undefined || !Number.isFinite(id)) return null;
  return world.groups.find((group) => group.id === Math.trunc(id)) ?? null;
}

function groupVehicleIds(world: MockWorld, group: MockGroup): number[] {
  return world.vehicles
    .filter((vehicle) => vehicle.company === group.company && vehicle.groupId === group.id)
    .map((vehicle) => vehicle.id);
}

/** Applique une commande de groupe ; les actions groupées réutilisent les règles véhicule. */
function applyGroup(world: MockWorld, command: Extract<EngineCommand, { type: 'group' }>): void {
  const company = world.companies[command.company];
  if (!company) {
    addNews(world, 'error', `Groupes : entreprise #${command.company} inconnue.`);
    return;
  }
  if (company.bankrupt) {
    addNews(world, 'error', 'Groupes : votre entreprise est en faillite.');
    return;
  }
  const group = groupById(world, command.group);

  switch (command.action) {
    case 'create': {
      const kind = command.kind ?? 'road';
      const owned = world.groups.filter((item) => item.company === company.id).length;
      if (owned >= MAX_GROUPS) {
        addNews(world, 'error', `Groupes : ${MAX_GROUPS} groupes maximum par entreprise.`);
        return;
      }
      const rawName = command.name ?? '';
      if (rawName.trim() && !isValidGroupName(rawName)) {
        addNews(world, 'error', 'Groupe refusé : nom vide ou trop long.');
        return;
      }
      const parent = groupById(world, command.parent);
      if (parent && (parent.company !== company.id || parent.kind !== kind)) {
        addNews(
          world,
          'error',
          'Groupe refusé : le parent doit être de votre entreprise et du même type.',
        );
        return;
      }
      const id = nextGroupId(world);
      const created: MockGroup = {
        id,
        company: company.id,
        name: normalizeGroupName(rawName) || defaultGroupName(id),
        kind,
        parent: parent?.id ?? null,
        replaceModel: null,
        replaceWhenOld: true,
      };
      world.groups.push(created);
      addNews(world, 'info', `Groupe « ${created.name} » créé (${kind}).`);
      addEvent(world, {
        type: 'group_created',
        group: created.id,
        company: company.id,
        tick: world.tick,
      });
      return;
    }
    case 'rename': {
      if (!group || group.company !== company.id) {
        addNews(world, 'error', 'Renommage refusé : groupe introuvable.');
        return;
      }
      const name = normalizeGroupName(command.name ?? '');
      if (!name) {
        addNews(world, 'error', 'Renommage refusé : le nom ne peut pas être vide.');
        return;
      }
      group.name = name;
      addNews(world, 'info', `Groupe #${group.id} renommé « ${name} ».`);
      return;
    }
    case 'delete': {
      if (!group || group.company !== company.id) {
        addNews(world, 'error', 'Suppression refusée : groupe introuvable.');
        return;
      }
      for (const vehicle of world.vehicles) {
        if (vehicle.groupId === group.id) vehicle.groupId = null;
      }
      for (const child of world.groups) {
        if (child.parent === group.id) child.parent = group.parent;
      }
      world.groups = world.groups.filter((item) => item.id !== group.id);
      addNews(world, 'info', `Groupe « ${group.name} » supprimé.`);
      addEvent(world, {
        type: 'group_deleted',
        group: group.id,
        company: company.id,
        tick: world.tick,
      });
      return;
    }
    case 'assign':
    case 'remove': {
      const target = command.action === 'remove' ? null : group;
      if (command.action === 'assign' && !target) {
        addNews(world, 'error', 'Affectation refusée : groupe introuvable.');
        return;
      }
      if (target && target.company !== company.id) {
        addNews(
          world,
          'error',
          'Affectation refusée : ce groupe appartient à une autre entreprise.',
        );
        return;
      }
      const ids = command.vehicles ?? [];
      let changed = 0;
      let rejected = 0;
      for (const id of ids) {
        const vehicle = findVehicle(world, id);
        if (!vehicle || vehicle.company !== company.id) {
          rejected += 1;
          continue;
        }
        if (target && vehicle.kind !== target.kind) {
          rejected += 1;
          continue;
        }
        vehicle.groupId = target?.id ?? null;
        changed += 1;
      }
      addNews(
        world,
        changed > 0 ? 'info' : 'error',
        target
          ? `${changed} véhicule(s) affecté(s) au groupe « ${target.name} »${rejected > 0 ? ` (${rejected} refusé(s))` : ''}.`
          : `${changed} véhicule(s) retiré(s) de leur groupe${rejected > 0 ? ` (${rejected} refusé(s))` : ''}.`,
      );
      return;
    }
    default:
      break;
  }

  if (!group || group.company !== company.id) {
    addNews(world, 'error', 'Action de groupe refusée : groupe introuvable.');
    return;
  }

  if (command.action === 'autoreplace') {
    const modelId = command.model ?? null;
    if (modelId === null || modelId === '') {
      group.replaceModel = null;
      addNews(world, 'info', `Autoreplace désactivé pour « ${group.name} ».`);
      return;
    }
    const target = compatibleAutoreplaceModel(modelId, group.kind);
    if (!target) {
      addNews(
        world,
        'error',
        `Autoreplace refusé : « ${modelId} » n’est pas un modèle ${group.kind} du catalogue.`,
      );
      return;
    }
    group.replaceModel = target.id;
    group.replaceWhenOld = command.whenOld !== false;
    addNews(
      world,
      'info',
      `Autoreplace activé pour « ${group.name} » vers ${target.name} (${
        group.replaceWhenOld ? 'véhicules anciens' : 'dès que possible'
      }).`,
    );
    return;
  }

  const ids = groupVehicleIds(world, group);
  if (ids.length === 0) {
    addNews(world, 'warning', `Groupe « ${group.name} » : aucun véhicule à traiter.`);
    return;
  }
  const base = {
    type: 'vehicle' as const,
    company: company.id,
  };
  switch (command.action) {
    case 'start':
      for (const id of ids) startVehicle(world, { ...base, action: 'start', vehicle: id }, company);
      return;
    case 'stop':
      for (const id of ids) stopVehicle(world, { ...base, action: 'stop', vehicle: id }, company);
      return;
    case 'send_to_depot':
      for (const id of ids) {
        sendToDepotCommand(world, { ...base, action: 'send_to_depot', vehicle: id }, company);
      }
      updateVehiclesTransforms(world);
      return;
    case 'sell':
      for (const id of [...ids])
        sellVehicle(world, { ...base, action: 'sell', vehicle: id }, company);
      return;
    default:
      break;
  }
}

/** Valide et normalise une tournée reçue du client (#161). */
function normalizeOrders(
  world: MockWorld,
  kind: VehicleKind,
  specs: readonly NonNullable<Extract<EngineCommand, { type: 'vehicle' }>['orders']>[number][],
): { orders: VehicleOrder[]; error: string | null } {
  if (specs.length > MAX_VEHICLE_ORDERS) {
    return { orders: [], error: `${specs.length} ordres (${MAX_VEHICLE_ORDERS} maximum).` };
  }
  const orders: VehicleOrder[] = specs.map((order) => ({
    target: order.target,
    kind: order.kind,
    ...(order.options ? { options: cloneOrderOptions(order.options) } : {}),
  }));
  let destinations = 0;
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    if (!order) continue;
    if (order.kind === 'conditional') {
      if (!order.options?.condition) {
        return { orders: [], error: `Ordre ${index + 1} : condition manquante.` };
      }
      const jump = order.options.jump;
      if (jump === undefined || !Number.isInteger(jump) || jump < 0 || jump >= orders.length) {
        return {
          orders: [],
          error: `Ordre ${index + 1} : saut invalide (attendu 1..${orders.length}).`,
        };
      }
      continue;
    }
    destinations += 1;
    const incompatible = orderInfrastructureError(world, kind, order);
    if (incompatible) {
      return { orders: [], error: `Ordre ${index + 1} : ${incompatible}` };
    }
    const target = resolveOrderTarget(world, order);
    if (!target) {
      return {
        orders: [],
        error:
          order.kind === 'station'
            ? `Gare #${order.target} introuvable.`
            : order.kind === 'industry'
              ? `Industrie #${order.target} introuvable.`
              : `Dépôt ${order.target} introuvable ou démoli.`,
      };
    }
  }
  if (destinations === 0) {
    return {
      orders: [],
      error: 'Aucun arrêt physique : ajoutez une gare, une industrie ou un dépôt.',
    };
  }
  return { orders, error: null };
}

/**
 * Refit de cargaison (#160) : exige un véhicule arrêté dans son dépôt, une
 * cargaison disponible pour le modèle et la trésorerie. La cargaison en cours
 * est perdue, comme dans OpenTTD.
 */
function refitVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Refit refusé : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Refit refusé : ce véhicule ne vous appartient pas.');
    return;
  }
  if (vehicle.status !== 3) {
    addNews(world, 'error', 'Refit refusé : le véhicule doit être arrêté dans un dépôt.');
    return;
  }
  const model = vehicleModel(vehicle.model);
  if (!model) {
    addNews(world, 'error', 'Refit refusé : ce véhicule ne suit pas le catalogue partagé.');
    return;
  }
  const cargo = command.cargo ?? '';
  const option = refitOption(model, cargo);
  if (!option) {
    addNews(
      world,
      'error',
      `Refit refusé : ${model.name} n’accepte pas « ${cargo || '?'} » (disponible : ${model.refits
        .map((item) => item.cargo)
        .join(', ')}).`,
    );
    return;
  }
  if (vehicle.cargoType === cargo) {
    addNews(world, 'error', `Refit inutile : ${model.name} transporte déjà « ${cargo} ».`);
    return;
  }
  const cost = refitCost(model);
  if (company.money < cost) {
    addNews(
      world,
      'error',
      `Refit refusé : ${Math.round(cost)} £ requis pour reconfigurer ${model.name}.`,
    );
    return;
  }
  const lost = vehicle.cargoAmount;
  vehicle.cargoType = cargo;
  vehicle.cargoClass = cargo;
  vehicle.cargoCapacity = option.capacity;
  vehicle.cargoAmount = 0;
  company.money -= cost;
  addNews(
    world,
    'info',
    `Véhicule #${vehicle.id} reconfiguré vers « ${cargo} » pour ${Math.round(cost)} £ : capacité ${option.capacity}, ${lost} unité(s) perdue(s).`,
  );
}

/** Duplication d'un véhicule dans son dépôt (#161), tournée copiée. */
function cloneVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const source = findVehicle(world, command.vehicle);
  if (!source) {
    addNews(
      world,
      'error',
      `Duplication refusée : véhicule #${command.vehicle ?? '?'} introuvable.`,
    );
    return;
  }
  if (source.company !== company.id) {
    addNews(world, 'error', 'Duplication refusée : ce véhicule ne vous appartient pas.');
    return;
  }
  if (source.status !== 3) {
    addNews(world, 'error', 'Duplication refusée : le véhicule source doit être dans un dépôt.');
    return;
  }
  const model = vehicleModel(source.model);
  if (!model) {
    addNews(world, 'error', 'Duplication refusée : ce véhicule ne suit pas le catalogue partagé.');
    return;
  }
  const cost = cloneCost(model);
  if (company.money < cost) {
    addNews(
      world,
      'error',
      `Duplication refusée : ${Math.round(cost)} £ requis pour cloner ${model.name}.`,
    );
    return;
  }
  const clone: MockVehicle = {
    ...source,
    id: nextVehicleId(world),
    path: source.path.map((point) => ({ ...point })),
    pathLengths: [...source.pathLengths],
    segmentStops: source.segmentStops.map((stop) => (stop ? { ...stop } : null)),
    currentOrder: source.currentOrder,
    routeOrders: [...source.routeOrders],
    orderTargets: [...source.orderTargets],
    orders: source.orders.map((order) => cloneOrder(order)),
    cargoType: source.cargoType,
    cargoCapacity: source.cargoCapacity,
    cargoAmount: source.cargoAmount,
    waitTicks: 0,
    profitLastYear: 0,
    ageDays: 0,
    groupId: source.groupId,
    reliability: {
      ...initialReliability(source.reliability.serviceIntervalDays),
      lastServiceTick: world.tick,
    },
  };
  if (command.shareOrders === false) {
    clone.orders = [];
    clone.orderTargets = [];
    clone.routeOrders = [];
    clone.currentOrder = 0;
    clone.path = [{ x: source.x, y: source.y }];
    clone.pathLengths = [0];
    clone.segmentStops = [null];
    clone.status = 3;
  }
  world.vehicles.push(clone);
  company.money -= cost;
  syncVehicleCounts(world);
  updateVehiclesTransforms(world);
  addNews(
    world,
    'info',
    `${model.name} dupliqué (#${clone.id}) pour ${Math.round(cost)} £ depuis le véhicule #${source.id}.`,
  );
}

function orderVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
  company: MockCompany,
): void {
  const vehicle = findVehicle(world, command.vehicle);
  if (!vehicle) {
    addNews(world, 'error', `Tournée refusée : véhicule #${command.vehicle ?? '?'} introuvable.`);
    return;
  }
  if (vehicle.company !== company.id) {
    addNews(world, 'error', 'Tournée refusée : ce véhicule ne vous appartient pas.');
    return;
  }
  const normalized = normalizeOrders(world, vehicle.kind, command.orders ?? []);
  if (normalized.error) {
    addNews(world, 'error', `Tournée refusée : ${normalized.error}`);
    return;
  }
  vehicle.orders = normalized.orders;
  vehicle.currentOrder = 0;
  vehicle.orderTargets = vehicle.orders
    .filter((order) => order.kind !== 'conditional')
    .map((order) => order.target);
  syncRouteOrders(vehicle);
  // Un véhicule déjà en route suit immédiatement sa nouvelle tournée ; un
  // véhicule à l'arrêt ou en dépôt garde sa position jusqu'au démarrage, sauf
  // si un ordre demande le démarrage automatique (#162).
  if (vehicle.status === 1 || vehicle.status === 2) {
    rebuildRoute(world, vehicle);
  } else if (
    vehicle.status !== 1 &&
    vehicle.status !== 2 &&
    vehicle.orders.some((order) => order.options?.timetable?.autostart)
  ) {
    if (rebuildRoute(world, vehicle)) {
      addNews(world, 'info', `Véhicule #${vehicle.id} démarré automatiquement (horaire).`);
    }
  }
  addNews(world, 'info', `Tournée du véhicule #${vehicle.id} : ${vehicle.orders.length} ordre(s).`);
}

/**
 * Applique une commande véhicule. Comme la construction, le mock valide tout
 * avant de modifier l'état : une commande refusée ne touche ni la trésorerie
 * ni les véhicules et publie une news d'erreur lisible par le HUD.
 */
function applyVehicle(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'vehicle' }>,
): void {
  const company = world.companies[command.company];
  if (!company) {
    addNews(world, 'error', `Véhicules : entreprise #${command.company} inconnue.`);
    return;
  }
  if (company.bankrupt) {
    addNews(world, 'error', 'Véhicules : votre entreprise est en faillite.');
    return;
  }
  switch (command.action) {
    case 'buy':
      buyVehicle(world, command, company);
      break;
    case 'sell':
      sellVehicle(world, command, company);
      break;
    case 'start':
      startVehicle(world, command, company);
      break;
    case 'stop':
      stopVehicle(world, command, company);
      break;
    case 'order':
      orderVehicle(world, command, company);
      break;
    case 'refit':
      refitVehicle(world, command, company);
      break;
    case 'clone':
      cloneVehicle(world, command, company);
      break;
    case 'service':
      serviceVehicleCommand(world, command, company);
      break;
    case 'send_to_depot':
      sendToDepotCommand(world, command, company);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Finance et autorité locale (#165/#166)
// ---------------------------------------------------------------------------

/** Index de mois absolu, pour les actions limitées à une par mois. */
function monthIndex(world: MockWorld): number {
  return world.year * MONTHS_PER_YEAR + world.month;
}

function townActionCostOf(world: MockWorld, action: TownActionKind): number {
  return Math.round(TOWN_ACTION_BASE_COST[action] * priceFactor(world));
}

function townActionAvailable(world: MockWorld, town: MockTown, action: TownActionKind): boolean {
  return town.actionMonths[action] !== monthIndex(world);
}

function applyFinance(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'finance' }>,
): void {
  const company = world.companies[command.company];
  if (!company) {
    addNews(world, 'error', `Finance : entreprise #${command.company} inconnue.`);
    return;
  }
  if (company.bankrupt) {
    addNews(world, 'error', 'Finance : votre entreprise est en faillite.');
    return;
  }
  const interval = world.loanInterval > 0 ? world.loanInterval : DEFAULT_LOAN_INTERVAL;
  const requested =
    typeof command.amount === 'number' && Number.isFinite(command.amount) && command.amount > 0
      ? Math.round(command.amount)
      : interval;

  if (command.action === 'increase_loan') {
    const room = Math.max(0, company.maxLoan - company.loan);
    if (room <= 0) {
      addNews(world, 'error', 'Emprunt refusé : plafond de prêt atteint.');
      return;
    }
    const stepped = Math.floor(Math.min(requested, room) / interval) * interval;
    const amount = stepped > 0 ? stepped : Math.min(requested, room);
    company.loan += amount;
    company.money += amount;
    addNews(
      world,
      'info',
      `Prêt augmenté de ${Math.round(amount)} £ (dette ${Math.round(company.loan)} £ / ${Math.round(company.maxLoan)} £).`,
    );
    addEvent(world, {
      type: 'loan_changed',
      company: company.id,
      loan: company.loan,
      tick: world.tick,
    });
    return;
  }

  if (company.loan <= 0) {
    addNews(world, 'error', 'Remboursement refusé : aucun prêt en cours.');
    return;
  }
  if (company.money <= 0) {
    addNews(world, 'error', 'Remboursement refusé : trésorerie insuffisante.');
    return;
  }
  const repayable = Math.min(requested, company.loan, company.money);
  const stepped = Math.floor(repayable / interval) * interval;
  const amount = stepped > 0 ? stepped : Math.min(repayable, company.loan);
  company.loan -= amount;
  company.money -= amount;
  addNews(
    world,
    'info',
    `Prêt remboursé de ${Math.round(amount)} £ (dette restante ${Math.round(company.loan)} £).`,
  );
  addEvent(world, {
    type: 'loan_changed',
    company: company.id,
    loan: company.loan,
    tick: world.tick,
  });
}

function applyTownAction(
  world: MockWorld,
  command: Extract<EngineCommand, { type: 'town_action' }>,
): void {
  const company = world.companies[command.company];
  if (!company) {
    addNews(world, 'error', `Autorité locale : entreprise #${command.company} inconnue.`);
    return;
  }
  if (company.bankrupt) {
    addNews(world, 'error', 'Autorité locale : votre entreprise est en faillite.');
    return;
  }
  const town = world.towns.find((item) => item.id === command.town);
  if (!town) {
    addNews(world, 'error', `Autorité locale : ville #${command.town} inconnue.`);
    return;
  }
  if (!townActionAvailable(world, town, command.action)) {
    addNews(world, 'error', `${town.name} : cette action a déjà été financée ce mois-ci.`);
    return;
  }
  const cost = townActionCostOf(world, command.action);
  if (company.money < cost) {
    addNews(world, 'error', `Autorité locale : ${Math.round(cost)} £ requis pour cette action.`);
    return;
  }
  company.money -= cost;
  town.actionMonths[command.action] = monthIndex(world);
  let message = '';
  switch (command.action) {
    case 'advertise':
      town.rating = Math.min(100, town.rating + 10);
      message = `Campagne de publicité financée à ${town.name} : note ${Math.round(town.rating)} / 100.`;
      break;
    case 'fund_roads':
      town.rating = Math.min(100, town.rating + 6);
      town.growthRate = Math.min(8, town.growthRate + 1);
      message = `Routes financées à ${town.name} : croissance et note en hausse.`;
      break;
    case 'fund_buildings':
      town.rating = Math.min(100, town.rating + 8);
      town.population += 60;
      town.buildings += 1;
      message = `Bâtiments financés à ${town.name} : la ville s’agrandit.`;
      break;
  }
  addNews(world, 'info', message);
  addEvent(world, {
    type: 'town_action',
    town: town.id,
    action: command.action,
    tick: world.tick,
  });
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function addEvent(world: MockWorld, event: WorldEvent): void {
  world.events.push(event);
  if (world.events.length > 256) {
    const drop = world.events.length - 256;
    world.events.splice(0, drop);
    world.eventCursor = Math.max(0, world.eventCursor - drop);
  }
}

function addNews(world: MockWorld, kind: MockNews['kind'], text: string): void {
  world.news.push({ tick: world.tick, kind, text });
  if (world.news.length > 60) {
    const drop = world.news.length - 60;
    world.news.splice(0, drop);
    world.newsCursor = Math.max(0, world.newsCursor - drop);
  }
}

/** Facteur de prix appliqué aux coûts et aux recettes (#165). */
function priceFactor(world: MockWorld): number {
  return 1 + Math.max(0, world.inflation) / 100;
}

/** Le véhicule peut-il charger cette cargaison ? */
function canCarry(vehicle: MockVehicle, cargo: string): boolean {
  if (isPassengerCargo(vehicle.cargoClass)) return isPassengerCargo(cargo);
  return !isPassengerCargo(cargo);
}

/** Subvention correspondant à une livraison source → destination. */
function matchingSubsidy(
  world: MockWorld,
  cargo: string,
  fromIndustry: number | null,
  toIndustry: number,
): MockSubsidy | null {
  if (fromIndustry === null) return null;
  return (
    world.subsidies.find(
      (subsidy) =>
        subsidy.cargo === cargo &&
        subsidy.fromIndustry === fromIndustry &&
        subsidy.toIndustry === toIndustry,
    ) ?? null
  );
}

function awardSubsidy(world: MockWorld, subsidy: MockSubsidy, companyId: number): void {
  if (subsidy.awardedTo !== null) return;
  subsidy.awardedTo = companyId;
  const company = world.companies[companyId];
  addNews(
    world,
    'company',
    `${company?.name ?? `Entreprise #${companyId}`} remporte la subvention ${subsidy.cargo}.`,
  );
  addEvent(world, {
    type: 'subsidy_awarded',
    subsidy: subsidy.id,
    company: companyId,
    tick: world.tick,
  });
}

/**
 * Revenu d'une livraison : tarif de cargaison, distance parcourue, rapidité,
 * inflation et bonus de subvention. Le calcul est entièrement déterministe.
 */
function deliveryRevenue(
  world: MockWorld,
  vehicle: MockVehicle,
  amount: number,
  toIndustry: number | null,
): number {
  if (amount <= 0) return 0;
  const distance = Math.max(1, vehicle.tripDistance);
  const elapsedDays = Math.max(0, (world.tick - vehicle.loadedTick) / TICKS_PER_DAY);
  const distanceFactor = 0.6 + Math.min(2.4, distance / 45);
  const speedFactor = 0.85 + Math.min(0.4, vehicle.speed / 150);
  const timeFactor = 1.2 - Math.min(0.4, elapsedDays / 120);
  let revenue = amount * cargoRate(vehicle.cargoType) * distanceFactor * speedFactor * timeFactor;
  if (toIndustry !== null) {
    const subsidy = matchingSubsidy(world, vehicle.cargoType, vehicle.cargoSource, toIndustry);
    if (subsidy) {
      awardSubsidy(world, subsidy, vehicle.company);
      if (subsidy.awardedTo === vehicle.company) revenue *= 1.8;
    }
  }
  return Math.max(1, Math.round(revenue * priceFactor(world)));
}

function creditCompany(world: MockWorld, vehicle: MockVehicle, revenue: number): void {
  if (revenue <= 0) return;
  const company = world.companies[vehicle.company];
  if (company) {
    company.deliveredToday += revenue;
    company.money += revenue;
  }
  vehicle.profitLastYear += revenue;
}

/** Délai de garde d'un plein chargement quand la gare reste vide (ticks). */
const FULL_LOAD_TIMEOUT = 180;

function stopAction(vehicle: MockVehicle, orderIndex: number): OrderAction {
  const order = vehicle.orders[orderIndex];
  return order?.options?.action ?? 'normal';
}

function addStationWaiting(station: MockStation, cargo: string, amount: number): void {
  if (amount <= 0) return;
  const existing = station.waiting.find((entry) => entry.cargo === cargo);
  if (existing) existing.amount += amount;
  else station.waiting.push({ cargo, amount });
}

/** Charge le véhicule depuis la gare, selon le mode d'arrêt courant. */
function loadFromStation(world: MockWorld, vehicle: MockVehicle, station: MockStation): void {
  const action = stopAction(vehicle, vehicle.currentOrder);
  // Un transfert est un simple dépôt en gare : le véhicule repart à vide et
  // la cargaison attend un second véhicule.
  if (action === 'no_load' || action === 'unload' || action === 'transfer') return;
  if (vehicle.cargoCapacity <= 0) return;
  while (vehicle.cargoAmount < vehicle.cargoCapacity) {
    const entry = station.waiting.find((item) => item.amount > 0 && canCarry(vehicle, item.cargo));
    if (!entry) break;
    const load = Math.min(vehicle.cargoCapacity - vehicle.cargoAmount, entry.amount);
    if (load <= 0) break;
    vehicle.cargoAmount += load;
    entry.amount -= load;
    vehicle.cargoType = entry.cargo;
    vehicle.cargoSource = null;
    vehicle.tripDistance = 0;
    vehicle.loadedTick = world.tick;
  }
  station.waiting = station.waiting.filter((item) => item.amount > 0);
}

function vehicleArrive(world: MockWorld, vehicle: MockVehicle, stop: MockStop): void {
  const orderIndex = stop.order ?? -1;
  if (orderIndex >= 0) vehicle.currentOrder = orderIndex;
  const action = stopAction(vehicle, vehicle.currentOrder);

  if (vehicle.cargoAmount > 0 && (stop.kind === 'station' || stop.kind === 'industry')) {
    const amount = vehicle.cargoAmount;
    if (stop.kind === 'station') {
      const station = world.stations.find((item) => item.id === stop.id);
      if (station) {
        if (action === 'transfer') {
          // Transfert : la cargaison rejoint le quai, sans revenu immédiat.
          addStationWaiting(station, vehicle.cargoType, amount);
        } else if (action === 'unload') {
          // Déchargement forcé : revenu immédiat, pas de stock réutilisable.
          creditCompany(world, vehicle, deliveryRevenue(world, vehicle, amount, null));
        } else {
          // Chargement normal, plein chargement, sans chargement : déchargement
          // classique, avec revenu et stock en gare.
          addStationWaiting(station, vehicle.cargoType, amount);
          creditCompany(world, vehicle, deliveryRevenue(world, vehicle, amount, null));
        }
      }
    } else if (stop.kind === 'industry') {
      const industry = world.industries.find((item) => item.id === stop.id);
      if (industry && industry.accepts.includes(vehicle.cargoType)) {
        industry.transported += amount;
        creditCompany(world, vehicle, deliveryRevenue(world, vehicle, amount, industry.id));
      }
    }
    vehicle.cargoAmount = 0;
    vehicle.cargoSource = null;
    vehicle.tripDistance = 0;
  }

  const timetableWait = vehicle.orders[vehicle.currentOrder]?.options?.timetable?.waitTicks;
  const baseWait = 14 + ((vehicle.id * 7) % 22);
  vehicle.waitTicks =
    timetableWait !== undefined && Number.isFinite(timetableWait)
      ? Math.max(0, Math.trunc(timetableWait))
      : action === 'full_load'
        ? FULL_LOAD_TIMEOUT
        : baseWait;
  if (action === 'full_load' && stop.kind === 'station') {
    const station = world.stations.find((item) => item.id === stop.id);
    if (station) {
      // Tentative de chargement immédiate : une gare déjà approvisionnée ne
      // fait pas attendre le véhicule.
      loadFromStation(world, vehicle, station);
      if (vehicle.cargoAmount >= vehicle.cargoCapacity) vehicle.waitTicks = 0;
    }
  }
  // Un véhicule garé au dépôt regarde sa porte : il repartira dans cette
  // direction, sans demi-tour visible au moment du départ (#247).
  if (stop.kind === 'depot') {
    const depot = world.depots.find((item) => item.id === stop.id);
    if (depot) vehicle.direction = depotDirection(depot.direction);
  }
  vehicle.status = 2;
  addEvent(world, {
    type: 'vehicle_arrived',
    vehicle: vehicle.id,
    station: stop.id,
    tick: world.tick,
  });
}

function vehicleDepart(world: MockWorld, vehicle: MockVehicle, stop: MockStop): void {
  const action = stopAction(vehicle, vehicle.currentOrder);
  if (stop.kind === 'station') {
    const station = world.stations.find((item) => item.id === stop.id);
    if (station) {
      if (action === 'normal' || action === 'full_load') {
        loadFromStation(world, vehicle, station);
      }
      // Complément de démonstration : une gare sans stock ne doit pas bloquer
      // une ligne de bout en bout. Le plein chargement comble jusqu'à la
      // capacité, le chargement normal garde l'ancien apport partiel.
      if (vehicle.cargoAmount === 0 && action === 'normal') {
        vehicle.cargoAmount = Math.round(vehicle.cargoCapacity * 0.35);
        vehicle.cargoSource = null;
        vehicle.tripDistance = 0;
        vehicle.loadedTick = world.tick;
      } else if (action === 'full_load' && vehicle.cargoAmount < vehicle.cargoCapacity) {
        vehicle.cargoAmount = vehicle.cargoCapacity;
        vehicle.cargoSource = null;
        vehicle.tripDistance = 0;
        vehicle.loadedTick = world.tick;
      }
    }
  } else if (stop.kind === 'industry' && (action === 'normal' || action === 'full_load')) {
    const industry = world.industries.find((item) => item.id === stop.id);
    if (
      industry &&
      industry.cargo !== '' &&
      industry.stock > 0 &&
      vehicle.cargoAmount === 0 &&
      canCarry(vehicle, industry.cargo)
    ) {
      const load = Math.min(vehicle.cargoCapacity, Math.floor(industry.stock));
      if (load > 0) {
        industry.stock -= load;
        vehicle.cargoAmount = load;
        vehicle.cargoType = industry.cargo;
        vehicle.cargoSource = industry.id;
        vehicle.tripDistance = 0;
        vehicle.loadedTick = world.tick;
      }
    }
  }
  vehicle.status = 1;
  addEvent(world, {
    type: 'vehicle_departed',
    vehicle: vehicle.id,
    station: stop.id,
    tick: world.tick,
  });

  // Ordre suivant : un saut conditionnel peut changer la rotation du tracé.
  const next = nextOrderIndex(world, vehicle, vehicle.currentOrder);
  if (next === null) {
    vehicle.status = 0;
    return;
  }
  const position = vehicle.routeOrders.indexOf(vehicle.currentOrder);
  const expected =
    position >= 0 && vehicle.routeOrders.length > 0
      ? vehicle.routeOrders[(position + 1) % vehicle.routeOrders.length]
      : next;
  if (next !== expected) {
    vehicle.currentOrder = next;
    rebuildRoute(world, vehicle);
  } else {
    vehicle.currentOrder = next;
  }
}

function moveVehicle(world: MockWorld, vehicle: MockVehicle): void {
  // 0 = arrêté par le joueur, 3 = en dépôt : le véhicule ne bouge pas.
  if (vehicle.status === 0 || vehicle.status === 3) return;
  if (vehicle.path.length < 2) return;
  if (vehicle.reliability.breakdown === 'stopped') return;
  if (vehicle.waitTicks > 0) {
    const stop = vehicle.segmentStops[vehicle.segment] ?? null;
    if (stop && stop.kind === 'station') {
      const station = world.stations.find((item) => item.id === stop.id);
      if (station && stopAction(vehicle, vehicle.currentOrder) === 'full_load') {
        loadFromStation(world, vehicle, station);
        if (vehicle.cargoAmount >= vehicle.cargoCapacity) {
          vehicle.waitTicks = 0;
          vehicleDepart(world, vehicle, stop);
          return;
        }
      }
    }
    vehicle.waitTicks -= 1;
    if (vehicle.waitTicks === 0) {
      if (stop) vehicleDepart(world, vehicle, stop);
      else vehicle.status = 1;
    }
    return;
  }

  let remaining = (vehicle.speed / TICKS_PER_DAY) * MOTION_SCALE;
  remaining *= breakdownSpeedFactor(vehicle.reliability.breakdown);
  let guard = 0;
  while (remaining > 0 && guard < 12) {
    guard += 1;
    const length = vehicle.pathLengths[vehicle.segment] ?? 0;
    if (length <= 0) {
      vehicle.segment = (vehicle.segment + 1) % vehicle.path.length;
      vehicle.segmentT = 0;
      continue;
    }
    const left = (1 - vehicle.segmentT) * length;
    if (remaining < left) {
      vehicle.segmentT += remaining / length;
      vehicle.tripDistance += remaining;
      remaining = 0;
      continue;
    }
    remaining -= left;
    vehicle.tripDistance += left;
    vehicle.segment = (vehicle.segment + 1) % vehicle.path.length;
    vehicle.segmentT = 0;
    const stop = vehicle.segmentStops[vehicle.segment] ?? null;
    if (stop) {
      vehicleArrive(world, vehicle, stop);
      remaining = 0;
    }
  }
}

/** Charges d'exploitation quotidiennes et résultat du jour. */
function updateCompanyEconomy(world: MockWorld): void {
  for (const company of world.companies) {
    company.vehicleCount = world.vehicles.filter(
      (vehicle) => vehicle.company === company.id,
    ).length;
    company.stationCount = world.stations.filter(
      (station) => station.company === company.id,
    ).length;
    const structureUpkeep = world.structures
      .filter((structure) => structure.company === company.id)
      .reduce((total, structure) => total + structure.maintenancePerYear, 0);
    company.income = company.deliveredToday;
    company.expenses = Math.round(
      (220 * company.vehicleCount + 160 * company.stationCount + 900) * priceFactor(world) +
        structureUpkeep / 365,
    );
    company.money += company.income - company.expenses;
    company.deliveredToday = 0;
    company.value = Math.round(
      company.money - company.loan + company.vehicleCount * 72_000 + company.stationCount * 110_000,
    );
  }
}

/** Intérêts mensuels, faillite et évolution de l'inflation (#165). */
function monthlyEconomy(world: MockWorld, rng: Prng): void {
  const monthIndex = world.year * MONTHS_PER_YEAR + world.month;
  for (const company of world.companies) {
    const interest = Math.round((company.loan * world.interestRate) / 100 / MONTHS_PER_YEAR);
    if (interest > 0) {
      company.money -= interest;
      company.interestPaid += interest;
      company.expenses += interest;
    }
    company.maxLoan = Math.round(difficultyPreset(world.difficulty).maxLoan * priceFactor(world));
    if (company.bankrupt) continue;
    if (company.money < 0) {
      company.monthsOfBankruptcy += 1;
      if (company.monthsOfBankruptcy === 3) {
        addNews(
          world,
          'warning',
          `${company.name} : trésorerie négative depuis 3 mois. Remboursez un prêt ou réduisez les coûts.`,
        );
      }
      if (company.monthsOfBankruptcy >= BANKRUPTCY_MONTHS) {
        company.bankrupt = true;
        addNews(world, 'error', `${company.name} est en faillite.`);
        addEvent(world, { type: 'company_bankrupt', company: company.id, tick: world.tick });
      }
    } else if (company.monthsOfBankruptcy > 0) {
      company.monthsOfBankruptcy = Math.max(0, company.monthsOfBankruptcy - 1);
    }
  }

  // Inflation annuelle : légèrement variable autour du préréglage.
  if (world.month === 0) {
    const base = difficultyPreset(world.difficulty).inflation;
    const rate = Math.max(0, base + rng.float(-0.6, 0.9));
    world.inflation = Math.round((world.inflation + rate) * 10) / 10;
    addNews(
      world,
      'info',
      `Inflation annuelle : +${rate.toFixed(1)} % (cumul ${world.inflation.toFixed(1)} %).`,
    );
  }

  // Subventions : compte à rebours puis renouvellement déterministe.
  for (const subsidy of world.subsidies) subsidy.remainingMonths -= 1;
  const expired = world.subsidies.filter((subsidy) => subsidy.remainingMonths <= 0);
  for (const subsidy of expired) {
    addEvent(world, { type: 'subsidy_expired', subsidy: subsidy.id, tick: world.tick });
  }
  world.subsidies = world.subsidies.filter((subsidy) => subsidy.remainingMonths > 0);
  if (world.subsidies.length < 2 && monthIndex % 3 === 0) {
    const candidates: { from: MockIndustry; to: MockIndustry }[] = [];
    for (const from of world.industries) {
      if (from.cargo === '') continue;
      for (const to of world.industries) {
        if (to.id === from.id || !to.accepts.includes(from.cargo)) continue;
        if (
          world.subsidies.some(
            (subsidy) =>
              subsidy.cargo === from.cargo &&
              subsidy.fromIndustry === from.id &&
              subsidy.toIndustry === to.id,
          )
        ) {
          continue;
        }
        candidates.push({ from, to });
      }
    }
    if (candidates.length > 0) {
      const pick = candidates[rng.int(0, candidates.length - 1)];
      if (pick) {
        const nextId = world.subsidies.reduce((max, item) => Math.max(max, item.id + 1), 0);
        world.subsidies.push({
          id: nextId,
          cargo: pick.from.cargo,
          fromIndustry: pick.from.id,
          toIndustry: pick.to.id,
          remainingMonths: SUBSIDY_OFFER_MONTHS,
          awardedTo: null,
        });
        addNews(
          world,
          'info',
          `Nouvelle subvention : ${pick.from.cargo} de ${pick.from.name} vers ${pick.to.name}.`,
        );
      }
    }
  }
}

function addTownBuilding(world: MockWorld, rng: Prng, town: MockTown): boolean {
  const radius = 9;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const x = Math.round(town.x) + rng.int(-radius, radius);
    const y = Math.round(town.y) + rng.int(-radius, radius);
    if (!inBounds(world.width, world.height, x, y)) continue;
    const index = tileIndex(x, y, world.width);
    const kind = world.kind[index];
    if (kind !== K.grass && kind !== K.clear && kind !== K.trees) continue;
    world.kind[index] = K.house;
    world.mapDirty = true;
    world.mapVersion += 1;
    return true;
  }
  return false;
}

function growTowns(world: MockWorld, rng: Prng, dayIndex: number): void {
  for (const town of world.towns) {
    const growth = Math.max(0, Math.round(town.growthRate * rng.float(0.2, 1.8)));
    town.population += growth;
    // La note dérive lentement ; les actions municipales la font remonter.
    town.rating = Math.max(0, Math.min(100, town.rating + rng.int(-1, 1)));
    if (dayIndex % 12 === 0 && addTownBuilding(world, rng, town)) {
      town.buildings += 1;
      addEvent(world, {
        type: 'town_growth',
        town: town.id,
        population: town.population,
        tick: world.tick,
      });
    }
  }
}

/** Passagers et courrier générés quotidiennement autour des villes. */
function growStationCargo(world: MockWorld, rng: Prng): void {
  for (const station of world.stations) {
    if (station.kind === 'buoy' || station.kind === 'ship') continue;
    let nearest: MockTown | null = null;
    let best = Infinity;
    for (const town of world.towns) {
      const dx = town.x - station.x;
      const dy = town.y - station.y;
      const distance = dx * dx + dy * dy;
      if (distance < best) {
        best = distance;
        nearest = town;
      }
    }
    if (!nearest || best > 24 * 24) continue;
    const passengers = Math.max(1, Math.round((nearest.population / 500) * rng.float(0.5, 1.5)));
    const mail = rng.chance(0.5) ? Math.max(1, Math.round(passengers / 4)) : 0;
    addWaiting(station, 'passengers', passengers);
    if (mail > 0) addWaiting(station, 'mail', mail);
    // Petit fret local : les camions de démonstration trouvent toujours une
    // cargaison à proximité d'une ville, même sans industrie à proximité.
    if (rng.chance(0.45)) {
      addWaiting(station, 'goods', Math.max(1, Math.round(nearest.population / 1_200)));
    }
  }
}

function addWaiting(station: MockStation, cargo: string, amount: number): void {
  if (amount <= 0) return;
  const entry = station.waiting.find((item) => item.cargo === cargo);
  if (entry) entry.amount = Math.min(2_000, entry.amount + amount);
  else station.waiting.push({ cargo, amount: Math.min(2_000, amount) });
}

/* ------------------------------------------------------------------------- */
/*  IA concurrentes (#168)                                                   */
/* ------------------------------------------------------------------------- */

function aiLinkKey(a: number, b: number): string {
  return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

/** Lecture sûre du type de tuile dans un monde déjà construit. */
function worldKindAt(world: MockWorld, x: number, y: number): number {
  if (!inBounds(world.width, world.height, x, y)) return K.void;
  return world.kind[tileIndex(x, y, world.width)] ?? K.void;
}

/** Tuile susceptible de porter une route ou une petite gare routière. */
function aiTileUsable(world: MockWorld, x: number, y: number): boolean {
  if (!inBounds(world.width, world.height, x, y)) return false;
  const kind = worldKindAt(world, x, y);
  return kind === K.grass || kind === K.clear || kind === K.trees || kind === K.rough;
}

/**
 * Sites candidats autour d'une ville, du côté de l'autre ville. Les tuiles de
 * ville, d'industrie et d'eau sont écartées : l'IA n'essaie pas de démolir.
 */
function aiStationSites(world: MockWorld, town: MockTown, toward: MockTown): P2[] {
  const cx = Math.floor(town.x);
  const cy = Math.floor(town.y);
  const dx = toward.x - town.x;
  const dy = toward.y - town.y;
  const sx = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) || 1 : 0;
  const sy = sx === 0 ? Math.sign(dy) || 1 : 0;
  const sites: P2[] = [];
  for (let radius = 5; radius <= 14 && sites.length < 8; radius += 1) {
    for (let lateral = -4; lateral <= 4 && sites.length < 8; lateral += 1) {
      const x = cx + sx * radius + (sy === 0 ? 0 : lateral);
      const y = cy + sy * radius + (sx === 0 ? 0 : lateral);
      if (world.owner[tileIndex(x, y, world.width)] !== COMPANY_NONE) continue;
      if (!aiTileUsable(world, x, y)) continue;
      if (!aiTileUsable(world, x + 1, y) && !aiTileUsable(world, x - 1, y)) continue;
      if (!aiTileUsable(world, x, y + 1) && !aiTileUsable(world, x, y - 1)) continue;
      sites.push({ x, y });
    }
  }
  return sites;
}

/** Paires de villes non encore reliées, les plus proches d'abord. */
function aiCandidatePairs(world: MockWorld, company: MockCompany): [MockTown, MockTown][] {
  const known = new Set(company.aiLinks ?? []);
  const pairs: { a: MockTown; b: MockTown; distance: number }[] = [];
  for (let i = 0; i < world.towns.length; i += 1) {
    for (let j = i + 1; j < world.towns.length; j += 1) {
      const a = world.towns[i];
      const b = world.towns[j];
      if (!a || !b || known.has(aiLinkKey(a.id, b.id))) continue;
      const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (distance < 10 || distance > 72) continue;
      pairs.push({ a, b, distance });
    }
  }
  pairs.sort(
    (left, right) =>
      left.distance - right.distance || left.a.id - right.a.id || left.b.id - right.b.id,
  );
  return pairs.slice(0, 6).map((pair) => [pair.a, pair.b]);
}

/** Dépôt routier adjacent à la route, pour la gare de départ. */
function aiBuildDepot(world: MockWorld, company: MockCompany, station: P2): MockDepot | null {
  const before = world.depots.length;
  const candidates: P2[] = [];
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const x = station.x + dx;
      const y = station.y + dy;
      if (!aiTileUsable(world, x, y)) continue;
      const touchesRoad =
        worldKindAt(world, x + 1, y) === K.road ||
        worldKindAt(world, x - 1, y) === K.road ||
        worldKindAt(world, x, y + 1) === K.road ||
        worldKindAt(world, x, y - 1) === K.road;
      if (touchesRoad) candidates.push({ x, y });
    }
  }
  for (const spot of candidates) {
    applyBuild(world, {
      type: 'build',
      tool: 'depot',
      company: company.id,
      from: spot,
      options: { kind: 'road' },
    });
    if (world.depots.length > before) return world.depots[world.depots.length - 1] ?? null;
  }
  return null;
}

/** Achète et met en route des bus entre les deux nouvelles gares. */
function aiBuyBuses(
  world: MockWorld,
  company: MockCompany,
  depot: MockDepot,
  stationA: MockStation,
  stationB: MockStation,
  level: number,
): number {
  const model = level >= 2 ? 'bus_intercity' : 'bus_city';
  const count = Math.min(4, 1 + level);
  let bought = 0;
  for (let i = 0; i < count; i += 1) {
    const before = new Set(world.vehicles.map((vehicle) => vehicle.id));
    applyVehicle(world, {
      type: 'vehicle',
      action: 'buy',
      company: company.id,
      depotId: depot.id,
      model,
    });
    const vehicle = [...world.vehicles].reverse().find((item) => !before.has(item.id));
    if (!vehicle) break;
    applyVehicle(world, {
      type: 'vehicle',
      action: 'order',
      company: company.id,
      vehicle: vehicle.id,
      orders: [
        { target: stationA.id, kind: 'station' },
        { target: stationB.id, kind: 'station' },
      ],
    });
    applyVehicle(world, {
      type: 'vehicle',
      action: 'start',
      company: company.id,
      vehicle: vehicle.id,
    });
    bought += 1;
  }
  return bought;
}

/** Tente une liaison routière complète entre deux villes. */
function aiBuildLinkBetween(
  world: MockWorld,
  company: MockCompany,
  a: MockTown,
  b: MockTown,
  level: number,
): boolean {
  const sitesA = aiStationSites(world, a, b);
  const sitesB = aiStationSites(world, b, a);
  for (const siteA of sitesA) {
    for (const siteB of sitesB) {
      const length = Math.abs(siteA.x - siteB.x) + Math.abs(siteA.y - siteB.y);
      if (length < 8 || length > 64) continue;
      const axes: ('x' | 'y')[] =
        Math.abs(siteA.x - siteB.x) >= Math.abs(siteA.y - siteB.y) ? ['x', 'y'] : ['y', 'x'];
      for (const axis of axes) {
        const link = planLinkedRoute({
          map: mapSnapshotView(world),
          from: siteA,
          to: siteB,
          axis,
          kind: 'road',
          company: company.id,
          budget: company.money,
        });
        if (!link || link.cost > company.money * 0.65) continue;

        const beforeStations = world.stations.length;
        for (const piece of link.pieces) {
          if (piece.tool === 'bridge') {
            applyBuild(world, {
              type: 'build',
              tool: 'bridge',
              company: company.id,
              from: piece.from,
              to: piece.to,
              options: { kind: 'road', material: piece.material ?? 'steel' },
            });
          } else {
            applyBuild(world, {
              type: 'build',
              tool: 'road',
              company: company.id,
              from: piece.from,
              to: piece.to,
              options: { axis: piece.axis },
            });
          }
        }
        // La gare de départ suit le premier segment, celle d'arrivée le
        // dernier : sur un tracé en L, leurs axes diffèrent souvent.
        const startDirection = axis === 'x' ? 'ne' : 'nw';
        const endDirection =
          axis === 'x' && siteA.y !== siteB.y
            ? 'nw'
            : axis === 'y' && siteA.x !== siteB.x
              ? 'ne'
              : startDirection;
        applyBuild(world, {
          type: 'build',
          tool: 'station',
          company: company.id,
          from: siteA,
          options: { kind: 'road', drive_through: true, direction: startDirection },
        });
        applyBuild(world, {
          type: 'build',
          tool: 'station',
          company: company.id,
          from: siteB,
          options: { kind: 'road', drive_through: true, direction: endDirection },
        });
        if (world.stations.length < beforeStations + 2) return false;
        const stationB = world.stations[world.stations.length - 1];
        const stationA = world.stations[world.stations.length - 2];
        if (!stationA || !stationB) return false;
        const depot = aiBuildDepot(world, company, siteA);
        if (depot) aiBuyBuses(world, company, depot, stationA, stationB, level);
        return true;
      }
    }
  }
  return false;
}

/**
 * Fait construire une liaison aux entreprises IA. Chaque niveau augmente le
 * nombre de lignes et la fréquence des chantiers ; une paire échouée n'est pas
 * retentée indéfiniment. Le tirage vient de `world.rngState`, donc reste
 * identique à graine égale.
 */
function runAiCompanies(world: MockWorld, dayIndex: number): void {
  for (const company of world.companies) {
    if (!company.isAI || company.bankrupt) continue;
    const level = clampInt(company.aiLevel ?? 1, 1, 3);
    const due = company.aiNextBuildDay ?? dayIndex;
    if (dayIndex < due) continue;
    const links = company.aiLinks ?? [];
    company.aiLinks = links;
    if (links.length >= level) {
      company.aiNextBuildDay = dayIndex + 30;
      continue;
    }
    let built = false;
    for (const [a, b] of aiCandidatePairs(world, company)) {
      links.push(aiLinkKey(a.id, b.id));
      if (aiBuildLinkBetween(world, company, a, b, level)) {
        built = true;
        break;
      }
    }
    company.aiNextBuildDay = dayIndex + (built ? 6 : 4) + (3 - level) * 2;
  }
}

/* ------------------------------------------------------------------------- */
/*  Désastres optionnels (#172)                                              */
/* ------------------------------------------------------------------------- */

/** Probabilité quotidienne par difficulté : facile → expert. */
const DISASTER_CHANCE = [0.004, 0.008, 0.014, 0.022] as const;

const DISASTER_LABELS: Record<DisasterKind, string> = {
  fire: 'Incendie',
  road_accident: 'Accident routier',
  train_crash: 'Déraillement',
  aircraft_crash: 'Crash aérien',
};

function disasterChance(world: MockWorld): number {
  return DISASTER_CHANCE[clampInt(world.difficulty, 0, 3)] ?? DISASTER_CHANCE[1];
}

/** Choisit une cible et applique les dégâts immédiats du désastre. */
function startDisaster(world: MockWorld, rng: Prng): void {
  const road = world.vehicles.filter(
    (vehicle) => vehicle.kind === 'road' && vehicle.company !== COMPANY_NONE,
  );
  const trains = world.vehicles.filter(
    (vehicle) => vehicle.kind === 'train' && vehicle.company !== COMPANY_NONE,
  );
  const aircraft = world.vehicles.filter(
    (vehicle) => vehicle.kind === 'aircraft' && vehicle.company !== COMPANY_NONE,
  );
  const sources: DisasterKind[] = ['fire'];
  if (road.length > 0) sources.push('road_accident');
  if (trains.length > 0) sources.push('train_crash');
  if (aircraft.length > 0) sources.push('aircraft_crash');
  const kind = sources[rng.int(0, sources.length - 1)] ?? 'fire';
  const severity = rng.int(1, 3);
  const id = world.nextDisasterId;
  world.nextDisasterId += 1;

  if (kind === 'fire') {
    const fireIndustries = world.industries.filter((industry) => industry.cargo !== '');
    const useIndustry = fireIndustries.length > 0 && rng.chance(0.6);
    if (useIndustry) {
      const industry = fireIndustries[rng.int(0, fireIndustries.length - 1)];
      if (!industry) return;
      const before = industry.production;
      industry.production = Math.max(24, Math.round(before * (1 - severity * 0.08)));
      world.disasters.push({
        id,
        kind,
        x: industry.x,
        y: industry.y,
        company: COMPANY_NONE,
        industry: industry.id,
        severity,
        startedTick: world.tick,
        remainingDays: 4 + severity * 2,
      });
    } else {
      const town = world.towns[rng.int(0, world.towns.length - 1)];
      if (!town) return;
      town.population = Math.max(0, town.population - severity * 60);
      world.disasters.push({
        id,
        kind,
        x: town.x,
        y: town.y,
        company: COMPANY_NONE,
        town: town.id,
        severity,
        startedTick: world.tick,
        remainingDays: 3 + severity * 2,
      });
    }
    addNews(
      world,
      'error',
      `${DISASTER_LABELS[kind]} (gravité ${severity}) : les secours interviennent.`,
    );
  } else if (kind === 'road_accident') {
    const vehicle = road[rng.int(0, road.length - 1)];
    if (!vehicle) return;
    vehicle.status = 0;
    vehicle.waitTicks = 0;
    vehicle.cargoAmount = Math.max(0, Math.round(vehicle.cargoAmount * 0.5));
    world.disasters.push({
      id,
      kind,
      x: vehicle.x,
      y: vehicle.y,
      company: vehicle.company,
      vehicle: vehicle.id,
      severity,
      startedTick: world.tick,
      remainingDays: 1 + severity,
    });
    addNews(
      world,
      'warning',
      `${DISASTER_LABELS[kind]} (gravité ${severity}) : véhicule #${vehicle.id} immobilisé.`,
    );
  } else {
    const candidates = kind === 'train_crash' ? trains : aircraft;
    const vehicle = candidates[rng.int(0, candidates.length - 1)];
    if (!vehicle) return;
    const x = vehicle.x;
    const y = vehicle.y;
    const company = vehicle.company;
    world.vehicles = world.vehicles.filter((item) => item.id !== vehicle.id);
    syncVehicleCounts(world);
    world.disasters.push({
      id,
      kind,
      x,
      y,
      company,
      severity,
      startedTick: world.tick,
      remainingDays: 2 + severity,
    });
    addNews(
      world,
      'error',
      `${DISASTER_LABELS[kind]} (gravité ${severity}) : véhicule #${vehicle.id} détruit.`,
    );
  }

  addEvent(world, { type: 'disaster_started', disaster: id, kind, tick: world.tick });
}

/** Incrémente les désastres actifs et libère les véhicules accidentés. */
function updateDisasters(world: MockWorld, dayIndex: number, rng: Prng): void {
  if (!world.disastersEnabled) return;
  const ended: MockDisaster[] = [];
  for (const disaster of world.disasters) {
    disaster.remainingDays -= 1;
    if (disaster.remainingDays > 0) continue;
    ended.push(disaster);
    if (disaster.kind === 'road_accident' && disaster.vehicle !== undefined) {
      const vehicle = world.vehicles.find((item) => item.id === disaster.vehicle);
      if (vehicle && vehicle.status === 0) {
        vehicle.status = 1;
        if (vehicle.orders.length > 0) rebuildRoute(world, vehicle);
      }
    }
  }
  for (const disaster of ended) {
    addEvent(world, { type: 'disaster_ended', disaster: disaster.id, tick: world.tick });
    addNews(world, 'info', `${DISASTER_LABELS[disaster.kind]} terminé.`);
  }
  world.disasters = world.disasters.filter((disaster) => disaster.remainingDays > 0);

  if (dayIndex < world.nextDisasterDay) return;
  world.nextDisasterDay = dayIndex + 1;
  if (rng.chance(disasterChance(world))) startDisaster(world, rng);
}

/** Production industrielle : stock quotidien et évolution mensuelle. */
function updateIndustries(world: MockWorld, rng: Prng): void {
  for (const industry of world.industries) {
    if (industry.cargo !== '') {
      const daily = (industry.production / DAYS_PER_MONTH) * rng.float(0.6, 1.4);
      const cap = Math.max(60, industry.production * 2);
      industry.stock = Math.min(cap, industry.stock + daily);
    }
  }
}

function monthlyIndustries(world: MockWorld, rng: Prng): void {
  for (const industry of world.industries) {
    if (industry.cargo === '') {
      industry.transported = Math.max(0, Math.round(industry.transported * 0.5));
      continue;
    }
    const ratio = industry.production > 0 ? industry.transported / industry.production : 0;
    if (ratio > 0.75) {
      industry.production = Math.min(
        960,
        Math.round(industry.production * (1.02 + rng.float(0, 0.03))),
      );
    } else if (ratio < 0.2) {
      industry.production = Math.max(
        24,
        Math.round(industry.production * (0.96 + rng.float(0, 0.02))),
      );
    } else {
      industry.production = Math.max(24, Math.min(960, industry.production + rng.int(-4, 5)));
    }
    industry.transported = Math.max(0, Math.round(industry.transported * 0.5));
    if (rng.chance(0.08)) {
      addEvent(world, {
        type: 'industry_production',
        industry: industry.id,
        amount: industry.production,
        tick: world.tick,
      });
    }
  }
}

/** Entretien annuel indicatif d'un véhicule, même hors catalogue. */
function vehicleMaintenance(vehicle: MockVehicle): number {
  return vehicleModel(vehicle.model)?.maintenance ?? Math.max(600, vehicle.cargoCapacity * 14);
}

/** Jours écoulés depuis le dernier service, ou depuis la mise en circulation. */
function daysSinceService(world: MockWorld, vehicle: MockVehicle): number {
  const since = vehicle.reliability.lastServiceTick ?? 0;
  return Math.max(0, Math.floor((world.tick - since) / TICKS_PER_DAY));
}

/** Service au dépôt : remet l'usure à zéro et débite une quote-part d'entretien. */
function serviceVehicle(world: MockWorld, vehicle: MockVehicle, company: MockCompany): boolean {
  const days = daysSinceService(world, vehicle);
  const cost = serviceCost(
    vehicleMaintenance(vehicle),
    days,
    vehicle.reliability.serviceIntervalDays,
  );
  if (company.money < cost) {
    addNews(
      world,
      'error',
      `Entretien refusé pour le véhicule #${vehicle.id} : ${Math.round(cost)} £ requis.`,
    );
    return false;
  }
  company.money -= cost;
  vehicle.reliability = {
    ...initialReliability(vehicle.reliability.serviceIntervalDays),
    lastServiceTick: world.tick,
  };
  vehicle.waitTicks = 0;
  addNews(
    world,
    'info',
    `Véhicule #${vehicle.id} entretenu pour ${Math.round(cost)} £ : fiabilité restaurée.`,
  );
  addEvent(world, {
    type: 'vehicle_repaired',
    vehicle: vehicle.id,
    cost,
    tick: world.tick,
  });
  return true;
}

/** Gare/dépôt de rattachement du véhicule (homeDepot ou dépôt le plus proche). */
function vehicleHomeDepot(world: MockWorld, vehicle: MockVehicle): MockDepot | null {
  if (vehicle.homeDepot) {
    const depot = depotAtTile(world, vehicle.homeDepot.x, vehicle.homeDepot.y);
    if (depot && depot.company === vehicle.company) return depot;
  }
  let best: MockDepot | null = null;
  let bestDistance = Infinity;
  for (const depot of world.depots) {
    if (depot.company !== vehicle.company) continue;
    const kindOk = vehicle.kind === 'train' ? depot.kind === 'rail' : depot.kind === 'road';
    if (!kindOk && vehicle.kind !== 'ship' && vehicle.kind !== 'aircraft') continue;
    const dx = depot.x - vehicle.x;
    const dy = depot.y - vehicle.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = depot;
    }
  }
  return best;
}

/** Envoie le véhicule dans son dépôt (téléportation simplifiée du mock). */
function sendVehicleToDepot(world: MockWorld, vehicle: MockVehicle): boolean {
  if (vehicle.status === 3) return true;
  const depot = vehicleHomeDepot(world, vehicle);
  if (!depot) {
    addNews(
      world,
      'error',
      `Véhicule #${vehicle.id} : aucun dépôt de votre entreprise pour l'accueillir.`,
    );
    return false;
  }
  const centre = { x: depot.x + depot.width / 2, y: depot.y + depot.height / 2 };
  vehicle.homeDepot = { x: depot.x, y: depot.y };
  vehicle.path = [{ ...centre }];
  vehicle.pathLengths = [0];
  vehicle.segment = 0;
  vehicle.segmentT = 0;
  vehicle.segmentStops = [null];
  vehicle.status = 3;
  vehicle.waitTicks = 0;
  vehicle.direction = depotDirection(depot.direction);
  vehicle.pitch = 0;
  vehicle.x = centre.x;
  vehicle.y = centre.y;
  addNews(world, 'info', `Véhicule #${vehicle.id} envoyé au dépôt ${depot.id}.`);
  return true;
}

/** Progression d'une panne : ralentissement puis arrêt temporaire. */
function advanceVehicleBreakdown(world: MockWorld, vehicle: MockVehicle): void {
  if (vehicle.reliability.breakdown === 'none') return;
  const previous = vehicle.reliability.breakdown;
  const next = advanceBreakdown(vehicle.reliability.breakdown, vehicle.reliability.breakdownTicks);
  vehicle.reliability.breakdown = next.breakdown;
  vehicle.reliability.breakdownTicks = next.breakdownTicks;
  if (previous === 'slowing' && next.breakdown === 'stopped') {
    addNews(world, 'warning', `Panne : le véhicule #${vehicle.id} est temporairement arrêté.`);
  }
  if (next.breakdown === 'none') {
    addNews(world, 'info', `Véhicule #${vehicle.id} réparé : il reprend son service.`);
  }
}

/** Usure quotidienne et tirage déterministe des pannes. */
function updateReliabilityDaily(world: MockWorld, rng: Prng): void {
  for (const vehicle of world.vehicles) {
    if (vehicle.status === 3) continue;
    vehicle.reliability = advanceWear(vehicle.reliability, 1);
    vehicle.reliability.cooldownDays = Math.max(0, vehicle.reliability.cooldownDays - 1);
    if (vehicle.reliability.breakdown !== 'none') continue;
    if (
      rollBreakdown(vehicle.reliability.wear, vehicle.reliability.cooldownDays, rng.float(0, 1))
    ) {
      vehicle.reliability.breakdown = 'slowing';
      vehicle.reliability.breakdownTicks = BREAKDOWN_SLOW_TICKS;
      vehicle.reliability.cooldownDays = BREAKDOWN_COOLDOWN_DAYS;
      addNews(
        world,
        'warning',
        `Panne : le véhicule #${vehicle.id} ralentit (usure ${Math.round(
          vehicle.reliability.wear,
        )} %).`,
      );
      addEvent(world, {
        type: 'vehicle_breakdown',
        vehicle: vehicle.id,
        breakdown: 'slowing',
        tick: world.tick,
      });
    }
  }
}

/** Remplacement automatique des véhicules d'un groupe (#164). */
function updateAutoreplace(world: MockWorld): void {
  if (world.groups.length === 0) return;
  for (const group of world.groups) {
    if (!group.replaceModel) continue;
    const target = compatibleAutoreplaceModel(group.replaceModel, group.kind);
    if (!target) continue;
    for (const vehicle of world.vehicles) {
      if (vehicle.groupId !== group.id || vehicle.company !== group.company) continue;
      if (vehicle.model === target.id) continue;
      const days = daysSinceService(world, vehicle);
      if (
        !shouldAutoreplace(vehicle.ageDays, vehicle.reliability.wear, group.replaceWhenOld, days)
      ) {
        continue;
      }
      const company = world.companies[vehicle.company];
      if (!company) continue;
      const cost = Math.max(
        0,
        Math.round((target.cost - vehicleRefund(world, vehicle)) * priceFactor(world)),
      );
      if (company.money < cost) {
        addNews(
          world,
          'warning',
          `Autoreplace différé : ${Math.round(cost)} £ requis pour remplacer le véhicule #${vehicle.id}.`,
        );
        continue;
      }
      company.money -= cost;
      vehicle.model = target.id;
      vehicle.speed = target.speed;
      vehicle.cargoType = target.cargo;
      vehicle.cargoClass = target.cargo;
      vehicle.cargoCapacity = target.capacity;
      vehicle.cargoAmount = Math.min(vehicle.cargoAmount, target.capacity);
      vehicle.reliability = {
        ...initialReliability(vehicle.reliability.serviceIntervalDays),
        lastServiceTick: world.tick,
      };
      addNews(
        world,
        'company',
        `Autoreplace : véhicule #${vehicle.id} remplacé par ${target.name} pour ${Math.round(cost)} £.`,
      );
      addEvent(world, {
        type: 'vehicle_autoreplaced',
        vehicle: vehicle.id,
        model: target.id,
        tick: world.tick,
      });
    }
  }
}

function dailyTick(world: MockWorld): void {
  const rng = Prng.fromState(world.rngState);
  const dayIndex = (world.year * MONTHS_PER_YEAR + world.month) * DAYS_PER_MONTH + world.day;
  updateCompanyEconomy(world);
  runAiCompanies(world, dayIndex);
  updateDisasters(world, dayIndex, rng);
  growTowns(world, rng, dayIndex);
  growStationCargo(world, rng);
  updateIndustries(world, rng);
  updateReliabilityDaily(world, rng);
  updateAutoreplace(world);
  for (const vehicle of world.vehicles) vehicle.ageDays += 1;
  if (rng.chance(0.16)) addNews(world, 'info', rng.pick(RANDOM_NEWS));
  world.rngState = rng.getState();
}

function monthlyTick(world: MockWorld): void {
  const rng = Prng.fromState(world.rngState);
  monthlyEconomy(world, rng);
  monthlyIndustries(world, rng);
  world.rngState = rng.getState();
}

/** Écrit un octet de signal en maintenant le compteur de tuiles actives. */
function writeSignalData(world: MockWorld, index: number, value: number): void {
  const previous = world.signalData[index] ?? 0;
  if (previous === 0 && value !== 0) world.signalCount += 1;
  else if (previous !== 0 && value === 0) world.signalCount -= 1;
  world.signalData[index] = value;
}

/** Écrit le sens d'une route et tient le compteur de hash à jour (#231). */
function writeRoadData(world: MockWorld, index: number, value: number): void {
  const previous = world.roadData[index] ?? 0;
  if (previous === 0 && value !== 0) world.roadCount += 1;
  else if (previous !== 0 && value === 0) world.roadCount -= 1;
  world.roadData[index] = value;
}

/**
 * Recalcule l'état rouge/vert des signaux à partir de l'occupation réelle des
 * cantons. Le calcul est déterministe : il ne dépend que des positions des
 * trains et de `signalData` (#156).
 */
function updateSignalAspects(world: MockWorld): void {
  if (world.signalCount === 0) return;
  const width = world.width;
  const map = mapSnapshotView(world);
  const trains = world.vehicles.filter((vehicle) => vehicle.kind === 'train');
  for (let index = 0; index < world.signalData.length; index += 1) {
    const bits = world.signalData[index] ?? 0;
    if (bits === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const block = signalBlockTiles(map, x, y);
    const aspect = signalAspectForBlock(block, width, trains);
    const current = decodeSignalBits(bits)?.aspect ?? 'green';
    if (current !== aspect) {
      writeSignalData(world, index, withSignalAspect(bits, aspect));
    }
  }
}

function advanceTick(world: MockWorld): void {
  world.tick += 1;
  for (const vehicle of world.vehicles) {
    advanceVehicleBreakdown(world, vehicle);
    moveVehicle(world, vehicle);
  }
  updateSignalAspects(world);
  updateVehiclesTransforms(world);

  if (world.tick % TICKS_PER_DAY === 0) {
    world.day += 1;
    let newMonth = false;
    if (world.day > DAYS_PER_MONTH) {
      world.day = 1;
      world.month += 1;
      newMonth = true;
      if (world.month >= MONTHS_PER_YEAR) {
        world.month = 0;
        world.year += 1;
      }
    }
    dailyTick(world);
    if (newMonth) monthlyTick(world);
  }
}

// ---------------------------------------------------------------------------
// Sérialisation
// ---------------------------------------------------------------------------

function serializeWorld(world: MockWorld): SerializedWorld {
  return {
    seed: world.seed,
    width: world.width,
    height: world.height,
    tick: world.tick,
    year: world.year,
    month: world.month,
    day: world.day,
    paused: world.paused,
    speed: world.speed,
    rngState: world.rngState,
    sequence: world.sequence,
    mapVersion: world.mapVersion,
    inflation: world.inflation,
    difficulty: world.difficulty,
    interestRate: world.interestRate,
    loanInterval: world.loanInterval,
    kind: encodeBase64(world.kind),
    heightMap: encodeBase64(world.heightMap),
    owner: encodeBase64(world.owner),
    slope: encodeBase64(world.slope),
    flags: encodeBase64(world.flags),
    trackBits: encodeBase64(world.trackBits),
    railTypes: encodeBase64(world.railTypes),
    roadData: encodeBase64(world.roadData),
    signalData: encodeBase64(world.signalData),
    signalCount: world.signalCount,
    companies: world.companies,
    towns: world.towns,
    industries: world.industries,
    stations: world.stations,
    depots: world.depots,
    structures: world.structures,
    vehicles: world.vehicles.map((vehicle) => ({
      id: vehicle.id,
      kind: vehicle.kind,
      company: vehicle.company,
      model: vehicle.model,
      homeDepot: vehicle.homeDepot,
      path: vehicle.path,
      segment: vehicle.segment,
      segmentT: vehicle.segmentT,
      segmentStops: vehicle.segmentStops,
      currentOrder: vehicle.currentOrder,
      routeOrders: vehicle.routeOrders,
      speed: vehicle.speed,
      direction: vehicle.direction,
      pitch: vehicle.pitch,
      status: vehicle.status,
      waitTicks: vehicle.waitTicks,
      x: vehicle.x,
      y: vehicle.y,
      z: vehicle.z,
      cargoType: vehicle.cargoType,
      cargoClass: vehicle.cargoClass,
      cargoAmount: vehicle.cargoAmount,
      cargoCapacity: vehicle.cargoCapacity,
      cargoSource: vehicle.cargoSource,
      tripDistance: vehicle.tripDistance,
      loadedTick: vehicle.loadedTick,
      orderTargets: vehicle.orderTargets,
      orders: vehicle.orders,
      profitLastYear: vehicle.profitLastYear,
      ageDays: vehicle.ageDays,
      groupId: vehicle.groupId,
      reliability: vehicle.reliability,
    })),
    subsidies: world.subsidies,
    groups: world.groups,
    news: world.news,
    disastersEnabled: world.disastersEnabled,
    disasters: world.disasters,
    nextDisasterDay: world.nextDisasterDay,
    nextDisasterId: world.nextDisasterId,
  };
}

function decodeArray(text: string, expected: number): Uint8Array {
  const bytes = decodeBase64(text);
  if (bytes.length !== expected) {
    throw new Error(`Tableau carte invalide : ${bytes.length} octets au lieu de ${expected}.`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class MockEngine implements EngineDriver {
  private ready = false;
  private loading = false;
  private progress = 0;
  private lastError: string | null = null;
  private world: MockWorld | null = null;

  async init(options: EngineInitOptions): Promise<void> {
    this.loading = true;
    this.progress = 0;
    try {
      await Promise.resolve();
      this.progress = 0.6;
      await Promise.resolve();
      this.ready = true;
      this.progress = 1;
      this.loading = false;
      if (options.debug) {
        console.info('[MockEngine] prêt (moduleUrl =', options.moduleUrl, ')');
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.loading = false;
      this.ready = false;
      throw error;
    }
  }

  async newGame(options: NewGameOptions): Promise<void> {
    this.world = new WorldBuilder(options, options.seed >>> 0).build();
    this.ready = true;
    this.loading = false;
    this.progress = 1;
    this.lastError = null;
  }

  /** Choisit l'entreprise locale (#99) sans modifier l'état simulé ni le hash. */
  setLocalCompany(company: number): boolean {
    const world = this.world;
    if (!world) return false;
    const target = world.companies.find((item) => item.id === company);
    if (!target || target.isAI) return false;
    for (const item of world.companies) item.isLocal = item.id === company;
    return true;
  }

  step(ticks: number): number {
    const world = this.world;
    if (!world || !this.ready) return 0;
    if (world.paused || world.speed === 0) return 0;
    const count = Math.min(Math.max(0, Math.floor(ticks)), MAX_STEP_TICKS);
    for (let i = 0; i < count; i += 1) advanceTick(world);
    return count;
  }

  snapshot(): WorldSnapshot {
    const world = this.world;
    if (!world) throw new Error('MockEngine.snapshot : aucune partie chargée.');
    world.sequence += 1;

    const hash = this.hash();
    const includeMap = world.mapDirty || !world.mapSent;
    const map: MapSnapshot | null = includeMap
      ? {
          width: world.width,
          height: world.height,
          kind: world.kind.slice(),
          heightMap: world.heightMap.slice(),
          owner: world.owner.slice(),
          slope: world.slope.slice(),
          flags: world.flags.slice(),
          trackBits: world.trackBits.slice(),
          railTypes: world.railTypes.slice(),
          roadData: world.roadData.slice(),
          signalData: world.signalData.slice(),
        }
      : null;
    if (includeMap) {
      world.mapDirty = false;
      world.mapSent = true;
    }

    const economy: EconomySnapshot = {
      year: world.year,
      month: world.month,
      day: world.day,
      dayFraction: world.tick % TICKS_PER_DAY,
      speed: world.speed,
      paused: world.paused,
      inflation: world.inflation,
      difficulty: world.difficulty,
      interestRate: world.interestRate,
      maxLoan: Math.max(0, ...world.companies.map((company) => company.maxLoan)),
      loanInterval: world.loanInterval,
    };

    const companies: CompanySnapshot[] = world.companies.map((company) => ({
      id: company.id,
      name: company.name,
      president: company.president,
      colour: company.colour,
      money: company.money,
      loan: company.loan,
      value: company.value,
      income: company.income,
      expenses: company.expenses,
      vehicles: company.vehicleCount,
      stations: company.stationCount,
      isAI: company.isAI,
      isLocal: company.isLocal,
      bankrupt: company.bankrupt,
      maxLoan: company.maxLoan,
      monthsOfBankruptcy: company.monthsOfBankruptcy,
      ...(company.isAI ? { aiLevel: clampInt(company.aiLevel ?? 1, 1, 3) } : {}),
    }));

    const currentMonth = monthIndex(world);
    const towns: TownSnapshot[] = world.towns.map((town) => {
      const actions: Record<TownActionKind, TownActionSnapshot> = {
        advertise: {
          available: town.actionMonths.advertise !== currentMonth,
          cost: townActionCostOf(world, 'advertise'),
        },
        fund_roads: {
          available: town.actionMonths.fund_roads !== currentMonth,
          cost: townActionCostOf(world, 'fund_roads'),
        },
        fund_buildings: {
          available: town.actionMonths.fund_buildings !== currentMonth,
          cost: townActionCostOf(world, 'fund_buildings'),
        },
      };
      const authority: TownAuthoritySnapshot = { rating: town.rating, actions };
      return {
        id: town.id,
        name: town.name,
        x: town.x,
        y: town.y,
        population: town.population,
        growthRate: town.growthRate,
        buildings: town.buildings,
        rating: town.rating,
        authority,
      };
    });

    const industries: IndustrySnapshot[] = world.industries.map((industry) => ({
      id: industry.id,
      name: industry.name,
      kind: industry.kind,
      x: industry.x,
      y: industry.y,
      production: industry.production,
      transported: industry.transported,
      stocks:
        industry.cargo === ''
          ? []
          : [{ cargo: industry.cargo, amount: Math.round(industry.stock) }],
      accepts: [...industry.accepts],
      serviceRate:
        industry.production > 0
          ? Math.max(0, Math.min(100, (industry.transported / industry.production) * 100))
          : 0,
    }));

    const subsidies: SubsidySnapshot[] = world.subsidies.map((subsidy) => {
      const from = world.industries.find((item) => item.id === subsidy.fromIndustry);
      const to = world.industries.find((item) => item.id === subsidy.toIndustry);
      return {
        id: subsidy.id,
        cargo: subsidy.cargo,
        from: from?.name ?? `Industrie #${subsidy.fromIndustry}`,
        to: to?.name ?? `Industrie #${subsidy.toIndustry}`,
        fromKind: 'industry',
        toKind: 'industry',
        remainingMonths: Math.max(0, subsidy.remainingMonths),
        awardedTo: subsidy.awardedTo,
      };
    });

    const stations: StationSnapshot[] = world.stations.map((station) => ({
      id: station.id,
      company: station.company,
      name: station.name,
      kind: station.kind,
      x: station.x,
      y: station.y,
      width: station.width,
      height: station.height,
      waiting: station.waiting.map((entry) => ({ ...entry })),
      ...(station.driveThrough !== undefined
        ? {
            driveThrough: station.driveThrough,
            ...(station.roadAxis ? { roadAxis: station.roadAxis } : {}),
          }
        : {}),
    }));

    const depots: DepotSnapshot[] = world.depots.map((depot) => ({
      id: depot.id,
      company: depot.company,
      kind: depot.kind,
      x: depot.x,
      y: depot.y,
      direction: depot.direction,
      width: depot.width,
      height: depot.height,
      ...(depot.railType ? { railType: depot.railType } : {}),
    }));

    const structures: StructureSnapshot[] = world.structures.map((structure) =>
      structure.type === 'bridge'
        ? {
            id: structure.id,
            kind: 'bridge' as const,
            company: structure.company,
            transport: structure.transport,
            material: structure.material ?? 'wood',
            from: { ...structure.from },
            to: { ...structure.to },
            length: structure.length,
            deckHeight: structure.deckHeight ?? 0,
          }
        : {
            id: structure.id,
            kind: 'tunnel' as const,
            company: structure.company,
            transport: structure.transport,
            from: { ...structure.from },
            to: { ...structure.to },
            length: structure.length,
            portalHeight: structure.portalHeight ?? 0,
          },
    );

    const vehicles: VehicleSnapshot[] = world.vehicles.map((vehicle) => ({
      id: vehicle.id,
      kind: vehicle.kind,
      company: vehicle.company,
      ...(vehicle.model ? { model: vehicle.model } : {}),
      x: vehicle.x,
      y: vehicle.y,
      z: vehicle.z,
      direction: vehicle.direction,
      pitch: vehicle.pitch,
      speed: Math.round(vehicle.speed),
      status: vehicle.status,
      cargo: {
        type: vehicle.cargoType,
        amount: vehicle.cargoAmount,
        capacity: vehicle.cargoCapacity,
      },
      orderTargets: vehicle.orderTargets.slice(),
      ...(vehicle.orders.length > 0
        ? {
            orderKinds: vehicle.orders
              .filter((order) => order.kind !== 'conditional')
              .map((order) => order.kind),
            orderDetails: vehicle.orders.map((order, index) => ({
              index,
              target: order.target,
              kind: order.kind,
              ...(order.options ? { options: cloneOrderOptions(order.options) } : {}),
            })),
            currentOrder: vehicle.currentOrder,
          }
        : {}),
      profitLastYear: vehicle.profitLastYear,
      ageDays: vehicle.ageDays,
      ...(vehicle.groupId !== null
        ? {
            group: {
              id: vehicle.groupId,
              name:
                world.groups.find((group) => group.id === vehicle.groupId)?.name ??
                defaultGroupName(vehicle.groupId),
            },
          }
        : {}),
      reliability: reliabilitySnapshot(
        vehicle.reliability,
        vehicleMaintenance(vehicle),
        world.tick,
        TICKS_PER_DAY,
      ),
    }));

    const groups: VehicleGroupSnapshot[] = world.groups.map((group) => ({
      id: group.id,
      company: group.company,
      name: group.name,
      kind: group.kind,
      parent: group.parent,
      vehicles: groupVehicleIds(world, group).length,
      autoreplace: group.replaceModel
        ? { model: group.replaceModel, whenOld: group.replaceWhenOld }
        : null,
    }));

    const news = world.news.slice(world.newsCursor);
    world.newsCursor = world.news.length;
    const events = world.events.slice(world.eventCursor);
    world.eventCursor = world.events.length;

    const disasters = world.disasters.map((disaster) => ({
      id: disaster.id,
      kind: disaster.kind,
      x: disaster.x,
      y: disaster.y,
      company: disaster.company,
      ...(disaster.vehicle !== undefined ? { vehicle: disaster.vehicle } : {}),
      ...(disaster.town !== undefined ? { town: disaster.town } : {}),
      ...(disaster.industry !== undefined ? { industry: disaster.industry } : {}),
      severity: disaster.severity,
      startedTick: disaster.startedTick,
      remainingDays: disaster.remainingDays,
    }));

    return {
      meta: { protocol: PROTOCOL_VERSION, tick: world.tick, hash, sequence: world.sequence },
      economy,
      map,
      companies,
      towns,
      industries,
      stations,
      depots,
      signals: world.signalCount > 0 ? signalsFromMap(mapSnapshotView(world)) : [],
      structures,
      vehicles,
      subsidies,
      groups,
      news,
      disasters,
      events,
    };
  }

  send(command: EngineCommand): void {
    const world = this.world;
    if (!world) return;
    switch (command.type) {
      case 'pause':
        world.paused = command.paused;
        break;
      case 'speed':
        world.speed = command.speed;
        world.paused = command.speed === 0;
        break;
      case 'console':
        addNews(world, 'info', `Console : ${command.command}`);
        break;
      case 'build':
        applyBuild(world, command);
        break;
      case 'vehicle':
        applyVehicle(world, command);
        break;
      case 'finance':
        applyFinance(world, command);
        break;
      case 'town_action':
        applyTownAction(world, command);
        break;
      case 'group':
        applyGroup(world, command);
        break;
      default:
        break;
    }
  }

  hash(): string {
    const world = this.world;
    if (!world) return '00000000';
    const hash = new StateHash();
    hash.mixInt(world.tick);
    hash.mixInt(world.year);
    hash.mixInt(world.month);
    hash.mixInt(world.day);
    hash.mixInt(world.tick % TICKS_PER_DAY);
    hash.mixInt(world.paused ? 1 : 0);
    hash.mixInt(world.speed);
    hash.mixFloat(world.inflation);
    hash.mixInt(world.difficulty);
    hash.mixInt(world.interestRate);
    for (const company of world.companies) {
      hash.mixInt(company.id);
      hash.mixFloat(company.money, 1);
      hash.mixInt(company.deliveredToday);
      hash.mixFloat(company.loan, 1);
      hash.mixFloat(company.maxLoan, 1);
      hash.mixInt(company.monthsOfBankruptcy);
      hash.mixInt(company.bankrupt ? 1 : 0);
      hash.mixInt(company.aiLevel ?? 0);
      hash.mixInt(company.aiNextBuildDay ?? -1);
      for (const link of company.aiLinks ?? []) hash.mixString(link);
    }
    hash.mixInt(world.disastersEnabled ? 1 : 0);
    hash.mixInt(world.nextDisasterDay);
    hash.mixInt(world.nextDisasterId);
    for (const disaster of world.disasters) {
      hash.mixInt(disaster.id);
      hash.mixString(disaster.kind);
      hash.mixFloat(disaster.x);
      hash.mixFloat(disaster.y);
      hash.mixInt(disaster.company);
      hash.mixInt(disaster.vehicle ?? 255);
      hash.mixInt(disaster.severity);
      hash.mixInt(disaster.remainingDays);
    }
    for (const town of world.towns) {
      hash.mixInt(town.id);
      hash.mixInt(town.population);
      hash.mixInt(town.buildings);
      hash.mixInt(town.rating);
      hash.mixInt(town.actionMonths.advertise);
      hash.mixInt(town.actionMonths.fund_roads);
      hash.mixInt(town.actionMonths.fund_buildings);
    }
    for (const industry of world.industries) {
      hash.mixInt(industry.id);
      hash.mixInt(industry.production);
      hash.mixInt(industry.transported);
      hash.mixInt(Math.round(industry.stock));
    }
    for (const subsidy of world.subsidies) {
      hash.mixInt(subsidy.id);
      hash.mixString(subsidy.cargo);
      hash.mixInt(subsidy.fromIndustry);
      hash.mixInt(subsidy.toIndustry);
      hash.mixInt(subsidy.remainingMonths);
      hash.mixInt(subsidy.awardedTo ?? 255);
    }
    for (const group of world.groups) {
      hash.mixInt(group.id);
      hash.mixInt(group.company);
      hash.mixString(group.name);
      hash.mixString(group.kind);
      hash.mixInt(group.parent ?? -1);
      hash.mixString(group.replaceModel ?? '');
      hash.mixInt(group.replaceWhenOld ? 1 : 0);
    }
    for (const station of world.stations) {
      hash.mixInt(station.id);
      for (const waiting of station.waiting) hash.mixInt(waiting.amount);
    }
    for (const depot of world.depots) {
      hash.mixInt(depot.id);
      hash.mixInt(depot.company);
      hash.mixString(depot.kind);
      hash.mixInt(depot.x);
      hash.mixInt(depot.y);
      hash.mixInt(depot.direction);
    }
    for (const structure of world.structures) {
      hash.mixInt(structure.id);
      hash.mixString(structure.type);
      hash.mixInt(structure.company);
      hash.mixString(structure.transport);
      hash.mixString(structure.material ?? '');
      hash.mixInt(structure.from.x);
      hash.mixInt(structure.from.y);
      hash.mixInt(structure.to.x);
      hash.mixInt(structure.to.y);
      hash.mixInt(structure.length);
    }
    for (const vehicle of world.vehicles) {
      hash.mixInt(vehicle.id);
      hash.mixString(vehicle.model);
      hash.mixString(vehicle.cargoType);
      hash.mixInt(vehicle.cargoCapacity);
      hash.mixFloat(vehicle.x);
      hash.mixFloat(vehicle.y);
      hash.mixFloat(vehicle.z);
      hash.mixInt(vehicle.direction);
      hash.mixInt(vehicle.status);
      hash.mixInt(vehicle.cargoAmount);
      hash.mixString(vehicle.cargoType);
      hash.mixInt(vehicle.cargoSource ?? 255);
      hash.mixInt(vehicle.groupId ?? 255);
      hash.mixFloat(vehicle.reliability.wear, 1);
      hash.mixString(vehicle.reliability.breakdown);
      hash.mixInt(vehicle.reliability.breakdownTicks);
      hash.mixInt(vehicle.reliability.lastServiceTick ?? -1);
      hash.mixInt(vehicle.reliability.serviceIntervalDays);
      hash.mixInt(vehicle.orders.length);
      hash.mixInt(vehicle.currentOrder);
      for (const order of vehicle.orders) {
        hash.mixInt(order.target);
        hash.mixString(order.kind);
        const options = order.options;
        if (options) {
          hash.mixString(options.action ?? '');
          hash.mixInt(options.jump ?? -1);
          if (options.condition) {
            hash.mixString(options.condition.type);
            hash.mixString(options.condition.comparator);
            hash.mixInt(options.condition.value);
            hash.mixString(options.condition.cargo ?? '');
            hash.mixInt(options.condition.month ?? -1);
          }
          if (options.timetable) {
            hash.mixInt(options.timetable.waitTicks ?? -1);
            hash.mixInt(options.timetable.travelTicks ?? -1);
            hash.mixInt(options.timetable.autostart ? 1 : 0);
          }
        }
      }
    }
    // La carte fait partie de l'état : une construction doit changer le hash
    // pour que le lockstep détecte une divergence de terrain.
    for (const layer of [
      world.kind,
      world.heightMap,
      world.owner,
      world.slope,
      world.flags,
      world.trackBits,
      world.railTypes,
      world.signalData,
    ]) {
      for (let i = 0; i < layer.length; i += 1) hash.mixInt(layer[i] ?? 0);
    }
    // Le sens des routes ne coûte rien tant qu'aucune tuile n'est à sens
    // unique : le compteur suffit à distinguer les deux états.
    hash.mixInt(world.roadCount);
    if (world.roadCount > 0) {
      for (let i = 0; i < world.roadData.length; i += 1) hash.mixInt(world.roadData[i] ?? 0);
    }
    return hash.digest();
  }

  async save(): Promise<Uint8Array> {
    const world = this.world;
    if (!world) throw new Error('MockEngine.save : aucune partie chargée.');
    const payload = JSON.stringify({ v: PROTOCOL_VERSION, world: serializeWorld(world) });
    return new TextEncoder().encode(payload);
  }

  async load(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data);
    const parsed = JSON.parse(text) as { v?: number; world?: SerializedWorld };
    if (!parsed.world) throw new Error('Sauvegarde invalide : monde absent.');
    if (parsed.v !== PROTOCOL_VERSION) {
      throw new Error(
        `Version de sauvegarde ${String(parsed.v)} incompatible avec le protocole ${PROTOCOL_VERSION}.`,
      );
    }
    const saved = parsed.world;
    const expected = saved.width * saved.height;
    const preset = difficultyPreset(saved.difficulty ?? 1);
    const world: MockWorld = {
      seed: saved.seed,
      width: saved.width,
      height: saved.height,
      tick: saved.tick,
      year: saved.year,
      month: saved.month,
      day: saved.day,
      paused: saved.paused,
      speed: saved.speed,
      rngState: saved.rngState,
      inflation: saved.inflation ?? 0,
      difficulty: saved.difficulty ?? 1,
      interestRate: saved.interestRate ?? preset.interestRate,
      loanInterval: saved.loanInterval ?? DEFAULT_LOAN_INTERVAL,
      disastersEnabled: saved.disastersEnabled ?? false,
      disasters: saved.disasters ?? [],
      nextDisasterDay:
        saved.nextDisasterDay ??
        (saved.disastersEnabled === true
          ? (saved.year * MONTHS_PER_YEAR + saved.month) * DAYS_PER_MONTH + saved.day + 10
          : -1),
      nextDisasterId:
        saved.nextDisasterId ??
        (saved.disasters ?? []).reduce((max, disaster) => Math.max(max, disaster.id + 1), 0),
      kind: decodeArray(saved.kind, expected),
      heightMap: decodeArray(saved.heightMap, expected),
      owner: decodeArray(saved.owner, expected),
      slope: decodeArray(saved.slope, expected),
      flags: decodeArray(saved.flags, expected),
      trackBits: decodeArray(saved.trackBits, expected),
      railTypes: saved.railTypes
        ? decodeArray(saved.railTypes, expected)
        : new Uint8Array(expected),
      roadData: saved.roadData ? decodeArray(saved.roadData, expected) : new Uint8Array(expected),
      roadCount: 0,
      signalData: saved.signalData
        ? decodeArray(saved.signalData, expected)
        : new Uint8Array(expected),
      signalCount: saved.signalCount ?? 0,
      companies: saved.companies.map((company) => ({
        ...company,
        maxLoan: company.maxLoan ?? preset.maxLoan,
        monthsOfBankruptcy: company.monthsOfBankruptcy ?? 0,
        interestPaid: company.interestPaid ?? 0,
        ...(company.isAI
          ? {
              aiLevel: clampInt(
                company.aiLevel ?? 1 + Math.min(2, Math.max(0, company.id - 1)),
                1,
                3,
              ),
              aiNextBuildDay:
                company.aiNextBuildDay ??
                (saved.year * MONTHS_PER_YEAR + saved.month) * DAYS_PER_MONTH + saved.day + 5,
              aiLinks: company.aiLinks ?? [],
            }
          : {}),
      })),
      towns: saved.towns.map((town) => ({
        ...town,
        actionMonths: {
          advertise: town.actionMonths?.advertise ?? -1,
          fund_roads: town.actionMonths?.fund_roads ?? -1,
          fund_buildings: town.actionMonths?.fund_buildings ?? -1,
        },
      })),
      industries: saved.industries.map((industry) => {
        const definition = INDUSTRY_DEFINITIONS.find((item) => item.kind === industry.kind);
        return {
          ...industry,
          accepts: industry.accepts ?? definition?.accepts ?? [],
          stock: industry.stock ?? Math.round((industry.production ?? 0) * 0.35),
        };
      }),
      stations: saved.stations,
      depots: saved.depots ?? [],
      structures: saved.structures ?? [],
      vehicles: [],
      subsidies: saved.subsidies ?? [],
      groups: (saved.groups ?? []).map((group) => ({
        ...group,
        parent: group.parent ?? null,
        replaceModel: group.replaceModel ?? null,
        replaceWhenOld: group.replaceWhenOld ?? true,
      })),
      news: saved.news,
      newsCursor: saved.news.length,
      events: [],
      eventCursor: 0,
      mapDirty: true,
      mapSent: false,
      mapVersion: saved.mapVersion + 1,
      sequence: saved.sequence,
    };
    // Recalcule le compteur (sauvegardes antérieures à #156 ou champ absent).
    let signalCount = 0;
    for (const value of world.signalData) if (value !== 0) signalCount += 1;
    world.signalCount = signalCount;
    let roadCount = 0;
    for (const value of world.roadData) if (value !== 0) roadCount += 1;
    world.roadCount = roadCount;
    const validGroups = new Set(world.groups.map((group) => group.id));
    world.vehicles = saved.vehicles.map((vehicle) => {
      const orders =
        vehicle.orders && vehicle.orders.length > 0
          ? vehicle.orders.map((order) => cloneOrder(order))
          : (vehicle.orderTargets ?? []).map((target) => ({
              target,
              kind: 'station' as const,
            }));
      const positional = orders
        .map((order, index) => ({ order, index }))
        .filter((item) => item.order.kind !== 'conditional')
        .map((item) => item.index);
      const currentOrder = positional.includes(vehicle.currentOrder ?? 0)
        ? (vehicle.currentOrder ?? 0)
        : (positional[0] ?? 0);
      const segmentStops =
        vehicle.segmentStops ??
        (vehicle.segmentStations ?? []).map((id) =>
          id >= 0 ? ({ kind: 'station', id } as MockStop) : null,
        );
      return {
        ...vehicle,
        model: vehicle.model ?? '',
        homeDepot: vehicle.homeDepot ?? null,
        segmentStops,
        cargoClass: vehicle.cargoClass ?? vehicle.cargoType,
        cargoSource: vehicle.cargoSource ?? null,
        tripDistance: vehicle.tripDistance ?? 0,
        loadedTick: vehicle.loadedTick ?? 0,
        orders,
        currentOrder,
        routeOrders:
          vehicle.routeOrders && vehicle.routeOrders.length > 0 ? vehicle.routeOrders : positional,
        pathLengths: computePathLengths(vehicle.path),
        groupId:
          vehicle.groupId !== null &&
          vehicle.groupId !== undefined &&
          validGroups.has(vehicle.groupId)
            ? vehicle.groupId
            : null,
        reliability: {
          ...initialReliability(
            clampServiceInterval(
              vehicle.reliability?.serviceIntervalDays ?? (vehicle.kind === 'train' ? 150 : 110),
            ),
          ),
          ...vehicle.reliability,
          breakdown: vehicle.reliability?.breakdown ?? 'none',
          breakdownTicks: vehicle.reliability?.breakdownTicks ?? 0,
          wear: vehicle.reliability?.wear ?? 0,
          lastServiceTick: vehicle.reliability?.lastServiceTick ?? world.tick,
          cooldownDays: vehicle.reliability?.cooldownDays ?? 0,
        },
      };
    });
    if (!saved.depots) world.depots = legacyDepots(world);
    normaliseDepotDirections(world);
    // Recalcule position, direction et tangage (#232) : le mock ne sauvegarde
    // que le chemin, l'orientation est dérivée du segment courant.
    updateVehiclesTransforms(world);
    this.world = world;
    this.ready = true;
    this.loading = false;
    this.progress = 1;
    this.lastError = null;
  }

  status(): EngineStatus {
    const world = this.world;
    return {
      ready: this.ready,
      loading: this.loading,
      progress: this.progress,
      tick: world?.tick ?? 0,
      paused: world?.paused ?? true,
      speed: world?.speed ?? 0,
      lastError: this.lastError,
    };
  }

  dispose(): void {
    this.world = null;
    this.ready = false;
    this.loading = false;
    this.progress = 0;
  }

  /** La partie est-elle chargée ? (utilisé par le bootstrap et les tests) */
  isLoaded(): boolean {
    return this.world !== null;
  }
}
