/**
 * Aide concise des raccourcis clavier.
 */

import { el } from '../dom';

const CONTROLS: [string, string][] = [
  ['Clic droit / Alt + glisser', 'Orbite'],
  ['Clic gauche / molette', 'Déplacer (hors outil), zoomer'],
  ['Flèches / WASD', 'Déplacer la caméra'],
  ['Q / E', 'Pivoter'],
  ['+ / −', 'Zoomer'],
  ['Début (Home)', 'Recadrer la carte'],
  ['Clic', 'Sélectionner'],
  ['Double-clic', 'Centrer et suivre'],
  ['Routes / Rails + glisser', 'Construire un tronçon'],
  ['Ctrl + Z', 'Démolir le dernier tronçon'],
  ['Clic droit (construction)', 'Annuler le tracé'],
  ['Échap', 'Quitter l’outil / pause'],
  ['Espace', 'Pause'],
];

export class HelpPanel {
  readonly element: HTMLElement;

  private open = false;

  constructor() {
    this.element = el('aside', {
      className: 'hud-help',
      attrs: { 'aria-label': 'Aide et contrôles' },
    });
    const title = el('h3', { text: 'Contrôles' });
    const list = el('ul');
    for (const [keys, description] of CONTROLS) {
      const item = el('li');
      item.append(el('kbd', { text: keys }), el('span', { text: description }));
      list.append(item);
    }
    const hint = el('p', {
      className: 'hud-help-hint',
      text: 'Minimap : clic pour recentrer. Routes et rails : barre du bas, puis cliquez ou glissez sur la carte.',
    });
    this.element.append(title, list, hint);
    this.element.hidden = true;
  }

  isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.element.hidden = false;
  }

  hide(): void {
    this.open = false;
    this.element.hidden = true;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }
}
