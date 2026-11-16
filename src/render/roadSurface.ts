/**
 * Profil de hauteur de la chaussée (#202).
 *
 * Une route ne doit pas suivre la pente **en largeur** (dévers) : la chaussée
 * est horizontale transversalement et ne s'incline que dans le sens de la
 * longueur. Le terrain, lui, reste inchangé : une route en travers d'un
 * versant est donc posée plus haut d'un côté que de l'autre, et ses joues
 * (trottoirs, bordures) referment l'écart avec le sol.
 *
 * Les hauteurs de référence sont prises sur les **bords de chaque tuile**, à
 * partir de leurs deux coins de terrain. Deux tuiles voisines calculent donc
 * exactement la même hauteur sur leur arête commune, quelle que soit leur
 * forme : la chaussée est continue aux jonctions, aux virages et aux impasses.
 * Pour ne pas être recoupée par le sol sur un versant, la chaussée se cale
 * juste sous le coin haut du bord (voir `EDGE_HIGH_BIAS`) : le terrain
 * n'affleure plus que sur une fine bande reprise par le trottoir, et les
 * véhicules restent à quelques centimètres de la surface.
 *
 * Les carrefours et virages utilisent un éventail de quatre triangles : chaque
 * bras est horizontal dans sa largeur, avec un bord extérieur plat raccordé au
 * voisin. Les coutures entre deux bras se réduisent à des triangles verticaux
 * d'aire nulle en projection, donc sans trou ni facette visible de dessus.
 */

import type { MapSnapshot } from '../engine/protocol';
import { cornerHeightWorld, sampleHeightWorld } from '../game/mapGrid';
import { TRACK_CONNECT, type TrackTilePlan } from './trackPlan';

/** Hauteurs (monde, sans surélévation) des quatre bords et du centre. */
export interface RoadTileHeights {
  north: number;
  east: number;
  south: number;
  west: number;
  centre: number;
}

/**
 * Part du dénivelé transversal laissée sous le bord haut.
 *
 * Sur un versant, une chaussée strictement au niveau du centre serait coupée
 * en deux par le terrain : le sol monte au-dessus d'elle sur toute la moitié
 * amont. On cale donc la chaussée un peu sous le bord haut (15 % de l'écart
 * entre les deux coins). Le terrain n'affleure plus que sur une fine bande
 * couverte par le trottoir, tout en gardant les véhicules à quelques
 * centimètres de la surface.
 */
const EDGE_HIGH_BIAS = 0.15;

export type RoadSurfaceMode = 'straight' | 'junction';

export interface RoadSurface {
  mode: RoadSurfaceMode;
  /** Axe longitudinal d'une route droite ; `null` pour un carrefour. */
  axis: 'x' | 'y' | null;
  heights: RoadTileHeights;
  /** Hauteur du terrain sous la chaussée en un point de la tuile. */
  heightAt(x: number, z: number): number;
  /** Hauteur plate d'un bord de tuile (bit `TRACK_CONNECT`). */
  sideHeight(bit: number): number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Hauteur d'un bord de tuile, légèrement sous son coin le plus haut.
 *
 * La hauteur ne dépend que des deux coins du bord : deux tuiles voisines
 * obtiennent donc exactement la même valeur le long de leur arête commune,
 * quelle que soit leur forme (droite, virage, T ou croisement).
 */
function edgeHeight(map: MapSnapshot, ax: number, az: number, bx: number, bz: number): number {
  const first = cornerHeightWorld(map, ax, az);
  const second = cornerHeightWorld(map, bx, bz);
  const high = Math.max(first, second);
  const low = Math.min(first, second);
  return high - (high - low) * EDGE_HIGH_BIAS;
}

/**
 * Hauteurs de référence d'une tuile route.
 *
 * Chaque bord est plat et partagé avec la tuile voisine. Le centre sert de
 * point de raccord aux carrefours : il reprend la hauteur bilinéaire du sol,
 * celle des véhicules.
 */
export function roadTileHeights(map: MapSnapshot, plan: TrackTilePlan): RoadTileHeights {
  const { x, y } = plan;
  return {
    north: edgeHeight(map, x, y, x + 1, y),
    east: edgeHeight(map, x + 1, y, x + 1, y + 1),
    south: edgeHeight(map, x, y + 1, x + 1, y + 1),
    west: edgeHeight(map, x, y, x, y + 1),
    centre: sampleHeightWorld(map, x + 0.5, y + 0.5),
  };
}

function sideHeightOf(heights: RoadTileHeights, bit: number): number {
  switch (bit) {
    case TRACK_CONNECT.north:
      return heights.north;
    case TRACK_CONNECT.east:
      return heights.east;
    case TRACK_CONNECT.south:
      return heights.south;
    default:
      return heights.west;
  }
}

/**
 * Profil de chaussée d'une tuile route.
 *
 * - droite, impasse, tuile isolée : une seule pente longitudinale, nulle en
 *   travers ;
 * - virage, T, croisement : quatre bras à bords plats, raccordés au centre.
 */
export function buildRoadSurface(map: MapSnapshot, plan: TrackTilePlan): RoadSurface {
  const heights = roadTileHeights(map, plan);
  const straight =
    plan.shape === 'straight' || plan.shape === 'dead-end' || plan.shape === 'isolated';
  const axis: 'x' | 'y' | null = straight ? (plan.axis ?? 'x') : null;

  if (axis === 'x') {
    const { x } = plan;
    const west = heights.west;
    const east = heights.east;
    return {
      mode: 'straight',
      axis,
      heights,
      heightAt: (px: number) => west + (east - west) * clamp01(px - x),
      sideHeight: (bit) => sideHeightOf(heights, bit),
    };
  }

  if (axis === 'y') {
    const { y } = plan;
    const north = heights.north;
    const south = heights.south;
    return {
      mode: 'straight',
      axis,
      heights,
      heightAt: (_px: number, pz: number) => north + (south - north) * clamp01(pz - y),
      sideHeight: (bit) => sideHeightOf(heights, bit),
    };
  }

  const { centre } = heights;
  return {
    mode: 'junction',
    axis: null,
    heights,
    heightAt: (px: number, pz: number) => {
      const u = clamp01(px - plan.x);
      const v = clamp01(pz - plan.y);
      const toNorth = 0.5 - Math.abs(u - 0.5);
      if (v <= toNorth) return heights.north + (centre - heights.north) * (v / 0.5);
      if (v >= 1 - toNorth) return heights.south + (centre - heights.south) * ((1 - v) / 0.5);
      if (u >= 0.5) return heights.east + (centre - heights.east) * ((1 - u) / 0.5);
      return heights.west + (centre - heights.west) * (u / 0.5);
    },
    sideHeight: (bit) => sideHeightOf(heights, bit),
  };
}
