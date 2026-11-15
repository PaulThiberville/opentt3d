/**
 * Socle de rendu Three.js : renderer, scène, caméra, lumières, boucle rAF.
 *
 * La boucle est la seule source de temps du frontend : le delta est borné
 * (0,1 s) et la boucle est suspendue quand l'onglet est masqué. `dispose()`
 * libère le contexte WebGL, les listeners et les ressources de la scène.
 */

import * as THREE from 'three';
import { clamp } from '../game/interpolation';
import {
  detectQuality,
  qualitySettings,
  resolvePixelRatio,
  resolveRenderSize,
  type QualityLevel,
  type QualitySettings,
} from './quality';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityLevel;
  onFrame?: (deltaSeconds: number) => void;
  maxDeltaSeconds?: number;
}

export interface RendererDiagnostics {
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  width: number;
  height: number;
  quality: QualityLevel;
}

export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private canvas: HTMLCanvasElement;
  private qualityLevel: QualityLevel;
  private settings: QualitySettings;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.Fog;
  private running = false;
  private hidden = false;
  private handle: number | null = null;
  private lastTime = 0;
  private maxDelta: number;
  private onFrame?: (deltaSeconds: number) => void;
  private resizeObserver: ResizeObserver | null = null;
  private focus = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private disposed = false;

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    this.onFrame = options.onFrame;
    this.maxDelta = Math.max(0.01, options.maxDeltaSeconds ?? 0.1);

    const guessed = options.quality ?? detectQuality(
      typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency,
    );
    this.qualityLevel = guessed;
    this.settings = qualitySettings(guessed);

    this.webgl = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: this.settings.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.02;
    this.webgl.shadowMap.enabled = this.settings.shadows;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x9dc3dc);
    this.fog = new THREE.Fog(0x9dc3dc, this.settings.fogNear, this.settings.drawDistance);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(
      52,
      1,
      0.4,
      this.settings.drawDistance,
    );
    this.camera.position.set(0, 60, 60);
    this.camera.lookAt(0, 0, 0);

    this.hemi = new THREE.HemisphereLight(0xe6f2ff, 0x38412f, this.settings.ambientLight);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0cf, 2.35);
    this.sun.position.set(60, 120, 45);
    this.sun.castShadow = this.settings.shadows;
    this.sun.shadow.mapSize.set(this.settings.shadowMapSize, this.settings.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.camera.left = -80;
    this.sun.shadow.camera.right = 80;
    this.sun.shadow.camera.top = 80;
    this.sun.shadow.camera.bottom = -80;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.5;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.resize();
    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
  }

  get quality(): QualityLevel {
    return this.qualityLevel;
  }

  get settingsSnapshot(): QualitySettings {
    return this.settings;
  }

  /** Applique un preset. L'antialiasing reste celui du contexte créé. */
  setQuality(level: QualityLevel): void {
    this.qualityLevel = level;
    this.settings = qualitySettings(level);
    this.webgl.shadowMap.enabled = this.settings.shadows;
    this.sun.castShadow = this.settings.shadows;
    this.sun.shadow.mapSize.set(this.settings.shadowMapSize, this.settings.shadowMapSize);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.hemi.intensity = this.settings.ambientLight;
    this.fog.near = this.settings.fogNear;
    this.fog.far = this.settings.drawDistance;
    this.camera.far = this.settings.drawDistance;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  start(onFrame?: (deltaSeconds: number) => void): void {
    if (this.running || this.disposed) return;
    if (onFrame) this.onFrame = onFrame;
    this.running = true;
    this.lastTime = performance.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  /** Force un rendu (utile pour l'écran de chargement). */
  renderNow(): void {
    this.render();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = rect.width || window.innerWidth;
    const cssHeight = rect.height || window.innerHeight;
    const size = resolveRenderSize(cssWidth, cssHeight, this.qualityLevel, window.devicePixelRatio);
    this.webgl.setPixelRatio(size.pixelRatio);
    this.webgl.setSize(size.width, size.height, false);
    this.camera.aspect = size.width / Math.max(1, size.height);
    this.camera.updateProjectionMatrix();
  }

  diagnostics(): RendererDiagnostics {
    const size = new THREE.Vector2();
    this.webgl.getSize(size);
    return {
      drawCalls: this.webgl.info.render.calls,
      triangles: this.webgl.info.render.triangles,
      pixelRatio: resolvePixelRatio(this.qualityLevel, window.devicePixelRatio),
      width: Math.round(size.x),
      height: Math.round(size.y),
      quality: this.qualityLevel,
    };
  }

  private schedule(): void {
    if (this.handle !== null) return;
    this.handle = requestAnimationFrame(this.frame);
  }

  private frame = (time: number): void => {
    this.handle = null;
    if (!this.running) return;
    const rawDelta = (time - this.lastTime) / 1000;
    this.lastTime = time;
    const delta = clamp(Number.isFinite(rawDelta) ? rawDelta : 0, 0, this.maxDelta);
    this.onFrame?.(delta);
    this.render();
    this.schedule();
  };

  private render(): void {
    if (this.settings.shadows) {
      this.camera.getWorldDirection(this.forward);
      this.focus.copy(this.camera.position).addScaledVector(this.forward, 45);
      this.sun.position.set(this.focus.x + 55, this.focus.y + 110, this.focus.z + 40);
      this.sun.target.position.copy(this.focus);
      this.sun.target.updateMatrixWorld();
      this.sun.shadow.camera.updateProjectionMatrix();
    }
    this.webgl.render(this.scene, this.camera);
  }

  private handleResize = (): void => {
    this.resize();
  };

  /** Pause complète quand l'onglet est masqué, reprise sans delta géant. */
  private handleVisibility = (): void => {
    if (document.hidden) {
      this.hidden = true;
      if (this.handle !== null) {
        cancelAnimationFrame(this.handle);
        this.handle = null;
      }
    } else if (this.hidden) {
      this.hidden = false;
      this.lastTime = performance.now();
      if (this.running) this.schedule();
    }
  };

  /** Test de disponibilité WebGL sans instancier le renderer. */
  static isWebGLAvailable(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scene.remove(this.sun);
    this.scene.remove(this.sun.target);
    this.scene.remove(this.hemi);
    this.sun.shadow.map?.dispose();
    this.webgl.dispose();
    this.scene.clear();
  }
}
