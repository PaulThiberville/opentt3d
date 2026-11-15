/**
 * Géométrie de la minimap : cadrage de la carte et empreinte caméra au sol.
 *
 * Pur (aucun canvas, aucun DOM) et testé sous Node. La minimap affiche la
 * carte entière en conservant ses proportions, puis dessine le quadrilatère
 * au sol couvert par la caméra.
 */

import type { CameraView } from './types';

const MINIMAP_SIGNATURE_OFFSET = 0x811c9dc5;
const MINIMAP_SIGNATURE_PRIME = 0x01000193;

/**
 * Empreinte stable de la carte affichée par la minimap.
 *
 * Seuls le type de tuile et la hauteur influencent l'ImageData de base : les
 * entités (villes, industries, véhicules) sont redessinées à part et n'ont pas
 * besoin de déclencher une reconstruction du fond.
 */
export function computeMapSignature(map: {
  width: number;
  height: number;
  kind: Uint8Array;
  heightMap: Uint8Array;
}): number {
  let hash = MINIMAP_SIGNATURE_OFFSET;
  hash = Math.imul(hash ^ map.width, MINIMAP_SIGNATURE_PRIME) >>> 0;
  hash = Math.imul(hash ^ map.height, MINIMAP_SIGNATURE_PRIME) >>> 0;
  for (let index = 0; index < map.kind.length; index += 1) {
    hash = Math.imul(hash ^ (map.kind[index] ?? 0), MINIMAP_SIGNATURE_PRIME) >>> 0;
  }
  for (let index = 0; index < map.heightMap.length; index += 1) {
    hash = Math.imul(hash ^ (map.heightMap[index] ?? 0), MINIMAP_SIGNATURE_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Limite les redraws de la minimap à une fréquence cible (4-10 Hz). */
export class RedrawThrottle {
  private last = Number.NEGATIVE_INFINITY;
  private interval: number;

  constructor(intervalMs = 100) {
    this.interval = Math.max(0, intervalMs);
  }

  shouldDraw(now: number, force = false): boolean {
    if (force) {
      this.last = now;
      return true;
    }
    if (now - this.last < this.interval) return false;
    this.last = now;
    return true;
  }

  reset(): void {
    this.last = Number.NEGATIVE_INFINITY;
  }
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinimapLayout {
  /** Zone de la carte dans le canvas, en pixels CSS. */
  frame: Rect;
  /** Pixels CSS par tuile. */
  scale: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEFAULT_FOV = (52 * Math.PI) / 180;

/** Cadre centré qui conserve le ratio largeur/hauteur de la carte. */
export function computeMinimapLayout(
  mapWidth: number,
  mapHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): MinimapLayout {
  const mw = mapWidth > 0 ? mapWidth : 1;
  const mh = mapHeight > 0 ? mapHeight : 1;
  const cw = Math.max(1, canvasWidth);
  const ch = Math.max(1, canvasHeight);
  const scale = Math.min(cw / mw, ch / mh);
  const width = mw * scale;
  const height = mh * scale;
  return {
    frame: { x: (cw - width) / 2, y: (ch - height) / 2, width, height },
    scale,
  };
}

export function worldToMinimap(
  x: number,
  y: number,
  layout: MinimapLayout,
  mapWidth: number,
  mapHeight: number,
): Point {
  const mw = mapWidth > 0 ? mapWidth : 1;
  const mh = mapHeight > 0 ? mapHeight : 1;
  return {
    x: layout.frame.x + (x / mw) * layout.frame.width,
    y: layout.frame.y + (y / mh) * layout.frame.height,
  };
}

/** Conversion inverse, bornée aux bords de la carte. */
export function minimapToWorld(
  px: number,
  py: number,
  layout: MinimapLayout,
  mapWidth: number,
  mapHeight: number,
): Point {
  const mw = mapWidth > 0 ? mapWidth : 1;
  const mh = mapHeight > 0 ? mapHeight : 1;
  const fx = layout.frame.width > 0 ? (px - layout.frame.x) / layout.frame.width : 0;
  const fy = layout.frame.height > 0 ? (py - layout.frame.y) / layout.frame.height : 0;
  return {
    x: Math.max(0, Math.min(1, fx)) * mw,
    y: Math.max(0, Math.min(1, fy)) * mh,
  };
}

export function normalizeVec3(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Intersection des quatre rayons de frustum avec le plan horizontal passant
 * par la cible. Renvoie les coins dans l'ordre haut-gauche, haut-droit,
 * bas-droit, bas-gauche (repère monde X/Z).
 */
export function cameraFootprint(
  view: CameraView,
  aspect: number,
  fovRadians = DEFAULT_FOV,
): Point[] {
  const targetY = Number.isFinite(view.targetY) ? (view.targetY as number) : 0;
  const distance = Math.max(0.1, view.distance);
  const pitch = Math.max(0.02, Math.min(Math.PI / 2 - 0.01, view.pitch));
  const horizontal = Math.cos(pitch) * distance;
  const camera: Vec3 = {
    x: view.targetX + Math.sin(view.yaw) * horizontal,
    y: targetY + Math.sin(pitch) * distance,
    z: view.targetZ + Math.cos(view.yaw) * horizontal,
  };
  const forward = normalizeVec3({
    x: -Math.sin(view.yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: -Math.cos(view.yaw) * Math.cos(pitch),
  });
  const right = normalizeVec3(crossVec3(forward, { x: 0, y: 1, z: 0 }));
  const up = crossVec3(right, forward);
  const tanV = Math.tan(Math.max(0.05, Math.min(1.4, fovRadians)) / 2);
  const tanH = tanV * Math.max(0.2, aspect);
  const signs: [number, number][] = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ];
  const points: Point[] = [];
  for (const [sx, sy] of signs) {
    const direction = normalizeVec3({
      x: forward.x + right.x * sx * tanH + up.x * sy * tanV,
      y: forward.y + right.y * sx * tanH + up.y * sy * tanV,
      z: forward.z + right.z * sx * tanH + up.z * sy * tanV,
    });
    let travel: number;
    if (direction.y > -1e-3) {
      // Rayon rasant ou au-dessus de l'horizon : borne raisonnable plutôt
      // qu'une intersection quasi infinie qui dégénère le polygone.
      travel = distance * 8;
    } else {
      travel = (targetY - camera.y) / direction.y;
    }
    travel = Math.max(0, Math.min(travel, distance * 12));
    points.push({ x: camera.x + direction.x * travel, y: camera.z + direction.z * travel });
  }
  return points;
}
