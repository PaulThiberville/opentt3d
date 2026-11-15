/**
 * HUD tycoon : assemble la barre supérieure, le panneau de sélection, la
 * minimap, le flux d'actualités, la barre d'outils, l'aide et les toasts.
 *
 * Le HUD ne simule rien : il affiche le dernier snapshot et les événements
 * relayés par `Game`. Les écritures DOM sont limitées aux valeurs qui changent.
 */

import type { GameSpeed } from '../game/Game';
import type { BuildSettings } from '../game/buildRules';
import { createBuildSettings } from '../game/buildRules';
import type { QualityLevel } from '../render/quality';
import type { BuildHintView } from './buildHint';
import { el } from './dom';
import { t } from './i18n';
import { formatShortGameDate, type GameDateLike } from './format';
import { NewsQueue, type NewsKind } from './news';
import type { CameraView, HudState, SelectionSummary } from './types';
import { BuildHint } from './hud/BuildHint';
import { BuildOptions } from './hud/BuildOptions';
import { DepotPanel } from './hud/DepotPanel';
import { HelpPanel } from './hud/HelpPanel';
import { Minimap } from './hud/Minimap';
import { NewsFeed } from './hud/NewsFeed';
import { SelectionPanel } from './hud/SelectionPanel';
import { Toasts } from './hud/Toasts';
import { Toolbar, type BuildToolId } from './hud/Toolbar';
import { TopBar } from './hud/TopBar';
import { VehiclePanel } from './hud/VehiclePanel';

export interface HudCallbacks {
  onTogglePause: () => void;
  onSpeedChange: (speed: GameSpeed) => void;
  onResetView: () => void;
  onCycleQuality: () => void;
  onOpenSettings: () => void;
  onClearSelection: () => void;
  onRecenterCamera: (x: number, y: number) => void;
  onBuildToolChange: (tool: BuildToolId) => void;
  onBuildSettingsChange: (settings: BuildSettings) => void;
  onBuildRotate: () => void;
  /** Panneau dépôt : achat, sélection, démarrage et vente. */
  onBuyVehicle: (modelId: string) => void;
  onSelectVehicle: (vehicleId: number) => void;
  onStartVehicle: (vehicleId: number) => void;
  onStopVehicle: (vehicleId: number) => void;
  onSellVehicle: (vehicleId: number) => void;
  onCloseDepot: () => void;
  /** Éditeur de tournée du panneau véhicule. */
  onAddOrder: (vehicleId: number) => void;
  onRemoveOrder: (vehicleId: number, index: number) => void;
  onMoveOrder: (vehicleId: number, index: number, delta: -1 | 1) => void;
  onCloseVehicle: () => void;
  /** Coupe ou rétablit le son (bouton minimal de la barre supérieure). */
  onToggleAudio?: () => void;
}

export interface HudNewsInput {
  kind: NewsKind;
  text: string;
  tick: number;
  date: GameDateLike | null;
}

export type { SelectionSummary, HudState, QualityLevel };

export class Hud {
  readonly root: HTMLDivElement;
  readonly news = new NewsQueue();

  private callbacks: HudCallbacks;
  private topBar: TopBar;
  private audioButton: HTMLButtonElement;
  private selectionPanel: SelectionPanel;
  private depotPanel: DepotPanel;
  private vehiclePanel: VehiclePanel;
  private minimap: Minimap;
  private newsFeed: NewsFeed;
  private toolbar: Toolbar;
  private buildHint: BuildHint;
  private buildOptions: BuildOptions;
  private help: HelpPanel;
  private toasts: Toasts;
  private networkStatus: HTMLDivElement;
  private errorOverlay: HTMLDivElement;
  private errorTitle: HTMLHeadingElement;
  private errorMessage: HTMLParagraphElement;
  private retryButton: HTMLButtonElement;

  constructor(mount: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.root = el('div', { className: 'hud' });

    this.topBar = new TopBar({
      onTogglePause: () => this.callbacks.onTogglePause(),
      onSpeedChange: (speed) => this.callbacks.onSpeedChange(speed),
      onResetView: () => this.callbacks.onResetView(),
      onCycleQuality: () => this.callbacks.onCycleQuality(),
      onToggleNews: () => this.toggleNews(),
      onToggleHelp: () => this.toggleHelp(),
      onOpenSettings: () => this.callbacks.onOpenSettings(),
    });

    // Bouton mute minimal : ajouté à la barre d'outils existante sans modifier
    // `TopBar`, pour limiter les conflits avec les autres vagues UI.
    this.audioButton = el('button', {
      className: 'hud-button hud-audio-button',
      text: '🔊',
      attrs: {
        type: 'button',
        title: 'Couper le son',
        'aria-label': 'Couper le son',
        'aria-pressed': 'false',
      },
    });
    this.audioButton.addEventListener('click', () => this.callbacks.onToggleAudio?.());
    this.audioButton.hidden = this.callbacks.onToggleAudio === undefined;
    const tools = this.topBar.element.querySelector('.hud-tools');
    (tools ?? this.topBar.element).append(this.audioButton);

    this.selectionPanel = new SelectionPanel({
      onClear: () => this.callbacks.onClearSelection(),
    });

    this.depotPanel = new DepotPanel({
      onBuy: (modelId) => this.callbacks.onBuyVehicle(modelId),
      onSelectVehicle: (vehicleId) => this.callbacks.onSelectVehicle(vehicleId),
      onStartVehicle: (vehicleId) => this.callbacks.onStartVehicle(vehicleId),
      onSellVehicle: (vehicleId) => this.callbacks.onSellVehicle(vehicleId),
      onClose: () => this.callbacks.onCloseDepot(),
    });

    this.vehiclePanel = new VehiclePanel({
      onClear: () => this.callbacks.onCloseVehicle(),
      onStart: (vehicleId) => this.callbacks.onStartVehicle(vehicleId),
      onStop: (vehicleId) => this.callbacks.onStopVehicle(vehicleId),
      onSell: (vehicleId) => this.callbacks.onSellVehicle(vehicleId),
      onAddOrder: (vehicleId) => this.callbacks.onAddOrder(vehicleId),
      onRemoveOrder: (vehicleId, index) => this.callbacks.onRemoveOrder(vehicleId, index),
      onMoveOrder: (vehicleId, index, delta) => this.callbacks.onMoveOrder(vehicleId, index, delta),
    });

    this.minimap = new Minimap({
      onRecenter: (x, y) => this.callbacks.onRecenterCamera(x, y),
    });

    this.newsFeed = new NewsFeed({
      onMarkAllRead: () => this.markAllRead(),
      onRead: (id) => {
        if (this.news.markRead(id)) this.refreshNews();
      },
      onClose: () => this.closeNews(),
    });

    this.toolbar = new Toolbar({
      onToggleTool: (tool) => this.callbacks.onBuildToolChange(tool),
    });

    this.buildHint = new BuildHint();
    this.buildOptions = new BuildOptions(
      {
        onChange: (settings) => this.callbacks.onBuildSettingsChange(settings),
        onRotate: () => this.callbacks.onBuildRotate(),
      },
      createBuildSettings(),
    );
    this.help = new HelpPanel();
    this.toasts = new Toasts();
    this.networkStatus = el('div', {
      className: 'hud-net',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.networkStatus.hidden = true;

    this.errorOverlay = el('div', {
      className: 'hud-overlay hud-error',
      attrs: {
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-live': 'assertive',
        'aria-labelledby': 'hud-error-title',
      },
    });
    const card = el('div', { className: 'hud-overlay-card' });
    this.errorTitle = el('h2', {
      text: t('hud.error'),
      attrs: { id: 'hud-error-title' },
    });
    this.errorMessage = el('p', { text: '' });
    const retry = el('button', {
      className: 'btn btn-primary hud-retry',
      text: t('hud.reload'),
      attrs: { type: 'button' },
    });
    retry.addEventListener('click', () => window.location.reload());
    card.append(this.errorTitle, this.errorMessage, retry);
    this.errorOverlay.append(card);
    this.errorOverlay.hidden = true;
    this.retryButton = retry;

    this.root.append(
      this.topBar.element,
      this.selectionPanel.element,
      this.depotPanel.element,
      this.vehiclePanel.element,
      this.minimap.element,
      this.newsFeed.element,
      this.toolbar.element,
      this.buildOptions.element,
      this.buildHint.element,
      this.help.element,
      this.toasts.element,
      this.networkStatus,
      this.errorOverlay,
    );
    mount.append(this.root);
    document.addEventListener('keydown', this.handleEscape);

    this.refreshNews();
  }

  /**
   * Échap ferme les panneaux même quand le focus est sur un de leurs boutons :
   * la session ignore les raccourcis ciblant un contrôle interactif.
   */
  private handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (document.querySelector('.screen.is-visible')) return;
    if (this.closePanels()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // La session ignore Échap quand le focus est sur un contrôle interactif.
    // On rend le focus au canvas puis on rejoue l'événement dans son contexte,
    // pour que le menu de pause reste accessible après un passage dans le HUD.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest('.hud')) return;
    const canvas = document.querySelector<HTMLElement>('#scene');
    if (!canvas) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.focus();
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  update(state: HudState): void {
    this.topBar.update(state);
    this.updateNetworkStatus(state);
    // Le panneau véhicule est prioritaire sur le dépôt, lui-même prioritaire
    // sur le panneau de sélection générique.
    const vehicle = state.vehicle ?? null;
    const depot = vehicle ? null : (state.depot ?? null);
    this.depotPanel.update(depot);
    this.vehiclePanel.update(vehicle);
    const panelsOpen = vehicle !== null || depot !== null;
    this.selectionPanel.update(
      panelsOpen ? null : state.selection,
      panelsOpen ? false : state.following,
    );
    this.minimap.setSnapshot(state.snapshot);
    this.minimap.setSelection(state.selection?.selection ?? null);
    this.refreshNewsBadge();
    if (this.newsFeed.isOpen()) this.renderNewsList();
  }

  private updateNetworkStatus(state: HudState): void {
    const status = state.networkStatus;
    if (!status) {
      this.networkStatus.hidden = true;
      return;
    }
    this.networkStatus.hidden = false;
    this.networkStatus.textContent = status.text;
    this.networkStatus.dataset.tone = status.tone;
  }

  updateCamera(view: CameraView, aspect: number): void {
    this.minimap.setCamera(view, aspect);
  }

  /** Ajoute une news horodatée et affiche un toast. */
  pushNews(input: HudNewsInput): void {
    const item = this.news.add({
      kind: input.kind,
      text: input.text,
      tick: input.tick,
      dateLabel: formatShortGameDate(input.date),
    });
    if (!item) return;
    this.refreshNews();
    this.toasts.push(input.kind, input.text);
  }

  /** Message éphémère non archivé dans le flux. */
  notify(kind: NewsKind, text: string): void {
    this.toasts.push(kind, text);
  }

  /** Reflète l'outil de construction armé dans la barre du bas. */
  setBuildTool(tool: BuildToolId | null): void {
    this.toolbar.setActive(tool);
  }

  /** Met à jour le bouton mute (état réel du moteur audio). */
  setAudioMuted(muted: boolean): void {
    this.audioButton.textContent = muted ? '🔇' : '🔊';
    this.audioButton.title = muted ? 'Rétablir le son' : 'Couper le son';
    this.audioButton.setAttribute('aria-label', this.audioButton.title);
    this.audioButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
    this.audioButton.classList.toggle('is-active', muted);
  }

  /** Affiche le coût estimé et le motif d'invalidité au-dessus de la barre. */
  setBuildHint(view: BuildHintView | null): void {
    this.buildHint.update(view);
  }

  /** Affiche les réglages de gare/dépôt/signal pour l'outil armé. */
  setBuildOptions(tool: BuildToolId | null, settings: BuildSettings): void {
    this.buildOptions.update(tool, settings);
  }

  toggleNews(): void {
    if (this.newsFeed.isOpen()) {
      this.closeNews();
      return;
    }
    this.newsFeed.show();
    this.topBar.setNewsOpen(true);
    this.markAllRead();
    this.renderNewsList();
  }

  closeNews(): void {
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement &&
      (this.newsFeed.element.contains(active) || !active.isConnected);
    this.newsFeed.hide();
    this.topBar.setNewsOpen(false);
    if (restore) this.topBar.focusNewsButton();
  }

  markAllRead(): void {
    this.news.markAllRead();
    this.refreshNews();
  }

  toggleHelp(): void {
    this.help.toggle();
    if (this.help.isOpen()) this.closeNews();
  }

  hideHelp(): void {
    this.help.hide();
  }

  isHelpOpen(): boolean {
    return this.help.isOpen();
  }

  isNewsOpen(): boolean {
    return this.newsFeed.isOpen();
  }

  closePanels(): boolean {
    let closed = false;
    if (this.newsFeed.isOpen()) {
      this.closeNews();
      closed = true;
    }
    if (this.help.isOpen()) {
      this.hideHelp();
      closed = true;
    }
    return closed;
  }

  showError(title: string, message: string): void {
    this.errorTitle.textContent = title;
    this.errorMessage.textContent = message;
    this.errorOverlay.hidden = false;
    this.retryButton.focus();
  }

  private refreshNewsBadge(): void {
    this.topBar.setUnread(this.news.unreadCount());
  }

  private refreshNews(): void {
    this.refreshNewsBadge();
    if (this.newsFeed.isOpen()) this.renderNewsList();
  }

  private renderNewsList(): void {
    this.newsFeed.update(this.news.list(), this.news.unreadCount());
  }

  dispose(): void {
    document.removeEventListener('keydown', this.handleEscape);
    this.topBar.dispose();
    this.toolbar.dispose();
    this.help.dispose();
    this.selectionPanel.dispose();
    this.newsFeed.dispose();
    this.toasts.dispose();
    this.buildHint.dispose();
    this.buildOptions.dispose();
    this.buildOptions.element.remove();
    this.minimap.dispose();
    this.news.clear();
    this.root.remove();
  }
}
