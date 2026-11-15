/**
 * Mode photo : pause, UI masquée, orbite libre et capture PNG.
 *
 * La classe orchestre uniquement l'état et les dépendances injectées (caméra,
 * capture, pause, masquage UI) : elle ne connaît ni Three.js ni le DOM de la
 * session, ce qui la rend testable sous Node. L'overlay de raccourcis est créé
 * seulement si un hôte DOM est fourni.
 *
 * Trois presets de cadrage : carte (plongée large), rue (rasante, grand-angle)
 * et train (suivi d'un véhicule). Toutes les valeurs passent par les bornes de
 * `cameraMath` : distance, inclinaison et FOV restent sûrs.
 */

import * as THREE from 'three';
import {
  clampDistance,
  clampFov,
  clampPitch,
  clampTarget,
  type CameraPose,
  type MapBounds,
} from './cameraMath';

export type PhotoPresetId = 'map' | 'street' | 'train';

export interface PhotoPreset {
  id: PhotoPresetId;
  /** Distance caméra-cible en tuiles. */
  distance: number;
  /** Inclinaison en radians (0 = horizon). */
  pitch: number;
  /** Champ de vision en degrés. */
  fov: number;
  /** Recadrage sur la carte, sur une ancre ou suivi d'un véhicule. */
  framing: 'map' | 'anchor' | 'follow';
}

export const PHOTO_PRESET_IDS: readonly PhotoPresetId[] = ['map', 'street', 'train'];

export const PHOTO_PRESETS: Record<PhotoPresetId, PhotoPreset> = {
  map: { id: 'map', distance: 190, pitch: 1.02, fov: 46, framing: 'map' },
  street: { id: 'street', distance: 26, pitch: 0.3, fov: 62, framing: 'anchor' },
  train: { id: 'train', distance: 30, pitch: 0.36, fov: 55, framing: 'follow' },
};

/** Durée des transitions de preset (0 sous reduced motion). */
export const PHOTO_TRANSITION_SECONDS = 0.65;

export function isPhotoPresetId(value: string): value is PhotoPresetId {
  return (PHOTO_PRESET_IDS as readonly string[]).includes(value);
}

/** Sommet d'écran minimal pour considérer une capture comme valide. */
const MIN_PNG_PAYLOAD = 64;

export interface PhotoAnchor {
  x: number;
  z: number;
}

/** Sous-ensemble de `CameraController` utilisé par le mode photo. */
export interface PhotoCameraPort {
  getPose(): CameraPose;
  getFov(): number;
  setFov(fov: number): void;
  applyPose(pose: CameraPose, options?: { fov?: number; immediate?: boolean }): void;
  transitionTo(pose: CameraPose, options?: { fov?: number; seconds?: number }): void;
  setFollowTarget(provider: (() => PhotoAnchor | null) | null, distance?: number): void;
  setSpeedMultiplier(value: number): void;
  getSpeedMultiplier(): number;
}

export interface PhotoModeLabels {
  title: string;
  hint: string;
  capture: string;
  exit: string;
  preset: Record<PhotoPresetId, string>;
  captured: string;
}

export const DEFAULT_PHOTO_LABELS: PhotoModeLabels = {
  title: 'Mode photo',
  hint: 'Orbite : glisser · Zoom : molette · 1/2/3 : cadrage · C : capture · P ou Échap : quitter',
  capture: 'Capturer (C)',
  exit: 'Quitter (P)',
  preset: { map: 'Carte', street: 'Rue', train: 'Train' },
  captured: 'Capture enregistrée',
};

export interface PhotoModeOptions {
  camera: PhotoCameraPort;
  bounds: MapBounds;
  /** Rend la frame et renvoie un data URL PNG (ou null si indisponible). */
  captureFrame: () => string | null;
  /** Masque/affiche le HUD et la pastille moteur. */
  setUiHidden: (hidden: boolean) => void;
  /** Met le jeu en pause ; renvoie de quoi restaurer l'état précédent. */
  pause: () => (() => void) | null;
  /** Ancre du cadrage rue/train (véhicule sélectionné ou gare). */
  anchor?: () => PhotoAnchor | null;
  /** Suivi vivant pour le preset train. */
  followAnchor?: () => (() => PhotoAnchor | null) | null;
  reducedMotion?: boolean;
  now?: () => number;
  /** Hôte de l'overlay (facultatif : absent en test Node). */
  mount?: HTMLElement;
  labels?: Partial<PhotoModeLabels>;
  /** Déclenché par le bouton « Capturer » de l'overlay. */
  onCapture?: () => void;
}

export interface PhotoCapture {
  dataUrl: string;
  filename: string;
  preset: PhotoPresetId;
}

/** Prend en charge pause, UI, preset et capture ; `dispose()` restaure tout. */
export class PhotoMode {
  private options: PhotoModeOptions;
  private labels: PhotoModeLabels;
  private active = false;
  private preset: PhotoPresetId = 'map';
  private saved: { pose: CameraPose; fov: number; speed: number } | null = null;
  private restorePause: (() => void) | null = null;
  private lastCapture: PhotoCapture | null = null;
  private overlay: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private presetButtons = new Map<PhotoPresetId, HTMLButtonElement>();

  constructor(options: PhotoModeOptions) {
    this.options = options;
    this.labels = {
      ...DEFAULT_PHOTO_LABELS,
      ...options.labels,
      preset: { ...DEFAULT_PHOTO_LABELS.preset, ...options.labels?.preset },
    };
  }

  isActive(): boolean {
    return this.active;
  }

  getPreset(): PhotoPresetId {
    return this.preset;
  }

  getLastCapture(): PhotoCapture | null {
    return this.lastCapture;
  }

  /** Entre en mode photo et applique un preset. Renvoie true au premier appel. */
  enter(preset: PhotoPresetId = 'map'): boolean {
    if (this.active) return false;
    this.active = true;
    const pose = this.options.camera.getPose();
    this.saved = {
      pose: {
        target: pose.target.clone(),
        yaw: pose.yaw,
        pitch: pose.pitch,
        distance: pose.distance,
      },
      fov: this.options.camera.getFov(),
      speed: this.options.camera.getSpeedMultiplier(),
    };
    this.options.camera.setFollowTarget(null);
    this.options.camera.setSpeedMultiplier(0.55);
    this.restorePause = this.options.pause() ?? null;
    this.options.setUiHidden(true);
    this.showOverlay(true);
    this.applyPreset(preset, !this.options.reducedMotion);
    return true;
  }

  /** Quitte le mode photo, restaure pause, UI, vitesse, FOV et cadrage. */
  exit(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.options.camera.setFollowTarget(null);
    const saved = this.saved;
    this.saved = null;
    if (saved) {
      this.options.camera.setSpeedMultiplier(saved.speed);
      this.options.camera.transitionTo(saved.pose, {
        fov: saved.fov,
        seconds: this.options.reducedMotion ? 0 : 0.5,
      });
    }
    this.options.setUiHidden(false);
    this.showOverlay(false);
    const restore = this.restorePause;
    this.restorePause = null;
    restore?.();
    return true;
  }

  toggle(preset?: PhotoPresetId): boolean {
    if (this.active) {
      this.exit();
      return false;
    }
    this.enter(preset);
    return true;
  }

  /** Change de cadrage ; entre en mode photo si nécessaire. */
  setPreset(preset: PhotoPresetId): void {
    if (!this.active) {
      this.enter(preset);
      return;
    }
    this.applyPreset(preset, !this.options.reducedMotion);
  }

  private applyPreset(preset: PhotoPresetId, animate: boolean): void {
    this.preset = preset;
    const definition = PHOTO_PRESETS[preset];
    const current = this.options.camera.getPose();
    const center = {
      x: (this.options.bounds.minX + this.options.bounds.maxX) / 2,
      z: (this.options.bounds.minZ + this.options.bounds.maxZ) / 2,
    };
    const anchor = definition.framing === 'map' ? null : (this.options.anchor?.() ?? null);
    const focus = anchor ?? center;
    const pose: CameraPose = {
      target: new THREE.Vector3(focus.x, 0, focus.z),
      yaw: current.yaw,
      pitch: clampPitch(definition.pitch),
      distance: clampDistance(definition.distance),
    };
    clampTarget(pose.target, this.options.bounds);
    const fov = clampFov(definition.fov);
    if (animate) {
      this.options.camera.transitionTo(pose, { fov, seconds: PHOTO_TRANSITION_SECONDS });
    } else {
      this.options.camera.applyPose(pose, { fov, immediate: true });
    }
    if (definition.framing === 'follow') {
      const provider = this.options.followAnchor?.() ?? null;
      this.options.camera.setFollowTarget(provider, pose.distance);
    }
    this.refreshOverlay();
  }

  /**
   * Capture la frame courante (render synchrone + data URL). Renvoie `null`
   * quand le canvas n'est pas disponible ou que le PNG est vide.
   */
  capture(): PhotoCapture | null {
    if (!this.active) return null;
    let dataUrl: string | null;
    try {
      dataUrl = this.options.captureFrame();
    } catch {
      dataUrl = null;
    }
    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return null;
    if (dataUrl.length < 'data:image/png;base64,'.length + MIN_PNG_PAYLOAD) return null;
    const timestamp = new Date(this.options.now?.() ?? Date.now())
      .toISOString()
      .replace(/[:.]/g, '-');
    const capture: PhotoCapture = {
      dataUrl,
      filename: `opentt3d-photo-${this.preset}-${timestamp}.png`,
      preset: this.preset,
    };
    this.lastCapture = capture;
    if (this.status) this.status.textContent = `${this.labels.captured} : ${capture.filename}`;
    return capture;
  }

  /** Met à jour les raccourcis de l'overlay (langue, état). */
  setLabels(labels: Partial<PhotoModeLabels>): void {
    this.labels = {
      ...this.labels,
      ...labels,
      preset: { ...this.labels.preset, ...labels.preset },
    };
    this.refreshOverlay();
  }

  private showOverlay(visible: boolean): void {
    this.refreshOverlay();
    if (!this.overlay) return;
    this.overlay.hidden = !visible;
  }

  private ensureOverlay(): void {
    if (this.overlay || !this.options.mount || typeof document === 'undefined') return;
    const overlay = document.createElement('div');
    overlay.className = 'photo-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    const title = document.createElement('p');
    title.className = 'photo-overlay-title';
    title.textContent = this.labels.title;
    const hint = document.createElement('p');
    hint.className = 'photo-overlay-hint';
    hint.textContent = this.labels.hint;
    const presets = document.createElement('div');
    presets.className = 'photo-overlay-presets';
    for (const id of PHOTO_PRESET_IDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'photo-preset';
      button.dataset.preset = id;
      button.addEventListener('click', () => this.setPreset(id));
      presets.append(button);
      this.presetButtons.set(id, button);
    }
    const capture = document.createElement('button');
    capture.type = 'button';
    capture.className = 'photo-capture';
    capture.addEventListener('click', () => this.options.onCapture?.());
    const status = document.createElement('p');
    status.className = 'photo-overlay-status';
    overlay.append(title, hint, presets, capture, status);
    this.options.mount.append(overlay);
    this.overlay = overlay;
    this.status = status;
    this.refreshOverlay();
  }

  private refreshOverlay(): void {
    this.ensureOverlay();
    for (const [id, button] of this.presetButtons) {
      button.textContent = this.labels.preset[id];
      button.setAttribute('aria-pressed', this.active && id === this.preset ? 'true' : 'false');
      button.classList.toggle('is-active', id === this.preset);
    }
    const capture = this.overlay?.querySelector<HTMLButtonElement>('.photo-capture');
    if (capture) capture.textContent = this.labels.capture;
    const title = this.overlay?.querySelector<HTMLElement>('.photo-overlay-title');
    if (title) title.textContent = this.labels.title;
    const hint = this.overlay?.querySelector<HTMLElement>('.photo-overlay-hint');
    if (hint) hint.textContent = this.labels.hint;
    if (this.status && !this.lastCapture) this.status.textContent = '';
  }

  dispose(): void {
    this.exit();
    this.overlay?.remove();
    this.overlay = null;
    this.status = null;
    this.presetButtons.clear();
    this.lastCapture = null;
  }
}

/** Déclenche le téléchargement d'un PNG (navigateur uniquement). */
export function downloadDataUrl(
  dataUrl: string,
  filename: string,
  doc: Document | null = typeof document === 'undefined' ? null : document,
): boolean {
  if (!doc || !dataUrl.startsWith('data:image/')) return false;
  const link = doc.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.rel = 'noopener';
  doc.body.append(link);
  link.click();
  link.remove();
  return true;
}
