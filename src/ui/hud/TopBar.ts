/**
 * Barre supérieure du HUD : entreprise, trésorerie, flux, date, vitesse,
 * FPS, qualité et accès aux panneaux.
 */

import type { WorldSnapshot, CompanySnapshot } from '../../engine/protocol';
import type { GameSpeed } from '../../game/Game';
import { QUALITY_PRESETS } from '../../render/quality';
import { el } from '../dom';
import { formatGameDate, formatMoney, formatSignedMoney } from '../format';
import type { HudState } from '../types';

export interface TopBarCallbacks {
  onTogglePause: () => void;
  onSpeedChange: (speed: GameSpeed) => void;
  onResetView: () => void;
  onCycleQuality: () => void;
  onToggleNews: () => void;
  onToggleHelp: () => void;
  onOpenSettings: () => void;
}

function localCompany(snapshot: WorldSnapshot | null): CompanySnapshot | null {
  if (!snapshot) return null;
  return snapshot.companies.find((company) => company.isLocal) ?? snapshot.companies[0] ?? null;
}

export class TopBar {
  readonly element: HTMLElement;

  private callbacks: TopBarCallbacks;
  private companyValue: HTMLSpanElement;
  private moneyValue: HTMLSpanElement;
  private incomeValue: HTMLSpanElement;
  private expenseValue: HTMLSpanElement;
  private dateValue: HTMLSpanElement;
  private fpsValue: HTMLSpanElement;
  private qualityButton: HTMLButtonElement;
  private pauseButton: HTMLButtonElement;
  private newsBadge: HTMLSpanElement;
  private speedButtons: { button: HTMLButtonElement; speed: GameSpeed }[] = [];
  private cache = new Map<string, string>();

  constructor(callbacks: TopBarCallbacks) {
    this.callbacks = callbacks;
    this.element = el('header', { className: 'hud-bar' });

    const brand = el('div', { className: 'hud-brand' });
    brand.append(
      el('span', { className: 'hud-brand-mark', text: '◆' }),
      el('span', { className: 'hud-brand-name', text: 'OpenTT3D' }),
    );

    const companyBlock = el('div', { className: 'hud-stat hud-company' });
    companyBlock.append(el('span', { className: 'hud-label', text: 'Entreprise' }));
    this.companyValue = el('span', { className: 'hud-value', text: '—' });
    companyBlock.append(this.companyValue);

    const moneyBlock = el('div', { className: 'hud-stat hud-money' });
    moneyBlock.append(el('span', { className: 'hud-label', text: 'Trésorerie' }));
    this.moneyValue = el('span', { className: 'hud-value hud-money-value', text: '—' });
    moneyBlock.append(this.moneyValue);

    const flowBlock = el('div', { className: 'hud-stat hud-flow' });
    flowBlock.append(el('span', { className: 'hud-label', text: 'Flux du jour' }));
    const flowValues = el('span', { className: 'hud-flow-values' });
    this.incomeValue = el('span', { className: 'hud-flow-income', text: '—' });
    this.expenseValue = el('span', { className: 'hud-flow-expense', text: '—' });
    flowValues.append(this.incomeValue, this.expenseValue);
    flowBlock.append(flowValues);

    const dateBlock = el('div', { className: 'hud-stat hud-date' });
    dateBlock.append(el('span', { className: 'hud-label', text: 'Date' }));
    this.dateValue = el('span', { className: 'hud-value', text: '—' });
    dateBlock.append(this.dateValue);

    const speedBlock = el('div', { className: 'hud-stat hud-speed' });
    speedBlock.append(el('span', { className: 'hud-label', text: 'Vitesse' }));
    const speedGroup = el('div', { className: 'hud-speed-group' });
    this.pauseButton = el('button', {
      className: 'hud-button hud-pause',
      text: 'II',
      attrs: { type: 'button', title: 'Pause (Espace)', 'aria-label': 'Pause' },
    });
    this.pauseButton.addEventListener('click', () => this.callbacks.onTogglePause());
    speedGroup.append(this.pauseButton);
    for (const speed of [1, 2] as const) {
      const speedButton = el('button', {
        className: 'hud-button',
        text: `${speed}×`,
        attrs: { type: 'button', title: `Vitesse ${speed}×`, 'aria-label': `Vitesse ${speed}` },
      });
      speedButton.addEventListener('click', () => this.callbacks.onSpeedChange(speed));
      this.speedButtons.push({ button: speedButton, speed });
      speedGroup.append(speedButton);
    }
    speedBlock.append(speedGroup);

    const fpsBlock = el('div', { className: 'hud-stat hud-fps' });
    fpsBlock.append(el('span', { className: 'hud-label', text: 'FPS' }));
    this.fpsValue = el('span', { className: 'hud-value', text: '—' });
    fpsBlock.append(this.fpsValue);

    const tools = el('div', { className: 'hud-tools' });
    this.qualityButton = el('button', {
      className: 'hud-button hud-quality',
      text: 'Moyenne',
      attrs: { type: 'button', title: 'Changer la qualité de rendu' },
    });
    this.qualityButton.addEventListener('click', () => this.callbacks.onCycleQuality());

    const newsButton = el('button', {
      className: 'hud-button hud-news-button',
      attrs: { type: 'button', title: 'Actualités', 'aria-label': 'Actualités' },
    });
    newsButton.append(el('span', { text: 'News' }));
    this.newsBadge = el('span', { className: 'hud-badge', text: '0' });
    newsButton.append(this.newsBadge);
    newsButton.addEventListener('click', () => this.callbacks.onToggleNews());

    const resetButton = el('button', {
      className: 'hud-button',
      text: '⌖',
      attrs: {
        type: 'button',
        title: 'Recentrer la carte (Début)',
        'aria-label': 'Recentrer la carte',
      },
    });
    resetButton.addEventListener('click', () => this.callbacks.onResetView());

    const settingsButton = el('button', {
      className: 'hud-button',
      text: '⚙',
      attrs: { type: 'button', title: 'Réglages', 'aria-label': 'Réglages' },
    });
    settingsButton.addEventListener('click', () => this.callbacks.onOpenSettings());

    const helpButton = el('button', {
      className: 'hud-button',
      text: '?',
      attrs: { type: 'button', title: 'Aide et contrôles', 'aria-label': 'Aide' },
    });
    helpButton.addEventListener('click', () => this.callbacks.onToggleHelp());

    tools.append(this.qualityButton, newsButton, resetButton, settingsButton, helpButton);

    this.element.append(
      brand,
      companyBlock,
      moneyBlock,
      flowBlock,
      dateBlock,
      speedBlock,
      fpsBlock,
      tools,
    );
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
    this.setText(this.incomeValue, 'income', company ? formatSignedMoney(company.income) : '—');
    this.setText(
      this.expenseValue,
      'expense',
      company ? formatSignedMoney(-company.expenses) : '—',
    );
    this.setText(this.dateValue, 'date', formatGameDate(snapshot?.economy));
    this.setText(this.fpsValue, 'fps', state.fps > 0 ? `${Math.round(state.fps)}` : '—');
    this.setText(this.qualityButton, 'quality', QUALITY_PRESETS[state.quality].label);
    this.setText(this.pauseButton, 'pause', state.paused ? '▶' : 'II');
    this.pauseButton.classList.toggle('is-active', state.paused);
    const locked = state.controlsLocked === true;
    this.pauseButton.disabled = locked;
    this.pauseButton.title = locked ? 'Pause contrôlée par l’hôte en réseau' : 'Pause (Espace)';
    for (const entry of this.speedButtons) {
      entry.button.classList.toggle('is-active', !state.paused && state.speed === entry.speed);
      entry.button.disabled = locked;
      entry.button.title = locked
        ? 'Vitesse contrôlée par l’hôte en réseau'
        : `Vitesse ${entry.speed}×`;
    }
    if (company) {
      this.companyValue.title = `${company.name} · prêt ${formatMoney(company.loan)} · valeur ${formatMoney(company.value)}`;
    } else {
      this.companyValue.removeAttribute('title');
    }
  }

  setUnread(count: number): void {
    const label = count > 99 ? '99+' : `${count}`;
    this.setText(this.newsBadge, 'unread', label);
    this.newsBadge.classList.toggle('is-empty', count === 0);
    this.newsBadge.setAttribute(
      'aria-label',
      `${count} actualité${count > 1 ? 's' : ''} non lue${count > 1 ? 's' : ''}`,
    );
  }
}
