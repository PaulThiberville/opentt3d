import { describe, expect, it } from 'vitest';
import { percentOf, seriesGeometry } from '../src/ui/charts';

describe('géométrie des graphiques', () => {
  it('retourne null pour une série vide ou invalide', () => {
    expect(seriesGeometry([])).toBeNull();
    expect(seriesGeometry([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('projette les valeurs dans la boîte avec une marge', () => {
    const geometry = seriesGeometry([0, 50, 100], 100, 50, 5);
    expect(geometry).not.toBeNull();
    expect(geometry?.points).toHaveLength(3);
    expect(geometry?.points[0]?.x).toBe(5);
    expect(geometry?.points[2]?.x).toBe(95);
    expect(geometry?.points[0]?.y).toBe(45);
    expect(geometry?.points[2]?.y).toBe(5);
    expect(geometry?.min).toBe(0);
    expect(geometry?.max).toBe(100);
    expect(geometry?.path.startsWith('M')).toBe(true);
    expect(geometry?.area.endsWith('Z')).toBe(true);
  });

  it('centre une valeur constante au lieu de diviser par zéro', () => {
    const geometry = seriesGeometry([42], 100, 40, 0);
    expect(geometry?.points[0]?.x).toBe(50);
    expect(geometry?.points[0]?.y).toBe(20);
    expect(Number.isFinite(geometry?.points[0]?.y ?? Number.NaN)).toBe(true);
  });

  it('borne les pourcentages des barres', () => {
    expect(percentOf(50, 100)).toBe(50);
    expect(percentOf(-3, 100)).toBe(0);
    expect(percentOf(150, 100)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(Number.NaN, 100)).toBe(0);
  });
});
