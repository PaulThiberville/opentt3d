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

/** Cible cliquable d'un panneau lieu : gare, industrie ou véhicule. */
export interface PlaceTarget {
  kind: 'station' | 'industry' | 'vehicle';
  id: number;
}

export interface PlacePanelItem {
  /** Identifiant stable dans la liste (gare, industrie, véhicule). */
  id: string;
  label: string;
  detail: string;
  /** Présent : l'élément ouvre le panneau correspondant. */
  target?: PlaceTarget;
}

export interface PlacePanelSection {
  id: string;
  title: string;
  empty: string;
  items: PlacePanelItem[];
}

/**
 * Action de panneau lieu. `supported` est faux quand le protocole v1 n'expose
 * pas la commande : le bouton reste désactivé et `reason` explique l'absence.
 */
export interface PlacePanelAction {
  id: string;
  label: string;
  kind: 'focus' | 'unsupported';
  supported: boolean;
  reason?: string;
}

/** Panneau ville, industrie ou gare, alimenté par le seul snapshot. */
export interface PlacePanelView {
  kind: 'town' | 'industry' | 'station';
  id: number;
  /** Centre du lieu, pour recentrer la caméra. */
  x: number;
  y: number;
  title: string;
  detail: string;
  colour: number | null;
  stats: SelectionStat[];
  sections: PlacePanelSection[];
  actions: PlacePanelAction[];
  hint: string;
}

export interface DepotModelView {
  id: string;
  name: string;
  cargo: string;
  capacity: number;
  speed: number;
  cost: number;
  maintenance: number;
  description: string;
  affordable: boolean;
}

export interface DepotVehicleView {
  id: number;
  name: string;
  detail: string;
  canStart: boolean;
  canStop: boolean;
}

export interface DepotPanelView {
  /** Id stable de `snapshot.depots` (transmis à l'achat). */
  id: number;
  x: number;
  y: number;
  kindLabel: string;
  title: string;
  detail: string;
  money: string;
  models: DepotModelView[];
  vehicles: DepotVehicleView[];
  hint: string;
}

export interface VehicleOrderView {
  index: number;
  label: string;
  kind: 'station' | 'industry' | 'depot';
}

export interface VehiclePanelView extends SelectionSummary {
  status: string;
  orders: VehicleOrderView[];
  canStart: boolean;
  canStop: boolean;
  canSell: boolean;
  /** Le prochain clic sur la carte ajoute une gare/dépôt à la tournée. */
  orderPicking: boolean;
  hint: string;
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
  /** Panneau dépôt ouvert (prioritaire sur le panneau de sélection). */
  depot?: DepotPanelView | null;
  /** Panneau véhicule (sélection d'un véhicule). */
  vehicle?: VehiclePanelView | null;
  /** Panneau ville, industrie ou gare (sélection d'un lieu). */
  place?: PlacePanelView | null;
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
