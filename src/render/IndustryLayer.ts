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
import { qualitySettings, type QualityLevel } from './quality';
import { createModelMaterial } from './models/materials';
import {
  collectIndustryFootprint,
  planDetail,
  planIndustry,
  type IndustryArchetype,
  type IndustryDetail,
  type IndustryPlan,
} from './industryPlan';
import { buildIndustryGeometry } from './models/industries';

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

interface ArchetypeMesh {
  archetype: IndustryArchetype;
  mesh: THREE.Mesh;
  detailed: THREE.BufferGeometry;
  coarse: THREE.BufferGeometry;
  /** Distance minimale caméra → industrie de ce lot. */
  centre: THREE.Vector3;
  detailedStats: { triangles: number; windows: number; parts: number };
  lod: boolean;
}

export class IndustryLayer {
  readonly group = new THREE.Group();

  private material: THREE.MeshStandardMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private meshes: ArchetypeMesh[] = [];
  private plans: IndustryPlan[] = [];
  private smoke: THREE.InstancedMesh | null = null;
  private smokeSources: SmokeSource[] = [];
  private smokeEnabled = true;
  private smokeDistance = 140;
  private lodDistance = 70;
  private elapsed = 0;
  private shadows = false;
  private signature = 0;
  private detail: IndustryDetail = 1;
  private quality: QualityLevel = 'medium';
  private industries: readonly IndustrySnapshot[] = [];
  private map: MapSnapshot | null = null;
  /** Dernière position caméra connue, pour appliquer le LOD après un rebuild. */
  private cameraPosition: THREE.Vector3 | null = null;
  /** Nombre de reconstructions (diagnostic/tests). */
  builds = 0;
  /** Nombre de lots affichés en silhouette simplifiée (diagnostic/tests). */
  coarseLods = 0;

  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();

  constructor() {
    this.group.name = 'industries';
    this.material = createModelMaterial({
      night: this.nightUniform,
      glowStrength: 1.1,
      nightAmbient: 0.03,
      roughness: 0.74,
      metalness: 0.06,
      name: 'industries-surface',
    });
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
      const detailed = buildIndustryGeometry(group, this.detail);
      const coarse = buildIndustryGeometry(group, 0);
      const mesh = new THREE.Mesh(detailed.geometry, this.material);
      mesh.name = `industry-${archetype}`;
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      const centre = new THREE.Vector3();
      for (const plan of group) {
        centre.x +=
          plan.footprint.reduce((sum, tile) => sum + tile.x + 0.5, 0) /
          Math.max(1, plan.footprint.length);
        centre.z +=
          plan.footprint.reduce((sum, tile) => sum + tile.y + 0.5, 0) /
          Math.max(1, plan.footprint.length);
        centre.y +=
          plan.footprint.reduce((sum, tile) => sum + tile.height, 0) /
          Math.max(1, plan.footprint.length);
      }
      centre.multiplyScalar(1 / Math.max(1, group.length));
      this.meshes.push({
        archetype,
        mesh,
        detailed: detailed.geometry,
        coarse: coarse.geometry,
        centre,
        detailedStats: detailed.stats,
        lod: false,
      });
    }

    this.buildSmoke();
    this.applyLod(this.cameraPosition);
  }

  /**
   * Bascule chaque archétype entre silhouette détaillée et volumes simples
   * selon la distance caméra → la plus proche industrie du lot.
   */
  applyLod(cameraPosition: THREE.Vector3 | null): void {
    if (!cameraPosition) return;
    let coarse = 0;
    for (const entry of this.meshes) {
      const distance = Math.hypot(
        entry.centre.x - cameraPosition.x,
        entry.centre.z - cameraPosition.z,
      );
      const useCoarse = distance > this.lodDistance;
      if (useCoarse) coarse += 1;
      if (useCoarse === entry.lod) continue;
      entry.lod = useCoarse;
      entry.mesh.geometry = useCoarse ? entry.coarse : entry.detailed;
      entry.mesh.geometry.computeBoundingSphere();
    }
    this.coarseLods = coarse;
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
    this.cameraPosition = cameraPosition ?? null;
    this.applyLod(this.cameraPosition);
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
    this.lodDistance = this.quality === 'high' ? 110 : this.quality === 'low' ? 48 : 78;
    if (this.smoke) this.smoke.visible = this.smokeEnabled;
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const entry of this.meshes) entry.mesh.castShadow = enabled;
  }

  /** Matériau de surface partagé (diagnostic et tests). */
  get surfaceMaterial(): THREE.MeshStandardMaterial {
    return this.material;
  }

  /** 0 = jour, 1 = nuit profonde : allume les vitrages et balises. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightAmount;
  }

  get night(): number {
    return this.nightAmount;
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

  /** Triangles de la silhouette détaillée, tous archétypes confondus. */
  get triangleCount(): number {
    let total = 0;
    for (const entry of this.meshes) total += entry.detailedStats.triangles;
    return total;
  }

  /** Détail par archétype, pour vérifier le budget de modélisation. */
  get archetypeStats(): Record<string, { triangles: number; windows: number; parts: number }> {
    const stats: Record<string, { triangles: number; windows: number; parts: number }> = {};
    for (const entry of this.meshes) stats[entry.archetype] = { ...entry.detailedStats };
    return stats;
  }

  get detailLevel(): IndustryDetail {
    return this.detail;
  }

  private clearMeshes(): void {
    for (const entry of this.meshes) {
      this.group.remove(entry.mesh);
      entry.detailed.dispose();
      entry.coarse.dispose();
    }
    this.meshes = [];
    this.coarseLods = 0;
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
    this.cameraPosition = null;
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
