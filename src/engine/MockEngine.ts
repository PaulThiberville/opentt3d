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
  TILE_FLAG,
  TILE_KIND_INDEX,
  TRACK_BIT_CROSSING_RAIL,
  type CompanySnapshot,
  type DepotSnapshot,
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
  type SignalDirection,
  type StationSnapshot,
  type StructureSnapshot,
  type SubsidySnapshot,
  type TownActionKind,
  type TownActionSnapshot,
  type TownAuthoritySnapshot,
  type TownSnapshot,
  type VehicleKind,
  type VehicleSnapshot,
  type WorldEvent,
  type WorldSnapshot,
} from './protocol';
import { Prng, StateHash, fbm, valueNoise } from '../game/prng';
import { decodeBase64, encodeBase64 } from '../game/base64';
import { sampleHeightWorld } from '../game/mapGrid';
import {
  BANKRUPTCY_MONTHS,
  DEFAULT_LOAN_INTERVAL,
  cargoRate,
  isPassengerCargo,
} from '../game/economyRules';
import {
  BUILD_TOOL_LABELS,
  BRIDGE_MATERIALS,
  BRIDGE_MATERIAL_LABELS,
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
  planSignal,
  planStation,
  planTerraform,
  planTree,
  planTunnel,
} from '../game/buildRules';
import { stationFootprint } from '../game/buildRules';
import {
  depotConnections,
  parseBuildDirection,
  type BridgeMaterial,
  type BuildDirection,
  type BuildTransport,
  type DepotSettings,
  type LockSettings,
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

  kind: Uint8Array;
  heightMap: Uint8Array;
  owner: Uint8Array;
  slope: Uint8Array;
  flags: Uint8Array;
  trackBits: Uint8Array;
  /** Type de rail par tuile (#157). */
  railTypes: Uint8Array;
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
  vehicles: (Omit<MockVehicle, 'pathLengths' | 'segmentStops'> & {
    segmentStops?: (MockStop | null)[];
    /** Ancien format (#29) : arrêts de gare uniquement. */
    segmentStations?: number[];
  })[];
  subsidies?: MockSubsidy[];
  news: MockNews[];
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

function stepDirection(current: number, target: number, maxStep: number): number {
  const delta = ((target - current + 384) % 256) - 128;
  if (Math.abs(delta) <= maxStep) return target & 255;
  return (current + Math.sign(delta) * maxStep + 256) & 255;
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
  for (let i = 0; i < path.length; i += 1) {
    const point = path[i];
    if (!point) continue;
    for (const stop of stops) {
      const dx = point.x - (stop.x + 0.5);
      const dy = point.y - (stop.y + 0.5);
      if (dx * dx + dy * dy <= 1.1) {
        result[i] = { kind: stop.kind, id: stop.id, order: stop.order };
      }
    }
  }
  return result;
}

/**
 * Tracé de tournée : part de la position courante, passe par chaque cible
 * dans l'ordre puis revient au point de départ (boucle aller-retour).
 */
function buildRoutePath(start: P2, targets: readonly P2[]): P2[] {
  const anchor = { x: Math.floor(start.x), y: Math.floor(start.y) };
  const tiles: P2[] = [anchor];
  let cursor = anchor;
  for (const target of targets) {
    const segment = traceTiles(cursor, { x: Math.floor(target.x), y: Math.floor(target.y) });
    for (let i = 1; i < segment.length; i += 1) {
      const point = segment[i];
      if (point) tiles.push(point);
    }
    cursor = { x: Math.floor(target.x), y: Math.floor(target.y) };
  }
  return loopPath(tiles);
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
  const resolved = resolveOrders(world, vehicle.orders, vehicle.currentOrder);
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
  const path = buildRoutePath({ x: vehicle.x, y: vehicle.y }, resolved.targets);
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
  readonly signalData: Uint8Array;

  readonly companies: MockCompany[];
  readonly towns: MockTown[] = [];
  readonly industries: MockIndustry[] = [];
  readonly stations: MockStation[] = [];
  readonly depots: MockDepot[] = [];
  readonly structures: MockStructure[] = [];
  readonly vehicles: MockVehicle[] = [];
  readonly subsidies: MockSubsidy[] = [];

  constructor(options: NewGameOptions, seed: number) {
    this.seed = seed;
    this.width = clampInt(options.width ?? 192, 64, 512);
    this.height = clampInt(options.height ?? 192, 64, 512);
    this.startYear = clampInt(options.startYear ?? 1950, 1, 9999);
    this.difficulty = Math.min(3, Math.max(0, Math.round(options.difficulty ?? 1)));
    this.economy = difficultyPreset(this.difficulty);
    this.rng = new Prng(seed ^ 0x51ed270b);
    const size = this.width * this.height;
    this.kind = new Uint8Array(size);
    this.heightMap = new Uint8Array(size);
    this.owner = new Uint8Array(size).fill(COMPANY_NONE);
    this.flags = new Uint8Array(size);
    this.trackBits = new Uint8Array(size);
    this.railTypes = new Uint8Array(size);
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
        });
      }
    } else {
      this.companies.push(
        {
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
        },
        {
          id: 1,
          name: 'Ligne du Lac',
          president: 'IA · C. Dubois',
          colour: COMPANY_COLOURS[1],
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
        },
      );
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
        this.heightMap[this.index(x, y)] = level;
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

  paintRoute(tiles: P2[], kindIndex: number, owner: number): void {
    for (let i = 0; i < tiles.length; i += 1) {
      const tile = tiles[i];
      if (!tile) continue;
      const index = this.index(tile.x, tile.y);
      const overWater = this.isWater(tile.x, tile.y);
      this.kind[index] = overWater ? K.bridge : kindIndex;
      if (overWater) this.flags[index] = (this.flags[index] ?? 0) | TILE_FLAG.BRIDGE;
      this.owner[index] = owner;
      const previous = tiles[i - 1];
      const next = tiles[i + 1];
      let bits = 0;
      if (previous) bits |= directionBit(tile, previous);
      if (next) bits |= directionBit(tile, next);
      this.trackBits[index] = (this.trackBits[index] ?? 0) | bits;
    }
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
    if (roadA) this.addDepot('road', { x: roadA.x + 4, y: roadA.y + 4 }, 0);
    if (trainA) this.addDepot('rail', { x: trainA.x + 4, y: trainA.y + 4 }, 0);

    // Réseau ferroviaire : gare A ↔ gare B.
    if (trainA && trainB) {
      const tiles = traceTiles({ x: trainA.x, y: trainA.y }, { x: trainB.x, y: trainB.y });
      this.paintRoute(tiles, K.rail, 0);
      const path = loopPath(tiles);
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
      this.paintRoute(tiles, K.road, 0);
      const path = loopPath(tiles);
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
      this.paintRoute(tiles, K.road, 0);
      const path = loopPath(tiles);
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
      kind: this.kind,
      heightMap: this.heightMap,
      owner: this.owner,
      slope: new Uint8Array(this.width * this.height),
      flags: this.flags,
      trackBits: this.trackBits,
      railTypes: this.railTypes,
      signalData: this.signalData,
      signalCount: 0,
      companies: this.companies,
      towns: this.towns,
      industries: this.industries,
      stations: this.stations,
      depots: this.depots,
      structures: this.structures,
      vehicles: this.vehicles,
      subsidies: this.subsidies,
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
  if (!from || !to) return { x: 0, y: 0, dx: 1, dy: 0 };
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
    signalData: world.signalData,
  };
}

function updateVehiclesTransforms(world: MockWorld): void {
  const map = mapSnapshotView(world);
  for (const vehicle of world.vehicles) {
    const position = positionAlong(vehicle);
    vehicle.x = position.x;
    vehicle.y = position.y;
    vehicle.direction = stepDirection(
      vehicle.direction,
      directionFromVector(position.dx, position.dy),
      12,
    );
    const ground = sampleHeightWorld(map, vehicle.x, vehicle.y);
    if (vehicle.kind === 'aircraft') {
      vehicle.z = ground + 6.5 + Math.sin(world.tick * 0.02 + vehicle.id) * 0.4;
    } else if (vehicle.kind === 'ship') {
      vehicle.z = 0.12;
    } else {
      vehicle.z = ground + 0.08;
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
  const footprint = stationFootprint(plan.station ?? settings);
  const resolved = plan.station ?? settings;
  const id = world.stations.length;
  const town = nearestTownName(world, plan.from.x, plan.from.y);
  const baseName = settings.kind === 'rail' ? `Gare de ${town}` : `Arrêt de ${town}`;
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
    kind: settings.kind === 'rail' ? 'train' : 'road',
    x: plan.from.x + footprint.width / 2,
    y: plan.from.y + footprint.height / 2,
    width: footprint.width,
    height: footprint.height,
    waiting: [],
  });
  const message =
    settings.kind === 'rail'
      ? `Gare ferroviaire construite (${resolved.platforms} voie(s) × ${resolved.length} tuile(s)).`
      : settings.driveThrough
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
  const portalHeight = world.heightMap[tileIndex(plan.from.x, plan.from.y, world.width)] ?? 0;
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
  const plan = planBuild({
    map: mapSnapshotView(world),
    tool,
    from: command.from,
    to: command.to,
    axis,
    company: command.company,
    budget: company.money,
    ...(tool === 'rail' ? { railType: railTypeFromCommand(command) } : {}),
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
    } else {
      world.railTypes[tile.index] = 0;
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
    direction: 0,
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

/** Valide et normalise une tournée reçue du client (#161). */
function normalizeOrders(
  world: MockWorld,
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
  const normalized = normalizeOrders(world, command.orders ?? []);
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

  if (vehicle.cargoAmount > 0) {
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

function dailyTick(world: MockWorld): void {
  const rng = Prng.fromState(world.rngState);
  const dayIndex = (world.year * MONTHS_PER_YEAR + world.month) * DAYS_PER_MONTH + world.day;
  updateCompanyEconomy(world);
  growTowns(world, rng, dayIndex);
  growStationCargo(world, rng);
  updateIndustries(world, rng);
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
  for (const vehicle of world.vehicles) moveVehicle(world, vehicle);
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
    })),
    subsidies: world.subsidies,
    news: world.news,
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
    }));

    const news = world.news.slice(world.newsCursor);
    world.newsCursor = world.news.length;
    const events = world.events.slice(world.eventCursor);
    world.eventCursor = world.events.length;

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
      news,
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
      kind: decodeArray(saved.kind, expected),
      heightMap: decodeArray(saved.heightMap, expected),
      owner: decodeArray(saved.owner, expected),
      slope: decodeArray(saved.slope, expected),
      flags: decodeArray(saved.flags, expected),
      trackBits: decodeArray(saved.trackBits, expected),
      railTypes: saved.railTypes
        ? decodeArray(saved.railTypes, expected)
        : new Uint8Array(expected),
      signalData: saved.signalData
        ? decodeArray(saved.signalData, expected)
        : new Uint8Array(expected),
      signalCount: saved.signalCount ?? 0,
      companies: saved.companies.map((company) => ({
        ...company,
        maxLoan: company.maxLoan ?? preset.maxLoan,
        monthsOfBankruptcy: company.monthsOfBankruptcy ?? 0,
        interestPaid: company.interestPaid ?? 0,
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
      };
    });
    if (!saved.depots) world.depots = legacyDepots(world);
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
