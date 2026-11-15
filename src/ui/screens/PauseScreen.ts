/**
 * Voile de pause (Échap) : reprendre, ouvrir les réglages ou revenir au menu
 * après confirmation explicite.
 */

import { el } from '../dom';
import type { SessionOverview } from '../types';
import { BaseScreen } from './BaseScreen';

export interface PauseScreenOptions {
  overview: SessionOverview;
  onResume: () => void;
  onSettings: () => void;
  onQuit: () => void;
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
  private actions: HTMLDivElement;
  private quitButton: HTMLButtonElement;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(options: PauseScreenOptions) {
    super('pause-screen');
    this.options = options;

    const panel = el('div', { className: 'panel pause-panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: 'Partie en pause' }),
      el('h1', { className: 'panel-title', text: 'Pause' }),
      el('p', {
        className: 'panel-subtitle',
        text: 'Le temps de jeu est arrêté. Reprenez quand vous voulez.',
      }),
    );

    const grid = el('div', { className: 'stat-grid' });
    grid.append(
      stat('Entreprise', options.overview.company),
      stat('Date', options.overview.date),
      stat('Trésorerie', options.overview.money),
      stat('Véhicules', `${options.overview.vehicles}`),
      stat('Gares et arrêts', `${options.overview.stations}`),
    );

    this.actions = el('div', { className: 'panel-actions panel-actions-column' });
    const resume = el('button', {
      className: 'btn btn-primary',
      text: 'Reprendre la partie',
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    resume.addEventListener('click', () => options.onResume());

    const settings = el('button', {
      className: 'btn btn-ghost',
      text: 'Réglages',
      attrs: { type: 'button' },
    });
    settings.addEventListener('click', () => options.onSettings());

    this.quitButton = el('button', {
      className: 'btn btn-danger',
      text: 'Retour au menu',
      attrs: { type: 'button' },
    });
    this.quitButton.addEventListener('click', () => this.showConfirm());

    this.actions.append(resume, settings, this.quitButton);

    this.confirm = el('div', {
      className: 'confirm',
      attrs: { role: 'alertdialog', 'aria-label': 'Confirmer l’abandon' },
    });
    this.confirm.append(
      el('p', {
        className: 'confirm-text',
        text: 'Abandonner cette partie ? La progression non sauvegardée sera perdue.',
      }),
    );
    const confirmActions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', {
      className: 'btn btn-ghost',
      text: 'Annuler',
      attrs: { type: 'button' },
    });
    cancel.addEventListener('click', () => this.hideConfirm());
    this.confirmButton = el('button', {
      className: 'btn btn-danger',
      text: 'Confirmer l’abandon',
      attrs: { type: 'button' },
    });
    this.confirmButton.addEventListener('click', () => options.onQuit());
    confirmActions.append(cancel, this.confirmButton);
    this.confirm.append(confirmActions);
    this.confirm.hidden = true;

    panel.append(header, grid, this.actions, this.confirm);
    this.element.append(panel);
  }

  private showConfirm(): void {
    this.confirm.hidden = false;
    this.quitButton.disabled = true;
    this.confirmButton?.focus();
  }

  private hideConfirm(): void {
    this.confirm.hidden = true;
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
