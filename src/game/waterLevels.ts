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

/**
 * Découpage compact de la carte en composantes d'eau libres.
 *
 * `ids[index]` vaut l'identifiant de la composante pour une tuile d'eau
 * 4-connexe sans écluse, et `-1` partout ailleurs (terre, vide, écluse). Le
 * rendu s'en sert pour plaquer **toutes** les tuiles d'une composante sur son
 * niveau minimal, sans copier une liste de tuiles par composante.
 */
export interface WaterComponentIndex {
  /** Niveau minimal de chaque composante, indexé par identifiant. */
  levels: number[];
  /** Identifiant de composante par tuile, `-1` hors eau libre. */
  ids: Int32Array;
  /** Nombre de composantes. */
  count: number;
}

const LOCK = TILE_KIND_INDEX.lock;
const VOID = TILE_KIND_INDEX.void;
const NO_COMPONENT = -1;

/**
 * Découpe la carte en composantes d'eau connexes (4-voisinage).
 *
 * Les écluses sont des **barrières** : elles appartiennent à leur propre
 * bief et ne sont pas traversées, ce qui autorise deux niveaux légitimes de
 * part et de l'autre. Les tuiles vides et sèches ne sont jamais incluses.
 *
 * Les nappes qui ne se touchent que par un coin restent deux composantes :
 * la règle est explicitement 4-connexe, comme le maillage des berges.
 */
export function waterComponentIndex(map: WaterLevelMap): WaterComponentIndex {
  const { width, height, kind, heightMap } = map;
  const size = width * height;
  const visited = new Uint8Array(size);
  const ids = new Int32Array(size).fill(NO_COMPONENT);
  const queue = new Int32Array(size);
  const levels: number[] = [];

  for (let start = 0; start < size; start += 1) {
    if (visited[start] === 1) continue;
    const kindIndex = kind[start] ?? VOID;
    if (kindIndex === LOCK || !isWaterKind(tileKindFromIndex(kindIndex))) continue;
    const id = levels.length;
    visited[start] = 1;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    let level = Number.POSITIVE_INFINITY;

    while (head < tail) {
      const index = queue[head] ?? 0;
      head += 1;
      ids[index] = id;
      const tileLevel = heightMap[index] ?? 0;
      if (tileLevel < level) level = tileLevel;

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

    levels.push(Number.isFinite(level) ? level : 0);
  }
  return { levels, ids, count: levels.length };
}

/** Liste détaillée des composantes (tests et diagnostic). */
export function waterComponents(map: WaterLevelMap): WaterComponent[] {
  const { ids, levels } = waterComponentIndex(map);
  const tiles: number[][] = levels.map(() => []);
  const distinctLevels: Set<number>[] = levels.map(() => new Set<number>());
  const { heightMap } = map;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index] ?? NO_COMPONENT;
    if (id < 0) continue;
    tiles[id]?.push(index);
    distinctLevels[id]?.add(heightMap[index] ?? 0);
  }
  return levels.map((level, id) => ({
    level,
    levels: [...(distinctLevels[id] ?? [])].sort((a, b) => a - b),
    tiles: tiles[id] ?? [],
  }));
}

/**
 * Niveau de rendu de chaque tuile.
 *
 * Toutes les tuiles d'une même composante 4-connexe sans écluse reçoivent le
 * niveau minimal de la composante. Une écluse conserve son propre niveau : elle
 * reste la seule dénivellation légitime, matérialisée par un bajoyer de pierre.
 * Les tuiles sèches et le vide gardent leur hauteur d'origine.
 *
 * Cette passe est pure et ne modifie pas la carte : le moteur OpenTTD (WASM)
 * garde son état, seul le rendu aplanit les nappes. Le mock applique en plus
 * `normalizeWaterLevels` à son monde, si bien que les deux moteurs convergent.
 */
export function waterRenderLevels(map: WaterLevelMap): Uint8Array {
  const { width, height, heightMap } = map;
  const size = width * height;
  const levels = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) levels[index] = heightMap[index] ?? 0;
  const { ids, levels: componentLevels } = waterComponentIndex(map);
  for (let index = 0; index < size; index += 1) {
    const id = ids[index] ?? NO_COMPONENT;
    if (id < 0) continue;
    levels[index] = componentLevels[id] ?? levels[index] ?? 0;
  }
  return levels;
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
