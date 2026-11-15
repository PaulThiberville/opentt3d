/**
 * Adaptateur entre une partie (`Game`) et le moteur audio.
 *
 * `GameSession` ne branche que ce module : les abonnements aux événements, le
 * suivi des snapshots et le cycle pause/menu restent ici. Le moteur audio, lui,
 * ignore tout du jeu et du DOM.
 */

import type { MapSnapshot, WorldSnapshot } from '../engine/protocol';
import type { Game } from '../game/Game';
import type { QualityLevel } from '../render/quality';
import type { GameSettings } from '../ui/settings';
import { AudioEngine, volumesFromSettings, type ListenerState } from './AudioEngine';
import { AudioDirector } from './director';
import type { SoundId } from './soundIds';

export interface SessionAudioOptions {
  /** Moteur partagé avec l'application ; sinon la session en crée un. */
  engine?: AudioEngine;
  quality: QualityLevel;
  settings: GameSettings;
  now?: () => number;
}

const AMBIENCE_REFRESH_SECONDS = 0.25;

export class SessionAudio {
  private engine: AudioEngine;
  private ownsEngine: boolean;
  private director: AudioDirector;
  private detach: (() => void)[] = [];
  private quality: QualityLevel;
  private snapshot: WorldSnapshot | null = null;
  private map: MapSnapshot | null = null;
  private listener: ListenerState = { x: 0, z: 0, yaw: 0 };
  private ambienceTimer = 0;
  /** Facteur nuit visuel ; `null` = suivre le calendrier moteur. */
  private dayNightNight: number | null = null;
  private paused = false;
  private gameplay = false;
  private disposed = false;

  constructor(options: SessionAudioOptions) {
    this.ownsEngine = options.engine === undefined;
    this.engine =
      options.engine ?? new AudioEngine({ volumes: volumesFromSettings(options.settings) });
    this.quality = options.quality;
    this.director = new AudioDirector(this.engine, options.quality, {
      ...(options.now ? { now: options.now } : {}),
    });
    this.engine.setVolumes(volumesFromSettings(options.settings));
    this.engine.setQuality(options.quality);
    this.engine.setGameplay(false);
    this.engine.setPaused(true);
  }

  get audioEngine(): AudioEngine {
    return this.engine;
  }

  get isMuted(): boolean {
    return this.engine.isMuted;
  }

  /** Branche les événements de la boucle de jeu ; renvoie un désabonnement. */
  attach(game: Game): void {
    if (this.disposed) return;
    this.gameplay = true;
    this.engine.setPaused(false);
    this.engine.setGameplay(true);
    this.paused = false;
    this.detach.push(
      game.events.on('command', ({ command }) => {
        if (this.disposed || this.paused) return;
        this.director.handleCommand(command);
      }),
      game.events.on('notify', ({ kind, text }) => {
        if (this.disposed || this.paused) return;
        this.director.handleNotification(kind, text);
      }),
    );
  }

  /** Dernier snapshot + carte : l'ambiance (eau, heure) en dépend. */
  ingestSnapshot(snapshot: WorldSnapshot | null, map: MapSnapshot | null): void {
    this.snapshot = snapshot;
    this.map = map;
    this.refreshAmbience();
  }

  setListener(listener: ListenerState): void {
    this.listener = { ...listener };
  }

  setSettings(settings: GameSettings): void {
    this.engine.setVolumes(volumesFromSettings(settings));
  }

  /**
   * Aligne l'ambiance (oiseaux/grillons) sur l'heure **visuelle**. Sans appel,
   * le calendrier moteur reste la référence.
   */
  setDayNight(night: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(night) ? night : 0));
    this.dayNightNight = clamped;
  }

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
    this.engine.setQuality(quality);
    this.director.setQuality(quality);
    this.refreshAmbience();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.engine.setPaused(paused);
  }

  setGameplay(active: boolean): void {
    if (this.gameplay === active) return;
    this.gameplay = active;
    this.engine.setGameplay(active);
  }

  toggleMuted(): boolean {
    return this.engine.toggleMuted();
  }

  setMuted(muted: boolean): void {
    this.engine.setMuted(muted);
  }

  play(id: SoundId): boolean {
    return this.engine.play(id);
  }

  /** À appeler chaque frame : programme les oiseaux/grillons et l'eau. */
  frame(deltaSeconds: number): void {
    if (this.disposed) return;
    this.director.frame(deltaSeconds);
    if (!this.gameplay || this.paused) return;
    this.ambienceTimer += deltaSeconds;
    if (this.ambienceTimer >= AMBIENCE_REFRESH_SECONDS) {
      this.ambienceTimer = 0;
      this.refreshAmbience();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.detach) off();
    this.detach = [];
    this.gameplay = false;
    this.engine.setPaused(true);
    this.engine.setGameplay(false);
    this.snapshot = null;
    this.map = null;
    if (this.ownsEngine) this.engine.dispose();
  }

  private refreshAmbience(): void {
    this.director.ingestSnapshot(
      this.snapshot,
      this.map,
      this.listener,
      this.quality,
      this.dayNightNight ?? undefined,
    );
  }
}
