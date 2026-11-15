/**
 * Rendu des dépôts route/rail.
 *
 * Le protocole v1 n'a pas de liste de dépôts : le mock marque la tuile avec
 * `DEPOT_TRACK_BIT` (bit privé) dans `trackBits`. Cette couche pose un petit
 * auvent instancié pour rendre le dépôt visible et cliquable, sans modifier
 * le terrain ni ajouter de draw call par dépôt.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { COMPANY_NONE } from '../engine/protocol';
import { sampleHeightWorld, tileIndex } from '../game/mapGrid';
import { DEPOT_TRACK_BIT } from '../game/vehicleRules';
import { companyColour, hexToRgb } from './tileVisuals';

const MAX_DEPOTS = 512;
const ROOF_HEIGHT = 0.3;

interface DepotPlacement {
  x: number;
  z: number;
  ground: number;
  owner: number;
}

export class DepotLayer {
  readonly group = new THREE.Group();

  private roofs: THREE.InstancedMesh;
  private material: THREE.MeshLambertMaterial;
  private placements: DepotPlacement[] = [];
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private colour = new THREE.Color();
  private rgb = { r: 0, g: 0, b: 0 };

  constructor() {
    this.group.name = 'depots';
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const geometry = new THREE.BoxGeometry(0.72, ROOF_HEIGHT, 0.72);
    this.roofs = new THREE.InstancedMesh(geometry, this.material, MAX_DEPOTS);
    this.roofs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.roofs.count = 0;
    this.roofs.frustumCulled = false;
    this.roofs.castShadow = false;
    this.roofs.receiveShadow = false;
    this.roofs.renderOrder = 6;
    this.group.add(this.roofs);
    this.group.visible = false;
  }

  /** Reconstruit les auvents à partir des drapeaux de la carte. */
  setMap(map: MapSnapshot): void {
    this.placements = [];
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (this.placements.length >= MAX_DEPOTS) break;
        const index = tileIndex(x, y, map.width);
        if (((map.trackBits[index] ?? 0) & DEPOT_TRACK_BIT) === 0) continue;
        this.placements.push({
          x: x + 0.5,
          z: y + 0.5,
          ground: sampleHeightWorld(map, x + 0.5, y + 0.5),
          owner: map.owner[index] ?? COMPANY_NONE,
        });
      }
    }

    for (let i = 0; i < this.placements.length; i += 1) {
      const placement = this.placements[i];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground + ROOF_HEIGHT / 2 + 0.02, placement.z);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale);
      this.roofs.setMatrixAt(i, this.matrix);
      const base = placement.owner === COMPANY_NONE ? 0x8a7a62 : companyColour(placement.owner);
      const rgb = hexToRgb(base, this.rgb);
      this.colour.setRGB(rgb.r, rgb.g, rgb.b).multiplyScalar(0.85);
      this.roofs.setColorAt(i, this.colour);
    }
    this.roofs.count = this.placements.length;
    this.roofs.instanceMatrix.needsUpdate = true;
    if (this.roofs.instanceColor) this.roofs.instanceColor.needsUpdate = true;
    this.roofs.computeBoundingSphere();
    this.group.visible = this.placements.length > 0;
  }

  get count(): number {
    return this.placements.length;
  }

  dispose(): void {
    this.roofs.geometry.dispose();
    this.material.dispose();
    this.group.clear();
    this.placements = [];
  }
}
