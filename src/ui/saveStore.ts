/**
 * Stockage local des sauvegardes : IndexedDB sans dépendance.
 *
 * Deux object stores pour ne jamais charger les gros blobs inutilement :
 * `meta` (une ligne par slot) et `blobs` (les octets). `list()` ne lit que les
 * métadonnées ; `get()` charge le conteneur demandé.
 *
 * Aucune donnée personnelle n'est stockée : nom de sauvegarde choisi par le
 * joueur, noms des entreprises du monde et métadonnées de partie uniquement.
 * La taille est bornée à `MAX_SAVE_BYTES` et les erreurs de quota sont traduites
 * en message actionnable.
 */

import {
  MAX_SAVE_BYTES,
  SAVE_SCHEMA_VERSION,
  autosaveName,
  defaultSaveName,
  detectSaveFormat,
  inspectSaveBytes,
  nextAutosaveId,
  planAutosaveRotation,
  sanitizeSaveName,
  saveFileName,
  type SaveEngine,
  type SaveFormat,
  type SaveGameDate,
  type SaveInspection,
  type SaveKind,
  type SaveRecord,
  type SaveSlot,
} from './saveFormat';
import { t } from './i18n';

export type SaveStoreErrorCode = 'quota' | 'too-large' | 'invalid' | 'storage' | 'not-found';

/** Erreur de stockage avec un code exploitable par l'UI. */
export class SaveStoreError extends Error {
  readonly code: SaveStoreErrorCode;

  constructor(code: SaveStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveStoreError';
    this.code = code;
  }
}

/** Entrée de création d'une sauvegarde, produite par `GameSession.captureSave`. */
export interface NewSaveInput {
  name?: string;
  bytes: Uint8Array;
  engine: SaveEngine;
  kind?: SaveKind;
  seed?: number | null;
  mapSize?: number | null;
  gameDate?: SaveGameDate | null;
  companies?: string[];
  tick?: number;
  protocol?: number | null;
}

/** Contrat minimal du stockage, implémenté par IndexedDB et la mémoire. */
export interface SaveStorageBackend {
  list(): Promise<SaveSlot[]>;
  get(id: string): Promise<SaveRecord | null>;
  put(record: SaveRecord): Promise<void>;
  delete(id: string): Promise<void>;
  estimate?(): Promise<{ usage: number; quota: number } | null>;
  close?(): void;
}

export interface SaveStoreOptions {
  now?: () => number;
  maxBytes?: number;
  autosaveLimit?: number;
  /** Génère les identifiants des slots manuels/importés. */
  randomId?: () => string;
}

/** Façade métier : validation, nommage, quota et rotation des autosaves. */
export class SaveStore {
  readonly backend: SaveStorageBackend;

  private now: () => number;
  private maxBytes: number;
  private autosaveLimit: number;
  private randomId: () => string;
  /** Sérialise les écritures pour que la rotation ne se chevauche pas. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(backend: SaveStorageBackend, options: SaveStoreOptions = {}) {
    this.backend = backend;
    this.now = options.now ?? (() => Date.now());
    this.maxBytes = Math.max(1, options.maxBytes ?? MAX_SAVE_BYTES);
    this.autosaveLimit = Math.max(1, Math.trunc(options.autosaveLimit ?? 3));
    this.randomId = options.randomId ?? defaultId;
  }

  list(): Promise<SaveSlot[]> {
    return this.backend.list().then((slots) => slots.slice().sort(sortSlots));
  }

  get(id: string): Promise<SaveRecord | null> {
    return this.backend.get(id);
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.backend.delete(id);
      } catch (error) {
        throw toStoreError(error, t('save.error.delete'));
      }
    });
  }

  /** Sauvegarde manuelle ou import : chaque écriture crée un nouveau slot. */
  save(input: NewSaveInput): Promise<SaveSlot> {
    return this.serialize(() => this.write(input, input.kind ?? 'manual'));
  }

  /** Autosave : rotation glissante, au plus `autosaveLimit` slots conservés. */
  saveAutosave(input: Omit<NewSaveInput, 'kind' | 'name'>): Promise<SaveSlot> {
    return this.serialize(async () => {
      const existing = await this.backend.list();
      const name = autosaveName(input.gameDate ?? null);
      const slot = await this.write({ ...input, name }, 'autosave', existing);
      const rotation = planAutosaveRotation([...existing, slot], this.autosaveLimit);
      for (const id of rotation.remove) {
        if (id === slot.id) continue;
        await this.backend.delete(id);
      }
      return slot;
    });
  }

  /**
   * Importe un fichier utilisateur après validation complète.
   * Le nom interne (métadonnées du pont) est préféré au nom de fichier.
   */
  async importFile(fileName: string, bytes: Uint8Array): Promise<SaveSlot> {
    let inspection: SaveInspection;
    try {
      inspection = inspectSaveBytes(bytes);
    } catch (error) {
      throw toStoreError(error, t('save.error.import'));
    }
    const fallback = fileStem(fileName) || 'Sauvegarde importée';
    const name = sanitizeSaveName(inspection.name ?? fallback, fallback);
    return this.serialize(() =>
      this.write(
        {
          name,
          bytes,
          engine: inspection.engine,
          seed: inspection.seed,
          mapSize: inspection.mapSize,
          gameDate: inspection.gameDate,
          companies: inspection.companies,
          tick: inspection.tick,
          protocol: inspection.protocol,
        },
        'import',
      ),
    );
  }

  estimate(): Promise<{ usage: number; quota: number } | null> {
    if (!this.backend.estimate) return Promise.resolve(null);
    return this.backend.estimate().catch(() => null);
  }

  close(): void {
    this.backend.close?.();
  }

  private async write(
    input: NewSaveInput,
    kind: SaveKind,
    knownSlots?: SaveSlot[],
  ): Promise<SaveSlot> {
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new SaveStoreError('invalid', t('save.error.storeEmpty'));
    }
    if (bytes.length > this.maxBytes) {
      throw new SaveStoreError(
        'too-large',
        t('save.error.storeTooLarge', {
          max: Math.round(this.maxBytes / (1024 * 1024)),
        }),
      );
    }
    const detected = detectSaveFormat(bytes);
    if (!detected) {
      throw new SaveStoreError('invalid', t('save.error.storeUnknown'));
    }
    const expectedFormat: SaveFormat = input.engine === 'wasm' ? 'ot3s' : 'mock-json';
    if (detected !== expectedFormat) {
      throw new SaveStoreError(
        'invalid',
        t('save.error.storeIncompatible', {
          detected: detected === 'ot3s' ? 'WASM' : 'mock',
          engine: input.engine === 'wasm' ? 'WASM' : 'mock',
        }),
      );
    }

    const existing = knownSlots ?? (kind === 'autosave' ? await this.backend.list() : []);
    const id = kind === 'autosave' ? nextAutosaveId(existing) : this.randomId();
    const createdAt = this.now();
    const fallbackName =
      kind === 'import' ? 'Sauvegarde importée' : defaultSaveName(input.gameDate ?? null);
    const slot: SaveSlot = {
      id,
      schema: SAVE_SCHEMA_VERSION,
      name: sanitizeSaveName(input.name ?? fallbackName, fallbackName),
      createdAt,
      engine: input.engine,
      kind,
      format: detected,
      size: bytes.length,
      seed: normalizeSeed(input.seed),
      mapSize: normalizeMapSize(input.mapSize),
      gameDate: normalizeGameDate(input.gameDate),
      companies: normalizeCompanies(input.companies),
      tick:
        typeof input.tick === 'number' && Number.isFinite(input.tick) && input.tick >= 0
          ? Math.trunc(input.tick)
          : 0,
      protocol:
        typeof input.protocol === 'number' && Number.isFinite(input.protocol)
          ? Math.trunc(input.protocol)
          : null,
    };

    await this.ensureQuota(bytes.length);
    try {
      await this.backend.put({ ...slot, bytes });
    } catch (error) {
      throw toStoreError(error, t('save.error.save'));
    }
    return slot;
  }

  private async ensureQuota(size: number): Promise<void> {
    const estimate = await this.estimate();
    if (!estimate || estimate.quota <= 0) return;
    if (estimate.usage + size > estimate.quota) {
      throw new SaveStoreError('quota', t('save.error.quota'));
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Une erreur ne doit pas bloquer la file des écritures suivantes.
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sortSlots(a: SaveSlot, b: SaveSlot): number {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

function defaultId(): string {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function fileStem(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/]/g, ' ')
    .trim();
}

function normalizeSeed(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value >>> 0 : null;
}

function normalizeMapSize(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const size = Math.trunc(value);
  return size > 0 && size <= 4096 ? size : null;
}

function normalizeGameDate(value: SaveGameDate | null | undefined): SaveGameDate | null {
  if (!value) return null;
  const { year, month, day } = value;
  if (![year, month, day].every((entry) => Number.isFinite(entry))) return null;
  if (year < 0 || month < 0 || month > 11 || day < 1 || day > 31) return null;
  return { year: Math.trunc(year), month: Math.trunc(month), day: Math.trunc(day) };
}

function normalizeCompanies(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim().slice(0, 64))
    .slice(0, 16);
}

/* ------------------------------------------------------------------------- */
/*  Backend mémoire (tests + repli quand IndexedDB est indisponible)         */
/* ------------------------------------------------------------------------- */

/** Stockage en mémoire : ordre d'itération stable, aucun accès navigateur. */
export class MemorySaveBackend implements SaveStorageBackend {
  /** Erreur injectée au prochain `put` (tests de quota). */
  nextPutError: unknown = null;
  /** Erreur injectée au prochain `list`. */
  nextListError: unknown = null;

  private metas = new Map<string, SaveSlot>();
  private blobs = new Map<string, Uint8Array>();
  /** Compteur d'écritures, utile aux tests de rotation. */
  writes = 0;

  async list(): Promise<SaveSlot[]> {
    if (this.nextListError) {
      const error = this.nextListError;
      this.nextListError = null;
      throw error;
    }
    return Array.from(this.metas.values()).map((slot) => cloneSlot(slot));
  }

  async get(id: string): Promise<SaveRecord | null> {
    const slot = this.metas.get(id);
    const bytes = this.blobs.get(id);
    if (!slot || !bytes) return null;
    return { ...cloneSlot(slot), bytes: bytes.slice() };
  }

  async put(record: SaveRecord): Promise<void> {
    if (this.nextPutError) {
      const error = this.nextPutError;
      this.nextPutError = null;
      throw error;
    }
    const { bytes, ...meta } = record;
    this.metas.set(record.id, cloneSlot(meta));
    this.blobs.set(record.id, bytes.slice());
    this.writes += 1;
  }

  async delete(id: string): Promise<void> {
    this.metas.delete(id);
    this.blobs.delete(id);
  }

  async estimate(): Promise<{ usage: number; quota: number } | null> {
    let usage = 0;
    for (const bytes of this.blobs.values()) usage += bytes.length;
    return { usage, quota: 64 * 1024 * 1024 };
  }
}

function cloneSlot(slot: SaveSlot): SaveSlot {
  return {
    ...slot,
    companies: [...slot.companies],
    gameDate: slot.gameDate ? { ...slot.gameDate } : null,
  };
}

/* ------------------------------------------------------------------------- */
/*  Backend IndexedDB                                                        */
/* ------------------------------------------------------------------------- */

const DB_NAME = 'opentt3d-saves';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BLOB_STORE = 'blobs';

/** Backend IndexedDB : métadonnées et octets dans deux stores séparés. */
export class IndexedDbSaveBackend implements SaveStorageBackend {
  private db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static open(factory: IDBFactory, name = DB_NAME): Promise<IndexedDbSaveBackend> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE);
        }
      };
      request.onsuccess = () => resolve(new IndexedDbSaveBackend(request.result));
      request.onerror = () => reject(request.error ?? new Error(t('save.error.idbOpen')));
      request.onblocked = () =>
        reject(new Error('IndexedDB est bloqué par un autre onglet de OpenTT3D.'));
    });
  }

  async list(): Promise<SaveSlot[]> {
    const tx = this.db.transaction(META_STORE, 'readonly');
    const done = transactionDone(tx);
    const request = tx.objectStore(META_STORE).getAll();
    const rows = await requestResult<unknown[]>(request);
    await done;
    return rows.filter(isStoredSlot).map(normalizeStoredSlot);
  }

  async get(id: string): Promise<SaveRecord | null> {
    const tx = this.db.transaction([META_STORE, BLOB_STORE], 'readonly');
    const done = transactionDone(tx);
    const metaRequest = tx.objectStore(META_STORE).get(id);
    const blobRequest = tx.objectStore(BLOB_STORE).get(id);
    const [meta, blob] = await Promise.all([
      requestResult<unknown>(metaRequest),
      requestResult<unknown>(blobRequest),
    ]);
    await done;
    if (!isStoredSlot(meta)) return null;
    const bytes =
      blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : null;
    if (!bytes) return null;
    return { ...normalizeStoredSlot(meta), bytes };
  }

  async put(record: SaveRecord): Promise<void> {
    const { bytes, ...meta } = record;
    const tx = this.db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    tx.objectStore(BLOB_STORE).put(bytes.slice(), record.id);
    await transactionDone(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(BLOB_STORE).delete(id);
    await transactionDone(tx);
  }

  async estimate(): Promise<{ usage: number; quota: number } | null> {
    return estimateStorageQuota();
  }

  close(): void {
    this.db.close();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t('save.error.idbRequest')));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('save.error.idbTransaction')));
    tx.onabort = () => reject(tx.error ?? new Error(t('save.error.idbAbort')));
  });
}

function isStoredSlot(value: unknown): value is SaveSlot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SaveSlot>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.createdAt === 'number' &&
    (candidate.engine === 'mock' || candidate.engine === 'wasm') &&
    (candidate.format === 'ot3s' || candidate.format === 'mock-json')
  );
}

function normalizeStoredSlot(slot: SaveSlot): SaveSlot {
  return {
    ...slot,
    schema: typeof slot.schema === 'number' ? slot.schema : SAVE_SCHEMA_VERSION,
    kind: slot.kind === 'autosave' || slot.kind === 'import' ? slot.kind : 'manual',
    size: typeof slot.size === 'number' ? slot.size : 0,
    seed: typeof slot.seed === 'number' ? slot.seed : null,
    mapSize: typeof slot.mapSize === 'number' ? slot.mapSize : null,
    gameDate: slot.gameDate ?? null,
    companies: Array.isArray(slot.companies) ? normalizeCompanies(slot.companies) : [],
    tick: typeof slot.tick === 'number' ? slot.tick : 0,
    protocol: typeof slot.protocol === 'number' ? slot.protocol : null,
  };
}

/* ------------------------------------------------------------------------- */
/*  Ouverture et erreurs                                                     */
/* ------------------------------------------------------------------------- */

export interface SaveStoreHandle {
  store: SaveStore;
  /** false quand IndexedDB est indisponible : repli mémoire pour l'onglet. */
  persistent: boolean;
  warning: string | null;
  dispose(): void;
}

/**
 * Ouvre IndexedDB, ou retombe sur un stockage mémoire si le navigateur le
 * refuse (mode privé strict, iframe sans permission, stockage désactivé).
 * L'appelant affiche `warning` pour que l'utilisateur sache que la sauvegarde
 * ne survivra pas à la fermeture de l'onglet.
 */
export async function openSaveStore(
  factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB,
): Promise<SaveStoreHandle> {
  if (factory) {
    try {
      const backend = await IndexedDbSaveBackend.open(factory);
      return {
        store: new SaveStore(backend),
        persistent: true,
        warning: null,
        dispose: () => backend.close(),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return memoryHandle(
        `Stockage local indisponible (${reason}). Les sauvegardes resteront en mémoire pour cet onglet.`,
      );
    }
  }
  return memoryHandle(
    'Ce navigateur n’expose pas IndexedDB : les sauvegardes resteront en mémoire pour cet onglet.',
  );
}

function memoryHandle(warning: string): SaveStoreHandle {
  const backend = new MemorySaveBackend();
  return {
    store: new SaveStore(backend),
    persistent: false,
    warning,
    dispose: () => undefined,
  };
}

/** `navigator.storage.estimate()` sans lever si l'API est absente ou refusée. */
export async function estimateStorageQuota(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined') return null;
  const storage = navigator.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const estimate = await storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    if (quota <= 0) return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

/** Un quota dépassé arrive sous plusieurs noms selon les navigateurs. */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    candidate.code === 22 ||
    candidate.code === 1014
  );
}

function toStoreError(error: unknown, action: string): SaveStoreError {
  if (error instanceof SaveStoreError) return error;
  if (isQuotaError(error)) {
    return new SaveStoreError('quota', t('save.error.quota'), { cause: error });
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'too-large'
  ) {
    return new SaveStoreError('too-large', (error as Error).message, { cause: error });
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'empty'
  ) {
    return new SaveStoreError('invalid', (error as Error).message, { cause: error });
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      ['unsupported', 'truncated', 'corrupt', 'version'].includes(code)
    ) {
      return new SaveStoreError('invalid', (error as Error).message, { cause: error });
    }
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new SaveStoreError('storage', t('save.error.action', { action, detail }), {
    cause: error,
  });
}

/** Message prêt pour l'UI, quel que soit le type d'erreur. */
export function describeSaveError(error: unknown): string {
  if (error instanceof SaveStoreError || error instanceof Error) return error.message;
  return t('save.error.unexpected', { detail: String(error) });
}

/* ------------------------------------------------------------------------- */
/*  Export / import de fichier (navigateur)                                  */
/* ------------------------------------------------------------------------- */

/** Construit le blob d'export (séparé pour rester testable sans DOM). */
export function saveBlob(record: SaveRecord): Blob {
  const type = record.format === 'ot3s' ? 'application/octet-stream' : 'application/json';
  return new Blob([record.bytes as unknown as BlobPart], { type });
}

/** Télécharge le conteneur avec un nom lisible. */
export function downloadSaveFile(record: SaveRecord): string {
  const fileName = saveFileName(record);
  const url = URL.createObjectURL(saveBlob(record));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return fileName;
}

/** Lit un fichier choisi par l'utilisateur après contrôle de taille. */
export async function readSaveFile(file: File): Promise<Uint8Array> {
  if (file.size > MAX_SAVE_BYTES) {
    throw new SaveStoreError(
      'too-large',
      t('save.error.fileTooLarge', { max: Math.round(MAX_SAVE_BYTES / (1024 * 1024)) }),
    );
  }
  if (file.size === 0) throw new SaveStoreError('invalid', t('save.error.fileEmpty'));
  return new Uint8Array(await file.arrayBuffer());
}
