/**
 * Anti-rafale par son, en temps réel (millisecondes).
 *
 * Le survol de boutons et les rafales de news peuvent déclencher des dizaines
 * d'événements par seconde : chaque son possède une fenêtre minimale. Les sons
 * non listés retombent sur `defaultIntervalMs` (0 = pas de limite).
 */

import type { SoundId } from './soundIds';

export type ThrottleLimits = Partial<Record<SoundId, number>>;

export const DEFAULT_THROTTLE_MS: ThrottleLimits = {
  'ui.click': 45,
  'ui.hover': 90,
  'ui.notify': 350,
  'ui.error': 500,
  'build.road': 80,
  'build.rail': 80,
  'build.station': 250,
  'build.depot': 250,
  'build.clear': 80,
  'vehicle.buy': 250,
  'vehicle.start': 250,
  'vehicle.stop': 250,
  'vehicle.sell': 250,
  'money.in': 900,
  'money.out': 900,
  alert: 1200,
  'train.pass': 3000,
  'bus.pass': 2600,
};

export class SoundThrottle {
  private limits: ThrottleLimits;
  private defaultIntervalMs: number;
  private lastPlayed = new Map<SoundId, number>();

  constructor(limits: ThrottleLimits = DEFAULT_THROTTLE_MS, defaultIntervalMs = 0) {
    this.limits = { ...limits };
    this.defaultIntervalMs = Math.max(0, defaultIntervalMs);
  }

  /** Indique si le son peut être joué à `nowMs` ; mémorise l'instant si oui. */
  allow(id: SoundId, nowMs: number): boolean {
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const interval = Math.max(0, this.limits[id] ?? this.defaultIntervalMs);
    const previous = this.lastPlayed.get(id);
    if (previous !== undefined && now - previous < interval) return false;
    this.lastPlayed.set(id, now);
    return true;
  }

  /** Dernier instant autorisé pour un son (debug et tests). */
  last(id: SoundId): number | null {
    return this.lastPlayed.get(id) ?? null;
  }

  reset(): void {
    this.lastPlayed.clear();
  }
}
