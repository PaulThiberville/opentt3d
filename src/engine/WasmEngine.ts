/**
 * Pilote du moteur OpenTTD réel (WebAssembly).
 *
 * Implémente `EngineDriver` au-dessus des fonctions C exportées par le pont
 * (engine/bridge/ottd_bridge.cpp). Aucune vue sur `HEAPU8` n'est conservée :
 * chaque snapshot recopie les tableaux carte dans des `Uint8Array` neufs avant
 * de rendre la main, donc une croissance ou une réutilisation du heap pendant
 * `step()` ne peut pas corrompre l'état déjà lu.
 *
 * Limitations assumées en v1 (le pont ne les expose pas encore) :
 *  - commandes de construction et de véhicules : voir #11.
 *
 * `save()`/`load()` utilisent le conteneur OT3S du pont. Les options de partie
 * (climat, année, IA, difficulté) sont transmises via `ottd_new_game_ex`.
 */

import {
  isPowerOfTwo,
  decodeMapSnapshot,
  MapSnapshotError,
  type DecodedMapSnapshot,
} from './mapBinary';
import {
  loadEngine,
  describeUnknownError,
  type EmscriptenModule,
  type EmscriptenModuleFactory,
  type EngineLoadOptions,
} from './loadEngine';
import { parseWorldJson } from './worldJson';
import {
  type EngineCommand,
  type EngineDriver,
  type EngineInitOptions,
  type EngineStatus,
  type NewGameOptions,
  type WorldSnapshot,
} from './protocol';

const MIN_MAP_SIZE = 64;
const MAX_MAP_SIZE = 4096;
/** Ticks de secours si la carte n'est pas encore disponible après `newGame`. */
const MAP_READY_ATTEMPTS = 120;

export interface WasmEngineOptions {
  /** Fabrique Emscripten déjà chargée (tests, embarquement hors ligne). */
  factory?: EmscriptenModuleFactory;
  /** Import dynamique alternatif (tests). */
  importModule?: EngineLoadOptions['importModule'];
}

function describeError(error: unknown): string {
  return describeUnknownError(error);
}

/** Configuration transmise à `ottd_new_game_ex` (clés du pont, #60). */
function buildGameConfig(options: NewGameOptions): string {
  const config: Record<string, unknown> = {
    climate: options.climate ?? 'temperate',
    start_year: options.startYear ?? 1950,
    difficulty: options.difficulty ?? 1,
    ai_companies: options.aiCompanies ?? 0,
    map_size: Math.trunc(options.width),
  };
  return JSON.stringify(config);
}

interface MapDescriptor {
  width?: number;
  height?: number;
}

/** Lit `map.width`/`map.height` du descripteur JSON (facultatif). */
function readMapDescriptor(root: unknown): MapDescriptor {
  if (typeof root !== 'object' || root === null) return {};
  const map = (root as Record<string, unknown>).map;
  if (typeof map !== 'object' || map === null) return {};
  const record = map as Record<string, unknown>;
  return {
    width: typeof record.width === 'number' ? record.width : undefined,
    height: typeof record.height === 'number' ? record.height : undefined,
  };
}

export class WasmEngine implements EngineDriver {
  private readonly factory?: EmscriptenModuleFactory;
  private readonly importModule?: EngineLoadOptions['importModule'];

  private module: EmscriptenModule | null = null;
  private moduleUrl = '';
  private memoryBytes = 0;
  private booted = false;
  private inGame = false;

  private loading = false;
  private progress = 0;
  private tick = 0;
  private paused = false;
  private speed = 1;
  private lastError: string | null = null;
  /** Avertissements liés au chargement (mémoire), conservés entre parties. */
  private initWarnings: string[] = [];
  /** Avertissements de la partie courante (options, commandes). */
  private warnings: string[] = [];
  private initialized = false;
  private onWarning: ((message: string) => void) | null = null;
  /** Résultats de commandes à injecter dans le prochain snapshot. */
  private pendingNews: WorldSnapshot['news'] = [];

  constructor(options: WasmEngineOptions = {}) {
    this.factory = options.factory;
    this.importModule = options.importModule;
  }

  /** URL absolue réellement chargée (vide avant `init`). */
  get loadedModuleUrl(): string {
    return this.moduleUrl;
  }

  /** Mémoire linéaire allouée après instanciation, en octets. */
  get memorySize(): number {
    return this.memoryBytes;
  }

  get warningsList(): readonly string[] {
    return [...this.initWarnings, ...this.warnings];
  }

  async init(options: EngineInitOptions): Promise<void> {
    if (this.initialized) return;
    this.loading = true;
    this.progress = 0;
    this.lastError = null;
    this.onWarning = options.onWarning ?? null;

    try {
      const loaded = await loadEngine({
        moduleUrl: options.moduleUrl,
        memoryMiB: options.memoryMiB,
        debug: options.debug,
        onProgress: (progress, message) => {
          // Emscripten rappelle `setStatus` après le ready (timer interne) :
          // ignorer ces mises à jour tardives pour ne pas faire reculer la
          // barre de progression une fois le moteur prêt.
          if (this.initialized) return;
          this.progress = progress * 0.9;
          options.onProgress?.(this.progress, message);
        },
        factory: this.factory,
        importModule: this.importModule,
      });

      this.module = loaded.module;
      this.moduleUrl = loaded.moduleUrl;
      this.memoryBytes = loaded.memoryBytes;
      this.assertBridgeExports();

      this.progress = 0.92;
      options.onProgress?.(this.progress, 'Démarrage d’OpenTTD…');

      const boot = this.module._ottd_boot();
      if (boot !== 0) {
        throw new Error(this.bridgeError('ottd_boot', boot));
      }
      this.booted = true;

      if (loaded.memoryShortfall) {
        this.warnInit(
          `Mémoire demandée indisponible : le module compile ${(
            loaded.memoryBytes /
            (1024 * 1024)
          ).toFixed(1)} Mio fixes. Recompilez avec -sINITIAL_MEMORY pour changer la limite.`,
        );
      }

      this.initialized = true;
      this.progress = 1;
      options.onProgress?.(1, 'Moteur WASM prêt');
    } catch (error) {
      this.lastError = describeError(error);
      this.progress = 0;
      this.loading = false;
      this.disposeModule();
      throw error;
    } finally {
      this.loading = false;
    }
  }

  async newGame(options: NewGameOptions): Promise<void> {
    const module = this.requireModule();
    if (!this.booted) throw new Error('WasmEngine.newGame : appelez init() avant newGame().');

    const width = Math.trunc(options.width);
    const height = Math.trunc(options.height);
    if (
      !isPowerOfTwo(width) ||
      !isPowerOfTwo(height) ||
      width < MIN_MAP_SIZE ||
      height < MIN_MAP_SIZE ||
      width > MAX_MAP_SIZE ||
      height > MAX_MAP_SIZE
    ) {
      throw new Error(
        `WasmEngine.newGame : taille de carte ${width}×${height} refusée. ` +
          `Le pont exige des puissances de 2 entre ${MIN_MAP_SIZE} et ${MAX_MAP_SIZE} ` +
          '(128, 256, 512…). Choisissez une autre taille ou le moteur mock (?engine=mock).',
      );
    }

    this.warnings = [];

    const seed = Math.trunc(options.seed) >>> 0;
    let created: number;
    const newGameEx = module._ottd_new_game_ex;
    const canConfigure = typeof newGameEx === 'function';
    if (canConfigure) {
      const configJson = buildGameConfig(options);
      const stringToUTF8 = module.stringToUTF8?.bind(module);
      const lengthBytesUTF8 = module.lengthBytesUTF8?.bind(module);
      if (typeof stringToUTF8 === 'function' && typeof lengthBytesUTF8 === 'function') {
        const size = lengthBytesUTF8(configJson) + 1;
        const pointer = module._malloc(size);
        try {
          stringToUTF8(configJson, pointer, size);
          created = newGameEx(seed, width, height, pointer);
        } finally {
          module._free(pointer);
        }
      } else if (typeof module.ccall === 'function') {
        created = Number(
          module.ccall(
            'ottd_new_game_ex',
            'number',
            ['number', 'number', 'number', 'string'],
            [seed, width, height, configJson],
          ),
        );
      } else {
        throw new Error(
          'WasmEngine.newGame : le module expose ottd_new_game_ex mais pas stringToUTF8/ccall.',
        );
      }
    } else {
      // Ancien build : les options ne sont pas appliquées, on le signale.
      this.processGameOptionWarnings(options);
      created = module._ottd_new_game(seed, width, height);
    }

    if (created === 5) {
      // Partie jouable, mais certaines IA n'ont pas démarré.
      this.warn(this.bridgeError('ottd_new_game_ex', created));
    } else if (created !== 0) {
      throw new Error(
        this.bridgeError(canConfigure ? 'ottd_new_game_ex' : 'ottd_new_game', created),
      );
    }

    this.inGame = true;
    this.paused = false;
    this.speed = 1;
    this.tick = module._ottd_tick();

    // La génération est synchrone dans le pont, mais un build plus lent peut
    // pomper quelques ticks : on vérifie la carte avec une marge bornée.
    this.ensureMapReady(module, width, height);
  }

  step(ticks: number): number {
    const module = this.requireModule();
    if (!this.inGame) return 0;
    const requested = Math.max(0, Math.min(0xffffffff, Math.trunc(ticks)));
    if (requested === 0) return 0;

    const executed = module._ottd_step(requested);
    this.tick = module._ottd_tick();
    if (executed !== requested) {
      this.warn(
        `ottd_step a exécuté ${executed} tick(s) sur ${requested} demandés ` +
          '(partie terminée ou erreur interne).',
      );
    }
    return executed;
  }

  snapshot(): WorldSnapshot {
    const module = this.requireModule();
    if (!this.inGame) {
      throw new Error('WasmEngine.snapshot : aucune partie en cours.');
    }

    // Les deux appels doivent être dos à dos, sans `step()` entre eux.
    const jsonText = this.readJsonText(module);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch (error) {
      throw new Error(`WasmEngine.snapshot : JSON moteur invalide (${describeError(error)}).`, {
        cause: error,
      });
    }
    const world = parseWorldJson(parsed);
    this.ingestBridgeWarnings(parsed);
    const descriptor = readMapDescriptor(parsed);

    let decoded: DecodedMapSnapshot;
    try {
      const bytes = this.readMapBytes(module);
      decoded = decodeMapSnapshot(bytes, {
        width: descriptor.width,
        height: descriptor.height,
        tick: world.meta.tick,
      });
    } catch (error) {
      if (error instanceof MapSnapshotError) {
        throw new Error(`WasmEngine.snapshot : ${error.message}`, { cause: error });
      }
      throw error;
    }

    world.map = decoded.map;
    this.tick = world.meta.tick;
    if (this.pendingNews.length > 0) {
      world.news = [...world.news, ...this.pendingNews].slice(-50);
      this.pendingNews = [];
    }
    return world;
  }

  send(command: EngineCommand): void {
    switch (command.type) {
      case 'pause':
        // Le pont n'a pas d'entrée pause : `Game` n'appelle pas `step()` en
        // pause, l'état est donc reflété côté pilote et dans `status()`.
        this.paused = command.paused;
        return;
      case 'speed':
        this.speed = command.speed;
        return;
      case 'console':
        this.warn('Commande console ignorée : le pont WASM ne l’expose pas encore.');
        return;
      case 'build':
      case 'vehicle':
        this.executeBridgeCommand(command);
        return;
      default:
        this.warn('Commande moteur inconnue ignorée.');
    }
  }

  /** Exécute une commande build/vehicle via `ottd_command` (#11). */
  private executeBridgeCommand(command: EngineCommand): void {
    const module = this.requireModule();
    const run = module._ottd_command;
    const readResult = module._ottd_command_result;
    if (typeof run !== 'function' || typeof readResult !== 'function') {
      this.warn('Commandes indisponibles : ce build du pont ne les expose pas encore (#11).');
      return;
    }

    let result: Record<string, unknown> = {};
    try {
      const pointer = this.allocateUtf8(module, JSON.stringify(command));
      try {
        run(pointer, 0, 0);
      } finally {
        module._free(pointer);
      }
      const text = module.UTF8ToString(readResult());
      const parsed: unknown = text === '' ? {} : JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        result = parsed as Record<string, unknown>;
      }
    } catch (error) {
      this.warn(`Commande moteur illisible : ${describeError(error)}`);
      return;
    }

    const ok = result.ok === true;
    const message =
      typeof result.message === 'string' && result.message.trim() !== ''
        ? result.message
        : ok
          ? 'Commande exécutée.'
          : 'Commande refusée par le moteur.';
    this.pendingNews.push({ tick: this.tick, kind: ok ? 'info' : 'error', text: message });
    if (!ok) this.warn(message);
  }

  /** Alloue une chaîne UTF-8 dans le heap WASM (libération par l'appelant). */
  private allocateUtf8(module: EmscriptenModule, text: string): number {
    if (typeof module.stringToUTF8 !== 'function' || typeof module.lengthBytesUTF8 !== 'function') {
      throw new Error('stringToUTF8/lengthBytesUTF8 indisponibles dans ce module.');
    }
    const size = module.lengthBytesUTF8(text) + 1;
    const pointer = module._malloc(size);
    module.stringToUTF8(text, pointer, size);
    return pointer;
  }

  hash(): string {
    const module = this.requireModule();
    const raw = module._ottd_hash();
    const value = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(Number(raw)));
    return `0x${BigInt.asUintN(64, value).toString(16).padStart(16, '0')}`;
  }

  /**
   * Sérialise l'état courant de façon synchrone (#93).
   *
   * Le pont copie la sauvegarde dans le heap WASM puis rend la main : il n'y a
   * aucune promesse à attendre. Le lockstep réseau s'appuie sur cette variante
   * pour que `Runner.serialize()` soit réellement synchrone et corresponde
   * exactement au tick courant au moment du hash.
   */
  saveSync(): Uint8Array {
    const module = this.requireModule();
    if (typeof module._ottd_save_size !== 'function' || typeof module._ottd_save !== 'function') {
      throw new Error('WasmEngine.save : ce build du pont n’expose pas la sauvegarde.');
    }
    const size = module._ottd_save_size();
    if (size < 0) throw new Error(this.bridgeError('ottd_save_size', size));
    const pointer = module._malloc(size);
    try {
      const written = module._ottd_save(pointer, size);
      if (written < 0) throw new Error(this.bridgeError('ottd_save', written));
      return module.HEAPU8.slice(pointer, pointer + written);
    } finally {
      module._free(pointer);
    }
  }

  /**
   * Recharge une sauvegarde de façon synchrone (#93). Utilisé par le Runner
   * réseau : l'état est remplacé avant que `load()` ne rende la main, donc le
   * hash et le tick lus juste après sont ceux du pair source.
   */
  loadSync(data: Uint8Array): void {
    const module = this.requireModule();
    if (typeof module._ottd_load !== 'function') {
      throw new Error('WasmEngine.load : ce build du pont n’expose pas le chargement.');
    }
    if (data.length === 0) throw new Error('WasmEngine.load : sauvegarde vide.');
    const pointer = module._malloc(data.length);
    try {
      module.HEAPU8.set(data, pointer);
      const code = module._ottd_load(pointer, data.length);
      if (code !== 0) throw new Error(this.bridgeError('ottd_load', code));
      this.inGame = true;
      this.tick = module._ottd_tick();
      this.pendingNews = [];
      this.warnings = [];
    } finally {
      module._free(pointer);
    }
  }

  /** Variante asynchrone de `saveSync`, compatible `EngineDriver`. */
  async save(): Promise<Uint8Array> {
    return this.saveSync();
  }

  /** Variante asynchrone de `loadSync`, compatible `EngineDriver`. */
  async load(data: Uint8Array): Promise<void> {
    this.loadSync(data);
  }

  status(): EngineStatus {
    return {
      ready: this.initialized && this.booted,
      loading: this.loading,
      progress: this.progress,
      tick: this.module && this.booted ? this.module._ottd_tick() : this.tick,
      paused: this.paused,
      speed: this.speed,
      lastError: this.lastError,
      warnings: [...this.initWarnings, ...this.warnings],
    };
  }

  dispose(): void {
    this.initialized = false;
    this.loading = false;
    this.inGame = false;
    this.progress = 0;
    this.disposeModule();
  }

  /* ----------------------------------------------------------------------- */
  /*  Interne                                                                */
  /* ----------------------------------------------------------------------- */

  private disposeModule(): void {
    const module = this.module;
    this.module = null;
    if (!module) return;
    if (this.booted) {
      try {
        module._ottd_shutdown();
      } catch (error) {
        this.lastError = describeError(error);
      }
    }
    try {
      module.destroy?.();
    } catch {
      // Le runtime Emscripten n'est pas toujours libérable ; rien à faire.
    }
    this.booted = false;
  }

  private requireModule(): EmscriptenModule {
    if (!this.module) {
      throw new Error('WasmEngine : le module WASM n’est pas chargé (appelez init()).');
    }
    return this.module;
  }

  private assertBridgeExports(): void {
    const module = this.requireModule();
    const required = [
      '_ottd_boot',
      '_ottd_new_game',
      '_ottd_step',
      '_ottd_tick',
      '_ottd_hash',
      '_ottd_snapshot_json',
      '_ottd_snapshot_map',
      '_ottd_last_error',
      '_ottd_shutdown',
      '_malloc',
      '_free',
      'UTF8ToString',
    ] as const;
    const missing = required.filter(
      (name) => typeof (module as unknown as Record<string, unknown>)[name] !== 'function',
    );
    if (missing.length > 0) {
      throw new Error(
        `Module WASM incomplet : export(s) manquant(s) ${missing.join(', ')}. ` +
          'Vérifiez que le build active le pont OpenTT3D (OPTION_OTT3D_BRIDGE).',
      );
    }
  }

  private bridgeError(fn: string, code: number): string {
    const module = this.module;
    let detail = '';
    if (module) {
      try {
        const text = module.UTF8ToString(module._ottd_last_error());
        if (text) detail = ` — ${text}`;
      } catch {
        detail = '';
      }
    }
    return `${fn} a échoué (code ${code})${detail}`;
  }

  private warn(message: string): void {
    if (this.warnings.includes(message)) return;
    this.warnings.push(message);
    this.onWarning?.(message);
  }

  /** Warnings produits par le pont dans le JSON de snapshot (`warnings[]`). */
  private ingestBridgeWarnings(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) return;
    const warnings = (parsed as { warnings?: unknown }).warnings;
    if (!Array.isArray(warnings)) return;
    for (const entry of warnings) {
      if (typeof entry === 'string' && entry.trim() !== '') this.warn(entry);
    }
  }

  private warnInit(message: string): void {
    if (this.initWarnings.includes(message)) return;
    this.initWarnings.push(message);
    this.onWarning?.(message);
  }

  /**
   * Les options de partie non gérées par le pont sont signalées explicitement.
   * La partie démarre avec les réglages par défaut d'OpenTTD (tempéré, 1950,
   * aucune IA, difficulté normale).
   */
  private processGameOptionWarnings(options: NewGameOptions): void {
    const unsupported: string[] = [];
    const ai = options.aiCompanies ?? 0;
    if (ai > 0) unsupported.push(`entreprises IA (${ai})`);
    if (options.climate !== undefined && options.climate !== 'temperate') {
      unsupported.push(`climat « ${options.climate} »`);
    }
    if (options.startYear !== undefined && options.startYear !== 1950) {
      unsupported.push(`année de départ ${options.startYear}`);
    }
    if (options.difficulty !== undefined && options.difficulty !== 1) {
      unsupported.push(`difficulté ${options.difficulty}`);
    }
    if (unsupported.length > 0) {
      this.warn(
        `Options non appliquées par le pont WASM (#60) : ${unsupported.join(', ')}. ` +
          'La partie démarre en climat tempéré, en 1950, sans IA, difficulté normale.',
      );
    }
  }

  private ensureMapReady(module: EmscriptenModule, width: number, height: number): void {
    let attempts = 0;
    for (;;) {
      const required = module._ottd_snapshot_map(0, 0);
      if (required > 0) {
        try {
          const bytes = this.readMapBytes(module);
          const decoded = decodeMapSnapshot(bytes, { width, height });
          this.tick = decoded.tick;
          return;
        } catch (error) {
          if (error instanceof MapSnapshotError) {
            throw new Error(`WasmEngine.newGame : ${error.message}`, { cause: error });
          }
          throw error;
        }
      }
      attempts += 1;
      if (attempts > MAP_READY_ATTEMPTS) {
        throw new Error(
          `WasmEngine.newGame : la carte ${width}×${height} n’est pas disponible après ` +
            `${attempts} ticks de secours.`,
        );
      }
      if (module._ottd_step(1) !== 1) {
        throw new Error(this.bridgeError('ottd_step', 0));
      }
    }
  }

  private readJsonText(module: EmscriptenModule): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const required = module._ottd_snapshot_json(0, 0);
      if (required <= 0) {
        throw new Error(`ottd_snapshot_json a renvoyé ${required} (aucune partie en cours ?).`);
      }
      const pointer = module._malloc(required);
      try {
        const written = module._ottd_snapshot_json(pointer, required);
        if (written === required) return module.UTF8ToString(pointer);
        if (written < required) {
          throw new Error(
            `ottd_snapshot_json a écrit ${written} octets pour ${required} requis (tronqué).`,
          );
        }
        // La longueur a grandi entre le dimensionnement et l'écriture : retenter.
      } finally {
        module._free(pointer);
      }
    }
    throw new Error('ottd_snapshot_json : la taille du JSON change à chaque appel.');
  }

  private readMapBytes(module: EmscriptenModule): Uint8Array {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const required = module._ottd_snapshot_map(0, 0);
      if (required <= 0) {
        throw new Error(`ottd_snapshot_map a renvoyé ${required} (aucune partie en cours ?).`);
      }
      const pointer = module._malloc(required);
      try {
        const written = module._ottd_snapshot_map(pointer, required);
        if (written === required) {
          // `slice()` copie hors du heap : aucune vue ne survit à l'appel.
          return module.HEAPU8.slice(pointer, pointer + required);
        }
        if (written < required) {
          throw new Error(
            `ottd_snapshot_map a écrit ${written} octets pour ${required} requis (tronqué).`,
          );
        }
      } finally {
        module._free(pointer);
      }
    }
    throw new Error('ottd_snapshot_map : la taille du snapshot change à chaque appel.');
  }
}
