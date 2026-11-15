import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOGS,
  LANGUAGE_STORAGE_KEY,
  TRANSLATION_KEYS,
  normalizeLanguage,
  onLanguageChange,
  plural,
  qualityLabel,
  readStoredLanguage,
  resetI18n,
  setLanguage,
  t,
  tn,
  translate,
} from '../src/ui/i18n';
import {
  formatGameDate,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatVehicleSpeed,
} from '../src/ui/format';
import { SETTINGS_STORAGE_KEY, type StorageLike } from '../src/ui/settings';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function normalized(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

afterEach(() => {
  resetI18n();
});

describe('catalogues i18n', () => {
  it('expose exactement les mêmes clés en français et en anglais', () => {
    const fr = Object.keys(CATALOGS.fr).sort();
    const en = Object.keys(CATALOGS.en).sort();
    expect(en).toEqual(fr);
    expect(fr).toEqual([...TRANSLATION_KEYS].sort());
  });

  it('ne contient aucune traduction vide', () => {
    for (const key of TRANSLATION_KEYS) {
      expect(CATALOGS.fr[key]?.trim(), `FR ${key}`).not.toBe('');
      expect(CATALOGS.en[key]?.trim(), `EN ${key}`).not.toBe('');
    }
  });

  it('conserve les mêmes variables d’interpolation dans les deux langues', () => {
    for (const key of TRANSLATION_KEYS) {
      expect(placeholders(CATALOGS.en[key]), `placeholders EN ${key}`).toEqual(
        placeholders(CATALOGS.fr[key]),
      );
    }
  });

  it('interpole les variables et retombe sur le français', () => {
    expect(translate('fr', 'build.decrease', { label: 'Quais' })).toBe('Quais : diminuer');
    expect(translate('en', 'build.decrease', { label: 'Platforms' })).toBe('Platforms: decrease');
    expect(translate('fr', 'build.decrease')).toBe('{label} : diminuer');
    expect(translate('en', 'clé.inconnue' as never)).toBe('clé.inconnue');
  });

  it('gère le singulier et le pluriel', () => {
    expect(plural('fr', 1, 'topbar.unread.one', 'topbar.unread.other')).toBe('1 actualité non lue');
    expect(plural('fr', 3, 'topbar.unread.one', 'topbar.unread.other')).toBe(
      '3 actualités non lues',
    );
    expect(plural('en', 1, 'topbar.unread.one', 'topbar.unread.other')).toBe('1 unread news item');
    expect(plural('en', 0, 'topbar.unread.one', 'topbar.unread.other')).toBe('0 unread news items');
  });

  it('localise les presets de qualité', () => {
    setLanguage('fr', { storage: null });
    expect(qualityLabel('medium')).toBe('Moyenne');
    setLanguage('en', { storage: null });
    expect(qualityLabel('medium')).toBe('Medium');
  });

  it('localise les formats monétaires, dates et vitesses', () => {
    setLanguage('en', { storage: null });
    expect(formatMoney(2_400_000)).toBe('£2,400,000');
    expect(formatSignedMoney(-3_200)).toBe('−£3,200');
    expect(formatGameDate({ year: 1950, month: 0, day: 1 })).toBe('1 January 1950');
    expect(formatPercent(42.4, 1)).toBe('42.4%');
    expect(formatVehicleSpeed(24)).toBe('24 tiles/day');

    setLanguage('fr', { storage: null });
    expect(normalized(formatMoney(2_400_000))).toBe('2 400 000 £');
    expect(formatGameDate({ year: 1950, month: 0, day: 1 })).toBe('1 janvier 1950');
    expect(formatVehicleSpeed(24)).toBe('24 tuiles/j');
  });
});

describe('langue courante et persistance', () => {
  it('persiste la langue choisie', () => {
    const storage = new MemoryStorage();
    resetI18n();
    expect(setLanguage('en', { storage })).toBe('en');
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(readStoredLanguage(storage)).toBe('en');
  });

  it('lit la langue depuis les réglages historiques', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ language: 'en' }));
    expect(readStoredLanguage(storage)).toBe('en');
  });

  it('ignore une langue inconnue ou un stockage corrompu', () => {
    const storage = new MemoryStorage();
    storage.setItem(LANGUAGE_STORAGE_KEY, 'de');
    storage.setItem(SETTINGS_STORAGE_KEY, '{pas du json');
    expect(readStoredLanguage(storage)).toBe('fr');
    expect(normalizeLanguage('de')).toBe('fr');
    expect(normalizeLanguage(undefined)).toBe('fr');
    expect(normalizeLanguage('en')).toBe('en');
  });

  it('traduit dans la langue active', () => {
    resetI18n();
    setLanguage('en', { storage: null });
    expect(t('common.cancel')).toBe('Cancel');
    expect(tn(1, 'topbar.unread.one', 'topbar.unread.other')).toBe('1 unread news item');
    setLanguage('fr', { storage: null });
    expect(t('common.cancel')).toBe('Annuler');
  });

  it('notifie les abonnés et se désabonne proprement', () => {
    const seen: string[] = [];
    resetI18n();
    const unsubscribe = onLanguageChange((language) => seen.push(language));
    setLanguage('en', { storage: null });
    setLanguage('fr', { storage: null });
    unsubscribe();
    setLanguage('en', { storage: null });
    expect(seen).toEqual(['en', 'fr']);
  });
});
