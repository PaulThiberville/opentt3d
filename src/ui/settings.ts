/**
 * Réglages persistants (localStorage) et valeurs par défaut.
 *
 * Le stockage est injecté (`StorageLike`) pour rester testable sous Node. Le
 * parseur est défensif : une entrée corrompue, partielle ou d'un autre type
 * retombe silencieusement sur les valeurs par défaut.
 */

import type { QualityLevel } from '../render/quality';
import { QUALITY_LEVELS } from '../render/quality';

export type Language = 'fr' | 'en';

export interface GameSettings {
  quality: QualityLevel;
  language: Language;
  masterVolume: number;
  effectsVolume: number;
  musicVolume: number;
  /** Relais P2P affiché en lecture seule tant que le lobby n'est pas branché. */
  p2pRelay: string;
}

export const SETTINGS_STORAGE_KEY = 'opentt3d.settings.v1';

export const DEFAULT_P2P_RELAY = 'Automatique (Trystero)';

export const DEFAULT_SETTINGS: GameSettings = {
  quality: 'medium',
  language: 'fr',
  masterVolume: 70,
  effectsVolume: 80,
  musicVolume: 40,
  p2pRelay: DEFAULT_P2P_RELAY,
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isQuality(value: unknown): value is QualityLevel {
  return typeof value === 'string' && (QUALITY_LEVELS as readonly string[]).includes(value);
}

function isLanguage(value: unknown): value is Language {
  return value === 'fr' || value === 'en';
}

/** Normalise un objet inconnu en réglages valides. */
export function sanitizeSettings(raw: unknown): GameSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    quality: isQuality(record.quality) ? record.quality : DEFAULT_SETTINGS.quality,
    language: isLanguage(record.language) ? record.language : DEFAULT_SETTINGS.language,
    masterVolume: clampVolume(record.masterVolume, DEFAULT_SETTINGS.masterVolume),
    effectsVolume: clampVolume(record.effectsVolume, DEFAULT_SETTINGS.effectsVolume),
    musicVolume: clampVolume(record.musicVolume, DEFAULT_SETTINGS.musicVolume),
    p2pRelay: DEFAULT_P2P_RELAY,
  };
}

export function loadSettings(storage: StorageLike | null | undefined): GameSettings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const text = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(text) as unknown);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  storage: StorageLike | null | undefined,
  settings: GameSettings,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** Copie modifiée et revalidée, sans muter l'objet source. */
export function updateSettings(
  settings: GameSettings,
  patch: Partial<Record<keyof GameSettings, unknown>>,
): GameSettings {
  return sanitizeSettings({ ...settings, ...patch });
}
