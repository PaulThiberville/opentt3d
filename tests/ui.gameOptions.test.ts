import { describe, expect, it } from 'vitest';
import {
  MAP_SIZES,
  createDefaultNewGameOptions,
  mergeNewGameOptions,
  parseSeed,
  randomSeed,
  validateNewGameOptions,
} from '../src/ui/gameOptions';

describe('graine', () => {
  it('accepte les entiers, l’hexadécimal et les chaînes', () => {
    expect(parseSeed(42)).toBe(42);
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed(' 0x10 ')).toBe(16);
    expect(parseSeed('1e3')).toBe(1000);
  });

  it('convertit en uint32 et rejette les entrées invalides', () => {
    expect(parseSeed(0x1_0000_0001)).toBe(1);
    expect(parseSeed(-1)).toBe(4_294_967_295);
    expect(parseSeed('abc')).toBeNull();
    expect(parseSeed('')).toBeNull();
    expect(parseSeed(Number.NaN)).toBeNull();
  });

  it('tire une graine déterministe avec un aléa injecté', () => {
    expect(randomSeed(() => 0.5)).toBe(2_147_483_648);
    expect(randomSeed(() => 0)).toBe(0);
  });
});

describe('validation des options de partie', () => {
  const defaults = createDefaultNewGameOptions('high');

  it('fournit des valeurs par défaut valides', () => {
    expect(defaults.size).toBe(256);
    expect(defaults.quality).toBe('high');
    expect(defaults.difficulty).toBe(1);
    expect(defaults.disasters).toBe(false);
    expect(validateNewGameOptions({}, defaults).ok).toBe(true);
  });

  it('normalise un formulaire complet', () => {
    const result = validateNewGameOptions(
      {
        seed: '0x2a',
        size: '128',
        quality: 'low',
        difficulty: '3',
        aiCompanies: '0',
        climate: 'subarctic',
        startYear: '2000',
        disasters: 'oui',
      },
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      seed: 42,
      size: 128,
      quality: 'low',
      difficulty: 3,
      aiCompanies: 0,
      climate: 'subarctic',
      startYear: 2000,
      disasters: true,
    });
  });

  it('rejette une taille hors de la liste', () => {
    const result = validateNewGameOptions({ size: '200' }, defaults);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toContain('size');
  });

  it('n’expose que des puissances de 2 exigées par le pont WASM', () => {
    expect(MAP_SIZES).toEqual([128, 256, 512]);
    for (const size of [64, 192, 384, 1024]) {
      const result = validateNewGameOptions({ size: `${size}` }, defaults);
      expect(result.ok).toBe(false);
    }
  });

  it('rejette difficulté, IA, climat et année invalides', () => {
    const result = validateNewGameOptions(
      { difficulty: '5', aiCompanies: '9', climate: 'lunaire', startYear: '1800' },
      defaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.errors.map((error) => error.field);
    expect(fields).toEqual(
      expect.arrayContaining(['difficulty', 'aiCompanies', 'climate', 'startYear']),
    );
  });

  it('rejette une graine non numérique', () => {
    const result = validateNewGameOptions({ seed: 'pas-une-graine' }, defaults);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.field).toBe('seed');
  });

  it('rejette une valeur de désastres non booléenne', () => {
    const result = validateNewGameOptions({ disasters: 'peut-être' }, defaults);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toContain('disasters');
  });

  it('expose toutes les tailles attendues', () => {
    expect(MAP_SIZES).toEqual([128, 256, 512]);
  });
});

describe('fusion tolérante', () => {
  const base = createDefaultNewGameOptions();

  it('applique un patch valide', () => {
    const merged = mergeNewGameOptions(base, { size: '512', quality: 'high', seed: '7' });
    expect(merged.size).toBe(512);
    expect(merged.quality).toBe('high');
    expect(merged.seed).toBe(7);
  });

  it('conserve la base pour une ancienne taille (384)', () => {
    expect(mergeNewGameOptions(base, { size: '384' })).toBe(base);
  });

  it('conserve la base si le patch est invalide', () => {
    expect(mergeNewGameOptions(base, { size: '999' })).toBe(base);
  });
});
