/**
 * Rendu des villes, gares et dépôts de ville.
 *
 * Les bâtiments ne sont plus des boîtes uniformes : chaque tuile `house` reçoit
 * un archétype (maison, immeuble, commerce, église, entrepôt) construit par
 * `models/buildings.ts`. Les géométries sont fusionnées par archétype et
 * variante, puis posées par `InstancedMesh` : le nombre de draw calls dépend
 * des archétypes, pas du nombre de bâtiments.
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
import { COMPANY_NONE } from '../engine/protocol';
import { sampleHeightWorld, tileKindFromIndex } from '../game/mapGrid';
import { Prng, hashUnit2d } from '../game/prng';
import { companyColour, hexToRgb } from './tileVisuals';
import { qualitySettings, type QualityLevel } from './quality';
import {
  BUILDING_VARIANTS,
  chooseBuildingArchetype,
  createBuildingGeometry,
  createDistantBuildingGeometry,
  createStationHallGeometry,
  createStationPlatformGeometry,
  type BuildingArchetype,
  type BuildingDetail,
} from './models/buildings';

const MAX_RADIUS = 10;
const MAX_STATION_TILES = 2048;

export interface CityPickTarget {
  mesh: THREE.InstancedMesh;
  townForInstance(instanceId: number): number | null;
}

interface Placement {
  townId: number;
  archetype: BuildingArchetype;
  variant: number;
  x: number;
  z: number;
  ground: number;
  yaw: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  tint: number;
  /** Dérive chaude/froide de la teinte, pour casser l'uniformité. */
  warmth: number;
}

interface TownState {
  townId: number;
  centreX: number;
  centreZ: number;
  placements: Placement[];
  near: boolean;
}

interface StationPlacement {
  x: number;
  z: number;
  ground: number;
  yaw: number;
  width: number;
  height: number;
  colour: number;
}

export class CityLayer {
  readonly group = new THREE.Group();

  private material: THREE.MeshLambertMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private nightLights = true;
  private towns = new Map<number, TownState>();
  private buckets: THREE.InstancedMesh[] = [];
  private bucketTownIds = new Map<THREE.InstancedMesh, number[]>();
  private geometryCache = new Map<string, THREE.BufferGeometry>();
  private distantGeometry: THREE.BufferGeometry | null = null;
  private hallGeometry: THREE.BufferGeometry | null = null;
  private platformGeometry: THREE.BufferGeometry | null = null;
  private stationHalls: THREE.InstancedMesh | null = null;
  private stationPlatforms: THREE.InstancedMesh | null = null;
  private stationCount = 0;
  private stationSignature = 0;
  private stationStations: readonly StationSnapshot[] = [];
  private map: MapSnapshot | null = null;
  private detail: BuildingDetail = 1;
  private quality: QualityLevel = 'medium';
  private nearDistance = 80;
  private shadows = false;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private colour = new THREE.Color();
  private rgb = { r: 0, g: 0, b: 0 };
  private yawAxis = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'cities';
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Fenêtres éclairées : un attribut par sommet, aucun draw call en plus.
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.nightUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aWindow;\nvarying float vWindow;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWindow = aWindow;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uNight;\nvarying float vWindow;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           if ( uNight > 0.001 && vWindow > 0.01 ) {
             totalEmissiveRadiance += vec3( 1.0, 0.6, 0.25 ) * vWindow * uNight * 1.3;
           }`,
        );
    };
    this.material.customProgramCacheKey = () => 'opentt3d-building-windows-v2';
    this.applyQuality('medium');
  }

  /** Reconstruit les bâtiments de toutes les villes. */
  build(towns: readonly TownSnapshot[], map: MapSnapshot): void {
    this.map = map;
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
          const variant = Math.min(
            BUILDING_VARIANTS - 1,
            Math.floor(hashUnit2d(town.id * 17 + 3, x + 13, y + 7) * BUILDING_VARIANTS),
          );
          const worldX = x + 0.5;
          const worldZ = y + 0.5;
          placements.push({
            townId: town.id,
            archetype,
            variant,
            x: worldX,
            z: worldZ,
            ground: sampleHeightWorld(map, worldX, worldZ),
            yaw: (rng.int(0, 3) * Math.PI) / 2,
            scaleX: rng.float(0.92, 1),
            scaleY: rng.float(0.9, 1.1),
            scaleZ: rng.float(0.92, 1),
            tint: rng.float(0.9, 1.05),
            warmth: rng.float(-0.018, 0.018),
          });
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
    this.applyBuckets();
  }

  /** Change le niveau de détail des bâtiments (qualité graphique). */
  setQuality(level: QualityLevel): void {
    this.applyQuality(level);
    if (this.towns.size > 0) this.applyBuckets();
    if (this.stationStations.length > 0) {
      this.hallGeometry?.dispose();
      this.hallGeometry = null;
      this.platformGeometry?.dispose();
      this.platformGeometry = null;
      this.stationSignature = 0;
      this.setStations(this.stationStations, this.map);
    }
  }

  private applyQuality(level: QualityLevel): void {
    this.quality = level;
    this.detail = level === 'high' ? 2 : level === 'medium' ? 1 : 0;
    this.nearDistance = level === 'high' ? 120 : level === 'medium' ? 80 : 45;
    this.nightLights = qualitySettings(level).nightWindows;
    this.nightUniform.value = this.nightLights ? this.nightAmount : 0;
  }

  /** Bascule les villes lointaines en silhouette simplifiée. */
  update(cameraPosition: THREE.Vector3): void {
    if (this.towns.size === 0) return;
    let changed = false;
    for (const town of this.towns.values()) {
      const distance = Math.hypot(town.centreX - cameraPosition.x, town.centreZ - cameraPosition.z);
      const near = distance <= this.nearDistance;
      if (near !== town.near) {
        town.near = near;
        changed = true;
      }
    }
    if (changed) this.applyBuckets();
  }

  private applyBuckets(): void {
    for (const mesh of this.buckets) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.buckets = [];
    this.bucketTownIds.clear();

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
      const [archetypeName, variantText] = key.split(':');
      const archetype = (archetypeName ?? 'house') as BuildingArchetype;
      const variant = Number.parseInt(variantText ?? '0', 10);
      const geometry = this.geometryFor(archetype, variant, this.detail);
      const mesh = this.createBucket(geometry, placements, `city-${key}`);
      this.buckets.push(mesh);
    }

    if (far.length > 0) {
      const geometry = this.distantGeometryFor();
      const mesh = this.createBucket(geometry, far, 'city-far');
      this.buckets.push(mesh);
    }
  }

  private createBucket(
    geometry: THREE.BufferGeometry,
    placements: readonly Placement[],
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, placements.length);
    mesh.name = name;
    mesh.castShadow = this.shadows && name !== 'city-far';
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    const townIds: number[] = [];
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground, placement.z);
      this.quaternion.setFromAxisAngle(this.yawAxis, placement.yaw);
      this.scale.set(placement.scaleX, placement.scaleY, placement.scaleZ);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(index, this.matrix);
      this.colour.setRGB(
        placement.tint * (1 + placement.warmth),
        placement.tint * 0.995,
        placement.tint * (0.975 - placement.warmth),
      );
      mesh.setColorAt(index, this.colour);
      townIds.push(placement.townId);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.bucketTownIds.set(mesh, townIds);
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
    if (!this.hallGeometry) this.hallGeometry = createStationHallGeometry(detail);
    if (!this.platformGeometry) this.platformGeometry = createStationPlatformGeometry(detail);
    const hallGeometry = this.hallGeometry;
    const platformGeometry = this.platformGeometry;
    if (!hallGeometry || !platformGeometry) return;

    const halls: StationPlacement[] = [];
    const platforms: StationPlacement[] = [];
    for (const station of visible) {
      const width = Math.max(1, station.width);
      const height = Math.max(1, station.height);
      const centreX = station.x + width / 2;
      const centreZ = station.y + height / 2;
      const yaw = width >= height ? 0 : Math.PI / 2;
      const ground = sampleHeightWorld(map, centreX, centreZ);
      halls.push({
        x: centreX,
        z: centreZ,
        ground,
        yaw,
        width: Math.min(1.5, Math.max(0.75, width * 0.55)),
        height: Math.min(1.1, Math.max(0.75, height * 0.5)),
        colour: stationColour(station.company),
      });
      for (let tileY = 0; tileY < height; tileY += 1) {
        for (let tileX = 0; tileX < width; tileX += 1) {
          if (platforms.length >= MAX_STATION_TILES) break;
          const x = station.x + tileX + 0.5;
          const z = station.y + tileY + 0.5;
          platforms.push({
            x,
            z,
            ground: sampleHeightWorld(map, x, z),
            yaw,
            width: 0.95,
            height: 0.95,
            colour: stationColour(station.company),
          });
        }
      }
    }

    this.stationHalls = this.createStationMesh(hallGeometry, halls, 'station-halls');
    this.stationPlatforms = this.createStationMesh(
      platformGeometry,
      platforms,
      'station-platforms',
    );
    this.stationCount = visible.length;
  }

  private createStationMesh(
    geometry: THREE.BufferGeometry,
    placements: readonly StationPlacement[],
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, placements.length);
    mesh.name = name;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      if (!placement) continue;
      this.position.set(placement.x, placement.ground, placement.z);
      this.quaternion.setFromAxisAngle(this.yawAxis, placement.yaw);
      this.scale.set(placement.width, 1, placement.height);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(index, this.matrix);
      hexToRgb(placement.colour, this.rgb);
      this.colour.setRGB(this.rgb.r, this.rgb.g, this.rgb.b);
      mesh.setColorAt(index, this.colour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
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
  }

  get buildingCount(): number {
    let total = 0;
    for (const town of this.towns.values()) total += town.placements.length;
    return total;
  }

  get stationCountValue(): number {
    return this.stationCount;
  }

  get drawCallCount(): number {
    return this.buckets.length + (this.stationHalls ? 1 : 0) + (this.stationPlatforms ? 1 : 0);
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

  pickTargets(): CityPickTarget[] {
    return this.buckets.map((mesh) => ({
      mesh,
      townForInstance: (instanceId: number) => this.bucketTownIds.get(mesh)?.[instanceId] ?? null,
    }));
  }

  private clear(): void {
    for (const mesh of this.buckets) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.buckets = [];
    this.bucketTownIds.clear();
    this.towns.clear();
    this.clearStations();
  }

  private clearStations(): void {
    if (this.stationHalls) {
      this.group.remove(this.stationHalls);
      this.stationHalls.dispose();
      this.stationHalls = null;
    }
    if (this.stationPlatforms) {
      this.group.remove(this.stationPlatforms);
      this.stationPlatforms.dispose();
      this.stationPlatforms = null;
    }
    this.stationCount = 0;
    this.stationSignature = 0;
  }

  dispose(): void {
    this.clear();
    this.group.clear();
    for (const geometry of this.geometryCache.values()) geometry.dispose();
    this.geometryCache.clear();
    this.distantGeometry?.dispose();
    this.distantGeometry = null;
    this.hallGeometry?.dispose();
    this.hallGeometry = null;
    this.platformGeometry?.dispose();
    this.platformGeometry = null;
    this.material.dispose();
    this.map = null;
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }
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
    for (let index = 0; index < station.kind.length; index += 1) {
      mix(station.kind.charCodeAt(index));
    }
    // Les terrassements sous la gare doivent aussi déclencher une reconstruction.
    if (map) {
      const width = Math.max(1, station.width);
      const height = Math.max(1, station.height);
      for (let dy = 0; dy < height; dy += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          const x = Math.floor(station.x) + dx;
          const y = Math.floor(station.y) + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          mix(map.heightMap[y * map.width + x] ?? 0);
        }
      }
    }
  }
  return hash >>> 0;
}

/** Couleur de livrée d'une gare, atténuée pour rester lisible en plein jour. */
function stationColour(company: CompanyId): number {
  if (company === COMPANY_NONE) return 0xd8d2c4;
  const rgb = hexToRgb(companyColour(company), { r: 0, g: 0, b: 0 });
  const r = Math.round(255 * 0.55 + rgb.r * 255 * 0.45);
  const g = Math.round(255 * 0.55 + rgb.g * 255 * 0.45);
  const b = Math.round(255 * 0.55 + rgb.b * 255 * 0.45);
  return (r << 16) | (g << 8) | b;
}
