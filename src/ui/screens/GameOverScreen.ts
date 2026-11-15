/**
 * Écran de fin de partie.
 *
 * Le mock ne produit pas de condition de victoire : l'écran est un
 * placeholder propre, déclenché par l'API `GameSession.endGame(reason)` (ou
 * une faillite détectée dans le snapshot).
 */

import { el } from '../dom';
import type { GameOverSummary } from '../types';
import { t } from '../i18n';
import { BaseScreen } from './BaseScreen';

export interface GameOverScreenOptions {
  summary: GameOverSummary;
  onMenu: () => void;
  /** Absent en réseau : rejouer exigerait un nouveau salon ou #38. */
  onReplay?: () => void;
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
    this.element.setAttribute('aria-label', t('gameover.eyebrow'));
    const summary = options.summary;

    const panel = el('div', { className: 'panel panel-wide game-over-panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: t('gameover.eyebrow') }),
      el('h1', { className: 'panel-title', text: summary.title }),
      el('p', { className: 'panel-subtitle', text: summary.reason }),
    );

    const grid = el('div', { className: 'stat-grid' });
    grid.append(
      stat(t('gameover.stats.company'), summary.company),
      stat(t('gameover.stats.date'), summary.date),
      stat(t('gameover.stats.money'), summary.money),
      stat(t('gameover.stats.value'), summary.value),
      stat(t('gameover.stats.vehicles'), `${summary.vehicles}`),
      stat(t('gameover.stats.stations'), `${summary.stations}`),
    );

    const note = el('p', {
      className: 'screen-note',
      text: t('gameover.note'),
    });

    const actions = el('div', { className: 'panel-actions' });
    const menu = el('button', {
      className: 'btn btn-ghost',
      text: t('common.backToMenu'),
      attrs: { type: 'button' },
    });
    menu.addEventListener('click', () => options.onMenu());
    if (options.onReplay) {
      const replay = el('button', {
        className: 'btn btn-primary',
        text: t('gameover.replay'),
        attrs: { type: 'button', 'data-autofocus': '' },
      });
      replay.addEventListener('click', () => options.onReplay?.());
      actions.append(menu, replay);
    } else {
      menu.setAttribute('data-autofocus', '');
      menu.classList.remove('btn-ghost');
      menu.classList.add('btn-primary');
      actions.append(menu);
    }

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
