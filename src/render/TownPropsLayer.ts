/**
 * Décors et mobilier urbain instanciés (#178).
 *
 * Chaque ville reçoit un semis déterministe de props procéduraux — lampadaires,
 * bancs, arbres de rue, arrêts de bus, panneaux, jardins, clôtures et placettes
 * pavées — posés sur le relief. Le semis évite les bâtiments, l'eau, les berges
 * noyées par une nappe surélevée, les industries et les gares : les jardins et
 * clôtures vont sur les tuiles libres (herbe, clairière, terrain vague), les
 * lampadaires et panneaux au coin des tuiles de voirie, toujours hors de la
 * chaussée et de la bordure (#215).
 *
 * Budget : un lot `InstancedMesh` par type de prop, jamais un par objet. Seules
 * les villes proches de la caméra sont instanciées ; au-delà d'un seuil avec
 * hystérésis, leurs props sont retirés des lots (LOD). Le rebuild n'a lieu
 * qu'au franchissement du seuil, pas à chaque frame.
 *
 * Aucun asset binaire : les géométries viennent de `models/buildings.ts`, le
 * matériau de nuit partagé de `models/materials.ts` allume lampadaires et
 * vitrines sans draw call supplémentaire.
 */

import * as THREE from 'three';
import type { MapSnapshot, TownSnapshot } from '../engine/protocol';
import { TILE_FLAG, TILE_KIND_INDEX } from '../engine/protocol';
import {
  HEIGHT_SCALE,
  cornerHeightWorld,
  isWaterKind,
  sampleHeightWorld,
  tileKindFromIndex,
} from '../game/mapGrid';
import { Prng, hashUnit2d } from '../game/prng';
import { qualitySettings, type QualityLevel } from './quality';
import { createModelMaterial } from './models/materials';
import { createTownPropGeometry, type BuildingDetail, type TownPropKind } from './models/buildings';
import { waterSurfaceHeight } from './waterSurface';

/** Rayon de semis autour du centre-ville (tuiles). */
const PROPS_RADIUS = 9;
/** Distance near/far par défaut, ajustée par le preset de qualité. */
const LOD_HYSTERESIS_RATIO = 1.18;
/** Plafond global : garde-fou mémoire sur les très grandes cartes. */
const MAX_PROPS_TOTAL = 2_400;
/** Nombre maximal de props par ville et par preset. */
const MAX_PROPS_PER_TOWN: Record<QualityLevel, number> = {
  low: 20,
  medium: 46,
  high: 72,
};
/** Tuiles qui peuvent recevoir un prop : jamais une route ou un bâtiment. */
const FREE_KINDS = new Set<number>([
  TILE_KIND_INDEX.grass,
  TILE_KIND_INDEX.clear,
  TILE_KIND_INDEX.rough,
]);
const ROAD_KINDS = new Set<number>([
  TILE_KIND_INDEX.road,
  TILE_KIND_INDEX.bridge,
  TILE_KIND_INDEX.tunnel,
]);

/**
 * Vrai si une tuile est inondable : drapeau d'eau, ou relief assez bas pour
 * qu'une nappe voisine la recouvre. Le second cas couvre les berges basses
 * d'un canal surélevé et, surtout, les **coins bas d'une berge en pente** : un
 * banc ou un jardin posé sur le coin le plus bas se retrouverait sous la
 * surface, comme un radeau (#215/#227).
 *
 * Le contrôle porte sur le voisinage complet (8-connexe, comme la couronne de
 * rive) et sur la hauteur du coin le plus bas, pas seulement sur le dessus de
 * la tuile : une pente peut descendre sous l'eau même si le centre de la tuile
 * émerge encore.
 */
export function isWaterloggedPropTile(map: MapSnapshot, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const index = y * map.width + x;
  if (((map.flags[index] ?? 0) & TILE_FLAG.WATER) !== 0) return true;
  const kind = tileKindFromIndex(map.kind[index] ?? 0);
  if (isWaterKind(kind) || kind === 'void') return true;
  const reference = nearbyWaterSurface(map, x, y);
  if (!Number.isFinite(reference)) return false;
  const top = (map.heightMap[index] ?? 0) * HEIGHT_SCALE;
  if (reference >= top - 0.02) return true;
  const lowestCorner = Math.min(
    cornerHeightWorld(map, x, y),
    cornerHeightWorld(map, x + 1, y),
    cornerHeightWorld(map, x, y + 1),
    cornerHeightWorld(map, x + 1, y + 1),
  );
  // Une tuile plate au même niveau que l'eau reste sèche : la surface est
  // juste sous son dessus. Dès qu'un coin descend sous la nappe, en revanche,
  // un prop posé au plus bas serait immergé.
  return reference > lowestCorner + 0.02;
}

/** Plus haute surface d'eau dans le voisinage 8-connexe, ou `-Infinity`. */
export function nearbyWaterSurface(map: MapSnapshot, x: number, y: number): number {
  let reference = -Infinity;
  for (let dy = -1; dy <= 1; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= map.height) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= map.width) continue;
      const neighbour = ny * map.width + nx;
      if (!isWaterKind(tileKindFromIndex(map.kind[neighbour] ?? 0))) continue;
      const surface = waterSurfaceHeight(map.heightMap[neighbour] ?? 0);
      if (surface > reference) reference = surface;
    }
  }
  return reference;
}

/**
 * Vrai si le pied d'un prop (`ground`, en unités monde) reste au-dessus de
 * toute nappe voisine. Dernier garde-fou du semis : une famille de props ne
 * doit jamais flotter, même si sa tuile a passé le filtre de pente.
 */
export function propFootAboveWater(
  map: MapSnapshot,
  x: number,
  z: number,
  ground: number,
): boolean {
  const tileX = Math.floor(x);
  const tileY = Math.floor(z);
  if (isWaterloggedPropTile(map, tileX, tileY)) return false;
  const reference = nearbyWaterSurface(map, tileX, tileY);
  if (!Number.isFinite(reference)) return true;
  return ground >= reference + 0.02;
}

interface PropPlacement {
  townId: number;
  kind: TownPropKind;
  x: number;
  z: number;
  ground: number;
  yaw: number;
  scale: number;
  /** Facteur de teinte du quartier (0,9..1,06). */
  tintR: number;
  tintG: number;
  tintB: number;
}

interface TownPropState {
  townId: number;
  centreX: number;
  centreZ: number;
  near: boolean;
}

interface CandidateTile {
  x: number;
  y: number;
  /** Nombre de voisins libres (4-connexe), pour distinguer rue et cœur d'îlot. */
  freeNeighbours: number;
  /** Direction de la route la plus proche, en pas de tuile (dx, dy). */
  roadX: number;
  roadY: number;
  nearRoad: boolean;
}

/** Palettes de quartier, alignées sur celles de `CityLayer`. */
const PROP_PALETTES: readonly (readonly [number, number, number])[] = [
  [1.03, 1.0, 0.95],
  [0.98, 1.0, 1.04],
  [1.04, 1.02, 0.98],
  [1.01, 0.97, 0.96],
];

export class TownPropsLayer {
  readonly group = new THREE.Group();

  private material: THREE.MeshStandardMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private nightLights = true;
  private geometryCache = new Map<string, THREE.BufferGeometry>();
  private meshes: THREE.InstancedMesh[] = [];
  private placements: PropPlacement[] = [];
  private towns = new Map<number, TownPropState>();
  private detail: BuildingDetail = 1;
  private nearDistance = 100;
  private farDistance = 118;
  private shadows = false;
  private signature = 0;
  private builtLevel: QualityLevel | null = null;
  private map: MapSnapshot | null = null;
  private townSnapshots: readonly TownSnapshot[] = [];
  private dirty = true;
  private visibleCountValue = 0;
  /** Nombre de reconstructions réelles du semis (diagnostic/tests). */
  builds = 0;
  /** Nombre de bascules near/far (diagnostic/tests). */
  lodSwitches = 0;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private colour = new THREE.Color();
  private yawAxis = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'town-props';
    this.material = createModelMaterial({
      night: this.nightUniform,
      glowStrength: 1.5,
      nightAmbient: 0.02,
      roughness: 0.82,
      metalness: 0.02,
      name: 'town-props-surface',
    });
    this.applyQuality('medium');
  }

  /** Reconstruit le semis de props des villes (déterministe). */
  build(towns: readonly TownSnapshot[], map: MapSnapshot, level: QualityLevel): void {
    this.map = map;
    this.townSnapshots = towns;
    if (this.builtLevel !== level) this.applyQuality(level);
    const signature = computeTownPropsSignature(towns, map, level);
    if (this.builds > 0 && signature === this.signature) return;
    this.signature = signature;
    this.builds += 1;
    this.clearInstances();
    this.towns.clear();
    this.placements = [];

    if (map.width < 8 || map.height < 8) {
      this.dirty = false;
      return;
    }

    const perTown = MAX_PROPS_PER_TOWN[level];
    for (const town of towns) {
      if (this.placements.length >= MAX_PROPS_TOTAL) break;
      const generated = generateTownProps(town, map, perTown);
      // Une ville sans aucune tuile libre reste suivie : rien à instancier.
      this.towns.set(town.id, {
        townId: town.id,
        centreX: town.x,
        centreZ: town.y,
        near: true,
      });
      for (const placement of generated) {
        if (this.placements.length >= MAX_PROPS_TOTAL) break;
        this.placements.push(placement);
      }
    }
    this.dirty = true;
    this.applyLod(null);
    this.rebuildInstances();
  }

  /** Change le preset : densité, détail et distance de LOD. */
  setQuality(level: QualityLevel): void {
    if (this.map && this.townSnapshots.length > 0) {
      this.build(this.townSnapshots, this.map, level);
      return;
    }
    this.applyQuality(level);
  }

  private applyQuality(level: QualityLevel): void {
    this.detail = level === 'high' ? 2 : level === 'medium' ? 1 : 0;
    this.nearDistance = level === 'high' ? 150 : level === 'medium' ? 100 : 60;
    this.farDistance = Math.round(this.nearDistance * LOD_HYSTERESIS_RATIO);
    this.nightLights = qualitySettings(level).nightWindows;
    this.nightUniform.value = this.nightLights ? this.nightAmount : 0;
    this.builtLevel = level;
  }

  update(cameraPosition: THREE.Vector3): void {
    if (this.towns.size === 0) return;
    if (this.applyLod(cameraPosition) || this.dirty) {
      this.rebuildInstances();
    }
  }

  /** Bascule near/far avec hystérésis ; vrai si un état a changé. */
  private applyLod(cameraPosition: THREE.Vector3 | null): boolean {
    let changed = false;
    for (const town of this.towns.values()) {
      let near = town.near;
      if (cameraPosition) {
        const distance = Math.hypot(
          town.centreX - cameraPosition.x,
          town.centreZ - cameraPosition.z,
        );
        if (town.near) {
          if (distance > this.farDistance) near = false;
        } else if (distance < this.nearDistance) {
          near = true;
        }
      }
      if (near === town.near) continue;
      town.near = near;
      this.lodSwitches += 1;
      changed = true;
    }
    return changed;
  }

  /** Recrée un lot `InstancedMesh` par type de prop visible. */
  private rebuildInstances(): void {
    this.clearMeshes();
    this.dirty = false;
    this.visibleCountValue = 0;
    const byKind = new Map<TownPropKind, PropPlacement[]>();
    for (const placement of this.placements) {
      const town = this.towns.get(placement.townId);
      if (!town || !town.near) continue;
      const bucket = byKind.get(placement.kind);
      if (bucket) bucket.push(placement);
      else byKind.set(placement.kind, [placement]);
    }
    for (const [kind, placements] of byKind) {
      const geometry = this.geometryFor(kind);
      const mesh = new THREE.InstancedMesh(geometry, this.material, placements.length);
      mesh.name = `town-prop-${kind}`;
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      for (let index = 0; index < placements.length; index += 1) {
        const placement = placements[index];
        if (!placement) continue;
        this.position.set(placement.x, placement.ground, placement.z);
        this.quaternion.setFromAxisAngle(this.yawAxis, placement.yaw);
        this.scale.setScalar(placement.scale);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        mesh.setMatrixAt(index, this.matrix);
        this.colour.setRGB(placement.tintR, placement.tintG, placement.tintB);
        mesh.setColorAt(index, this.colour);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.visibleCountValue += placements.length;
    }
  }

  private geometryFor(kind: TownPropKind): THREE.BufferGeometry {
    const key = `${kind}:${this.detail}`;
    const cached = this.geometryCache.get(key);
    if (cached) return cached;
    const geometry = createTownPropGeometry(kind, this.detail);
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  /** 0 = jour, 1 = nuit profonde : allume lampadaires et vitrines. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightLights ? this.nightAmount : 0;
  }

  get night(): number {
    return this.nightAmount;
  }

  setNightLights(enabled: boolean): void {
    this.nightLights = enabled;
    this.nightUniform.value = enabled ? this.nightAmount : 0;
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const mesh of this.meshes) mesh.castShadow = enabled;
  }

  /** Nombre total de props semés, toutes villes confondues. */
  get propCount(): number {
    return this.placements.length;
  }

  /** Props effectivement instanciés (villes proches). */
  get visibleCount(): number {
    return this.visibleCountValue;
  }

  get kindCount(): number {
    return new Set(this.placements.map((placement) => placement.kind)).size;
  }

  get drawCallCount(): number {
    return this.meshes.length;
  }

  get triangleCount(): number {
    let total = 0;
    for (const mesh of this.meshes) {
      const position = mesh.geometry.getAttribute('position');
      total += ((position?.count ?? 0) / 3) * mesh.count;
    }
    return total;
  }

  /** Nombre de villes dont les props sont masqués (LOD). */
  get distantTownCount(): number {
    let total = 0;
    for (const town of this.towns.values()) if (!town.near) total += 1;
    return total;
  }

  /** Placements, pour les tests et le diagnostic. */
  get placementsSnapshot(): readonly PropPlacement[] {
    return this.placements;
  }

  get surfaceMaterial(): THREE.MeshStandardMaterial {
    return this.material;
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes = [];
    this.visibleCountValue = 0;
  }

  private clearInstances(): void {
    this.clearMeshes();
    this.placements = [];
  }

  dispose(): void {
    this.clearInstances();
    this.towns.clear();
    for (const geometry of this.geometryCache.values()) geometry.dispose();
    this.geometryCache.clear();
    this.group.clear();
    this.material.dispose();
    this.map = null;
    this.townSnapshots = [];
    this.signature = 0;
    this.builds = 0;
    this.lodSwitches = 0;
    this.builtLevel = null;
    this.dirty = true;
  }
}

/**
 * Semis déterministe d'une ville.
 *
 * Le centre reçoit plutôt des placettes et des bancs, les abords des jardins
 * et des clôtures, les tuiles de voirie des lampadaires et des panneaux. Un
 * prop au maximum par tuile, jamais sur un bâtiment ni sur l'asphalte.
 */
export function generateTownProps(
  town: TownSnapshot,
  map: MapSnapshot,
  limit: number,
): PropPlacement[] {
  const centreX = Math.floor(town.x);
  const centreY = Math.floor(town.y);
  const rng = new Prng(town.id * 7919 + map.width * 17 + map.height * 31 + 0x5171);
  const candidates: CandidateTile[] = [];
  const kerbs: CandidateTile[] = [];
  for (let dy = -PROPS_RADIUS; dy <= PROPS_RADIUS; dy += 1) {
    for (let dx = -PROPS_RADIUS; dx <= PROPS_RADIUS; dx += 1) {
      const distance = Math.hypot(dx, dy);
      if (distance > PROPS_RADIUS) continue;
      const x = centreX + dx;
      const y = centreY + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const kind = map.kind[y * map.width + x] ?? 0;
      if (kind === TILE_KIND_INDEX.road) {
        // Les lampadaires se posent au coin de la tuile de voirie, hors de la
        // chaussée (demi-largeur 0,34) et de la bordure : jamais sur l'asphalte.
        // Une rue noyée par une nappe voisine ne reçoit aucun mobilier.
        if (isWaterloggedPropTile(map, x, y)) continue;
        if (hashUnit2d(town.id * 29 + 3, x + 1, y + 5) > 0.42) {
          kerbs.push({ x, y, freeNeighbours: 0, roadX: 0, roadY: 0, nearRoad: true });
        }
        continue;
      }
      if (!FREE_KINDS.has(kind)) continue;
      if (isWaterloggedPropTile(map, x, y)) continue;
      let freeNeighbours = 0;
      let roadX = 0;
      let roadY = 0;
      let nearRoad = false;
      for (const [nx, ny] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const wx = x + nx;
        const wy = y + ny;
        if (wx < 0 || wy < 0 || wx >= map.width || wy >= map.height) continue;
        const neighbour = map.kind[wy * map.width + wx] ?? 0;
        if (FREE_KINDS.has(neighbour)) freeNeighbours += 1;
        else if (ROAD_KINDS.has(neighbour)) {
          nearRoad = true;
          roadX = nx;
          roadY = ny;
        }
      }
      candidates.push({ x, y, freeNeighbours, roadX, roadY, nearRoad });
    }
  }
  if (candidates.length === 0) return [];

  const placements: PropPlacement[] = [];
  const used = new Set<number>();

  // 1. Placette : un bloc 2×2 libre près du centre devient un petit parvis.
  const plaza = findPlaza(candidates, map, centreX, centreY);
  if (plaza) {
    for (const tile of plaza) {
      if (placements.length >= limit) break;
      const placement = makePlacement(town, map, tile, 'plaza', rng, 1.04);
      if (!propFootAboveWater(map, placement.x, placement.z, placement.ground)) continue;
      used.add(tile.y * map.width + tile.x);
      placements.push(placement);
    }
  }

  // 2. Lampadaires et panneaux le long des rues, au coin des tuiles de voirie.
  const kerbBudget = Math.max(4, Math.floor(limit * 0.5));
  let kerbCount = 0;
  for (const tile of kerbs) {
    if (placements.length >= limit || kerbCount >= kerbBudget) break;
    const roll = hashUnit2d(town.id * 71 + 13, tile.x + 9, tile.y + 3);
    const kind: TownPropKind = roll < 0.78 ? 'lamp' : 'sign';
    const placement = makeKerbPlacement(town, map, tile, kind, rng);
    if (!propFootAboveWater(map, placement.x, placement.z, placement.ground)) continue;
    placements.push(placement);
    kerbCount += 1;
  }

  // 3. Mobilier dans les îlots libres (jardins, bancs, arbres, clôtures).
  for (const tile of candidates) {
    if (placements.length >= limit) break;
    const key = tile.y * map.width + tile.x;
    if (used.has(key)) continue;
    used.add(key);
    const roll = hashUnit2d(town.id * 37 + 5, tile.x + 3, tile.y + 11);
    let kind: TownPropKind;
    if (tile.nearRoad) {
      if (roll < 0.34) kind = 'lamp';
      else if (roll < 0.5) kind = 'bench';
      else if (roll < 0.6) kind = 'sign';
      else if (roll < 0.68) kind = 'busStop';
      else if (roll < 0.84) kind = 'tree';
      else kind = 'garden';
    } else if (tile.freeNeighbours >= 3) {
      if (roll < 0.38) kind = 'tree';
      else if (roll < 0.66) kind = 'garden';
      else if (roll < 0.8) kind = 'bench';
      else kind = 'fence';
    } else {
      if (roll < 0.46) kind = 'tree';
      else if (roll < 0.68) kind = 'fence';
      else if (roll < 0.82) kind = 'garden';
      else kind = 'sign';
    }
    const placement = makePlacement(town, map, tile, kind, rng, 1);
    if (!propFootAboveWater(map, placement.x, placement.z, placement.ground)) continue;
    placements.push(placement);
  }
  return placements;
}

/** Cherche un bloc 2×2 libre proche du centre, sans jamais chevaucher la voirie. */
function findPlaza(
  candidates: readonly CandidateTile[],
  map: MapSnapshot,
  centreX: number,
  centreY: number,
): CandidateTile[] | null {
  const byKey = new Map<number, CandidateTile>();
  for (const tile of candidates) byKey.set(tile.y * map.width + tile.x, tile);
  let best: CandidateTile[] | null = null;
  let bestDistance = Infinity;
  for (const tile of candidates) {
    if (!tile.nearRoad) continue;
    const block = [
      tile,
      byKey.get(tile.y * map.width + tile.x + 1),
      byKey.get((tile.y + 1) * map.width + tile.x),
      byKey.get((tile.y + 1) * map.width + tile.x + 1),
    ];
    if (block.some((entry) => entry === undefined)) continue;
    const distance = Math.hypot(tile.x + 0.5 - centreX, tile.y + 0.5 - centreY);
    if (distance < bestDistance && distance <= PROPS_RADIUS * 0.6) {
      bestDistance = distance;
      best = block as CandidateTile[];
    }
  }
  return best;
}

function propPalette(town: TownSnapshot, tile: CandidateTile, rng: Prng): [number, number, number] {
  const palette = PROP_PALETTES[
    Math.floor(hashUnit2d(town.id * 53 + 9, tile.x + 7, tile.y + 5) * PROP_PALETTES.length)
  ] ?? [1, 1, 1];
  const tint = rng.float(0.94, 1.04);
  return [palette[0] * tint, palette[1] * tint, palette[2] * tint];
}

function makePlacement(
  town: TownSnapshot,
  map: MapSnapshot,
  tile: CandidateTile,
  kind: TownPropKind,
  rng: Prng,
  scaleBase: number,
): PropPlacement {
  // Un lampadaire ou un panneau se cale vers la chaussée ; l'arrêt de bus est
  // un petit édicule et reste centré sur sa tuile. Les autres props reçoivent
  // un léger jitter déterministe, toujours ramené dans l'empreinte.
  const streetFurniture = kind === 'lamp' || kind === 'sign';
  const fixedOnTile = kind === 'plaza' || kind === 'busStop';
  const offset = streetFurniture ? 0.3 : 0;
  const jitterX = fixedOnTile ? 0 : (rng.float(0, 1) - 0.5) * 0.2;
  const jitterZ = fixedOnTile ? 0 : (rng.float(0, 1) - 0.5) * 0.2;
  // Les lampadaires et panneaux regardent la route.
  const yaw = streetFurniture
    ? Math.atan2(tile.roadX, tile.roadY) + Math.PI / 2
    : rng.int(0, 3) * (Math.PI / 2) + (kind === 'plaza' ? 0 : rng.float(-0.12, 0.12));
  const tint = propPalette(town, tile, rng);
  const scale = (kind === 'plaza' ? 1 : rng.float(0.9, 1.08)) * scaleBase;
  const extent = rotatedPropExtent(kind, yaw, scale);
  const x = clampToTile(tile.x + 0.5 + jitterX + tile.roadX * offset, tile.x, extent.x);
  const z = clampToTile(tile.y + 0.5 + jitterZ + tile.roadY * offset, tile.y, extent.z);
  const ground = groundForTile(map, tile, x, z);
  return {
    townId: town.id,
    kind,
    x,
    z,
    ground,
    yaw,
    scale,
    tintR: tint[0],
    tintG: tint[1],
    tintB: tint[2],
  };
}

const PROP_EXTENT_CACHE = new Map<TownPropKind, { x: number; z: number }>();

/**
 * Demi-empreinte locale d'un prop (au détail maximal, donc majorante), pour
 * garantir qu'aucun meuble ne déborde de sa tuile après rotation.
 */
function propHalfExtent(kind: TownPropKind): { x: number; z: number } {
  const cached = PROP_EXTENT_CACHE.get(kind);
  if (cached) return cached;
  const geometry = createTownPropGeometry(kind, 2);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const extent = {
    x: Math.max(Math.abs(box?.min.x ?? 0), Math.abs(box?.max.x ?? 0)),
    z: Math.max(Math.abs(box?.min.z ?? 0), Math.abs(box?.max.z ?? 0)),
  };
  geometry.dispose();
  PROP_EXTENT_CACHE.set(kind, extent);
  return extent;
}

/** Empreinte d'un prop tourné, projetée sur les axes de la tuile. */
function rotatedPropExtent(
  kind: TownPropKind,
  yaw: number,
  scale: number,
): { x: number; z: number } {
  const half = propHalfExtent(kind);
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  return {
    x: (half.x * cos + half.z * sin) * scale,
    z: (half.x * sin + half.z * cos) * scale,
  };
}

/** Garde le centre d'un prop à distance de l'arête de sa tuile. */
function clampToTile(value: number, tile: number, halfExtent: number): number {
  const margin = 0.005;
  const low = tile + halfExtent + margin;
  const high = tile + 1 - halfExtent - margin;
  if (low > high) return tile + 0.5;
  return Math.max(low, Math.min(high, value));
}

/**
 * Lampadaire ou panneau au coin d'une tuile de voirie, hors chaussée.
 *
 * La chaussée occupe 0,34 de demi-largeur et la bordure s'arrête à ~0,38 : un
 * pied posé à 0,42 du centre reste sur le trottoir, jamais sur l'asphalte.
 */
function makeKerbPlacement(
  town: TownSnapshot,
  map: MapSnapshot,
  tile: CandidateTile,
  kind: TownPropKind,
  rng: Prng,
): PropPlacement {
  const signX = hashUnit2d(town.id * 43 + 7, tile.x + 2, tile.y + 6) > 0.5 ? 1 : -1;
  const signZ = hashUnit2d(town.id * 61 + 5, tile.x + 8, tile.y + 4) > 0.5 ? 1 : -1;
  const x = tile.x + 0.5 + signX * 0.42;
  const z = tile.y + 0.5 + signZ * 0.42;
  const ground = groundForTile(map, tile, x, z);
  const tint = propPalette(town, tile, rng);
  // La tête du lampadaire pointe vers le centre de la chaussée.
  const yaw = Math.atan2(signZ, -signX);
  return {
    townId: town.id,
    kind,
    x,
    z,
    ground,
    yaw,
    scale: rng.float(0.94, 1.04),
    tintR: tint[0],
    tintG: tint[1],
    tintB: tint[2],
  };
}

/** Hauteur du sol sous un prop : jamais au-dessus du coin le plus bas. */
function groundForTile(map: MapSnapshot, tile: CandidateTile, x: number, z: number): number {
  const corner = Math.min(
    cornerHeightWorld(map, tile.x, tile.y),
    cornerHeightWorld(map, tile.x + 1, tile.y),
    cornerHeightWorld(map, tile.x, tile.y + 1),
    cornerHeightWorld(map, tile.x + 1, tile.y + 1),
  );
  return Math.max(corner, sampleHeightWorld(map, x, z) - 0.015);
}

/**
 * Empreinte FNV des villes, des tuiles libres et de leurs hauteurs : les
 * placements en dérivent entièrement.
 */
export function computeTownPropsSignature(
  towns: readonly TownSnapshot[],
  map: MapSnapshot,
  level: QualityLevel,
): number {
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ (value | 0), 0x01000193) >>> 0;
  };
  mix(map.width);
  mix(map.height);
  for (let index = 0; index < level.length; index += 1) mix(level.charCodeAt(index));
  mix(towns.length);
  const radius = PROPS_RADIUS + 1;
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
        const kind = map.kind[index] ?? 0;
        mix(kind);
        mix(map.heightMap[index] ?? 0);
        mix(map.flags[index] ?? 0);
      }
    }
  }
  return hash >>> 0;
}

/** Exposé pour les tests : vrai si la tuile interdit tout prop. */
export function isPropFreeKind(index: number): boolean {
  return FREE_KINDS.has(index);
}

/** Exposé pour les tests : vrai si la tuile est une route. */
export function isRoadKind(index: number): boolean {
  return ROAD_KINDS.has(index);
}
