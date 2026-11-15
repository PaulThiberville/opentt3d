import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_GROUND_CLEARANCE,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  cameraOffset,
  clampDistance,
  clampPitch,
  clampTarget,
  computeCameraPosition,
  enforceAboveGround,
  groundPointFromNdc,
  keyboardPanStep,
  panBasis,
  screenToNdc,
  wheelZoomFactor,
  type CameraPose,
} from '../src/render/cameraMath';

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(52, 1.6, 0.5, 1000);
  camera.position.set(0, 50, 50);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('bornes de caméra', () => {
  it('borne la cible à l’intérieur de la carte', () => {
    const target = new THREE.Vector3(-50, 0, 500);
    clampTarget(target, { minX: 0, maxX: 256, minZ: 0, maxZ: 256 });
    expect(target.x).toBeGreaterThanOrEqual(2);
    expect(target.x).toBeLessThanOrEqual(254);
    expect(target.z).toBeGreaterThanOrEqual(2);
    expect(target.z).toBeLessThanOrEqual(254);
  });

  it('garde la cible dans une carte plus petite que la marge', () => {
    const target = new THREE.Vector3(100, 0, 100);
    clampTarget(target, { minX: 0, maxX: 3, minZ: 0, maxZ: 3 });
    expect(target.x).toBeGreaterThanOrEqual(0);
    expect(target.x).toBeLessThanOrEqual(3);
  });

  it('borne l’inclinaison et la distance', () => {
    expect(clampPitch(-1)).toBe(MIN_PITCH);
    expect(clampPitch(3)).toBe(MAX_PITCH);
    expect(clampPitch(0.9)).toBeCloseTo(0.9);
    expect(clampDistance(0)).toBe(MIN_DISTANCE);
    expect(clampDistance(10_000)).toBe(MAX_DISTANCE);
    expect(clampDistance(60)).toBe(60);
  });
});

describe('position de caméra', () => {
  it('respecte la distance et l’élévation demandées', () => {
    const pose: CameraPose = {
      target: new THREE.Vector3(100, 2, 80),
      yaw: 0.7,
      pitch: 0.9,
      distance: 50,
    };
    const position = computeCameraPosition(pose);
    expect(position.distanceTo(pose.target)).toBeCloseTo(50, 5);
    expect(position.y - pose.target.y).toBeCloseTo(Math.sin(0.9) * 50, 5);
  });

  it('place la caméra au sud pour yaw = 0', () => {
    const offset = cameraOffset(0, 0.5, 10);
    expect(offset.x).toBeCloseTo(0);
    expect(offset.z).toBeGreaterThan(0);
    expect(offset.y).toBeGreaterThan(0);
  });

  it('ne passe jamais sous le terrain', () => {
    const position = new THREE.Vector3(10, 1, 10);
    enforceAboveGround(position, () => 5);
    expect(position.y).toBeCloseTo(5 + CAMERA_GROUND_CLEARANCE);

    const high = new THREE.Vector3(10, 40, 10);
    enforceAboveGround(high, () => 5);
    expect(high.y).toBe(40);
  });

  it('fournit une base de pan orthonormée', () => {
    const basis = panBasis(0.4);
    const norm = Math.hypot(basis.rightX, basis.rightZ);
    expect(norm).toBeCloseTo(1, 6);
    const forwardNorm = Math.hypot(basis.forwardX, basis.forwardZ);
    expect(forwardNorm).toBeCloseTo(1, 6);
    const dot = basis.rightX * basis.forwardX + basis.rightZ * basis.forwardZ;
    expect(dot).toBeCloseTo(0, 6);
  });
});

describe('écran → monde', () => {
  it('convertit les coins et le centre en NDC', () => {
    const rect = { left: 100, top: 50, width: 1000, height: 500 };
    expect(screenToNdc(100, 50, rect)).toEqual({ x: -1, y: 1 });
    expect(screenToNdc(1100, 550, rect)).toEqual({ x: 1, y: -1 });
    const center = screenToNdc(600, 300, rect);
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0);
  });

  it('projette le centre de l’écran sur la cible', () => {
    const camera = makeCamera();
    const point = groundPointFromNdc({ x: 0, y: 0 }, camera, 0);
    expect(point).not.toBeNull();
    expect(point?.x).toBeCloseTo(0, 3);
    expect(point?.z).toBeCloseTo(0, 3);
  });

  it('renvoie null quand le rayon ne touche pas le sol', () => {
    const camera = new THREE.PerspectiveCamera(52, 1.6, 0.5, 1000);
    camera.position.set(0, 50, 0);
    camera.lookAt(0, 200, 0);
    camera.updateMatrixWorld(true);
    expect(groundPointFromNdc({ x: 0, y: 0 }, camera, 0)).toBeNull();
  });

  it('un point hors centre touche le plan plus loin', () => {
    const camera = makeCamera();
    const point = groundPointFromNdc({ x: 0.6, y: 0 }, camera, 0);
    expect(point).not.toBeNull();
    expect(Math.abs(point?.x ?? 0)).toBeGreaterThan(1);
  });
});

describe('zoom et clavier', () => {
  it('le facteur de molette est monotone et borné', () => {
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-10_000)).toBeGreaterThan(0.5);
    expect(wheelZoomFactor(10_000)).toBeLessThan(2);
  });

  it('le pas clavier grandit avec la distance', () => {
    expect(keyboardPanStep(10, 0.016)).toBeLessThan(keyboardPanStep(100, 0.016));
    expect(keyboardPanStep(0, 0.016)).toBeGreaterThanOrEqual(0);
  });
});
