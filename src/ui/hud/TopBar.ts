/**
 * Barre supérieure du HUD : entreprise, trésorerie, flux, date, vitesse,
 * FPS, qualité et accès aux panneaux.
 *
 * Les libellés passent par le socle i18n : `bindText`/`bindAttr` les
 * retraduisent à chaud quand la langue change depuis les réglages.
 */

import type { WorldSnapshot, CompanySnapshot } from '../../engine/protocol';
import type { GameSpeed } from '../../game/Game';
import { el } from '../dom';
import { bindAttr, bindText, onLanguageChange, qualityLabel, t, tn } from '../i18n';
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
  private newsButton: HTMLButtonElement;
  private newsLabel: HTMLSpanElement;
  private newsBadge: HTMLSpanElement;
  private newsLive: HTMLSpanElement;
  private lastUnread = 0;
  private speedButtons: { button: HTMLButtonElement; speed: GameSpeed }[] = [];
  private cache = new Map<string, string>();
  private lastState: HudState | null = null;
  private stopListening: () => void;

  constructor(callbacks: TopBarCallbacks) {
    this.callbacks = callbacks;
    this.element = el('header', { className: 'hud-bar' });

    const brand = el('div', { className: 'hud-brand' });
    brand.append(
      el('span', { className: 'hud-brand-mark', text: '◆', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'hud-brand-name', text: 'OpenTT3D' }),
    );

    const companyBlock = el('div', { className: 'hud-stat hud-company' });
    companyBlock.append(bindText(el('span', { className: 'hud-label' }), 'topbar.company'));
    this.companyValue = el('span', { className: 'hud-value', text: '—' });
    companyBlock.append(this.companyValue);

    const moneyBlock = el('div', { className: 'hud-stat hud-money' });
    moneyBlock.append(bindText(el('span', { className: 'hud-label' }), 'topbar.money'));
    this.moneyValue = el('span', { className: 'hud-value hud-money-value', text: '—' });
    moneyBlock.append(this.moneyValue);

    const flowBlock = el('div', { className: 'hud-stat hud-flow' });
    flowBlock.append(bindText(el('span', { className: 'hud-label' }), 'topbar.flow'));
    const flowValues = el('span', { className: 'hud-flow-values' });
    this.incomeValue = el('span', { className: 'hud-flow-income', text: '—' });
    this.expenseValue = el('span', { className: 'hud-flow-expense', text: '—' });
    flowValues.append(this.incomeValue, this.expenseValue);
    flowBlock.append(flowValues);

    const dateBlock = el('div', { className: 'hud-stat hud-date' });
    dateBlock.append(bindText(el('span', { className: 'hud-label' }), 'topbar.date'));
    this.dateValue = el('span', { className: 'hud-value', text: '—' });
    dateBlock.append(this.dateValue);

    const speedBlock = el('div', { className: 'hud-stat hud-speed' });
    speedBlock.append(bindText(el('span', { className: 'hud-label' }), 'topbar.speed'));
    const speedGroup = el('div', { className: 'hud-speed-group' });
    this.pauseButton = el('button', {
      className: 'hud-button hud-pause',
      attrs: {
        type: 'button',
        title: t('topbar.pauseTooltip'),
        'aria-label': t('topbar.pause'),
        'aria-pressed': 'false',
      },
    });
    this.pauseButton.textContent = 'II';
    this.pauseButton.addEventListener('click', () => this.callbacks.onTogglePause());
    speedGroup.append(this.pauseButton);
    for (const speed of [1, 2] as const) {
      const speedButton = el('button', {
        className: 'hud-button',
        text: `${speed}×`,
        attrs: {
          type: 'button',
          title: t('topbar.speedButton', { speed }),
          'aria-label': t('topbar.speedAria', { speed }),
          'aria-pressed': 'false',
        },
      });
      speedButton.addEventListener('click', () => this.callbacks.onSpeedChange(speed));
      this.speedButtons.push({ button: speedButton, speed });
      speedGroup.append(speedButton);
    }
    speedBlock.append(speedGroup);

    const fpsBlock = el('div', { className: 'hud-stat hud-fps' });
    fpsBlock.append(bindText(el('span', { className: 'hud-label' }), 'topbar.fps'));
    this.fpsValue = el('span', { className: 'hud-value', text: '—' });
    fpsBlock.append(this.fpsValue);

    const tools = el('div', { className: 'hud-tools' });
    this.qualityButton = el('button', {
      className: 'hud-button hud-quality',
      text: 'Moyenne',
      attrs: {
        type: 'button',
        title: t('topbar.qualityTitle'),
        'aria-label': t('topbar.qualityAria', { label: 'Moyenne' }),
      },
    });
    bindAttr(this.qualityButton, 'title', 'topbar.qualityTitle');
    this.qualityButton.addEventListener('click', () => this.callbacks.onCycleQuality());

    this.newsButton = el('button', {
      className: 'hud-button hud-news-button',
      attrs: {
        type: 'button',
        title: t('topbar.newsTitle'),
        'aria-label': t('topbar.news'),
        'aria-controls': 'hud-news-panel',
        'aria-expanded': 'false',
      },
    });
    this.newsLabel = bindText(el('span'), 'topbar.news');
    this.newsButton.append(this.newsLabel);
    this.newsBadge = el('span', {
      className: 'hud-badge',
      text: '0',
      attrs: { 'aria-hidden': 'true' },
    });
    this.newsButton.append(this.newsBadge);
    this.newsButton.addEventListener('click', () => this.callbacks.onToggleNews());
    bindAttr(this.newsButton, 'title', 'topbar.newsTitle');
    this.newsLive = el('span', {
      className: 'sr-only',
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });

    const resetButton = el('button', {
      className: 'hud-button',
      text: '⌖',
      attrs: {
        type: 'button',
        title: t('topbar.resetTitle'),
        'aria-label': t('topbar.reset'),
      },
    });
    resetButton.addEventListener('click', () => this.callbacks.onResetView());
    bindAttr(resetButton, 'title', 'topbar.resetTitle');
    bindAttr(resetButton, 'aria-label', 'topbar.reset');

    const settingsButton = el('button', {
      className: 'hud-button',
      text: '⚙',
      attrs: { type: 'button', title: t('common.settings'), 'aria-label': t('common.settings') },
    });
    settingsButton.addEventListener('click', () => this.callbacks.onOpenSettings());
    bindAttr(settingsButton, 'title', 'common.settings');
    bindAttr(settingsButton, 'aria-label', 'common.settings');

    const helpButton = el('button', {
      className: 'hud-button',
      text: '?',
      attrs: {
        type: 'button',
        title: t('topbar.helpTitle'),
        'aria-label': t('topbar.help'),
      },
    });
    helpButton.addEventListener('click', () => this.callbacks.onToggleHelp());
    bindAttr(helpButton, 'title', 'topbar.helpTitle');
    bindAttr(helpButton, 'aria-label', 'topbar.help');

    tools.append(this.qualityButton, this.newsButton, resetButton, settingsButton, helpButton);

    this.element.append(
      brand,
      companyBlock,
      moneyBlock,
      flowBlock,
      dateBlock,
      speedBlock,
      fpsBlock,
      tools,
      this.newsLive,
    );

    this.stopListening = onLanguageChange(() => {
      if (this.lastState) {
        this.cache.clear();
        this.update(this.lastState);
      }
      this.setUnread(this.lastUnread);
    });
  }

  dispose(): void {
    this.stopListening();
  }

  /** Rend le focus au bouton Actualités après fermeture du panneau. */
  focusNewsButton(): void {
    this.newsButton.focus();
  }

  /** Reflète l'état ouvert/fermé du panneau d'actualités. */
  setNewsOpen(open: boolean): void {
    this.newsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  private setText(element: HTMLElement, key: string, value: string): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    element.textContent = value;
  }

  update(state: HudState): void {
    this.lastState = state;
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
    this.fpsValue.title = `${Math.round(state.fps)} FPS · ${state.drawCalls} draw calls`;
    const currentQuality = qualityLabel(state.quality);
    this.setText(this.qualityButton, 'quality', currentQuality);
    this.qualityButton.setAttribute(
      'aria-label',
      t('topbar.qualityAria', { label: currentQuality }),
    );
    const paused = state.paused;
    this.setText(this.pauseButton, 'pause', paused ? '▶' : 'II');
    this.pauseButton.classList.toggle('is-active', paused);
    this.pauseButton.setAttribute('aria-pressed', paused ? 'true' : 'false');
    const locked = state.controlsLocked === true;
    this.pauseButton.disabled = locked;
    this.pauseButton.setAttribute('aria-label', paused ? t('topbar.resume') : t('topbar.pause'));
    this.pauseButton.title = locked
      ? t('topbar.lockedPause')
      : paused
        ? t('topbar.resumeTooltip')
        : t('topbar.pauseTooltip');
    for (const entry of this.speedButtons) {
      const active = !paused && state.speed === entry.speed;
      entry.button.classList.toggle('is-active', active);
      entry.button.setAttribute('aria-pressed', active ? 'true' : 'false');
      entry.button.disabled = locked;
      entry.button.setAttribute(
        'aria-label',
        locked ? t('topbar.lockedSpeed') : t('topbar.speedAria', { speed: entry.speed }),
      );
      entry.button.title = locked
        ? t('topbar.lockedSpeed')
        : t('topbar.speedButton', { speed: entry.speed });
    }
    if (company) {
      this.companyValue.title = t('topbar.companyTitle', {
        name: company.name,
        loan: formatMoney(company.loan),
        value: formatMoney(company.value),
      });
    } else {
      this.companyValue.removeAttribute('title');
    }
  }

  setUnread(count: number): void {
    if (count !== this.lastUnread) {
      this.lastUnread = count;
      this.newsLive.textContent =
        count === 0 ? t('news.upToDate') : tn(count, 'topbar.unread.one', 'topbar.unread.other');
    }
    const label = count > 99 ? '99+' : `${count}`;
    this.setText(this.newsBadge, 'unread', label);
    this.newsBadge.classList.toggle('is-empty', count === 0);
    this.newsButton.setAttribute(
      'aria-label',
      `${t('topbar.news')} — ${tn(count, 'topbar.unread.one', 'topbar.unread.other')}`,
    );
  }
}
