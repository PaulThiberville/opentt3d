/**
 * Rendu simple des désastres actifs (#172).
 *
 * Un seul `InstancedMesh` de balises colorées : une couleur par type
 * (incendie, accident, déraillement, crash) et une taille liée à la gravité.
 * La couche reste invisible quand aucun désastre n'est actif, donc elle ne
 * coûte aucun draw call dans une partie normale (option désactivée).
 */

import * as THREE from 'three';
import type { DisasterSnapshot, MapSnapshot } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';

const MAX_MARKERS = 64;
const UP = new THREE.Vector3(0, 1, 0);

const DISASTER_COLOURS: Record<DisasterSnapshot['kind'], number> = {
  fire: 0xff7a2f,
  road_accident: 0xffc94d,
  train_crash: 0xff4d4d,
  aircraft_crash: 0xd18cff,
};

export class DisasterLayer {
  readonly group = new THREE.Group();

  private mesh: THREE.InstancedMesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshBasicMaterial;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private rotation = 0;
  private placements: { x: number; z: number; ground: number; severity: number }[] = [];

  constructor() {
    this.group.name = 'disasters';
    this.geometry = new THREE.ConeGeometry(0.55, 1.5, 6);
    this.geometry.translate(0, 0.75, 0);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_MARKERS);
    this.mesh.name = 'disaster-markers';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  /** Remplace les balises actives à partir du snapshot. */
  setDisasters(disasters: readonly DisasterSnapshot[] | undefined, map: MapSnapshot | null): void {
    const list = (disasters ?? []).slice(0, MAX_MARKERS);
    this.placements = [];
    if (list.length === 0) {
      this.mesh.count = 0;
      this.group.visible = false;
      return;
    }
    for (let index = 0; index < list.length; index += 1) {
      const disaster = list[index];
      if (!disaster) continue;
      const ground = map ? sampleHeightWorld(map, disaster.x, disaster.y) : 0;
      this.placements.push({
        x: disaster.x,
        z: disaster.y,
        ground,
        severity: Math.max(1, Math.min(3, disaster.severity)),
      });
      this.mesh.setColorAt(index, new THREE.Color(DISASTER_COLOURS[disaster.kind]));
    }
    this.mesh.count = this.placements.length;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.group.visible = this.placements.length > 0;
    this.applyMatrices();
  }

  /** Animation discrète : les balises tournent doucement. */
  update(deltaSeconds: number): void {
    if (!this.group.visible) return;
    this.rotation = (this.rotation + deltaSeconds * 0.9) % (Math.PI * 2);
    this.applyMatrices();
  }

  private applyMatrices(): void {
    for (let index = 0; index < this.placements.length; index += 1) {
      const placement = this.placements[index];
      if (!placement) continue;
      const size = 0.55 + placement.severity * 0.18;
      this.position.set(placement.x, placement.ground + 0.2, placement.z);
      this.quaternion.setFromAxisAngle(UP, this.rotation + index * 0.7);
      this.scale.set(size, size, size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(index, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.remove(...this.group.children);
    this.group.parent?.remove(this.group);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.placements = [];
  }
}
