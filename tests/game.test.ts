import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Game } from '../src/game/Game';
import { MockEngine } from '../src/engine/MockEngine';
import type { NotifyKind, Selection } from '../src/game/Game';

const FRAME = 1 / 60;

async function setup(): Promise<Game> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed: 4242, width: 128, height: 128 });
  const game = new Game({ driver: engine, clock: () => Date.now() });
  return game;
}

describe('Game : accumulation et snapshots', () => {
  let game: Game;

  beforeEach(async () => {
    game = await setup();
    game.start();
  });

  afterEach(() => {
    game.dispose();
  });

  it('capture un snapshot initial', () => {
    const snapshot = game.getLatestSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.meta.tick).toBe(0);
    expect(game.getTick()).toBe(0);
    expect(game.getSnapshotBuffer()).toHaveLength(1);
  });

  it('avance de 30 ticks par seconde simulée', () => {
    // maxDeltaSeconds vaut 0,25 s : quatre frames couvrent une seconde.
    for (let i = 0; i < 4; i += 1) game.advance(0.25);
    expect(game.getTick()).toBe(30);
  });

  it('produit un snapshot toutes les 6 ticks (5 Hz)', () => {
    const snapshots: number[] = [];
    game.events.on('snapshot', ({ snapshot }) => snapshots.push(snapshot.meta.tick));
    game.advance(0.2);
    expect(snapshots).toContain(6);
    expect(game.getInterpolation().from).not.toBeNull();
    expect(game.getInterpolation().to).not.toBeNull();
  });

  it('garde alpha dans [0, 1] et progresse entre deux snapshots', () => {
    game.advance(0.4);
    const alphas: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      game.advance(FRAME);
      const alpha = game.getInterpolation().alpha;
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThanOrEqual(1);
      alphas.push(alpha);
    }
    expect(new Set(alphas).size).toBeGreaterThan(5);
  });

  it('se met en pause et reprend', () => {
    game.advance(0.2);
    const tick = game.getTick();
    game.setPaused(true);
    expect(game.isPaused()).toBe(true);
    game.advance(0.5);
    expect(game.getTick()).toBe(tick);
    game.setPaused(false);
    game.advance(0.2);
    expect(game.getTick()).toBeGreaterThan(tick);
  });

  it('double la vitesse en mode 2×', () => {
    game.setSpeed(2);
    game.advance(0.25);
    expect(game.getTick()).toBe(15);
    game.setSpeed(0);
    const tick = game.getTick();
    game.advance(1);
    expect(game.getTick()).toBe(tick);
    expect(game.isPaused()).toBe(true);
  });

  it('émet sim:tick avec le nombre de ticks exécutés', () => {
    let executed = 0;
    game.events.on('sim:tick', (payload) => {
      executed += payload.ticks;
    });
    game.advance(0.25);
    expect(executed).toBe(game.getTick());
  });

  it('borne le delta pour éviter une avalanche après un onglet caché', () => {
    game.advance(10);
    expect(game.getTick()).toBeLessThanOrEqual(Math.ceil(30 * 0.25) + 1);
  });

  it('relaie les nouvelles du snapshot initial en notifications', async () => {
    const engine = new MockEngine();
    await engine.init({ moduleUrl: 'mock://engine' });
    await engine.newGame({ seed: 9, width: 96, height: 96 });
    const kinds: NotifyKind[] = [];
    const fresh = new Game({ driver: engine, clock: () => Date.now() });
    fresh.events.on('notify', ({ kind }) => kinds.push(kind));
    fresh.start();
    expect(kinds.length).toBeGreaterThan(0);
    fresh.dispose();
  });

  it('gère la sélection et n’émet que sur changement', () => {
    const selections: (Selection | null)[] = [];
    game.events.on('selection', ({ selection }) => selections.push(selection));
    game.select({ kind: 'vehicle', id: 3 });
    game.select({ kind: 'vehicle', id: 3 });
    game.select(null);
    expect(selections).toEqual([{ kind: 'vehicle', id: 3 }, null]);
    expect(game.getSelection()).toBeNull();
  });

  it('ne fuit pas après dispose', () => {
    const listeners = game.events.count();
    expect(listeners).toBeGreaterThanOrEqual(0);
    game.dispose();
    expect(game.events.count()).toBe(0);
    expect(game.isRunning()).toBe(false);
    game.advance(1);
    expect(game.getLatestSnapshot()).toBeNull();
  });
});
