/**
 * Fantôme de construction : surbrillance des tuiles ciblées, tracé et flèche
 * d'orientation.
 *
 * Le plan vient de `buildRules.planBuild` (module pur) : l'overlay ne valide
 * rien, il colore en vert un tracé valide et en rouge un tracé refusé. Les
 * objets sont alloués une fois (instances et ligne préallouées) : un changement
 * de tuile survolée ne recrée aucune géométrie.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { MAX_BUILD_TILES, type BuildPlan } from '../game/buildRules';
import { sampleHeightWorld } from '../game/mapGrid';

const VALID_COLOUR = 0x6ee7a0;
const INVALID_COLOUR = 0xf07a72;
const TILE_LIFT = 0.09;
const LINE_LIFT = 0.22;

export class BuildOverlay {
  readonly group = new THREE.Group();

  private tiles: THREE.InstancedMesh;
  private tileMaterial: THREE.MeshBasicMaterial;
  private line: THREE.Line;
  private lineMaterial: THREE.LineBasicMaterial;
  private linePositions: Float32Array;
  private marker: THREE.Mesh;
  private markerMaterial: THREE.MeshBasicMaterial;
  private colour = new THREE.Color(VALID_COLOUR);
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private direction = new THREE.Vector3();

  constructor() {
    this.group.name = 'build-overlay';
    this.group.visible = false;

    const tileGeometry = new THREE.BoxGeometry(0.9, 0.08, 0.9);
    this.tileMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      toneMapped: false,
    });
    this.tiles = new THREE.InstancedMesh(tileGeometry, this.tileMaterial, MAX_BUILD_TILES);
    this.tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tiles.count = 0;
    this.tiles.frustumCulled = false;
    this.tiles.renderOrder = 11;

    this.linePositions = new Float32Array(MAX_BUILD_TILES * 3);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    lineGeometry.setDrawRange(0, 0);
    this.lineMaterial = new THREE.LineBasicMaterial({
      color: VALID_COLOUR,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    this.line = new THREE.Line(lineGeometry, this.lineMaterial);
    this.line.frustumCulled = false;
    this.line.renderOrder = 12;

    const markerGeometry = new THREE.ConeGeometry(0.17, 0.5, 10);
    this.markerMaterial = new THREE.MeshBasicMaterial({
      color: VALID_COLOUR,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    this.marker = new THREE.Mesh(markerGeometry, this.markerMaterial);
    this.marker.visible = false;
    this.marker.renderOrder = 12;

    this.group.add(this.tiles, this.line, this.marker);
  }

  /** Affiche un plan d'aperçu ; `null` masque le fantôme. */
  setPlan(plan: BuildPlan | null, map: MapSnapshot | null): void {
    if (!plan || !map || plan.tiles.length === 0) {
      this.clear();
      return;
    }
    const colour = plan.valid ? VALID_COLOUR : INVALID_COLOUR;
    this.colour.setHex(colour);
    this.tileMaterial.color.setHex(0xffffff);
    this.lineMaterial.color.setHex(colour);
    this.markerMaterial.color.setHex(colour);

    const count = Math.min(plan.tiles.length, MAX_BUILD_TILES);
    for (let i = 0; i < count; i += 1) {
      const tile = plan.tiles[i];
      if (!tile) continue;
      const ground = sampleHeightWorld(map, tile.x + 0.5, tile.y + 0.5);
      this.position.set(tile.x + 0.5, ground + TILE_LIFT, tile.y + 0.5);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale);
      this.tiles.setMatrixAt(i, this.matrix);
      this.tiles.setColorAt(i, this.colour);

      this.linePositions[i * 3] = tile.x + 0.5;
      this.linePositions[i * 3 + 1] = ground + LINE_LIFT;
      this.linePositions[i * 3 + 2] = tile.y + 0.5;
    }

    this.tiles.count = count;
    this.tiles.instanceMatrix.needsUpdate = true;
    if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;
    this.tiles.computeBoundingSphere();

    const geometry = this.line.geometry;
    geometry.setDrawRange(0, count);
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    geometry.computeBoundingSphere();

    const last = plan.tiles[count - 1];
    const previous = plan.tiles[count - 2];
    if (last && previous) {
      const ground = sampleHeightWorld(map, last.x + 0.5, last.y + 0.5);
      this.marker.position.set(last.x + 0.5, ground + 0.55, last.y + 0.5);
      this.direction.set(last.x - previous.x, 0, last.y - previous.y);
      if (this.direction.lengthSq() > 0) {
        this.direction.normalize();
        this.marker.quaternion.setFromUnitVectors(this.up, this.direction);
      }
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }

    this.group.visible = true;
  }

  clear(): void {
    this.tiles.count = 0;
    this.tiles.instanceMatrix.needsUpdate = true;
    this.line.geometry.setDrawRange(0, 0);
    this.marker.visible = false;
    this.group.visible = false;
  }

  dispose(): void {
    this.tiles.geometry.dispose();
    this.tileMaterial.dispose();
    this.line.geometry.dispose();
    this.lineMaterial.dispose();
    this.marker.geometry.dispose();
    this.markerMaterial.dispose();
    this.group.clear();
  }
}
