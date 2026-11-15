/**
 * Écran de fin de partie.
 *
 * Le mock ne produit pas de condition de victoire : l'écran est un
 * placeholder propre, déclenché par l'API `GameSession.endGame(reason)` (ou
 * une faillite détectée dans le snapshot).
 */

import { el } from '../dom';
import type { GameOverSummary } from '../types';
import { BaseScreen } from './BaseScreen';

export interface GameOverScreenOptions {
  summary: GameOverSummary;
  onMenu: () => void;
  onReplay: () => void;
}

function stat(label: string, value: string): HTMLDivElement {
  const node = el('div', { className: 'stat-card' });
  node.append(
    el('span', { className: 'stat-label', text: label }),
    el('span', { className: 'stat-value', text: value }),
  );
  return node;
}

export class GameOverScreen extends BaseScreen {
  private options: GameOverScreenOptions;

  constructor(options: GameOverScreenOptions) {
    super('game-over-screen');
    this.options = options;
    const summary = options.summary;

    const panel = el('div', { className: 'panel panel-wide game-over-panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: 'Fin de partie' }),
      el('h1', { className: 'panel-title', text: summary.title }),
      el('p', { className: 'panel-subtitle', text: summary.reason }),
    );

    const grid = el('div', { className: 'stat-grid' });
    grid.append(
      stat('Entreprise', summary.company),
      stat('Date', summary.date),
      stat('Trésorerie', summary.money),
      stat('Valeur', summary.value),
      stat('Véhicules', `${summary.vehicles}`),
      stat('Gares et arrêts', `${summary.stations}`),
    );

    const note = el('p', {
      className: 'screen-note',
      text: 'Écran de démonstration : le moteur mock n’a pas de condition de victoire. Le classement complet et les statistiques arriveront avec le moteur WASM.',
    });

    const actions = el('div', { className: 'panel-actions' });
    const menu = el('button', {
      className: 'btn btn-ghost',
      text: 'Retour au menu',
      attrs: { type: 'button' },
    });
    menu.addEventListener('click', () => options.onMenu());
    const replay = el('button', {
      className: 'btn btn-primary',
      text: 'Rejouer avec les mêmes options',
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    replay.addEventListener('click', () => options.onReplay());
    actions.append(menu, replay);

    panel.append(header, grid, note, actions);
    this.element.append(panel);
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.options.onMenu();
    }
  }
}
