import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, qualitySettings, resolveShadowFrustum } from '../src/render/quality';

describe('paramètres d’ombre par preset', () => {
  it('réserve les ombres à la haute qualité', () => {
    expect(QUALITY_PRESETS.low.shadows).toBe(false);
    expect(QUALITY_PRESETS.medium.shadows).toBe(false);
    expect(QUALITY_PRESETS.high.shadows).toBe(true);
  });

  it('augmente la résolution de la shadow map avec la qualité', () => {
    expect(QUALITY_PRESETS.low.shadowMapSize).toBe(512);
    expect(QUALITY_PRESETS.medium.shadowMapSize).toBe(1024);
    expect(QUALITY_PRESETS.high.shadowMapSize).toBe(2048);
    expect(QUALITY_PRESETS.low.shadowMapSize).toBeLessThan(QUALITY_PRESETS.medium.shadowMapSize);
    expect(QUALITY_PRESETS.medium.shadowMapSize).toBeLessThan(QUALITY_PRESETS.high.shadowMapSize);
  });

  it('expose un biais négatif, un normalBias positif et un rayon doux', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const settings = qualitySettings(level);
      expect(settings.shadowBias).toBeLessThan(0);
      expect(settings.shadowNormalBias).toBeGreaterThan(0);
      expect(settings.shadowRadius).toBeGreaterThan(0);
      expect(settings.shadowFrustum).toBeGreaterThan(0);
      expect(Number.isFinite(settings.shadowBias)).toBe(true);
      expect(Number.isFinite(settings.shadowNormalBias)).toBe(true);
      expect(Number.isFinite(settings.shadowRadius)).toBe(true);
    }
    expect(QUALITY_PRESETS.low.shadowRadius).toBeLessThan(QUALITY_PRESETS.high.shadowRadius);
    expect(QUALITY_PRESETS.low.shadowFrustum).toBeLessThan(QUALITY_PRESETS.high.shadowFrustum);
  });
});

describe('frustum d’ombre ajusté', () => {
  it('s’élargit avec la distance de caméra, sans dépasser le plafond', () => {
    const base = 100;
    expect(resolveShadowFrustum(base, 0)).toBe(base);
    expect(resolveShadowFrustum(base, 40)).toBeGreaterThan(base);
    expect(resolveShadowFrustum(base, 40)).toBeLessThan(resolveShadowFrustum(base, 120));
    expect(resolveShadowFrustum(base, 10_000)).toBeCloseTo(base * 1.65, 6);
  });

  it('tolère des entrées invalides', () => {
    expect(resolveShadowFrustum(80, Number.NaN)).toBe(80);
    expect(resolveShadowFrustum(0, 0)).toBe(80);
    expect(resolveShadowFrustum(0, Number.NaN)).toBe(80);
    expect(resolveShadowFrustum(Number.NaN, 0)).toBe(80);
    expect(resolveShadowFrustum(80, -20)).toBe(80);
  });
});
