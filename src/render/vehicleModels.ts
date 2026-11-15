/**
 * Modèles procéduraux low-poly des véhicules.
 *
 * Chaque modèle est un `BufferGeometry` fusionné, orienté +X (avant), avec des
 * couleurs de sommets : la couleur d'entreprise est appliquée via
 * `InstancedMesh.setColorAt()` et multiplie les couleurs de sommets. Les parties
 * sombres (fenêtres, châssis) restent donc lisibles dans toutes les livrées.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleModelKind } from '../game/vehicleInterpolation';
import { hexToRgb } from './tileVisuals';

const BODY = 0xffffff;
const CABIN = 0xf2f4f5;
const WINDOW = 0x24313d;
const CHASSIS = 0x2a2c31;
const ROOF = 0xdfe3e6;

function paint(geometry: THREE.BufferGeometry, colour: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  geometry.translate(x, y, z);
  const count = geometry.attributes.position?.count ?? 0;
  const colours = new Float32Array(count * 3);
  const rgb = hexToRgb(colour);
  for (let i = 0; i < count; i += 1) {
    colours[i * 3] = rgb.r;
    colours[i * 3 + 1] = rgb.g;
    colours[i * 3 + 2] = rgb.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

function box(width: number, height: number, depth: number, colour: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(width, height, depth), colour, x, y, z);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('Fusion de géométrie de véhicule impossible');
  merged.computeBoundingSphere();
  return merged;
}

/** Locomotive + deux wagons, dans un seul maillage. */
function buildTrain(): THREE.BufferGeometry {
  return merge([
    box(2.05, 0.07, 0.3, CHASSIS, -0.1, 0.1, 0),
    box(0.6, 0.38, 0.32, BODY, 0.62, 0.33, 0),
    box(0.62, 0.07, 0.34, ROOF, 0.62, 0.55, 0),
    box(0.5, 0.1, 0.33, WINDOW, 0.68, 0.42, 0),
    box(0.46, 0.34, 0.3, BODY, -0.12, 0.3, 0),
    box(0.46, 0.34, 0.3, BODY, -0.72, 0.3, 0),
    box(0.48, 0.05, 0.32, ROOF, -0.12, 0.49, 0),
    box(0.48, 0.05, 0.32, ROOF, -0.72, 0.49, 0),
    box(0.1, 0.06, 0.2, CHASSIS, 0.28, 0.1, 0),
    box(0.1, 0.06, 0.2, CHASSIS, -0.42, 0.1, 0),
  ]);
}

function buildTruck(): THREE.BufferGeometry {
  return merge([
    box(0.62, 0.07, 0.26, CHASSIS, 0, 0.09, 0),
    box(0.28, 0.26, 0.26, BODY, 0.19, 0.24, 0),
    box(0.24, 0.1, 0.27, WINDOW, 0.2, 0.3, 0),
    box(0.34, 0.3, 0.28, CABIN, -0.18, 0.26, 0),
    box(0.34, 0.04, 0.29, ROOF, -0.18, 0.42, 0),
  ]);
}

function buildBus(): THREE.BufferGeometry {
  return merge([
    box(0.66, 0.06, 0.26, CHASSIS, 0, 0.08, 0),
    box(0.66, 0.3, 0.28, BODY, 0, 0.27, 0),
    box(0.6, 0.12, 0.29, WINDOW, 0, 0.32, 0),
    box(0.66, 0.05, 0.3, ROOF, 0, 0.44, 0),
  ]);
}

function buildShip(): THREE.BufferGeometry {
  return merge([
    box(1.05, 0.16, 0.34, CHASSIS, 0, 0.1, 0),
    box(0.85, 0.06, 0.3, BODY, 0, 0.2, 0),
    box(0.34, 0.24, 0.24, CABIN, 0.16, 0.32, 0),
    box(0.1, 0.12, 0.1, WINDOW, 0.16, 0.38, 0),
    box(0.18, 0.16, 0.16, CHASSIS, -0.26, 0.3, 0),
  ]);
}

function buildPlane(): THREE.BufferGeometry {
  return merge([
    box(0.98, 0.14, 0.14, CABIN, 0, 0.12, 0),
    box(0.2, 0.05, 0.86, CABIN, 0.1, 0.13, 0),
    box(0.14, 0.05, 0.34, CABIN, -0.4, 0.16, 0),
    box(0.16, 0.1, 0.12, WINDOW, 0.38, 0.2, 0),
    box(0.1, 0.14, 0.06, CHASSIS, -0.44, 0.26, 0),
  ]);
}

export function buildVehicleGeometries(): Record<VehicleModelKind, THREE.BufferGeometry> {
  return {
    train: buildTrain(),
    truck: buildTruck(),
    bus: buildBus(),
    ship: buildShip(),
    plane: buildPlane(),
  };
}

export function disposeVehicleGeometries(geometries: Record<VehicleModelKind, THREE.BufferGeometry>): void {
  for (const geometry of Object.values(geometries)) geometry.dispose();
}
