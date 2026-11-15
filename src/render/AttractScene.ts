/**
 * Simulation d'attraction derrière les menus.
 *
 * Une partie mock autonome (IA, villes, industries, véhicules) tourne dans un
 * canvas dédié sous l'interface. Elle n'a ni HUD, ni entrées, ni audio : elle
 * sert uniquement de fond vivant au menu principal, comme une démo de salon.
 *
 * Le canvas est créé puis détruit à chaque cycle menu → partie → menu : cela
 * évite de réutiliser un contexte WebGL déjà libéré par la session de jeu.
 * Rendu à ~30 fps (15 fps sous une modale floutée), qualité moyenne.
 */

import * as THREE from 'three';
import { Game } from '../game/Game';
import { MockEngine } from '../engine/MockEngine';
import type { WorldSnapshot } from '../engine/protocol';
import { Renderer } from './Renderer';
import { WorldView } from './WorldView';
import { detectQuality, type QualityLevel } from './quality';

export interface AttractSceneOptions {
  /** Qualité de rendu ; par défaut, dérivée du matériel. */
  quality?: QualityLevel;
  /** Taille de carte de la démo. */
  size?: number;
  seed?: number;
}

const ACTIVE_FPS = 30;
const BACKDROP_FPS = 15;
const CYCLE_SECONDS = 300;

export class AttractScene {
  private options: AttractSceneOptions;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: Renderer | null = null;
  private world: WorldView | null = null;
  private game: Game | null = null;
  private raf: number | null = null;
  private lastFrame = 0;
  private lastSequence = -1;
  private disposed = false;
  private backdrop = false;
  private running = false;

  private focusX = 0;
  private focusZ = 0;
  private focusY = 0;
  private orbit = 0;
  private hasFocus = false;
  private readonly lookTarget = new THREE.Vector3();
  private readonly viewDirection = new THREE.Vector3();
  private readonly rightVector = new THREE.Vector3();

  constructor(options: AttractSceneOptions = {}) {
    this.options = { ...options };
  }

  get canvasElement(): HTMLCanvasElement | null {
    return this.canvas;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Démarre la démo ; à attendre avant de montrer le menu si l'on veut le fond tout de suite. */
  async start(): Promise<void> {
    if (this.running || this.disposed) return;
    const quality =
      this.options.quality ??
      detectQuality(
        typeof window === 'undefined' ? 1 : window.devicePixelRatio,
        typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency,
      );
    const canvas = document.createElement('canvas');
    canvas.className = 'menu-scene';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    this.canvas = canvas;
    document.body.classList.add('menu-attract');

    try {
      const renderer = new Renderer({ canvas, quality });
      this.renderer = renderer;

      const engine = new MockEngine();
      await engine.init({ moduleUrl: 'mock://engine' });
      if (this.disposed) return;
      await engine.newGame({
        seed: this.options.seed ?? (Math.random() * 2 ** 31) | 0,
        width: this.options.size ?? 128,
        height: this.options.size ?? 128,
        aiCompanies: 3,
        difficulty: 1,
        startYear: 1960,
      });
      if (this.disposed) return;

      const game = new Game({ driver: engine, snapshotRate: 5 });
      this.game = game;
      game.start();

      const world = new WorldView({
        scene: renderer.scene,
        camera: renderer.camera,
        canvas,
        quality,
        timeOfDay: renderer,
        dayNight: { enabled: true, cycleSeconds: CYCLE_SECONDS },
      });
      this.world = world;
      world.setDayNightCycle(true, CYCLE_SECONDS);

      const snapshot = game.getLatestSnapshot();
      if (snapshot) this.applySnapshot(snapshot);
      // Lumière dorée de fin de matinée : la démo met les volumes en valeur.
      world.setDayNightPhase(0.42);

      this.running = true;
      this.lastFrame = 0;
      this.raf = requestAnimationFrame(this.frame);
      this.renderFrame(0);
      canvas.classList.add('is-ready');
    } catch (error) {
      console.warn('[attract] la démo de fond n’a pas démarré', error);
      this.dispose();
    }
  }

  /** Sous une modale, la démo passe à 15 fps (le flou coûte déjà cher). */
  setBackdrop(active: boolean): void {
    this.backdrop = active;
  }

  private applySnapshot(snapshot: WorldSnapshot): void {
    if (!this.world || this.lastSequence === snapshot.meta.sequence) return;
    this.lastSequence = snapshot.meta.sequence;
    this.world.applySnapshot(snapshot);

    if (!this.hasFocus) {
      const featured = [...snapshot.towns].sort((a, b) => b.population - a.population)[0];
      const map = snapshot.map;
      const x = featured?.x ?? (map ? map.width / 2 : (snapshot.towns[0]?.x ?? 64));
      const z = featured?.y ?? (map ? map.height / 2 : (snapshot.towns[0]?.y ?? 64));
      this.focusX = x;
      this.focusZ = z;
      this.focusY = this.world.terrain.heightAt(x, z);
      this.hasFocus = true;
    }
  }

  private frame = (now: number): void => {
    if (this.disposed || !this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const minDelay = 1000 / (this.backdrop ? BACKDROP_FPS : ACTIVE_FPS);
    if (this.lastFrame !== 0 && now - this.lastFrame < minDelay) return;
    const delta = this.lastFrame === 0 ? 0 : Math.min(0.12, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.renderFrame(delta);
  };

  private renderFrame(delta: number): void {
    const game = this.game;
    const world = this.world;
    const renderer = this.renderer;
    if (!game || !world || !renderer) return;
    try {
      if (delta > 0) game.advance(delta);
      const snapshot = game.getLatestSnapshot();
      if (snapshot) this.applySnapshot(snapshot);
      // Lumière dorée de fin de matinée : la démo met les volumes en valeur.
      world.setDayNightPhase(0.42);
      world.update(delta, game.getInterpolation());
      this.updateCamera(delta, renderer);
      renderer.renderNow();
    } catch (error) {
      console.warn('[attract] erreur de rendu, arrêt de la démo', error);
      this.dispose();
    }
  }

  /** Orbite lente autour de la ville principale, avec léger mouvement vertical. */
  private updateCamera(delta: number, renderer: Renderer): void {
    this.orbit += delta * 0.045;
    const camera = renderer.camera;
    camera.position.copy(
      attractOrbitPosition({ x: this.focusX, y: this.focusY, z: this.focusZ }, this.orbit),
    );
    camera.lookAt(this.focusX, this.focusY + 3.5, this.focusZ);
    if (camera.isPerspectiveCamera) {
      const targetFov = 46;
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, delta * 2);
        camera.updateProjectionMatrix();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.world?.dispose();
    this.world = null;
    this.game?.dispose();
    this.game = null;
    this.renderer?.dispose();
    this.renderer = null;
    const canvas = this.canvas;
    if (canvas) {
      // Libère tout de suite le contexte : les menus peuvent être ouverts et
      // quittés plusieurs fois, on ne veut pas empiler les contextes WebGL.
      try {
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // Le contexte est peut-être déjà perdu : rien à faire.
      }
      canvas.remove();
    }
    this.canvas = null;
    document.body.classList.remove('menu-attract');
  }
}

/** Petit utilitaire de cadrage partagé avec les tests. */
export function attractOrbitPosition(
  focus: { x: number; y: number; z: number },
  orbit: number,
): THREE.Vector3 {
  const radius = 31 + Math.sin(orbit * 0.23) * 6;
  const height = 14 + Math.sin(orbit * 0.31) * 3;
  return new THREE.Vector3(
    focus.x + Math.cos(orbit) * radius,
    focus.y + height,
    focus.z + Math.sin(orbit) * radius,
  );
}
