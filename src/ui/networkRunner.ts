/**
 * Adaptateurs entre le moteur (`EngineDriver`) et le lockstep (`Runner`).
 *
 * Le réseau ne transporte que des commandes et des hashes : chaque pair
 * exécute le même tick sur le même moteur. `createEngineRunner` traduit donc
 * les appels synchrones du `Runner` (`tick`, `step`, `hash`, `serialize`,
 * `load`) vers le contrat du moteur, tandis que `createLockstepDriver` sert de
 * façade à `Game` pour que le rendu suive des ticks déjà séquencés par
 * `NetSession`, sans jamais avancer le moteur de son côté.
 *
 * Depuis #93, le moteur WASM expose `saveSync`/`loadSync` : la sauvegarde
 * réseau est alors réellement synchrone et correspond au tick courant, ce que
 * le resync et le join exigent. Le mock conserve son chemin historique (cache
 * rempli en microtâche) car son `save()` ne publie pas encore de variante
 * synchrone.
 */

import type { EngineCommand, EngineDriver, WorldSnapshot } from '../engine/protocol';
import { decodeBase64, encodeBase64 } from '../game/base64';
import type { Runner } from '../net/session';
import type { Command } from '../net/types';

/** Moteurs capables de sérialiser/recharger sans promesse (WASM, #93). */
export interface SyncSaveEngine {
  saveSync(): Uint8Array;
  loadSync(data: Uint8Array): void;
}

/** Vrai si le pilote expose la paire synchrone attendue par le lockstep. */
export function isSyncSaveEngine(engine: EngineDriver): engine is EngineDriver & SyncSaveEngine {
  const candidate = engine as unknown as Partial<SyncSaveEngine>;
  return typeof candidate.saveSync === 'function' && typeof candidate.loadSync === 'function';
}

export interface EngineRunner extends Runner {
  readonly driver: EngineDriver;
  /** Vrai si `serialize()`/`load()` sont synchrones et exacts (WASM). */
  readonly synchronous: boolean;
  /** Force une sauvegarde et renvoie le format texte du runner. */
  saveNow(): Promise<string>;
}

interface SaveEnvelope {
  tick: number;
  data: string;
}

/** Commandes locales à ne jamais séquencer : elles casseraient le lockstep. */
function isLocalOnly(command: EngineCommand): boolean {
  return command.type === 'pause' || command.type === 'speed';
}

function parseEnvelope(text: string): SaveEnvelope {
  let envelope: SaveEnvelope;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SaveEnvelope).tick !== 'number' ||
      typeof (parsed as SaveEnvelope).data !== 'string'
    ) {
      throw new Error('format inconnu');
    }
    envelope = parsed as SaveEnvelope;
  } catch {
    throw new Error('Sauvegarde réseau illisible.');
  }
  return envelope;
}

function parseSave(text: string): Uint8Array {
  return decodeBase64(parseEnvelope(text).data);
}

/**
 * `Runner` adossé à un `EngineDriver`. Le moteur doit être en pause désactivée
 * et en vitesse 1 : les commandes pause/vitesse ne sont pas séquencées en
 * réseau (elles sont désactivées dans l'UI).
 */
export function createEngineRunner(engine: EngineDriver): EngineRunner {
  const synchronous = isSyncSaveEngine(engine);
  let cached: SaveEnvelope | null = null;
  let saving: Promise<SaveEnvelope> | null = null;

  function refresh(): Promise<SaveEnvelope> {
    if (saving) return saving;
    saving = engine
      .save()
      .then((bytes) => {
        const envelope: SaveEnvelope = {
          tick: engine.status().tick,
          data: encodeBase64(bytes),
        };
        cached = envelope;
        saving = null;
        return envelope;
      })
      .catch((error: unknown) => {
        saving = null;
        throw error;
      });
    return saving;
  }

  function step(commands: Command[]): void {
    for (const command of commands) {
      if (isLocalOnly(command)) continue;
      engine.send(command);
    }
    const before = engine.status().tick;
    const executed = engine.step(1);
    const after = engine.status().tick;
    if (executed !== 1 || after !== before + 1) {
      throw new Error(
        `Le moteur n'a pas avancé d'un tick (demandé 1, exécuté ${executed}, ${before} → ${after}).`,
      );
    }
  }

  function serialize(): string {
    if (synchronous && isSyncSaveEngine(engine)) {
      const tick = engine.status().tick;
      const envelope: SaveEnvelope = { tick, data: encodeBase64(engine.saveSync()) };
      cached = envelope;
      return JSON.stringify(envelope);
    }
    const tick = engine.status().tick;
    if (cached && cached.tick === tick) return JSON.stringify(cached);
    // La sauvegarde mock s'exécute immédiatement ; le cache est prêt à la
    // microtâche suivante. Entre-temps, on renvoie la dernière sauvegarde
    // connue plutôt que de bloquer la boucle.
    void refresh().catch((error: unknown) => {
      console.warn('[net:runner] sauvegarde impossible', error);
    });
    return cached ? JSON.stringify(cached) : '';
  }

  function load(data: string): void {
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('Resynchronisation impossible : aucune sauvegarde reçue.');
    }
    if (synchronous && isSyncSaveEngine(engine)) {
      const envelope = parseEnvelope(data);
      const bytes = decodeBase64(envelope.data);
      engine.loadSync(bytes);
      const tick = engine.status().tick;
      if (tick !== envelope.tick) {
        throw new Error(
          `Sauvegarde réseau incohérente : tick ${tick} chargé, ${envelope.tick} annoncé.`,
        );
      }
      cached = envelope;
      return;
    }
    const bytes = parseSave(data);
    // `MockEngine.load` applique son état de façon synchrone avant de rendre
    // la promesse.
    void engine.load(bytes).catch((error: unknown) => {
      console.warn('[net:runner] chargement de sauvegarde impossible', error);
    });
    const envelope = parseEnvelope(data);
    cached = envelope;
  }

  return {
    driver: engine,
    synchronous,
    tick: () => engine.status().tick,
    step,
    hash: () => engine.hash(),
    serialize,
    load,
    saveNow: async () => (synchronous ? serialize() : JSON.stringify(await refresh())),
  };
}

export interface LockstepGameDriver extends EngineDriver {
  /** Nombre de ticks exécutés par `NetSession` depuis le dernier prélèvement. */
  addExecuted(ticks: number): void;
  readonly executed: number;
}

/**
 * Façade utilisée par `Game` en réseau. `Game.advance()` continue de mesurer
 * le temps réel et de prendre des snapshots, mais `step()` ne fait qu'annoncer
 * les ticks déjà exécutés par le lockstep : le moteur n'est jamais avancé deux
 * fois.
 */
export function createLockstepDriver(engine: EngineDriver): LockstepGameDriver {
  let pending = 0;
  let consumed = 0;

  return {
    get executed() {
      return consumed;
    },
    addExecuted(ticks: number) {
      if (!Number.isFinite(ticks) || ticks <= 0) return;
      pending += Math.floor(ticks);
    },
    step(ticks: number) {
      void ticks;
      const executed = pending;
      pending = 0;
      consumed += executed;
      return executed;
    },
    init: (options) => engine.init(options),
    newGame: (options) => engine.newGame(options),
    snapshot: (): WorldSnapshot => engine.snapshot(),
    send: (command) => engine.send(command),
    hash: () => engine.hash(),
    save: () => engine.save(),
    load: (data) => engine.load(data),
    status: () => engine.status(),
    dispose: () => engine.dispose(),
  };
}
