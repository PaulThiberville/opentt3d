/**
 * Rendu instancié des véhicules.
 *
 * Un `InstancedMesh` par archétype visuel (bus urbain, autocar, camions,
 * locomotive, voitures, wagon, bateau, avion), capacité gérée dynamiquement,
 * aucune allocation de géométrie par frame. La position provient de
 * `VehicleInterpolator` (déjà interpolée entre snapshots) ; l'orientation est
 * déduite de la direction 0..255. L'archétype est choisi de façon déterministe
 * à partir de la famille du contrat et de l'id du véhicule.
 */

import * as THREE from 'three';
import type { RenderVehicle } from '../game/vehicleInterpolation';
import { companyColour, hexToRgb } from './tileVisuals';
import { createModelMaterial } from './models/materials';
import {
  createVehicleModelLibrary,
  variantFor,
  type VehicleModelDefinition,
  type VehicleModelLibrary,
  type VehicleVariant,
} from './vehicleModels';

/** Direction OpenTTD 0..255 → lacet Three.js (modèle orienté +X). */
export function directionToYaw(direction: number): number {
  const theta = ((direction & 255) / 256) * Math.PI * 2;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  return Math.atan2(-dy, dx);
}

interface ModelSlot {
  definition: VehicleModelDefinition;
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

  private library: VehicleModelLibrary;
  private material: THREE.MeshStandardMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private slots = new Map<VehicleVariant, ModelSlot>();
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
  private modelCounts = new Map<VehicleVariant, number>();
  private colourCache = new Map<number, { r: number; g: number; b: number }>();
  private lastSignature = 0;
  private lastColourSignature = 0;
  private hasSignature = false;
  private slotsCreated = 0;
  /** Uploads de matrices d'instances (diagnostic/tests). */
  matrixUploads = 0;
  /** Uploads de couleurs d'instances (diagnostic/tests). */
  colourUploads = 0;

  constructor() {
    this.group.name = 'vehicles';
    this.library = createVehicleModelLibrary();
    this.material = createModelMaterial({
      night: this.nightUniform,
      glowStrength: 1.25,
      nightAmbient: 0.18,
      roughness: 0.66,
      metalness: 0.05,
      name: 'vehicles-surface',
    });

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
    const signature = vehicleSignature(vehicles);
    const colourSignature = vehicleColourSignature(vehicles);
    if (this.hasSignature && signature === this.lastSignature) {
      // Position, orientation, statut et livrée inchangés (pause, gare…) :
      // aucun buffer GPU n'est réuploadé.
      this.updateHalo(vehicles);
      return;
    }
    const coloursChanged = !this.hasSignature || colourSignature !== this.lastColourSignature;
    this.lastSignature = signature;
    this.lastColourSignature = colourSignature;
    this.hasSignature = true;
    this.slotsCreated = 0;

    for (const slot of this.slots.values()) slot.used = 0;

    this.modelCounts.clear();
    for (const vehicle of vehicles) {
      const variant = variantFor(vehicle.model, vehicle.id);
      this.modelCounts.set(variant, (this.modelCounts.get(variant) ?? 0) + 1);
    }
    for (const [variant, count] of this.modelCounts) this.ensureSlot(variant, count);

    // Une nouvelle instance créée doit recevoir ses couleurs même si la
    // livrée globale n'a pas changé.
    const mustUploadColours = coloursChanged || this.slotsCreated > 0;

    for (const vehicle of vehicles) {
      const variant = variantFor(vehicle.model, vehicle.id);
      const slot = this.slots.get(variant);
      if (!slot) continue;
      const index = slot.used;
      if (index >= slot.capacity) continue;

      const yaw = directionToYaw(vehicle.direction);
      this.quaternion.setFromAxisAngle(this.up, yaw);
      this.position.set(vehicle.x, vehicle.z + slot.definition.groundOffset, vehicle.y);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      slot.mesh.setMatrixAt(index, this.matrix);

      if (mustUploadColours) {
        const rgb = this.companyRgb(vehicle.company);
        const dim = vehicle.status === 0 ? 0.65 : 1;
        this.tint.setRGB(rgb.r * dim, rgb.g * dim, rgb.b * dim);
        slot.mesh.setColorAt(index, this.tint);
      }

      slot.ids[index] = vehicle.id;
      slot.used = index + 1;
    }

    for (const slot of this.slots.values()) {
      slot.mesh.count = slot.used;
      slot.mesh.instanceMatrix.needsUpdate = true;
      this.matrixUploads += 1;
      if (mustUploadColours && slot.mesh.instanceColor) {
        slot.mesh.instanceColor.needsUpdate = true;
        this.colourUploads += 1;
      }
      slot.mesh.visible = slot.used > 0;
    }

    this.slotsCreated = 0;
    this.updateHalo(vehicles);
  }

  private companyRgb(company: number): { r: number; g: number; b: number } {
    let rgb = this.colourCache.get(company);
    if (!rgb) {
      rgb = hexToRgb(companyColour(company));
      this.colourCache.set(company, rgb);
    }
    return rgb;
  }

  private ensureSlot(variant: VehicleVariant, needed: number): ModelSlot {
    let slot = this.slots.get(variant);
    if (slot && slot.capacity >= needed) return slot;
    const capacity = Math.max(16, Math.ceil(needed * 1.5));
    if (slot) {
      this.group.remove(slot.mesh);
      slot.mesh.dispose();
    }
    const definition = this.library.get(variant);
    const mesh = new THREE.InstancedMesh(definition.geometry, this.material, capacity);
    mesh.name = `vehicles-${variant}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = false;
    // Alloue le buffer de couleurs d'instance et masque les instances libres.
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, white);
    mesh.count = 0;
    this.group.add(mesh);
    this.slotsCreated += 1;
    slot = {
      definition,
      mesh,
      capacity,
      ids: new Array<number>(capacity).fill(-1),
      used: 0,
    };
    this.slots.set(variant, slot);
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
    this.haloRadius = this.library.get(variantFor(vehicle.model, vehicle.id)).haloRadius;
    this.halo.visible = true;
    this.halo.scale.setScalar(this.haloRadius);
    this.halo.position.set(vehicle.x, vehicle.z + 0.06, vehicle.y);
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const slot of this.slots.values()) slot.mesh.castShadow = enabled;
  }

  /** Matériau de surface partagé (diagnostic et tests). */
  get surfaceMaterial(): THREE.MeshStandardMaterial {
    return this.material;
  }

  /** 0 = jour, 1 = nuit : léger halo émissif pour rester lisible en carte. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightAmount;
  }

  get night(): number {
    return this.nightAmount;
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
    this.library.dispose();
    this.material.dispose();
    this.colourCache.clear();
    this.modelCounts.clear();
    this.hasSignature = false;
    this.lastSignature = 0;
    this.lastColourSignature = 0;
    this.slotsCreated = 0;
  }
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Empreinte des données qui pilotent matrices et couleurs d'instances. */
export function vehicleSignature(vehicles: readonly RenderVehicle[]): number {
  let hash = FNV_OFFSET;
  hash = Math.imul(hash ^ vehicles.length, FNV_PRIME) >>> 0;
  for (const vehicle of vehicles) {
    hash = Math.imul(hash ^ vehicle.id, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ quantize(vehicle.x), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ quantize(vehicle.y), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ quantize(vehicle.z), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ (vehicle.direction & 255), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ vehicle.status, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ vehicle.company, FNV_PRIME) >>> 0;
    for (let index = 0; index < vehicle.model.length; index += 1) {
      hash = Math.imul(hash ^ vehicle.model.charCodeAt(index), FNV_PRIME) >>> 0;
    }
  }
  return hash >>> 0;
}

/** Empreinte de la livrée seule : un déplacement ne réuploade pas les couleurs. */
export function vehicleColourSignature(vehicles: readonly RenderVehicle[]): number {
  let hash = FNV_OFFSET;
  hash = Math.imul(hash ^ vehicles.length, FNV_PRIME) >>> 0;
  for (const vehicle of vehicles) {
    hash = Math.imul(hash ^ vehicle.id, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ vehicle.company, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ vehicle.status, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function quantize(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100_000) : 0;
}
