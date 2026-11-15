/**
 * Décor continu hors des limites jouables : jupe de terrain, océan et îles.
 *
 * Ce module ne dépend pas de Three.js : il produit des descriptions de
 * géométrie et des couleurs linéaires, testables sous Node. `SurroundingsLayer`
 * se contente de les téléverser. Rien ici ne modifie la carte jouable : les
 * hauteurs sont échantillonnées en lecture seule et les coordonnées restent
 * hors de `[0, width] × [0, height]`.
 *
 * La jupe reprend exactement la hauteur et la couleur des tuiles de bord au
 * raccord (`d = 0`), puis descend vers le lit océanique. Le profil démarre avec
 * une pente nulle : les normales de bord restent donc identiques à celles du
 * terrain, ce qui évite toute couture d'éclairage.
 */

import type { MapSnapshot } from '../engine/protocol';
import { clamp, sampleHeightWorld, tileKindFromIndex, tileIndex } from '../game/mapGrid';
import { Prng, StateHash, hashUnit2d, valueNoise } from '../game/prng';
import { qualitySettings, type QualityLevel } from './quality';
import {
  TERRAIN_SKIN_COLOURS,
  hexToLinearRgb,
  mixColour,
  rgbToHex,
  smoothstep01,
  tileColour,
  type Rgb,
} from './tileVisuals';
import {
  WATER_LEVEL_OFFSET,
  sampleField,
  waterDepthFactor,
  type ShoreFields,
} from './waterSurface';

/** Niveau de l'eau (identique aux tuiles d'eau du terrain). */
export const SEA_LEVEL = WATER_LEVEL_OFFSET;

/** Lit visé au bout de la jupe, sous le niveau de la mer. */
export const SKIRT_SEABED = -1.8;

/** Graine stable du décor lointain. */
export const SURROUNDINGS_SEED = 0x174c0de;

/**
 * Budgets par preset.
 *
 * - `skirtMargin` : largeur de la jupe en tuiles (prolongement des bords) ;
 * - `plateau` : portion plate au raccord (pente nulle = normales identiques) ;
 * - `coastalBand` : largeur de la bande d'eau détaillée autour de la carte
 *   (0 = océan simple, cas de la basse qualité) ;
 * - `islands` : nombre d'îles lointaines fusionnées en un seul mesh.
 */
export interface SurroundingsBudget {
  skirtMargin: number;
  plateau: number;
  coastalBand: number;
  islands: number;
}

export const SURROUNDINGS_BUDGETS: Record<QualityLevel, SurroundingsBudget> = {
  low: { skirtMargin: 5, plateau: 1, coastalBand: 0, islands: 0 },
  medium: { skirtMargin: 16, plateau: 1, coastalBand: 18, islands: 4 },
  high: { skirtMargin: 22, plateau: 1, coastalBand: 24, islands: 7 },
};

export function surroundingsBudget(level: QualityLevel): SurroundingsBudget {
  return SURROUNDINGS_BUDGETS[level] ?? SURROUNDINGS_BUDGETS.medium;
}

/**
 * Distance euclidienne hors du rectangle jouable, 0 à l'intérieur.
 *
 * La distance euclidienne (et non L∞) arrondit les coins de la jupe : la
 * limite terre/eau ne suit plus un carré parfait.
 */
export function distanceOutsideMap(map: MapSnapshot, x: number, z: number): number {
  const dx = x < 0 ? -x : x > map.width ? x - map.width : 0;
  const dz = z < 0 ? -z : z > map.height ? z - map.height : 0;
  return Math.hypot(dx, dz);
}

/** Signature des bords : toute modification visible sur la jupe la change. */
export function layoutSignature(map: MapSnapshot): string {
  const hash = new StateHash().mixInt(map.width).mixInt(map.height);
  const mixTile = (x: number, y: number): void => {
    const index = tileIndex(x, y, map.width);
    hash
      .mixInt(map.kind[index] ?? 0)
      .mixInt(map.heightMap[index] ?? 0)
      .mixInt(map.slope[index] ?? 0);
  };
  for (let x = 0; x < map.width; x += 1) {
    mixTile(x, 0);
    mixTile(x, map.height - 1);
  }
  for (let y = 0; y < map.height; y += 1) {
    mixTile(0, y);
    mixTile(map.width - 1, y);
  }
  return hash.digest();
}

/** Signature des types de tuiles : elle pilote les champs de distance à terre. */
export function shoreSignature(map: MapSnapshot): string {
  const hash = new StateHash().mixInt(map.width).mixInt(map.height);
  for (let index = 0; index < map.kind.length; index += 1) {
    hash.mixInt(map.kind[index] ?? 0);
  }
  return hash.digest();
}

/**
 * Hauteur de la jupe à une coordonnée hors carte.
 *
 * À `d = 0`, la valeur est exactement `sampleHeightWorld` : le raccord est donc
 * parfait. Le profil est plat sur `plateau` tuiles, puis rejoint le lit avec une
 * pente nulle aux deux extrémités (`smoothstep`).
 */
export function surroundingHeight(
  map: MapSnapshot,
  x: number,
  z: number,
  budget: SurroundingsBudget = SURROUNDINGS_BUDGETS.medium,
): number {
  const distance = distanceOutsideMap(map, x, z);
  if (distance <= 0) return sampleHeightWorld(map, x, z);
  const edgeX = clamp(x, 0, map.width);
  const edgeZ = clamp(z, 0, map.height);
  const edge = sampleHeightWorld(map, edgeX, edgeZ);
  const margin = Math.max(budget.plateau + 0.001, budget.skirtMargin);
  const clamped = Math.min(distance, margin);
  const t = smoothstep01(budget.plateau, margin, clamped);
  // Relief côtier : un bruit doux, nul au raccord et au lit, décale la ligne
  // d'eau le long des bords pour casser la régularité du rectangle.
  const relief =
    clamped <= budget.plateau
      ? 0
      : Math.sin((Math.PI * (clamped - budget.plateau)) / Math.max(0.001, margin - budget.plateau));
  const wobble =
    (valueNoise(SURROUNDINGS_SEED, x * 0.12, z * 0.12) - 0.5) * 2.2 +
    (valueNoise(SURROUNDINGS_SEED + 0x51, x * 0.045, z * 0.045) - 0.5) * 1.8;
  const amplitude = Math.min(3.4, 1.1 + (edge + 1.8) * 0.24);
  const base = edge + (SKIRT_SEABED - edge) * t;
  // Le bruit décale la ligne d'eau, mais ne crée pas d'îlots détachés au
  // large : sous la mer, son amplitude est fortement réduite et plafonnée.
  const gain = base < SEA_LEVEL ? 0.3 : 1;
  let height = base + wobble * amplitude * relief * gain;
  if (base < SEA_LEVEL - 0.6) height = Math.min(height, SEA_LEVEL - 0.15);
  return Math.max(SKIRT_SEABED, Math.min(edge + 2.5, height));
}

/**
 * Couleur linéaire d'un sommet de jupe.
 *
 * Le raccord reprend la couleur interpolée du terrain (conversion linéaire par
 * tuile *avant* le bilinéaire, comme `TerrainLayer`). Les teintes de sable et
 * de lit n'apparaissent qu'à partir de `d > 0` : à `d = 0` la couleur est donc
 * rigoureusement celle du terrain.
 */
const SAND_LINEAR = hexToLinearRgb(TERRAIN_SKIN_COLOURS.sand);
const WET_SAND_LINEAR = hexToLinearRgb(TERRAIN_SKIN_COLOURS.wetSand);
const BED_SHALLOW_LINEAR = hexToLinearRgb(TERRAIN_SKIN_COLOURS.bedShallow);
const BED_DEEP_LINEAR = hexToLinearRgb(TERRAIN_SKIN_COLOURS.bedDeep);
const DRY_GRASS_LINEAR = hexToLinearRgb(TERRAIN_SKIN_COLOURS.dryGrass);

function mixLinear(out: Rgb, target: Rgb, amount: number): void {
  const t = Math.max(0, Math.min(1, amount));
  out.r += (target.r - out.r) * t;
  out.g += (target.g - out.g) * t;
  out.b += (target.b - out.b) * t;
}

const tileRgb = { r: 0, g: 0, b: 0 };

/** Couleur linéaire d'une tuile, avec la même variation que `TerrainLayer`. */
function tileColourLinear(map: MapSnapshot, tileX: number, tileY: number, out: Rgb): void {
  const x = clamp(tileX, 0, map.width - 1);
  const y = clamp(tileY, 0, map.height - 1);
  const index = tileIndex(x, y, map.width);
  const kind = tileKindFromIndex(map.kind[index] ?? 0);
  const level = map.heightMap[index] ?? 0;
  const slope = map.slope[index] ?? 0;
  const colour = tileColour(kind, level, slope, map.width);
  const shade = 0.986 + hashUnit2d(map.width + 7, x, y) * 0.028;
  hexToLinearRgb(
    rgbToHex(
      ((colour >> 16) & 0xff) * shade,
      ((colour >> 8) & 0xff) * shade,
      (colour & 0xff) * shade,
    ),
    out,
  );
}

/** Couleur interpolée du terrain à un sommet de grille (indices bornés). */
export function terrainColourLinear(map: MapSnapshot, x: number, z: number, out: Rgb): Rgb {
  const fx = x - 0.5;
  const fz = z - 0.5;
  const cellX = Math.floor(fx);
  const cellZ = Math.floor(fz);
  const tx = fx - cellX;
  const tz = fz - cellZ;

  const x0 = clamp(cellX, 0, map.width - 1);
  const x1 = clamp(cellX + 1, 0, map.width - 1);
  const z0 = clamp(cellZ, 0, map.height - 1);
  const z1 = clamp(cellZ + 1, 0, map.height - 1);

  tileColourLinear(map, x0, z0, tileRgb);
  const r00 = tileRgb.r;
  const g00 = tileRgb.g;
  const b00 = tileRgb.b;
  tileColourLinear(map, x1, z0, tileRgb);
  const r10 = tileRgb.r;
  const g10 = tileRgb.g;
  const b10 = tileRgb.b;
  tileColourLinear(map, x0, z1, tileRgb);
  const r01 = tileRgb.r;
  const g01 = tileRgb.g;
  const b01 = tileRgb.b;
  tileColourLinear(map, x1, z1, tileRgb);
  const r11 = tileRgb.r;
  const g11 = tileRgb.g;
  const b11 = tileRgb.b;

  const topR = r00 + (r10 - r00) * tx;
  const topG = g00 + (g10 - g00) * tx;
  const topB = b00 + (b10 - b00) * tx;
  const bottomR = r01 + (r11 - r01) * tx;
  const bottomG = g01 + (g11 - g01) * tx;
  const bottomB = b01 + (b11 - b01) * tx;
  out.r = topR + (bottomR - topR) * tz;
  out.g = topG + (bottomG - topG) * tz;
  out.b = topB + (bottomB - topB) * tz;
  return out;
}

/** Couleur finale d'un sommet de jupe (sable, eau, lit). */
export function surroundingColourLinear(
  map: MapSnapshot,
  x: number,
  z: number,
  budget: SurroundingsBudget,
  out: Rgb,
): Rgb {
  terrainColourLinear(map, x, z, out);
  const distance = distanceOutsideMap(map, x, z);
  if (distance <= 0) return out;
  const height = surroundingHeight(map, x, z, budget);
  const near = smoothstep01(0, 0.9, distance);

  // Plage : sable clair puis sable mouillé au contact de l'eau.
  const sand = smoothstep01(SEA_LEVEL + 2.2, SEA_LEVEL + 0.05, height) * near;
  mixLinear(out, SAND_LINEAR, sand * 0.82);
  const wet = smoothstep01(SEA_LEVEL + 0.5, SEA_LEVEL - 0.15, height) * near;
  mixLinear(out, WET_SAND_LINEAR, wet * 0.45);

  // Lit sous l'eau : passe du sableux au bleu profond avec la profondeur.
  const submerged = smoothstep01(SEA_LEVEL + 0.1, SEA_LEVEL - 0.65, height) * near;
  mixLinear(out, BED_SHALLOW_LINEAR, submerged * 0.55);
  const deep = smoothstep01(SEA_LEVEL - 0.5, SEA_LEVEL - 1.7, height);
  mixLinear(out, BED_DEEP_LINEAR, deep * 0.7);

  // Herbe sèche sur les replats exposés, très discrète.
  const dry =
    smoothstep01(2.5, 4.5, distance) *
    (1 - sand) *
    smoothstep01(SEA_LEVEL + 0.8, SEA_LEVEL + 3.5, height);
  mixLinear(out, DRY_GRASS_LINEAR, dry * 0.1);
  return out;
}

/**
 * Normale d'un sommet de jupe, par différences finies.
 *
 * L'échantillonnage intérieur reste celui de la carte : au bord, la dérivée
 * sortante est nulle (plateau), exactement comme la couronne bornée de
 * `TerrainLayer`. Les normales se raccordent donc sans cassure.
 */
export function surroundingNormal(
  map: MapSnapshot,
  x: number,
  z: number,
  budget: SurroundingsBudget,
  out: Rgb = { r: 0, g: 0, b: 0 },
): Rgb {
  const step = 1;
  const left = surroundingHeight(map, x - step, z, budget);
  const right = surroundingHeight(map, x + step, z, budget);
  const up = surroundingHeight(map, x, z - step, budget);
  const down = surroundingHeight(map, x, z + step, budget);
  const nx = -(right - left) / (2 * step);
  const nz = -(down - up) / (2 * step);
  const length = Math.hypot(nx, 1, nz) || 1;
  out.r = nx / length;
  out.g = 1 / length;
  out.b = nz / length;
  return out;
}

/** Distance à la terre utilisée pour teinter la bande côtière. */
export function surroundingWaterDepth(
  map: MapSnapshot,
  fields: ShoreFields,
  x: number,
  z: number,
  budget: SurroundingsBudget = SURROUNDINGS_BUDGETS.medium,
): number {
  const edgeDistance = sampleField(
    fields.waterDistance,
    map.width,
    map.height,
    clamp(x, 0, map.width),
    clamp(z, 0, map.height),
  );
  const distance = distanceOutsideMap(map, x, z);
  // Profondeur « carte » : continue avec l'eau jouable au bord.
  const mapDepth = waterDepthFactor(edgeDistance + distance);
  // Profondeur du lit de la jupe : la vraie ligne d'eau est celle où le
  // terrain hors carte passe sous la mer, pas le rectangle jouable.
  const bedDepth = smoothstep01(0.05, 1.4, SEA_LEVEL - surroundingHeight(map, x, z, budget));
  return Math.max(mapDepth, bedDepth);
}

export interface RingGrid {
  /** Coordonnées X de chaque sommet. */
  xs: number[];
  /** Coordonnées Z de chaque sommet. */
  zs: number[];
  /** Positions `[x, y, z]` aplaties. */
  positions: number[];
  indices: number[];
  triangles: number;
}

function buildRingGrid(
  width: number,
  height: number,
  margin: number,
  heightAt: (x: number, z: number) => number,
): RingGrid {
  const xs: number[] = [];
  const zs: number[] = [];
  const positions: number[] = [];
  const indices: number[] = [];
  const stride = width + margin * 2 + 1;
  const vertices = new Map<number, number>();

  const addVertex = (x: number, z: number): number => {
    const key = (z + margin) * stride + (x + margin);
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = xs.length;
    vertices.set(key, index);
    xs.push(x);
    zs.push(z);
    positions.push(x, heightAt(x, z), z);
    return index;
  };

  for (let z = -margin; z < height + margin; z += 1) {
    for (let x = -margin; x < width + margin; x += 1) {
      // Cellule entièrement couverte par le terrain jouable : rien à ajouter.
      if (x >= 0 && z >= 0 && x + 1 <= width && z + 1 <= height) continue;
      const a = addVertex(x, z);
      const b = addVertex(x + 1, z);
      const c = addVertex(x, z + 1);
      const d = addVertex(x + 1, z + 1);
      // Même diagonale et même sens que TerrainLayer (normale +Y).
      indices.push(a, d, b, a, c, d);
    }
  }

  return { xs, zs, positions, indices, triangles: indices.length / 3 };
}

/** Grille de la jupe de terrain autour de la carte. */
export function buildSkirtGrid(map: MapSnapshot, budget: SurroundingsBudget): RingGrid {
  return buildRingGrid(map.width, map.height, budget.skirtMargin, (x, z) =>
    surroundingHeight(map, x, z, budget),
  );
}

/** Demi-extension du fond océanique : couvre tout le frustum visible. */
export function oceanOuterHalf(map: MapSnapshot, level: QualityLevel): number {
  const settings = qualitySettings(level);
  const span = Math.max(map.width, map.height);
  return span * 0.5 + settings.drawDistance * 1.4;
}

/**
 * Grille de l'océan : une seule surface continue du bord de la carte au large.
 *
 * La bande côtière (largeur `coastalBand`) est échantillonnée au pas d'une
 * tuile pour que la houle et la profondeur se raccordent exactement à l'eau de
 * la carte. Au-delà, les lignes s'espacent progressivement : le large ne coûte
 * que quelques centaines de triangles, sans arête ni changement de matériau.
 */
export function buildOceanGrid(map: MapSnapshot, level: QualityLevel): RingGrid {
  const budget = surroundingsBudget(level);
  const band = budget.coastalBand;
  const outer = oceanOuterHalf(map, level);
  const centreX = map.width / 2;
  const centreZ = map.height / 2;
  const innerMinX = -band;
  const innerMaxX = map.width + band;
  const innerMinZ = -band;
  const innerMaxZ = map.height + band;

  const axis = (min: number, innerMin: number, innerMax: number, max: number): number[] => {
    const values: number[] = [];
    const push = (value: number): void => {
      const last = values[values.length - 1];
      if (last === undefined || Math.abs(value - last) > 1e-6) values.push(value);
    };
    const before: number[] = [];
    let step = 12;
    let cursor = innerMin;
    while (cursor > min + 1e-6) {
      cursor = Math.max(min, cursor - step);
      before.push(cursor);
      step = Math.min(step * 2, 160);
    }
    before.reverse();
    for (const value of before) push(value);
    if (band <= 0) {
      // Océan simple : aucun raccord de houle à respecter, grille grossière.
      for (let value = innerMin; value < innerMax; value += 8) push(value);
      push(innerMax);
    } else {
      for (let value = innerMin; value <= innerMax + 1e-6; value += 1) push(value);
    }
    let after = innerMax;
    step = 12;
    while (after < max - 1e-6) {
      after = Math.min(max, after + step);
      push(after);
      step = Math.min(step * 2, 160);
    }
    return values;
  };

  const xs = axis(centreX - outer, innerMinX, innerMaxX, centreX + outer);
  const zs = axis(centreZ - outer, innerMinZ, innerMaxZ, centreZ + outer);
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexXs: number[] = [];
  const vertexZs: number[] = [];
  const vertices = new Map<number, number>();
  const stride = zs.length;

  const addVertex = (ix: number, iz: number): number => {
    const key = iz * stride + ix;
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    vertices.set(key, index);
    const x = xs[ix] ?? 0;
    const z = zs[iz] ?? 0;
    vertexXs.push(x);
    vertexZs.push(z);
    positions.push(x, SEA_LEVEL, z);
    return index;
  };

  for (let iz = 0; iz < zs.length - 1; iz += 1) {
    const z = zs[iz] ?? 0;
    const nextZ = zs[iz + 1] ?? z;
    for (let ix = 0; ix < xs.length - 1; ix += 1) {
      const x = xs[ix] ?? 0;
      const nextX = xs[ix + 1] ?? x;
      // Cellule entièrement couverte par la carte jouable : rien à dessiner.
      if (x >= 0 && z >= 0 && nextX <= map.width && nextZ <= map.height) continue;
      const a = addVertex(ix, iz);
      const b = addVertex(ix + 1, iz);
      const c = addVertex(ix, iz + 1);
      const d = addVertex(ix + 1, iz + 1);
      indices.push(a, d, b, a, c, d);
    }
  }

  return { xs: vertexXs, zs: vertexZs, positions, indices, triangles: indices.length / 3 };
}

export interface IslandPlan {
  x: number;
  z: number;
  radius: number;
  height: number;
  seed: number;
}

/** Îles lointaines déterministes, placées au-delà de la jupe. */
export function islandPlan(map: MapSnapshot, level: QualityLevel): IslandPlan[] {
  const budget = surroundingsBudget(level);
  if (budget.islands <= 0) return [];
  const settings = qualitySettings(level);
  const span = Math.max(map.width, map.height);
  const centreX = map.width / 2;
  const centreZ = map.height / 2;
  const prng = new Prng(
    (SURROUNDINGS_SEED ^ Math.imul(map.width, 73856093) ^ Math.imul(map.height, 19349663)) >>> 0,
  );
  const minRadius = span * 0.5 + budget.skirtMargin + 42;
  const spread = Math.min(settings.drawDistance * 0.5, span * 0.5 + 140);
  const islands: IslandPlan[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let index = 0; index < budget.islands; index += 1) {
    const angle = index * golden + prng.float(-0.18, 0.18);
    const distance = minRadius + prng.float(0, Math.max(1, spread));
    const radius = Math.min(
      prng.float(3.6, 5.5) + span * 0.012,
      Math.max(2, distance - (span * 0.5 + budget.skirtMargin + 18)),
    );
    const height = radius * prng.float(0.35, 0.72) + prng.float(0.4, 1.6);
    islands.push({
      x: centreX + Math.cos(angle) * distance,
      z: centreZ + Math.sin(angle) * distance,
      radius,
      height,
      seed: prng.nextUint32(),
    });
  }
  return islands;
}

export interface IslandMeshData {
  positions: number[];
  colours: number[];
  indices: number[];
  triangles: number;
}

/**
 * Géométrie fusionnée des îles (un seul mesh, un seul draw call).
 *
 * Anneaux concentriques irréguliers : sable au ras de l'eau, herbe tempérée,
 * roche sommitale. Aucune texture, aucune allocation par frame.
 */
export function buildIslandMesh(map: MapSnapshot, level: QualityLevel): IslandMeshData {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const sand = TERRAIN_SKIN_COLOURS.wetSand;
  const grass = 0x4f6b45;
  const rough = 0x5c6448;
  const rock = 0x5a5c52;
  const segments = 12;
  const rings = [
    { radius: 1, fraction: 0, y: SEA_LEVEL - 1.6, tint: sand, shade: 0 },
    { radius: 0.85, fraction: 0, y: SEA_LEVEL + 0.06, tint: sand, shade: 0.1 },
    { radius: 0.58, fraction: 0.24, y: 0, tint: grass, shade: 0.12 },
    { radius: 0.28, fraction: 0.62, y: 0, tint: rough, shade: 0.18 },
  ];

  for (const island of islandPlan(map, level)) {
    const prng = new Prng(island.seed);
    const ringStarts: number[][] = [];
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const ring = rings[ringIndex];
      if (!ring) continue;
      const start = positions.length / 3;
      const row: number[] = [];
      for (let segment = 0; segment < segments; segment += 1) {
        const angle = (segment / segments) * Math.PI * 2;
        const jitter = 0.82 + prng.next() * 0.36;
        const radius = island.radius * ring.radius * jitter;
        const x = island.x + Math.cos(angle) * radius;
        const z = island.z + Math.sin(angle) * radius;
        const baseY = ring.fraction > 0 ? SEA_LEVEL + island.height * ring.fraction : ring.y;
        const y = baseY + (prng.next() - 0.5) * island.height * 0.12;
        positions.push(x, y, z);
        const tint =
          ring.radius > 0.7 ? sand : ring.radius > 0.4 ? grass : prng.chance(0.4) ? rough : grass;
        const amount = Math.min(0.8, ring.shade + prng.next() * 0.16);
        const mixed = mixColour(tint, ring.radius <= 0.4 ? rock : 0x647a4f, amount);
        const linear = hexToLinearRgb(mixed);
        colours.push(linear.r, linear.g, linear.b);
        row.push(start + segment);
      }
      ringStarts.push(row);
    }

    // Flancs : anneau extérieur vers anneau intérieur (normales vers le haut).
    for (let ringIndex = 0; ringIndex < ringStarts.length - 1; ringIndex += 1) {
      const inner = ringStarts[ringIndex];
      const outer = ringStarts[ringIndex + 1];
      if (!inner || !outer) continue;
      for (let segment = 0; segment < segments; segment += 1) {
        const next = (segment + 1) % segments;
        const a = inner[segment] ?? 0;
        const b = inner[next] ?? 0;
        const c = outer[segment] ?? 0;
        const d = outer[next] ?? 0;
        indices.push(a, b, c, b, d, c);
      }
    }

    // Sommet rocheux et sa couronne.
    const peak = positions.length / 3;
    const peakY = SEA_LEVEL + island.height * 0.92 + 0.5;
    positions.push(island.x, peakY, island.z);
    const peakColour = hexToLinearRgb(rock);
    colours.push(peakColour.r, peakColour.g, peakColour.b);
    const top = ringStarts[ringStarts.length - 1];
    if (top) {
      for (let segment = 0; segment < segments; segment += 1) {
        const next = (segment + 1) % segments;
        indices.push(top[segment] ?? 0, top[next] ?? 0, peak);
      }
    }
  }

  return { positions, colours, indices, triangles: indices.length / 3 };
}
