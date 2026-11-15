/**
 * Rendu des dépôts route et rail.
 *
 * La source est `WorldSnapshot.depots` (#90) : chaque entrée porte un id de
 * pool stable, sa tuile, son entreprise, son type et sa direction. Chaque
 * dépôt reçoit un petit bâtiment (corps + ouverture) et une livrée colorée
 * (toit, auvent, enseigne) posés par deux `InstancedMesh` : deux draw calls
 * pour toute la carte, quelle que soit la quantité de dépôts.
 *
 * L'empreinte du modèle reste sous 0,9 tuile : aucun dépassement sur les
 * routes, rails ou bâtiments voisins. La tuile route/rail reste dessinée par
 * `TerrainLayer` (les ids dupliqués sont ignorés pour éviter un doublon).
 */

import * as THREE from 'three';
import type { DepotSnapshot, MapSnapshot } from '../engine/protocol';
import { COMPANY_NONE } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { companyColour, hexToRgb } from './tileVisuals';
import { createModelMaterial } from './models/materials';
import {
  createDepotBodyGeometry,
  createDepotLiveryGeometry,
  type DepotKind,
} from './models/buildings';

const MAX_DEPOTS = 512;
const UP = new THREE.Vector3(0, 1, 0);

interface DepotPlacement {
  id: number;
  x: number;
  z: number;
  ground: number;
  owner: number;
  kind: DepotKind;
  /** Rotation de l'auvent : 0..3 × 90°. */
  rotation: number;
}

export class DepotLayer {
  readonly group = new THREE.Group();

  private roadBodies: THREE.InstancedMesh;
  private roadLiveries: THREE.InstancedMesh;
  private railBodies: THREE.InstancedMesh;
  private railLiveries: THREE.InstancedMesh;
  private bodyMaterial: THREE.MeshStandardMaterial;
  private liveryMaterial: THREE.MeshStandardMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private geometries: THREE.BufferGeometry[] = [];
  private placements: DepotPlacement[] = [];
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private colour = new THREE.Color();
  private rgb = { r: 0, g: 0, b: 0 };

  constructor() {
    this.group.name = 'depots';
    this.bodyMaterial = createModelMaterial({
      night: this.nightUniform,
      glowStrength: 1.0,
      nightAmbient: 0.02,
      roughness: 0.76,
      metalness: 0.04,
      name: 'depot-bodies-surface',
    });
    this.liveryMaterial = createModelMaterial({
      night: this.nightUniform,
      glowStrength: 1.0,
      roughness: 0.55,
      metalness: 0.08,
      name: 'depot-liveries-surface',
    });
    const roadBody = createDepotBodyGeometry('road', 1);
    const roadLivery = createDepotLiveryGeometry('road');
    const railBody = createDepotBodyGeometry('rail', 1);
    const railLivery = createDepotLiveryGeometry('rail');
    this.geometries.push(roadBody, roadLivery, railBody, railLivery);
    this.roadBodies = this.createMesh(roadBody, this.bodyMaterial, 'depot-road-bodies');
    this.roadLiveries = this.createMesh(roadLivery, this.liveryMaterial, 'depot-road-liveries');
    this.railBodies = this.createMesh(railBody, this.bodyMaterial, 'depot-rail-bodies');
    this.railLiveries = this.createMesh(railLivery, this.liveryMaterial, 'depot-rail-liveries');
    for (const mesh of [this.roadBodies, this.roadLiveries, this.railBodies, this.railLiveries]) {
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  private createMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_DEPOTS);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 6;
    return mesh;
  }

  /** Reconstruit les bâtiments à partir de `snapshot.depots`. */
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
        kind: depot.kind,
        rotation: (((depot.direction % 4) + 4) % 4) * (Math.PI / 2),
      });
    }

    let roadIndex = 0;
    let railIndex = 0;
    for (const placement of this.placements) {
      const rail = placement.kind === 'rail';
      const bodies = rail ? this.railBodies : this.roadBodies;
      const liveries = rail ? this.railLiveries : this.roadLiveries;
      const index = rail ? railIndex : roadIndex;
      if (rail) railIndex += 1;
      else roadIndex += 1;
      this.position.set(placement.x, placement.ground, placement.z);
      this.quaternion.setFromAxisAngle(UP, placement.rotation);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      bodies.setMatrixAt(index, this.matrix);
      liveries.setMatrixAt(index, this.matrix);
      const base = placement.owner === COMPANY_NONE ? 0x8a7a62 : companyColour(placement.owner);
      const rgb = hexToRgb(base, this.rgb);
      // Livrée légèrement assombrie pour ne pas brûler au soleil.
      this.colour.setRGB(rgb.r, rgb.g, rgb.b).multiplyScalar(0.92);
      liveries.setColorAt(index, this.colour);
    }
    this.roadBodies.count = roadIndex;
    this.roadLiveries.count = roadIndex;
    this.railBodies.count = railIndex;
    this.railLiveries.count = railIndex;
    for (const mesh of [this.roadBodies, this.roadLiveries, this.railBodies, this.railLiveries]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.group.visible = this.placements.length > 0;
  }

  get count(): number {
    return this.placements.length;
  }

  /** Matériau de surface du corps des dépôts (diagnostic et tests). */
  get surfaceMaterial(): THREE.MeshStandardMaterial {
    return this.bodyMaterial;
  }

  /** 0 = jour, 1 = nuit profonde : allume les petits vitrages des dépôts. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightAmount;
  }

  get night(): number {
    return this.nightAmount;
  }

  /** Ids rendus, dans l'ordre du snapshot (diagnostic et tests). */
  get ids(): number[] {
    return this.placements.map((placement) => placement.id);
  }

  /** Rotations appliquées (radians), pour vérifier l'orientation. */
  get rotations(): number[] {
    return this.placements.map((placement) => placement.rotation);
  }

  /** Types rendus, pour distinguer dépôt route et rail. */
  get kinds(): DepotKind[] {
    return this.placements.map((placement) => placement.kind);
  }

  get drawCallCount(): number {
    let count = 0;
    for (const child of this.group.children) {
      const mesh = child as THREE.InstancedMesh;
      if (mesh.isInstancedMesh && mesh.count > 0) count += 1;
    }
    return count;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries = [];
    this.bodyMaterial.dispose();
    this.liveryMaterial.dispose();
    for (const child of this.group.children) {
      const mesh = child as THREE.InstancedMesh;
      if (mesh.isInstancedMesh) mesh.dispose();
    }
    this.group.clear();
    this.placements = [];
  }
}
