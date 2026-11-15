/**
 * Bandeau d'aide au-dessus de la barre d'outils : outil actif, coût estimé et
 * motif d'invalidité. Purement informatif, jamais interactif.
 */

import { el } from '../dom';
import type { BuildHintView } from '../buildHint';

export class BuildHint {
  readonly element: HTMLElement;

  constructor() {
    this.element = el('div', {
      className: 'hud-build-hint',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.element.hidden = true;
  }

  update(view: BuildHintView | null): void {
    if (!view) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    this.element.dataset.tone = view.tone;
    this.element.textContent = view.text;
  }

  dispose(): void {
    this.element.remove();
  }
}
