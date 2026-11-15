/**
 * Aide concise des raccourcis clavier.
 */

import { el } from '../dom';
import { bindText, onLanguageChange, t, type TranslationKey } from '../i18n';

const CONTROLS: [TranslationKey, TranslationKey][] = [
  ['help.controls.orbit.keys', 'help.controls.orbit.desc'],
  ['help.controls.pan.keys', 'help.controls.pan.desc'],
  ['help.controls.move.keys', 'help.controls.move.desc'],
  ['help.controls.rotate.keys', 'help.controls.rotate.desc'],
  ['help.controls.zoom.keys', 'help.controls.zoom.desc'],
  ['help.controls.home.keys', 'help.controls.home.desc'],
  ['help.controls.select.keys', 'help.controls.select.desc'],
  ['help.controls.follow.keys', 'help.controls.follow.desc'],
  ['help.controls.build.keys', 'help.controls.build.desc'],
  ['help.controls.place.keys', 'help.controls.place.desc'],
  ['help.controls.rotateBuild.keys', 'help.controls.rotateBuild.desc'],
  ['help.controls.undo.keys', 'help.controls.undo.desc'],
  ['help.controls.cancel.keys', 'help.controls.cancel.desc'],
  ['help.controls.depot.keys', 'help.controls.depot.desc'],
  ['help.controls.orders.keys', 'help.controls.orders.desc'],
  ['help.controls.escape.keys', 'help.controls.escape.desc'],
  ['help.controls.space.keys', 'help.controls.space.desc'],
];

export class HelpPanel {
  readonly element: HTMLElement;

  private open = false;
  private list: HTMLUListElement;
  private hint: HTMLParagraphElement;
  private stopListening: () => void;

  constructor() {
    this.element = el('aside', {
      className: 'hud-help',
      attrs: { 'aria-label': t('help.label') },
    });
    const title = bindText(el('h3'), 'help.title');
    this.list = el('ul');
    this.hint = bindText(el('p', { className: 'hud-help-hint' }), 'help.hint');
    this.element.append(title, this.list, this.hint);
    this.element.hidden = true;
    this.renderList();
    this.stopListening = onLanguageChange(() => {
      this.element.setAttribute('aria-label', t('help.label'));
      this.renderList();
    });
  }

  private renderList(): void {
    this.list.replaceChildren();
    for (const [keys, description] of CONTROLS) {
      const item = el('li');
      item.append(el('kbd', { text: t(keys) }), el('span', { text: t(description) }));
      this.list.append(item);
    }
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

  dispose(): void {
    this.stopListening();
  }
}
