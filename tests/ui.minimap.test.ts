import { describe, expect, it } from 'vitest';
import {
  cameraFootprint,
  computeMinimapLayout,
  minimapToWorld,
  worldToMinimap,
} from '../src/ui/minimapMath';

describe('cadrage de la minimap', () => {
  it('centre une carte carrée dans un canvas paysage', () => {
    const layout = computeMinimapLayout(256, 256, 200, 100);
    expect(layout.scale).toBeCloseTo(100 / 256, 5);
    expect(layout.frame.width).toBeCloseTo(100, 5);
    expect(layout.frame.height).toBeCloseTo(100, 5);
    expect(layout.frame.x).toBeCloseTo(50, 5);
    expect(layout.frame.y).toBeCloseTo(0, 5);
  });

  it('gère une carte rectangulaire', () => {
    const layout = computeMinimapLayout(200, 100, 300, 300);
    expect(layout.frame.width).toBeCloseTo(300, 5);
    expect(layout.frame.height).toBeCloseTo(150, 5);
    expect(layout.frame.y).toBeCloseTo(75, 5);
  });

  it('protège les tailles invalides', () => {
    const layout = computeMinimapLayout(0, 0, 0, 0);
    expect(layout.frame.width).toBeGreaterThan(0);
    expect(layout.frame.height).toBeGreaterThan(0);
    expect(Number.isFinite(layout.scale)).toBe(true);
  });
});

describe('conversions monde ↔ minimap', () => {
  const layout = computeMinimapLayout(256, 128, 200, 200);

  it('projette les coins de la carte sur le cadre', () => {
    expect(worldToMinimap(0, 0, layout, 256, 128)).toEqual({ x: 0, y: 50 });
    const bottomRight = worldToMinimap(256, 128, layout, 256, 128);
    expect(bottomRight.x).toBeCloseTo(200, 5);
    expect(bottomRight.y).toBeCloseTo(150, 5);
  });

  it('effectue un aller-retour stable', () => {
    const world = { x: 64, y: 32 };
    const pixel = worldToMinimap(world.x, world.y, layout, 256, 128);
    const back = minimapToWorld(pixel.x, pixel.y, layout, 256, 128);
    expect(back.x).toBeCloseTo(world.x, 5);
    expect(back.y).toBeCloseTo(world.y, 5);
  });

  it('borne un clic hors du cadre', () => {
    expect(minimapToWorld(-50, -50, layout, 256, 128)).toEqual({ x: 0, y: 0 });
    const limit = minimapToWorld(500, 500, layout, 256, 128);
    expect(limit.x).toBe(256);
    expect(limit.y).toBe(128);
  });
});

describe('empreinte caméra', () => {
  const view = {
    targetX: 128,
    targetZ: 128,
    targetY: 4,
    yaw: 0,
    pitch: 0.9,
    distance: 80,
  };

  it('renvoie quatre coins finis autour de la cible', () => {
    const points = cameraFootprint(view, 16 / 9);
    expect(points).toHaveLength(4);
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    const averageX = points.reduce((sum, point) => sum + point.x, 0) / 4;
    expect(averageX).toBeCloseTo(view.targetX, 1);
  });

  it('rétrécit l’empreinte quand la caméra monte à la verticale', () => {
    const spread = (pitch: number): number => {
      const points = cameraFootprint({ ...view, pitch }, 16 / 9);
      return Math.max(...points.map((point) => Math.hypot(point.x - 128, point.y - 128)));
    };
    expect(spread(1.35)).toBeLessThan(spread(0.5));
  });

  it('reste bornée avec un angle rasant', () => {
    const points = cameraFootprint({ ...view, pitch: 0.02 }, 16 / 9);
    for (const point of points) {
      expect(Math.abs(point.x - view.targetX)).toBeLessThan(view.distance * 13);
      expect(Math.abs(point.y - view.targetZ)).toBeLessThan(view.distance * 13);
    }
  });

  it('tourne avec l’azimut', () => {
    const points = cameraFootprint({ ...view, yaw: Math.PI / 2 }, 1);
    expect(points).toHaveLength(4);
    expect(points.every((point) => Number.isFinite(point.y))).toBe(true);
  });
});
