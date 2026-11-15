/**
 * Types partagés par les composants d'interface.
 *
 * Aucun accès DOM : uniquement des formes de données consommées par le HUD,
 * les écrans et les modules purs.
 */

import type { WorldSnapshot } from '../engine/protocol';
import type { GameSpeed, Selection } from '../game/Game';
import type { QualityLevel } from '../render/quality';
import type { NewsKind } from './news';

export interface SelectionStat {
  label: string;
  value: string;
  tone?: 'muted' | 'good' | 'bad';
}

export interface SelectionSummary {
  selection: Selection;
  title: string;
  detail: string;
  stats: SelectionStat[];
  colour: number | null;
}

export interface CameraView {
  targetX: number;
  targetZ: number;
  /** Hauteur du point visé (unités monde). */
  targetY?: number;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface NetworkStatusView {
  text: string;
  tone: 'ok' | 'wait' | 'warn' | 'error';
}

export interface HudState {
  snapshot: WorldSnapshot | null;
  fps: number;
  paused: boolean;
  speed: GameSpeed;
  selection: SelectionSummary | null;
  quality: QualityLevel;
  following: boolean;
  drawCalls: number;
  /** Pause et vitesse sont séquencées par l'hôte en réseau. */
  controlsLocked?: boolean;
  networkStatus?: NetworkStatusView | null;
}

export interface NewsFeedItem {
  id: number;
  kind: NewsKind;
  text: string;
  dateLabel: string;
  read: boolean;
}

export interface SessionOverview {
  company: string;
  date: string;
  money: string;
  vehicles: number;
  stations: number;
}

export interface GameOverSummary {
  title: string;
  reason: string;
  company: string;
  money: string;
  value: string;
  vehicles: number;
  stations: number;
  date: string;
}
