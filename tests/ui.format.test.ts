import { describe, expect, it } from 'vitest';
import {
  formatDecimal,
  formatGameDate,
  formatInt,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatRating,
  formatShortGameDate,
  formatSignedMoney,
  formatVehicleSpeed,
} from '../src/ui/format';

function normalized(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

describe('formatage monétaire', () => {
  it('formate les montants en livres avec séparateurs français', () => {
    expect(normalized(formatMoney(2_400_000))).toBe('2 400 000 £');
    expect(normalized(formatMoney(-1500))).toBe('−1 500 £');
    expect(normalized(formatMoney(0))).toBe('0 £');
  });

  it('affiche un signe explicite pour les flux', () => {
    expect(normalized(formatSignedMoney(12_400))).toBe('+12 400 £');
    expect(normalized(formatSignedMoney(-3200))).toBe('−3 200 £');
    expect(normalized(formatSignedMoney(0))).toBe('0 £');
  });

  it('compacte les gros montants', () => {
    expect(formatMoneyCompact(1_500_000)).toBe('1,5 M£');
    expect(normalized(formatMoneyCompact(42_000))).toBe('42 k£');
    expect(normalized(formatMoneyCompact(950))).toBe('950 £');
  });

  it('refuse les valeurs non finies', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatSignedMoney(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatInt(Number.NaN)).toBe('—');
  });
});

describe('formatage des valeurs de jeu', () => {
  it('formate une date de jeu en français', () => {
    expect(formatGameDate({ year: 1950, month: 0, day: 1 })).toBe('1 janvier 1950');
    expect(formatGameDate({ year: 1950, month: 12, day: 1 })).toBe('—');
    expect(formatGameDate(null)).toBe('—');
  });

  it('formate une date courte pour les news', () => {
    expect(formatShortGameDate({ year: 1950, month: 7, day: 14 })).toBe('14 août 1950');
  });

  it('formate vitesses, notes et pourcentages', () => {
    expect(formatVehicleSpeed(24)).toBe('24 tuiles/j');
    expect(formatRating(72)).toBe('72 / 100');
    expect(formatPercent(42.4)).toBe('42 %');
    expect(formatPercent(42.4, 1)).toBe('42,4 %');
  });

  it('formate les entiers et décimales', () => {
    expect(normalized(formatInt(12345))).toBe('12 345');
    expect(formatDecimal(3.25)).toBe('3,3');
  });
});
