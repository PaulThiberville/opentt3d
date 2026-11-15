import { describe, expect, it } from 'vitest';
import {
  DAY_TICKS,
  approachPhase,
  mixColour,
  phaseFromDayFraction,
  phaseFromEconomy,
  shortestPhaseDelta,
  smoothstep,
  sunState,
  wrap01,
} from '../src/render/dayNight';

describe('conversion date de jeu → phase', () => {
  it('expose 74 ticks par jour et démarre en fin de matinée', () => {
    expect(DAY_TICKS).toBe(74);
    expect(phaseFromDayFraction(0)).toBeCloseTo(0.45, 6);
    expect(phaseFromDayFraction(14.8)).toBeCloseTo(0.65, 6);
    expect(phaseFromDayFraction(33.3)).toBeCloseTo(0.9, 6);
    expect(phaseFromDayFraction(51.8)).toBeCloseTo(0.15, 6);
  });

  it('normalise les valeurs hors bornes', () => {
    expect(phaseFromDayFraction(-22.2)).toBeCloseTo(0.15, 6);
    expect(phaseFromDayFraction(DAY_TICKS * 3)).toBeCloseTo(0.45, 6);
    expect(phaseFromDayFraction(Number.NaN)).toBeCloseTo(0.45, 6);
    expect(wrap01(1.25)).toBeCloseTo(0.25, 6);
    expect(wrap01(-0.25)).toBeCloseTo(0.75, 6);
  });

  it('lit directement le snapshot d’économie', () => {
    expect(phaseFromEconomy({ dayFraction: 14.8 })).toBeCloseTo(0.65, 6);
    expect(phaseFromEconomy({ dayFraction: 0 })).toBeCloseTo(0.45, 6);
  });
});

describe('lissage de phase', () => {
  it('calcule l’écart le plus court, y compris au passage de minuit', () => {
    expect(shortestPhaseDelta(0.9, 0.1)).toBeCloseTo(0.2, 6);
    expect(shortestPhaseDelta(0.1, 0.9)).toBeCloseTo(-0.2, 6);
    expect(shortestPhaseDelta(0.25, 0.25)).toBe(0);
  });

  it('approche la cible sans la dépasser et sans saut à minuit', () => {
    const next = approachPhase(0.97, 0.03, 0.16);
    expect(shortestPhaseDelta(next, 0.03)).toBeLessThan(shortestPhaseDelta(0.97, 0.03));
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThan(1);
    let phase = 0.97;
    for (let i = 0; i < 60; i += 1) phase = approachPhase(phase, 0.03, 0.16);
    expect(shortestPhaseDelta(phase, 0.03)).toBeLessThan(0.001);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  });

  it('ignore un delta négatif ou non fini', () => {
    expect(approachPhase(0.25, 0.5, -1)).toBeCloseTo(0.25, 6);
    expect(approachPhase(0.25, 0.5, Number.NaN)).toBeCloseTo(0.25, 6);
  });
});

describe('position et couleur du soleil', () => {
  it('place minuit sous l’horizon, sans lumière', () => {
    const state = sunState(0);
    expect(state.altitude).toBeCloseTo(-1, 6);
    expect(state.intensity).toBe(0);
    expect(state.night).toBeCloseTo(1, 6);
    expect(state.daylight).toBe(0);
    expect(state.segment).toBe('night');
    expect(state.direction.y).toBeLessThan(0);
  });

  it('place midi au sud et au plus haut', () => {
    const state = sunState(0.5);
    expect(state.altitude).toBeCloseTo(1, 6);
    expect(state.intensity).toBeCloseTo(2.35, 6);
    expect(state.night).toBe(0);
    expect(state.daylight).toBeCloseTo(1, 6);
    expect(state.direction.y).toBeGreaterThan(0.7);
    expect(state.direction.z).toBeGreaterThan(0);
    expect(state.segment).toBe('day');
  });

  it('se lève à l’est et se couche à l’ouest', () => {
    const sunrise = sunState(0.25);
    expect(sunrise.direction.x).toBeGreaterThan(0.9);
    expect(sunrise.direction.z).toBeCloseTo(0, 5);
    expect(sunrise.direction.y).toBeCloseTo(0, 5);
    expect(sunrise.segment).toBe('dawn');
    expect(sunrise.intensity).toBeGreaterThan(0);
    expect(sunrise.intensity).toBeLessThan(1.5);

    const dusk = sunState(0.75);
    expect(dusk.direction.x).toBeLessThan(-0.9);
    expect(dusk.segment).toBe('dusk');
  });

  it('réchauffe la lumière près de l’horizon', () => {
    const dawn = sunState(0.27);
    const noon = sunState(0.5);
    const dawnRed = (dawn.colour >> 16) & 0xff;
    const dawnGreen = (dawn.colour >> 8) & 0xff;
    const noonGreen = (noon.colour >> 8) & 0xff;
    expect(dawnRed).toBe(0xff);
    expect(dawnGreen).toBeLessThan(noonGreen);
    expect(dawn.colour).not.toBe(noon.colour);
  });

  it('démarre une nouvelle partie en matinée lisible', () => {
    const start = sunState(phaseFromDayFraction(0));
    expect(start.daylight).toBeGreaterThan(0.8);
    expect(start.night).toBeLessThan(0.1);
    expect(start.intensity).toBeGreaterThan(2);
    expect(start.segment).toBe('day');
  });

  it('allume étoiles et lune uniquement la nuit', () => {
    expect(sunState(0.5).starOpacity).toBe(0);
    expect(sunState(0.5).moonIntensity).toBe(0);
    expect(sunState(0).starOpacity).toBeGreaterThan(0.95);
    expect(sunState(0).moonIntensity).toBeGreaterThan(0.9);
  });

  it('garde une ambiance nocturne non nulle pour la lisibilité', () => {
    const night = sunState(0);
    expect(night.ambient).toBeGreaterThanOrEqual(0.75);
    expect(night.hemiGround).not.toBe(0);
    expect(night.fogColour).not.toBe(night.skyColour);
  });

  it('varie continûment entre deux phases voisines', () => {
    let previous = sunState(0.2).intensity;
    for (let phase = 0.21; phase <= 0.8; phase += 0.01) {
      const current = sunState(phase).intensity;
      expect(Math.abs(current - previous)).toBeLessThan(0.4);
      previous = current;
    }
  });
});

describe('utilitaires de couleur', () => {
  it('borne et lisse les interpolations', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(mixColour(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixColour(0xff0000, 0x00ff00, 1)).toBe(0x00ff00);
  });
});
