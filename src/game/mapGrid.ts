/**
 * Helpers d'indexation et de hauteur de la carte.
 *
 * Le protocole (src/engine/protocol.ts) indexe les tableaux `y * width + x`
 * avec X vers l'est et Y vers le sud. Le rendu Three.js utilise
 * `(x, height, y)` : X et Z de Three correspondent donc à X et Y du protocole.
 * Toutes les conversions passent par ce module.
 */

import { TILE_KIND_INDEX, type MapSnapshot, type TileKind } from '../engine/protocol';

/** Table inverse index stable → TileKind. */
export const TILE_KINDS: readonly TileKind[] = (() => {
  const entries = Object.entries(TILE_KIND_INDEX) as [TileKind, number][];
  const kinds: TileKind[] = [];
  for (const [kind, index] of entries) kinds[index] = kind;
  return kinds;
})();

/** Une unité de hauteur OpenTTD vaut une demi-tuile en monde 3D. */
export const HEIGHT_SCALE = 0.5;
export const MAX_HEIGHT_LEVEL = 15;

export function tileKindFromIndex(index: number): TileKind {
  return TILE_KINDS[index] ?? 'void';
}

export function isWaterKind(kind: TileKind): boolean {
  return kind === 'water' || kind === 'river' || kind === 'canal' || kind === 'lock';
}

/** Index linéaire d'une tuile, sans validation (hot path). */
export function tileIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

export function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Lecture sûre de `kind` : renvoie `void` hors carte. */
export function tileKindAt(map: MapSnapshot, x: number, y: number): TileKind {
  if (!inBounds(x, y, map.width, map.height)) return 'void';
  return tileKindFromIndex(map.kind[tileIndex(x, y, map.width)] ?? 0);
}

/** Hauteur d'une tuile en unités monde (0..7.5). */
export function tileHeightWorld(map: MapSnapshot, x: number, y: number): number {
  if (!inBounds(x, y, map.width, map.height)) return 0;
  return (map.heightMap[tileIndex(x, y, map.width)] ?? 0) * HEIGHT_SCALE;
}

/**
 * Hauteur d'un coin de grille (cx, cy ∈ [0..width] × [0..height]).
 *
 * La moyenne des 1 à 4 tuiles adjacentes est calculée de façon identique par
 * les chunks voisins : les bords partagent donc exactement les mêmes sommets
 * et aucune fissure ni recouvrement n'apparaît aux jonctions.
 */
export function cornerHeightWorld(map: MapSnapshot, cx: number, cy: number): number {
  let sum = 0;
  let count = 0;
  for (let dy = -1; dy <= 0; dy += 1) {
    for (let dx = -1; dx <= 0; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(x, y, map.width, map.height)) continue;
      sum += map.heightMap[tileIndex(x, y, map.width)] ?? 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : (sum / count) * HEIGHT_SCALE;
}

/**
 * Hauteur interpolée en coordonnées tuiles fractionnaires.
 *
 * Utilisée par les véhicules, la caméra et le picking : elle correspond
 * exactement au maillage du terrain (mêmes coins, même bilinéaire).
 */
export function sampleHeightWorld(map: MapSnapshot, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const h00 = cornerHeightWorld(map, x0, y0);
  const h10 = cornerHeightWorld(map, x0 + 1, y0);
  const h01 = cornerHeightWorld(map, x0, y0 + 1);
  const h11 = cornerHeightWorld(map, x0 + 1, y0 + 1);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fy;
}

/** Centre d'une tuile en coordonnées monde (X, Z de Three). */
export function tileCenter(x: number, y: number): { x: number; z: number } {
  return { x: x + 0.5, z: y + 0.5 };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
