/**
 * Surface d'eau : profondeur, houle et écume, sans dépendance Three.js.
 *
 * L'eau reste un quad par tuile (deux triangles). Le relief des vagues vient
 * du shader, la profondeur d'un champ de distance calculé une fois par carte :
 * la teinte et l'écume suivent donc la distance à la côte sans ajouter de
 * géométrie. Les helpers sont purs et testables sous Node.
 */

import type { MapSnapshot } from '../engine/protocol';
import { HEIGHT_SCALE, isWaterKind, tileKindFromIndex } from '../game/mapGrid';

/**
 * Élévation de la surface par rapport au lit d'une tuile d'eau.
 *
 * Une tuile d'eau a une hauteur de niveau 0 dans le protocole : le lit est à
 * `y = 0` et la surface à `y = 0.5`. L'écart est très supérieur au biais de
 * profondeur, ce qui exclut tout z-fighting entre l'eau et le terrain.
 */
export const WATER_LEVEL_OFFSET = 0.5;

/** Distance (en tuiles) au-delà de laquelle l'eau est considérée profonde. */
export const WATER_DEPTH_RANGE = 7;

/** Distance maximale suivie pour les plages et les berges (en tuiles). */
export const SHORE_MAX_DISTANCE = 8;

/** Amplitude maximale de la houle verticale, en unités monde. */
export const WATER_WAVE_AMPLITUDE = 0.05;

/** Fréquence/spatialité de la houle, partagées entre JS et GLSL. */
export const WATER_WAVE_TERMS = [
  { time: 1.35, x: 0.55, z: 0.42, weight: 0.6 },
  { time: 2.2, x: 1.7, z: -1.1, weight: 0.28 },
  { time: 0.8, x: -0.35, z: 0.9, weight: 0.12 },
] as const;

/** Profondeur (0..1) sous laquelle l'écume de côte apparaît. */
export const WATER_FOAM_DEPTH = 0.055;

/** Échelle spatiale du clapot de normal, en unités monde inverses. */
export const WATER_RIPPLE_SCALE = 5.5;

/** Distance où le clapot de normale s'atténue pour éviter le scintillement. */
export const WATER_RIPPLE_FADE_NEAR = 90;
export const WATER_RIPPLE_FADE_FAR = 210;

export interface ShoreFields {
  /** Distance à la première tuile d'eau (0 sur l'eau, plafonnée). */
  landDistance: Float32Array;
  /** Distance à la première tuile terrestre (0 sur la terre, plafonnée). */
  waterDistance: Float32Array;
}

function clampIndex(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

/** BFS 4-voisinage, plafonné : suffisant pour une bande de plage. */
function distanceField(
  width: number,
  height: number,
  isSource: (index: number) => boolean,
  limit: number,
): Float32Array {
  const size = width * height;
  const distances = new Int16Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < size; index += 1) {
    if (!isSource(index)) continue;
    distances[index] = 0;
    queue[tail] = index;
    tail += 1;
  }
  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const next = (distances[index] ?? 0) + 1;
    if (next > limit) continue;
    const x = index % width;
    const y = (index - x) / width;
    const visit = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const neighbour = ny * width + nx;
      if ((distances[neighbour] ?? -1) >= 0) return;
      distances[neighbour] = next;
      queue[tail] = neighbour;
      tail += 1;
    };
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }
  const result = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const distance = distances[index] ?? -1;
    result[index] = distance < 0 ? limit : distance;
  }
  return result;
}

/**
 * Champs de distance d'une carte : terre → eau et eau → terre.
 * Coût linéaire en tuiles, une seule fois par changement de carte.
 */
export function buildShoreFields(map: MapSnapshot): ShoreFields {
  const isWater = (index: number): boolean => isWaterKind(tileKindFromIndex(map.kind[index] ?? 0));
  return {
    landDistance: distanceField(map.width, map.height, isWater, SHORE_MAX_DISTANCE),
    waterDistance: distanceField(
      map.width,
      map.height,
      (index) => !isWater(index),
      WATER_DEPTH_RANGE,
    ),
  };
}

/**
 * Échantillonne un champ par tuile à un coin de grille (bilinéaire).
 *
 * Le champ est défini au centre des tuiles : un sommet de coin partage donc la
 * même valeur de part et d'autre d'une arête, y compris entre deux chunks.
 */
export function sampleField(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  z: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const fx = x - 0.5;
  const fz = z - 0.5;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const x0 = clampIndex(ix, width - 1);
  const x1 = clampIndex(ix + 1, width - 1);
  const z0 = clampIndex(iz, height - 1);
  const z1 = clampIndex(iz + 1, height - 1);
  const top = (field[z0 * width + x0] ?? 0) * (1 - tx) + (field[z0 * width + x1] ?? 0) * tx;
  const bottom = (field[z1 * width + x0] ?? 0) * (1 - tx) + (field[z1 * width + x1] ?? 0) * tx;
  return top * (1 - tz) + bottom * tz;
}

/** Hauteur monde de la surface pour un niveau de tuile d'eau. */
export function waterSurfaceHeight(level: number): number {
  const safe = Number.isFinite(level) ? Math.max(0, level) : 0;
  return safe * HEIGHT_SCALE + WATER_LEVEL_OFFSET;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Distance à la terre → profondeur 0..1 (0 au bord, 1 au large). */
export function waterDepthFactor(distanceToLand: number): number {
  const distance = Number.isFinite(distanceToLand) ? Math.max(0, distanceToLand) : 0;
  return smoothstep(0.5, WATER_DEPTH_RANGE, distance);
}

/** Houle verticale déterministe, bornée par `WATER_WAVE_AMPLITUDE`. */
export function waterWaveHeight(seconds: number, x: number, z: number): number {
  const t = Number.isFinite(seconds) ? seconds : 0;
  let sum = 0;
  for (const term of WATER_WAVE_TERMS) {
    sum += Math.sin(t * term.time + x * term.x + z * term.z) * term.weight;
  }
  return sum * WATER_WAVE_AMPLITUDE;
}

/** Écume de côte : forte au bord, nulle au large. */
export function waterFoamAmount(depth: number, ripple: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.min(1, depth)) : 1;
  const r = Number.isFinite(ripple) ? Math.max(0, Math.min(1, ripple)) : 0;
  return (1 - smoothstep(0.01, WATER_FOAM_DEPTH, d)) * r;
}

/**
 * Constantes GLSL générées depuis les valeurs ci-dessus : une seule source de
 * vérité pour les bornes de houle, d'écume et d'atténuation.
 */
export const WATER_SHADER_CONSTANTS = `
const float WATER_WAVE_AMPLITUDE = ${WATER_WAVE_AMPLITUDE.toFixed(5)};
const float WATER_FOAM_DEPTH = ${WATER_FOAM_DEPTH.toFixed(5)};
const float WATER_RIPPLE_SCALE = ${WATER_RIPPLE_SCALE.toFixed(5)};
const float WATER_RIPPLE_FADE_NEAR = ${WATER_RIPPLE_FADE_NEAR.toFixed(1)};
const float WATER_RIPPLE_FADE_FAR = ${WATER_RIPPLE_FADE_FAR.toFixed(1)};
`;
