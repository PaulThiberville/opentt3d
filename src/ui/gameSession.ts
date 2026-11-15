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

import type { EngineDriver, WorldSnapshot } from '../engine/protocol';
import { MockEngine } from '../engine/MockEngine';
import { WasmEngine } from '../engine/WasmEngine';
import { resolveEngineModuleUrl, type EngineMode } from '../engine/loadEngine';
import { Game, type GameSpeed, type Selection } from '../game/Game';
import { Renderer } from '../render/Renderer';
import { WorldView, type WorldTarget } from '../render/WorldView';
import { nextQuality, type QualityLevel } from '../render/quality';
import { Hud } from './Hud';
import type { NewGameOptions } from './gameOptions';
import { formatGameDate, formatMoney } from './format';
import { describeSelection } from './selection';
import type { GameSettings } from './settings';
import type { GameOverSummary, SessionOverview } from './types';

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
}

const HUD_REFRESH_SECONDS = 0.2;
const MINIMAP_REFRESH_SECONDS = 0.1;

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
  private engineBadge: HTMLDivElement | null = null;
  private engineWarnings: string[] = [];

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
    this.config = options.config;
    this.settings = options.settings;
    this.callbacks = options.callbacks;
    this.quality = options.config.quality;
    this.engineMode = options.engine ?? 'mock';
    this.engineModuleUrl = options.engineModuleUrl ?? resolveEngineModuleUrl();
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
      wasm ? 'Chargement du moteur OpenTTD (WebAssembly)…' : 'Initialisation du moteur mock…',
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
      wasm ? 'Génération de la carte OpenTTD…' : 'Génération de la carte et des réseaux…',
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

    this.report(0.52, 'Création de la boucle de jeu…');
    await nextFrame();
    this.ensureActive(token);
    const game = new Game({ driver: engine });
    this.game = game;

    this.report(0.58, 'Initialisation du rendu 3D…');
    await nextFrame();
    this.ensureActive(token);
    this.renderer = new Renderer({ canvas: this.canvas, quality: this.quality });
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
    if (snapshot) this.monitorGameOver(snapshot);
  }

  /** Résume le moteur actif et relaie les avertissements du pont. */
  private announceEngine(): void {
    const hud = this.hud;
    if (!hud) return;
    if (this.engineMode === 'wasm') {
      hud.notify('info', 'Moteur WASM : simulation OpenTTD réelle.');
    } else {
      hud.notify('info', 'Moteur simulé (Mock) : partie de démonstration.');
    }
    for (const warning of this.engineWarnings) hud.notify('warning', warning);
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
    const label = this.engineMode === 'wasm' ? 'Moteur WASM' : 'Mock';
    badge.textContent = label;
    const details: string[] = [
      this.engineMode === 'wasm'
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
    });
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
    if (event.code === 'Space') {
      event.preventDefault();
      this.togglePause();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
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
    game.advance(delta);
    world.update(delta, game.getInterpolation());

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
    this.game?.togglePause();
    this.refreshHud();
  }

  pause(): void {
    this.game?.setPaused(true);
    this.refreshHud();
  }

  resume(): void {
    this.game?.setPaused(false);
    this.refreshHud();
  }

  setSpeed(speed: GameSpeed): void {
    this.game?.setSpeed(speed);
    this.refreshHud();
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
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
    if (this.game) this.game.dispose();
    else this.engine?.dispose();
    this.hud = null;
    this.world = null;
    this.renderer = null;
    this.game = null;
    this.engine = null;
    this.engineBadge?.remove();
    this.engineBadge = null;
  }
}
