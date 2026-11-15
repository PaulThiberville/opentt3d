import { describe, expect, it } from 'vitest';
import { Prng, StateHash, fbm, hashUnit2d, valueNoise } from '../src/game/prng';
import { encodeBase64, decodeBase64 } from '../src/game/base64';

describe('Prng', () => {
  it('produit la même séquence pour une graine donnée', () => {
    const a = Array.from({ length: 12 }, () => new Prng(42).next());
    expect(new Set(a).size).toBe(1);
    const first = new Prng(42);
    const second = new Prng(42);
    for (let i = 0; i < 64; i += 1) expect(first.nextUint32()).toBe(second.nextUint32());
  });

  it('produit des séquences différentes pour des graines différentes', () => {
    const a = new Prng(1);
    const b = new Prng(2);
    const valuesA = Array.from({ length: 8 }, () => a.nextUint32());
    const valuesB = Array.from({ length: 8 }, () => b.nextUint32());
    expect(valuesA).not.toEqual(valuesB);
  });

  it('respecte les bornes de int/float', () => {
    const prng = new Prng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = prng.int(-3, 9);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(9);
      expect(Number.isInteger(value)).toBe(true);
      const float = prng.float(1.5, 2.5);
      expect(float).toBeGreaterThanOrEqual(1.5);
      expect(float).toBeLessThan(2.5);
    }
  });

  it('se reconstruit depuis un état sérialisé', () => {
    const prng = new Prng(1234);
    for (let i = 0; i < 20; i += 1) prng.next();
    const state = prng.getState();
    const restored = Prng.fromState(state);
    expect(restored.nextUint32()).toBe(prng.nextUint32());
    expect(restored.getState()).toBe(prng.getState());
  });

  it('mélange de façon déterministe sans perdre d’élément', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const shuffled = new Prng(99).shuffle([...items]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(new Prng(99).shuffle([...items])).toEqual(shuffled);
  });
});

describe('bruit déterministe', () => {
  it('hashUnit2d reste dans [0, 1) et stable', () => {
    for (let x = 0; x < 20; x += 1) {
      for (let y = 0; y < 20; y += 1) {
        const value = hashUnit2d(5, x, y);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
        expect(hashUnit2d(5, x, y)).toBe(value);
      }
    }
    expect(hashUnit2d(5, 3, 4)).not.toBe(hashUnit2d(6, 3, 4));
  });

  it('valueNoise et fbm restent bornés', () => {
    for (let i = 0; i < 200; i += 1) {
      const x = i * 0.37;
      const y = i * 0.61;
      const noise = valueNoise(11, x, y);
      expect(noise).toBeGreaterThanOrEqual(0);
      expect(noise).toBeLessThanOrEqual(1);
      const fractal = fbm(11, x * 0.1, y * 0.1, 4);
      expect(fractal).toBeGreaterThanOrEqual(0);
      expect(fractal).toBeLessThanOrEqual(1);
    }
  });
});

describe('StateHash', () => {
  it('donne un hash stable pour la même séquence', () => {
    const build = (): string => {
      const hash = new StateHash();
      hash.mixInt(1).mixFloat(2.5, 100).mixString('OpenTT3D');
      return hash.digest();
    };
    expect(build()).toBe(build());
    expect(build()).toHaveLength(8);
    const other = new StateHash().mixInt(2).mixFloat(2.5, 100).mixString('OpenTT3D').digest();
    expect(other).not.toBe(build());
  });
});

describe('base64', () => {
  it('fait un aller-retour sur des tailles arbitraires', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 1000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37) & 0xff;
      const decoded = decodeBase64(encodeBase64(bytes));
      expect(decoded).toEqual(bytes);
    }
  });
});
