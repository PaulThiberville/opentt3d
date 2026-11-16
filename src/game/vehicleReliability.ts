/**
 * Règles d'usure, de fiabilité et d'entretien des véhicules (#163).
 *
 * Module pur partagé par `MockEngine`, l'interface et les tests. Il ne simule
 * aucun aléa : le moteur fournit le tirage déterministe, ces fonctions ne font
 * que convertir un état d'usure en probabilités et en coûts lisibles.
 *
 * L'unité de temps est le jour de jeu. Un véhicule neuf a `wear = 0` ; au-delà
 * de l'intervalle d'entretien, l'usure continue de progresser et la fiabilité
 * s'effondre. Un service dans un dépôt remet `wear` à zéro.
 */

import type { BreakdownState, VehicleReliabilitySnapshot } from '../engine/protocol';

/** Intervalle d'entretien par défaut, en jours de jeu. */
export const DEFAULT_SERVICE_INTERVAL_DAYS = 120;
export const MIN_SERVICE_INTERVAL_DAYS = 30;
export const MAX_SERVICE_INTERVAL_DAYS = 365;

/** Usure à partir de laquelle une panne peut survenir. */
export const BREAKDOWN_WEAR_THRESHOLD = 45;

/** Durée (ticks) des deux phases d'une panne : ralentissement puis arrêt. */
export const BREAKDOWN_SLOW_TICKS = 90;
export const BREAKDOWN_STOP_TICKS = 90;
/** Délai minimal (jours) entre deux pannes d'un même véhicule. */
export const BREAKDOWN_COOLDOWN_DAYS = 10;

/** Remplacement automatique : seuils d'âge selon `whenOld`. */
export const AUTOREPLACE_ALWAYS_DAYS = 30;
export const AUTOREPLACE_WHEN_OLD_DAYS = 365;
/** Usure qui déclenche un remplacement « quand vieux », même avant l'âge. */
export const AUTOREPLACE_WEAR_THRESHOLD = 55;

export interface ReliabilityTrack {
  wear: number;
  breakdown: BreakdownState;
  breakdownTicks: number;
  lastServiceTick: number | null;
  serviceIntervalDays: number;
  cooldownDays: number;
}

/** État initial d'un véhicule neuf. */
export function initialReliability(
  serviceIntervalDays = DEFAULT_SERVICE_INTERVAL_DAYS,
): ReliabilityTrack {
  return {
    wear: 0,
    breakdown: 'none',
    breakdownTicks: 0,
    lastServiceTick: null,
    serviceIntervalDays: clampServiceInterval(serviceIntervalDays),
    cooldownDays: 0,
  };
}

export function clampServiceInterval(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_SERVICE_INTERVAL_DAYS;
  return Math.max(MIN_SERVICE_INTERVAL_DAYS, Math.min(MAX_SERVICE_INTERVAL_DAYS, Math.round(days)));
}

export function clampWear(wear: number): number {
  if (!Number.isFinite(wear)) return 0;
  return Math.max(0, Math.min(100, wear));
}

/** Fiabilité restante 0..100. */
export function reliabilityPercent(wear: number): number {
  return Math.round(100 - clampWear(wear));
}

/** Usure gagnée par jour : un véhicule atteint 100 en un intervalle complet. */
export function wearPerDay(track: Pick<ReliabilityTrack, 'serviceIntervalDays'>): number {
  return 100 / clampServiceInterval(track.serviceIntervalDays);
}

/**
 * Avance l'usure d'un jour. L'usure ralentit après 80 pour éviter qu'un
 * véhicule devienne inutilisable avant d'avoir pu rentrer au dépôt.
 */
export function advanceWear(track: ReliabilityTrack, days = 1): ReliabilityTrack {
  if (days <= 0) return track;
  let wear = clampWear(track.wear);
  let remaining = days;
  while (remaining > 0) {
    const step = Math.min(1, remaining);
    const rate = wear > 80 ? wearPerDay(track) * 0.5 : wearPerDay(track);
    wear = clampWear(wear + rate * step);
    remaining -= step;
  }
  return { ...track, wear };
}

/**
 * Probabilité de panne par jour. Nulle sous le seuil, puis croissante jusqu'à
 * 35 % par jour à 100 % d'usure.
 */
export function breakdownChance(wear: number): number {
  const value = clampWear(wear);
  if (value < BREAKDOWN_WEAR_THRESHOLD) return 0;
  const span = 100 - BREAKDOWN_WEAR_THRESHOLD;
  return ((value - BREAKDOWN_WEAR_THRESHOLD) / span) * 0.35;
}

/** Déclenche ou non une panne à partir d'un tirage déterministe 0..1. */
export function rollBreakdown(wear: number, cooldownDays: number, sample: number): boolean {
  if (cooldownDays > 0) return false;
  const chance = breakdownChance(wear);
  if (chance <= 0) return false;
  return sample < chance;
}

/** Passe à la phase suivante d'une panne ; renvoie l'état résultant. */
export function advanceBreakdown(
  breakdown: BreakdownState,
  ticks: number,
): { breakdown: BreakdownState; breakdownTicks: number } {
  if (breakdown === 'none' || ticks <= 0) return { breakdown: 'none', breakdownTicks: 0 };
  const remaining = ticks - 1;
  if (breakdown === 'slowing') {
    if (remaining > 0) return { breakdown: 'slowing', breakdownTicks: remaining };
    return { breakdown: 'stopped', breakdownTicks: BREAKDOWN_STOP_TICKS };
  }
  return remaining > 0
    ? { breakdown: 'stopped', breakdownTicks: remaining }
    : { breakdown: 'none', breakdownTicks: 0 };
}

/** Facteur de vitesse appliqué pendant une panne. */
export function breakdownSpeedFactor(breakdown: BreakdownState): number {
  if (breakdown === 'stopped') return 0;
  if (breakdown === 'slowing') return 0.35;
  return 1;
}

/**
 * Coût d'un service au dépôt : quote-part de l'entretien annuel, majorée quand
 * le véhicule a dépassé son intervalle. Le moteur reste seul juge du débit.
 */
export function serviceCost(
  maintenancePerYear: number,
  daysSinceService: number,
  serviceIntervalDays = DEFAULT_SERVICE_INTERVAL_DAYS,
): number {
  const base = Math.max(180, maintenancePerYear * 0.35);
  const overdue = Math.max(0, daysSinceService - clampServiceInterval(serviceIntervalDays));
  const penalty = 1 + Math.min(0.5, overdue / Math.max(1, serviceIntervalDays));
  return Math.round(base * penalty);
}

/** Le véhicule doit-il être révisé (usure ou intervalle dépassé) ? */
export function needsService(track: ReliabilityTrack, daysSinceService: number): boolean {
  return (
    track.wear >= BREAKDOWN_WEAR_THRESHOLD ||
    daysSinceService >= clampServiceInterval(track.serviceIntervalDays)
  );
}

/** Un remplacement automatique doit-il s'appliquer à ce véhicule ? */
export function shouldAutoreplace(
  ageDays: number,
  wear: number,
  whenOld: boolean,
  daysSinceService = 0,
): boolean {
  if (!whenOld) {
    return ageDays >= AUTOREPLACE_ALWAYS_DAYS || wear >= BREAKDOWN_WEAR_THRESHOLD;
  }
  return (
    ageDays >= AUTOREPLACE_WHEN_OLD_DAYS ||
    wear >= AUTOREPLACE_WEAR_THRESHOLD ||
    daysSinceService >= MAX_SERVICE_INTERVAL_DAYS
  );
}

/** Vue protocole d'un état d'usure, pour le snapshot. */
export function reliabilitySnapshot(
  track: ReliabilityTrack,
  maintenancePerYear: number,
  tick: number,
  ticksPerDay: number,
): VehicleReliabilitySnapshot {
  const daysSinceService =
    track.lastServiceTick === null
      ? Math.max(0, Math.round(tick / Math.max(1, ticksPerDay)))
      : Math.max(0, Math.floor((tick - track.lastServiceTick) / Math.max(1, ticksPerDay)));
  return {
    wear: Math.round(clampWear(track.wear)),
    reliability: reliabilityPercent(track.wear),
    breakdown: track.breakdown,
    breakdownTicks: Math.max(0, Math.round(track.breakdownTicks)),
    lastServiceTick: track.lastServiceTick,
    serviceIntervalDays: clampServiceInterval(track.serviceIntervalDays),
    daysSinceService,
    maintenancePerYear: Math.max(0, Math.round(maintenancePerYear)),
  };
}
