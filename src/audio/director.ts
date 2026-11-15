/**
 * Chef d'orchestre audio : traduit les événements du jeu en sons et met à jour
 * l'ambiance. Il ne connaît ni le DOM ni WebAudio, seulement un `AudioSink`
 * (le moteur réel en production, un espion dans les tests).
 */

import type { EngineCommand, MapSnapshot, WorldSnapshot } from '../engine/protocol';
import type { QualityLevel } from '../render/quality';
import type { AmbienceEnvironment } from './mapping';
import {
  ambienceFromSnapshot,
  distance2D,
  gainForDistance,
  panForOffset,
  passSoundForKind,
  soundForCommand,
  soundForNotification,
  type NotifyKind,
} from './mapping';
import type { ListenerState, PlayOptions } from './AudioEngine';
import type { SoundId } from './soundIds';

export interface AudioSink {
  play(id: SoundId, options?: PlayOptions): boolean;
  playAt(
    id: SoundId,
    position: { x: number; z: number },
    listener: ListenerState,
    options?: PlayOptions,
  ): boolean;
  setAmbience(environment: AmbienceEnvironment): void;
  update(deltaSeconds: number): void;
}

export interface DirectorOptions {
  now?: () => number;
  /** Distance maximale d'un passage de véhicule (tuiles). */
  passDistance?: number;
  /** Passages simultanés traités par snapshot. */
  maxPassesPerSnapshot?: number;
}

const PASS_COOLDOWN_MS = 9_000;
const GLOBAL_PASS_COOLDOWN_MS = 1_400;

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export class AudioDirector {
  private sink: AudioSink;
  private now: () => number;
  private passDistance: number;
  private maxPassesPerSnapshot: number;
  private lastPassAt = new Map<number, number>();
  private lastGlobalPassAt = -Infinity;
  private quality: QualityLevel;

  constructor(sink: AudioSink, quality: QualityLevel = 'medium', options: DirectorOptions = {}) {
    this.sink = sink;
    this.quality = quality;
    this.now = options.now ?? defaultNow;
    this.passDistance = Math.max(1, options.passDistance ?? 16);
    this.maxPassesPerSnapshot = Math.max(0, options.maxPassesPerSnapshot ?? 2);
  }

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
  }

  /** Commande locale acceptée : construction, achat, démarrage… */
  handleCommand(command: EngineCommand): SoundId | null {
    const sound = soundForCommand(command);
    if (!sound) return null;
    return this.sink.play(sound) ? sound : null;
  }

  /**
   * Notification du jeu (news locales ou distantes). Le filtrage écarte les
   * messages informatifs de démarrage pour ne pas transformer le HUD en
   * juke-box ; les avertissements et mouvements d'argent restent audibles.
   */
  handleNotification(kind: NotifyKind, text: string): SoundId | null {
    const sound = soundForNotification(kind, text);
    if (!sound) return null;
    return this.sink.play(sound) ? sound : null;
  }

  /**
   * Met à jour l'ambiance (heure, eau, qualité) et déclenche au plus quelques
   * passages de véhicules proches de la caméra, avec volume et panoramique.
   */
  ingestSnapshot(
    snapshot: WorldSnapshot | null,
    map: MapSnapshot | null,
    listener: ListenerState,
    quality: QualityLevel = this.quality,
    nightOverride?: number,
  ): void {
    this.quality = quality;
    this.sink.setAmbience(ambienceFromSnapshot(snapshot, map, listener, quality, nightOverride));
    if (!snapshot) return;
    const now = this.now();
    if (now - this.lastGlobalPassAt < GLOBAL_PASS_COOLDOWN_MS) return;

    const candidates = snapshot.vehicles
      .filter((vehicle) => vehicle.status === 1 && vehicle.speed > 0)
      .map((vehicle) => ({
        vehicle,
        sound: passSoundForKind(vehicle.kind),
        distance: distance2D(vehicle.x, vehicle.y, listener.x, listener.z),
      }))
      .filter(
        (
          entry,
        ): entry is {
          vehicle: (typeof snapshot.vehicles)[number];
          sound: SoundId;
          distance: number;
        } => entry.sound !== null && entry.distance <= this.passDistance,
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.maxPassesPerSnapshot);

    for (const entry of candidates) {
      const previous = this.lastPassAt.get(entry.vehicle.id);
      if (previous !== undefined && now - previous < PASS_COOLDOWN_MS) continue;
      const gain = gainForDistance(entry.distance, this.passDistance);
      if (gain <= 0.02) continue;
      const pan = panForOffset(
        entry.vehicle.x - listener.x,
        entry.vehicle.y - listener.z,
        listener.yaw,
      );
      if (!this.sink.play(entry.sound, { gain, pan })) continue;
      this.lastPassAt.set(entry.vehicle.id, now);
      this.lastGlobalPassAt = now;
      break;
    }
  }

  frame(deltaSeconds: number): void {
    this.sink.update(deltaSeconds);
  }

  reset(): void {
    this.lastPassAt.clear();
    this.lastGlobalPassAt = -Infinity;
  }
}
