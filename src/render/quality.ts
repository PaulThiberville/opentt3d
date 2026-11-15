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
  /** Rayon du filtre PCF (en texels) : plus grand = ombre plus douce. */
  shadowRadius: number;
  /** Biais de profondeur négatif pour éviter l'acné d'ombre. */
  shadowBias: number;
  /** Décalage le long de la normale, robuste sur les pentes. */
  shadowNormalBias: number;
  /** Demi-largeur de la caméra d'ombre autour du point visé (en tuiles). */
  shadowFrustum: number;
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
  /** Étoiles et lune la nuit : coupé en basse qualité. */
  nightSky: boolean;
  /** Fenêtres éclairées des bâtiments la nuit. */
  nightWindows: boolean;
  /** Fumée animée des cheminées d'industrie. */
  industrySmoke: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    label: 'Basse',
    pixelRatioCap: 1,
    antialias: false,
    shadows: false,
    shadowMapSize: 512,
    shadowRadius: 1,
    shadowBias: -0.0008,
    shadowNormalBias: 0.55,
    shadowFrustum: 60,
    drawDistance: 420,
    fogNear: 180,
    treeDensity: 0.5,
    waterAnimation: false,
    wind: false,
    maxTrees: 4_000,
    ambientLight: 0.95,
    nightSky: false,
    nightWindows: false,
    industrySmoke: false,
  },
  medium: {
    level: 'medium',
    label: 'Moyenne',
    pixelRatioCap: 1.5,
    antialias: true,
    shadows: false,
    shadowMapSize: 1024,
    shadowRadius: 2,
    shadowBias: -0.0006,
    shadowNormalBias: 0.45,
    shadowFrustum: 80,
    drawDistance: 620,
    fogNear: 260,
    treeDensity: 0.8,
    waterAnimation: true,
    wind: true,
    maxTrees: 9_000,
    ambientLight: 0.78,
    nightSky: true,
    nightWindows: true,
    industrySmoke: true,
  },
  high: {
    level: 'high',
    label: 'Haute',
    // Plafond identique à medium : au-delà de 1,5×, les passes plein écran
    // (grading, AA) coûtent plus que le gain de netteté perçu sur un écran Retina.
    pixelRatioCap: 1.5,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    shadowRadius: 2.6,
    shadowBias: -0.0004,
    shadowNormalBias: 0.35,
    shadowFrustum: 100,
    drawDistance: 900,
    fogNear: 320,
    treeDensity: 1,
    waterAnimation: true,
    wind: true,
    maxTrees: 16_000,
    ambientLight: 0.68,
    nightSky: true,
    nightWindows: true,
    industrySmoke: true,
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

/**
 * Demi-largeur de la caméra d'ombre : elle s'élargit quand la caméra recule
 * pour couvrir la zone visible, sans dépasser un plafond qui rendrait les
 * texels trop grossiers. Une seule cascade « ajustée » remplace les cascades
 * complètes, trop coûteuses sur une carte entière.
 */
export function resolveShadowFrustum(baseFrustum: number, cameraDistance: number): number {
  const base = Number.isFinite(baseFrustum) && baseFrustum > 0 ? baseFrustum : 80;
  const distance = Number.isFinite(cameraDistance) && cameraDistance > 0 ? cameraDistance : 0;
  return Math.min(base * 1.65, base + distance * 0.32);
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
