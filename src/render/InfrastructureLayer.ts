/**
 * Ouvrages d'art du réseau fluvial et passages à niveau (#158/#159).
 *
 * Cette couche ne crée aucun asset : elle construit un maillage fusionné à
 * couleurs de sommets pour les écluses, les aqueducs et les passages à niveau,
 * plus un second maillage pour les feux rouges. Les canaux eux-mêmes restent
 * rendus par la couche d'eau du terrain (tuiles `canal`).
 *
 * Les tuiles `aqueduct` portent leur niveau de tablier dans `trackBits` (valeur
 * brute 0..15) : le mock y encode le niveau d'eau, le pont WASM le dérive de la
 * hauteur de la tuile. Aucune texture n'est nécessaire.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { TILE_KIND_INDEX, TRACK_BIT_CROSSING_RAIL } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { hexToRgb } from './tileVisuals';

const K = TILE_KIND_INDEX;

const STONE = 0x8b8377;
const STONE_DARK = 0x6d675e;
const METAL = 0x3d474f;
const WATER = 0x2f6f96;
const ASPHALT = 0x3f4347;
const RAIL = 0xc3cad0;
const SLEEPER = 0x503c2c;
const BARRIER_RED = 0xb83a32;
const BARRIER_WHITE = 0xe6e1d2;
const LIGHT_RED = 0xff4b3e;
const LIGHT_DARK = 0x5a1712;

type Rgb = readonly [number, number, number];

interface Builder {
  positions: number[];
  colours: number[];
}

function createBuilder(): Builder {
  return { positions: [], colours: [] };
}

function pushVertex(builder: Builder, x: number, y: number, z: number, colour: Rgb): void {
  builder.positions.push(x, y, z);
  builder.colours.push(colour[0], colour[1], colour[2]);
}

function tint(hex: number, factor = 1): Rgb {
  const rgb = hexToRgb(hex);
  return [rgb.r * factor, rgb.g * factor, rgb.b * factor];
}

/** Boîte alignée sur les axes, exprimée en centre + demi-dimensions. */
function addBox(
  builder: Builder,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  colour: Rgb,
): void {
  const x0 = cx - hx;
  const x1 = cx + hx;
  const y0 = cy - hy;
  const y1 = cy + hy;
  const z0 = cz - hz;
  const z1 = cz + hz;
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ): void => {
    pushVertex(builder, ...a, colour);
    pushVertex(builder, ...b, colour);
    pushVertex(builder, ...c, colour);
    pushVertex(builder, ...a, colour);
    pushVertex(builder, ...c, colour);
    pushVertex(builder, ...d, colour);
  };
  quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
}

function addCylinder(
  builder: Builder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  height: number,
  sides: number,
  colour: Rgb,
): void {
  const half = height / 2;
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2;
    const b = ((i + 1) / sides) * Math.PI * 2;
    const x0 = cx + Math.cos(a) * radius;
    const z0 = cz + Math.sin(a) * radius;
    const x1 = cx + Math.cos(b) * radius;
    const z1 = cz + Math.sin(b) * radius;
    pushVertex(builder, x0, cy - half, z0, colour);
    pushVertex(builder, x1, cy - half, z1, colour);
    pushVertex(builder, x1, cy + half, z1, colour);
    pushVertex(builder, x0, cy - half, z0, colour);
    pushVertex(builder, x1, cy + half, z1, colour);
    pushVertex(builder, x0, cy + half, z0, colour);
  }
}

function tileGround(map: MapSnapshot, x: number, y: number): number {
  return sampleHeightWorld(map, x + 0.5, y + 0.5);
}

/** Axe d'un aqueduc déduit de ses voisins (tablier ou canal de même niveau). */
function aqueductAxis(map: MapSnapshot, x: number, y: number): 'x' | 'y' {
  let horizontal = 0;
  let vertical = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
    const kind = map.kind[ny * map.width + nx] ?? 0;
    if (kind !== K.aqueduct && kind !== K.canal) continue;
    if (dx !== 0) horizontal += 1;
    else vertical += 1;
  }
  return horizontal >= vertical ? 'x' : 'y';
}

function emitLock(builder: Builder, lights: Builder, map: MapSnapshot, x: number, y: number): void {
  const ground = tileGround(map, x, y);
  const index = y * map.width + x;
  const bits = (map.trackBits[index] ?? 0) & 0x0f;
  let horizontal = 0;
  let vertical = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
    const kind = map.kind[ny * map.width + nx] ?? 0;
    if (kind !== K.water && kind !== K.canal && kind !== K.river && kind !== K.lock) continue;
    if (dx !== 0) horizontal += 1;
    else vertical += 1;
  }
  const axis: 'x' | 'y' =
    horizontal === 0 && vertical === 0
      ? (bits & 0x0a) !== 0
        ? 'x'
        : 'y'
      : horizontal >= vertical
        ? 'x'
        : 'y';
  const cx = x + 0.5;
  const cz = y + 0.5;
  const stone = tint(STONE);
  const dark = tint(STONE_DARK);
  const metal = tint(METAL);

  const across = axis === 'x' ? 'z' : 'x';
  const along = axis === 'x' ? 'x' : 'z';
  const halfSpan = 0.4;
  const chamber = 0.26;

  for (const sign of [-1, 1]) {
    const px = cx + (along === 'x' ? sign * chamber : 0);
    const pz = cz + (along === 'z' ? sign * chamber : 0);
    for (const side of [-1, 1]) {
      const ox = px + (across === 'x' ? side * halfSpan : 0);
      const oz = pz + (across === 'z' ? side * halfSpan : 0);
      addBox(builder, ox, ground + 0.36, oz, 0.075, 0.36, 0.075, stone);
      addBox(builder, ox, ground + 0.73, oz, 0.1, 0.035, 0.1, dark);
      addBox(lights, ox, ground + 0.78, oz, 0.035, 0.035, 0.035, tint(LIGHT_RED));
    }
    // Glissière et poutre du pont-levis, perpendiculaires au courant.
    addBox(
      builder,
      px,
      ground + 0.56,
      pz,
      across === 'x' ? halfSpan : 0.035,
      0.035,
      across === 'z' ? halfSpan : 0.035,
      metal,
    );
    addBox(
      builder,
      px,
      ground + 0.66,
      pz,
      across === 'x' ? 0.035 : 0.09,
      0.09,
      across === 'z' ? 0.035 : 0.09,
      dark,
    );
  }
  // Radier et bajoyer discrets, pour lire l'ouvrage même de loin.
  addBox(
    builder,
    cx,
    ground + 0.06,
    cz,
    along === 'x' ? chamber * 2 : halfSpan,
    0.05,
    along === 'z' ? chamber * 2 : halfSpan,
    dark,
  );
}

/** Niveau du tablier : bief voisin le plus proche, sinon encodage du mock. */
function aqueductLevel(map: MapSnapshot, x: number, y: number, axis: 'x' | 'y'): number {
  for (let step = 1; step <= 32; step += 1) {
    for (const sign of [-1, 1]) {
      const nx = x + (axis === 'x' ? sign * step : 0);
      const ny = y + (axis === 'y' ? sign * step : 0);
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) break;
      const index = ny * map.width + nx;
      const kind = map.kind[index] ?? 0;
      if (kind === K.canal || kind === K.water || kind === K.river || kind === K.lock) {
        return Math.max(0, Math.min(15, map.heightMap[index] ?? 0));
      }
    }
  }
  const raw = (map.trackBits[y * map.width + x] ?? 0) & 0x0f;
  return raw <= 15 ? raw : 0;
}

function emitAqueduct(
  builder: Builder,
  lights: Builder,
  map: MapSnapshot,
  x: number,
  y: number,
): void {
  const axis = aqueductAxis(map, x, y);
  const level = aqueductLevel(map, x, y, axis);
  const deck = level * 0.5 + 0.5;
  const ground = tileGround(map, x, y);
  const cx = x + 0.5;
  const cz = y + 0.5;
  const stone = tint(STONE);
  const dark = tint(STONE_DARK);
  const water = tint(WATER);
  const alongX = axis === 'x';

  // Tablier : radier, bajoyers et eau, continus d'une tuile à l'autre.
  addBox(builder, cx, deck - 0.2, cz, alongX ? 0.5 : 0.4, 0.07, alongX ? 0.4 : 0.5, dark);
  for (const side of [-1, 1]) {
    addBox(
      builder,
      cx + (alongX ? 0 : side * 0.37),
      deck - 0.08,
      cz + (alongX ? side * 0.37 : 0),
      alongX ? 0.5 : 0.05,
      0.14,
      alongX ? 0.05 : 0.5,
      stone,
    );
  }
  addBox(builder, cx, deck - 0.02, cz, alongX ? 0.48 : 0.32, 0.025, alongX ? 0.32 : 0.48, water);

  // Piles jusqu'au fond du val, avec un chapeau et un feu de balisage.
  const pierHeight = Math.max(0.25, deck - 0.28 - ground);
  for (const offset of [-0.3, 0.3]) {
    const px = cx + (alongX ? offset : 0);
    const pz = cz + (alongX ? 0 : offset);
    addBox(builder, px, ground + pierHeight / 2, pz, 0.11, pierHeight / 2, 0.11, stone);
    addBox(builder, px, ground + pierHeight + 0.04, pz, 0.16, 0.04, 0.16, dark);
    if (pierHeight > 0.6) {
      addBox(builder, px, deck - 0.34, pz, alongX ? 0.26 : 0.06, 0.06, alongX ? 0.06 : 0.26, dark);
    }
  }
  if (pierHeight > 0.75) {
    addBox(builder, cx, ground + Math.min(1.1, pierHeight * 0.55), cz, 0.09, 0.55, 0.09, dark);
  }
  addCylinder(lights, cx, deck - 0.24, cz, 0.045, 0.05, 6, tint(LIGHT_RED));
}

function emitCrossing(
  builder: Builder,
  lights: Builder,
  map: MapSnapshot,
  x: number,
  y: number,
): void {
  const ground = tileGround(map, x, y);
  const index = y * map.width + x;
  const bits = map.trackBits[index] ?? 0;
  const low = bits & 0x0f;
  const mockAxis: 'x' | 'y' | null = low === 0x0a ? 'x' : low === 0x05 ? 'y' : null;

  // Le mock encode l'axe et le réseau dans `trackBits` ; le pont WASM y laisse
  // le m8 brut. On retombe alors sur le voisinage : les rails prolongent le
  // passage sur un axe, la route sur l'autre.
  let railAxis: 'x' | 'y';
  if (mockAxis) {
    railAxis = (bits & TRACK_BIT_CROSSING_RAIL) !== 0 ? mockAxis : mockAxis === 'x' ? 'y' : 'x';
  } else {
    let horizontalRail = 0;
    let verticalRail = 0;
    let horizontalRoad = 0;
    let verticalRoad = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const kind = map.kind[ny * map.width + nx] ?? 0;
      if (kind === K.rail) {
        if (dx !== 0) horizontalRail += 1;
        else verticalRail += 1;
      } else if (kind === K.road) {
        if (dx !== 0) horizontalRoad += 1;
        else verticalRoad += 1;
      }
    }
    if (horizontalRail + verticalRail > 0) {
      railAxis = horizontalRail >= verticalRail ? 'x' : 'y';
    } else if (horizontalRoad + verticalRoad > 0) {
      railAxis = horizontalRoad >= verticalRoad ? 'y' : 'x';
    } else {
      railAxis = 'x';
    }
  }
  const roadAxis = railAxis === 'x' ? 'y' : 'x';
  const cx = x + 0.5;
  const cz = y + 0.5;
  const alongX = railAxis === 'x';

  // Chaussée perpendiculaire à la voie, puis traverses et rails.
  addBox(
    builder,
    cx,
    ground + 0.035,
    cz,
    roadAxis === 'x' ? 0.5 : 0.36,
    0.035,
    roadAxis === 'x' ? 0.36 : 0.5,
    tint(ASPHALT),
  );
  for (let i = -2; i <= 2; i += 1) {
    const offset = i * 0.19;
    addBox(
      builder,
      cx + (alongX ? offset : 0),
      ground + 0.055,
      cz + (alongX ? 0 : offset),
      alongX ? 0.055 : 0.32,
      0.018,
      alongX ? 0.32 : 0.055,
      tint(SLEEPER),
    );
  }
  for (const side of [-1, 1]) {
    addBox(
      builder,
      cx + (alongX ? 0 : side * 0.19),
      ground + 0.09,
      cz + (alongX ? side * 0.19 : 0),
      alongX ? 0.5 : 0.025,
      0.025,
      alongX ? 0.025 : 0.5,
      tint(RAIL),
    );
  }

  // Barrières et feux : deux mâts de chaque côté de la chaussée.
  const acrossRail = alongX ? 'z' : 'x';
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const px = cx + (acrossRail === 'x' ? side * 0.4 : end * 0.38);
      const pz = cz + (acrossRail === 'z' ? side * 0.4 : end * 0.38);
      addBox(builder, px, ground + 0.26, pz, 0.04, 0.26, 0.04, tint(BARRIER_WHITE));
      addBox(builder, px, ground + 0.5, pz, 0.055, 0.055, 0.055, tint(LIGHT_RED));
      addBox(lights, px, ground + 0.5, pz, 0.035, 0.035, 0.035, tint(LIGHT_RED));
      // Bras abaissé, rayé rouge/blanc, le long de la route.
      for (let segment = 0; segment < 3; segment += 1) {
        const offset = (segment - 1) * 0.15;
        addBox(
          builder,
          px + (roadAxis === 'x' ? offset : 0),
          ground + 0.42,
          pz + (roadAxis === 'y' ? offset : 0),
          roadAxis === 'x' ? 0.075 : 0.025,
          0.025,
          roadAxis === 'y' ? 0.075 : 0.025,
          tint(segment % 2 === 0 ? BARRIER_RED : BARRIER_WHITE),
        );
      }
    }
  }
}

export class InfrastructureLayer {
  readonly group = new THREE.Group();

  private structures: THREE.Mesh | null = null;
  private lights: THREE.Mesh | null = null;
  private structureMaterial: THREE.MeshLambertMaterial;
  private lightMaterial: THREE.MeshBasicMaterial;
  private map: MapSnapshot | null = null;
  private locks = 0;
  private aqueducts = 0;
  private crossings = 0;
  private lightColour = new THREE.Color(LIGHT_RED);

  constructor() {
    this.group.name = 'infrastructure';
    this.structureMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.lightMaterial = new THREE.MeshBasicMaterial({
      color: LIGHT_RED,
      toneMapped: false,
    });
  }

  get lockCount(): number {
    return this.locks;
  }

  get aqueductCount(): number {
    return this.aqueducts;
  }

  get crossingCount(): number {
    return this.crossings;
  }

  /** Reconstruit les ouvrages ; les canaux restent dans la couche d'eau. */
  setMap(map: MapSnapshot): void {
    this.map = map;
    this.rebuild();
  }

  applyDelta(map: MapSnapshot): void {
    this.map = map;
    this.rebuild();
  }

  private rebuild(): void {
    const map = this.map;
    if (!map) return;
    this.disposeMeshes();
    this.locks = 0;
    this.aqueducts = 0;
    this.crossings = 0;
    const builder = createBuilder();
    const lights = createBuilder();

    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const kind = map.kind[y * map.width + x] ?? 0;
        if (kind === K.lock) {
          this.locks += 1;
          emitLock(builder, lights, map, x, y);
        } else if (kind === K.aqueduct) {
          this.aqueducts += 1;
          emitAqueduct(builder, lights, map, x, y);
        } else if (kind === K.crossing) {
          this.crossings += 1;
          emitCrossing(builder, lights, map, x, y);
        }
      }
    }

    this.structures = this.createMesh(builder, this.structureMaterial, 'infrastructure-structures');
    this.lights = this.createMesh(lights, this.lightMaterial, 'infrastructure-lights');
    if (this.structures) this.group.add(this.structures);
    if (this.lights) this.group.add(this.lights);
  }

  private createMesh(builder: Builder, material: THREE.Material, name: string): THREE.Mesh | null {
    if (builder.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(builder.positions), 3),
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(builder.colours), 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  /** 0 = jour, 1 = nuit : les feux rouges gagnent en intensité la nuit. */
  setNight(amount: number): void {
    const value = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    const dark = new THREE.Color(LIGHT_DARK);
    const bright = new THREE.Color(LIGHT_RED);
    this.lightColour.copy(dark).lerp(bright, 0.45 + value * 0.55);
    this.lightMaterial.color.copy(this.lightColour);
  }

  private disposeMeshes(): void {
    for (const mesh of [this.structures, this.lights]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.structures = null;
    this.lights = null;
  }

  dispose(): void {
    this.disposeMeshes();
    this.group.clear();
    this.structureMaterial.dispose();
    this.lightMaterial.dispose();
    this.map = null;
  }
}
