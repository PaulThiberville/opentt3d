import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  updateSettings,
  type StorageLike,
} from '../src/ui/settings';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota');
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('réglages persistants', () => {
  it('charge les valeurs par défaut sans stockage', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('enregistre puis recharge les réglages', () => {
    const storage = new MemoryStorage();
    const settings = {
      ...DEFAULT_SETTINGS,
      quality: 'high' as const,
      masterVolume: 25,
      musicVolume: 5,
    };
    expect(saveSettings(storage, settings)).toBe(true);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('retombe sur les défauts si le JSON est corrompu', () => {
    const storage = new MemoryStorage();
    storage.data.set(SETTINGS_STORAGE_KEY, '{oops');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('normalise les champs partiels ou invalides', () => {
    const sanitized = sanitizeSettings({
      quality: 'ultra',
      language: 'de',
      masterVolume: 140,
      effectsVolume: -20,
      musicVolume: 'x',
      p2pRelay: 'autre',
    });
    expect(sanitized.quality).toBe('medium');
    expect(sanitized.language).toBe('fr');
    expect(sanitized.masterVolume).toBe(100);
    expect(sanitized.effectsVolume).toBe(0);
    expect(sanitized.musicVolume).toBe(DEFAULT_SETTINGS.musicVolume);
    expect(sanitized.p2pRelay).toBe(DEFAULT_SETTINGS.p2pRelay);
    expect(sanitized.dayNightCycle).toBe(DEFAULT_SETTINGS.dayNightCycle);
    expect(sanitized.dayNightCycleSeconds).toBe(DEFAULT_SETTINGS.dayNightCycleSeconds);
  });

  it('normalise le cycle jour/nuit', () => {
    expect(sanitizeSettings({ dayNightCycle: false }).dayNightCycle).toBe(false);
    expect(sanitizeSettings({ dayNightCycle: 'non' }).dayNightCycle).toBe(true);
    expect(sanitizeSettings({ dayNightCycleSeconds: 1 }).dayNightCycleSeconds).toBe(30);
    expect(sanitizeSettings({ dayNightCycleSeconds: 5_000 }).dayNightCycleSeconds).toBe(900);
    expect(sanitizeSettings({ dayNightCycleSeconds: 240 }).dayNightCycleSeconds).toBe(240);
  });

  it('accepte une langue déjà connue', () => {
    expect(sanitizeSettings({ language: 'en' }).language).toBe('en');
  });

  it('ne mute pas l’objet source lors d’une mise à jour', () => {
    const source = { ...DEFAULT_SETTINGS };
    const updated = updateSettings(source, { musicVolume: 10, quality: 'low' });
    expect(source.musicVolume).toBe(DEFAULT_SETTINGS.musicVolume);
    expect(updated.musicVolume).toBe(10);
    expect(updated.quality).toBe('low');
  });

  it('signale un échec d’écriture sans lever', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(saveSettings(storage, DEFAULT_SETTINGS)).toBe(false);
  });
});
