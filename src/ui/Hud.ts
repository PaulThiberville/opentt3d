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
import { formatShortGameDate, type GameDateLike } from './format';
import { NewsQueue, type NewsKind } from './news';
import type { CameraView, HudState, SelectionSummary } from './types';
import { BuildHint } from './hud/BuildHint';
import { BuildOptions } from './hud/BuildOptions';
import { HelpPanel } from './hud/HelpPanel';
import { Minimap } from './hud/Minimap';
import { NewsFeed } from './hud/NewsFeed';
import { SelectionPanel } from './hud/SelectionPanel';
import { Toasts } from './hud/Toasts';
import { Toolbar, type BuildToolId } from './hud/Toolbar';
import { TopBar } from './hud/TopBar';

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
  private selectionPanel: SelectionPanel;
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

    this.selectionPanel = new SelectionPanel({
      onClear: () => this.callbacks.onClearSelection(),
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
      attrs: { role: 'alertdialog', 'aria-live': 'assertive' },
    });
    const card = el('div', { className: 'hud-overlay-card' });
    this.errorTitle = el('h2', { text: 'Erreur' });
    this.errorMessage = el('p', { text: '' });
    const retry = el('button', {
      className: 'btn btn-primary hud-retry',
      text: 'Recharger la page',
      attrs: { type: 'button' },
    });
    retry.addEventListener('click', () => window.location.reload());
    card.append(this.errorTitle, this.errorMessage, retry);
    this.errorOverlay.append(card);
    this.errorOverlay.hidden = true;

    this.root.append(
      this.topBar.element,
      this.selectionPanel.element,
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

    this.refreshNews();
  }

  update(state: HudState): void {
    this.topBar.update(state);
    this.updateNetworkStatus(state);
    this.selectionPanel.update(state.selection, state.following);
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
    this.markAllRead();
    this.renderNewsList();
  }

  closeNews(): void {
    this.newsFeed.hide();
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
    this.toasts.dispose();
    this.buildHint.dispose();
    this.buildOptions.element.remove();
    this.minimap.dispose();
    this.news.clear();
    this.root.remove();
  }
}
