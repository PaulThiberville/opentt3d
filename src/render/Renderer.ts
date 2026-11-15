/**
 * Socle de rendu Three.js : renderer, scène, caméra, lumières, boucle rAF.
 *
 * La boucle est la seule source de temps du frontend : le delta est borné
 * (0,1 s) et la boucle est suspendue quand l'onglet est masqué. `dispose()`
 * libère le contexte WebGL, les listeners et les ressources de la scène.
 */

import * as THREE from 'three';
import { clamp } from '../game/interpolation';
import { Prng } from '../game/prng';
import { approachPhase, sunState, wrap01, type SunState } from './dayNight';
import { PostFX, type PostFxPassName, type PostFxStatus } from './PostFX';
import { postFxSettings } from './postFxConfig';
import {
  detectQuality,
  qualitySettings,
  resolvePixelRatio,
  resolveRenderSize,
  resolveShadowFrustum,
  type QualityLevel,
  type QualitySettings,
} from './quality';

const STAR_COUNT = 520;
const STAR_RADIUS = 240;
const MOON_RADIUS = 220;
const SUN_DISTANCE = 180;

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
  postFx: PostFxStatus;
}

export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private canvas: HTMLCanvasElement;
  private qualityLevel: QualityLevel;
  private settings: QualitySettings;
  private sun: THREE.DirectionalLight;
  private moon: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.Fog;
  private skyColor = new THREE.Color(0x9dc3dc);
  private stars: THREE.Points;
  private starMaterial: THREE.PointsMaterial;
  private moonDisc: THREE.Mesh;
  private moonDiscMaterial: THREE.MeshBasicMaterial;
  private phase = 0.35;
  private targetPhase = 0.35;
  private dayState: SunState = sunState(0.35);
  private sunDirection = new THREE.Vector3(0, 1, 0);
  private moonDirection = new THREE.Vector3(0, 1, 0);
  private running = false;
  private hidden = false;
  private handle: number | null = null;
  private lastTime = 0;
  private maxDelta: number;
  private onFrame?: (deltaSeconds: number) => void;
  private resizeObserver: ResizeObserver | null = null;
  private focus = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private postfx: PostFX | null = null;
  private lastPostFxNight = -1;
  private shadowFrustumRadius = 0;
  private disposed = false;

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    this.onFrame = options.onFrame;
    this.maxDelta = Math.max(0.01, options.maxDeltaSeconds ?? 0.1);

    const guessed =
      options.quality ??
      detectQuality(
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
    // `PCFSoftShadowMap` a été retiré de Three ; PCF + radius donne une ombre
    // douce équivalente sans avertissement console.
    this.webgl.shadowMap.enabled = this.settings.shadows;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    // Les diagnostics cumulent toutes les passes de la frame (scène, ombres,
    // post-processing) : `reset()` est appelé au début de chaque rendu.
    this.webgl.info.autoReset = false;

    this.scene.background = new THREE.Color(0x9dc3dc);
    this.fog = new THREE.Fog(0x9dc3dc, this.settings.fogNear, this.settings.drawDistance);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.4, this.settings.drawDistance);
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
    this.sun.shadow.bias = this.settings.shadowBias;
    this.sun.shadow.normalBias = this.settings.shadowNormalBias;
    this.sun.shadow.radius = this.settings.shadowRadius;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.applyShadowSettings();

    this.moon = new THREE.DirectionalLight(0x9fb6e8, 0);
    this.moon.castShadow = false;
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const starRng = new Prng(0x51a7c0de);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const theta = starRng.float(0, Math.PI * 2);
      const y = starRng.float(0.06, 1);
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      starPositions[i * 3] = Math.cos(theta) * ring * STAR_RADIUS;
      starPositions[i * 3 + 1] = y * STAR_RADIUS;
      starPositions[i * 3 + 2] = Math.sin(theta) * ring * STAR_RADIUS;
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xdfe8ff,
      size: 2.1,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.name = 'stars';
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -2;
    this.stars.visible = false;
    this.scene.add(this.stars);

    const moonGeometry = new THREE.CircleGeometry(4.4, 24);
    this.moonDiscMaterial = new THREE.MeshBasicMaterial({
      color: 0xe8eeff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.moonDisc = new THREE.Mesh(moonGeometry, this.moonDiscMaterial);
    this.moonDisc.name = 'moon';
    this.moonDisc.frustumCulled = false;
    this.moonDisc.renderOrder = -1;
    this.moonDisc.visible = false;
    this.scene.add(this.moonDisc);

    this.applyDayNightState();
    this.postfx = this.createPostFx();

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

  /**
   * Phase normalisée du jour (0 = minuit, 0,25 = lever, 0,5 = midi).
   * Le rendu lisse les sauts de snapshot pour éviter tout clignotement ;
   * `immediate` force la phase (captures, chargement, tests).
   */
  setTimeOfDay(fraction: number, immediate = false): void {
    if (!Number.isFinite(fraction)) return;
    this.targetPhase = wrap01(fraction);
    if (immediate) {
      this.phase = this.targetPhase;
      this.dayState = sunState(this.phase);
      this.applyDayNightState();
    }
  }

  getTimeOfDay(): number {
    return this.phase;
  }

  /** 0 = jour, 1 = nuit profonde (phase lissée). */
  get nightAmount(): number {
    return this.dayState.night;
  }

  get sunStateSnapshot(): SunState {
    return this.dayState;
  }

  /** Applique un preset. L'antialiasing reste celui du contexte créé. */
  setQuality(level: QualityLevel): void {
    this.qualityLevel = level;
    this.settings = qualitySettings(level);
    this.applyShadowSettings();
    this.hemi.intensity = this.settings.ambientLight;
    this.fog.near = this.settings.fogNear;
    this.fog.far = this.settings.drawDistance;
    this.camera.far = this.settings.drawDistance;
    this.camera.updateProjectionMatrix();
    this.postfx?.dispose();
    this.postfx = this.createPostFx();
    this.lastPostFxNight = -1;
    this.applyDayNightState();
    this.resize();
  }

  /** Statut du post-processing (passes actives, repli éventuel). */
  get postFxStatus(): PostFxStatus {
    return (
      this.postfx?.status ?? {
        requested: false,
        active: false,
        passes: [],
        warnings: [],
        fallbackReason: null,
        estimatedCostMs: 0,
      }
    );
  }

  get postFxActive(): boolean {
    return this.postfx?.active ?? false;
  }

  /**
   * Active/désactive le composer à chaud (debug). En `low`, aucun pipeline
   * n'existe : la méthode reste sans effet et renvoie `false`.
   */
  setPostProcessing(enabled: boolean): boolean {
    return this.postfx?.setEnabled(enabled) ?? false;
  }

  togglePostProcessing(): boolean {
    return this.postfx?.toggle() ?? false;
  }

  /** Debug : coupe une passe du composer sans changer de preset. */
  setPostFxPass(name: PostFxPassName, enabled: boolean): boolean {
    return this.postfx?.setPassEnabled(name, enabled) ?? false;
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
    this.postfx?.setSize(size.width, size.height, size.pixelRatio);
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
      postFx: this.postFxStatus,
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
    this.render(delta);
    this.schedule();
  };

  private render(deltaSeconds = 0): void {
    this.phase = approachPhase(this.phase, this.targetPhase, deltaSeconds, 0.16);
    this.dayState = sunState(this.phase);
    this.applyDayNightState();
    this.updateCelestialPositions();
    this.webgl.info.reset();
    if (!this.postfx?.render(deltaSeconds)) {
      this.webgl.render(this.scene, this.camera);
    }
  }

  /** Couleurs, intensités et éléments de ciel pour la phase courante. */
  private applyDayNightState(): void {
    const state = this.dayState;
    this.sun.color.setHex(state.colour);
    this.sun.intensity = state.intensity;
    this.sun.castShadow = this.settings.shadows && state.intensity > 0.06;
    this.moon.intensity = state.moonIntensity;
    this.hemi.color.setHex(state.hemiSky);
    this.hemi.groundColor.setHex(state.hemiGround);
    this.hemi.intensity = this.settings.ambientLight * state.ambient;
    this.skyColor.setHex(state.skyColour);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.skyColor);
    } else {
      this.scene.background = this.skyColor.clone();
    }
    this.fog.color.setHex(state.fogColour);
    this.webgl.toneMappingExposure = 1.12 - 0.1 * state.daylight;

    const showSky = this.settings.nightSky;
    this.stars.visible = showSky && state.starOpacity > 0.02;
    this.starMaterial.opacity = state.starOpacity * 0.9;
    this.moonDisc.visible = showSky && state.night > 0.12;
    this.moonDiscMaterial.opacity = Math.min(1, state.night * 0.95);

    if (this.postfx && Math.abs(state.night - this.lastPostFxNight) > 0.002) {
      this.lastPostFxNight = state.night;
      this.postfx.setNight(state.night);
    }
  }

  /** Soleil, lune et étoiles suivent la caméra et le point visé. */
  private updateCelestialPositions(): void {
    const state = this.dayState;
    this.camera.getWorldDirection(this.forward);
    this.focus.copy(this.camera.position).addScaledVector(this.forward, 45);

    this.sunDirection
      .set(state.direction.x, Math.max(0.06, state.direction.y), state.direction.z)
      .normalize();
    this.sun.position.copy(this.focus).addScaledVector(this.sunDirection, SUN_DISTANCE);
    this.sun.target.position.copy(this.focus);
    this.sun.target.updateMatrixWorld();
    this.updateShadowFrustum();

    this.moonDirection
      .set(-state.direction.x, Math.max(0.15, -state.direction.y), -state.direction.z)
      .normalize();
    this.moon.position.copy(this.focus).addScaledVector(this.moonDirection, SUN_DISTANCE);
    this.moon.target.position.copy(this.focus);
    this.moon.target.updateMatrixWorld();

    this.stars.position.copy(this.camera.position);
    this.stars.rotation.y = this.phase * Math.PI * 2;
    this.moonDisc.position
      .copy(this.camera.position)
      .addScaledVector(this.moonDirection, MOON_RADIUS);
    this.moonDisc.lookAt(this.camera.position);
  }

  private createPostFx(): PostFX | null {
    try {
      return new PostFX({
        renderer: this.webgl,
        scene: this.scene,
        camera: this.camera,
        settings: postFxSettings(this.qualityLevel),
        pixelRatio: resolvePixelRatio(
          this.qualityLevel,
          typeof window === 'undefined' ? 1 : window.devicePixelRatio,
        ),
      });
    } catch (error) {
      console.warn('[OpenTT3D] Post-processing désactivé :', error);
      return null;
    }
  }

  /** Applique la configuration d'ombre du preset (PCF doux, budget borné). */
  private applyShadowSettings(): void {
    const settings = this.settings;
    this.webgl.shadowMap.enabled = settings.shadows;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = settings.shadows;
    this.sun.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    this.sun.shadow.bias = settings.shadowBias;
    this.sun.shadow.normalBias = settings.shadowNormalBias;
    this.sun.shadow.radius = settings.shadowRadius;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.camera.left = -settings.shadowFrustum;
    this.sun.shadow.camera.right = settings.shadowFrustum;
    this.sun.shadow.camera.top = settings.shadowFrustum;
    this.sun.shadow.camera.bottom = -settings.shadowFrustum;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.shadowFrustumRadius = 0;
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
  }

  /**
   * Une cascade unique ajustée à la distance de la caméra : le frustum d'ombre
   * s'élargit quand on dézoome, ce qui garde des texels exploitables sans
   * payer deux passes de profondeur.
   */
  private updateShadowFrustum(): void {
    if (!this.settings.shadows) return;
    const distance = this.camera.position.distanceTo(this.focus);
    const radius = resolveShadowFrustum(this.settings.shadowFrustum, distance);
    if (Math.abs(radius - this.shadowFrustumRadius) < 0.5) return;
    this.shadowFrustumRadius = radius;
    const camera = this.sun.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.updateProjectionMatrix();
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
    this.postfx?.dispose();
    this.postfx = null;
    this.scene.remove(this.sun);
    this.scene.remove(this.sun.target);
    this.scene.remove(this.moon);
    this.scene.remove(this.moon.target);
    this.scene.remove(this.stars);
    this.scene.remove(this.moonDisc);
    this.scene.remove(this.hemi);
    this.sun.shadow.map?.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.moonDisc.geometry.dispose();
    this.moonDiscMaterial.dispose();
    this.webgl.dispose();
    this.scene.clear();
  }
}
