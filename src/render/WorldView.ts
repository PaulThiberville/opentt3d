/**
 * Vue du monde : assemble terrain, eau, villes, végétation et véhicules.
 *
 * Cette classe est le seul endroit qui connaît à la fois Three.js et le
 * contrat `WorldSnapshot`. Elle ne décide de rien : `main.ts` lui pousse les
 * snapshots et l'état d'interpolation, et relaie les sélections vers `Game`.
 */

import * as THREE from 'three';
import type { MapSnapshot, WorldSnapshot } from '../engine/protocol';
import { VehicleInterpolator, type RenderVehicle } from '../game/vehicleInterpolation';
import type { InterpolationState } from '../game/Game';
import { CameraController } from './CameraController';
import { CityLayer } from './CityLayer';
import { Picking, type PickResult } from './Picking';
import { TerrainLayer } from './TerrainLayer';
import { VegetationLayer } from './VegetationLayer';
import { VehicleLayer } from './VehicleLayer';
import type { QualityLevel } from './quality';

export type WorldTarget =
  | { kind: 'vehicle'; id: number }
  | { kind: 'building'; townId: number; x: number; y: number }
  | { kind: 'tile'; x: number; y: number };

export interface WorldViewOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  quality: QualityLevel;
  onSelect?: (target: WorldTarget | null) => void;
  onHover?: (target: WorldTarget | null) => void;
  onNotice?: (text: string) => void;
}

export class WorldView {
  readonly terrain = new TerrainLayer();
  readonly cityLayer = new CityLayer();
  readonly vegetation = new VegetationLayer();
  readonly vehicles = new VehicleLayer();

  private scene: THREE.Scene;
  private canvas: HTMLCanvasElement;
  private camera: THREE.PerspectiveCamera;
  private controller: CameraController;
  private picking: Picking;
  private interpolator = new VehicleInterpolator();
  private renderVehicles: RenderVehicle[] = [];
  private quality: QualityLevel;
  private mapApplied = false;
  private selectedVehicle: number | null = null;
  private currentMap: MapSnapshot | null = null;
  private onSelect?: (target: WorldTarget | null) => void;
  private onHover?: (target: WorldTarget | null) => void;
  private onNotice?: (text: string) => void;
  private lastHoverKey: string | null = null;

  constructor(options: WorldViewOptions) {
    this.scene = options.scene;
    this.canvas = options.canvas;
    this.camera = options.camera;
    this.quality = options.quality;
    this.onSelect = options.onSelect;
    this.onHover = options.onHover;
    this.onNotice = options.onNotice;

    this.scene.add(this.terrain.group);
    this.scene.add(this.cityLayer.group);
    this.scene.add(this.vegetation.group);
    this.scene.add(this.vehicles.group);

    this.picking = new Picking(
      {
        vehicles: () => this.vehicles.pickTargets(),
        buildings: () => this.cityLayer.pickTargets(),
        terrain: () => this.terrain.pickTargets(),
      },
      (x, z) => this.terrain.heightAt(x, z),
    );
    this.scene.add(this.picking.group);

    this.controller = new CameraController({
      camera: this.camera,
      element: this.canvas,
      bounds: { minX: 0, maxX: 64, minZ: 0, maxZ: 64 },
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      onClick: (ndc) => this.handleClick(ndc),
      onDoubleClick: (ndc) => this.handleDoubleClick(ndc),
    });
    this.controller.attach();
    this.controller.update(0);
    this.applyQuality(options.quality);
  }

  /** Applique un snapshot (carte en delta, entités complètes). */
  applySnapshot(snapshot: WorldSnapshot): void {
    const map = snapshot.map;
    if (map) {
      const first = !this.mapApplied;
      if (first) this.terrain.setMap(map);
      else this.terrain.applyDelta(map);
      this.currentMap = map;
      this.cityLayer.build(snapshot.towns, map);
      this.vegetation.build(map, this.quality);
      this.mapApplied = true;
      if (first) {
        this.controller.setBounds({ minX: 0, maxX: map.width, minZ: 0, maxZ: map.height });
        this.controller.reset();
      }
    }
  }

  /** Frame : interpolation, entités, caméra, picking au survol. */
  update(deltaSeconds: number, interpolation: InterpolationState): void {
    const from = interpolation.from?.vehicles ?? [];
    const to = interpolation.to?.vehicles ?? [];
    this.interpolator.interpolate(from, to, interpolation.alpha, this.renderVehicles);
    this.vehicles.update(this.renderVehicles);
    this.vehicles.updateAnimation(deltaSeconds);
    this.vehicles.setSelected(this.selectedVehicle);

    this.controller.update(deltaSeconds);
    this.terrain.update(deltaSeconds);
    this.vegetation.update(deltaSeconds);
    this.updateHover();
  }

  private updateHover(): void {
    const ndc = this.controller.takeHover();
    if (!ndc) {
      if (!this.controller.isPointerInside() && this.picking.hover) {
        this.picking.clearHover();
        this.lastHoverKey = null;
        this.onHover?.(null);
      }
      return;
    }
    const result = this.picking.pickWithCamera(ndc, this.camera);
    this.picking.setHover(result);
    const key = result
      ? result.kind === 'vehicle'
        ? `v${result.id}`
        : result.kind === 'building'
          ? `b${result.townId}`
          : `t${result.x},${result.y}`
      : null;
    if (key !== this.lastHoverKey) {
      this.lastHoverKey = key;
      this.onHover?.(this.toWorldTarget(result));
    }
  }

  private toWorldTarget(result: PickResult | null): WorldTarget | null {
    if (!result) return null;
    if (result.kind === 'vehicle') return { kind: 'vehicle', id: result.id };
    if (result.kind === 'building') {
      return {
        kind: 'building',
        townId: result.townId,
        x: Math.floor(result.point.x),
        y: Math.floor(result.point.z),
      };
    }
    return { kind: 'tile', x: result.x, y: result.y };
  }

  /** Picking programmatique (tests, menus contextuels). */
  pickAtNdc(ndc: { x: number; y: number }): WorldTarget | null {
    return this.toWorldTarget(this.picking.pickWithCamera(ndc, this.camera));
  }

  private handleClick(ndc: { x: number; y: number }): void {
    this.onSelect?.(this.pickAtNdc(ndc));
  }

  private handleDoubleClick(ndc: { x: number; y: number }): void {
    const result = this.picking.pickWithCamera(ndc, this.camera);
    if (!result) return;
    if (result.kind === 'vehicle') {
      this.focusVehicle(result.id);
      return;
    }
    this.controller.setFollowTarget(null);
    this.controller.focusOn(result.point.x, result.point.z, 24);
  }

  /** Sélection courante (halo) ; `null` efface le halo. */
  setSelection(target: WorldTarget | null): void {
    this.selectedVehicle = target?.kind === 'vehicle' ? target.id : null;
    this.vehicles.setSelected(this.selectedVehicle);
    // Le simple clic sélectionne ; le double-clic (ou `focusVehicle`) suit.
    if (target?.kind !== 'vehicle') this.controller.setFollowTarget(null);
  }

  /** Centre la caméra sur un véhicule et le suit. */
  focusVehicle(id: number): void {
    this.selectedVehicle = id;
    this.vehicles.setSelected(id);
    this.followVehicle(id);
    this.onNotice?.(`Suivi du véhicule #${id} (Échap pour revenir à la carte)`);
  }

  private followVehicle(id: number): void {
    this.controller.setFollowTarget(() => {
      const vehicle = this.renderVehicles.find((item) => item.id === id);
      return vehicle ? { x: vehicle.x, z: vehicle.y } : null;
    }, 18);
  }

  stopFollowing(): void {
    this.controller.setFollowTarget(null);
  }

  isFollowing(): boolean {
    return this.controller.isFollowing();
  }

  resetView(): void {
    this.stopFollowing();
    this.controller.reset();
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.applyQuality(level);
    if (this.currentMap) this.vegetation.build(this.currentMap, level);
  }

  private applyQuality(level: QualityLevel): void {
    this.terrain.setQuality(level);
    this.cityLayer.setShadows(level === 'high');
    this.vehicles.setShadows(level === 'high');
  }

  getCameraController(): CameraController {
    return this.controller;
  }

  getMap(): MapSnapshot | null {
    return this.currentMap;
  }

  getVehicleCount(): number {
    return this.renderVehicles.length;
  }

  getTreeCount(): number {
    return this.vegetation.count;
  }

  getBuildingCount(): number {
    return this.cityLayer.buildingCount;
  }

  getDrawCalls(): number {
    return this.vehicles.drawCallCount + this.cityLayer.drawCallCount + this.vegetation.drawCallCount;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  dispose(): void {
    this.controller.dispose();
    this.scene.remove(this.picking.group);
    this.picking.dispose();
    this.scene.remove(this.terrain.group);
    this.scene.remove(this.cityLayer.group);
    this.scene.remove(this.vegetation.group);
    this.scene.remove(this.vehicles.group);
    this.terrain.dispose();
    this.cityLayer.dispose();
    this.vegetation.dispose();
    this.vehicles.dispose();
    this.renderVehicles = [];
    this.currentMap = null;
  }
}
