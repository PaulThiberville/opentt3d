import { describe, expect, it } from 'vitest';
import {
  midpointBetween,
  panFromMidpoint,
  pinchDistance,
  spreadBetween,
  updatePinch,
  type TouchPinchState,
} from '../src/ui/touchGestures';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe('géométrie du pincement tactile (#170)', () => {
  it('calcule l’écart et le milieu de deux doigts', () => {
    expect(spreadBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpointBetween({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });

  it('rapproche la caméra quand les doigts s’écartent', () => {
    expect(pinchDistance(40, 100, 200)).toBe(20);
    expect(pinchDistance(40, 100, 50)).toBe(80);
    // Valeurs dégénérées : la distance de départ est conservée.
    expect(pinchDistance(40, 0, 100)).toBe(40);
    expect(pinchDistance(40, 100, 0)).toBe(40);
    expect(pinchDistance(Number.NaN, 100, 200)).toBeNaN();
  });

  it('convertit le déplacement du milieu en pan caméra', () => {
    const origin = panFromMidpoint(0, 0, 0, 40);
    expect(origin.x).toBeCloseTo(0);
    expect(origin.z).toBeCloseTo(0);
    const east = panFromMidpoint(10, 0, 0, 40);
    expect(east.x).toBeCloseTo(-0.68);
    expect(east.z).toBeCloseTo(0);
    const north = panFromMidpoint(0, 10, 0, 40);
    expect(north.x).toBeCloseTo(0);
    expect(north.z).toBeCloseTo(-0.68);
  });

  it('met à jour une gestuelle et consomme le déplacement du milieu', () => {
    const state: TouchPinchState = {
      startSpread: 100,
      startDistance: 140,
      lastMid: { x: 50, y: 50 },
    };
    const update = updatePinch(state, { x: 50, y: 30 }, { x: 250, y: 70 });
    expect(update.distance).toBeCloseTo(68.64, 1);
    expect(update.dx).toBe(100);
    expect(update.dy).toBe(0);
    expect(state.lastMid).toEqual({ x: 150, y: 50 });
  });
});

describe('intégration mobile (#170)', () => {
  it('attache les gestes à la scène sans modifier le renderer', () => {
    const session = readFileSync(join(root, 'src/ui/gameSession.ts'), 'utf8');
    expect(session).toContain("from './touchGestures'");
    expect(session).toContain('new TouchCameraGestures');
    expect(session).toContain('this.touchGestures?.detach()');
    const gestures = readFileSync(join(root, 'src/ui/touchGestures.ts'), 'utf8');
    expect(gestures).toContain("from '../render/CameraController'");
    expect(gestures).toContain('stopImmediatePropagation');
    expect(gestures).toContain('isPlacementEnabled');
  });

  it('expose les règles responsive et tactiles dans la feuille de style', () => {
    const style = readFileSync(join(root, 'src/style.css'), 'utf8');
    expect(style).toContain('@media (pointer: coarse)');
    expect(style).toContain('min-height: 44px');
    expect(style).toContain('env(safe-area-inset-bottom)');
    expect(style).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.hud-toolbar \{[\s\S]*?overflow-x: auto/,
    );
    expect(style).toMatch(/\.panel-screen > \.panel[\s\S]*?min-height: 100%/);
    expect(style).toMatch(/\.hud-tool \{[\s\S]*?scroll-snap-align: center/);
  });
});
