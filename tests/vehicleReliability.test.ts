import { describe, expect, it } from 'vitest';
import {
  AUTOREPLACE_ALWAYS_DAYS,
  AUTOREPLACE_WHEN_OLD_DAYS,
  BREAKDOWN_WEAR_THRESHOLD,
  DEFAULT_SERVICE_INTERVAL_DAYS,
  advanceBreakdown,
  advanceWear,
  breakdownChance,
  breakdownSpeedFactor,
  clampServiceInterval,
  initialReliability,
  needsService,
  reliabilityPercent,
  reliabilitySnapshot,
  rollBreakdown,
  serviceCost,
  shouldAutoreplace,
} from '../src/game/vehicleReliability';

describe('règles de fiabilité (#163)', () => {
  it('initialise un véhicule neuf et borne les intervalles', () => {
    const track = initialReliability();
    expect(track.wear).toBe(0);
    expect(track.breakdown).toBe('none');
    expect(track.serviceIntervalDays).toBe(DEFAULT_SERVICE_INTERVAL_DAYS);
    expect(clampServiceInterval(1)).toBe(30);
    expect(clampServiceInterval(10_000)).toBe(365);
    expect(reliabilityPercent(35)).toBe(65);
    expect(reliabilityPercent(140)).toBe(0);
  });

  it('fait progresser l’usure et déclenche les pannes au-delà du seuil', () => {
    let track = initialReliability(100);
    track = advanceWear(track, 50);
    expect(track.wear).toBeCloseTo(50, 0);
    expect(breakdownChance(0)).toBe(0);
    expect(breakdownChance(BREAKDOWN_WEAR_THRESHOLD)).toBe(0);
    expect(breakdownChance(100)).toBeGreaterThan(0.3);
    expect(rollBreakdown(100, 0, 0.1)).toBe(true);
    expect(rollBreakdown(100, 1, 0.1)).toBe(false);
    expect(rollBreakdown(10, 0, 0.1)).toBe(false);
    expect(needsService(track, 50)).toBe(true);
    expect(needsService(initialReliability(), 1)).toBe(false);
  });

  it('enchaîne ralentissement puis arrêt temporaire', () => {
    expect(advanceBreakdown('slowing', 1)).toEqual({ breakdown: 'stopped', breakdownTicks: 90 });
    expect(advanceBreakdown('slowing', 2)).toEqual({ breakdown: 'slowing', breakdownTicks: 1 });
    expect(advanceBreakdown('stopped', 1)).toEqual({ breakdown: 'none', breakdownTicks: 0 });
    expect(breakdownSpeedFactor('none')).toBe(1);
    expect(breakdownSpeedFactor('slowing')).toBeLessThan(1);
    expect(breakdownSpeedFactor('stopped')).toBe(0);
  });

  it('calcule le coût d’un service et le remplacement automatique', () => {
    expect(serviceCost(480, 0, 120)).toBeGreaterThan(0);
    expect(serviceCost(480, 240, 120)).toBeGreaterThan(serviceCost(480, 0, 120));
    expect(shouldAutoreplace(AUTOREPLACE_ALWAYS_DAYS, 0, false)).toBe(true);
    expect(shouldAutoreplace(1, 10, false)).toBe(false);
    expect(shouldAutoreplace(AUTOREPLACE_WHEN_OLD_DAYS, 0, true)).toBe(true);
    expect(shouldAutoreplace(10, 10, true)).toBe(false);
    expect(shouldAutoreplace(10, 90, true)).toBe(true);
  });

  it('produit une vue protocole stable', () => {
    const track = {
      ...initialReliability(120),
      wear: 42,
      lastServiceTick: 740,
      breakdown: 'slowing' as const,
      breakdownTicks: 12,
    };
    const view = reliabilitySnapshot(track, 480, 74 * 20, 74);
    expect(view.wear).toBe(42);
    expect(view.reliability).toBe(58);
    expect(view.daysSinceService).toBe(10);
    expect(view.breakdown).toBe('slowing');
    expect(view.maintenancePerYear).toBe(480);
  });
});
