import { describe, expect, it } from 'vitest';
import { tileColour } from '../src/render/tileVisuals';

describe('skin de sol urbain', () => {
  it('teinte les tuiles urbaines en vert-terre, sans aplat gris de dalle', () => {
    for (const kind of ['house', 'station', 'airport'] as const) {
      const colour = tileColour(kind, 7, 0, 64);
      const red = (colour >> 16) & 0xff;
      const green = (colour >> 8) & 0xff;
      const blue = colour & 0xff;
      expect(green).toBeGreaterThan(red);
      expect(green).toBeGreaterThan(blue);
      // Proche de la pelouse : pas de contraste de dalle.
      const grass = tileColour('grass', 7, 0, 64);
      expect(Math.abs(red - ((grass >> 16) & 0xff))).toBeLessThan(45);
    }
  });
});
