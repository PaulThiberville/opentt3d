/**
 * Gestionnaire d'écrans : un seul écran courant, transition fondu/glissement
 * et focus automatique sur le premier contrôle.
 */

import { el, focusFirst } from '../dom';
import type { ScreenView } from './BaseScreen';

export interface ShowScreenOptions {
  overlay?: boolean;
}

const TRANSITION_MS = 220;

export class ScreenManager {
  /** Notifié à chaque changement d'écran (clé, ou `null` quand tout est fermé). */
  onScreenChange: ((key: string | null) => void) | null = null;
  private host: HTMLElement;
  private current: ScreenView | null = null;
  private currentKey: string | null = null;
  private timers = new Set<number>();

  constructor(mount: HTMLElement) {
    this.host = el('div', { className: 'screens' });
    mount.append(this.host);
  }

  show(key: string, view: ScreenView, options: ShowScreenOptions = {}): void {
    if (this.current) this.detach(this.current);
    this.current = view;
    this.currentKey = key;
    const element = view.element;
    element.classList.add('screen');
    element.classList.toggle('screen--overlay', options.overlay === true);
    this.host.append(element);
    // Force un reflow pour que la transition d'apparition s'exécute.
    void element.offsetWidth;
    element.classList.add('is-visible');
    view.show?.();
    this.onScreenChange?.(key);
    requestAnimationFrame(() => {
      if (this.current === view) focusFirst(element);
    });
  }

  hide(): void {
    if (!this.current) return;
    const view = this.current;
    this.current = null;
    this.currentKey = null;
    this.detach(view);
    this.onScreenChange?.(null);
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  get key(): string | null {
    return this.currentKey;
  }

  private detach(view: ScreenView): void {
    view.hide?.();
    view.element.classList.remove('is-visible');
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      view.dispose?.();
      view.element.remove();
    }, TRANSITION_MS);
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.current?.dispose?.();
    this.current = null;
    this.currentKey = null;
    this.host.remove();
  }
}
