/**
 * Règles de construction routière et ferroviaire, partagées par l'aperçu 3D et
 * par `MockEngine`.
 *
 * Module pur (aucun DOM, aucun Three.js) : il transforme un clic ou un drag en
 * tracé de tuiles, valide le terrain et estime le coût. Le moteur reste seul
 * juge : `MockEngine` rejoue exactement ces règles avant de modifier la carte,
 * et le futur pont WASM renverra ses propres erreurs. L'UI ne débite jamais
 * d'argent et n'invente pas de résultat : elle affiche le plan d'aperçu puis
 * relaie le message du moteur.
 *
 * Unités : coordonnées en tuiles entières, hauteurs en demi-niveaux OpenTTD
 * (`heightMap` 0..15). Un écart de 1 niveau vaut 0,5 tuile dans le monde 3D.
 */

import {
  COMPANY_NONE,
  TILE_KIND_INDEX,
  type EngineCommand,
  type MapSnapshot,
  type RailType,
  type SignalDirection,
  type SignalKind,
  type SignalTrack,
  type TileKind,
} from '../engine/protocol';
import { MAX_HEIGHT_LEVEL, TILE_KINDS, tileIndex } from './mapGrid';
import { RAIL_TYPE_SURCHARGE, RAIL_TYPE_CONVERT_COST, parseRailType } from './railRules';
import { SIGNAL_CONVERT_COST, SIGNAL_KIND_COST, SIGNAL_REMOVE_COST } from './signalRules';

export type { SignalTrack };

export type BuildTool =
  | 'road'
  | 'rail'
  | 'clear'
  | 'station'
  | 'depot'
  | 'signal'
  | 'unsignal'
  | 'convert'
  | 'terraform'
  | 'tree'
  | 'canal'
  | 'lock'
  | 'aqueduct'
  | 'crossing';

/** Outils qui tracent un chemin de tuiles (route, rail, canal, démolition). */
export type PathBuildTool = 'road' | 'rail' | 'clear' | 'canal';

/** Sens d'un terrassement (#158). */
export type TerraformDirection = 'up' | 'down';

/** Axe du premier segment du tracé en L (`x` = horizontal puis vertical). */
export type BuildAxis = 'x' | 'y';

/** Infrastructure posée sur un réseau ferroviaire ou routier. */
export type BuildTransport = 'rail' | 'road';

/**
 * Orientation d'une diagonale OpenTTD : `ne`, `se`, `sw`, `nw` (0..3).
 * Une gare ferroviaire dont la longueur suit X utilise `ne` ou `sw` ;
 * une gare dont la longueur suit Y utilise `nw` ou `se`.
 */
export type BuildDirection = 'ne' | 'se' | 'sw' | 'nw';

/** Réglages d'une voie ferrée neuve ou convertie (#157). */
export interface RailSettings {
  type: RailType;
}

export interface StationSettings {
  kind: BuildTransport;
  /** Nombre de quais (1..8). Ignoré pour une gare routière. */
  platforms: number;
  /** Longueur des quais en tuiles (1..16). Ignorée pour une gare routière. */
  length: number;
  direction: BuildDirection;
  /** Gare routière en passage (drive-through). */
  driveThrough: boolean;
}

export interface DepotSettings {
  kind: BuildTransport;
  /** `null` = orientation détectée sur la voie voisine, sinon `se`. */
  direction: BuildDirection | null;
}

export interface SignalSettings {
  type: SignalKind;
  track: SignalTrack | null;
  /** Sens du signal : unique (défaut) ou bidirectionnel. */
  direction: SignalDirection;
  /** Un signal tous les N tuiles lors d'un glissement (1..8). */
  spacing: number;
}

/** Terrassement : sens et taille du carré posé au survol (#158). */
export interface TerraformSettings {
  direction: TerraformDirection;
  /** Côté du carré en tuiles (1..4). */
  size: number;
}

/** Plantation d'arbres : côté du carré en tuiles (1..4). */
export interface TreeSettings {
  size: number;
}

/** Écluse : orientation forcée ou détection sur le canal voisin. */
export interface LockSettings {
  direction: BuildDirection | null;
}

export interface BuildSettings {
  station: StationSettings;
  depot: DepotSettings;
  signal: SignalSettings;
  terraform: TerraformSettings;
  tree: TreeSettings;
  lock: LockSettings;
  rail: RailSettings;
}

export const STATION_MAX_PLATFORMS = 8;
export const STATION_MAX_LENGTH = 16;

/** Coût de base par tuile d'emprise (terrassement non compris). */
export const STATION_COST_PER_TILE: Record<BuildTransport, number> = {
  rail: 650,
  road: 480,
};

export const DEPOT_COST: Record<BuildTransport, number> = {
  rail: 720,
  road: 520,
};

/** Signal de bloc simple (pose sur une voie existante). */
export const SIGNAL_COST = SIGNAL_KIND_COST.block;

/** Coût de base d'une tuile de rail classique, hors surcoût de type. */
export const RAIL_COST_PER_TILE = 400;

export function railBuildCost(type: RailType): number {
  return RAIL_COST_PER_TILE + RAIL_TYPE_SURCHARGE[type];
}

export function railConvertCost(type: RailType): number {
  return RAIL_TYPE_CONVERT_COST[type];
}

/** Terrassement (#158) : coût de base par tuile et par niveau. */
export const TERRAFORM_COST_PER_TILE = 120;
/** Surcoût par voisin de hauteur différente (ouvrage en flanc de coteau). */
export const TERRAFORM_SLOPE_COST = 40;
export const TERRAFORM_MAX_SIZE = 4;
export const TERRAFORM_MAX_TILES = 256;

/** Plantation d'arbres (#158). */
export const TREE_COST = 90;
export const TREE_MAX_SIZE = 4;
export const TREE_MAX_TILES = 256;

/** Canal (#158) : creusement et fond. */
export const CANAL_COST_PER_TILE = 200;
export const CANAL_EXCAVATION_COST = 90;

/** Écluse (#158). */
export const LOCK_COST = 1400;

/** Aqueduc (#158) : tablier et piles facturés à la tuile. */
export const AQUEDUCT_COST_PER_TILE = 520;
export const AQUEDUCT_MAX_TILES = 32;

/** Passage à niveau (#159). */
export const CROSSING_COST = 640;
export const CROSSING_MAX_TILES = 16;

export const DIRECTION_ORDER: readonly BuildDirection[] = ['ne', 'se', 'sw', 'nw'];

export const DIRECTION_LABELS: Record<BuildDirection, string> = {
  ne: 'nord-est',
  se: 'sud-est',
  sw: 'sud-ouest',
  nw: 'nord-ouest',
};

/** Table de correspondance direction nommée ↔ index OpenTTD (0..3). */
export function directionFromIndex(index: number): BuildDirection {
  const normalized = ((Math.round(index) % 4) + 4) % 4;
  return DIRECTION_ORDER[normalized] ?? 'ne';
}

export function directionToIndex(direction: BuildDirection): number {
  const index = DIRECTION_ORDER.indexOf(direction);
  return index < 0 ? 0 : index;
}

/** Lit `ne|se|sw|nw|x|y|0..3` ; renvoie `null` si la valeur est inconnue. */
export function parseBuildDirection(value: unknown): BuildDirection | null {
  if (typeof value === 'number' && Number.isFinite(value)) return directionFromIndex(value);
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'ne' || text === 'x' || text === 'ne-sw') return 'ne';
  if (text === 'sw') return 'sw';
  if (text === 'nw' || text === 'y' || text === 'nw-se') return 'nw';
  if (text === 'se') return 'se';
  const numeric = Number(text);
  return Number.isFinite(numeric) ? directionFromIndex(numeric) : null;
}

/** Axe d'une gare/dépôt : `ne`/`sw` suivent X, `nw`/`se` suivent Y. */
export function directionAxis(direction: BuildDirection): BuildAxis {
  return direction === 'ne' || direction === 'sw' ? 'x' : 'y';
}

export function nextDirection(direction: BuildDirection): BuildDirection {
  return DIRECTION_ORDER[(directionToIndex(direction) + 1) % DIRECTION_ORDER.length] ?? 'ne';
}

export function createBuildSettings(): BuildSettings {
  return {
    station: {
      kind: 'rail',
      platforms: 1,
      length: 3,
      direction: 'ne',
      driveThrough: false,
    },
    depot: { kind: 'rail', direction: null },
    signal: { type: 'block', track: null, direction: 'one-way', spacing: 1 },
    terraform: { direction: 'up', size: 1 },
    tree: { size: 1 },
    lock: { direction: null },
    rail: { type: 'rail' },
  };
}

/** Copie superficielle sûre : les sous-objets ne sont jamais partagés. */
export function cloneBuildSettings(settings: BuildSettings): BuildSettings {
  return {
    station: { ...settings.station },
    depot: { ...settings.depot },
    signal: { ...settings.signal },
    terraform: { ...settings.terraform },
    tree: { ...settings.tree },
    lock: { ...settings.lock },
    rail: { ...settings.rail },
  };
}

export interface BuildPoint {
  x: number;
  y: number;
}

/** Bits de connexion d'une tuile de voie : 1 nord, 2 est, 4 sud, 8 ouest. */
export const CONNECT_NORTH = 1;
export const CONNECT_EAST = 2;
export const CONNECT_SOUTH = 4;
export const CONNECT_WEST = 8;

export const BUILD_COST_PER_TILE: Record<PathBuildTool, number> = {
  road: 120,
  rail: 400,
  clear: 40,
  canal: CANAL_COST_PER_TILE,
};

/** Surcoût par demi-niveau de dénivelé franchi (terrassement). */
export const BUILD_SLOPE_COST = 80;

/** Dénivelé maximal entre deux tuiles consécutives (demi-niveaux). */
export const MAX_HEIGHT_STEP = 1;

/** Longueur maximale d'un tronçon en tuiles (protège l'aperçu et le moteur). */
export const MAX_BUILD_TILES = 128;

export const BUILD_TOOL_LABELS: Record<BuildTool, string> = {
  road: 'Route',
  rail: 'Rail',
  clear: 'Démolition',
  station: 'Gare',
  depot: 'Dépôt',
  signal: 'Signal',
  terraform: 'Terrassement',
  tree: 'Arbres',
  canal: 'Canal',
  lock: 'Écluse',
  aqueduct: 'Aqueduc',
  crossing: 'Passage à niveau',
  unsignal: 'Retirer signal',
  convert: 'Type de rail',
};

export interface BuildPlanTile {
  x: number;
  y: number;
  /** Index dans les tableaux de la carte (`y * width + x`). */
  index: number;
  kind: TileKind;
  /** Hauteur brute du snapshot (demi-niveaux). */
  height: number;
  /** Hauteur du centre de la tuile en unités monde 3D. */
  ground: number;
  /** Bits de connexion du tracé (0 pour une démolition). */
  connections: number;
  /** Coût de cette tuile, terrassement compris. */
  cost: number;
}

export interface BuildPlan {
  tool: BuildTool;
  from: BuildPoint;
  to: BuildPoint;
  axis: BuildAxis;
  tiles: BuildPlanTile[];
  cost: number;
  /** `true` si le moteur accepterait le tracé (au budget près). */
  valid: boolean;
  /** Premier motif d'invalidité, prêt pour l'UI (français). */
  reason: string | null;
  /** Réglages résolus d'une gare, d'un dépôt ou d'un signal. */
  station?: StationSettings;
  depot?: { kind: BuildTransport; direction: BuildDirection };
  signal?: SignalSettings;
  /** Terrassement prévu (#158). */
  terraform?: { direction: TerraformDirection; size: number };
  /** Plantation prévue (#158). */
  tree?: { size: number };
  /** Écluse résolue (#158). */
  lock?: { direction: BuildDirection; upper: number; lower: number };
  /** Aqueduc résolu (#158). */
  aqueduct?: { axis: BuildAxis; level: number };
  /** Passage à niveau résolu (#159). */
  crossing?: { network: BuildTransport; axis: BuildAxis };
  /** Niveau d'eau visé par un canal ou un aqueduc (demi-niveaux). */
  waterLevel?: number;
  /** Type de rail posé ou visé par une conversion (#157). */
  railType?: RailType;
}

export interface BuildPlanOptions {
  map: MapSnapshot;
  tool: PathBuildTool;
  from: BuildPoint;
  to?: BuildPoint;
  axis?: BuildAxis;
  /** Entreprise qui construit : contrôle la propriété lors d'une démolition. */
  company?: number;
  /** Trésorerie disponible : permet d'annoncer un manque de fonds. */
  budget?: number;
  maxTiles?: number;
  /** Type de rail pour l'outil `rail` (#157), `rail` par défaut. */
  railType?: RailType;
}

/** Coordonnée de tuile entière, bornée à la carte par l'appelant. */
export function buildTile(point: BuildPoint): BuildPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function inBounds(map: MapSnapshot, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

function directionBit(from: BuildPoint, to: BuildPoint): number {
  if (to.x > from.x) return CONNECT_EAST;
  if (to.x < from.x) return CONNECT_WEST;
  if (to.y > from.y) return CONNECT_SOUTH;
  return CONNECT_NORTH;
}

/**
 * Tracé en L entre deux tuiles. `axis` choisit le premier segment ; il est
 * transmis au moteur via `options.axis` pour que l'aperçu et l'état construit
 * soient identiques.
 */
export function traceBuildPath(
  from: BuildPoint,
  to: BuildPoint,
  axis: BuildAxis = 'x',
): BuildPoint[] {
  const start = buildTile(from);
  const end = buildTile(to);
  const points: BuildPoint[] = [{ ...start }];
  let x = start.x;
  let y = start.y;
  const stepX = (): void => {
    while (x !== end.x) {
      x += Math.sign(end.x - x);
      points.push({ x, y });
    }
  };
  const stepY = (): void => {
    while (y !== end.y) {
      y += Math.sign(end.y - y);
      points.push({ x, y });
    }
  };
  if (axis === 'y') {
    stepY();
    stepX();
  } else {
    stepX();
    stepY();
  }
  return points;
}

/** Nombre de tuiles distinctes d'un tracé (le point de départ compte). */
export function pathLength(from: BuildPoint, to: BuildPoint): number {
  const dx = Math.abs(Math.round(to.x) - Math.round(from.x));
  const dy = Math.abs(Math.round(to.y) - Math.round(from.y));
  return dx + dy + 1;
}

/** Axe naturel d'un drag : l'axe dominant est parcouru en premier. */
export function axisForDrag(from: BuildPoint, to: BuildPoint): BuildAxis {
  const dx = Math.abs(Math.round(to.x) - Math.round(from.x));
  const dy = Math.abs(Math.round(to.y) - Math.round(from.y));
  return dx >= dy ? 'x' : 'y';
}

function occupancyReason(kind: TileKind, tool: BuildTool): string | null {
  if (tool === 'clear') {
    if (
      kind === 'road' ||
      kind === 'rail' ||
      kind === 'bridge' ||
      kind === 'station' ||
      kind === 'trees' ||
      kind === 'canal' ||
      kind === 'lock' ||
      kind === 'aqueduct' ||
      kind === 'crossing'
    ) {
      return null;
    }
    return 'Aucune voie ou construction à démolir sur cette tuile.';
  }
  switch (kind) {
    case 'void':
      return 'Tuile vide : terrain inconstructible.';
    case 'water':
    case 'river':
    case 'canal':
    case 'lock':
      return 'Impossible de construire sur l’eau (ponts à venir).';
    case 'house':
      return 'Impossible de construire sur un bâtiment.';
    case 'industry':
      return 'Impossible de construire sur une industrie.';
    case 'station':
      return 'Impossible de construire sur une gare.';
    case 'airport':
      return 'Impossible de construire sur un aéroport.';
    case 'dock':
      return 'Impossible de construire sur un quai.';
    case 'object':
      return 'Un objet occupe cette tuile.';
    case 'bridge':
    case 'tunnel':
    case 'aqueduct':
      return 'Un ouvrage occupe cette tuile.';
    case 'rail':
      return tool === 'rail' ? 'Voie déjà construite.' : 'Croisement rail/route à venir.';
    case 'road':
      return tool === 'road' ? 'Voie déjà construite.' : 'Croisement route/rail à venir.';
    case 'crossing':
      return 'Un passage à niveau occupe cette tuile.';
    default:
      return null;
  }
}

function tileCost(tool: PathBuildTool, heightDelta: number, railType: RailType = 'rail'): number {
  const slope = tool === 'clear' ? 0 : Math.abs(heightDelta) * BUILD_SLOPE_COST;
  if (tool === 'rail') return railBuildCost(railType) + slope;
  return BUILD_COST_PER_TILE[tool] + slope;
}

/**
 * Construit le plan d'aperçu : tuiles, connexions, coût cumulé et premier motif
 * d'invalidité. Un plan invalide conserve ses tuiles pour que le fantôme puisse
 * rester affiché en rouge jusqu'à la tuile fautive.
 */
export function planBuild(options: BuildPlanOptions): BuildPlan {
  const map = options.map;
  const tool = options.tool;
  const from = buildTile(options.from);
  const to = buildTile(options.to ?? options.from);
  const axis = options.axis ?? axisForDrag(from, to);
  const maxTiles = Math.max(1, options.maxTiles ?? MAX_BUILD_TILES);
  const railType: RailType = tool === 'rail' ? (options.railType ?? 'rail') : 'rail';
  const empty: BuildPlan = {
    tool,
    from,
    to,
    axis,
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
    ...(tool === 'rail' ? { railType } : {}),
  };

  if (!inBounds(map, from.x, from.y) || !inBounds(map, to.x, to.y)) {
    return { ...empty, reason: 'Tracé hors de la carte.' };
  }

  const points = traceBuildPath(from, to, axis);
  if (points.length > maxTiles) {
    return {
      ...empty,
      reason: `Tronçon trop long (${points.length} tuiles, ${maxTiles} maximum).`,
    };
  }

  const tiles: BuildPlanTile[] = [];
  let cost = 0;
  let reason: string | null = null;
  let previousHeight: number | null = null;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point) continue;
    const index = tileIndex(point.x, point.y, map.width);
    const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
    const height = map.heightMap[index] ?? 0;
    const owner = map.owner[index] ?? COMPANY_NONE;
    const previous = points[i - 1];
    const next = points[i + 1];
    let connections = 0;
    if (tool !== 'clear') {
      if (previous) connections |= directionBit(point, previous);
      if (next) connections |= directionBit(point, next);
      // Une tuile isolée reste une route droite est-ouest, lisible en 3D.
      if (connections === 0) connections = CONNECT_EAST | CONNECT_WEST;
    }

    const heightDelta = previousHeight === null ? 0 : height - previousHeight;
    const costOfTile = tileCost(tool, heightDelta, railType);
    cost += costOfTile;

    let tileReason = occupancyReason(kind, tool);
    if (
      !tileReason &&
      tool === 'clear' &&
      options.company !== undefined &&
      options.company !== COMPANY_NONE &&
      owner !== COMPANY_NONE &&
      owner !== options.company
    ) {
      tileReason = 'Voie appartenant à une autre entreprise.';
    }
    if (!tileReason && tool !== 'clear' && Math.abs(heightDelta) > MAX_HEIGHT_STEP) {
      tileReason = 'Pente trop raide (0,5 tuile de dénivelé maximum).';
    }
    if (tileReason) reason = reason ?? tileReason;

    tiles.push({
      x: point.x,
      y: point.y,
      index,
      kind,
      height,
      ground: height * 0.5,
      connections,
      cost: costOfTile,
    });
    previousHeight = height;
  }

  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }

  return {
    tool,
    from,
    to,
    axis,
    tiles,
    cost,
    valid: reason === null,
    reason,
    ...(tool === 'rail' ? { railType } : {}),
  };
}

/** Commande `EngineCommand.build` correspondant à un plan validé. */
export function commandFromPlan(
  plan: BuildPlan,
  company: number,
): Extract<EngineCommand, { type: 'build' }> {
  const single = plan.from.x === plan.to.x && plan.from.y === plan.to.y;
  const base = {
    type: 'build' as const,
    tool: plan.tool,
    company,
    from: { x: plan.from.x, y: plan.from.y },
    ...(single ? {} : { to: { x: plan.to.x, y: plan.to.y } }),
  };

  if (plan.tool === 'station') {
    const station = plan.station;
    return {
      ...base,
      options: station
        ? {
            kind: station.kind,
            platforms: station.platforms,
            length: station.length,
            direction: station.direction,
            axis: directionAxis(station.direction),
            ...(station.kind === 'road' ? { drive_through: station.driveThrough } : {}),
          }
        : { axis: plan.axis },
    };
  }
  if (plan.tool === 'depot') {
    return {
      ...base,
      options: {
        kind: plan.depot?.kind ?? 'rail',
        ...(plan.depot ? { direction: plan.depot.direction } : {}),
      },
    };
  }
  if (plan.tool === 'signal') {
    const settings = plan.signal;
    return {
      ...base,
      options: {
        type: settings?.type ?? 'block',
        direction: settings?.direction ?? 'one-way',
        spacing: settings?.spacing ?? 1,
        ...(settings?.track ? { track: settings.track } : {}),
      },
    };
  }
  if (plan.tool === 'terraform') {
    return {
      ...base,
      options: {
        direction: plan.terraform?.direction ?? 'up',
        size: plan.terraform?.size ?? 1,
      },
    };
  }
  if (plan.tool === 'tree') {
    return { ...base, options: { size: plan.tree?.size ?? 1 } };
  }
  if (plan.tool === 'lock') {
    return {
      ...base,
      options: { direction: plan.lock?.direction ?? 'ne' },
    };
  }
  if (plan.tool === 'crossing') {
    return {
      ...base,
      options: {
        axis: plan.crossing?.axis ?? plan.axis,
        network: plan.crossing?.network ?? 'rail',
      },
    };
  }
  if (plan.tool === 'aqueduct') {
    return { ...base, options: { axis: plan.aqueduct?.axis ?? plan.axis } };
  }
  if (plan.tool === 'canal') {
    return {
      ...base,
      options: {
        axis: plan.axis,
        order: plan.axis === 'y' ? 'vertical' : 'horizontal',
      },
    };
  }
  if (plan.tool === 'unsignal') {
    return { ...base, options: {} };
  }
  if (plan.tool === 'convert') {
    return { ...base, options: { railType: plan.railType ?? 'rail' } };
  }
  if (plan.tool === 'rail') {
    return {
      ...base,
      options: {
        axis: plan.axis,
        ...(plan.railType && plan.railType !== 'rail' ? { railType: plan.railType } : {}),
      },
    };
  }
  return { ...base, options: { axis: plan.axis } };
}

/** `true` si la tuile peut recevoir une voie du type demandé. */
export function isBuildableTile(map: MapSnapshot, x: number, y: number, tool: BuildTool): boolean {
  if (!inBounds(map, x, y)) return false;
  const index = tileIndex(x, y, map.width);
  const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
  return occupancyReason(kind, tool) === null;
}

// ---------------------------------------------------------------------------
// Gares, dépôts et signaux
// ---------------------------------------------------------------------------

/** Emprise d'une gare : `width` × `height` en tuiles, ancrée sur `from`. */
export function stationFootprint(settings: StationSettings): { width: number; height: number } {
  if (settings.kind === 'road') return { width: 1, height: 1 };
  const platforms = Math.max(1, Math.min(STATION_MAX_PLATFORMS, Math.round(settings.platforms)));
  const length = Math.max(1, Math.min(STATION_MAX_LENGTH, Math.round(settings.length)));
  // OpenTTD : AXIS_X → largeur = longueur, hauteur = quais ; AXIS_Y l'inverse.
  return directionAxis(settings.direction) === 'x'
    ? { width: length, height: platforms }
    : { width: platforms, height: length };
}

function infrastructureReason(kind: TileKind, tool: 'station' | 'depot'): string | null {
  const noun = tool === 'station' ? 'une gare' : 'un dépôt';
  switch (kind) {
    case 'void':
    case 'water':
    case 'river':
    case 'canal':
      return `Impossible de construire ${noun} sur l’eau.`;
    case 'house':
      return `Impossible de construire ${noun} sur un bâtiment.`;
    case 'industry':
      return `Impossible de construire ${noun} sur une industrie.`;
    case 'station':
      return 'Une gare occupe déjà cette tuile.';
    case 'airport':
      return `Impossible de construire ${noun} sur un aéroport.`;
    case 'dock':
      return `Impossible de construire ${noun} sur un quai.`;
    case 'object':
      return 'Un objet occupe cette tuile.';
    case 'bridge':
    case 'tunnel':
      return 'Un ouvrage occupe cette tuile.';
    case 'rail':
    case 'road':
      return tool === 'depot'
        ? 'Une voie occupe déjà cette tuile (choisissez une tuile voisine).'
        : null;
    default:
      return null;
  }
}

/** Bits de connexion d'une tuile de gare le long de son axe de longueur. */
function stationConnections(
  x: number,
  y: number,
  left: number,
  top: number,
  width: number,
  height: number,
  axis: BuildAxis,
): number {
  if (axis === 'x') {
    const bits = (x > left ? CONNECT_WEST : 0) | (x < left + width - 1 ? CONNECT_EAST : 0);
    return bits === 0 ? CONNECT_EAST | CONNECT_WEST : bits;
  }
  const bits = (y > top ? CONNECT_NORTH : 0) | (y < top + height - 1 ? CONNECT_SOUTH : 0);
  return bits === 0 ? CONNECT_NORTH | CONNECT_SOUTH : bits;
}

/** Connexions d'une tuile de dépôt : la voie traverse la tuile selon l'axe. */
export function depotConnections(direction: BuildDirection): number {
  return directionAxis(direction) === 'x'
    ? CONNECT_EAST | CONNECT_WEST
    : CONNECT_NORTH | CONNECT_SOUTH;
}

function overbuildReason(
  map: MapSnapshot,
  kind: TileKind,
  index: number,
  tool: 'station',
  settings: StationSettings,
): string | null {
  if (kind === 'rail') {
    if (settings.kind !== 'rail') return 'Une voie ferrée occupe cette tuile.';
    const bits = map.trackBits[index] ?? 0;
    const axis = directionAxis(settings.direction);
    const alongX = (bits & (CONNECT_EAST | CONNECT_WEST)) !== 0;
    const alongY = (bits & (CONNECT_NORTH | CONNECT_SOUTH)) !== 0;
    if ((axis === 'x' && !alongX && alongY) || (axis === 'y' && !alongY && alongX)) {
      return 'Voie existante mal orientée : pivotez la gare avec R.';
    }
    return null;
  }
  if (kind === 'road') {
    if (settings.kind !== 'road') return 'Une route occupe cette tuile.';
    if (!settings.driveThrough) return 'Une route occupe cette tuile (cochez « en passage »).';
    const bits = map.trackBits[index] ?? 0;
    const axis = directionAxis(settings.direction);
    const alongX = (bits & (CONNECT_EAST | CONNECT_WEST)) !== 0;
    const alongY = (bits & (CONNECT_NORTH | CONNECT_SOUTH)) !== 0;
    if ((axis === 'x' && !alongX && alongY) || (axis === 'y' && !alongY && alongX)) {
      return 'Route mal orientée pour une gare en passage : pivotez avec R.';
    }
  }
  return null;
}

interface InfrastructureOptions {
  map: MapSnapshot;
  from: BuildPoint;
  company?: number;
  budget?: number;
}

export interface StationPlanOptions extends InfrastructureOptions {
  settings: StationSettings;
}

export interface DepotPlanOptions extends InfrastructureOptions {
  settings: DepotSettings;
}

export interface SignalPlanOptions extends InfrastructureOptions {
  settings: SignalSettings;
  to?: BuildPoint;
  axis?: BuildAxis;
}

function emptyInfrastructurePlan(
  tool: 'station' | 'depot' | 'signal' | 'unsignal' | 'convert',
  from: BuildPoint,
  to: BuildPoint,
  axis: BuildAxis,
): BuildPlan {
  return { tool, from, to, axis, tiles: [], cost: 0, valid: false, reason: null };
}

/** Plan d'une gare ferroviaire multi-tuiles ou d'une gare routière. */
export function planStation(options: StationPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const settings: StationSettings = {
    ...options.settings,
    platforms: Math.max(1, Math.min(STATION_MAX_PLATFORMS, Math.round(options.settings.platforms))),
    length: Math.max(1, Math.min(STATION_MAX_LENGTH, Math.round(options.settings.length))),
  };
  const axis = directionAxis(settings.direction);
  const footprint = stationFootprint(settings);
  const plan = emptyInfrastructurePlan('station', from, from, axis);
  plan.station = settings;

  const left = from.x;
  const top = from.y;
  const right = left + footprint.width - 1;
  const bottom = top + footprint.height - 1;
  if (!inBounds(map, left, top) || !inBounds(map, right, bottom)) {
    return { ...plan, reason: 'Gare hors de la carte.' };
  }

  const anchorHeight = map.heightMap[tileIndex(left, top, map.width)] ?? 0;
  const costPerTile = STATION_COST_PER_TILE[settings.kind];
  let reason: string | null = null;
  let cost = 0;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = tileIndex(x, y, map.width);
      const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
      const height = map.heightMap[index] ?? 0;
      const connections =
        settings.kind === 'rail'
          ? stationConnections(x, y, left, top, footprint.width, footprint.height, axis)
          : settings.driveThrough
            ? depotConnections(settings.direction)
            : 0;
      const owner = map.owner[index] ?? COMPANY_NONE;
      const tileReason =
        infrastructureReason(kind, 'station') ??
        overbuildReason(map, kind, index, 'station', settings) ??
        (options.company !== undefined &&
        options.company !== COMPANY_NONE &&
        (kind === 'rail' || kind === 'road') &&
        owner !== COMPANY_NONE &&
        owner !== options.company
          ? 'La voie appartient à une autre entreprise.'
          : null) ??
        (Math.abs(height - anchorHeight) > MAX_HEIGHT_STEP
          ? 'Terrain trop accidenté pour une gare.'
          : null);
      if (tileReason) reason = reason ?? tileReason;
      cost += costPerTile;
      plan.tiles.push({
        x,
        y,
        index,
        kind,
        height,
        ground: height * 0.5,
        connections,
        cost: costPerTile,
      });
    }
  }

  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

function neighbourDirection(
  map: MapSnapshot,
  x: number,
  y: number,
  kind: TileKind,
): BuildDirection | null {
  const neighbours: { dx: number; dy: number; direction: BuildDirection }[] = [
    { dx: 1, dy: 0, direction: 'ne' },
    { dx: -1, dy: 0, direction: 'sw' },
    { dx: 0, dy: 1, direction: 'se' },
    { dx: 0, dy: -1, direction: 'nw' },
  ];
  for (const neighbour of neighbours) {
    if (!inBounds(map, x + neighbour.dx, y + neighbour.dy)) continue;
    const index = tileIndex(x + neighbour.dx, y + neighbour.dy, map.width);
    if ((TILE_KINDS[map.kind[index] ?? 0] ?? 'void') === kind) return neighbour.direction;
  }
  return null;
}

/** Plan d'un dépôt route/rail ; l'orientation suit la voie voisine si possible. */
export function planDepot(options: DepotPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const kind: TileKind = options.settings.kind === 'rail' ? 'rail' : 'road';
  const detected = neighbourDirection(map, from.x, from.y, kind);
  const direction = options.settings.direction ?? detected ?? 'se';
  const plan = emptyInfrastructurePlan('depot', from, from, directionAxis(direction));
  plan.depot = { kind: options.settings.kind, direction };

  if (!inBounds(map, from.x, from.y)) return { ...plan, reason: 'Dépôt hors de la carte.' };
  const index = tileIndex(from.x, from.y, map.width);
  const tileKind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
  const height = map.heightMap[index] ?? 0;
  const cost = DEPOT_COST[options.settings.kind];
  let reason = infrastructureReason(tileKind, 'depot');
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  plan.tiles.push({
    x: from.x,
    y: from.y,
    index,
    kind: tileKind,
    height,
    ground: height * 0.5,
    connections: depotConnections(direction),
    cost,
  });
  return { ...plan, cost, valid: reason === null, reason };
}

function traceSignalTiles(
  from: BuildPoint,
  to: BuildPoint,
): { points: BuildPoint[]; axis: BuildAxis } | null {
  if (from.x !== to.x && from.y !== to.y) return null;
  const axis: BuildAxis = from.x !== to.x ? 'x' : 'y';
  const points: BuildPoint[] = [];
  const stepX = Math.sign(to.x - from.x);
  const stepY = Math.sign(to.y - from.y);
  let x = from.x;
  let y = from.y;
  points.push({ x, y });
  while (x !== to.x || y !== to.y) {
    if (axis === 'x') x += stepX;
    else y += stepY;
    points.push({ x, y });
  }
  return { points, axis };
}

/** Plan d'un ou plusieurs signaux le long d'une voie existante. */
export function planSignal(options: SignalPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const to = buildTile(options.to ?? options.from);
  const traced = traceSignalTiles(from, to);
  const axis = traced?.axis ?? options.axis ?? 'x';
  const plan = emptyInfrastructurePlan('signal', from, to, axis);
  const settings: SignalSettings = {
    ...options.settings,
    spacing: Math.max(1, Math.min(8, Math.round(options.settings.spacing || 1))),
  };
  plan.signal = { ...settings };

  if (!traced) {
    return { ...plan, reason: 'Un alignement de signaux doit suivre X ou Y.' };
  }
  if (traced.points.length > MAX_BUILD_TILES) {
    return {
      ...plan,
      reason: `Trop de signaux (${traced.points.length}, ${MAX_BUILD_TILES} maximum).`,
    };
  }

  let reason: string | null = null;
  let cost = 0;
  for (let i = 0; i < traced.points.length; i += 1) {
    const point = traced.points[i];
    if (!point) continue;
    // Densité : un signal toutes les `spacing` tuiles en partant du début.
    if (i % settings.spacing !== 0) continue;
    if (!inBounds(map, point.x, point.y)) {
      reason = reason ?? 'Signal hors de la carte.';
      continue;
    }
    const index = tileIndex(point.x, point.y, map.width);
    const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
    const height = map.heightMap[index] ?? 0;
    const owner = map.owner[index] ?? COMPANY_NONE;
    const existing = map.signalData?.[index] ?? 0;
    let tileReason: string | null = null;
    if (kind !== 'rail') tileReason = 'Un signal exige une voie ferrée sur la tuile.';
    else if (
      options.company !== undefined &&
      options.company !== COMPANY_NONE &&
      owner !== options.company
    ) {
      tileReason = 'La voie appartient à une autre entreprise.';
    }
    if (tileReason) reason = reason ?? tileReason;
    const costOfTile = existing !== 0 ? SIGNAL_CONVERT_COST : SIGNAL_KIND_COST[settings.type];
    cost += costOfTile;
    plan.tiles.push({
      x: point.x,
      y: point.y,
      index,
      kind,
      height,
      ground: height * 0.5,
      connections: map.trackBits[index] ?? 0,
      cost: costOfTile,
    });
  }

  if (plan.tiles.length === 0 && !reason) {
    reason = 'Aucun signal à poser sur ce tracé.';
  }
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

/** Plan de retrait d'un ou plusieurs signaux (la voie reste en place). */
export function planRemoveSignal(options: SignalPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const to = buildTile(options.to ?? options.from);
  const traced = traceSignalTiles(from, to);
  const axis = traced?.axis ?? options.axis ?? 'x';
  const plan = emptyInfrastructurePlan('unsignal', from, to, axis);
  plan.signal = { ...options.settings };

  if (!traced) {
    return { ...plan, reason: 'Un alignement de signaux doit suivre X ou Y.' };
  }
  if (traced.points.length > MAX_BUILD_TILES) {
    return {
      ...plan,
      reason: `Trop de signaux (${traced.points.length}, ${MAX_BUILD_TILES} maximum).`,
    };
  }

  let reason: string | null = null;
  let cost = 0;
  for (const point of traced.points) {
    if (!inBounds(map, point.x, point.y)) {
      reason = reason ?? 'Signal hors de la carte.';
      continue;
    }
    const index = tileIndex(point.x, point.y, map.width);
    const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
    const height = map.heightMap[index] ?? 0;
    const owner = map.owner[index] ?? COMPANY_NONE;
    const hasSignal =
      (map.signalData?.[index] ?? 0) !== 0 || ((map.flags[index] ?? 0) & (1 << 6)) !== 0;
    let tileReason: string | null = null;
    if (kind !== 'rail') tileReason = 'Un signal exige une voie ferrée sur la tuile.';
    else if (
      hasSignal &&
      options.company !== undefined &&
      options.company !== COMPANY_NONE &&
      owner !== options.company
    ) {
      tileReason = 'La voie appartient à une autre entreprise.';
    }
    if (tileReason) reason = reason ?? tileReason;
    // Les tuiles sans signal sont traversées sans frais : un glissement peut
    // couvrir une voie dont seuls certains nœuds portent un signal.
    if (!hasSignal) continue;
    cost += SIGNAL_REMOVE_COST;
    plan.tiles.push({
      x: point.x,
      y: point.y,
      index,
      kind,
      height,
      ground: height * 0.5,
      connections: map.trackBits[index] ?? 0,
      cost: SIGNAL_REMOVE_COST,
    });
  }

  if (plan.tiles.length === 0 && !reason) {
    reason = 'Aucun signal à retirer sur ce tracé.';
  }
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

/** Options de conversion d'un tronçon vers un autre type de rail. */
export interface ConvertRailPlanOptions extends InfrastructureOptions {
  railType: RailType;
  to?: BuildPoint;
  axis?: BuildAxis;
}

/**
 * Plan de conversion d'un tronçon existant (#157) : toutes les tuiles doivent
 * être des voies de l'entreprise, et au moins une doit changer de type.
 */
export function planConvertRail(options: ConvertRailPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const to = buildTile(options.to ?? options.from);
  const axis = options.axis ?? axisForDrag(from, to);
  const plan = emptyInfrastructurePlan('convert', from, to, axis);
  const target = options.railType;
  plan.railType = target;

  if (!inBounds(map, from.x, from.y) || !inBounds(map, to.x, to.y)) {
    return { ...plan, reason: 'Tracé hors de la carte.' };
  }
  const points = traceBuildPath(from, to, axis);
  if (points.length > MAX_BUILD_TILES) {
    return {
      ...plan,
      reason: `Tronçon trop long (${points.length} tuiles, ${MAX_BUILD_TILES} maximum).`,
    };
  }

  const costPerTile = railConvertCost(target);
  let reason: string | null = null;
  let cost = 0;
  let changed = false;
  for (const point of points) {
    const index = tileIndex(point.x, point.y, map.width);
    const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
    const height = map.heightMap[index] ?? 0;
    const owner = map.owner[index] ?? COMPANY_NONE;
    const current = parseRailType(map.railTypes?.[index]) ?? 'rail';
    let tileReason: string | null = null;
    if (kind !== 'rail') tileReason = 'La conversion exige une voie ferrée.';
    else if (
      options.company !== undefined &&
      options.company !== COMPANY_NONE &&
      owner !== options.company
    ) {
      tileReason = 'La voie appartient à une autre entreprise.';
    }
    if (tileReason) reason = reason ?? tileReason;
    if (current !== target) changed = true;
    cost += costPerTile;
    plan.tiles.push({
      x: point.x,
      y: point.y,
      index,
      kind,
      height,
      ground: height * 0.5,
      connections: map.trackBits[index] ?? 0,
      cost: costPerTile,
    });
  }
  if (!reason && !changed) reason = 'Ce tronçon est déjà de ce type.';
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

// ---------------------------------------------------------------------------
// Terrassement et arbres (#158)
// ---------------------------------------------------------------------------

interface AreaPlanOptions extends InfrastructureOptions {
  to?: BuildPoint;
  /** Côté du carré quand aucun drag n'est fourni. */
  size?: number;
}

interface AreaRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  size: number;
}

function areaOf(
  map: MapSnapshot,
  from: BuildPoint,
  to: BuildPoint | undefined,
  size: number,
): AreaRect {
  const start = buildTile(from);
  if (to) {
    const end = buildTile(to);
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const right = Math.max(start.x, end.x);
    const bottom = Math.max(start.y, end.y);
    return { left, top, right, bottom, size: Math.max(right - left, bottom - top) + 1 };
  }
  const side = Math.max(1, Math.round(size));
  return {
    left: start.x,
    top: start.y,
    right: Math.min(map.width - 1, start.x + side - 1),
    bottom: Math.min(map.height - 1, start.y + side - 1),
    size: side,
  };
}

function areaTiles(map: MapSnapshot, rect: AreaRect): BuildPlanTile[] {
  const tiles: BuildPlanTile[] = [];
  for (let y = rect.top; y <= rect.bottom; y += 1) {
    for (let x = rect.left; x <= rect.right; x += 1) {
      const index = tileIndex(x, y, map.width);
      const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
      const height = map.heightMap[index] ?? 0;
      tiles.push({
        x,
        y,
        index,
        kind,
        height,
        ground: height * 0.5,
        connections: 0,
        cost: 0,
      });
    }
  }
  return tiles;
}

function neighbourHeightCount(map: MapSnapshot, x: number, y: number, height: number): number {
  let count = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(map, nx, ny)) continue;
    if ((map.heightMap[tileIndex(nx, ny, map.width)] ?? height) !== height) count += 1;
  }
  return count;
}

/** Terrains naturels qu'un terrassement ou une plantation peut modifier. */
function isNaturalGround(kind: TileKind): boolean {
  return kind === 'grass' || kind === 'clear' || kind === 'rough' || kind === 'trees';
}

function naturalGroundReason(kind: TileKind, what: string): string | null {
  if (isNaturalGround(kind)) return null;
  if (kind === 'water' || kind === 'river' || kind === 'canal' || kind === 'lock') {
    return `Impossible de ${what} sur l’eau.`;
  }
  if (kind === 'house') return `Impossible de ${what} sur un bâtiment.`;
  if (kind === 'industry') return `Impossible de ${what} sur une industrie.`;
  if (kind === 'station') return `Impossible de ${what} sur une gare.`;
  if (kind === 'airport') return `Impossible de ${what} sur un aéroport.`;
  if (kind === 'dock') return `Impossible de ${what} sur un quai.`;
  if (kind === 'rail' || kind === 'road' || kind === 'crossing') {
    return `Une voie occupe cette tuile : démolissez-la d’abord.`;
  }
  if (kind === 'bridge' || kind === 'tunnel' || kind === 'aqueduct' || kind === 'object') {
    return `Un ouvrage occupe cette tuile.`;
  }
  return `Terrain inadapté à ${what === 'planter des arbres' ? 'la plantation' : 'au terrassement'}.`;
}

export interface TerraformPlanOptions extends AreaPlanOptions {
  settings: TerraformSettings;
}

/** Plan de terrassement : un carré ou le rectangle du drag, niveau par niveau. */
export function planTerraform(options: TerraformPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const size = Math.max(1, Math.min(TERRAFORM_MAX_SIZE, Math.round(options.settings.size)));
  const rect = areaOf(map, from, options.to, size);
  const direction: TerraformDirection = options.settings.direction === 'down' ? 'down' : 'up';
  const to = { x: rect.right, y: rect.bottom };
  const plan: BuildPlan = {
    tool: 'terraform',
    from,
    to,
    axis: 'x',
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
    terraform: { direction, size: rect.size },
  };
  if (!inBounds(map, rect.left, rect.top) || !inBounds(map, rect.right, rect.bottom)) {
    return { ...plan, reason: 'Terrassement hors de la carte.' };
  }
  const count = (rect.right - rect.left + 1) * (rect.bottom - rect.top + 1);
  if (count > TERRAFORM_MAX_TILES) {
    return {
      ...plan,
      reason: `Zone trop grande (${count} tuiles, ${TERRAFORM_MAX_TILES} maximum).`,
    };
  }

  const delta = direction === 'up' ? 1 : -1;
  let reason: string | null = null;
  let cost = 0;
  for (const tile of areaTiles(map, rect)) {
    let tileReason = naturalGroundReason(tile.kind, 'terrasser');
    const height = tile.height + delta;
    if (!tileReason && (height < 0 || height > MAX_HEIGHT_LEVEL)) {
      tileReason =
        direction === 'up' ? 'Sommet maximal déjà atteint.' : 'Niveau minimal déjà atteint.';
    }
    const tileCost =
      TERRAFORM_COST_PER_TILE +
      neighbourHeightCount(map, tile.x, tile.y, tile.height) * TERRAFORM_SLOPE_COST;
    if (tileReason) reason = reason ?? tileReason;
    cost += tileCost;
    plan.tiles.push({ ...tile, cost: tileCost });
  }
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

export interface TreePlanOptions extends AreaPlanOptions {
  settings: TreeSettings;
}

/** Plan de plantation : carré au survol ou rectangle au drag. */
export function planTree(options: TreePlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const size = Math.max(1, Math.min(TREE_MAX_SIZE, Math.round(options.settings.size)));
  const rect = areaOf(map, from, options.to, size);
  const plan: BuildPlan = {
    tool: 'tree',
    from,
    to: { x: rect.right, y: rect.bottom },
    axis: 'x',
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
    tree: { size: rect.size },
  };
  if (!inBounds(map, rect.left, rect.top) || !inBounds(map, rect.right, rect.bottom)) {
    return { ...plan, reason: 'Plantation hors de la carte.' };
  }
  const count = (rect.right - rect.left + 1) * (rect.bottom - rect.top + 1);
  if (count > TREE_MAX_TILES) {
    return { ...plan, reason: `Zone trop grande (${count} tuiles, ${TREE_MAX_TILES} maximum).` };
  }

  let reason: string | null = null;
  let cost = 0;
  for (const tile of areaTiles(map, rect)) {
    const tileReason = naturalGroundReason(tile.kind, 'planter des arbres');
    const tileCost = TREE_COST * (tile.kind === 'trees' ? 2 : 1);
    if (tileReason) reason = reason ?? tileReason;
    cost += tileCost;
    plan.tiles.push({ ...tile, cost: tileCost });
  }
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

// ---------------------------------------------------------------------------
// Canaux, écluses et aqueducs (#158)
// ---------------------------------------------------------------------------

const CANAL_WATER_KINDS: readonly TileKind[] = ['water', 'river', 'canal', 'coast'];

function isCanalWater(kind: TileKind): boolean {
  return CANAL_WATER_KINDS.includes(kind);
}

export interface CanalPlanOptions extends InfrastructureOptions {
  to?: BuildPoint;
  axis?: BuildAxis;
  maxTiles?: number;
}

/** Tracé d'un canal en L ; le niveau d'eau suit un lac existant ou creuse le terrain. */
export function planCanal(options: CanalPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const to = buildTile(options.to ?? options.from);
  const axis = options.axis ?? axisForDrag(from, to);
  const maxTiles = Math.max(1, options.maxTiles ?? MAX_BUILD_TILES);
  const plan: BuildPlan = {
    tool: 'canal',
    from,
    to,
    axis,
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
  };
  if (!inBounds(map, from.x, from.y) || !inBounds(map, to.x, to.y)) {
    return { ...plan, reason: 'Tracé hors de la carte.' };
  }
  const points = traceBuildPath(from, to, axis);
  if (points.length > maxTiles) {
    return { ...plan, reason: `Canal trop long (${points.length} tuiles, ${maxTiles} maximum).` };
  }

  let reason: string | null = null;
  let cost = 0;
  let existingLevel: number | null = null;
  let minHeight = Number.POSITIVE_INFINITY;
  const raw: { point: BuildPoint; tile: BuildPlanTile; water: boolean }[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point) continue;
    const index = tileIndex(point.x, point.y, map.width);
    const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
    const height = map.heightMap[index] ?? 0;
    let tileReason: string | null = null;
    if (!isCanalWater(kind) && !isNaturalGround(kind)) {
      if (kind === 'rail' || kind === 'road' || kind === 'crossing') {
        tileReason = 'Un canal ne traverse pas une voie : construisez un aqueduc.';
      } else {
        tileReason = naturalGroundReason(kind, 'creuser un canal');
      }
    }
    const previous = points[i - 1];
    const next = points[i + 1];
    let connections = 0;
    if (previous) connections |= directionBit(point, previous);
    if (next) connections |= directionBit(point, next);
    if (connections === 0) connections = CONNECT_EAST | CONNECT_WEST;
    const water = isCanalWater(kind);
    if (water) existingLevel ??= height;
    else minHeight = Math.min(minHeight, height);
    if (tileReason) reason = reason ?? tileReason;
    raw.push({
      point,
      water,
      tile: {
        x: point.x,
        y: point.y,
        index,
        kind,
        height,
        ground: height * 0.5,
        connections,
        cost: 0,
      },
    });
  }

  const level = existingLevel ?? Math.max(0, (Number.isFinite(minHeight) ? minHeight : 0) - 2);
  for (const entry of raw) {
    const excavation = entry.water ? 0 : Math.abs(entry.tile.height - level);
    const tileCost = CANAL_COST_PER_TILE + excavation * CANAL_EXCAVATION_COST;
    cost += tileCost;
    plan.tiles.push({ ...entry.tile, cost: tileCost });
  }
  plan.waterLevel = level;
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

export interface LockPlanOptions extends InfrastructureOptions {
  settings: LockSettings;
}

function directionToNeighbour(dx: number, dy: number): BuildDirection {
  if (dx > 0) return 'ne';
  if (dx < 0) return 'sw';
  if (dy > 0) return 'se';
  return 'nw';
}

/** Plan d'une écluse : exige une tuile d'eau reliée à un bief voisin. */
export function planLock(options: LockPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const plan: BuildPlan = {
    tool: 'lock',
    from,
    to: from,
    axis: 'x',
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
  };
  if (!inBounds(map, from.x, from.y)) return { ...plan, reason: 'Écluse hors de la carte.' };
  const index = tileIndex(from.x, from.y, map.width);
  const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
  const height = map.heightMap[index] ?? 0;
  if (kind === 'lock') return { ...plan, reason: 'Une écluse occupe déjà cette tuile.' };
  if (!isCanalWater(kind))
    return { ...plan, reason: 'Une écluse exige une tuile de canal ou d’eau.' };

  let best: { dx: number; dy: number; height: number } | null = null;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = from.x + dx;
    const ny = from.y + dy;
    if (!inBounds(map, nx, ny)) continue;
    const nIndex = tileIndex(nx, ny, map.width);
    const nKind = TILE_KINDS[map.kind[nIndex] ?? 0] ?? 'void';
    if (!isCanalWater(nKind)) continue;
    const nHeight = map.heightMap[nIndex] ?? 0;
    if (!best || Math.abs(nHeight - height) > Math.abs(best.height - height)) {
      best = { dx, dy, height: nHeight };
    }
  }
  if (!best) {
    return { ...plan, reason: 'Une écluse exige un bief voisin (canal ou eau).' };
  }
  const direction = options.settings.direction ?? directionToNeighbour(best.dx, best.dy);
  const upper = Math.max(height, best.height);
  const lower = Math.min(height, best.height);
  const axis = directionAxis(direction);
  const connections = axis === 'x' ? CONNECT_EAST | CONNECT_WEST : CONNECT_NORTH | CONNECT_SOUTH;
  let reason: string | null = null;
  if (options.budget !== undefined && LOCK_COST > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(LOCK_COST)} £ requis.`;
  }
  plan.lock = { direction, upper, lower };
  plan.tiles.push({
    x: from.x,
    y: from.y,
    index,
    kind,
    height,
    ground: height * 0.5,
    connections,
    cost: LOCK_COST,
  });
  return { ...plan, axis, cost: LOCK_COST, valid: reason === null, reason };
}

export interface AqueductPlanOptions extends InfrastructureOptions {
  to: BuildPoint;
}

const AQUEDUCT_ENDPOINT_KINDS: readonly TileKind[] = [
  'grass',
  'clear',
  'rough',
  'trees',
  'water',
  'river',
  'canal',
  'coast',
];

/** Plan d'un aqueduc rectiligne : deux têtes d'eau et un tablier au-dessus du val. */
export function planAqueduct(options: AqueductPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const to = buildTile(options.to);
  const plan: BuildPlan = {
    tool: 'aqueduct',
    from,
    to,
    axis: from.x === to.x ? 'y' : 'x',
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
  };
  if (!inBounds(map, from.x, from.y) || !inBounds(map, to.x, to.y)) {
    return { ...plan, reason: 'Aqueduc hors de la carte.' };
  }
  if (from.x !== to.x && from.y !== to.y) {
    return { ...plan, reason: 'Un aqueduc doit suivre X ou Y.' };
  }
  if (from.x === to.x && from.y === to.y) {
    return { ...plan, reason: 'Un aqueduc relie deux tuiles distinctes.' };
  }
  const axis: BuildAxis = from.x !== to.x ? 'x' : 'y';
  const points = traceBuildPath(from, to, axis);
  if (points.length < 3) {
    return { ...plan, reason: 'Un aqueduc doit franchir au moins une tuile.' };
  }
  if (points.length > AQUEDUCT_MAX_TILES) {
    return {
      ...plan,
      reason: `Aqueduc trop long (${points.length} tuiles, ${AQUEDUCT_MAX_TILES} maximum).`,
    };
  }

  let reason: string | null = null;
  let level = 0;
  const endpointHeights: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point) continue;
    const index = tileIndex(point.x, point.y, map.width);
    const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
    const height = map.heightMap[index] ?? 0;
    const endpoint = i === 0 || i === points.length - 1;
    if (endpoint) {
      if (!AQUEDUCT_ENDPOINT_KINDS.includes(kind)) {
        reason = reason ?? naturalGroundReason(kind, 'ancrer un aqueduc');
      }
      endpointHeights.push(height);
      level = Math.max(level, height);
    } else if (
      kind === 'house' ||
      kind === 'industry' ||
      kind === 'station' ||
      kind === 'airport' ||
      kind === 'dock' ||
      kind === 'object' ||
      kind === 'void'
    ) {
      reason = reason ?? 'Un bâtiment ou un objet bloque le tablier de l’aqueduc.';
    }
    const previous = points[i - 1];
    const next = points[i + 1];
    let connections = 0;
    if (previous) connections |= directionBit(point, previous);
    if (next) connections |= directionBit(point, next);
    const tileCost = AQUEDUCT_COST_PER_TILE;
    plan.tiles.push({
      x: point.x,
      y: point.y,
      index,
      kind,
      height,
      ground: height * 0.5,
      connections,
      cost: tileCost,
    });
  }
  const cost = AQUEDUCT_COST_PER_TILE * points.length;
  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  plan.aqueduct = { axis, level };
  plan.waterLevel = level;
  return { ...plan, axis, cost, valid: reason === null, reason };
}

// ---------------------------------------------------------------------------
// Passage à niveau (#159)
// ---------------------------------------------------------------------------

export interface CrossingPlanOptions extends InfrastructureOptions {
  from: BuildPoint;
}

function straightAxis(bits: number): BuildAxis | null {
  if ((bits & (CONNECT_EAST | CONNECT_WEST)) === (CONNECT_EAST | CONNECT_WEST)) return 'x';
  if ((bits & (CONNECT_NORTH | CONNECT_SOUTH)) === (CONNECT_NORTH | CONNECT_SOUTH)) return 'y';
  return null;
}

/** Plan d'un passage à niveau sur une voie droite existante (rail ou route). */
export function planCrossing(options: CrossingPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const plan: BuildPlan = {
    tool: 'crossing',
    from,
    to: from,
    axis: 'x',
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
  };
  if (!inBounds(map, from.x, from.y)) {
    return { ...plan, reason: 'Passage à niveau hors de la carte.' };
  }
  const index = tileIndex(from.x, from.y, map.width);
  const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
  const height = map.heightMap[index] ?? 0;
  if (kind !== 'rail' && kind !== 'road') {
    return {
      ...plan,
      reason: 'Un passage à niveau se pose sur une voie ferrée ou une route.',
    };
  }
  const bits = (map.trackBits[index] ?? 0) & 0x0f;
  const axis = straightAxis(bits);
  if (!axis) {
    return { ...plan, reason: 'Le passage à niveau exige une voie droite.' };
  }
  const owner = map.owner[index] ?? COMPANY_NONE;
  if (
    options.company !== undefined &&
    options.company !== COMPANY_NONE &&
    owner !== COMPANY_NONE &&
    owner !== options.company
  ) {
    return { ...plan, reason: 'La voie appartient à une autre entreprise.' };
  }
  let reason: string | null = null;
  if (options.budget !== undefined && CROSSING_COST > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(CROSSING_COST)} £ requis.`;
  }
  plan.crossing = { network: kind === 'rail' ? 'rail' : 'road', axis };
  plan.tiles.push({
    x: from.x,
    y: from.y,
    index,
    kind,
    height,
    ground: height * 0.5,
    connections: bits,
    cost: CROSSING_COST,
  });
  return { ...plan, axis, cost: CROSSING_COST, valid: reason === null, reason };
}

/** Type brut d'une tuile (helper de tests et de debug). */
export function tileKindIndexAt(map: MapSnapshot, x: number, y: number): number {
  if (!inBounds(map, x, y)) return TILE_KIND_INDEX.void;
  return map.kind[tileIndex(x, y, map.width)] ?? TILE_KIND_INDEX.void;
}
