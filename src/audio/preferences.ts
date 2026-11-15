/**
 * Préférences audio locales (mute), persistées séparément des volumes.
 *
 * Les volumes master/effets/musique vivent déjà dans `opentt3d.settings.v1`
 * (`src/ui/settings.ts`). Le mute est un état runtime propre à l'audio, gardé
 * ici pour ne pas coupler le moteur au module de réglages UI et résister aux
 * autres agents qui modifient l'écran de préférences.
 */

export const AUDIO_PREFERENCES_KEY = 'opentt3d.audio.v1';

export interface AudioPreferences {
  muted: boolean;
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  muted: false,
};

export interface AudioStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function sanitizeAudioPreferences(raw: unknown): AudioPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUDIO_PREFERENCES };
  const record = raw as Record<string, unknown>;
  return { muted: record.muted === true };
}

export function loadAudioPreferences(
  storage: AudioStorageLike | null | undefined,
): AudioPreferences {
  if (!storage) return { ...DEFAULT_AUDIO_PREFERENCES };
  try {
    const text = storage.getItem(AUDIO_PREFERENCES_KEY);
    if (!text) return { ...DEFAULT_AUDIO_PREFERENCES };
    return sanitizeAudioPreferences(JSON.parse(text) as unknown);
  } catch {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
}

export function saveAudioPreferences(
  storage: AudioStorageLike | null | undefined,
  preferences: AudioPreferences,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(AUDIO_PREFERENCES_KEY, JSON.stringify(sanitizeAudioPreferences(preferences)));
    return true;
  } catch {
    return false;
  }
}
