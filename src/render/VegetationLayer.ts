/**
 * Végétation instanciée : un tronc et un houppier par arbre.
 *
 * Les arbres proviennent des tuiles `trees` du snapshot. La densité est
 * contrôlée par le preset de qualité (sous-échantillonnage déterministe) et
 * un plafond évite d'exploser la mémoire sur une carte 256×256.
 *
 * Le vent est un déplacement de sommets dans le shader du houppier, avec une
 * phase par instance : aucun objet n'est recréé par frame.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { sampleHeightWorld, tileKindFromIndex } from '../game/mapGrid';
import { hashUnit2d } from '../game/prng';
import { qualitySettings, type QualityLevel } from './quality';

interface WindUniform {
  value: number;
}

export class VegetationLayer {
  readonly group = new THREE.Group();

  private trunkGeometry = new THREE.CylinderGeometry(0.05, 0.075, 0.42, 5);
  private canopyGeometry = new THREE.ConeGeometry(0.3, 0.85, 6);
  private trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x5d4630 });
  private canopyMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: false });
  private trunks: THREE.InstancedMesh | null = null;
  private canopies: THREE.InstancedMesh | null = null;
  private windUniform: WindUniform | null = null;
  private elapsed = 0;
  private windEnabled = true;
  private map: MapSnapshot | null = null;
  private density = 0.8;
  private treeCount = 0;
  private signature = 0;
  private builtLevel: QualityLevel | null = null;

  constructor() {
    this.group.name = 'vegetation';
    this.trunkGeometry.translate(0, 0.21, 0);
    this.canopyGeometry.translate(0, 0.66, 0);
    this.canopyMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windUniform ?? { value: 0 };
      this.windUniform = shader.uniforms.uTime as WindUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nattribute float aPhase;',
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3( position );
           float heightFactor = clamp( position.y, 0.0, 2.0 );
           float sway = sin( uTime * 0.9 + aPhase ) * 0.075 * heightFactor;
           transformed.x += sway;
           transformed.z += sway * 0.65;`,
        );
    };
    this.canopyMaterial.customProgramCacheKey = () => 'opentt3d-canopy-v1';
  }

  /** Reconstruit seulement si les tuiles d'arbres ou le preset ont changé. */
  build(map: MapSnapshot, level: QualityLevel): void {
    const signature = computeTreeSignature(map);
    if (this.builtLevel === level && this.signature === signature) return;
    this.map = map;
    this.signature = signature;
    this.builtLevel = level;
    const settings = qualitySettings(level);
    this.density = settings.treeDensity;
    this.windEnabled = settings.wind;
    this.clearInstances();

    const candidates: number[] = [];
    for (let index = 0; index < map.kind.length; index += 1) {
      if (tileKindFromIndex(map.kind[index] ?? 0) === 'trees') candidates.push(index);
    }
    if (candidates.length === 0) {
      this.treeCount = 0;
      return;
    }

    const capacity = Math.min(settings.maxTrees, candidates.length);
    const kept: {
      x: number;
      z: number;
      ground: number;
      scale: number;
      rotation: number;
      phase: number;
      tint: number;
    }[] = [];
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
        x: wx,
        z: wz,
        ground: sampleHeightWorld(map, wx, wz),
        scale: 0.72 + hashUnit2d(0x33, x, y) * 0.5,
        rotation: hashUnit2d(0x44, x, y) * Math.PI * 2,
        phase: hashUnit2d(0x55, x, y) * Math.PI * 2,
        tint: hashUnit2d(0x66, x, y),
      });
    }

    if (kept.length === 0) {
      this.treeCount = 0;
      return;
    }

    const trunks = new THREE.InstancedMesh(this.trunkGeometry, this.trunkMaterial, kept.length);
    const canopies = new THREE.InstancedMesh(this.canopyGeometry, this.canopyMaterial, kept.length);
    trunks.name = 'trees-trunks';
    canopies.name = 'trees-canopies';
    trunks.frustumCulled = false;
    canopies.frustumCulled = false;

    const phases = new Float32Array(kept.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();

    for (let i = 0; i < kept.length; i += 1) {
      const tree = kept[i];
      if (!tree) continue;
      quaternion.setFromAxisAngle(axis, tree.rotation);
      position.set(tree.x, tree.ground, tree.z);
      scale.set(tree.scale, tree.scale * (0.9 + tree.tint * 0.35), tree.scale);
      matrix.compose(position, quaternion, scale);
      trunks.setMatrixAt(i, matrix);
      canopies.setMatrixAt(i, matrix);
      phases[i] = tree.phase;
      // Houppier : vert plus ou moins dense selon la tuile.
      const green = 0.36 + tree.tint * 0.22;
      colour.setRGB(0.18 + tree.tint * 0.1, green, 0.16 + tree.tint * 0.08);
      canopies.setColorAt(i, colour);
    }
    this.canopyGeometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    trunks.computeBoundingSphere();
    canopies.computeBoundingSphere();
    this.group.add(trunks);
    this.group.add(canopies);
    this.trunks = trunks;
    this.canopies = canopies;
    this.treeCount = kept.length;
  }

  get count(): number {
    return this.treeCount;
  }

  get drawCallCount(): number {
    return this.trunks ? 2 : 0;
  }

  update(deltaSeconds: number): void {
    if (!this.windEnabled) return;
    this.elapsed += deltaSeconds;
    if (this.windUniform) this.windUniform.value = this.elapsed;
  }

  private clearInstances(): void {
    if (this.trunks) {
      this.group.remove(this.trunks);
      this.trunks.dispose();
      this.trunks = null;
    }
    if (this.canopies) {
      this.group.remove(this.canopies);
      this.canopies.dispose();
      this.canopies = null;
    }
    this.treeCount = 0;
    this.windUniform = null;
  }

  dispose(): void {
    this.clearInstances();
    this.builtLevel = null;
    this.signature = 0;
    this.group.clear();
    this.trunkGeometry.dispose();
    this.canopyGeometry.dispose();
    this.trunkMaterial.dispose();
    this.canopyMaterial.dispose();
    this.map = null;
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }
}

/** Empreinte FNV des tuiles d'arbres, pour éviter les reconstructions inutiles. */
function computeTreeSignature(map: MapSnapshot): number {
  let hash = 0x811c9dc5;
  let count = 0;
  for (let index = 0; index < map.kind.length; index += 1) {
    if (tileKindFromIndex(map.kind[index] ?? 0) !== 'trees') continue;
    count += 1;
    hash = Math.imul(hash ^ index, 0x01000193) >>> 0;
  }
  return Math.imul(hash ^ count, 0x01000193) >>> 0;
}
