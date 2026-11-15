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
  type TileKind,
} from '../engine/protocol';
import { TILE_KINDS, tileIndex } from './mapGrid';

export type BuildTool = 'road' | 'rail' | 'clear' | 'station' | 'depot' | 'signal';

/** Outils qui tracent un chemin de tuiles (route, rail, démolition). */
export type PathBuildTool = 'road' | 'rail' | 'clear';

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

/** Voie choisie quand une tuile porte plusieurs voies (signal). */
export type SignalTrack = 'x' | 'y' | 'upper' | 'lower' | 'left' | 'right';

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
  type: 'block';
  track: SignalTrack | null;
}

export interface BuildSettings {
  station: StationSettings;
  depot: DepotSettings;
  signal: SignalSettings;
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
export const SIGNAL_COST = 320;

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
    signal: { type: 'block', track: null },
  };
}

/** Copie superficielle sûre : les sous-objets ne sont jamais partagés. */
export function cloneBuildSettings(settings: BuildSettings): BuildSettings {
  return {
    station: { ...settings.station },
    depot: { ...settings.depot },
    signal: { ...settings.signal },
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
    if (kind === 'road' || kind === 'rail' || kind === 'bridge' || kind === 'station') {
      return null;
    }
    return 'Aucune voie à démolir sur cette tuile.';
  }
  switch (kind) {
    case 'void':
    case 'water':
    case 'river':
    case 'canal':
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
      return 'Un ouvrage occupe cette tuile.';
    case 'rail':
      return tool === 'rail' ? 'Voie déjà construite.' : 'Croisement rail/route à venir.';
    case 'road':
      return tool === 'road' ? 'Voie déjà construite.' : 'Croisement route/rail à venir.';
    default:
      return null;
  }
}

function tileCost(tool: PathBuildTool, heightDelta: number): number {
  const slope = tool === 'clear' ? 0 : Math.abs(heightDelta) * BUILD_SLOPE_COST;
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
  const empty: BuildPlan = {
    tool,
    from,
    to,
    axis,
    tiles: [],
    cost: 0,
    valid: false,
    reason: null,
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
    const costOfTile = tileCost(tool, heightDelta);
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
    return {
      ...base,
      options: {
        type: 'block',
        ...(plan.signal?.track ? { track: plan.signal.track } : {}),
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
  tool: 'station' | 'depot' | 'signal',
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

/** Plan d'un ou plusieurs signaux de bloc le long d'une voie existante. */
export function planSignal(options: SignalPlanOptions): BuildPlan {
  const map = options.map;
  const from = buildTile(options.from);
  const to = buildTile(options.to ?? options.from);
  const traced = traceSignalTiles(from, to);
  const axis = traced?.axis ?? options.axis ?? 'x';
  const plan = emptyInfrastructurePlan('signal', from, to, axis);
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
    cost += SIGNAL_COST;
    plan.tiles.push({
      x: point.x,
      y: point.y,
      index,
      kind,
      height,
      ground: height * 0.5,
      connections: map.trackBits[index] ?? 0,
      cost: SIGNAL_COST,
    });
  }

  if (!reason && options.budget !== undefined && cost > options.budget) {
    reason = `Trésorerie insuffisante : ${Math.round(cost)} £ requis.`;
  }
  return { ...plan, cost, valid: reason === null, reason };
}

/** Type brut d'une tuile (helper de tests et de debug). */
export function tileKindIndexAt(map: MapSnapshot, x: number, y: number): number {
  if (!inBounds(map, x, y)) return TILE_KIND_INDEX.void;
  return map.kind[tileIndex(x, y, map.width)] ?? TILE_KIND_INDEX.void;
}
