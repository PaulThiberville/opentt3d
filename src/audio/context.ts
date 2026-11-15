/**
 * Sous-ensemble structurel de l'API WebAudio utilisé par `AudioEngine`.
 *
 * Le moteur ne dépend pas du DOM : il ne manipule que ces interfaces. Les tests
 * fournissent un faux contexte qui enregistre les nœuds créés, tandis que le
 * navigateur passe un vrai `AudioContext` (converti une seule fois).
 */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
  cancelScheduledValues(startTime: number): void;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): void;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface StereoPannerNodeLike extends AudioNodeLike {
  pan: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  /** `lowpass`, `bandpass`, `highpass`… */
  type: string;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  /** `sine`, `square`, `sawtooth`, `triangle`. */
  type: string;
  frequency: AudioParamLike;
  detune: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

export interface AudioBufferLike {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  playbackRate: AudioParamLike;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  /** `suspended`, `running`, `closed`… */
  readonly state: string;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createStereoPanner?(): StereoPannerNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export type AudioContextFactory = () => AudioContextLike | null;

interface AudioContextConstructor {
  new (): unknown;
}

/**
 * Récupère le constructeur natif : `AudioContext` partout, `webkitAudioContext`
 * sur les Safari anciens. Renvoie `null` sous Node ou si le navigateur refuse
 * la création (mode privé, politique restrictive).
 */
export function createDefaultAudioContext(): AudioContextLike | null {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Constructor) return null;
  try {
    return new Constructor() as AudioContextLike;
  } catch {
    return null;
  }
}

/** Valeur bornée dans [0, 1]. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Convertit un volume 0..100 (réglages) en gain 0..1. */
export function volumeToGain(volume: number): number {
  return clamp01((Number.isFinite(volume) ? volume : 0) / 100);
}
