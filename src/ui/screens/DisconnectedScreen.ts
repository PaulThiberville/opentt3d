/**
 * Écran affiché quand la session réseau est perdue sans migration possible.
 *
 * La partie n'est jamais sauvegardée automatiquement : l'écran propose donc un
 * retour au menu, sans laisser croire que la progression est conservée.
 */

import { el } from '../dom';
import { BaseScreen } from './BaseScreen';

export interface DisconnectedScreenOptions {
  title?: string;
  reason: string;
  onMenu: () => void;
}

export class DisconnectedScreen extends BaseScreen {
  private options: DisconnectedScreenOptions;

  constructor(options: DisconnectedScreenOptions) {
    super('panel-screen disconnected-screen');
    this.options = options;

    const panel = el('div', { className: 'panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: 'Réseau' }),
      el('h1', { className: 'panel-title is-error', text: options.title ?? 'Connexion perdue' }),
      el('p', { className: 'panel-subtitle', text: options.reason }),
    );

    const note = el('p', {
      className: 'screen-note',
      text: 'Le transfert de sauvegarde et la reconnexion en cours de partie arriveront avec #38 et #39. Le salon est fermé.',
    });

    const actions = el('div', { className: 'panel-actions' });
    const menu = el('button', {
      className: 'btn btn-primary',
      text: 'Retour au menu',
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    menu.addEventListener('click', () => options.onMenu());
    actions.append(menu);

    panel.append(header, note, actions);
    this.element.append(panel);
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.options.onMenu();
    }
  }
}
