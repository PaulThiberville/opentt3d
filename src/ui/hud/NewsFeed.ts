/**
 * Flux d'actualités du HUD : borné, horodaté en date de jeu, avec état lu.
 *
 * Le panneau s'ouvre depuis la barre supérieure ; l'ouverture marque les
 * entrées comme lues (compteur remis à zéro).
 */

import { el } from '../dom';
import type { NewsFeedItem } from '../types';

export interface NewsFeedOptions {
  onMarkAllRead: () => void;
  onRead: (id: number) => void;
  onClose: () => void;
}

export class NewsFeed {
  readonly element: HTMLElement;

  private list: HTMLDivElement;
  private empty: HTMLParagraphElement;
  private unreadLabel: HTMLSpanElement;
  private signature = '';
  private open = false;
  private items: readonly NewsFeedItem[] = [];

  constructor(options: NewsFeedOptions) {
    this.element = el('section', {
      className: 'hud-news-panel',
      attrs: { 'aria-label': 'Actualités', 'aria-live': 'polite' },
    });
    const header = el('div', { className: 'hud-news-header' });
    const title = el('h3', { text: 'Actualités' });
    this.unreadLabel = el('span', { className: 'hud-news-unread', text: '0 non lue' });
    const markAll = el('button', {
      className: 'hud-button hud-news-mark',
      text: 'Tout lire',
      attrs: { type: 'button', title: 'Marquer toutes les actualités comme lues' },
    });
    markAll.addEventListener('click', () => options.onMarkAllRead());
    const close = el('button', {
      className: 'hud-button hud-news-close',
      text: '×',
      attrs: { type: 'button', title: 'Fermer', 'aria-label': 'Fermer les actualités' },
    });
    close.addEventListener('click', () => options.onClose());
    header.append(title, this.unreadLabel, markAll, close);

    this.list = el('div', { className: 'hud-news-list' });
    this.empty = el('p', {
      className: 'hud-news-empty',
      text: 'Aucune actualité pour le moment.',
    });
    this.element.append(header, this.list, this.empty);
    this.element.hidden = true;

    const activate = (target: EventTarget | null): void => {
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest<HTMLElement>('[data-news-id]');
      if (!item) return;
      const id = Number(item.dataset.newsId);
      if (Number.isFinite(id)) options.onRead(id);
    };
    this.list.addEventListener('click', (event) => activate(event.target));
    this.list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate(event.target);
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.element.hidden = false;
    this.element.classList.add('is-visible');
  }

  hide(): void {
    this.open = false;
    this.element.classList.remove('is-visible');
    this.element.hidden = true;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  update(items: readonly NewsFeedItem[], unread: number): void {
    this.items = items;
    const signature = `${unread}|${items.map((item) => `${item.id}:${item.read ? 1 : 0}`).join(',')}`;
    this.unreadLabel.textContent =
      unread === 0 ? 'À jour' : `${unread} non lue${unread > 1 ? 's' : ''}`;
    this.empty.hidden = items.length > 0;
    this.list.hidden = items.length === 0;
    if (signature === this.signature) return;
    this.signature = signature;
    this.list.replaceChildren();
    for (const item of items) {
      const row = el('article', {
        className: `hud-news-item${item.read ? '' : ' is-unread'}`,
        dataset: { newsId: `${item.id}` },
        attrs: { tabindex: '0', title: item.text },
      });
      const dot = el('span', { className: `hud-news-dot hud-news-dot-${item.kind}` });
      const body = el('div', { className: 'hud-news-body' });
      body.append(
        el('p', { className: 'hud-news-text', text: item.text }),
        el('span', { className: 'hud-news-time', text: item.dateLabel }),
      );
      row.append(dot, body);
      this.list.append(row);
    }
  }

  getItems(): readonly NewsFeedItem[] {
    return this.items;
  }
}
