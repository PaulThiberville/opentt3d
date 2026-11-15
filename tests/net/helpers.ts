import type { NetSession, Runner } from '../../src/net/session.js';
import type { Command } from '../../src/net/types.js';
import type { EngineCommand } from '../../src/engine/protocol.js';

/**
 * Deterministic runner used by the network tests: it folds every executed
 * command into a 32-bit FNV hash. Any divergence in commands, order or tick
 * therefore changes `hash()`.
 */
export class MockRunner implements Runner {
  private currentTick = 0;
  private state = 0x811c9dc5;
  /** When set, the state is corrupted once while executing this tick. */
  corruptAt: number | null = null;
  executedTicks = 0;

  tick(): number {
    return this.currentTick;
  }

  step(commands: Command[]): void {
    if (this.corruptAt !== null && this.currentTick === this.corruptAt) {
      this.state = (this.state ^ 0x9e3779b9) >>> 0;
      this.corruptAt = null;
    }
    for (const command of commands) {
      const text = JSON.stringify(command);
      for (let i = 0; i < text.length; i++) {
        this.state ^= text.charCodeAt(i);
        this.state = Math.imul(this.state, 0x01000193) >>> 0;
      }
      this.state = Math.imul(this.state ^ this.currentTick, 0x01000193) >>> 0;
    }
    this.currentTick += 1;
    this.executedTicks += 1;
  }

  hash(): string {
    return `${this.currentTick}:${this.state.toString(16).padStart(8, '0')}`;
  }

  serialize(): string {
    return JSON.stringify({ tick: this.currentTick, state: this.state });
  }

  load(data: string): void {
    const parsed = JSON.parse(data) as { tick?: unknown; state?: unknown };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.tick !== 'number' ||
      typeof parsed.state !== 'number'
    ) {
      throw new Error('sauvegarde invalide');
    }
    this.currentTick = parsed.tick;
    this.state = parsed.state;
  }
}

export interface DriveOptions {
  /** Called before each session update; return a command to issue. */
  issue?: (session: NetSession, index: number, now: number) => EngineCommand | undefined;
  stepMs?: number;
  maxSteps?: number;
  startNow?: number;
}

/**
 * Steps every session with a synthetic clock until all reach `targetTick`.
 * Sessions that already reached the target are not updated any more, so the
 * final tick comparison is meaningful.
 */
export function drive(
  sessions: NetSession[],
  targetTick: number,
  options: DriveOptions = {},
): number {
  let now = options.startNow ?? 0;
  const stepMs = options.stepMs ?? 10;
  const maxSteps = options.maxSteps ?? 500_000;

  for (let step = 0; step < maxSteps; step++) {
    const laggards = sessions.filter((session) => session.stats().tick < targetTick);
    if (laggards.length === 0) return now;
    for (let index = 0; index < sessions.length; index++) {
      const session = sessions[index];
      if (!session) continue;
      if (session.stats().tick >= targetTick) continue;
      const command = options.issue?.(session, index, now);
      if (command) session.issue(command);
      session.update(now);
    }
    now += stepMs;
  }
  throw new Error(`drive() n'a pas atteint le tick ${targetTick}`);
}

export function hashes(sessions: NetSession[], runners: MockRunner[]): string[] {
  return runners.map((runner, index) => {
    const session = sessions[index];
    if (!session) throw new Error('session manquante');
    return `${session.stats().tick}:${runner.hash()}`;
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(intervalMs);
  }
  throw new Error('Condition non satisfaite dans le délai imparti');
}
