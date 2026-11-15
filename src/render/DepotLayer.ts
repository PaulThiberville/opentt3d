/**
 * Rendu des dépôts route/rail.
 *
 * La source est `WorldSnapshot.depots` (#90) : chaque entrée porte un id de
 * pool stable, sa tuile, son entreprise, son type et sa direction. La couche
 * pose un petit auvent instancié par dépôt, orienté selon l'entrée, sans
 * modifier le terrain ni ajouter de draw call par dépôt. La tuile route/rail
 * reste dessinée par `TerrainLayer` : aucun doublon n'est créé ici (les ids
 * dupliqués sont ignorés).
 */

import * as THREE from 'three';
import type { DepotSnapshot, MapSnapshot } from '../engine/protocol';
import { COMPANY_NONE } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { companyColour, hexToRgb } from './tileVisuals';

const MAX_DEPOTS = 512;
const ROOF_HEIGHT = 0.3;
const UP = new THREE.Vector3(0, 1, 0);

interface DepotPlacement {
  id: number;
  x: number;
  z: number;
  ground: number;
  owner: number;
  /** Rotation cosmétique de l'auvent : 0..3 × 90°. */
  rotation: number;
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

  /** Reconstruit les auvents à partir de `snapshot.depots`. */
  setDepots(depots: readonly DepotSnapshot[], map: MapSnapshot | null): void {
    this.placements = [];
    const seen = new Set<number>();
    for (const depot of depots) {
      if (this.placements.length >= MAX_DEPOTS) break;
      if (seen.has(depot.id)) continue;
      seen.add(depot.id);
      const x = depot.x + depot.width / 2;
      const z = depot.y + depot.height / 2;
      this.placements.push({
        id: depot.id,
        x,
        z,
        ground: map ? sampleHeightWorld(map, x, z) : 0,
        owner: depot.company,
        rotation: (((depot.direction % 4) + 4) % 4) * (Math.PI / 2),
      });
    }

    for (let i = 0; i < this.placements.length; i += 1) {
      const placement = this.placements[i];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground + ROOF_HEIGHT / 2 + 0.02, placement.z);
      this.quaternion.setFromAxisAngle(UP, placement.rotation);
      this.matrix.compose(this.position, this.quaternion, this.scale);
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

  /** Ids rendus, dans l'ordre du snapshot (diagnostic et tests). */
  get ids(): number[] {
    return this.placements.map((placement) => placement.id);
  }

  /** Rotations appliquées (radians), pour vérifier l'orientation. */
  get rotations(): number[] {
    return this.placements.map((placement) => placement.rotation);
  }

  dispose(): void {
    this.roofs.geometry.dispose();
    this.material.dispose();
    this.group.clear();
    this.placements = [];
  }
}
