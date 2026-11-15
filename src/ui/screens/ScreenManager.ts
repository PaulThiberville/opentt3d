/**
 * Gestionnaire d'écrans : un seul écran courant, transition fondu/glissement,
 * focus automatique sur le premier contrôle et restitution du focus au retour
 * dans le jeu. Les raccourcis de caméra sont filtrés tant qu'un écran est
 * ouvert.
 */

import { el, focusFirst, installGameKeyGuard, prefersReducedMotion } from '../dom';
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
  private previousFocus: HTMLElement | null = null;
  private removeKeyGuard: () => void;

  constructor(mount: HTMLElement) {
    this.host = el('div', { className: 'screens' });
    mount.append(this.host);
    this.removeKeyGuard = installGameKeyGuard();
  }

  show(key: string, view: ScreenView, options: ShowScreenOptions = {}): void {
    if (!this.current) this.previousFocus = this.captureFocus();
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
      if (this.current !== view) return;
      focusFirst(element);
      // Aucun contrôle focusable : le dialogue lui-même porte le focus.
      if (!element.contains(document.activeElement)) element.focus();
    });
  }

  hide(): void {
    if (!this.current) return;
    const view = this.current;
    const previous = this.previousFocus;
    this.current = null;
    this.currentKey = null;
    this.previousFocus = null;
    this.detach(view);
    this.onScreenChange?.(null);
    this.schedule(() => {
      if (this.current === null && previous?.isConnected) previous.focus();
    });
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  get key(): string | null {
    return this.currentKey;
  }

  private captureFocus(): HTMLElement | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (active === document.body) return null;
    if (active.closest('.screens')) return null;
    return active;
  }

  private schedule(callback: () => void): void {
    const delay = prefersReducedMotion() ? 0 : TRANSITION_MS;
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private detach(view: ScreenView): void {
    view.hide?.();
    view.element.classList.remove('is-visible');
    this.schedule(() => {
      view.dispose?.();
      view.element.remove();
    });
  }

  dispose(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.current?.dispose?.();
    this.current = null;
    this.currentKey = null;
    this.removeKeyGuard();
    this.host.remove();
  }
}
