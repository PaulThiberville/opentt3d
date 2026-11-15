/**
 * Flux d'actualités du HUD : borné, horodaté en date de jeu, avec état lu.
 *
 * Le panneau s'ouvre depuis la barre supérieure ; l'ouverture marque les
 * entrées comme lues (compteur remis à zéro). Le compteur non lu est annoncé
 * via une région `aria-live` dédiée plutôt que par la liste entière, pour
 * éviter de relire toutes les actualités à chaque mise à jour.
 */

import { el } from '../dom';
import { bindAttr, bindText, onLanguageChange, t, tn } from '../i18n';
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
  private closeButton: HTMLButtonElement;
  private signature = '';
  private open = false;
  private items: readonly NewsFeedItem[] = [];
  private stopListening: () => void;

  constructor(options: NewsFeedOptions) {
    this.element = el('section', {
      className: 'hud-news-panel',
      attrs: { id: 'hud-news-panel', 'aria-label': t('news.label') },
    });
    const header = el('div', { className: 'hud-news-header' });
    const title = bindText(el('h3'), 'news.title');
    this.unreadLabel = el('span', { className: 'hud-news-unread', text: '' });
    const markAll = el('button', {
      className: 'hud-button hud-news-mark',
      text: t('news.markAll'),
      attrs: { type: 'button', title: t('news.markAllTitle') },
    });
    bindAttr(markAll, 'title', 'news.markAllTitle');
    markAll.addEventListener('click', () => options.onMarkAllRead());
    this.closeButton = el('button', {
      className: 'hud-button hud-news-close',
      text: '×',
      attrs: { type: 'button', title: t('news.close'), 'aria-label': t('news.close') },
    });
    bindAttr(this.closeButton, 'title', 'news.close');
    bindAttr(this.closeButton, 'aria-label', 'news.close');
    this.closeButton.addEventListener('click', () => options.onClose());
    header.append(title, this.unreadLabel, markAll, this.closeButton);

    this.list = el('div', { className: 'hud-news-list' });
    this.empty = bindText(el('p', { className: 'hud-news-empty' }), 'news.empty');
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

    this.stopListening = onLanguageChange(() => {
      this.element.setAttribute('aria-label', t('news.label'));
      this.renderUnread(this.items, this.unreadCount());
      this.signature = '';
      this.renderList();
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.element.hidden = false;
    this.element.classList.add('is-visible');
    this.closeButton.focus();
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
    this.renderUnread(items, unread);
    this.renderList();
  }

  private unreadCount(): number {
    return this.items.filter((item) => !item.read).length;
  }

  private renderUnread(items: readonly NewsFeedItem[], unread: number): void {
    this.unreadLabel.textContent =
      unread === 0 ? t('news.upToDate') : tn(unread, 'news.unread.one', 'news.unread.other');
    this.empty.hidden = items.length > 0;
    this.list.hidden = items.length === 0;
  }

  private renderList(): void {
    const signature = `${this.items.map((item) => `${item.id}:${item.read ? 1 : 0}`).join(',')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.list.replaceChildren();
    for (const item of this.items) {
      const row = el('article', {
        className: `hud-news-item${item.read ? '' : ' is-unread'}`,
        dataset: { newsId: `${item.id}` },
        attrs: {
          tabindex: '0',
          role: 'button',
          title: item.text,
          'aria-label': t('news.itemAria', { text: item.text }),
        },
      });
      const dot = el('span', {
        className: `hud-news-dot hud-news-dot-${item.kind}`,
        attrs: { 'aria-hidden': 'true' },
      });
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

  dispose(): void {
    this.stopListening();
  }
}
