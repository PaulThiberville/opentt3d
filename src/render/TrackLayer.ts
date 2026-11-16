/**
 * Géométrie 3D des routes et voies ferrées.
 *
 * `TrackLayer` construit un maillage fusionné par chunk à partir des plans de
 * `trackPlan.ts` : chaussée pleine tuile et trottoirs sur les seuls bords non
 * connectés pour les routes, ballast, traverses et deux files de rails pour les
 * voies. Tout est fusionné dans UNE géométrie à couleurs de sommets par chunk
 * (un seul draw call), avec un second maillage plus détaillé pour le LOD proche
 * (jamais dessiné en même temps que le premier).
 *
 * Les sommets sont posés exactement sur la triangulation du terrain (même
 * découpage diagonal que `TerrainLayer`) puis surélevés de quelques
 * centimètres : pas de z-fighting, pas de fissure aux bords de chunk, et les
 * véhicules (posés à `sol + 0,09`) reposent sur les rails.
 *
 * Aucune texture ni asset : tout est construit en code, de façon déterministe.
 */

import * as THREE from 'three';
import type { MapSnapshot, RailType, StationSnapshot } from '../engine/protocol';
import { TILE_KIND_INDEX } from '../engine/protocol';
import { cornerHeightWorld } from '../game/mapGrid';
import { qualitySettings, type QualityLevel } from './quality';
import { hexToRgb } from './tileVisuals';
import {
  TRACK_CONNECT,
  TRACK_CORNER,
  buildTrackMasks,
  inferTilePlan,
  popCount,
  type TrackMasks,
  type TrackTilePlan,
} from './trackPlan';

export const TRACK_CHUNK_SIZE = 32;

/**
 * Largeur du trottoir posé à l'intérieur des bords non connectés. La chaussée,
 * elle, couvre toute la tuile : deux tuiles voisines partagent donc exactement
 * la même arête, sans trou ni couture aux carrefours.
 */
const SIDEWALK_WIDTH = 0.11;
const SIDEWALK_LIFT = 0.07;
const ROAD_LIFT = 0.032;
const MARK_WIDTH = 0.03;
const MARK_LIFT = ROAD_LIFT + 0.008;
const MARK_PERIOD = 0.62;
const MARK_DASH = 0.3;

const BALLAST_HALF = 0.36;
const BALLAST_LIFT = 0.018;
const BALLAST_BOTTOM_EXPAND = 0.07;

const SLEEPER_LENGTH = 0.56;
const SLEEPER_WIDTH = 0.088;
const SLEEPER_HEIGHT = 0.032;
const SLEEPER_SPACING = 0.3;
const SLEEPER_BOTTOM_LIFT = BALLAST_LIFT;
const SLEEPER_TOP_LIFT = SLEEPER_BOTTOM_LIFT + SLEEPER_HEIGHT;

const GAUGE_HALF = 0.19;
const RAIL_HALF = 0.024;
const RAIL_TOP_LIFT = 0.088;
const RAIL_BOTTOM_LIFT = 0.04;
/** Léger décalage pour éviter un z-fighting aux croisements de rails. */
const RAIL_CROSS_LIFT = 0.004;

const ROAD_COLOUR = 0x3f4347;
const ROAD_SIDE_COLOUR = 0x34383b;
const CURB_COLOUR = 0xa39d92;
const MARK_COLOUR = 0xe8e2cf;
const BALLAST_COLOUR = 0x6a6056;
const BALLAST_SIDE_COLOUR = 0x5d554c;
const SLEEPER_COLOUR = 0x503c2c;
const RAIL_COLOUR = 0xc3cad0;
const RAIL_SIDE_COLOUR = 0x8c949b;

const ROAD_NIGHT: Rgb = [0.018, 0.016, 0.013];
const CURB_NIGHT: Rgb = [0.055, 0.052, 0.047];
const MARK_NIGHT: Rgb = [0.32, 0.3, 0.24];
const BALLAST_NIGHT: Rgb = [0.012, 0.011, 0.01];
const SLEEPER_NIGHT: Rgb = [0.02, 0.015, 0.01];
const RAIL_NIGHT: Rgb = [0.17, 0.2, 0.23];

interface RailPalette {
  ballast: number;
  ballastSide: number;
  sleeper: number;
  rail: number;
  railSide: number;
  railNight: Rgb;
  sleepers: boolean;
  gaugeHalf: number;
  railHalf: number;
}

const RAIL_PALETTES: Record<RailType, RailPalette> = {
  rail: {
    ballast: BALLAST_COLOUR,
    ballastSide: BALLAST_SIDE_COLOUR,
    sleeper: SLEEPER_COLOUR,
    rail: RAIL_COLOUR,
    railSide: RAIL_SIDE_COLOUR,
    railNight: RAIL_NIGHT,
    sleepers: true,
    gaugeHalf: GAUGE_HALF,
    railHalf: RAIL_HALF,
  },
  electrified: {
    ballast: BALLAST_COLOUR,
    ballastSide: BALLAST_SIDE_COLOUR,
    sleeper: SLEEPER_COLOUR,
    rail: 0xd8e2e9,
    railSide: 0x9aa7b0,
    railNight: [0.2, 0.24, 0.28],
    sleepers: true,
    gaugeHalf: GAUGE_HALF,
    railHalf: RAIL_HALF,
  },
  monorail: {
    ballast: 0x8d8a84,
    ballastSide: 0x74716c,
    sleeper: 0x8d8a84,
    rail: 0xd2d5d8,
    railSide: 0x9fa4a8,
    railNight: [0.17, 0.18, 0.2],
    sleepers: false,
    gaugeHalf: 0,
    railHalf: 0.11,
  },
  maglev: {
    ballast: 0xb9bcc2,
    ballastSide: 0x989ca3,
    sleeper: 0xb9bcc2,
    rail: 0xeef2f6,
    railSide: 0xb9c2ca,
    railNight: [0.22, 0.24, 0.27],
    sleepers: false,
    gaugeHalf: 0,
    railHalf: 0.13,
  },
};

type Rgb = readonly [number, number, number];

export interface Pt2 {
  x: number;
  z: number;
}

interface Pt3 {
  x: number;
  y: number;
  z: number;
}

interface GeometryWriter {
  positions: number[];
  colours: number[];
  night: number[];
}

interface TrackChunk {
  cx: number;
  cy: number;
  key: number;
  base: THREE.Mesh;
  detail: THREE.Mesh | null;
  baseTriangles: number;
  detailTriangles: number;
  centreX: number;
  centreZ: number;
  showingDetail: boolean;
}

interface MapArrays {
  width: number;
  height: number;
  kind: Uint8Array;
  heightMap: Uint8Array;
  flags: Uint8Array;
}

function createWriter(): GeometryWriter {
  return { positions: [], colours: [], night: [] };
}

function writerTriangles(writer: GeometryWriter): number {
  return writer.positions.length / 9;
}

function pushVertex(writer: GeometryWriter, point: Pt3, colour: Rgb, glow: Rgb): void {
  writer.positions.push(point.x, point.y, point.z);
  writer.colours.push(colour[0], colour[1], colour[2]);
  writer.night.push(glow[0], glow[1], glow[2]);
}

function addTriangle(writer: GeometryWriter, a: Pt3, b: Pt3, c: Pt3, colour: Rgb, glow: Rgb): void {
  pushVertex(writer, a, colour, glow);
  pushVertex(writer, b, colour, glow);
  pushVertex(writer, c, colour, glow);
}

/** Quadrilatère donné dans l'ordre de son périmètre. */
function addQuad(
  writer: GeometryWriter,
  a: Pt3,
  b: Pt3,
  c: Pt3,
  d: Pt3,
  colour: Rgb,
  glow: Rgb,
): void {
  addTriangle(writer, a, c, b, colour, glow);
  addTriangle(writer, a, d, c, colour, glow);
}

function addWall(
  writer: GeometryWriter,
  topA: Pt3,
  topB: Pt3,
  bottomB: Pt3,
  bottomA: Pt3,
  colour: Rgb,
  glow: Rgb,
): void {
  addQuad(writer, topA, topB, bottomB, bottomA, colour, glow);
}

/**
 * Hauteur exacte du maillage de terrain en coordonnées tuiles fractionnaires.
 *
 * `sampleHeightWorld` interpole les quatre coins en bilinéaire, alors que
 * `TerrainLayer` découpe chaque tuile selon la diagonale NW→SE. On reproduit
 * ici ce découpage pour que la voie épouse le sol au millimètre.
 */
export function trackGroundHeight(map: MapSnapshot, x: number, z: number): number {
  const maxX = Math.max(0, map.width - 1);
  const maxZ = Math.max(0, map.height - 1);
  const x0 = Math.max(0, Math.min(maxX, Math.floor(x)));
  const z0 = Math.max(0, Math.min(maxZ, Math.floor(z)));
  const u = Math.max(-0.75, Math.min(1.75, x - x0));
  const v = Math.max(-0.75, Math.min(1.75, z - z0));
  const hA = cornerHeightWorld(map, x0, z0);
  const hB = cornerHeightWorld(map, x0 + 1, z0);
  const hC = cornerHeightWorld(map, x0 + 1, z0 + 1);
  const hD = cornerHeightWorld(map, x0, z0 + 1);
  return v <= u ? hA + (hB - hA) * u + (hC - hB) * v : hA + (hD - hA) * v + (hC - hD) * u;
}

function pointAt(map: MapSnapshot, x: number, z: number, lift: number): Pt3 {
  return { x, y: trackGroundHeight(map, x, z) + lift, z };
}

function tint(hex: number, variation: number, factor = 1): Rgb {
  const rgb = hexToRgb(hex);
  const shade = (0.94 + variation * 0.1) * factor;
  return [rgb.r * shade, rgb.g * shade, rgb.b * shade];
}

function shade(colour: Rgb, factor: number): Rgb {
  return [colour[0] * factor, colour[1] * factor, colour[2] * factor];
}

function normalise(dx: number, dz: number): Pt2 {
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length };
}

/** Normales 2D aux sommets d'une polyligne (pour les rubans). */
function pathNormals(path: readonly Pt2[]): Pt2[] {
  const normals: Pt2[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const previous = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    if (!previous || !next) {
      normals.push({ x: 0, z: 1 });
      continue;
    }
    const tangent = normalise(next.x - previous.x, next.z - previous.z);
    normals.push({ x: -tangent.z, z: tangent.x });
  }
  return normals;
}

interface RibbonOptions {
  /** Décalage latéral du ruban par rapport au chemin. */
  lateral?: number;
  halfWidth: number;
  topLift: number;
  /** Hauteur du bas des joues ; `null` pour ne pas en dessiner. */
  bottomLift?: number | null;
  /** Élargissement du bas (ballast trapézoïdal). */
  bottomExpand?: number;
  walls?: 'both' | 'plus' | 'minus' | 'none';
  topColour: Rgb;
  sideColour?: Rgb;
  topGlow: Rgb;
  sideGlow?: Rgb;
  caps?: boolean;
}

/** Ruban (route, ballast, rail, bordure) qui suit une polyligne et le relief. */
function addRibbon(
  writer: GeometryWriter,
  map: MapSnapshot,
  path: readonly Pt2[],
  options: RibbonOptions,
): void {
  if (path.length < 2) return;
  const normals = pathNormals(path);
  const lateral = options.lateral ?? 0;
  const bottomLift = options.bottomLift ?? null;
  const expand = options.bottomExpand ?? 0;
  const sideColour = options.sideColour ?? shade(options.topColour, 0.86);
  const sideGlow = options.sideGlow ?? options.topGlow;
  const walls = options.walls ?? 'both';

  const topMinus: Pt3[] = [];
  const topPlus: Pt3[] = [];
  const bottomMinus: Pt3[] = [];
  const bottomPlus: Pt3[] = [];

  for (let i = 0; i < path.length; i += 1) {
    const point = path[i];
    const normal = normals[i];
    if (!point || !normal) continue;
    const minusX = point.x + normal.x * (lateral - options.halfWidth);
    const minusZ = point.z + normal.z * (lateral - options.halfWidth);
    const plusX = point.x + normal.x * (lateral + options.halfWidth);
    const plusZ = point.z + normal.z * (lateral + options.halfWidth);
    topMinus.push(pointAt(map, minusX, minusZ, options.topLift));
    topPlus.push(pointAt(map, plusX, plusZ, options.topLift));
    if (bottomLift !== null) {
      bottomMinus.push(
        pointAt(map, minusX - normal.x * expand, minusZ - normal.z * expand, bottomLift),
      );
      bottomPlus.push(
        pointAt(map, plusX + normal.x * expand, plusZ + normal.z * expand, bottomLift),
      );
    }
  }

  for (let i = 0; i + 1 < topMinus.length; i += 1) {
    const a = topMinus[i];
    const b = topPlus[i];
    const c = topPlus[i + 1];
    const d = topMinus[i + 1];
    if (!a || !b || !c || !d) continue;
    addQuad(writer, a, b, c, d, options.topColour, options.topGlow);
  }

  if (bottomLift !== null) {
    for (let i = 0; i + 1 < topMinus.length; i += 1) {
      const minusTopA = topMinus[i];
      const minusTopB = topMinus[i + 1];
      const plusTopA = topPlus[i];
      const plusTopB = topPlus[i + 1];
      const minusBottomA = bottomMinus[i];
      const minusBottomB = bottomMinus[i + 1];
      const plusBottomA = bottomPlus[i];
      const plusBottomB = bottomPlus[i + 1];
      if (walls === 'both' || walls === 'minus') {
        if (minusTopA && minusTopB && minusBottomA && minusBottomB) {
          addWall(writer, minusTopA, minusTopB, minusBottomB, minusBottomA, sideColour, sideGlow);
        }
      }
      if (walls === 'both' || walls === 'plus') {
        if (plusTopA && plusTopB && plusBottomA && plusBottomB) {
          addWall(writer, plusTopA, plusTopB, plusBottomB, plusBottomA, sideColour, sideGlow);
        }
      }
    }
    if (options.caps) {
      const firstMinusTop = topMinus[0];
      const firstPlusTop = topPlus[0];
      const firstMinusBottom = bottomMinus[0];
      const firstPlusBottom = bottomPlus[0];
      if (firstMinusTop && firstPlusTop && firstMinusBottom && firstPlusBottom) {
        addQuad(
          writer,
          firstMinusTop,
          firstPlusTop,
          firstPlusBottom,
          firstMinusBottom,
          sideColour,
          sideGlow,
        );
      }
      const last = topMinus.length - 1;
      const lastMinusTop = topMinus[last];
      const lastPlusTop = topPlus[last];
      const lastMinusBottom = bottomMinus[last];
      const lastPlusBottom = bottomPlus[last];
      if (lastMinusTop && lastPlusTop && lastMinusBottom && lastPlusBottom) {
        addQuad(
          writer,
          lastMinusTop,
          lastPlusTop,
          lastPlusBottom,
          lastMinusBottom,
          sideColour,
          sideGlow,
        );
      }
    }
  }
}

function edgePoint(plan: TrackTilePlan, bit: number): Pt2 {
  const x = plan.x;
  const y = plan.y;
  switch (bit) {
    case TRACK_CONNECT.north:
      return { x: x + 0.5, z: y };
    case TRACK_CONNECT.east:
      return { x: x + 1, z: y + 0.5 };
    case TRACK_CONNECT.south:
      return { x: x + 0.5, z: y + 1 };
    default:
      return { x, z: y + 0.5 };
  }
}

function directionNormal(bit: number): Pt2 {
  switch (bit) {
    case TRACK_CONNECT.north:
      return { x: 0, z: -1 };
    case TRACK_CONNECT.east:
      return { x: 1, z: 0 };
    case TRACK_CONNECT.south:
      return { x: 0, z: 1 };
    default:
      return { x: -1, z: 0 };
  }
}

function connectionBits(connections: number): number[] {
  const bits: number[] = [];
  if (connections & TRACK_CONNECT.north) bits.push(TRACK_CONNECT.north);
  if (connections & TRACK_CONNECT.east) bits.push(TRACK_CONNECT.east);
  if (connections & TRACK_CONNECT.south) bits.push(TRACK_CONNECT.south);
  if (connections & TRACK_CONNECT.west) bits.push(TRACK_CONNECT.west);
  return bits;
}

function cornerPoint(plan: TrackTilePlan, bit: number): Pt2 {
  const x = plan.x;
  const y = plan.y;
  switch (bit) {
    case TRACK_CORNER.ne:
      return { x: x + 1, z: y };
    case TRACK_CORNER.se:
      return { x: x + 1, z: y + 1 };
    case TRACK_CORNER.sw:
      return { x, z: y + 1 };
    default:
      return { x, z: y };
  }
}

function quadraticPath(start: Pt2, control: Pt2, end: Pt2, segments: number): Pt2[] {
  const path: Pt2[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const u = 1 - t;
    path.push({
      x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
      z: u * u * start.z + 2 * u * t * control.z + t * t * end.z,
    });
  }
  return path;
}

function centre(plan: TrackTilePlan): Pt2 {
  return { x: plan.x + 0.5, z: plan.y + 0.5 };
}

function padBoundary(plan: TrackTilePlan, bit: number, half: number): Pt2 {
  const c = centre(plan);
  const normal = directionNormal(bit);
  return { x: c.x + normal.x * half, z: c.z + normal.z * half };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Rect2 {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface RoadSidewalkStrip {
  /** Bord de tuile portant le trottoir. */
  bit: number;
  rect: Rect2;
  /** Joues verticales du trottoir (jusqu'au sol). */
  walls: { north: boolean; east: boolean; south: boolean; west: boolean };
}

export interface RoadTileLayout {
  /** Chaussée pleine tuile, quel que soit le nombre de branches. */
  asphalt: Rect2;
  /** Trottoirs, uniquement sur les bords sans connexion. */
  sidewalks: RoadSidewalkStrip[];
  /** Bords connectés au réseau. */
  arms: number[];
}

/**
 * Découpe d'une tuile route : chaussée pleine tuile + trottoirs sur les seuls
 * bords non connectés.
 *
 * La chaussée couvre exactement `[x, x+1] × [y, y+1]`, comme dans OpenTTD :
 * deux tuiles voisines partagent la même arête, donc aucun trou ni couture aux
 * carrefours en T, aux croisements, aux virages et aux impasses.
 *
 * Les angles sont attribués dans l'ordre nord → est → sud → ouest : deux
 * trottoirs voisins ne se recouvrent jamais, ce qui évite tout z-fighting au
 * milieu d'un virage ou d'un carrefour.
 */
export function roadTileLayout(plan: TrackTilePlan): RoadTileLayout {
  const x0 = plan.x;
  const z0 = plan.y;
  const x1 = x0 + 1;
  const z1 = z0 + 1;
  const w = SIDEWALK_WIDTH;
  const north = (plan.connections & TRACK_CONNECT.north) === 0;
  const east = (plan.connections & TRACK_CONNECT.east) === 0;
  const south = (plan.connections & TRACK_CONNECT.south) === 0;
  const west = (plan.connections & TRACK_CONNECT.west) === 0;
  const sidewalks: RoadSidewalkStrip[] = [];

  if (north) {
    sidewalks.push({
      bit: TRACK_CONNECT.north,
      rect: { x0, z0, x1, z1: z0 + w },
      walls: { north: true, east: true, south: true, west: true },
    });
  }
  if (east) {
    sidewalks.push({
      bit: TRACK_CONNECT.east,
      rect: { x0: x1 - w, z0: z0 + (north ? w : 0), x1, z1 },
      walls: { north: !north, east: true, south: true, west: true },
    });
  }
  if (south) {
    sidewalks.push({
      bit: TRACK_CONNECT.south,
      rect: { x0, z0: z1 - w, x1: east ? x1 - w : x1, z1 },
      walls: { north: true, east: !east, south: true, west: true },
    });
  }
  if (west) {
    sidewalks.push({
      bit: TRACK_CONNECT.west,
      rect: { x0, z0: z0 + (north ? w : 0), x1: x0 + w, z1: z1 - (south ? w : 0) },
      walls: { north: !north, east: true, south: !south, west: true },
    });
  }

  return { asphalt: { x0, z0, x1, z1 }, sidewalks, arms: connectionBits(plan.connections) };
}

/** Joue verticale de la chaussée (version allégée, sans trottoir). */
function addRoadEdgeWall(
  writer: GeometryWriter,
  map: MapSnapshot,
  a: Pt2,
  b: Pt2,
  colour: Rgb,
): void {
  const topA = pointAt(map, a.x, a.z, ROAD_LIFT);
  const topB = pointAt(map, b.x, b.z, ROAD_LIFT);
  const bottomA = pointAt(map, a.x, a.z, 0);
  const bottomB = pointAt(map, b.x, b.z, 0);
  addWall(writer, topA, topB, bottomB, bottomA, colour, ROAD_NIGHT);
}

/** Trottoir surélevé d'un bord non connecté, avec ses joues et ses bouts. */
function emitSidewalk(
  writer: GeometryWriter,
  map: MapSnapshot,
  strip: RoadSidewalkStrip,
  variant: number,
): void {
  const { x0, z0, x1, z1 } = strip.rect;
  const topNw = pointAt(map, x0, z0, SIDEWALK_LIFT);
  const topNe = pointAt(map, x1, z0, SIDEWALK_LIFT);
  const topSe = pointAt(map, x1, z1, SIDEWALK_LIFT);
  const topSw = pointAt(map, x0, z1, SIDEWALK_LIFT);
  addQuad(writer, topNw, topNe, topSe, topSw, tint(CURB_COLOUR, variant), CURB_NIGHT);

  const side = tint(CURB_COLOUR, variant, 0.86);
  const bottomNw = pointAt(map, x0, z0, 0);
  const bottomNe = pointAt(map, x1, z0, 0);
  const bottomSe = pointAt(map, x1, z1, 0);
  const bottomSw = pointAt(map, x0, z1, 0);
  if (strip.walls.north) addWall(writer, topNw, topNe, bottomNe, bottomNw, side, CURB_NIGHT);
  if (strip.walls.east) addWall(writer, topNe, topSe, bottomSe, bottomNe, side, CURB_NIGHT);
  if (strip.walls.south) addWall(writer, topSe, topSw, bottomSw, bottomSe, side, CURB_NIGHT);
  if (strip.walls.west) addWall(writer, topSw, topNw, bottomNw, bottomSw, side, CURB_NIGHT);
}

function emitRoadSurface(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  detail: number,
): void {
  const variant = plan.variation;
  const layout = roadTileLayout(plan);
  const { x0, z0, x1, z1 } = layout.asphalt;
  const a = pointAt(map, x0, z0, ROAD_LIFT);
  const b = pointAt(map, x1, z0, ROAD_LIFT);
  const c = pointAt(map, x1, z1, ROAD_LIFT);
  const d = pointAt(map, x0, z1, ROAD_LIFT);
  addQuad(writer, a, b, c, d, tint(ROAD_COLOUR, variant), ROAD_NIGHT);

  if (detail >= 1) {
    for (const strip of layout.sidewalks) emitSidewalk(writer, map, strip, variant);
    return;
  }

  // LOD éloigné : une simple joue sur chaque bord libre suffit à refermer la
  // dalle. Les trottoirs (3,8 cm) sont invisibles à cette distance.
  const sideColour = tint(ROAD_SIDE_COLOUR, variant);
  if (!(plan.connections & TRACK_CONNECT.north)) {
    addRoadEdgeWall(writer, map, { x: x0, z: z0 }, { x: x1, z: z0 }, sideColour);
  }
  if (!(plan.connections & TRACK_CONNECT.east)) {
    addRoadEdgeWall(writer, map, { x: x1, z: z0 }, { x: x1, z: z1 }, sideColour);
  }
  if (!(plan.connections & TRACK_CONNECT.south)) {
    addRoadEdgeWall(writer, map, { x: x1, z: z1 }, { x: x0, z: z1 }, sideColour);
  }
  if (!(plan.connections & TRACK_CONNECT.west)) {
    addRoadEdgeWall(writer, map, { x: x0, z: z1 }, { x: x0, z: z0 }, sideColour);
  }
}

/** Tirets alignés sur une grille mondiale : continus d'une tuile à l'autre. */
function axisDashPaths(axis: 'x' | 'y', line: number, start: number, end: number): Pt2[][] {
  if (end - start < 0.02) return [];
  const paths: Pt2[][] = [];
  const first = Math.floor(start / MARK_PERIOD);
  const last = Math.ceil(end / MARK_PERIOD);
  for (let k = first; k <= last; k += 1) {
    const dashStart = Math.max(start, k * MARK_PERIOD);
    const dashEnd = Math.min(end, k * MARK_PERIOD + MARK_DASH);
    if (dashEnd - dashStart < 0.02) continue;
    if (axis === 'x') {
      paths.push([
        { x: dashStart, z: line },
        { x: dashEnd, z: line },
      ]);
    } else {
      paths.push([
        { x: line, z: dashStart },
        { x: line, z: dashEnd },
      ]);
    }
  }
  return paths;
}

/**
 * Axes des marquages d'une tuile route (purement descriptif, pour les tests).
 *
 * - droite : tirets alignés sur la grille mondiale, donc continus entre tuiles ;
 * - virage : ligne continue le long de l'arc ;
 * - about, T, croisement et tuile isolée : aucun marquage, la place du
 *   carrefour reste vierge et les tirets des tuiles droites voisines s'arrêtent
 *   naturellement à son arête.
 */
export function roadMarkingPaths(plan: TrackTilePlan): Pt2[][] {
  if (plan.shape === 'curve') {
    const bits = connectionBits(plan.connections);
    const first = bits[0];
    const second = bits[1];
    if (first === undefined || second === undefined) return [];
    return [quadraticPath(edgePoint(plan, first), centre(plan), edgePoint(plan, second), 8)];
  }

  if (plan.shape !== 'straight') return [];

  const axis = plan.axis ?? 'x';
  if (axis === 'x') return axisDashPaths('x', plan.y + 0.5, plan.x, plan.x + 1);
  return axisDashPaths('y', plan.x + 0.5, plan.y, plan.y + 1);
}

/** Marquage continu qui suit une polyligne (axe d'un virage ou tiret). */
function addMarkingRibbon(writer: GeometryWriter, map: MapSnapshot, path: readonly Pt2[]): void {
  if (path.length < 2) return;
  const normals = pathNormals(path);
  const half = MARK_WIDTH / 2;
  const colour = tint(MARK_COLOUR, 0.5, 1.04);
  for (let i = 0; i + 1 < path.length; i += 1) {
    const pointA = path[i];
    const pointB = path[i + 1];
    const normalA = normals[i];
    const normalB = normals[i + 1];
    if (!pointA || !pointB || !normalA || !normalB) continue;
    const minusA = pointAt(
      map,
      pointA.x - normalA.x * half,
      pointA.z - normalA.z * half,
      MARK_LIFT,
    );
    const plusA = pointAt(map, pointA.x + normalA.x * half, pointA.z + normalA.z * half, MARK_LIFT);
    const plusB = pointAt(map, pointB.x + normalB.x * half, pointB.z + normalB.z * half, MARK_LIFT);
    const minusB = pointAt(
      map,
      pointB.x - normalB.x * half,
      pointB.z - normalB.z * half,
      MARK_LIFT,
    );
    addQuad(writer, minusA, plusA, plusB, minusB, colour, MARK_NIGHT);
  }
}

function emitRoadMarkings(writer: GeometryWriter, map: MapSnapshot, plan: TrackTilePlan): void {
  for (const path of roadMarkingPaths(plan)) addMarkingRibbon(writer, map, path);
}

function emitRoadTile(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  detail: number,
): void {
  emitRoadSurface(writer, map, plan, detail);
  if (detail >= 1) emitRoadMarkings(writer, map, plan);
}

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

function emitRailRibbon(
  writer: GeometryWriter,
  map: MapSnapshot,
  path: readonly Pt2[],
  palette: RailPalette,
  variant: number,
  railLift: number,
  ballastLift = BALLAST_LIFT,
): void {
  addRibbon(writer, map, path, {
    halfWidth: BALLAST_HALF,
    topLift: ballastLift,
    bottomLift: 0,
    bottomExpand: BALLAST_BOTTOM_EXPAND,
    topColour: tint(palette.ballast, variant),
    sideColour: tint(palette.ballastSide, variant),
    topGlow: BALLAST_NIGHT,
  });
  const sides = palette.gaugeHalf === 0 ? [0] : [-1, 1];
  for (const side of sides) {
    addRibbon(writer, map, path, {
      lateral: side * palette.gaugeHalf,
      halfWidth: palette.railHalf,
      topLift: railLift,
      bottomLift: RAIL_BOTTOM_LIFT,
      topColour: tint(palette.rail, variant),
      sideColour: tint(palette.railSide, variant),
      topGlow: palette.railNight,
    });
  }
}

function placeSleepers(
  writer: GeometryWriter,
  map: MapSnapshot,
  path: readonly Pt2[],
  palette: RailPalette,
  variant: number,
): void {
  if (!palette.sleepers || path.length < 2) return;
  const lengths: number[] = [0];
  for (let i = 1; i < path.length; i += 1) {
    const previous = path[i - 1];
    const current = path[i];
    if (!previous || !current) continue;
    lengths.push(
      (lengths[lengths.length - 1] ?? 0) +
        Math.hypot(current.x - previous.x, current.z - previous.z),
    );
  }
  const total = lengths[lengths.length - 1] ?? 0;
  if (total < SLEEPER_SPACING * 0.5) return;

  const sleeperColour = tint(palette.sleeper, variant);
  for (let distance = SLEEPER_SPACING * 0.5; distance < total; distance += SLEEPER_SPACING) {
    let segment = 0;
    while (segment + 1 < lengths.length && (lengths[segment + 1] ?? 0) < distance) segment += 1;
    const a = path[segment];
    const b = path[segment + 1];
    const startLength = lengths[segment] ?? 0;
    const endLength = lengths[segment + 1] ?? startLength;
    if (!a || !b) continue;
    const local =
      endLength - startLength > 1e-6 ? (distance - startLength) / (endLength - startLength) : 0;
    const x = a.x + (b.x - a.x) * local;
    const z = a.z + (b.z - a.z) * local;
    const tangent = normalise(b.x - a.x, b.z - a.z);
    const normal = { x: -tangent.z, z: tangent.x };
    addSleeper(writer, map, x, z, normal, tangent, sleeperColour);
  }
}

function addSleeper(
  writer: GeometryWriter,
  map: MapSnapshot,
  x: number,
  z: number,
  normal: Pt2,
  tangent: Pt2,
  colour: Rgb,
): void {
  const halfLength = SLEEPER_LENGTH / 2;
  const halfWidth = SLEEPER_WIDTH / 2;
  const top: Pt2[] = [
    {
      x: x - normal.x * halfLength - tangent.x * halfWidth,
      z: z - normal.z * halfLength - tangent.z * halfWidth,
    },
    {
      x: x + normal.x * halfLength - tangent.x * halfWidth,
      z: z + normal.z * halfLength - tangent.z * halfWidth,
    },
    {
      x: x + normal.x * halfLength + tangent.x * halfWidth,
      z: z + normal.z * halfLength + tangent.z * halfWidth,
    },
    {
      x: x - normal.x * halfLength + tangent.x * halfWidth,
      z: z - normal.z * halfLength + tangent.z * halfWidth,
    },
  ];
  const topPoints = top.map((point) => pointAt(map, point.x, point.z, SLEEPER_TOP_LIFT));
  const bottomPoints = top.map((point) => pointAt(map, point.x, point.z, SLEEPER_BOTTOM_LIFT));
  const [t0, t1, t2, t3] = topPoints;
  const [b0, b1, b2, b3] = bottomPoints;
  if (!t0 || !t1 || !t2 || !t3 || !b0 || !b1 || !b2 || !b3) return;
  addQuad(writer, t0, t1, t2, t3, colour, SLEEPER_NIGHT);
  addWall(writer, t0, t1, b1, b0, shade(colour, 0.82), SLEEPER_NIGHT);
  addWall(writer, t1, t2, b2, b1, shade(colour, 0.82), SLEEPER_NIGHT);
  addWall(writer, t2, t3, b3, b2, shade(colour, 0.82), SLEEPER_NIGHT);
  addWall(writer, t3, t0, b0, b3, shade(colour, 0.82), SLEEPER_NIGHT);
}

function emitRailPath(
  writer: GeometryWriter,
  map: MapSnapshot,
  path: readonly Pt2[],
  plan: TrackTilePlan,
  detail: number,
  railLift: number,
  ballastLift = BALLAST_LIFT,
): void {
  const palette = RAIL_PALETTES[plan.railType];
  emitRailRibbon(writer, map, path, palette, plan.variation, railLift, ballastLift);
  if (detail >= 1) placeSleepers(writer, map, path, palette, plan.variation);
}

function emitRailPad(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  connections: number,
): void {
  const c = centre(plan);
  const h = BALLAST_HALF;
  const nw = { x: c.x - h, z: c.z - h };
  const ne = { x: c.x + h, z: c.z - h };
  const se = { x: c.x + h, z: c.z + h };
  const sw = { x: c.x - h, z: c.z + h };
  const topCorners = [nw, ne, se, sw].map((point) => pointAt(map, point.x, point.z, BALLAST_LIFT));
  const [a, b, cc, d] = topCorners;
  if (!a || !b || !cc || !d) return;
  const palette = RAIL_PALETTES[plan.railType];
  addQuad(writer, a, b, cc, d, tint(palette.ballast, plan.variation), BALLAST_NIGHT);

  const sides: Array<{ bit: number; from: Pt2; to: Pt2; outward: Pt2 }> = [
    { bit: TRACK_CONNECT.north, from: nw, to: ne, outward: { x: 0, z: -1 } },
    { bit: TRACK_CONNECT.east, from: ne, to: se, outward: { x: 1, z: 0 } },
    { bit: TRACK_CONNECT.south, from: se, to: sw, outward: { x: 0, z: 1 } },
    { bit: TRACK_CONNECT.west, from: sw, to: nw, outward: { x: -1, z: 0 } },
  ];
  for (const side of sides) {
    if (connections & side.bit) continue;
    const topA = pointAt(map, side.from.x, side.from.z, BALLAST_LIFT);
    const topB = pointAt(map, side.to.x, side.to.z, BALLAST_LIFT);
    const bottomA = pointAt(
      map,
      side.from.x + side.outward.x * BALLAST_BOTTOM_EXPAND,
      side.from.z + side.outward.z * BALLAST_BOTTOM_EXPAND,
      0,
    );
    const bottomB = pointAt(
      map,
      side.to.x + side.outward.x * BALLAST_BOTTOM_EXPAND,
      side.to.z + side.outward.z * BALLAST_BOTTOM_EXPAND,
      0,
    );
    addWall(
      writer,
      topA,
      topB,
      bottomB,
      bottomA,
      tint(palette.ballastSide, plan.variation),
      BALLAST_NIGHT,
    );
  }
}

function emitRailArm(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  bit: number,
  detail: number,
  railLift: number,
): void {
  const palette = RAIL_PALETTES[plan.railType];
  const path = [padBoundary(plan, bit, BALLAST_HALF), edgePoint(plan, bit)];
  emitRailRibbon(writer, map, path, palette, plan.variation, railLift);
  if (detail >= 1) placeSleepers(writer, map, path, palette, plan.variation);
  // Les rails partent du centre pour traverser la place du carrefour.
  const c = centre(plan);
  const railPath = [c, edgePoint(plan, bit)];
  const sides = palette.gaugeHalf === 0 ? [0] : [-1, 1];
  for (const side of sides) {
    addRibbon(writer, map, railPath, {
      lateral: side * palette.gaugeHalf,
      halfWidth: palette.railHalf,
      topLift: railLift,
      bottomLift: RAIL_BOTTOM_LIFT,
      topColour: tint(palette.rail, plan.variation),
      sideColour: tint(palette.railSide, plan.variation),
      topGlow: palette.railNight,
    });
  }
}

function emitRailDiagonal(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  corner: number,
  detail: number,
  railLift: number,
  ballastLift: number,
): void {
  const c = centre(plan);
  const path = [c, cornerPoint(plan, corner)];
  emitRailPath(writer, map, path, plan, detail, railLift, ballastLift);
}

/**
 * Émet une tuile rail.
 *
 * Les rails diagonaux OpenTTD (bits `TRACK_X`/`TRACK_Y`) ne sont pas exposés
 * par le protocole : on les déduit des voisins de coin. Une tuile sans
 * connexion de bord mais avec des coins devient une diagonale ; une tuile qui
 * mêle bords et coins reçoit une place centrale, ses bras et les diagonales.
 */
function emitRailTile(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  detail: number,
): void {
  const hasCorners = plan.corners !== 0;
  const bitCount = popCount(plan.connections);

  if (bitCount === 0 && hasCorners) {
    const diagonalLift = RAIL_TOP_LIFT;
    if (plan.corners & TRACK_CORNER.ne && plan.corners & TRACK_CORNER.sw) {
      emitRailPath(
        writer,
        map,
        [cornerPoint(plan, TRACK_CORNER.ne), centre(plan), cornerPoint(plan, TRACK_CORNER.sw)],
        plan,
        detail,
        diagonalLift,
      );
    } else {
      if (plan.corners & TRACK_CORNER.ne) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.ne, detail, diagonalLift, BALLAST_LIFT);
      }
      if (plan.corners & TRACK_CORNER.sw) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.sw, detail, diagonalLift, BALLAST_LIFT);
      }
    }
    if (plan.corners & TRACK_CORNER.nw && plan.corners & TRACK_CORNER.se) {
      emitRailPath(
        writer,
        map,
        [cornerPoint(plan, TRACK_CORNER.nw), centre(plan), cornerPoint(plan, TRACK_CORNER.se)],
        plan,
        detail,
        diagonalLift + RAIL_CROSS_LIFT,
        BALLAST_LIFT + RAIL_CROSS_LIFT,
      );
    } else {
      if (plan.corners & TRACK_CORNER.nw) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.nw, detail, diagonalLift, BALLAST_LIFT);
      }
      if (plan.corners & TRACK_CORNER.se) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.se, detail, diagonalLift, BALLAST_LIFT);
      }
    }
    return;
  }

  if ((plan.shape === 'straight' || plan.shape === 'isolated') && !hasCorners) {
    const axis = plan.axis ?? 'x';
    const start = edgePoint(plan, axis === 'x' ? TRACK_CONNECT.west : TRACK_CONNECT.north);
    const end = edgePoint(plan, axis === 'x' ? TRACK_CONNECT.east : TRACK_CONNECT.south);
    emitRailPath(writer, map, [start, centre(plan), end], plan, detail, RAIL_TOP_LIFT);
    return;
  }

  if (plan.shape === 'curve' && !hasCorners) {
    const bits = connectionBits(plan.connections);
    const first = bits[0];
    const second = bits[1];
    if (first === undefined || second === undefined) return;
    const path = quadraticPath(
      edgePoint(plan, first),
      centre(plan),
      edgePoint(plan, second),
      detail >= 1 ? 9 : 4,
    );
    emitRailPath(writer, map, path, plan, detail, RAIL_TOP_LIFT);
    return;
  }

  // About, T, croisement, ou mélange bord + diagonale : place + bras.
  const connections = plan.connections;
  const count = popCount(connections);
  if (count > 0) {
    emitRailPad(writer, map, plan, connections);
    for (const bit of connectionBits(connections)) {
      const crossing =
        bit === TRACK_CONNECT.east || bit === TRACK_CONNECT.west
          ? RAIL_TOP_LIFT + RAIL_CROSS_LIFT
          : RAIL_TOP_LIFT;
      emitRailArm(writer, map, plan, bit, detail, count > 2 ? crossing : RAIL_TOP_LIFT);
    }
  }

  if (hasCorners) {
    // Le ballast diagonal est très légèrement surélevé quand une place existe
    // déjà : les deux surfaces ne sont jamais coplanaires.
    const ballastLift = count > 0 ? BALLAST_LIFT + RAIL_CROSS_LIFT : BALLAST_LIFT;
    const diagonalLift = count > 0 ? RAIL_TOP_LIFT + RAIL_CROSS_LIFT * 2 : RAIL_TOP_LIFT;
    if (plan.corners & TRACK_CORNER.ne && plan.corners & TRACK_CORNER.sw) {
      emitRailPath(
        writer,
        map,
        [cornerPoint(plan, TRACK_CORNER.ne), centre(plan), cornerPoint(plan, TRACK_CORNER.sw)],
        plan,
        detail,
        diagonalLift,
        ballastLift,
      );
    } else {
      if (plan.corners & TRACK_CORNER.ne) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.ne, detail, diagonalLift, ballastLift);
      }
      if (plan.corners & TRACK_CORNER.sw) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.sw, detail, diagonalLift, ballastLift);
      }
    }
    if (plan.corners & TRACK_CORNER.nw && plan.corners & TRACK_CORNER.se) {
      emitRailPath(
        writer,
        map,
        [cornerPoint(plan, TRACK_CORNER.nw), centre(plan), cornerPoint(plan, TRACK_CORNER.se)],
        plan,
        detail,
        diagonalLift + RAIL_CROSS_LIFT,
        ballastLift + RAIL_CROSS_LIFT,
      );
    } else {
      if (plan.corners & TRACK_CORNER.nw) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.nw, detail, diagonalLift, ballastLift);
      }
      if (plan.corners & TRACK_CORNER.se) {
        emitRailDiagonal(writer, map, plan, TRACK_CORNER.se, detail, diagonalLift, ballastLift);
      }
    }
  }
}

function emitTile(
  writer: GeometryWriter,
  map: MapSnapshot,
  plan: TrackTilePlan,
  detail: number,
): void {
  if (plan.network === 'road') emitRoadTile(writer, map, plan, detail);
  else emitRailTile(writer, map, plan, detail);
}

// ---------------------------------------------------------------------------
// Couche de rendu
// ---------------------------------------------------------------------------

const NO_DETAIL_RANGE = 0;
const DETAIL_RANGE_MEDIUM = 64;
const DETAIL_RANGE_HIGH = 96;

export class TrackLayer {
  readonly group = new THREE.Group();
  readonly chunkSize = TRACK_CHUNK_SIZE;

  private chunks = new Map<number, TrackChunk>();
  private map: MapSnapshot | null = null;
  private masks: TrackMasks | null = null;
  private stations: readonly StationSnapshot[] = [];
  private stationSignature = '';
  private previous: MapArrays | null = null;
  private chunksX = 0;
  private chunksY = 0;
  private material: THREE.MeshLambertMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private quality: QualityLevel = 'medium';
  private detailLevel = 1;
  private detailRange = DETAIL_RANGE_MEDIUM;
  private cameraX = 0;
  private cameraZ = 0;
  private cameraKnown = false;

  /** Compteur de chunks reconstruits (diagnostic et tests). */
  chunksBuilt = 0;

  constructor() {
    this.group.name = 'tracks';
    this.group.visible = true;
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.nightUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec3 aNightGlow;\nvarying vec3 vNightGlow;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vNightGlow = aNightGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uNight;\nvarying vec3 vNightGlow;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vNightGlow * uNight;',
        );
    };
    this.material.customProgramCacheKey = () => 'opentt3d-tracks-night-v1';
  }

  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get triangleCount(): number {
    let total = 0;
    for (const chunk of this.chunks.values()) {
      total += chunk.showingDetail ? chunk.detailTriangles : chunk.baseTriangles;
    }
    return total;
  }

  get drawCallCount(): number {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.showingDetail) {
        if (chunk.detail) count += 1;
      } else count += 1;
    }
    return count;
  }

  /** Chunks dont la version détaillée est affichée (diagnostic). */
  get detailChunkCount(): number {
    let count = 0;
    for (const chunk of this.chunks.values()) if (chunk.showingDetail) count += 1;
    return count;
  }

  get night(): number {
    return this.nightAmount;
  }

  get trackTileCount(): number {
    if (!this.masks) return 0;
    let count = 0;
    for (let i = 0; i < this.masks.road.length; i += 1) {
      if ((this.masks.road[i] ?? 0) !== 0 || (this.masks.rail[i] ?? 0) !== 0) count += 1;
    }
    return count;
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.detailLevel = level === 'low' ? 0 : level === 'high' ? 2 : 1;
    this.detailRange =
      level === 'low'
        ? NO_DETAIL_RANGE
        : level === 'high'
          ? DETAIL_RANGE_HIGH
          : DETAIL_RANGE_MEDIUM;
    this.material.dithering = qualitySettings(level).level !== 'low';
    if (this.map) this.rebuildAll();
  }

  /** 0 = jour, 1 = nuit : émission des marquages, bordures et rails. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightAmount;
  }

  /** Nouvelle carte (ou carte de taille différente) : reconstruction complète. */
  setMap(map: MapSnapshot, stations: readonly StationSnapshot[] = []): void {
    const sizeChanged = !this.map || this.map.width !== map.width || this.map.height !== map.height;
    this.map = map;
    this.stations = stations;
    this.stationSignature = stationSignature(stations);
    this.masks = buildTrackMasks(map, stations);
    if (sizeChanged) {
      this.disposeChunks();
      this.chunksX = Math.ceil(map.width / TRACK_CHUNK_SIZE);
      this.chunksY = Math.ceil(map.height / TRACK_CHUNK_SIZE);
    }
    this.rebuildAll();
    this.previous = copyArrays(map);
  }

  /** Reconstruction incrémentale : seuls les chunks modifiés sont refaits. */
  applyDelta(map: MapSnapshot, stations: readonly StationSnapshot[] = []): void {
    if (!this.map || this.map.width !== map.width || this.map.height !== map.height) {
      this.setMap(map, stations);
      return;
    }
    this.map = map;
    const previous = this.previous;
    const nextSignature = stationSignature(stations);
    const stationsChanged = nextSignature !== this.stationSignature;
    const dirty = new Set<number>();
    if (stationsChanged) {
      this.markStationChunks(this.stations, dirty);
      this.markStationChunks(stations, dirty);
    }
    this.stations = stations;
    this.stationSignature = nextSignature;
    this.masks = buildTrackMasks(map, stations);

    for (let cy = 0; cy < this.chunksY; cy += 1) {
      for (let cx = 0; cx < this.chunksX; cx += 1) {
        const key = cy * this.chunksX + cx;
        if (dirty.has(key) || !previous || this.chunkDiffers(map, previous, cx, cy)) {
          this.buildChunk(cx, cy);
        }
      }
    }
    this.previous = copyArrays(map);
  }

  private markStationChunks(stations: readonly StationSnapshot[], dirty: Set<number>): void {
    if (!this.map) return;
    for (const station of stations) {
      if (station.kind !== 'train' && station.kind !== 'road') continue;
      const left = Math.round(station.x - station.width / 2) - 1;
      const top = Math.round(station.y - station.height / 2) - 1;
      const right = left + station.width + 1;
      const bottom = top + station.height + 1;
      const cx0 = Math.max(0, Math.floor(left / TRACK_CHUNK_SIZE));
      const cy0 = Math.max(0, Math.floor(top / TRACK_CHUNK_SIZE));
      const cx1 = Math.min(this.chunksX - 1, Math.floor(right / TRACK_CHUNK_SIZE));
      const cy1 = Math.min(this.chunksY - 1, Math.floor(bottom / TRACK_CHUNK_SIZE));
      for (let cy = cy0; cy <= cy1; cy += 1) {
        for (let cx = cx0; cx <= cx1; cx += 1) dirty.add(cy * this.chunksX + cx);
      }
    }
  }

  private chunkDiffers(map: MapSnapshot, previous: MapArrays, cx: number, cy: number): boolean {
    const x0 = cx * TRACK_CHUNK_SIZE;
    const y0 = cy * TRACK_CHUNK_SIZE;
    const x1 = Math.min(map.width, x0 + TRACK_CHUNK_SIZE);
    const y1 = Math.min(map.height, y0 + TRACK_CHUNK_SIZE);
    for (let y = y0; y < y1; y += 1) {
      const row = y * map.width;
      for (let x = x0; x < x1; x += 1) {
        const index = row + x;
        if (map.kind[index] !== previous.kind[index]) return true;
        if (map.heightMap[index] !== previous.heightMap[index]) return true;
        if (map.flags[index] !== previous.flags[index]) return true;
      }
    }
    return false;
  }

  rebuildAll(): void {
    if (!this.map) return;
    for (let cy = 0; cy < this.chunksY; cy += 1) {
      for (let cx = 0; cx < this.chunksX; cx += 1) this.buildChunk(cx, cy);
    }
  }

  private buildChunk(cx: number, cy: number): void {
    const map = this.map;
    const masks = this.masks;
    if (!map || !masks) return;
    const key = cy * this.chunksX + cx;
    const existing = this.chunks.get(key);
    if (existing) {
      this.removeChunk(key, existing);
    }
    this.chunksBuilt += 1;

    const x0 = cx * TRACK_CHUNK_SIZE;
    const y0 = cy * TRACK_CHUNK_SIZE;
    const width = Math.min(TRACK_CHUNK_SIZE, map.width - x0);
    const height = Math.min(TRACK_CHUNK_SIZE, map.height - y0);
    if (width <= 0 || height <= 0) return;

    const plans: TrackTilePlan[] = [];
    for (let ty = 0; ty < height; ty += 1) {
      for (let tx = 0; tx < width; tx += 1) {
        const wx = x0 + tx;
        const wy = y0 + ty;
        const index = wy * map.width + wx;
        const kind = map.kind[index] ?? 0;
        // Ponts et tunnels sont dessinés par `StructureLayer` : la voie de
        // surface s'arrête aux culées et aux portails.
        if (kind === TILE_KIND_INDEX.tunnel || kind === TILE_KIND_INDEX.bridge) continue;
        if (masks.rail[index]) plans.push(inferTilePlan(map, masks, wx, wy, 'rail'));
        else if (masks.road[index]) plans.push(inferTilePlan(map, masks, wx, wy, 'road'));
      }
    }
    if (plans.length === 0) return;

    const baseWriter = createWriter();
    const detailWriter = this.detailLevel > 0 ? createWriter() : null;
    for (const plan of plans) {
      emitTile(baseWriter, map, plan, 0);
      if (detailWriter) emitTile(detailWriter, map, plan, this.detailLevel);
    }

    const baseTriangles = writerTriangles(baseWriter);
    if (baseTriangles === 0) return;
    const base = this.createMesh(baseWriter, `track-base-${cx}-${cy}`);
    if (!base) return;
    const detail = this.createMesh(detailWriter, `track-detail-${cx}-${cy}`);
    const detailTriangles = detailWriter ? writerTriangles(detailWriter) : 0;

    const centreX = x0 + width / 2;
    const centreZ = y0 + height / 2;
    const showingDetail = this.shouldShowDetail(centreX, centreZ) && detail !== null;
    base.visible = !showingDetail;
    if (detail) detail.visible = showingDetail;
    this.group.add(base);
    if (detail) this.group.add(detail);

    this.chunks.set(key, {
      cx,
      cy,
      key,
      base,
      detail,
      baseTriangles,
      detailTriangles,
      centreX,
      centreZ,
      showingDetail,
    });
  }

  private createMesh(writer: GeometryWriter | null, name: string): THREE.Mesh | null {
    if (!writer || writer.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(writer.positions), 3),
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(writer.colours), 3));
    geometry.setAttribute(
      'aNightGlow',
      new THREE.BufferAttribute(new Float32Array(writer.night), 3),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = name;
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  private shouldShowDetail(x: number, z: number): boolean {
    if (this.detailLevel === 0 || this.detailRange <= 0) return false;
    if (!this.cameraKnown) return true;
    const dx = x - this.cameraX;
    const dz = z - this.cameraZ;
    return dx * dx + dz * dz <= this.detailRange * this.detailRange;
  }

  /** Bascule le LOD proche/loin selon la distance caméra (appelé par frame). */
  update(camera: THREE.Vector3 | { x: number; z: number }): void {
    this.cameraX = camera.x;
    this.cameraZ = camera.z;
    this.cameraKnown = true;
    const range = this.detailRange;
    const rangeSquared = range * range;
    for (const chunk of this.chunks.values()) {
      if (!chunk.detail) {
        if (chunk.showingDetail) chunk.showingDetail = false;
        if (!chunk.base.visible) chunk.base.visible = true;
        continue;
      }
      const dx = chunk.centreX - this.cameraX;
      const dz = chunk.centreZ - this.cameraZ;
      const show = range > 0 && dx * dx + dz * dz <= rangeSquared;
      if (show === chunk.showingDetail) continue;
      chunk.showingDetail = show;
      chunk.base.visible = !show;
      chunk.detail.visible = show;
    }
  }

  /** Triangles d'un chunk (version de base ou détaillée, pour les tests). */
  chunkTriangles(cx: number, cy: number, detail = false): number {
    const chunk = this.chunks.get(cy * this.chunksX + cx);
    if (!chunk) return 0;
    return detail ? chunk.detailTriangles : chunk.baseTriangles;
  }

  /** Vrai si la version détaillée du chunk est visible. */
  detailVisible(cx: number, cy: number): boolean {
    return this.chunks.get(cy * this.chunksX + cx)?.showingDetail ?? false;
  }

  private removeChunk(key: number, chunk: TrackChunk): void {
    this.group.remove(chunk.base);
    chunk.base.geometry.dispose();
    if (chunk.detail) {
      this.group.remove(chunk.detail);
      chunk.detail.geometry.dispose();
    }
    this.chunks.delete(key);
  }

  private disposeChunks(): void {
    for (const [key, chunk] of [...this.chunks]) this.removeChunk(key, chunk);
    this.chunks.clear();
  }

  dispose(): void {
    this.disposeChunks();
    this.group.clear();
    this.material.dispose();
    this.map = null;
    this.masks = null;
    this.stations = [];
    this.previous = null;
    this.chunksX = 0;
    this.chunksY = 0;
    this.stationSignature = '';
  }
}

function copyArrays(map: MapSnapshot): MapArrays {
  return {
    width: map.width,
    height: map.height,
    kind: map.kind.slice(),
    heightMap: map.heightMap.slice(),
    flags: map.flags.slice(),
  };
}

function stationSignature(stations: readonly StationSnapshot[]): string {
  const parts: string[] = [];
  for (const station of stations) {
    parts.push(
      `${station.id}:${station.kind}:${station.x}:${station.y}:${station.width}:${station.height}`,
    );
  }
  return parts.join('|');
}
