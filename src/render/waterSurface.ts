/**
 * Surface d'eau : profondeur, houle et écume, sans dépendance Three.js.
 *
 * L'eau reste un quad par tuile (deux triangles). Le relief des vagues vient
 * du shader, la profondeur d'un champ de distance calculé une fois par carte :
 * la teinte et l'écume suivent donc la distance à la côte sans ajouter de
 * géométrie. Les helpers sont purs et testables sous Node.
 *
 * Modèle de hauteur (correctif #176) : dans le protocole, la hauteur d'une
 * tuile d'eau est le niveau de sa surface dans OpenTTD. La surface 3D est donc
 * posée *très légèrement sous* ce niveau, et le lit rendu plus bas encore.
 * L'eau ne peut ainsi jamais dépasser le dessus d'une tuile voisine (route,
 * pont, quai, berge), même au creux de la houle.
 */

import type { MapSnapshot } from '../engine/protocol';
import { HEIGHT_SCALE, isWaterKind, tileKindFromIndex } from '../game/mapGrid';

/**
 * Décalage de la surface sous le dessus de la tuile, en unités monde.
 *
 * Négatif : l'eau est sous le niveau de la tuile, donc sous toute route, tout
 * pont et tout quai construits au même niveau. La marge (8 cm) couvre
 * l'amplitude de la houle (5 cm) : la crête reste toujours sous le terrain sec
 * et aucun tri de transparence ne peut faire passer l'eau au-dessus.
 */
export const WATER_LEVEL_OFFSET = -0.08;

/**
 * Descente du lit rendu sous le dessus de la tuile, en unités monde.
 *
 * Le lit n'est pas coplanaire avec la surface : l'écart donne une profondeur
 * visible, supprime tout z-fighting et laisse la transparence montrer le fond.
 * Aux berges, l'interpolation des coins ramène progressivement le lit sous la
 * surface, ce qui dessine la plage au lieu d'un mur d'eau.
 */
export const WATER_BED_DROP = 0.62;

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

/**
 * Champs de hauteur par tuile alimentant le maillage du terrain.
 *
 * `bed` couvre toute la carte (terre incluse) : il sert directement aux
 * positions et aux normales, sans branche par type de tuile. `surface` et
 * `weight` ne sont renseignés que sur l'eau, ce qui permet de calculer la
 * profondeur réelle d'un sommet sans peindre les tuiles sèches voisines.
 */
export interface WaterHeightFields {
  /** Hauteur monde du lit rendu, pour chaque tuile. */
  bed: Float32Array;
  /** Hauteur monde de la surface de l'eau (0 sur la terre). */
  surface: Float32Array;
  /** 1 sur une tuile d'eau, 0 ailleurs. */
  weight: Float32Array;
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

function safeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, level) : 0;
}

/**
 * Hauteur monde du dessus d'une tuile, indépendamment de l'eau.
 *
 * C'est la même convention que `sampleHeightWorld` : une tuile de niveau `n`
 * culmine à `n * HEIGHT_SCALE`.
 */
function tileTopHeight(level: number): number {
  return safeLevel(level) * HEIGHT_SCALE;
}

function cornerFieldValue(
  field: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
): number {
  let sum = 0;
  let count = 0;
  for (let dy = -1; dy <= 0; dy += 1) {
    for (let dx = -1; dx <= 0; dx += 1) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      sum += field[ty * width + tx] ?? 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Échantillonne un champ par tuile comme le maillage du terrain.
 *
 * Même moyenne de coins puis même bilinéaire que `sampleHeightWorld`
 * (`src/game/mapGrid.ts`) : les positions, les normales et la profondeur du
 * lit restent donc exactement alignées sur la géométrie du terrain. La
 * version « centre de tuile » (`sampleField`) sert aux distances de côte, pas
 * aux hauteurs.
 */
export function sampleCornerField(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  z: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const h00 = cornerFieldValue(field, width, height, x0, z0);
  const h10 = cornerFieldValue(field, width, height, x0 + 1, z0);
  const h01 = cornerFieldValue(field, width, height, x0, z0 + 1);
  const h11 = cornerFieldValue(field, width, height, x0 + 1, z0 + 1);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fz;
}

/**
 * Lit et surface de chaque tuile, en hauteurs monde.
 *
 * Une seule passe linéaire, sans allocation intermédiaire par tuile. Les
 * tuiles sèches gardent leur dessus habituel ; seules les tuiles d'eau sont
 * creusées pour créer le lit, ce qui laisse routes, ponts et quais au-dessus
 * de la surface.
 */
export function buildWaterHeightFields(map: MapSnapshot): WaterHeightFields {
  const size = map.width * map.height;
  const bed = new Float32Array(size);
  const surface = new Float32Array(size);
  const weight = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const level = map.heightMap[index] ?? 0;
    if (isWaterKind(tileKindFromIndex(map.kind[index] ?? 0))) {
      bed[index] = waterBedHeight(level);
      surface[index] = waterSurfaceHeight(level);
      weight[index] = 1;
    } else {
      bed[index] = tileTopHeight(level);
    }
  }
  return { bed, surface, weight };
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

/**
 * Hauteur monde du lit rendu sous une tuile d'eau.
 *
 * Toujours strictement sous `waterSurfaceHeight`, d'au moins
 * `WATER_BED_DROP - |WATER_LEVEL_OFFSET|` : aucun z-fighting possible.
 */
export function waterBedHeight(level: number): number {
  return tileTopHeight(level) - WATER_BED_DROP;
}

/** Hauteur monde de la surface pour un niveau de tuile d'eau. */
export function waterSurfaceHeight(level: number): number {
  return tileTopHeight(level) + WATER_LEVEL_OFFSET;
}

/**
 * Profondeur 0..1 d'un sommet du terrain, mesurée entre la surface d'eau
 * voisine et le lit réel.
 *
 * Le champ `surface` vaut 0 sur la terre : on le divise par le poids d'eau
 * échantillonné pour retrouver la surface des seules tuiles d'eau, puis on
 * compare au lit du sommet. Un sommet touchant une tuile sèche (route, quai,
 * berge) renvoie exactement 0, même collé à l'eau : sa teinte ne peut pas
 * déborder sur la tuile voisine.
 */
export function waterDepthAt(
  fields: WaterHeightFields,
  width: number,
  height: number,
  x: number,
  z: number,
  bedHeight: number,
): number {
  const weight = sampleCornerField(fields.weight, width, height, x, z);
  // Seuls les sommets entièrement entourés d'eau reçoivent la teinte du lit :
  // un sommet partagé avec une tuile sèche resterait visible sur la route ou
  // le quai voisin après interpolation.
  if (weight < 0.999) return 0;
  const surface = sampleCornerField(fields.surface, width, height, x, z) / weight;
  const depth = (surface - bedHeight) / WATER_BED_DROP;
  return Number.isFinite(depth) ? Math.max(0, Math.min(1, depth)) : 0;
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
