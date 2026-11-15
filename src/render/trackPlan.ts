/**
 * Planification des voies (routes et rails) à partir de la carte.
 *
 * Le protocole expose `kind` et `trackBits`, mais `trackBits` contient le
 * `m8` brut d'OpenTTD : pour une tuile rail, `m8` porte le type de rail et non
 * les bits de voie (qui vivent dans `m5`) ; pour une route, il porte le type de
 * route. Le mock y stocke ses propres bits `CONNECT_*`. Cette couche ne peut
 * donc pas s'appuyer dessus de façon portable.
 *
 * L'orientation est donc **inférée par voisinage** :
 * - une tuile route/rail se connecte à ses voisines orthogonales du même
 *   réseau ;
 * - les rails gèrent en plus les diagonales (voisins aux quatre coins) ;
 * - les gares et les ponts sont classés route/rail grâce aux snapshots ;
 * - les tuiles isolées retombent sur une voie droite est-ouest, convention
 *   d'OpenTTD pour un tronçon d'une tuile.
 *
 * Le résultat est purement déterministe : mêmes tableaux → mêmes plans.
 */

import {
  TILE_KIND_INDEX,
  type MapSnapshot,
  type RailType,
  type StationSnapshot,
} from '../engine/protocol';
import { hashUnit2d } from '../game/prng';
import { railTypeFromIndex } from '../game/railRules';

/** Bits de connexion par les bords de la tuile. */
export const TRACK_CONNECT = {
  north: 1,
  east: 2,
  south: 4,
  west: 8,
} as const;

/** Bits de connexion par les coins de la tuile (rails diagonaux). */
export const TRACK_CORNER = {
  ne: 1,
  se: 2,
  sw: 4,
  nw: 8,
} as const;

export type TrackNetwork = 'road' | 'rail';

export type TrackShape =
  'isolated' | 'dead-end' | 'straight' | 'curve' | 'tee' | 'cross' | 'diagonal' | 'diagonal-cross';

export interface TrackTilePlan {
  x: number;
  y: number;
  network: TrackNetwork;
  /** Connexions par les quatre bords. */
  connections: number;
  /** Connexions diagonales (rails uniquement). */
  corners: number;
  shape: TrackShape;
  /** Axe d'une voie droite ou d'un about. */
  axis: 'x' | 'y' | null;
  station: boolean;
  bridge: boolean;
  /** Variation déterministe 0..1 pour teinter la géométrie. */
  variation: number;
  /** Type de rail de la tuile (#157), `rail` pour les routes. */
  railType: RailType;
}

export interface TrackMasks {
  road: Uint8Array;
  rail: Uint8Array;
  /** Axe imposé par une gare : 1 = X, 2 = Y, 0 = aucun. */
  stationAxis: Uint8Array;
}

const NORTH = TRACK_CONNECT.north;
const EAST = TRACK_CONNECT.east;
const SOUTH = TRACK_CONNECT.south;
const WEST = TRACK_CONNECT.west;

const ROAD_INDEX = TILE_KIND_INDEX.road;
const RAIL_INDEX = TILE_KIND_INDEX.rail;
const STATION_INDEX = TILE_KIND_INDEX.station;
const BRIDGE_INDEX = TILE_KIND_INDEX.bridge;

export function oppositeConnections(bits: number): number {
  let result = 0;
  if (bits & NORTH) result |= SOUTH;
  if (bits & SOUTH) result |= NORTH;
  if (bits & EAST) result |= WEST;
  if (bits & WEST) result |= EAST;
  return result;
}

export function popCount(value: number): number {
  let count = 0;
  let bits = value & 0xff;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

/** Classe une combinaison de connexions de bord. */
export function classifyConnections(connections: number): TrackShape {
  const count = popCount(connections);
  if (count === 0) return 'isolated';
  if (count === 1) return 'dead-end';
  if (count === 2) {
    return (connections & (NORTH | SOUTH)) === (NORTH | SOUTH) ||
      (connections & (EAST | WEST)) === (EAST | WEST)
      ? 'straight'
      : 'curve';
  }
  if (count === 3) return 'tee';
  return 'cross';
}

/** Axe d'une tuile dont les connexions sont connues. */
export function axisFor(connections: number): 'x' | 'y' | null {
  if (connections & (EAST | WEST)) return 'x';
  if (connections & (NORTH | SOUTH)) return 'y';
  return null;
}

function networkAt(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return (mask[y * width + x] ?? 0) !== 0;
}

/** Connexions orthogonales d'une tuile avec les tuiles du même réseau. */
export function connectionsAt(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let bits = 0;
  if (networkAt(mask, width, height, x, y - 1)) bits |= NORTH;
  if (networkAt(mask, width, height, x + 1, y)) bits |= EAST;
  if (networkAt(mask, width, height, x, y + 1)) bits |= SOUTH;
  if (networkAt(mask, width, height, x - 1, y)) bits |= WEST;
  return bits;
}

/** Connexions diagonales d'une tuile rail avec ses voisines de coin. */
export function cornersAt(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let bits = 0;
  if (networkAt(mask, width, height, x + 1, y - 1)) bits |= TRACK_CORNER.ne;
  if (networkAt(mask, width, height, x + 1, y + 1)) bits |= TRACK_CORNER.se;
  if (networkAt(mask, width, height, x - 1, y + 1)) bits |= TRACK_CORNER.sw;
  if (networkAt(mask, width, height, x - 1, y - 1)) bits |= TRACK_CORNER.nw;
  return bits;
}

/**
 * Construit les masques route/rail de toute la carte.
 *
 * Les ponts sont classés par proximité (route ou rail) car leur type de
 * transport n'est pas exposé. Les tunnels sont volontairement ignorés : la
 * géométrie de surface s'arrêterait à la bouche sans traverser le relief.
 */
export function buildTrackMasks(
  map: MapSnapshot,
  stations: readonly StationSnapshot[] = [],
): TrackMasks {
  const size = map.width * map.height;
  const road = new Uint8Array(size);
  const rail = new Uint8Array(size);
  const stationAxis = new Uint8Array(size);
  const bridges: number[] = [];

  for (let index = 0; index < size; index += 1) {
    const kind = map.kind[index] ?? 0;
    if (kind === ROAD_INDEX) road[index] = 1;
    else if (kind === RAIL_INDEX) rail[index] = 1;
    else if (kind === BRIDGE_INDEX) bridges.push(index);
    else if (kind === STATION_INDEX) {
      // Rempli par le snapshot des gares ci-dessous.
    }
  }

  for (const station of stations) {
    if (station.kind !== 'train' && station.kind !== 'road') continue;
    const axis = station.width >= station.height ? 1 : 2;
    const left = Math.round(station.x - station.width / 2);
    const top = Math.round(station.y - station.height / 2);
    for (let dy = 0; dy < station.height; dy += 1) {
      for (let dx = 0; dx < station.width; dx += 1) {
        const x = left + dx;
        const y = top + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const index = y * map.width + x;
        if (map.kind[index] !== STATION_INDEX) continue;
        if (station.kind === 'train') rail[index] = 1;
        else road[index] = 1;
        stationAxis[index] = axis;
      }
    }
  }

  // Classification des ponts : les tuiles d'un même tablier forment une
  // composante connexe. On compte les routes/rails rencontrés sur son
  // pourtour (et non seulement autour de chaque tuile) pour classer les ponts
  // longs dont le milieu n'a aucun voisin routier immédiat.
  const visited = new Uint8Array(size);
  for (const start of bridges) {
    if (visited[start]) continue;
    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    let roadHits = 0;
    let railHits = 0;
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) continue;
      component.push(index);
      const x = index % map.width;
      const y = Math.floor(index / map.width);
      const neighbours = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const;
      for (const [nx, ny] of neighbours) {
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const neighbour = ny * map.width + nx;
        if (road[neighbour]) roadHits += 1;
        if (rail[neighbour]) railHits += 1;
        if ((map.kind[neighbour] ?? 0) === BRIDGE_INDEX && !visited[neighbour]) {
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    const isRail = railHits > roadHits;
    for (const index of component) {
      if (isRail) rail[index] = 1;
      else road[index] = 1;
    }
  }

  return { road, rail, stationAxis };
}

/**
 * Infère le plan d'une tuile. `masks` doit couvrir la carte entière.
 */
export function inferTilePlan(
  map: MapSnapshot,
  masks: TrackMasks,
  x: number,
  y: number,
  network: TrackNetwork,
): TrackTilePlan {
  const index = y * map.width + x;
  const mask = network === 'road' ? masks.road : masks.rail;
  let connections = connectionsAt(mask, map.width, map.height, x, y);

  const station = (masks.stationAxis[index] ?? 0) !== 0;
  if (station) {
    const axis = masks.stationAxis[index] === 1 ? 'x' : 'y';
    if (popCount(connections) === 0) {
      connections = axis === 'x' ? EAST | WEST : NORTH | SOUTH;
    }
  }

  let corners = 0;
  if (network === 'rail') {
    const diagonal = cornersAt(mask, map.width, map.height, x, y);
    const ne = (diagonal & TRACK_CORNER.ne) !== 0;
    const se = (diagonal & TRACK_CORNER.se) !== 0;
    const sw = (diagonal & TRACK_CORNER.sw) !== 0;
    const nw = (diagonal & TRACK_CORNER.nw) !== 0;
    if (ne && sw) corners |= TRACK_CORNER.ne | TRACK_CORNER.sw;
    if (nw && se) corners |= TRACK_CORNER.nw | TRACK_CORNER.se;
    // Un rail diagonal qui se raccorde à une voie droite n'a qu'un voisin de
    // coin : on garde ce demi-raccord quand la tuile n'est pas déjà un
    // carrefour (évite les éperons parasites entre deux voies parallèles).
    if (popCount(connections) <= 1) {
      if (ne && !(corners & TRACK_CORNER.sw)) corners |= TRACK_CORNER.ne;
      if (se && !(corners & TRACK_CORNER.nw)) corners |= TRACK_CORNER.se;
      if (sw && !(corners & TRACK_CORNER.ne)) corners |= TRACK_CORNER.sw;
      if (nw && !(corners & TRACK_CORNER.se)) corners |= TRACK_CORNER.nw;
    }
  }

  let shape = classifyConnections(connections);
  if (shape === 'isolated' && corners !== 0) {
    const pairs =
      (corners & (TRACK_CORNER.ne | TRACK_CORNER.sw)) !== 0 &&
      (corners & (TRACK_CORNER.nw | TRACK_CORNER.se)) !== 0;
    shape = pairs ? 'diagonal-cross' : 'diagonal';
  }

  const axis =
    shape === 'straight' || shape === 'dead-end' || shape === 'isolated'
      ? (axisFor(connections) ?? 'x')
      : null;

  return {
    x,
    y,
    network,
    connections,
    corners,
    shape,
    axis,
    station,
    bridge: (map.kind[index] ?? 0) === BRIDGE_INDEX,
    variation: hashUnit2d(map.width, x, y),
    railType: network === 'rail' ? railTypeFromIndex(map.railTypes?.[index] ?? 0) : 'rail',
  };
}

/** Plan de toutes les tuiles d'une carte (tests et diagnostics). */
export function buildTrackPlans(
  map: MapSnapshot,
  stations: readonly StationSnapshot[] = [],
): TrackTilePlan[] {
  const masks = buildTrackMasks(map, stations);
  const plans: TrackTilePlan[] = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const index = y * map.width + x;
      if (masks.rail[index]) plans.push(inferTilePlan(map, masks, x, y, 'rail'));
      else if (masks.road[index]) plans.push(inferTilePlan(map, masks, x, y, 'road'));
    }
  }
  return plans;
}
