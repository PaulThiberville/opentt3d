/**
 * Modèles de bâtiments, gares et dépôts, construits en code Three.js.
 *
 * Aucun asset binaire : chaque archétype est une petite scène de boîtes,
 * prismes, cylindres et plans fusionnée en UNE géométrie à couleurs de
 * sommets. Les fenêtres sont des quads (2 triangles) marqués par l'attribut
 * `aWindow` : le shader de nuit les allume sans draw call ni matériau
 * supplémentaire. Les modèles sont exprimés dans une empreinte unitaire
 * (1×1 tuile, base à y = 0) puis posés par `InstancedMesh`.
 *
 * Budget : chaque archétype reste largement sous 2 000 triangles, y compris
 * au niveau de détail maximal. Les variantes sont déterministes : une même
 * graine produit toujours la même silhouette.
 */

import * as THREE from 'three';
import { Prng, hashUnit2d } from '../../game/prng';
import { hexToRgb } from '../tileVisuals';

export type BuildingArchetype = 'house' | 'apartment' | 'shop' | 'church' | 'warehouse';

export type BuildingDetail = 0 | 1 | 2;

export const BUILDING_ARCHETYPES: readonly BuildingArchetype[] = [
  'house',
  'apartment',
  'shop',
  'church',
  'warehouse',
];

/** Variantes géométriques par archétype : au plus 15 buckets détaillés. */
export const BUILDING_VARIANTS = 3;

/** Empreinte maximale d'un bâtiment, marge de 0,06 tuile sur chaque bord. */
export const MAX_BUILDING_FOOTPRINT = 0.88;

export interface BuildingModelStats {
  triangles: number;
  windows: number;
}

const WALL_PALETTES: Record<BuildingArchetype, readonly number[]> = {
  house: [0xd8cdb8, 0xcbbba1, 0xbfa98c, 0xd2d4cc, 0xc9b9a4],
  apartment: [0xb9b4a8, 0xc7c0b2, 0xa9b0b4, 0xd0c8b8],
  shop: [0xd3c3aa, 0xc9b9a4, 0xbfae92, 0xd8cbb2],
  church: [0xd8d2c4, 0xcac2b0, 0xe0dacb],
  warehouse: [0x9aa0a2, 0x8e938f, 0xa8a49a, 0x949a99],
};

const ROOF_PALETTES: Record<BuildingArchetype, readonly number[]> = {
  house: [0x8f4132, 0x7c3d31, 0x9b5240, 0x555a60],
  apartment: [0x454b55, 0x555a60, 0x3f444c],
  shop: [0x555a60, 0x6b5a48, 0x454b55],
  church: [0x4a4f57, 0x555a60, 0x3f444c],
  warehouse: [0x6b7176, 0x5c6268, 0x767c80],
};

const GLASS = 0x36434f;
const DOOR = 0x4a3527;
const TRIM = 0xe6dfcf;
const LIT_WINDOW = 1;

/** Petit constructeur de géométrie fusionnée, à couleurs de sommets. */
class ModelBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colours: number[] = [];
  private windows: number[] = [];
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
    options: { yaw?: number; tiltZ?: number; window?: number } = {},
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
    hexToRgb(colour, this.rgb);
    const count = position.count;
    for (let i = 0; i < count; i += 1) {
      this.positions.push(position.getX(i), position.getY(i), position.getZ(i));
      this.normals.push(
        normal ? normal.getX(i) : this.up.x,
        normal ? normal.getY(i) : this.up.y,
        normal ? normal.getZ(i) : this.up.z,
      );
      this.colours.push(this.rgb.r, this.rgb.g, this.rgb.b);
      this.windows.push(window);
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
    options: { yaw?: number; window?: number } = {},
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
    options: { yaw?: number } = {},
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
    options: { yaw?: number } = {},
  ): void {
    const geometry = new THREE.ConeGeometry(0.5, 1, 4);
    geometry.rotateY(Math.PI / 4);
    geometry.translate(0, 0.5, 0);
    this.add(geometry, x, baseY, z, width, height, depth, colour, options);
  }

  cylinder(
    x: number,
    baseY: number,
    z: number,
    diameter: number,
    height: number,
    colour: number,
    options: { segments?: number; topScale?: number } = {},
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
    this.add(geometry, x, baseY, z, diameter, height, diameter, colour);
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
  ): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.add(geometry, x, centreY, z, width, height, 1, colour, { yaw, window });
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    geometry.setAttribute('aWindow', new THREE.Float32BufferAttribute(this.windows, 1));
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
  return shade(palette[variant % palette.length] ?? 0xc9b9a4, rng.float(-0.035, 0.035));
}

function roofColour(archetype: BuildingArchetype, variant: number, rng: Prng): number {
  const palette = ROOF_PALETTES[archetype];
  return shade(palette[(variant + 1) % palette.length] ?? 0x555a60, rng.float(-0.04, 0.04));
}

/**
 * Fenêtres et porte réparties sur les quatre façades.
 *
 * Les vitrages sont de simples quads : aucune géométrie par fenêtre n'est
 * conservée séparément, tout est fusionné dans la géométrie du bâtiment.
 */
function addFacadeOpenings(
  builder: ModelBuilder,
  options: {
    x: number;
    z: number;
    width: number;
    depth: number;
    height: number;
    seed: number;
    glass?: number;
    door?: boolean;
    columns?: number;
  },
): void {
  const { x, z, width, depth, height, seed } = options;
  const glass = options.glass ?? GLASS;
  const rng = new Prng(seed);
  const floorHeight = 0.24;
  const floors = Math.max(1, Math.min(8, Math.floor((height - 0.1) / floorHeight)));
  const columnsZ = options.columns ?? Math.max(1, Math.min(4, Math.round(width / 0.2)));
  const columnsX = options.columns ?? Math.max(1, Math.min(4, Math.round(depth / 0.2)));
  const winWidth = Math.min(0.088, (width - 0.14) / Math.max(1, columnsZ) - 0.03);
  const winHeight = Math.min(0.1, floorHeight * 0.5);
  if (winWidth <= 0.025 || winHeight <= 0.025) return;

  const rowY = (floor: number): number => 0.075 + floor * floorHeight + winHeight / 2;
  const column = (index: number, count: number, span: number): number =>
    count === 1 ? 0 : -span / 2 + 0.06 + (index * (span - 0.12)) / (count - 1);

  for (let floor = 0; floor < floors; floor += 1) {
    for (let index = 0; index < columnsZ; index += 1) {
      const offset = column(index, columnsZ, width);
      const y = rowY(floor);
      if (y + winHeight / 2 > height - 0.03) continue;
      const lit = rng.chance(0.55) ? LIT_WINDOW : 0.35;
      builder.plane(x + offset, y, z + depth / 2 + 0.004, winWidth, winHeight, glass, 0, lit);
      builder.plane(x + offset, y, z - depth / 2 - 0.004, winWidth, winHeight, glass, Math.PI, lit);
    }
    for (let index = 0; index < columnsX; index += 1) {
      const offset = column(index, columnsX, depth);
      const y = rowY(floor);
      if (y + winHeight / 2 > height - 0.03) continue;
      const lit = rng.chance(0.55) ? LIT_WINDOW : 0.35;
      builder.plane(
        x + width / 2 + 0.004,
        y,
        z + offset,
        winWidth,
        winHeight,
        glass,
        Math.PI / 2,
        lit,
      );
      builder.plane(
        x - width / 2 - 0.004,
        y,
        z + offset,
        winWidth,
        winHeight,
        glass,
        -Math.PI / 2,
        lit,
      );
    }
  }

  if (options.door !== false) {
    const doorWidth = Math.min(0.15, width * 0.24);
    const doorHeight = Math.min(0.21, height * 0.42);
    builder.plane(
      x + width * 0.2,
      doorHeight / 2 + 0.006,
      z + depth / 2 + 0.006,
      doorWidth,
      doorHeight,
      DOOR,
      0,
    );
    builder.box(x + width * 0.2, 0, z + depth / 2 + 0.012, doorWidth + 0.03, 0.018, 0.03, TRIM);
  }
}

function buildHouse(variant: number, detail: BuildingDetail): THREE.BufferGeometry {
  const rng = new Prng(0x51a3 + variant * 977);
  const wall = facadeColour('house', variant, rng);
  const roof = roofColour('house', variant, rng);
  const builder = new ModelBuilder();
  const width = 0.72 + variant * 0.06;
  const depth = 0.68 + ((variant + 1) % 2) * 0.05;
  const height = 0.52 + variant * 0.06 + rng.float(0, 0.05);
  builder.box(0, 0, 0, width, height, depth, wall);
  const roofHeight = 0.27 + (variant === 1 ? 0.1 : 0);
  if (variant === 0) {
    builder.prism(0, height, 0, width + 0.04, roofHeight, depth + 0.05, roof);
  } else {
    builder.pyramid(0, height, 0, width + 0.05, roofHeight, depth + 0.06, roof);
  }
  if (detail >= 1) {
    addFacadeOpenings(builder, { x: 0, z: 0, width, depth, height, seed: 0x91 + variant });
  }
  if (detail >= 2) {
    const chimneyX = variant === 0 ? width * 0.24 : -width * 0.22;
    builder.box(chimneyX, height + roofHeight * 0.45, 0.02, 0.1, 0.32, 0.1, shade(roof, -0.12));
    builder.box(chimneyX, height + roofHeight * 0.45 + 0.32, 0.02, 0.13, 0.035, 0.13, 0x3b3a38);
    builder.box(0, 0, depth / 2 + 0.05, width * 0.8, 0.02, 0.12, shade(wall, -0.12));
    // Petit auvent au-dessus de la porte.
    builder.box(width * 0.2, 0.26, depth / 2 + 0.07, 0.22, 0.025, 0.13, roof);
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
  const height = 1.52 + variant * 0.22 + rng.float(0, 0.16);
  builder.box(0, 0, 0, width, height, depth, wall);
  if (variant === 0) {
    builder.box(0, height, 0, width + 0.02, 0.05, depth + 0.02, shade(wall, 0.08));
    // Acrotère : quatre murets minces.
    builder.box(0, height + 0.05, depth / 2, width, 0.06, 0.035, roof);
    builder.box(0, height + 0.05, -depth / 2, width, 0.06, 0.035, roof);
    builder.box(width / 2, height + 0.05, 0, 0.035, 0.06, depth, roof);
    builder.box(-width / 2, height + 0.05, 0, 0.035, 0.06, depth, roof);
    builder.box(width * 0.18, height + 0.05, -depth * 0.16, 0.2, 0.22, 0.2, shade(wall, -0.05));
  } else {
    builder.prism(0, height, 0, width + 0.04, 0.24, depth + 0.05, roof);
    builder.box(-width * 0.2, height + 0.12, 0, 0.1, 0.24, 0.1, shade(roof, -0.1));
  }
  if (detail >= 1) {
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x2f1 + variant,
      columns: 2,
    });
  }
  if (detail >= 2) {
    // Balcons filants sur la façade sud, tous les deux étages.
    const floors = Math.max(2, Math.floor((height - 0.15) / 0.21));
    for (let floor = 1; floor < floors; floor += 2) {
      const y = 0.06 + floor * 0.24;
      builder.box(0, y, depth / 2 + 0.06, width * 0.72, 0.022, 0.13, shade(wall, 0.1));
      builder.box(0, y + 0.022, depth / 2 + 0.12, width * 0.72, 0.07, 0.02, roof);
    }
    builder.box(0, 0, depth / 2 + 0.06, width * 0.42, 0.025, 0.12, roof);
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
  const height = 0.78 + variant * 0.12;
  builder.box(0, 0, 0, width, height, depth, wall);
  if (variant === 0) {
    builder.prism(0, height, 0, width + 0.05, 0.24, depth + 0.04, roof);
  } else {
    builder.box(0, height, 0, width + 0.02, 0.06, depth + 0.02, shade(wall, 0.06));
    builder.box(0, height + 0.06, depth / 2, width, 0.05, 0.03, roof);
  }
  if (detail >= 1) {
    // Devanture : deux grands vitrages et une porte latérale.
    const glass = 0x40525f;
    builder.plane(-width * 0.18, 0.3, depth / 2 + 0.005, width * 0.3, 0.3, glass, 0, 0.7);
    builder.plane(width * 0.14, 0.3, depth / 2 + 0.005, width * 0.24, 0.3, glass, 0, 0.7);
    builder.plane(width * 0.34, 0.16, depth / 2 + 0.006, 0.13, 0.26, DOOR, 0);
    builder.plane(width * 0.34, 0.16, depth / 2 + 0.008, 0.09, 0.16, 0x2c3b45, 0, 0.6);
    // Enseigne au-dessus de la devanture.
    builder.box(0, 0.5, depth / 2 + 0.015, width * 0.72, 0.09, 0.02, TRIM);
    addFacadeOpenings(builder, {
      x: 0,
      z: 0,
      width,
      depth,
      height,
      seed: 0x77 + variant,
      columns: 2,
      door: false,
    });
  }
  if (detail >= 2) {
    // Auvent rayé et petits bacs de marchandises.
    builder.box(
      0,
      0.44,
      depth / 2 + 0.04,
      width * 0.68,
      0.03,
      0.14,
      variant === 0 ? 0xa2463c : 0x3f6b52,
    );
    builder.box(-width * 0.28, 0.44, depth / 2 + 0.12, 0.03, 0.12, 0.02, TRIM);
    builder.box(width * 0.28, 0.44, depth / 2 + 0.12, 0.03, 0.12, 0.02, TRIM);
    builder.box(-width * 0.34, 0, depth / 2 + 0.04, 0.12, 0.08, 0.09, 0x8a6a45);
    builder.box(-width * 0.34, 0.08, depth / 2 + 0.04, 0.1, 0.06, 0.08, 0x9b7a52);
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
  builder.prism(0, height, 0, width + 0.05, 0.48, depth + 0.06, roof);
  // Clocher décalé sur un coin : jamais hors de l'empreinte unitaire.
  const towerX = -width / 2 + 0.11;
  const towerZ = depth / 2 - 0.11;
  builder.box(towerX, 0, towerZ, 0.24, 1.18, 0.24, shade(wall, 0.03));
  builder.box(towerX, 1.18, towerZ, 0.28, 0.06, 0.28, shade(wall, 0.1));
  builder.pyramid(towerX, 1.24, towerZ, 0.32, 0.34, 0.32, roof);
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
  }
  if (detail >= 2) {
    // Contreforts et cloche visible sous l'abri du clocher.
    builder.box(-width / 2 - 0.015, 0, -0.18, 0.055, height * 0.72, 0.08, shade(wall, -0.08));
    builder.box(width / 2 + 0.015, 0, -0.18, 0.055, height * 0.72, 0.08, shade(wall, -0.08));
    builder.box(towerX, 0.82, towerZ, 0.13, 0.16, 0.13, 0xb59b52);
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
      builder.prism(offset, height, 0, width / 3 + 0.01, 0.14, depth + 0.03, roof);
    }
  } else {
    builder.box(0, height, 0, width + 0.02, 0.04, depth + 0.02, shade(wall, 0.05));
    builder.box(-width * 0.2, height + 0.04, 0, 0.16, 0.1, 0.16, shade(roof, -0.05));
    builder.box(width * 0.24, height + 0.04, 0, 0.1, 0.14, 0.1, shade(roof, -0.1));
  }
  // Grand rideau de quai + quais de chargement.
  builder.plane(0, 0.19, depth / 2 + 0.005, 0.42, 0.32, 0x4c4f52, 0);
  builder.box(0, 0.32, depth / 2 + 0.008, 0.46, 0.03, 0.03, TRIM);
  builder.box(0, 0, depth / 2 + 0.04, width * 0.9, 0.08, 0.12, shade(wall, -0.12));
  if (detail >= 2) {
    builder.box(-0.28, 0.08, depth / 2 + 0.04, 0.12, 0.1, 0.09, 0x7a5c3a);
    builder.box(0.3, 0.08, depth / 2 + 0.04, 0.1, 0.08, 0.09, 0x8a6a45);
    builder.box(0.3, 0.16, depth / 2 + 0.04, 0.08, 0.07, 0.08, 0x9b7a52);
    builder.box(0, height + 0.02, -depth / 2 + 0.06, 0.2, 0.06, 0.12, 0x6b7176);
  }
  if (detail >= 1) {
    // Bandeau de petits vitrages hauts.
    builder.plane(0, height * 0.72, depth / 2 + 0.006, width * 0.6, 0.07, GLASS, 0, 0.5);
    builder.plane(width / 2 + 0.006, height * 0.6, 0, 0.05, 0.12, GLASS, Math.PI / 2, 0.5);
  }
  return builder.build();
}

/**
 * Garantit qu'une géométrie unitaire ne dépasse pas l'empreinte de tuile.
 * Les volumes sont déjà dessinés dans cette marge ; ce garde-fou couvre les
 * détails ajoutés (auvents, enseignes, escaliers) sans déformer le reste.
 */
function fitFootprint(geometry: THREE.BufferGeometry, limit = 0.49): THREE.BufferGeometry {
  geometry.computeBoundingBox();
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
  const safeVariant = (((variant | 0) % BUILDING_VARIANTS) + BUILDING_VARIANTS) % BUILDING_VARIANTS;
  switch (archetype) {
    case 'apartment':
      return fitFootprint(buildApartment(safeVariant, detail));
    case 'shop':
      return fitFootprint(buildShop(safeVariant, detail));
    case 'church':
      return fitFootprint(buildChurch(safeVariant, detail));
    case 'warehouse':
      return fitFootprint(buildWarehouse(safeVariant, detail));
    case 'house':
    default:
      return fitFootprint(buildHouse(safeVariant, detail));
  }
}

/** Silhouette minimale pour les villes lointaines : corps + toit, ~24 triangles. */
export function createDistantBuildingGeometry(): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  builder.box(0, 0, 0, 0.78, 0.68, 0.72, 0xc9b9a4);
  builder.prism(0, 0.68, 0, 0.82, 0.26, 0.76, 0x6b6259);
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
  if (options.centrality > 0.48 && value > 0.6) return 'apartment';
  if (value > 0.52) return 'shop';
  if (options.centrality < 0.34 && value < 0.24) return 'warehouse';
  return 'house';
}

/** Gare : halle compacte (1×1) avec toit, auvent et signalétique. */
export function createStationHallGeometry(detail: BuildingDetail): THREE.BufferGeometry {
  const builder = new ModelBuilder();
  const wall = 0xcac4b6;
  const roof = 0x555a60;
  builder.box(0, 0, -0.06, 0.7, 0.36, 0.46, wall);
  builder.prism(0, 0.36, -0.06, 0.76, 0.18, 0.52, roof);
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
  builder.prism(0, 0.43, 0.12, 0.44, 0.12, 0.86, 0x555a60, { yaw: Math.PI / 2 });
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
  builder.plane(0, 0.02 + openingHeight / 2, 0.215, openingWidth, openingHeight, 0x33383b, 0);
  builder.box(0, 0.02 + openingHeight, 0.218, openingWidth + 0.04, 0.03, 0.02, TRIM);
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
  builder.prism(0, 0.5, -0.04, 0.84, 0.16, 0.58, 0xffffff);
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
