import { describe, expect, it } from 'vitest';
import {
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  detectQuality,
  nextQuality,
  qualitySettings,
  resolvePixelRatio,
  resolveRenderSize,
} from '../src/render/quality';

describe('presets de qualité', () => {
  it('définit les trois niveaux attendus', () => {
    expect(QUALITY_LEVELS).toEqual(['low', 'medium', 'high']);
    for (const level of QUALITY_LEVELS) {
      expect(QUALITY_PRESETS[level].level).toBe(level);
      expect(QUALITY_PRESETS[level].drawDistance).toBeGreaterThan(100);
      expect(QUALITY_PRESETS[level].maxTrees).toBeGreaterThan(0);
    }
  });

  it('ordonne les budgets du plus léger au plus lourd', () => {
    const low = QUALITY_PRESETS.low;
    const medium = QUALITY_PRESETS.medium;
    const high = QUALITY_PRESETS.high;
    expect(low.pixelRatioCap).toBeLessThan(medium.pixelRatioCap);
    expect(medium.pixelRatioCap).toBeLessThan(high.pixelRatioCap);
    expect(low.maxTrees).toBeLessThan(medium.maxTrees);
    expect(medium.maxTrees).toBeLessThan(high.maxTrees);
    expect(low.shadows).toBe(false);
    expect(high.shadows).toBe(true);
    expect(low.antialias).toBe(false);
  });

  it('renvoie un preset de repli valide', () => {
    expect(qualitySettings('medium').label).toBe('Moyenne');
    // @ts-expect-error valeur volontairement invalide
    expect(qualitySettings('ultra').level).toBe('medium');
  });
});

describe('résolution de rendu', () => {
  it('plafonne le DPR selon le preset', () => {
    expect(resolvePixelRatio('low', 3)).toBe(1);
    expect(resolvePixelRatio('medium', 3)).toBe(1.5);
    expect(resolvePixelRatio('high', 3)).toBe(2);
    expect(resolvePixelRatio('high', 1)).toBe(1);
  });

  it('ignore un DPR invalide', () => {
    expect(resolvePixelRatio('high', 0)).toBe(1);
    expect(resolvePixelRatio('high', Number.NaN)).toBe(1);
  });

  it('calcule la taille du buffer', () => {
    const size = resolveRenderSize(800, 600, 'medium', 2);
    expect(size.width).toBe(800);
    expect(size.height).toBe(600);
    expect(size.pixelRatio).toBe(1.5);
    expect(size.bufferWidth).toBe(1200);
    expect(size.bufferHeight).toBe(900);
  });

  it('garantit au moins 1 pixel', () => {
    const size = resolveRenderSize(0, -4, 'low', 1);
    expect(size.width).toBe(1);
    expect(size.height).toBe(1);
  });
});

describe('cycle et détection', () => {
  it('cycle low → medium → high → low', () => {
    expect(nextQuality('low')).toBe('medium');
    expect(nextQuality('medium')).toBe('high');
    expect(nextQuality('high')).toBe('low');
  });

  it('détecte un preset raisonnable', () => {
    expect(detectQuality(1, 1)).toBe('low');
    expect(detectQuality(2, 12)).toBe('high');
    expect(detectQuality(1, 8)).toBe('medium');
  });
});
