/**
 * Boucle de jeu indépendante de Three.js et du DOM.
 *
 * Le moteur (WASM ou mock) est injecté via `EngineDriver`, l'horloge aussi.
 * `Game` ne fait que :
 *  - accumuler le temps réel et appeler `driver.step()` à 30 ticks/s ;
 *  - demander un snapshot à 5 Hz et conserver les deux derniers pour
 *    l'interpolation (`alpha`) à 60 fps ;
 *  - relayer les nouvelles du monde et la sélection vers l'UI.
 *
 * Les tests utilisent une horloge factice et le `MockEngine` : aucun DOM.
 */

import type { EngineDriver, WorldSnapshot } from '../engine/protocol';
import { EventBus } from './EventBus';
import { clamp } from './interpolation';

export type GameSpeed = 0 | 1 | 2;

export type SelectionKind = 'vehicle' | 'town' | 'industry' | 'station' | 'tile';

export interface Selection {
  kind: SelectionKind;
  id: number;
}

export interface TimedSnapshot {
  /** Temps de simulation (secondes) auquel le snapshot a été pris. */
  time: number;
  snapshot: WorldSnapshot;
}

export interface InterpolationState {
  from: WorldSnapshot | null;
  to: WorldSnapshot | null;
  /** Position d'affichage entre `from` et `to`, dans [0, 1]. */
  alpha: number;
}

export type NotifyKind = 'info' | 'warning' | 'error' | 'company';

export interface GameEvents {
  'sim:tick': { tick: number; ticks: number; simTime: number };
  snapshot: { snapshot: WorldSnapshot; interpolation: InterpolationState };
  selection: { selection: Selection | null };
  notify: { kind: NotifyKind; text: string; tick: number };
  state: { paused: boolean; speed: GameSpeed; tick: number };
}

export interface GameOptions {
  driver: EngineDriver;
  /** Horloge en millisecondes (défaut : performance.now, sinon Date.now). */
  clock?: () => number;
  ticksPerSecond?: number;
  /** Fréquence des snapshots, en Hz. */
  snapshotRate?: number;
  /** Delta maximal accepté entre deux frames (sécurité onglet caché). */
  maxDeltaSeconds?: number;
}

export const DEFAULT_TICKS_PER_SECOND = 30;
export const DEFAULT_SNAPSHOT_RATE = 5;
const SNAPSHOT_BUFFER_SIZE = 6;

function defaultClock(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly driver: EngineDriver;
  readonly ticksPerSecond: number;
  readonly snapshotRate: number;
  readonly maxDeltaSeconds: number;

  /** Nombre de ticks moteur entre deux snapshots (6 à 30 Hz / 5 Hz). */
  readonly snapshotEveryTicks: number;
  /** Retard d'interpolation : on affiche l'état d'il y a un intervalle. */
  readonly interpolationLag: number;

  private clock: () => number;
  private accumulator = 0;
  private simTime = 0;
  private tick = 0;
  private lastSnapshotTick = -1;
  private running = false;
  private paused = false;
  private speed: GameSpeed = 1;
  private selection: Selection | null = null;
  private fps = 60;
  private lastFrameTime = 0;
  private disposed = false;
  private buffer: TimedSnapshot[] = [];
  private interpolation: InterpolationState = { from: null, to: null, alpha: 0 };

  constructor(options: GameOptions) {
    this.driver = options.driver;
    this.clock = options.clock ?? defaultClock;
    this.ticksPerSecond = Math.max(1, options.ticksPerSecond ?? DEFAULT_TICKS_PER_SECOND);
    this.snapshotRate = Math.max(0.2, options.snapshotRate ?? DEFAULT_SNAPSHOT_RATE);
    this.maxDeltaSeconds = Math.max(0.01, options.maxDeltaSeconds ?? 0.25);
    this.snapshotEveryTicks = Math.max(1, Math.round(this.ticksPerSecond / this.snapshotRate));
    this.interpolationLag = this.snapshotEveryTicks / this.ticksPerSecond;
  }

  /** Démarre la boucle et capture le snapshot initial. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameTime = this.clock();
    const status = this.driver.status();
    this.tick = status.tick;
    this.simTime = this.tick / this.ticksPerSecond;
    this.paused = status.paused;
    this.speed = status.speed === 0 ? 1 : (status.speed as GameSpeed);
    this.takeSnapshot();
  }

  /** Arrête la boucle sans libérer le moteur (utile pour les tests). */
  stop(): void {
    this.running = false;
    this.accumulator = 0;
  }

  /**
   * Avance la simulation. Sans argument, le delta est calculé depuis l'horloge
   * injectée ; le renderer fournit normalement le delta borné de la rAF.
   */
  advance(deltaSeconds?: number): void {
    if (!this.running || this.disposed) return;
    const now = this.clock();
    let delta: number;
    if (deltaSeconds === undefined) {
      delta = this.lastFrameTime === 0 ? 0 : (now - this.lastFrameTime) / 1000;
    } else {
      delta = deltaSeconds;
    }
    this.lastFrameTime = now;
    if (!Number.isFinite(delta) || delta <= 0) {
      this.refreshInterpolation();
      return;
    }
    delta = Math.min(delta, this.maxDeltaSeconds);
    const instant = 1 / Math.max(delta, 1 / 240);
    this.fps = this.fps * 0.9 + instant * 0.1;

    const speed = this.effectiveSpeed();
    if (speed === 0) {
      this.refreshInterpolation();
      return;
    }

    this.accumulator += delta * speed;
    const maxTicks = Math.max(1, Math.ceil(this.ticksPerSecond * this.maxDeltaSeconds * speed));
    let due = Math.floor(this.accumulator * this.ticksPerSecond + 1e-6);
    if (due > maxTicks) {
      due = maxTicks;
      this.accumulator = due / this.ticksPerSecond;
    } else {
      this.accumulator -= due / this.ticksPerSecond;
    }

    if (due > 0) {
      const executed = this.driver.step(due);
      if (executed > 0) {
        this.tick += executed;
        this.simTime = this.tick / this.ticksPerSecond;
        this.events.emit('sim:tick', { tick: this.tick, ticks: executed, simTime: this.simTime });
        if (this.tick - this.lastSnapshotTick >= this.snapshotEveryTicks) this.takeSnapshot();
      }
    }
    this.refreshInterpolation();
  }

  /** Force un snapshot immédiat (après un chargement, par exemple). */
  refresh(): WorldSnapshot {
    this.takeSnapshot();
    this.refreshInterpolation();
    return this.latestSnapshot();
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    this.driver.send({ type: 'pause', paused });
    this.emitState();
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  setSpeed(speed: GameSpeed): void {
    if (this.disposed) return;
    const next: GameSpeed = speed === 0 ? 0 : speed === 2 ? 2 : 1;
    this.speed = next;
    this.paused = next === 0;
    this.driver.send({ type: 'speed', speed: next });
    this.driver.send({ type: 'pause', paused: this.paused });
    this.emitState();
  }

  getSpeed(): GameSpeed {
    return this.speed;
  }

  isPaused(): boolean {
    return this.paused || this.speed === 0;
  }

  effectiveSpeed(): GameSpeed {
    if (this.paused || this.speed === 0) return 0;
    return this.speed;
  }

  select(selection: Selection | null): void {
    if (this.disposed) return;
    if (
      selection &&
      this.selection &&
      selection.kind === this.selection.kind &&
      selection.id === this.selection.id
    ) {
      return;
    }
    this.selection = selection;
    this.events.emit('selection', { selection });
  }

  getSelection(): Selection | null {
    return this.selection;
  }

  getTick(): number {
    return this.tick;
  }

  getSimTime(): number {
    return this.simTime;
  }

  getFps(): number {
    return this.fps;
  }

  getInterpolation(): InterpolationState {
    return this.interpolation;
  }

  getLatestSnapshot(): WorldSnapshot | null {
    return this.buffer.length > 0 ? (this.buffer[this.buffer.length - 1]?.snapshot ?? null) : null;
  }

  getSnapshotBuffer(): readonly TimedSnapshot[] {
    return this.buffer;
  }

  isRunning(): boolean {
    return this.running;
  }

  private latestSnapshot(): WorldSnapshot {
    const snap = this.getLatestSnapshot();
    if (!snap) throw new Error('Game.refresh : aucun snapshot disponible.');
    return snap;
  }

  private emitState(): void {
    this.events.emit('state', { paused: this.isPaused(), speed: this.speed, tick: this.tick });
  }

  private takeSnapshot(): void {
    let snapshot: WorldSnapshot;
    try {
      snapshot = this.driver.snapshot();
    } catch (error) {
      this.events.emit('notify', {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
        tick: this.tick,
      });
      return;
    }
    const time = this.tick / this.ticksPerSecond;
    this.lastSnapshotTick = this.tick;
    this.buffer.push({ time, snapshot });
    if (this.buffer.length > SNAPSHOT_BUFFER_SIZE) this.buffer.shift();

    this.events.emit('snapshot', { snapshot, interpolation: this.interpolation });
    for (const news of snapshot.news) {
      this.events.emit('notify', { kind: news.kind, text: news.text, tick: news.tick });
    }
  }

  private refreshInterpolation(): void {
    const buffer = this.buffer;
    if (buffer.length === 0) {
      this.interpolation = { from: null, to: null, alpha: 0 };
      return;
    }
    if (buffer.length === 1) {
      const only = buffer[0];
      this.interpolation = { from: only?.snapshot ?? null, to: only?.snapshot ?? null, alpha: 0 };
      return;
    }
    const renderTime = Math.max(0, this.simTime - this.interpolationLag);
    let from = buffer[0];
    let to = buffer[buffer.length - 1];
    if (from && to) {
      for (let i = 0; i < buffer.length - 1; i += 1) {
        const a = buffer[i];
        const b = buffer[i + 1];
        if (!a || !b) continue;
        if (renderTime >= a.time && renderTime <= b.time) {
          from = a;
          to = b;
          break;
        }
        if (renderTime > b.time) {
          from = a;
          to = b;
        }
      }
    }
    if (!from || !to) {
      this.interpolation = { from: null, to: null, alpha: 0 };
      return;
    }
    const span = to.time - from.time;
    const alpha = span <= 0 ? 1 : clamp((renderTime - from.time) / span, 0, 1);
    this.interpolation = { from: from.snapshot, to: to.snapshot, alpha };
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.buffer = [];
    this.interpolation = { from: null, to: null, alpha: 0 };
    this.selection = null;
    this.events.clear();
    this.driver.dispose();
  }
}
