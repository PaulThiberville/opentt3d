import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAY_NIGHT_CYCLE_SECONDS,
  DEFAULT_DAY_NIGHT_PHASE,
  DISABLED_DAY_NIGHT_PHASE,
  MAX_DAY_NIGHT_CYCLE_SECONDS,
  MIN_DAY_NIGHT_CYCLE_SECONDS,
  DayNightCycle,
  ensureDaytimePhase,
  sanitizeCycleSeconds,
} from '../src/render/dayNightCycle';

describe('horloge visuelle jour/nuit', () => {
  it('utilise deux minutes par cycle par défaut', () => {
    const cycle = new DayNightCycle();
    expect(cycle.cycleSeconds).toBe(120);
    expect(DEFAULT_DAY_NIGHT_CYCLE_SECONDS).toBe(120);
    expect(cycle.phase).toBeCloseTo(DEFAULT_DAY_NIGHT_PHASE, 6);
    expect(cycle.isEnabled).toBe(true);
  });

  it('borne les durées inconnues ou hors limites', () => {
    expect(sanitizeCycleSeconds(undefined)).toBe(DEFAULT_DAY_NIGHT_CYCLE_SECONDS);
    expect(sanitizeCycleSeconds('120')).toBe(DEFAULT_DAY_NIGHT_CYCLE_SECONDS);
    expect(sanitizeCycleSeconds(Number.NaN)).toBe(DEFAULT_DAY_NIGHT_CYCLE_SECONDS);
    expect(sanitizeCycleSeconds(1)).toBe(MIN_DAY_NIGHT_CYCLE_SECONDS);
    expect(sanitizeCycleSeconds(10_000)).toBe(MAX_DAY_NIGHT_CYCLE_SECONDS);
    expect(sanitizeCycleSeconds(61.7)).toBe(62);
  });

  it('avance au temps réel et boucle sans saut à minuit', () => {
    const cycle = new DayNightCycle({ phase: 0.9 });
    expect(cycle.advance(0)).toBeCloseTo(0.9, 6);
    // 120 s par cycle : 6 s = 5 % de la journée.
    expect(cycle.advance(6)).toBeCloseTo(0.95, 6);
    expect(cycle.advance(6)).toBeCloseTo(0, 6);
    expect(cycle.advance(12)).toBeCloseTo(0.1, 6);
  });

  it('respecte une durée personnalisée', () => {
    const cycle = new DayNightCycle({ cycleSeconds: 300, phase: 0 });
    expect(cycle.advance(30)).toBeCloseTo(0.1, 6);
    cycle.setCycleSeconds(60);
    expect(cycle.advance(30)).toBeCloseTo(0.6, 6);
  });

  it('fige l’heure à midi quand le cycle est désactivé', () => {
    const cycle = new DayNightCycle({ phase: 0.1 });
    cycle.setEnabled(false);
    expect(cycle.phase).toBe(DISABLED_DAY_NIGHT_PHASE);
    expect(cycle.advance(1_000)).toBe(DISABLED_DAY_NIGHT_PHASE);
    // Une phase moteur ne peut pas réintroduire la nuit tant que c'est figé.
    cycle.setPhase(0);
    expect(cycle.phase).toBe(DISABLED_DAY_NIGHT_PHASE);
    cycle.setEnabled(true);
    expect(cycle.phase).toBe(DISABLED_DAY_NIGHT_PHASE);
    // Midi + une demi-journée = minuit (phase 0).
    expect(cycle.advance(60)).toBeCloseTo(0, 6);
  });

  it('se fige pendant la pause et reprend ensuite', () => {
    const cycle = new DayNightCycle({ phase: 0.5 });
    cycle.setPaused(true);
    expect(cycle.advance(60)).toBe(0.5);
    cycle.setPaused(false);
    // Reprise depuis midi : 60 s plus tard, il est minuit (phase 0).
    expect(cycle.advance(60)).toBeCloseTo(0, 6);
  });

  it('ignore une phase non finie ou un delta négatif', () => {
    const cycle = new DayNightCycle({ phase: 0.4 });
    cycle.setPhase(Number.NaN);
    expect(cycle.phase).toBeCloseTo(0.4, 6);
    expect(cycle.advance(-20)).toBeCloseTo(0.4, 6);
  });

  it('ramène une heure de départ nocturne vers la fin de matinée', () => {
    expect(ensureDaytimePhase(0)).toBeCloseTo(0.45, 6);
    expect(ensureDaytimePhase(0.9)).toBeCloseTo(0.45, 6);
    expect(ensureDaytimePhase(0.5)).toBeCloseTo(0.5, 6);
    expect(ensureDaytimePhase(0.25, 0.4)).toBeCloseTo(0.25, 6);
    expect(ensureDaytimePhase(Number.NaN)).toBeCloseTo(0.45, 6);
  });

  it('expose le temps restant avant minuit', () => {
    const cycle = new DayNightCycle({ phase: 0.75, cycleSeconds: 120 });
    expect(cycle.secondsToMidnight).toBeCloseTo(30, 6);
    cycle.setEnabled(false);
    expect(cycle.secondsToMidnight).toBe(0);
  });
});
