/**
 * Bandeau d'alerte réseau (#39) : rend explicite la pause coopérative ouverte
 * quand un pair humain ne répond plus, avec les actions décidées par l'hôte
 * (continuer sans le joueur, attendre encore).
 *
 * Le composant ne décide de rien : `GameSession` fournit un `NetworkAlertView`
 * déjà traduit. Il reste compact, accessible (`role="alert"`) et ne crée aucun
 * timer.
 */

import { el } from '../dom';
import type { NetworkAlertView } from '../netlobby';

export class NetworkAlert {
  readonly element: HTMLElement;

  private body: HTMLDivElement;
  private title: HTMLSpanElement;
  private detail: HTMLSpanElement;
  private actions: HTMLDivElement;
  private signature = '';

  constructor() {
    this.element = el('div', {
      className: 'hud-net hud-net-alert',
      attrs: {
        role: 'alert',
        'aria-live': 'assertive',
        'aria-atomic': 'true',
      },
    });
    // `style.css` est hors périmètre de cette tâche : le bandeau réutilise la
    // classe `hud-net` et n'active que le strict nécessaire en ligne.
    Object.assign(this.element.style, {
      display: 'none',
      alignItems: 'center',
      gap: '10px',
      flexWrap: 'wrap',
      justifyContent: 'center',
      pointerEvents: 'auto',
      top: '96px',
      textAlign: 'left',
      borderRadius: '12px',
      padding: '8px 12px',
      maxWidth: 'min(720px, calc(100vw - 24px))',
    });

    this.title = el('span', { className: 'hud-net-alert-title' });
    this.title.style.fontWeight = '700';
    this.detail = el('span', { className: 'hud-net-alert-detail' });
    this.actions = el('div', { className: 'hud-net-alert-actions' });
    Object.assign(this.actions.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    this.body = el('div', { className: 'hud-net-alert-body' });
    Object.assign(this.body.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      flexWrap: 'wrap',
    });
    this.body.append(this.title, this.detail);
    this.element.append(this.body, this.actions);
    this.element.hidden = true;
  }

  update(view: NetworkAlertView | null): void {
    if (!view) {
      if (this.signature !== '') {
        this.signature = '';
        this.element.hidden = true;
        this.element.style.display = 'none';
        this.element.replaceChildren();
        this.body = el('div', { className: 'hud-net-alert-body' });
        this.actions = el('div', { className: 'hud-net-alert-actions' });
      }
      return;
    }
    // The countdown changes the detail every second: re-render only then.
    const signature = `${view.title}|${view.detail}|${view.actions
      .map((action) => action.label)
      .join('|')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.element.dataset.tone = view.tone === 'warn' ? 'warn' : 'wait';
    this.title.textContent = view.title;
    this.detail.textContent = view.detail;
    this.actions.replaceChildren();
    for (const action of view.actions) {
      const button = el('button', {
        className: `hud-button${action.primary ? ' is-active' : ''}`,
        text: action.label,
        attrs: { type: 'button' },
      });
      button.addEventListener('click', () => action.onSelect());
      this.actions.append(button);
    }
    this.actions.hidden = view.actions.length === 0;
    this.body.replaceChildren(this.title, this.detail);
    this.element.replaceChildren(this.body, this.actions);
    this.element.hidden = false;
    this.element.style.display = 'flex';
  }

  dispose(): void {
    this.signature = '';
    this.element.replaceChildren();
    this.element.remove();
  }
}
