import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/audio/AudioEngine';
import { SessionAudio } from '../src/audio/sessionAudio';
import { EventBus } from '../src/game/EventBus';
import type { Game, GameEvents } from '../src/game/Game';
import { DEFAULT_SETTINGS } from '../src/ui/settings';
import { createFakeContext } from './fixtures/fakeAudio';

function attachSession() {
  const context = createFakeContext();
  const engine = new AudioEngine({ contextFactory: () => context, music: false });
  const session = new SessionAudio({
    engine,
    quality: 'medium',
    settings: DEFAULT_SETTINGS,
    now: () => 1000,
  });
  const bus = new EventBus<GameEvents>();
  const game = { events: bus } as unknown as Game;
  engine.unlock();
  session.attach(game);
  return { context, engine, session, bus };
}

describe('SessionAudio', () => {
  it('branche les commandes et notifications sur le moteur', () => {
    const { context, session, bus } = attachSession();
    const before = context.gains.length;
    bus.emit('command', {
      command: { type: 'vehicle', action: 'buy', company: 0, depotId: 1 },
    });
    expect(context.gains.length).toBeGreaterThan(before);

    const afterCommand = context.gains.length;
    bus.emit('notify', { kind: 'info', text: 'Monde généré', tick: 0 });
    expect(context.gains.length).toBe(afterCommand);

    bus.emit('notify', { kind: 'warning', text: 'Voie occupée', tick: 1 });
    expect(context.gains.length).toBeGreaterThan(afterCommand);
    session.dispose();
  });

  it('n’émet pas de sons de jeu en pause mais laisse les clics UI', () => {
    const { context, engine, session, bus } = attachSession();
    session.setPaused(true);
    const before = context.gains.length;
    bus.emit('command', {
      command: { type: 'build', tool: 'road', company: 0, from: { x: 0, y: 0 } },
    });
    expect(context.gains.length).toBe(before);
    expect(engine.play('ui.click')).toBe(true);
    session.dispose();
  });

  it('se détache sans fermer un moteur partagé', () => {
    const { context, engine, session, bus } = attachSession();
    session.dispose();
    const before = context.gains.length;
    bus.emit('notify', { kind: 'error', text: 'boum', tick: 2 });
    expect(context.gains.length).toBe(before);
    expect(context.closeCalls).toBe(0);
    expect(engine.play('ui.click')).toBe(true);
  });
});
