/**
 * Base des écrans : un élément racine et un gestionnaire clavier attaché
 * uniquement pendant que l'écran est affiché.
 */

import { el, focusableElements } from '../dom';

export interface ScreenView {
  readonly element: HTMLElement;
  show?(): void;
  hide?(): void;
  dispose?(): void;
}

export abstract class BaseScreen implements ScreenView {
  readonly element: HTMLElement;

  constructor(className: string) {
    this.element = el('section', { className });
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.tabIndex = -1;
  }

  show(): void {
    document.addEventListener('keydown', this.handleKeyDown);
  }

  hide(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  dispose(): void {
    this.hide();
    this.element.remove();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.key === 'Tab') {
      this.trapFocus(event);
      return;
    }
    this.onKeyDown(event);
  };

  /** Garde le focus dans l'écran courant (le HUD derrière reste inerte). */
  private trapFocus(event: KeyboardEvent): void {
    const items = focusableElements(this.element);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && this.element.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && (!inside || active === last)) {
      first.focus();
      event.preventDefault();
    }
  }

  protected onKeyDown(event: KeyboardEvent): void {
    // Par défaut, aucun raccourci global : Tab et les contrôles natifs suffisent.
    void event;
  }
}
