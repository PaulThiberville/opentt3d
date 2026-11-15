/**
 * Moteur audio procédural partagé par l'application.
 *
 * Responsabilités :
 *  - créer le contexte WebAudio au premier geste (`unlock`) et les bus
 *    master / effets / musique / ambiance ;
 *  - synthétiser les sons d'interface, de construction et de véhicules ;
 *  - entretenir une ambiance douce (vent, eau, oiseaux le jour, grillons la
 *    nuit) sans boucle de fichiers ;
 *  - couper le son quand l'onglet est caché ou que la fenêtre perd le focus.
 *
 * Le moteur ne touche jamais au DOM : l'intégration (gestes, visibilité,
 * boutons du HUD) est faite par `ui.ts`, `SessionAudio` et `main.ts`.
 */

import type { QualityLevel } from '../render/quality';
import {
  clamp01,
  createDefaultAudioContext,
  type AudioBufferLike,
  type AudioContextFactory,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioBufferSourceNodeLike,
  type GainNodeLike,
  type OscillatorNodeLike,
  volumeToGain,
} from './context';
import { ambienceDensity, type AmbienceEnvironment } from './mapping';
import { scheduleBird, scheduleCricket, scheduleSound } from './recipes';
import { isUiSound, type SoundId } from './soundIds';
import { SoundThrottle } from './throttle';

/** Gain maximal de la musique : volontairement très discret. */
export const MUSIC_LEVEL = 0.035;
const NOISE_SECONDS = 2;

export interface AudioVolumes {
  /** 0..100, comme `GameSettings`. */
  master: number;
  effects: number;
  music: number;
}

export interface AudioEngineOptions {
  contextFactory?: AudioContextFactory;
  /** Horloge en millisecondes (throttle). */
  now?: () => number;
  random?: () => number;
  muted?: boolean;
  volumes?: Partial<AudioVolumes>;
  /** Musique d'ambiance (désactivable). */
  music?: boolean;
  quality?: QualityLevel;
}

export interface AudioEngineState {
  unlocked: boolean;
  muted: boolean;
  hidden: boolean;
  focused: boolean;
  paused: boolean;
  gameplay: boolean;
  volumes: AudioVolumes;
}

export interface PlayOptions {
  /** Multiplicateur de volume 0..1 (distance, importance). */
  gain?: number;
  /** Panoramique -1 (gauche) .. 1 (droite). */
  pan?: number;
}

export interface ListenerState {
  x: number;
  z: number;
  yaw: number;
}

const DEFAULT_VOLUMES: AudioVolumes = { master: 70, effects: 80, music: 40 };

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function defaultRandom(): number {
  return Math.random();
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export class AudioEngine {
  private contextFactory: AudioContextFactory;
  private now: () => number;
  private random: () => number;
  private ctx: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private sfx: GainNodeLike | null = null;
  private musicGain: GainNodeLike | null = null;
  private ambienceBus: GainNodeLike | null = null;
  private windGain: GainNodeLike | null = null;
  private waterGain: GainNodeLike | null = null;
  private windSource: AudioBufferSourceNodeLike | null = null;
  private waterSource: AudioBufferSourceNodeLike | null = null;
  private musicNodes: OscillatorNodeLike[] = [];
  private noiseBuffer: AudioBufferLike | null = null;
  private cleanupTimers = new Set<ReturnType<typeof setTimeout>>();
  private throttle = new SoundThrottle();
  private listeners = new Set<(state: AudioEngineState) => void>();
  private volumes: AudioVolumes;
  private musicEnabled: boolean;
  private env: AmbienceEnvironment = {
    night: 0,
    daylight: 1,
    water: 0,
    quality: 'medium',
  };

  private unlocked = false;
  private disposed = false;
  private muted: boolean;
  private hidden = false;
  private focused = true;
  private paused = false;
  private gameplay = false;
  private ambienceClock = 0;
  private nextAmbienceAt = 1.2;

  constructor(options: AudioEngineOptions = {}) {
    this.contextFactory = options.contextFactory ?? createDefaultAudioContext;
    this.now = options.now ?? defaultNow;
    this.random = options.random ?? defaultRandom;
    this.volumes = { ...DEFAULT_VOLUMES, ...options.volumes };
    this.volumes.master = clampVolume(this.volumes.master);
    this.volumes.effects = clampVolume(this.volumes.effects);
    this.volumes.music = clampVolume(this.volumes.music);
    this.musicEnabled = options.music ?? true;
    this.muted = options.muted ?? false;
    if (options.quality) this.env.quality = options.quality;
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  get currentVolumes(): AudioVolumes {
    return { ...this.volumes };
  }

  /** Crée le contexte et démarre l'ambiance. À appeler sur le premier geste. */
  unlock(): void {
    if (this.disposed || this.unlocked) return;
    let ctx: AudioContextLike | null = null;
    try {
      ctx = this.contextFactory();
    } catch {
      // Navigateur sans WebAudio ou création refusée : moteur silencieux.
    }
    if (!ctx) {
      this.emit();
      return;
    }
    this.ctx = ctx;
    this.unlocked = true;
    this.buildGraph();
    this.resumeContext();
    this.emit();
  }

  /** Applique les volumes persistés (0..100). */
  setVolumes(patch: Partial<AudioVolumes>): void {
    if (patch.master !== undefined) this.volumes.master = clampVolume(patch.master);
    if (patch.effects !== undefined) this.volumes.effects = clampVolume(patch.effects);
    if (patch.music !== undefined) this.volumes.music = clampVolume(patch.music);
    this.applyGains();
    this.emit();
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.applyGains();
    this.emit();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Onglet caché : suspension complète, reprise à la réactivation. */
  setTabHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.applyGains();
    if (hidden) this.suspendContext();
    else this.resumeContext();
    this.emit();
  }

  /** Perte de focus de la fenêtre : même traitement que l'onglet caché. */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.applyGains();
    this.emit();
  }

  /** Pause/menu : seuls les sons d'interface restent audibles. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.applyGains();
    this.emit();
  }

  /** Ambiance et musique actives uniquement pendant une partie. */
  setGameplay(active: boolean): void {
    if (this.gameplay === active) return;
    this.gameplay = active;
    if (active) {
      this.ambienceClock = 0;
      this.nextAmbienceAt = 1.2;
    }
    this.applyGains();
    this.emit();
  }

  setQuality(quality: QualityLevel): void {
    this.env = { ...this.env, quality };
  }

  setAmbience(environment: AmbienceEnvironment): void {
    this.env = { ...environment };
    this.applyAmbienceGains();
  }

  /** Avance l'horloge d'ambiance et programme oiseaux/grillons. */
  update(deltaSeconds: number): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || !this.activeAmbience()) return;
    const delta = Math.max(0, Math.min(1, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
    this.ambienceClock += delta;
    if (this.ambienceClock < this.nextAmbienceAt) return;
    if (this.env.quality === 'low' || !this.ambienceBus) return;

    const destination = this.ambienceBus;
    const t0 = ctx.currentTime;
    const night = this.env.night >= 0.5;
    if (night) scheduleCricket(ctx, destination, t0, this.random);
    else scheduleBird(ctx, destination, t0, this.random);

    const density = Math.max(0.2, ambienceDensity(this.env.quality));
    const base = night ? 1.5 : 5.2;
    const spread = night ? 1.4 : 2.6;
    this.nextAmbienceAt = this.ambienceClock + (base + this.random() * spread) / density;
  }

  /** Joue un son court. Renvoie `false` si muet, suspendu, en pause ou throttlé. */
  play(id: SoundId, options: PlayOptions = {}): boolean {
    const ctx = this.ctx;
    if (!ctx || this.disposed || !this.unlocked) return false;
    if (this.muted || this.hidden || !this.focused) return false;
    if (this.paused && !isUiSound(id)) return false;
    if (!this.gameplay && !isUiSound(id)) return false;
    if (!this.throttle.allow(id, this.now())) return false;
    const gain = clamp01(options.gain ?? 1);
    if (gain <= 0.005) return false;
    this.schedule(id, gain, options.pan ?? 0);
    return true;
  }

  /** Joue un son spatialisé : volume par distance, panoramique par position. */
  playAt(
    id: SoundId,
    position: { x: number; z: number },
    listener: ListenerState,
    options: PlayOptions = {},
  ): boolean {
    const dx = position.x - listener.x;
    const dz = position.z - listener.z;
    const distance = Math.hypot(dx, dz);
    const maxDistance = 26;
    if (distance > maxDistance) return false;
    const falloff = 1 - distance / maxDistance;
    const gain = clamp01((options.gain ?? 1) * falloff * falloff);
    if (gain <= 0.01) return false;
    const rightX = Math.cos(listener.yaw);
    const rightZ = -Math.sin(listener.yaw);
    const pan = Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / 14));
    return this.play(id, { gain, pan });
  }

  subscribe(listener: (state: AudioEngineState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AudioEngineState {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      hidden: this.hidden,
      focused: this.focused,
      paused: this.paused,
      gameplay: this.gameplay,
      volumes: { ...this.volumes },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const timer of this.cleanupTimers) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.stopSource(this.windSource);
    this.stopSource(this.waterSource);
    this.windSource = null;
    this.waterSource = null;
    for (const osc of this.musicNodes) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // Déjà arrêté : sans conséquence.
      }
    }
    this.musicNodes = [];
    for (const node of [
      this.windGain,
      this.waterGain,
      this.ambienceBus,
      this.musicGain,
      this.sfx,
      this.master,
    ]) {
      try {
        node?.disconnect();
      } catch {
        // Déconnexion idempotente.
      }
    }
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.musicGain = null;
    this.ambienceBus = null;
    this.windGain = null;
    this.waterGain = null;
    if (ctx) {
      try {
        void ctx.close().catch(() => undefined);
      } catch {
        // Un contexte déjà fermé n'est pas une erreur.
      }
    }
    this.unlocked = false;
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.connect(this.master);
    this.ambienceBus = ctx.createGain();
    this.ambienceBus.connect(this.sfx);
    this.noiseBuffer = this.createNoiseBuffer(ctx);
    this.startAmbienceLayers();
    this.startMusic();
    this.applyGains();
  }

  private createNoiseBuffer(ctx: AudioContextLike): AudioBufferLike | null {
    try {
      const sampleRate =
        Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
      const buffer = ctx.createBuffer(1, Math.round(sampleRate * NOISE_SECONDS), sampleRate);
      const data = buffer.getChannelData(0);
      let previous = 0;
      for (let index = 0; index < data.length; index += 1) {
        const white = this.random() * 2 - 1;
        // Léger lissage : bruit brun, plus doux pour le vent et l'eau.
        previous = previous * 0.82 + white * 0.18;
        data[index] = previous;
      }
      return buffer;
    } catch {
      return null;
    }
  }

  private startAmbienceLayers(): void {
    const ctx = this.ctx;
    const buffer = this.noiseBuffer;
    const bus = this.ambienceBus;
    if (!ctx || !buffer || !bus) return;

    const windSource = ctx.createBufferSource();
    windSource.buffer = buffer;
    windSource.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 340;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(bus);
    windSource.start();
    this.windSource = windSource;
    this.windGain = windGain;

    const waterSource = ctx.createBufferSource();
    waterSource.buffer = buffer;
    waterSource.loop = true;
    const waterFilter = ctx.createBiquadFilter();
    waterFilter.type = 'bandpass';
    waterFilter.frequency.value = 760;
    waterFilter.Q.value = 0.6;
    const waterGain = ctx.createGain();
    waterSource.connect(waterFilter);
    waterFilter.connect(waterGain);
    waterGain.connect(bus);
    waterSource.start(0, 0.7);
    this.waterSource = waterSource;
    this.waterGain = waterGain;

    this.applyAmbienceGains();
  }

  private startMusic(): void {
    const ctx = this.ctx;
    const output = this.musicGain;
    if (!this.musicEnabled || !ctx || !output) return;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 820;
    filter.Q.value = 0.4;
    filter.connect(output);
    for (const [frequency, detune] of [
      [110, -4],
      [164.81, 5],
      [220, -7],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
      this.musicNodes.push(osc);
    }
  }

  private schedule(id: SoundId, gain: number, pan: number): void {
    const ctx = this.ctx;
    const bus = this.sfx;
    if (!ctx || !bus) return;
    const voice = ctx.createGain();
    voice.gain.value = gain;
    const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    let output: AudioNodeLike = voice;
    if (panner) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      voice.connect(panner);
      output = panner;
    }
    output.connect(bus);
    try {
      scheduleSound(id, ctx, output, ctx.currentTime, this.noiseBuffer);
    } catch {
      // Un échec de synthèse ne doit jamais remonter dans la boucle de jeu.
    }
    // Les recettes déconnectent leurs oscillateurs/sources, pas la voix ni le
    // panoramique partagés : on libère ces deux nœuds une fois le son terminé.
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      try {
        voice.disconnect();
        panner?.disconnect();
      } catch {
        // Contexte déjà fermé : rien à libérer.
      }
    }, 2_000);
    this.cleanupTimers.add(timer);
  }

  private activeAmbience(): boolean {
    return (
      this.gameplay &&
      !this.paused &&
      !this.muted &&
      !this.hidden &&
      this.focused &&
      this.ctx !== null
    );
  }

  private applyGains(): void {
    const silenced = this.muted || this.hidden || !this.focused;
    if (this.master) {
      this.master.gain.value = silenced ? 0 : volumeToGain(this.volumes.master);
    }
    if (this.sfx) {
      this.sfx.gain.value = silenced ? 0 : volumeToGain(this.volumes.effects);
    }
    if (this.musicGain) {
      const active = this.gameplay && !this.paused && !silenced;
      this.musicGain.gain.value = active ? volumeToGain(this.volumes.music) * MUSIC_LEVEL : 0;
    }
    this.applyAmbienceGains();
  }

  private applyAmbienceGains(): void {
    if (this.ambienceBus) {
      this.ambienceBus.gain.value = this.activeAmbience() ? 1 : 0;
    }
    if (this.windGain) {
      this.windGain.gain.value = 0.16 + this.env.night * 0.07;
    }
    if (this.waterGain) {
      this.waterGain.gain.value = clamp01(this.env.water) * 0.5;
    }
  }

  private resumeContext(): void {
    const ctx = this.ctx;
    if (!ctx || this.hidden) return;
    try {
      void ctx.resume().catch(() => undefined);
    } catch {
      // Safari peut refuser hors geste ; le prochain geste réessaiera.
    }
  }

  private suspendContext(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      void ctx.suspend().catch(() => undefined);
    } catch {
      // Certains contextes factices n'implémentent pas suspend.
    }
  }

  private stopSource(source: AudioBufferSourceNodeLike | null): void {
    if (!source) return;
    try {
      source.stop();
      source.disconnect();
    } catch {
      // Source déjà arrêtée.
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

/** Conversion « réglages audio » vers le patch attendu par `setVolumes`. */
export function volumesFromSettings(settings: {
  masterVolume: number;
  effectsVolume: number;
  musicVolume: number;
}): AudioVolumes {
  return {
    master: settings.masterVolume,
    effects: settings.effectsVolume,
    music: settings.musicVolume,
  };
}
