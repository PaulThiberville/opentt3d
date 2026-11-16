/**
 * Format des sauvegardes locales : métadonnées de slot, nommage, validation
 * d'import et rotation de l'autosave.
 *
 * Module pur (aucun DOM, aucun IndexedDB) utilisé par `saveStore`, les écrans
 * et les tests sous Node. Il connaît les deux formats produits par les pilotes :
 *
 * - `mock-json` : JSON `{ v, world }` de `MockEngine.save()` ;
 * - `ot3s` : conteneur binaire du pont OpenTTD (en-tête `OT3S` de 32 octets,
 *   métadonnées du pont puis `.sav` OpenTTD standard).
 *
 * L'import refuse tout ce qui n'est pas l'un de ces deux formats : un `.sav`
 * OpenTTD brut ne contient pas les métadonnées du pont et serait rejeté par
 * `ottd_load` de toute façon.
 */

import { PROTOCOL_VERSION } from '../engine/protocol';
import { formatGameDate, type GameDateLike } from './format';
import { t } from './i18n';

/** Taille maximale d'une sauvegarde (32 Mio). Au-delà, import et écriture refusés. */
export const MAX_SAVE_BYTES = 32 * 1024 * 1024;

/** Nombre de sauvegardes automatiques conservées (rotation glissante). */
export const AUTOSAVE_SLOT_COUNT = 3;

/** Version du schéma de métadonnées stocké dans IndexedDB. */
export const SAVE_SCHEMA_VERSION = 1;

export type SaveEngine = 'mock' | 'wasm';
export type SaveKind = 'manual' | 'autosave' | 'import';
export type SaveFormat = 'ot3s' | 'mock-json';

export interface SaveGameDate {
  year: number;
  month: number;
  day: number;
}

/** Métadonnées d'un slot, sans les octets (la liste ne charge jamais les blobs). */
export interface SaveSlot {
  id: string;
  schema: number;
  name: string;
  /** Horodatage réel de l'écriture (ms epoch). */
  createdAt: number;
  engine: SaveEngine;
  kind: SaveKind;
  format: SaveFormat;
  /** Taille du conteneur en octets. */
  size: number;
  /** Graine si connue (mock, ou slot créé depuis une session live). */
  seed: number | null;
  /** Taille de carte si connue. */
  mapSize: number | null;
  /** Date de jeu au moment de la sauvegarde, si connue. */
  gameDate: SaveGameDate | null;
  /** Noms des entreprises présentes, sans donnée personnelle. */
  companies: string[];
  /** Tick moteur au moment de la sauvegarde. */
  tick: number;
  /** Version de protocole déclarée par le conteneur (si connue). */
  protocol: number | null;
}

export interface SaveRecord extends SaveSlot {
  bytes: Uint8Array;
}

export type SaveErrorCode =
  'empty' | 'too-large' | 'unsupported' | 'truncated' | 'corrupt' | 'version';

/** Erreur lisible de format/validation, destinée à l'UI. */
export class SaveFormatError extends Error {
  readonly code: SaveErrorCode;

  constructor(code: SaveErrorCode, message: string) {
    super(message);
    this.name = 'SaveFormatError';
    this.code = code;
  }
}

const OT3S_MAGIC = [0x4f, 0x54, 0x33, 0x53] as const; // « OT3S »
const SAV_MAGIC = [0x4f, 0x54, 0x54] as const; // « OTT » (OTTX / OTTZ / OTTN)
const OT3S_HEADER_SIZE = 32;
const OT3S_VERSION = 1;

const CLIMATES = ['temperate', 'subarctic', 'subtropical', 'toyland'] as const;

/** Longueur décodée d'une chaîne base64 standard, ou -1 si mal formée. */
export function base64ByteLength(text: string): number {
  if (text.length === 0) return 0;
  if (text.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return -1;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/** Détecte le format sans parser le contenu (rapide, utilisé avant écriture). */
export function detectSaveFormat(bytes: Uint8Array): SaveFormat | null {
  if (isOt3s(bytes)) return 'ot3s';
  const first = firstNonWhitespace(bytes);
  if (first === 0x7b) return 'mock-json'; // « { »
  return null;
}

function isOt3s(bytes: Uint8Array): boolean {
  return OT3S_MAGIC.every((value, index) => bytes[index] === value);
}

function isRawOpenTtdSave(bytes: Uint8Array): boolean {
  return SAV_MAGIC.every((value, index) => bytes[index] === value);
}

function firstNonWhitespace(bytes: Uint8Array): number | null {
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index] ?? 0;
    if (value !== 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) return value;
  }
  return null;
}

export interface SaveInspection {
  format: SaveFormat;
  engine: SaveEngine;
  /** Taille réelle du conteneur. */
  size: number;
  /** Tick de sauvegarde (diagnostic). */
  tick: number;
  /** Nom interne (métadonnées du pont), sans garantie d'unicité. */
  name: string | null;
  seed: number | null;
  mapSize: number | null;
  gameDate: SaveGameDate | null;
  companies: string[];
  protocol: number | null;
  /** Champs de configuration retrouvés dans les métadonnées du pont. */
  climate: (typeof CLIMATES)[number] | null;
  difficulty: number | null;
  aiCompanies: number | null;
  startYear: number | null;
  /** Option désastres (#172), absente des conteneurs antérieurs. */
  disasters: boolean | null;
}

interface BridgeMetadata {
  name: string | null;
  mapSize: number | null;
  climate: SaveInspection['climate'];
  difficulty: number | null;
  aiCompanies: number | null;
  startYear: number | null;
  disasters: boolean | null;
}

function emptyBridgeMetadata(): BridgeMetadata {
  return {
    name: null,
    mapSize: null,
    climate: null,
    difficulty: null,
    aiCompanies: null,
    startYear: null,
    disasters: null,
  };
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/** Vérifie et décrit une sauvegarde importée. Lève `SaveFormatError` si invalide. */
export function inspectSaveBytes(bytes: Uint8Array): SaveInspection {
  if (bytes.length === 0) {
    throw new SaveFormatError('empty', t('save.error.empty'));
  }
  if (bytes.length > MAX_SAVE_BYTES) {
    throw new SaveFormatError(
      'too-large',
      t('save.error.tooLarge', {
        size: formatSaveSize(bytes.length),
        max: formatSaveSize(MAX_SAVE_BYTES),
      }),
    );
  }
  if (isOt3s(bytes)) return inspectOt3s(bytes);
  if (isRawOpenTtdSave(bytes)) {
    throw new SaveFormatError('unsupported', t('save.error.unsupportedRaw'));
  }
  const first = firstNonWhitespace(bytes);
  if (first === 0x7b) return inspectMockJson(bytes);
  throw new SaveFormatError('unsupported', t('save.error.unsupported'));
}

function inspectOt3s(bytes: Uint8Array): SaveInspection {
  if (bytes.length < OT3S_HEADER_SIZE) {
    throw new SaveFormatError('truncated', t('save.error.headerTruncated'));
  }
  const version = readU16(bytes, 4);
  if (version !== OT3S_VERSION) {
    throw new SaveFormatError(
      'version',
      t('save.error.version', { version, expected: OT3S_VERSION }),
    );
  }
  const headerSize = readU16(bytes, 6);
  if (headerSize < OT3S_HEADER_SIZE) {
    throw new SaveFormatError('corrupt', t('save.error.headerSize'));
  }
  const payloadSize = readU32(bytes, 8);
  const tick = readU32(bytes, 12);
  const metadataSize = readU32(bytes, 24);
  const expected = headerSize + metadataSize + payloadSize;
  if (expected > bytes.length) {
    throw new SaveFormatError(
      'truncated',
      t('save.error.truncated', {
        missing: formatSaveSize(expected - bytes.length),
      }),
    );
  }
  if (expected !== bytes.length) {
    throw new SaveFormatError('corrupt', t('save.error.sizeMismatch'));
  }
  if (payloadSize === 0) {
    throw new SaveFormatError('corrupt', t('save.error.emptyPayload'));
  }

  const metadata = readBridgeMetadata(bytes, headerSize, metadataSize);
  return {
    format: 'ot3s',
    engine: 'wasm',
    size: bytes.length,
    tick,
    name: metadata.name,
    // Le .sav ne conserve ni la graine ni la date de jeu courante de façon
    // accessible : l'UI les affiche comme inconnues jusqu'au chargement.
    seed: null,
    mapSize: metadata.mapSize,
    gameDate: null,
    companies: [],
    // Le conteneur OT3S n'embarque pas la version du protocole du frontend :
    // elle sera connue au premier snapshot après chargement.
    protocol: null,
    climate: metadata.climate,
    difficulty: metadata.difficulty,
    aiCompanies: metadata.aiCompanies,
    startYear: metadata.startYear,
    disasters: metadata.disasters,
  };
}

/**
 * Métadonnées du pont (voir Protocole > Sauvegarde mémoire) : 36 octets fixes,
 * longueur + nom de partie, puis nombre + liste d'avertissements. On ne lit que
 * ce qui est nécessaire à l'affichage ; le pont revalide le conteneur complet.
 */
function readBridgeMetadata(bytes: Uint8Array, offset: number, size: number): BridgeMetadata {
  const metadata = emptyBridgeMetadata();
  if (size < 40) return metadata;
  const end = offset + size;
  if (end > bytes.length) {
    throw new SaveFormatError('truncated', t('save.error.metadataTruncated'));
  }
  const flags = bytes[offset] ?? 0;
  const landscape = bytes[offset + 1] ?? 0;
  if ((flags & (1 << 0)) !== 0) {
    metadata.climate = CLIMATES[landscape] ?? null;
  }
  if ((flags & (1 << 1)) !== 0) metadata.startYear = readU32(bytes, offset + 4);
  if ((flags & (1 << 2)) !== 0) metadata.difficulty = readU32(bytes, offset + 8);
  if ((flags & (1 << 3)) !== 0) metadata.aiCompanies = readU32(bytes, offset + 12);
  if ((flags & (1 << 7)) !== 0) metadata.disasters = (bytes[offset + 28] ?? 0) !== 0;
  if ((flags & (1 << 6)) !== 0) metadata.mapSize = readU32(bytes, offset + 24);

  const nameLength = readU32(bytes, offset + 32);
  if (36 + nameLength > size) {
    throw new SaveFormatError('corrupt', t('save.error.metadataCorrupt'));
  }
  if (nameLength > 0) {
    const nameBytes = bytes.subarray(offset + 36, offset + 36 + nameLength);
    metadata.name = new TextDecoder().decode(nameBytes);
  }
  return metadata;
}

function inspectMockJson(bytes: Uint8Array): SaveInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SaveFormatError('corrupt', t('save.error.mockJson'));
  }
  if (!isRecord(parsed)) {
    throw new SaveFormatError('corrupt', t('save.error.mockRoot'));
  }
  const version = parsed.v;
  if (version !== PROTOCOL_VERSION) {
    throw new SaveFormatError(
      'version',
      t('save.error.mockVersion', { version: String(version), protocol: PROTOCOL_VERSION }),
    );
  }
  const world = parsed.world;
  if (!isRecord(world)) {
    throw new SaveFormatError('corrupt', t('save.error.mockWorld'));
  }
  const width = asPositiveInt(world.width);
  const height = asPositiveInt(world.height);
  if (width === null || height === null || width !== height || width > 4096) {
    throw new SaveFormatError('corrupt', t('save.error.mockDimensions'));
  }
  const expected = width * height;
  for (const field of ['kind', 'heightMap', 'owner', 'slope', 'flags', 'trackBits']) {
    const text = world[field];
    if (typeof text !== 'string') {
      throw new SaveFormatError('corrupt', t('save.error.mockLayer', { field }));
    }
    const length = base64ByteLength(text);
    if (length !== expected) {
      throw new SaveFormatError(
        'truncated',
        t('save.error.mockLayerTruncated', { field, actual: length, expected }),
      );
    }
  }
  for (const field of ['companies', 'towns', 'industries', 'stations', 'vehicles', 'news']) {
    if (!Array.isArray(world[field])) {
      throw new SaveFormatError('corrupt', t('save.error.mockList', { field }));
    }
  }

  const year = asPositiveInt(world.year);
  const month = asNonNegativeInt(world.month);
  const day = asPositiveInt(world.day);
  const gameDate =
    year !== null && month !== null && month <= 11 && day !== null && day <= 31
      ? { year, month, day }
      : null;

  const companies = Array.isArray(world.companies)
    ? world.companies
        .map((company) =>
          isRecord(company) && typeof company.name === 'string' ? company.name : null,
        )
        .filter((name): name is string => name !== null)
        .map((name) => name.slice(0, 64))
    : [];

  const seed = asNonNegativeInt(world.seed);
  return {
    format: 'mock-json',
    engine: 'mock',
    size: bytes.length,
    tick: asNonNegativeInt(world.tick) ?? 0,
    name: null,
    seed: seed === null ? null : seed >>> 0,
    mapSize: width,
    gameDate,
    companies,
    protocol: PROTOCOL_VERSION,
    climate: null,
    difficulty: null,
    aiCompanies: null,
    startYear: null,
    disasters: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPositiveInt(value: unknown): number | null {
  const number = asNonNegativeInt(value);
  return number !== null && number > 0 ? number : null;
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded >= 0 ? rounded : null;
}

/* ------------------------------------------------------------------------- */
/*  Nommage et affichage                                                     */
/* ------------------------------------------------------------------------- */

/** Nettoie un nom saisi : espaces compactés, caractères de contrôle retirés. */
export function sanitizeSaveName(raw: string, fallback = 'Sauvegarde'): string {
  const clean = Array.from(raw)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const bounded = Array.from(clean).slice(0, 60).join('');
  return bounded === '' ? fallback : bounded;
}

/** Nom par défaut d'une sauvegarde manuelle : la date de jeu. */
export function defaultSaveName(date: GameDateLike | null | undefined): string {
  const label = formatGameDate(date);
  return label === '—' ? 'Sauvegarde manuelle' : `Partie du ${label}`;
}

/** Nom lisible d'un autosave, préfixé pour être repérable dans la liste. */
export function autosaveName(date: GameDateLike | null | undefined): string {
  const label = formatGameDate(date);
  return label === '—' ? 'Autosave' : `Autosave · ${label}`;
}

/** Taille lisible en français (o, Kio, Mio). */
export function formatSaveSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} o`;
  if (bytes < 1024 * 1024) {
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(
      bytes / 1024,
    )} Kio`;
  }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(
    bytes / (1024 * 1024),
  )} Mio`;
}

/** Horodatage local court : « 15/11/2026 14:32 ». */
export function formatSaveTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  const date = new Date(epochMs);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Étiquette du moteur pour la liste. */
export function engineLabel(engine: SaveEngine): string {
  return engine === 'wasm' ? 'WASM' : 'Mock';
}

function slugify(text: string): string {
  const ascii = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii.slice(0, 48) || 'sauvegarde';
}

/** Nom de fichier d'export, lisible et sans caractère interdit. */
export function saveFileName(slot: SaveSlot): string {
  const extension = slot.format === 'ot3s' ? 'ot3s' : 'json';
  const date = slot.gameDate
    ? `${slot.gameDate.year}-${`${slot.gameDate.month + 1}`.padStart(2, '0')}-${`${
        slot.gameDate.day
      }`.padStart(2, '0')}`
    : new Date(slot.createdAt).toISOString().slice(0, 10);
  return `opentt3d-${slugify(slot.name)}-${date}.${extension}`;
}

/* ------------------------------------------------------------------------- */
/*  Autosave                                                                 */
/* ------------------------------------------------------------------------- */

export interface AutosaveConfig {
  /** Intervalle en temps réel (ms). */
  intervalMs: number;
  /** Intervalle en ticks de jeu. */
  intervalTicks: number;
}

/** Par défaut : cinq minutes réelles ou 9 000 ticks (5 min à vitesse 1). */
export const DEFAULT_AUTOSAVE: AutosaveConfig = {
  intervalMs: 5 * 60_000,
  intervalTicks: 9_000,
};

/**
 * Planifie les autosaves sans horloge implicite : l'appelant fournit le temps
 * réel et le tick courant. Le premier appel arme seulement la fenêtre, ce qui
 * évite une sauvegarde immédiate au démarrage de la partie.
 */
export class AutosaveScheduler {
  readonly intervalMs: number;
  readonly intervalTicks: number;

  private lastMs: number | null = null;
  private lastTick: number | null = null;

  constructor(config: AutosaveConfig = DEFAULT_AUTOSAVE) {
    this.intervalMs = Math.max(5_000, Math.round(config.intervalMs));
    this.intervalTicks = Math.max(1, Math.round(config.intervalTicks));
  }

  due(nowMs: number, tick: number): boolean {
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const current = Number.isFinite(tick) && tick >= 0 ? tick : 0;
    if (this.lastMs === null || this.lastTick === null) {
      this.lastMs = now;
      this.lastTick = current;
      return false;
    }
    const elapsedMs = now - this.lastMs;
    const elapsedTicks = current - this.lastTick;
    if (elapsedMs < this.intervalMs && elapsedTicks < this.intervalTicks) return false;
    this.lastMs = now;
    this.lastTick = current;
    return true;
  }

  reset(nowMs = 0, tick = 0): void {
    this.lastMs = nowMs;
    this.lastTick = tick;
  }
}

/** Prochain identifiant d'autosave, à partir des slots existants. */
export function nextAutosaveId(slots: readonly SaveSlot[]): string {
  let max = 0;
  for (const slot of slots) {
    if (slot.kind !== 'autosave') continue;
    const match = /^autosave-(\d+)$/.exec(slot.id);
    if (match) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10));
  }
  return `autosave-${max + 1}`;
}

export interface AutosaveRotation {
  keep: string[];
  remove: string[];
}

/**
 * Rotation glissante : conserve les `keep` autosaves les plus récentes et
 * renvoie les identifiants à supprimer. Ne touche jamais aux slots manuels.
 */
export function planAutosaveRotation(
  slots: readonly SaveSlot[],
  keep = AUTOSAVE_SLOT_COUNT,
): AutosaveRotation {
  const limit = Math.max(1, Math.trunc(keep));
  const autosaves = slots
    .filter((slot) => slot.kind === 'autosave')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const excess = Math.max(0, autosaves.length - limit);
  return {
    keep: autosaves.slice(excess).map((slot) => slot.id),
    remove: autosaves.slice(0, excess).map((slot) => slot.id),
  };
}
