/**
 * Gestes tactiles de la caméra (#170), sans modifier le contrôleur de rendu.
 *
 * Le `CameraController` gère déjà le clic, le glisser et la molette. Sur
 * mobile il manque le pincement : ce module l'ajoute au-dessus de son API
 * publique (`getPose` / `applyPose` / `setFollowTarget`) en capturant les
 * pointeurs tactiles à deux doigts. Les gestes à un doigt restent au
 * contrôleur ; les mouvements multi-touch sont interceptés pour éviter qu'un
 * pan démarre pendant le pincement.
 */

import type { CameraController } from '../render/CameraController';

export interface TouchPoint {
  x: number;
  y: number;
}

export interface TouchGestureOptions {
  element: HTMLElement;
  camera: CameraController;
  /** Distance minimale entre deux doigts pour démarrer un pincement. */
  minSpread?: number;
}

export interface TouchPinchState {
  /** Écart initial entre les deux doigts, en pixels. */
  startSpread: number;
  /** Distance caméra au début du geste. */
  startDistance: number;
  /** Milieu initial du geste. */
  lastMid: TouchPoint;
}

export interface PinchUpdate {
  distance: number;
  /** Déplacement du milieu, en pixels. */
  dx: number;
  dy: number;
}

const MIN_SPREAD = 12;
/** Sensibilité du pan tactile par rapport au pan souris du contrôleur. */
const PAN_SCALE = 0.0017;

export function spreadBetween(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpointBetween(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Distance caméra pour un pincement : écarter les doigts rapproche la caméra
 * (division par le rapport d'écartement). Le résultat est fini et strictement
 * positif ; le contrôleur applique ses propres bornes ensuite.
 */
export function pinchDistance(startDistance: number, startSpread: number, spread: number): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0) return startDistance;
  if (!Number.isFinite(startSpread) || startSpread <= 0) return startDistance;
  if (!Number.isFinite(spread) || spread <= 0) return startDistance;
  const next = startDistance * (startSpread / spread);
  return Number.isFinite(next) && next > 0 ? next : startDistance;
}

/** Conversion du déplacement du milieu en déplacement caméra dans le plan. */
export function panFromMidpoint(
  dx: number,
  dy: number,
  yaw: number,
  distance: number,
): { x: number; z: number } {
  const scale = Math.max(0, distance) * PAN_SCALE;
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  return {
    x: forwardX * dy * scale - rightX * dx * scale,
    z: forwardZ * dy * scale - rightZ * dx * scale,
  };
}

/** Met à jour un pincement à partir des deux pointeurs courants. */
export function updatePinch(state: TouchPinchState, a: TouchPoint, b: TouchPoint): PinchUpdate {
  const mid = midpointBetween(a, b);
  const dx = mid.x - state.lastMid.x;
  const dy = mid.y - state.lastMid.y;
  state.lastMid = mid;
  return {
    distance: pinchDistance(state.startDistance, state.startSpread, spreadBetween(a, b)),
    dx,
    dy,
  };
}

/** Gestionnaire de pincement / pan à deux doigts attaché à la scène. */
export class TouchCameraGestures {
  private element: HTMLElement;
  private camera: CameraController;
  private minSpread: number;
  private pointers = new Map<number, TouchPoint>();
  private gesture: TouchPinchState | null = null;
  private suppressUntilClear = false;
  private attached = false;

  constructor(options: TouchGestureOptions) {
    this.element = options.element;
    this.camera = options.camera;
    this.minSpread = options.minSpread ?? MIN_SPREAD;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    // Capture : les gestes tactiles passent avant le contrôleur de caméra.
    this.element.addEventListener('pointerdown', this.handlePointerDown, {
      capture: true,
    });
    this.element.addEventListener('pointermove', this.handlePointerMove, {
      capture: true,
    });
    this.element.addEventListener('pointerup', this.handlePointerUp, { capture: true });
    this.element.addEventListener('pointercancel', this.handlePointerUp, { capture: true });
    this.element.addEventListener('pointerleave', this.handlePointerUp, { capture: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.element.removeEventListener('pointerdown', this.handlePointerDown, {
      capture: true,
    } as EventListenerOptions);
    this.element.removeEventListener('pointermove', this.handlePointerMove, {
      capture: true,
    } as EventListenerOptions);
    this.element.removeEventListener('pointerup', this.handlePointerUp, {
      capture: true,
    } as EventListenerOptions);
    this.element.removeEventListener('pointercancel', this.handlePointerUp, {
      capture: true,
    } as EventListenerOptions);
    this.element.removeEventListener('pointerleave', this.handlePointerUp, {
      capture: true,
    } as EventListenerOptions);
    this.pointers.clear();
    this.gesture = null;
    this.suppressUntilClear = false;
  }

  /** Nombre de pointeurs tactiles suivis (diagnostic et tests). */
  get pointerCount(): number {
    return this.pointers.size;
  }

  private isTouch(event: PointerEvent): boolean {
    return event.pointerType === 'touch' || event.pointerType === 'pen';
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.isTouch(event)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size < 2) return;
    const pair = this.firstPair();
    if (!pair) return;
    if (spreadBetween(pair[0], pair[1]) < this.minSpread) return;
    // Un outil de construction possède le clic gauche : deux doigts ne doivent
    // pas interrompre son tracé ni laisser un placement à moitié engagé.
    if (this.camera.isPlacementEnabled()) {
      this.gesture = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this.camera.isScripted()) return;
    this.beginGesture(pair[0], pair[1]);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.isTouch(event)) return;
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.suppressUntilClear) {
      // Après un pincement, le doigt restant ne doit pas faire sauter la
      // caméra avec une origine de drag devenue obsolète.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!this.gesture) return;
    const pair = this.firstPair();
    if (!pair) return;
    this.applyPinch(pair[0], pair[1]);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.isTouch(event)) return;
    this.pointers.delete(event.pointerId);
    if (this.gesture) {
      this.gesture = null;
      // Ignore les mouvements résiduels du doigt restant jusqu'à ce que tous
      // les pointeurs soient relevés : le contrôleur ne doit pas sauter.
      this.suppressUntilClear = this.pointers.size > 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (this.pointers.size === 0) this.suppressUntilClear = false;
  };

  private firstPair(): [TouchPoint, TouchPoint] | null {
    const points = Array.from(this.pointers.values());
    if (points.length < 2) return null;
    const first = points[0];
    const second = points[1];
    return first && second ? [first, second] : null;
  }

  private beginGesture(a: TouchPoint, b: TouchPoint): void {
    const pose = this.camera.getPose();
    this.camera.setFollowTarget(null);
    this.gesture = {
      startSpread: Math.max(this.minSpread, spreadBetween(a, b)),
      startDistance: pose.distance,
      lastMid: midpointBetween(a, b),
    };
  }

  private applyPinch(a: TouchPoint, b: TouchPoint): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const pose = this.camera.getPose();
    const update = updatePinch(gesture, a, b);
    const pan = panFromMidpoint(update.dx, update.dy, pose.yaw, update.distance);
    const target = pose.target.clone();
    target.x += pan.x;
    target.z += pan.z;
    this.camera.applyPose(
      {
        target,
        yaw: pose.yaw,
        pitch: pose.pitch,
        distance: update.distance,
      },
      { fov: this.camera.getFov(), immediate: true },
    );
  }
}
