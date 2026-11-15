/**
 * Végétation instanciée : un tronc et un houppier par arbre.
 *
 * Les arbres proviennent des tuiles `trees` du snapshot. La densité est
 * contrôlée par le preset de qualité (sous-échantillonnage déterministe) et
 * un plafond évite d'exploser la mémoire sur une carte 256×256.
 *
 * Les instances sont regroupées par chunk spatial (au plus 4×4 groupes) pour
 * que le frustum culling de Three.js puisse écarter les forêts hors écran sans
 * multiplier les draw calls. Chaque chunk bascule entre géométrie détaillée et
 * géométrie basse avec hystérésis : aucun popping à la frontière.
 *
 * Le vent est un déplacement de sommets dans le shader du houppier. La phase
 * est dérivée de la matrice d'instance (position au sol) : aucun attribut
 * instancié n'est alloué par rebuild, donc aucune fuite GPU possible.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { TILE_KIND_INDEX } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { hashUnit2d } from '../game/prng';
import { qualitySettings, type QualityLevel } from './quality';

interface WindUniform {
  value: number;
}

interface TreePlacement {
  x: number;
  z: number;
  ground: number;
  scale: number;
  rotation: number;
  tint: number;
}

interface TreeChunk {
  centreX: number;
  centreZ: number;
  count: number;
  near: boolean;
  trunks: THREE.InstancedMesh;
  canopies: THREE.InstancedMesh;
}

/** Nombre maximal de groupes spatiaux par axe : au plus 16 chunks. */
const CHUNKS_PER_AXIS = 4;
/** Taille minimale d'un chunk en tuiles (cartes petites). */
const MIN_CHUNK_TILES = 32;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class VegetationLayer {
  readonly group = new THREE.Group();

  private trunkGeometry = new THREE.CylinderGeometry(0.05, 0.075, 0.42, 5);
  private canopyGeometry = new THREE.ConeGeometry(0.3, 0.85, 6);
  private coarseTrunkGeometry = new THREE.CylinderGeometry(0.06, 0.08, 0.42, 3);
  private coarseCanopyGeometry = new THREE.ConeGeometry(0.32, 0.85, 4);
  private trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x5d4630 });
  private canopyMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: false });
  private chunks: TreeChunk[] = [];
  private windUniform: WindUniform | null = null;
  private elapsed = 0;
  private windEnabled = true;
  private reducedMotion = false;
  private map: MapSnapshot | null = null;
  private density = 0.8;
  private treeCount = 0;
  private signature = 0;
  private builtLevel: QualityLevel | null = null;
  private nearDistance = 90;
  private farDistance = 112;
  /** Nombre de reconstructions réelles (diagnostic/tests). */
  builds = 0;
  /** Nombre de bascules near/far (diagnostic/tests). */
  lodSwitches = 0;

  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private axis = new THREE.Vector3(0, 1, 0);
  private colour = new THREE.Color();

  constructor() {
    this.group.name = 'vegetation';
    this.trunkGeometry.translate(0, 0.21, 0);
    this.coarseTrunkGeometry.translate(0, 0.21, 0);
    this.canopyGeometry.translate(0, 0.66, 0);
    this.coarseCanopyGeometry.translate(0, 0.66, 0);
    this.canopyMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windUniform ?? { value: 0 };
      this.windUniform = shader.uniforms.uTime as WindUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3( position );
           // Phase stable par instance, dérivée de la position au sol :
           // aucun attribut GPU supplémentaire à allouer par rebuild.
           float phase = fract( sin( dot( instanceMatrix[ 3 ].xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
           float heightFactor = clamp( ( position.y - 0.2 ) / 0.9, 0.0, 1.0 );
           float sway = sin( uTime * 0.9 + phase * 6.2831853 ) * 0.075 * heightFactor;
           transformed.x += sway;
           transformed.z += sway * 0.65;`,
        );
    };
    this.canopyMaterial.customProgramCacheKey = () => 'opentt3d-canopy-v2';
    this.applyQualitySettings('medium');
  }

  /** Reconstruit seulement si les tuiles d'arbres, leurs hauteurs ou le preset changent. */
  build(map: MapSnapshot, level: QualityLevel): void {
    this.map = map;
    if (this.builtLevel !== level) this.applyQualitySettings(level);
    const signature = computeTreeSignature(map, level);
    if (this.builds > 0 && this.signature === signature) return;
    this.signature = signature;
    this.builtLevel = level;
    this.builds += 1;
    this.clearInstances();

    const settings = qualitySettings(level);
    this.density = settings.treeDensity;

    const candidates: number[] = [];
    for (let index = 0; index < map.kind.length; index += 1) {
      if (map.kind[index] === TILE_KIND_INDEX.trees) candidates.push(index);
    }
    if (candidates.length === 0) {
      this.treeCount = 0;
      return;
    }

    const capacity = Math.min(settings.maxTrees, candidates.length);
    const kept: { x: number; y: number; tree: TreePlacement }[] = [];
    for (const index of candidates) {
      if (kept.length >= capacity) break;
      const x = index % map.width;
      const y = (index - x) / map.width;
      if (hashUnit2d(0x7ee5, x, y) > this.density) continue;
      const jitterX = (hashUnit2d(0x11, x, y) - 0.5) * 0.52;
      const jitterZ = (hashUnit2d(0x22, x, y) - 0.5) * 0.52;
      const wx = x + 0.5 + jitterX;
      const wz = y + 0.5 + jitterZ;
      kept.push({
        x,
        y,
        tree: {
          x: wx,
          z: wz,
          ground: sampleHeightWorld(map, wx, wz),
          scale: 0.72 + hashUnit2d(0x33, x, y) * 0.5,
          rotation: hashUnit2d(0x44, x, y) * Math.PI * 2,
          tint: hashUnit2d(0x66, x, y),
        },
      });
    }

    if (kept.length === 0) {
      this.treeCount = 0;
      return;
    }

    const chunkSize = Math.max(
      MIN_CHUNK_TILES,
      Math.ceil(Math.max(map.width, map.height) / CHUNKS_PER_AXIS),
    );
    const byChunk = new Map<number, TreePlacement[]>();
    for (const entry of kept) {
      const chunkX = Math.floor(entry.x / chunkSize);
      const chunkY = Math.floor(entry.y / chunkSize);
      const key = chunkY * 1024 + chunkX;
      const bucket = byChunk.get(key);
      if (bucket) bucket.push(entry.tree);
      else byChunk.set(key, [entry.tree]);
    }

    for (const placements of byChunk.values()) {
      this.chunks.push(this.createChunk(placements));
    }
    this.treeCount = kept.length;
    // Premier rendu détaillé : la caméra affine au premier `update`.
    this.applyLod(null);
  }

  private applyQualitySettings(level: QualityLevel): void {
    this.nearDistance = level === 'high' ? 120 : level === 'medium' ? 90 : 55;
    this.farDistance = Math.round(this.nearDistance * 1.25);
    this.windEnabled = qualitySettings(level).wind;
  }

  private createChunk(placements: TreePlacement[]): TreeChunk {
    const count = placements.length;
    const trunks = new THREE.InstancedMesh(this.trunkGeometry, this.trunkMaterial, count);
    const canopies = new THREE.InstancedMesh(this.canopyGeometry, this.canopyMaterial, count);
    trunks.name = 'trees-trunks';
    canopies.name = 'trees-canopies';
    trunks.frustumCulled = true;
    canopies.frustumCulled = true;

    let centreX = 0;
    let centreZ = 0;
    for (let i = 0; i < count; i += 1) {
      const tree = placements[i];
      if (!tree) continue;
      this.quaternion.setFromAxisAngle(this.axis, tree.rotation);
      this.position.set(tree.x, tree.ground, tree.z);
      this.scale.set(tree.scale, tree.scale * (0.9 + tree.tint * 0.35), tree.scale);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      trunks.setMatrixAt(i, this.matrix);
      canopies.setMatrixAt(i, this.matrix);
      // Houppiers volontairement sombres et peu saturés, dans la même famille
      // que l'herbe : les valeurs linéaires évitent le vert menthe délavé.
      this.colour.setRGB(
        0.052 + tree.tint * 0.045,
        0.095 + tree.tint * 0.07,
        0.038 + tree.tint * 0.032,
      );
      canopies.setColorAt(i, this.colour);
      centreX += tree.x;
      centreZ += tree.z;
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    trunks.computeBoundingSphere();
    canopies.computeBoundingSphere();
    this.group.add(trunks, canopies);
    return {
      centreX: centreX / count,
      centreZ: centreZ / count,
      count,
      near: true,
      trunks,
      canopies,
    };
  }

  get count(): number {
    return this.treeCount;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  get nearChunkCount(): number {
    let total = 0;
    for (const chunk of this.chunks) if (chunk.near) total += 1;
    return total;
  }

  get farChunkCount(): number {
    return this.chunks.length - this.nearChunkCount;
  }

  /** États des chunks, pour tester le LOD sans dépendre du rendu. */
  get chunkStates(): { x: number; z: number; near: boolean; count: number }[] {
    return this.chunks.map((chunk) => ({
      x: chunk.centreX,
      z: chunk.centreZ,
      near: chunk.near,
      count: chunk.count,
    }));
  }

  get drawCallCount(): number {
    // Un chunk proche = tronc + houppier ; un chunk lointain ne garde que le
    // houppier basse définition (un seul draw call).
    return this.nearChunkCount * 2 + this.farChunkCount;
  }

  /**
   * Fige le balancement (accessibilité). Le shader conserve sa phase courante
   * au lieu de repartir de zéro : aucun saut visuel au changement de réglage.
   */
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    if (!enabled) return;
    if (this.windUniform) this.windUniform.value = this.elapsed;
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Temps de vent accumulé (diagnostic/tests). */
  get windElapsed(): number {
    return this.elapsed;
  }

  update(deltaSeconds: number, cameraPosition?: THREE.Vector3 | null): void {
    if (this.windEnabled && !this.reducedMotion) {
      this.elapsed += deltaSeconds;
      if (this.windUniform) this.windUniform.value = this.elapsed;
    }
    if (cameraPosition) this.applyLod(cameraPosition);
  }

  /** Bascule near/far avec hystérésis, chunk par chunk. */
  applyLod(cameraPosition: THREE.Vector3 | null): void {
    const near = this.nearDistance;
    const far = this.farDistance;
    for (const chunk of this.chunks) {
      let next = chunk.near;
      if (cameraPosition) {
        const distance = Math.hypot(
          chunk.centreX - cameraPosition.x,
          chunk.centreZ - cameraPosition.z,
        );
        if (chunk.near) {
          if (distance > far) next = false;
        } else if (distance < near) {
          next = true;
        }
      }
      if (next === chunk.near) continue;
      chunk.near = next;
      this.lodSwitches += 1;
      chunk.trunks.visible = next;
      chunk.trunks.geometry = next ? this.trunkGeometry : this.coarseTrunkGeometry;
      chunk.canopies.geometry = next ? this.canopyGeometry : this.coarseCanopyGeometry;
      chunk.trunks.computeBoundingSphere();
      chunk.canopies.computeBoundingSphere();
    }
  }

  private clearInstances(): void {
    for (const chunk of this.chunks) {
      this.group.remove(chunk.trunks, chunk.canopies);
      chunk.trunks.dispose();
      chunk.canopies.dispose();
    }
    this.chunks = [];
    this.treeCount = 0;
    this.windUniform = null;
  }

  dispose(): void {
    this.clearInstances();
    this.builtLevel = null;
    this.signature = 0;
    this.builds = 0;
    this.lodSwitches = 0;
    this.group.clear();
    this.trunkGeometry.dispose();
    this.canopyGeometry.dispose();
    this.coarseTrunkGeometry.dispose();
    this.coarseCanopyGeometry.dispose();
    this.trunkMaterial.dispose();
    this.canopyMaterial.dispose();
    this.map = null;
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }
}

/**
 * Empreinte FNV des tuiles d'arbres, de leurs hauteurs et du preset : les
 * placements (position, échelle, teinte, phase) en dérivent entièrement.
 */
export function computeTreeSignature(map: MapSnapshot, level: QualityLevel): number {
  let hash = FNV_OFFSET;
  hash = Math.imul(hash ^ map.width, FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ map.height, FNV_PRIME) >>> 0;
  for (let index = 0; index < level.length; index += 1) {
    hash = Math.imul(hash ^ level.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  let count = 0;
  for (let index = 0; index < map.kind.length; index += 1) {
    if (map.kind[index] !== TILE_KIND_INDEX.trees) continue;
    count += 1;
    // La hauteur compte : une plaine reboisée sans changer les tuiles doit
    // reposer les arbres sur le nouveau relief.
    hash = Math.imul(hash ^ index, FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ (map.heightMap[index] ?? 0), FNV_PRIME) >>> 0;
  }
  return Math.imul(hash ^ count, FNV_PRIME) >>> 0;
}
