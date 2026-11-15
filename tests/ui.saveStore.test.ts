import { describe, expect, it } from 'vitest';
import {
  MemorySaveBackend,
  SaveStore,
  SaveStoreError,
  isQuotaError,
  type NewSaveInput,
} from '../src/ui/saveStore';
import { mockSaveBytes, ot3sSaveBytes } from './fixtures/saveFixtures';

function createStore(options: { now?: () => number; maxBytes?: number } = {}): {
  store: SaveStore;
  backend: MemorySaveBackend;
} {
  const backend = new MemorySaveBackend();
  const store = new SaveStore(backend, {
    now: options.now ?? (() => 1_700_000_000_000),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    randomId: (() => {
      let counter = 0;
      return () => `save-${++counter}`;
    })(),
  });
  return { store, backend };
}

function manualInput(overrides: Partial<NewSaveInput> = {}): NewSaveInput {
  return {
    name: 'Partie de test',
    bytes: mockSaveBytes({ seed: 7, tick: 120 }),
    engine: 'mock',
    seed: 7,
    mapSize: 4,
    gameDate: { year: 1950, month: 7, day: 14 },
    companies: ['Transport du Nord', 'Mock AI'],
    tick: 120,
    protocol: 1,
    ...overrides,
  };
}

describe('SaveStore : slots et blobs', () => {
  it('enregistre, liste et relit une sauvegarde sans charger les blobs dans la liste', async () => {
    const { store } = createStore();
    const slot = await store.save(manualInput());
    expect(slot.id).toBe('save-1');
    expect(slot.name).toBe('Partie de test');
    expect(slot.engine).toBe('mock');
    expect(slot.format).toBe('mock-json');
    expect(slot.size).toBeGreaterThan(0);
    expect(slot.gameDate).toEqual({ year: 1950, month: 7, day: 14 });
    expect(slot.companies).toEqual(['Transport du Nord', 'Mock AI']);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('bytes');

    const record = await store.get(slot.id);
    expect(record).not.toBeNull();
    expect(record?.bytes).toBeInstanceOf(Uint8Array);
    expect(record?.bytes.length).toBe(slot.size);
    expect(Array.from(record?.bytes.slice(0, 1) ?? [])).toEqual([0x7b]);
  });

  it('trie du plus récent au plus ancien et supprime', async () => {
    let now = 1_000;
    const { store } = createStore({ now: () => (now += 1_000) });
    const first = await store.save(manualInput({ name: 'Ancienne' }));
    const second = await store.save(manualInput({ name: 'Récente' }));
    expect((await store.list()).map((slot) => slot.name)).toEqual(['Récente', 'Ancienne']);
    await store.remove(first.id);
    expect((await store.list()).map((slot) => slot.id)).toEqual([second.id]);
    expect(await store.get(first.id)).toBeNull();
  });

  it('refuse une sauvegarde vide, inconnue ou incompatible avec le moteur', async () => {
    const { store } = createStore();
    await expect(store.save(manualInput({ bytes: new Uint8Array(0) }))).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      store.save(manualInput({ bytes: new TextEncoder().encode('nope') })),
    ).rejects.toMatchObject({ code: 'invalid' });
    // OT3S stocké comme mock : le conteneur ne doit pas être chargé par le mock.
    await expect(
      store.save(manualInput({ bytes: ot3sSaveBytes(), engine: 'mock' })),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('borne la taille avant écriture', async () => {
    const { store, backend } = createStore({ maxBytes: 64 });
    const big = mockSaveBytes({ width: 4 });
    expect(big.length).toBeGreaterThan(64);
    await expect(store.save(manualInput({ bytes: big }))).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(backend.writes).toBe(0);
  });

  it('traduit un dépassement de quota en message actionnable', async () => {
    const { store, backend } = createStore();
    backend.nextPutError = { name: 'QuotaExceededError' };
    const error = await store.save(manualInput()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SaveStoreError);
    expect((error as SaveStoreError).code).toBe('quota');
    expect((error as Error).message).toMatch(/Espace de stockage insuffisant/);
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError(new Error('autre'))).toBe(false);
  });

  it('refuse proactivement quand le quota estimé est insuffisant', async () => {
    class TightBackend extends MemorySaveBackend {
      override async estimate(): Promise<{ usage: number; quota: number }> {
        return { usage: 100, quota: 110 };
      }
    }
    const store = new SaveStore(new TightBackend(), { now: () => 1 });
    await expect(store.save(manualInput())).rejects.toMatchObject({ code: 'quota' });
  });
});

describe('SaveStore : autosave et import', () => {
  it('conserve trois autosaves glissantes et les nomme par date de jeu', async () => {
    let now = 1_000;
    const { store } = createStore({ now: () => (now += 1_000) });
    const manual = await store.save(manualInput({ name: 'Manuelle' }));
    const created = [];
    for (let day = 1; day <= 4; day += 1) {
      created.push(
        await store.saveAutosave({
          bytes: mockSaveBytes({ seed: 7, day }),
          engine: 'mock',
          seed: 7,
          mapSize: 4,
          gameDate: { year: 1950, month: 7, day },
          companies: ['Transport du Nord'],
          tick: day * 100,
          protocol: 1,
        }),
      );
    }
    const list = await store.list();
    const autosaves = list.filter((slot) => slot.kind === 'autosave');
    expect(autosaves).toHaveLength(3);
    expect(autosaves.map((slot) => slot.id).sort()).toEqual([
      'autosave-2',
      'autosave-3',
      'autosave-4',
    ]);
    expect(list.some((slot) => slot.id === manual.id)).toBe(true);
    expect(autosaves[0]?.name).toMatch(/^Autosave · /);
    expect(await store.get(created[0]?.id ?? '')).toBeNull();
  });

  it('importe un fichier OT3S avec son nom interne et ses métadonnées', async () => {
    const { store } = createStore();
    const bytes = ot3sSaveBytes({ name: 'Empire WASM', mapSize: 256, tick: 12 });
    const slot = await store.importFile('export.ot3s', bytes);
    expect(slot.kind).toBe('import');
    expect(slot.name).toBe('Empire WASM');
    expect(slot.engine).toBe('wasm');
    expect(slot.format).toBe('ot3s');
    expect(slot.mapSize).toBe(256);
    expect(slot.tick).toBe(12);
    expect(slot.seed).toBeNull();
    expect(slot.gameDate).toBeNull();
  });

  it('importe un JSON mock en retombant sur le nom de fichier', async () => {
    const { store } = createStore();
    const bytes = mockSaveBytes({
      seed: 9,
      year: 1960,
      month: 2,
      day: 3,
      companies: ['Atelier'],
    });
    const slot = await store.importFile('ma-partie.json', bytes);
    expect(slot.name).toBe('ma-partie');
    expect(slot.engine).toBe('mock');
    expect(slot.seed).toBe(9);
    expect(slot.gameDate).toEqual({ year: 1960, month: 2, day: 3 });
    expect(slot.companies).toEqual(['Atelier']);
  });

  it('refuse un import corrompu sans écrire de slot', async () => {
    const { store } = createStore();
    await expect(
      store.importFile('bad.ot3s', new TextEncoder().encode('OT3S')),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.list()).toHaveLength(0);
  });
});
