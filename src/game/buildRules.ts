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

import { COMPANY_NONE, TILE_KIND_INDEX, type MapSnapshot, type TileKind } from '../engine/protocol';
import { TILE_KINDS, tileIndex } from './mapGrid';

export type BuildTool = 'road' | 'rail' | 'clear';

/** Axe du premier segment du tracé en L (`x` = horizontal puis vertical). */
export type BuildAxis = 'x' | 'y';

export interface BuildPoint {
  x: number;
  y: number;
}

/** Bits de connexion d'une tuile de voie : 1 nord, 2 est, 4 sud, 8 ouest. */
export const CONNECT_NORTH = 1;
export const CONNECT_EAST = 2;
export const CONNECT_SOUTH = 4;
export const CONNECT_WEST = 8;

export const BUILD_COST_PER_TILE: Record<BuildTool, number> = {
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
}

export interface BuildPlanOptions {
  map: MapSnapshot;
  tool: BuildTool;
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
    if (kind === 'road' || kind === 'rail' || kind === 'bridge') return null;
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

function tileCost(tool: BuildTool, heightDelta: number): number {
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
): {
  type: 'build';
  tool: BuildTool;
  company: number;
  from: { x: number; y: number };
  to?: { x: number; y: number };
  options: { axis: BuildAxis };
} {
  const single = plan.from.x === plan.to.x && plan.from.y === plan.to.y;
  return {
    type: 'build',
    tool: plan.tool,
    company,
    from: { x: plan.from.x, y: plan.from.y },
    ...(single ? {} : { to: { x: plan.to.x, y: plan.to.y } }),
    options: { axis: plan.axis },
  };
}

/** `true` si la tuile peut recevoir une voie du type demandé. */
export function isBuildableTile(map: MapSnapshot, x: number, y: number, tool: BuildTool): boolean {
  if (!inBounds(map, x, y)) return false;
  const index = tileIndex(x, y, map.width);
  const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
  return occupancyReason(kind, tool) === null;
}

/** Type brut d'une tuile (helper de tests et de debug). */
export function tileKindIndexAt(map: MapSnapshot, x: number, y: number): number {
  if (!inBounds(map, x, y)) return TILE_KIND_INDEX.void;
  return map.kind[tileIndex(x, y, map.width)] ?? TILE_KIND_INDEX.void;
}
