/**
 * Voile de pause (Échap) : reprendre, ouvrir les réglages ou revenir au menu
 * après confirmation explicite. La confirmation est un sous-dialogue : le
 * focus y reste piégé tant qu'elle est ouverte.
 */

import { el } from '../dom';
import { t } from '../i18n';
import type { SessionOverview } from '../types';
import { BaseScreen } from './BaseScreen';

export interface PauseScreenOptions {
  overview: SessionOverview;
  onResume: () => void;
  onSettings: () => void;
  onQuit: () => void;
  /** Ouvre l'écran de sauvegarde (solo uniquement). */
  onSave?: () => void;
  /** Ouvre l'écran de chargement (solo uniquement). */
  onLoad?: () => void;
  /** En réseau, la simulation continue : le menu est local. */
  network?: boolean;
}

function stat(label: string, value: string): HTMLDivElement {
  const node = el('div', { className: 'stat-card' });
  node.append(
    el('span', { className: 'stat-label', text: label }),
    el('span', { className: 'stat-value', text: value }),
  );
  return node;
}

export class PauseScreen extends BaseScreen {
  private options: PauseScreenOptions;
  private confirm: HTMLDivElement;
  private confirmText: HTMLParagraphElement;
  private actions: HTMLDivElement;
  private quitButton: HTMLButtonElement;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(options: PauseScreenOptions) {
    super('pause-screen');
    this.options = options;
    this.element.setAttribute(
      'aria-label',
      options.network ? t('pause.title.network') : t('pause.title.paused'),
    );

    const panel = el('div', { className: 'panel pause-panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', {
        className: 'panel-eyebrow',
        text: options.network ? t('pause.eyebrow.network') : t('pause.eyebrow.paused'),
      }),
      el('h1', {
        className: 'panel-title',
        text: options.network ? t('pause.title.network') : t('pause.title.paused'),
      }),
      el('p', {
        className: 'panel-subtitle',
        text: options.network ? t('pause.subtitle.network') : t('pause.subtitle.paused'),
      }),
    );

    const grid = el('div', { className: 'stat-grid' });
    grid.append(
      stat(t('pause.stats.company'), options.overview.company),
      stat(t('pause.stats.date'), options.overview.date),
      stat(t('pause.stats.money'), options.overview.money),
      stat(t('pause.stats.vehicles'), `${options.overview.vehicles}`),
      stat(t('pause.stats.stations'), `${options.overview.stations}`),
    );

    this.actions = el('div', { className: 'panel-actions panel-actions-column' });
    const resume = el('button', {
      className: 'btn btn-primary',
      text: options.network ? t('pause.closeMenu') : t('pause.resume'),
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    resume.addEventListener('click', () => options.onResume());

    const settings = el('button', {
      className: 'btn btn-ghost',
      text: t('common.settings'),
      attrs: { type: 'button' },
    });
    settings.addEventListener('click', () => options.onSettings());

    this.quitButton = el('button', {
      className: 'btn btn-danger',
      text: t('pause.quit'),
      attrs: { type: 'button' },
    });
    this.quitButton.addEventListener('click', () => this.showConfirm());

    this.actions.append(resume);
    if (!options.network && options.onSave) {
      const save = el('button', {
        className: 'btn btn-ghost',
        text: t('pause.save'),
        attrs: { type: 'button' },
      });
      save.addEventListener('click', () => options.onSave?.());
      this.actions.append(save);
    }
    if (!options.network && options.onLoad) {
      const load = el('button', {
        className: 'btn btn-ghost',
        text: t('pause.load'),
        attrs: { type: 'button' },
      });
      load.addEventListener('click', () => options.onLoad?.());
      this.actions.append(load);
    }
    this.actions.append(settings, this.quitButton);

    if (options.network) {
      this.actions.append(
        el('p', {
          className: 'screen-note',
          text: t('pause.networkNote'),
        }),
      );
    }

    this.confirmText = el('p', {
      className: 'confirm-text',
      text: t('pause.confirm.text'),
      attrs: { id: 'pause-confirm-text' },
    });
    this.confirm = el('div', {
      className: 'confirm',
      attrs: {
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'pause-confirm-text',
      },
    });
    this.confirm.append(this.confirmText);
    const confirmActions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', {
      className: 'btn btn-ghost',
      text: t('common.cancel'),
      attrs: { type: 'button' },
    });
    cancel.addEventListener('click', () => this.hideConfirm());
    this.confirmButton = el('button', {
      className: 'btn btn-danger',
      text: t('pause.confirm.ok'),
      attrs: { type: 'button' },
    });
    this.confirmButton.addEventListener('click', () => options.onQuit());
    confirmActions.append(cancel, this.confirmButton);
    this.confirm.append(confirmActions);
    this.confirm.hidden = true;

    panel.append(header, grid, this.actions, this.confirm);
    this.element.append(panel);
  }

  /** Tant que la confirmation est visible, Tab reste dans son dialogue. */
  protected override focusScope(): HTMLElement {
    return this.confirm.hidden ? this.element : this.confirm;
  }

  private showConfirm(): void {
    this.confirm.hidden = false;
    this.quitButton.disabled = true;
    // La confirmation est modale : le reste des actions devient inerte
    // (souris comprise), comme l'annonce `aria-modal`.
    this.actions.inert = true;
    this.confirmButton?.focus();
  }

  private hideConfirm(): void {
    this.confirm.hidden = true;
    this.actions.inert = false;
    this.quitButton.disabled = false;
    this.quitButton.focus();
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!this.confirm.hidden) this.hideConfirm();
    else this.options.onResume();
  }
}
