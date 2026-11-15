import { afterEach, describe, expect, it } from 'vitest';
import {
  ENGINE_MODULE_FILE,
  EngineLoadError,
  loadEngine,
  parseEngineMode,
  resolveEngineModuleUrl,
  type EmscriptenModule,
} from '../src/engine/loadEngine';
import { FakeEngineModule } from './fixtures/fakeEngineModule';

const ORIGINAL_DOCUMENT = (globalThis as { document?: Document }).document;

function withDocumentBase(baseURI: string): void {
  Object.defineProperty(globalThis, 'document', {
    value: { baseURI },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (ORIGINAL_DOCUMENT === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    withDocumentBase(ORIGINAL_DOCUMENT.baseURI);
  }
});

describe('sélection du moteur', () => {
  it('normalise ?engine=', () => {
    expect(parseEngineMode('wasm')).toBe('wasm');
    expect(parseEngineMode(' MOCK ')).toBe('mock');
    expect(parseEngineMode('webgl')).toBeNull();
    expect(parseEngineMode(null)).toBeNull();
  });
});

describe('résolution de l’URL du module', () => {
  it('respecte une URL absolue fournie', () => {
    expect(resolveEngineModuleUrl('https://cdn.test/opentt3d-engine.js')).toBe(
      'https://cdn.test/opentt3d-engine.js',
    );
  });

  it('résout par défaut depuis la base de la page (dev, build, GitHub Pages)', () => {
    withDocumentBase('https://paul.github.io/opentt3d/');
    expect(resolveEngineModuleUrl()).toBe(
      `https://paul.github.io/opentt3d/engine/${ENGINE_MODULE_FILE}`,
    );
    expect(resolveEngineModuleUrl(undefined)).toBe(
      `https://paul.github.io/opentt3d/engine/${ENGINE_MODULE_FILE}`,
    );
  });

  it('résout un chemin relatif par rapport à la page', () => {
    withDocumentBase('http://localhost:5173/');
    expect(resolveEngineModuleUrl('engine/custom-engine.js')).toBe(
      'http://localhost:5173/engine/custom-engine.js',
    );
  });
});

describe('chargement du module', () => {
  it('progresse et expose la mémoire réelle', async () => {
    const fake = new FakeEngineModule();
    const progress: number[] = [];
    const loaded = await loadEngine({
      moduleUrl: 'fake://engine',
      factory: async () => fake.asModule() as EmscriptenModule,
      onProgress: (value) => progress.push(value),
    });
    expect(loaded.module).toBe(fake.asModule());
    expect(loaded.moduleUrl).toBe('fake://engine');
    expect(loaded.memoryBytes).toBe(1 << 20);
    expect(loaded.memoryShortfall).toBe(false);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1] ?? 0);
    }
  });

  it('détecte une mémoire compilée insuffisante', async () => {
    const fake = new FakeEngineModule();
    const loaded = await loadEngine({
      moduleUrl: 'fake://engine',
      memoryMiB: 64,
      factory: async () => fake.asModule() as EmscriptenModule,
    });
    expect(loaded.memoryShortfall).toBe(true);
  });

  it('produit une erreur lisible quand les artefacts sont absents', async () => {
    const error = await loadEngine({
      moduleUrl: 'http://localhost:5173/engine/opentt3d-engine.js',
      importModule: async () => {
        throw new TypeError(
          'Failed to fetch dynamically imported module: /engine/opentt3d-engine.js',
        );
      },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EngineLoadError);
    const loadError = error as EngineLoadError;
    expect(loadError.code).toBe('module-missing');
    expect(loadError.message).toContain('Impossible de charger le module moteur');
    expect(loadError.hint).toContain('engine:build');
  });

  it('refuse un module sans fabrique utilisable', async () => {
    const error = await loadEngine({
      moduleUrl: 'fake://engine',
      importModule: async () => ({ version: 1 }),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).code).toBe('module-invalid');
    expect((error as EngineLoadError).message).toContain('fabrique');
  });

  it('signale un module sans mémoire WASM', async () => {
    const error = await loadEngine({
      moduleUrl: 'fake://engine',
      factory: async () => ({ HEAPU8: new Uint8Array(0) }) as unknown as EmscriptenModule,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).code).toBe('module-invalid');
    expect((error as EngineLoadError).message).toContain('mémoire WASM');
  });
});
