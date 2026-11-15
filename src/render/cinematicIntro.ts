/**
 * Intro cinématique de début de partie : survol doux de la carte.
 *
 * Le module est volontairement pur (aucun DOM, aucun Three.js) : il produit des
 * poses de caméra bornées que `CameraController.setScriptedPose()` applique.
 * `GameSession` décide du moment, du skip et du respect de
 * `prefers-reduced-motion`.
 *
 * Trajectoire : orbite lente autour du centre de la carte, en s'éloignant puis
 * en se rapprochant du sol, avec un léger glissement vers les premiers points
 * d'intérêt (villes, gares) pour éviter un simple zoom statique. Trois à cinq
 * secondes, coupable au clic ou à la touche.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep01 } from '../game/interpolation';
import {
  clampDistance,
  clampPitch,
  clampTarget,
  type CameraPose,
  type MapBounds,
} from './cameraMath';

export interface IntroAnchor {
  x: number;
  z: number;
}

export interface CinematicIntroOptions {
  bounds: MapBounds;
  /** Durée en secondes, bornée à [3, 5] pour rester une intro. */
  durationSeconds?: number;
  /** Points d'intérêt traversés (villes, gares…) ; le centre par défaut. */
  anchors?: IntroAnchor[];
  /** Aucune animation : l'intro est terminée dès sa construction. */
  reducedMotion?: boolean;
  /** Azimut de départ ; la caméra balaie ensuite 0,75 rad. */
  startYaw?: number;
}

export const MIN_INTRO_SECONDS = 3;
export const MAX_INTRO_SECONDS = 5;
export const DEFAULT_INTRO_SECONDS = 4.2;

export function clampIntroDuration(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_INTRO_SECONDS;
  return clamp(seconds, MIN_INTRO_SECONDS, MAX_INTRO_SECONDS);
}

/** Poses intermédiaires et finale de l'intro, entièrement bornées. */
export class CinematicIntro {
  readonly duration: number;
  private bounds: MapBounds;
  private anchors: IntroAnchor[];
  private startYaw: number;
  private elapsed = 0;
  private done = false;

  constructor(options: CinematicIntroOptions) {
    this.bounds = options.bounds;
    this.anchors =
      options.anchors && options.anchors.length > 0 ? options.anchors : [this.center()];
    this.duration = clampIntroDuration(options.durationSeconds);
    this.startYaw = options.startYaw ?? Math.PI * 0.18;
    if (options.reducedMotion) {
      this.elapsed = this.duration;
      this.done = true;
    }
  }

  get progress(): number {
    return clamp01(this.elapsed / this.duration);
  }

  get finished(): boolean {
    return this.done;
  }

  /**
   * Avance l'intro. Renvoie la pose à appliquer, ou `null` quand elle est
   * terminée : l'appelant récupère alors `finishPose()` pour le raccord.
   */
  update(deltaSeconds: number): CameraPose | null {
    if (this.done) return null;
    const dt = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    if (this.elapsed >= this.duration) {
      this.done = true;
      return null;
    }
    return this.poseAt(this.progress);
  }

  /** Termine immédiatement (clic, touche, réglage désactivé). */
  skip(): void {
    this.elapsed = this.duration;
    this.done = true;
  }

  /** Dernière pose de l'intro, identique à la pose de raccord. */
  finishPose(): CameraPose {
    return this.poseAt(1);
  }

  private poseAt(progress: number): CameraPose {
    const eased = smoothstep01(progress);
    const span = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxZ - this.bounds.minZ);
    const center = this.center();
    const focus = this.focusAt(eased);
    const target = new THREE.Vector3(
      lerp(center.x, focus.x, 0.45),
      0,
      lerp(center.z, focus.z, 0.45),
    );
    clampTarget(target, this.bounds);
    const yaw = this.startYaw + 0.75 * eased;
    const pitch = clampPitch(0.62 + 0.28 * eased);
    const distance = clampDistance(lerp(span * 1.35, span * 0.82, eased));
    return { target, yaw, pitch, distance };
  }

  /** Point d'intérêt courant : glissement linéaire le long des ancres. */
  private focusAt(t: number): IntroAnchor {
    if (this.anchors.length === 1) return this.anchors[0]!;
    const scaled = t * (this.anchors.length - 1);
    const index = Math.min(this.anchors.length - 2, Math.floor(scaled));
    const local = scaled - index;
    const from = this.anchors[index]!;
    const to = this.anchors[index + 1]!;
    return { x: lerp(from.x, to.x, local), z: lerp(from.z, to.z, local) };
  }

  private center(): IntroAnchor {
    return {
      x: (this.bounds.minX + this.bounds.maxX) / 2,
      z: (this.bounds.minZ + this.bounds.maxZ) / 2,
    };
  }
}
