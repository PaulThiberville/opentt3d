/**
 * Générateurs pseudo-aléatoires déterministes du frontend.
 *
 * Toute la génération de monde, la variation des bâtiments et les tests
 * reposent sur ces primitives : elles doivent produire exactement la même
 * séquence pour une graine donnée, en navigateur comme sous Node.
 *
 * Aucune dépendance DOM/Three ici : ce module est utilisable dans le moteur
 * mock, dans la boucle de jeu et dans les tests unitaires.
 */

/** Multiplicateur 32 bits non signé (mulberry32). */
const ADD_32 = 0x6d2b79f5;
/** Bruit additif pour éviter les graines nulles. */
const SEED_SCRAMBLE = 0x9e3779b9;

/** PRNG mulberry32 : rapide, 2^32 états, qualité largement suffisante. */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = ((seed | 0) ^ SEED_SCRAMBLE) >>> 0;
  }

  /** Reconstruit un PRNG depuis un état sérialisé (save/load). */
  static fromState(state: number): Prng {
    const prng = new Prng(0);
    prng.state = state >>> 0;
    return prng;
  }

  /** État interne, sérialisable pour `save()`. */
  getState(): number {
    return this.state;
  }

  clone(): Prng {
    return Prng.fromState(this.state);
  }

  /** Décalage de flux stable, pour les sous-systèmes (terrain, villes…). */
  fork(salt: number): Prng {
    return new Prng((this.state ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0);
  }

  /** Entier 32 bits non signé. */
  nextUint32(): number {
    this.state = (this.state + ADD_32) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Flottant dans [0, 1). */
  next(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Flottant dans [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Entier dans [min, max] inclus. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Vrai avec la probabilité `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** -1 ou +1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Prng.pick: liste vide');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Prng.pick: index invalide');
    return item;
  }

  /** Mélange de Fisher-Yates en place, déterministe. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined) {
        items[i] = b;
        items[j] = a;
      }
    }
    return items;
  }
}

/** Hash 32 bits de deux coordonnées entières, stable et sans allocation. */
export function hash2d(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash 2D ramené dans [0, 1). */
export function hashUnit2d(seed: number, x: number, y: number): number {
  return hash2d(seed, x, y) / 0x100000000;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Bruit de valeur 2D dans [0, 1) : interpolation bilinéaire adoucie d'un
 * treillis de hashes. Suffisant pour des collines et des taches de forêt.
 */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const n00 = hashUnit2d(seed, x0, y0);
  const n10 = hashUnit2d(seed, x0 + 1, y0);
  const n01 = hashUnit2d(seed, x0, y0 + 1);
  const n11 = hashUnit2d(seed, x0 + 1, y0 + 1);
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fy);
}

/** Fractal brownian motion normalisé dans [0, 1]. */
export function fbm(seed: number, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise(seed + i * 1013, x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}

export const FNV_OFFSET = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

/** Accumulateur de hash FNV-1a 32 bits, pour un hash d'état déterministe. */
export class StateHash {
  private value = FNV_OFFSET;

  mixInt(value: number): this {
    this.value = Math.imul((this.value ^ (value | 0)) >>> 0, FNV_PRIME) >>> 0;
    return this;
  }

  /** Mélange un flottant quantifié (évite les écarts de dernière décimale). */
  mixFloat(value: number, scale = 1000): this {
    return this.mixInt(Math.round(value * scale) | 0);
  }

  mixString(text: string): this {
    for (let i = 0; i < text.length; i += 1) this.mixInt(text.charCodeAt(i));
    return this;
  }

  /** Représentation hexadécimale 8 caractères, stable. */
  digest(): string {
    return (this.value >>> 0).toString(16).padStart(8, '0');
  }
}
