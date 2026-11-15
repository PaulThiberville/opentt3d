/**
 * Horloge visuelle du cycle jour/nuit.
 *
 * Le cycle d'OpenTTD (74 ticks par jour) sert au calendrier du jeu, pas au
 * rendu : à vitesse normale, une journée complète s'écoule en quelques
 * secondes et l'éclairage clignote. On découple donc l'heure **visuelle** du
 * tick moteur :
 *
 * - la phase est un temps réel continu, indépendant de la vitesse de jeu ;
 * - un cycle complet dure `cycleSeconds` secondes (120 s par défaut, soit deux
 *   minutes pour une journée) ;
 * - désactivé, le cycle est figé à midi (phase 0,5) pour garder une scène
 *   lisible ;
 * - en pause, l'heure se fige avec le jeu.
 *
 * Aucune dépendance Three.js/DOM : testable sous Node.
 */

import { clamp01, sunState, wrap01 } from './dayNight';

/** Durée par défaut d'une journée visuelle complète. */
export const DEFAULT_DAY_NIGHT_CYCLE_SECONDS = 120;
export const MIN_DAY_NIGHT_CYCLE_SECONDS = 30;
export const MAX_DAY_NIGHT_CYCLE_SECONDS = 900;
/** Phase de repli quand le cycle est désactivé (0,5 = midi). */
export const DISABLED_DAY_NIGHT_PHASE = 0.5;
/** Phase initiale avant le premier snapshot (matinée, cohérente avec le rendu). */
export const DEFAULT_DAY_NIGHT_PHASE = 0.45;

/** Normalise une durée de cycle inconnue dans les bornes autorisées. */
export function sanitizeCycleSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DAY_NIGHT_CYCLE_SECONDS;
  }
  return Math.round(
    Math.max(MIN_DAY_NIGHT_CYCLE_SECONDS, Math.min(MAX_DAY_NIGHT_CYCLE_SECONDS, value)),
  );
}

/**
 * Ramène une phase de départ nocturne vers une fin de matinée lisible.
 * Les parties neuves du moteur peuvent démarrer à une heure arbitraire :
 * l'ambiance ne doit pas ouvrir sur un écran noir.
 */
export function ensureDaytimePhase(phase: number, fallback = DEFAULT_DAY_NIGHT_PHASE): number {
  const normalized = wrap01(phase);
  return sunState(normalized).night > 0.35 ? fallback : normalized;
}

export interface DayNightCycleOptions {
  enabled?: boolean;
  cycleSeconds?: number;
  /** Phase de départ dans [0, 1). */
  phase?: number;
}

/**
 * Phase visuelle continue, indépendante du calendrier moteur.
 *
 * `advance()` est appelé à chaque frame ; il renvoie toujours la phase à
 * appliquer au rendu, y compris quand le cycle est désactivé ou en pause.
 */
export class DayNightCycle {
  private value: number;
  private enabled: boolean;
  private seconds: number;
  private paused = false;

  constructor(options: DayNightCycleOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.seconds = sanitizeCycleSeconds(options.cycleSeconds);
    this.value = this.enabled
      ? wrap01(options.phase ?? DEFAULT_DAY_NIGHT_PHASE)
      : DISABLED_DAY_NIGHT_PHASE;
  }

  get phase(): number {
    return this.value;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get cycleSeconds(): number {
    return this.seconds;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Change la phase sans attendre le prochain pas de temps. */
  setPhase(phase: number): void {
    if (!this.enabled) return;
    if (!Number.isFinite(phase)) return;
    this.value = wrap01(phase);
  }

  /**
   * Active ou fige le cycle. Désactivé, la phase est verrouillée à midi ;
   * réactivé, le cycle repart de cette phase.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.value = DISABLED_DAY_NIGHT_PHASE;
  }

  setCycleSeconds(seconds: number): void {
    this.seconds = sanitizeCycleSeconds(seconds);
  }

  /** Fige l'heure avec le jeu (pause, menu). */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Avance l'horloge de `deltaSeconds` et renvoie la phase courante. */
  advance(deltaSeconds: number): number {
    if (!this.enabled || this.paused) return this.value;
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    if (delta > 0) this.value = wrap01(this.value + delta / this.seconds);
    return this.value;
  }

  /** Progression du cycle dans [0, 1), utile aux tests et au HUD debug. */
  get progress(): number {
    return wrap01(this.value);
  }

  /** Durée restante avant minuit, en secondes (cycle actif). */
  get secondsToMidnight(): number {
    if (!this.enabled) return 0;
    return clamp01(1 - this.value) * this.seconds;
  }
}
