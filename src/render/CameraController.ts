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
import { clamp, damp } from '../game/interpolation';
import {
  CAMERA_GROUND_CLEARANCE,
  MAX_DISTANCE,
  MIN_DISTANCE,
  TARGET_MARGIN,
  type CameraPose,
  type MapBounds,
  cameraOffset,
  clampDistance,
  clampPitch,
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

interface DragState {
  mode: 'orbit' | 'pan';
  pointerId: number;
  lastX: number;
  lastY: number;
  moved: number;
}

const KEY_LEFT = new Set(['ArrowLeft', 'KeyA']);
const KEY_RIGHT = new Set(['ArrowRight', 'KeyD']);
const KEY_UP = new Set(['ArrowUp', 'KeyW']);
const KEY_DOWN = new Set(['ArrowDown', 'KeyS']);

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

  private onClick?: (ndc: { x: number; y: number }) => void;
  private onDoubleClick?: (ndc: { x: number; y: number }) => void;

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
    const span = Math.max(options.bounds.maxX - options.bounds.minX, options.bounds.maxZ - options.bounds.minZ);
    this.pose = {
      target: new THREE.Vector3(options.initialTarget?.x ?? centerX, 0, options.initialTarget?.z ?? centerZ),
      yaw: options.initialYaw ?? Math.PI * 0.25,
      pitch: clampPitch(options.initialPitch ?? 0.92),
      distance: clampDistance(options.initialDistance ?? Math.min(MAX_DISTANCE * 0.85, span * 1.1)),
    };
    this.currentDistance = this.pose.distance;
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

  /** Recentre la vue sur un point du monde. */
  focusOn(x: number, z: number, distance?: number): void {
    this.follow = null;
    this.pose.target.x = x;
    this.pose.target.z = z;
    clampTarget(this.pose.target, this.bounds);
    this.updateTargetHeight();
    if (distance !== undefined) this.pose.distance = clamp(distance, this.minDistance, this.maxDistance);
  }

  /** Suit une cible mobile (véhicule). `null` revient en vue libre. */
  setFollowTarget(provider: (() => { x: number; z: number } | null) | null, distance = 16): void {
    this.follow = provider;
    this.followDistance = clamp(distance, this.minDistance, this.maxDistance);
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

    clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
    this.updateTargetHeight();
    this.pose.yaw = ((this.pose.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this.pose.pitch = clampPitch(this.pose.pitch);
    this.pose.distance = clamp(this.pose.distance, Math.max(this.minDistance, MIN_DISTANCE), this.maxDistance);
    this.currentDistance = damp(this.currentDistance, this.pose.distance, 16, dt);
    this.currentDistance = clamp(this.currentDistance, this.minDistance, this.maxDistance);

    cameraOffset(this.pose.yaw, this.pose.pitch, this.currentDistance, this.scratchPosition).add(this.pose.target);
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
    const step = keyboardPanStep(this.pose.distance, dt);
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
    if (yawDelta !== 0) this.pose.yaw += yawDelta * 1.5 * dt;
    if (zoom !== 0) this.pose.distance = clampDistance(this.pose.distance * (1 + zoom * 0.9 * dt));
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
    const step = keyboardPanStep(this.pose.distance, dt) * 0.75;
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
    const orbit = event.button === 2 || (event.button === 0 && event.altKey);
    const pan = event.button === 1 || (event.button === 0 && !event.altKey);
    if (!orbit && !pan) return;
    event.preventDefault();
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

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.mode === 'orbit') {
      this.pose.yaw -= dx * 0.0062;
      this.pose.pitch = clampPitch(this.pose.pitch + dy * 0.0052);
    } else {
      const basis = panBasis(this.pose.yaw);
      const scale = this.currentDistance * 0.0017;
      this.pose.target.x += basis.forwardX * dy * scale - basis.rightX * dx * scale;
      this.pose.target.z += basis.forwardZ * dy * scale - basis.rightZ * dx * scale;
      clampTarget(this.pose.target, this.bounds, TARGET_MARGIN);
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.element.releasePointerCapture?.(event.pointerId);
    this.element.style.cursor = '';
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
    this.zoomAt(ndc, wheelZoomFactor(event.deltaY));
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    const ndc = this.ndcForEvent(event.clientX, event.clientY);
    this.onDoubleClick?.(ndc);
  };

  private handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
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
    this.keys.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private handleBlur = (): void => {
    this.keys.clear();
    this.drag = null;
  };

  dispose(): void {
    this.detach();
    this.follow = null;
    this.onClick = undefined;
    this.onDoubleClick = undefined;
  }
}
