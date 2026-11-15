/**
 * Bootstrap du frontend OpenTT3D.
 *
 * Machine à états simple : menu → nouvelle partie ou multijoueur → chargement
 * → session de jeu (HUD + 3D) → pause / réglages / fin de partie → retour au
 * menu. Le retour au menu libère entièrement la session (`dispose()`), ce qui
 * permet de relancer une partie sans contexte WebGL orphelin.
 *
 * Le multijoueur reste sans backend : en production Trystero (WebRTC via relais
 * Nostr), en développement `?net=local` (BroadcastChannel entre onglets). Le
 * menu ne crée le transport et l'annuaire qu'au moment d'entrer dans le salon.
 */

import './style.css';
import {
  EngineLoadError,
  describeUnknownError,
  parseEngineMode,
  type EngineMode,
} from './engine/loadEngine';
import { createDirectory, newRoomId, type Directory } from './net/directory';
import { createLobby, type Lobby } from './net/lobby';
import type { StartInfo } from './net/lobby-types';
import { createTransport, type TransportKind } from './net/transport';
import { Renderer } from './render/Renderer';
import { detectQuality } from './render/quality';
import {
  GameSession,
  LoadCancelledError,
  type GameSessionCallbacks,
  type LoadToken,
} from './ui/gameSession';
import {
  createDefaultNewGameOptions,
  mergeNewGameOptions,
  type NewGameOptions,
} from './ui/gameOptions';
import { createLocalDirectory } from './ui/localDirectory';
import {
  detachableTransport,
  installStartedGate,
  mapStartInfoToGameOptions,
  readNetworkParams,
  transportKindFor,
  type DetachableTransport,
  type JoinTarget,
} from './ui/netlobby';
import {
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
  updateSettings,
  type GameSettings,
} from './ui/settings';
import { AboutScreen } from './ui/screens/AboutScreen';
import { DisconnectedScreen } from './ui/screens/DisconnectedScreen';
import { GameOverScreen } from './ui/screens/GameOverScreen';
import { LobbyScreen } from './ui/screens/LobbyScreen';
import { LoadingScreen } from './ui/screens/LoadingScreen';
import { MainMenuScreen } from './ui/screens/MainMenuScreen';
import { MultiplayerScreen, type CreateRoomRequest } from './ui/screens/MultiplayerScreen';
import { NewGameScreen } from './ui/screens/NewGameScreen';
import { PauseScreen } from './ui/screens/PauseScreen';
import { ScreenManager } from './ui/screens/ScreenManager';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import type { GameOverSummary } from './ui/types';

type SettingsOrigin = 'menu' | 'pause';

const PLAYER_NAME_KEY = 'opentt3d.playerName';

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

/**
 * Moteur sélectionné par `?engine=mock|wasm`. Le mock reste le défaut : le
 * moteur réel n'est activé que sur demande explicite, le temps de valider
 * l'intégration (issue #13). Le réseau force le mock (#73).
 */
function readEngineMode(): EngineMode {
  const raw = new URLSearchParams(window.location.search).get('engine');
  if (raw === null || raw.trim() === '') return 'mock';
  const parsed = parseEngineMode(raw);
  if (parsed) return parsed;
  console.warn(
    `[OpenTT3D] Moteur inconnu « ${raw} » : moteur mock utilisé. Valeurs acceptées : mock, wasm.`,
  );
  return 'mock';
}

const engineMode: EngineMode = readEngineMode();
const networkBoot = readNetworkParams(window.location.search);
const networkKind = networkBoot.kind;
const transportKind: TransportKind = transportKindFor(networkKind);

if (networkBoot.warning) {
  console.warn(`[OpenTT3D] ${networkBoot.warning}`);
}

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

let playerName = readPlayerName();
let activeLobby: Lobby | null = null;
let lobbyHandle: DetachableTransport | null = null;
let startedGateOff: (() => void) | null = null;
let networkDirectory: Directory | null = null;

function readPlayerName(): string {
  try {
    const stored = window.localStorage.getItem(PLAYER_NAME_KEY);
    if (stored && stored.trim()) return stored.trim().slice(0, 24);
  } catch {
    // localStorage peut être bloqué (mode privé strict).
  }
  return 'Joueur';
}

function rememberPlayerName(name: string): void {
  const clean = name.trim().slice(0, 24);
  if (!clean) return;
  playerName = clean;
  try {
    window.localStorage.setItem(PLAYER_NAME_KEY, clean);
  } catch {
    // Le nom reste valable pour la session courante.
  }
}

function ensureNetworkDirectory(): Directory | null {
  if (networkDirectory) return networkDirectory;
  try {
    networkDirectory =
      networkKind === 'local' ? createLocalDirectory() : createDirectory({ kind: 'nostr' });
  } catch (error) {
    console.warn('[OpenTT3D] Annuaire multijoueur indisponible', error);
    networkDirectory = null;
  }
  return networkDirectory;
}

function closeNetworkDirectory(): void {
  if (!networkDirectory) return;
  try {
    networkDirectory.close();
  } catch {
    // Fermer un annuaire déjà détruit n'est pas une erreur visible.
  }
  networkDirectory = null;
}

/** Détache le salon sans fermer le transport : il passe au lockstep. */
function detachLobbyHandlers(): void {
  lobbyHandle?.detach();
  lobbyHandle = null;
  activeLobby = null;
}

function disposeNetworkGate(): void {
  startedGateOff?.();
  startedGateOff = null;
}

function persistSettings(next: GameSettings): void {
  settings = next;
  saveSettings(window.localStorage, next);
}

function disposeSession(): void {
  if (!session) {
    disposeNetworkGate();
    closeNetworkDirectory();
    return;
  }
  session.dispose();
  session = null;
  disposeNetworkGate();
  closeNetworkDirectory();
}

function showMainMenu(): void {
  disposeSession();
  screens.show(
    'menu',
    new MainMenuScreen({
      onSolo: () => showNewGame(),
      onMultiplayer: () => showMultiplayer(),
      onSettings: () => showSettings('menu'),
      onAbout: () => showAbout(),
      unavailableReason: webglAvailable
        ? null
        : 'WebGL est indisponible dans ce navigateur. Activez l’accélération matérielle puis rechargez la page.',
      multiplayerNote:
        networkKind === 'local'
          ? 'Mode local · deux onglets BroadcastChannel'
          : 'Salon P2P · Trystero / relais Nostr',
    }),
  );
}

function showNewGame(): void {
  screens.show(
    'new-game',
    new NewGameScreen({
      initial: pendingOptions,
      engineMode,
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

interface MultiplayerPrefill {
  join?: string;
  notice?: string | null;
}

function showMultiplayer(prefill: MultiplayerPrefill = {}): void {
  const directory = ensureNetworkDirectory();
  const notice = prefill.notice ?? networkBoot.warning;
  screens.show(
    'multiplayer',
    new MultiplayerScreen({
      kind: networkKind,
      directory,
      initialName: playerName,
      ...(prefill.join ? { initialJoin: prefill.join } : {}),
      ...(notice ? { notice } : {}),
      onCreate: (request) => createRoom(request),
      onJoin: (target, name) => {
        rememberPlayerName(name);
        joinRoom(target, name);
      },
      onBack: () => {
        closeNetworkDirectory();
        showMainMenu();
      },
    }),
  );
}

function lobbyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRoom(request: CreateRoomRequest): void {
  rememberPlayerName(request.playerName);
  const roomId = newRoomId();
  let handle: DetachableTransport | null = null;
  try {
    const transport = createTransport({ kind: transportKind, roomId });
    handle = detachableTransport(transport);
    const directory = ensureNetworkDirectory();
    const lobby = createLobby({
      transport: handle.transport,
      isHost: true,
      roomId,
      name: request.lobbyName,
      seed: request.seed,
      isPublic: request.isPublic,
      directory: request.isPublic && directory ? directory : undefined,
      settings: {
        mapSize: request.mapSize,
        difficulty: request.difficulty,
        maxPlayers: 8,
      },
    });
    lobby.setName(request.playerName);
    activeLobby = lobby;
    lobbyHandle = handle;
    showLobby(lobby);
  } catch (error) {
    handle?.transport.leave();
    showMultiplayer({
      notice: `Impossible de créer le salon : ${lobbyErrorMessage(error)}`,
    });
  }
}

function joinRoom(target: JoinTarget, name: string): void {
  let handle: DetachableTransport | null = null;
  try {
    const transport = createTransport({ kind: transportKind, roomId: target.roomId });
    handle = detachableTransport(transport);
    const lobby = createLobby({
      transport: handle.transport,
      isHost: false,
      roomId: target.roomId,
      name,
      ...(target.hostId ? { hostId: target.hostId } : {}),
    });
    activeLobby = lobby;
    lobbyHandle = handle;
    showLobby(lobby);
  } catch (error) {
    handle?.transport.leave();
    showMultiplayer({
      join: target.roomId,
      notice: `Impossible de rejoindre le salon : ${lobbyErrorMessage(error)}`,
    });
  }
}

function showLobby(lobby: Lobby): void {
  screens.show(
    'lobby',
    new LobbyScreen({
      lobby,
      kind: networkKind,
      onStart: (info) => beginNetworkGame(info),
      onLeave: () => leaveLobby(),
    }),
  );
}

function leaveLobby(): void {
  const lobby = activeLobby;
  detachLobbyHandlers();
  lobby?.leave();
  closeNetworkDirectory();
  showMainMenu();
}

function beginNetworkGame(info: StartInfo): void {
  // Le salon a rempli son rôle : on garde le transport pour le lockstep et on
  // refuse explicitement les retardataires.
  detachLobbyHandlers();
  closeNetworkDirectory();
  if (!webglAvailable) {
    info.transport.leave();
    showMainMenu();
    return;
  }
  void startNetworkGame(info);
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
    engine: engineMode,
    callbacks: soloCallbacks(loading),
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
    const message = describeUnknownError(error);
    if (error instanceof EngineLoadError) {
      const hint = error.hint ? ` ${error.hint}` : '';
      loading.setError('Moteur WASM indisponible', `${message}${hint}`);
    } else {
      loading.setError('Impossible de démarrer la partie', message);
    }
  }
}

function soloCallbacks(loading?: LoadingScreen): GameSessionCallbacks {
  return {
    onProgress: (progress, message) => loading?.setProgress(progress, message),
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
  };
}

async function startNetworkGame(info: StartInfo): Promise<void> {
  disposeSession();
  // Le transport vient du salon : il ne doit pas être fermé par le nettoyage
  // du menu. On installe la porte de refus des retardataires.
  disposeNetworkGate();
  startedGateOff = installStartedGate(info.transport, Object.values(info.peers));

  const mapped = mapStartInfoToGameOptions(info, pendingOptions.quality);
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
    config: mapped.options,
    settings,
    engine: 'mock',
    network: info,
    callbacks: {
      onProgress: (progress, message) => loading.setProgress(progress, message),
      onPauseRequested: () => showPause(),
      onOpenSettings: () => {
        session?.setInputEnabled(false);
        showSettings('pause');
      },
      onGameOver: (summary) => showGameOver(summary),
      onNetworkLost: (reason) => showNetworkLost(reason),
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
    disposeNetworkGate();
    if (cancelled) {
      showMainMenu();
      return;
    }
    loading.setError('Impossible de rejoindre la partie', describeUnknownError(error));
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
      network: current.isNetwork,
      onResume: () => {
        screens.hide();
        current.setInputEnabled(true);
        current.resume();
      },
      onSettings: () => showSettings('pause'),
      onQuit: () => {
        screens.hide();
        if (session === current) disposeSession();
        else current.dispose();
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
        if (session === current) disposeSession();
        else current.dispose();
        showMainMenu();
      },
      ...(current.isNetwork
        ? {}
        : {
            onReplay: () => {
              screens.hide();
              current.dispose();
              if (session === current) session = null;
              void startGame(replayOptions);
            },
          }),
    }),
    { overlay: true },
  );
}

function showNetworkLost(reason: string): void {
  screens.hide();
  disposeSession();
  screens.show(
    'disconnected',
    new DisconnectedScreen({
      title: 'Hôte perdu',
      reason,
      onMenu: () => showMainMenu(),
    }),
  );
}

function exposeDebug(current: GameSession): void {
  if (!import.meta.env.DEV) return;
  const api = {
    engineMode: current.engineMode,
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
    get network() {
      return current.networkSession;
    },
    get netStatus() {
      return current.networkSession?.stats() ?? null;
    },
    get buildTool() {
      return current.getBuildTool();
    },
    get buildSettings() {
      return current.getBuildSettings();
    },
    setBuildTool: (tool: 'road' | 'rail' | 'clear' | 'station' | 'depot' | 'signal') =>
      current.setBuildTool(tool),
    session: current,
    screens,
    endGame: (reason: string) => current.endGame(reason),
  };
  (window as unknown as Record<string, unknown>).__opentt3d = api;
}

if (networkBoot.invite) {
  joinRoom(networkBoot.invite, playerName);
} else if (networkBoot.roomId) {
  showMultiplayer({ join: networkBoot.roomId, notice: networkBoot.warning });
} else if (boot.autoStart && webglAvailable) {
  void startGame(boot.options);
} else {
  if (boot.autoStart && !webglAvailable) {
    console.warn('[OpenTT3D] WebGL indisponible : démarrage automatique ignoré.');
  }
  showMainMenu();
}
