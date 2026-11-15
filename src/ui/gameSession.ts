/**
 * Session de jeu : moteur (mock ou WASM), boucle `Game`, renderer, monde 3D et HUD.
 *
 * `GameSession` est le seul module qui assemble le moteur et la présentation
 * pour une partie. Il ne connaît pas les écrans : le bootstrap lui fournit des
 * callbacks (pause, fin de partie, changement de qualité) et peut tout
 * libérer avec `dispose()` avant de revenir au menu.
 *
 * Le moteur est choisi par `?engine=mock|wasm` (défaut : mock). Le mode WASM
 * charge OpenTTD réel depuis `public/engine/` ; le mode mock reste le chemin de
 * développement quand les artefacts sont absents.
 */

import type { AudioEngine } from '../audio/AudioEngine';
import { SessionAudio } from '../audio/sessionAudio';
import type {
  CompanySnapshot,
  EngineCommand,
  EngineDriver,
  WorldSnapshot,
} from '../engine/protocol';
import { TILE_FLAG } from '../engine/protocol';
import { MockEngine } from '../engine/MockEngine';
import { WasmEngine } from '../engine/WasmEngine';
import { engineBuildId, resolveEngineModuleUrl, type EngineMode } from '../engine/loadEngine';
import { Game, type GameSpeed, type Selection } from '../game/Game';
import {
  cloneBuildSettings,
  commandFromPlan,
  createBuildSettings,
  nextDirection,
  planBuild,
  type BuildPlan,
  type BuildSettings,
  type BuildTool,
} from '../game/buildRules';
import { tileKindAt } from '../game/mapGrid';
import {
  buyVehicleCommand,
  depotAtTile,
  depotOrder,
  orderVehicleCommand,
  ordersFromSnapshot,
  stationAtTile,
  stationOrder,
  validateVehicleOrders,
  vehicleActionCommand,
  type VehicleOrder,
} from '../game/vehicleRules';
import type { StartInfo } from '../net/lobby-types';
import { NET_TICK_MS, createNetSession, type NetSession, type NetUpdate } from '../net/session';
import { Renderer } from '../render/Renderer';
import { WorldView, type WorldTarget } from '../render/WorldView';
import { nextQuality, type QualityLevel } from '../render/quality';
import { Hud } from './Hud';
import { BuildController } from './buildController';
import { describeBuildPlan } from './buildHint';
import type { NewGameOptions } from './gameOptions';
import { formatGameDate, formatMoney } from './format';
import type { BuildToolId } from './hud/Toolbar';
import {
  AutosaveScheduler,
  DEFAULT_AUTOSAVE,
  type AutosaveConfig,
  type SaveEngine,
  type SaveGameDate,
} from './saveFormat';
import {
  describeNetworkStatus,
  localCompanyForStart,
  mapStartInfoToGameOptions,
  networkControlsLocked,
  peerNamesFromStart,
  planNetworkEngine,
} from './netlobby';
import {
  createEngineRunner,
  createLockstepDriver,
  type EngineRunner,
  type LockstepGameDriver,
} from './networkRunner';
import { describeSelection } from './selection';
import { describeDepotPanel, describeVehiclePanel } from './vehicleView';
import type { GameSettings } from './settings';
import type { GameOverSummary, NetworkStatusView, SessionOverview } from './types';

export interface LoadToken {
  cancelled: boolean;
}

export class LoadCancelledError extends Error {
  constructor() {
    super('Chargement annulé.');
    this.name = 'LoadCancelledError';
  }
}

export interface GameSessionCallbacks {
  onProgress?: (progress: number, message: string) => void;
  onPauseRequested: () => void;
  onOpenSettings: () => void;
  onGameOver: (summary: GameOverSummary) => void;
  onQualityChange?: (quality: QualityLevel) => void;
  /** Réseau uniquement : plus aucun hôte vivant, la session est perdue. */
  onNetworkLost?: (reason: string) => void;
  /**
   * Autosave due (intervalle réel ou ticks atteints). Le bootstrap capture et
   * écrit le slot ; la session ne connaît pas IndexedDB.
   */
  onAutosave?: () => void;
}

/** Sauvegarde à restaurer au démarrage de la session. */
export interface LoadedGameInput {
  bytes: Uint8Array;
  /** Options d'affichage/qualité et métadonnées connues du slot. */
  options: NewGameOptions;
  /** Moteur qui a produit le conteneur. */
  engine: EngineMode;
  /** Nom du slot, pour les messages du HUD. */
  name?: string;
}

/**
 * Session réseau déjà établie par le join tardif (#92). Le moteur a chargé la
 * sauvegarde de l'hôte et le hash a été vérifié par `NetSession` : la session
 * de jeu n'a plus qu'à construire le rendu et le HUD autour de cet état.
 */
export interface PreparedJoinInput {
  start: StartInfo;
  engine: EngineDriver;
  runner: EngineRunner;
  session: NetSession;
  restored: { tick: number; hash: string };
}

/** Instantané sérialisable d'une partie, prêt pour `SaveStore.save`. */
export interface CapturedSave {
  bytes: Uint8Array;
  engine: SaveEngine;
  seed: number;
  mapSize: number;
  gameDate: SaveGameDate | null;
  companies: string[];
  tick: number;
  protocol: number | null;
}

export interface GameSessionOptions {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  config: NewGameOptions;
  settings: GameSettings;
  callbacks: GameSessionCallbacks;
  /** Moteur à utiliser (défaut : mock). */
  engine?: EngineMode;
  /** Force l'URL du module WASM (défaut : `public/engine/`). */
  engineModuleUrl?: string;
  /**
   * Démarre une partie lockstep à partir du salon. Le moteur vient du
   * `StartInfo` (`settings.engine`), identique sur tous les pairs (#93).
   */
  network?: StartInfo;
  /** Session déjà chargée par le join tardif (#92). */
  preparedJoin?: PreparedJoinInput;
  /** Restaure une sauvegarde au lieu de générer une nouvelle partie. */
  loadedGame?: LoadedGameInput;
  /** Autosave : intervalles réels/ticks, ou `false` pour désactiver. */
  autosave?: AutosaveConfig | false;
  /**
   * Moteur audio partagé avec l'application (déverrouillé au premier geste).
   * Sans lui, la session crée et libère son propre moteur.
   */
  audio?: AudioEngine;
}

const HUD_REFRESH_SECONDS = 0.2;
const MINIMAP_REFRESH_SECONDS = 0.1;

const BUILD_TOOL_INTROS: Record<BuildTool, string> = {
  road: 'Routes : cliquez ou glissez pour tracer un tronçon',
  rail: 'Rails : cliquez ou glissez pour tracer un tronçon',
  clear: 'Démolition : cliquez ou glissez sur une voie',
  station: 'Gares : réglez la taille et l’orientation, puis cliquez pour poser',
  depot: 'Dépôts : cliquez à côté d’une voie, R oriente l’entrée',
  signal: 'Signaux : cliquez ou glissez le long d’une voie ferrée',
};

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

export class GameSession {
  readonly config: NewGameOptions;
  readonly engineMode: EngineMode;
  readonly network: StartInfo | null;

  private canvas: HTMLCanvasElement;
  private uiRoot: HTMLElement;
  private settings: GameSettings;
  private callbacks: GameSessionCallbacks;
  private engineModuleUrl: string;
  private sharedAudio: AudioEngine | null;
  private audio: SessionAudio | null = null;

  private engine: EngineDriver | null = null;
  private game: Game | null = null;
  private renderer: Renderer | null = null;
  private world: WorldView | null = null;
  private hud: Hud | null = null;
  private buildController: BuildController | null = null;
  private buildTool: BuildToolId | null = null;
  private buildSettings: BuildSettings = createBuildSettings();
  /** Dernier tronçon confirmé par le moteur, pour Ctrl+Z. */
  private lastBuild: BuildPlan | null = null;
  private engineBadge: HTMLDivElement | null = null;
  private engineWarnings: string[] = [];

  private netSession: NetSession | null = null;
  private netRunner: EngineRunner | null = null;
  private lockstep: LockstepGameDriver | null = null;
  private preparedJoin: PreparedJoinInput | null;
  private lastNetUpdate: NetUpdate | null = null;
  private peerNames: Record<string, string> = {};
  private networkWarnings: string[] = [];
  private networkLostNotified = false;
  private lastNetworkNoticeAt = -Infinity;
  private lastNetworkSaveAt = 0;
  private networkSavePending = false;

  private quality: QualityLevel;
  private lastTarget: WorldTarget | null = null;
  /** Dépôt ouvert par un clic (id stable de `snapshot.depots`). */
  private openDepot: number | null = null;
  /** Véhicule dont la tournée attend un clic sur une gare/dépôt. */
  private orderPickingFor: number | null = null;
  private hudTimer = 0;
  private minimapTimer = 0;
  private disposed = false;
  private inputEnabled = true;
  private gameOverShown = false;
  private loadedGame: LoadedGameInput | null = null;
  private restoredState: { tick: number; hash: string } | null = null;
  private autosave: AutosaveScheduler | null = null;
  private saveChip: HTMLDivElement | null = null;
  private saveChipTimer = 0;

  constructor(options: GameSessionOptions) {
    this.canvas = options.canvas;
    this.uiRoot = options.uiRoot;
    this.preparedJoin = options.preparedJoin ?? null;
    this.network = this.preparedJoin?.start ?? options.network ?? null;
    this.loadedGame = this.network ? null : (options.loadedGame ?? null);
    this.config = this.network
      ? mapStartInfoToGameOptions(this.network, options.config.quality).options
      : (this.loadedGame?.options ?? options.config);
    if (this.network) {
      this.networkWarnings = mapStartInfoToGameOptions(
        this.network,
        options.config.quality,
      ).warnings;
    }
    this.settings = options.settings;
    this.callbacks = options.callbacks;
    this.sharedAudio = options.audio ?? null;
    this.quality = this.config.quality;
    this.engineMode = this.network
      ? this.network.settings.engine
      : (this.loadedGame?.engine ?? options.engine ?? 'mock');
    this.engineModuleUrl = options.engineModuleUrl ?? resolveEngineModuleUrl();
    this.autosave =
      this.network || options.autosave === false
        ? null
        : new AutosaveScheduler(options.autosave ?? DEFAULT_AUTOSAVE);
  }

  get isNetwork(): boolean {
    return this.network !== null;
  }

  get networkSession(): NetSession | null {
    return this.netSession;
  }

  get engineInstance(): EngineDriver | null {
    return this.engine;
  }

  get gameInstance(): Game | null {
    return this.game;
  }

  get rendererInstance(): Renderer | null {
    return this.renderer;
  }

  get worldInstance(): WorldView | null {
    return this.world;
  }

  get hudInstance(): Hud | null {
    return this.hud;
  }

  get currentQuality(): QualityLevel {
    return this.quality;
  }

  /** Tick et hash relevés juste après `engine.load`, avant reprise. */
  get restoredStateInfo(): { tick: number; hash: string } | null {
    return this.restoredState ? { ...this.restoredState } : null;
  }

  async load(token: LoadToken): Promise<void> {
    const config = this.config;
    const wasm = this.engineMode === 'wasm';
    const restoring = this.loadedGame !== null;
    if (this.network) {
      // Refus explicite d'un mélange mock/WASM ou d'un build différent avant
      // toute allocation de moteur : les pairs doivent partir du même état.
      const plan = planNetworkEngine(this.network);
      if (plan.error) throw new Error(plan.error);
    }
    this.report(
      0.03,
      restoring
        ? 'Préparation de la restauration…'
        : this.isNetwork
          ? wasm
            ? 'Préparation de la session réseau (moteur OpenTTD WASM)…'
            : 'Préparation de la session réseau (moteur mock déterministe)…'
          : wasm
            ? 'Chargement du moteur OpenTTD (WebAssembly)…'
            : 'Initialisation du moteur mock…',
    );
    const prepared = this.preparedJoin;
    let engine: EngineDriver;
    if (prepared) {
      engine = prepared.engine;
      this.engine = engine;
      this.restoredState = { ...prepared.restored };
      this.report(0.34, `Partie rejointe au tick ${prepared.restored.tick} : chargement du rendu…`);
      await nextFrame();
      this.ensureActive(token);
    } else {
      engine = wasm ? new WasmEngine() : new MockEngine();
      this.engine = engine;
      await engine.init({
        moduleUrl: wasm ? this.engineModuleUrl : 'mock://engine',
        onProgress: (progress, message) => {
          this.report(0.04 + Math.max(0, Math.min(1, progress)) * 0.34, message);
        },
        onWarning: (message) => this.recordEngineWarning(message),
      });
      this.collectEngineWarnings();
      this.ensureActive(token);

      if (this.loadedGame) {
        this.report(0.42, 'Restauration de la sauvegarde…');
        await nextFrame();
        this.ensureActive(token);
        // `load()` du pilote remplace l'état atomiquement : la première snapshot
        // reçue est complète (les séquences repartent à zéro côté pont).
        await engine.load(this.loadedGame.bytes);
        this.restoredState = { tick: engine.status().tick, hash: engine.hash() };
        this.collectEngineWarnings();
        this.ensureActive(token);
      } else {
        this.report(
          0.42,
          wasm
            ? 'Génération de la carte OpenTTD…'
            : this.isNetwork
              ? 'Génération déterministe du monde partagé…'
              : 'Génération de la carte et des réseaux…',
        );
        await nextFrame();
        this.ensureActive(token);
        await engine.newGame({
          seed: config.seed,
          width: config.size,
          height: config.size,
          aiCompanies: config.aiCompanies,
          difficulty: config.difficulty,
          startYear: config.startYear,
          climate: config.climate,
          ...(config.companies && config.companies.length > 0
            ? { companies: config.companies }
            : {}),
        });
        this.collectEngineWarnings();
        this.ensureActive(token);
      }
    }

    if (this.network) {
      if (prepared) this.adoptPreparedJoin(prepared, engine);
      else this.createNetworkSession(engine);
      // Chaque pair applique l'entreprise de son joueur (#99), y compris après
      // le chargement d'une sauvegarde produite par l'hôte.
      this.applyLocalCompany(engine);
    }
    this.ensureActive(token);

    this.report(0.52, 'Création de la boucle de jeu…');
    await nextFrame();
    this.ensureActive(token);
    const game = this.isNetwork
      ? new Game({
          driver: this.lockstep ?? engine,
          ticksPerSecond: 1000 / NET_TICK_MS,
          commandSink: (command) => this.issueNetworkCommand(command),
        })
      : new Game({ driver: engine });
    this.game = game;

    this.report(0.58, 'Initialisation du rendu 3D…');
    await nextFrame();
    this.ensureActive(token);
    this.renderer = new Renderer({ canvas: this.canvas, quality: this.quality });
    this.buildController = this.createBuildController();
    this.world = this.createWorld(this.renderer);
    this.hud = this.createHud();
    this.audio = new SessionAudio({
      ...(this.sharedAudio ? { engine: this.sharedAudio } : {}),
      quality: this.quality,
      settings: this.settings,
    });
    this.attachEvents(game);
    this.attachListeners();
    this.createEngineBadge();
    this.createSaveChip();

    // `game.start()` capture le premier snapshot et émet les news initiales,
    // désormais écoutées par le HUD.
    game.start();
    this.refreshHud();
    this.announceEngine();
    if (this.loadedGame) {
      this.hud.notify(
        'info',
        `Partie restaurée${this.loadedGame.name ? ` : « ${this.loadedGame.name} »` : ''}.`,
      );
    }
    if (this.preparedJoin) {
      this.hud.notify(
        'info',
        `Partie rejointe en cours : tick ${this.preparedJoin.restored.tick}, hash vérifié avec l’hôte.`,
      );
    }

    this.report(0.82, 'Construction du terrain…');
    const buildStart = performance.now();
    await nextFrame();
    this.ensureActive(token);
    this.renderer.renderNow();
    const buildMs = Math.round(performance.now() - buildStart);

    this.report(0.94, 'Échauffement du rendu…');
    await nextFrame();
    this.ensureActive(token);
    this.startNetworkSession();
    this.renderer.start((delta) => this.frame(delta));
    this.updateCameraFrame();
    this.refreshHud();
    this.report(1, 'Monde prêt');

    const snapshot = game.getLatestSnapshot();
    this.hud.notify(
      'info',
      this.loadedGame
        ? `Sauvegarde restaurée en ${buildMs} ms.`
        : this.preparedJoin
          ? `Partie rejointe en ${buildMs} ms : rendu prêt au tick ${this.preparedJoin.restored.tick}.`
          : `Monde ${config.size}×${config.size} généré en ${buildMs} ms.`,
    );
    this.hud.notify(
      'info',
      'Clic : sélection · double-clic : suivre · Échap : pause · Espace : pause.',
    );
    this.hud.notify(
      'info',
      'Routes, rails, gares, dépôts et signaux : barre du bas, puis cliquez sur la carte.',
    );
    this.hud.notify(
      'info',
      'Un dépôt ouvert permet d’acheter un véhicule ; ajoutez ensuite ses gares puis démarrez-le.',
    );
    if (snapshot) this.monitorGameOver(snapshot);
  }

  /** Résume le moteur actif et relaie les avertissements du pont. */
  private announceEngine(): void {
    const hud = this.hud;
    if (!hud) return;
    if (this.isNetwork) {
      hud.notify(
        'info',
        this.preparedJoin
          ? `Session réseau rejointe en cours (${this.engineMode === 'wasm' ? 'WASM' : 'mock'}) : sauvegarde de l’hôte chargée, hash vérifié, reprise des ticks.`
          : this.engineMode === 'wasm'
            ? 'Session réseau lockstep : moteur OpenTTD WASM, état partagé par hashes.'
            : 'Session réseau lockstep : moteur mock déterministe, état partagé par hashes.',
      );
    } else if (this.engineMode === 'wasm') {
      hud.notify('info', 'Moteur WASM : simulation OpenTTD réelle.');
    } else {
      hud.notify('info', 'Moteur simulé (Mock) : partie de démonstration.');
    }
    for (const warning of this.engineWarnings) hud.notify('warning', warning);
    for (const warning of this.networkWarnings) hud.notify('warning', warning);
  }

  /**
   * Prépare le runner du lockstep sur le moteur déjà généré. La session
   * elle-même n'est créée qu'une fois le rendu prêt (`startNetworkSession`) :
   * l'hôte n'attend ainsi un `hello` que lorsque le pair peut réellement
   * exécuter les tours, au lieu de le voir « en retard » pendant le chargement.
   */
  private createNetworkSession(engine: EngineDriver): void {
    const start = this.network;
    if (!start) return;
    this.netRunner = createEngineRunner(engine);
    this.lockstep = createLockstepDriver(engine);
    this.peerNames = peerNamesFromStart(start);
    this.lastNetworkSaveAt = this.networkNow();
    if (this.netRunner.synchronous) {
      // `serialize()` WASM est exact et synchrone : aucun cache à amorcer, le
      // resync sérialise à la demande depuis le tick courant.
      return;
    }
    // Amorce le cache de sauvegarde mock : si un resync est demandé, l'hôte a
    // au moins un état chargeable au lieu d'un message vide.
    void this.netRunner.saveNow().catch((error: unknown) => {
      console.warn('[net:session] sauvegarde initiale indisponible', error);
    });
  }

  /**
   * Adopte la session déjà chargée par le join tardif (#92). Le moteur, le
   * runner et le `NetSession` ont vérifié la sauvegarde et le hash : on ne
   * recrée ni moteur ni session, on rebranche seulement le rendu et le HUD.
   */
  private adoptPreparedJoin(prepared: PreparedJoinInput, engine: EngineDriver): void {
    this.netRunner = prepared.runner;
    this.lockstep = createLockstepDriver(engine);
    this.netSession = prepared.session;
    this.peerNames = peerNamesFromStart(prepared.start);
    this.lastNetworkSaveAt = this.networkNow();
    this.attachNetHandlers();
  }

  /** Ouvre le lockstep : hellos, tours et hashes commencent ici. */
  private startNetworkSession(): void {
    const start = this.network;
    const runner = this.netRunner;
    if (!start || !runner || this.netSession) return;
    const hostPlayer = start.players.find((player) => player.isHost);
    const hostId = hostPlayer ? start.peers[hostPlayer.player] : undefined;
    const playerName = start.players.find((player) => player.player === start.localPlayer)?.name;
    const companies: Record<number, number> = {};
    for (const player of start.players) {
      if (player.company !== undefined) companies[player.player] = player.company;
    }
    this.netSession = createNetSession({
      runner,
      localPlayer: start.localPlayer,
      transport: start.transport,
      isHost: start.isHost,
      ...(start.isHost ? {} : { hostId }),
      peers: start.peers,
      engine: engineBuildId(this.engineMode),
      maxPlayers: start.settings.maxPlayers,
      ...(Object.keys(companies).length > 0 ? { companies } : {}),
      ...(start.companySeats === undefined ? {} : { companySeats: start.companySeats }),
      // Une sauvegarde WASM peut être volumineuse : garder la fenêtre ouverte
      // plus longtemps que le défaut de 15 s, sans bloquer la partie au-delà.
      joinTimeoutMs: 60_000,
      ...(playerName ? { playerName } : {}),
    });
    this.attachNetHandlers();
  }

  /** Abonnements communs au démarrage initial et au join tardif. */
  private attachNetHandlers(): void {
    const session = this.netSession;
    if (!session) return;
    session.onDesync(() => {
      this.hud?.notify('warning', 'Divergence détectée : resynchronisation avec l’hôte…');
      // Le runner vient de recharger un tick plus avancé : rafraîchit la vue
      // sans attendre le prochain snapshot périodique.
      this.game?.refresh();
    });
    session.onChat(({ player, text }) => {
      const name = this.network?.players.find((item) => item.player === player)?.name ?? 'Joueur';
      this.hud?.notify('info', `${name} : ${text}`);
    });
  }

  private recordEngineWarning(message: string): void {
    if (this.engineWarnings.includes(message)) return;
    this.engineWarnings.push(message);
    this.hud?.notify('warning', message);
    this.refreshEngineBadge();
  }

  /** Récupère les avertissements cumulés par le pilote (options, mémoire…). */
  private collectEngineWarnings(): void {
    const status = this.engine?.status();
    for (const warning of status?.warnings ?? []) this.recordEngineWarning(warning);
  }

  /**
   * Pastille discrète « Moteur WASM » / « Mock » en bas à gauche. Elle ne
   * recouvre aucun contrôle du HUD et expose les avertissements en infobulle.
   */
  private createEngineBadge(): void {
    if (this.engineBadge) return;
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.dataset.engine = this.engineMode;
    badge.style.position = 'fixed';
    badge.style.left = '12px';
    badge.style.bottom = '12px';
    badge.style.zIndex = '40';
    badge.style.pointerEvents = 'auto';
    badge.style.userSelect = 'none';
    this.uiRoot.append(badge);
    this.engineBadge = badge;
    this.refreshEngineBadge();
  }

  private refreshEngineBadge(): void {
    const badge = this.engineBadge;
    if (!badge) return;
    const label = this.isNetwork
      ? this.engineMode === 'wasm'
        ? 'WASM · réseau'
        : 'Mock · réseau'
      : this.engineMode === 'wasm'
        ? 'Moteur WASM'
        : 'Mock';
    badge.textContent = label;
    const details: string[] = [
      this.isNetwork
        ? `Lockstep réseau · ${this.engineMode === 'wasm' ? engineBuildId('wasm') : 'mock déterministe'} · seed ${this.config.seed} · ${this.network?.players.length ?? 0} participants`
        : this.engineMode === 'wasm'
          ? `OpenTTD WASM · ${this.engineModuleUrl}`
          : 'Moteur simulé déterministe',
    ];
    if (this.engineWarnings.length > 0) details.push('', ...this.engineWarnings);
    badge.title = details.join('\n');
    badge.setAttribute(
      'aria-label',
      this.engineWarnings.length > 0
        ? `${label} — ${this.engineWarnings.length} avertissement(s)`
        : label,
    );
  }

  /**
   * Pastille discrète de sauvegarde (bas gauche, au-dessus de la pastille
   * moteur). Elle confirme un autosave ou une sauvegarde manuelle sans masquer
   * le HUD, puis s'efface au bout de quelques secondes.
   */
  private createSaveChip(): void {
    if (this.saveChip) return;
    const chip = document.createElement('div');
    chip.className = 'save-chip';
    chip.hidden = true;
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    this.uiRoot.append(chip);
    this.saveChip = chip;
  }

  /** Affiche brièvement la pastille d'autosave et le toast correspondant. */
  notifySave(text: string): void {
    this.hud?.notify('info', text);
    const chip = this.saveChip;
    if (!chip) return;
    chip.textContent = text;
    chip.hidden = false;
    window.clearTimeout(this.saveChipTimer);
    this.saveChipTimer = window.setTimeout(() => {
      if (this.saveChip) this.saveChip.hidden = true;
    }, 5_000);
  }

  /** Erreur de sauvegarde non bloquante (quota, stockage indisponible). */
  notifySaveError(text: string): void {
    this.hud?.notify('warning', text);
  }

  /**
   * Capture l'état courant pour le stockage local. Le nom est choisi par
   * l'appelant ; la session ne fait que fournir les octets et les métadonnées
   * du snapshot (date de jeu, entreprises, tick, graine).
   */
  async captureSave(): Promise<CapturedSave> {
    const engine = this.engine;
    if (!engine || this.disposed) {
      throw new Error('Aucune partie en cours à sauvegarder.');
    }
    if (this.isNetwork) {
      throw new Error('La sauvegarde locale est désactivée pendant une partie réseau.');
    }
    const bytes = await engine.save();
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    const economy = snapshot?.economy ?? null;
    return {
      bytes,
      engine: this.engineMode,
      seed: this.config.seed,
      mapSize: this.config.size,
      gameDate: economy ? { year: economy.year, month: economy.month, day: economy.day } : null,
      companies: snapshot?.companies.map((company) => company.name) ?? [],
      tick: snapshot?.meta.tick ?? this.game?.getTick() ?? 0,
      protocol: snapshot?.meta.protocol ?? null,
    };
  }

  /** Vérifie l'échéance d'autosave ; le bootstrap écrit le slot. */
  private checkAutosave(tick: number): void {
    const scheduler = this.autosave;
    const callback = this.callbacks.onAutosave;
    if (!scheduler || !callback || this.disposed || !this.inputEnabled) return;
    if (scheduler.due(this.networkNow(), tick)) callback();
  }

  /** Active ou suspend l'autosave (utile pendant un écran ou un import). */
  setAutosaveEnabled(enabled: boolean): void {
    if (enabled && !this.autosave && !this.isNetwork) {
      this.autosave = new AutosaveScheduler(DEFAULT_AUTOSAVE);
      return;
    }
    if (!enabled) this.autosave = null;
  }

  private report(progress: number, message: string): void {
    this.callbacks.onProgress?.(progress, message);
  }

  private ensureActive(token: LoadToken): void {
    if (this.disposed) throw new LoadCancelledError();
    if (token.cancelled) throw new LoadCancelledError();
  }

  private createWorld(renderer: Renderer): WorldView {
    return new WorldView({
      scene: renderer.scene,
      camera: renderer.camera,
      canvas: this.canvas,
      quality: this.quality,
      timeOfDay: renderer,
      dayNight: {
        enabled: this.settings.dayNightCycle,
        cycleSeconds: this.settings.dayNightCycleSeconds,
      },
      onSelect: (target) => this.applySelection(target),
      onHover: () => undefined,
      onNotice: (text) => this.hud?.notify('info', text),
      onBuildHover: (tile) => this.buildController?.handleHover(tile),
      onBuildStart: (tile) => this.buildController?.handleBegin(tile),
      onBuildMove: (tile) => this.buildController?.handleMove(tile),
      onBuildEnd: (tile) => this.buildController?.handleEnd(tile),
      onBuildCancel: () => this.buildController?.handleCancel(),
    });
  }

  private createBuildController(): BuildController {
    const controller = new BuildController({
      getMap: () => this.world?.getMap() ?? null,
      getCompany: () => {
        const snapshot = this.game?.getLatestSnapshot();
        const company =
          snapshot?.companies.find((item) => item.id === this.localCompanyId()) ??
          snapshot?.companies.find((item) => item.isLocal) ??
          snapshot?.companies[0] ??
          null;
        return company
          ? { id: company.id, money: company.money, bankrupt: company.bankrupt }
          : null;
      },
      onPreview: (plan) => {
        this.world?.setBuildPlan(plan);
        this.hud?.setBuildHint(describeBuildPlan(plan, this.buildTool));
      },
      onCommit: (plan) => this.commitBuild(plan),
      onNotice: (kind, text) => this.hud?.notify(kind, text),
    });
    controller.setSettings(this.buildSettings);
    return controller;
  }

  private createHud(): Hud {
    return new Hud(this.uiRoot, {
      onTogglePause: () => this.togglePause(),
      onSpeedChange: (speed) => this.setSpeed(speed),
      onResetView: () => {
        this.world?.resetView();
        this.clearSelection();
      },
      onCycleQuality: () => this.cycleQuality(),
      onOpenSettings: () => this.callbacks.onOpenSettings(),
      onClearSelection: () => this.clearSelection(),
      onRecenterCamera: (x, y) => {
        this.world?.stopFollowing();
        this.world?.getCameraController().focusOn(x, y);
        this.updateCameraFrame();
      },
      onBuildToolChange: (tool) => this.setBuildTool(tool),
      onBuildSettingsChange: (settings) => this.applyBuildSettings(settings),
      onBuildRotate: () => this.rotateBuild(),
      onBuyVehicle: (modelId) => this.buyVehicle(modelId),
      onSelectVehicle: (vehicleId) => this.selectVehicle(vehicleId),
      onStartVehicle: (vehicleId) => this.startVehicle(vehicleId),
      onStopVehicle: (vehicleId) => this.stopVehicle(vehicleId),
      onSellVehicle: (vehicleId) => this.sellVehicle(vehicleId),
      onCloseDepot: () => this.closeDepot(),
      onAddOrder: (vehicleId) => this.toggleOrderPicking(vehicleId),
      onRemoveOrder: (vehicleId, index) => this.removeOrder(vehicleId, index),
      onMoveOrder: (vehicleId, index, delta) => this.moveOrder(vehicleId, index, delta),
      onCloseVehicle: () => this.clearSelection(),
      onToggleAudio: () => this.toggleAudioMute(),
    });
  }

  private attachEvents(game: Game): void {
    this.audio?.attach(game);
    game.events.on('snapshot', ({ snapshot }) => {
      this.world?.applySnapshot(snapshot);
      this.audio?.ingestSnapshot(snapshot, this.world?.getMap() ?? null);
      this.monitorGameOver(snapshot);
    });
    game.events.on('notify', ({ kind, text, tick }) => {
      const snapshot = game.getLatestSnapshot();
      this.hud?.pushNews({
        kind,
        text,
        tick,
        date: snapshot?.economy ?? null,
      });
    });
    game.events.on('state', () => this.refreshHud());
    game.events.on('selection', () => this.refreshHud());
  }

  private attachListeners(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    // Un écran (pause, réglages…) a déjà traité l'événement : ne pas le rejouer
    // au retour dans la boucle de jeu.
    if (event.defaultPrevented) return;
    if (!this.inputEnabled || this.disposed) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (
        target.closest(
          'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"]',
        )
      ) {
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.undoLastBuild();
      return;
    }
    if ((event.key === 'r' || event.key === 'R') && this.buildTool) {
      if (this.rotateBuild()) {
        event.preventDefault();
        return;
      }
    }
    if (event.code === 'Space') {
      event.preventDefault();
      this.togglePause();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.orderPickingFor !== null) {
        this.cancelOrderPicking();
        return;
      }
      if (this.openDepot !== null) {
        this.closeDepot();
        return;
      }
      if (this.buildTool) {
        this.applyBuildTool(null);
        return;
      }
      if (this.hud?.closePanels()) return;
      if (this.world?.isFollowing()) {
        this.world.stopFollowing();
        this.clearSelection();
        return;
      }
      this.callbacks.onPauseRequested();
      return;
    }
    if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      event.preventDefault();
      this.hud?.toggleHelp();
    }
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.audio?.play('ui.error');
    this.hud?.showError(
      'Contexte WebGL perdu',
      'Le pilote graphique a interrompu le rendu. Rechargez la page pour reprendre la partie.',
    );
  };

  private frame(delta: number): void {
    if (this.disposed) return;
    const game = this.game;
    const world = this.world;
    if (!game || !world) return;

    const session = this.netSession;
    const lockstep = this.lockstep;
    if (session && lockstep) {
      const now = this.networkNow();
      const update = session.update(now);
      this.lastNetUpdate = update;
      // Le lockstep est la seule source d'avancement. On aligne `Game` sur le
      // tick moteur : en marche normale le delta vaut `update.ticks`, après un
      // resync/join il rattrape aussi le saut de tick.
      const drift = session.stats().tick - game.getTick();
      if (drift > 0) lockstep.addExecuted(drift);
      game.advance(delta);
      world.update(delta, { ...game.getInterpolation(), alpha: session.alpha(now) });
      this.refreshNetworkSave(now, session.stats().isHost);
      this.checkNetworkState();
    } else {
      game.advance(delta);
      world.update(delta, game.getInterpolation());
    }
    world.setDayNightPaused(game.isPaused());
    this.audio?.setDayNight(world.dayNightAmount);

    const pose = world.getCameraController().getPose();
    this.audio?.setListener({ x: pose.target.x, z: pose.target.z, yaw: pose.yaw });
    this.audio?.setPaused(game.isPaused());
    this.audio?.frame(delta);

    this.checkAutosave(game.getTick());

    this.hudTimer += delta;
    if (this.hudTimer >= HUD_REFRESH_SECONDS) {
      this.hudTimer = 0;
      this.refreshHud();
    }
    this.minimapTimer += delta;
    if (this.minimapTimer >= MINIMAP_REFRESH_SECONDS) {
      this.minimapTimer = 0;
      this.updateCameraFrame();
    }
  }

  private networkNow(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Rafraîchit périodiquement le cache de sauvegarde de l'hôte. Le lockstep ne
   * transfère pas l'état en marche normale ; ce cache ne sert qu'aux resyncs
   * d'urgence, et reste borné à une sauvegarde toutes les 10 s. #38 le
   * remplacera par un transfert explicite.
   */
  private refreshNetworkSave(now: number, isHost: boolean): void {
    if (!isHost || this.networkSavePending || !this.netRunner) return;
    // Le WASM sérialise à la demande, exactement au tick courant : inutile de
    // recopier plusieurs mégaoctets toutes les 10 s.
    if (this.netRunner.synchronous) return;
    if (now - this.lastNetworkSaveAt < 10_000) return;
    this.lastNetworkSaveAt = now;
    this.networkSavePending = true;
    void this.netRunner
      .saveNow()
      .catch((error: unknown) => {
        console.warn('[net:session] sauvegarde de resync indisponible', error);
      })
      .finally(() => {
        this.networkSavePending = false;
      });
  }

  /** Signale une perte d'hôte sans migration possible, une seule fois. */
  private checkNetworkState(): void {
    const session = this.netSession;
    if (!session || this.networkLostNotified) return;
    const stats = session.stats();
    if (!stats.lost) return;
    this.networkLostNotified = true;
    this.hud?.notify('error', 'Hôte perdu : la session réseau est interrompue.');
    this.callbacks.onNetworkLost?.(
      'L’hôte a disparu et aucun autre joueur n’a pu prendre le relais. La partie réseau est arrêtée.',
    );
  }

  private networkStatus(): NetworkStatusView | null {
    const session = this.netSession;
    if (!session) return null;
    const stats = session.stats();
    const update = this.lastNetUpdate;
    return describeNetworkStatus({
      isHost: stats.isHost,
      tick: stats.tick,
      ping: stats.ping,
      desyncs: stats.desyncs,
      waiting: update?.waiting ?? false,
      waitingFor: update?.waitingFor ?? [],
      names: this.peerNames,
      playersOnline: Object.keys(this.network?.peers ?? {}).length,
      lost: stats.lost,
    });
  }

  private notifyNetworkControls(): void {
    if (this.disposed) return;
    const now = this.networkNow();
    if (now - this.lastNetworkNoticeAt < 2000) return;
    this.lastNetworkNoticeAt = now;
    this.hud?.notify('info', networkControlsLocked().text);
  }

  private updateCameraFrame(): void {
    const world = this.world;
    const hud = this.hud;
    if (!world || !hud) return;
    const pose = world.getCameraController().getPose();
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    hud.updateCamera(
      {
        targetX: pose.target.x,
        targetZ: pose.target.z,
        targetY: pose.target.y,
        yaw: pose.yaw,
        pitch: pose.pitch,
        distance: pose.distance,
      },
      aspect,
    );
  }

  refreshHud(): void {
    const game = this.game;
    const world = this.world;
    const hud = this.hud;
    if (!game || !world || !hud) return;
    this.audio?.setPaused(game.isPaused());
    hud.setAudioMuted(this.audio?.isMuted ?? this.sharedAudio?.isMuted ?? false);
    const snapshot = game.getLatestSnapshot();
    const map = world.getMap();
    const selection = game.getSelection();
    const companyId = this.localCompanyId();
    let depot =
      this.openDepot !== null ? describeDepotPanel(snapshot, companyId, this.openDepot) : null;
    if (this.openDepot !== null && !depot) this.openDepot = null;
    let vehicle = null;
    if (selection?.kind === 'vehicle') {
      vehicle = describeVehiclePanel(
        snapshot,
        map,
        selection.id,
        this.orderPickingFor === selection.id,
      );
      // Véhicule vendu ou disparu du snapshot : la sélection est obsolète.
      if (!vehicle) {
        this.lastTarget = null;
        world.setSelection(null);
        game.select(null);
      }
    }
    if (vehicle) depot = null;
    hud.update({
      snapshot,
      fps: game.getFps(),
      paused: game.isPaused(),
      speed: game.getSpeed(),
      selection: describeSelection(snapshot, selection, this.lastTarget, map),
      depot,
      vehicle,
      quality: this.quality,
      following: world.isFollowing(),
      drawCalls: world.getDrawCalls(),
      controlsLocked: this.isNetwork,
      networkStatus: this.networkStatus(),
    });
  }

  private applySelection(target: WorldTarget | null): void {
    if (this.orderPickingFor !== null) {
      this.tryAddOrder(target);
      return;
    }
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    const map = this.world?.getMap() ?? null;
    this.openDepot = null;
    this.orderPickingFor = null;
    this.lastTarget = target;

    if (target && target.kind === 'tile' && map) {
      const depot = depotAtTile(snapshot, target.x, target.y);
      if (depot) {
        this.openDepot = depot.id;
      } else {
        const station = stationAtTile(snapshot, target.x, target.y);
        if (station) {
          this.world?.setSelection(target);
          this.game?.select({ kind: 'station', id: station.id });
          this.refreshHud();
          return;
        }
      }
    }

    this.world?.setSelection(target);
    this.game?.select(this.toSelection(target));
    this.refreshHud();
  }

  private toSelection(target: WorldTarget | null): Selection | null {
    if (!target) return null;
    if (target.kind === 'vehicle') return { kind: 'vehicle', id: target.id };
    if (target.kind === 'building') return { kind: 'town', id: target.townId };
    const width = this.world?.getMap()?.width ?? this.config.size;
    return { kind: 'tile', id: target.y * width + target.x };
  }

  /** Sélectionne un véhicule sans passer par le picking. */
  private selectVehicle(vehicleId: number): void {
    this.openDepot = null;
    this.orderPickingFor = null;
    const target: WorldTarget = { kind: 'vehicle', id: vehicleId };
    this.lastTarget = target;
    this.world?.setSelection(target);
    this.game?.select({ kind: 'vehicle', id: vehicleId });
    this.refreshHud();
  }

  clearSelection(): void {
    this.lastTarget = null;
    this.openDepot = null;
    this.orderPickingFor = null;
    this.world?.setSelection(null);
    this.game?.select(null);
    this.refreshHud();
  }

  /** Ferme le panneau dépôt sans toucher à la sélection de tuile. */
  private closeDepot(): void {
    this.openDepot = null;
    this.refreshHud();
  }

  /**
   * Achat d'un modèle dans le dépôt ouvert. En solo le snapshot est forcé
   * pour récupérer immédiatement le `vehicleId` créé par le moteur ; en réseau
   * la commande part dans le tour lockstep et le panneau se rafraîchira seul.
   */
  private buyVehicle(modelId: string): void {
    const game = this.game;
    const depotId = this.openDepot;
    if (!game || depotId === null) return;
    const company = this.localCompanyId();
    if (company === null) {
      this.hud?.notify('warning', 'Aucune entreprise locale : achat impossible.');
      return;
    }
    const before = new Set(game.getLatestSnapshot()?.vehicles.map((item) => item.id) ?? []);
    game.issueCommand(buyVehicleCommand(company, depotId, modelId));
    if (this.isNetwork) {
      this.hud?.notify('info', 'Achat envoyé : il sera appliqué au prochain tour.');
      return;
    }
    game.refresh();
    const snapshot = game.getLatestSnapshot();
    const bought = snapshot?.vehicles
      .filter((item) => item.company === company && !before.has(item.id))
      .sort((a, b) => b.id - a.id)[0];
    if (bought) {
      this.selectVehicle(bought.id);
      this.hud?.notify(
        'info',
        `Véhicule #${bought.id} acheté. Ajoutez ses ordres puis démarrez-le.`,
      );
      return;
    }
    this.refreshHud();
  }

  private startVehicle(vehicleId: number): void {
    const company = this.localCompanyId();
    if (company === null) return;
    const vehicle = this.game?.getLatestSnapshot()?.vehicles.find((item) => item.id === vehicleId);
    if (vehicle && vehicle.orderTargets.length === 0) {
      this.hud?.notify('warning', 'Ajoutez au moins une gare à la tournée avant de démarrer.');
      return;
    }
    this.issueVehicleCommand(vehicleActionCommand(company, 'start', vehicleId));
  }

  private stopVehicle(vehicleId: number): void {
    const company = this.localCompanyId();
    if (company === null) return;
    this.issueVehicleCommand(vehicleActionCommand(company, 'stop', vehicleId));
  }

  private sellVehicle(vehicleId: number): void {
    const company = this.localCompanyId();
    if (company === null) return;
    this.issueVehicleCommand(vehicleActionCommand(company, 'sell', vehicleId));
    if (
      this.game?.getSelection()?.kind === 'vehicle' &&
      this.game.getSelection()?.id === vehicleId
    ) {
      this.clearSelection();
    }
  }

  /** Émet une commande véhicule, force le snapshot en solo puis rafraîchit le HUD. */
  private issueVehicleCommand(command: EngineCommand): void {
    const game = this.game;
    if (!game) return;
    game.issueCommand(command);
    if (this.isNetwork) {
      this.hud?.notify('info', 'Commande véhicule envoyée au prochain tour.');
      return;
    }
    game.refresh();
    this.refreshHud();
  }

  /** Arme ou désarme l'ajout d'un ordre par clic sur la carte. */
  private toggleOrderPicking(vehicleId: number): void {
    if (this.orderPickingFor === vehicleId) {
      this.cancelOrderPicking();
      return;
    }
    if (this.buildTool) this.applyBuildTool(null);
    this.openDepot = null;
    this.selectVehicle(vehicleId);
    this.orderPickingFor = vehicleId;
    this.refreshHud();
    this.hud?.notify(
      'info',
      'Cliquez sur une gare ou un dépôt de la carte pour l’ajouter à la tournée.',
    );
  }

  private cancelOrderPicking(): void {
    if (this.orderPickingFor === null) return;
    this.orderPickingFor = null;
    this.hud?.notify('info', 'Ajout d’ordre annulé.');
    this.refreshHud();
  }

  /** Clic carte pendant l'ajout d'ordre : gare ou dépôt uniquement. */
  private tryAddOrder(target: WorldTarget | null): void {
    const vehicleId = this.orderPickingFor;
    if (vehicleId === null) return;
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    if (!snapshot) return;
    const vehicle = snapshot.vehicles.find((item) => item.id === vehicleId);
    if (!vehicle) {
      this.cancelOrderPicking();
      return;
    }
    if (!target || target.kind !== 'tile') {
      this.hud?.notify('warning', 'Ordre invalide : cliquez sur une gare ou un dépôt.');
      return;
    }
    let order: VehicleOrder | null = null;
    const depot = depotAtTile(snapshot, target.x, target.y);
    if (depot) {
      order = depotOrder(depot);
    } else {
      const station = stationAtTile(snapshot, target.x, target.y);
      if (station) order = stationOrder(station);
    }
    if (!order) {
      this.hud?.notify('warning', 'Ordre invalide : seules les gares et les dépôts sont acceptés.');
      return;
    }
    const orders = [...ordersFromSnapshot(vehicle, snapshot), order];
    const validation = validateVehicleOrders(orders, snapshot);
    if (!validation.ok) {
      this.hud?.notify('warning', validation.reason ?? 'Ordre refusé.');
      return;
    }
    const company = this.localCompanyId();
    if (company === null) return;
    this.orderPickingFor = null;
    this.issueVehicleCommand(orderVehicleCommand(company, vehicleId, orders));
    this.hud?.notify('info', 'Ordre ajouté à la tournée.');
  }

  private removeOrder(vehicleId: number, index: number): void {
    this.updateOrders(vehicleId, (orders) => orders.filter((_, item) => item !== index));
  }

  private moveOrder(vehicleId: number, index: number, delta: -1 | 1): void {
    this.updateOrders(vehicleId, (orders) => {
      const target = index + delta;
      if (target < 0 || target >= orders.length) return orders;
      const next = [...orders];
      const moved = next[index];
      const other = next[target];
      if (!moved || !other) return orders;
      next[index] = other;
      next[target] = moved;
      return next;
    });
  }

  private updateOrders(
    vehicleId: number,
    transform: (orders: VehicleOrder[]) => VehicleOrder[],
  ): void {
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    if (!snapshot) return;
    const vehicle = snapshot.vehicles.find((item) => item.id === vehicleId);
    if (!vehicle) return;
    const orders = transform(ordersFromSnapshot(vehicle, snapshot));
    const company = this.localCompanyId();
    if (company === null) return;
    this.issueVehicleCommand(orderVehicleCommand(company, vehicleId, orders));
  }

  togglePause(): void {
    if (this.isNetwork) {
      this.notifyNetworkControls();
      return;
    }
    this.game?.togglePause();
    this.refreshHud();
  }

  pause(): void {
    // En réseau, la simulation ne s'arrête jamais localement : seul le menu
    // (Échap) suspend l'affichage. Les ticks continuent via `NetSession`.
    if (this.isNetwork) {
      this.refreshHud();
      return;
    }
    this.game?.setPaused(true);
    this.refreshHud();
  }

  resume(): void {
    if (this.isNetwork) {
      this.refreshHud();
      return;
    }
    this.game?.setPaused(false);
    this.refreshHud();
  }

  setSpeed(speed: GameSpeed): void {
    if (this.isNetwork) {
      this.notifyNetworkControls();
      this.refreshHud();
      return;
    }
    this.game?.setSpeed(speed);
    this.refreshHud();
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled && this.buildTool) this.applyBuildTool(null);
  }

  getBuildTool(): BuildTool | null {
    return this.buildTool;
  }

  getBuildSettings(): BuildSettings {
    return cloneBuildSettings(this.buildSettings);
  }
  /** Arme ou désarme un outil de construction (le clic sur l'outil actif bascule). */
  setBuildTool(tool: BuildToolId): void {
    if (this.disposed) return;
    this.applyBuildTool(this.buildTool === tool ? null : tool);
  }

  private applyBuildTool(tool: BuildToolId | null): void {
    this.buildTool = tool;
    this.buildController?.setTool(tool);
    this.world?.setBuildMode(tool !== null);
    this.hud?.setBuildTool(tool);
    this.hud?.setBuildOptions(tool, this.buildSettings);
    this.hud?.setBuildHint(describeBuildPlan(null, tool));
    if (tool) {
      this.clearSelection();
      this.world?.stopFollowing();
      this.hud?.notify('info', `${BUILD_TOOL_INTROS[tool]} · Échap pour quitter.`);
    }
    this.refreshHud();
  }

  /** Applique les options de gare/dépôt/signal au contrôleur et au HUD. */
  private applyBuildSettings(settings: BuildSettings): void {
    this.buildSettings = cloneBuildSettings(settings);
    this.buildController?.setSettings(this.buildSettings);
    this.hud?.setBuildOptions(this.buildTool, this.buildSettings);
  }

  /** Pivote l'outil actif (R ou bouton « Pivoter »). */
  private rotateBuild(): boolean {
    if (!this.buildTool || (this.buildTool !== 'station' && this.buildTool !== 'depot')) {
      return false;
    }
    if (this.buildTool === 'station') {
      this.buildSettings.station.direction = nextDirection(this.buildSettings.station.direction);
    } else {
      this.buildSettings.depot.direction = nextDirection(
        this.buildSettings.depot.direction ?? 'se',
      );
    }
    this.buildController?.setSettings(this.buildSettings);
    this.hud?.setBuildOptions(this.buildTool, this.buildSettings);
    return true;
  }

  /** Entreprise qui signe la commande : locale en solo, siège du joueur en réseau. */
  private localCompanyId(): number | null {
    const snapshot = this.game?.getLatestSnapshot();
    const mapped = this.network ? localCompanyForStart(this.network) : undefined;
    if (mapped !== undefined && snapshot?.companies.some((item) => item.id === mapped)) {
      return mapped;
    }
    const company = snapshot?.companies.find((item) => item.isLocal) ?? snapshot?.companies[0];
    return company?.id ?? null;
  }

  /**
   * Applique l'entreprise du joueur local au moteur (#99). Appelé après la
   * génération ou le chargement de la sauvegarde de l'hôte ; l'entreprise
   * existe forcément (sièges réservés créés au démarrage).
   */
  private applyLocalCompany(engine: EngineDriver): void {
    if (!this.network) return;
    const company = localCompanyForStart(this.network);
    if (company === undefined) return;
    if (typeof engine.setLocalCompany !== 'function') {
      this.recordEngineWarning(
        'Entreprise par joueur indisponible : ce moteur ne l’expose pas (#99).',
      );
      return;
    }
    if (!engine.setLocalCompany(company)) {
      this.recordEngineWarning(
        `Entreprise locale ${company} indisponible : repli sur l’entreprise par défaut.`,
      );
    }
  }

  /**
   * En réseau, la commande part dans le tour de l'hôte : elle ne touche jamais
   * le moteur local directement, sinon les pairs divergeraient.
   */
  private issueNetworkCommand(command: EngineCommand): void {
    const session = this.netSession;
    if (session) session.issue(command);
    else this.engine?.send(command);
  }

  /** Émet la commande de construction puis rafraîchit la carte en solo. */
  private commitBuild(plan: BuildPlan): void {
    const game = this.game;
    if (!game) return;
    const company = this.localCompanyId();
    if (company === null) {
      this.hud?.notify('warning', 'Aucune entreprise locale : construction impossible.');
      return;
    }
    game.issueCommand(commandFromPlan(plan, company));
    this.lastBuild = null;
    if (this.isNetwork) {
      // Le lockstep appliquera la commande au prochain tour : on ne peut pas
      // encore vérifier la carte, mais l'annulation reste une commande valide.
      if (plan.tool !== 'signal') this.lastBuild = plan;
      this.hud?.notify(
        'info',
        'Commande de construction envoyée : elle sera appliquée au prochain tour.',
      );
      return;
    }
    // Le mock applique la commande immédiatement : un snapshot forcé affiche
    // la route et les news d'erreur/succès sans attendre le prochain tick.
    game.refresh();
    this.refreshHud();
    // Un signal ne se retire pas avec la démolition (elle arracherait la voie) :
    // il n'entre pas dans la pile Ctrl+Z.
    if (plan.tool !== 'signal' && this.buildConfirmed(plan, company)) this.lastBuild = plan;
  }

  /** Vérifie sur la carte que toutes les tuiles du plan ont bien été posées. */
  private buildConfirmed(plan: BuildPlan, company: number): boolean {
    if (plan.tool === 'clear') return false;
    const map = this.game?.getLatestSnapshot()?.map;
    if (!map) return false;
    if (plan.tool === 'signal') {
      return plan.tiles.every(
        (tile) =>
          tileKindAt(map, tile.x, tile.y) === 'rail' &&
          ((map.flags[tile.index] ?? 0) & TILE_FLAG.SIGNAL) !== 0,
      );
    }
    const expected = plan.tool === 'station' ? 'station' : plan.depot?.kind;
    if (!expected) {
      return plan.tiles.every(
        (tile) =>
          tileKindAt(map, tile.x, tile.y) === plan.tool && map.owner[tile.index] === company,
      );
    }
    return plan.tiles.every(
      (tile) => tileKindAt(map, tile.x, tile.y) === expected && map.owner[tile.index] === company,
    );
  }

  /**
   * Ctrl+Z : démolit le dernier tronçon construit (même tracé, outil `clear`).
   * En réseau, la démolition est séquencée comme les autres commandes.
   */
  undoLastBuild(): void {
    const last = this.lastBuild;
    const game = this.game;
    if (!game) return;
    if (!last) {
      this.hud?.notify('info', 'Aucune construction récente à annuler.');
      return;
    }
    const map = this.world?.getMap();
    const company = this.localCompanyId();
    if (!map || company === null) {
      this.hud?.notify('warning', 'Annulation impossible : carte ou entreprise indisponible.');
      return;
    }
    const snapshot = game.getLatestSnapshot();
    const money = snapshot?.companies.find((item) => item.id === company)?.money;

    // Gare/dépôt : l'emprise est rectangulaire, on démolit chaque tuile du plan
    // (une commande par tuile) pour ne pas déborder sur le voisinage.
    if (last.tool === 'station' || last.tool === 'depot') {
      const commands: EngineCommand[] = [];
      for (const tile of last.tiles) {
        const clear = planBuild({
          map,
          tool: 'clear',
          from: { x: tile.x, y: tile.y },
          company,
          ...(money !== undefined ? { budget: money } : {}),
        });
        if (!clear.valid) {
          this.hud?.notify(
            'warning',
            `Démolition impossible : ${clear.reason ?? 'tuile refusée.'}`,
          );
          this.lastBuild = null;
          return;
        }
        commands.push(commandFromPlan(clear, company));
      }
      for (const command of commands) game.issueCommand(command);
      this.lastBuild = null;
      if (this.isNetwork) {
        this.hud?.notify('info', 'Annulation envoyée : démolition au prochain tour.');
        return;
      }
      game.refresh();
      this.refreshHud();
      return;
    }

    const clear = planBuild({
      map,
      tool: 'clear',
      from: last.from,
      to: last.to,
      axis: last.axis,
      company,
      ...(money !== undefined ? { budget: money } : {}),
    });
    if (!clear.valid) {
      this.hud?.notify('warning', `Démolition impossible : ${clear.reason ?? 'tracé refusé.'}`);
      this.lastBuild = null;
      return;
    }
    game.issueCommand(commandFromPlan(clear, company));
    this.lastBuild = null;
    if (this.isNetwork) {
      this.hud?.notify('info', 'Annulation envoyée : démolition au prochain tour.');
      return;
    }
    game.refresh();
    this.refreshHud();
  }

  setQuality(level: QualityLevel): void {
    if (this.quality === level) return;
    this.quality = level;
    this.renderer?.setQuality(level);
    this.world?.setQuality(level);
    this.audio?.setQuality(level);
    this.refreshHud();
  }

  applySettings(settings: GameSettings): void {
    this.settings = settings;
    this.setQuality(settings.quality);
    this.world?.setDayNightCycle(settings.dayNightCycle, settings.dayNightCycleSeconds);
    this.audio?.setSettings(settings);
  }

  getSettings(): GameSettings {
    return { ...this.settings };
  }

  /** Moteur audio effectif (partagé, ou propre à la session). */
  get audioEngine(): AudioEngine | null {
    return this.audio?.audioEngine ?? this.sharedAudio;
  }

  get audioMuted(): boolean {
    return this.audio?.isMuted ?? this.sharedAudio?.isMuted ?? false;
  }

  /** Bouton mute du HUD : l'état est reflété immédiatement. */
  toggleAudioMute(): boolean {
    const muted = this.audio?.toggleMuted() ?? this.sharedAudio?.toggleMuted() ?? false;
    this.hud?.setAudioMuted(muted);
    return muted;
  }

  cycleQuality(): void {
    this.setQuality(nextQuality(this.quality));
    this.callbacks.onQualityChange?.(this.quality);
    this.hud?.notify('info', `Qualité de rendu : ${this.quality}.`);
  }

  /** Entreprise locale du snapshot (mapping réseau prioritaire, sinon isLocal). */
  private localCompanySnapshot(): CompanySnapshot | null {
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    if (!snapshot) return null;
    const id = this.localCompanyId();
    return (
      (id === null ? undefined : snapshot.companies.find((item) => item.id === id)) ??
      snapshot.companies.find((item) => item.isLocal) ??
      snapshot.companies[0] ??
      null
    );
  }

  getOverview(): SessionOverview {
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    const company = this.localCompanySnapshot();
    return {
      company: company?.name ?? '—',
      date: formatGameDate(snapshot?.economy),
      money: company ? formatMoney(company.money) : '—',
      vehicles: this.countVehicles(snapshot, company?.id),
      stations: this.countStations(snapshot, company?.id),
    };
  }

  private countVehicles(snapshot: WorldSnapshot | null, company: number | undefined): number {
    if (!snapshot) return 0;
    if (company === undefined) return snapshot.vehicles.length;
    return snapshot.vehicles.filter((vehicle) => vehicle.company === company).length;
  }

  private countStations(snapshot: WorldSnapshot | null, company: number | undefined): number {
    if (!snapshot) return 0;
    if (company === undefined) return snapshot.stations.length;
    return snapshot.stations.filter((station) => station.company === company).length;
  }

  getGameOverSummary(title = 'Fin de partie', reason = 'La partie est terminée.'): GameOverSummary {
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    const company = this.localCompanySnapshot();
    return {
      title,
      reason,
      company: company?.name ?? '—',
      money: company ? formatMoney(company.money) : '—',
      value: company ? formatMoney(company.value) : '—',
      vehicles: this.countVehicles(snapshot, company?.id),
      stations: this.countStations(snapshot, company?.id),
      date: formatGameDate(snapshot?.economy),
    };
  }

  /** API prête pour le moteur réel : victoire, faillite, scénario terminé. */
  endGame(reason: string, title = 'Fin de partie'): void {
    if (this.gameOverShown || this.disposed) return;
    this.gameOverShown = true;
    this.audio?.play('alert');
    this.callbacks.onGameOver(this.getGameOverSummary(title, reason));
  }

  private monitorGameOver(snapshot: WorldSnapshot): void {
    if (this.gameOverShown) return;
    const localId = this.localCompanyId();
    const local =
      (localId === null ? undefined : snapshot.companies.find((item) => item.id === localId)) ??
      snapshot.companies.find((company) => company.isLocal);
    if (local?.bankrupt) {
      this.endGame('Votre entreprise est en faillite.', 'Faillite');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer?.stop();
    this.audio?.dispose();
    this.audio = null;
    this.hud?.dispose();
    this.world?.dispose();
    this.renderer?.dispose();
    this.netSession?.dispose();
    this.netSession = null;
    this.netRunner = null;
    this.lockstep = null;
    if (this.game) this.game.dispose();
    else this.engine?.dispose();
    this.hud = null;
    this.world = null;
    this.buildController = null;
    this.buildTool = null;
    this.lastBuild = null;
    this.renderer = null;
    this.game = null;
    this.engine = null;
    this.engineBadge?.remove();
    this.engineBadge = null;
    window.clearTimeout(this.saveChipTimer);
    this.saveChip?.remove();
    this.saveChip = null;
    this.autosave = null;
  }
}
