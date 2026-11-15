/**
 * Rendu des signaux de bloc posés sur les voies.
 *
 * Le protocole v1 ne transmet pas encore l'état rouge/vert des signaux : la
 * pastille alterne donc de façon déterministe (au rythme d'un jour de jeu) pour
 * rendre les signaux visibles et distinguer les deux états. Le jour où le pont
 * exposera l'état réel (#28, protocole v1.2), seul `update()` changera.
 */

import * as THREE from 'three';
import { TILE_FLAG, type MapSnapshot } from '../engine/protocol';
import { sampleHeightWorld, tileIndex } from '../game/mapGrid';

const MAX_SIGNALS = 2048;
const POLE_HEIGHT = 0.62;
/** Ticks moteur par jour (protocole v1 : fraction de jour 0..73). */
const TICKS_PER_DAY = 74;
const RED = 0xf05c52;
const GREEN = 0x63e08c;

interface SignalPlacement {
  x: number;
  y: number;
  ground: number;
}

export class SignalLayer {
  readonly group = new THREE.Group();

  private poles: THREE.InstancedMesh;
  private lights: THREE.InstancedMesh;
  private poleMaterial: THREE.MeshBasicMaterial;
  private lightMaterial: THREE.MeshBasicMaterial;
  private placements: SignalPlacement[] = [];
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private colour = new THREE.Color();
  private tick = 0;

  constructor() {
    this.group.name = 'signals';
    this.poleMaterial = new THREE.MeshBasicMaterial({ color: 0x3a3f45, toneMapped: false });
    const poleGeometry = new THREE.BoxGeometry(0.055, POLE_HEIGHT, 0.055);
    this.poles = new THREE.InstancedMesh(poleGeometry, this.poleMaterial, MAX_SIGNALS);
    this.poles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poles.count = 0;
    this.poles.frustumCulled = false;
    this.poles.renderOrder = 8;

    this.lightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    const lightGeometry = new THREE.SphereGeometry(0.12, 10, 8);
    this.lights = new THREE.InstancedMesh(lightGeometry, this.lightMaterial, MAX_SIGNALS);
    this.lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lights.count = 0;
    this.lights.frustumCulled = false;
    this.lights.renderOrder = 9;

    this.group.add(this.poles, this.lights);
    this.group.visible = false;
  }

  /** Reconstruit la liste des signaux à partir des drapeaux de la carte. */
  setMap(map: MapSnapshot): void {
    this.placements = [];
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const index = tileIndex(x, y, map.width);
        if (((map.flags[index] ?? 0) & TILE_FLAG.SIGNAL) === 0) continue;
        if (this.placements.length >= MAX_SIGNALS) break;
        this.placements.push({
          x: x + 0.5,
          y: y + 0.5,
          ground: sampleHeightWorld(map, x + 0.5, y + 0.5),
        });
      }
    }

    const count = this.placements.length;
    for (let i = 0; i < count; i += 1) {
      const placement = this.placements[i];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground + POLE_HEIGHT / 2, placement.y);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale);
      this.poles.setMatrixAt(i, this.matrix);
      this.position.set(placement.x, placement.ground + POLE_HEIGHT + 0.05, placement.y);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale);
      this.lights.setMatrixAt(i, this.matrix);
    }
    this.poles.count = count;
    this.lights.count = count;
    this.poles.instanceMatrix.needsUpdate = true;
    this.lights.instanceMatrix.needsUpdate = true;
    this.poles.computeBoundingSphere();
    this.lights.computeBoundingSphere();
    this.group.visible = count > 0;
    this.update(this.tick);
  }

  /** Colore les pastilles : alternance déterministe rouge/vert par jour. */
  update(tick: number): void {
    this.tick = tick;
    const day = Math.floor(tick / TICKS_PER_DAY);
    for (let i = 0; i < this.placements.length; i += 1) {
      const placement = this.placements[i];
      if (!placement) continue;
      const phase = (day + Math.round(placement.x) + Math.round(placement.y)) & 1;
      this.colour.setHex(phase === 0 ? GREEN : RED);
      this.lights.setColorAt(i, this.colour);
    }
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
  }

  get count(): number {
    return this.placements.length;
  }

  clear(): void {
    this.placements = [];
    this.poles.count = 0;
    this.lights.count = 0;
    this.group.visible = false;
  }

  dispose(): void {
    this.poles.geometry.dispose();
    this.poleMaterial.dispose();
    this.lights.geometry.dispose();
    this.lightMaterial.dispose();
    this.group.clear();
  }
}
