import { describe, expect, it, vi } from 'vitest';
import { PostFX, type PostFxPipeline } from '../src/render/PostFX';
import {
  POSTFX_PRESETS,
  postFxPasses,
  postFxSettings,
  postFxVisuals,
  resolvePostFxAntialias,
} from '../src/render/postFxConfig';

const fakeContext = {
  renderer: {} as never,
  scene: {} as never,
  camera: {} as never,
};

function makePipeline(overrides: Partial<PostFxPipeline> = {}) {
  const pipeline = {
    passes: ['render', 'bloom', 'output', 'grade', 'smaa'],
    warnings: [],
    render: vi.fn(),
    setSize: vi.fn(),
    setNight: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
  return pipeline as PostFxPipeline & {
    render: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    setNight: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

describe('presets de post-processing', () => {
  it('coupe complètement le composer en basse qualité', () => {
    const low = postFxSettings('low');
    expect(low.enabled).toBe(false);
    expect(postFxPasses(low)).toEqual([]);
    expect(low.estimatedCostMs).toBe(0);
  });

  it('active bloom, FXAA et grading en moyenne qualité, sans AO', () => {
    const medium = postFxSettings('medium');
    expect(medium.enabled).toBe(true);
    expect(medium.bloom).toBe(true);
    expect(medium.ambientOcclusion).toBe(false);
    expect(medium.antialias).toBe('fxaa');
    expect(medium.grade).toBe(true);
    expect(medium.tiltShiftAmount).toBe(0);
    expect(postFxPasses(medium)).toEqual(['render', 'bloom', 'output', 'grade', 'fxaa']);
  });

  it('ajoute GTAO, SMAA et tilt-shift en haute qualité', () => {
    const high = postFxSettings('high');
    expect(high.bloom).toBe(true);
    expect(high.ambientOcclusion).toBe(true);
    expect(high.antialias).toBe('smaa');
    expect(high.grade).toBe(true);
    expect(high.tiltShiftAmount).toBeGreaterThan(0);
    expect(postFxPasses(high)).toEqual(['render', 'gtao', 'bloom', 'output', 'grade', 'smaa']);
  });

  it('garde des budgets croissants et bornés', () => {
    expect(POSTFX_PRESETS.low.estimatedCostMs).toBeLessThan(POSTFX_PRESETS.medium.estimatedCostMs);
    expect(POSTFX_PRESETS.medium.estimatedCostMs).toBeLessThan(POSTFX_PRESETS.high.estimatedCostMs);
    expect(POSTFX_PRESETS.high.estimatedCostMs).toBeLessThanOrEqual(8);
    for (const preset of Object.values(POSTFX_PRESETS)) {
      expect(preset.bloomResolutionScale).toBeGreaterThan(0);
      expect(preset.bloomResolutionScale).toBeLessThanOrEqual(1);
      expect(preset.aoResolutionScale).toBeGreaterThan(0);
      expect(preset.aoResolutionScale).toBeLessThanOrEqual(1);
      expect(preset.grain).toBeGreaterThanOrEqual(0);
      expect(preset.vignette).toBeGreaterThanOrEqual(0);
      expect(preset.vignette).toBeLessThanOrEqual(1);
    }
  });

  it('retombe sur le preset medium pour un niveau inconnu', () => {
    // @ts-expect-error niveau volontairement invalide
    expect(postFxSettings('ultra').level).toBe('medium');
  });

  it('adapte l’antialiasing au DPR effectif', () => {
    expect(resolvePostFxAntialias(postFxSettings('high'), 1)).toBe('smaa');
    expect(resolvePostFxAntialias(postFxSettings('high'), 1.49)).toBe('smaa');
    expect(resolvePostFxAntialias(postFxSettings('high'), 1.5)).toBe('fxaa');
    expect(resolvePostFxAntialias(postFxSettings('high'), 2)).toBe('fxaa');
    expect(resolvePostFxAntialias(postFxSettings('medium'), 1)).toBe('fxaa');
    expect(resolvePostFxAntialias(postFxSettings('low'), 2)).toBe('none');
    expect(resolvePostFxAntialias(postFxSettings('high'), Number.NaN)).toBe('smaa');
  });
});

describe('adaptation au cycle jour/nuit', () => {
  it('renforce le bloom et refroidit le grading la nuit', () => {
    const settings = postFxSettings('high');
    const day = postFxVisuals(settings, 0);
    const night = postFxVisuals(settings, 1);
    expect(night.bloomStrength).toBeGreaterThan(day.bloomStrength);
    expect(night.bloomThreshold).toBeLessThan(day.bloomThreshold);
    expect(night.warmth).toBeLessThan(0);
    expect(day.warmth).toBeGreaterThan(0);
    expect(night.vignette).toBeGreaterThan(day.vignette);
    expect(night.saturation).toBeLessThan(day.saturation);
  });

  it('borne le facteur nuit et produit des valeurs finies', () => {
    const settings = postFxSettings('medium');
    const below = postFxVisuals(settings, -4);
    const above = postFxVisuals(settings, 9);
    expect(below.bloomStrength).toBe(postFxVisuals(settings, 0).bloomStrength);
    expect(above.warmth).toBe(postFxVisuals(settings, 1).warmth);
    for (const value of Object.values(above)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(above.grain).toBeLessThanOrEqual(1);
    expect(above.vignette).toBeLessThanOrEqual(1);
  });
});

describe('façade PostFX et repli', () => {
  it('ne construit aucun pipeline quand le preset est coupé', () => {
    const factory = vi.fn();
    const postfx = new PostFX({
      ...fakeContext,
      settings: postFxSettings('low'),
      pipelineFactory: factory,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(postfx.active).toBe(false);
    expect(postfx.render(0.016)).toBe(false);
    expect(postfx.status.passes).toEqual([]);
  });

  it('transmet les appels au pipeline actif', () => {
    const pipeline = makePipeline();
    const postfx = new PostFX({
      ...fakeContext,
      settings: postFxSettings('medium'),
      pipelineFactory: () => pipeline,
    });
    expect(postfx.active).toBe(true);
    expect(postfx.render(0.016)).toBe(true);
    postfx.setSize(1280, 720, 1.5);
    postfx.setNight(0.8);
    expect(pipeline.render).toHaveBeenCalledWith(0.016);
    expect(pipeline.setSize).toHaveBeenCalledWith(1280, 720, 1.5);
    expect(pipeline.setNight).toHaveBeenCalledWith(0.8);
    expect(postfx.status.passes).toEqual(pipeline.passes);
    postfx.dispose();
    expect(pipeline.dispose).toHaveBeenCalledTimes(1);
  });

  it('se replie si le composer ne peut pas être créé', () => {
    const postfx = new PostFX({
      ...fakeContext,
      settings: postFxSettings('high'),
      pipelineFactory: () => {
        throw new Error('contexte WebGL limité');
      },
    });
    expect(postfx.active).toBe(false);
    expect(postfx.status.fallbackReason).toContain('contexte WebGL limité');
    expect(postfx.render(0.016)).toBe(false);
  });

  it('se replie proprement si une passe échoue en cours de route', () => {
    const pipeline = makePipeline({
      render: vi.fn(() => {
        throw new Error('context lost');
      }),
    });
    const postfx = new PostFX({
      ...fakeContext,
      settings: postFxSettings('medium'),
      pipelineFactory: () => pipeline,
    });
    expect(postfx.render(0.016)).toBe(false);
    expect(postfx.active).toBe(false);
    expect(postfx.render(0.016)).toBe(false);
    expect(pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(postfx.status.fallbackReason).toContain('context lost');
  });

  it('permet un toggle de debug sans reconstruire le composer', () => {
    const pipeline = makePipeline();
    const factory = vi.fn(() => pipeline);
    const postfx = new PostFX({
      ...fakeContext,
      settings: postFxSettings('medium'),
      pipelineFactory: factory,
    });
    expect(postfx.toggle()).toBe(false);
    expect(postfx.render(0.016)).toBe(false);
    expect(postfx.toggle()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    postfx.dispose();
    expect(postfx.active).toBe(false);
  });

  it('coupe une passe précise pour le debug', () => {
    const setPassEnabled = vi.fn(() => true);
    const pipeline = makePipeline({ setPassEnabled });
    const postfx = new PostFX({
      ...fakeContext,
      settings: postFxSettings('high'),
      pipelineFactory: () => pipeline,
    });
    expect(postfx.setPassEnabled('gtao', false)).toBe(true);
    expect(setPassEnabled).toHaveBeenCalledWith('gtao', false);
    postfx.setEnabled(false);
    expect(postfx.setPassEnabled('gtao', true)).toBe(false);
  });
});
