/**
 * Rendu instancié des véhicules.
 *
 * Un `InstancedMesh` par archétype visuel (bus urbain, autocar, camions,
 * locomotive, voitures, wagon, bateau, avion), capacité gérée dynamiquement,
 * aucune allocation de géométrie par frame. La position provient de
 * `VehicleInterpolator` (déjà interpolée entre snapshots) ; l'orientation est
 * déduite de la direction 0..255. L'archétype est choisi de façon déterministe
 * à partir de la famille du contrat et de l'id du véhicule. Les bateaux sont
 * enfoncés à leur ligne de flottaison : sans cela, leur coque flottait
 * visiblement au-dessus de la nappe et ressemblait à un radeau (#215).
 */

import * as THREE from 'three';
import type { RenderVehicle } from '../game/vehicleInterpolation';
import { TILE_KIND_INDEX, type MapSnapshot } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { companyColour, hexToRgb } from './tileVisuals';
import { createModelMaterial } from './models/materials';
import {
  createVehicleModelLibrary,
  variantFor,
  type VehicleModelDefinition,
  type VehicleModelLibrary,
  type VehicleVariant,
} from './vehicleModels';
import type { QualityLevel } from './quality';

/** Direction OpenTTD 0..255 → lacet Three.js (modèle orienté +X). */
export function directionToYaw(direction: number): number {
  const theta = ((direction & 255) / 256) * Math.PI * 2;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  return Math.atan2(-dy, dx);
}

/**
 * Enfoncement de la coque d'un bateau sous `vehicle.z`, en unités monde.
 *
 * Le contrat moteur expose la hauteur de la voie d'eau (0,12 au niveau de la
 * mer) alors que l'origine du modèle est le bas de la coque. Sans ce
 * correctif, les bateaux flottaient visiblement au-dessus de la surface et
 * ressemblaient à des radeaux colorés (#215). La valeur place la ligne de
 * flottaison au ras de l'eau, avec la coque partiellement immergée.
 */
export const SHIP_WATERLINE_OFFSET = -0.19;

/** Décalage vertical d'un archétype au-dessus de `vehicle.z`. */
export function vehicleGroundOffset(variant: VehicleVariant, modelOffset: number): number {
  return variant === 'ship' ? SHIP_WATERLINE_OFFSET : modelOffset;
}

interface ModelSlot {
  definition: VehicleModelDefinition;
  mesh: THREE.InstancedMesh;
  capacity: number;
  ids: number[];
  used: number;
}

/** Budget de bouffées de vapeur (une seule `Points` par preset actif). */
const STEAM_CAPACITY = 96;
const STEAM_MEDIUM = 48;
const STEAM_HIGH = 96;
const STEAM_LIFE = 1.45;
const STEAM_SOURCES = 64;

const STEAM_VERTEX = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vAlpha = aAlpha;
    gl_PointSize = aSize * (280.0 / max(1.0, -view.z));
    gl_Position = projectionMatrix * view;
  }
`;

const STEAM_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float distance = length(point);
    if (distance > 0.5) discard;
    float alpha = smoothstep(0.5, 0.1, distance) * vAlpha;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(0.93, 0.95, 0.97, alpha);
  }
`;

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
  private quality: QualityLevel = 'medium';
  private reducedMotion = false;
  private steam: THREE.Points | null = null;
  private steamMaterial: THREE.ShaderMaterial | null = null;
  private steamPositions = new Float32Array(STEAM_CAPACITY * 3);
  private steamAlpha = new Float32Array(STEAM_CAPACITY);
  private steamSize = new Float32Array(STEAM_CAPACITY);
  private steamVelocity = new Float32Array(STEAM_CAPACITY * 3);
  private steamAge = new Float32Array(STEAM_CAPACITY);
  private steamCursor = 0;
  private steamAccumulator = 0;
  private steamEmitCounter = 0;
  private steamMax = STEAM_MEDIUM;
  private railSources = new Float32Array(STEAM_SOURCES * 3);
  private railSourceCount = 0;
  /** Bouffées de vapeur actives (diagnostic/tests). */
  steamParticleCount = 0;
  /** Draw calls annexes (halo, vapeur), hors modèles instanciés. */
  get accessoryDrawCalls(): number {
    return (this.halo.visible ? 1 : 0) + (this.steam?.visible ? 1 : 0);
  }

  /** Capacité de vapeur du preset (0 en basse qualité). */
  get steamCapacity(): number {
    return this.steamMax;
  }

  /** Copie des positions de vapeur (diagnostic/tests, pas la boucle de jeu). */
  steamPositionsSnapshot(): Float32Array {
    return this.steamPositions.slice(0, this.steamMax * 3);
  }

  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private yawQuaternion = new THREE.Quaternion();
  private pitchQuaternion = new THREE.Quaternion();
  private pitchAxis = new THREE.Vector3(0, 0, 1);
  private scale = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private map: MapSnapshot | null = null;
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
    this.ensureSteam();
    this.steam?.geometry.setDrawRange(0, this.steamMax);
  }

  /** Met à jour toutes les instances à partir des véhicules interpolés. */
  update(vehicles: readonly RenderVehicle[], map: MapSnapshot | null = null): void {
    this.map = map;
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
      this.yawQuaternion.setFromAxisAngle(this.up, yaw);
      const pitch = this.vehiclePitch(vehicle);
      if (Number.isFinite(pitch) && Math.abs(pitch) > 1e-5) {
        this.pitchQuaternion.setFromAxisAngle(this.pitchAxis, pitch);
        this.quaternion.copy(this.yawQuaternion).multiply(this.pitchQuaternion);
      } else {
        this.quaternion.copy(this.yawQuaternion);
      }
      const offset = vehicleGroundOffset(variant, slot.definition.groundOffset);
      this.position.set(vehicle.x, vehicle.z + offset, vehicle.y);
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

    this.collectRailSources(vehicles);
    this.slotsCreated = 0;
    this.updateHalo(vehicles);
  }

  /**
   * Tangage d'un véhicule (#232) : valeur du moteur si elle existe, sinon
   * pente du terrain le long de son axe de déplacement. Ce repli couvre les
   * moteurs WASM antérieurs au champ `pitch` et les véhicules arrêtés sur une
   * rampe. Les navires, avions et modèles non terrestres restent horizontaux.
   */
  private vehiclePitch(vehicle: RenderVehicle): number {
    if (Number.isFinite(vehicle.pitch)) return vehicle.pitch as number;
    if (vehicle.kind !== 'road' && vehicle.kind !== 'train') return 0;
    const map = this.map;
    if (!map) return 0;
    const tileX = Math.floor(vehicle.x);
    const tileY = Math.floor(vehicle.y);
    if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) return 0;
    const kind = map.kind[tileY * map.width + tileX] ?? 0;
    // Sur un pont/tunnel, le terrain sous le tablier ne donne pas la pente
    // réelle : horizontal vaut mieux qu'un tangage faux quand le moteur ne
    // fournit pas `pitch`.
    if (kind === TILE_KIND_INDEX.bridge || kind === TILE_KIND_INDEX.tunnel) return 0;
    const yaw = directionToYaw(vehicle.direction);
    const forwardX = Math.cos(yaw);
    const forwardZ = -Math.sin(yaw);
    const half = 0.38;
    const front = sampleHeightWorld(map, vehicle.x + forwardX * half, vehicle.y + forwardZ * half);
    const back = sampleHeightWorld(map, vehicle.x - forwardX * half, vehicle.y - forwardZ * half);
    return Math.atan2(front - back, half * 2);
  }

  /** Mémorise les positions des convois pour émettre la vapeur sans copie. */
  private collectRailSources(vehicles: readonly RenderVehicle[]): void {
    let count = 0;
    for (const vehicle of vehicles) {
      if (vehicle.kind !== 'train' || count >= STEAM_SOURCES) continue;
      this.railSources[count * 3] = vehicle.x;
      this.railSources[count * 3 + 1] = vehicle.z;
      this.railSources[count * 3 + 2] = vehicle.y;
      count += 1;
    }
    this.railSourceCount = count;
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
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(0.1, deltaSeconds)) : 0;
    this.elapsed += delta;
    this.updateSteam(delta);
    if (!this.halo.visible) return;
    const pulse = 1 + Math.sin(this.elapsed * 3.4) * 0.06;
    this.haloMaterial.opacity = 0.7 + Math.sin(this.elapsed * 3.4) * 0.15;
    this.halo.scale.setScalar(this.haloRadius * pulse);
  }

  /**
   * Vapeur de locomotive : un unique `Points` à capacité fixe. Émission et
   * simulation sont déterministes (hash de l'id et du compteur, jamais
   * `Math.random`), et aucune allocation n'a lieu par frame.
   */
  private updateSteam(delta: number): void {
    const steam = this.steam;
    if (!steam || this.steamMax === 0) {
      this.steamParticleCount = 0;
      return;
    }
    if (this.reducedMotion || this.railSourceCount === 0) {
      steam.visible = false;
      this.steamParticleCount = 0;
      return;
    }

    // Émission : ~11 bouffées/s par convoi en marche, plafonnée au budget.
    this.steamAccumulator += delta * this.railSourceCount * 11;
    let spawns = Math.floor(this.steamAccumulator);
    this.steamAccumulator -= spawns;
    const activeLimit = this.steamMax;
    while (spawns > 0) {
      spawns -= 1;
      const source = this.steamEmitCounter % this.railSourceCount;
      this.steamEmitCounter += 1;
      const slot = this.steamCursor % activeLimit;
      this.steamCursor += 1;
      const offset = slot * 3;
      const jitterX = hashSigned(source * 31 + this.steamEmitCounter * 7) * 0.16;
      const jitterZ = hashSigned(source * 17 + this.steamEmitCounter * 13) * 0.16;
      this.steamPositions[offset] = this.railSources[source * 3]! + jitterX;
      this.steamPositions[offset + 1] = this.railSources[source * 3 + 1]! + 0.62;
      this.steamPositions[offset + 2] = this.railSources[source * 3 + 2]! + jitterZ;
      this.steamVelocity[offset] = jitterX * 0.6 + 0.18;
      this.steamVelocity[offset + 1] = 0.85 + hashSigned(source * 3 + 1) * 0.18;
      this.steamVelocity[offset + 2] = jitterZ * 0.6 + 0.06;
      this.steamAge[slot] = 1e-4;
    }

    let alive = 0;
    const geometry = steam.geometry;
    for (let slot = 0; slot < activeLimit; slot += 1) {
      const offset = slot * 3;
      if (this.steamAge[slot]! > 0 || this.steamAlpha[slot]! > 0) {
        this.steamAge[slot] = this.steamAge[slot]! + delta;
      }
      const age = this.steamAge[slot]!;
      if (age <= 0 || age >= STEAM_LIFE) {
        this.steamAlpha[slot] = 0;
        this.steamSize[slot] = 0;
        continue;
      }
      const life = age / STEAM_LIFE;
      this.steamPositions[offset] =
        this.steamPositions[offset]! + this.steamVelocity[offset]! * delta;
      this.steamPositions[offset + 1] =
        this.steamPositions[offset + 1]! + this.steamVelocity[offset + 1]! * delta;
      this.steamPositions[offset + 2] =
        this.steamPositions[offset + 2]! + this.steamVelocity[offset + 2]! * delta;
      // La bouffée ralentit en montant et s'élargit.
      this.steamVelocity[offset] = this.steamVelocity[offset]! * 0.985;
      this.steamVelocity[offset + 1] = this.steamVelocity[offset + 1]! * 0.992;
      this.steamAlpha[slot] = Math.sin(Math.PI * Math.min(1, life)) * 0.55;
      this.steamSize[slot] = 0.28 + life * 0.85;
      alive += 1;
    }
    this.steamParticleCount = alive;
    steam.visible = alive > 0;
    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.aAlpha!.needsUpdate = true;
    geometry.attributes.aSize!.needsUpdate = true;
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.steamMax = level === 'high' ? STEAM_HIGH : level === 'medium' ? STEAM_MEDIUM : 0;
    if (this.steamMax > 0) this.ensureSteam();
    if (this.steam) {
      this.steam.visible = this.steamMax > 0 && !this.reducedMotion;
      this.steam.geometry.setDrawRange(0, this.steamMax);
    }
  }

  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  /** Coupe la vapeur animée (accessibilité). */
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    if (this.steam) this.steam.visible = !enabled && this.steamMax > 0;
    if (enabled) this.steamParticleCount = 0;
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  private ensureSteam(): void {
    if (this.steam) return;
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this.steamPositions, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const alpha = new THREE.BufferAttribute(this.steamAlpha, 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    const size = new THREE.BufferAttribute(this.steamSize, 1);
    size.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('aAlpha', alpha);
    geometry.setAttribute('aSize', size);
    geometry.setDrawRange(0, this.steamMax);
    this.steamMaterial = new THREE.ShaderMaterial({
      name: 'vehicle-steam',
      vertexShader: STEAM_VERTEX,
      fragmentShader: STEAM_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const steam = new THREE.Points(geometry, this.steamMaterial);
    steam.name = 'vehicle-steam';
    steam.frustumCulled = false;
    steam.renderOrder = 7;
    steam.visible = false;
    this.steam = steam;
    this.group.add(steam);
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
    if (this.steam) {
      this.group.remove(this.steam);
      this.steam.geometry.dispose();
      this.steamMaterial?.dispose();
      this.steam = null;
      this.steamMaterial = null;
    }
    this.library.dispose();
    this.material.dispose();
    this.colourCache.clear();
    this.modelCounts.clear();
    this.steamParticleCount = 0;
    this.railSourceCount = 0;
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
    for (let index = 0; index < vehicle.kind.length; index += 1) {
      hash = Math.imul(hash ^ vehicle.kind.charCodeAt(index), FNV_PRIME) >>> 0;
    }
    hash = Math.imul(hash ^ quantize(vehicle.x), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ quantize(vehicle.y), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ quantize(vehicle.z), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ quantize(vehicle.pitch ?? 0), FNV_PRIME) >>> 0;
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

/** Hash déterministe dans [-1, 1) pour la dispersion des bouffées. */
function hashSigned(seed: number): number {
  let hash = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) / 0x80000000 - 1;
}
