/**
 * Presets de qualité graphique.
 *
 * Fonctions pures (testables sous Node) + objet de réglages consommé par
 * `Renderer`, `TerrainLayer` et `VegetationLayer`.
 */

export type QualityLevel = 'low' | 'medium' | 'high';

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];

export interface QualitySettings {
  level: QualityLevel;
  label: string;
  /** Plafond du devicePixelRatio (1 = rendu natif sans suréchantillonnage). */
  pixelRatioCap: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Distance de la caméra et du brouillard (en tuiles). */
  drawDistance: number;
  fogNear: number;
  /** Probabilité de conserver un arbre (1 = tous). */
  treeDensity: number;
  waterAnimation: boolean;
  /** Balancement léger des arbres. */
  wind: boolean;
  /** Nombre maximal d'arbres instanciés, garde-fou mémoire. */
  maxTrees: number;
  /** Nombre de lampes d'appoint (hémisphérique + directionnelle). */
  ambientLight: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    label: 'Basse',
    pixelRatioCap: 1,
    antialias: false,
    shadows: false,
    shadowMapSize: 512,
    drawDistance: 420,
    fogNear: 180,
    treeDensity: 0.5,
    waterAnimation: false,
    wind: false,
    maxTrees: 4_000,
    ambientLight: 0.95,
  },
  medium: {
    level: 'medium',
    label: 'Moyenne',
    pixelRatioCap: 1.5,
    antialias: true,
    shadows: false,
    shadowMapSize: 1024,
    drawDistance: 620,
    fogNear: 260,
    treeDensity: 0.8,
    waterAnimation: true,
    wind: true,
    maxTrees: 9_000,
    ambientLight: 0.78,
  },
  high: {
    level: 'high',
    label: 'Haute',
    pixelRatioCap: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    drawDistance: 900,
    fogNear: 320,
    treeDensity: 1,
    waterAnimation: true,
    wind: true,
    maxTrees: 16_000,
    ambientLight: 0.68,
  },
};

export function qualitySettings(level: QualityLevel): QualitySettings {
  return QUALITY_PRESETS[level] ?? QUALITY_PRESETS.medium;
}

/** Ratio de pixels effectif, borné par le preset et le matériel. */
export function resolvePixelRatio(level: QualityLevel, devicePixelRatio: number): number {
  const cap = qualitySettings(level).pixelRatioCap;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, cap);
}

export interface RenderSize {
  width: number;
  height: number;
  pixelRatio: number;
  /** Taille réelle du drawing buffer. */
  bufferWidth: number;
  bufferHeight: number;
}

/** Taille de rendu CSS + buffer, avec DPR borné. */
export function resolveRenderSize(
  cssWidth: number,
  cssHeight: number,
  level: QualityLevel,
  devicePixelRatio: number,
): RenderSize {
  const width = Math.max(1, Math.floor(cssWidth));
  const height = Math.max(1, Math.floor(cssHeight));
  const pixelRatio = resolvePixelRatio(level, devicePixelRatio);
  return {
    width,
    height,
    pixelRatio,
    bufferWidth: Math.floor(width * pixelRatio),
    bufferHeight: Math.floor(height * pixelRatio),
  };
}

export function nextQuality(level: QualityLevel): QualityLevel {
  const index = QUALITY_LEVELS.indexOf(level);
  return QUALITY_LEVELS[(index + 1) % QUALITY_LEVELS.length] ?? 'medium';
}

/** Détecte automatiquement un preset raisonnable au démarrage. */
export function detectQuality(devicePixelRatio: number, hardwareConcurrency: number): QualityLevel {
  if (hardwareConcurrency > 0 && hardwareConcurrency <= 2) return 'low';
  if (devicePixelRatio >= 1.75 && hardwareConcurrency >= 8) return 'high';
  return 'medium';
}
