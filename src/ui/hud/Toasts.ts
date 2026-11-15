/**
 * Toasts temporaires : file limitée à cinq entrées, disparition animée.
 */

import type { NewsKind } from '../news';
import { el } from '../dom';

export class Toasts {
  readonly element: HTMLElement;

  private timers = new Set<number>();

  constructor() {
    this.element = el('div', {
      className: 'hud-toasts',
      attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
    });
  }

  push(kind: NewsKind, text: string): void {
    const toast = el('div', { className: `hud-toast hud-toast-${kind}` });
    toast.append(
      el('span', { className: 'hud-toast-dot' }),
      el('div', { className: 'hud-toast-body', text }),
    );
    this.element.append(toast);
    while (this.element.children.length > 5) this.element.firstElementChild?.remove();

    const leaveTimer = window.setTimeout(() => {
      this.timers.delete(leaveTimer);
      toast.classList.add('is-leaving');
      const removeTimer = window.setTimeout(() => {
        this.timers.delete(removeTimer);
        toast.remove();
      }, 360);
      this.timers.add(removeTimer);
    }, 7000);
    this.timers.add(leaveTimer);
  }

  clear(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.element.replaceChildren();
  }

  dispose(): void {
    this.clear();
    this.element.remove();
  }
}
