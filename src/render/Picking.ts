/**
 * Picking et surbrillance.
 *
 * Priorité de sélection : véhicule > bâtiment > tuile. Le survol est limité à
 * une requête par frame par le `WorldView` (les NDC ne sont relus que lorsque
 * la souris bouge). Le marqueur de tuile et le halo de véhicule sont des
 * objets uniques réutilisés, jamais recréés.
 */

import * as THREE from 'three';
import type { CityPickTarget } from './CityLayer';
import type { VehiclePickTarget } from './VehicleLayer';

export type PickResult =
  | { kind: 'vehicle'; id: number; point: THREE.Vector3; distance: number }
  | { kind: 'building'; townId: number; point: THREE.Vector3; distance: number }
  | { kind: 'tile'; x: number; y: number; point: THREE.Vector3; distance: number };

export interface PickSources {
  vehicles(): VehiclePickTarget[];
  buildings(): CityPickTarget[];
  terrain(): THREE.Object3D[];
}

export class Picking {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private sources: PickSources;
  private heightAt: (x: number, z: number) => number;

  readonly group = new THREE.Group();
  private tileOutline: THREE.LineLoop;
  private tileOutlineMaterial: THREE.LineBasicMaterial;
  private outlinePositions: Float32Array;
  private vehicleRing: THREE.Mesh;
  private vehicleRingMaterial: THREE.MeshBasicMaterial;
  private hovered: PickResult | null = null;

  constructor(sources: PickSources, heightAt: (x: number, z: number) => number) {
    this.sources = sources;
    this.heightAt = heightAt;
    this.group.name = 'picking';

    this.outlinePositions = new Float32Array(4 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.outlinePositions, 3));
    this.tileOutlineMaterial = new THREE.LineBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.9,
    });
    this.tileOutline = new THREE.LineLoop(geometry, this.tileOutlineMaterial);
    this.tileOutline.visible = false;
    this.tileOutline.renderOrder = 12;

    const ringGeometry = new THREE.RingGeometry(0.55, 0.8, 26);
    ringGeometry.rotateX(-Math.PI / 2);
    this.vehicleRingMaterial = new THREE.MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.vehicleRing = new THREE.Mesh(ringGeometry, this.vehicleRingMaterial);
    this.vehicleRing.visible = false;
    this.vehicleRing.renderOrder = 12;

    this.group.add(this.tileOutline);
    this.group.add(this.vehicleRing);
  }

  get hover(): PickResult | null {
    return this.hovered;
  }

  /** Picking complet : la caméra construit le rayon écran → monde. */
  pickWithCamera(ndc: { x: number; y: number }, camera: THREE.Camera): PickResult | null {
    this.pointer.set(ndc.x, ndc.y);
    this.raycaster.setFromCamera(this.pointer, camera);

    const vehicleTargets = this.sources.vehicles();
    if (vehicleTargets.length > 0) {
      const meshes = vehicleTargets.map((target) => target.mesh);
      const hits = this.raycaster.intersectObjects(meshes, false);
      const first = hits[0];
      if (first && first.instanceId !== undefined) {
        const target = vehicleTargets.find((candidate) => candidate.mesh === first.object);
        const id = target?.idForInstance(first.instanceId) ?? null;
        if (id !== null) {
          return { kind: 'vehicle', id, point: first.point.clone(), distance: first.distance };
        }
      }
    }

    const buildingTargets = this.sources.buildings();
    if (buildingTargets.length > 0) {
      const meshes = buildingTargets.map((target) => target.mesh);
      const hits = this.raycaster.intersectObjects(meshes, false);
      const first = hits[0];
      if (first && first.instanceId !== undefined) {
        const target = buildingTargets.find((candidate) => candidate.mesh === first.object);
        const townId = target?.townForInstance(first.instanceId) ?? null;
        if (townId !== null) {
          return { kind: 'building', townId, point: first.point.clone(), distance: first.distance };
        }
      }
    }

    const terrain = this.sources.terrain();
    if (terrain.length > 0) {
      const hits = this.raycaster.intersectObjects(terrain, false);
      const first = hits[0];
      if (first) {
        const x = Math.floor(first.point.x);
        const y = Math.floor(first.point.z);
        return { kind: 'tile', x, y, point: first.point.clone(), distance: first.distance };
      }
    }
    return null;
  }

  /** Met à jour le marqueur visuel du survol. */
  setHover(result: PickResult | null): void {
    this.hovered = result;
    if (!result) {
      this.tileOutline.visible = false;
      this.vehicleRing.visible = false;
      return;
    }
    if (result.kind === 'vehicle') {
      this.tileOutline.visible = false;
      this.vehicleRing.visible = true;
      this.vehicleRing.position.set(result.point.x, result.point.y + 0.05, result.point.z);
      const scale = 1 + Math.sin(performance.now() * 0.004) * 0.05;
      this.vehicleRing.scale.setScalar(scale);
      return;
    }
    this.vehicleRing.visible = false;
    this.tileOutline.visible = true;
    const tileX = result.kind === 'tile' ? result.x : Math.floor(result.point.x);
    const tileY = result.kind === 'tile' ? result.y : Math.floor(result.point.z);
    const ground = this.heightAt(tileX + 0.5, tileY + 0.5);
    const outset = 0.06;
    const x0 = tileX + outset;
    const x1 = tileX + 1 - outset;
    const z0 = tileY + outset;
    const z1 = tileY + 1 - outset;
    const y = ground + 0.08;
    const positions = this.outlinePositions;
    positions[0] = x0;
    positions[1] = y;
    positions[2] = z0;
    positions[3] = x1;
    positions[4] = y;
    positions[5] = z0;
    positions[6] = x1;
    positions[7] = y;
    positions[8] = z1;
    positions[9] = x0;
    positions[10] = y;
    positions[11] = z1;
    const attribute = this.tileOutline.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    this.tileOutline.geometry.computeBoundingSphere();
  }

  clearHover(): void {
    this.setHover(null);
  }

  dispose(): void {
    this.tileOutline.geometry.dispose();
    this.tileOutlineMaterial.dispose();
    this.vehicleRing.geometry.dispose();
    this.vehicleRingMaterial.dispose();
    this.group.clear();
    this.hovered = null;
  }
}
