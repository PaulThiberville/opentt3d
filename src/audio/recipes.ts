/**
 * Recettes sonores procédurales.
 *
 * Chaque son est synthétisé à la volée (oscillateurs, bruit filtré, enveloppes
 * courtes) : aucun échantillon ni fichier externe. Les recettes écrivent dans
 * un nœud de destination déjà panoramisé et dosé par `AudioEngine`.
 */

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  BiquadFilterNodeLike,
} from './context';
import type { SoundId } from './soundIds';

interface FilterSpec {
  type: 'lowpass' | 'highpass' | 'bandpass';
  frequency: number;
  q?: number;
}

interface ToneSpec {
  type?: 'sine' | 'square' | 'sawtooth' | 'triangle';
  frequency: number;
  endFrequency?: number;
  duration: number;
  gain: number;
  attack?: number;
  delay?: number;
  filter?: FilterSpec;
}

interface NoiseSpec {
  duration: number;
  gain: number;
  attack?: number;
  delay?: number;
  filter?: FilterSpec;
  playbackRate?: number;
  offset?: number;
}

const MIN_GAIN = 0.0001;

function connectFilter(
  ctx: AudioContextLike,
  source: AudioNodeLike,
  destination: AudioNodeLike,
  spec: FilterSpec | undefined,
): void {
  if (!spec) {
    source.connect(destination);
    return;
  }
  const filter: BiquadFilterNodeLike = ctx.createBiquadFilter();
  filter.type = spec.type;
  filter.frequency.value = spec.frequency;
  filter.Q.value = spec.q ?? 0.7;
  source.connect(filter);
  filter.connect(destination);
}

function envelope(
  ctx: AudioContextLike,
  gainNode: ReturnType<AudioContextLike['createGain']>,
  start: number,
  peak: number,
  attack: number,
  duration: number,
): void {
  const param = gainNode.gain;
  param.setValueAtTime(MIN_GAIN, start);
  param.linearRampToValueAtTime(Math.max(MIN_GAIN, peak), start + attack);
  param.exponentialRampToValueAtTime(MIN_GAIN, start + duration);
}

function tone(ctx: AudioContextLike, destination: AudioNodeLike, t0: number, spec: ToneSpec): void {
  const start = t0 + (spec.delay ?? 0);
  const duration = Math.max(0.02, spec.duration);
  const attack = Math.min(spec.attack ?? 0.008, duration * 0.5);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = spec.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(1, spec.frequency), start);
  if (spec.endFrequency !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.endFrequency), start + duration);
  }
  envelope(ctx, gain, start, spec.gain, attack, duration);
  connectFilter(ctx, osc, gain, spec.filter);
  gain.connect(destination);
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      // Un nœud déjà libéré ne doit jamais interrompre la boucle de jeu.
    }
  };
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function noise(
  ctx: AudioContextLike,
  destination: AudioNodeLike,
  buffer: AudioBufferLike | null,
  t0: number,
  spec: NoiseSpec,
): void {
  if (!buffer) return;
  const start = t0 + (spec.delay ?? 0);
  const duration = Math.max(0.02, spec.duration);
  const attack = Math.min(spec.attack ?? 0.004, duration * 0.5);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = false;
  source.playbackRate.value = spec.playbackRate ?? 1;
  const gain = ctx.createGain();
  envelope(ctx, gain, start, spec.gain, attack, duration);
  connectFilter(ctx, source, gain, spec.filter);
  gain.connect(destination);
  source.onended = () => {
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      // Ignore : le son est déjà terminé.
    }
  };
  source.start(start, spec.offset ?? 0);
  source.stop(start + duration + 0.02);
}

/** Joue une recette sur `destination` à l'instant audio `t0`. */
export function scheduleSound(
  id: SoundId,
  ctx: AudioContextLike,
  destination: AudioNodeLike,
  t0: number,
  buffer: AudioBufferLike | null,
): void {
  switch (id) {
    case 'ui.click':
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 760,
        endFrequency: 640,
        duration: 0.055,
        gain: 0.09,
      });
      noise(ctx, destination, buffer, t0, {
        duration: 0.02,
        gain: 0.025,
        filter: { type: 'highpass', frequency: 1800 },
      });
      return;
    case 'ui.hover':
      tone(ctx, destination, t0, {
        frequency: 1150,
        endFrequency: 1250,
        duration: 0.035,
        gain: 0.035,
        attack: 0.004,
      });
      return;
    case 'ui.notify':
      tone(ctx, destination, t0, { frequency: 740, duration: 0.13, gain: 0.055 });
      tone(ctx, destination, t0, { frequency: 988, duration: 0.16, gain: 0.045, delay: 0.11 });
      return;
    case 'ui.error':
      tone(ctx, destination, t0, {
        type: 'sawtooth',
        frequency: 220,
        endFrequency: 140,
        duration: 0.28,
        gain: 0.07,
        filter: { type: 'lowpass', frequency: 1200 },
      });
      tone(ctx, destination, t0, {
        type: 'square',
        frequency: 110,
        endFrequency: 92,
        duration: 0.2,
        gain: 0.035,
        delay: 0.05,
      });
      return;
    case 'build.road':
      noise(ctx, destination, buffer, t0, {
        duration: 0.16,
        gain: 0.14,
        filter: { type: 'lowpass', frequency: 900 },
      });
      tone(ctx, destination, t0, {
        frequency: 96,
        endFrequency: 68,
        duration: 0.12,
        gain: 0.06,
      });
      return;
    case 'build.rail':
      noise(ctx, destination, buffer, t0, {
        duration: 0.1,
        gain: 0.12,
        filter: { type: 'highpass', frequency: 2200 },
        playbackRate: 1.4,
      });
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 1500,
        endFrequency: 1050,
        duration: 0.09,
        gain: 0.055,
      });
      return;
    case 'build.station':
      tone(ctx, destination, t0, { type: 'triangle', frequency: 523, duration: 0.28, gain: 0.05 });
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 659,
        duration: 0.3,
        gain: 0.045,
        delay: 0.09,
      });
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 784,
        duration: 0.34,
        gain: 0.04,
        delay: 0.18,
      });
      return;
    case 'build.depot':
      noise(ctx, destination, buffer, t0, {
        duration: 0.2,
        gain: 0.11,
        filter: { type: 'lowpass', frequency: 650 },
      });
      tone(ctx, destination, t0, {
        frequency: 168,
        endFrequency: 82,
        duration: 0.22,
        gain: 0.075,
      });
      return;
    case 'build.clear':
      noise(ctx, destination, buffer, t0, {
        duration: 0.2,
        gain: 0.14,
        filter: { type: 'lowpass', frequency: 750 },
        playbackRate: 0.8,
      });
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 210,
        endFrequency: 90,
        duration: 0.18,
        gain: 0.035,
      });
      return;
    case 'vehicle.buy':
      tone(ctx, destination, t0, { frequency: 880, duration: 0.11, gain: 0.055 });
      tone(ctx, destination, t0, { frequency: 1320, duration: 0.16, gain: 0.045, delay: 0.09 });
      noise(ctx, destination, buffer, t0, {
        duration: 0.06,
        gain: 0.03,
        filter: { type: 'highpass', frequency: 3000 },
      });
      return;
    case 'vehicle.start':
      tone(ctx, destination, t0, {
        type: 'sawtooth',
        frequency: 64,
        endFrequency: 118,
        duration: 0.32,
        gain: 0.05,
        filter: { type: 'lowpass', frequency: 520 },
      });
      return;
    case 'vehicle.stop':
      tone(ctx, destination, t0, {
        type: 'sawtooth',
        frequency: 120,
        endFrequency: 54,
        duration: 0.3,
        gain: 0.05,
        filter: { type: 'lowpass', frequency: 480 },
      });
      return;
    case 'vehicle.sell':
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 700,
        endFrequency: 520,
        duration: 0.14,
        gain: 0.05,
      });
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 520,
        endFrequency: 360,
        duration: 0.18,
        gain: 0.045,
        delay: 0.12,
      });
      return;
    case 'money.in':
      tone(ctx, destination, t0, { frequency: 660, duration: 0.09, gain: 0.045 });
      tone(ctx, destination, t0, { frequency: 880, duration: 0.1, gain: 0.04, delay: 0.08 });
      tone(ctx, destination, t0, { frequency: 1100, duration: 0.16, gain: 0.035, delay: 0.16 });
      return;
    case 'money.out':
      tone(ctx, destination, t0, { frequency: 440, duration: 0.11, gain: 0.045 });
      tone(ctx, destination, t0, { frequency: 330, duration: 0.18, gain: 0.04, delay: 0.1 });
      return;
    case 'alert':
      tone(ctx, destination, t0, {
        type: 'square',
        frequency: 1046,
        duration: 0.11,
        gain: 0.04,
        filter: { type: 'lowpass', frequency: 2400 },
      });
      tone(ctx, destination, t0, {
        type: 'square',
        frequency: 1046,
        duration: 0.11,
        gain: 0.04,
        delay: 0.19,
        filter: { type: 'lowpass', frequency: 2400 },
      });
      return;
    case 'train.pass':
      noise(ctx, destination, buffer, t0, {
        duration: 0.9,
        gain: 0.13,
        attack: 0.14,
        filter: { type: 'lowpass', frequency: 520 },
        playbackRate: 0.7,
      });
      tone(ctx, destination, t0, {
        type: 'triangle',
        frequency: 74,
        endFrequency: 58,
        duration: 0.7,
        gain: 0.045,
        attack: 0.1,
      });
      for (const delay of [0.16, 0.36, 0.56]) {
        noise(ctx, destination, buffer, t0, {
          duration: 0.035,
          gain: 0.05,
          delay,
          filter: { type: 'bandpass', frequency: 1800, q: 1.4 },
        });
      }
      return;
    case 'bus.pass':
      tone(ctx, destination, t0, {
        type: 'sawtooth',
        frequency: 108,
        endFrequency: 78,
        duration: 0.5,
        gain: 0.045,
        attack: 0.06,
        filter: { type: 'lowpass', frequency: 760 },
      });
      noise(ctx, destination, buffer, t0, {
        duration: 0.42,
        gain: 0.07,
        attack: 0.05,
        filter: { type: 'bandpass', frequency: 420, q: 0.8 },
        playbackRate: 0.9,
      });
      return;
    default:
      return;
  }
}

/** Pépiement d'oiseau (jour) : deux glissandi courts et aigus. */
export function scheduleBird(
  ctx: AudioContextLike,
  destination: AudioNodeLike,
  t0: number,
  random: () => number,
): void {
  const base = 2300 + random() * 1200;
  tone(ctx, destination, t0, {
    frequency: base,
    endFrequency: base * 1.35,
    duration: 0.075,
    gain: 0.012,
    attack: 0.01,
  });
  tone(ctx, destination, t0, {
    frequency: base * 1.5,
    endFrequency: base * 1.1,
    duration: 0.06,
    gain: 0.009,
    delay: 0.1,
  });
}

/** Grillon (nuit) : trois impulsions aiguës très courtes. */
export function scheduleCricket(
  ctx: AudioContextLike,
  destination: AudioNodeLike,
  t0: number,
  random: () => number,
): void {
  const base = 3900 + random() * 700;
  for (let pulse = 0; pulse < 3; pulse += 1) {
    tone(ctx, destination, t0, {
      frequency: base,
      duration: 0.028,
      gain: 0.008,
      attack: 0.003,
      delay: pulse * 0.055,
    });
  }
}
