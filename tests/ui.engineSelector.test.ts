import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EngineArtifacts } from '../src/engine/engineAssets';
import { createEngineAvailability } from '../src/ui/engineAvailability';
import { CATALOGS } from '../src/ui/i18n';

const root = join(import.meta.dirname, '..');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

function artifacts(reason: EngineArtifacts['reason']): EngineArtifacts {
  return {
    reason,
    available: reason === 'available',
    missing: reason === 'missing' ? ['opentt3d-engine.wasm'] : [],
    unreachable: reason === 'network' ? ['opentt3d-engine.js'] : [],
    urls: [],
    checkedAt: 0,
  };
}

describe('sélecteur de moteur (#78)', () => {
  it('expose les libellés demandés en français et en anglais', () => {
    expect(CATALOGS.fr['engine.mock.label']).toBe('Mock (démo)');
    expect(CATALOGS.fr['engine.wasm.label']).toBe('OpenTTD réel (expérimental)');
    expect(CATALOGS.en['engine.mock.label']).toBe('Mock (demo)');
    expect(CATALOGS.en['engine.wasm.label']).toBe('Real OpenTTD (experimental)');
    for (const key of [
      'newgame.engine.label',
      'newgame.engine.hint',
      'settings.engine.label',
      'settings.engine.hint',
      'engine.status.checking',
      'engine.status.available',
      'engine.status.missing',
      'engine.status.network',
      'engine.option.missing',
      'engine.option.network',
      'engine.locked.url',
    ] as const) {
      expect(CATALOGS.fr[key]?.trim(), `FR ${key}`).toBeTruthy();
      expect(CATALOGS.en[key]?.trim(), `EN ${key}`).toBeTruthy();
    }
  });

  it('partage la détection entre les écrans sans bloquer le menu', async () => {
    const deferred: { resolve?: (value: EngineArtifacts) => void } = {};
    const detect = vi.fn(
      () =>
        new Promise<EngineArtifacts>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const availability = createEngineAvailability({ detect });
    const seen: string[] = [];
    const unsubscribe = availability.subscribe((value) => seen.push(value.reason));

    expect(availability.get()).toBeNull();
    const first = availability.refresh();
    const second = availability.refresh();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    deferred.resolve?.(artifacts('missing'));
    await first;
    expect(seen).toEqual(['missing']);
    expect(availability.get()?.available).toBe(false);

    unsubscribe();
  });

  it('affiche le sélecteur dans Nouvelle partie et Réglages', () => {
    const newGame = read('src/ui/screens/NewGameScreen.ts');
    expect(newGame).toContain('new EnginePicker');
    expect(newGame).toContain("idPrefix: 'new'");
    expect(newGame).toContain('engineUrlMode');
    expect(newGame).toContain('engineAvailability');
    expect(newGame).toContain('this.enginePicker.selection');
    expect(newGame).toContain("t('newgame.engine.label')");

    const settings = read('src/ui/screens/SettingsScreen.ts');
    expect(settings).toContain('new EnginePicker');
    expect(settings).toContain("idPrefix: 'settings'");
    expect(settings).toContain("t('settings.engine.label')");
    expect(settings).toContain('engineAvailability');
    expect(settings).toContain('this.unsubscribeEngine');

    const picker = read('src/ui/enginePicker.ts');
    expect(picker).toContain("el('fieldset'");
    expect(picker).toContain("el('legend'");
    expect(picker).toContain("'aria-live': 'polite'");
    expect(picker).toContain('input.disabled');
  });

  it('garde l’URL prioritaire et un défaut mock sans casser réseau ni sauvegardes', () => {
    const main = read('src/main.ts');
    expect(main).toContain('let engineMode: EngineMode = engineOverride ?? settings.engine');
    expect(main).toContain('engineMode = engineOverride ?? next.engine');
    expect(main).toContain('void startGame(options, engine)');
    expect(main).toContain('engine: info.settings.engine');
    expect(main).toContain('engine: record.engine');
    expect(main).toContain('engineAvailability.refresh()');

    const session = read('src/ui/gameSession.ts');
    expect(session).toContain('this.network.settings.engine');
    expect(session).toContain("this.loadedGame?.engine ?? options.engine ?? 'mock'");
  });
});
