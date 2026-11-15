/**
 * Rendu des industries : volumes low-poly fusionnés par archétype.
 *
 * Les plans (`industryPlan.ts`) décrivent des boîtes, cylindres, cônes et
 * prismes rattachés aux tuiles `industry` du snapshot. Toutes les parties d'un
 * même archétype sont fusionnées en une géométrie à couleurs de sommets : une
 * carte complète tient donc en quelques draw calls (une par silhouette), plus
 * un `InstancedMesh` pour la fumée.
 *
 * Aucun objet n'est recréé par frame : la reconstruction n'a lieu que lorsque
 * les industries, l'emprise ou le niveau de détail changent.
 */

import * as THREE from 'three';
import type { IndustrySnapshot, MapSnapshot } from '../engine/protocol';
import { TILE_KIND_INDEX } from '../engine/protocol';
import { hexToRgb } from './tileVisuals';
import { qualitySettings, type QualityLevel } from './quality';
import {
  collectIndustryFootprint,
  planDetail,
  planIndustry,
  type IndustryArchetype,
  type IndustryDetail,
  type IndustryPart,
  type IndustryPlan,
} from './industryPlan';

const SMOKE_PUFFS_PER_STACK = 3;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

interface SmokeSource {
  x: number;
  y: number;
  z: number;
  scale: number;
  phase: number;
}

export class IndustryLayer {
  readonly group = new THREE.Group();

  private material: THREE.MeshLambertMaterial;
  private meshes: THREE.Mesh[] = [];
  private plans: IndustryPlan[] = [];
  private smoke: THREE.InstancedMesh | null = null;
  private smokeSources: SmokeSource[] = [];
  private smokeEnabled = true;
  private smokeDistance = 140;
  private elapsed = 0;
  private shadows = false;
  private signature = 0;
  private detail: IndustryDetail = 1;
  private quality: QualityLevel = 'medium';
  private industries: readonly IndustrySnapshot[] = [];
  private map: MapSnapshot | null = null;
  /** Nombre de reconstructions (diagnostic/tests). */
  builds = 0;

  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private euler = new THREE.Euler();

  constructor() {
    this.group.name = 'industries';
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  /** Reconstruit seulement si les industries, l'emprise ou le détail changent. */
  build(
    industries: readonly IndustrySnapshot[],
    map: MapSnapshot | null,
    quality: QualityLevel,
  ): void {
    this.industries = industries;
    this.map = map;
    this.quality = quality;
    this.detail = planDetail(quality);
    this.applyQualitySettings();
    const signature = computeSignature(industries, map, this.detail);
    if (signature === this.signature && this.builds > 0) return;
    this.signature = signature;
    this.builds += 1;
    this.clearMeshes();

    const byArchetype = new Map<IndustryArchetype, IndustryPlan[]>();
    const plans: IndustryPlan[] = [];
    for (const industry of industries) {
      const footprint = collectIndustryFootprint(map, industry);
      const plan = planIndustry(industry, footprint, this.detail);
      plans.push(plan);
      const bucket = byArchetype.get(plan.archetype);
      if (bucket) bucket.push(plan);
      else byArchetype.set(plan.archetype, [plan]);
    }
    this.plans = plans;

    for (const [archetype, group] of byArchetype) {
      const geometry = this.mergePlans(group);
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `industry-${archetype}`;
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    this.buildSmoke();
  }

  private mergePlans(plans: readonly IndustryPlan[]): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colours: number[] = [];
    const rgb = { r: 0, g: 0, b: 0 };
    const up = new THREE.Vector3(0, 1, 0);

    for (const plan of plans) {
      for (const part of plan.parts) {
        const geometry = createPartGeometry(part);
        this.euler.set(part.tiltX, part.rotation, part.tiltZ, 'YXZ');
        this.quaternion.setFromEuler(this.euler);
        this.position.set(part.x, part.ground + part.base, part.z);
        this.scale.set(part.width, part.height, part.depth);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        geometry.applyMatrix4(this.matrix);
        const flat = geometry.index ? geometry.toNonIndexed() : geometry;
        const position = flat.getAttribute('position');
        const normal = flat.getAttribute('normal');
        hexToRgb(part.colour, rgb);
        const count = position.count;
        for (let i = 0; i < count; i += 1) {
          positions.push(position.getX(i), position.getY(i), position.getZ(i));
          normals.push(
            normal ? normal.getX(i) : up.x,
            normal ? normal.getY(i) : up.y,
            normal ? normal.getZ(i) : up.z,
          );
          colours.push(rgb.r, rgb.g, rgb.b);
        }
        if (flat !== geometry) flat.dispose();
        geometry.dispose();
      }
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    merged.computeBoundingSphere();
    return merged;
  }

  private buildSmoke(): void {
    const sources: SmokeSource[] = [];
    for (const plan of this.plans) {
      for (const stack of plan.smokeStacks) {
        sources.push({
          ...stack,
          phase: this.hashPhase(plan.id, stack.x, stack.z),
        });
      }
    }
    this.smokeSources = sources;
    if (sources.length === 0 || !this.smokeEnabled) return;

    const capacity = sources.length * SMOKE_PUFFS_PER_STACK;
    const geometry = new THREE.IcosahedronGeometry(0.5, 0);
    const material = new THREE.MeshBasicMaterial({
      color: 0xd9dee2,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      fog: true,
    });
    const smoke = new THREE.InstancedMesh(geometry, material, capacity);
    smoke.name = 'industry-smoke';
    smoke.frustumCulled = false;
    smoke.renderOrder = 6;
    smoke.visible = this.smokeEnabled;
    this.group.add(smoke);
    this.smoke = smoke;
    this.writeSmokeMatrices(null);
  }

  private hashPhase(id: number, x: number, z: number): number {
    const value = Math.sin(id * 12.9898 + x * 78.233 + z * 37.719) * 43758.5453;
    return value - Math.floor(value);
  }

  private writeSmokeMatrices(camera: THREE.Vector3 | null): void {
    const smoke = this.smoke;
    if (!smoke) return;
    const maxDistance = this.smokeDistance;
    const maxDistanceSquared = maxDistance * maxDistance;
    let index = 0;
    let visibleStacks = 0;
    for (const source of this.smokeSources) {
      const dx = camera ? source.x - camera.x : 0;
      const dz = camera ? source.z - camera.z : 0;
      const tooFar = camera ? dx * dx + dz * dz > maxDistanceSquared : false;
      if (!tooFar) visibleStacks += 1;
      for (let puff = 0; puff < SMOKE_PUFFS_PER_STACK; puff += 1) {
        if (tooFar) {
          this.scale.set(0, 0, 0);
          this.position.set(source.x, source.y, source.z);
        } else {
          const t = (this.elapsed * 0.34 + source.phase + puff / SMOKE_PUFFS_PER_STACK) % 1;
          const drift = t * 0.18;
          const angle = source.phase * Math.PI * 2 + t * 1.4;
          this.position.set(
            source.x + Math.cos(angle) * drift,
            source.y + t * 1.25,
            source.z + Math.sin(angle) * drift,
          );
          const size = source.scale * (0.55 + t * 1.5);
          this.scale.set(size, size * 0.85, size);
        }
        this.quaternion.identity();
        this.matrix.compose(this.position, this.quaternion, this.scale);
        smoke.setMatrixAt(index, this.matrix);
        index += 1;
      }
    }
    smoke.instanceMatrix.needsUpdate = true;
    smoke.visible = this.smokeEnabled && visibleStacks > 0;
  }

  /** Animation de fumée, avec LOD par distance à la caméra. */
  update(deltaSeconds: number, cameraPosition?: THREE.Vector3): void {
    if (!this.smokeEnabled || !this.smoke) return;
    this.elapsed += deltaSeconds;
    this.writeSmokeMatrices(cameraPosition ?? null);
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.detail = planDetail(level);
    this.applyQualitySettings();
    if (this.industries.length > 0 || this.map) {
      const signature = computeSignature(this.industries, this.map, this.detail);
      if (signature === this.signature) return;
      this.build(this.industries, this.map, level);
    }
  }

  private applyQualitySettings(): void {
    const settings = qualitySettings(this.quality);
    this.smokeEnabled = settings.industrySmoke;
    this.smokeDistance = this.quality === 'high' ? 210 : 140;
    if (this.smoke) this.smoke.visible = this.smokeEnabled;
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const mesh of this.meshes) mesh.castShadow = enabled;
  }

  get industryCount(): number {
    return this.plans.length;
  }

  get partCount(): number {
    let total = 0;
    for (const plan of this.plans) total += plan.parts.length;
    return total;
  }

  get smokeSourceCount(): number {
    return this.smokeSources.length;
  }

  get drawCallCount(): number {
    return this.meshes.length + (this.smoke && this.smoke.visible ? 1 : 0);
  }

  get detailLevel(): IndustryDetail {
    return this.detail;
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes = [];
    if (this.smoke) {
      this.group.remove(this.smoke);
      this.smoke.geometry.dispose();
      const material = this.smoke.material;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else {
        material.dispose();
      }
      this.smoke = null;
    }
    this.smokeSources = [];
    this.plans = [];
    this.elapsed = 0;
  }

  dispose(): void {
    this.clearMeshes();
    this.group.clear();
    this.material.dispose();
    this.industries = [];
    this.map = null;
    this.signature = 0;
    this.builds = 0;
  }
}

/** Empreinte stable des industries + tuiles industrielles + détail. */
function computeSignature(
  industries: readonly IndustrySnapshot[],
  map: MapSnapshot | null,
  detail: IndustryDetail,
): number {
  let hash = FNV_OFFSET;
  hash = Math.imul(hash ^ detail, FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ industries.length, FNV_PRIME) >>> 0;
  if (map) {
    hash = Math.imul(hash ^ map.width, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ map.height, FNV_PRIME) >>> 0;
    for (let index = 0; index < map.kind.length; index += 1) {
      if ((map.kind[index] ?? 0) !== TILE_KIND_INDEX.industry) continue;
      hash = Math.imul(hash ^ index, FNV_PRIME) >>> 0;
    }
  }
  for (const industry of industries) {
    hash = Math.imul(hash ^ industry.id, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ Math.floor(industry.x), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ Math.floor(industry.y), FNV_PRIME) >>> 0;
    for (let i = 0; i < industry.kind.length; i += 1) {
      hash = Math.imul(hash ^ industry.kind.charCodeAt(i), FNV_PRIME) >>> 0;
    }
  }
  return hash >>> 0;
}

/** Géométrie unitaire d'une partie : base à y = 0, ou centrée pour les grumes. */
function createPartGeometry(part: IndustryPart): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  switch (part.shape) {
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(
        Math.max(0.02, part.topScale) * 0.5,
        0.5,
        1,
        8,
        1,
        false,
      );
      break;
    case 'cone':
      geometry = new THREE.ConeGeometry(0.5, 1, 8);
      break;
    case 'prism':
      geometry = createPrismGeometry();
      break;
    case 'ico':
      geometry = new THREE.IcosahedronGeometry(0.5, 0);
      break;
    case 'box':
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
  }
  if (!part.centre) geometry.translate(0, 0.5, 0);
  return geometry;
}

/** Prisme à toit à deux pans, base 1×1, hauteur 1, faîtage sur Z. */
function createPrismGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array([
    // Pan gauche
    -0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5, -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.5,
    // Pan droit
    0.5, 0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0.5, 0, 0.5,
    // Pignons avant et arrière
    -0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}
