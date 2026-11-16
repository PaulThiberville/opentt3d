/**
 * HUD tycoon : assemble la barre supérieure, le panneau de sélection, la
 * minimap, le flux d'actualités, la barre d'outils, l'aide et les toasts.
 *
 * Le HUD ne simule rien : il affiche le dernier snapshot et les événements
 * relayés par `Game`. Les écritures DOM sont limitées aux valeurs qui changent.
 */

import type { GameSpeed } from '../game/Game';
import type { OrderOptions, TownActionKind, VehicleKind } from '../engine/protocol';
import type { BuildSettings } from '../game/buildRules';
import { createBuildSettings } from '../game/buildRules';
import type { QualityLevel } from '../render/quality';
import type { BuildHintView } from './buildHint';
import { el } from './dom';
import { onLanguageChange, t } from './i18n';
import { formatShortGameDate, type GameDateLike } from './format';
import { NewsQueue, type NewsKind } from './news';
import type { NetworkAlertView } from './netlobby';
import type { CameraView, HudState, PlaceTarget, SelectionSummary } from './types';
import { BuildHint } from './hud/BuildHint';
import { BuildOptions } from './hud/BuildOptions';
import { DepotPanel } from './hud/DepotPanel';
import { FinancesPanel } from './hud/FinancesPanel';
import { HelpPanel } from './hud/HelpPanel';
import { Minimap } from './hud/Minimap';
import { NetworkAlert } from './hud/NetworkAlert';
import { NewsFeed } from './hud/NewsFeed';
import { PlacePanel } from './hud/PlacePanel';
import { ReportsPanel, type ReportTab } from './hud/ReportsPanel';
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
  /** Refit, options d'ordre, partage et duplication (#160/#161). */
  onRefitVehicle: (vehicleId: number, cargo: string) => void;
  onUpdateOrder: (vehicleId: number, index: number, options: OrderOptions) => void;
  onAddConditionalOrder: (vehicleId: number) => void;
  onShareOrders: (vehicleId: number, targetId: number) => void;
  onCloneVehicle: (vehicleId: number) => void;
  /** Entretien et envoi au dépôt (#163). */
  onServiceVehicle: (vehicleId: number) => void;
  onSendVehicleToDepot: (vehicleId: number) => void;
  /** Groupes de véhicules et actions groupées (#164). */
  onCreateGroup: (kind: VehicleKind, name: string) => void;
  onRenameGroup: (groupId: number, name: string) => void;
  onDeleteGroup: (groupId: number) => void;
  onAssignVehicleGroup: (vehicleId: number, groupId: number | null) => void;
  onGroupAction: (groupId: number, action: 'start' | 'stop' | 'send_to_depot' | 'sell') => void;
  onGroupAutoreplace: (groupId: number, model: string | null, whenOld: boolean) => void;
  onCloseVehicle: () => void;
  /** Panneau ville/industrie/gare : recentrage et navigation entre lieux. */
  onPlaceFocus: (x: number, y: number) => void;
  onPlaceSelect: (target: PlaceTarget) => void;
  onClosePlace: () => void;
  /** Coupe ou rétablit le son (bouton minimal de la barre supérieure). */
  onToggleAudio?: () => void;
  /** Ouvre/ferme le mode photo (bouton appareil). */
  onPhotoMode?: () => void;
  /** Panneau finances (#165). */
  onToggleFinances: () => void;
  onIncreaseLoan: () => void;
  onDecreaseLoan: () => void;
  /** Action municipale depuis le panneau ville (#166). */
  onTownAction: (townId: number, action: TownActionKind) => void;
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
  private photoButton: HTMLButtonElement;
  private audioMuted = false;
  private stopAudioLanguage: () => void;
  private selectionPanel: SelectionPanel;
  private depotPanel: DepotPanel;
  private vehiclePanel: VehiclePanel;
  private placePanel: PlacePanel;
  private reports: ReportsPanel;
  private financePanel: FinancesPanel;
  private bankruptcyAlert: HTMLDivElement;
  private bankruptcyText: HTMLSpanElement;
  private minimap: Minimap;
  private newsFeed: NewsFeed;
  private toolbar: Toolbar;
  private buildHint: BuildHint;
  private buildOptions: BuildOptions;
  private help: HelpPanel;
  private toasts: Toasts;
  private networkStatus: HTMLDivElement;
  private networkAlert: NetworkAlert;
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
      onOpenReports: (tab) => this.openReports(tab),
      onToggleFinances: () => this.callbacks.onToggleFinances(),
    });

    // Bouton mute minimal : ajouté à la barre d'outils existante sans modifier
    // `TopBar`, pour limiter les conflits avec les autres vagues UI.
    this.audioButton = el('button', {
      className: 'hud-button hud-audio-button',
      text: '🔊',
      attrs: {
        type: 'button',
        title: t('hud.audio.mute'),
        'aria-label': t('hud.audio.mute'),
        'aria-pressed': 'false',
      },
    });
    this.audioButton.addEventListener('click', () => this.callbacks.onToggleAudio?.());
    this.audioButton.hidden = this.callbacks.onToggleAudio === undefined;
    this.stopAudioLanguage = onLanguageChange(() => this.refreshAudioLabel());
    const tools = this.topBar.element.querySelector('.hud-tools');
    (tools ?? this.topBar.element).append(this.audioButton);

    // Mode photo : même emplacement discret que le bouton son.
    this.photoButton = el('button', {
      className: 'hud-button hud-photo-button',
      text: '📷',
      attrs: {
        type: 'button',
        title: t('photo.open'),
        'aria-label': t('photo.open'),
        'aria-pressed': 'false',
      },
    });
    this.photoButton.addEventListener('click', () => this.callbacks.onPhotoMode?.());
    this.photoButton.hidden = this.callbacks.onPhotoMode === undefined;
    (tools ?? this.topBar.element).append(this.photoButton);

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
      onRefit: (vehicleId, cargo) => this.callbacks.onRefitVehicle(vehicleId, cargo),
      onUpdateOrder: (vehicleId, index, options) =>
        this.callbacks.onUpdateOrder(vehicleId, index, options),
      onAddConditional: (vehicleId) => this.callbacks.onAddConditionalOrder(vehicleId),
      onShareOrders: (vehicleId, targetId) => this.callbacks.onShareOrders(vehicleId, targetId),
      onCloneVehicle: (vehicleId) => this.callbacks.onCloneVehicle(vehicleId),
      onService: (vehicleId) => this.callbacks.onServiceVehicle(vehicleId),
      onSendToDepot: (vehicleId) => this.callbacks.onSendVehicleToDepot(vehicleId),
    });

    this.placePanel = new PlacePanel({
      onClose: () => this.callbacks.onClosePlace(),
      onFocus: (x, y) => this.callbacks.onPlaceFocus(x, y),
      onSelect: (target) => this.callbacks.onPlaceSelect(target),
      onTownAction: (townId, action) => this.callbacks.onTownAction(townId, action),
    });

    this.reports = new ReportsPanel({
      onClose: () => this.closeReports(),
      onSelectVehicle: (vehicleId) => {
        this.closeReports();
        this.callbacks.onSelectVehicle(vehicleId);
      },
      onStartVehicle: (vehicleId) => this.callbacks.onStartVehicle(vehicleId),
      onStopVehicle: (vehicleId) => this.callbacks.onStopVehicle(vehicleId),
      onSellVehicle: (vehicleId) => this.callbacks.onSellVehicle(vehicleId),
      onCreateGroup: (kind, name) => this.callbacks.onCreateGroup(kind, name),
      onRenameGroup: (groupId, name) => this.callbacks.onRenameGroup(groupId, name),
      onDeleteGroup: (groupId) => this.callbacks.onDeleteGroup(groupId),
      onAssignVehicleGroup: (vehicleId, groupId) =>
        this.callbacks.onAssignVehicleGroup(vehicleId, groupId),
      onGroupAction: (groupId, action) => this.callbacks.onGroupAction(groupId, action),
      onGroupAutoreplace: (groupId, model, whenOld) =>
        this.callbacks.onGroupAutoreplace(groupId, model, whenOld),
    });

    this.financePanel = new FinancesPanel({
      onClose: () => this.closeFinances(),
      onIncreaseLoan: () => this.callbacks.onIncreaseLoan(),
      onDecreaseLoan: () => this.callbacks.onDecreaseLoan(),
    });

    this.bankruptcyAlert = el('div', {
      className: 'hud-bankruptcy',
      attrs: {
        role: 'alert',
        'aria-live': 'assertive',
      },
    });
    const bankruptcyText = el('span', { className: 'hud-bankruptcy-text' });
    this.bankruptcyText = bankruptcyText;
    const bankruptcyAction = el('button', {
      className: 'hud-bankruptcy-action',
      text: t('finance.alert.open'),
      attrs: { type: 'button' },
    });
    bankruptcyAction.addEventListener('click', () => this.openFinances());
    this.bankruptcyAlert.append(bankruptcyText, bankruptcyAction);
    this.bankruptcyAlert.addEventListener('click', (event) => {
      if (event.target === bankruptcyAction) return;
      this.openFinances();
    });
    this.bankruptcyAlert.hidden = true;

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
    this.networkAlert = new NetworkAlert();

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
      this.bankruptcyAlert,
      this.selectionPanel.element,
      this.depotPanel.element,
      this.vehiclePanel.element,
      this.placePanel.element,
      this.reports.element,
      this.financePanel.element,
      this.minimap.element,
      this.newsFeed.element,
      this.toolbar.element,
      this.buildOptions.element,
      this.buildHint.element,
      this.help.element,
      this.toasts.element,
      this.networkStatus,
      this.networkAlert.element,
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
    this.reports.updateSnapshot(state.snapshot);
    this.updateNetworkStatus(state);
    this.updateBankruptcyAlert(state);
    // Le panneau véhicule est prioritaire sur le dépôt, lui-même prioritaire
    // sur le panneau lieu, lui-même prioritaire sur la sélection générique.
    const vehicle = state.vehicle ?? null;
    const depot = vehicle ? null : (state.depot ?? null);
    const place = vehicle || depot ? null : (state.place ?? null);
    this.depotPanel.update(depot, state.quality);
    this.vehiclePanel.update(vehicle);
    this.placePanel.update(place);
    this.financePanel.update(state.finance ?? null);
    this.topBar.setFinancesOpen(this.financePanel.isOpen());
    const panelsOpen = vehicle !== null || depot !== null || place !== null;
    this.selectionPanel.update(
      panelsOpen ? null : state.selection,
      panelsOpen ? false : state.following,
    );
    this.minimap.setSnapshot(state.snapshot);
    this.minimap.setSelection(state.selection?.selection ?? null);
    this.refreshNewsBadge();
    if (this.newsFeed.isOpen()) this.renderNewsList();
  }

  private updateBankruptcyAlert(state: HudState): void {
    const alert = state.bankruptcyAlert ?? null;
    this.bankruptcyAlert.hidden = alert === null;
    if (!alert) return;
    this.bankruptcyText.textContent = alert.text;
    this.bankruptcyAlert.dataset.tone = alert.tone;
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

  /** Bandeau explicite de pause coopérative réseau (#39). */
  setNetworkAlert(view: NetworkAlertView | null): void {
    this.networkAlert.update(view);
  }

  /** Reflète l'outil de construction armé dans la barre du bas. */
  setBuildTool(tool: BuildToolId | null): void {
    this.toolbar.setActive(tool);
  }

  /** Reflète l'état du mode photo sur le bouton appareil. */
  setPhotoMode(active: boolean): void {
    this.photoButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    this.photoButton.classList.toggle('is-active', active);
  }

  /** Met à jour le bouton mute (état réel du moteur audio). */
  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted;
    this.audioButton.textContent = muted ? '🔇' : '🔊';
    this.refreshAudioLabel();
    this.audioButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
    this.audioButton.classList.toggle('is-active', muted);
  }

  private refreshAudioLabel(): void {
    const label = t(this.audioMuted ? 'hud.audio.unmute' : 'hud.audio.mute');
    this.audioButton.title = label;
    this.audioButton.setAttribute('aria-label', label);
  }

  /** Affiche le coût estimé et le motif d'invalidité au-dessus de la barre. */
  setBuildHint(view: BuildHintView | null): void {
    this.buildHint.update(view);
  }

  /** Affiche les réglages de gare/dépôt/signal pour l'outil armé. */
  setBuildOptions(tool: BuildToolId | null, settings: BuildSettings): void {
    this.buildOptions.update(tool, settings);
  }

  openReports(tab: ReportTab = 'finance'): void {
    if (this.newsFeed.isOpen()) this.closeNews();
    if (this.help.isOpen()) this.hideHelp();
    this.reports.open(tab);
  }

  closeReports(): void {
    if (!this.reports.isOpen()) return;
    this.reports.close();
    this.topBar.focusReportButton(this.reports.activeTab);
  }

  isReportsOpen(): boolean {
    return this.reports.isOpen();
  }

  toggleNews(): void {
    if (this.reports.isOpen()) this.closeReports();
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
    if (this.reports.isOpen()) this.closeReports();
    this.help.toggle();
    if (this.help.isOpen()) this.closeNews();
  }

  /** Ouvre/ferme le panneau finances ; le focus revient au bouton. */
  toggleFinances(): void {
    if (this.financePanel.isOpen()) {
      this.closeFinances();
      return;
    }
    this.openFinances();
  }

  openFinances(): void {
    if (this.financePanel.isOpen()) return;
    this.closeNews();
    this.hideHelp();
    this.financePanel.show();
    this.topBar.setFinancesOpen(true);
  }

  closeFinances(): void {
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement &&
      (this.financePanel.element.contains(active) || !active.isConnected);
    this.financePanel.hide();
    this.topBar.setFinancesOpen(false);
    if (restore) this.topBar.focusFinancesButton();
  }

  isFinancesOpen(): boolean {
    return this.financePanel.isOpen();
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
    if (this.reports.isOpen()) {
      this.closeReports();
      closed = true;
    }
    if (this.newsFeed.isOpen()) {
      this.closeNews();
      closed = true;
    }
    if (this.help.isOpen()) {
      this.hideHelp();
      closed = true;
    }
    if (this.financePanel.isOpen()) {
      this.closeFinances();
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
    this.stopAudioLanguage();
    this.topBar.dispose();
    this.toolbar.dispose();
    this.help.dispose();
    this.selectionPanel.dispose();
    this.newsFeed.dispose();
    this.toasts.dispose();
    this.networkAlert.dispose();
    this.reports.dispose();
    this.buildHint.dispose();
    this.buildOptions.dispose();
    this.buildOptions.element.remove();
    this.financePanel.dispose();
    this.depotPanel.dispose();
    this.minimap.dispose();
    this.news.clear();
    this.root.remove();
  }
}
