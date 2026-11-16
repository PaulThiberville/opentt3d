/**
 * Options de nouvelle partie : types, valeurs autorisées et validation.
 *
 * Module pur (aucun DOM) utilisé par l'écran « Nouvelle partie » et testé sous
 * Node. Les valeurs rejetées par le mock (taille, difficulté, IA, climat) sont
 * bornées ici avant d'atteindre le moteur.
 *
 * Tailles : le pont WASM exige des puissances de 2 entre 64 et 4096
 * (`ottd_new_game`). L'UI n'expose donc que 128, 256 et 512 ; toute autre
 * valeur est refusée ici, avant d'atteindre le moteur.
 */

import type { CompanyProfile } from '../engine/protocol';
import type { QualityLevel } from '../render/quality';
import { QUALITY_LEVELS } from '../render/quality';

export const MAP_SIZES = [128, 256, 512] as const;
export type MapSize = (typeof MAP_SIZES)[number];

/** Taille par défaut : 256×256 (compromis lisibilité / coût du snapshot). */
export const DEFAULT_MAP_SIZE: MapSize = 256;

export const DIFFICULTIES = [
  { value: 0, label: 'Facile' },
  { value: 1, label: 'Normale' },
  { value: 2, label: 'Difficile' },
  { value: 3, label: 'Expert' },
] as const;
export type Difficulty = 0 | 1 | 2 | 3;

export const CLIMATES = [
  { value: 'temperate', label: 'Tempéré' },
  { value: 'subarctic', label: 'Subarctique' },
  { value: 'subtropical', label: 'Subtropical' },
  { value: 'toyland', label: 'Jouet' },
] as const;
export type Climate = (typeof CLIMATES)[number]['value'];

export const AI_COMPANIES = [0, 1, 2, 3] as const;

export interface NewGameOptions {
  seed: number;
  size: MapSize;
  quality: QualityLevel;
  difficulty: Difficulty;
  aiCompanies: number;
  climate: Climate;
  startYear: number;
  /** Catastrophes optionnelles (#172), désactivées par défaut. */
  disasters: boolean;
  /**
   * Entreprises humaines créées au démarrage (#99). Absent en solo (une seule
   * entreprise locale) ; en réseau, la liste vient du `StartInfo` du salon.
   */
  companies?: CompanyProfile[];
}

export interface FieldError {
  field: keyof NewGameOptions;
  message: string;
}

export type ValidationResult =
  { ok: true; value: NewGameOptions } | { ok: false; errors: FieldError[] };

export const DEFAULT_START_YEAR = 1950;
export const MIN_START_YEAR = 1900;
export const MAX_START_YEAR = 2100;

export function createDefaultNewGameOptions(quality: QualityLevel = 'medium'): NewGameOptions {
  return {
    seed: 1337,
    size: DEFAULT_MAP_SIZE,
    quality,
    difficulty: 1,
    aiCompanies: 1,
    climate: 'temperate',
    startYear: DEFAULT_START_YEAR,
    disasters: false,
  };
}

/** Graine uint32 ; accepte décimale, hexadécimale et chaîne numérique. */
export function parseSeed(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value) >>> 0;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = /^0x[0-9a-f]+$/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed) >>> 0;
}

export function randomSeed(random: () => number = Math.random): number {
  const value = Math.floor(random() * 0x1_0000_0000);
  return (Number.isFinite(value) ? value : 0) >>> 0;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isQuality(value: unknown): value is QualityLevel {
  return typeof value === 'string' && (QUALITY_LEVELS as readonly string[]).includes(value);
}

function isClimate(value: unknown): value is Climate {
  return typeof value === 'string' && CLIMATES.some((entry) => entry.value === value);
}

function isMapSize(value: number): value is MapSize {
  return (MAP_SIZES as readonly number[]).includes(value);
}

/** Booléen tolérant : accepte 0/1 et les chaînes usuelles des paramètres URL. */
function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 0 ? false : value === 1 ? true : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'on' || text === 'oui') return true;
  if (text === '0' || text === 'false' || text === 'off' || text === 'non') return false;
  return null;
}

/**
 * Valide et normalise une saisie de formulaire. Les champs absents prennent la
 * valeur par défaut ; la graine est toujours convertie en uint32.
 */
export function validateNewGameOptions(
  input: Partial<Record<keyof NewGameOptions, unknown>>,
  defaults: NewGameOptions = createDefaultNewGameOptions(),
): ValidationResult {
  const errors: FieldError[] = [];

  const seed = input.seed === undefined ? defaults.seed : parseSeed(input.seed);
  if (seed === null)
    errors.push({ field: 'seed', message: 'La graine doit être un nombre entier.' });

  const rawSize = input.size === undefined ? defaults.size : toNumber(input.size);
  if (rawSize === null || !isMapSize(rawSize)) {
    errors.push({
      field: 'size',
      message: `Taille de carte invalide (${MAP_SIZES.join(', ')}).`,
    });
  }

  const quality = input.quality === undefined ? defaults.quality : input.quality;
  if (!isQuality(quality)) {
    errors.push({ field: 'quality', message: 'Qualité graphique inconnue.' });
  }

  const rawDifficulty =
    input.difficulty === undefined ? defaults.difficulty : toNumber(input.difficulty);
  const difficulty =
    rawDifficulty === null ? null : (Math.round(rawDifficulty) as NewGameOptions['difficulty']);
  if (difficulty === null || difficulty < 0 || difficulty > 3) {
    errors.push({ field: 'difficulty', message: 'Difficulté invalide (0 à 3).' });
  }

  const rawAi =
    input.aiCompanies === undefined ? defaults.aiCompanies : toNumber(input.aiCompanies);
  const aiCompanies = rawAi === null ? null : Math.round(rawAi);
  if (aiCompanies === null || aiCompanies < 0 || aiCompanies > 3) {
    errors.push({ field: 'aiCompanies', message: 'Nombre d’IA invalide (0 à 3).' });
  }

  const climate = input.climate === undefined ? defaults.climate : input.climate;
  if (!isClimate(climate)) {
    errors.push({ field: 'climate', message: 'Climat inconnu.' });
  }

  const rawYear = input.startYear === undefined ? defaults.startYear : toNumber(input.startYear);
  const startYear = rawYear === null ? null : Math.round(rawYear);
  if (startYear === null || startYear < MIN_START_YEAR || startYear > MAX_START_YEAR) {
    errors.push({
      field: 'startYear',
      message: `Année de départ entre ${MIN_START_YEAR} et ${MAX_START_YEAR}.`,
    });
  }

  const disasters = input.disasters === undefined ? defaults.disasters : toBoolean(input.disasters);
  if (disasters === null) {
    errors.push({ field: 'disasters', message: 'Option désastres invalide (oui ou non).' });
  }

  if (
    errors.length > 0 ||
    seed === null ||
    rawSize === null ||
    !isQuality(quality) ||
    difficulty === null ||
    aiCompanies === null ||
    !isClimate(climate) ||
    startYear === null ||
    disasters === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      seed,
      size: rawSize as MapSize,
      quality,
      difficulty,
      aiCompanies,
      climate,
      startYear,
      disasters,
    },
  };
}

/** Fusion tolérante (utile pour les paramètres d'URL). */
export function mergeNewGameOptions(
  base: NewGameOptions,
  patch: Partial<Record<keyof NewGameOptions, unknown>>,
): NewGameOptions {
  const result = validateNewGameOptions(patch, base);
  return result.ok ? result.value : base;
}
