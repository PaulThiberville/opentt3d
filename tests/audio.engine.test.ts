import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, type AudioEngineOptions } from '../src/audio/AudioEngine';
import { createFakeContext } from './fixtures/fakeAudio';

function createEngine(overrides: Partial<AudioEngineOptions> = {}) {
  const context = createFakeContext();
  const engine = new AudioEngine({
    contextFactory: () => context,
    music: false,
    volumes: { master: 70, effects: 80, music: 40 },
    ...overrides,
  });
  return { engine, context };
}

describe('AudioEngine', () => {
  it('ne crée le contexte qu’au premier geste (unlock)', () => {
    const { engine, context } = createEngine();
    expect(context.gains).toHaveLength(0);
    expect(engine.play('ui.click')).toBe(false);
    engine.unlock();
    expect(engine.isUnlocked).toBe(true);
    expect(context.gains.length).toBeGreaterThan(0);
    expect(context.resumeCalls).toBe(1);
  });

  it('diffère le buffer de bruit et les couches d’ambiance hors du geste', () => {
    const { engine, context } = createEngine({ music: true });
    engine.unlock();
    // Le contexte, le master et le bus d'effets sont immédiats…
    expect(context.gains.length).toBeGreaterThan(0);
    expect(engine.isLayersReady).toBe(false);
    // …mais aucun sample ni oscillateur n'est construit dans le pointerdown.
    expect(context.buffersCreated).toBe(0);
    expect(context.sources).toHaveLength(0);
    expect(context.oscillators).toHaveLength(0);

    engine.flushDeferredGraph();
    expect(engine.isLayersReady).toBe(true);
    expect(context.buffersCreated).toBe(1);
    expect(context.sources.length).toBeGreaterThanOrEqual(2);
    expect(context.oscillators.length).toBeGreaterThan(0);
    engine.dispose();
  });

  it('construit le graphe différé au premier update sans bloquer unlock', () => {
    const { engine, context } = createEngine();
    engine.unlock();
    expect(engine.isLayersReady).toBe(false);
    engine.setGameplay(true);
    engine.update(0.1);
    expect(engine.isLayersReady).toBe(true);
    expect(context.buffersCreated).toBe(1);
    engine.dispose();
  });

  it('applique les volumes master/effets/musique', () => {
    const { engine, context } = createEngine();
    engine.unlock();
    const master = context.gains[0];
    engine.setVolumes({ master: 50, effects: 25, music: 0 });
    expect(master?.gain.value).toBeCloseTo(0.5);
    expect(engine.currentVolumes).toEqual({ master: 50, effects: 25, music: 0 });
  });

  it('coupe le master au mute et au retour', () => {
    const { engine, context } = createEngine();
    engine.unlock();
    const master = context.gains[0];
    engine.setMuted(true);
    expect(master?.gain.value).toBe(0);
    expect(engine.play('ui.click')).toBe(false);
    engine.setMuted(false);
    expect(master?.gain.value).toBeCloseTo(0.7);
  });

  it('suspend le contexte quand l’onglet est caché et reprend au retour', () => {
    const { engine, context } = createEngine();
    engine.unlock();
    const master = context.gains[0];
    engine.setTabHidden(true);
    expect(context.suspendCalls).toBe(1);
    expect(master?.gain.value).toBe(0);
    engine.setTabHidden(false);
    expect(context.resumeCalls).toBeGreaterThan(1);
    expect(master?.gain.value).toBeCloseTo(0.7);
  });

  it('coupe le son à la perte de focus', () => {
    const { engine, context } = createEngine();
    engine.unlock();
    const master = context.gains[0];
    engine.setFocused(false);
    expect(master?.gain.value).toBe(0);
    expect(engine.play('ui.click')).toBe(false);
    engine.setFocused(true);
    expect(master?.gain.value).toBeCloseTo(0.7);
  });

  it('autorise les clics UI en pause mais pas les sons de jeu', () => {
    const { engine } = createEngine({ now: () => 1000 });
    engine.unlock();
    engine.setGameplay(true);
    engine.setPaused(true);
    expect(engine.play('ui.click')).toBe(true);
    expect(engine.play('build.road')).toBe(false);
  });

  it('joue un son spatialisé avec panoramique', () => {
    const { engine, context } = createEngine({ now: () => 1000 });
    engine.unlock();
    engine.setGameplay(true);
    const played = engine.play('train.pass', { gain: 0.8, pan: 0.5 });
    expect(played).toBe(true);
    expect(context.panners).toHaveLength(1);
    expect(context.panners[0]?.pan.value).toBeCloseTo(0.5);
  });

  it('throttle les sons répétés', () => {
    let now = 0;
    const { engine } = createEngine({ now: () => now });
    engine.unlock();
    engine.setGameplay(true);
    expect(engine.play('build.rail')).toBe(true);
    now = 20;
    expect(engine.play('build.rail')).toBe(false);
    now = 200;
    expect(engine.play('build.rail')).toBe(true);
  });

  it('programme des oiseaux le jour et des grillons la nuit', () => {
    const tick = (engine: AudioEngine): void => {
      engine.update(1);
      engine.update(1);
    };

    const day = createEngine();
    day.engine.unlock();
    day.engine.setGameplay(true);
    day.engine.setAmbience({ night: 0, daylight: 1, water: 0, quality: 'medium' });
    tick(day.engine);
    expect(day.context.oscillators.length).toBeGreaterThan(0);

    const night = createEngine();
    night.engine.unlock();
    night.engine.setGameplay(true);
    night.engine.setAmbience({ night: 1, daylight: 0, water: 1, quality: 'high' });
    tick(night.engine);
    expect(night.context.oscillators.length).toBeGreaterThan(0);

    const low = createEngine();
    low.engine.unlock();
    low.engine.setGameplay(true);
    low.engine.setAmbience({ night: 0, daylight: 1, water: 0, quality: 'low' });
    tick(low.engine);
    expect(low.context.oscillators).toHaveLength(0);
  });

  it('n’émet plus rien après dispose et ferme le contexte une fois', () => {
    const { engine, context } = createEngine();
    engine.unlock();
    engine.setGameplay(true);
    engine.dispose();
    engine.dispose();
    expect(context.closeCalls).toBe(1);
    expect(engine.play('ui.click')).toBe(false);
  });

  it('notifie les abonnés lors d’un changement de mute', () => {
    const { engine } = createEngine();
    const listener = vi.fn();
    const off = engine.subscribe(listener);
    engine.setMuted(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    engine.setMuted(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
