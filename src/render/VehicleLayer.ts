/**
 * Rendu instancié des véhicules.
 *
 * Un `InstancedMesh` par modèle visuel (train, camion, bus, bateau, avion),
 * capacité gérée dynamiquement, aucune allocation de géométrie par frame.
 * La position provient de `VehicleInterpolator` (déjà interpolée entre
 * snapshots) ; l'orientation est déduite de la direction 0..255.
 */

import * as THREE from 'three';
import type { VehicleModelKind, RenderVehicle } from '../game/vehicleInterpolation';
import { companyColour, hexToRgb } from './tileVisuals';
import { buildVehicleGeometries, disposeVehicleGeometries } from './vehicleModels';

/** Direction OpenTTD 0..255 → lacet Three.js (modèle orienté +X). */
export function directionToYaw(direction: number): number {
  const theta = ((direction & 255) / 256) * Math.PI * 2;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  return Math.atan2(-dy, dx);
}

/** Décalage vertical du modèle, en unités monde. */
const MODEL_Y_OFFSET: Record<VehicleModelKind, number> = {
  train: 0.02,
  truck: 0.01,
  bus: 0.01,
  ship: 0.02,
  plane: 0,
};

interface ModelSlot {
  mesh: THREE.InstancedMesh;
  capacity: number;
  ids: number[];
  used: number;
}

export interface VehiclePickTarget {
  mesh: THREE.InstancedMesh;
  idForInstance(instanceId: number): number | null;
}

export class VehicleLayer {
  readonly group = new THREE.Group();

  private geometries: Record<VehicleModelKind, THREE.BufferGeometry>;
  private material: THREE.MeshLambertMaterial;
  private slots = new Map<VehicleModelKind, ModelSlot>();
  private halo: THREE.Mesh;
  private haloMaterial: THREE.MeshBasicMaterial;
  private selectedId: number | null = null;
  private haloRadius = 0.6;
  private elapsed = 0;
  private shadows = false;

  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private tint = new THREE.Color();
  private modelCounts = new Map<VehicleModelKind, number>();

  constructor() {
    this.group.name = 'vehicles';
    this.geometries = buildVehicleGeometries();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

    const haloGeometry = new THREE.RingGeometry(0.52, 0.78, 28);
    haloGeometry.rotateX(-Math.PI / 2);
    this.haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe27a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.halo = new THREE.Mesh(haloGeometry, this.haloMaterial);
    this.halo.name = 'vehicle-halo';
    this.halo.visible = false;
    this.halo.renderOrder = 10;
    this.group.add(this.halo);
  }

  /** Met à jour toutes les instances à partir des véhicules interpolés. */
  update(vehicles: readonly RenderVehicle[]): void {
    for (const slot of this.slots.values()) slot.used = 0;

    this.modelCounts.clear();
    for (const vehicle of vehicles) {
      this.modelCounts.set(vehicle.model, (this.modelCounts.get(vehicle.model) ?? 0) + 1);
    }
    for (const [model, count] of this.modelCounts) this.ensureSlot(model, count);

    for (const vehicle of vehicles) {
      const slot = this.slots.get(vehicle.model);
      if (!slot) continue;
      const index = slot.used;
      if (index >= slot.capacity) continue;

      const yaw = directionToYaw(vehicle.direction);
      this.quaternion.setFromAxisAngle(this.up, yaw);
      this.position.set(vehicle.x, vehicle.z + MODEL_Y_OFFSET[vehicle.model], vehicle.y);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      slot.mesh.setMatrixAt(index, this.matrix);

      const base = companyColour(vehicle.company);
      const rgb = hexToRgb(base);
      const dim = vehicle.status === 0 ? 0.65 : 1;
      this.tint.setRGB(rgb.r * dim, rgb.g * dim, rgb.b * dim);
      slot.mesh.setColorAt(index, this.tint);

      slot.ids[index] = vehicle.id;
      slot.used = index + 1;
    }

    for (const slot of this.slots.values()) {
      slot.mesh.count = slot.used;
      slot.mesh.instanceMatrix.needsUpdate = true;
      if (slot.mesh.instanceColor) slot.mesh.instanceColor.needsUpdate = true;
      slot.mesh.visible = slot.used > 0;
    }

    this.updateHalo(vehicles);
  }

  private ensureSlot(model: VehicleModelKind, needed: number): ModelSlot {
    let slot = this.slots.get(model);
    if (slot && slot.capacity >= needed) return slot;
    const capacity = Math.max(16, Math.ceil(needed * 1.5));
    if (slot) {
      this.group.remove(slot.mesh);
      slot.mesh.dispose();
    }
    const mesh = new THREE.InstancedMesh(this.geometries[model], this.material, capacity);
    mesh.name = `vehicles-${model}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = false;
    // Alloue le buffer de couleurs d'instance et masque les instances libres.
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, white);
    mesh.count = 0;
    this.group.add(mesh);
    slot = { mesh, capacity, ids: new Array<number>(capacity).fill(-1), used: 0 };
    this.slots.set(model, slot);
    return slot;
  }

  private updateHalo(vehicles: readonly RenderVehicle[]): void {
    if (this.selectedId === null) {
      this.halo.visible = false;
      return;
    }
    const vehicle = vehicles.find((item) => item.id === this.selectedId);
    if (!vehicle) {
      this.halo.visible = false;
      return;
    }
    this.haloRadius = vehicle.model === 'train' ? 1.3 : vehicle.model === 'ship' ? 0.9 : 0.6;
    this.halo.visible = true;
    this.halo.scale.setScalar(this.haloRadius);
    this.halo.position.set(vehicle.x, vehicle.z + 0.06, vehicle.y);
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const slot of this.slots.values()) slot.mesh.castShadow = enabled;
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    if (id === null) this.halo.visible = false;
  }

  getSelected(): number | null {
    return this.selectedId;
  }

  /** Cibles de picking : un maillage instancié par modèle. */
  pickTargets(): VehiclePickTarget[] {
    const targets: VehiclePickTarget[] = [];
    for (const slot of this.slots.values()) {
      if (slot.used === 0) continue;
      targets.push({
        mesh: slot.mesh,
        idForInstance: (instanceId: number) => slot.ids[instanceId] ?? null,
      });
    }
    return targets;
  }

  /** Nombre d'instances affichées (diagnostic/HUD). */
  get instanceCount(): number {
    let total = 0;
    for (const slot of this.slots.values()) total += slot.used;
    return total;
  }

  get drawCallCount(): number {
    return this.slots.size;
  }

  updateAnimation(deltaSeconds: number): void {
    this.elapsed += deltaSeconds;
    if (!this.halo.visible) return;
    const pulse = 1 + Math.sin(this.elapsed * 3.4) * 0.06;
    this.haloMaterial.opacity = 0.7 + Math.sin(this.elapsed * 3.4) * 0.15;
    this.halo.scale.setScalar(this.haloRadius * pulse);
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      this.group.remove(slot.mesh);
      slot.mesh.dispose();
    }
    this.slots.clear();
    this.group.remove(this.halo);
    this.halo.geometry.dispose();
    this.haloMaterial.dispose();
    disposeVehicleGeometries(this.geometries);
    this.material.dispose();
  }
}
