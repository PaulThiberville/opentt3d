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

/** Palette de base par type de tuile (hex sRGB). */
export const TILE_COLOURS: Record<TileKind, number> = {
  void: 0x0d1218,
  clear: 0x5f8a43,
  grass: 0x477334,
  rough: 0x6d6452,
  water: 0x1f4f70,
  coast: 0xc2a878,
  rail: 0x5c5348,
  road: 0x4d4d4f,
  house: 0x8c8478,
  trees: 0x2f5428,
  station: 0x9a9a96,
  industry: 0x746457,
  bridge: 0x6b5540,
  tunnel: 0x33333a,
  object: 0x6a6a70,
  airport: 0x62636a,
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

function mixHex(a: number, b: number, amount: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return rgbToHex(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount);
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
  let colour = mixHex(0x000000, base, Math.min(1, variation));
  // Altitude : les sommets tirent vers la roche claire.
  if (kind === 'grass' || kind === 'clear' || kind === 'trees' || kind === 'rough') {
    const altitude = Math.max(0, Math.min(1, (heightLevel - 8) / 6));
    if (altitude > 0) colour = mixHex(colour, 0x8d8676, altitude * 0.5);
    if (steepness >= 3) colour = mixHex(colour, 0x5f584a, 0.32);
  }
  return colour;
}

/** Variation appliquée aux eaux peu profondes (proches d'une côte). */
export function shallowWaterColour(seed: number): number {
  return mixHex(TILE_COLOURS.water, 0x4a93b4, 0.2 + hashUnit2d(seed, 7, 3) * 0.08);
}

/** Couleur d'un bâtiment de ville, selon le quartier et la graine. */
export function buildingColour(seed: number, index: number, cityTint: number): number {
  const palette = [0xd8cdb8, 0xc4b49a, 0xbfa98c, 0xd2d4cc, 0xa8b0b4, 0xc9b9a4, 0xb59b7f];
  const base = palette[Math.abs(seed + index * 7) % palette.length] ?? 0xc9b9a4;
  return mixHex(base, cityTint, 0.16);
}
