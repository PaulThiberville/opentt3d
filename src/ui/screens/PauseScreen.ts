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
  private actions: HTMLDivElement;
  private quitButton: HTMLButtonElement;
  private confirmButton: HTMLButtonElement | null = null;

  constructor(options: PauseScreenOptions) {
    super('pause-screen');
    this.options = options;

    const panel = el('div', { className: 'panel pause-panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', {
        className: 'panel-eyebrow',
        text: options.network ? 'Menu de partie' : 'Partie en pause',
      }),
      el('h1', { className: 'panel-title', text: options.network ? 'Menu local' : 'Pause' }),
      el('p', {
        className: 'panel-subtitle',
        text: options.network
          ? 'La simulation continue en réseau : ce menu ne met que votre affichage en pause. La vitesse est contrôlée par l’hôte.'
          : 'Le temps de jeu est arrêté. Reprenez quand vous voulez.',
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
      text: options.network ? 'Fermer le menu' : 'Reprendre la partie',
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

    this.actions.append(resume);
    if (!options.network && options.onSave) {
      const save = el('button', {
        className: 'btn btn-ghost',
        text: 'Sauvegarder la partie',
        attrs: { type: 'button' },
      });
      save.addEventListener('click', () => options.onSave?.());
      this.actions.append(save);
    }
    if (!options.network && options.onLoad) {
      const load = el('button', {
        className: 'btn btn-ghost',
        text: 'Charger une sauvegarde',
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
          text: 'Les sauvegardes locales sont désactivées pendant une partie réseau : la progression est détenue par l’hôte.',
        }),
      );
    }

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
