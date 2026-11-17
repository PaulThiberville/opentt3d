/**
 * Rendu des villes, gares et dépôts de ville.
 *
 * Les bâtiments ne sont plus des boîtes uniformes : chaque tuile `house` reçoit
 * un archétype (maison, mitoyenne, immeuble, commerce, bureaux, église,
 * entrepôt, édifice public) construit par `models/buildings.ts`. Les géométries
 * sont fusionnées par archétype et variante, puis posées par `InstancedMesh` :
 * le nombre de draw calls dépend des archétypes (16 au plus), pas du nombre de
 * bâtiments. La palette de chaque quartier module la teinte d'instance sans
 * créer de géométrie supplémentaire.
 *
 * LOD : les villes proches gardent la silhouette détaillée (fenêtres, portes,
 * cheminées, auvents) ; au-delà d'un seuil lié à la qualité, leurs bâtiments
 * basculent dans un unique lot simplifié. Le basculement n'a lieu qu'au
 * franchissement du seuil, jamais à chaque frame.
 *
 * Les fenêtres sont des quads fusionnés marqués par `aWindow` : un seul shader
 * les allume la nuit, sans mesh ni matériau supplémentaire.
 */

import * as THREE from 'three';
import type { CompanyId, MapSnapshot, StationSnapshot, TownSnapshot } from '../engine/protocol';
import { COMPANY_NONE, TILE_KIND_INDEX } from '../engine/protocol';
import { cornerHeightWorld, sampleHeightWorld, tileKindFromIndex } from '../game/mapGrid';
import { CONNECT_EAST, CONNECT_NORTH, CONNECT_SOUTH, CONNECT_WEST } from '../game/buildRules';
import { Prng, hashUnit2d } from '../game/prng';
import { companyColour, hexToRgb } from './tileVisuals';
import { qualitySettings, type QualityLevel } from './quality';
import { createModelMaterial } from './models/materials';
import { SIDEWALK_LIFT } from './TrackLayer';
import {
  buildingVariantCount,
  chooseBuildingArchetype,
  createBuildingGeometry,
  createBusStopGeometry,
  createDistantBuildingGeometry,
  createStationBaseGeometry,
  createStationHallGeometry,
  createStationPlatformGeometry,
  type BuildingArchetype,
  type BuildingDetail,
} from './models/buildings';

const MAX_RADIUS = 10;
const MAX_STATION_TILES = 2048;
const LOD_HYSTERESIS_RATIO = 1.18;
/** Centre de la bande de trottoir dans l'espace local de l'abri (#245). */
const STOP_CURB_OFFSET = 0.44;

/** Cible de picking résolue depuis une instance de la couche ville. */
export type CityPickInfo =
  | { kind: 'building'; townId: number; x: number; y: number }
  | { kind: 'station'; stationId: number; x: number; y: number };

export interface CityPickTarget {
  mesh: THREE.InstancedMesh;
  /** Bâtiment (ville) ou gare, avec la tuile réelle de l'instance. */
  infoForInstance(instanceId: number): CityPickInfo | null;
}

interface Placement {
  townId: number;
  archetype: BuildingArchetype;
  variant: number;
  x: number;
  z: number;
  /** Tuile logique de l'instance (jamais déduite du point d'impact). */
  tileX: number;
  tileY: number;
  ground: number;
  yaw: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  tint: number;
  /** Dérive chaude/froide de la teinte, pour casser l'uniformité. */
  warmth: number;
  /** Palette du quartier (facteurs RGB appliqués à la teinte d'instance). */
  districtR: number;
  districtG: number;
  districtB: number;
  /** Vide à combler sous le bâtiment quand la tuile est en pente. */
  plinthHeight: number;
  plinthWidth: number;
  plinthDepth: number;
}

interface TownState {
  townId: number;
  centreX: number;
  centreZ: number;
  placements: Placement[];
  near: boolean;
}

interface StationPlacement {
  stationId: number;
  x: number;
  z: number;
  tileX: number;
  tileY: number;
  ground: number;
  yaw: number;
  width: number;
  height: number;
  colour: number;
  /** Hauteur de la terrasse locale (socle de gare uniquement). */
  scaleY?: number;
}

export class CityLayer {
  readonly group = new THREE.Group();

  private material: THREE.MeshStandardMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private nightLights = true;
  private towns = new Map<number, TownState>();
  private buckets: THREE.InstancedMesh[] = [];
  private bucketByKey = new Map<string, THREE.InstancedMesh>();
  private farBucket: THREE.InstancedMesh | null = null;
  private allDirty = true;
  private bucketSignatures = new Map<THREE.InstancedMesh, number>();
  private bucketTownIds = new Map<THREE.InstancedMesh, number[]>();
  private bucketTiles = new Map<THREE.InstancedMesh, { x: number; y: number }[]>();
  private stationPickInfo = new Map<
    THREE.InstancedMesh,
    { stationId: number; x: number; y: number }[]
  >();
  private geometryCache = new Map<string, THREE.BufferGeometry>();
  private distantGeometry: THREE.BufferGeometry | null = null;
  private hallGeometry: THREE.BufferGeometry | null = null;
  private platformGeometry: THREE.BufferGeometry | null = null;
  private stopGeometry: THREE.BufferGeometry | null = null;
  private stationHalls: THREE.InstancedMesh | null = null;
  private stationPlatforms: THREE.InstancedMesh | null = null;
  private stationStops: THREE.InstancedMesh | null = null;
  private stationBases: THREE.InstancedMesh | null = null;
  private stationBaseGeometry: THREE.BufferGeometry;
  private stationBaseMaterial: THREE.MeshLambertMaterial;
  private plinths: THREE.InstancedMesh | null = null;
  private plinthGeometry: THREE.BufferGeometry;
  private plinthMaterial: THREE.MeshLambertMaterial;
  private stationCount = 0;
  private plinthCountValue = 0;
  private stationBaseCountValue = 0;
  private stationSignature = 0;
  private stationStations: readonly StationSnapshot[] = [];
  private map: MapSnapshot | null = null;
  private detail: BuildingDetail = 1;
  private quality: QualityLevel = 'medium';
  private nearDistance = 80;
  private farDistance = 95;
  private shadows = false;
  private signature = 0;
  private townSnapshots: readonly TownSnapshot[] = [];
  /** Nombre de reconstructions réelles des villes (diagnostic/tests). */
  builds = 0;
  /** Nombre de bascules near/far (diagnostic/tests). */
  lodSwitches = 0;
  /** Nombre de lots réinstanciés lors du dernier `applyBuckets` (diagnostic/tests). */
  bucketRebuilds = 0;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private colour = new THREE.Color();
  private rgb = { r: 0, g: 0, b: 0 };
  private yawAxis = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'cities';
    this.material = createModelMaterial({
      night: this.nightUniform,
      glowStrength: 1.35,
      nightAmbient: 0.025,
      roughness: 0.78,
      metalness: 0.03,
      name: 'cities-surface',
    });
    this.plinthGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.plinthGeometry.translate(0, 0.5, 0);
    this.plinthMaterial = new THREE.MeshLambertMaterial({ color: 0x6b6355 });
    this.stationBaseGeometry = createStationBaseGeometry();
    this.stationBaseMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.applyQuality('medium');
  }

  /** Reconstruit les bâtiments de toutes les villes. */
  build(towns: readonly TownSnapshot[], map: MapSnapshot): void {
    this.map = map;
    this.townSnapshots = towns;
    const signature = computeCitySignature(towns, map, this.detail);
    if (this.builds > 0 && signature === this.signature) return;
    this.signature = signature;
    this.builds += 1;
    this.clear();
    const placementsByTown = new Map<number, Placement[]>();

    for (const town of towns) {
      const placements: Placement[] = [];
      const rng = new Prng((town.id + 1) * 7919 + map.width * 31 + map.height);
      const centerX = Math.floor(town.x);
      const centerY = Math.floor(town.y);
      let hasChurch = false;

      for (let dy = -MAX_RADIUS; dy <= MAX_RADIUS; dy += 1) {
        for (let dx = -MAX_RADIUS; dx <= MAX_RADIUS; dx += 1) {
          const x = centerX + dx;
          const y = centerY + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          const index = y * map.width + x;
          if (tileKindFromIndex(map.kind[index] ?? 0) !== 'house') continue;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > MAX_RADIUS) continue;

          const centrality = Math.max(0, 1 - distance / MAX_RADIUS);
          const archetype = chooseBuildingArchetype({
            seed: town.id * 131 + 7,
            x,
            y,
            centrality,
            hasChurch,
          });
          if (archetype === 'church') hasChurch = true;
          const variantCount = buildingVariantCount(archetype);
          const variant = Math.min(
            variantCount - 1,
            Math.floor(hashUnit2d(town.id * 17 + 3, x + 13, y + 7) * variantCount),
          );
          const district = districtPalette(town.id, centerX, centerY, x, y);
          const worldX = x + 0.5;
          const worldZ = y + 0.5;
          placements.push({
            townId: town.id,
            archetype,
            variant,
            x: worldX,
            z: worldZ,
            tileX: x,
            tileY: y,
            ground: sampleHeightWorld(map, worldX, worldZ),
            yaw: (rng.int(0, 3) * Math.PI) / 2,
            scaleX: rng.float(0.92, 1),
            scaleY: rng.float(0.9, 1.1),
            scaleZ: rng.float(0.92, 1),
            tint: rng.float(0.9, 1.05),
            warmth: rng.float(-0.018, 0.018),
            districtR: district[0],
            districtG: district[1],
            districtB: district[2],
            plinthHeight: 0,
            plinthWidth: 0.7,
            plinthDepth: 0.7,
          });
          const placement = placements[placements.length - 1];
          if (placement) this.describePlinth(placement, map, x, y);
        }
      }

      // Une église par ville dès qu'elle est assez grande : point de repère.
      if (!hasChurch && placements.length >= 24) {
        let landmark: Placement | null = null;
        let bestDistance = Infinity;
        for (const placement of placements) {
          const distance =
            (placement.x - town.x) * (placement.x - town.x) +
            (placement.z - town.y) * (placement.z - town.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            landmark = placement;
          }
        }
        if (landmark) {
          landmark.archetype = 'church';
          landmark.variant = 0;
        }
      }

      if (placements.length === 0) continue;
      placementsByTown.set(town.id, placements);
      this.towns.set(town.id, {
        townId: town.id,
        centreX: town.x,
        centreZ: town.y,
        placements,
        near: true,
      });
    }

    // Premier passage : tout en détail, la caméra affine au premier update.
    this.buildPlinths();
    this.applyBuckets();
  }

  /** Calcule la plinthe locale d'une tuile en pente (jamais une dalle de ville). */
  private describePlinth(placement: Placement, map: MapSnapshot, x: number, y: number): void {
    const minCorner = Math.min(
      cornerHeightWorld(map, x, y),
      cornerHeightWorld(map, x + 1, y),
      cornerHeightWorld(map, x, y + 1),
      cornerHeightWorld(map, x + 1, y + 1),
    );
    const gap = placement.ground - minCorner;
    if (gap <= 0.02) return;
    const geometry = this.geometryFor(placement.archetype, placement.variant, this.detail);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const width = box ? box.max.x - box.min.x : 0.72;
    const depth = box ? box.max.z - box.min.z : 0.72;
    placement.plinthHeight = gap + 0.025;
    placement.plinthWidth = Math.min(0.9, width * placement.scaleX * 0.94);
    placement.plinthDepth = Math.min(0.9, depth * placement.scaleZ * 0.94);
  }

  /** Une seule instance de plinthe par bâtiment en pente, jamais un aplat global. */
  private buildPlinths(): void {
    this.clearPlinths();
    const placements: Placement[] = [];
    for (const town of this.towns.values()) {
      for (const placement of town.placements) {
        if (placement.plinthHeight > 0.02) placements.push(placement);
      }
    }
    if (placements.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      this.plinthGeometry,
      this.plinthMaterial,
      placements.length,
    );
    mesh.name = 'city-plinths';
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      if (!placement) continue;
      this.position.set(
        placement.x,
        placement.ground - placement.plinthHeight + 0.025,
        placement.z,
      );
      this.quaternion.setFromAxisAngle(this.yawAxis, placement.yaw);
      this.scale.set(placement.plinthWidth, placement.plinthHeight, placement.plinthDepth);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(index, this.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.plinths = mesh;
    this.plinthCountValue = placements.length;
  }

  private clearPlinths(): void {
    if (!this.plinths) return;
    this.group.remove(this.plinths);
    this.plinths.dispose();
    this.plinths = null;
    this.plinthCountValue = 0;
  }

  /** Change le niveau de détail des bâtiments (qualité graphique). */
  setQuality(level: QualityLevel): void {
    this.applyQuality(level);
    // La signature dépend du détail : sans cette mise à jour, le prochain
    // snapshot déclencherait une reconstruction complète inutile des villes.
    if (this.map) {
      this.signature = computeCitySignature(this.townSnapshots, this.map, this.detail);
    }
    if (this.towns.size > 0) {
      this.allDirty = true;
      this.applyBuckets();
    }
    if (this.stationStations.length > 0) {
      this.hallGeometry?.dispose();
      this.hallGeometry = null;
      this.platformGeometry?.dispose();
      this.platformGeometry = null;
      this.stopGeometry?.dispose();
      this.stopGeometry = null;
      this.stationSignature = 0;
      this.setStations(this.stationStations, this.map);
    }
  }

  private applyQuality(level: QualityLevel): void {
    this.quality = level;
    this.detail = level === 'high' ? 2 : level === 'medium' ? 1 : 0;
    this.nearDistance = level === 'high' ? 120 : level === 'medium' ? 80 : 45;
    this.farDistance = Math.round(this.nearDistance * LOD_HYSTERESIS_RATIO);
    this.nightLights = qualitySettings(level).nightWindows;
    this.nightUniform.value = this.nightLights ? this.nightAmount : 0;
  }

  /** Bascule les villes lointaines en silhouette simplifiée. */
  update(cameraPosition: THREE.Vector3): void {
    if (this.towns.size === 0) return;
    let changed = false;
    for (const town of this.towns.values()) {
      const distance = Math.hypot(town.centreX - cameraPosition.x, town.centreZ - cameraPosition.z);
      let near = town.near;
      // Hystérésis : entre `nearDistance` et `farDistance`, on conserve l'état.
      if (town.near) {
        if (distance > this.farDistance) near = false;
      } else if (distance < this.nearDistance) {
        near = true;
      }
      if (near === town.near) continue;
      town.near = near;
      this.lodSwitches += 1;
      changed = true;
    }
    if (changed) this.applyBuckets();
  }

  private applyBuckets(): void {
    const rebuildAll = this.allDirty;
    this.allDirty = false;
    this.bucketRebuilds = 0;

    if (rebuildAll) this.clearBucketMeshes();

    const nearBuckets = new Map<string, Placement[]>();
    const far: Placement[] = [];
    for (const town of this.towns.values()) {
      for (const placement of town.placements) {
        if (!town.near) {
          far.push(placement);
          continue;
        }
        const key = `${placement.archetype}:${placement.variant}`;
        const bucket = nearBuckets.get(key);
        if (bucket) bucket.push(placement);
        else nearBuckets.set(key, [placement]);
      }
    }

    for (const [key, placements] of nearBuckets) {
      // Une bascule de LOD ne réinstancie que les lots dont le contenu change
      // réellement : les lots partagés avec des villes restées proches gardent
      // leur InstancedMesh.
      const signature = bucketSignature(placements);
      const existing = this.bucketByKey.get(key);
      if (!rebuildAll && existing && this.bucketSignatures.get(existing) === signature) continue;
      this.removeBucket(key);
      const [archetypeName, variantText] = key.split(':');
      const archetype = (archetypeName ?? 'house') as BuildingArchetype;
      const variant = Number.parseInt(variantText ?? '0', 10);
      const geometry = this.geometryFor(archetype, variant, this.detail);
      const mesh = this.createBucket(geometry, placements, `city-${key}`);
      this.bucketByKey.set(key, mesh);
      this.bucketSignatures.set(mesh, signature);
    }

    for (const key of [...this.bucketByKey.keys()]) {
      if (!nearBuckets.has(key)) this.removeBucket(key);
    }

    if (far.length > 0) {
      const signature = bucketSignature(far);
      const existing = this.farBucket;
      if (rebuildAll || !existing || this.bucketSignatures.get(existing) !== signature) {
        this.removeFarBucket();
        this.farBucket = this.createBucket(this.distantGeometryFor(), far, 'city-far');
        this.bucketSignatures.set(this.farBucket, signature);
      }
    } else {
      this.removeFarBucket();
    }

    this.buckets = [...this.bucketByKey.values()];
    if (this.farBucket) this.buckets.push(this.farBucket);
  }

  private removeBucket(key: string): void {
    const mesh = this.bucketByKey.get(key);
    if (!mesh) return;
    this.bucketByKey.delete(key);
    this.removeBucketMesh(mesh);
  }

  private removeFarBucket(): void {
    if (!this.farBucket) return;
    this.removeBucketMesh(this.farBucket);
    this.farBucket = null;
  }

  private removeBucketMesh(mesh: THREE.InstancedMesh): void {
    this.group.remove(mesh);
    this.bucketTownIds.delete(mesh);
    this.bucketTiles.delete(mesh);
    this.bucketSignatures.delete(mesh);
    mesh.dispose();
  }

  private clearBucketMeshes(): void {
    for (const mesh of this.bucketByKey.values()) this.removeBucketMesh(mesh);
    this.bucketByKey.clear();
    this.removeFarBucket();
    this.buckets = [];
    this.bucketTownIds.clear();
    this.bucketTiles.clear();
    this.bucketSignatures.clear();
  }

  private createBucket(
    geometry: THREE.BufferGeometry,
    placements: readonly Placement[],
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, placements.length);
    mesh.name = name;
    this.bucketRebuilds += 1;
    mesh.castShadow = this.shadows && name !== 'city-far';
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    const townIds: number[] = [];
    const tiles: { x: number; y: number }[] = [];
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground, placement.z);
      this.quaternion.setFromAxisAngle(this.yawAxis, placement.yaw);
      this.scale.set(placement.scaleX, placement.scaleY, placement.scaleZ);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(index, this.matrix);
      this.colour.setRGB(
        clampColour(placement.tint * (1 + placement.warmth) * placement.districtR),
        clampColour(placement.tint * 0.995 * placement.districtG),
        clampColour(placement.tint * (0.975 - placement.warmth) * placement.districtB),
      );
      mesh.setColorAt(index, this.colour);
      townIds.push(placement.townId);
      tiles.push({ x: placement.tileX, y: placement.tileY });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.bucketTownIds.set(mesh, townIds);
    this.bucketTiles.set(mesh, tiles);
    return mesh;
  }

  private geometryFor(
    archetype: BuildingArchetype,
    variant: number,
    detail: BuildingDetail,
  ): THREE.BufferGeometry {
    const key = `${archetype}:${variant}:${detail}`;
    const cached = this.geometryCache.get(key);
    if (cached) return cached;
    const geometry = createBuildingGeometry(archetype, variant, detail);
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  private distantGeometryFor(): THREE.BufferGeometry {
    if (!this.distantGeometry) this.distantGeometry = createDistantBuildingGeometry();
    return this.distantGeometry;
  }

  /** Reconstruit les gares (halle + quais couverts) à partir du snapshot. */
  setStations(stations: readonly StationSnapshot[], map: MapSnapshot | null): void {
    const signature = computeStationSignature(stations, map);
    if (signature === this.stationSignature) return;
    this.stationStations = stations;
    this.clearStations();
    this.stationSignature = signature;
    if (!map || stations.length === 0) return;
    const visible = stations.filter(
      (station) => station.kind !== 'ship' && station.kind !== 'buoy',
    );
    if (visible.length === 0) return;

    const detail: BuildingDetail = this.detail >= 2 ? 2 : 1;
    const hasDriveThrough = visible.some((station) => isDriveThroughStation(station, map));
    if (!this.hallGeometry) this.hallGeometry = createStationHallGeometry(detail);
    if (!this.platformGeometry) this.platformGeometry = createStationPlatformGeometry(detail);
    if (hasDriveThrough && !this.stopGeometry) {
      this.stopGeometry = createBusStopGeometry(detail);
    }
    const hallGeometry = this.hallGeometry;
    const platformGeometry = this.platformGeometry;
    const stopGeometry = this.stopGeometry;
    if (!hallGeometry || !platformGeometry) return;

    const halls: StationPlacement[] = [];
    const platforms: StationPlacement[] = [];
    const stops: StationPlacement[] = [];
    const bases: StationPlacement[] = [];
    for (const station of visible) {
      const width = Math.max(1, Math.round(station.width));
      const height = Math.max(1, Math.round(station.height));
      const colour = stationColour(station.company);
      // `station.x/y` est le CENTRE de l'emprise (contrat du snapshot) : la
      // tuile nord-ouest se déduit de la moitié de l'emprise, jamais de x/y.
      const left = Math.floor(station.x - width / 2);
      const top = Math.floor(station.y - height / 2);
      // La halle tient sur UNE tuile : on vise la tuile du centre, ramenée
      // dans l'emprise pour ne jamais sortir de la gare.
      const hallTileX = Math.max(left, Math.min(left + width - 1, Math.floor(station.x)));
      const hallTileY = Math.max(top, Math.min(top + height - 1, Math.floor(station.y)));
      const hallX = hallTileX + 0.5;
      const hallZ = hallTileY + 0.5;
      const hallGround = sampleHeightWorld(map, hallX, hallZ);
      if (isDriveThroughStation(station, map)) {
        // Arrêt en passage : un abri de trottoir orienté par la route. Aucune
        // halle, aucun quai, aucun socle : la chaussée reste libre et plane.
        const axis = stationRoadAxis(station, map);
        // L'abri est posé sur le trottoir : on échantillonne la hauteur au
        // point de bord de chaussée, pas au centre de la tuile, puis on ajoute
        // la surépaisseur du trottoir pour éviter d'enfoncer le mobilier.
        const curbX = axis === 'x' ? hallX : hallX + STOP_CURB_OFFSET;
        const curbZ = axis === 'x' ? hallZ + STOP_CURB_OFFSET : hallZ;
        stops.push({
          stationId: station.id,
          x: hallX,
          z: hallZ,
          tileX: hallTileX,
          tileY: hallTileY,
          ground: sampleHeightWorld(map, curbX, curbZ) + SIDEWALK_LIFT,
          yaw: axis === 'x' ? 0 : Math.PI / 2,
          width: 0.98,
          height: 0.98,
          colour,
        });
        continue;
      }
      const yaw = width >= height ? 0 : Math.PI / 2;
      halls.push({
        stationId: station.id,
        x: hallX,
        z: hallZ,
        tileX: hallTileX,
        tileY: hallTileY,
        ground: hallGround,
        yaw,
        width: 0.95,
        height: 0.95,
        colour,
      });
      this.pushStationBase(
        bases,
        map,
        station.id,
        hallTileX,
        hallTileY,
        hallX,
        hallZ,
        hallGround,
        0.82,
        yaw,
      );
      // Les aéroports gardent leur tarmac dessiné par le terrain : pas de
      // canopée de quai sur 3×3 tuiles. Seul le terminal est posé.
      if (station.kind === 'airport') continue;
      for (let tileY = 0; tileY < height; tileY += 1) {
        for (let tileX = 0; tileX < width; tileX += 1) {
          if (platforms.length >= MAX_STATION_TILES) break;
          const x = left + tileX + 0.5;
          const z = top + tileY + 0.5;
          const ground = sampleHeightWorld(map, x, z);
          platforms.push({
            stationId: station.id,
            x,
            z,
            tileX: left + tileX,
            tileY: top + tileY,
            ground,
            yaw,
            width: 0.95,
            height: 0.95,
            colour,
          });
          this.pushStationBase(
            bases,
            map,
            station.id,
            left + tileX,
            top + tileY,
            x,
            z,
            ground,
            0.9,
            yaw,
          );
        }
      }
    }

    if (halls.length > 0) {
      this.stationHalls = this.createStationMesh(hallGeometry, halls, 'station-halls');
    }
    if (stops.length > 0 && stopGeometry) {
      this.stationStops = this.createStationMesh(stopGeometry, stops, 'station-stops');
    }
    if (platforms.length > 0) {
      this.stationPlatforms = this.createStationMesh(
        platformGeometry,
        platforms,
        'station-platforms',
      );
    }
    if (bases.length > 0) {
      this.stationBases = this.createStationMesh(
        this.stationBaseGeometry,
        bases,
        'station-bases',
        this.stationBaseMaterial,
      );
    }
    this.stationCount = visible.length;
    this.stationBaseCountValue = bases.length;
  }

  /**
   * Ajoute une petite terrasse locale sous une tuile de gare si la pente crée
   * un vide. C'est une instance par tuile, jamais une plaque multi-tuiles.
   */
  private pushStationBase(
    bases: StationPlacement[],
    map: MapSnapshot,
    stationId: number,
    tileX: number,
    tileY: number,
    x: number,
    z: number,
    ground: number,
    footprint: number,
    yaw: number,
  ): void {
    const minCorner = Math.min(
      cornerHeightWorld(map, tileX, tileY),
      cornerHeightWorld(map, tileX + 1, tileY),
      cornerHeightWorld(map, tileX, tileY + 1),
      cornerHeightWorld(map, tileX + 1, tileY + 1),
    );
    const gap = ground - minCorner;
    if (gap <= 0.02) return;
    bases.push({
      stationId,
      x,
      z,
      tileX,
      tileY,
      ground: minCorner,
      yaw,
      width: footprint,
      height: footprint,
      colour: 0xffffff,
      scaleY: gap + 0.025,
    });
  }

  private createStationMesh(
    geometry: THREE.BufferGeometry,
    placements: readonly StationPlacement[],
    name: string,
    material: THREE.Material = this.material,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    mesh.name = name;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    const pickInfo: { stationId: number; x: number; y: number }[] = [];
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground, placement.z);
      this.quaternion.setFromAxisAngle(this.yawAxis, placement.yaw);
      this.scale.set(placement.width, placement.scaleY ?? 1, placement.height);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(index, this.matrix);
      hexToRgb(placement.colour, this.rgb);
      this.colour.setRGB(this.rgb.r, this.rgb.g, this.rgb.b);
      mesh.setColorAt(index, this.colour);
      pickInfo.push({ stationId: placement.stationId, x: placement.tileX, y: placement.tileY });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.stationPickInfo.set(mesh, pickInfo);
    return mesh;
  }

  /** Matériau de surface partagé (diagnostic et tests). */
  get surfaceMaterial(): THREE.MeshStandardMaterial {
    return this.material;
  }

  /** 0 = jour, 1 = nuit profonde : allume les fenêtres des bâtiments. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightLights ? this.nightAmount : 0;
  }

  get night(): number {
    return this.nightAmount;
  }

  /** Active/désactive les fenêtres éclairées (preset basse qualité). */
  setNightLights(enabled: boolean): void {
    this.nightLights = enabled;
    this.nightUniform.value = enabled ? this.nightAmount : 0;
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const mesh of this.buckets) {
      mesh.castShadow = enabled && mesh.name !== 'city-far';
    }
    if (this.stationHalls) this.stationHalls.castShadow = enabled;
    if (this.stationPlatforms) this.stationPlatforms.castShadow = enabled;
    if (this.stationStops) this.stationStops.castShadow = enabled;
    if (this.stationBases) this.stationBases.castShadow = enabled;
    if (this.plinths) this.plinths.castShadow = enabled;
  }

  get buildingCount(): number {
    let total = 0;
    for (const town of this.towns.values()) total += town.placements.length;
    return total;
  }

  get stationCountValue(): number {
    return this.stationCount;
  }

  /** Socles locaux de gare (diagnostic/tests). */
  get stationBaseCount(): number {
    return this.stationBaseCountValue;
  }

  /** Plinthes de bâtiments en pente (diagnostic/tests). */
  get plinthCount(): number {
    return this.plinthCountValue;
  }

  get drawCallCount(): number {
    return (
      this.buckets.length +
      (this.stationHalls ? 1 : 0) +
      (this.stationPlatforms ? 1 : 0) +
      (this.stationStops ? 1 : 0) +
      (this.stationBases ? 1 : 0)
    );
  }

  /** Nombre de villes affichées en silhouette simplifiée (diagnostic). */
  get distantTownCount(): number {
    let total = 0;
    for (const town of this.towns.values()) if (!town.near) total += 1;
    return total;
  }

  /** Nombre total de triangles des lots actuellement montés. */
  get triangleCount(): number {
    let total = 0;
    for (const mesh of this.buckets) {
      const position = mesh.geometry.getAttribute('position');
      total += ((position?.count ?? 0) / 3) * mesh.count;
    }
    return total;
  }

  /**
   * Cibles de picking : bâtiments des villes ET gares. Les props décoratifs
   * (`TownPropsLayer`) n'y figurent jamais : ils ne doivent pas voler le clic
   * d'un bâtiment, et une gare doit rester sélectionnable.
   */
  pickTargets(): CityPickTarget[] {
    const targets: CityPickTarget[] = this.buckets.map((mesh) => ({
      mesh,
      infoForInstance: (instanceId: number): CityPickInfo | null => {
        const townId = this.bucketTownIds.get(mesh)?.[instanceId];
        const tile = this.bucketTiles.get(mesh)?.[instanceId];
        if (townId === undefined || !tile) return null;
        return { kind: 'building', townId, x: tile.x, y: tile.y };
      },
    }));
    for (const mesh of [
      this.stationHalls,
      this.stationPlatforms,
      this.stationStops,
      this.stationBases,
    ]) {
      if (!mesh) continue;
      targets.push({
        mesh,
        infoForInstance: (instanceId: number): CityPickInfo | null => {
          const info = this.stationPickInfo.get(mesh)?.[instanceId];
          if (!info) return null;
          return { kind: 'station', stationId: info.stationId, x: info.x, y: info.y };
        },
      });
    }
    return targets;
  }

  private clear(): void {
    this.clearBucketMeshes();
    this.towns.clear();
    this.clearPlinths();
    this.clearStations();
    this.allDirty = true;
  }

  private clearStations(): void {
    if (this.stationHalls) {
      this.group.remove(this.stationHalls);
      this.stationPickInfo.delete(this.stationHalls);
      this.stationHalls.dispose();
      this.stationHalls = null;
    }
    if (this.stationPlatforms) {
      this.group.remove(this.stationPlatforms);
      this.stationPickInfo.delete(this.stationPlatforms);
      this.stationPlatforms.dispose();
      this.stationPlatforms = null;
    }
    if (this.stationStops) {
      this.group.remove(this.stationStops);
      this.stationPickInfo.delete(this.stationStops);
      this.stationStops.dispose();
      this.stationStops = null;
    }
    if (this.stationBases) {
      this.group.remove(this.stationBases);
      this.stationPickInfo.delete(this.stationBases);
      this.stationBases.dispose();
      this.stationBases = null;
    }
    this.stationPickInfo.clear();
    this.stationBaseCountValue = 0;
    this.stationCount = 0;
    this.stationSignature = 0;
  }

  dispose(): void {
    this.clear();
    this.group.clear();
    this.signature = 0;
    this.builds = 0;
    this.lodSwitches = 0;
    this.bucketRebuilds = 0;
    for (const geometry of this.geometryCache.values()) geometry.dispose();
    this.geometryCache.clear();
    this.distantGeometry?.dispose();
    this.distantGeometry = null;
    this.hallGeometry?.dispose();
    this.hallGeometry = null;
    this.platformGeometry?.dispose();
    this.platformGeometry = null;
    this.stopGeometry?.dispose();
    this.stopGeometry = null;
    this.plinthGeometry.dispose();
    this.plinthMaterial.dispose();
    this.stationBaseGeometry.dispose();
    this.stationBaseMaterial.dispose();
    this.material.dispose();
    this.map = null;
    this.townSnapshots = [];
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }
}

/**
 * Signature bon marché du contenu d'un lot : identité des placements qui le
 * composent. Elle évite de réinstancier un lot dont aucune instance n'a changé.
 */
function bucketSignature(placements: readonly Placement[]): number {
  let hash = 0x811c9dc5;
  for (const placement of placements) {
    hash = Math.imul(hash ^ placement.townId, 0x01000193) >>> 0;
    hash = Math.imul(hash ^ Math.round(placement.x * 512), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ Math.round(placement.z * 512), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ Math.round(placement.ground * 512), 0x01000193) >>> 0;
  }
  return Math.imul(hash ^ placements.length, 0x01000193) >>> 0;
}

/**
 * Palettes de quartier : facteurs RGB appliqués à la teinte d'instance.
 *
 * Les géométries restent mutualisées (16 lots) ; c'est la couleur d'instance
 * qui donne à chaque secteur de la ville son ambiance (tuiles chaudes, enduits
 * crème, façades froides). Un quartier regroupe plusieurs dizaines de tuiles :
 * la variation est visible sans transformer chaque maison en exception.
 */
const DISTRICT_PALETTES: readonly (readonly [number, number, number])[] = [
  [1.045, 1.0, 0.935],
  [1.0, 0.985, 1.05],
  [1.05, 1.02, 0.97],
  [1.02, 0.955, 0.95],
  [0.955, 1.04, 1.0],
  [0.975, 1.0, 1.055],
  [1.02, 1.03, 1.01],
  [1.035, 0.99, 1.02],
];

/** Secteur (8 quartiers) d'une tuile autour du centre-ville. */
export function districtIndex(centreX: number, centreZ: number, x: number, z: number): number {
  const dx = x - centreX;
  const dz = z - centreZ;
  const angle = Math.atan2(dz, dx);
  const sector = Math.min(3, Math.max(0, Math.floor((angle + Math.PI) / (Math.PI / 2))));
  const ring = Math.hypot(dx, dz) > MAX_RADIUS * 0.42 ? 1 : 0;
  return ring * 4 + sector;
}

/** Facteurs RGB du quartier, déterministes pour une ville et un secteur. */
export function districtPalette(
  townId: number,
  centreX: number,
  centreZ: number,
  x: number,
  z: number,
): readonly [number, number, number] {
  const index = districtIndex(centreX, centreZ, x, z);
  const hash = hashUnit2d(townId * 59 + 17, index, 3);
  const palette = DISTRICT_PALETTES[Math.floor(hash * DISTRICT_PALETTES.length)] ?? [1, 1, 1];
  return palette;
}

function clampColour(value: number): number {
  return Math.max(0, Math.min(1.08, value));
}

/** Empreinte stable des villes + tuiles house + hauteurs + détail. */ export function computeCitySignature(
  towns: readonly TownSnapshot[],
  map: MapSnapshot,
  detail: BuildingDetail,
): number {
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ (value | 0), 0x01000193) >>> 0;
  };
  mix(map.width);
  mix(map.height);
  mix(detail);
  mix(towns.length);
  // Seule la zone lue par `build` autour de chaque ville compte : inutile de
  // hacher les 262 144 tuiles d'une carte 512 à chaque snapshot.
  const radius = MAX_RADIUS + 1;
  for (const town of towns) {
    const centreX = Math.floor(town.x);
    const centreY = Math.floor(town.y);
    mix(town.id);
    mix(centreX);
    mix(centreY);
    for (let dy = -radius; dy <= radius; dy += 1) {
      const y = centreY + dy;
      if (y < 0 || y >= map.height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = centreX + dx;
        if (x < 0 || x >= map.width) continue;
        const index = y * map.width + x;
        // Une tuile house, une hauteur ou un voisin de pente qui change doit
        // reposer les bâtiments et leurs plinthes.
        mix(map.kind[index] === TILE_KIND_INDEX.house ? 1 : 0);
        mix(map.heightMap[index] ?? 0);
      }
    }
  }
  return hash >>> 0;
}

/** Signature stable des gares + dimensions de carte, pour éviter les rebuilds. */
function computeStationSignature(
  stations: readonly StationSnapshot[],
  map: MapSnapshot | null,
): number {
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ (value | 0), 0x01000193) >>> 0;
  };
  mix(stations.length);
  mix(map ? map.width : 0);
  mix(map ? map.height : 0);
  for (const station of stations) {
    mix(station.id);
    mix(station.company);
    mix(station.x);
    mix(station.y);
    mix(station.width);
    mix(station.height);
    mix(station.driveThrough ? 1 : 0);
    mix(station.roadAxis === 'y' ? 1 : 0);
    for (let index = 0; index < station.kind.length; index += 1) {
      mix(station.kind.charCodeAt(index));
    }
    // Les terrassements sous la gare doivent aussi déclencher une reconstruction.
    if (map) {
      const width = Math.max(1, Math.round(station.width));
      const height = Math.max(1, Math.round(station.height));
      const left = Math.floor(station.x - width / 2);
      const top = Math.floor(station.y - height / 2);
      for (let dy = 0; dy < height; dy += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          const x = left + dx;
          const y = top + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          const index = y * map.width + x;
          mix(map.heightMap[index] ?? 0);
          // L'orientation d'un arrêt en passage peut être déduite de la route
          // voisine quand le snapshot est antérieur au champ `roadAxis`.
          mix(map.kind[index] ?? 0);
          mix(map.trackBits[index] ?? 0);
        }
      }
    }
  }
  return hash >>> 0;
}

/** Vrai si la tuile porte une route (pour l'orientation d'un arrêt en passage). */
function isRoadTile(map: MapSnapshot, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return (map.kind[y * map.width + x] ?? 0) === TILE_KIND_INDEX.road;
}

/**
 * Détecte un arrêt de bus en passage. Les snapshots récents portent
 * `driveThrough` ; les anciens (et le pont WASM non reconstruit) sont déduits
 * de la tuile de gare : connexions routières dans la tuile ou routes de part
 * et d'autre. Une gare routière normale, posée à côté de la route, ne doit
 * jamais être confondue avec un arrêt traversant.
 */
function isDriveThroughStation(station: StationSnapshot, map: MapSnapshot): boolean {
  if (station.kind !== 'road') return false;
  if (station.driveThrough !== undefined) return station.driveThrough;
  if (Math.round(station.width) !== 1 || Math.round(station.height) !== 1) return false;
  const x = Math.floor(station.x);
  const y = Math.floor(station.y);
  const index = y * map.width + x;
  const bits = map.trackBits[index] ?? 0;
  if (
    (bits & (CONNECT_EAST | CONNECT_WEST)) !== 0 ||
    (bits & (CONNECT_NORTH | CONNECT_SOUTH)) !== 0
  ) {
    return true;
  }
  return (
    (isRoadTile(map, x - 1, y) && isRoadTile(map, x + 1, y)) ||
    (isRoadTile(map, x, y - 1) && isRoadTile(map, x, y + 1))
  );
}

/** Axe de la route d'un arrêt en passage, explicite ou déduit de la carte. */
function stationRoadAxis(station: StationSnapshot, map: MapSnapshot): 'x' | 'y' {
  if (station.roadAxis) return station.roadAxis;
  const x = Math.floor(station.x);
  const y = Math.floor(station.y);
  const index = y * map.width + x;
  const bits = map.trackBits[index] ?? 0;
  const alongX = (bits & (CONNECT_EAST | CONNECT_WEST)) !== 0;
  const alongY = (bits & (CONNECT_NORTH | CONNECT_SOUTH)) !== 0;
  if (alongX !== alongY) return alongX ? 'x' : 'y';

  const horizontal = Number(isRoadTile(map, x - 1, y)) + Number(isRoadTile(map, x + 1, y));
  const vertical = Number(isRoadTile(map, x, y - 1)) + Number(isRoadTile(map, x, y + 1));
  if (horizontal !== vertical) return horizontal > vertical ? 'x' : 'y';
  return station.width >= station.height ? 'x' : 'y';
}

/** Couleur de livrée d'une gare, atténuée pour rester lisible en plein jour. */
function stationColour(company: CompanyId): number {
  if (company === COMPANY_NONE) return 0xd8d2c4;
  const rgb = hexToRgb(companyColour(company), { r: 0, g: 0, b: 0 });
  const r = Math.round(255 * 0.42 + rgb.r * 255 * 0.58);
  const g = Math.round(255 * 0.42 + rgb.g * 255 * 0.58);
  const b = Math.round(255 * 0.42 + rgb.b * 255 * 0.58);
  return (r << 16) | (g << 8) | b;
}
