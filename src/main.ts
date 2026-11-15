/**
 * Bootstrap du frontend OpenTT3D.
 *
 * Machine à états simple : menu → nouvelle partie → chargement → session de
 * jeu (HUD + 3D) → pause / réglages / fin de partie → retour au menu. Le
 * retour au menu libère entièrement la session (`dispose()`), ce qui permet
 * de relancer une partie sans contexte WebGL orphelin.
 */

import './style.css';
import { Renderer } from './render/Renderer';
import { detectQuality } from './render/quality';
import { GameSession, LoadCancelledError, type LoadToken } from './ui/gameSession';
import {
  createDefaultNewGameOptions,
  mergeNewGameOptions,
  type NewGameOptions,
} from './ui/gameOptions';
import {
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
  updateSettings,
  type GameSettings,
} from './ui/settings';
import { AboutScreen } from './ui/screens/AboutScreen';
import { GameOverScreen } from './ui/screens/GameOverScreen';
import { LoadingScreen } from './ui/screens/LoadingScreen';
import { MainMenuScreen } from './ui/screens/MainMenuScreen';
import { NewGameScreen } from './ui/screens/NewGameScreen';
import { PauseScreen } from './ui/screens/PauseScreen';
import { ScreenManager } from './ui/screens/ScreenManager';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import type { GameOverSummary } from './ui/types';

type SettingsOrigin = 'menu' | 'pause';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const mount = document.querySelector<HTMLElement>('#ui');
if (!canvas || !mount) {
  throw new Error('Éléments canvas/#scene ou div/#ui introuvables dans index.html');
}
const sceneCanvas: HTMLCanvasElement = canvas;
const uiMount: HTMLElement = mount;

const screens = new ScreenManager(uiMount);
let settings = loadSettings(window.localStorage);
if (window.localStorage.getItem(SETTINGS_STORAGE_KEY) === null) {
  settings = {
    ...settings,
    quality: detectQuality(window.devicePixelRatio, navigator.hardwareConcurrency ?? 4),
  };
}
let session: GameSession | null = null;
let settingsOrigin: SettingsOrigin = 'menu';

const webglAvailable = Renderer.isWebGLAvailable();

interface UrlBoot {
  options: NewGameOptions;
  autoStart: boolean;
}

function readUrlBoot(base: NewGameOptions): UrlBoot {
  const params = new URLSearchParams(window.location.search);
  const autoParam = params.get('autostart');
  const autoStart =
    autoParam !== '0' &&
    (params.has('autostart') || params.has('seed') || params.has('size') || params.has('quality'));
  const patch: Partial<Record<keyof NewGameOptions, unknown>> = {};
  if (params.has('seed')) patch.seed = params.get('seed');
  if (params.has('size')) patch.size = params.get('size');
  if (params.has('quality')) patch.quality = params.get('quality');
  if (params.has('difficulty')) patch.difficulty = params.get('difficulty');
  if (params.has('ai')) patch.aiCompanies = params.get('ai');
  return { options: mergeNewGameOptions(base, patch), autoStart };
}

const boot = readUrlBoot(createDefaultNewGameOptions(settings.quality));
let pendingOptions: NewGameOptions = boot.options;
let replayOptions: NewGameOptions = boot.options;

function persistSettings(next: GameSettings): void {
  settings = next;
  saveSettings(window.localStorage, next);
}

function disposeSession(): void {
  if (!session) return;
  session.dispose();
  session = null;
}

function showMainMenu(): void {
  disposeSession();
  screens.show(
    'menu',
    new MainMenuScreen({
      onSolo: () => showNewGame(),
      onSettings: () => showSettings('menu'),
      onAbout: () => showAbout(),
      unavailableReason: webglAvailable
        ? null
        : 'WebGL est indisponible dans ce navigateur. Activez l’accélération matérielle puis rechargez la page.',
    }),
  );
}

function showNewGame(): void {
  screens.show(
    'new-game',
    new NewGameScreen({
      initial: pendingOptions,
      onStart: (options) => {
        pendingOptions = options;
        replayOptions = options;
        persistSettings(updateSettings(settings, { quality: options.quality }));
        void startGame(options);
      },
      onBack: () => showMainMenu(),
    }),
  );
}

function showSettings(origin: SettingsOrigin): void {
  settingsOrigin = origin;
  if (session) session.setInputEnabled(false);
  screens.show(
    'settings',
    new SettingsScreen({
      settings,
      onChange: (next) => {
        persistSettings(next);
        pendingOptions = { ...pendingOptions, quality: next.quality };
        session?.applySettings(next);
      },
      onBack: () => {
        if (settingsOrigin === 'pause' && session) showPause();
        else showMainMenu();
      },
    }),
    { overlay: origin === 'pause' },
  );
}

function showAbout(): void {
  screens.show('about', new AboutScreen({ onBack: () => showMainMenu() }));
}

async function startGame(options: NewGameOptions): Promise<void> {
  disposeSession();
  if (!webglAvailable) {
    showMainMenu();
    return;
  }
  replayOptions = options;
  pendingOptions = options;
  persistSettings(updateSettings(settings, { quality: options.quality }));

  const token: LoadToken = { cancelled: false };
  const loading: LoadingScreen = new LoadingScreen({
    onCancel: () => {
      token.cancelled = true;
      loading.setCancelling();
    },
    onClose: () => showMainMenu(),
  });
  screens.show('loading', loading);

  const next = new GameSession({
    canvas: sceneCanvas,
    uiRoot: uiMount,
    config: options,
    settings,
    callbacks: {
      onProgress: (progress, message) => loading.setProgress(progress, message),
      onPauseRequested: () => showPause(),
      onOpenSettings: () => {
        session?.pause();
        session?.setInputEnabled(false);
        showSettings('pause');
      },
      onGameOver: (summary) => showGameOver(summary),
      onQualityChange: (quality) => {
        persistSettings(updateSettings(settings, { quality }));
        pendingOptions = { ...pendingOptions, quality };
      },
    },
  });
  session = next;

  try {
    await next.load(token);
    if (token.cancelled) throw new LoadCancelledError();
    screens.hide();
    next.setInputEnabled(true);
    exposeDebug(next);
  } catch (error) {
    const cancelled = token.cancelled || error instanceof LoadCancelledError;
    next.dispose();
    if (session === next) session = null;
    if (cancelled) {
      showMainMenu();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    loading.setError('Impossible de démarrer la partie', message);
  }
}

function showPause(): void {
  const current = session;
  if (!current) return;
  current.setInputEnabled(false);
  current.pause();
  screens.show(
    'pause',
    new PauseScreen({
      overview: current.getOverview(),
      onResume: () => {
        screens.hide();
        current.setInputEnabled(true);
        current.resume();
      },
      onSettings: () => showSettings('pause'),
      onQuit: () => {
        screens.hide();
        current.dispose();
        if (session === current) session = null;
        showMainMenu();
      },
    }),
    { overlay: true },
  );
}

function showGameOver(summary: GameOverSummary): void {
  const current = session;
  if (!current) return;
  current.setInputEnabled(false);
  current.pause();
  screens.show(
    'game-over',
    new GameOverScreen({
      summary,
      onMenu: () => {
        screens.hide();
        current.dispose();
        if (session === current) session = null;
        showMainMenu();
      },
      onReplay: () => {
        screens.hide();
        current.dispose();
        if (session === current) session = null;
        void startGame(replayOptions);
      },
    }),
    { overlay: true },
  );
}

function exposeDebug(current: GameSession): void {
  if (!import.meta.env.DEV) return;
  const api = {
    get game() {
      return current.gameInstance;
    },
    get world() {
      return current.worldInstance;
    },
    get renderer() {
      return current.rendererInstance;
    },
    get engine() {
      return current.engineInstance;
    },
    session: current,
    screens,
    endGame: (reason: string) => current.endGame(reason),
  };
  (window as unknown as Record<string, unknown>).__opentt3d = api;
}

if (boot.autoStart && webglAvailable) {
  void startGame(boot.options);
} else {
  if (boot.autoStart && !webglAvailable) {
    console.warn('[OpenTT3D] WebGL indisponible : démarrage automatique ignoré.');
  }
  showMainMenu();
}
