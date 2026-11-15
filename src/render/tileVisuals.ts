/**
 * Palette et couleurs procédurales du monde.
 *
 * Aucune texture : la couleur de chaque tuile est calculée à partir de son
 * type, de sa hauteur, de sa déclivité et d'une variation déterministe.
 */

import type { TileKind } from '../engine/protocol';
import { hashUnit2d } from '../game/prng';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Palette de base par type de tuile (hex sRGB).
 *
 * Les verts sont tempérés et légèrement désaturés : assez profonds pour rester
 * crédibles sous le soleil chaud (intensité 2,35 + ACES), sans virer au vert
 * néon. Les couleurs sont converties en espace linéaire avant d'alimenter les
 * sommets (voir `hexToLinearRgb`). `rough` reste un vert d'altitude plutôt
 * qu'un beige : la roche est ajoutée par le shader selon la pente, pas par la
 * palette.
 */
export const TILE_COLOURS: Record<TileKind, number> = {
  void: 0x0d1218,
  clear: 0x748b59,
  grass: 0x677a50,
  rough: 0x606f50,
  water: 0x1d4a68,
  coast: 0xcdb488,
  rail: 0x5c5348,
  road: 0x4d4d4f,
  house: 0x5e7550,
  trees: 0x38532f,
  station: 0x60704c,
  industry: 0x746457,
  bridge: 0x6b5540,
  tunnel: 0x33333a,
  object: 0x6a6a70,
  airport: 0x5f6d4e,
  dock: 0x67593f,
  canal: 0x2a5d80,
  river: 0x2d6a8e,
};

/** Palette des couleurs d'entreprise OpenTTD (index 0..15). */
export const COMPANY_COLOURS = [
  0x1c2f83, 0x2f8f4e, 0xd46a9a, 0xe0c53c, 0xc9463f, 0x4fa3d9, 0x3f9c58, 0x2c6b3a, 0x3d6fc4,
  0xe8dcc0, 0xa46ac0, 0x7a4aa8, 0xd97b2f, 0x8a5a35, 0x8a8f94, 0xf0f0f0,
];

export function companyColour(index: number): number {
  return (
    COMPANY_COLOURS[
      (((index | 0) % COMPANY_COLOURS.length) + COMPANY_COLOURS.length) % COMPANY_COLOURS.length
    ] ?? 0x3d6fc4
  );
}

export function rgbToHex(r: number, g: number, b: number): number {
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}

export function hexToRgb(hex: number, out: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  out.r = ((hex >> 16) & 0xff) / 255;
  out.g = ((hex >> 8) & 0xff) / 255;
  out.b = (hex & 0xff) / 255;
  return out;
}

/** Canal sRGB (0..1) vers l'espace linéaire attendu par Three.js. */
export function srgbToLinear(value: number): number {
  const c = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Couleur hex sRGB vers triplet linéaire.
 *
 * Les `BufferAttribute` de couleur ne sont pas convertis par Three.js : écrire
 * directement les octets sRGB dans les sommets revient à les traiter comme des
 * valeurs linéaires. L'herbe ressortait alors lavée et beige. Cette conversion
 * rétablit la teinte de la palette sous l'éclairage ACES.
 */
export function hexToLinearRgb(hex: number, out: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  out.r = srgbToLinear(((hex >> 16) & 0xff) / 255);
  out.g = srgbToLinear(((hex >> 8) & 0xff) / 255);
  out.b = srgbToLinear((hex & 0xff) / 255);
  return out;
}

/** Formate une couleur sRGB en `vec3` GLSL linéaire, pour les constantes du shader. */
export function glslLinearColour(hex: number): string {
  const rgb = hexToLinearRgb(hex);
  return `vec3( ${rgb.r.toFixed(5)}, ${rgb.g.toFixed(5)}, ${rgb.b.toFixed(5)} )`;
}

/** Mélange linéaire de deux couleurs hex sRGB (0 = `a`, 1 = `b`). */
export function mixColour(a: number, b: number, amount: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return rgbToHex(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount);
}

/** Éclaircit (`amount > 0`) ou assombrit (`amount < 0`) une couleur hex. */
export function shadeColour(hex: number, amount: number): number {
  const factor = 1 + amount;
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * factor)));
  return (
    (channel((hex >> 16) & 0xff) << 16) | (channel((hex >> 8) & 0xff) << 8) | channel(hex & 0xff)
  );
}

/**
 * Variation procédurale déterministe d'une teinte de surface.
 *
 * Une petite dérive de luminosité et un voile de poussière chaude cassent
 * l'uniformité des toits et des façades sans texture. Le résultat ne dépend que
 * de la couleur de base et de la graine : deux rendus identiques restent
 * identiques.
 */
export function weatherColour(hex: number, seed: number, amount = 0.07): number {
  const brightness = hashUnit2d(seed, 0x51, 0x9d) - 0.5;
  const dust = hashUnit2d(seed, 0x27, 0x3b);
  const dusty = mixColour(hex, 0xb9a887, dust * Math.min(0.18, Math.max(0, amount)));
  return shadeColour(dusty, brightness * amount);
}

/**
 * Couleur d'une tuile de terrain.
 *
 * @param kind type de tuile
 * @param heightLevel hauteur 0..15
 * @param steepness nombre de voisins de hauteur différente (0..4)
 * @param seed graine pour la variation déterministe
 */
export function tileColour(
  kind: TileKind,
  heightLevel: number,
  steepness: number,
  seed = 1,
): number {
  const base = TILE_COLOURS[kind] ?? TILE_COLOURS.void;
  const variation = 0.9 + hashUnit2d(seed, heightLevel, steepness) * 0.16;
  let colour = mixColour(0x000000, base, Math.min(1, variation));
  // Ballast, voirie et dalles : deux passages de teinte déterministes pour
  // casser l'aplat sans texture (l'asphalte et le ballast ne sont jamais unis).
  switch (kind) {
    case 'rail':
      colour = mixColour(
        colour,
        0x6d5f4c,
        0.14 + hashUnit2d(seed, heightLevel + 5, steepness + 9) * 0.18,
      );
      break;
    case 'road':
    case 'airport':
      colour = mixColour(
        colour,
        0x2f3236,
        0.08 + hashUnit2d(seed, heightLevel + 2, steepness + 7) * 0.12,
      );
      break;
    case 'station':
      colour = mixColour(colour, 0xb4b1aa, hashUnit2d(seed, heightLevel + 11, steepness + 3) * 0.1);
      break;
    case 'industry':
      colour = mixColour(
        colour,
        0x5c5044,
        hashUnit2d(seed, heightLevel + 13, steepness + 1) * 0.12,
      );
      break;
    case 'dock':
      colour = mixColour(
        colour,
        0x7a6a4c,
        hashUnit2d(seed, heightLevel + 17, steepness + 6) * 0.14,
      );
      break;
    default:
      break;
  }
  // Herbe, prés et forêts : dérive de teinte (vert tendre ↔ vert profond)
  // plutôt qu'un simple éclaircissement, pour éviter les plaques délavées.
  if (kind === 'grass' || kind === 'clear' || kind === 'trees' || kind === 'rough') {
    const drift = hashUnit2d(seed, heightLevel + 21, steepness + 31);
    const tint = kind === 'trees' ? 0x2a4525 : kind === 'rough' ? 0x6b7a56 : 0x6c8a4e;
    colour = mixColour(colour, tint, 0.06 + drift * 0.12);
    // Altitude : très légère montée vers les pelouses alpines, la roche et la
    // falaise étant désormais ajoutées par la peau procédurale selon la pente.
    const altitude = Math.max(0, Math.min(1, (heightLevel - 10) / 5));
    if (altitude > 0) colour = mixColour(colour, 0x6f7d5c, altitude * 0.1);
    if (steepness >= 3) colour = mixColour(colour, 0x6a5c44, 0.18);
  }
  return colour;
}

/** Teintes de la peau procédurale, en sRGB (converties côté shader/sommets). */
export const TERRAIN_SKIN_COLOURS = {
  earth: 0x6b5638,
  rock: 0x74766b,
  rockDark: 0x4e5148,
  sand: 0xcdb488,
  wetSand: 0x9c855e,
  bedShallow: 0x7c7c58,
  bedDeep: 0x173841,
  dryGrass: 0x8a955c,
  skyReflection: 0xa8cada,
} as const;

export function smoothstep01(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Eau peu profonde (turquoise) à profonde (bleu nuit). */
export const WATER_SHALLOW_COLOUR = 0x55aab2;
export const WATER_MID_COLOUR = 0x26738f;
export const WATER_DEEP_COLOUR = 0x123f5b;

/**
 * Couleur d'eau pour un facteur de profondeur 0 (bord) à 1 (large).
 * La rampe reste dans les bleus-verts : pas de gris, pas de beige.
 */
export function waterColourAtDepth(depth: number, seed = 0): number {
  const d = Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 0));
  let colour = mixColour(WATER_SHALLOW_COLOUR, WATER_MID_COLOUR, smoothstep01(0.02, 0.5, d));
  colour = mixColour(colour, WATER_DEEP_COLOUR, smoothstep01(0.38, 1, d));
  const shimmer = (hashUnit2d(seed, 0x37, 0x71) - 0.5) * 0.06;
  return shadeColour(colour, shimmer);
}

/** Variation appliquée aux eaux peu profondes (proches d'une côte). */
export function shallowWaterColour(seed: number): number {
  return mixColour(WATER_SHALLOW_COLOUR, 0x8fd0cd, 0.16 + hashUnit2d(seed, 7, 3) * 0.12);
}

/** Couleur d'un bâtiment de ville, selon le quartier et la graine. */
export function buildingColour(seed: number, index: number, cityTint: number): number {
  const palette = [0xd8cdb8, 0xc4b49a, 0xbfa98c, 0xd2d4cc, 0xa8b0b4, 0xc9b9a4, 0xb59b7f];
  const base = palette[Math.abs(seed + index * 7) % palette.length] ?? 0xc9b9a4;
  return mixColour(base, cityTint, 0.16);
}
