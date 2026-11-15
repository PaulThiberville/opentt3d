/**
 * Mathématiques de la caméra tycoon : conversions pures et contraintes.
 *
 * Aucun accès au DOM ici, uniquement Three.js mathématique : ces helpers sont
 * testés sous Node (Vitest) et utilisés par `CameraController`.
 *
 * Convention monde : Three.js X = est, Y = hauteur, Z = sud (Y du protocole).
 */

import * as THREE from 'three';
import { clamp } from '../game/interpolation';

export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CameraPose {
  target: THREE.Vector3;
  /** Azimut en radians (0 = caméra au sud, regarde vers le nord). */
  yaw: number;
  /** Élévation en radians (0 = horizon, π/2 = au-dessus). */
  pitch: number;
  /** Distance cible depuis le point visé. */
  distance: number;
}

export const MIN_PITCH = 0.18;
export const MAX_PITCH = 1.45;
export const MIN_DISTANCE = 6;
export const MAX_DISTANCE = 340;
/** Marge intérieure pour garder la cible dans la carte. */
export const TARGET_MARGIN = 2;
/** Hauteur minimale de la caméra au-dessus du terrain. */
export const CAMERA_GROUND_CLEARANCE = 2.4;

export function clampPitch(pitch: number): number {
  return clamp(pitch, MIN_PITCH, MAX_PITCH);
}

export function clampDistance(distance: number): number {
  return clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
}

/** Borne la cible à l'intérieur de la carte (mutation en place). */
export function clampTarget(
  target: THREE.Vector3,
  bounds: MapBounds,
  margin = TARGET_MARGIN,
): THREE.Vector3 {
  const minX = Math.min(bounds.minX + margin, bounds.maxX - margin);
  const minZ = Math.min(bounds.minZ + margin, bounds.maxZ - margin);
  const maxX = Math.max(bounds.minX + margin, bounds.maxX - margin);
  const maxZ = Math.max(bounds.minZ + margin, bounds.maxZ - margin);
  target.x = clamp(target.x, minX, maxX);
  target.z = clamp(target.z, minZ, maxZ);
  return target;
}

/** Décalage de la caméra par rapport à la cible. */
export function cameraOffset(
  yaw: number,
  pitch: number,
  distance: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const horizontal = Math.cos(pitch) * distance;
  out.set(Math.sin(yaw) * horizontal, Math.sin(pitch) * distance, Math.cos(yaw) * horizontal);
  return out;
}

export function computeCameraPosition(pose: CameraPose, out = new THREE.Vector3()): THREE.Vector3 {
  return cameraOffset(pose.yaw, pose.pitch, pose.distance, out).add(pose.target);
}

/** Repère de déplacement au sol pour le pan. */
export function panBasis(yaw: number): {
  forwardX: number;
  forwardZ: number;
  rightX: number;
  rightZ: number;
} {
  return {
    forwardX: -Math.sin(yaw),
    forwardZ: -Math.cos(yaw),
    rightX: Math.cos(yaw),
    rightZ: -Math.sin(yaw),
  };
}

/**
 * Empêche la caméra de passer sous le terrain.
 * Renvoie la hauteur corrigée et écrit la position ajustée.
 */
export function enforceAboveGround(
  position: THREE.Vector3,
  heightAt: (x: number, z: number) => number,
  clearance = CAMERA_GROUND_CLEARANCE,
): THREE.Vector3 {
  const ground = heightAt(position.x, position.z);
  const minY = ground + clearance;
  if (position.y < minY) position.y = minY;
  return position;
}

/** Coordonnées écran → NDC ([-1, 1]). */
export function screenToNdc(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): {
  x: number;
  y: number;
} {
  const width = rect.width || 1;
  const height = rect.height || 1;
  return {
    x: ((clientX - rect.left) / width) * 2 - 1,
    y: -((clientY - rect.top) / height) * 2 + 1,
  };
}

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const scratchRay = new THREE.Raycaster();

/**
 * Intersection du rayon écran avec un plan horizontal (y = planeY).
 * Utilisé pour le zoom vers le curseur et le double-clic de recentrage.
 */
export function groundPointFromNdc(
  ndc: { x: number; y: number },
  camera: THREE.Camera,
  planeY: number,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  scratchRay.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  groundPlane.constant = -planeY;
  const hit = scratchRay.ray.intersectPlane(groundPlane, out);
  return hit ? out : null;
}

/** Facteur de zoom appliqué à une molette (deltaY en pixels). */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(clamp(deltaY, -320, 320) * 0.0016);
}

/** Pas de déplacement clavier, proportionnel à la distance caméra. */
export function keyboardPanStep(distance: number, deltaSeconds: number): number {
  return clamp(distance * 0.85, 6, 90) * deltaSeconds;
}
