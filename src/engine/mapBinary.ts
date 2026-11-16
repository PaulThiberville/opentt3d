/**
 * Décodeur du snapshot carte binaire v1 produit par `ottd_snapshot_map()`
 * (engine/bridge/ottd_bridge.cpp).
 *
 * Disposition little-endian :
 *
 *   0   en-tête de 64 octets (magic OTM1, version, dimensions, tick, séquence…)
 *   64  répertoire : 7 entrées de 12 octets (id, elem_size, flags, offset, length)
 *   148 données : 7 couches contiguës de `width * height` octets
 *
 * Couches, dans l'ordre : kind, heightMap, owner, slope, flags, trackBits,
 * signalData (#156). La version 2 ajoute `signalData` ; le décodeur accepte
 * encore la version 1 (6 couches) pour les artefacts WASM antérieurs et
 * fabrique alors une couche de signaux vide. Les tableaux renvoyés sont des
 * **copies** : aucune vue ne dépend du buffer d'entrée, donc aucune vue ne
 * survit à un `step()` du moteur.
 *
 * Toute anomalie lève une `MapSnapshotError` avec un message lisible : le
 * protocole est strict, une carte mal formée ne doit jamais être rendue.
 */

import type { MapSnapshot } from './protocol';

/** "OTM1" en little-endian. */
export const MAP_SNAPSHOT_MAGIC = 0x314d544f;
export const MAP_SNAPSHOT_VERSION = 2;
/** Version minimale encore lisible (artefacts WASM antérieurs à #156). */
export const MAP_SNAPSHOT_MIN_VERSION = 1;
export const MAP_HEADER_SIZE = 64;
export const MAP_DIRECTORY_ENTRY_SIZE = 12;
export const MAP_LAYER_COUNT = 7;
/** Nombre de couches de la version 1, sans `signalData`. */
export const MAP_LAYER_COUNT_V1 = 6;
export const MAP_DATA_OFFSET = MAP_HEADER_SIZE + MAP_LAYER_COUNT * MAP_DIRECTORY_ENTRY_SIZE;

/** Identifiants de couche du répertoire. */
export const MAP_LAYER_ID = {
  kind: 1,
  heightMap: 2,
  owner: 3,
  slope: 4,
  flags: 5,
  trackBits: 6,
  signalData: 7,
} as const;

export type MapLayerName = keyof typeof MAP_LAYER_ID;

/** Ordre attendu des couches dans les données. */
export const MAP_LAYER_ORDER: readonly MapLayerName[] = [
  'kind',
  'heightMap',
  'owner',
  'slope',
  'flags',
  'trackBits',
  'signalData',
];

export type MapSnapshotErrorCode =
  'too-small' | 'magic' | 'version' | 'header' | 'dimensions' | 'directory' | 'layer' | 'bounds';

export class MapSnapshotError extends Error {
  readonly code: MapSnapshotErrorCode;

  constructor(code: MapSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'MapSnapshotError';
    this.code = code;
  }
}

export interface MapSnapshotHeader {
  magic: number;
  version: number;
  headerSize: number;
  width: number;
  height: number;
  tileCount: number;
  layerCount: number;
  sequence: number;
  tick: number;
  flags: number;
  dataOffset: number;
  directoryOffset: number;
  bytesPerLayer: number;
}

export interface DecodedMapSnapshot {
  header: MapSnapshotHeader;
  width: number;
  height: number;
  tileCount: number;
  /** Tick moteur auquel la carte a été prise (doit égaler `meta.tick`). */
  tick: number;
  /** Compteur de snapshots carte, indépendant de celui du JSON. */
  sequence: number;
  map: MapSnapshot;
}

export interface DecodeMapExpectations {
  /** Dimensions attendues (issues du snapshot JSON). */
  width?: number;
  height?: number;
  /** Tick attendu : garantit que carte et entités viennent du même instant. */
  tick?: number;
}

function fail(code: MapSnapshotErrorCode, message: string): never {
  throw new MapSnapshotError(code, message);
}

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/**
 * Décode un buffer complet. `bytes` peut être une vue sur le heap WASM : elle
 * n'est lue que le temps de l'appel et recopiée dans des `Uint8Array` neufs.
 */
export function decodeMapSnapshot(
  bytes: Uint8Array,
  expected: DecodeMapExpectations = {},
): DecodedMapSnapshot {
  if (bytes.byteLength < MAP_HEADER_SIZE) {
    fail(
      'too-small',
      `Snapshot carte tronqué : ${bytes.byteLength} octets, en-tête de ${MAP_HEADER_SIZE} requis.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MAP_SNAPSHOT_MAGIC) {
    fail(
      'magic',
      `Magic de carte invalide : 0x${magic.toString(16).padStart(8, '0')} ` +
        `(attendu 0x${MAP_SNAPSHOT_MAGIC.toString(16)} « OTM1 »).`,
    );
  }

  const version = view.getUint16(4, true);
  if (version < MAP_SNAPSHOT_MIN_VERSION || version > MAP_SNAPSHOT_VERSION) {
    fail(
      'version',
      `Version de snapshot carte non supportée : ${version} ` +
        `(attendu ${MAP_SNAPSHOT_MIN_VERSION}..${MAP_SNAPSHOT_VERSION}). ` +
        'Reconstruisez le moteur et le frontend ensemble.',
    );
  }

  const headerSize = view.getUint16(6, true);
  if (headerSize !== MAP_HEADER_SIZE) {
    fail(
      'header',
      `Taille d’en-tête invalide : ${headerSize} octets (attendu ${MAP_HEADER_SIZE}).`,
    );
  }

  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const tileCount = view.getUint32(16, true);
  const layerCount = view.getUint32(20, true);
  const sequence = view.getUint32(24, true);
  const tick = view.getUint32(28, true);
  const flags = view.getUint32(32, true);
  const dataOffset = view.getUint32(36, true);
  const directoryOffset = view.getUint32(40, true);
  const bytesPerLayer = view.getUint32(44, true);

  if (width === 0 || height === 0) {
    fail('dimensions', `Dimensions de carte invalides : ${width}×${height}.`);
  }
  if (tileCount !== width * height) {
    fail(
      'dimensions',
      `Nombre de tuiles incohérent : ${tileCount} (attendu ${width}×${height} = ${width * height}).`,
    );
  }
  if (expected.width !== undefined && width !== expected.width) {
    fail('dimensions', `Largeur inattendue : ${width} (attendu ${expected.width}).`);
  }
  if (expected.height !== undefined && height !== expected.height) {
    fail('dimensions', `Hauteur inattendue : ${height} (attendu ${expected.height}).`);
  }
  if (expected.tick !== undefined && tick !== expected.tick) {
    fail(
      'dimensions',
      `Carte et entités désynchronisées : tick carte ${tick}, tick attendu ${expected.tick}.`,
    );
  }
  const expectedLayers = version === 1 ? MAP_LAYER_COUNT_V1 : MAP_LAYER_COUNT;
  if (layerCount !== expectedLayers) {
    fail(
      'directory',
      `Nombre de couches invalide : ${layerCount} (attendu ${expectedLayers} en v${version}).`,
    );
  }
  if (directoryOffset !== MAP_HEADER_SIZE) {
    fail(
      'directory',
      `Offset de répertoire invalide : ${directoryOffset} (attendu ${MAP_HEADER_SIZE}).`,
    );
  }
  const minimumDataOffset = MAP_HEADER_SIZE + layerCount * MAP_DIRECTORY_ENTRY_SIZE;
  if (dataOffset < minimumDataOffset) {
    fail('directory', `Offset de données invalide : ${dataOffset} (minimum ${minimumDataOffset}).`);
  }
  if (bytesPerLayer !== tileCount) {
    fail('directory', `Taille de couche incohérente : ${bytesPerLayer} (attendu ${tileCount}).`);
  }

  const requiredBytes = dataOffset + layerCount * tileCount;
  if (bytes.byteLength < requiredBytes) {
    fail(
      'bounds',
      `Snapshot carte tronqué : ${bytes.byteLength} octets reçus, ${requiredBytes} requis.`,
    );
  }

  const offsets = new Map<MapLayerName, number>();
  for (let index = 0; index < layerCount; index += 1) {
    const entry = directoryOffset + index * MAP_DIRECTORY_ENTRY_SIZE;
    const layerId = view.getUint8(entry);
    const elemSize = view.getUint8(entry + 1);
    const layerOffset = view.getUint32(entry + 4, true);
    const length = view.getUint32(entry + 8, true);

    const known = MAP_LAYER_ORDER.find((name) => MAP_LAYER_ID[name] === layerId);
    if (!known) {
      fail('layer', `Couche inconnue dans le répertoire : id ${layerId} (entrée ${index}).`);
    }
    if (offsets.has(known)) {
      fail('layer', `Couche dupliquée dans le répertoire : ${known}.`);
    }
    if (elemSize !== 1) {
      fail('layer', `Taille d’élément invalide pour la couche ${known} : ${elemSize} (attendu 1).`);
    }
    if (length !== tileCount) {
      fail(
        'layer',
        `Longueur invalide pour la couche ${known} : ${length} (attendu ${tileCount}).`,
      );
    }
    if (layerOffset < dataOffset) {
      fail(
        'bounds',
        `Offset de couche ${known} invalide : ${layerOffset} (données à partir de ${dataOffset}).`,
      );
    }
    if (layerOffset + length > bytes.byteLength) {
      fail(
        'bounds',
        `Couche ${known} hors du buffer : ${layerOffset}+${length} > ${bytes.byteLength}.`,
      );
    }
    offsets.set(known, layerOffset);
  }

  const requiredLayers =
    version === 1 ? MAP_LAYER_ORDER.slice(0, MAP_LAYER_COUNT_V1) : MAP_LAYER_ORDER;
  for (const name of requiredLayers) {
    if (!offsets.has(name)) fail('layer', `Couche manquante dans le répertoire : ${name}.`);
  }

  const layer = (name: MapLayerName): Uint8Array => {
    const offset = offsets.get(name);
    if (offset === undefined) fail('layer', `Couche manquante : ${name}.`);
    return bytes.slice(offset, offset + tileCount);
  };

  const header: MapSnapshotHeader = {
    magic,
    version,
    headerSize,
    width,
    height,
    tileCount,
    layerCount,
    sequence,
    tick,
    flags,
    dataOffset,
    directoryOffset,
    bytesPerLayer,
  };

  return {
    header,
    width,
    height,
    tileCount,
    tick,
    sequence,
    map: {
      width,
      height,
      kind: layer('kind'),
      heightMap: layer('heightMap'),
      owner: layer('owner'),
      slope: layer('slope'),
      flags: layer('flags'),
      trackBits: layer('trackBits'),
      signalData: offsets.has('signalData') ? layer('signalData') : new Uint8Array(tileCount),
    },
  };
}
