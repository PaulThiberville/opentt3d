import { describe, expect, it } from 'vitest';
import { attractOrbitPosition } from '../src/render/AttractScene';

describe('caméra d’attraction', () => {
  it('tourne autour du point visé à distance constante par paliers', () => {
    const focus = { x: 40, y: 6, z: 70 };
    for (let index = 0; index < 24; index += 1) {
      const orbit = index * 0.5;
      const position = attractOrbitPosition(focus, orbit);
      const radius = Math.hypot(position.x - focus.x, position.z - focus.z);
      expect(radius).toBeGreaterThanOrEqual(25);
      expect(radius).toBeLessThanOrEqual(37);
      expect(position.y - focus.y).toBeGreaterThanOrEqual(11);
      expect(position.y - focus.y).toBeLessThanOrEqual(17);
    }
  });

  it('change de point de vue sans quitter le voisinage de la ville', () => {
    const focus = { x: 0, y: 0, z: 0 };
    const first = attractOrbitPosition(focus, 0);
    const second = attractOrbitPosition(focus, Math.PI);
    expect(first.distanceTo(second)).toBeGreaterThan(40);
    expect(first.x).toBeGreaterThan(10);
    expect(second.x).toBeLessThan(-10);
  });

  it('reste à l’extérieur de la scène, jamais dans le décor', () => {
    const focus = { x: -12, y: 4.5, z: 8 };
    for (let index = 0; index < 12; index += 1) {
      const position = attractOrbitPosition(focus, index * 0.9);
      const distance = Math.hypot(position.x - focus.x, position.y - focus.y, position.z - focus.z);
      expect(distance).toBeGreaterThan(20);
    }
  });
});
