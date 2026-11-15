/**
 * Modèle pur du cycle jour/nuit.
 *
 * Le moteur expose `economy.dayFraction` sur 74 ticks par jour
 * (`TICKS_PER_DAY` d'OpenTTD). Ce module le convertit en phase normalisée
 * (0 = minuit, 0,25 = lever, 0,5 = midi, 0,75 = coucher), puis en paramètres
 * de lumière, de ciel et de brume consommés par `Renderer`.
 *
 * Aucune dépendance Three.js/DOM : tout est testable sous Node.
 */

import type { EconomySnapshot } from '../engine/protocol';

/** Ticks moteur par jour de jeu (OpenTTD : `TICKS_PER_DAY`). */
export const DAY_TICKS = 74;

/**
 * Convention de rendu : une nouvelle journée de jeu démarre en fin de matinée
 * (10:48), pour éviter qu'une nouvelle partie s'ouvre dans la pénombre.
 * La phase reste linéaire sur 74 ticks et minuit reste à 0, midi à 0,5.
 */
export const DAY_START_OFFSET = 0.45;

export const TAU = Math.PI * 2;
/** Élévation maximale du soleil (radians), volontairement sous le zénith. */
const MAX_ELEVATION = 1.02;

export type DaySegment = 'night' | 'dawn' | 'day' | 'dusk';

export interface SunState {
  /** Phase normalisée [0, 1). */
  phase: number;
  /** Sinus de l'élévation brute, -1 (minuit) à 1 (midi). */
  altitude: number;
  /** Élévation géométrique du soleil (radians, négative la nuit). */
  elevation: number;
  /** Azimut : 0 = est, π/2 = sud, π = ouest. */
  azimuth: number;
  /** Vecteur unitaire scène → soleil (X est, Y haut, Z sud). */
  direction: { x: number; y: number; z: number };
  /** Couleur du soleil (hex sRGB). */
  colour: number;
  /** Intensité de la lumière directionnelle. */
  intensity: number;
  /** Intensité de la lumière lunaire (0 le jour). */
  moonIntensity: number;
  /** Couleur du ciel et de la brume. */
  skyColour: number;
  fogColour: number;
  hemiSky: number;
  hemiGround: number;
  /** Multiplicateur d'ambiance, à appliquer au preset de qualité. */
  ambient: number;
  /** 0 = plein jour, 1 = nuit profonde. */
  night: number;
  /** 0 = nuit, 1 = plein jour. */
  daylight: number;
  /** Opacité des étoiles (0 le jour). */
  starOpacity: number;
  segment: DaySegment;
}

/** Ramène une valeur dans [0, 1). */
export function wrap01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 1) + 1) % 1;
}

/** Convertit un `dayFraction` (0..73) en phase [0, 1) alignée sur minuit. */
export function phaseFromDayFraction(dayFraction: number): number {
  const ticks = Number.isFinite(dayFraction) ? dayFraction : 0;
  return wrap01(ticks / DAY_TICKS + DAY_START_OFFSET);
}

/** Raccourci depuis un snapshot d'économie. */
export function phaseFromEconomy(economy: Pick<EconomySnapshot, 'dayFraction'>): number {
  return phaseFromDayFraction(economy?.dayFraction ?? 0);
}

/** Écart de phase le plus court, dans [-0,5 ; 0,5). */
export function shortestPhaseDelta(from: number, to: number): number {
  const delta = wrap01(to - from);
  return delta >= 0.5 ? delta - 1 : delta;
}

/**
 * Rapproche une phase de sa cible sans saut au passage de minuit.
 * `timeConstant` est la constante de temps de lissage (secondes).
 */
export function approachPhase(
  current: number,
  target: number,
  deltaSeconds: number,
  timeConstant = 0.12,
): number {
  const delta = shortestPhaseDelta(current, target);
  if (delta === 0) return wrap01(current);
  const step = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
  const tau = Math.max(1e-4, timeConstant);
  const alpha = 1 - Math.exp(-step / tau);
  return wrap01(current + delta * alpha);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Interpolation lissée entre deux bornes (bornes inversées acceptées). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixChannel(a: number, b: number, t: number): number {
  return Math.round(lerp(a, b, t));
}

/** Mélange deux couleurs hex sRGB. */
export function mixColour(a: number, b: number, t: number): number {
  const amount = clamp01(t);
  return (
    (mixChannel((a >> 16) & 0xff, (b >> 16) & 0xff, amount) << 16) |
    (mixChannel((a >> 8) & 0xff, (b >> 8) & 0xff, amount) << 8) |
    mixChannel(a & 0xff, b & 0xff, amount)
  );
}

const NIGHT_SKY = 0x0c1628;
const DUSK_SKY = 0xe98a5d;
const DAY_SKY = 0x9dc3dc;
const NIGHT_HEMI_SKY = 0x6b84ad;
const DUSK_HEMI_SKY = 0xcf9a7e;
const DAY_HEMI_SKY = 0xe6f2ff;
const NIGHT_HEMI_GROUND = 0x283444;
const DAY_HEMI_GROUND = 0x38412f;
const DUSK_SUN = 0xff9a5c;
const DAY_SUN = 0xfff4dd;

/**
 * Paramètres complets pour une phase donnée.
 *
 * Les transitions sont continues : aucune discontinuité à l'aube, au
 * crépuscule ou au passage de minuit.
 */
export function sunState(phase: number): SunState {
  const normalized = wrap01(phase);
  // 0,25 -> lever (0), 0,5 -> midi (1), 0,75 -> coucher (0), 0 -> minuit (-1).
  const altitude = Math.sin((normalized - 0.25) * TAU);
  const azimuth = (normalized - 0.25) * TAU;
  const elevation = Math.asin(Math.max(-1, Math.min(1, altitude)));
  const scaledElevation = elevation * (MAX_ELEVATION / (Math.PI / 2));
  const cosElevation = Math.cos(scaledElevation);
  const direction = {
    x: Math.cos(azimuth) * cosElevation,
    y: Math.sin(scaledElevation),
    z: Math.sin(azimuth) * cosElevation,
  };

  const daylight = smoothstep(-0.18, 0.35, altitude);
  const night = 1 - smoothstep(-0.22, 0.06, altitude);
  const warm = smoothstep(-0.05, 0.5, altitude);
  const skyColour =
    altitude >= 0.12
      ? mixColour(DUSK_SKY, DAY_SKY, smoothstep(0.12, 0.55, altitude))
      : mixColour(NIGHT_SKY, DUSK_SKY, smoothstep(-0.35, 0.12, altitude));

  let segment: DaySegment;
  if (night > 0.72) segment = 'night';
  else if (altitude < 0.16) segment = normalized < 0.5 ? 'dawn' : 'dusk';
  else segment = 'day';

  return {
    phase: normalized,
    altitude,
    elevation: scaledElevation,
    azimuth,
    direction,
    colour: mixColour(DUSK_SUN, DAY_SUN, warm),
    intensity: 2.35 * smoothstep(-0.28, 0.3, altitude),
    moonIntensity: 1.0 * smoothstep(0.2, 0.85, night),
    skyColour,
    fogColour: mixColour(skyColour, DAY_SKY, 0.08),
    hemiSky: mixColour(
      mixColour(NIGHT_HEMI_SKY, DUSK_HEMI_SKY, smoothstep(-0.3, 0.14, altitude)),
      DAY_HEMI_SKY,
      smoothstep(0.12, 0.5, altitude),
    ),
    hemiGround: mixColour(NIGHT_HEMI_GROUND, DAY_HEMI_GROUND, daylight),
    ambient: 0.82 + 0.18 * daylight,
    night,
    daylight,
    starOpacity: smoothstep(0.45, 0.95, night),
    segment,
  };
}
