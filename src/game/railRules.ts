/**
 * Règles des types de voie ferrée (#157), partagées par l'interface, le mock
 * et le pont C++.
 *
 * Module pur : aucun DOM, aucun Three.js. Les index sont stables et alignés
 * sur l'ordre historique d'OpenTTD (`RAILTYPE_RAIL`, `RAILTYPE_ELECTRIC`,
 * `RAILTYPE_MONO`, `RAILTYPE_MAGLEV`) pour que le snapshot binaire reste
 * déterministe entre le moteur et le frontend.
 */

import {
  RAIL_TYPE_INDEX,
  RAIL_TYPES,
  TILE_KIND_INDEX,
  type MapSnapshot,
  type RailType,
} from '../engine/protocol';

export { RAIL_TYPE_INDEX, RAIL_TYPES };
export type { RailType };

export const RAIL_TYPE_LABELS: Record<RailType, string> = {
  rail: 'Rail',
  electrified: 'Rail électrifié',
  monorail: 'Monorail',
  maglev: 'Maglev',
};

export const RAIL_TYPE_DESCRIPTIONS: Record<RailType, string> = {
  rail: 'Voie classique, locomotives diesel et vapeur.',
  electrified: 'Voie classique avec caténaire, locomotives électriques.',
  monorail: 'Poutre unique, rames monorail rapides.',
  maglev: 'Sustentation magnétique, vitesse maximale.',
};

/** Surcoût par tuile par rapport au rail classique (construction neuve). */
export const RAIL_TYPE_SURCHARGE: Record<RailType, number> = {
  rail: 0,
  electrified: 140,
  monorail: 260,
  maglev: 420,
};

/** Coût de conversion d'une tuile vers un autre type. */
export const RAIL_TYPE_CONVERT_COST: Record<RailType, number> = {
  rail: 180,
  electrified: 240,
  monorail: 320,
  maglev: 460,
};

/** Seul le rail électrifié porte une caténaire. */
export function hasCatenary(type: RailType): boolean {
  return type === 'electrified';
}

/** Type de rail à partir de l'index du snapshot (0..3), sinon `rail`. */
export function railTypeFromIndex(index: number): RailType {
  if (!Number.isFinite(index)) return 'rail';
  const normalized = Math.round(index);
  for (const type of RAIL_TYPES) {
    if (RAIL_TYPE_INDEX[type] === normalized) return type;
  }
  return 'rail';
}

/** Lit un type de rail textuel (`rail`, `electric`, `mono`, `maglev`…). */
export function parseRailType(value: unknown): RailType | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return railTypeFromIndex(value);
  }
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'rail':
    case 'normal':
    case 'classique':
      return 'rail';
    case 'electrified':
    case 'electric':
    case 'electrifie':
    case 'électrifié':
    case 'elrail':
      return 'electrified';
    case 'monorail':
    case 'mono':
      return 'monorail';
    case 'maglev':
      return 'maglev';
    default:
      return null;
  }
}

/** Type suivant dans le cycle de l'interface (rail → électrifié → mono → maglev). */
export function nextRailType(type: RailType): RailType {
  const index = RAIL_TYPES.indexOf(type);
  return RAIL_TYPES[(index + 1) % RAIL_TYPES.length] ?? 'rail';
}

/** Type effectif d'une tuile : `railTypes` explicite, sinon m8 du pont. */
export function railTypeAt(
  railTypes: Uint8Array | undefined,
  trackBits: Uint8Array | undefined,
  index: number,
  fromBridge: boolean,
): RailType {
  const explicit = railTypes?.[index];
  if (explicit !== undefined && explicit !== 0xff) return railTypeFromIndex(explicit);
  // Le pont stocke le type de rail dans m8 pour les tuiles MP_RAILWAY ; le
  // mock, lui, utilise m8 pour ses bits de connexion (jamais un type fiable).
  if (fromBridge) return railTypeFromIndex((trackBits?.[index] ?? 0) & 0x7);
  return 'rail';
}

/**
 * Complète `MapSnapshot.railTypes` depuis le m8 du pont. Seules les tuiles
 * `rail` portent un type fiable ; les autres retombent sur `rail`.
 */
export function deriveRailTypes(map: MapSnapshot): Uint8Array {
  const indexRail = TILE_KIND_INDEX.rail;
  const types = new Uint8Array(map.width * map.height).fill(RAIL_TYPE_INDEX.rail);
  for (let index = 0; index < types.length; index += 1) {
    if ((map.kind[index] ?? 0) !== indexRail) continue;
    types[index] = (map.trackBits[index] ?? 0) & 0x7;
  }
  return types;
}
