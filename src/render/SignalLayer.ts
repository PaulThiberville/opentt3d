/**
 * Rendu des signaux (#156).
 *
 * Le protocole expose désormais un octet de signal par tuile (`signalData`)
 * et une liste prête à l'emploi (`WorldSnapshot.signals`) : le rendu affiche
 * le type, le sens et l'état réels. Quand un ancien snapshot ne fournit que le
 * drapeau `TILE_FLAG.SIGNAL`, la pastille alterne rouge/vert de façon
 * déterministe pour rester visible.
 *
 * Deux `InstancedMesh` suffisent, comme le budget de rendu l'exige : les mâts
 * (colorés par type) et les feux (colorés par état). Le type se lit aussi à la
 * silhouette : les signaux path sont plus hauts, les combinés plus larges.
 */

import * as THREE from 'three';
import { TILE_FLAG, type MapSnapshot, type SignalSnapshot } from '../engine/protocol';
import { sampleHeightWorld, tileIndex } from '../game/mapGrid';
import type { SignalAspect, SignalKind } from '../game/signalRules';

const MAX_SIGNALS = 2048;
const POLE_HEIGHT = 0.62;
/** Ticks moteur par jour (protocole v1 : fraction de jour 0..73). */
const TICKS_PER_DAY = 74;
const RED = 0xf05c52;
const GREEN = 0x63e08c;
const YELLOW = 0xf2c94c;

const TYPE_COLOUR: Record<SignalKind, number> = {
  block: 0x3a3f45,
  path: 0x2f6fa8,
  entry: 0x2d8c7a,
  exit: 0xc47a2c,
  combo: 0x7a4fa8,
};

const HEAD_SCALE: Record<SignalKind, [number, number, number]> = {
  block: [1, 1, 1],
  path: [1, 1.35, 1],
  entry: [1.25, 0.9, 1],
  exit: [0.85, 1.2, 1],
  combo: [1.35, 1.35, 1],
};

interface SignalPlacement {
  x: number;
  y: number;
  ground: number;
  kind: SignalKind;
  aspect: SignalAspect;
  semaphore: boolean;
  /** Ancien snapshot : pas d'état réel, on alterne au rythme du jour. */
  dynamic: boolean;
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
    this.poleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
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

  /**
   * Reconstruit depuis la carte seule (compatibilité). Les signaux typés du
   * snapshot sont préférés via `setSignals`.
   */
  setMap(map: MapSnapshot): void {
    const signals: SignalSnapshot[] = [];
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const index = tileIndex(x, y, map.width);
        if (((map.flags[index] ?? 0) & TILE_FLAG.SIGNAL) === 0) continue;
        if (signals.length >= MAX_SIGNALS) break;
        signals.push({
          x,
          y,
          kind: 'block',
          direction: 'one-way',
          aspect: 'green',
          semaphore: false,
        });
      }
    }
    this.applySignals(signals, map, true);
  }

  /** Reconstruit depuis la liste typée du snapshot (#156). */
  setSignals(signals: readonly SignalSnapshot[] | undefined, map: MapSnapshot | null): void {
    if (!signals || signals.length === 0) {
      if (map) this.setMap(map);
      else this.clear();
      return;
    }
    this.applySignals(signals, map, false);
  }

  private applySignals(
    signals: readonly SignalSnapshot[],
    map: MapSnapshot | null,
    dynamic: boolean,
  ): void {
    this.placements = [];
    for (const signal of signals) {
      if (this.placements.length >= MAX_SIGNALS) break;
      const ground = map
        ? sampleHeightWorld(map, signal.x + 0.5, signal.y + 0.5)
        : sampleHeightWorldFallback(signal.y);
      this.placements.push({
        x: signal.x + 0.5,
        y: signal.y + 0.5,
        ground,
        kind: signal.kind,
        aspect: signal.aspect,
        semaphore: signal.semaphore,
        dynamic,
      });
    }

    const count = this.placements.length;
    for (let i = 0; i < count; i += 1) {
      const placement = this.placements[i];
      if (!placement) continue;
      const headScale = HEAD_SCALE[placement.kind];
      this.position.set(placement.x, placement.ground + POLE_HEIGHT / 2, placement.y);
      this.scale.set(1, 1, 1);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale);
      this.poles.setMatrixAt(i, this.matrix);

      const headHeight = POLE_HEIGHT + (headScale[1] - 1) * 0.12;
      this.position.set(placement.x, placement.ground + headHeight, placement.y);
      this.scale.set(headScale[0], headScale[1], headScale[2]);
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
    this.applyColours();
  }

  /** Couleurs : mâts par type, feux par état (ou alternance héritée). */
  private applyColours(): void {
    const day = Math.floor(this.tick / TICKS_PER_DAY);
    for (let i = 0; i < this.placements.length; i += 1) {
      const placement = this.placements[i];
      if (!placement) continue;
      const poleColour = placement.semaphore ? 0x5b4632 : (TYPE_COLOUR[placement.kind] ?? 0x3a3f45);
      this.colour.setHex(poleColour);
      this.poles.setColorAt(i, this.colour);

      let aspect = placement.aspect;
      if (placement.dynamic) {
        const phase = (day + Math.round(placement.x) + Math.round(placement.y)) & 1;
        aspect = phase === 0 ? 'green' : 'red';
      }
      this.colour.setHex(aspect === 'red' ? RED : aspect === 'yellow' ? YELLOW : GREEN);
      this.lights.setColorAt(i, this.colour);
    }
    if (this.poles.instanceColor) this.poles.instanceColor.needsUpdate = true;
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
  }

  /** Met à jour l'alternance des anciens signaux et le cycle jour/nuit. */
  update(tick: number): void {
    this.tick = tick;
    if (this.placements.some((placement) => placement.dynamic)) this.applyColours();
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
    this.group.remove(this.poles, this.lights);
    this.poles.dispose();
    this.poles.geometry.dispose();
    this.poleMaterial.dispose();
    this.lights.dispose();
    this.lights.geometry.dispose();
    this.lightMaterial.dispose();
    this.placements = [];
    this.poles.count = 0;
    this.lights.count = 0;
    this.group.clear();
  }
}

function sampleHeightWorldFallback(y: number): number {
  return (y % 4) * 0.5;
}
