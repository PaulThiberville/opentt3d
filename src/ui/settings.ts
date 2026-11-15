/**
 * Réglages persistants (localStorage) et valeurs par défaut.
 *
 * Le stockage est injecté (`StorageLike`) pour rester testable sous Node. Le
 * parseur est défensif : une entrée corrompue, partielle ou d'un autre type
 * retombe silencieusement sur les valeurs par défaut.
 */

import type { EngineMode } from '../engine/loadEngine';
import type { QualityLevel } from '../render/quality';
import { QUALITY_LEVELS } from '../render/quality';
import { DEFAULT_DAY_NIGHT_CYCLE_SECONDS, sanitizeCycleSeconds } from '../render/dayNightCycle';

export type Language = 'fr' | 'en';

export interface GameSettings {
  quality: QualityLevel;
  /**
   * Moteur proposé pour les prochaines parties solo (#78). Une sauvegarde garde
   * le moteur qui l'a produite et le réseau le fige dans `StartInfo`.
   */
  engine: EngineMode;
  language: Language;
  masterVolume: number;
  effectsVolume: number;
  musicVolume: number;
  /** Relais P2P affiché en lecture seule tant que le lobby n'est pas branché. */
  p2pRelay: string;
  /** Cycle jour/nuit visuel (aucun effet sur le gameplay). */
  dayNightCycle: boolean;
  /** Durée d'une journée visuelle complète, en secondes. */
  dayNightCycleSeconds: number;
  /** Intro cinématique de début de partie (désactivée par reduced motion). */
  cinematicIntro: boolean;
}

export const SETTINGS_STORAGE_KEY = 'opentt3d.settings.v1';

export const DEFAULT_P2P_RELAY = 'Automatique (Trystero)';

/** Upper bound on configured signalling relays (keeps the UI and config sane). */
export const MAX_P2P_RELAYS = 8;

const RELAY_URL_PATTERN = /^wss?:\/\/[^\s,;]+$/i;

/** Extracts validated relay URLs from an array or a comma/space-separated string. */
export function parseRelayUrls(value: unknown): string[] {
  const source =
    typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
  const seen = new Set<string>();
  for (const item of source) {
    const url = item.trim().replace(/\/+$/, '');
    if (!RELAY_URL_PATTERN.test(url)) continue;
    seen.add(url);
    if (seen.size >= MAX_P2P_RELAYS) break;
  }
  return [...seen];
}

/** Normalises the persisted relay setting: a validated list or "Automatic". */
export function sanitizeP2pRelay(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_P2P_RELAY;
  const trimmed = value.trim();
  if (!trimmed || /^(automatique|automatic)/i.test(trimmed)) return DEFAULT_P2P_RELAY;
  const relays = parseRelayUrls(trimmed);
  return relays.length > 0 ? relays.join(', ') : DEFAULT_P2P_RELAY;
}

/** Relay URLs to pass to the transport; empty means "use Trystero defaults". */
export function p2pRelayUrls(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  if (/^(automatique|automatic)/i.test(value.trim())) return [];
  return parseRelayUrls(value);
}

export const DEFAULT_SETTINGS: GameSettings = {
  quality: 'medium',
  engine: 'mock',
  language: 'fr',
  masterVolume: 70,
  effectsVolume: 80,
  musicVolume: 40,
  p2pRelay: DEFAULT_P2P_RELAY,
  dayNightCycle: true,
  dayNightCycleSeconds: DEFAULT_DAY_NIGHT_CYCLE_SECONDS,
  cinematicIntro: true,
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

/**
 * Normalise le moteur persistant (#78). Toute valeur inconnue retombe sur le
 * mock : un ancien réglage sans champ `engine` (ou un `engineMode` d'une version
 * antérieure) reste donc jouable sans migration destructive de la clé v1.
 */
export function sanitizeEngineMode(value: unknown): EngineMode {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.engine;
  const normalized = value.trim().toLowerCase();
  return normalized === 'wasm' ? 'wasm' : 'mock';
}

/** Normalise un objet inconnu en réglages valides. */
export function sanitizeSettings(raw: unknown): GameSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    quality: isQuality(record.quality) ? record.quality : DEFAULT_SETTINGS.quality,
    engine: sanitizeEngineMode(record.engine ?? record.engineMode),
    language: isLanguage(record.language) ? record.language : DEFAULT_SETTINGS.language,
    masterVolume: clampVolume(record.masterVolume, DEFAULT_SETTINGS.masterVolume),
    effectsVolume: clampVolume(record.effectsVolume, DEFAULT_SETTINGS.effectsVolume),
    musicVolume: clampVolume(record.musicVolume, DEFAULT_SETTINGS.musicVolume),
    p2pRelay: sanitizeP2pRelay(record.p2pRelay),
    dayNightCycle:
      typeof record.dayNightCycle === 'boolean'
        ? record.dayNightCycle
        : DEFAULT_SETTINGS.dayNightCycle,
    dayNightCycleSeconds: sanitizeCycleSeconds(record.dayNightCycleSeconds),
    cinematicIntro:
      typeof record.cinematicIntro === 'boolean'
        ? record.cinematicIntro
        : DEFAULT_SETTINGS.cinematicIntro,
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
