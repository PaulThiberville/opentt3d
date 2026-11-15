import { describe, expect, it } from 'vitest';
import type { EngineArtifacts } from '../src/engine/engineAssets';
import {
  engineArtifactsStatusKey,
  engineArtifactsStatusVars,
  engineChoiceOptions,
  isEngineChoiceAvailable,
  resolveEngineChoice,
} from '../src/ui/engineChoice';

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

describe('choix du moteur côté UI (#78)', () => {
  it('propose exactement mock et wasm', () => {
    const options = engineChoiceOptions(null);
    expect(options.map((option) => option.value)).toEqual(['mock', 'wasm']);
    expect(options.every((option) => option.labelKey.startsWith('engine.'))).toBe(true);
    expect(options.every((option) => option.buildId.includes('opentt3d-'))).toBe(true);
  });

  it('désactive WASM uniquement quand les artefacts sont confirmés absents', () => {
    const missing = engineChoiceOptions(artifacts('missing'));
    expect(missing.find((option) => option.value === 'mock')?.disabled).toBe(false);
    const wasm = missing.find((option) => option.value === 'wasm');
    expect(wasm?.disabled).toBe(true);
    expect(wasm?.reasonKey).toBe('engine.option.missing');

    const network = engineChoiceOptions(artifacts('network'));
    expect(network.find((option) => option.value === 'wasm')?.disabled).toBe(false);
    expect(network.find((option) => option.value === 'wasm')?.reasonKey).toBe(
      'engine.option.network',
    );

    const checking = engineChoiceOptions(null);
    expect(checking.find((option) => option.value === 'wasm')?.disabled).toBe(false);
    expect(checking.find((option) => option.value === 'wasm')?.reasonKey).toBeNull();
  });

  it('respecte le réglage persistant et rétrograde le wasm absent', () => {
    const kept = resolveEngineChoice({
      urlMode: null,
      storedMode: 'wasm',
      artifacts: artifacts('available'),
    });
    expect(kept.mode).toBe('wasm');
    expect(kept.locked).toBe(false);
    expect(kept.downgraded).toBe(false);

    const downgraded = resolveEngineChoice({
      urlMode: null,
      storedMode: 'wasm',
      artifacts: artifacts('missing'),
    });
    expect(downgraded.mode).toBe('mock');
    expect(downgraded.downgraded).toBe(true);

    const mock = resolveEngineChoice({
      urlMode: null,
      storedMode: 'mock',
      artifacts: artifacts('available'),
    });
    expect(mock.mode).toBe('mock');
    expect(mock.downgraded).toBe(false);
  });

  it('laisse ?engine= prioritaire, même sans artefacts', () => {
    const forced = resolveEngineChoice({
      urlMode: 'wasm',
      storedMode: 'mock',
      artifacts: artifacts('missing'),
    });
    expect(forced.mode).toBe('wasm');
    expect(forced.locked).toBe(true);
    expect(forced.downgraded).toBe(false);
    expect(forced.options.find((option) => option.value === 'wasm')?.disabled).toBe(true);

    const forcedMock = resolveEngineChoice({
      urlMode: 'mock',
      storedMode: 'wasm',
      artifacts: artifacts('available'),
    });
    expect(forcedMock.mode).toBe('mock');
    expect(forcedMock.locked).toBe(true);
  });

  it('traduit chaque état de détection', () => {
    expect(engineArtifactsStatusKey(null)).toBe('engine.status.checking');
    expect(engineArtifactsStatusKey(artifacts('available'))).toBe('engine.status.available');
    expect(engineArtifactsStatusKey(artifacts('missing'))).toBe('engine.status.missing');
    expect(engineArtifactsStatusKey(artifacts('network'))).toBe('engine.status.network');
    expect(engineArtifactsStatusVars(artifacts('missing')).files).toContain('wasm');
    expect(engineArtifactsStatusVars(null).build).toContain('wasm');
  });

  it('expose un test de disponibilité cohérent avec les options', () => {
    expect(isEngineChoiceAvailable(artifacts('missing'), 'wasm')).toBe(false);
    expect(isEngineChoiceAvailable(artifacts('missing'), 'mock')).toBe(true);
    expect(isEngineChoiceAvailable(artifacts('network'), 'wasm')).toBe(true);
  });
});
