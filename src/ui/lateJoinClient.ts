/**
 * Client du join tardif (#92).
 *
 * `LateJoinProbe` découvre une partie déjà démarrée sur un code de salon :
 * il envoie `late-query` jusqu'à recevoir le `StartPayload` de l'hôte. Ce
 * probe tourne en parallèle du salon : si le salon répond normalement (partie
 * pas encore démarrée), il est arrêté ; si la partie tourne, l'écran de join
 * prend le relais.
 *
 * `LateJoinClient` fait le vrai travail : initialise le moteur, attend
 * l'autorisation (`ready: true`), crée le `NetSession`, envoie `requestJoin`,
 * puis consomme la sauvegarde et vérifie le hash via `onJoin`. Le résultat
 * `LateJoinPrepared` est passé tel quel à `GameSession`.
 */

import type { EngineDriver } from '../engine/protocol';
import { MockEngine } from '../engine/MockEngine';
import { WasmEngine } from '../engine/WasmEngine';
import { resolveEngineModuleUrl } from '../engine/loadEngine';
import type { StartInfo, StartPayload } from '../net/lobby-types';
import { createNetSession, type JoinEvent, type NetSession } from '../net/session';
import type { JoinRejectReason } from '../net/types';
import type { Transport } from '../net/transport';
import { createEngineRunner, type EngineRunner } from './networkRunner';
import {
  LATE_JOIN_CHANNELS,
  LATE_JOIN_PROTOCOL_VERSION,
  checkLateJoinCompatibility,
  createLateJoinStartInfo,
  freeStartPlayerIndex,
  isLateJoinOffer,
  joinRejectMessage,
  lateJoinStateFromSession,
  offerRejectMessage,
  type LateJoinOffer,
  type LateJoinQuery,
  type LateJoinUiState,
} from './netjoin';

const DEFAULT_QUERY_MS = 700;
const DEFAULT_ADMISSION_MS = 60_000;
const JOIN_POLL_MS = 16;
const JOIN_MAX_MS = 90_000;

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LateJoinError extends Error {
  readonly reason?: JoinRejectReason;

  constructor(message: string, reason?: JoinRejectReason) {
    super(message);
    this.name = 'LateJoinError';
    if (reason !== undefined) this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Découverte

export interface LateJoinProbeOptions {
  transport: Transport;
  /** Hôte attendu (lien complet) ; sinon le premier offreur fait foi. */
  hostId?: string;
  playerName?: string;
  /** Build attendu du client, pour un refus immédiat. */
  engine?: string;
  now?: () => number;
  queryMs?: number;
  onOffer: (offer: LateJoinOffer, from: string) => void;
  onDenied?: (offer: LateJoinOffer) => void;
}

/**
 * Envoie `late-query` tant qu'aucune offre n'arrive. `stop()` détache tout :
 * le transport reste utilisable pour le salon ou pour le join.
 */
export class LateJoinProbe {
  private options: LateJoinProbeOptions;
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: LateJoinProbeOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return !this.stopped && this.timer !== null;
  }

  start(): void {
    if (this.stopped || this.timer !== null) return;
    this.off = this.options.transport.on(LATE_JOIN_CHANNELS.offer, (data, from) => {
      if (!isLateJoinOffer(data)) return;
      if (this.options.hostId && from !== this.options.hostId) return;
      if (data.status === 'busy' || data.status === 'available') {
        if (data.payload) {
          const error = checkLateJoinCompatibility(data.payload);
          if (error) {
            this.stop();
            this.options.onDenied?.({
              v: LATE_JOIN_PROTOCOL_VERSION,
              k: 'late-offer',
              status: 'denied',
              reason: 'version',
              message: error,
            });
            return;
          }
          this.stop();
          this.options.onOffer(data, from);
          return;
        }
        // Rien de concret (hôte en chargement) : continuer à interroger.
        return;
      }
      if (data.status === 'open' || data.status === 'pending') {
        this.stop();
        this.options.onOffer(data, from);
        return;
      }
      this.stop();
      this.options.onDenied?.(data);
    });
    this.query();
    this.timer = setInterval(() => this.query(), this.options.queryMs ?? DEFAULT_QUERY_MS);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  private query(): void {
    if (this.stopped) return;
    const query: LateJoinQuery = {
      v: LATE_JOIN_PROTOCOL_VERSION,
      k: 'late-query',
      ...(this.options.playerName ? { name: this.options.playerName } : {}),
      ...(this.options.engine ? { engine: this.options.engine } : {}),
    };
    this.options.transport.send(LATE_JOIN_CHANNELS.query, query, this.options.hostId);
  }
}

// ---------------------------------------------------------------------------
// Join complet

export interface LateJoinPrepared {
  start: StartInfo;
  engine: EngineDriver;
  runner: EngineRunner;
  session: NetSession;
  /** Tick et hash relus après le chargement de la sauvegarde. */
  restored: { tick: number; hash: string };
}

export interface LateJoinClientOptions {
  transport: Transport;
  payload: StartPayload;
  hostId: string;
  playerName?: string;
  /** Fabrique de moteur injectable (tests, WASM Node). */
  createEngine?: (mode: StartPayload['settings']['engine']) => EngineDriver;
  engineModuleUrl?: string;
  now?: () => number;
  queryMs?: number;
  admissionMs?: number;
  joinMaxMs?: number;
  onState?: (state: LateJoinUiState) => void;
}

export class LateJoinClient {
  private options: LateJoinClientOptions;
  private engine: EngineDriver | null = null;
  private runner: EngineRunner | null = null;
  private session: NetSession | null = null;
  private state: LateJoinUiState = {
    stage: 'idle',
    message: 'Recherche de la partie en cours…',
    tone: 'info',
    progress: 0,
    received: 0,
    total: 0,
  };
  private cancelled = false;
  private finished = false;
  private lastJoinEvent: JoinEvent | null = null;

  constructor(options: LateJoinClientOptions) {
    this.options = options;
  }

  get currentState(): LateJoinUiState {
    return { ...this.state };
  }

  /** Initialise le moteur, attend l'admission puis charge la sauvegarde. */
  async prepare(): Promise<LateJoinPrepared> {
    const { payload, hostId } = this.options;
    const compatibility = checkLateJoinCompatibility(payload);
    if (compatibility) throw new LateJoinError(compatibility, 'version');

    this.setState({ stage: 'initializing', tone: 'info', message: 'Initialisation du moteur…' });
    const engine = this.createEngine(payload.settings.engine);
    this.engine = engine;
    try {
      await engine.init({
        moduleUrl:
          payload.settings.engine === 'wasm'
            ? (this.options.engineModuleUrl ?? resolveEngineModuleUrl())
            : 'mock://engine',
        onProgress: (progress, message) => {
          this.setState({
            stage: 'initializing',
            engineProgress: Math.max(0, Math.min(1, progress)),
            message: message || 'Initialisation du moteur…',
          });
        },
        onWarning: () => undefined,
      });
    } catch (error) {
      engine.dispose();
      this.engine = null;
      throw new LateJoinError(
        error instanceof Error
          ? `Moteur indisponible : ${error.message}`
          : 'Moteur indisponible pour rejoindre la partie.',
      );
    }
    this.ensureActive();

    this.setState({
      stage: 'waiting',
      tone: 'warn',
      message: 'En attente de l’autorisation de l’hôte…',
    });
    await this.waitForAdmission();

    const localPlayer = freeStartPlayerIndex(payload.peers);
    if (localPlayer < 0) {
      throw new LateJoinError('Aucune place de joueur libre dans cette partie.', 'full');
    }
    const start = createLateJoinStartInfo(payload, this.options.transport, localPlayer);
    const runner = createEngineRunner(engine);
    this.runner = runner;
    const session = createNetSession({
      runner,
      localPlayer,
      transport: this.options.transport,
      isHost: false,
      hostId,
      peers: payload.peers,
      engine: payload.engineBuild,
      ...(this.options.playerName ? { playerName: this.options.playerName } : {}),
      joinTimeoutMs: 60_000,
    });
    this.session = session;
    const offJoin = session.onJoin((event) => {
      this.lastJoinEvent = event;
    });

    this.setState({
      stage: 'requesting',
      tone: 'info',
      message: 'Demande de join envoyée à l’hôte…',
    });
    const requested = session.requestJoin(hostId, localPlayer);
    if (!requested) {
      offJoin();
      throw new LateJoinError('Impossible d’envoyer la demande de join à l’hôte.');
    }

    const startedAt = (this.options.now ?? nowMs)();
    const maxMs = this.options.joinMaxMs ?? JOIN_MAX_MS;
    try {
      for (;;) {
        this.ensureActive();
        const phase = session.joinPhase();
        const progress = session.joinProgress();
        const mapped = lateJoinStateFromSession(progress, this.state);
        const event = this.lastJoinEvent;
        if (event && !event.ok) {
          this.setState({
            ...mapped,
            stage: 'rejected',
            tone: 'error',
            message: joinRejectMessage(event.reason ?? 'closed', event.message),
          });
          throw new LateJoinError(
            joinRejectMessage(event.reason ?? 'closed', event.message),
            event.reason,
          );
        }
        if (phase === 'joined') {
          const tick = session.stats().tick;
          const hash = runner.hash();
          this.setState({
            ...mapped,
            stage: 'joined',
            tone: 'ok',
            tick,
            player: session.localPlayer,
            message: `Partie rejointe au tick ${tick} : hash vérifié, reprise des ticks.`,
          });
          this.finished = true;
          offJoin();
          return { start, engine, runner, session, restored: { tick, hash } };
        }
        this.setState(mapped);
        session.update((this.options.now ?? nowMs)());
        await delay(JOIN_POLL_MS);
        if ((this.options.now ?? nowMs)() - startedAt > maxMs) {
          this.setState({
            ...mapped,
            stage: 'rejected',
            tone: 'error',
            message: 'Délai de join dépassé : l’hôte n’a pas terminé le transfert.',
          });
          throw new LateJoinError(
            'Délai de join dépassé : l’hôte n’a pas terminé le transfert.',
            'timeout',
          );
        }
      }
    } catch (error) {
      offJoin();
      throw error;
    }
  }

  /** Annule le join et libère moteur/session (le transport reste à l'appelant). */
  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    this.session?.dispose();
    this.session = null;
    this.engine?.dispose();
    this.engine = null;
    this.setState({
      stage: 'rejected',
      tone: 'error',
      message: 'Join annulé.',
    });
  }

  // ------------------------------------------------------------------ interne

  private createEngine(mode: StartPayload['settings']['engine']): EngineDriver {
    if (this.options.createEngine) return this.options.createEngine(mode);
    return mode === 'wasm' ? new WasmEngine() : new MockEngine();
  }

  private async waitForAdmission(): Promise<void> {
    const { hostId } = this.options;
    const deadline =
      (this.options.now ?? nowMs)() + (this.options.admissionMs ?? DEFAULT_ADMISSION_MS);
    let settled: 'open' | 'denied' | null = null;
    let denial: string | null = null;
    let denialReason: JoinRejectReason = 'closed';

    const off = this.options.transport.on(LATE_JOIN_CHANNELS.offer, (data, from) => {
      if (settled !== null || !isLateJoinOffer(data)) return;
      if (from !== hostId) return;
      if (data.status === 'open') {
        settled = 'open';
      } else if (data.status === 'denied') {
        settled = 'denied';
        denial = offerRejectMessage(data);
        denialReason = data.reason ?? 'closed';
      } else if (data.status === 'pending') {
        this.setState({
          stage: 'waiting',
          tone: 'warn',
          message: data.message || 'L’hôte doit autoriser votre arrivée dans la partie.',
        });
      } else if (data.status === 'busy') {
        this.setState({
          stage: 'waiting',
          tone: 'warn',
          message: data.message || 'L’hôte prépare encore la partie…',
        });
      }
    });

    const sendReady = (): void => {
      const query: LateJoinQuery = {
        v: LATE_JOIN_PROTOCOL_VERSION,
        k: 'late-query',
        ready: true,
        engine: this.options.payload.engineBuild,
        ...(this.options.playerName ? { name: this.options.playerName } : {}),
      };
      this.options.transport.send(LATE_JOIN_CHANNELS.query, query, hostId);
    };

    try {
      sendReady();
      while (settled === null) {
        this.ensureActive();
        if ((this.options.now ?? nowMs)() > deadline) {
          throw new LateJoinError(
            'L’hôte n’a pas répondu à la demande de join. Vérifiez qu’il a ouvert la partie aux retardataires.',
            'timeout',
          );
        }
        await delay(this.options.queryMs ?? 400);
        if (settled === null) sendReady();
      }
    } finally {
      off();
    }

    if (settled === 'denied') {
      this.setState({
        stage: 'rejected',
        tone: 'error',
        message: denial ?? 'Join refusé par l’hôte.',
      });
      throw new LateJoinError(denial ?? 'Join refusé par l’hôte.', denialReason);
    }
  }

  private ensureActive(): void {
    if (this.cancelled) throw new LateJoinError('Join annulé.');
  }

  private setState(patch: Partial<LateJoinUiState>): void {
    this.state = { ...this.state, ...patch };
    try {
      this.options.onState?.(this.currentState);
    } catch (error) {
      console.error('[ui:late-join] onState handler error', error);
    }
  }
}
