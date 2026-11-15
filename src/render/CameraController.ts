/**
 * Contrôleur de caméra tycoon.
 *
 * Interactions :
 *  - clic droit ou Alt + clic gauche : orbite (azimut + inclinaison bornée) ;
 *  - clic milieu ou clic gauche glissé : pan dans le plan du sol ;
 *  - molette : zoom vers le curseur ;
 *  - flèches / WASD : pan clavier, Q/E : rotation, +/- : zoom, Home : recadrage ;
 *  - double-clic : recentrage sur le point visé ;
 *  - mode suivi de véhicule via `setFollowTarget()`.
 *
 * La caméra est bornée à la carte et ne passe jamais sous le terrain : la
 * hauteur est échantillonnée via `heightAt`, fourni par le terrain.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, lerpAngle, smoothstep01 } from '../game/interpolation';
import {
  CAMERA_GROUND_CLEARANCE,
  MAX_DISTANCE,
  MIN_DISTANCE,
  TARGET_MARGIN,
  type CameraPose,
  type MapBounds,
  cameraOffset,
  clampDistance,
  clampFov,
  clampPitch,
  clampSpeedMultiplier,
  clampTarget,
  enforceAboveGround,
  groundPointFromNdc,
  keyboardPanStep,
  panBasis,
  screenToNdc,
  wheelZoomFactor,
} from './cameraMath';

export interface CameraControllerOptions {
  camera: THREE.PerspectiveCamera;
  element: HTMLElement;
  bounds: MapBounds;
  heightAt?: (x: number, z: number) => number;
  initialTarget?: { x: number; z: number };
  initialDistance?: number;
  initialYaw?: number;
  initialPitch?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Défilement aux bords de l'écran (désactivé par défaut). */
  edgeScroll?: boolean;
  onClick?: (ndc: { x: number; y: number }) => void;
  onDoubleClick?: (ndc: { x: number; y: number }) => void;
}

/**
 * Mode placement d'un outil (construction). Quand il est actif, le clic gauche
 * et son drag appartiennent à l'outil ; le pan reste disponible au bouton
 * milieu, l'orbite au bouton droit ou Alt + gauche. Un clic droit pendant le
 * drag annule le tracé au lieu de démarrer une orbite.
 */
export interface PlacementHandlers {
  begin(ndc: { x: number; y: number }): void;
  move(ndc: { x: number; y: number }): void;
  end(ndc: { x: number; y: number }): void;
  cancel(): void;
}

interface DragState {
  mode: 'orbit' | 'pan';
  pointerId: number;
  lastX: number;
  lastY: number;
  moved: number;
}

/** Transition douce entre deux cadrages (preset photo, retour de suivi…). */
interface CameraTransition {
  fromTarget: THREE.Vector3;
  fromYaw: number;
  fromPitch: number;
  fromDistance: number;
  fromFov: number;
  toTarget: THREE.Vector3;
  toYaw: number;
  toPitch: number;
  toDistance: number;
  toFov: number;
  elapsed: number;
  duration: number;
}

const KEY_LEFT = new Set(['ArrowLeft', 'KeyA']);
const KEY_RIGHT = new Set(['ArrowRight', 'KeyD']);
const KEY_UP = new Set(['ArrowUp', 'KeyW']);
const KEY_DOWN = new Set(['ArrowDown', 'KeyS']);

/** Bit `MouseEvent.buttons` du bouton droit (gauche = 1, droit = 2). */
const POINTER_BUTTON_RIGHT = 2;

export class CameraController {
  private camera: THREE.PerspectiveCamera;
  private element: HTMLElement;
  private bounds: MapBounds;
  private heightAt: (x: number, z: number) => number;
  private minDistance: number;
  private maxDistance: number;
  private edgeScroll: boolean;

  private pose: CameraPose;
  private currentDistance: number;
  private keys = new Set<string>();
  private drag: DragState | null = null;
  private hoverNdc: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private pointerInside = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private follow: (() => { x: number; z: number } | null) | null = null;
  private followDistance = 16;
  private scratchPosition = new THREE.Vector3();
  private attached = false;
  private fov = 52;
  private speedMultiplier = 1;
  /** Pose imposée par un script (intro cinématique) : prioritaire sur les entrées. */
  private scriptedPose: CameraPose | null = null;
  private transition: CameraTransition | null = null;

  private onClick?: (ndc: { x: number; y: number }) => void;
  private onDoubleClick?: (ndc: { x: number; y: number }) => void;
  private placement: PlacementHandlers | null = null;
  private placementPointerId: number | null = null;

  constructor(options: CameraControllerOptions) {
    this.camera = options.camera;
    this.element = options.element;
    this.bounds = options.bounds;
    this.heightAt = options.heightAt ?? (() => 0);
    this.minDistance = options.minDistance ?? MIN_DISTANCE;
    this.maxDistance = options.maxDistance ?? MAX_DISTANCE;
    this.edgeScroll = options.edgeScroll ?? false;
    this.onClick = options.onClick;
    this.onDoubleClick = options.onDoubleClick;
    const centerX = (options.bounds.minX + options.bounds.maxX) / 2;
    const centerZ = (options.bounds.minZ + options.bounds.maxZ) / 2;
    const span = Math.max(
      options.bounds.maxX - options.bounds.minX,
      options.bounds.maxZ - options.bounds.minZ,
    );
    this.pose = {
      target: new THREE.Vector3(
        options.initialTarget?.x ?? centerX,
        0,
        options.initialTarget?.z ?? centerZ,
      ),
      yaw: options.initialYaw ?? Math.PI * 0.25,
      pitch: clampPitch(options.initialPitch ?? 0.92),
      distance: clampDistance(options.initialDistance ?? Math.min(MAX_DISTANCE * 0.85, span * 1.1)),
    };
    this.currentDistance = this.pose.distance;
    this.fov = clampFov(this.camera.fov);
    this.updateTargetHeight();
    this.update(0);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerUp);
    this.element.addEventListener('pointerleave', this.handlePointerLeave);
    this.element.addEventListener('wheel', this.handleWheel, { passive: false });
    this.element.addEventListener('dblclick', this.handleDoubleClick);
    this.element.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerUp);
    this.element.removeEventListener('pointerleave', this.handlePointerLeave);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.element.removeEventListener('dblclick', this.handleDoubleClick);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.keys.clear();
    this.drag = null;
    this.placementPointerId = null;
  }

  setBounds(bounds: MapBounds): void {
    this.bounds = bounds;
    clampTarget(this.pose.target, this.bounds);
  }

  setHeightSampler(heightAt: (x: number, z: number) => number): void {
    this.heightAt = heightAt;
  }

  setViewLimits(minDistance: number, maxDistance: number): void {
    this.minDistance = minDistance;
    this.maxDistance = Math.max(minDistance, maxDistance);
    this.pose.distance = clampDistance(this.pose.distance);
  }

  getPose(): CameraPose {
    return this.pose;
  }

  getYaw(): number {
    return this.pose.yaw;
  }

  getDistance(): number {
    return this.pose.distance;
  }

  /** Champ de vision courant en degrés. */
  getFov(): number {
    return this.fov;
  }

  /** Applique un FOV borné (30–68°) et met à jour la projection. */
  setFov(fov: number): void {
    const next = clampFov(fov);
    if (Math.abs(next - this.fov) < 1e-4) return;
    this.fov = next;
    this.camera.fov = next;
    this.camera.updateProjectionMatrix();
  }

  /** Multiplicateur des entrées caméra (0,4–2,5). */
  getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  setSpeedMultiplier(value: number): void {
    this.speedMultiplier = clampSpeedMultiplier(value);
  }

  /**
   * Impose une pose (intro cinématique). Tant qu'elle est fournie à chaque
   * frame, les entrées clavier/souris ne déplacent pas la caméra ; `null`
   * rend la main au contrôleur.
   */
  setScriptedPose(pose: CameraPose | null): void {
    this.scriptedPose = pose;
    if (pose) {
      this.transition = null;
      this.currentDistance = pose.distance;
    }
  }

  isScripted(): boolean {
    return this.scriptedPose !== null;
  }

  /** Applique immédiatement une pose complète (sans interpolation). */
  applyPose(
    pose: Pick<CameraPose, 'yaw' | 'pitch' | 'distance'> & { target: THREE.Vector3 },
    options: { fov?: number; immediate?: boolean } = {},
  ): void {
    this.transition = null;
    this.pose.target.copy(pose.target);
    this.pose.yaw = pose.yaw;
    this.pose.pitch = clampPitch(pose.pitch);
    this.pose.distance = clampDistance(pose.distance);
    if (options.fov !== undefined) this.setFov(options.fov);
    if (options.immediate !== false) this.currentDistance = this.pose.distance;
    clampTarget(this.pose.target, this.bounds);
    this.updateTargetHeight();
    this.commit(0);
  }

  /**
   * Transition douce vers un cadrage. La durée nulle (ou une pose identique)
   * applique la pose immédiatement, ce qui sert au respect de
   * `prefers-reduced-motion`.
   */
  transitionTo(
    pose: Pick<CameraPose, 'yaw' | 'pitch' | 'distance'> & { target: THREE.Vector3 },
    options: { fov?: number; seconds?: number } = {},
  ): void {
    const seconds = Math.max(0, options.seconds ?? 0.8);
    if (seconds === 0) {
      this.applyPose(pose, { ...(options.fov !== undefined ? { fov: options.fov } : {}) });
      return;
    }
    this.scriptedPose = null;
    this.follow = null;
    this.transition = {
      fromTarget: this.pose.target.clone(),
      fromYaw: this.pose.yaw,
      fromPitch: this.pose.pitch,
      fromDistance: this.currentDistance,
      fromFov: this.fov,
      toTarget: pose.target.clone(),
      toYaw: pose.yaw,
      toPitch: clampPitch(pose.pitch),
      toDistance: clampDistance(pose.distance),
      toFov: options.fov !== undefined ? clampFov(options.fov) : this.fov,
      elapsed: 0,
      duration: seconds,
    };
  }

  isTransitioning(): boolean {
    return this.transition !== null;
  }

  /** Recentre la vue sur un point du monde. */
  focusOn(x: number, z: number, distance?: number): void {
    this.follow = null;
    this.transition = null;
    this.scriptedPose = null;
    this.pose.target.x = x;
    this.pose.target.z = z;
    clampTarget(this.pose.target, this.bounds);
    this.updateTargetHeight();
    if (distance !== undefined)
      this.pose.distance = clamp(distance, this.minDistance, this.maxDistance);
  }

  /** Suit une cible mobile (véhicule). `null` revient en vue libre. */
  setFollowTarget(provider: (() => { x: number; z: number } | null) | null, distance = 16): void {
    this.follow = provider;
    this.followDistance = clamp(distance, this.minDistance, this.maxDistance);
  }

  /**
   * Active ou coupe le mode placement. Le curseur devient une croix et le clic
   * gauche est réservé à l'outil ; `dispose()` ou `setPlacement(null)` rend le
   * comportement de sélection habituel.
   */
  setPlacement(handlers: PlacementHandlers | null): void {
    this.placement = handlers;
    this.placementPointerId = null;
    this.element.style.cursor = handlers ? 'crosshair' : '';
  }

  isPlacementEnabled(): boolean {
    return this.placement !== null;
  }

  /** Un drag de construction est-il en cours ? */
  isPlacing(): boolean {
    return this.placementPointerId !== null;
  }

  isFollowing(): boolean {
    return this.follow !== null;
  }

  isPointerInside(): boolean {
    return this.pointerInside;
  }

  /** Recadre la carte entière. */
  reset(): void {
    this.follow = null;
    this.transition = null;
    this.scriptedPose = null;
    this.pose.target.set(
      (this.bounds.minX + this.bounds.maxX) / 2,
      0,
      (this.bounds.minZ + this.bounds.maxZ) / 2,
    );
    this.pose.distance = clamp(
      Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxZ - this.bounds.minZ) * 1.05,
      this.minDistance,
      this.maxDistance,
    );
    this.pose.pitch = 0.92;
    this.pose.yaw = Math.PI * 0.25;
    this.currentDistance = this.pose.distance;
    this.updateTargetHeight();
  }

  /** NDC du dernier survol, consommé une fois par frame par le picking. */
  takeHover(): { x: number; y: number } | null {
    if (!this.hoverDirty) return null;
    this.hoverDirty = false;
    return this.hoverNdc;
  }

  /** NDC sous un événement souris (pour le picking immédiat). */
  ndcForEvent(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return screenToNdc(clientX, clientY, rect);
  }

  update(deltaSeconds: number): void {
    const dt = Math.min(deltaSeconds, 0.1);
    if (this.scriptedPose) {
      this.copyScriptedPose();
      this.commit(dt);
      return;
    }
    if (this.transition) {
      this.advanceTransition(dt);
      this.commit(dt);
      return;
    }
    this.applyKeyboardPan(dt);
    this.applyEdgeScroll(dt);

    if (this.follow) {
      const position = this.follow();
      if (position) {
        this.pose.target.x = position.x;
        this.pose.target.z = position.z;
        this.pose.distance = damp(this.pose.distance, this.followDistance, 3.5, dt);
      }
    }

    this.commit(dt);
  }

  /** Recopie la pose imposée en la bornant à la carte. */
  private copyScriptedPose(): void {
    const scripted = this.scriptedPose;
    if (!scripted) return;
    this.pose.target.copy(scripted.target);
    this.pose.yaw = scripted.yaw;
    this.pose.pitch = scripted.pitch;
    this.pose.distance = scripted.distance;
  }

  private advanceTransition(dt: number): void {
    const transition = this.transition;
    if (!transition) return;
    transition.elapsed = Math.min(transition.duration, transition.elapsed + dt);
    const t = smoothstep01(clamp01(transition.elapsed / transition.duration));
    this.pose.target.x = lerp(transition.fromTarget.x, transition.toTarget.x, t);
    this.pose.target.z = lerp(transition.fromTarget.z, transition.toTarget.z, t);
    this.pose.yaw = lerpAngle(transition.fromYaw, transition.toYaw, t);
    this.pose.pitch = lerp(transition.fromPitch, transition.toPitch, t);
    this.pose.distance = lerp(transition.fromDistance, transition.toDistance, t);
    this.setFov(lerp(transition.fromFov, transition.toFov, t));
    if (transition.elapsed >= transition.duration) this.transition = null;
  }

  /** Borne la pose puis place la caméra (partagé par tous les modes). */
  private commit(dt: number): void {
    clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
    this.updateTargetHeight();
    this.pose.yaw = ((this.pose.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this.pose.pitch = clampPitch(this.pose.pitch);
    this.pose.distance = clamp(
      this.pose.distance,
      Math.max(this.minDistance, MIN_DISTANCE),
      this.maxDistance,
    );
    if (this.scriptedPose || this.transition) {
      this.currentDistance = this.pose.distance;
    } else {
      this.currentDistance = damp(this.currentDistance, this.pose.distance, 16, dt);
    }
    this.currentDistance = clamp(this.currentDistance, this.minDistance, this.maxDistance);

    cameraOffset(this.pose.yaw, this.pose.pitch, this.currentDistance, this.scratchPosition).add(
      this.pose.target,
    );
    enforceAboveGround(this.scratchPosition, this.heightAt, CAMERA_GROUND_CLEARANCE);
    this.camera.position.copy(this.scratchPosition);
    this.camera.lookAt(this.pose.target);
  }

  private updateTargetHeight(): void {
    const ground = this.heightAt(this.pose.target.x, this.pose.target.z);
    this.pose.target.y = Math.max(ground, 0);
  }

  private applyKeyboardPan(dt: number): void {
    if (this.keys.size === 0) return;
    const basis = panBasis(this.pose.yaw);
    const step = keyboardPanStep(this.pose.distance, dt) * this.speedMultiplier;
    let forward = 0;
    let right = 0;
    let yawDelta = 0;
    let zoom = 0;
    for (const key of this.keys) {
      if (KEY_UP.has(key)) forward += 1;
      if (KEY_DOWN.has(key)) forward -= 1;
      if (KEY_RIGHT.has(key)) right += 1;
      if (KEY_LEFT.has(key)) right -= 1;
      if (key === 'KeyQ') yawDelta += 1;
      if (key === 'KeyE') yawDelta -= 1;
      if (key === 'Equal' || key === 'NumpadAdd') zoom -= 1;
      if (key === 'Minus' || key === 'NumpadSubtract') zoom += 1;
    }
    if (forward !== 0 || right !== 0) {
      const length = Math.hypot(forward, right) || 1;
      this.pose.target.x += ((basis.forwardX * forward + basis.rightX * right) / length) * step;
      this.pose.target.z += ((basis.forwardZ * forward + basis.rightZ * right) / length) * step;
      this.follow = null;
    }
    if (yawDelta !== 0) this.pose.yaw += yawDelta * 1.5 * dt * this.speedMultiplier;
    if (zoom !== 0)
      this.pose.distance = clampDistance(
        this.pose.distance * (1 + zoom * 0.9 * dt * this.speedMultiplier),
      );
    if (forward !== 0 || right !== 0) clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
  }

  private applyEdgeScroll(dt: number): void {
    if (!this.edgeScroll || this.drag || !this.pointerInside) return;
    const rect = this.element.getBoundingClientRect();
    const margin = 24;
    const x = this.lastPointerX - rect.left;
    const y = this.lastPointerY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const basis = panBasis(this.pose.yaw);
    const step = keyboardPanStep(this.pose.distance, dt) * 0.75 * this.speedMultiplier;
    let dx = 0;
    let dy = 0;
    if (x < margin) dx -= 1;
    if (x > rect.width - margin) dx += 1;
    if (y < margin) dy += 1;
    if (y > rect.height - margin) dy -= 1;
    if (dx === 0 && dy === 0) return;
    this.pose.target.x += basis.rightX * dx * step + basis.forwardX * dy * step;
    this.pose.target.z += basis.rightZ * dx * step + basis.forwardZ * dy * step;
    this.follow = null;
    clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
  }

  private zoomAt(ndc: { x: number; y: number }, factor: number): void {
    const previous = this.pose.distance;
    const next = clampDistance(previous * factor);
    if (Math.abs(next - previous) < 1e-3) return;
    const hit = groundPointFromNdc(ndc, this.camera, this.pose.target.y, new THREE.Vector3());
    if (hit) {
      const amount = clamp(((previous - next) / previous) * 0.85, -0.25, 0.85);
      this.pose.target.x += (hit.x - this.pose.target.x) * amount;
      this.pose.target.z += (hit.z - this.pose.target.z) * amount;
    }
    this.pose.distance = next;
    clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    // Un clic droit pendant un drag de construction annule le tracé ; sans drag
    // actif, il conserve son rôle d'orbite.
    if (event.button === 2 && this.placement && this.placementPointerId !== null) {
      event.preventDefault();
      this.element.releasePointerCapture?.(this.placementPointerId);
      this.placementPointerId = null;
      this.placement.cancel();
      return;
    }

    const orbit = event.button === 2 || (event.button === 0 && event.altKey);
    const pan = event.button === 1 || (event.button === 0 && !event.altKey);
    if (!orbit && !pan) return;

    // Mode placement : le clic gauche appartient à l'outil, sauf si un drag
    // caméra (milieu / droit / Alt) est déjà engagé.
    if (this.placement && !this.drag && event.button === 0 && !event.altKey) {
      event.preventDefault();
      this.placementPointerId = event.pointerId;
      this.follow = null;
      this.transition = null;
      this.element.setPointerCapture?.(event.pointerId);
      this.placement.begin(this.ndcForEvent(event.clientX, event.clientY));
      return;
    }

    event.preventDefault();
    this.transition = null;
    this.drag = {
      mode: orbit ? 'orbit' : 'pan',
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: 0,
    };
    this.follow = null;
    this.element.setPointerCapture?.(event.pointerId);
    this.element.style.cursor = orbit ? 'grabbing' : 'move';
  };

  private handlePointerMove = (event: PointerEvent): void => {
    this.pointerInside = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.hoverNdc = this.ndcForEvent(event.clientX, event.clientY);
    this.hoverDirty = true;

    if (this.placement && this.placementPointerId !== null) {
      // Certains navigateurs (Chrome sous capture de pointeur) signalent un
      // clic droit pendant un drag gauche par un `pointermove` avec
      // `buttons & 2`, pas par un `pointerdown`. On annule donc ici aussi.
      if ((event.buttons & POINTER_BUTTON_RIGHT) !== 0) {
        this.element.releasePointerCapture?.(this.placementPointerId);
        this.placementPointerId = null;
        this.placement.cancel();
        return;
      }
      if (this.placementPointerId === event.pointerId) {
        this.placement.move(this.hoverNdc);
        return;
      }
    }

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.mode === 'orbit') {
      this.pose.yaw -= dx * 0.0062 * this.speedMultiplier;
      this.pose.pitch = clampPitch(this.pose.pitch + dy * 0.0052 * this.speedMultiplier);
    } else {
      const basis = panBasis(this.pose.yaw);
      const scale = this.currentDistance * 0.0017 * this.speedMultiplier;
      this.pose.target.x += basis.forwardX * dy * scale - basis.rightX * dx * scale;
      this.pose.target.z += basis.forwardZ * dy * scale - basis.rightZ * dx * scale;
      clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.placement && this.placementPointerId === event.pointerId) {
      this.element.releasePointerCapture?.(event.pointerId);
      this.placementPointerId = null;
      this.placement.end(this.ndcForEvent(event.clientX, event.clientY));
      return;
    }

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.element.releasePointerCapture?.(event.pointerId);
    this.element.style.cursor = this.placement ? 'crosshair' : '';
    if (drag.mode === 'pan' && drag.moved < 6 && event.button === 0) {
      this.onClick?.(this.ndcForEvent(event.clientX, event.clientY));
    }
    this.drag = null;
  };

  private handlePointerLeave = (): void => {
    this.pointerInside = false;
    this.hoverNdc = null;
    this.hoverDirty = false;
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const ndc = this.ndcForEvent(event.clientX, event.clientY);
    this.follow = null;
    this.transition = null;
    this.zoomAt(ndc, wheelZoomFactor(event.deltaY));
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    // En construction, le double-clic ne doit pas voler le focus caméra.
    if (this.placement) return;
    const ndc = this.ndcForEvent(event.clientX, event.clientY);
    this.onDoubleClick?.(ndc);
  };

  private handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    )
      return;
    if (event.key === 'Home') {
      this.reset();
      return;
    }
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'KeyQ',
      'KeyE',
      'Equal',
      'Minus',
      'NumpadAdd',
      'NumpadSubtract',
    ];
    if (!keys.includes(event.code)) return;
    event.preventDefault();
    this.transition = null;
    this.keys.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private handleBlur = (): void => {
    this.keys.clear();
    this.drag = null;
    if (this.placementPointerId !== null) {
      this.placementPointerId = null;
      this.placement?.cancel();
    }
  };

  dispose(): void {
    this.detach();
    this.placement = null;
    this.follow = null;
    this.transition = null;
    this.scriptedPose = null;
    this.onClick = undefined;
    this.onDoubleClick = undefined;
  }
}
