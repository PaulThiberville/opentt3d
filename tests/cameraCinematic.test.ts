import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_GROUND_CLEARANCE,
  MAX_DISTANCE,
  MAX_FOV,
  MAX_PITCH,
  MAX_SPEED_MULTIPLIER,
  MIN_DISTANCE,
  MIN_FOV,
  MIN_PITCH,
  MIN_SPEED_MULTIPLIER,
  cameraHeight,
  clampDistance,
  clampFov,
  clampPitch,
  clampSpeedMultiplier,
  type CameraPose,
  type MapBounds,
} from '../src/render/cameraMath';
import { CameraController } from '../src/render/CameraController';
import {
  DEFAULT_INTRO_SECONDS,
  MAX_INTRO_SECONDS,
  MIN_INTRO_SECONDS,
  CinematicIntro,
  clampIntroDuration,
} from '../src/render/cinematicIntro';

const BOUNDS: MapBounds = { minX: 0, maxX: 128, minZ: 0, maxZ: 128 };

function assertPoseInBounds(pose: CameraPose, bounds: MapBounds = BOUNDS): void {
  expect(pose.target.x).toBeGreaterThanOrEqual(bounds.minX);
  expect(pose.target.x).toBeLessThanOrEqual(bounds.maxX);
  expect(pose.target.z).toBeGreaterThanOrEqual(bounds.minZ);
  expect(pose.target.z).toBeLessThanOrEqual(bounds.maxZ);
  expect(pose.pitch).toBeGreaterThanOrEqual(MIN_PITCH);
  expect(pose.pitch).toBeLessThanOrEqual(MAX_PITCH);
  expect(pose.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
  expect(pose.distance).toBeLessThanOrEqual(MAX_DISTANCE);
}

describe('bornes des réglages caméra', () => {
  it('borne le FOV dans la plage 30–68°', () => {
    expect(clampFov(10)).toBe(MIN_FOV);
    expect(clampFov(90)).toBe(MAX_FOV);
    expect(clampFov(52)).toBe(52);
    expect(clampFov(Number.NaN)).toBe(52);
  });

  it('borne le multiplicateur de vitesse', () => {
    expect(clampSpeedMultiplier(0)).toBe(MIN_SPEED_MULTIPLIER);
    expect(clampSpeedMultiplier(100)).toBe(MAX_SPEED_MULTIPLIER);
    expect(clampSpeedMultiplier(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampSpeedMultiplier(0.8)).toBe(0.8);
  });

  it('calcule une hauteur cohérente et sûre', () => {
    // L'inclinaison minimale est appliquée avant le calcul : jamais au sol.
    expect(cameraHeight(0, 50)).toBeCloseTo(Math.sin(MIN_PITCH) * 50);
    expect(cameraHeight(Math.PI / 2, 50)).toBeCloseTo(Math.sin(MAX_PITCH) * 50);
    expect(cameraHeight(-1, 50)).toBeCloseTo(Math.sin(MIN_PITCH) * 50);
    expect(cameraHeight(0.3, 26)).toBeGreaterThan(CAMERA_GROUND_CLEARANCE);
  });
});

describe('intro cinématique', () => {
  it('borne sa durée entre 3 et 5 secondes', () => {
    expect(clampIntroDuration(1)).toBe(MIN_INTRO_SECONDS);
    expect(clampIntroDuration(10)).toBe(MAX_INTRO_SECONDS);
    expect(clampIntroDuration(undefined)).toBe(DEFAULT_INTRO_SECONDS);
  });

  it('produit des poses bornées tout au long du survol', () => {
    const intro = new CinematicIntro({ bounds: BOUNDS, durationSeconds: 4 });
    const step = 0.1;
    let updates = 0;
    for (let elapsed = 0; elapsed < 4; elapsed += step) {
      const pose = intro.update(step);
      if (!pose) break;
      assertPoseInBounds(pose);
      updates += 1;
    }
    expect(updates).toBeGreaterThan(30);
    expect(intro.progress).toBeCloseTo(1, 5);
    expect(intro.finished).toBe(true);
    expect(intro.update(step)).toBeNull();
  });

  it('glisse vers les points d’intérêt sans sortir de la carte', () => {
    const intro = new CinematicIntro({
      bounds: BOUNDS,
      anchors: [
        { x: 12, z: 12 },
        { x: 118, z: 118 },
      ],
    });
    const start = intro.update(0.001);
    expect(start).not.toBeNull();
    for (let i = 0; i < 40; i += 1) {
      const pose = intro.update(0.1);
      if (!pose) break;
      assertPoseInBounds(pose);
    }
    expect(intro.finishPose()).toBeTruthy();
    assertPoseInBounds(intro.finishPose());
  });

  it('se coupe immédiatement au clic ou à la touche', () => {
    const intro = new CinematicIntro({ bounds: BOUNDS });
    intro.update(0.5);
    expect(intro.finished).toBe(false);
    intro.skip();
    expect(intro.finished).toBe(true);
    expect(intro.progress).toBe(1);
    expect(intro.update(0.016)).toBeNull();
    assertPoseInBounds(intro.finishPose());
  });

  it('ne démarre pas sous prefers-reduced-motion', () => {
    const intro = new CinematicIntro({ bounds: BOUNDS, reducedMotion: true });
    expect(intro.finished).toBe(true);
    expect(intro.update(0.016)).toBeNull();
    assertPoseInBounds(intro.finishPose());
  });
});

/** Élément minimal : les tests n'attachent aucun listener DOM. */
function fakeElement(): HTMLElement {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLElement;
}

function makeController(bounds: MapBounds = BOUNDS): CameraController {
  const camera = new THREE.PerspectiveCamera(52, 1.6, 0.4, 1000);
  return new CameraController({
    camera,
    element: fakeElement(),
    bounds,
    heightAt: () => 3,
  });
}

describe('contrôleur : poses scriptées et FOV', () => {
  it('applique un FOV borné et le reflète sur la caméra', () => {
    const controller = makeController();
    controller.setFov(90);
    expect(controller.getFov()).toBe(MAX_FOV);
    controller.setFov(5);
    expect(controller.getFov()).toBe(MIN_FOV);
    controller.setFov(48);
    expect(controller.getFov()).toBe(48);
  });

  it('applique une pose immédiate en bornant cible, distance et hauteur', () => {
    const controller = makeController();
    controller.applyPose(
      {
        target: new THREE.Vector3(500, 0, -200),
        yaw: Math.PI * 6,
        pitch: 5,
        distance: 10_000,
      },
      { fov: 64, immediate: true },
    );
    const pose = controller.getPose();
    expect(pose.target.x).toBeLessThanOrEqual(BOUNDS.maxX);
    expect(pose.target.z).toBeGreaterThanOrEqual(BOUNDS.minZ);
    expect(pose.pitch).toBe(MAX_PITCH);
    expect(pose.distance).toBeLessThanOrEqual(MAX_DISTANCE);
    expect(controller.getFov()).toBe(64);
  });

  it('interpole une transition puis se stabilise sur la cible', () => {
    const controller = makeController();
    const start = controller.getPose().distance;
    controller.transitionTo(
      { target: new THREE.Vector3(40, 0, 40), yaw: 0.4, pitch: 0.7, distance: 30 },
      { fov: 60, seconds: 0.5 },
    );
    expect(controller.isTransitioning()).toBe(true);
    controller.update(0.25);
    const middle = controller.getPose();
    expect(middle.distance).toBeLessThan(start);
    expect(middle.distance).toBeGreaterThan(30);
    // `update` borne le delta à 0,1 s (frame) : plusieurs frames pour finir.
    for (let i = 0; i < 6; i += 1) controller.update(0.1);
    expect(controller.isTransitioning()).toBe(false);
    expect(controller.getPose().distance).toBeCloseTo(30, 4);
    expect(controller.getFov()).toBeCloseTo(60, 4);
  });

  it('la pose scriptée reste prioritaire sur les entrées', () => {
    const controller = makeController();
    controller.setScriptedPose({
      target: new THREE.Vector3(20, 0, 30),
      yaw: 1.1,
      pitch: 0.8,
      distance: 44,
    });
    expect(controller.isScripted()).toBe(true);
    controller.update(0.2);
    const pose = controller.getPose();
    expect(pose.target.x).toBeCloseTo(20, 5);
    expect(pose.target.z).toBeCloseTo(30, 5);
    expect(pose.distance).toBeCloseTo(44, 5);
    controller.setScriptedPose(null);
    expect(controller.isScripted()).toBe(false);
  });

  it('borne le multiplicateur de vitesse des entrées', () => {
    const controller = makeController();
    controller.setSpeedMultiplier(9);
    expect(controller.getSpeedMultiplier()).toBe(MAX_SPEED_MULTIPLIER);
    controller.setSpeedMultiplier(-1);
    expect(controller.getSpeedMultiplier()).toBe(MIN_SPEED_MULTIPLIER);
  });

  it('applique une transition nulle instantanément (reduced motion)', () => {
    const controller = makeController();
    controller.transitionTo(
      { target: new THREE.Vector3(64, 0, 64), yaw: 0.2, pitch: clampPitch(0.4), distance: 24 },
      { fov: 55, seconds: 0 },
    );
    expect(controller.isTransitioning()).toBe(false);
    expect(controller.getPose().distance).toBeCloseTo(clampDistance(24), 5);
    expect(controller.getFov()).toBe(55);
  });
});
