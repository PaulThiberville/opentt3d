/**
 * Cohérence des niveaux d'eau (#205).
 *
 * Une nappe d'eau (mer, lac, rivière, canal) est un seul plan horizontal tant
 * qu'aucune écluse ne la sépare. Le mock peut toutefois hériter de hauteurs
 * disparates : terrassement de ville/industrie au-dessus d'un plan d'eau,
 * canaux construits en plusieurs fois, sauvegardes anciennes. Cette passe
 * pure recolle les composantes connexes à un niveau commun et laisse les
 * écluses jouer leur rôle de barrière entre deux biefs.
 *
 * Aucun accès à Three.js ni au DOM : testable sous Node.
 */

import { TILE_KIND_INDEX } from '../engine/protocol';
import { isWaterKind, tileKindFromIndex } from './mapGrid';

/** Vue minimale d'une carte, compatible `MapSnapshot` et `MockWorld`. */
export interface WaterLevelMap {
  width: number;
  height: number;
  kind: Uint8Array;
  heightMap: Uint8Array;
}

export interface WaterComponent {
  /** Niveau retenu pour la composante (le plus bas, jamais au-dessus d'un bief). */
  level: number;
  /** Niveaux présents avant normalisation. */
  levels: number[];
  /** Indices de tuiles de la composante, hors écluse. */
  tiles: number[];
}

const LOCK = TILE_KIND_INDEX.lock;
const VOID = TILE_KIND_INDEX.void;

/**
 * Découpe la carte en composantes d'eau connexes (4-voisinage).
 *
 * Les écluses sont des **barrières** : elles appartiennent à leur propre
 * bief et ne sont pas traversées, ce qui autorise deux niveaux légitimes de
 * part et d'autre. Les tuiles vides et sèches ne sont jamais incluses.
 */
export function waterComponents(map: WaterLevelMap): WaterComponent[] {
  const { width, height, kind, heightMap } = map;
  const size = width * height;
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);
  const components: WaterComponent[] = [];

  for (let start = 0; start < size; start += 1) {
    if (visited[start] === 1) continue;
    const kindIndex = kind[start] ?? VOID;
    if (kindIndex === LOCK || !isWaterKind(tileKindFromIndex(kindIndex))) continue;
    visited[start] = 1;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    const tiles: number[] = [];
    const levels = new Set<number>();
    let level = Number.POSITIVE_INFINITY;

    while (head < tail) {
      const index = queue[head] ?? 0;
      head += 1;
      const tileLevel = heightMap[index] ?? 0;
      levels.add(tileLevel);
      if (tileLevel < level) level = tileLevel;
      tiles.push(index);

      const x = index % width;
      const y = (index - x) / width;
      const visit = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const neighbour = ny * width + nx;
        if (visited[neighbour] === 1) return;
        const neighbourKind = kind[neighbour] ?? VOID;
        if (neighbourKind === LOCK) return;
        if (!isWaterKind(tileKindFromIndex(neighbourKind))) return;
        visited[neighbour] = 1;
        queue[tail] = neighbour;
        tail += 1;
      };
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }

    components.push({
      level: Number.isFinite(level) ? level : 0,
      levels: [...levels].sort((a, b) => a - b),
      tiles,
    });
  }
  return components;
}

/**
 * Aligne chaque composante d'eau sur son niveau le plus bas.
 *
 * Le niveau bas évite qu'une nappe haute « flotte » au-dessus d'une rive
 * basse quand elle se raccorde à une eau plus basse. Les écluses ne sont
 * jamais déplacées : elles restent la référence des deux biefs qu'elles
 * séparent. Retourne le nombre de tuiles effectivement corrigées.
 */
export function normalizeWaterLevels(map: WaterLevelMap): number {
  let changed = 0;
  for (const component of waterComponents(map)) {
    for (const index of component.tiles) {
      if ((map.heightMap[index] ?? 0) === component.level) continue;
      map.heightMap[index] = component.level;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Vérifie qu'aucune tuile d'eau n'a un voisin d'eau 4-connexe à un autre
 * niveau sans écluse entre les deux. Utilisé par les tests et le diagnostic.
 */
export function findWaterLevelBreaks(map: WaterLevelMap): {
  x: number;
  y: number;
  level: number;
  neighbourX: number;
  neighbourY: number;
  neighbourLevel: number;
}[] {
  const breaks: {
    x: number;
    y: number;
    level: number;
    neighbourX: number;
    neighbourY: number;
    neighbourLevel: number;
  }[] = [];
  const { width, height, kind, heightMap } = map;
  const isGroundWater = (index: number): boolean => {
    const value = kind[index] ?? VOID;
    return value !== LOCK && isWaterKind(tileKindFromIndex(value));
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!isGroundWater(index)) continue;
      const level = heightMap[index] ?? 0;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (!isGroundWater(neighbour)) continue;
        const neighbourLevel = heightMap[neighbour] ?? 0;
        if (neighbourLevel === level) continue;
        breaks.push({ x, y, level, neighbourX: nx, neighbourY: ny, neighbourLevel });
      }
    }
  }
  return breaks;
}
