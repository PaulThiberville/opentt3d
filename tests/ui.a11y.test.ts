import { describe, expect, it } from 'vitest';
import { prefersReducedMotion, resolveFocusTrap, shouldGuardGameKey } from '../src/ui/dom';

describe('focus trap', () => {
  it('ne fait rien sans contrôle focusable', () => {
    expect(resolveFocusTrap(0, -1, false)).toBeNull();
    expect(resolveFocusTrap(0, 0, true)).toBeNull();
  });

  it('ramène le focus dans le conteneur quand il est dehors', () => {
    expect(resolveFocusTrap(3, -1, false)).toBe(0);
    expect(resolveFocusTrap(3, -1, true)).toBe(2);
  });

  it('boucle du dernier vers le premier et inversement', () => {
    expect(resolveFocusTrap(3, 2, false)).toBe(0);
    expect(resolveFocusTrap(3, 0, true)).toBe(2);
  });

  it('laisse le navigateur avancer au milieu de la liste', () => {
    expect(resolveFocusTrap(3, 0, false)).toBeNull();
    expect(resolveFocusTrap(3, 1, false)).toBeNull();
    expect(resolveFocusTrap(3, 1, true)).toBeNull();
    expect(resolveFocusTrap(3, 2, true)).toBeNull();
  });
});

describe('garde des raccourcis de jeu', () => {
  it('laisse passer les raccourcis quand aucun écran modal n’est ouvert', () => {
    expect(
      shouldGuardGameKey({
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        inScreen: false,
        screenOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldGuardGameKey({ key: ' ', code: 'Space', inScreen: false, screenOpen: false }),
    ).toBe(false);
  });

  it('filtre les flèches, Home, WASD, zoom et Espace dans un écran', () => {
    for (const [key, code] of [
      ['ArrowLeft', 'ArrowLeft'],
      ['ArrowDown', 'ArrowDown'],
      ['Home', 'Home'],
      ['w', 'KeyW'],
      ['q', 'KeyQ'],
      ['+', 'NumpadAdd'],
      [' ', 'Space'],
    ] as const) {
      expect(shouldGuardGameKey({ key, code, inScreen: true, screenOpen: false })).toBe(true);
      expect(shouldGuardGameKey({ key, code, inScreen: false, screenOpen: true })).toBe(true);
    }
  });

  it('laisse Tab, Échap, Entrée et les raccourcis métier hors caméra', () => {
    for (const [key, code] of [
      ['Tab', 'Tab'],
      ['Escape', 'Escape'],
      ['Enter', 'Enter'],
      ['r', 'KeyR'],
      ['?', 'Slash'],
    ] as const) {
      expect(shouldGuardGameKey({ key, code, inScreen: true, screenOpen: true })).toBe(false);
    }
  });
});

describe('préférence de mouvement réduit', () => {
  it('lit la media query sans dépendre de window', () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion(() => ({ matches: true }))).toBe(true);
    expect(prefersReducedMotion(() => ({ matches: false }))).toBe(false);
    expect(prefersReducedMotion((query) => ({ matches: query.includes('reduced-motion') }))).toBe(
      true,
    );
  });
});
