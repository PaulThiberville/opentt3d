/**
 * Bibliothèque de modèles de véhicules, construite exclusivement en code.
 *
 * Chaque archétype est une géométrie fusionnée, orientée vers +X, aux
 * dimensions exprimées en tuiles (1 tuile ≈ 1 unité monde). Les corps sont
 * blancs pour être teintés par `InstancedMesh.setColorAt()` ; les vitres, le
 * châssis, les roues et les charges restent sombres. Un seul maillage par
 * archétype permet de garder quelques draw calls pour toute la flotte.
 *
 * Aucun chargement asynchrone, aucun GLB, aucun asset binaire.
 */

import * as THREE from 'three';
import type { VehicleModelKind } from '../../game/vehicleInterpolation';
import {
  MODEL_COLOURS,
  beveledBox,
  box,
  cylinder,
  disposeGeometries,
  extrudePlan,
  extrudeShape,
  hub,
  measureGeometry,
  mergeParts,
  wheel,
  type ModelBounds,
} from './modelUtils';

/** Archétypes visuels exposés au rendu (plus fins que les 5 familles du contrat). */
export const VEHICLE_VARIANTS = [
  'train-steam',
  'train-coach',
  'train-freight',
  'truck-flat',
  'truck-tanker',
  'bus-city',
  'bus-coach',
  'ship',
  'plane',
] as const;

export type VehicleVariant = (typeof VEHICLE_VARIANTS)[number];

export interface VehicleSize {
  length: number;
  width: number;
  height: number;
}

export interface VehicleModelDefinition {
  variant: VehicleVariant;
  geometry: THREE.BufferGeometry;
  triangles: number;
  bounds: ModelBounds;
  /** Dimensions hors tout en tuiles (longueur sur X, largeur sur Z, hauteur sur Y). */
  size: VehicleSize;
  /** Rayon du halo de sélection au sol. */
  haloRadius: number;
  /** Décalage vertical appliqué au-dessus du sol du véhicule. */
  groundOffset: number;
}

const MAX_VEHICLE_TRIANGLES = 3000;

function polygonShape(points: ReadonlyArray<readonly [number, number]>): THREE.Shape {
  const shape = new THREE.Shape();
  const first = points[0];
  if (!first) throw new Error('Forme vide');
  shape.moveTo(first[0], first[1]);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point) shape.lineTo(point[0], point[1]);
  }
  shape.closePath();
  return shape;
}

function finalize(
  variant: VehicleVariant,
  parts: readonly THREE.BufferGeometry[],
  haloRadius: number,
  groundOffset = 0.01,
): VehicleModelDefinition {
  const geometry = mergeParts(parts, `vehicle-${variant}`);
  const { triangles, bounds } = measureGeometry(geometry);
  if (triangles > MAX_VEHICLE_TRIANGLES) {
    throw new Error(`Modèle ${variant} : ${triangles} triangles (budget ${MAX_VEHICLE_TRIANGLES})`);
  }
  return {
    variant,
    geometry,
    triangles,
    bounds,
    size: {
      length: bounds.maxX - bounds.minX,
      width: bounds.maxZ - bounds.minZ,
      height: bounds.maxY - bounds.minY,
    },
    haloRadius,
    groundOffset,
  };
}

// ---------------------------------------------------------------------------
// Bus urbain
// ---------------------------------------------------------------------------

function busCityShape(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0.12);
  shape.lineTo(0.5, 0.12);
  shape.quadraticCurveTo(0.53, 0.12, 0.53, 0.2);
  shape.lineTo(0.53, 0.42);
  shape.quadraticCurveTo(0.53, 0.52, 0.45, 0.54);
  shape.quadraticCurveTo(0, 0.58, -0.45, 0.54);
  shape.quadraticCurveTo(-0.53, 0.52, -0.53, 0.42);
  shape.lineTo(-0.53, 0.2);
  shape.quadraticCurveTo(-0.53, 0.12, -0.5, 0.12);
  shape.closePath();
  return shape;
}

function buildBusCity(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    extrudeShape(busCityShape(), 0.34, MODEL_COLOURS.body),
    box(0.96, 0.035, 0.006, MODEL_COLOURS.bodyShade, 0, 0.245, 0.173),
    box(0.96, 0.035, 0.006, MODEL_COLOURS.bodyShade, 0, 0.245, -0.173),
    // Bandes vitrées latérales découpées par des montants.
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, -0.35, 0.365, 0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, -0.17, 0.365, 0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, 0.01, 0.365, 0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, 0.19, 0.365, 0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, 0.36, 0.365, 0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, -0.35, 0.365, -0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, -0.17, 0.365, -0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, 0.01, 0.365, -0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, 0.19, 0.365, -0.172),
    box(0.14, 0.17, 0.012, MODEL_COLOURS.glass, 0.36, 0.365, -0.172),
    // Pare-brise, lunette et afficheur de ligne.
    box(0.014, 0.2, 0.29, MODEL_COLOURS.glass, 0.529, 0.375, 0),
    box(0.014, 0.16, 0.26, MODEL_COLOURS.glass, -0.532, 0.36, 0),
    box(0.018, 0.05, 0.22, MODEL_COLOURS.glassLight, 0.535, 0.49, 0),
    // Portes (joints sombres) et poignées.
    box(0.012, 0.27, 0.008, MODEL_COLOURS.chassis, 0.28, 0.26, 0.174),
    box(0.012, 0.27, 0.008, MODEL_COLOURS.chassis, 0.28, 0.26, -0.174),
    box(0.012, 0.27, 0.008, MODEL_COLOURS.chassis, -0.44, 0.26, 0.174),
    box(0.012, 0.27, 0.008, MODEL_COLOURS.chassis, -0.44, 0.26, -0.174),
    // Toit, climatisation et rambardes.
    beveledBox(0.9, 0.035, 0.31, MODEL_COLOURS.roof, { y: 0.566, radius: 0.012 }),
    beveledBox(0.22, 0.045, 0.19, MODEL_COLOURS.bodyShade, {
      x: -0.12,
      y: 0.6,
      radius: 0.012,
    }),
    box(0.62, 0.012, 0.012, MODEL_COLOURS.metal, 0.05, 0.59, 0.15),
    box(0.62, 0.012, 0.012, MODEL_COLOURS.metal, 0.05, 0.59, -0.15),
    // Boucliers, phares et rétroviseurs.
    box(0.035, 0.07, 0.32, MODEL_COLOURS.chassis, 0.545, 0.135, 0),
    box(0.035, 0.06, 0.3, MODEL_COLOURS.chassis, -0.545, 0.13, 0),
    box(0.014, 0.055, 0.065, MODEL_COLOURS.lamp, 0.55, 0.205, 0.105),
    box(0.014, 0.055, 0.065, MODEL_COLOURS.lamp, 0.55, 0.205, -0.105),
    box(0.014, 0.04, 0.05, MODEL_COLOURS.tailLight, -0.55, 0.205, 0.11),
    box(0.014, 0.04, 0.05, MODEL_COLOURS.tailLight, -0.55, 0.205, -0.11),
    box(0.025, 0.025, 0.06, MODEL_COLOURS.chassis, 0.48, 0.46, 0.195),
    box(0.025, 0.025, 0.06, MODEL_COLOURS.chassis, 0.48, 0.46, -0.195),
    // Châssis et roues.
    box(0.94, 0.06, 0.28, MODEL_COLOURS.chassis, 0, 0.12, 0),
    wheel(0.078, 0.055, MODEL_COLOURS.wheel, 0.33, 0.078, 0.15),
    wheel(0.078, 0.055, MODEL_COLOURS.wheel, 0.33, 0.078, -0.15),
    wheel(0.078, 0.055, MODEL_COLOURS.wheel, -0.35, 0.078, 0.15),
    wheel(0.078, 0.055, MODEL_COLOURS.wheel, -0.35, 0.078, -0.15),
    hub(0.036, 0.008, MODEL_COLOURS.metal, 0.33, 0.078, 0.176),
    hub(0.036, 0.008, MODEL_COLOURS.metal, 0.33, 0.078, -0.176),
    hub(0.036, 0.008, MODEL_COLOURS.metal, -0.35, 0.078, 0.176),
    hub(0.036, 0.008, MODEL_COLOURS.metal, -0.35, 0.078, -0.176),
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// Autocar
// ---------------------------------------------------------------------------

function coachShape(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-0.6, 0.12);
  shape.quadraticCurveTo(-0.67, 0.16, -0.67, 0.28);
  shape.lineTo(-0.67, 0.5);
  shape.quadraticCurveTo(-0.67, 0.62, -0.55, 0.64);
  shape.quadraticCurveTo(0, 0.68, 0.55, 0.64);
  shape.quadraticCurveTo(0.67, 0.62, 0.67, 0.5);
  shape.lineTo(0.67, 0.28);
  shape.quadraticCurveTo(0.67, 0.16, 0.6, 0.12);
  shape.closePath();
  return shape;
}

function buildBusCoach(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    extrudeShape(coachShape(), 0.36, MODEL_COLOURS.body),
    // Grande bande vitrée panoramique, montants clairs.
    box(1.02, 0.21, 0.01, MODEL_COLOURS.glass, 0, 0.445, 0.181),
    box(1.02, 0.21, 0.01, MODEL_COLOURS.glass, 0, 0.445, -0.181),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, -0.42, 0.445, 0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, -0.21, 0.445, 0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, 0, 0.445, 0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, 0.21, 0.445, 0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, 0.42, 0.445, 0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, -0.42, 0.445, -0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, -0.21, 0.445, -0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, 0, 0.445, -0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, 0.21, 0.445, -0.183),
    box(0.028, 0.22, 0.014, MODEL_COLOURS.trim, 0.42, 0.445, -0.183),
    // Soute à bagages et bas de caisse.
    box(0.92, 0.11, 0.008, MODEL_COLOURS.bodyShade, 0, 0.275, 0.181),
    box(0.92, 0.11, 0.008, MODEL_COLOURS.bodyShade, 0, 0.275, -0.181),
    box(1.16, 0.035, 0.008, MODEL_COLOURS.bodyShade, 0, 0.255, 0.182),
    box(1.16, 0.035, 0.008, MODEL_COLOURS.bodyShade, 0, 0.255, -0.182),
    // Pare-brise incliné, lunette arrière, rétroviseurs.
    box(0.016, 0.26, 0.32, MODEL_COLOURS.glass, 0.668, 0.46, 0),
    box(0.016, 0.2, 0.28, MODEL_COLOURS.glass, -0.672, 0.42, 0),
    box(0.03, 0.03, 0.07, MODEL_COLOURS.chassis, 0.61, 0.51, 0.205),
    box(0.03, 0.03, 0.07, MODEL_COLOURS.chassis, 0.61, 0.51, -0.205),
    // Toit, feux et boucliers.
    beveledBox(1.02, 0.04, 0.32, MODEL_COLOURS.roof, { y: 0.665, radius: 0.014 }),
    beveledBox(0.2, 0.03, 0.18, MODEL_COLOURS.bodyShade, { x: -0.4, y: 0.692, radius: 0.012 }),
    beveledBox(0.16, 0.03, 0.16, MODEL_COLOURS.bodyShade, { x: 0.18, y: 0.692, radius: 0.012 }),
    box(0.04, 0.08, 0.35, MODEL_COLOURS.chassis, 0.685, 0.14, 0),
    box(0.04, 0.07, 0.33, MODEL_COLOURS.chassis, -0.685, 0.135, 0),
    box(0.016, 0.06, 0.07, MODEL_COLOURS.lamp, 0.7, 0.225, 0.11),
    box(0.016, 0.06, 0.07, MODEL_COLOURS.lamp, 0.7, 0.225, -0.11),
    box(0.016, 0.045, 0.055, MODEL_COLOURS.tailLight, -0.7, 0.22, 0.12),
    box(0.016, 0.045, 0.055, MODEL_COLOURS.tailLight, -0.7, 0.22, -0.12),
    // Châssis, trois essieux.
    box(1.18, 0.07, 0.29, MODEL_COLOURS.chassis, 0, 0.12, 0),
    wheel(0.088, 0.06, MODEL_COLOURS.wheel, 0.42, 0.088, 0.155),
    wheel(0.088, 0.06, MODEL_COLOURS.wheel, 0.42, 0.088, -0.155),
    wheel(0.088, 0.06, MODEL_COLOURS.wheel, -0.32, 0.088, 0.155),
    wheel(0.088, 0.06, MODEL_COLOURS.wheel, -0.32, 0.088, -0.155),
    wheel(0.088, 0.06, MODEL_COLOURS.wheel, -0.5, 0.088, 0.155),
    wheel(0.088, 0.06, MODEL_COLOURS.wheel, -0.5, 0.088, -0.155),
    hub(0.04, 0.008, MODEL_COLOURS.metal, 0.42, 0.088, 0.187),
    hub(0.04, 0.008, MODEL_COLOURS.metal, 0.42, 0.088, -0.187),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.32, 0.088, 0.187),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.32, 0.088, -0.187),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.5, 0.088, 0.187),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.5, 0.088, -0.187),
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// Camions : cabine commune, plateau ou citerne
// ---------------------------------------------------------------------------

function truckCabParts(centreX: number): THREE.BufferGeometry[] {
  const shape = new THREE.Shape();
  shape.moveTo(-0.21, 0.14);
  shape.lineTo(0.21, 0.14);
  shape.lineTo(0.21, 0.3);
  shape.quadraticCurveTo(0.21, 0.37, 0.16, 0.41);
  shape.lineTo(0.03, 0.55);
  shape.quadraticCurveTo(-0.01, 0.58, -0.08, 0.58);
  shape.lineTo(-0.21, 0.58);
  shape.closePath();

  return [
    extrudeShape(shape, 0.34, MODEL_COLOURS.body, { x: centreX }),
    // Pare-brise incliné et vitres latérales.
    box(0.016, 0.19, 0.3, MODEL_COLOURS.glass, centreX + 0.14, 0.475, 0, {
      rotateZ: 0.62,
    }),
    box(0.17, 0.14, 0.012, MODEL_COLOURS.glass, centreX + 0.01, 0.445, 0.172),
    box(0.17, 0.14, 0.012, MODEL_COLOURS.glass, centreX + 0.01, 0.445, -0.172),
    box(0.016, 0.16, 0.24, MODEL_COLOURS.glassLight, centreX - 0.215, 0.43, 0),
    // Portière, poignée et marchepied.
    box(0.012, 0.28, 0.008, MODEL_COLOURS.chassis, centreX - 0.1, 0.3, 0.174),
    box(0.012, 0.28, 0.008, MODEL_COLOURS.chassis, centreX - 0.1, 0.3, -0.174),
    box(0.05, 0.03, 0.05, MODEL_COLOURS.chassis, centreX + 0.19, 0.44, 0.2),
    box(0.05, 0.03, 0.05, MODEL_COLOURS.chassis, centreX + 0.19, 0.44, -0.2),
    box(0.12, 0.02, 0.12, MODEL_COLOURS.chassis, centreX - 0.12, 0.16, 0.13),
    // Toit, déflecteur, bouclier, calandre et phares.
    box(0.34, 0.03, 0.35, MODEL_COLOURS.roof, centreX + 0.01, 0.59, 0),
    beveledBox(0.2, 0.05, 0.32, MODEL_COLOURS.bodyShade, {
      x: centreX - 0.02,
      y: 0.615,
      radius: 0.012,
    }),
    box(0.04, 0.08, 0.34, MODEL_COLOURS.chassis, centreX + 0.22, 0.14, 0),
    box(0.012, 0.1, 0.24, MODEL_COLOURS.chassis, centreX + 0.225, 0.33, 0),
    box(0.016, 0.06, 0.07, MODEL_COLOURS.lamp, centreX + 0.23, 0.23, 0.1),
    box(0.016, 0.06, 0.07, MODEL_COLOURS.lamp, centreX + 0.23, 0.23, -0.1),
  ];
}

function buildTruckFlat(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    ...truckCabParts(0.41),
    // Châssis et plateau.
    box(1.14, 0.06, 0.28, MODEL_COLOURS.chassis, 0, 0.145, 0),
    box(0.68, 0.05, 0.36, MODEL_COLOURS.bodyShade, -0.28, 0.215, 0),
    // Ridelles : montants et lisses.
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, -0.58, 0.3, 0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, -0.38, 0.3, 0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, -0.18, 0.3, 0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, 0.02, 0.3, 0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, -0.58, 0.3, -0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, -0.38, 0.3, -0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, -0.18, 0.3, -0.18),
    box(0.03, 0.15, 0.022, MODEL_COLOURS.trim, 0.02, 0.3, -0.18),
    box(0.64, 0.025, 0.014, MODEL_COLOURS.trim, -0.28, 0.375, 0.18),
    box(0.64, 0.025, 0.014, MODEL_COLOURS.trim, -0.28, 0.375, -0.18),
    // Deux caisses arrimées.
    beveledBox(0.17, 0.13, 0.25, MODEL_COLOURS.wood, {
      x: -0.48,
      y: 0.305,
      radius: 0.01,
    }),
    beveledBox(0.15, 0.12, 0.24, MODEL_COLOURS.bodyShade, {
      x: -0.27,
      y: 0.3,
      radius: 0.01,
    }),
    box(0.005, 0.13, 0.25, MODEL_COLOURS.chassis, -0.48, 0.305, 0),
    box(0.005, 0.12, 0.24, MODEL_COLOURS.chassis, -0.27, 0.3, 0),
    // Échappement, réservoir et bavettes.
    cylinder(0.026, 0.026, 0.34, 8, MODEL_COLOURS.stack, { x: 0.2, y: 0.38, z: 0.13 }),
    cylinder(0.06, 0.06, 0.2, 8, MODEL_COLOURS.metal, {
      axis: 'x',
      x: 0.02,
      y: 0.175,
      z: -0.16,
    }),
    box(0.02, 0.12, 0.08, MODEL_COLOURS.chassis, -0.53, 0.1, 0.16),
    box(0.02, 0.12, 0.08, MODEL_COLOURS.chassis, -0.53, 0.1, -0.16),
    // Roues : un essieu avant, deux essieux arrière.
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, 0.45, 0.09, 0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, 0.45, 0.09, -0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.22, 0.09, 0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.22, 0.09, -0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.44, 0.09, 0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.44, 0.09, -0.15),
    hub(0.04, 0.008, MODEL_COLOURS.metal, 0.45, 0.09, 0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, 0.45, 0.09, -0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.22, 0.09, 0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.22, 0.09, -0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.44, 0.09, 0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.44, 0.09, -0.182),
  ];
  return parts;
}

function buildTruckTanker(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    ...truckCabParts(0.43),
    box(1.16, 0.06, 0.28, MODEL_COLOURS.chassis, 0, 0.145, 0),
    // Citerne et berceaux.
    cylinder(0.155, 0.155, 0.76, 14, MODEL_COLOURS.body, {
      axis: 'x',
      x: -0.21,
      y: 0.36,
    }),
    cylinder(0.16, 0.16, 0.035, 14, MODEL_COLOURS.chassis, {
      axis: 'x',
      x: 0.02,
      y: 0.36,
    }),
    cylinder(0.16, 0.16, 0.035, 14, MODEL_COLOURS.chassis, {
      axis: 'x',
      x: -0.42,
      y: 0.36,
    }),
    box(0.72, 0.03, 0.1, MODEL_COLOURS.metal, -0.21, 0.53, 0),
    cylinder(0.045, 0.045, 0.05, 8, MODEL_COLOURS.metal, { x: -0.2, y: 0.55, z: 0 }),
    cylinder(0.055, 0.055, 0.02, 8, MODEL_COLOURS.chassis, { x: -0.2, y: 0.577, z: 0 }),
    // Échelle arrière et garde-corps.
    box(0.016, 0.32, 0.016, MODEL_COLOURS.metal, -0.6, 0.37, 0.07),
    box(0.016, 0.32, 0.016, MODEL_COLOURS.metal, -0.6, 0.37, -0.07),
    box(0.016, 0.016, 0.16, MODEL_COLOURS.metal, -0.6, 0.25, 0),
    box(0.016, 0.016, 0.16, MODEL_COLOURS.metal, -0.6, 0.37, 0),
    box(0.016, 0.016, 0.16, MODEL_COLOURS.metal, -0.6, 0.49, 0),
    // Bavettes et feux arrière.
    box(0.02, 0.12, 0.08, MODEL_COLOURS.chassis, -0.53, 0.1, 0.16),
    box(0.02, 0.12, 0.08, MODEL_COLOURS.chassis, -0.53, 0.1, -0.16),
    box(0.014, 0.045, 0.055, MODEL_COLOURS.tailLight, -0.62, 0.23, 0.1),
    box(0.014, 0.045, 0.055, MODEL_COLOURS.tailLight, -0.62, 0.23, -0.1),
    // Roues.
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, 0.45, 0.09, 0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, 0.45, 0.09, -0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.22, 0.09, 0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.22, 0.09, -0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.44, 0.09, 0.15),
    wheel(0.09, 0.058, MODEL_COLOURS.wheel, -0.44, 0.09, -0.15),
    hub(0.04, 0.008, MODEL_COLOURS.metal, 0.45, 0.09, 0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, 0.45, 0.09, -0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.22, 0.09, 0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.22, 0.09, -0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.44, 0.09, 0.182),
    hub(0.04, 0.008, MODEL_COLOURS.metal, -0.44, 0.09, -0.182),
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// Locomotive vapeur, voiture voyageurs, wagon marchandises
// ---------------------------------------------------------------------------

function buildTrainSteam(): THREE.BufferGeometry[] {
  const cab = new THREE.Shape();
  cab.moveTo(-0.62, 0.2);
  cab.lineTo(-0.18, 0.2);
  cab.lineTo(-0.18, 0.48);
  cab.quadraticCurveTo(-0.18, 0.57, -0.27, 0.58);
  cab.lineTo(-0.55, 0.58);
  cab.quadraticCurveTo(-0.62, 0.57, -0.62, 0.48);
  cab.closePath();

  const cowcatcher = polygonShape([
    [0.6, 0.04],
    [0.72, 0.04],
    [0.72, 0.17],
    [0.6, 0.1],
  ]);

  const parts: THREE.BufferGeometry[] = [
    box(1.34, 0.07, 0.28, MODEL_COLOURS.chassis, -0.02, 0.17, 0),
    // Chaudière, boîte à fumée, cerclages.
    cylinder(0.14, 0.14, 0.66, 12, MODEL_COLOURS.body, {
      axis: 'x',
      x: 0.16,
      y: 0.4,
    }),
    cylinder(0.15, 0.15, 0.12, 12, MODEL_COLOURS.chassis, {
      axis: 'x',
      x: 0.55,
      y: 0.4,
    }),
    cylinder(0.148, 0.148, 0.03, 12, MODEL_COLOURS.trim, {
      axis: 'x',
      x: 0.48,
      y: 0.4,
    }),
    cylinder(0.148, 0.148, 0.028, 12, MODEL_COLOURS.trim, {
      axis: 'x',
      x: 0.02,
      y: 0.4,
    }),
    cylinder(0.148, 0.148, 0.025, 12, MODEL_COLOURS.bodyShade, {
      axis: 'x',
      x: -0.12,
      y: 0.4,
    }),
    // Dômes vapeur et sable.
    cylinder(0.052, 0.062, 0.075, 8, MODEL_COLOURS.body, { x: 0.2, y: 0.52, z: 0 }),
    cylinder(0.022, 0.022, 0.03, 8, MODEL_COLOURS.metal, { x: 0.2, y: 0.57, z: 0 }),
    cylinder(0.045, 0.05, 0.065, 8, MODEL_COLOURS.bodyShade, { x: 0.04, y: 0.515, z: 0 }),
    // Cheminée et échappement.
    cylinder(0.055, 0.07, 0.14, 8, MODEL_COLOURS.stack, { x: 0.48, y: 0.565, z: 0 }),
    cylinder(0.085, 0.062, 0.05, 8, MODEL_COLOURS.stack, { x: 0.48, y: 0.66, z: 0 }),
    // Cabine, toit et fenêtres.
    extrudeShape(cab, 0.34, MODEL_COLOURS.body),
    box(0.42, 0.035, 0.36, MODEL_COLOURS.roof, -0.4, 0.595, 0),
    box(0.15, 0.15, 0.012, MODEL_COLOURS.glass, -0.32, 0.44, 0.172),
    box(0.11, 0.15, 0.012, MODEL_COLOURS.glass, -0.5, 0.44, 0.172),
    box(0.15, 0.15, 0.012, MODEL_COLOURS.glass, -0.32, 0.44, -0.172),
    box(0.11, 0.15, 0.012, MODEL_COLOURS.glass, -0.5, 0.44, -0.172),
    box(0.012, 0.15, 0.24, MODEL_COLOURS.glass, -0.185, 0.44, 0),
    box(0.012, 0.27, 0.008, MODEL_COLOURS.chassis, -0.44, 0.31, 0.174),
    // Boucliers, attelage, lanterne et chasse-pierres.
    box(0.05, 0.1, 0.34, MODEL_COLOURS.chassis, 0.665, 0.19, 0),
    box(0.05, 0.1, 0.34, MODEL_COLOURS.chassis, -0.69, 0.19, 0),
    box(0.1, 0.05, 0.08, MODEL_COLOURS.metal, 0.73, 0.17, 0),
    box(0.1, 0.05, 0.08, MODEL_COLOURS.metal, -0.75, 0.17, 0),
    box(0.06, 0.06, 0.06, MODEL_COLOURS.lamp, 0.61, 0.575, 0),
    extrudeShape(cowcatcher, 0.3, MODEL_COLOURS.chassis),
    // Roues motrices, bogie avant, bielles et cylindres.
    wheel(0.115, 0.06, MODEL_COLOURS.wheel, -0.28, 0.115, 0.135),
    wheel(0.115, 0.06, MODEL_COLOURS.wheel, -0.28, 0.115, -0.135),
    wheel(0.115, 0.06, MODEL_COLOURS.wheel, -0.02, 0.115, 0.135),
    wheel(0.115, 0.06, MODEL_COLOURS.wheel, -0.02, 0.115, -0.135),
    wheel(0.115, 0.06, MODEL_COLOURS.wheel, 0.24, 0.115, 0.135),
    wheel(0.115, 0.06, MODEL_COLOURS.wheel, 0.24, 0.115, -0.135),
    wheel(0.07, 0.05, MODEL_COLOURS.wheel, 0.52, 0.07, 0.13),
    wheel(0.07, 0.05, MODEL_COLOURS.wheel, 0.52, 0.07, -0.13),
    hub(0.048, 0.008, MODEL_COLOURS.metal, -0.28, 0.115, 0.168),
    hub(0.048, 0.008, MODEL_COLOURS.metal, -0.28, 0.115, -0.168),
    hub(0.048, 0.008, MODEL_COLOURS.metal, -0.02, 0.115, 0.168),
    hub(0.048, 0.008, MODEL_COLOURS.metal, -0.02, 0.115, -0.168),
    hub(0.048, 0.008, MODEL_COLOURS.metal, 0.24, 0.115, 0.168),
    hub(0.048, 0.008, MODEL_COLOURS.metal, 0.24, 0.115, -0.168),
    box(0.56, 0.022, 0.018, MODEL_COLOURS.metal, -0.02, 0.115, 0.17),
    box(0.56, 0.022, 0.018, MODEL_COLOURS.metal, -0.02, 0.115, -0.17),
    box(0.2, 0.02, 0.02, MODEL_COLOURS.metal, 0.42, 0.115, 0.17),
    box(0.2, 0.02, 0.02, MODEL_COLOURS.metal, 0.42, 0.115, -0.17),
    cylinder(0.036, 0.036, 0.17, 8, MODEL_COLOURS.metal, {
      axis: 'x',
      x: 0.47,
      y: 0.16,
      z: 0.17,
    }),
    cylinder(0.036, 0.036, 0.17, 8, MODEL_COLOURS.metal, {
      axis: 'x',
      x: 0.47,
      y: 0.16,
      z: -0.17,
    }),
    box(0.1, 0.02, 0.1, MODEL_COLOURS.chassis, -0.6, 0.14, 0.1),
    box(0.1, 0.02, 0.1, MODEL_COLOURS.chassis, -0.6, 0.14, -0.1),
  ];
  return parts;
}

function buildTrainCoach(): THREE.BufferGeometry[] {
  const body = new THREE.Shape();
  body.moveTo(-0.62, 0.13);
  body.lineTo(0.62, 0.13);
  body.quadraticCurveTo(0.66, 0.13, 0.66, 0.2);
  body.lineTo(0.66, 0.45);
  body.quadraticCurveTo(0.66, 0.55, 0.58, 0.57);
  body.quadraticCurveTo(0, 0.61, -0.58, 0.57);
  body.quadraticCurveTo(-0.66, 0.55, -0.66, 0.45);
  body.lineTo(-0.66, 0.2);
  body.quadraticCurveTo(-0.66, 0.13, -0.62, 0.13);
  body.closePath();

  const parts: THREE.BufferGeometry[] = [
    box(1.16, 0.06, 0.28, MODEL_COLOURS.chassis, 0, 0.16, 0),
    extrudeShape(body, 0.33, MODEL_COLOURS.body),
    // Bande vitrée continue et montants.
    box(1.02, 0.17, 0.01, MODEL_COLOURS.glass, 0, 0.4, 0.167),
    box(1.02, 0.17, 0.01, MODEL_COLOURS.glass, 0, 0.4, -0.167),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, -0.48, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, -0.32, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, -0.16, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0.16, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0.32, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0.48, 0.4, 0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, -0.48, 0.4, -0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, -0.32, 0.4, -0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, -0.16, 0.4, -0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0, 0.4, -0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0.16, 0.4, -0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0.32, 0.4, -0.169),
    box(0.028, 0.18, 0.014, MODEL_COLOURS.trim, 0.48, 0.4, -0.169),
    // Portes et livrée.
    box(0.012, 0.32, 0.008, MODEL_COLOURS.chassis, -0.56, 0.33, 0.168),
    box(0.012, 0.32, 0.008, MODEL_COLOURS.chassis, 0.56, 0.33, 0.168),
    box(0.012, 0.32, 0.008, MODEL_COLOURS.chassis, -0.56, 0.33, -0.168),
    box(0.012, 0.32, 0.008, MODEL_COLOURS.chassis, 0.56, 0.33, -0.168),
    box(1.15, 0.03, 0.008, MODEL_COLOURS.bodyShade, 0, 0.27, 0.168),
    box(1.15, 0.03, 0.008, MODEL_COLOURS.bodyShade, 0, 0.27, -0.168),
    // Toit et aérateurs.
    beveledBox(1.1, 0.035, 0.3, MODEL_COLOURS.roof, { y: 0.615, radius: 0.012 }),
    beveledBox(0.14, 0.035, 0.14, MODEL_COLOURS.bodyShade, {
      x: -0.3,
      y: 0.645,
      radius: 0.01,
    }),
    beveledBox(0.14, 0.035, 0.14, MODEL_COLOURS.bodyShade, { x: 0.3, y: 0.645, radius: 0.01 }),
    // Attelages.
    box(0.08, 0.05, 0.08, MODEL_COLOURS.metal, 0.72, 0.17, 0),
    box(0.08, 0.05, 0.08, MODEL_COLOURS.metal, -0.72, 0.17, 0),
    // Bogies et roues.
    box(0.27, 0.08, 0.29, MODEL_COLOURS.chassis, 0.42, 0.12, 0),
    box(0.27, 0.08, 0.29, MODEL_COLOURS.chassis, -0.42, 0.12, 0),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, 0.32, 0.072, 0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, 0.32, 0.072, -0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, 0.52, 0.072, 0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, 0.52, 0.072, -0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, -0.32, 0.072, 0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, -0.32, 0.072, -0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, -0.52, 0.072, 0.125),
    wheel(0.072, 0.05, MODEL_COLOURS.wheel, -0.52, 0.072, -0.125),
  ];
  return parts;
}

function buildTrainFreight(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    box(1.1, 0.07, 0.3, MODEL_COLOURS.chassis, 0, 0.16, 0),
    box(0.92, 0.04, 0.34, MODEL_COLOURS.wood, 0, 0.205, 0),
    // Caisses latérales et ridaux.
    box(0.92, 0.3, 0.02, MODEL_COLOURS.body, 0, 0.36, 0.165),
    box(0.92, 0.3, 0.02, MODEL_COLOURS.body, 0, 0.36, -0.165),
    box(0.02, 0.3, 0.32, MODEL_COLOURS.body, 0.46, 0.36, 0),
    box(0.02, 0.3, 0.32, MODEL_COLOURS.body, -0.46, 0.36, 0),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, -0.34, 0.36, 0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, -0.11, 0.36, 0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, 0.11, 0.36, 0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, 0.34, 0.36, 0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, -0.34, 0.36, -0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, -0.11, 0.36, -0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, 0.11, 0.36, -0.168),
    box(0.024, 0.32, 0.026, MODEL_COLOURS.bodyShade, 0.34, 0.36, -0.168),
    box(0.94, 0.025, 0.028, MODEL_COLOURS.trim, 0, 0.5225, 0.168),
    box(0.94, 0.025, 0.028, MODEL_COLOURS.trim, 0, 0.5225, -0.168),
    // Chargement de charbon : trois tas déterministes.
    box(0.2, 0.18, 0.26, MODEL_COLOURS.cargo, -0.2, 0.43, 0),
    box(0.18, 0.16, 0.25, MODEL_COLOURS.cargo, 0.02, 0.42, 0, { rotateY: 0.08 }),
    box(0.16, 0.14, 0.24, MODEL_COLOURS.cargo, 0.21, 0.41, 0, { rotateY: -0.07 }),
    // Essieux, boîtes d'essieu et attelages.
    box(0.1, 0.08, 0.3, MODEL_COLOURS.chassis, 0.38, 0.11, 0),
    box(0.1, 0.08, 0.3, MODEL_COLOURS.chassis, -0.38, 0.11, 0),
    wheel(0.075, 0.05, MODEL_COLOURS.wheel, 0.38, 0.075, 0.13),
    wheel(0.075, 0.05, MODEL_COLOURS.wheel, 0.38, 0.075, -0.13),
    wheel(0.075, 0.05, MODEL_COLOURS.wheel, -0.38, 0.075, 0.13),
    wheel(0.075, 0.05, MODEL_COLOURS.wheel, -0.38, 0.075, -0.13),
    hub(0.038, 0.008, MODEL_COLOURS.metal, 0.38, 0.075, 0.158),
    hub(0.038, 0.008, MODEL_COLOURS.metal, 0.38, 0.075, -0.158),
    hub(0.038, 0.008, MODEL_COLOURS.metal, -0.38, 0.075, 0.158),
    hub(0.038, 0.008, MODEL_COLOURS.metal, -0.38, 0.075, -0.158),
    box(0.08, 0.05, 0.08, MODEL_COLOURS.metal, 0.59, 0.17, 0),
    box(0.08, 0.05, 0.08, MODEL_COLOURS.metal, -0.59, 0.17, 0),
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// Bateau
// ---------------------------------------------------------------------------

function shipPlan(scale = 1): THREE.Shape {
  const s = scale;
  const shape = new THREE.Shape();
  shape.moveTo(-0.72 * s, 0);
  shape.quadraticCurveTo(-0.72 * s, 0.18 * s, -0.54 * s, 0.21 * s);
  shape.lineTo(0.36 * s, 0.23 * s);
  shape.quadraticCurveTo(0.66 * s, 0.22 * s, 0.84 * s, 0);
  shape.quadraticCurveTo(0.66 * s, -0.22 * s, 0.36 * s, -0.23 * s);
  shape.lineTo(-0.54 * s, -0.21 * s);
  shape.quadraticCurveTo(-0.72 * s, -0.18 * s, -0.72 * s, 0);
  shape.closePath();
  return shape;
}

function buildShip(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    // Œuvre vive sombre, franc-bord teinté, pont.
    extrudePlan(shipPlan(0.95), 0.1, MODEL_COLOURS.chassis, { y: 0 }),
    extrudePlan(shipPlan(1), 0.16, MODEL_COLOURS.body, { y: 0.1 }),
    extrudePlan(shipPlan(0.9), 0.03, MODEL_COLOURS.wood, { y: 0.26 }),
    // Château et passerelle.
    beveledBox(0.36, 0.24, 0.34, MODEL_COLOURS.body, {
      x: -0.2,
      y: 0.39,
      radius: 0.02,
    }),
    box(0.31, 0.07, 0.35, MODEL_COLOURS.glass, -0.2, 0.45, 0),
    beveledBox(0.24, 0.06, 0.28, MODEL_COLOURS.roof, {
      x: -0.2,
      y: 0.54,
      radius: 0.012,
    }),
    // Cheminée et cerclage.
    cylinder(0.055, 0.06, 0.2, 10, MODEL_COLOURS.body, { x: -0.05, y: 0.58, z: 0 }),
    cylinder(0.062, 0.062, 0.045, 10, MODEL_COLOURS.chassis, { x: -0.05, y: 0.65, z: 0 }),
    // Mât, vergue et haubans.
    cylinder(0.008, 0.01, 0.3, 6, MODEL_COLOURS.metal, { x: 0.34, y: 0.42, z: 0 }),
    box(0.02, 0.01, 0.34, MODEL_COLOURS.metal, 0.34, 0.52, 0),
    box(0.008, 0.24, 0.008, MODEL_COLOURS.metal, 0.34, 0.4, 0.14),
    box(0.008, 0.24, 0.008, MODEL_COLOURS.metal, 0.34, 0.4, -0.14),
    // Conteneurs sur le pont avant.
    beveledBox(0.22, 0.14, 0.26, MODEL_COLOURS.bodyShade, {
      x: 0.14,
      y: 0.35,
      radius: 0.01,
    }),
    beveledBox(0.2, 0.13, 0.24, MODEL_COLOURS.cargo, { x: 0.39, y: 0.345, radius: 0.01 }),
    box(0.005, 0.14, 0.26, MODEL_COLOURS.chassis, 0.14, 0.35, 0),
    box(0.005, 0.13, 0.24, MODEL_COLOURS.chassis, 0.39, 0.345, 0),
    // Rambardes.
    box(0.8, 0.008, 0.008, MODEL_COLOURS.metal, -0.02, 0.34, 0.205),
    box(0.8, 0.008, 0.008, MODEL_COLOURS.metal, -0.02, 0.34, -0.205),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, -0.5, 0.32, 0.2),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, -0.2, 0.32, 0.205),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, 0.1, 0.32, 0.205),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, 0.4, 0.32, 0.185),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, -0.5, 0.32, -0.2),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, -0.2, 0.32, -0.205),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, 0.1, 0.32, -0.205),
    box(0.012, 0.06, 0.012, MODEL_COLOURS.metal, 0.4, 0.32, -0.185),
    // Canot de sauvetage.
    beveledBox(0.15, 0.05, 0.07, MODEL_COLOURS.bodyShade, {
      x: -0.48,
      y: 0.37,
      z: 0.18,
      radius: 0.02,
    }),
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// Avion
// ---------------------------------------------------------------------------

function wingPlan(): THREE.Shape {
  return polygonShape([
    [0.18, 0],
    [0.02, 0.82],
    [-0.16, 0.82],
    [-0.16, 0],
    [-0.16, -0.82],
    [0.02, -0.82],
  ]);
}

function tailPlanePlan(): THREE.Shape {
  return polygonShape([
    [-0.66, 0],
    [-0.78, 0.3],
    [-0.92, 0.3],
    [-0.86, 0],
    [-0.92, -0.3],
    [-0.78, -0.3],
  ]);
}

function buildPlane(): THREE.BufferGeometry[] {
  const fin = polygonShape([
    [-0.58, 0.28],
    [-0.78, 0.52],
    [-0.88, 0.52],
    [-0.94, 0.28],
  ]);

  const parts: THREE.BufferGeometry[] = [
    // Fuselage, nez et cône de queue.
    cylinder(0.105, 0.105, 0.95, 12, MODEL_COLOURS.body, {
      axis: 'x',
      x: 0.02,
      y: 0.26,
    }),
    cylinder(0.004, 0.105, 0.24, 12, MODEL_COLOURS.body, {
      axis: 'x',
      x: 0.615,
      y: 0.26,
    }),
    cylinder(0.105, 0.018, 0.34, 12, MODEL_COLOURS.body, {
      axis: 'x',
      x: -0.62,
      y: 0.26,
    }),
    // Ailes et saumons.
    extrudePlan(wingPlan(), 0.035, MODEL_COLOURS.body, { y: 0.245, curveSegments: 1 }),
    box(0.22, 0.012, 0.012, MODEL_COLOURS.bodyShade, 0.02, 0.284, 0.6),
    box(0.22, 0.012, 0.012, MODEL_COLOURS.bodyShade, 0.02, 0.284, -0.6),
    // Dérive et stabilisateur horizontal.
    extrudeShape(fin, 0.035, MODEL_COLOURS.body, { curveSegments: 1 }),
    extrudePlan(tailPlanePlan(), 0.025, MODEL_COLOURS.body, { y: 0.3, curveSegments: 1 }),
    // Réacteurs sous les ailes.
    cylinder(0.05, 0.05, 0.26, 8, MODEL_COLOURS.bodyShade, {
      axis: 'x',
      x: 0.05,
      y: 0.235,
      z: 0.36,
    }),
    cylinder(0.05, 0.05, 0.26, 8, MODEL_COLOURS.bodyShade, {
      axis: 'x',
      x: 0.05,
      y: 0.235,
      z: -0.36,
    }),
    cylinder(0.046, 0.046, 0.02, 8, MODEL_COLOURS.chassis, {
      axis: 'x',
      x: 0.185,
      y: 0.235,
      z: 0.36,
    }),
    cylinder(0.046, 0.046, 0.02, 8, MODEL_COLOURS.chassis, {
      axis: 'x',
      x: 0.185,
      y: 0.235,
      z: -0.36,
    }),
    box(0.16, 0.025, 0.05, MODEL_COLOURS.bodyShade, 0.02, 0.225, 0.36),
    box(0.16, 0.025, 0.05, MODEL_COLOURS.bodyShade, 0.02, 0.225, -0.36),
    // Poste de pilotage et hublots.
    box(0.02, 0.07, 0.13, MODEL_COLOURS.glass, 0.5, 0.33, 0),
    box(0.13, 0.065, 0.012, MODEL_COLOURS.glass, 0.43, 0.33, 0.085),
    box(0.13, 0.065, 0.012, MODEL_COLOURS.glass, 0.43, 0.33, -0.085),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, -0.2, 0.31, 0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, -0.08, 0.31, 0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, 0.04, 0.31, 0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, 0.16, 0.31, 0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, 0.28, 0.31, 0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, -0.2, 0.31, -0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, -0.08, 0.31, -0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, 0.04, 0.31, -0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, 0.16, 0.31, -0.105),
    box(0.035, 0.03, 0.008, MODEL_COLOURS.glassLight, 0.28, 0.31, -0.105),
    // Livrée et immatriculation.
    box(0.9, 0.03, 0.008, MODEL_COLOURS.bodyShade, 0, 0.225, 0.106),
    box(0.9, 0.03, 0.008, MODEL_COLOURS.bodyShade, 0, 0.225, -0.106),
    box(0.012, 0.03, 0.06, MODEL_COLOURS.chassis, -0.35, 0.34, 0.095),
    // Train d'atterrissage.
    box(0.02, 0.14, 0.02, MODEL_COLOURS.chassis, 0.38, 0.13, 0),
    wheel(0.035, 0.03, MODEL_COLOURS.wheel, 0.38, 0.035, 0),
    box(0.02, 0.15, 0.02, MODEL_COLOURS.chassis, 0.04, 0.14, 0.11),
    box(0.02, 0.15, 0.02, MODEL_COLOURS.chassis, 0.04, 0.14, -0.11),
    wheel(0.045, 0.035, MODEL_COLOURS.wheel, 0.04, 0.045, 0.11),
    wheel(0.045, 0.035, MODEL_COLOURS.wheel, 0.04, 0.045, -0.11),
    box(0.12, 0.02, 0.28, MODEL_COLOURS.chassis, 0.04, 0.19, 0),
    // Feux de navigation.
    box(0.02, 0.025, 0.025, MODEL_COLOURS.lamp, 0.02, 0.284, 0.79),
    box(0.02, 0.025, 0.025, MODEL_COLOURS.lamp, 0.02, 0.284, -0.79),
    box(0.015, 0.02, 0.02, MODEL_COLOURS.tailLight, -0.9, 0.34, 0),
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

const BUILDERS: Record<VehicleVariant, () => THREE.BufferGeometry[]> = {
  'bus-city': buildBusCity,
  'bus-coach': buildBusCoach,
  'truck-flat': buildTruckFlat,
  'truck-tanker': buildTruckTanker,
  'train-steam': buildTrainSteam,
  'train-coach': buildTrainCoach,
  'train-freight': buildTrainFreight,
  ship: buildShip,
  plane: buildPlane,
};

const HALO_RADIUS: Record<VehicleVariant, number> = {
  'bus-city': 0.72,
  'bus-coach': 0.84,
  'truck-flat': 0.8,
  'truck-tanker': 0.82,
  'train-steam': 1.05,
  'train-coach': 0.91,
  'train-freight': 0.87,
  ship: 1.15,
  plane: 1.05,
};

/** Construit un archétype à la demande (déterministe, sans cache). */
export function buildVehicleModel(variant: VehicleVariant): VehicleModelDefinition {
  const builder = BUILDERS[variant];
  return finalize(variant, builder(), HALO_RADIUS[variant]);
}

/**
 * Choix visuel déterministe à partir de la famille du contrat et de l'id.
 *
 * Les ids d'un convoi mock sont séquentiels : `id % 5` fait apparaître une
 * locomotive toutes les cinq unités, puis des voitures puis un wagon. Le choix
 * ne dépend ni du temps ni de l'ordre des snapshots, donc il est stable en
 * réseau et entre deux frames.
 */
export function vehicleVariantFor(kind: VehicleModelKind, id: number): VehicleVariant {
  const key = Math.abs(Math.floor(Number.isFinite(id) ? id : 0));
  switch (kind) {
    case 'train': {
      const slot = key % 5;
      if (slot === 0) return 'train-steam';
      return slot === 4 ? 'train-freight' : 'train-coach';
    }
    case 'truck':
      return key % 2 === 0 ? 'truck-flat' : 'truck-tanker';
    case 'bus':
      return key % 3 === 0 ? 'bus-coach' : 'bus-city';
    case 'ship':
      return 'ship';
    case 'plane':
      return 'plane';
  }
}

/** Construit toute la bibliothèque (utile pour les tests de budget). */
export function buildVehicleModels(): Record<VehicleVariant, VehicleModelDefinition> {
  const models = {} as Record<VehicleVariant, VehicleModelDefinition>;
  for (const variant of VEHICLE_VARIANTS) models[variant] = buildVehicleModel(variant);
  return models;
}

/** Libère toutes les géométries d'une bibliothèque de véhicules. */
export function disposeVehicleModels(models: Record<VehicleVariant, VehicleModelDefinition>): void {
  disposeGeometries(Object.values(models).map((model) => model.geometry));
}
