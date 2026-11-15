/**
 * Bootstrap du frontend OpenTT3D.
 *
 * Enchaînement : HUD (écran de chargement) → moteur mock → boucle de jeu →
 * renderer → scène → première frame. Toute erreur d'initialisation (WebGL
 * indisponible, contexte perdu) est présentée dans un écran dédié.
 */

import './style.css';
import { MockEngine } from './engine/MockEngine';
import { Game, type GameSpeed, type Selection } from './game/Game';
import { Renderer } from './render/Renderer';
import { WorldView, type WorldTarget } from './render/WorldView';
import { Hud, type SelectionSummary } from './ui/Hud';
import { QUALITY_PRESETS, detectQuality, nextQuality, type QualityLevel } from './render/quality';
import { companyColour } from './render/tileVisuals';
import { TILE_KINDS, tileIndex } from './game/mapGrid';
import type { MapSnapshot, WorldSnapshot } from './engine/protocol';

const VEHICLE_LABELS: Record<string, string> = {
  train: 'Train',
  road: 'Véhicule routier',
  ship: 'Bateau',
  aircraft: 'Avion',
};

const STATION_LABELS: Record<string, string> = {
  train: 'Gare',
  road: 'Arrêt',
  ship: 'Dock',
  airport: 'Aéroport',
  buoy: 'Bouée',
};

const HUD_REFRESH_SECONDS = 0.2;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

interface BootstrapOptions {
  seed: number;
  size: number;
  quality: QualityLevel;
}

function readOptions(): BootstrapOptions {
  const params = new URLSearchParams(window.location.search);
  const seed = Number.parseInt(params.get('seed') ?? '', 10);
  const size = Number.parseInt(params.get('size') ?? '', 10);
  const requested = params.get('quality');
  const quality: QualityLevel =
    requested === 'low' || requested === 'medium' || requested === 'high'
      ? requested
      : detectQuality(window.devicePixelRatio, navigator.hardwareConcurrency ?? 4);
  return {
    seed: Number.isFinite(seed) ? seed >>> 0 : 1337,
    size: Number.isFinite(size) ? Math.min(384, Math.max(96, size)) : 256,
    quality,
  };
}

async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene');
  const mount = document.querySelector<HTMLElement>('#ui');
  if (!canvas || !mount) {
    throw new Error('Éléments canvas/#ui introuvables dans index.html');
  }

  const options = readOptions();
  let quality = options.quality;
  let engine: MockEngine | null = null;
  let game: Game | null = null;
  let renderer: Renderer | null = null;
  let world: WorldView | null = null;
  let hudTimer = 0;
  let lastTarget: WorldTarget | null = null;
  let refreshHud = (): void => {};

  const hud = new Hud(mount, {
    onTogglePause: () => {
      game?.togglePause();
      refreshHud();
    },
    onSpeedChange: (speed: GameSpeed) => {
      game?.setSpeed(speed);
      refreshHud();
    },
    onResetView: () => {
      world?.resetView();
      game?.select(null);
      world?.setSelection(null);
      lastTarget = null;
      refreshHud();
    },
    onCycleQuality: () => {
      quality = nextQuality(quality);
      renderer?.setQuality(quality);
      world?.setQuality(quality);
      hud.notify('info', `Qualité de rendu : ${QUALITY_PRESETS[quality].label.toLowerCase()}.`);
      refreshHud();
    },
  });
  hud.showLoading('Chargement du moteur…');

  if (!Renderer.isWebGLAvailable()) {
    hud.showError(
      'WebGL indisponible',
      'Votre navigateur ou votre carte graphique ne fournit pas de contexte WebGL. Activez l’accélération matérielle puis rechargez la page.',
    );
    return;
  }

  try {
    engine = new MockEngine();
    await engine.init({ moduleUrl: 'mock://engine' });
    hud.setProgress(0.25, 'Génération du monde…');
    await nextFrame();

    await engine.newGame({
      seed: options.seed,
      width: options.size,
      height: options.size,
      aiCompanies: 1,
      difficulty: 1,
      startYear: 1950,
      climate: 'temperate',
    });
    hud.setProgress(0.45, 'Création de la boucle de jeu…');
    await nextFrame();

    game = new Game({ driver: engine });
    game.start();

    refreshHud = (): void => {
      if (!game || !world) return;
      const snapshot = game.getLatestSnapshot();
      hud.update({
        snapshot,
        fps: game.getFps(),
        paused: game.isPaused(),
        speed: game.getSpeed(),
        selection: describeSelection(snapshot, game.getSelection(), lastTarget, world.getMap()),
        quality,
        following: world.isFollowing(),
        drawCalls: world.getDrawCalls(),
      });
    };

    const applySelection = (target: WorldTarget | null): void => {
      lastTarget = target;
      world?.setSelection(target);
      game?.select(toSelection(target, world?.getMap()?.width ?? options.size));
      refreshHud();
    };

    renderer = new Renderer({ canvas, quality });
    world = new WorldView({
      scene: renderer.scene,
      camera: renderer.camera,
      canvas,
      quality,
      onSelect: (target) => applySelection(target),
      onHover: () => undefined,
      onNotice: (text) => hud.notify('info', text),
    });

    hud.setProgress(0.6, 'Construction du terrain…');
    await nextFrame();
    const buildStart = performance.now();
    const initial = game.getLatestSnapshot();
    if (initial) world.applySnapshot(initial);
    const buildMs = Math.round(performance.now() - buildStart);
    hud.setProgress(0.9, 'Échauffement du rendu…');
    renderer.renderNow();
    await nextFrame();

    // Les snapshots suivants sont poussés par la boucle de jeu.
    game.events.on('snapshot', ({ snapshot }) => {
      world?.applySnapshot(snapshot);
    });
    game.events.on('notify', ({ kind, text }) => hud.notify(kind, text));
    game.events.on('state', () => refreshHud());
    game.events.on('selection', () => refreshHud());

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space') {
        event.preventDefault();
        game?.togglePause();
        refreshHud();
      } else if (event.key === 'Escape') {
        world?.stopFollowing();
        game?.select(null);
        world?.setSelection(null);
        lastTarget = null;
        refreshHud();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      hud.showError(
        'Contexte WebGL perdu',
        'Le pilote graphique a interrompu le rendu. Rechargez la page pour reprendre la partie.',
      );
    });

    renderer.start((delta) => {
      if (!game || !world) return;
      game.advance(delta);
      const interpolation = game.getInterpolation();
      world.update(delta, interpolation);
      hudTimer += delta;
      if (hudTimer >= HUD_REFRESH_SECONDS) {
        hudTimer = 0;
        refreshHud();
      }
    });

    if (import.meta.env.DEV) {
      // Point d'accroche pour Playwright et le débogage manuel.
      (window as unknown as Record<string, unknown>).__opentt3d = { game, world, renderer, engine };
    }

    hud.setProgress(1, 'Monde prêt');
    hud.hideLoading();
    hud.notify('info', `Monde ${options.size}×${options.size} généré en ${buildMs} ms.`);
    hud.notify('info', 'Clic droit / Alt + glisser : orbite · molette : zoom · clic : sélection.');
    refreshHud();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hud.showError('Impossible de démarrer la scène 3D', message);
    // Nettoyage partiel pour éviter un contexte WebGL orphelin.
    world?.dispose();
    renderer?.dispose();
    game?.dispose();
    engine?.dispose();
    throw error;
  }
}

function toSelection(target: WorldTarget | null, mapWidth: number): Selection | null {
  if (!target) return null;
  if (target.kind === 'vehicle') return { kind: 'vehicle', id: target.id };
  if (target.kind === 'building') return { kind: 'town', id: target.townId };
  return { kind: 'tile', id: tileIndex(target.x, target.y, mapWidth) };
}

function describeSelection(
  snapshot: WorldSnapshot | null,
  selection: Selection | null,
  target: WorldTarget | null,
  map: MapSnapshot | null,
): SelectionSummary | null {
  if (!snapshot || !selection) return null;
  switch (selection.kind) {
    case 'vehicle': {
      const vehicle = snapshot.vehicles.find((item) => item.id === selection.id);
      if (!vehicle) return null;
      const company = snapshot.companies.find((item) => item.id === vehicle.company);
      const cargo = vehicle.cargo
        ? ` · ${vehicle.cargo.type} ${vehicle.cargo.amount}/${vehicle.cargo.capacity}`
        : '';
      return {
        selection,
        title: `Véhicule #${vehicle.id} — ${VEHICLE_LABELS[vehicle.kind] ?? vehicle.kind}`,
        detail: `${company?.name ?? 'Inconnue'} · ${vehicle.status === 0 ? 'à l’arrêt' : 'en service'} · ${vehicle.speed} tuiles/j${cargo}`,
        colour: companyColour(company?.colour ?? 8),
      };
    }
    case 'town': {
      const town = snapshot.towns.find((item) => item.id === selection.id);
      if (!town) return null;
      return {
        selection,
        title: town.name,
        detail: `${town.population.toLocaleString('fr-FR')} habitants · ${town.buildings} bâtiments · note ${town.rating}`,
        colour: null,
      };
    }
    case 'industry': {
      const industry = snapshot.industries.find((item) => item.id === selection.id);
      if (!industry) return null;
      return {
        selection,
        title: industry.name,
        detail: `Production ${industry.production} · transporté ${industry.transported}`,
        colour: null,
      };
    }
    case 'station': {
      const station = snapshot.stations.find((item) => item.id === selection.id);
      if (!station) return null;
      const waiting = station.waiting.reduce((total, entry) => total + entry.amount, 0);
      return {
        selection,
        title: station.name,
        detail: `${STATION_LABELS[station.kind] ?? station.kind} · ${waiting} unités en attente`,
        colour: null,
      };
    }
    case 'tile': {
      if (!target || target.kind !== 'tile') {
        return { selection, title: 'Tuile', detail: 'Sélectionnée sur la carte', colour: null };
      }
      if (
        !map ||
        target.x < 0 ||
        target.y < 0 ||
        target.x >= map.width ||
        target.y * map.width + target.x >= map.kind.length
      ) {
        return {
          selection,
          title: `Tuile (${target.x}, ${target.y})`,
          detail: 'Carte non chargée',
          colour: null,
        };
      }
      const index = tileIndex(target.x, target.y, map.width);
      const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
      const height = ((map.heightMap[index] ?? 0) * 0.5).toFixed(1);
      return {
        selection,
        title: `Tuile (${target.x}, ${target.y})`,
        detail: `Type ${kind} · hauteur ${height}`,
        colour: null,
      };
    }
    default:
      return null;
  }
}

void bootstrap().catch((error: unknown) => {
  // Dernier filet : le HUD a déjà affiché l'erreur si le bootstrap a pu aller
  // jusqu'à sa création ; sinon on laisse la console parler.
  console.error('[OpenTT3D] échec du démarrage', error);
});
