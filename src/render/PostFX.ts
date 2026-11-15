/**
 * Pipeline de post-processing cinématographique.
 *
 * Ordre des passes :
 *   RenderPass → GTAO (high) → bloom → OutputPass (ACES + sRGB)
 *   → grading/vignette/grain/tilt-shift → FXAA ou SMAA
 *
 * Le composer travaille en HalfFloat linéaire ; `OutputPass` applique le tone
 * mapping ACES et l'encodage sRGB, puis le grading s'exécute en espace
 * d'affichage. En cas d'échec (contexte WebGL limité, allocation refusée), le
 * pipeline se désactive et `Renderer` retombe sur un rendu direct : aucune
 * exception ne remonte dans la boucle de jeu.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
  postFxPasses,
  postFxVisuals,
  resolvePostFxAntialias,
  type PostFxSettings,
  type PostFxVisuals,
} from './postFxConfig';
import { GradeShader } from './shaders/gradeShader';

export interface PostFxContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  settings: PostFxSettings;
  /** Ratio de pixels effectif, connu avant le premier resize. */
  pixelRatio?: number;
}

export type PostFxPassName = 'gtao' | 'bloom' | 'output' | 'grade' | 'antialias';

/** Surface minimale d'un pipeline, injectable dans les tests. */
export interface PostFxPipeline {
  readonly passes: readonly string[];
  readonly warnings: readonly string[];
  render(deltaSeconds: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  setNight(night: number): void;
  /** Debug : coupe une passe sans reconstruire le composer. */
  setPassEnabled?(name: PostFxPassName, enabled: boolean): boolean;
  dispose(): void;
}

export type PostFxPipelineFactory = (context: PostFxContext) => PostFxPipeline;

export interface PostFxOptions extends PostFxContext {
  /** Remplaçable en test pour vérifier le repli sans WebGL. */
  pipelineFactory?: PostFxPipelineFactory;
}

export interface PostFxStatus {
  requested: boolean;
  active: boolean;
  passes: string[];
  warnings: string[];
  fallbackReason: string | null;
  estimatedCostMs: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'erreur inconnue';
}

function requirePositive(value: number, fallback = 1): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Construit le composer réel et ses passes. */
export function createThreePostFxPipeline(context: PostFxContext): PostFxPipeline {
  const { renderer, scene, camera, settings } = context;
  const composer = new EffectComposer(renderer);
  const passes: Pass[] = [];
  const passMap = new Map<PostFxPassName, Pass>();
  const warnings: string[] = [];
  const pixelRatio = Number.isFinite(context.pixelRatio)
    ? Math.max(1, context.pixelRatio ?? 1)
    : renderer.getPixelRatio() || 1;
  const antialiasKind = resolvePostFxAntialias(settings, pixelRatio);
  let visuals: PostFxVisuals = postFxVisuals(settings, 0);
  let time = 0;

  const addPass = (pass: Pass): void => {
    composer.addPass(pass);
    passes.push(pass);
  };

  addPass(new RenderPass(scene, camera));

  let gtao: GTAOPass | null = null;
  if (settings.ambientOcclusion) {
    try {
      gtao = new GTAOPass(scene, camera, 1, 1);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = settings.aoIntensity;
      gtao.updateGtaoMaterial({
        radius: settings.aoRadius,
        distanceExponent: 1.5,
        thickness: 0.5,
        distanceFallOff: 1.2,
        scale: 1,
        samples: settings.aoSamples,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({
        lumaPhi: 10,
        depthPhi: 2,
        normalPhi: 3,
        radius: 4,
        radiusExponent: 1.6,
        rings: 2,
        samples: 8,
      });
      addPass(gtao);
      passMap.set('gtao', gtao);
    } catch (error) {
      gtao?.dispose();
      gtao = null;
      warnings.push(`GTAO désactivé : ${describeError(error)}`);
    }
  }

  let bloom: UnrealBloomPass | null = null;
  if (settings.bloom) {
    try {
      bloom = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        visuals.bloomStrength,
        visuals.bloomRadius,
        visuals.bloomThreshold,
      );
      addPass(bloom);
      passMap.set('bloom', bloom);
    } catch (error) {
      bloom?.dispose();
      bloom = null;
      warnings.push(`Bloom désactivé : ${describeError(error)}`);
    }
  }

  const outputPass = new OutputPass();
  addPass(outputPass);
  passMap.set('output', outputPass);

  let grade: ShaderPass | null = null;
  if (settings.grade) {
    try {
      grade = new ShaderPass(GradeShader);
      const uniforms = grade.uniforms;
      uniforms.vignette!.value = visuals.vignette;
      uniforms.grain!.value = visuals.grain;
      uniforms.saturation!.value = visuals.saturation;
      uniforms.contrast!.value = visuals.contrast;
      uniforms.warmth!.value = visuals.warmth;
      uniforms.splitTone!.value = visuals.splitTone;
      uniforms.tiltShift!.value = visuals.tiltShiftAmount;
      uniforms.tiltFocus!.value = visuals.tiltFocus;
      uniforms.tiltBand!.value = visuals.tiltBand;
      addPass(grade);
      passMap.set('grade', grade);
    } catch (error) {
      grade?.dispose();
      grade = null;
      warnings.push(`Grading désactivé : ${describeError(error)}`);
    }
  }

  let antialiasAdded = false;
  if (antialiasKind === 'fxaa') {
    try {
      const aaPass = new FXAAPass();
      addPass(aaPass);
      passMap.set('antialias', aaPass);
      antialiasAdded = true;
    } catch (error) {
      warnings.push(`FXAA désactivé : ${describeError(error)}`);
    }
  } else if (antialiasKind === 'smaa') {
    try {
      const aaPass = new SMAAPass();
      addPass(aaPass);
      passMap.set('antialias', aaPass);
      antialiasAdded = true;
    } catch (error) {
      warnings.push(`SMAA désactivé : ${describeError(error)}`);
    }
  }

  const pipelinePasses = postFxPasses(settings)
    .map((name) => (name === 'smaa' && antialiasKind === 'fxaa' ? 'fxaa' : name))
    .filter((name) => {
      if (name === 'gtao') return gtao !== null;
      if (name === 'bloom') return bloom !== null;
      if (name === 'grade') return grade !== null;
      if (name === 'fxaa' || name === 'smaa') return antialiasAdded;
      return true;
    });

  const applyVisuals = (next: PostFxVisuals): void => {
    visuals = next;
    if (bloom) {
      bloom.strength = next.bloomStrength;
      bloom.radius = next.bloomRadius;
      bloom.threshold = next.bloomThreshold;
    }
    if (grade) {
      grade.uniforms.vignette!.value = next.vignette;
      grade.uniforms.grain!.value = next.grain;
      grade.uniforms.saturation!.value = next.saturation;
      grade.uniforms.contrast!.value = next.contrast;
      grade.uniforms.warmth!.value = next.warmth;
      grade.uniforms.splitTone!.value = next.splitTone;
      grade.uniforms.tiltShift!.value = next.tiltShiftAmount;
      grade.uniforms.tiltFocus!.value = next.tiltFocus;
      grade.uniforms.tiltBand!.value = next.tiltBand;
    }
  };

  return {
    passes: pipelinePasses,
    warnings,
    render(deltaSeconds: number): void {
      time += Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
      if (grade) grade.uniforms.time!.value = time;
      composer.render(deltaSeconds);
    },
    setSize(width: number, height: number, pixelRatio: number): void {
      const ratio = requirePositive(pixelRatio, renderer.getPixelRatio() || 1);
      composer.setPixelRatio(ratio);
      composer.setSize(requirePositive(width), requirePositive(height));
      const bufferWidth = Math.max(1, Math.floor(requirePositive(width) * ratio));
      const bufferHeight = Math.max(1, Math.floor(requirePositive(height) * ratio));
      if (bloom) {
        bloom.setSize(
          Math.max(1, Math.floor(bufferWidth * settings.bloomResolutionScale)),
          Math.max(1, Math.floor(bufferHeight * settings.bloomResolutionScale)),
        );
      }
      if (gtao) {
        gtao.setSize(
          Math.max(1, Math.floor(bufferWidth * settings.aoResolutionScale)),
          Math.max(1, Math.floor(bufferHeight * settings.aoResolutionScale)),
        );
      }
      if (grade) grade.uniforms.resolution!.value.set(bufferWidth, bufferHeight);
    },
    setNight(night: number): void {
      applyVisuals(postFxVisuals(settings, night));
    },
    setPassEnabled(name: PostFxPassName, enabled: boolean): boolean {
      const pass = passMap.get(name);
      if (!pass) return false;
      pass.enabled = enabled;
      return true;
    },
    dispose(): void {
      for (const pass of passes) pass.dispose();
      composer.dispose();
    },
  };
}

/**
 * Façade résiliente du post-processing.
 *
 * `render()` renvoie `false` si le pipeline est inactif ou vient d'échouer ;
 * `Renderer` fait alors un rendu direct. Le statut expose les passes réelles et
 * la raison du repli pour le debug (`window.__opentt3d.renderer`).
 */
export class PostFX {
  private readonly settings: PostFxSettings;
  private pipeline: PostFxPipeline | null = null;
  private enabled: boolean;
  private fallbackReason: string | null = null;
  private disposed = false;

  constructor(options: PostFxOptions) {
    this.settings = options.settings;
    this.enabled = options.settings.enabled;
    if (!this.enabled) return;
    const factory = options.pipelineFactory ?? createThreePostFxPipeline;
    try {
      this.pipeline = factory({
        renderer: options.renderer,
        scene: options.scene,
        camera: options.camera,
        settings: options.settings,
        pixelRatio: options.pixelRatio,
      });
    } catch (error) {
      this.pipeline = null;
      this.fallbackReason = `post-processing indisponible : ${describeError(error)}`;
    }
  }

  get active(): boolean {
    return this.enabled && this.pipeline !== null && !this.disposed;
  }

  get status(): PostFxStatus {
    const pipeline = this.pipeline;
    return {
      requested: this.settings.enabled,
      active: this.active,
      passes: pipeline ? [...pipeline.passes] : [],
      warnings: pipeline ? [...pipeline.warnings] : [],
      fallbackReason: this.fallbackReason,
      estimatedCostMs: this.settings.estimatedCostMs,
    };
  }

  /** Active/désactive à chaud (debug) sans reconstruire le composer. */
  setEnabled(enabled: boolean): boolean {
    if (this.disposed) return false;
    this.enabled = enabled;
    return this.active;
  }

  toggle(): boolean {
    return this.setEnabled(!this.active);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    if (!this.pipeline) return;
    try {
      this.pipeline.setSize(width, height, pixelRatio);
    } catch (error) {
      this.fail(error);
    }
  }

  setNight(night: number): void {
    if (!this.pipeline) return;
    try {
      this.pipeline.setNight(night);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Debug : coupe une passe (gtao, bloom, output, grade, antialias). */
  setPassEnabled(name: PostFxPassName, enabled: boolean): boolean {
    if (!this.active || !this.pipeline?.setPassEnabled) return false;
    try {
      return this.pipeline.setPassEnabled(name, enabled);
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Renvoie `true` si l'image est passée par le composer. */
  render(deltaSeconds: number): boolean {
    if (!this.active || !this.pipeline) return false;
    try {
      this.pipeline.render(deltaSeconds);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pipeline = this.pipeline;
    this.pipeline = null;
    pipeline?.dispose();
  }

  private fail(error: unknown): void {
    const pipeline = this.pipeline;
    this.pipeline = null;
    this.fallbackReason = `post-processing désactivé à l'exécution : ${describeError(error)}`;
    try {
      pipeline?.dispose();
    } catch {
      // Un dispose qui échoue ne doit pas masquer le repli.
    }
  }
}
