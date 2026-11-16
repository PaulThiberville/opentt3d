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
import { AudioEngine, volumesFromSettings } from './audio/AudioEngine';
import { loadAudioPreferences, saveAudioPreferences } from './audio/preferences';
import { installAudioUi } from './audio/ui';
import {
  EngineLoadError,
  describeUnknownError,
  parseEngineMode,
  type EngineMode,
} from './engine/loadEngine';
import { sharedEngineAvailability } from './ui/engineAvailability';
import { createDirectory, newRoomId, type Directory } from './net/directory';
import { createLobby, type Lobby } from './net/lobby';
import type { StartInfo } from './net/lobby-types';
import { createTransport, type Transport, type TransportKind } from './net/transport';
import { startPwa } from './pwa';
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
import { t } from './ui/i18n';
import {
  LateJoinClient,
  LateJoinError,
  LateJoinProbe,
  type LateJoinPrepared,
} from './ui/lateJoinClient';
import { LateJoinHost } from './ui/lateJoinHost';
import { LateJoinPanel } from './ui/lateJoinPanel';
import {
  buildRoomInvite,
  detachableTransport,
  mapStartInfoToGameOptions,
  readNetworkParams,
  transportKindFor,
  type DetachableTransport,
  type JoinTarget,
} from './ui/netlobby';
import {
  checkLateJoinCompatibility,
  hostPeerIdFromPayload,
  offerRejectMessage,
  type LateJoinOffer,
} from './ui/netjoin';
import {
  SETTINGS_STORAGE_KEY,
  loadSettings,
  p2pRelayUrls,
  saveSettings,
  updateSettings,
  type GameSettings,
} from './ui/settings';
import { defaultSaveName, type SaveRecord } from './ui/saveFormat';
import {
  describeSaveError,
  openSaveStore,
  type NewSaveInput,
  type SaveStoreHandle,
} from './ui/saveStore';
import { AboutScreen } from './ui/screens/AboutScreen';
import { DisconnectedScreen } from './ui/screens/DisconnectedScreen';
import { GameOverScreen } from './ui/screens/GameOverScreen';
import { LobbyScreen } from './ui/screens/LobbyScreen';
import { JoinScreen } from './ui/screens/JoinScreen';
import { LoadingScreen } from './ui/screens/LoadingScreen';
import { AttractScene } from './render/AttractScene';
import { MainMenuScreen } from './ui/screens/MainMenuScreen';
import { MultiplayerScreen, type CreateRoomRequest } from './ui/screens/MultiplayerScreen';
import { NewGameScreen } from './ui/screens/NewGameScreen';
import { PauseScreen } from './ui/screens/PauseScreen';
import { SaveScreen } from './ui/screens/SaveScreen';
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

/**
 * PWA : service worker + invitation de mise à jour. Désactivé en développement
 * (HMR) et avec `?pwa=off`. L'invitation n'apparaît que hors partie, via
 * `notifyAppIdle()`.
 */
const pwa = startPwa();

const screens = new ScreenManager(uiMount);
screens.onScreenChange = (key) => {
  // Sous une modale, la démo passe à 15 fps : le flou coûte déjà cher.
  attractScene?.setBackdrop(key !== null && key !== 'menu');
};
let settings = loadSettings(window.localStorage);
if (window.localStorage.getItem(SETTINGS_STORAGE_KEY) === null) {
  settings = {
    ...settings,
    quality: detectQuality(window.devicePixelRatio, navigator.hardwareConcurrency ?? 4),
  };
}
let session: GameSession | null = null;
let settingsOrigin: SettingsOrigin = 'menu';
let attractScene: AttractScene | null = null;
let saveStorePromise: Promise<SaveStoreHandle> | null = null;
let autosavePending = false;

/**
 * Moteur audio unique pour la page : il survit aux sessions (clics de menu) et
 * se déverrouille au premier geste. Les volumes viennent de `settings` ; le
 * mute est persisté à part (`opentt3d.audio.v1`).
 */
const audioPreferences = loadAudioPreferences(window.localStorage);
const audio = new AudioEngine({
  muted: audioPreferences.muted,
  volumes: volumesFromSettings(settings),
});
audio.subscribe((state) => {
  saveAudioPreferences(window.localStorage, { muted: state.muted });
});
installAudioUi({ engine: audio, win: window, doc: document });

/**
 * Ouvre le stockage local une seule fois par page. `openSaveStore` retombe sur
 * un backend mémoire si IndexedDB est refusé ; l'écran de sauvegarde l'annonce.
 */
function ensureSaveStore(): Promise<SaveStoreHandle> {
  saveStorePromise ??= openSaveStore();
  return saveStorePromise;
}

const webglAvailable = Renderer.isWebGLAvailable();
const prefersReducedMotion =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Moteur sélectionné par `?engine=mock|wasm` (#78). L'URL reste prioritaire
 * sur le réglage persistant pour les tests, la CI et les liens partagés. Sans
 * paramètre, le choix vient de `settings.engine` (défaut : mock).
 *
 * En réseau, ce choix est le réglage initial du salon ; il est ensuite figé
 * dans `StartInfo` pour que tous les pairs utilisent le même moteur (#93).
 */
function readEngineModeOverride(): EngineMode | null {
  const raw = new URLSearchParams(window.location.search).get('engine');
  if (raw === null || raw.trim() === '') return null;
  const parsed = parseEngineMode(raw);
  if (parsed) return parsed;
  console.warn(
    `[OpenTT3D] Moteur inconnu « ${raw} » : réglage persistant utilisé. Valeurs acceptées : mock, wasm.`,
  );
  return null;
}

const engineOverride = readEngineModeOverride();
const engineAvailability = sharedEngineAvailability();
let engineMode: EngineMode = engineOverride ?? settings.engine;
const networkBoot = readNetworkParams(window.location.search);
const networkKind = networkBoot.kind;
const transportKind: TransportKind = transportKindFor(networkKind);

/** `?relays=` prend le pas sur le réglage persistant (#39). */
function configuredRelays(): string[] {
  return networkBoot.relays.length > 0 ? networkBoot.relays : p2pRelayUrls(settings.p2pRelay);
}

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
    (params.has('autostart') ||
      params.has('seed') ||
      params.has('size') ||
      params.has('quality') ||
      params.has('disasters'));
  const patch: Partial<Record<keyof NewGameOptions, unknown>> = {};
  if (params.has('seed')) patch.seed = params.get('seed');
  if (params.has('size')) patch.size = params.get('size');
  if (params.has('quality')) patch.quality = params.get('quality');
  if (params.has('difficulty')) patch.difficulty = params.get('difficulty');
  if (params.has('ai')) patch.aiCompanies = params.get('ai');
  if (params.has('disasters')) patch.disasters = params.get('disasters');
  return { options: mergeNewGameOptions(base, patch), autoStart };
}

const boot = readUrlBoot(createDefaultNewGameOptions(settings.quality));
let pendingOptions: NewGameOptions = boot.options;
let replayOptions: NewGameOptions = boot.options;

let playerName = readPlayerName();
let activeLobby: Lobby | null = null;
let lobbyHandle: DetachableTransport | null = null;
let networkDirectory: Directory | null = null;
let lateHost: LateJoinHost | null = null;
let latePanel: LateJoinPanel | null = null;
let lateProbe: LateJoinProbe | null = null;
let lateProbeLobbyOff: (() => void) | null = null;
let lateClient: LateJoinClient | null = null;

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
    const relays = configuredRelays();
    networkDirectory =
      networkKind === 'local'
        ? createLocalDirectory()
        : createDirectory({
            kind: 'nostr',
            ...(relays.length > 0 ? { relays } : {}),
          });
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

function disposeLateHost(): void {
  latePanel?.dispose();
  latePanel = null;
  lateHost?.dispose();
  lateHost = null;
}

function stopLateProbe(): void {
  lateProbeLobbyOff?.();
  lateProbeLobbyOff = null;
  lateProbe?.stop();
  lateProbe = null;
}

function persistSettings(next: GameSettings): void {
  settings = next;
  saveSettings(window.localStorage, next);
  audio.setVolumes(volumesFromSettings(next));
  engineMode = engineOverride ?? next.engine;
}

/**
 * Détection des artefacts au démarrage (#78) : elle ne bloque jamais le menu.
 * Si un 404 confirme l'absence du WASM, un réglage `wasm` est ramené au mock
 * pour que « Nouvelle partie » ne propose pas un moteur cassé ; une panne
 * réseau n'écrase rien et laisse simplement le choix actif.
 */
engineAvailability.subscribe((artifacts) => {
  if (engineOverride || artifacts.reason !== 'missing' || settings.engine !== 'wasm') return;
  persistSettings(updateSettings(settings, { engine: 'mock' }));
});
void engineAvailability.refresh().catch((error: unknown) => {
  console.warn('[OpenTT3D] Vérification des artefacts moteur impossible', error);
});

function disposeSession(): void {
  stopLateProbe();
  disposeLateHost();
  if (!session) {
    closeNetworkDirectory();
    return;
  }
  session.dispose();
  session = null;
  closeNetworkDirectory();
}

/** Démo vivante derrière le menu : une partie mock autonome, sans HUD ni audio. */
function ensureAttract(): void {
  if (!webglAvailable || attractScene || prefersReducedMotion) return;
  const seedParam = Number(new URLSearchParams(window.location.search).get('attractSeed'));
  const scene = new AttractScene({
    quality: settings.quality === 'low' ? 'low' : 'medium',
    ...(Number.isFinite(seedParam) && seedParam > 0 ? { seed: seedParam } : {}),
  });
  attractScene = scene;
  void scene.start().then(() => {
    if (attractScene === scene && !scene.isRunning) attractScene = null;
  });
}

function stopAttract(): void {
  attractScene?.dispose();
  attractScene = null;
}

function showMainMenu(): void {
  pwa.notifyAppIdle();
  disposeSession();
  ensureAttract();
  screens.show(
    'menu',
    new MainMenuScreen({
      onSolo: () => showNewGame(),
      onMultiplayer: () => showMultiplayer(),
      onLoad: () => showSaveScreen('menu'),
      onSettings: () => showSettings('menu'),
      onAbout: () => showAbout(),
      unavailableReason: webglAvailable ? null : t('menu.unavailable.webgl'),
      multiplayerNote:
        networkKind === 'local' ? t('menu.multiplayer.localNote') : t('menu.multiplayer.relayNote'),
      liveSimulation: webglAvailable && !prefersReducedMotion,
    }),
  );
}

function showNewGame(): void {
  screens.show(
    'new-game',
    new NewGameScreen({
      initial: pendingOptions,
      engineMode,
      storedEngineMode: settings.engine,
      engineUrlMode: engineOverride,
      engineAvailability,
      onEngineChange: (mode) => {
        if (engineOverride) return;
        persistSettings(updateSettings(settings, { engine: mode }));
      },
      onStart: (options, engine) => {
        pendingOptions = options;
        replayOptions = options;
        persistSettings(
          updateSettings(settings, {
            quality: options.quality,
            ...(engineOverride ? {} : { engine }),
          }),
        );
        void startGame(options, engine);
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
    const relays = configuredRelays();
    const transport = createTransport({
      kind: transportKind,
      roomId,
      ...(relays.length > 0 ? { relays } : {}),
    });
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
        engine: engineMode,
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
    const relays = configuredRelays();
    const transport = createTransport({
      kind: transportKind,
      roomId: target.roomId,
      ...(relays.length > 0 ? { relays } : {}),
    });
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
    startLateProbe(target, name, handle.transport, lobby);
    showLobby(lobby);
  } catch (error) {
    stopLateProbe();
    handle?.transport.leave();
    showMultiplayer({
      join: target.roomId,
      notice: `Impossible de rejoindre le salon : ${lobbyErrorMessage(error)}`,
    });
  }
}

/**
 * Découverte d'une partie déjà démarrée (#92). Le probe questionne le salon
 * sur un canal distinct : tant que la partie n'a pas démarré, personne ne
 * répond et le salon reste le chemin normal. Dès qu'une offre arrive, le
 * salon local est détaché (le transport reste ouvert) et l'écran de join prend
 * le relais.
 */
function startLateProbe(
  target: JoinTarget,
  name: string,
  transport: Transport,
  lobby: Lobby,
): void {
  stopLateProbe();
  // Dès que le salon répond normalement (place attribuée, partie pas encore
  // démarrée), la découverte tardive n'a plus lieu d'être.
  let offLobby: (() => void) | null = null;
  offLobby = lobby.onChange((state) => {
    if (state.closed || state.started || state.slots.some((slot) => slot.id === lobby.selfId)) {
      offLobby?.();
      lateProbeLobbyOff = null;
      stopLateProbe();
    }
  });
  lateProbeLobbyOff = offLobby;
  const probe = new LateJoinProbe({
    transport,
    ...(target.hostId ? { hostId: target.hostId } : {}),
    playerName: name,
    onOffer: (offer, from) => {
      // Le `lobby-start` peut arriver juste après le démarrage : si ce client
      // fait partie de la partie, il suit le chemin normal, pas le join tardif.
      const lobby = activeLobby;
      if (lobby?.state.started && lobby.state.slots.some((slot) => slot.id === lobby.selfId)) {
        return;
      }
      stopLateProbe();
      detachLobbyHandlers();
      enterLateJoin(offer, from, transport, target);
    },
    onDenied: (offer) => {
      stopLateProbe();
      detachLobbyHandlers();
      transport.leave();
      showMultiplayer({
        join: target.roomId,
        notice: offerRejectMessage(offer),
      });
    },
  });
  lateProbe = probe;
  probe.start();
}

/** Bascule vers l'écran de progression et lance le vrai join. */
function enterLateJoin(
  offer: LateJoinOffer,
  from: string,
  transport: Transport,
  target: JoinTarget,
): void {
  const payload = offer.payload;
  if (!payload) {
    transport.leave();
    showMultiplayer({ join: target.roomId, notice: t('mp.notice.hostConfig') });
    return;
  }
  const compatibility = checkLateJoinCompatibility(payload);
  if (compatibility) {
    transport.leave();
    showMultiplayer({ join: target.roomId, notice: compatibility });
    return;
  }
  const expectedHost = hostPeerIdFromPayload(payload);
  if (expectedHost !== null && expectedHost !== from) {
    transport.leave();
    showMultiplayer({
      join: target.roomId,
      notice: t('mp.notice.inconsistent'),
    });
    return;
  }

  let cancelled = false;
  const screen: JoinScreen = new JoinScreen({
    payload,
    onCancel: () => {
      cancelled = true;
      screen.setCancelling();
      lateClient?.cancel();
      lateClient = null;
      transport.leave();
      showMultiplayer({ join: target.roomId, notice: t('mp.notice.cancelled') });
    },
    onBack: () => showMainMenu(),
  });
  screens.show('join', screen);

  const client = new LateJoinClient({
    transport,
    payload,
    hostId: from,
    playerName,
    onState: (state) => screen.setState(state),
  });
  lateClient = client;

  void (async () => {
    try {
      const prepared = await client.prepare();
      if (cancelled) {
        prepared.session.dispose();
        prepared.engine.dispose();
        return;
      }
      lateClient = null;
      await startJoinedGame(prepared, screen);
    } catch (error) {
      lateClient = null;
      if (cancelled) return;
      const reason =
        error instanceof LateJoinError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      console.warn('[OpenTT3D] join tardif impossible', error);
      // La session partielle est libérée par `cancel` (idempotent).
      client.cancel();
      transport.leave();
      screen.setError('Impossible de rejoindre la partie', reason);
    }
  })();
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
  stopLateProbe();
  detachLobbyHandlers();
  lobby?.leave();
  closeNetworkDirectory();
  showMainMenu();
}

function beginNetworkGame(info: StartInfo): void {
  // Le salon a rempli son rôle : on garde le transport pour le lockstep.
  // Depuis #92, les retardataires sont acceptés via le broker de join tardif.
  stopLateProbe();
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
      engineUrlMode: engineOverride,
      engineAvailability,
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

async function startGame(options: NewGameOptions, engine: EngineMode = engineMode): Promise<void> {
  stopAttract();
  disposeSession();
  if (!webglAvailable) {
    showMainMenu();
    return;
  }
  pwa.notifyAppBusy();
  replayOptions = options;
  pendingOptions = options;
  engineMode = engine;
  persistSettings(
    updateSettings(settings, {
      quality: options.quality,
      ...(engineOverride ? {} : { engine }),
    }),
  );

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
    audio,
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
      loading.setError(t('loading.error.wasm'), `${message}${hint}`);
    } else {
      loading.setError(t('join.error.start'), message);
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
    onAutosave: () => {
      void runAutosave();
    },
  };
}

/** Options d'affichage à réutiliser pour une sauvegarde chargée. */
function loadedGameOptions(record: SaveRecord): NewGameOptions {
  const patch: Partial<Record<keyof NewGameOptions, unknown>> = {
    quality: settings.quality,
  };
  if (record.seed !== null) patch.seed = record.seed;
  if (record.mapSize !== null) patch.size = record.mapSize;
  return mergeNewGameOptions({ ...pendingOptions, quality: settings.quality }, patch);
}

async function startLoadedGame(record: SaveRecord): Promise<void> {
  stopAttract();
  // L'ancienne session (le cas échéant) est libérée avant toute allocation :
  // pas de contexte WebGL ni de listener orphelin pendant le chargement.
  disposeSession();
  if (!webglAvailable) {
    showMainMenu();
    return;
  }
  pwa.notifyAppBusy();
  const options = loadedGameOptions(record);
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
  loading.setProgress(0.02, `Restauration de « ${record.name} »…`);

  const next = new GameSession({
    canvas: sceneCanvas,
    uiRoot: uiMount,
    config: options,
    settings,
    engine: record.engine,
    audio,
    loadedGame: {
      bytes: record.bytes,
      options,
      engine: record.engine,
      name: record.name,
    },
    callbacks: soloCallbacks(loading),
  });
  session = next;

  try {
    await next.load(token);
    if (token.cancelled) throw new LoadCancelledError();
    screens.hide();
    next.setInputEnabled(true);
    // La partie a souvent été sauvegardée depuis la pause : on reprend
    // immédiatement après la restauration.
    next.resume();
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
    loading.setError(
      'Impossible de charger la sauvegarde',
      `${message} Vérifiez que le fichier correspond bien au moteur ${record.engine === 'wasm' ? 'WASM' : 'mock'}.`,
    );
  }
}

/** Autosave glissant : capture, écriture, rotation, toast discret. */
async function runAutosave(): Promise<void> {
  const current = session;
  if (!current || current.isNetwork || autosavePending) return;
  autosavePending = true;
  try {
    const handle = await ensureSaveStore();
    if (session !== current || current.isNetwork) return;
    const captured = await current.captureSave();
    const slot = await handle.store.saveAutosave(captured);
    if (session === current) current.notifySave(`Partie sauvegardée · ${slot.name}`);
  } catch (error) {
    if (session === current) {
      current.notifySaveError(`Autosave impossible : ${describeSaveError(error)}`);
    }
  } finally {
    autosavePending = false;
  }
}

function networkCallbacks(
  onProgress: (progress: number, message: string) => void,
): GameSessionCallbacks {
  return {
    onProgress,
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
  };
}

async function startNetworkGame(info: StartInfo): Promise<void> {
  stopAttract();
  disposeSession();
  pwa.notifyAppBusy();
  // Le transport vient du salon : il ne doit pas être fermé par le nettoyage
  // du menu. L'hôte répond aux retardataires via `LateJoinHost`, créé avant le
  // chargement pour qu'une demande pendant la génération ne reste pas muette.
  if (info.isHost) {
    lateHost = new LateJoinHost({ transport: info.transport, start: info });
  }

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
    engine: info.settings.engine,
    network: info,
    audio,
    callbacks: networkCallbacks((progress, message) => loading.setProgress(progress, message)),
  });
  session = next;

  try {
    await next.load(token);
    if (token.cancelled) throw new LoadCancelledError();
    screens.hide();
    next.setInputEnabled(true);
    exposeDebug(next);
    if (info.isHost && lateHost) {
      const net = next.networkSession;
      if (net) lateHost.attachSession(net);
      const roomId = info.transport.roomId;
      if (roomId) {
        latePanel = new LateJoinPanel({
          mount: uiMount,
          host: lateHost,
          roomId,
          inviteLink: buildRoomInvite(
            roomId,
            info.transport.selfId,
            networkKind,
            window.location.href,
          ),
        });
      }
    }
  } catch (error) {
    const cancelled = token.cancelled || error instanceof LoadCancelledError;
    next.dispose();
    if (session === next) session = null;
    disposeLateHost();
    if (cancelled) {
      showMainMenu();
      return;
    }
    loading.setError('Impossible de rejoindre la partie', describeUnknownError(error));
  }
}

/** Démarre le rendu et le HUD autour de la session déjà chargée par le join. */
async function startJoinedGame(prepared: LateJoinPrepared, screen: JoinScreen): Promise<void> {
  stopAttract();
  const start = prepared.start;
  disposeSession();
  pwa.notifyAppBusy();
  const mapped = mapStartInfoToGameOptions(start, pendingOptions.quality);
  pendingOptions = { ...pendingOptions, quality: mapped.options.quality };
  const token: LoadToken = { cancelled: false };
  const next = new GameSession({
    canvas: sceneCanvas,
    uiRoot: uiMount,
    config: mapped.options,
    settings,
    engine: start.settings.engine,
    network: start,
    preparedJoin: prepared,
    audio,
    callbacks: networkCallbacks((progress, message) => screen.setPreparation(progress, message)),
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
    screen.setError(t('join.error.startJoined'), describeUnknownError(error));
  }
}

/**
 * Écran Sauvegarder / Charger. Depuis la pause, il capture la session en cours ;
 * depuis le menu principal, il ne fait que lister/importer et charger.
 */
function showSaveScreen(origin: 'menu' | 'pause'): void {
  const current = session;
  if (origin === 'pause' && current) {
    current.setInputEnabled(false);
    current.pause();
  }
  const capture =
    origin === 'pause' && current
      ? async (): Promise<Omit<NewSaveInput, 'name'>> => current.captureSave()
      : undefined;
  const overview = origin === 'pause' ? (current?.getOverview() ?? null) : null;
  const liveDate = current?.gameInstance?.getLatestSnapshot()?.economy ?? null;

  screens.show(
    'saves',
    new SaveScreen({
      store: ensureSaveStore(),
      mode: origin === 'pause' ? 'both' : 'load',
      onBack: () => {
        if (origin === 'pause' && current && session === current) showPause();
        else showMainMenu();
      },
      onLoad: (record) => {
        screens.hide();
        void startLoadedGame(record);
      },
      ...(capture ? { capture } : {}),
      suggestedName: defaultSaveName(liveDate),
      ...(overview
        ? { currentLabel: `${overview.company} · ${overview.date} · ${overview.money}` }
        : {}),
      onSaved: (slot) => {
        current?.notifySave(`Partie sauvegardée : « ${slot.name} »`);
        // Une sauvegarde vient d'être écrite : c'est le bon moment pour
        // proposer la mise à jour sans perdre de progression.
        pwa.notifyAppIdle();
      },
    }),
  );
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
      onSave: () => showSaveScreen('pause'),
      onLoad: () => showSaveScreen('pause'),
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
              void startGame(replayOptions, current.engineMode);
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
      title: t('disconnected.title.hostLost'),
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
    get audio() {
      return current.audioEngine ?? audio;
    },
    get buildTool() {
      return current.getBuildTool();
    },
    get buildSettings() {
      return current.getBuildSettings();
    },
    setBuildTool: (
      tool:
        | 'road'
        | 'rail'
        | 'clear'
        | 'station'
        | 'depot'
        | 'signal'
        | 'unsignal'
        | 'convert'
        | 'terraform'
        | 'tree'
        | 'canal'
        | 'lock'
        | 'aqueduct'
        | 'crossing'
        | 'bridge'
        | 'tunnel',
    ) => current.setBuildTool(tool),
    session: current,
    screens,
    endGame: (reason: string) => current.endGame(reason),
    listSaves: async () => (await ensureSaveStore()).store.list(),
    captureSave: () => current.captureSave(),
    restored: current.restoredStateInfo,
    photo: current.getPhotoMode(),
    togglePhotoMode: (preset?: 'map' | 'street' | 'train') => current.togglePhotoMode(preset),
    isIntroRunning: () => current.isCinematicIntroRunning(),
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
