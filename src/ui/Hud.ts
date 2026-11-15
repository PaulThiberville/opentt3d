/**
 * HUD minimaliste : DOM + CSS, aucun framework.
 *
 * Barre supérieure (trésorerie, date, vitesse, FPS, qualité), aide des
 * contrôles, notifications temporaires, indicateur de sélection, écran de
 * chargement et écran d'erreur. Les écritures DOM sont différées : seuls les
 * textes qui changent sont réécrits.
 */

import type { CompanySnapshot, WorldSnapshot } from '../engine/protocol';
import type { GameSpeed, NotifyKind, Selection } from '../game/Game';
import { QUALITY_PRESETS, type QualityLevel } from '../render/quality';

export interface SelectionSummary {
  selection: Selection;
  title: string;
  detail: string;
  colour: number | null;
}

export interface HudCallbacks {
  onTogglePause: () => void;
  onSpeedChange: (speed: GameSpeed) => void;
  onResetView: () => void;
  onCycleQuality: () => void;
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
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

const MONEY_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatMoney(value: number): string {
  return `${MONEY_FORMAT.format(Math.round(value))} £`;
}

function formatDate(snapshot: WorldSnapshot | null): string {
  if (!snapshot) return '—';
  const { year, month, day } = snapshot.economy;
  return `${day} ${MONTHS[month] ?? '?'} ${year}`;
}

function localCompany(snapshot: WorldSnapshot | null): CompanySnapshot | null {
  if (!snapshot) return null;
  return snapshot.companies.find((company) => company.isLocal) ?? snapshot.companies[0] ?? null;
}

export class Hud {
  readonly root: HTMLDivElement;

  private callbacks: HudCallbacks;
  private moneyValue: HTMLSpanElement;
  private dateValue: HTMLSpanElement;
  private companyValue: HTMLSpanElement;
  private fpsValue: HTMLSpanElement;
  private qualityButton: HTMLButtonElement;
  private pauseButton: HTMLButtonElement;
  private speedButtons: { button: HTMLButtonElement; speed: GameSpeed }[] = [];
  private selectionCard: HTMLDivElement;
  private selectionDot: HTMLSpanElement;
  private selectionTitle: HTMLDivElement;
  private selectionDetail: HTMLDivElement;
  private toasts: HTMLDivElement;
  private helpPanel: HTMLDivElement;
  private loadingOverlay: HTMLDivElement;
  private loadingText: HTMLParagraphElement;
  private loadingBar: HTMLDivElement;
  private errorOverlay: HTMLDivElement;
  private errorTitle: HTMLHeadingElement;
  private errorMessage: HTMLParagraphElement;
  private helpVisible = false;
  private timers = new Set<number>();
  private cache = new Map<string, string>();

  constructor(mount: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.root = el('div', 'hud');

    const bar = el('header', 'hud-bar');
    const brand = el('div', 'hud-brand');
    brand.append(el('span', 'hud-brand-mark', '◆'), el('span', 'hud-brand-name', 'OpenTT3D'));

    const companyBlock = el('div', 'hud-stat hud-company');
    companyBlock.append(el('span', 'hud-label', 'Entreprise'));
    this.companyValue = el('span', 'hud-value', '—');
    companyBlock.append(this.companyValue);

    const moneyBlock = el('div', 'hud-stat');
    moneyBlock.append(el('span', 'hud-label', 'Trésorerie'));
    this.moneyValue = el('span', 'hud-value hud-money', '—');
    moneyBlock.append(this.moneyValue);

    const dateBlock = el('div', 'hud-stat');
    dateBlock.append(el('span', 'hud-label', 'Date'));
    this.dateValue = el('span', 'hud-value', '—');
    dateBlock.append(this.dateValue);

    const speedBlock = el('div', 'hud-stat hud-speed');
    speedBlock.append(el('span', 'hud-label', 'Vitesse'));
    this.pauseButton = el('button', 'hud-button hud-pause', 'II');
    this.pauseButton.type = 'button';
    this.pauseButton.title = 'Pause (Espace)';
    this.pauseButton.setAttribute('aria-label', 'Pause');
    this.pauseButton.addEventListener('click', () => this.callbacks.onTogglePause());
    const speedGroup = el('div', 'hud-speed-group');
    speedGroup.append(this.pauseButton);
    for (const speed of [1, 2] as const) {
      const button = el('button', 'hud-button', `${speed}×`);
      button.type = 'button';
      button.title = `Vitesse ${speed}×`;
      button.addEventListener('click', () => this.callbacks.onSpeedChange(speed));
      this.speedButtons.push({ button, speed });
      speedGroup.append(button);
    }
    speedBlock.append(speedGroup);

    const fpsBlock = el('div', 'hud-stat hud-fps');
    fpsBlock.append(el('span', 'hud-label', 'FPS'));
    this.fpsValue = el('span', 'hud-value', '—');
    fpsBlock.append(this.fpsValue);

    const tools = el('div', 'hud-tools');
    this.qualityButton = el('button', 'hud-button hud-quality', 'Moyenne');
    this.qualityButton.type = 'button';
    this.qualityButton.title = 'Changer la qualité de rendu';
    this.qualityButton.addEventListener('click', () => this.callbacks.onCycleQuality());
    const resetButton = el('button', 'hud-button', '⌖');
    resetButton.type = 'button';
    resetButton.title = 'Recentrer la carte (Début)';
    resetButton.setAttribute('aria-label', 'Recentrer la carte');
    resetButton.addEventListener('click', () => this.callbacks.onResetView());
    const helpButton = el('button', 'hud-button', '?');
    helpButton.type = 'button';
    helpButton.title = 'Aide et contrôles';
    helpButton.setAttribute('aria-label', 'Aide');
    helpButton.addEventListener('click', () => this.toggleHelp());
    tools.append(this.qualityButton, resetButton, helpButton);

    bar.append(brand, companyBlock, moneyBlock, dateBlock, speedBlock, fpsBlock, tools);

    this.selectionCard = el('div', 'hud-selection');
    this.selectionDot = el('span', 'hud-selection-dot');
    const selectionText = el('div', 'hud-selection-text');
    this.selectionTitle = el('div', 'hud-selection-title', 'Aucune sélection');
    this.selectionDetail = el('div', 'hud-selection-detail', 'Cliquez sur un véhicule, une ville ou une tuile.');
    selectionText.append(this.selectionTitle, this.selectionDetail);
    this.selectionCard.append(this.selectionDot, selectionText);

    this.toasts = el('div', 'hud-toasts');
    this.toasts.setAttribute('aria-live', 'polite');

    this.helpPanel = el('div', 'hud-help');
    const helpTitle = el('h3', undefined, 'Contrôles');
    const helpList = el('ul');
    const controls = [
      ['Clic droit / Alt + glisser', 'Tourner la caméra (orbite)'],
      ['Clic gauche / molette', 'Déplacer la vue, zoomer vers le curseur'],
      ['Clic milieu', 'Déplacer la vue'],
      ['Flèches / WASD', 'Déplacer la caméra'],
      ['Q / E', 'Pivoter la caméra'],
      ['+ / −', 'Zoomer / dézoomer'],
      ['Début (Home)', 'Recadrer la carte'],
      ['Clic', 'Sélectionner un véhicule, une ville, une tuile'],
      ['Double-clic', 'Centrer et suivre'],
      ['Échap', 'Quitter le suivi de véhicule'],
      ['Espace', 'Pause'],
    ];
    for (const [keys, description] of controls) {
      const item = el('li');
      item.append(el('kbd', undefined, keys ?? ''), el('span', undefined, description ?? ''));
      helpList.append(item);
    }
    this.helpPanel.append(helpTitle, helpList);

    this.loadingOverlay = el('div', 'hud-overlay hud-loading');
    const loadingCard = el('div', 'hud-overlay-card');
    const spinner = el('div', 'hud-spinner');
    this.loadingText = el('p', 'hud-loading-text', 'Préparation du monde…');
    const barTrack = el('div', 'hud-progress');
    this.loadingBar = el('div', 'hud-progress-fill');
    barTrack.append(this.loadingBar);
    loadingCard.append(spinner, el('h2', undefined, 'OpenTT3D'), this.loadingText, barTrack);
    this.loadingOverlay.append(loadingCard);

    this.errorOverlay = el('div', 'hud-overlay hud-error');
    const errorCard = el('div', 'hud-overlay-card');
    this.errorTitle = el('h2', undefined, 'Erreur');
    this.errorMessage = el('p', undefined, '');
    const retry = el('button', 'hud-button hud-retry', 'Recharger');
    retry.type = 'button';
    retry.addEventListener('click', () => window.location.reload());
    errorCard.append(this.errorTitle, this.errorMessage, retry);
    this.errorOverlay.append(errorCard);
    this.errorOverlay.hidden = true;
    this.helpPanel.hidden = true;

    this.root.append(bar, this.selectionCard, this.toasts, this.helpPanel, this.loadingOverlay, this.errorOverlay);
    mount.append(this.root);

    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.helpVisible) this.toggleHelp();
    });
  }

  private setText(element: HTMLElement, key: string, value: string): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    element.textContent = value;
  }

  update(state: HudState): void {
    const snapshot = state.snapshot;
    const company = localCompany(snapshot);
    this.setText(this.companyValue, 'company', company?.name ?? '—');
    this.setText(this.moneyValue, 'money', company ? formatMoney(company.money) : '—');
    this.moneyValue.classList.toggle('hud-negative', (company?.money ?? 0) < 0);
    this.setText(this.dateValue, 'date', formatDate(snapshot));
    this.setText(this.fpsValue, 'fps', state.fps > 0 ? `${Math.round(state.fps)}` : '—');
    this.setText(this.qualityButton, 'quality', QUALITY_PRESETS[state.quality].label);
    this.setText(this.pauseButton, 'pause', state.paused ? '▶' : 'II');
    this.pauseButton.classList.toggle('is-active', state.paused);
    for (const entry of this.speedButtons) {
      entry.button.classList.toggle('is-active', !state.paused && state.speed === entry.speed);
    }

    const selection = state.selection;
    this.selectionCard.classList.toggle('is-empty', !selection && !state.following);
    if (selection) {
      this.setText(this.selectionTitle, 'selection-title', selection.title);
      this.setText(this.selectionDetail, 'selection-detail', selection.detail);
      if (selection.colour === null) {
        this.selectionDot.style.background = 'var(--hud-accent)';
      } else {
        const hex = selection.colour.toString(16).padStart(6, '0');
        this.selectionDot.style.background = `#${hex}`;
      }
      this.selectionCard.hidden = false;
    } else if (state.following) {
      this.setText(this.selectionTitle, 'selection-title', 'Suivi caméra');
      this.setText(this.selectionDetail, 'selection-detail', 'Échap pour revenir à la vue carte.');
      this.selectionDot.style.background = 'var(--hud-accent)';
      this.selectionCard.hidden = false;
    } else {
      this.selectionCard.hidden = true;
    }
  }

  notify(kind: NotifyKind, text: string): void {
    const toast = el('div', `hud-toast hud-toast-${kind}`);
    const dot = el('span', 'hud-toast-dot');
    const body = el('div', 'hud-toast-body', text);
    toast.append(dot, body);
    this.toasts.append(toast);
    while (this.toasts.children.length > 5) {
      this.toasts.firstElementChild?.remove();
    }
    const timer = window.setTimeout(() => {
      toast.classList.add('is-leaving');
      const removeTimer = window.setTimeout(() => toast.remove(), 400);
      this.timers.add(removeTimer);
    }, 7000);
    this.timers.add(timer);
  }

  showLoading(text = 'Préparation du monde…'): void {
    this.loadingOverlay.hidden = false;
    this.setText(this.loadingText, 'loading-text', text);
    this.setProgress(0.08);
  }

  setProgress(progress: number, text?: string): void {
    const clamped = Math.max(0, Math.min(1, progress));
    this.loadingBar.style.width = `${Math.round(clamped * 100)}%`;
    if (text) this.setText(this.loadingText, 'loading-text', text);
  }

  hideLoading(): void {
    this.loadingOverlay.classList.add('is-hidden');
    window.setTimeout(() => {
      this.loadingOverlay.hidden = true;
    }, 320);
  }

  showError(title: string, message: string): void {
    this.errorTitle.textContent = title;
    this.errorMessage.textContent = message;
    this.errorOverlay.hidden = false;
    this.loadingOverlay.hidden = true;
  }

  toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    this.helpPanel.hidden = !this.helpVisible;
  }

  dispose(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.root.remove();
    this.cache.clear();
  }
}
