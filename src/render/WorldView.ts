/**
 * Vue du monde : assemble terrain, eau, villes, végétation et véhicules.
 *
 * Cette classe est le seul endroit qui connaît à la fois Three.js et le
 * contrat `WorldSnapshot`. Elle ne décide de rien : `main.ts` lui pousse les
 * snapshots et l'état d'interpolation, et relaie les sélections vers `Game`.
 */

import type * as THREE from 'three';
import type { MapSnapshot, WorldSnapshot } from '../engine/protocol';
import { VehicleInterpolator, type RenderVehicle } from '../game/vehicleInterpolation';
import type { InterpolationState } from '../game/Game';
import type { BuildPlan, BuildPoint } from '../game/buildRules';
import { AtmosphereLayer } from './AtmosphereLayer';
import { BuildOverlay } from './BuildOverlay';
import { CameraController } from './CameraController';
import { CityLayer } from './CityLayer';
import { CatenaryLayer } from './CatenaryLayer';
import { DepotLayer } from './DepotLayer';
import { DisasterLayer } from './DisasterLayer';
import { IndustryLayer } from './IndustryLayer';
import { InfrastructureLayer } from './InfrastructureLayer';
import { Picking, type PickResult } from './Picking';
import { SignalLayer } from './SignalLayer';
import { StructureLayer } from './StructureLayer';
import { SurroundingsLayer } from './SurroundingsLayer';
import { TerrainLayer } from './TerrainLayer';
import { TownPropsLayer } from './TownPropsLayer';
import { TrackLayer } from './TrackLayer';
import { VegetationLayer } from './VegetationLayer';
import { VehicleLayer } from './VehicleLayer';
import { phaseFromEconomy, sunState } from './dayNight';
import {
  DEFAULT_DAY_NIGHT_CYCLE_SECONDS,
  DayNightCycle,
  ensureDaytimePhase,
} from './dayNightCycle';
import { qualitySettings, type QualityLevel } from './quality';

/** Surface minimale du renderer pour piloter le cycle jour/nuit. */
export interface TimeOfDaySink {
  setTimeOfDay(fraction: number, immediate?: boolean): void;
  readonly nightAmount: number;
}

export type WorldTarget =
  | { kind: 'vehicle'; id: number }
  | { kind: 'building'; townId: number; x: number; y: number }
  | { kind: 'tile'; x: number; y: number };

export interface WorldViewOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  quality: QualityLevel;
  /** Receveur du cycle jour/nuit (le `Renderer`). */
  timeOfDay?: TimeOfDaySink;
  /** Cycle visuel : activation et durée d'une journée complète. */
  dayNight?: { enabled: boolean; cycleSeconds: number };
  onSelect?: (target: WorldTarget | null) => void;
  onHover?: (target: WorldTarget | null) => void;
  onNotice?: (text: string) => void;
  /** Mode construction : survol, début de drag, déplacement, fin et annulation. */
  onBuildHover?: (tile: BuildPoint | null) => void;
  onBuildStart?: (tile: BuildPoint | null) => void;
  onBuildMove?: (tile: BuildPoint | null) => void;
  onBuildEnd?: (tile: BuildPoint | null) => void;
  onBuildCancel?: () => void;
  /** Force la réduction des animations (tests, réglage explicite). */
  reducedMotion?: boolean;
}

export class WorldView {
  readonly terrain = new TerrainLayer();
  readonly tracks = new TrackLayer();
  readonly cityLayer = new CityLayer();
  readonly townProps = new TownPropsLayer();
  readonly industries = new IndustryLayer();
  readonly vegetation = new VegetationLayer();
  readonly vehicles = new VehicleLayer();
  readonly signals = new SignalLayer();
  readonly catenary = new CatenaryLayer();
  readonly depots = new DepotLayer();
  readonly disasters = new DisasterLayer();
  readonly infrastructure = new InfrastructureLayer();
  readonly structures = new StructureLayer();
  readonly atmosphere = new AtmosphereLayer();
  readonly surroundings = new SurroundingsLayer();

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
  private timeOfDay?: TimeOfDaySink;
  private dayNight: DayNightCycle;
  private phaseInitialized = false;
  private night = 0;
  private onSelect?: (target: WorldTarget | null) => void;
  private onHover?: (target: WorldTarget | null) => void;
  private onNotice?: (text: string) => void;
  private onBuildHover?: (tile: BuildPoint | null) => void;
  private onBuildStart?: (tile: BuildPoint | null) => void;
  private onBuildMove?: (tile: BuildPoint | null) => void;
  private onBuildEnd?: (tile: BuildPoint | null) => void;
  private onBuildCancel?: () => void;
  private buildOverlay = new BuildOverlay();
  private buildMode = false;
  private lastHoverKey: string | null = null;
  private reducedMotion: boolean;

  constructor(options: WorldViewOptions) {
    this.scene = options.scene;
    this.canvas = options.canvas;
    this.camera = options.camera;
    this.quality = options.quality;
    this.timeOfDay = options.timeOfDay;
    this.dayNight = new DayNightCycle({
      enabled: options.dayNight?.enabled ?? true,
      cycleSeconds: options.dayNight?.cycleSeconds ?? DEFAULT_DAY_NIGHT_CYCLE_SECONDS,
    });
    this.onSelect = options.onSelect;
    this.onHover = options.onHover;
    this.onNotice = options.onNotice;
    this.onBuildHover = options.onBuildHover;
    this.onBuildStart = options.onBuildStart;
    this.onBuildMove = options.onBuildMove;
    this.onBuildEnd = options.onBuildEnd;
    this.onBuildCancel = options.onBuildCancel;
    this.reducedMotion =
      options.reducedMotion ??
      (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false);

    this.scene.add(this.terrain.group);
    this.scene.add(this.tracks.group);
    this.scene.add(this.cityLayer.group);
    this.scene.add(this.townProps.group);
    this.scene.add(this.industries.group);
    this.scene.add(this.vegetation.group);
    this.scene.add(this.vehicles.group);
    this.scene.add(this.signals.group);
    this.scene.add(this.catenary.group);
    this.scene.add(this.depots.group);
    this.scene.add(this.disasters.group);
    this.scene.add(this.infrastructure.group);
    this.scene.add(this.structures.group);
    this.scene.add(this.atmosphere.group);
    this.scene.add(this.surroundings.group);
    this.scene.add(this.buildOverlay.group);

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
    this.applyReducedMotion(this.reducedMotion);
  }

  /** Applique un snapshot (carte en delta, entités complètes). */
  applySnapshot(snapshot: WorldSnapshot): void {
    const map = snapshot.map;
    if (map) {
      const first = !this.mapApplied;
      if (first) {
        this.terrain.setMap(map);
        this.tracks.setMap(map, snapshot.stations);
        this.infrastructure.setMap(map);
      } else {
        this.terrain.applyDelta(map);
        this.tracks.applyDelta(map, snapshot.stations);
        this.infrastructure.applyDelta(map);
      }
      this.currentMap = map;
      this.cityLayer.build(snapshot.towns, map);
      this.townProps.build(snapshot.towns, map, this.quality);
      this.industries.build(snapshot.industries, map, this.quality);
      this.vegetation.build(map, this.quality);
      this.signals.setMap(map);
      this.catenary.setMap(map);
      this.surroundings.build(map, this.quality);
      this.structures.setStructures(snapshot.structures ?? [], map);
      this.mapApplied = true;
      if (first) {
        this.controller.setBounds({ minX: 0, maxX: map.width, minZ: 0, maxZ: map.height });
        this.controller.reset();
      }
    }
    // Les dépôts sont complets à chaque snapshot ; la carte ne sert qu'à la
    // hauteur du sol (la dernière carte connue est conservée).
    this.signals.setSignals(snapshot.signals, this.currentMap);
    this.depots.setDepots(snapshot.depots, this.currentMap);
    this.disasters.setDisasters(snapshot.disasters, this.currentMap);
    this.cityLayer.setStations(snapshot.stations, this.currentMap);
    this.atmosphere.applyWorld(this.currentMap, snapshot.towns, snapshot.stations);
    // L'heure visuelle ne suit le calendrier moteur qu'une fois : ensuite elle
    // avance au temps réel, indépendamment de la vitesse de jeu.
    if (!this.phaseInitialized) {
      this.phaseInitialized = true;
      this.dayNight.setPhase(ensureDaytimePhase(phaseFromEconomy(snapshot.economy)));
      this.applyDayNightPhase(true);
      this.applyNight(this.night);
    }
    this.signals.update(snapshot.meta.tick);
  }

  /** Diffuse le facteur nuit aux couches qui ont un rendu nocturne. */
  private applyNight(amount: number): void {
    this.terrain.setNight(amount);
    this.tracks.setNight(amount);
    this.catenary.setNight(amount);
    this.vehicles.setNight(amount);
    this.cityLayer.setNight(amount);
    this.townProps.setNight(amount);
    this.industries.setNight(amount);
    this.depots.setNight(amount);
    this.infrastructure.setNight(amount);
    this.atmosphere.setNight(amount);
    this.surroundings.setNight(amount);
  }

  /** Phase visuelle courante (0 = minuit, 0,5 = midi). */
  get dayNightPhase(): number {
    return this.dayNight.phase;
  }

  /** 0 = jour, 1 = nuit profonde, selon l'heure visuelle. */
  get dayNightAmount(): number {
    return sunState(this.dayNight.phase).night;
  }

  /** Force l'heure visuelle (démo de menu, captures) sans attendre un snapshot. */
  setDayNightPhase(phase: number): void {
    this.dayNight.setPhase(phase);
    this.applyDayNightPhase(true);
    this.applyNight(this.timeOfDay?.nightAmount ?? this.night);
  }

  /** Applique immédiatement l'activation et la durée du cycle visuel. */
  setDayNightCycle(enabled: boolean, cycleSeconds: number): void {
    this.dayNight.setCycleSeconds(cycleSeconds);
    this.dayNight.setEnabled(enabled);
    this.applyDayNightPhase(true);
    this.applyNight(this.timeOfDay?.nightAmount ?? this.night);
  }

  /** Fige l'heure avec le jeu (pause, menu). */
  setDayNightPaused(paused: boolean): void {
    this.dayNight.setPaused(paused);
  }

  private applyDayNightPhase(immediate = false): void {
    const phase = this.dayNight.phase;
    this.night = sunState(phase).night;
    this.timeOfDay?.setTimeOfDay(phase, immediate);
  }

  /** Frame : interpolation, entités, caméra, picking au survol. */
  update(deltaSeconds: number, interpolation: InterpolationState): void {
    const from = interpolation.from?.vehicles ?? [];
    const to = interpolation.to?.vehicles ?? [];
    this.interpolator.interpolate(from, to, interpolation.alpha, this.renderVehicles);
    this.vehicles.update(this.renderVehicles, this.currentMap);
    this.vehicles.updateAnimation(deltaSeconds);
    this.vehicles.setSelected(this.selectedVehicle);

    this.controller.update(deltaSeconds);
    this.terrain.update(deltaSeconds);
    this.tracks.update(this.camera.position);
    this.structures.update(this.camera.position);
    this.vegetation.update(deltaSeconds, this.camera.position);
    this.cityLayer.update(this.camera.position);
    this.townProps.update(this.camera.position);
    this.industries.update(deltaSeconds, this.camera.position);
    this.disasters.update(deltaSeconds);
    this.atmosphere.update(deltaSeconds, this.camera.position, this.dayNight.phase);
    this.surroundings.update(deltaSeconds);
    this.dayNight.advance(deltaSeconds);
    this.applyDayNightPhase();
    this.applyNight(this.timeOfDay?.nightAmount ?? this.night);
    if (this.buildMode) this.updateBuildHover();
    else this.updateHover();
  }

  /**
   * Active le mode construction : le clic gauche appartient à l'outil et le
   * survol alimente l'aperçu. Le picking véhicule/bâtiment est suspendu pour
   * que les entités ne détournent pas la tuile visée.
   */
  setBuildMode(enabled: boolean): void {
    if (this.buildMode === enabled) return;
    this.buildMode = enabled;
    this.buildOverlay.clear();
    if (!enabled) this.atmosphere.setConstructionSite(null);
    this.picking.clearHover();
    this.lastHoverKey = null;
    if (enabled) {
      this.controller.setPlacement({
        begin: (ndc) => this.onBuildStart?.(this.pickTileAtNdc(ndc)),
        move: (ndc) => this.onBuildMove?.(this.pickTileAtNdc(ndc)),
        end: (ndc) => this.onBuildEnd?.(this.pickTileAtNdc(ndc)),
        cancel: () => this.onBuildCancel?.(),
      });
      this.onBuildHover?.(null);
    } else {
      this.controller.setPlacement(null);
    }
  }

  isBuildMode(): boolean {
    return this.buildMode;
  }

  /** Affiche le fantôme du plan courant (ou le masque avec `null`). */
  setBuildPlan(plan: BuildPlan | null): void {
    this.buildOverlay.setPlan(plan, this.currentMap);
    // Poussière de chantier : bouffée discrète bornée aux tuiles du plan.
    if (plan && plan.valid) {
      this.atmosphere.setConstructionSite({
        x: (plan.from.x + plan.to.x) / 2 + 0.5,
        z: (plan.from.y + plan.to.y) / 2 + 0.5,
        tiles: plan.tiles,
      });
    } else {
      this.atmosphere.setConstructionSite(null);
    }
  }

  /** Tuile de terrain sous un point NDC (ignore véhicules et bâtiments). */
  pickTileAtNdc(ndc: { x: number; y: number }): BuildPoint | null {
    const hit = this.picking.pickTileWithCamera(ndc, this.camera);
    return hit ? { x: hit.x, y: hit.y } : null;
  }

  private updateBuildHover(): void {
    const ndc = this.controller.takeHover();
    this.picking.clearHover();
    if (ndc) this.onBuildHover?.(this.pickTileAtNdc(ndc));
    else if (!this.controller.isPointerInside()) this.onBuildHover?.(null);
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
          ? `b${result.townId}:${result.x},${result.y}`
          : result.kind === 'station'
            ? `s${result.stationId}:${result.x},${result.y}`
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
        x: result.x,
        y: result.y,
      };
    }
    // Une gare est résolue par sa tuile : `gameSession` retrouve l'id de la
    // gare depuis le snapshot, comme pour un clic sur le terrain.
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
    this.industries.setQuality(level);
  }

  /** Active/coupe toutes les particules animées (accessibilité). */
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    this.applyReducedMotion(enabled);
  }

  private applyReducedMotion(enabled: boolean): void {
    this.atmosphere.setReducedMotion(enabled);
    this.vegetation.setReducedMotion(enabled);
    this.industries.setReducedMotion(enabled);
    this.vehicles.setReducedMotion(enabled);
  }

  private applyQuality(level: QualityLevel): void {
    this.terrain.setQuality(level);
    this.tracks.setQuality(level);
    this.structures.setQuality(level);
    this.structures.setShadows(level === 'high');
    this.cityLayer.setQuality(level);
    this.cityLayer.setShadows(level === 'high');
    this.cityLayer.setNightLights(qualitySettings(level).nightWindows);
    this.townProps.setQuality(level);
    this.townProps.setShadows(level === 'high');
    this.townProps.setNightLights(qualitySettings(level).nightWindows);
    this.vehicles.setShadows(level === 'high');
    this.vehicles.setQuality(level);
    this.industries.setShadows(level === 'high');
    this.atmosphere.setQuality(level);
    this.surroundings.setQuality(level);
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

  getStationCount(): number {
    return this.cityLayer.stationCountValue;
  }

  getIndustryCount(): number {
    return this.industries.industryCount;
  }

  getIndustryPartCount(): number {
    return this.industries.partCount;
  }

  getIndustryDrawCalls(): number {
    return this.industries.drawCallCount;
  }

  getSignalCount(): number {
    return this.signals.count;
  }

  getDepotCount(): number {
    return this.depots.count;
  }

  getInfrastructureCounts(): { locks: number; aqueducts: number; crossings: number } {
    return {
      locks: this.infrastructure.lockCount,
      aqueducts: this.infrastructure.aqueductCount,
      crossings: this.infrastructure.crossingCount,
    };
  }

  getStructureCount(): number {
    return this.structures.count;
  }

  getTrackChunkCount(): number {
    return this.tracks.chunkCount;
  }

  getTrackTriangleCount(): number {
    return this.tracks.triangleCount;
  }

  getDrawCalls(): number {
    return (
      this.vehicles.drawCallCount +
      this.cityLayer.drawCallCount +
      this.townProps.drawCallCount +
      this.vegetation.drawCallCount +
      this.industries.drawCallCount +
      this.depots.drawCallCount +
      this.tracks.drawCallCount +
      this.structures.drawCallCount +
      this.atmosphere.drawCallCount +
      this.surroundings.drawCallCount +
      this.vehicles.accessoryDrawCalls
    );
  }

  /** Triangles ajoutés par le décor hors carte (diagnostic). */
  getSurroundingsTriangleCount(): number {
    return this.surroundings.triangleCount;
  }

  getSurroundingsDrawCalls(): number {
    return this.surroundings.drawCallCount;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  dispose(): void {
    this.controller.dispose();
    this.scene.remove(this.picking.group);
    this.picking.dispose();
    this.scene.remove(this.terrain.group);
    this.scene.remove(this.tracks.group);
    this.scene.remove(this.cityLayer.group);
    this.scene.remove(this.townProps.group);
    this.scene.remove(this.industries.group);
    this.scene.remove(this.vegetation.group);
    this.scene.remove(this.vehicles.group);
    this.scene.remove(this.signals.group);
    this.scene.remove(this.depots.group);
    this.scene.remove(this.disasters.group);
    this.scene.remove(this.infrastructure.group);
    this.scene.remove(this.structures.group);
    this.scene.remove(this.atmosphere.group);
    this.scene.remove(this.surroundings.group);
    this.scene.remove(this.buildOverlay.group);
    this.terrain.dispose();
    this.tracks.dispose();
    this.cityLayer.dispose();
    this.townProps.dispose();
    this.industries.dispose();
    this.vegetation.dispose();
    this.vehicles.dispose();
    this.signals.dispose();
    this.catenary.dispose();
    this.depots.dispose();
    this.disasters.dispose();
    this.infrastructure.dispose();
    this.structures.dispose();
    this.atmosphere.dispose();
    this.surroundings.dispose();
    this.buildOverlay.dispose();
    this.renderVehicles = [];
    this.currentMap = null;
  }
}
