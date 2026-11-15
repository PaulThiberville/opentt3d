/**
 * Réglages du post-processing, sans dépendance Three.js/DOM.
 *
 * Ce module est volontairement pur : `PostFX` ne fait que traduire ces valeurs
 * en passes, et les tests vérifient les budgets, les presets et l'adaptation au
 * cycle jour/nuit sous Node.
 */

import type { QualityLevel } from './quality';

export type PostFxAntialias = 'none' | 'fxaa' | 'smaa';

/** Paramètres visuels modulés entre le jour et la nuit. */
export interface PostFxVisuals {
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** Vignettage 0..1 (assombrit les coins). */
  vignette: number;
  /** Grain 0..1, appliqué en espace écran. */
  grain: number;
  saturation: number;
  contrast: number;
  /** Positif = chaud (jour), négatif = froid (nuit). */
  warmth: number;
  /** Split toning : ombres froides, hautes lumières chaudes. */
  splitTone: number;
  /** Flou de maquette (0 = coupé). */
  tiltShiftAmount: number;
  /** Ligne de netteté en UV (0 = haut, 1 = bas). */
  tiltFocus: number;
  /** Épaisseur de la bande nette en UV. */
  tiltBand: number;
}

export interface PostFxSettings extends PostFxVisuals {
  level: QualityLevel;
  enabled: boolean;
  bloom: boolean;
  /** Échelle de résolution du bloom (0,5 = demi-résolution). */
  bloomResolutionScale: number;
  ambientOcclusion: boolean;
  /** Échelle de résolution du GTAO. */
  aoResolutionScale: number;
  aoRadius: number;
  aoIntensity: number;
  aoSamples: number;
  antialias: PostFxAntialias;
  /** Color grading + vignette + grain + tilt-shift. */
  grade: boolean;
  /** Coût indicatif des passes sur un GPU intégré récent (millisecondes). */
  estimatedCostMs: number;
}

/**
 * Budgets :
 * - low : aucun composer, rendu direct (0 ms).
 * - medium : bloom demi-résolution + FXAA + grading (≈ 2 ms).
 * - high : bloom + GTAO 40 % + SMAA/FXAA + tilt-shift (≈ 7 ms).
 *
 * Le GTAO re-rend la scène en normales : c'est la passe la plus chère, elle
 * reste réservée à `high` et tourne à 40 % de la résolution. Le bloom est
 * toujours en demi-résolution pour conserver une marge sur les GPU intégrés.
 */
export const POSTFX_PRESETS: Record<QualityLevel, PostFxSettings> = {
  low: {
    level: 'low',
    enabled: false,
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0.5,
    bloomThreshold: 1,
    bloomResolutionScale: 0.5,
    ambientOcclusion: false,
    aoResolutionScale: 0.5,
    aoRadius: 0.5,
    aoIntensity: 0,
    aoSamples: 8,
    antialias: 'none',
    grade: false,
    saturation: 1,
    contrast: 1,
    warmth: 0,
    splitTone: 0,
    vignette: 0,
    grain: 0,
    tiltShiftAmount: 0,
    tiltFocus: 0.56,
    tiltBand: 0.18,
    estimatedCostMs: 0,
  },
  medium: {
    level: 'medium',
    enabled: true,
    bloom: true,
    bloomStrength: 0.14,
    bloomRadius: 0.5,
    bloomThreshold: 0.92,
    bloomResolutionScale: 0.5,
    ambientOcclusion: false,
    aoResolutionScale: 0.5,
    aoRadius: 0.5,
    aoIntensity: 0,
    aoSamples: 8,
    antialias: 'fxaa',
    grade: true,
    saturation: 1.08,
    contrast: 1.05,
    warmth: 0.16,
    splitTone: 0.4,
    vignette: 0.24,
    grain: 0.012,
    tiltShiftAmount: 0,
    tiltFocus: 0.56,
    tiltBand: 0.18,
    estimatedCostMs: 2.2,
  },
  high: {
    level: 'high',
    enabled: true,
    bloom: true,
    bloomStrength: 0.2,
    bloomRadius: 0.58,
    bloomThreshold: 0.88,
    bloomResolutionScale: 0.5,
    ambientOcclusion: true,
    aoResolutionScale: 0.4,
    aoRadius: 0.35,
    aoIntensity: 0.6,
    aoSamples: 8,
    antialias: 'smaa',
    grade: true,
    saturation: 1.1,
    contrast: 1.07,
    warmth: 0.18,
    splitTone: 0.55,
    vignette: 0.3,
    grain: 0.016,
    tiltShiftAmount: 0.26,
    tiltFocus: 0.56,
    tiltBand: 0.18,
    estimatedCostMs: 7,
  },
};

export function postFxSettings(level: QualityLevel): PostFxSettings {
  return POSTFX_PRESETS[level] ?? POSTFX_PRESETS.medium;
}

/**
 * AA réellement utilisé selon le DPR effectif. À partir de 1,5×, SMAA coûte
 * plusieurs millisecondes pour un gain invisible sur un buffer déjà
 * suréchantillonné : FXAA suffit et préserve la marge de la qualité haute.
 */
export function resolvePostFxAntialias(
  settings: PostFxSettings,
  pixelRatio: number,
): PostFxAntialias {
  if (settings.antialias === 'none') return 'none';
  if (settings.antialias === 'smaa' && Number.isFinite(pixelRatio) && pixelRatio >= 1.5) {
    return 'fxaa';
  }
  return settings.antialias;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Paramètres visuels interpolés entre jour (0) et nuit profonde (1).
 *
 * La nuit renforce le bloom (fenêtres et phares), abaisse le seuil pour capter
 * les émissions, refroidit le grading et accentue légèrement le vignettage.
 * Aucune valeur ne dépend de la qualité : les presets ne diffèrent que par les
 * passes activées et leurs résolutions.
 */
export function postFxVisuals(settings: PostFxSettings, night: number): PostFxVisuals {
  const n = clampUnit(night);
  return {
    bloomStrength: mix(settings.bloomStrength, settings.bloomStrength * 2.4, n),
    bloomRadius: mix(settings.bloomRadius, Math.min(1, settings.bloomRadius + 0.1), n),
    bloomThreshold: mix(settings.bloomThreshold, Math.max(0.5, settings.bloomThreshold - 0.3), n),
    vignette: clampUnit(mix(settings.vignette, settings.vignette + 0.08, n)),
    grain: clampUnit(mix(settings.grain, settings.grain + 0.008, n)),
    saturation: mix(settings.saturation, settings.saturation - 0.12, n),
    contrast: mix(settings.contrast, settings.contrast + 0.04, n),
    warmth: mix(settings.warmth, -0.26, n),
    splitTone: clampUnit(mix(settings.splitTone, settings.splitTone + 0.22, n)),
    tiltShiftAmount: clampUnit(mix(settings.tiltShiftAmount, settings.tiltShiftAmount + 0.05, n)),
    tiltFocus: settings.tiltFocus,
    tiltBand: settings.tiltBand,
  };
}

/** Liste ordonnée des passes réellement ajoutées au composer. */
export function postFxPasses(settings: PostFxSettings): string[] {
  if (!settings.enabled) return [];
  const passes = ['render'];
  if (settings.ambientOcclusion) passes.push('gtao');
  if (settings.bloom) passes.push('bloom');
  passes.push('output');
  if (settings.grade) passes.push('grade');
  if (settings.antialias !== 'none') passes.push(settings.antialias);
  return passes;
}
