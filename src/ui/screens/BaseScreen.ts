/**
 * Base des écrans : un élément racine et un gestionnaire clavier attaché
 * uniquement pendant que l'écran est affiché.
 */

import { el, focusableElements, resolveFocusTrap } from '../dom';

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
    // Nomme le dialogue à partir de son titre si l'écran n'en fournit pas.
    if (!this.element.hasAttribute('aria-label') && !this.element.hasAttribute('aria-labelledby')) {
      const heading = this.element.querySelector('h1, h2');
      const label = heading?.textContent?.trim();
      if (label) this.element.setAttribute('aria-label', label);
    }
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

  /**
   * Élément qui borne le focus. Un écran peut rétrécir la portée quand un
   * sous-dialogue (confirmation) est ouvert.
   */
  protected focusScope(): HTMLElement {
    return this.element;
  }

  /** Garde le focus dans l'écran courant (le HUD derrière reste inerte). */
  private trapFocus(event: KeyboardEvent): void {
    const scope = this.focusScope();
    const items = focusableElements(scope);
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const target = resolveFocusTrap(items.length, index, event.shiftKey);
    if (target === null) return;
    items[target]?.focus();
    event.preventDefault();
  }

  protected onKeyDown(event: KeyboardEvent): void {
    // Par défaut, aucun raccourci global : Tab et les contrôles natifs suffisent.
    void event;
  }
}
