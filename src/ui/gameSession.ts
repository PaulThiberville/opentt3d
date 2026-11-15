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

import type { EngineCommand, EngineDriver, WorldSnapshot } from '../engine/protocol';
import { TILE_FLAG } from '../engine/protocol';
import { MockEngine } from '../engine/MockEngine';
import { WasmEngine } from '../engine/WasmEngine';
import { resolveEngineModuleUrl, type EngineMode } from '../engine/loadEngine';
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
  describeNetworkStatus,
  mapStartInfoToGameOptions,
  networkControlsLocked,
  peerNamesFromStart,
} from './netlobby';
import {
  createEngineRunner,
  createLockstepDriver,
  type EngineRunner,
  type LockstepGameDriver,
} from './networkRunner';
import { describeSelection } from './selection';
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
  /** Démarre une partie lockstep à partir du salon. Force le moteur mock. */
  network?: StartInfo;
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
  private lastNetUpdate: NetUpdate | null = null;
  private peerNames: Record<string, string> = {};
  private networkWarnings: string[] = [];
  private networkLostNotified = false;
  private lastNetworkNoticeAt = -Infinity;
  private lastNetworkSaveAt = 0;
  private networkSavePending = false;

  private quality: QualityLevel;
  private lastTarget: WorldTarget | null = null;
  private hudTimer = 0;
  private minimapTimer = 0;
  private disposed = false;
  private inputEnabled = true;
  private gameOverShown = false;

  constructor(options: GameSessionOptions) {
    this.canvas = options.canvas;
    this.uiRoot = options.uiRoot;
    this.network = options.network ?? null;
    this.config = this.network
      ? mapStartInfoToGameOptions(this.network, options.config.quality).options
      : options.config;
    if (this.network) {
      this.networkWarnings = mapStartInfoToGameOptions(
        this.network,
        options.config.quality,
      ).warnings;
    }
    this.settings = options.settings;
    this.callbacks = options.callbacks;
    this.quality = this.config.quality;
    this.engineMode = this.network ? 'mock' : (options.engine ?? 'mock');
    this.engineModuleUrl = options.engineModuleUrl ?? resolveEngineModuleUrl();
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

  async load(token: LoadToken): Promise<void> {
    const config = this.config;
    const wasm = this.engineMode === 'wasm';
    this.report(
      0.03,
      this.isNetwork
        ? 'Préparation de la session réseau (moteur mock déterministe)…'
        : wasm
          ? 'Chargement du moteur OpenTTD (WebAssembly)…'
          : 'Initialisation du moteur mock…',
    );
    const engine: EngineDriver = wasm ? new WasmEngine() : new MockEngine();
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
    });
    this.collectEngineWarnings();
    this.ensureActive(token);

    if (this.network) this.createNetworkSession(engine);
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
    this.attachEvents(game);
    this.attachListeners();
    this.createEngineBadge();

    // `game.start()` capture le premier snapshot et émet les news initiales,
    // désormais écoutées par le HUD.
    game.start();
    this.refreshHud();
    this.announceEngine();

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
    this.hud.notify('info', `Monde ${config.size}×${config.size} généré en ${buildMs} ms.`);
    this.hud.notify(
      'info',
      'Clic : sélection · double-clic : suivre · Échap : pause · Espace : pause.',
    );
    this.hud.notify(
      'info',
      'Routes, rails, gares, dépôts et signaux : barre du bas, puis cliquez sur la carte.',
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
        'Session réseau lockstep : moteur mock déterministe, aucun transfert de sauvegarde.',
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
    // Amorce le cache de sauvegarde : si un resync est demandé, le host aura
    // au moins un état chargeable au lieu d'un message vide (#38 fera mieux).
    this.lastNetworkSaveAt = this.networkNow();
    void this.netRunner.saveNow().catch((error: unknown) => {
      console.warn('[net:session] sauvegarde initiale indisponible', error);
    });
  }

  /** Ouvre le lockstep : hellos, tours et hashes commencent ici. */
  private startNetworkSession(): void {
    const start = this.network;
    const runner = this.netRunner;
    if (!start || !runner || this.netSession) return;
    const hostPlayer = start.players.find((player) => player.isHost);
    const hostId = hostPlayer ? start.peers[hostPlayer.player] : undefined;
    this.netSession = createNetSession({
      runner,
      localPlayer: start.localPlayer,
      transport: start.transport,
      isHost: start.isHost,
      ...(start.isHost ? {} : { hostId }),
      peers: start.peers,
    });
    this.netSession.onDesync(() => {
      this.hud?.notify('warning', 'Divergence détectée : resynchronisation avec l’hôte…');
    });
    this.netSession.onChat(({ player, text }) => {
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
      ? 'Mock · réseau'
      : this.engineMode === 'wasm'
        ? 'Moteur WASM'
        : 'Mock';
    badge.textContent = label;
    const details: string[] = [
      this.isNetwork
        ? `Lockstep réseau · seed ${this.config.seed} · ${this.network?.players.length ?? 0} participants`
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
    });
  }

  private attachEvents(game: Game): void {
    game.events.on('snapshot', ({ snapshot }) => {
      this.world?.applySnapshot(snapshot);
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
      if (update.ticks > 0) lockstep.addExecuted(update.ticks);
      game.advance(delta);
      world.update(delta, { ...game.getInterpolation(), alpha: session.alpha(now) });
      this.refreshNetworkSave(now, session.stats().isHost);
      this.checkNetworkState();
    } else {
      game.advance(delta);
      world.update(delta, game.getInterpolation());
    }

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
    const snapshot = game.getLatestSnapshot();
    const selection = game.getSelection();
    hud.update({
      snapshot,
      fps: game.getFps(),
      paused: game.isPaused(),
      speed: game.getSpeed(),
      selection: describeSelection(snapshot, selection, this.lastTarget, world.getMap()),
      quality: this.quality,
      following: world.isFollowing(),
      drawCalls: world.getDrawCalls(),
      controlsLocked: this.isNetwork,
      networkStatus: this.networkStatus(),
    });
  }

  private applySelection(target: WorldTarget | null): void {
    this.lastTarget = target;
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

  clearSelection(): void {
    this.lastTarget = null;
    this.world?.setSelection(null);
    this.game?.select(null);
    this.refreshHud();
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
    const player = this.network?.localPlayer;
    if (this.isNetwork && player !== undefined) {
      const company = snapshot?.companies.find((item) => item.id === player);
      if (company) return company.id;
    }
    const company = snapshot?.companies.find((item) => item.isLocal) ?? snapshot?.companies[0];
    return company?.id ?? null;
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
    this.refreshHud();
  }

  applySettings(settings: GameSettings): void {
    this.settings = settings;
    this.setQuality(settings.quality);
  }

  getSettings(): GameSettings {
    return { ...this.settings };
  }

  cycleQuality(): void {
    this.setQuality(nextQuality(this.quality));
    this.callbacks.onQualityChange?.(this.quality);
    this.hud?.notify('info', `Qualité de rendu : ${this.quality}.`);
  }

  getOverview(): SessionOverview {
    const snapshot = this.game?.getLatestSnapshot() ?? null;
    const company =
      snapshot?.companies.find((item) => item.isLocal) ?? snapshot?.companies[0] ?? null;
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
    const company =
      snapshot?.companies.find((item) => item.isLocal) ?? snapshot?.companies[0] ?? null;
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
    this.callbacks.onGameOver(this.getGameOverSummary(title, reason));
  }

  private monitorGameOver(snapshot: WorldSnapshot): void {
    if (this.gameOverShown) return;
    const local = snapshot.companies.find((company) => company.isLocal);
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
  }
}
