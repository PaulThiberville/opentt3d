/**
 * Fixtures de sauvegarde pour les tests : un conteneur OT3S minimal et une
 * sauvegarde mock JSON valide. Aucun fichier binaire n'est nécessaire.
 */

import { PROTOCOL_VERSION } from '../../src/engine/protocol';

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export interface MockSaveOptions {
  seed?: number;
  width?: number;
  tick?: number;
  year?: number;
  month?: number;
  day?: number;
  companies?: string[];
  version?: number;
}

/** JSON conforme à `MockEngine.save()` pour une carte `width×width`. */
export function mockSaveBytes(options: MockSaveOptions = {}): Uint8Array {
  const width = options.width ?? 4;
  const layer = base64(new Uint8Array(width * width));
  const world = {
    seed: options.seed ?? 1337,
    width,
    height: width,
    tick: options.tick ?? 0,
    year: options.year ?? 1950,
    month: options.month ?? 0,
    day: options.day ?? 1,
    paused: false,
    speed: 1,
    rngState: 1,
    sequence: 1,
    mapVersion: 1,
    kind: layer,
    heightMap: layer,
    owner: layer,
    slope: layer,
    flags: layer,
    trackBits: layer,
    companies: (options.companies ?? ['Transport du Nord']).map((name, id) => ({
      id,
      name,
      president: '—',
      colour: id,
      money: 100000,
      loan: 0,
      value: 100000,
      income: 0,
      expenses: 0,
      vehicles: 0,
      stations: 0,
      isAI: false,
      isLocal: id === 0,
      bankrupt: false,
    })),
    towns: [],
    industries: [],
    stations: [],
    vehicles: [],
    news: [],
  };
  return new TextEncoder().encode(
    JSON.stringify({ v: options.version ?? PROTOCOL_VERSION, world }),
  );
}

export interface Ot3sOptions {
  tick?: number;
  name?: string;
  mapSize?: number;
  startYear?: number;
  difficulty?: number;
  aiCompanies?: number;
  climate?: number;
  disasters?: boolean;
  payload?: Uint8Array;
}

/**
 * Conteneur OT3S minimal : en-tête de 32 octets, métadonnées du pont (nom et
 * configuration), puis une charge `.sav` factice. Le checksum n'est pas
 * recalculé : `inspectSaveBytes` ne le vérifie pas, le pont le fera au chargement.
 */
export function ot3sSaveBytes(options: Ot3sOptions = {}): Uint8Array {
  const name = new TextEncoder().encode(options.name ?? 'Partie de test');
  const payload = options.payload ?? new TextEncoder().encode('OTTX-fake-sav-payload');
  const metadataSize = 36 + name.length + 4;
  const total = 32 + metadataSize + payload.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x54, 0x33, 0x53], 0); // OT3S
  view.setUint16(4, 1, true);
  view.setUint16(6, 32, true);
  view.setUint32(8, payload.length, true);
  view.setUint32(12, options.tick ?? 0, true);
  view.setUint32(24, metadataSize, true);
  view.setUint32(28, 0, true);

  const metadata = 32;
  const flags =
    (1 << 0) |
    (1 << 1) |
    (1 << 2) |
    (1 << 3) |
    (1 << 6) |
    (options.disasters === undefined ? 0 : 1 << 7);
  bytes[metadata] = flags;
  bytes[metadata + 1] = options.climate ?? 0;
  view.setUint32(metadata + 4, options.startYear ?? 1950, true);
  view.setUint32(metadata + 8, options.difficulty ?? 1, true);
  view.setUint32(metadata + 12, options.aiCompanies ?? 1, true);
  view.setUint32(metadata + 24, options.mapSize ?? 128, true);
  bytes[metadata + 28] = options.disasters === true ? 1 : 0;
  view.setUint32(metadata + 32, name.length, true);
  bytes.set(name, metadata + 36);
  view.setUint32(metadata + 36 + name.length, 0, true);
  bytes.set(payload, metadata + metadataSize);
  return bytes;
}
