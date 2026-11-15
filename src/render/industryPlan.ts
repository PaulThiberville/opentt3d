/**
 * Planification des industries, sans dépendance Three.js.
 *
 * Une industrie du snapshot ne fournit que son centre et son type. On
 * reconstitue son emprise à partir des tuiles `industry` contiguës de la carte
 * (jamais une route, une gare ou une tuile de ville), puis on y répartit des
 * volumes low-poly déterministes : cheminées, silos, stocks, bâtiments annexes.
 *
 * Chaque partie est rattachée à une tuile et bornée à 0,92 tuile de large pour
 * ne jamais déborder de l'emprise. Le plan est ensuite fusionné en une seule
 * géométrie par archétype dans `IndustryLayer`.
 */

import type { IndustrySnapshot, MapSnapshot } from '../engine/protocol';
import { HEIGHT_SCALE, tileKindFromIndex } from '../game/mapGrid';
import { Prng, hashUnit2d } from '../game/prng';

export type IndustryArchetype =
  'mine' | 'power' | 'factory' | 'sawmill' | 'farm' | 'forest' | 'refinery' | 'quarry' | 'generic';

export type IndustryShape = 'box' | 'cylinder' | 'cone' | 'prism' | 'ico';

export type IndustryPartRole = 'main' | 'chimney' | 'silo' | 'stock' | 'annex' | 'detail';

export interface IndustryFootprintTile {
  x: number;
  y: number;
  /** Hauteur du terrain en unités monde. */
  height: number;
}

export interface IndustryPart {
  shape: IndustryShape;
  /** Centre de la partie en coordonnées monde (X, Z). */
  x: number;
  z: number;
  /** Hauteur du sol sous la partie (unités monde). */
  ground: number;
  /** Décalage vertical du pied de la partie. */
  base: number;
  width: number;
  depth: number;
  height: number;
  /** Lacet (radians). */
  rotation: number;
  tiltX: number;
  tiltZ: number;
  /** Cylindres : rapport rayon haut / rayon bas. */
  topScale: number;
  /** Si vrai, la géométrie est centrée sur son origine (objets couchés). */
  centre: boolean;
  colour: number;
  role: IndustryPartRole;
  /** Cheminée émettant de la fumée. */
  smoke: boolean;
}

export interface IndustryPlan {
  id: number;
  kind: string;
  archetype: IndustryArchetype;
  /** Tuiles utilisées pour le bâti et la fumée. */
  footprint: IndustryFootprintTile[];
  parts: IndustryPart[];
  /** Sommets des cheminées, pour l'animation de fumée. */
  smokeStacks: { x: number; y: number; z: number; scale: number }[];
}

/** Niveau de détail : 0 = basse qualité, 2 = haute qualité. */
export type IndustryDetail = 0 | 1 | 2;

const MAX_FOOTPRINT_TILES = 64;
const MAX_FOOTPRINT_RADIUS = 4;
const MAX_WIDTH = 0.92;
const EDGE_MARGIN = 0.02;

/** Tuiles qui ne doivent jamais recevoir d'industrie (routes, gares, eau…). */
const BLOCKED_KINDS = new Set([
  'void',
  'water',
  'coast',
  'river',
  'canal',
  'rail',
  'road',
  'house',
  'station',
  'bridge',
  'tunnel',
  'airport',
  'dock',
]);

/** Mappe un `kind` OpenTTD vers une silhouette. */
export function industryArchetype(kind: string): IndustryArchetype {
  const value = (kind ?? '').toLowerCase();
  if (value.includes('mine') || value.includes('quarry') || value.includes('pit')) {
    return value.includes('quarry') ? 'quarry' : 'mine';
  }
  if (value.includes('power') || value.includes('electric')) return 'power';
  if (value.includes('sawmill') || value.includes('lumber')) return 'sawmill';
  if (value.includes('forest') || value.includes('wood')) return 'forest';
  if (
    value.includes('farm') ||
    value.includes('plantation') ||
    value.includes('orchard') ||
    value.includes('grain')
  ) {
    return 'farm';
  }
  if (value.includes('oil') || value.includes('refin') || value.includes('chemical')) {
    return 'refinery';
  }
  if (
    value.includes('factory') ||
    value.includes('mill') ||
    value.includes('works') ||
    value.includes('plant') ||
    value.includes('steel') ||
    value.includes('brew') ||
    value.includes('food')
  ) {
    return 'factory';
  }
  if (value.includes('quarry') || value.includes('gravel')) return 'quarry';
  return 'generic';
}

export function planDetail(level: string): IndustryDetail {
  if (level === 'low') return 0;
  if (level === 'high') return 2;
  return 1;
}

/** Emprise industrielle : composante connexe de tuiles `industry`. */
export function collectIndustryFootprint(
  map: MapSnapshot | null,
  industry: IndustrySnapshot,
): IndustryFootprintTile[] {
  const startX = Math.floor(industry.x);
  const startY = Math.floor(industry.y);
  if (!map) return [{ x: startX, y: startY, height: 0 }];

  const isIndustry = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
    return tileKindFromIndex(map.kind[y * map.width + x] ?? 0) === 'industry';
  };
  const heightAt = (x: number, y: number): number =>
    (map.heightMap[y * map.width + x] ?? 0) * HEIGHT_SCALE;

  let rootX = startX;
  let rootY = startY;
  if (!isIndustry(rootX, rootY)) {
    let best: { x: number; y: number; distance: number } | null = null;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const x = startX + dx;
        const y = startY + dy;
        if (!isIndustry(x, y)) continue;
        const distance = dx * dx + dy * dy;
        if (!best || distance < best.distance) best = { x, y, distance };
      }
    }
    if (!best) return fallbackFootprint(map, startX, startY);
    rootX = best.x;
    rootY = best.y;
  }

  const tiles: IndustryFootprintTile[] = [];
  const visited = new Set<number>();
  const queue: { x: number; y: number }[] = [{ x: rootX, y: rootY }];
  while (queue.length > 0 && tiles.length < MAX_FOOTPRINT_TILES) {
    const current = queue.shift();
    if (!current) break;
    const key = current.y * map.width + current.x;
    if (visited.has(key)) continue;
    visited.add(key);
    if (!isIndustry(current.x, current.y)) continue;
    if (
      Math.abs(current.x - rootX) > MAX_FOOTPRINT_RADIUS ||
      Math.abs(current.y - rootY) > MAX_FOOTPRINT_RADIUS
    ) {
      continue;
    }
    tiles.push({ x: current.x, y: current.y, height: heightAt(current.x, current.y) });
    queue.push({ x: current.x + 1, y: current.y });
    queue.push({ x: current.x - 1, y: current.y });
    queue.push({ x: current.x, y: current.y + 1 });
    queue.push({ x: current.x, y: current.y - 1 });
  }
  if (tiles.length === 0) return fallbackFootprint(map, rootX, rootY);
  return tiles;
}

/** Repli quand le moteur ne marque pas les tuiles : petit terrain constructible. */
function fallbackFootprint(
  map: MapSnapshot,
  centreX: number,
  centreY: number,
): IndustryFootprintTile[] {
  const tiles: IndustryFootprintTile[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = centreX + dx;
      const y = centreY + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const kind = tileKindFromIndex(map.kind[y * map.width + x] ?? 0);
      if (BLOCKED_KINDS.has(kind)) continue;
      tiles.push({ x, y, height: (map.heightMap[y * map.width + x] ?? 0) * HEIGHT_SCALE });
    }
  }
  if (tiles.length === 0) {
    const x = Math.max(0, Math.min(map.width - 1, centreX));
    const y = Math.max(0, Math.min(map.height - 1, centreY));
    tiles.push({ x, y, height: (map.heightMap[y * map.width + x] ?? 0) * HEIGHT_SCALE });
  }
  return tiles;
}

interface Palette {
  wall: number;
  roof: number;
  accent: number;
  stack: number;
  stock: number;
}

const PALETTES: Record<IndustryArchetype, Palette> = {
  mine: { wall: 0x80715c, roof: 0x5b4b3c, accent: 0x6d5c48, stack: 0x4a4a4f, stock: 0x2b2a2c },
  power: { wall: 0x9a9a96, roof: 0x6f7378, accent: 0x8a3f32, stack: 0x7c4b41, stock: 0x2c2c2e },
  factory: {
    wall: 0x9a9184,
    roof: 0x5b626b,
    accent: 0x7f6b55,
    stack: 0x6a6a70,
    stock: 0x3a3a3d,
  },
  sawmill: {
    wall: 0x9b7c54,
    roof: 0x6b4a32,
    accent: 0x84643f,
    stack: 0x7a5a3a,
    stock: 0x8a6a45,
  },
  farm: { wall: 0xb8a482, roof: 0x8f4132, accent: 0x8f7a58, stack: 0x9a3f32, stock: 0xc7b071 },
  forest: {
    wall: 0x7f6a4c,
    roof: 0x4e5b3a,
    accent: 0x6a5236,
    stack: 0x5a4a35,
    stock: 0x6d5334,
  },
  refinery: {
    wall: 0xa8adb2,
    roof: 0x757b82,
    accent: 0x9aa0a6,
    stack: 0xb0b4b8,
    stock: 0x44474b,
  },
  quarry: {
    wall: 0x9d978a,
    roof: 0x777063,
    accent: 0x8c8578,
    stack: 0x6f6a60,
    stock: 0x8e877a,
  },
  generic: {
    wall: 0x968f82,
    roof: 0x5c6268,
    accent: 0x7e705c,
    stack: 0x666a70,
    stock: 0x3c3c40,
  },
};

interface PartSpec {
  shape: IndustryShape;
  role: IndustryPartRole;
  /** Index de tuile dans l'emprise triée. */
  tile: number;
  width: number;
  depth: number;
  height: number;
  base?: number;
  offsetX?: number;
  offsetZ?: number;
  tiltX?: number;
  tiltZ?: number;
  topScale?: number;
  centre?: boolean;
  colour?: number;
  smoke?: boolean;
  /** Détail minimal requis. */
  from?: IndustryDetail;
}

function shade(colour: number, amount: number): number {
  const factor = 1 + amount;
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * factor)));
  return (
    (channel((colour >> 16) & 0xff) << 16) |
    (channel((colour >> 8) & 0xff) << 8) |
    channel(colour & 0xff)
  );
}

function kindSeed(kind: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < kind.length; i += 1) {
    hash = Math.imul(hash ^ kind.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash;
}

function orderFootprint(
  footprint: IndustryFootprintTile[],
  industry: IndustrySnapshot,
  seed: number,
): IndustryFootprintTile[] {
  const centreX = industry.x;
  const centreZ = industry.y;
  return [...footprint].sort((a, b) => {
    const da = (a.x + 0.5 - centreX) ** 2 + (a.y + 0.5 - centreZ) ** 2;
    const db = (b.x + 0.5 - centreX) ** 2 + (b.y + 0.5 - centreZ) ** 2;
    if (Math.abs(da - db) > 1e-6) return da - db;
    const ha = hashUnit2d(seed, a.x, a.y);
    const hb = hashUnit2d(seed, b.x, b.y);
    if (ha === hb) return a.x - b.x || a.y - b.y;
    return ha - hb;
  });
}

/** Recettes par archétype : nombre de volumes borné pour tenir le budget. */
function recipe(archetype: IndustryArchetype, palette: Palette, rng: Prng): PartSpec[] {
  const mainHeight = rng.float(0.95, 1.12);
  const stackHeight = rng.float(0.94, 1.06);
  switch (archetype) {
    case 'mine':
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.1,
          depth: 0.1,
          height: 1.75 * mainHeight,
          offsetX: -0.15,
          tiltZ: -0.12,
          colour: palette.stack,
        },
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.1,
          depth: 0.1,
          height: 1.75 * mainHeight,
          offsetX: 0.15,
          tiltZ: 0.12,
          colour: palette.stack,
        },
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.42,
          depth: 0.12,
          height: 0.1,
          base: 1.55 * mainHeight,
          colour: palette.stack,
        },
        {
          shape: 'cylinder',
          role: 'detail',
          tile: 0,
          width: 0.4,
          depth: 0.4,
          height: 0.08,
          base: 1.48 * mainHeight,
          tiltX: Math.PI / 2,
          centre: true,
          colour: palette.stack,
        },
        { shape: 'box', role: 'main', tile: 1, width: 0.82, depth: 0.72, height: 0.58 },
        {
          shape: 'prism',
          role: 'main',
          tile: 1,
          width: 0.86,
          depth: 0.78,
          height: 0.22,
          base: 0.58,
          colour: palette.roof,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 2,
          width: 0.8,
          depth: 0.8,
          height: 0.52,
          colour: palette.stock,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 3,
          width: 0.7,
          depth: 0.6,
          height: 0.48,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 4,
          width: 0.58,
          depth: 0.58,
          height: 0.38,
          colour: palette.stock,
          from: 1,
        },
        {
          shape: 'box',
          role: 'detail',
          tile: 5,
          width: 0.9,
          depth: 0.16,
          height: 0.14,
          base: 0.05,
          colour: palette.stack,
          from: 2,
        },
      ];
    case 'power':
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.9,
          depth: 0.76,
          height: 0.8 * mainHeight,
        },
        { shape: 'box', role: 'main', tile: 1, width: 0.78, depth: 0.76, height: 1.1 },
        {
          shape: 'cylinder',
          role: 'chimney',
          tile: 2,
          width: 0.26,
          depth: 0.26,
          height: 3.1 * stackHeight,
          colour: palette.stack,
          smoke: true,
        },
        {
          shape: 'cylinder',
          role: 'chimney',
          tile: 3,
          width: 0.22,
          depth: 0.22,
          height: 2.7 * stackHeight,
          colour: palette.stack,
          smoke: true,
          from: 1,
        },
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 4,
          width: 0.8,
          depth: 0.8,
          height: 1.1,
          topScale: 1.32,
          colour: palette.wall,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 5,
          width: 0.82,
          depth: 0.82,
          height: 0.5,
          colour: palette.stock,
          from: 2,
        },
        {
          shape: 'prism',
          role: 'detail',
          tile: 0,
          width: 0.88,
          depth: 0.74,
          height: 0.2,
          base: 0.8 * mainHeight,
          colour: palette.roof,
          from: 2,
        },
      ];
    case 'factory':
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.9,
          depth: 0.78,
          height: 1.02 * mainHeight,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 1,
          width: 0.78,
          depth: 0.7,
          height: 0.62,
        },
        {
          shape: 'cylinder',
          role: 'chimney',
          tile: 2,
          width: 0.22,
          depth: 0.22,
          height: 2.5 * stackHeight,
          colour: palette.stack,
          smoke: true,
        },
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 3,
          width: 0.56,
          depth: 0.56,
          height: 1.45,
          colour: palette.accent,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'silo',
          tile: 3,
          width: 0.62,
          depth: 0.62,
          height: 0.26,
          base: 1.45,
          colour: palette.roof,
          from: 1,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 4,
          width: 0.8,
          depth: 0.42,
          height: 0.22,
          colour: palette.roof,
          from: 1,
        },
        {
          shape: 'prism',
          role: 'detail',
          tile: 0,
          width: 0.88,
          depth: 0.72,
          height: 0.28,
          base: 1.02 * mainHeight,
          colour: palette.roof,
          from: 1,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 5,
          width: 0.78,
          depth: 0.72,
          height: 0.68,
          from: 2,
        },
      ];
    case 'sawmill':
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.9,
          depth: 0.56,
          height: 0.62 * mainHeight,
        },
        {
          shape: 'prism',
          role: 'main',
          tile: 0,
          width: 0.88,
          depth: 0.62,
          height: 0.24,
          base: 0.62 * mainHeight,
          colour: palette.roof,
        },
        ...logStack(1, palette.stock, 0),
        ...logStack(2, palette.stock, 1),
        {
          shape: 'box',
          role: 'annex',
          tile: 3,
          width: 0.62,
          depth: 0.52,
          height: 0.46,
          from: 1,
        },
        {
          shape: 'prism',
          role: 'annex',
          tile: 3,
          width: 0.66,
          depth: 0.56,
          height: 0.18,
          base: 0.46,
          colour: palette.roof,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 4,
          width: 0.62,
          depth: 0.62,
          height: 0.34,
          colour: palette.stock,
          from: 2,
        },
      ];
    case 'farm':
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.9,
          depth: 0.64,
          height: 0.52 * mainHeight,
        },
        {
          shape: 'prism',
          role: 'main',
          tile: 0,
          width: 0.94,
          depth: 0.7,
          height: 0.26,
          base: 0.52 * mainHeight,
          colour: palette.roof,
        },
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 1,
          width: 0.52,
          depth: 0.52,
          height: 1.3,
          colour: palette.accent,
        },
        {
          shape: 'cone',
          role: 'silo',
          tile: 1,
          width: 0.58,
          depth: 0.58,
          height: 0.26,
          base: 1.3,
          colour: palette.roof,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 2,
          width: 0.68,
          depth: 0.58,
          height: 0.44,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 3,
          width: 0.6,
          depth: 0.6,
          height: 0.46,
          colour: palette.stock,
          from: 1,
        },
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 4,
          width: 0.44,
          depth: 0.44,
          height: 1.1,
          colour: palette.accent,
          from: 2,
        },
      ];
    case 'forest':
      return [
        ...logStack(0, palette.stock, 0),
        ...logStack(1, palette.stock, 1),
        {
          shape: 'box',
          role: 'annex',
          tile: 2,
          width: 0.6,
          depth: 0.5,
          height: 0.44,
        },
        {
          shape: 'prism',
          role: 'annex',
          tile: 2,
          width: 0.64,
          depth: 0.54,
          height: 0.18,
          base: 0.44,
          colour: palette.roof,
        },
        {
          shape: 'cone',
          role: 'detail',
          tile: 3,
          width: 0.62,
          depth: 0.62,
          height: 1.15,
          colour: 0x2f5428,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'detail',
          tile: 4,
          width: 0.5,
          depth: 0.5,
          height: 0.9,
          colour: 0x35602c,
          from: 2,
        },
      ];
    case 'refinery':
      return [
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 0,
          width: 0.7,
          depth: 0.7,
          height: 0.72 * mainHeight,
          colour: palette.wall,
        },
        {
          shape: 'cylinder',
          role: 'chimney',
          tile: 1,
          width: 0.36,
          depth: 0.36,
          height: 2.5 * stackHeight,
          colour: palette.stack,
          smoke: true,
        },
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 2,
          width: 0.58,
          depth: 0.58,
          height: 0.64,
          colour: palette.accent,
          from: 1,
        },
        {
          shape: 'cylinder',
          role: 'detail',
          tile: 3,
          width: 0.14,
          depth: 0.14,
          height: 1.9,
          colour: palette.stack,
        },
        {
          shape: 'cone',
          role: 'detail',
          tile: 3,
          width: 0.22,
          depth: 0.22,
          height: 0.28,
          base: 1.9,
          colour: 0xff9a3c,
          from: 1,
        },
        {
          shape: 'box',
          role: 'detail',
          tile: 4,
          width: 0.9,
          depth: 0.12,
          height: 0.12,
          base: 0.52,
          colour: palette.roof,
          from: 2,
        },
      ];
    case 'quarry':
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.9,
          depth: 0.82,
          height: 0.16,
          colour: palette.stock,
        },
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.68,
          depth: 0.6,
          height: 0.16,
          base: 0.16,
          colour: palette.accent,
        },
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.46,
          depth: 0.38,
          height: 0.16,
          base: 0.32,
          colour: palette.stock,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 1,
          width: 0.76,
          depth: 0.76,
          height: 0.56,
          colour: palette.stock,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 2,
          width: 0.68,
          depth: 0.58,
          height: 0.46,
          from: 1,
        },
        {
          shape: 'prism',
          role: 'annex',
          tile: 2,
          width: 0.72,
          depth: 0.62,
          height: 0.18,
          base: 0.46,
          colour: palette.roof,
          from: 1,
        },
        {
          shape: 'cone',
          role: 'stock',
          tile: 3,
          width: 0.5,
          depth: 0.5,
          height: 0.36,
          colour: palette.stock,
          from: 2,
        },
      ];
    case 'generic':
    default:
      return [
        {
          shape: 'box',
          role: 'main',
          tile: 0,
          width: 0.9,
          depth: 0.76,
          height: 0.86 * mainHeight,
        },
        {
          shape: 'cylinder',
          role: 'chimney',
          tile: 1,
          width: 0.2,
          depth: 0.2,
          height: 2.2 * stackHeight,
          colour: palette.stack,
          smoke: true,
        },
        {
          shape: 'cylinder',
          role: 'silo',
          tile: 2,
          width: 0.52,
          depth: 0.52,
          height: 1.2,
          colour: palette.accent,
        },
        {
          shape: 'cone',
          role: 'silo',
          tile: 2,
          width: 0.58,
          depth: 0.58,
          height: 0.24,
          base: 1.2,
          colour: palette.roof,
        },
        {
          shape: 'box',
          role: 'annex',
          tile: 3,
          width: 0.68,
          depth: 0.58,
          height: 0.5,
          from: 1,
        },
        {
          shape: 'prism',
          role: 'detail',
          tile: 0,
          width: 0.88,
          depth: 0.72,
          height: 0.22,
          base: 0.86 * mainHeight,
          colour: palette.roof,
          from: 2,
        },
      ];
  }
}

/** Trois grumes couchées, alignées sur X et empilées en Z. */
function logStack(tile: number, colour: number, from: IndustryDetail): PartSpec[] {
  const logs: PartSpec[] = [];
  for (let i = 0; i < 3; i += 1) {
    logs.push({
      shape: 'cylinder',
      role: 'stock',
      tile,
      width: 0.16,
      depth: 0.16,
      height: 0.7,
      base: 0.09 + i * 0.02,
      offsetZ: (i - 1) * 0.17,
      tiltZ: Math.PI / 2,
      centre: true,
      colour,
      from,
    });
  }
  return logs;
}

function clampOffset(offset: number, width: number): number {
  const limit = Math.max(0, 0.5 - width / 2 - EDGE_MARGIN);
  return Math.max(-limit, Math.min(limit, offset));
}

function buildPart(
  spec: PartSpec,
  tile: IndustryFootprintTile,
  rng: Prng,
  palette: Palette,
): IndustryPart {
  const width = Math.min(MAX_WIDTH, Math.max(0.04, spec.width));
  const depth = Math.min(MAX_WIDTH, Math.max(0.04, spec.depth));
  const offsetX = clampOffset(spec.offsetX ?? 0, width);
  const offsetZ = clampOffset(spec.offsetZ ?? 0, depth);
  const defaultColour =
    spec.role === 'main'
      ? palette.wall
      : spec.role === 'annex'
        ? palette.accent
        : spec.role === 'chimney'
          ? palette.stack
          : spec.role === 'stock'
            ? palette.stock
            : palette.wall;
  return {
    shape: spec.shape,
    x: tile.x + 0.5 + offsetX,
    z: tile.y + 0.5 + offsetZ,
    ground: tile.height,
    base: spec.base ?? 0,
    width,
    depth,
    height: Math.max(0.03, spec.height),
    rotation: 0,
    tiltX: spec.tiltX ?? 0,
    tiltZ: spec.tiltZ ?? 0,
    topScale: spec.topScale ?? 1,
    centre: spec.centre ?? false,
    colour: shade(spec.colour ?? defaultColour, rng.float(-0.06, 0.08)),
    role: spec.role,
    smoke: spec.smoke ?? false,
  };
}

/** Construit le plan d'une industrie : volumes déterministes dans son emprise. */
export function planIndustry(
  industry: IndustrySnapshot,
  footprint: IndustryFootprintTile[],
  detail: IndustryDetail,
): IndustryPlan {
  const archetype = industryArchetype(industry.kind);
  const palette = PALETTES[archetype];
  const seed = (industry.id + 1) * 7919 + kindSeed(industry.kind);
  const rng = new Prng(seed);
  const tiles =
    footprint.length > 0
      ? orderFootprint(footprint, industry, seed)
      : [{ x: Math.floor(industry.x), y: Math.floor(industry.y), height: 0 }];
  const specs = recipe(archetype, palette, rng).filter((spec) => detail >= (spec.from ?? 0));
  const parts: IndustryPart[] = [];
  for (const spec of specs) {
    const tile = tiles[spec.tile % tiles.length];
    if (!tile) continue;
    parts.push(buildPart(spec, tile, rng, palette));
  }
  const smokeStacks = parts
    .filter((part) => part.smoke)
    .map((part) => ({
      x: part.x,
      y: part.ground + part.base + part.height,
      z: part.z,
      scale: Math.max(0.18, part.width * 0.75),
    }));
  return {
    id: industry.id,
    kind: industry.kind,
    archetype,
    footprint: tiles,
    parts,
    smokeStacks,
  };
}
