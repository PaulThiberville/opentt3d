import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_SLOT_COUNT,
  AutosaveScheduler,
  DEFAULT_AUTOSAVE,
  MAX_SAVE_BYTES,
  SaveFormatError,
  autosaveName,
  base64ByteLength,
  defaultSaveName,
  detectSaveFormat,
  formatSaveSize,
  formatSaveTimestamp,
  inspectSaveBytes,
  nextAutosaveId,
  planAutosaveRotation,
  sanitizeSaveName,
  saveFileName,
  type SaveSlot,
} from '../src/ui/saveFormat';
import { mockSaveBytes, ot3sSaveBytes } from './fixtures/saveFixtures';

function normalized(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

function slot(overrides: Partial<SaveSlot>): SaveSlot {
  return {
    id: 'slot-1',
    schema: 1,
    name: 'Partie',
    createdAt: 1_000,
    engine: 'mock',
    kind: 'manual',
    format: 'mock-json',
    size: 1024,
    seed: 1,
    mapSize: 128,
    gameDate: null,
    companies: [],
    tick: 0,
    protocol: 1,
    ...overrides,
  };
}

describe('métadonnées et nommage des sauvegardes', () => {
  it('nettoie un nom saisi', () => {
    expect(sanitizeSaveName('  Ma   partie  ')).toBe('Ma partie');
    expect(sanitizeSaveName('\u0000\u0007')).toBe('Sauvegarde');
    expect(sanitizeSaveName('   ', 'Défaut')).toBe('Défaut');
    expect(sanitizeSaveName('x'.repeat(120))).toHaveLength(60);
  });

  it('propose la date de jeu par défaut', () => {
    expect(defaultSaveName({ year: 1950, month: 7, day: 14 })).toBe('Partie du 14 août 1950');
    expect(defaultSaveName(null)).toBe('Sauvegarde manuelle');
    expect(autosaveName({ year: 1950, month: 7, day: 14 })).toBe('Autosave · 14 août 1950');
    expect(autosaveName(null)).toBe('Autosave');
  });

  it('formate les tailles et l’horodatage', () => {
    expect(normalized(formatSaveSize(0))).toBe('0 o');
    expect(normalized(formatSaveSize(1024))).toBe('1 Kio');
    expect(normalized(formatSaveSize(1536))).toBe('1,5 Kio');
    expect(normalized(formatSaveSize(1024 * 1024))).toBe('1 Mio');
    expect(formatSaveSize(-1)).toBe('—');
    expect(formatSaveTimestamp(1_700_000_000_000)).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });

  it('produit un nom de fichier lisible et sûr', () => {
    const name = saveFileName(
      slot({
        name: 'Partie du 14 août 1950',
        format: 'ot3s',
        gameDate: { year: 1950, month: 7, day: 14 },
      }),
    );
    expect(name).toBe('opentt3d-partie-du-14-aout-1950-1950-08-14.ot3s');
    const json = saveFileName(slot({ name: 'Essai / test', createdAt: Date.UTC(2026, 10, 15) }));
    expect(json).toBe('opentt3d-essai-test-2026-11-15.json');
  });
});

describe('validation d’import', () => {
  it('accepte un conteneur OT3S et lit ses métadonnées', () => {
    const bytes = ot3sSaveBytes({
      tick: 480,
      name: 'Empire du Nord',
      mapSize: 256,
      startYear: 1965,
      difficulty: 2,
      aiCompanies: 3,
      climate: 1,
      disasters: true,
    });
    expect(detectSaveFormat(bytes)).toBe('ot3s');
    const inspection = inspectSaveBytes(bytes);
    expect(inspection.format).toBe('ot3s');
    expect(inspection.engine).toBe('wasm');
    expect(inspection.tick).toBe(480);
    expect(inspection.name).toBe('Empire du Nord');
    expect(inspection.mapSize).toBe(256);
    expect(inspection.startYear).toBe(1965);
    expect(inspection.difficulty).toBe(2);
    expect(inspection.aiCompanies).toBe(3);
    expect(inspection.climate).toBe('subarctic');
    expect(inspection.disasters).toBe(true);
    expect(inspection.size).toBe(bytes.length);
  });

  it('accepte une sauvegarde mock et en extrait graine, date et entreprises', () => {
    const bytes = mockSaveBytes({
      width: 4,
      seed: 4242,
      tick: 90,
      year: 1961,
      month: 3,
      day: 12,
      companies: ['Transports du Nord', 'Mock AI'],
    });
    expect(detectSaveFormat(bytes)).toBe('mock-json');
    const inspection = inspectSaveBytes(bytes);
    expect(inspection.format).toBe('mock-json');
    expect(inspection.engine).toBe('mock');
    expect(inspection.seed).toBe(4242);
    expect(inspection.mapSize).toBe(4);
    expect(inspection.gameDate).toEqual({ year: 1961, month: 3, day: 12 });
    expect(inspection.tick).toBe(90);
    expect(inspection.companies).toEqual(['Transports du Nord', 'Mock AI']);
  });

  it('refuse les fichiers vides, inconnus ou trop gros', () => {
    expect(() => inspectSaveBytes(new Uint8Array(0))).toThrow(SaveFormatError);
    expect(() => inspectSaveBytes(new TextEncoder().encode('bonjour'))).toThrow(/Format inconnu/);
    expect(() => inspectSaveBytes(new Uint8Array(MAX_SAVE_BYTES + 1))).toThrow(/trop volumineux/);
  });

  it('refuse un .sav OpenTTD brut avec un message explicite', () => {
    const raw = new TextEncoder().encode('OTTX-rest-of-save');
    expect(() => inspectSaveBytes(raw)).toThrow(/\.sav OpenTTD brut/);
  });

  it('détecte un conteneur tronqué ou d’une version inconnue', () => {
    const bytes = ot3sSaveBytes({ name: 'Partie tronquée' });
    expect(() => inspectSaveBytes(bytes.slice(0, bytes.length - 4))).toThrow(/tronqué/);
    const truncatedHeader = bytes.slice(0, 20);
    expect(() => inspectSaveBytes(truncatedHeader)).toThrow(/en-tête incomplet/);
    const version = bytes.slice();
    version[4] = 2;
    expect(() => inspectSaveBytes(version)).toThrow(/Version de sauvegarde/);
  });

  it('refuse une sauvegarde mock tronquée ou de mauvaise version', () => {
    const truncated = mockSaveBytes({ width: 4 });
    const parsed = JSON.parse(new TextDecoder().decode(truncated)) as {
      world: Record<string, unknown>;
    };
    parsed.world.kind = Buffer.from(new Uint8Array(3)).toString('base64');
    const bytes = new TextEncoder().encode(JSON.stringify(parsed));
    expect(() => inspectSaveBytes(bytes)).toThrow(/tronquée/);

    const wrongVersion = mockSaveBytes({ version: 99 });
    expect(() => inspectSaveBytes(wrongVersion)).toThrow(/incompatible/);
  });

  it('compte les octets d’une chaîne base64', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('AAAA')).toBe(3);
    expect(base64ByteLength('AAA=')).toBe(2);
    expect(base64ByteLength('AA==')).toBe(1);
    expect(base64ByteLength('abc')).toBe(-1);
  });
});

describe('planification de l’autosave', () => {
  it('déclenche sur le temps réel ou les ticks, jamais au premier appel', () => {
    const scheduler = new AutosaveScheduler({ intervalMs: 10_000, intervalTicks: 300 });
    expect(scheduler.due(0, 0)).toBe(false);
    expect(scheduler.due(9_999, 299)).toBe(false);
    expect(scheduler.due(10_000, 299)).toBe(true);
    expect(scheduler.due(10_001, 300)).toBe(false);
    expect(scheduler.due(10_002, 599)).toBe(true);
    scheduler.reset(0, 0);
    expect(scheduler.due(10_000, 0)).toBe(true);
  });

  it('borne les intervalles pour éviter une sauvegarde en rafale', () => {
    const scheduler = new AutosaveScheduler({ intervalMs: 0, intervalTicks: 0 });
    expect(scheduler.intervalMs).toBe(5_000);
    expect(scheduler.intervalTicks).toBe(1);
    expect(DEFAULT_AUTOSAVE.intervalMs).toBeGreaterThanOrEqual(60_000);
  });

  it('fait tourner trois autosaves sans toucher aux sauvegardes manuelles', () => {
    const slots: SaveSlot[] = [
      slot({ id: 'manual', kind: 'manual', createdAt: 500 }),
      slot({ id: 'autosave-1', kind: 'autosave', createdAt: 100 }),
      slot({ id: 'autosave-2', kind: 'autosave', createdAt: 200 }),
      slot({ id: 'autosave-3', kind: 'autosave', createdAt: 300 }),
      slot({ id: 'autosave-4', kind: 'autosave', createdAt: 400 }),
    ];
    const rotation = planAutosaveRotation(slots, AUTOSAVE_SLOT_COUNT);
    expect(rotation.remove).toEqual(['autosave-1']);
    expect(rotation.keep).toEqual(['autosave-2', 'autosave-3', 'autosave-4']);
    expect(rotation.keep).not.toContain('manual');
    expect(planAutosaveRotation(slots.slice(0, 2)).remove).toEqual([]);
    expect(nextAutosaveId(slots)).toBe('autosave-5');
    expect(nextAutosaveId([slot({ id: 'manual', kind: 'manual' })])).toBe('autosave-1');
  });
});
