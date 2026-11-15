import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  PHOTO_PRESETS,
  PhotoMode,
  downloadDataUrl,
  type PhotoAnchor,
  type PhotoCameraPort,
} from '../src/render/PhotoMode';
import {
  MAX_FOV,
  MIN_DISTANCE,
  MIN_FOV,
  cameraHeight,
  type CameraPose,
  type MapBounds,
} from '../src/render/cameraMath';
import { sanitizeSettings } from '../src/ui/settings';

const BOUNDS: MapBounds = { minX: 0, maxX: 128, minZ: 0, maxZ: 128 };
const PNG = `data:image/png;base64,${'A'.repeat(256)}`;

class FakeCamera implements PhotoCameraPort {
  pose: CameraPose = {
    target: new THREE.Vector3(64, 0, 64),
    yaw: 0.6,
    pitch: 0.8,
    distance: 90,
  };
  fov = 52;
  speed = 1;
  follow: (() => PhotoAnchor | null) | null = null;
  followDistance = 0;
  transitions: { distance: number; fov: number; seconds: number }[] = [];
  applied: { distance: number; fov: number }[] = [];

  getPose(): CameraPose {
    return {
      target: this.pose.target.clone(),
      yaw: this.pose.yaw,
      pitch: this.pose.pitch,
      distance: this.pose.distance,
    };
  }

  getFov(): number {
    return this.fov;
  }

  setFov(fov: number): void {
    this.fov = fov;
  }

  applyPose(pose: CameraPose, options: { fov?: number; immediate?: boolean } = {}): void {
    this.pose = {
      target: pose.target.clone(),
      yaw: pose.yaw,
      pitch: pose.pitch,
      distance: pose.distance,
    };
    if (options.fov !== undefined) this.fov = options.fov;
    this.applied.push({ distance: pose.distance, fov: this.fov });
  }

  transitionTo(pose: CameraPose, options: { fov?: number; seconds?: number } = {}): void {
    this.pose = {
      target: pose.target.clone(),
      yaw: pose.yaw,
      pitch: pose.pitch,
      distance: pose.distance,
    };
    if (options.fov !== undefined) this.fov = options.fov;
    this.transitions.push({
      distance: pose.distance,
      fov: this.fov,
      seconds: options.seconds ?? 0.8,
    });
  }

  setFollowTarget(provider: (() => PhotoAnchor | null) | null, distance = 16): void {
    this.follow = provider;
    this.followDistance = distance;
  }

  setSpeedMultiplier(value: number): void {
    this.speed = value;
  }

  getSpeedMultiplier(): number {
    return this.speed;
  }
}

function setup(options: { reducedMotion?: boolean; anchor?: PhotoAnchor | null } = {}) {
  const camera = new FakeCamera();
  const hidden: boolean[] = [];
  let restored = 0;
  const pause = vi.fn(() => () => {
    restored += 1;
  });
  const mode = new PhotoMode({
    camera,
    bounds: BOUNDS,
    captureFrame: () => PNG,
    setUiHidden: (value) => hidden.push(value),
    pause,
    ...(options.anchor !== undefined ? { anchor: () => options.anchor ?? null } : {}),
    reducedMotion: options.reducedMotion ?? false,
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  return { mode, camera, hidden, pause, restored: () => restored };
}

describe('mode photo', () => {
  it('met en pause, masque l’UI et applique un cadrage borné', () => {
    const { mode, camera, hidden, pause } = setup({ anchor: { x: 30, z: 40 } });
    expect(mode.enter('street')).toBe(true);
    expect(mode.isActive()).toBe(true);
    expect(mode.getPreset()).toBe('street');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(hidden).toEqual([true]);
    expect(camera.transitions).toHaveLength(1);
    const applied = camera.transitions[0]!;
    expect(applied.seconds).toBeGreaterThan(0);
    expect(applied.fov).toBeGreaterThanOrEqual(MIN_FOV);
    expect(applied.fov).toBeLessThanOrEqual(MAX_FOV);
    expect(applied.distance).toBe(PHOTO_PRESETS.street.distance);
    expect(camera.pose.target.x).toBeCloseTo(30, 5);
    expect(camera.pose.target.z).toBeCloseTo(40, 5);
  });

  it('restaure pause, UI, FOV, vitesse et cadrage à la sortie', () => {
    const { mode, camera, hidden, restored } = setup();
    const initial = camera.getPose();
    const initialFov = camera.getFov();
    mode.enter();
    camera.fov = 40;
    mode.exit();
    expect(mode.isActive()).toBe(false);
    expect(hidden).toEqual([true, false]);
    expect(restored()).toBe(1);
    expect(camera.speed).toBe(1);
    expect(camera.fov).toBe(initialFov);
    expect(camera.pose.target.x).toBeCloseTo(initial.target.x, 5);
    expect(camera.pose.target.z).toBeCloseTo(initial.target.z, 5);
    expect(camera.transitions.at(-1)?.fov).toBe(initialFov);
  });

  it('toggle entre entrée et sortie', () => {
    const { mode, hidden } = setup();
    expect(mode.toggle()).toBe(true);
    expect(mode.isActive()).toBe(true);
    expect(mode.toggle()).toBe(false);
    expect(mode.isActive()).toBe(false);
    expect(hidden).toEqual([true, false]);
  });

  it('capture un PNG non vide et nomme le fichier', () => {
    const { mode } = setup();
    expect(mode.capture()).toBeNull();
    mode.enter('map');
    const shot = mode.capture();
    expect(shot).not.toBeNull();
    expect(shot?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(shot?.filename).toMatch(/^opentt3d-photo-map-.*\.png$/);
    expect(mode.getLastCapture()).toEqual(shot);
  });

  it('refuse une capture vide ou non PNG', () => {
    const broken = setup();
    broken.mode.enter();
    // Le faux hôte renvoie un PNG valide : on vérifie le garde-fou via un hôte dédié.
    expect(broken.mode.capture()).not.toBeNull();
    const empty = new PhotoMode({
      camera: new FakeCamera(),
      bounds: BOUNDS,
      captureFrame: () => 'data:image/png;base64,',
      setUiHidden: () => undefined,
      pause: () => null,
    });
    empty.enter();
    expect(empty.capture()).toBeNull();
    const wrong = new PhotoMode({
      camera: new FakeCamera(),
      bounds: BOUNDS,
      captureFrame: () => 'data:text/plain;base64,AAAA',
      setUiHidden: () => undefined,
      pause: () => null,
    });
    wrong.enter();
    expect(wrong.capture()).toBeNull();
  });

  it('applique les presets sans transition sous reduced motion', () => {
    const { mode, camera } = setup({ reducedMotion: true });
    mode.enter('map');
    expect(camera.transitions).toHaveLength(0);
    expect(camera.applied).toHaveLength(1);
    mode.setPreset('street');
    expect(camera.applied).toHaveLength(2);
    mode.exit();
    expect(camera.transitions.at(-1)?.seconds).toBe(0);
    expect(camera.applied).toHaveLength(2);
  });

  it('cadre la rue plus bas que la carte et reste au-dessus du sol', () => {
    const map = PHOTO_PRESETS.map;
    const street = PHOTO_PRESETS.street;
    const mapHeight = cameraHeight(map.pitch, map.distance);
    const streetHeight = cameraHeight(street.pitch, street.distance);
    expect(streetHeight).toBeLessThan(mapHeight);
    expect(streetHeight).toBeGreaterThan(2.4);
    expect(street.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
  });

  it('suit le véhicule pour le preset train', () => {
    const { mode, camera } = setup({ anchor: { x: 12, z: 8 } });
    const provider = () => ({ x: 20, z: 24 });
    const followMode = new PhotoMode({
      camera,
      bounds: BOUNDS,
      captureFrame: () => PNG,
      setUiHidden: () => undefined,
      pause: () => null,
      anchor: () => ({ x: 12, z: 8 }),
      followAnchor: () => provider,
    });
    followMode.enter('train');
    expect(camera.follow).toBe(provider);
    expect(camera.followDistance).toBe(PHOTO_PRESETS.train.distance);
    expect(camera.pose.target.x).toBeCloseTo(12, 5);
    followMode.exit();
    expect(camera.follow).toBeNull();
    mode.dispose();
    followMode.dispose();
  });
});

describe('téléchargement des captures', () => {
  it('refuse un data URL non image ou un document absent', () => {
    expect(downloadDataUrl('data:image/png;base64,AAAA', 'shot.png', null)).toBe(false);
    expect(downloadDataUrl('https://example.com/a.png', 'shot.png', null)).toBe(false);
  });
});

describe('réglage d’intro cinématique', () => {
  it('est activé par défaut et normalisé en booléen', () => {
    expect(sanitizeSettings({}).cinematicIntro).toBe(true);
    expect(sanitizeSettings({ cinematicIntro: false }).cinematicIntro).toBe(false);
    expect(sanitizeSettings({ cinematicIntro: 'non' }).cinematicIntro).toBe(true);
  });
});
