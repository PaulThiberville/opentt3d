/**
 * Modèles de bâtiments, props urbains, gares et dépôts, construits en code Three.js.
 *
 * Aucun asset binaire : chaque archétype est une petite scène de boîtes,
 * prismes, cylindres et plans fusionnée en UNE géométrie à couleurs de
 * sommets. Les fenêtres sont des quads (2 triangles) marqués par l'attribut
 * `aWindow` : le shader de nuit les allume sans draw call ni matériau
 * supplémentaire. `aFinish` et `aGlow` distinguent verre, métal, toits satinés
 * et sources lumineuses ; le matériau `MeshStandardMaterial` partagé applique
 * rugosité, reflet de verre et émission. Les modèles sont exprimés dans une
 * empreinte unitaire (1×1 tuile, base à y = 0) puis posés par `InstancedMesh`.
 *
 * Huit archétypes (maison, mitoyenne, immeuble, boutique, bureaux, église,
 * entrepôt, édifice public) se déclinent en 16 combinaisons archétype ×
 * variante : le nombre de lots instanciés reste borné, quelle que soit la
 * taille de la ville. Les façades procédurales ajoutent fenêtres encadrées,
 * seuils, volets, corniches, balcons, lucarnes et enseignes selon le niveau de
 * détail.
 *
 * Budget : chaque archétype reste largement sous 2 000 triangles, y compris au
 * niveau de détail maximal ; le détail 1 (qualité moyenne) vise ~150 triangles
 * par bâtiment en moyenne. Les variantes sont déterministes : une même graine
 * produit toujours la même silhouette.
 */

import * as THREE from 'three';
import { Prng, hashUnit2d } from '../../game/prng';
import { hexToRgb, mixColour, weatherColour } from '../tileVisuals';
import { MODEL_FINISH, MODEL_GLOW, type ModelFinish, type ModelGlow } from './materials';

export type BuildingArchetype =
  'house' | 'terrace' | 'apartment' | 'shop' | 'office' | 'church' | 'warehouse' | 'civic';

export type BuildingDetail = 0 | 1 | 2;

export const BUILDING_ARCHETYPES: readonly BuildingArchetype[] = [
  'house',
  'terrace',
  'apartment',
  'shop',
  'office',
  'church',
  'warehouse',
  'civic',
];

/**
 * Variantes géométriques par archétype. La somme (3 + 2×6 + 1 = 16) borne le
 * nombre de lots instanciés par ville : la variété ne coûte jamais un draw call
 * par bâtiment.
 */
export const BUILDING_VARIANT_COUNTS: Record<BuildingArchetype, number> = {
  house: 3,
  terrace: 2,
  apartment: 2,
  shop: 2,
  office: 2,
  church: 1,
  warehouse: 2,
  civic: 2,
};

/** Nombre maximal de variantes d'un archétype. */
export const BUILDING_VARIANTS = 3;

export function buildingVariantCount(archetype: BuildingArchetype): number {
  return BUILDING_VARIANT_COUNTS[archetype] ?? 1;
}

/** Empreinte maximale d'un bâtiment, marge de 0,06 tuile sur chaque bord. */
export const MAX_BUILDING_FOOTPRINT = 0.88;

export interface BuildingModelStats {
  triangles: number;
  windows: number;
}

const WALL_PALETTES: Record<BuildingArchetype, readonly number[]> = {
  house: [0xd8cdb8, 0xcbbba1, 0xbfa98c, 0xd2d4cc, 0xc9b9a4],
  terrace: [0xc9b39a, 0xbfae95, 0xd3c2a8, 0xb9a68c],
  apartment: [0xb9b4a8, 0xc7c0b2, 0xa9b0b4, 0xd0c8b8],
  shop: [0xd3c3aa, 0xc9b9a4, 0xbfae92, 0xd8cbb2],
  office: [0xb2b6b8, 0xa9b0b4, 0xc0c2bf, 0x9fa6aa],
  church: [0xd8d2c4, 0xcac2b0, 0xe0dacb],
  warehouse: [0x9aa0a2, 0x8e938f, 0xa8a49a, 0x949a99],
  civic: [0xd2c9b6, 0xc6bca8, 0xdbd3c0, 0xbdb3a0],
};

const ROOF_PALETTES: Record<BuildingArchetype, readonly number[]> = {
  house: [0x8f4132, 0x7c3d31, 0x9b5240, 0x555a60],
  terrace: [0x6b4a3c, 0x555a60, 0x7d5a45],
  apartment: [0x454b55, 0x555a60, 0x3f444c],
  shop: [0x555a60, 0x6b5a48, 0x454b55],
  office: [0x454b55, 0x3f444c, 0x555a60],
  church: [0x4a4f57, 0x555a60, 0x3f444c],
  warehouse: [0x6b7176, 0x5c6268, 0x767c80],
  civic: [0x4a4f57, 0x555a60, 0x6b5a48],
};

const GLASS = 0x36434f;
const GLASS_OFFICE = 0x3d4e6b;
const GLASS_CURTAIN = 0x466078;
const DOOR = 0x4a3527;
const TRIM = 0xe6dfcf;
const LIT_WINDOW = 1;

/** Teintes de vitrage utilisées par les archétypes (finition verre). */
const GLASS_COLOURS = new Set<number>([
  GLASS,
  0x40525f,
  0x2c3b45,
  0x3d4e6b,
  0x3d4a55,
  0x33383b,
  GLASS_OFFICE,
  GLASS_CURTAIN,
  0x2f4a5e,
]);

/** Couleurs de livrée qui doivent rester exactement blanches. */
const PURE_WHITE = 0xffffff;

function finishForBuildingColour(colour: number): ModelFinish {
  if (GLASS_COLOURS.has(colour)) return MODEL_FINISH.glass;
  if (colour === DOOR || colour === TRIM) return MODEL_FINISH.accent;
  if (colour === 0x8a8f94 || colour === 0x6b7176) return MODEL_FINISH.metal;
  return MODEL_FINISH.paint;
}

/** Petit constructeur de géométrie fusionnée, à couleurs de sommets. */
class ModelBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colours: number[] = [];
  private windows: number[] = [];
  private finishes: number[] = [];
  private glows: number[] = [];
  private rgb = { r: 0, g: 0, b: 0 };
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private euler = new THREE.Euler();
  private up = new THREE.Vector3(0, 1, 0);

  add(
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    options: {
      yaw?: number;
      tiltZ?: number;
      window?: number;
      finish?: ModelFinish;
      glow?: ModelGlow;
    } = {},
  ): void {
    this.euler.set(0, options.yaw ?? 0, options.tiltZ ?? 0, 'YXZ');
    this.quaternion.setFromEuler(this.euler);
    this.position.set(x, y, z);
    this.scale.set(width, height, depth);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    geometry.applyMatrix4(this.matrix);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = flat.getAttribute('position');
    const normal = flat.getAttribute('normal');
    const window = options.window ?? 0;
    const finish = options.finish ?? finishForBuildingColour(colour);
    const glow = options.glow ?? MODEL_GLOW.none;
    const weathered = colour !== PURE_WHITE;
    hexToRgb(colour, this.rgb);
    const count = position.count;
    for (let i = 0; i < count; i += 1) {
      const px = position.getX(i);
      const py = position.getY(i);
      const pz = position.getZ(i);
      this.positions.push(px, py, pz);
      this.normals.push(
        normal ? normal.getX(i) : this.up.x,
        normal ? normal.getY(i) : this.up.y,
        normal ? normal.getZ(i) : this.up.z,
      );
      let factor = 1;
      if (weathered) {
        // Salissure basse et grain très léger : deux bâtiments identiques
        // restent identiques, mais les surfaces ne sont plus parfaitement plates.
        const grime = Math.max(0, Math.min(1, 1 - py / 0.16));
        const grain = hashUnit2d(
          colour & 0xffffff,
          Math.round(px * 197 + pz * 89),
          Math.round(py * 409),
        );
        factor = 1 - grime * 0.1 + (grain - 0.5) * 0.045;
      }
      this.colours.push(
        Math.max(0, Math.min(1, this.rgb.r * factor)),
        Math.max(0, Math.min(1, this.rgb.g * factor)),
        Math.max(0, Math.min(1, this.rgb.b * factor)),
      );
      this.windows.push(window);
      this.finishes.push(finish);
      this.glows.push(glow);
    }
    if (flat !== geometry) flat.dispose();
    geometry.dispose();
  }

  box(
    x: number,
    baseY: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    options: {
      yaw?: number;
      window?: number;
      finish?: ModelFinish;
      glow?: ModelGlow;
    } = {},
  ): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    this.add(geometry, x, baseY, z, width, height, depth, colour, options);
  }

  /** Prisme à toit à deux pans, faîtage sur Z. */
  prism(
    x: number,
    baseY: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    options: { yaw?: number; finish?: ModelFinish } = {},
  ): void {
    this.add(prismGeometry(), x, baseY, z, width, height, depth, colour, options);
  }

  /** Toit pyramidal à quatre pans. */
  pyramid(
    x: number,
    baseY: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    options: { yaw?: number; finish?: ModelFinish } = {},
  ): void {
    const geometry = new THREE.ConeGeometry(0.5, 1, 4);
    geometry.rotateY(Math.PI / 4);
    geometry.translate(0, 0.5, 0);
    this.add(geometry, x, baseY, z, width, height, depth, colour, options);
  }

  /** Toit à quatre pans avec faîtage court : lecture « pavillon » plus douce. */
  hip(
    x: number,
    baseY: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    options: { yaw?: number; finish?: ModelFinish } = {},
  ): void {
    this.add(hipGeometry(), x, baseY, z, width, height, depth, colour, options);
  }

  cylinder(
    x: number,
    baseY: number,
    z: number,
    diameter: number,
    height: number,
    colour: number,
    options: {
      segments?: number;
      topScale?: number;
      finish?: ModelFinish;
      glow?: ModelGlow;
    } = {},
  ): void {
    const geometry = new THREE.CylinderGeometry(
      Math.max(0.05, options.topScale ?? 1) * 0.5,
      0.5,
      1,
      options.segments ?? 8,
      1,
      false,
    );
    geometry.translate(0, 0.5, 0);
    this.add(geometry, x, baseY, z, diameter, height, diameter, colour, {
      finish: options.finish,
      glow: options.glow,
    });
  }

  /** Quad vertical (fenêtre, porte, enseigne) plaqué sur une façade. */
  plane(
    x: number,
    centreY: number,
    z: number,
    width: number,
    height: number,
    colour: number,
    yaw: number,
    window = 0,
    glow: ModelGlow = MODEL_GLOW.none,
  ): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.add(geometry, x, centreY, z, width, height, 1, colour, { yaw, window, glow });
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    geometry.setAttribute('aWindow', new THREE.Float32BufferAttribute(this.windows, 1));
    geometry.setAttribute('aFinish', new THREE.Float32BufferAttribute(this.finishes, 1));
    geometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glows, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function prismGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array([
    // Pan -X
    -0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5, -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.5,
    // Pan +X
    0.5, 0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0.5, 0, 0.5,
    // Pignon -Z et +Z
    -0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Toit à quatre pans : deux trapèzes et deux triangles, faîtage sur Z. */
function hipGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array([
    // Pan -X
    -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.25, -0.5, 0, -0.5, 0, 1, 0.25, 0, 1, -0.25,
    // Pan +X
    0.5, 0, 0.5, 0.5, 0, -0.5, 0, 1, -0.25, 0.5, 0, 0.5, 0, 1, -0.25, 0, 1, 0.25,
    // Croupe -Z
    -0.5, 0, -0.5, 0, 1, -0.25, 0.5, 0, -0.5,
    // Croupe +Z
    0.5, 0, 0.5, 0, 1, 0.25, -0.5, 0, 0.5,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function shade(colour: number, amount: number): number {
  const factor = 1 + amount;
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * factor)));
  return (
    (channel((colour >> 16) & 0xff) << 16) |
    (channel((colour >> 8) & 0xff) << 8) |
    channel(colour & 0xff)
  );
}

function facadeColour(archetype: BuildingArchetype, variant: number, rng: Prng): number {
  const palette = WALL_PALETTES[archetype];
  const base = palette[variant % palette.length] ?? 0xc9b9a4;
  const seed = 0x9e37 + variant * 131 + archetype.length * 17 + Math.floor(rng.float(0, 4096));
  return weatherColour(base, seed, 0.06);
}

function roofColour(archetype: BuildingArchetype, variant: number, rng: Prng): number {
  const palette = ROOF_PALETTES[archetype];
  const base = palette[(variant + 1) % palette.length] ?? 0x555a60;
  // Dérive chaude (tuiles) ou froide (ardoise), puis usure déterministe.
  const drift = rng.chance(0.5) ? 0xa87d62 : 0x7d8892;
  const tinted = mixColour(base, drift, rng.float(0.02, 0.09));
  const seed = 0x513b + variant * 197 + archetype.length * 29 + Math.floor(rng.float(0, 4096));
  return weatherColour(tinted, seed, 0.09);
}

interface FacadeOptions {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  seed: number;
  glass?: number;
  door?: boolean;
  /** Colonnes forçées (façades étroites ou vitrines). */
  columns?: number;
  /** Premier étage fenêtré : 1 saute le rez-de-chaussée (devanture). */
  firstFloor?: number;
  /** Cadres clairs derrière les vitrages (détail 2). */
  frames?: boolean;
  /** Appuis de fenêtre sur les façades principales (détail 2). */
  sills?: boolean;
  /** Volets battants sur la façade +Z (détail 2). */
  shutters?: boolean;
  /** Proportion de fenêtres allumées la nuit. */
  litRatio?: number;
  /** Hauteur d'étage imposée (immeubles, bureaux). */
  floorHeight?: number;
  /** Nombre maximal d'étages fenêtrés. */
  maxFloors?: number;
}

/**
 * Fenêtres, portes et détails de façade répartis sur les quatre faces.
 *
 * Les vitrages sont de simples quads : aucune géométrie par fenêtre n'est
 * conservée séparément, tout est fusionné dans la géométrie du bâtiment. Les
 * cadres et appuis restent limités aux façades visibles depuis la rue (+Z) et
 * aux deux grands côtés, pour tenir le budget triangles du détail 1.
 */
function addFacadeOpenings(builder: ModelBuilder, options: FacadeOptions): void {
  const { x, z, width, depth, height, seed } = options;
  const glass = options.glass ?? GLASS;
  const rng = new Prng(seed);
  const floorHeight = options.floorHeight ?? 0.24;
  const firstFloor = options.firstFloor ?? 0;
  const frames = options.frames === true;
  const sills = options.sills === true;
  const shutters = options.shutters === true;
  const litRatio = options.litRatio ?? 0.55;
  const maxFloors = options.maxFloors ?? 9;
  const floors = Math.max(
    1,
    Math.min(maxFloors, Math.floor((height - 0.1) / floorHeight) - firstFloor),
  );
  const columnsZ = options.columns ?? Math.max(1, Math.min(4, Math.round(width / 0.2)));
  const columnsX = options.columns ?? Math.max(1, Math.min(4, Math.round(depth / 0.2)));
  const winWidth = Math.min(0.105, (width - 0.14) / Math.max(1, columnsZ) - 0.03);
  const winHeight = Math.min(0.12, floorHeight * 0.54);
  if (winWidth <= 0.025 || winHeight <= 0.025) return;

  const rowY = (floor: number): number =>
    0.075 + (floor + firstFloor) * floorHeight + winHeight / 2;
  const column = (index: number, count: number, span: number): number =>
    count === 1 ? 0 : -span / 2 + 0.06 + (index * (span - 0.12)) / (count - 1);

  const windowAt = (
    px: number,
    py: number,
    pz: number,
    yaw: number,
    normalX: number,
    normalZ: number,
    frame: boolean,
    shuttersHere: boolean,
    sillHere: boolean,
  ): void => {
    const lit = rng.chance(litRatio) ? LIT_WINDOW : 0.35;
    if (frame) {
      // Cadre légèrement en retrait : deux plans coplanaires z-fighteraient.
      builder.plane(
        px - normalX * 0.002,
        py,
        pz - normalZ * 0.002,
        winWidth + 0.016,
        winHeight + 0.016,
        TRIM,
        yaw,
        0,
      );
    }
    builder.plane(px, py, pz, winWidth, winHeight, glass, yaw, lit);
    if (shuttersHere) {
      const shutterWidth = winWidth * 0.34;
      const offset = winWidth / 2 + shutterWidth / 2 + 0.006;
      builder.plane(px - offset, py, pz, shutterWidth, winHeight, shade(glass, -0.2), yaw);
      builder.plane(px + offset, py, pz, shutterWidth, winHeight, shade(glass, -0.2), yaw);
    }
    if (sillHere) {
      // Appui : une seule boîte fine, 12 triangles, sur la façade principale.
      builder.box(px, py - winHeight / 2 - 0.02, pz + 0.025, winWidth + 0.03, 0.018, 0.05, TRIM);
    }
  };

  for (let floor = 0; floor < floors; floor += 1) {
    for (let index = 0; index < columnsZ; index += 1) {
      const offset = column(index, columnsZ, width);
      const y = rowY(floor);
      if (y + winHeight / 2 > height - 0.03) continue;
      // Façade +Z : détails complets ; façade -Z : vitrage seul.
      windowAt(x + offset, y, z + depth / 2 + 0.004, 0, 0, 1, frames, shutters, sills);
      windowAt(x + offset, y, z - depth / 2 - 0.004, Math.PI, 0, -1, false, false, false);
    }
    for (let index = 0; index < columnsX; index += 1) {
      const offset = column(index, columnsX, depth);
      const y = rowY(floor);
      if (y + winHeight / 2 > height - 0.03) continue;
      windowAt(x + width / 2 + 0.004, y, z + offset, Math.PI / 2, 1, 0, frames, false, false);
      windowAt(x - width / 2 - 0.004, y, z + offset, -Math.PI / 2, -1, 0, false, false, false);
    }
  }

  if (options.door !== false) {
    const doorWidth = Math.min(0.15, width * 0.24);
    const doorHeight = Math.min(0.21, height * 0.42);
    const doorX = x + width * 0.18;
    builder.plane(
      doorX,
      doorHeight / 2 + 0.006,
      z + depth / 2 + 0.006,
      doorWidth,
      doorHeight,
      DOOR,
      0,
    );
    builder.box(doorX, 0, z + depth / 2 + 0.012, doorWidth + 0.03, 0.018, 0.03, TRIM);
    if (frames) {
      builder.plane(
        doorX,
        doorHeight / 2 + 0.016,
        z + depth / 2 + 0.007,
        doorWidth + 0.03,
        doorHeight + 0.03,
        TRIM,
        0,
      );
      builder.box(
        doorX,
        0,
        z + depth / 2 + 0.014,
        doorWidth + 0.05,
        0.016,
        0.045,
        shade(TRIM, -0.12),
      );
    }
  }
}

/** Cheminée courte avec chapeau : deux boîtes, lisible même de loin. */
function addChimney(
  builder: ModelBuilder,
  x: number,
  baseY: number,
  z: number,
  colour: number,
  height = 0.3,
  width = 0.09,
): void {
  builder.box(x, baseY, z, width, height, width, shade(colour, -0.12));
  builder.box(x, baseY + height, z, width + 0.04, 0.03, width + 0.04, 0x3b3a38);
  builder.box(x, baseY + height * 0.55, z, width + 0.02, 0.02, width + 0.02, shade(colour, 0.1));
}

/** Lucarne : petit volume de toit, pignon et vitrage. */
function addDormer(
  builder: ModelBuilder,
  x: number,
  baseY: number,
  z: number,
  wall: number,
  roof: number,
): void {
  builder.box(x, baseY, z, 0.15, 0.13, 0.14, wall);
  builder.prism(x, baseY + 0.13, z, 0.17, 0.08, 0.16, roof, {
    finish: MODEL_FINISH.satin,
  });
  builder.plane(x, baseY + 0.075, z + 0.075, 0.07, 0.06, GLASS, 0, LIT_WINDOW);
}

/** Corniche : un bandeau unique, 12 triangles, autour du dernier étage. */
function addCornice(
  builder: ModelBuilder,
  x: number,
  y: number,
  z: number,
  width: number,
  depth: number,
  colour: number,
  amount = 0.08,
  thickness = 0.03,
): void {
  builder.box(x, y, z, width + 0.035, thickness, depth + 0.035, shade(colour, amount));
}

function buildHouse(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x51a3 + variant * 977);
  const wall = facadeColour('house', variant, rng);
  const roof = roofColour('house', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.7 + variant * 0.045;
  const depth = 0.66 + ((variant + 1) % 2) * 0.04;
  const height = 0.5 + variant * 0.05 + rng.float(0, 0.04);
  builder.box(0, 0, 0, width, height, depth, wall);
  if (detail >= 1) {
    // Soubassement : la maison ne flotte pas sur l'herbe.
    builder.box(0, 0, 0, width + 0.02, 0.055, depth + 0.02, shade(wall, -0.16));
  }
  const roofHeight = 0.24 + (variant === 1 ? 0.08 : 0);
  if (variant === 0) {
    builder.prism(0, height, 0, width + 0.05, roofHeight, depth + 0.06, roof, {
      finish: MODEL_FINISH.satin,
    });
  } else if (variant === 1) {
    builder.hip(0, height, 0, width + 0.055, roofHeight, depth + 0.06, roof, {
      finish: MODEL_FINISH.satin,
    });
  } else {
    builder.prism(0, height, 0, width + 0.05, roofHeight, depth + 0.05, roof, {
      yaw: Math.PI / 2,
      finish: MODEL_FINISH.satin,
    });
    // Petite annexe en appentis, toujours dans l'empreinte.
    builder.box(
      width * 0.26,
      0,
      depth * 0.36,
      width * 0.34,
      height * 0.58,
      depth * 0.34,
      shade(wall, -0.06),
    );
    builder.prism(
      width * 0.26,
      height * 0.58,
      depth * 0.36,
      width * 0.38,
      roofHeight * 0.45,
      depth * 0.38,
      roof,
      { finish: MODEL_FINISH.satin },
    );
  }
  if (detail >= 1) {
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x91 + variant,
      frames: detail >= 2,
      sills: detail >= 2,
      shutters: detail >= 2 && variant !== 1,
      columns: 2,
    });
    addCornice(builder, 0, height - 0.06, 0, width, depth, wall, 0.08, 0.025);
  }
  if (detail >= 2) {
    const chimneyX = variant === 0 ? width * 0.24 : -width * 0.22;
    addChimney(builder, chimneyX, height + roofHeight * 0.42, 0.02, roof, 0.3);
    addDormer(builder, 0, height + roofHeight * 0.3, depth * 0.24, wall, roof);
    // Auvent au-dessus de la porte.
    builder.box(width * 0.18, 0.26, depth / 2 + 0.07, 0.24, 0.025, 0.13, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(width * 0.18, 0, depth / 2 + 0.1, 0.16, 0.02, 0.1, shade(wall, -0.2));
  }
  return builder.build();
}

function buildTerrace(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x33d1 + variant * 613);
  const wall = facadeColour('terrace', variant, rng);
  const roof = roofColour('terrace', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.82;
  const depth = 0.62 + variant * 0.03;
  const height = 0.8 + variant * 0.14 + rng.float(0, 0.04);
  builder.box(0, 0, 0, width, height, depth, wall);
  if (detail >= 1) {
    builder.box(0, 0, 0, width + 0.02, 0.06, depth + 0.02, shade(wall, -0.15));
    // Murs mitoyens : deux lames verticales qui lisent la rangée.
    builder.box(
      -width / 2 + 0.025,
      height * 0.25,
      0,
      0.045,
      height * 0.75,
      depth + 0.03,
      shade(wall, -0.07),
    );
    builder.box(
      width / 2 - 0.025,
      height * 0.25,
      0,
      0.045,
      height * 0.75,
      depth + 0.03,
      shade(wall, -0.07),
    );
  }
  if (variant === 0) {
    builder.prism(0, height, 0, width + 0.05, 0.24, depth + 0.05, roof, {
      yaw: Math.PI / 2,
      finish: MODEL_FINISH.satin,
    });
  } else {
    addCornice(builder, 0, height, 0, width, depth, wall, 0.06, 0.07);
    builder.box(0, height + 0.07, 0, width - 0.02, 0.02, depth - 0.02, shade(roof, 0.12), {
      finish: MODEL_FINISH.satin,
    });
    builder.box(0, height + 0.09, -0.1, 0.2, 0.18, 0.2, shade(wall, -0.05));
    builder.box(0, height + 0.09, depth / 2, width, 0.05, 0.03, roof, {
      finish: MODEL_FINISH.satin,
    });
  }
  if (detail >= 1) {
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x1f7 + variant,
      frames: detail >= 2,
      sills: detail >= 2,
      columns: 3,
      litRatio: 0.5,
    });
    // Deux portes : la rangée n'a pas une entrée unique.
    builder.plane(-width * 0.28, 0.09, depth / 2 + 0.006, 0.1, 0.18, DOOR, 0);
    builder.plane(width * 0.3, 0.09, depth / 2 + 0.006, 0.1, 0.18, DOOR, 0);
  }
  if (detail >= 2) {
    addChimney(builder, -width * 0.3, height + 0.14, 0.05, roof, 0.24, 0.075);
    addChimney(builder, width * 0.32, height + 0.14, -0.05, roof, 0.2, 0.07);
    // Marquise du rez-de-chaussée.
    builder.box(0, 0.27, depth / 2 + 0.06, width * 0.72, 0.024, 0.12, roof, {
      finish: MODEL_FINISH.satin,
    });
  }
  return builder.build();
}

function buildApartment(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x73c1 + variant * 1913);
  const wall = facadeColour('apartment', variant, rng);
  const roof = roofColour('apartment', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.74 + variant * 0.05;
  const depth = 0.66 + variant * 0.04;
  const height = 1.5 + variant * 0.22 + rng.float(0, 0.14);
  builder.box(0, 0, 0, width, height, depth, wall);
  if (variant === 0) {
    builder.box(0, height, 0, width + 0.02, 0.05, depth + 0.02, shade(roof, 0.1));
    // Acrotère : quatre murets minces.
    builder.box(0, height + 0.05, depth / 2, width, 0.06, 0.035, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(0, height + 0.05, -depth / 2, width, 0.06, 0.035, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(width / 2, height + 0.05, 0, 0.035, 0.06, depth, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(-width / 2, height + 0.05, 0, 0.035, 0.06, depth, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(width * 0.18, height + 0.05, -depth * 0.16, 0.2, 0.22, 0.2, shade(wall, -0.05));
  } else {
    builder.hip(0, height, 0, width + 0.05, 0.26, depth + 0.05, roof, {
      finish: MODEL_FINISH.satin,
    });
    addChimney(builder, -width * 0.22, height + 0.12, 0.02, roof, 0.26, 0.085);
    addDormer(builder, width * 0.16, height + 0.1, depth * 0.26, wall, roof);
  }
  if (detail >= 1) {
    builder.box(0, 0, 0, width + 0.025, 0.07, depth + 0.025, shade(wall, -0.14));
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x2f1 + variant,
      columns: variant === 0 ? 3 : 2,
      floorHeight: 0.235,
      frames: detail >= 2,
      sills: detail >= 2,
      litRatio: 0.58,
    });
    addCornice(builder, 0, 0.32, 0, width, depth, wall, 0.09, 0.025);
  }
  if (detail >= 2) {
    // Balcons filants sur la façade sud, tous les deux étages.
    const floors = Math.max(2, Math.floor((height - 0.15) / 0.235));
    for (let floor = 1; floor < floors; floor += 2) {
      const y = 0.06 + floor * 0.235;
      builder.box(0, y, depth / 2 + 0.06, width * 0.72, 0.022, 0.13, shade(wall, 0.1));
      builder.box(0, y + 0.022, depth / 2 + 0.12, width * 0.72, 0.07, 0.02, roof, {
        finish: MODEL_FINISH.satin,
      });
    }
    builder.box(0, 0, depth / 2 + 0.06, width * 0.42, 0.025, 0.12, roof, {
      finish: MODEL_FINISH.satin,
    });
    // Édicule d'escalier et ventilation sur le toit plat.
    builder.box(-width * 0.26, height + 0.05, depth * 0.1, 0.14, 0.12, 0.14, shade(wall, -0.08));
    builder.box(width * 0.3, height + 0.05, -depth * 0.18, 0.1, 0.08, 0.1, 0x8a8f94);
  }
  return builder.build();
}

function buildShop(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x9b41 + variant * 613);
  const wall = facadeColour('shop', variant, rng);
  const roof = roofColour('shop', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.76 + variant * 0.04;
  const depth = 0.68;
  const height = 0.8 + variant * 0.16 + rng.float(0, 0.04);
  builder.box(0, 0, 0, width, height, depth, wall);
  if (variant === 0) {
    builder.prism(0, height, 0, width + 0.05, 0.24, depth + 0.04, roof, {
      finish: MODEL_FINISH.satin,
    });
  } else {
    builder.box(0, height, 0, width + 0.02, 0.06, depth + 0.02, shade(roof, 0.12));
    builder.box(0, height + 0.06, depth / 2, width, 0.05, 0.03, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(-width * 0.24, height + 0.06, -depth * 0.16, 0.14, 0.16, 0.14, shade(wall, -0.06));
  }
  if (detail >= 1) {
    builder.box(0, 0, 0, width + 0.02, 0.06, depth + 0.02, shade(wall, -0.15));
    // Devanture : deux grands vitrages et une porte latérale.
    const glass = 0x40525f;
    builder.plane(-width * 0.18, 0.28, depth / 2 + 0.005, width * 0.3, 0.28, glass, 0, 0.7);
    builder.plane(width * 0.1, 0.28, depth / 2 + 0.005, width * 0.24, 0.28, glass, 0, 0.7);
    builder.plane(width * 0.32, 0.15, depth / 2 + 0.006, 0.12, 0.26, DOOR, 0);
    builder.plane(width * 0.32, 0.15, depth / 2 + 0.008, 0.08, 0.16, 0x2c3b45, 0, 0.6);
    // Enseigne au-dessus de la devanture : bandeau + texte lumineux la nuit.
    builder.box(0, 0.47, depth / 2 + 0.015, width * 0.74, 0.1, 0.02, TRIM);
    builder.plane(
      0,
      0.52,
      depth / 2 + 0.028,
      width * 0.52,
      0.05,
      0xd8b96a,
      0,
      0,
      MODEL_GLOW.beacon,
    );
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x77 + variant,
      columns: 2,
      firstFloor: 1,
      door: false,
      frames: detail >= 2,
      litRatio: 0.6,
    });
  }
  if (detail >= 2) {
    // Auvent rayé et petits bacs de marchandises.
    builder.box(
      0,
      0.42,
      depth / 2 + 0.04,
      width * 0.68,
      0.03,
      0.14,
      variant === 0 ? 0xa2463c : 0x3f6b52,
    );
    builder.box(-width * 0.28, 0.42, depth / 2 + 0.12, 0.03, 0.1, 0.02, TRIM);
    builder.box(width * 0.28, 0.42, depth / 2 + 0.12, 0.03, 0.1, 0.02, TRIM);
    builder.box(-width * 0.34, 0, depth / 2 + 0.04, 0.12, 0.08, 0.09, 0x8a6a45);
    builder.box(-width * 0.34, 0.08, depth / 2 + 0.04, 0.1, 0.06, 0.08, 0x9b7a52);
    // Enseigne suspendue perpendiculaire à la façade.
    builder.box(width * 0.38, 0.34, depth / 2 + 0.1, 0.02, 0.02, 0.16, 0x3b3a38);
    builder.box(width * 0.38, 0.24, depth / 2 + 0.17, 0.02, 0.1, 0.12, TRIM);
  }
  return builder.build();
}

function buildOffice(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x6a2f + variant * 2311);
  const wall = facadeColour('office', variant, rng);
  const roof = roofColour('office', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.76;
  const depth = 0.66 + variant * 0.04;
  const height = 1.3 + variant * 0.34 + rng.float(0, 0.12);
  const baseHeight = variant === 1 ? height * 0.58 : height;
  const upperWidth = variant === 1 ? width * 0.76 : width;
  const upperDepth = variant === 1 ? depth * 0.78 : depth;
  builder.box(0, 0, 0, width, baseHeight, depth, wall);
  if (variant === 1) {
    builder.box(0, baseHeight, 0, upperWidth, height - baseHeight, upperDepth, shade(wall, 0.04));
  }
  addCornice(builder, 0, height - 0.05, 0, upperWidth, upperDepth, roof, 0.05, 0.05);
  builder.box(0, height, 0, upperWidth - 0.01, 0.02, upperDepth - 0.01, shade(roof, 0.1), {
    finish: MODEL_FINISH.satin,
  });
  if (detail >= 1) {
    const floors = Math.max(2, Math.floor((height - 0.2) / 0.26));
    const glassBand = (floorsCount: number): void => {
      for (let floor = 0; floor < floorsCount; floor += 1) {
        const y = 0.16 + floor * 0.26;
        if (y + 0.07 > height - 0.06) continue;
        const top = y > baseHeight - 0.12 ? upperWidth * 0.9 : width * 0.9;
        const sideDepth = y > baseHeight - 0.12 ? upperDepth * 0.9 : depth * 0.9;
        builder.plane(0, y, depth / 2 + 0.006, top, 0.12, GLASS_CURTAIN, 0, 0.55);
        builder.plane(width / 2 + 0.006, y, 0, sideDepth, 0.12, GLASS_CURTAIN, Math.PI / 2, 0.45);
        builder.plane(-width / 2 - 0.006, y, 0, sideDepth, 0.12, GLASS_CURTAIN, -Math.PI / 2, 0.45);
      }
    };
    glassBand(floors);
    // Bandeaux d'étage : deux boîtes fines qui rythment la façade.
    for (let floor = 1; floor < floors; floor += 2) {
      const y = 0.09 + floor * 0.26;
      if (y > height - 0.12) continue;
      addCornice(builder, 0, y, 0, upperWidth, upperDepth, wall, 0.05, 0.02);
    }
    // Entrée vitrée et auvent.
    builder.plane(0, 0.12, depth / 2 + 0.008, 0.22, 0.22, GLASS_OFFICE, 0, 0.75);
    builder.box(0, 0.25, depth / 2 + 0.09, 0.34, 0.025, 0.18, roof, {
      finish: MODEL_FINISH.satin,
    });
    builder.box(0, 0, depth / 2 + 0.03, 0.4, 0.03, 0.16, 0x8a8f94);
  }
  if (detail >= 2) {
    // Coins de façade : quatre poteaux verticaux fins.
    const cornerX = upperWidth / 2 - 0.015;
    const cornerZ = upperDepth / 2 - 0.015;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        builder.box(
          sx * cornerX,
          baseHeight,
          sz * cornerZ,
          0.035,
          height - baseHeight,
          0.035,
          shade(wall, 0.12),
        );
      }
    }
    // Toiture technique : caissons, antenne, enseigne lumineuse.
    builder.box(-width * 0.18, height, -depth * 0.12, 0.16, 0.1, 0.14, 0x8a8f94);
    builder.box(width * 0.2, height, depth * 0.1, 0.12, 0.14, 0.1, 0x6b7176);
    builder.cylinder(width * 0.05, height, -depth * 0.22, 0.012, 0.24, 0x3b3a38, { segments: 4 });
    builder.plane(
      0,
      height + 0.09,
      depth / 2 + 0.01,
      0.24,
      0.07,
      0x7fb4c9,
      0,
      0,
      MODEL_GLOW.beacon,
    );
    // Garde-corps du toit.
    builder.box(0, height + 0.02, depth / 2 - 0.02, upperWidth, 0.03, 0.02, 0x8a8f94);
  }
  return builder.build();
}

function buildChurch(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x2d17 + variant * 997);
  const wall = facadeColour('church', variant, rng);
  const roof = roofColour('church', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.66;
  const depth = 0.7;
  const height = 0.66 + variant * 0.05;
  builder.box(0, 0, 0, width, height, depth, wall);
  builder.prism(0, height, 0, width + 0.05, 0.48, depth + 0.06, roof, {
    finish: MODEL_FINISH.satin,
  });
  // Clocher décalé sur un coin : jamais hors de l'empreinte unitaire.
  const towerX = -width / 2 + 0.11;
  const towerZ = depth / 2 - 0.11;
  builder.box(towerX, 0, towerZ, 0.24, 1.18, 0.24, shade(wall, 0.03));
  builder.box(towerX, 1.18, towerZ, 0.28, 0.06, 0.28, shade(wall, 0.1));
  builder.pyramid(towerX, 1.24, towerZ, 0.32, 0.34, 0.32, roof, { finish: MODEL_FINISH.satin });
  builder.box(towerX, 1.58, towerZ, 0.025, 0.11, 0.025, 0x3b3a38);
  builder.box(towerX, 1.62, towerZ, 0.09, 0.025, 0.025, 0x3b3a38);
  if (detail >= 1) {
    // Portail en ogive approché par deux quads superposés.
    builder.plane(0, 0.16, depth / 2 + 0.005, 0.19, 0.26, DOOR, 0);
    builder.plane(0, 0.32, depth / 2 + 0.006, 0.12, 0.09, DOOR, 0);
    // Vitraux étroits le long de la nef.
    for (const offset of [-0.18, 0.02, 0.2]) {
      builder.plane(offset, 0.4, depth / 2 + 0.005, 0.045, 0.2, 0x3d4e6b, 0, 0.5);
    }
    builder.plane(-0.12, 0.86, towerZ + 0.125, 0.07, 0.14, 0x3d4e6b, 0, 0.5);
    // Rose du portail : petit disque de vitrage.
    builder.plane(0, 0.5, depth / 2 + 0.006, 0.08, 0.08, 0x4d5e8a, 0, 0.4);
    addCornice(builder, 0, 0.3, 0, width, depth, wall, 0.07, 0.025);
  }
  if (detail >= 2) {
    // Contreforts et cloche visible sous l'abri du clocher.
    builder.box(-width / 2 - 0.015, 0, -0.18, 0.055, height * 0.72, 0.08, shade(wall, -0.08));
    builder.box(width / 2 + 0.015, 0, -0.18, 0.055, height * 0.72, 0.08, shade(wall, -0.08));
    builder.box(towerX, 0.82, towerZ, 0.13, 0.16, 0.13, 0xb59b52);
    builder.plane(towerX, 1.05, towerZ + 0.122, 0.09, 0.22, 0x2c3b45, 0, 0.35);
    // Croix de faîtage.
    builder.box(0, height + 0.48, 0, 0.02, 0.14, 0.02, 0x3b3a38);
    builder.box(0, height + 0.53, 0, 0.09, 0.02, 0.02, 0x3b3a38);
  }
  return builder.build();
}

function buildWarehouse(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x4c9d + variant * 431);
  const wall = facadeColour('warehouse', variant, rng);
  const roof = roofColour('warehouse', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.82 + variant * 0.03;
  const depth = 0.68 + variant * 0.03;
  const height = 0.4 + variant * 0.05;
  builder.box(0, 0, 0, width, height, depth, wall);
  if (variant === 0) {
    // Toit en shed : trois petits pans successifs.
    for (let index = 0; index < 3; index += 1) {
      const offset = -width / 2 + (width * (index + 0.5)) / 3;
      builder.prism(offset, height, 0, width / 3 + 0.01, 0.14, depth + 0.03, roof, {
        finish: MODEL_FINISH.satin,
      });
    }
  } else {
    builder.box(0, height, 0, width + 0.02, 0.04, depth + 0.02, shade(roof, 0.12));
    builder.box(-width * 0.2, height + 0.04, 0, 0.16, 0.1, 0.16, shade(roof, -0.05));
    builder.box(width * 0.24, height + 0.04, 0, 0.1, 0.14, 0.1, shade(roof, -0.1));
  }
  // Grand rideau de quai + quais de chargement.
  builder.plane(0, 0.19, depth / 2 + 0.005, 0.42, 0.32, 0x4c4f52, 0);
  builder.box(0, 0.32, depth / 2 + 0.008, 0.46, 0.03, 0.03, TRIM);
  builder.box(0, 0, depth / 2 + 0.04, width * 0.9, 0.08, 0.12, shade(wall, -0.12));
  if (detail >= 1) {
    // Bandeau de petits vitrages hauts.
    builder.plane(0, height * 0.72, depth / 2 + 0.006, width * 0.6, 0.07, GLASS, 0, 0.5);
    builder.plane(width / 2 + 0.006, height * 0.6, 0, 0.05, 0.12, GLASS, Math.PI / 2, 0.5);
    // Petit bureau d'expédition collé à la façade.
    builder.box(
      -width * 0.34,
      0,
      -depth * 0.28,
      width * 0.24,
      height * 0.58,
      depth * 0.3,
      shade(wall, -0.04),
    );
    builder.plane(
      -width * 0.34,
      height * 0.32,
      -depth * 0.28 + depth * 0.155,
      0.1,
      0.1,
      GLASS,
      0,
      0.5,
    );
  }
  if (detail >= 2) {
    builder.box(-0.28, 0.08, depth / 2 + 0.04, 0.12, 0.1, 0.09, 0x7a5c3a);
    builder.box(0.3, 0.08, depth / 2 + 0.04, 0.1, 0.08, 0.09, 0x8a6a45);
    builder.box(0.3, 0.16, depth / 2 + 0.04, 0.08, 0.07, 0.08, 0x9b7a52);
    builder.box(0, height + 0.02, -depth / 2 + 0.06, 0.2, 0.06, 0.12, 0x6b7176);
    // Extracteurs de toiture.
    builder.cylinder(-width * 0.1, height + 0.03, 0.06, 0.09, 0.08, 0x8a8f94, { segments: 6 });
    builder.cylinder(width * 0.16, height + 0.03, -0.08, 0.08, 0.1, 0x8a8f94, { segments: 6 });
  }
  return builder.build();
}

function buildCivic(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x7b3d + variant * 881);
  const wall = facadeColour('civic', variant, rng);
  const roof = roofColour('civic', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.84;
  const depth = 0.68;
  const height = 0.78 + variant * 0.12 + rng.float(0, 0.05);
  builder.box(0, 0, 0, width, height, depth, wall);
  builder.hip(0, height, 0, width + 0.05, 0.3, depth + 0.05, roof, {
    finish: MODEL_FINISH.satin,
  });
  if (detail >= 1) {
    builder.box(0, 0, 0, width + 0.03, 0.07, depth + 0.03, shade(wall, -0.14));
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x3e1 + variant,
      columns: 3,
      frames: detail >= 2,
      sills: detail >= 2,
      litRatio: 0.45,
    });
    addCornice(builder, 0, height - 0.06, 0, width, depth, wall, 0.09, 0.03);
    // Avant-corps central et fronton.
    builder.box(0, 0, depth / 2 + 0.03, 0.3, height * 0.86, 0.08, shade(wall, 0.02));
    builder.prism(0, height * 0.86, depth / 2 + 0.03, 0.34, 0.14, 0.1, roof, {
      finish: MODEL_FINISH.satin,
    });
  }
  if (detail >= 2) {
    // Colonnes du portique, marches et horloge.
    for (const offset of [-0.11, 0.11]) {
      builder.cylinder(offset, 0.04, depth / 2 + 0.09, 0.055, height * 0.52, TRIM, { segments: 6 });
    }
    builder.box(0, 0, depth / 2 + 0.04, 0.5, 0.04, 0.16, 0x8a8f94);
    builder.box(0, 0.04, depth / 2 + 0.04, 0.42, 0.03, 0.14, shade(0x8a8f94, 0.08));
    builder.plane(
      0,
      height * 0.99,
      depth / 2 + 0.072,
      0.11,
      0.11,
      0xe8e2cf,
      0,
      0,
      MODEL_GLOW.windowDim,
    );
    builder.plane(0, height * 0.99, depth / 2 + 0.074, 0.08, 0.02, 0x33383b, 0);
    // Mât et drapeau.
    builder.box(width * 0.34, height * 0.9, -depth * 0.18, 0.018, 0.4, 0.018, 0x8a8f94);
    builder.plane(
      width * 0.4,
      height * 0.9 + 0.32,
      -depth * 0.18,
      0.16,
      0.1,
      0xb44a3e,
      Math.PI / 2,
    );
    // Arbres de façade gérés par la couche de props : rien ici.
  }
  return builder.build();
}

/**
 * Garantit qu'une géométrie unitaire est centrée sur sa tuile et ne dépasse
 * pas son empreinte.
 *
 * Les volumes sont dessinés autour de l'origine, mais un auvent, un escalier
 * ou une enseigne décale la boîte englobante : on recentre d'abord l'empreinte
 * sur zéro, puis on la ramène dans la marge si un détail dépasse. La base reste
 * à y = 0.
 */
function fitFootprint(
  geometry: THREE.BufferGeometry,
  limit = 0.49,
  centre = true,
): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const initial = geometry.boundingBox;
  if (!initial) return geometry;
  if (centre) {
    const centreX = (initial.min.x + initial.max.x) / 2;
    const centreZ = (initial.min.z + initial.max.z) / 2;
    if (Math.abs(centreX) > 1e-6 || Math.abs(centreZ) > 1e-6) {
      geometry.translate(-centreX, 0, -centreZ);
      geometry.computeBoundingBox();
    }
  }
  const box = geometry.boundingBox;
  if (!box) return geometry;
  const extent = Math.max(
    Math.abs(box.min.x),
    Math.abs(box.max.x),
    Math.abs(box.min.z),
    Math.abs(box.max.z),
  );
  if (extent > limit) {
    const scale = limit / extent;
    geometry.scale(scale, 1, scale);
    geometry.computeBoundingBox();
  }
  return geometry;
}

/** Géométrie d'un archétype, empreinte unitaire, base à y = 0. */
export function createBuildingGeometry(
  archetype: BuildingArchetype,
  variant: number,
  detail: BuildingDetail,
): THREE.BufferGeometry {
  const count = buildingVariantCount(archetype);
  const safeVariant = (((variant | 0) % count) + count) % count;
  switch (archetype) {
    case 'terrace':
      return fitFootprint(buildTerrace(safeVariant, detail));
    case 'apartment':
      return fitFootprint(buildApartment(safeVariant, detail));
    case 'shop':
      return fitFootprint(buildShop(safeVariant, detail));
    case 'office':
      return fitFootprint(buildOffice(safeVariant, detail));
    case 'church':
      return fitFootprint(buildChurch(safeVariant, detail));
    case 'warehouse':
      return fitFootprint(buildWarehouse(safeVariant, detail));
    case 'civic':
      return fitFootprint(buildCivic(safeVariant, detail));
    case 'house':
    default:
      return fitFootprint(buildHouse(safeVariant, detail));
  }
}

/** Silhouette minimale pour les villes lointaines : corps + toit, ~24 triangles. */
export function createDistantBuildingGeometry(): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  builder.box(0, 0, 0, 0.78, 0.68, 0.72, 0xc9b9a4);
  builder.prism(0, 0.68, 0, 0.82, 0.26, 0.76, 0x6b6259, {
    finish: MODEL_FINISH.satin,
  });
  builder.box(0, 0.94, 0, 0.06, 0.06, 0.06, 0x6b6259);
  return fitFootprint(builder.build());
}

/** Choisit un archétype déterministe selon la centralité et la graine de tuile. */
export function chooseBuildingArchetype(options: {
  seed: number;
  x: number;
  y: number;
  centrality: number;
  hasChurch: boolean;
}): BuildingArchetype {
  const value = hashUnit2d(options.seed, options.x, options.y);
  if (!options.hasChurch && options.centrality > 0.66 && value > 0.93) return 'church';
  const pick = hashUnit2d(options.seed + 0x9e37, options.y + 5, options.x + 11);
  // Toutes les villes n'ont pas de centre administratif : la variété reste
  // locale, et aucun lot civic n'est instancié dans les villes qui n'en ont pas.
  const allowCivic = hashUnit2d(options.seed + 0x9111, 5, 9) > 0.5;
  if (options.centrality >= 0.7) {
    if (pick < 0.3) return 'office';
    if (pick < 0.58) return 'apartment';
    if (pick < 0.8) return 'shop';
    if (pick < 0.86 && allowCivic) return 'civic';
    if (pick < 0.94) return 'terrace';
    return 'apartment';
  }
  if (options.centrality >= 0.45) {
    if (pick < 0.16) return 'apartment';
    if (pick < 0.28) return 'office';
    if (pick < 0.48) return 'shop';
    if (pick < 0.56 && allowCivic) return 'civic';
    if (pick < 0.8) return 'terrace';
    return 'house';
  }
  if (options.centrality >= 0.24) {
    if (pick < 0.14) return 'shop';
    if (pick < 0.5) return 'terrace';
    if (pick < 0.58) return 'apartment';
    if (pick < 0.64 && allowCivic) return 'civic';
    return 'house';
  }
  if (pick < 0.26) return 'warehouse';
  if (pick < 0.5) return 'terrace';
  if (pick < 0.58) return 'shop';
  return 'house';
}

// ---------------------------------------------------------------------------
// Props urbains
// ---------------------------------------------------------------------------

/** Mobilier urbain instancié par `TownPropsLayer`. */
export type TownPropKind =
  'lamp' | 'bench' | 'tree' | 'busStop' | 'sign' | 'garden' | 'fence' | 'plaza';

export const TOWN_PROP_KINDS: readonly TownPropKind[] = [
  'lamp',
  'bench',
  'tree',
  'busStop',
  'sign',
  'garden',
  'fence',
  'plaza',
];

const LAMP_GLOW = 0xfff0c0;

/**
 * Géométrie d'un prop, empreinte unitaire, base à y = 0.
 *
 * Le niveau de détail ne change pas la silhouette générale (un lampadaire reste
 * un lampadaire) mais retire bases, barreaux et détails : le passage près/loin
 * ne produit pas de popping structurel.
 */
export function createTownPropGeometry(
  kind: TownPropKind,
  detail: BuildingDetail,
): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  switch (kind) {
    case 'lamp': {
      if (detail >= 1) builder.box(0, 0, 0, 0.11, 0.035, 0.11, 0x4a4d52);
      builder.cylinder(0, 0.03, 0, 0.04, 0.56, 0x3f464e, { segments: 6, topScale: 0.7 });
      builder.box(0, 0.58, 0, 0.16, 0.028, 0.028, 0x3f464e);
      builder.box(0.07, 0.565, 0, 0.075, 0.055, 0.075, LAMP_GLOW, {
        glow: MODEL_GLOW.headlight,
      });
      if (detail >= 2) {
        builder.box(0.07, 0.545, 0, 0.095, 0.018, 0.095, 0x3b3a38);
        builder.box(0.07, 0.62, 0, 0.055, 0.02, 0.055, 0x3b3a38);
      }
      break;
    }
    case 'bench': {
      if (detail >= 2) {
        builder.box(0, 0.03, 0, 0.42, 0.035, 0.13, 0x8a6a45);
        builder.box(0, 0.07, -0.055, 0.42, 0.1, 0.03, 0x8a6a45);
        builder.box(-0.15, 0, 0, 0.035, 0.05, 0.11, 0x4a4d52);
        builder.box(0.15, 0, 0, 0.035, 0.05, 0.11, 0x4a4d52);
        builder.box(-0.15, 0.05, -0.055, 0.03, 0.09, 0.03, 0x4a4d52);
        builder.box(0.15, 0.05, -0.055, 0.03, 0.09, 0.03, 0x4a4d52);
      } else if (detail >= 1) {
        builder.box(0, 0.03, 0, 0.4, 0.035, 0.13, 0x8a6a45);
        builder.box(0, 0.065, -0.05, 0.4, 0.08, 0.03, 0x8a6a45);
        builder.box(-0.14, 0, 0, 0.04, 0.05, 0.12, 0x4a4d52);
        builder.box(0.14, 0, 0, 0.04, 0.05, 0.12, 0x4a4d52);
      } else {
        builder.box(0, 0.02, 0, 0.38, 0.06, 0.13, 0x8a6a45);
      }
      break;
    }
    case 'tree': {
      builder.cylinder(0, 0, 0, 0.055, 0.3, 0x5d4630, { segments: 5 });
      builder.add(
        new THREE.IcosahedronGeometry(0.5, 0),
        0,
        0.42,
        0,
        0.44,
        detail >= 1 ? 0.5 : 0.42,
        0.44,
        detail >= 2 ? 0x5d7f45 : 0x557040,
        { finish: MODEL_FINISH.paint },
      );
      if (detail >= 2) {
        builder.add(
          new THREE.IcosahedronGeometry(0.5, 0),
          0.08,
          0.34,
          -0.06,
          0.3,
          0.32,
          0.3,
          0x4f6d3b,
          { finish: MODEL_FINISH.paint },
        );
      }
      break;
    }
    case 'busStop': {
      builder.box(0, 0, 0, 0.42, 0.035, 0.3, 0x8a8f94);
      builder.box(-0.19, 0, 0, 0.03, 0.36, 0.03, 0x4a4d52);
      builder.box(0.19, 0, 0, 0.03, 0.36, 0.03, 0x4a4d52);
      builder.box(0, 0.36, 0, 0.46, 0.04, 0.34, 0x555a60);
      if (detail >= 1) {
        builder.plane(0.19, 0.2, 0.08, 0.22, 0.24, 0x40525f, Math.PI / 2, 0.5);
        builder.box(-0.05, 0, 0.06, 0.3, 0.045, 0.1, 0x8a6a45);
        builder.box(0.05, 0.04, 0.06, 0.3, 0.03, 0.09, 0x7a5c3a);
        builder.box(0.22, 0.02, 0.2, 0.02, 0.5, 0.02, 0x4a4d52);
        builder.box(0.22, 0.4, 0.2, 0.14, 0.1, 0.02, 0xd8b96a);
      }
      if (detail >= 2) {
        builder.plane(0.22, 0.4, 0.213, 0.1, 0.05, 0x3d4a55, 0, 0.6);
      }
      break;
    }
    case 'sign': {
      builder.box(0, 0, 0, 0.028, 0.42, 0.028, 0x4a4d52);
      builder.box(0, 0.42, 0, 0.26, 0.1, 0.02, 0xd8d2c4);
      builder.plane(0, 0.47, 0.012, 0.2, 0.055, 0x3d4a55, 0, 0);
      if (detail >= 2) {
        builder.box(0, 0.38, 0, 0.3, 0.02, 0.03, 0x4a4d52);
      }
      break;
    }
    case 'garden': {
      builder.box(0, 0, 0, 0.44, 0.05, 0.34, 0x7a5c3a);
      builder.box(0, 0.05, 0, 0.4, 0.02, 0.3, 0x4f3f2c);
      if (detail >= 1) {
        builder.box(-0.11, 0.05, -0.06, 0.14, 0.08, 0.14, 0x5d7f45);
        builder.box(0.1, 0.05, 0.05, 0.12, 0.07, 0.12, 0x6b8a4a);
        builder.box(0.13, 0.05, -0.08, 0.08, 0.05, 0.08, 0xb5625c);
        builder.box(-0.08, 0.05, 0.09, 0.07, 0.04, 0.07, 0xc7a24a);
        builder.box(-0.24, 0, 0, 0.02, 0.1, 0.34, 0xd8d2c4);
        builder.box(0.24, 0, 0, 0.02, 0.1, 0.34, 0xd8d2c4);
      }
      if (detail >= 2) {
        builder.box(0, 0, -0.19, 0.48, 0.1, 0.025, 0xd8d2c4);
        builder.box(-0.14, 0.05, 0.02, 0.06, 0.12, 0.06, 0x5d7f45);
      }
      break;
    }
    case 'fence': {
      const postColour = 0xd8d2c4;
      builder.box(-0.36, 0, 0, 0.035, 0.24, 0.035, postColour);
      builder.box(0, 0, 0, 0.035, 0.24, 0.035, postColour);
      builder.box(0.36, 0, 0, 0.035, 0.24, 0.035, postColour);
      builder.box(0, 0.14, 0, 0.76, 0.025, 0.025, postColour);
      if (detail >= 1) {
        builder.box(0, 0.06, 0, 0.76, 0.025, 0.025, postColour);
      }
      if (detail >= 2) {
        builder.box(0, 0, 0.06, 0.74, 0.1, 0.14, 0x5d7f45);
      }
      break;
    }
    case 'plaza': {
      builder.box(0, 0, 0, 0.9, 0.035, 0.9, 0x9c968a);
      builder.box(0, 0.035, 0, 0.8, 0.012, 0.8, 0xaaa294);
      if (detail >= 1) {
        builder.box(0, 0.035, 0.36, 0.9, 0.02, 0.06, 0xd8d2c4);
        builder.box(0, 0.035, -0.36, 0.9, 0.02, 0.06, 0xd8d2c4);
        builder.cylinder(0, 0.04, 0, 0.24, 0.1, 0x8a8f94, { segments: 8 });
        builder.cylinder(0, 0.14, 0, 0.06, 0.14, 0x8a8f94, { segments: 6 });
      }
      if (detail >= 2) {
        builder.box(0, 0.04, 0, 0.06, 0.18, 0.06, 0x8a8f94);
        builder.add(new THREE.IcosahedronGeometry(0.5, 0), 0, 0.24, 0, 0.09, 0.09, 0.09, 0xd8d2c4, {
          finish: MODEL_FINISH.accent,
        });
      }
      break;
    }
    default: {
      builder.box(0, 0, 0, 0.2, 0.2, 0.2, 0xc9b9a4);
    }
  }
  // Les props gardent leur asymétrie voulue (tête de lampadaire, enseigne) :
  // seule leur empreinte est ramenée dans la tuile, pas leur centre visuel.
  return fitFootprint(builder.build(), 0.47, false);
}

// ---------------------------------------------------------------------------
// Gares et dépôts
// ---------------------------------------------------------------------------

/** Gare : halle compacte (1×1) avec toit, auvent et signalétique. */
export function createStationHallGeometry(detail: BuildingDetail): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  const wall = 0xcac4b6;
  const roof = 0x555a60;
  builder.box(0, 0, -0.06, 0.7, 0.36, 0.46, wall);
  builder.prism(0, 0.36, -0.06, 0.76, 0.18, 0.52, roof, { finish: MODEL_FINISH.satin });
  // Auvent de quai tenu par deux poteaux.
  builder.box(0, 0.35, 0.31, 0.84, 0.03, 0.3, shade(roof, 0.08));
  builder.box(-0.34, 0, 0.4, 0.035, 0.35, 0.035, shade(wall, -0.18));
  builder.box(0.34, 0, 0.4, 0.035, 0.35, 0.035, shade(wall, -0.18));
  if (detail >= 1) {
    builder.plane(0.2, 0.16, 0.171, 0.13, 0.22, DOOR, 0, 0);
    builder.plane(-0.14, 0.21, 0.171, 0.12, 0.14, GLASS, 0, 0.7);
    builder.box(0, 0.42, 0.18, 0.36, 0.08, 0.02, TRIM);
    builder.plane(0, 0.42, 0.192, 0.24, 0.04, 0x3d4a55, 0, 0.5);
  }
  if (detail >= 2) {
    builder.box(0, 0, 0.31, 0.84, 0.035, 0.3, shade(0x8a8f94, 0.1));
    builder.box(-0.32, 0, 0.38, 0.12, 0.03, 0.14, shade(wall, -0.05));
  }
  return fitFootprint(builder.build());
}

/** Quai couvert : une tuile de plateforme instanciée par tuile de gare. */
export function createStationPlatformGeometry(detail: BuildingDetail): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  builder.box(0, 0, 0.12, 0.86, 0.09, 0.5, 0x7e8076);
  builder.box(0, 0.09, 0.36, 0.86, 0.012, 0.06, 0xd8d2c4);
  builder.box(-0.34, 0.09, 0.16, 0.035, 0.34, 0.035, 0x6b7176);
  builder.box(0.34, 0.09, 0.16, 0.035, 0.34, 0.035, 0x6b7176);
  builder.prism(0, 0.43, 0.12, 0.44, 0.12, 0.86, 0x555a60, {
    yaw: Math.PI / 2,
    finish: MODEL_FINISH.satin,
  });
  builder.box(0, 0.43, 0.12, 0.86, 0.022, 0.46, 0xd8d2c4);
  if (detail >= 1) {
    builder.box(-0.12, 0.09, 0.24, 0.16, 0.05, 0.06, 0x7a5c3a);
    builder.box(0.18, 0.09, 0.3, 0.04, 0.22, 0.04, 0x3d4a55);
    builder.plane(0.18, 0.3, 0.322, 0.14, 0.07, 0xe0dacb, 0, 0);
  }
  return fitFootprint(builder.build());
}

export type DepotKind = 'road' | 'rail';

/** Corps neutre d'un dépôt : murs, ouverture sombre et poteaux. */
export function createDepotBodyGeometry(
  kind: DepotKind,
  detail: BuildingDetail,
): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  const wall = kind === 'rail' ? 0x8f938f : 0x9a958a;
  builder.box(0, 0, -0.04, 0.76, 0.5, 0.5, wall);
  const openingWidth = kind === 'rail' ? 0.5 : 0.56;
  const openingHeight = kind === 'rail' ? 0.36 : 0.32;
  builder.plane(0, 0.02 + openingHeight / 2, 0.215, openingWidth, openingHeight, 0x33383b, 0, 0.55);
  builder.box(0, 0.02 + openingHeight, 0.218, openingWidth + 0.04, 0.03, 0.02, TRIM);
  // Lanterne au-dessus du seuil : petite emission chaude la nuit.
  builder.box(0, 0.02 + openingHeight + 0.05, 0.222, 0.06, 0.03, 0.025, 0xfff0c0, {
    glow: MODEL_GLOW.headlight,
  });
  builder.box(-0.42, 0, 0.32, 0.035, 0.36, 0.035, shade(wall, -0.15));
  builder.box(0.42, 0, 0.32, 0.035, 0.36, 0.035, shade(wall, -0.15));
  if (detail >= 1) {
    builder.plane(-0.26, 0.36, 0.216, 0.09, 0.09, GLASS, 0, 0.55);
    builder.box(0, 0.5, -0.04, 0.8, 0.04, 0.54, 0x6b7176);
  }
  if (kind === 'rail') {
    builder.box(-0.16, 0.02, 0.24, 0.035, 0.02, 0.5, 0x5c5348);
    builder.box(0.16, 0.02, 0.24, 0.035, 0.02, 0.5, 0x5c5348);
  } else {
    builder.box(0, 0.02, 0.24, 0.36, 0.015, 0.5, 0x4d4d4f);
  }
  return fitFootprint(builder.build());
}

/** Livrée coloriable d'un dépôt : toit, auvent et enseigne (couleur blanche). */
export function createDepotLiveryGeometry(kind: DepotKind): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  builder.prism(0, 0.5, -0.04, 0.84, 0.16, 0.58, 0xffffff, {
    finish: MODEL_FINISH.satin,
  });
  builder.box(0, 0.44, 0.3, 0.88, 0.03, 0.26, 0xffffff);
  builder.box(0, 0.36, 0.19, 0.42, 0.06, 0.02, 0xffffff);
  if (kind === 'rail') builder.box(0, 0.5, 0.44, 0.88, 0.03, 0.06, 0xffffff);
  return fitFootprint(builder.build());
}

/** Socle local d'une tuile de gare : épouse la pente, jamais une dalle globale. */
export function createStationBaseGeometry(): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  builder.box(0, 0, 0, 0.9, 1, 0.9, 0x68665c);
  builder.box(0, 0.94, 0, 0.92, 0.06, 0.92, 0x7c7a6e);
  return fitFootprint(builder.build(), 0.48);
}

/** Nombre de triangles d'une géométrie fusionnée. */
export function geometryTriangleCount(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}
