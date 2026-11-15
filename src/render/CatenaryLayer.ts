/**
 * Caténaires 3D des voies électrifiées (#157).
 *
 * Poteaux et câbles sont reconstruits depuis `MapSnapshot.railTypes` (ou le
 * drapeau `TILE_FLAG.ELECTRIFIED` du pont). Deux `InstancedMesh` suffisent :
 * un pour les poteaux, un pour les câbles. Le tracé suit les connexions
 * inférées par `trackPlan`, donc les courbes reçoivent un câble par branche.
 *
 * Aucun asset : tout est déterministe et proportionnel à la carte.
 */

import * as THREE from 'three';
import { TILE_FLAG, type MapSnapshot } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { hasCatenary, railTypeFromIndex } from '../game/railRules';
import { TRACK_CONNECT, buildTrackMasks, connectionsAt } from './trackPlan';

const MAX_POSTS = 8192;
const MAX_WIRES = 16384;
const POST_HEIGHT = 0.86;
const POST_OFFSET = 0.3;
const WIRE_HEIGHT = 0.9;
const WIRE_THICKNESS = 0.018;

interface Wire {
  x: number;
  z: number;
  length: number;
  angle: number;
  y: number;
}

export class CatenaryLayer {
  readonly group = new THREE.Group();

  private posts: THREE.InstancedMesh;
  private wires: THREE.InstancedMesh;
  private postMaterial: THREE.MeshLambertMaterial;
  private wireMaterial: THREE.MeshLambertMaterial;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private axisY = new THREE.Vector3(0, 1, 0);
  private postCount = 0;
  private wireCount = 0;

  constructor() {
    this.group.name = 'catenary';
    this.postMaterial = new THREE.MeshLambertMaterial({ color: 0x5f6469 });
    const postGeometry = new THREE.BoxGeometry(0.055, POST_HEIGHT, 0.055);
    this.posts = new THREE.InstancedMesh(postGeometry, this.postMaterial, MAX_POSTS);
    this.posts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.posts.count = 0;
    this.posts.frustumCulled = false;

    this.wireMaterial = new THREE.MeshLambertMaterial({ color: 0x2e3236 });
    const wireGeometry = new THREE.BoxGeometry(1, WIRE_THICKNESS, WIRE_THICKNESS);
    this.wires = new THREE.InstancedMesh(wireGeometry, this.wireMaterial, MAX_WIRES);
    this.wires.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wires.count = 0;
    this.wires.frustumCulled = false;

    this.group.add(this.posts, this.wires);
    this.group.visible = false;
  }

  /** Reconstruit les caténaires depuis la carte. */
  setMap(map: MapSnapshot): void {
    const masks = buildTrackMasks(map);
    this.postCount = 0;
    this.wireCount = 0;
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const index = y * map.width + x;
        if ((masks.rail[index] ?? 0) === 0) continue;
        const flags = map.flags[index] ?? 0;
        const type = railTypeFromIndex(map.railTypes?.[index] ?? 0);
        const electrified = map.railTypes
          ? hasCatenary(type)
          : (flags & TILE_FLAG.ELECTRIFIED) !== 0;
        if (!electrified) continue;
        const connections = connectionsAt(masks.rail, map.width, map.height, x, y);
        this.emitTile(map, x, y, connections);
        if (this.postCount >= MAX_POSTS) break;
      }
      if (this.postCount >= MAX_POSTS) break;
    }

    this.posts.count = this.postCount;
    this.wires.count = this.wireCount;
    this.posts.instanceMatrix.needsUpdate = true;
    this.wires.instanceMatrix.needsUpdate = true;
    this.posts.computeBoundingSphere();
    this.wires.computeBoundingSphere();
    this.group.visible = this.postCount > 0;
  }

  private emitTile(map: MapSnapshot, x: number, y: number, connections: number): void {
    const cx = x + 0.5;
    const cz = y + 0.5;
    const ground = sampleHeightWorld(map, cx, cz);
    const alongX = (connections & (TRACK_CONNECT.east | TRACK_CONNECT.west)) !== 0;
    const alongZ = (connections & (TRACK_CONNECT.north | TRACK_CONNECT.south)) !== 0;
    const isStraightX = alongX && !alongZ;
    const isStraightZ = alongZ && !alongX;

    // Poteaux : deux de part et d'autre d'une voie droite, un seul sur une
    // courbe ou un about pour rester lisible en 3D.
    if (isStraightX) {
      this.pushPost(cx, cz - POST_OFFSET, ground);
      this.pushPost(cx, cz + POST_OFFSET, ground);
    } else if (isStraightZ) {
      this.pushPost(cx - POST_OFFSET, cz, ground);
      this.pushPost(cx + POST_OFFSET, cz, ground);
    } else {
      this.pushPost(cx - POST_OFFSET * 0.7, cz - POST_OFFSET * 0.7, ground);
      if ((connections & TRACK_CONNECT.east) !== 0 || (connections & TRACK_CONNECT.south) !== 0) {
        this.pushPost(cx + POST_OFFSET * 0.7, cz + POST_OFFSET * 0.7, ground);
      }
    }

    // Câbles : un segment du centre vers chaque connexion.
    for (const [bit, dx, dz] of [
      [TRACK_CONNECT.north, 0, -0.5],
      [TRACK_CONNECT.east, 0.5, 0],
      [TRACK_CONNECT.south, 0, 0.5],
      [TRACK_CONNECT.west, -0.5, 0],
    ] as const) {
      if ((connections & bit) === 0) continue;
      const midX = cx + dx / 2;
      const midZ = cz + dz / 2;
      this.pushWire({
        x: midX,
        z: midZ,
        length: 0.5,
        angle: Math.atan2(-dz, dx),
        y: ground + WIRE_HEIGHT,
      });
    }
  }

  private pushPost(x: number, z: number, ground: number): void {
    if (this.postCount >= MAX_POSTS) return;
    this.position.set(x, ground + POST_HEIGHT / 2, z);
    this.matrix.compose(this.position, this.quaternion.identity(), this.scale.set(1, 1, 1));
    this.posts.setMatrixAt(this.postCount, this.matrix);
    this.postCount += 1;
  }

  private pushWire(wire: Wire): void {
    if (this.wireCount >= MAX_WIRES) return;
    this.position.set(wire.x, wire.y, wire.z);
    this.quaternion.setFromAxisAngle(this.axisY, wire.angle);
    this.scale.set(wire.length, 1, 1);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.wires.setMatrixAt(this.wireCount, this.matrix);
    this.wireCount += 1;
  }

  /** Assombrit poteaux et câbles la nuit sans changer leur géométrie. */
  setNight(amount: number): void {
    const night = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.postMaterial.color.setRGB(0.37 - night * 0.33, 0.39 - night * 0.35, 0.41 - night * 0.36);
    this.wireMaterial.color.setRGB(0.18 - night * 0.16, 0.2 - night * 0.18, 0.21 - night * 0.19);
  }

  get countPosts(): number {
    return this.postCount;
  }

  get countWires(): number {
    return this.wireCount;
  }

  get drawCallCount(): number {
    return this.group.visible ? 2 : 0;
  }

  clear(): void {
    this.postCount = 0;
    this.wireCount = 0;
    this.posts.count = 0;
    this.wires.count = 0;
    this.group.visible = false;
  }

  dispose(): void {
    this.group.remove(this.posts, this.wires);
    this.posts.dispose();
    this.posts.geometry.dispose();
    this.postMaterial.dispose();
    this.wires.dispose();
    this.wires.geometry.dispose();
    this.wireMaterial.dispose();
    this.clear();
    this.group.clear();
  }
}
