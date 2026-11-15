/**
 * Règles de signalisation avancée (#156), partagées par l'interface, le mock
 * et le pont C++.
 *
 * Encodage d'un octet de `MapSnapshot.signalData` :
 *
 * | Bits | Sens |
 * |---|---|
 * | 0..2 | type : 0 aucun, 1 bloc, 2 path/PBS, 3 entrée, 4 sortie, 5 combiné |
 * | 3 | 1 = bidirectionnel, 0 = sens unique |
 * | 4..5 | état : 0 vert, 1 rouge, 2 jaune |
 * | 6 | 1 = signal mécanique (sémaphore) |
 * | 7 | réservé |
 *
 * Le pont OpenTTD ne connaît que rouge et vert ; le jaune reste disponible
 * pour l'aperçu et les tests de réservation.
 */

import { TILE_KIND_INDEX, type MapSnapshot, type SignalAspect } from '../engine/protocol';
import type { SignalDirection, SignalKind, SignalSnapshot } from '../engine/protocol';

export type { SignalAspect, SignalDirection, SignalKind, SignalSnapshot };

export const SIGNAL_KINDS: readonly SignalKind[] = ['block', 'path', 'entry', 'exit', 'combo'];

export const SIGNAL_KIND_INDEX: Record<SignalKind, number> = {
  block: 1,
  path: 2,
  entry: 3,
  exit: 4,
  combo: 5,
};

export const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  block: 'Bloc',
  path: 'Path (PBS)',
  entry: 'Entrée',
  exit: 'Sortie',
  combo: 'Combiné',
};

export const SIGNAL_KIND_DESCRIPTIONS: Record<SignalKind, string> = {
  block: 'Un seul train par canton.',
  path: 'Réservation de chemin, plusieurs trains peuvent suivre.',
  entry: 'Entrée de block-sections : ouvre la section si une sortie est libre.',
  exit: 'Sortie de block-sections : autorise les entrées en amont.',
  combo: 'Entrée et sortie combinées.',
};

/** Coût de pose par type (le rail classique reste à 320 £). */
export const SIGNAL_KIND_COST: Record<SignalKind, number> = {
  block: 320,
  path: 460,
  entry: 380,
  exit: 380,
  combo: 420,
};

/** Coût de conversion lorsqu'un signal existe déjà sur la tuile. */
export const SIGNAL_CONVERT_COST = 120;

/** Coût de retrait d'un signal (démolition dédiée, la voie reste en place). */
export const SIGNAL_REMOVE_COST = 40;

export const ASPECT_INDEX: Record<SignalAspect, number> = {
  green: 0,
  red: 1,
  yellow: 2,
};

export function signalKindFromIndex(index: number): SignalKind | null {
  if (!Number.isFinite(index)) return null;
  const normalized = Math.round(index);
  for (const kind of SIGNAL_KINDS) {
    if (SIGNAL_KIND_INDEX[kind] === normalized) return kind;
  }
  return null;
}

export function signalAspectFromIndex(index: number): SignalAspect {
  if (index === ASPECT_INDEX.red) return 'red';
  if (index === ASPECT_INDEX.yellow) return 'yellow';
  return 'green';
}

export function parseSignalKind(value: unknown): SignalKind | null {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'block':
    case 'bloc':
      return 'block';
    case 'path':
    case 'pbs':
    case 'chemin':
      return 'path';
    case 'entry':
    case 'entree':
    case 'entrée':
      return 'entry';
    case 'exit':
    case 'sortie':
      return 'exit';
    case 'combo':
    case 'combine':
    case 'combiné':
      return 'combo';
    default:
      return null;
  }
}

export function parseSignalDirection(value: unknown): SignalDirection | null {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'one-way':
    case 'oneway':
    case 'single':
    case 'sens-unique':
    case 'unique':
      return 'one-way';
    case 'both':
    case 'two-way':
    case 'twoway':
    case 'bidirectional':
    case 'bidirectionnel':
      return 'both';
    default:
      return null;
  }
}

export function nextSignalKind(kind: SignalKind): SignalKind {
  const index = SIGNAL_KINDS.indexOf(kind);
  return SIGNAL_KINDS[(index + 1) % SIGNAL_KINDS.length] ?? 'block';
}

export function nextSignalDirection(direction: SignalDirection): SignalDirection {
  return direction === 'one-way' ? 'both' : 'one-way';
}

export interface SignalBits {
  kind: SignalKind;
  direction: SignalDirection;
  aspect: SignalAspect;
  semaphore: boolean;
}

/** Encode un signal dans l'octet de `signalData`. */
export function encodeSignalBits(signal: SignalBits): number {
  const kind = SIGNAL_KIND_INDEX[signal.kind] & 0x7;
  const direction = signal.direction === 'both' ? 1 << 3 : 0;
  const aspect = (ASPECT_INDEX[signal.aspect] & 0x3) << 4;
  const semaphore = signal.semaphore ? 1 << 6 : 0;
  return kind | direction | aspect | semaphore;
}

/** Décode un octet de `signalData` ; `null` quand aucun signal n'est posé. */
export function decodeSignalBits(value: number): SignalBits | null {
  const kind = signalKindFromIndex(value & 0x7);
  if (!kind) return null;
  return {
    kind,
    direction: (value & (1 << 3)) !== 0 ? 'both' : 'one-way',
    aspect: signalAspectFromIndex((value >> 4) & 0x3),
    semaphore: (value & (1 << 6)) !== 0,
  };
}

/** Remplace l'état d'un octet de signal sans toucher au type ni au sens. */
export function withSignalAspect(value: number, aspect: SignalAspect): number {
  return (value & ~(0x3 << 4)) | ((ASPECT_INDEX[aspect] & 0x3) << 4);
}

/** Signaux d'une carte, dans l'ordre déterministe des tuiles. */
export function signalsFromMap(map: MapSnapshot | null | undefined): SignalSnapshot[] {
  if (!map?.signalData) return [];
  const signals: SignalSnapshot[] = [];
  for (let index = 0; index < map.signalData.length; index += 1) {
    const bits = decodeSignalBits(map.signalData[index] ?? 0);
    if (!bits) continue;
    signals.push({
      x: index % map.width,
      y: Math.floor(index / map.width),
      ...bits,
    });
  }
  return signals;
}

/** Index de tuile d'une carte (convention y * width + x). */
export function mapTileIndex(map: MapSnapshot, x: number, y: number): number {
  return y * map.width + x;
}

function isRailTile(map: MapSnapshot, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return (map.kind[mapTileIndex(map, x, y)] ?? 0) === TILE_KIND_INDEX.rail;
}

function hasSignalAt(map: MapSnapshot, index: number): boolean {
  return (map.signalData?.[index] ?? 0) !== 0;
}

/**
 * Tuiles du canton protégé par un signal. Parcours en largeur déterministe :
 * on part de la tuile du signal, on suit les rails orthogonalement, et on
 * s'arrête au signal suivant (sa tuile reste dans le canton pour qu'un train
 * arrêté dessus bloque bien les deux cantons adjacents).
 */
export function signalBlockTiles(map: MapSnapshot, x: number, y: number, maxTiles = 256): number[] {
  if (!isRailTile(map, x, y)) return [];
  const start = mapTileIndex(map, x, y);
  const visited = new Set<number>([start]);
  const queue: { x: number; y: number; depth: number }[] = [{ x, y, depth: 0 }];
  const tiles: number[] = [start];
  while (queue.length > 0 && tiles.length < maxTiles) {
    const current = queue.shift();
    if (!current) continue;
    if (current.depth > 0 && hasSignalAt(map, mapTileIndex(map, current.x, current.y))) {
      // Le signal suivant borne le canton : on l'inclut mais on n'explore pas
      // au-delà.
      continue;
    }
    const neighbours = [
      [current.x + 1, current.y],
      [current.x - 1, current.y],
      [current.x, current.y + 1],
      [current.x, current.y - 1],
    ] as const;
    for (const [nx, ny] of neighbours) {
      if (!isRailTile(map, nx, ny)) continue;
      const index = mapTileIndex(map, nx, ny);
      if (visited.has(index)) continue;
      visited.add(index);
      tiles.push(index);
      queue.push({ x: nx, y: ny, depth: current.depth + 1 });
    }
  }
  return tiles;
}

export interface OccupiedTile {
  x: number;
  y: number;
}

/** `true` si un véhicule occupe l'une des tuiles du canton. */
export function isBlockOccupied(
  block: readonly number[],
  width: number,
  vehicles: readonly OccupiedTile[],
): boolean {
  if (block.length === 0) return false;
  const set = new Set(block);
  for (const vehicle of vehicles) {
    const x = Math.floor(vehicle.x);
    const y = Math.floor(vehicle.y);
    if (set.has(y * width + x)) return true;
  }
  return false;
}

/**
 * État d'un signal : rouge si un train occupe le canton protégé, vert sinon.
 * Un signal path reste rouge tant qu'aucune réservation n'est possible ; le
 * mock ne distingue pas encore ce cas et applique la même règle de canton.
 */
export function signalAspectForBlock(
  block: readonly number[],
  width: number,
  vehicles: readonly OccupiedTile[],
): SignalAspect {
  return isBlockOccupied(block, width, vehicles) ? 'red' : 'green';
}
