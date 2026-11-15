/**
 * Aides pures de la « peau » de terrain.
 *
 * Le terrain garde une tuile = un quad en basse et moyenne qualité : seules
 * les normales et les couleurs changent. La haute qualité peut subdiviser
 * chaque tuile pour adoucir la silhouette. Ce module centralise les budgets
 * (testables sous Node) et les réglages de peau, sans dépendre de Three.js.
 */

import type { QualityLevel } from './quality';

/** Taille d'un chunk de terrain, en tuiles. */
export const TERRAIN_CHUNK_SIZE = 32;

/**
 * Subdivision d'une tuile par preset.
 *
 * - `low` et `medium` : 1×1, soit exactement le même nombre de triangles
 *   qu'avant l'issue #122 (deux triangles par tuile).
 * - `high` : 2×2 en option, uniquement si le rendu le justifie.
 */
export const TERRAIN_SUBDIVISION: Record<QualityLevel, number> = {
  low: 1,
  medium: 1,
  high: 2,
};

/**
 * Au-delà de ce nombre de tuiles, la haute qualité garde la peau procédurale
 * mais renonce à la subdivision : sur 512×512 elle coûte 4× plus de triangles
 * sans gain visible à distance de jeu, et fait passer le rendu sous 60 fps.
 */
export const TERRAIN_HIGH_SUBDIVISION_MAX_TILES = 100_000;

export function terrainSubdivision(level: QualityLevel, tileCount = 0): number {
  const subdivision = TERRAIN_SUBDIVISION[level] ?? 1;
  if (level === 'high' && tileCount > TERRAIN_HIGH_SUBDIVISION_MAX_TILES) return 1;
  return subdivision;
}

/**
 * Intensité de la peau procédurale : la basse qualité garde un lissage et une
 * variation discrète, la moyenne et la haute affichent la peau complète.
 */
export function terrainSkinStrength(level: QualityLevel): number {
  if (level === 'low') return 0.35;
  if (level === 'high') return 1.15;
  return 1;
}

/**
 * Bornes du mélange herbe/terre/roche/sable dans le shader.
 *
 * Les pentes sont exprimées en `1 - normal.y` : 0 = plat, ~0,106 pour une
 * marche d'un niveau, ~0,293 pour deux niveaux. L'herbe reste dominante sur
 * les terrains plats et les pentes douces ; la roche n'apparaît que sur les
 * falaises (trois niveaux et plus), ce qui évite le terrain uniformément beige.
 */
export const TERRAIN_SKIN_BOUNDS = {
  /** Pente de départ/fin du mélange herbe → terre. */
  earthSlope: { start: 0.16, end: 0.38 },
  /** Pente de départ/fin du mélange terre → roche. */
  rockSlope: { start: 0.32, end: 0.58 },
  /** Altitude monde (0..7,5) où la roche d'altitude commence à poindre. */
  alpine: { start: 5.4, end: 7.2, weight: 0.28 },
  /** Bande de plage : distance à l'eau (tuiles) et altitude monde. */
  sand: { inner: 0.35, outer: 2.2, altitudeStart: 0.7, altitudeEnd: 1.7 },
  /** Force maximale de la perturbation de normale (micro-relief). */
  bumpStrength: 0.22,
  /** Teinte herbe sèche, très minoritaire, pour casser les aplats. */
  dryGrass: 0.12,
} as const;

/** Met en forme une borne pour l'injecter dans un shader GLSL. */
export function glslBound(value: number): string {
  return Number(value).toFixed(4);
}

export interface TerrainBudget {
  /** Nombre de tuiles couvertes (hors doublons de bord). */
  tiles: number;
  /** Subdivision par tuile (1 = un quad, 2 = quatre). */
  subdivision: number;
  /** Nombre total de chunks (y compris les chunks partiels en bord de carte). */
  chunks: number;
  /** Sommets après indexation, bords de chunk compris. */
  vertices: number;
  /** Triangles effectivement indexés. */
  triangles: number;
  /** Indices (6 par triangle). */
  indices: number;
}

/**
 * Budget exact du maillage pour une carte et un preset donnés.
 *
 * Le découpage en chunks est pris en compte : chaque chunk possède
 * `(largeur × subdivision + 1)` sommets par axe, les bords n'étant pas
 * dupliqués à l'intérieur d'un chunk.
 */
export function terrainBudget(
  width: number,
  height: number,
  level: QualityLevel,
  chunkSize = TERRAIN_CHUNK_SIZE,
): TerrainBudget {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const subdivision = terrainSubdivision(level, safeWidth * safeHeight);
  const chunksX = Math.ceil(safeWidth / chunkSize);
  const chunksY = Math.ceil(safeHeight / chunkSize);
  let vertices = 0;
  let triangles = 0;
  for (let cy = 0; cy < chunksY; cy += 1) {
    const chunkHeight = Math.min(chunkSize, safeHeight - cy * chunkSize);
    if (chunkHeight <= 0) continue;
    for (let cx = 0; cx < chunksX; cx += 1) {
      const chunkWidth = Math.min(chunkSize, safeWidth - cx * chunkSize);
      if (chunkWidth <= 0) continue;
      const nx = chunkWidth * subdivision + 1;
      const nz = chunkHeight * subdivision + 1;
      vertices += nx * nz;
      triangles += chunkWidth * chunkHeight * subdivision * subdivision * 2;
    }
  }
  return {
    tiles: safeWidth * safeHeight,
    subdivision,
    chunks: chunksX * chunksY,
    vertices,
    triangles,
    indices: triangles * 3,
  };
}
