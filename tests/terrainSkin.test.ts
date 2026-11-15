import { describe, expect, it } from 'vitest';
import { TERRAIN_SKIN_BOUNDS } from '../src/render/terrainSurface';
import {
  TERRAIN_SKIN_COLOURS,
  TILE_COLOURS,
  WATER_DEEP_COLOUR,
  WATER_SHALLOW_COLOUR,
  glslLinearColour,
  hexToLinearRgb,
  srgbToLinear,
  tileColour,
  waterColourAtDepth,
} from '../src/render/tileVisuals';

function channels(hex: number): { r: number; g: number; b: number; luma: number } {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

describe('palette de terrain', () => {
  it('donne une herbe verte profonde, légèrement désaturée', () => {
    for (const kind of ['grass', 'clear', 'trees', 'rough'] as const) {
      const colour = tileColour(kind, 7, 0, 64);
      const { r, g, b, luma } = channels(colour);
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
      // Vert dominant, mais pas de vert néon : les écarts restent mesurés.
      expect(g - r).toBeGreaterThan(14);
      expect(g - b).toBeGreaterThan(28);
      const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
      expect(saturation).toBeLessThanOrEqual(0.5);
      // Valeur de vert tempéré : ni pastel, ni fluo.
      expect(g).toBeGreaterThan(65);
      expect(g).toBeLessThan(150);
      expect(luma).toBeLessThan(135);
    }
  });

  it('garde les hauteurs herbeuses vertes même au sommet', () => {
    const low = tileColour('grass', 3, 0, 12);
    const high = tileColour('rough', 15, 1, 12);
    for (const colour of [low, high]) {
      const { r, g, b } = channels(colour);
      expect(g).toBeGreaterThan(r + 10);
      expect(g).toBeGreaterThan(b + 25);
    }
    // L'altitude éclaircit un peu la pelouse sans la virer au beige.
    expect(channels(high).luma).toBeLessThan(160);
  });

  it('garde les teintes urbaines proches de la pelouse', () => {
    for (const kind of ['house', 'station', 'airport'] as const) {
      const colour = tileColour(kind, 7, 0, 64);
      const { r, g, b } = channels(colour);
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
      // Proche de la pelouse : pas de contraste de dalle.
      const grass = tileColour('grass', 7, 0, 64);
      expect(Math.abs(r - ((grass >> 16) & 0xff))).toBeLessThan(45);
    }
  });

  it('expose des teintes de peau plausibles, herbe exclue', () => {
    const earth = channels(TERRAIN_SKIN_COLOURS.earth);
    expect(earth.r).toBeGreaterThan(earth.g);
    expect(earth.g).toBeGreaterThan(earth.b);
    const rock = channels(TERRAIN_SKIN_COLOURS.rock);
    expect(Math.max(rock.r, rock.g, rock.b) - Math.min(rock.r, rock.g, rock.b)).toBeLessThan(30);
    const sand = channels(TERRAIN_SKIN_COLOURS.sand);
    expect(sand.luma).toBeGreaterThan(150);
    // Sable mouillé plus sombre que le sable sec.
    expect(channels(TERRAIN_SKIN_COLOURS.wetSand).luma).toBeLessThan(sand.luma);
    // Fond profond plus sombre que le fond sableux.
    expect(channels(TERRAIN_SKIN_COLOURS.bedDeep).luma).toBeLessThan(
      channels(TERRAIN_SKIN_COLOURS.bedShallow).luma,
    );
  });

  it('convertit correctement sRGB → linéaire pour les sommets', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBe(1);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
    expect(srgbToLinear(Number.NaN)).toBe(0);
    expect(srgbToLinear(2)).toBe(1);
    const black = hexToLinearRgb(0x000000);
    const white = hexToLinearRgb(0xffffff);
    expect(black.r + black.g + black.b).toBe(0);
    expect(white.r).toBe(1);
    expect(white.g).toBe(1);
    expect(white.b).toBe(1);
    // La conversion assombrit les tons moyens : c'est ce qui rendait l'herbe
    // beige quand les octets sRGB étaient écrits tels quels.
    const grass = hexToLinearRgb(TILE_COLOURS.grass);
    expect(Math.max(grass.r, grass.g, grass.b)).toBeLessThan(0.3);
  });

  it('formate les constantes GLSL sans NaN et dans [0, 1]', () => {
    for (const hex of Object.values(TILE_COLOURS)) {
      const glsl = glslLinearColour(hex);
      expect(glsl).toMatch(/^vec3\( [0-9.]+, [0-9.]+, [0-9.]+ \)$/);
      const values = glsl
        .slice(6, -2)
        .split(',')
        .map((value) => Number(value.trim()));
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('rampe de couleur de l’eau', () => {
  it('va du turquoise clair au bleu profond, sans gris', () => {
    const shallow = waterColourAtDepth(0, 5);
    const deep = waterColourAtDepth(1, 5);
    const shallowRgb = channels(shallow);
    const deepRgb = channels(deep);
    expect(shallowRgb.luma).toBeGreaterThan(deepRgb.luma);
    expect(shallowRgb.g).toBeGreaterThan(shallowRgb.r + 40);
    expect(shallowRgb.b).toBeGreaterThan(shallowRgb.r + 40);
    expect(deepRgb.b).toBeGreaterThan(deepRgb.r);
    expect(deepRgb.b).toBeGreaterThan(deepRgb.g);
    // Bornes de profondeur : aucune couleur invalide.
    for (const depth of [-1, 0, 0.3, 0.7, 1, 4, Number.NaN]) {
      const colour = waterColourAtDepth(depth, 3);
      expect(colour).toBeGreaterThanOrEqual(0);
      expect(colour).toBeLessThanOrEqual(0xffffff);
    }
    expect(waterColourAtDepth(0.4, 5)).toBe(waterColourAtDepth(0.4, 5));
    expect(WATER_SHALLOW_COLOUR).not.toBe(WATER_DEEP_COLOUR);
  });
});

describe('bornes du shader de terrain', () => {
  it('ordonne les seuils herbe → terre → roche', () => {
    const { earthSlope, rockSlope, alpine, sand, bumpStrength, dryGrass } = TERRAIN_SKIN_BOUNDS;
    expect(earthSlope.start).toBeGreaterThan(0);
    expect(earthSlope.start).toBeLessThan(earthSlope.end);
    expect(rockSlope.start).toBeLessThan(rockSlope.end);
    // La terre commence avant la roche : les pentes douces restent herbeuses.
    expect(earthSlope.start).toBeLessThan(rockSlope.start);
    expect(earthSlope.end).toBeGreaterThan(rockSlope.start);
    expect(alpine.start).toBeLessThan(alpine.end);
    expect(alpine.weight).toBeGreaterThan(0);
    expect(alpine.weight).toBeLessThanOrEqual(0.4);
    expect(sand.inner).toBeLessThan(sand.outer);
    expect(sand.altitudeStart).toBeLessThan(sand.altitudeEnd);
    expect(bumpStrength).toBeGreaterThan(0);
    expect(bumpStrength).toBeLessThanOrEqual(0.3);
    expect(dryGrass).toBeGreaterThanOrEqual(0);
    expect(dryGrass).toBeLessThanOrEqual(0.3);
  });
});
