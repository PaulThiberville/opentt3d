/**
 * Fixtures synthétiques du snapshot carte binaire (v1 à v3).
 *
 * Construit des buffers conformes (ou volontairement corrompus) sans WASM,
 * pour tester `src/engine/mapBinary.ts` de façon déterministe.
 */

import {
  MAP_DATA_OFFSET,
  MAP_DIRECTORY_ENTRY_SIZE,
  MAP_HEADER_SIZE,
  MAP_LAYER_COUNT,
  MAP_LAYER_COUNT_V2,
  MAP_LAYER_ID,
  MAP_LAYER_ORDER,
  MAP_SNAPSHOT_MAGIC,
  MAP_SNAPSHOT_VERSION,
  type MapLayerName,
} from '../../src/engine/mapBinary';

export interface MapFixtureOptions {
  width?: number;
  height?: number;
  tick?: number;
  sequence?: number;
  flags?: number;
  /** Contenu des couches ; par défaut un motif déterministe par couche. */
  layers?: Partial<Record<MapLayerName, Uint8Array>>;
  /** Version du snapshot (1 sans signaux, 2 sans sens unique, 3 courant). */
  version?: number;
  /** En-tête corrompu à façon (appliqué après écriture). */
  corrupt?: (view: DataView, bytes: Uint8Array) => void;
}

function defaultLayer(name: MapLayerName, tileCount: number): Uint8Array {
  // Une carte sans signal est le cas nominal : la couche de signaux démarre à
  // zéro (sinon le rendu et les tests verraient des signaux aléatoires).
  if (name === 'signalData') return new Uint8Array(tileCount);
  // Idem pour le sens des routes (#231) : double sens par défaut.
  if (name === 'roadData') return new Uint8Array(tileCount);
  const seed = MAP_LAYER_ID[name];
  const layer = new Uint8Array(tileCount);
  for (let index = 0; index < tileCount; index += 1) {
    layer[index] = (seed * 17 + index * 3) & 0xff;
  }
  return layer;
}

export function buildMapFixture(options: MapFixtureOptions = {}): Uint8Array {
  const width = options.width ?? 2;
  const height = options.height ?? 2;
  const tileCount = width * height;
  const version = options.version ?? MAP_SNAPSHOT_VERSION;
  const layerCount =
    version === 1 ? MAP_LAYER_COUNT - 2 : version === 2 ? MAP_LAYER_COUNT_V2 : MAP_LAYER_COUNT;
  const dataOffset = MAP_HEADER_SIZE + layerCount * MAP_DIRECTORY_ENTRY_SIZE;
  const bytes = new Uint8Array(dataOffset + layerCount * tileCount);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, MAP_SNAPSHOT_MAGIC, true);
  view.setUint16(4, version, true);
  view.setUint16(6, MAP_HEADER_SIZE, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, tileCount, true);
  view.setUint32(20, layerCount, true);
  view.setUint32(24, options.sequence ?? 1, true);
  view.setUint32(28, options.tick ?? 1000, true);
  view.setUint32(32, options.flags ?? 1, true);
  view.setUint32(36, dataOffset, true);
  view.setUint32(40, MAP_HEADER_SIZE, true);
  view.setUint32(44, tileCount, true);

  MAP_LAYER_ORDER.slice(0, layerCount).forEach((name, index) => {
    const entry = MAP_HEADER_SIZE + index * MAP_DIRECTORY_ENTRY_SIZE;
    const layerOffset = dataOffset + index * tileCount;
    const layer = options.layers?.[name] ?? defaultLayer(name, tileCount);
    view.setUint8(entry, MAP_LAYER_ID[name]);
    view.setUint8(entry + 1, 1);
    view.setUint16(entry + 2, 0, true);
    view.setUint32(entry + 4, layerOffset, true);
    view.setUint32(entry + 8, tileCount, true);
    bytes.set(layer.subarray(0, tileCount), layerOffset);
  });

  options.corrupt?.(view, bytes);
  return bytes;
}

/** Écrit un champ u32 de l'en-tête (raccourci pour les tests d'erreur). */
export function setHeaderU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

/** Écrit un champ u16 de l'en-tête. */
export function setHeaderU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

/** Offset absolu des données d'une couche dans un buffer conforme. */
export function layerOffset(name: MapLayerName, width = 2, height = 2): number {
  const index = MAP_LAYER_ORDER.indexOf(name);
  return MAP_DATA_OFFSET + index * width * height;
}
