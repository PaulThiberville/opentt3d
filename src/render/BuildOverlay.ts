/**
 * Fantôme de construction : surbrillance des tuiles ciblées, tracé, emprise
 * rectangulaire et marqueur d'orientation.
 *
 * Le plan vient de `buildRules` (module pur) : l'overlay ne valide rien, il
 * colore en vert un plan valide et en rouge un plan refusé. Les objets sont
 * alloués une fois (instances, lignes et marqueurs préalloués) : un changement
 * de tuile survolée ne recrée aucune géométrie.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import {
  MAX_BUILD_TILES,
  STATION_MAX_PLATFORMS,
  directionAxis,
  type BuildDirection,
  type BuildPlan,
} from '../game/buildRules';
import { sampleHeightWorld } from '../game/mapGrid';
import {
  ONEWAY_ARROW_HEAD,
  ONEWAY_ARROW_LENGTH,
  ONEWAY_ARROW_WIDTH,
  ROAD_LANE_OFFSET,
} from './TrackLayer';

const VALID_COLOUR = 0x6ee7a0;
const INVALID_COLOUR = 0xf07a72;
const TILE_LIFT = 0.09;
const LINE_LIFT = 0.22;
const OUTLINE_LIFT = 0.3;
/** Les flèches du fantôme reposent au-dessus de la surbrillance translucide. */
const ARROW_LIFT = TILE_LIFT + 0.05;

const DIRECTION_VECTORS: Record<BuildDirection, { x: number; z: number }> = {
  ne: { x: 1, z: -1 },
  se: { x: 1, z: 1 },
  sw: { x: -1, z: 1 },
  nw: { x: -1, z: -1 },
};

export class BuildOverlay {
  readonly group = new THREE.Group();

  private tiles: THREE.InstancedMesh;
  private tileMaterial: THREE.MeshBasicMaterial;
  private line: THREE.Line;
  private lineMaterial: THREE.LineBasicMaterial;
  private linePositions: Float32Array;
  private outline: THREE.LineLoop;
  private outlineMaterial: THREE.LineBasicMaterial;
  private outlinePositions: Float32Array;
  private platformLines: THREE.LineSegments;
  private platformMaterial: THREE.LineBasicMaterial;
  private platformPositions: Float32Array;
  private marker: THREE.Mesh;
  private markerMaterial: THREE.MeshBasicMaterial;
  private signalPole: THREE.Mesh;
  private signalLight: THREE.Mesh;
  private signalMaterial: THREE.MeshBasicMaterial;
  private oneWayArrows: THREE.InstancedMesh;
  private oneWayMaterial: THREE.MeshBasicMaterial;
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

    this.outlinePositions = new Float32Array(4 * 3);
    const outlineGeometry = new THREE.BufferGeometry();
    outlineGeometry.setAttribute('position', new THREE.BufferAttribute(this.outlinePositions, 3));
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: VALID_COLOUR,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    this.outline = new THREE.LineLoop(outlineGeometry, this.outlineMaterial);
    this.outline.frustumCulled = false;
    this.outline.renderOrder = 12;
    this.outline.visible = false;

    this.platformPositions = new Float32Array(STATION_MAX_PLATFORMS * 2 * 3);
    const platformGeometry = new THREE.BufferGeometry();
    platformGeometry.setAttribute('position', new THREE.BufferAttribute(this.platformPositions, 3));
    platformGeometry.setDrawRange(0, 0);
    this.platformMaterial = new THREE.LineBasicMaterial({
      color: VALID_COLOUR,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    this.platformLines = new THREE.LineSegments(platformGeometry, this.platformMaterial);
    this.platformLines.frustumCulled = false;
    this.platformLines.renderOrder = 12;

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

    const poleGeometry = new THREE.CylinderGeometry(0.035, 0.045, 0.62, 6);
    this.signalMaterial = new THREE.MeshBasicMaterial({
      color: VALID_COLOUR,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    this.signalPole = new THREE.Mesh(poleGeometry, this.signalMaterial);
    this.signalPole.visible = false;
    this.signalPole.renderOrder = 12;
    const lightGeometry = new THREE.SphereGeometry(0.1, 10, 8);
    this.signalLight = new THREE.Mesh(lightGeometry, this.signalMaterial);
    this.signalLight.visible = false;
    this.signalLight.renderOrder = 13;

    // Flèches blanches du fantôme de route à sens unique (#246) : même
    // proportions que les flèches peintes sur la chaussée, une par voie.
    this.oneWayMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.oneWayArrows = new THREE.InstancedMesh(
      createOneWayArrowGeometry(),
      this.oneWayMaterial,
      MAX_BUILD_TILES * 2,
    );
    this.oneWayArrows.name = 'build-oneway-arrows';
    this.oneWayArrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.oneWayArrows.count = 0;
    this.oneWayArrows.frustumCulled = false;
    this.oneWayArrows.renderOrder = 13;
    this.oneWayArrows.visible = false;

    this.group.add(
      this.tiles,
      this.line,
      this.outline,
      this.platformLines,
      this.marker,
      this.signalPole,
      this.signalLight,
      this.oneWayArrows,
    );
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
    this.outlineMaterial.color.setHex(colour);
    this.platformMaterial.color.setHex(colour);
    this.markerMaterial.color.setHex(colour);
    this.signalMaterial.color.setHex(colour);

    const count = Math.min(plan.tiles.length, MAX_BUILD_TILES);
    for (let i = 0; i < count; i += 1) {
      const tile = plan.tiles[i];
      if (!tile) continue;
      const ground = tile.elevation ?? sampleHeightWorld(map, tile.x + 0.5, tile.y + 0.5);
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
    const showPathLine =
      plan.tool === 'road' ||
      plan.tool === 'rail' ||
      plan.tool === 'clear' ||
      plan.tool === 'signal' ||
      plan.tool === 'canal' ||
      plan.tool === 'aqueduct' ||
      plan.tool === 'bridge' ||
      plan.tool === 'tunnel';
    geometry.setDrawRange(0, showPathLine ? count : 0);
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    geometry.computeBoundingSphere();

    const rect = rectOf(plan);
    this.updateOutline(plan, map, rect);
    this.updatePlatforms(plan, map, rect);
    this.updateMarker(plan, map, rect);
    this.updateSignal(plan, map);
    this.updateOneWayArrows(plan, map, count);
    this.group.visible = true;
  }

  /** Emprise rectangulaire pour une gare/un dépôt/un signal, sinon le tracé. */
  private updateOutline(
    plan: BuildPlan,
    map: MapSnapshot,
    rect: { left: number; top: number; right: number; bottom: number },
  ): void {
    if (
      plan.tool === 'road' ||
      plan.tool === 'rail' ||
      plan.tool === 'clear' ||
      plan.tool === 'canal' ||
      plan.tool === 'aqueduct' ||
      plan.tool === 'bridge' ||
      plan.tool === 'tunnel'
    ) {
      this.outline.visible = false;
      return;
    }
    const left = rect.left;
    const top = rect.top;
    const right = rect.right + 1;
    const bottom = rect.bottom + 1;
    const corners: [number, number][] = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
    for (let i = 0; i < corners.length; i += 1) {
      const corner = corners[i];
      if (!corner) continue;
      const [x, y] = corner;
      this.outlinePositions[i * 3] = x;
      this.outlinePositions[i * 3 + 1] = sampleHeightWorld(map, x, y) + OUTLINE_LIFT;
      this.outlinePositions[i * 3 + 2] = y;
    }
    const attribute = this.outline.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    this.outline.geometry.computeBoundingSphere();
    this.outline.visible = true;
  }

  /** Quais d'une gare ferroviaire : une ligne par quai, le long de la longueur. */
  private updatePlatforms(
    plan: BuildPlan,
    map: MapSnapshot,
    rect: { left: number; top: number; right: number; bottom: number },
  ): void {
    const station = plan.station;
    if (plan.tool !== 'station' || !station || station.kind !== 'rail') {
      this.platformLines.geometry.setDrawRange(0, 0);
      return;
    }
    const axis = directionAxis(station.direction);
    const platforms = axis === 'x' ? rect.bottom - rect.top + 1 : rect.right - rect.left + 1;
    let vertex = 0;
    for (let i = 0; i < Math.min(platforms, STATION_MAX_PLATFORMS); i += 1) {
      const from =
        axis === 'x'
          ? { x: rect.left + 0.5, y: rect.top + i + 0.5 }
          : { x: rect.left + i + 0.5, y: rect.top + 0.5 };
      const to =
        axis === 'x'
          ? { x: rect.right + 0.5, y: rect.top + i + 0.5 }
          : { x: rect.left + i + 0.5, y: rect.bottom + 0.5 };
      for (const point of [from, to]) {
        this.platformPositions[vertex * 3] = point.x;
        this.platformPositions[vertex * 3 + 1] =
          sampleHeightWorld(map, point.x, point.y) + OUTLINE_LIFT;
        this.platformPositions[vertex * 3 + 2] = point.y;
        vertex += 1;
      }
    }
    const geometry = this.platformLines.geometry;
    geometry.setDrawRange(0, vertex);
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  /** Flèche d'orientation au centre d'une gare/dépôt, ou du dernier tronçon. */
  private updateMarker(
    plan: BuildPlan,
    map: MapSnapshot,
    rect: { left: number; top: number; right: number; bottom: number },
  ): void {
    if (plan.tool === 'station' || plan.tool === 'depot') {
      const direction = plan.tool === 'station' ? plan.station?.direction : plan.depot?.direction;
      if (!direction) {
        this.marker.visible = false;
        return;
      }
      const vector = DIRECTION_VECTORS[direction];
      const cx = (rect.left + rect.right + 1) / 2 + vector.x * 0.6;
      const cz = (rect.top + rect.bottom + 1) / 2 + vector.z * 0.6;
      const ground = sampleHeightWorld(map, rect.left + 0.5, rect.top + 0.5);
      this.marker.position.set(cx, ground + 0.62, cz);
      this.direction.set(vector.x, 0, vector.z).normalize();
      this.marker.quaternion.setFromUnitVectors(this.up, this.direction);
      this.marker.visible = true;
      return;
    }
    if (plan.tool === 'signal') {
      this.marker.visible = false;
      return;
    }
    // Un fantôme à sens unique porte déjà ses flèches blanches sur la
    // chaussée : le cône d'orientation du dernier tronçon ferait doublon.
    if (plan.tool === 'road' && plan.road?.oneWay) {
      this.marker.visible = false;
      return;
    }
    const count = Math.min(plan.tiles.length, MAX_BUILD_TILES);
    const last = plan.tiles[count - 1];
    const previous = plan.tiles[count - 2];
    if (last && previous) {
      const ground = last.elevation ?? sampleHeightWorld(map, last.x + 0.5, last.y + 0.5);
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
  }

  private updateSignal(plan: BuildPlan, map: MapSnapshot): void {
    const tile = plan.tiles[0];
    if (plan.tool !== 'signal' || !tile) {
      this.signalPole.visible = false;
      this.signalLight.visible = false;
      return;
    }
    const ground = sampleHeightWorld(map, tile.x + 0.5, tile.y + 0.5);
    this.signalPole.position.set(tile.x + 0.5, ground + 0.37, tile.y + 0.5);
    this.signalLight.position.set(tile.x + 0.5, ground + 0.7, tile.y + 0.5);
    this.signalPole.visible = true;
    this.signalLight.visible = true;
  }

  /**
   * Flèches blanches du fantôme de route à sens unique (#246).
   *
   * Le sens vient de `plan.road.oneWay` (y compris une conversion d'un tronçon
   * déjà posé). Deux instances par tuile, une par voie, avec le même écart et
   * les mêmes proportions que le marquage définitif de `TrackLayer`.
   */
  private updateOneWayArrows(plan: BuildPlan, map: MapSnapshot, count: number): void {
    const oneWay = plan.tool === 'road' ? (plan.road?.oneWay ?? null) : null;
    if (!oneWay || count <= 0) {
      this.oneWayArrows.count = 0;
      this.oneWayArrows.visible = false;
      return;
    }
    const axis = plan.axis ?? (oneWay === 'east' || oneWay === 'west' ? 'x' : 'y');
    const positive = oneWay === 'east' || oneWay === 'south';
    const yaw = axis === 'x' ? (positive ? 0 : Math.PI) : positive ? -Math.PI / 2 : Math.PI / 2;
    let instance = 0;
    this.scale.set(1, 1, 1);
    for (let index = 0; index < count; index += 1) {
      const tile = plan.tiles[index];
      if (!tile) continue;
      const ground = tile.elevation ?? sampleHeightWorld(map, tile.x + 0.5, tile.y + 0.5);
      this.quaternion.setFromAxisAngle(this.up, yaw);
      for (const lane of [-ROAD_LANE_OFFSET, ROAD_LANE_OFFSET]) {
        this.position.set(
          tile.x + 0.5 + (axis === 'y' ? lane : 0),
          ground + ARROW_LIFT,
          tile.y + 0.5 + (axis === 'x' ? lane : 0),
        );
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.oneWayArrows.setMatrixAt(instance, this.matrix);
        instance += 1;
      }
    }
    this.oneWayArrows.count = instance;
    this.oneWayArrows.instanceMatrix.needsUpdate = true;
    this.oneWayArrows.computeBoundingSphere();
    this.oneWayArrows.visible = instance > 0;
  }

  clear(): void {
    this.tiles.count = 0;
    this.tiles.instanceMatrix.needsUpdate = true;
    this.line.geometry.setDrawRange(0, 0);
    this.outline.visible = false;
    this.platformLines.geometry.setDrawRange(0, 0);
    this.marker.visible = false;
    this.signalPole.visible = false;
    this.signalLight.visible = false;
    this.oneWayArrows.count = 0;
    this.oneWayArrows.visible = false;
    this.group.visible = false;
  }

  dispose(): void {
    this.group.remove(
      this.tiles,
      this.line,
      this.outline,
      this.platformLines,
      this.marker,
      this.signalPole,
      this.signalLight,
      this.oneWayArrows,
    );
    this.tiles.dispose();
    this.tiles.geometry.dispose();
    this.tileMaterial.dispose();
    this.line.geometry.dispose();
    this.lineMaterial.dispose();
    this.outline.geometry.dispose();
    this.outlineMaterial.dispose();
    this.platformLines.geometry.dispose();
    this.platformMaterial.dispose();
    this.marker.geometry.dispose();
    this.markerMaterial.dispose();
    this.signalPole.geometry.dispose();
    this.signalLight.geometry.dispose();
    this.signalMaterial.dispose();
    this.oneWayArrows.geometry.dispose();
    this.oneWayArrows.dispose();
    this.oneWayMaterial.dispose();
    this.group.clear();
  }
}

/**
 * Flèche plate orientée vers +X, centrée sur l'origine. Elle reprend les
 * dimensions exactes du marquage de `TrackLayer` : hampe fine et pointe large.
 */
function createOneWayArrowGeometry(): THREE.BufferGeometry {
  const half = ONEWAY_ARROW_LENGTH / 2;
  const halfWidth = ONEWAY_ARROW_WIDTH / 2;
  const head = ONEWAY_ARROW_HEAD;
  const tail = half - head;
  const vertices = new Float32Array([
    // Hampe
    -half,
    0,
    -halfWidth,
    half,
    0,
    -halfWidth,
    half,
    0,
    halfWidth,
    -half,
    0,
    -halfWidth,
    half,
    0,
    halfWidth,
    -half,
    0,
    halfWidth,
    // Pointe
    half,
    0,
    0,
    tail,
    0,
    -head,
    tail,
    0,
    head,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function rectOf(plan: BuildPlan): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  if (
    plan.tool === 'road' ||
    plan.tool === 'rail' ||
    plan.tool === 'clear' ||
    plan.tool === 'bridge' ||
    plan.tool === 'tunnel'
  ) {
    let left = plan.from.x;
    let top = plan.from.y;
    let right = plan.from.x;
    let bottom = plan.from.y;
    for (const tile of plan.tiles) {
      left = Math.min(left, tile.x);
      top = Math.min(top, tile.y);
      right = Math.max(right, tile.x);
      bottom = Math.max(bottom, tile.y);
    }
    return { left, top, right, bottom };
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const tile of plan.tiles) {
    left = Math.min(left, tile.x);
    top = Math.min(top, tile.y);
    right = Math.max(right, tile.x);
    bottom = Math.max(bottom, tile.y);
  }
  if (!Number.isFinite(left)) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left, top, right, bottom };
}
