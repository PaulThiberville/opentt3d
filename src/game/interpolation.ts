/**
 * Helpers d'interpolation, indépendants du rendu et testables sous Node.
 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const TWO_PI = Math.PI * 2;

/** Normalise un angle dans [0, 2π). */
export function normalizeAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/** Interpole deux angles (radians) par le plus court chemin. */
export function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((b - a + Math.PI * 3) % TWO_PI) - Math.PI;
  return a + delta * t;
}

/** Interpole deux directions 0..255 par le plus court chemin (pas de 360°). */
export function lerpDirection(a: number, b: number, t: number): number {
  const delta = ((b - a + 384) % 256) - 128;
  const value = a + delta * t;
  return ((Math.round(value) % 256) + 256) % 256;
}

/** Interpolation adoucie, utile pour les transitions caméra. */
export function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/** Lissage exponentiel indépendant du framerate. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
