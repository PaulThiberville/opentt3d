/**
 * Panneau lieu : ville, industrie ou gare.
 *
 * Le composant ne lit jamais le snapshot : il affiche la vue pure fournie par
 * `placeView` et remonte les intentions (fermer, recentrer, ouvrir une cible).
 * Les actions non supportées par le protocole restent des boutons désactivés,
 * accompagnés d'une explication visible : aucune dépense n'est simulée.
 */

import { button, el } from '../dom';
import { t } from '../i18n';
import type { PlacePanelAction, PlacePanelItem, PlacePanelView, PlaceTarget } from '../types';

export interface PlacePanelOptions {
  onClose: () => void;
  onFocus: (x: number, y: number) => void;
  onSelect: (target: PlaceTarget) => void;
}

const PLACE_LABEL_KEYS = {
  town: 'place.label.town',
  industry: 'place.label.industry',
  station: 'place.label.station',
} as const;

export class PlacePanel {
  readonly element: HTMLElement;

  private dot: HTMLSpanElement;
  private title: HTMLHeadingElement;
  private detail: HTMLDivElement;
  private stats: HTMLDListElement;
  private sections: HTMLDivElement;
  private actions: HTMLDivElement;
  private hint: HTMLParagraphElement;
  private options: PlacePanelOptions;
  private signature = '';
  private visible = false;

  constructor(options: PlacePanelOptions) {
    this.options = options;
    this.element = el('aside', {
      className: 'hud-place',
      attrs: {
        role: 'region',
        'aria-live': 'polite',
        'aria-labelledby': 'hud-place-title',
      },
    });
    this.element.tabIndex = -1;

    this.dot = el('span', { className: 'hud-selection-dot' });
    const heading = el('div', { className: 'hud-panel-heading' });
    this.title = el('h2', {
      className: 'hud-place-title',
      attrs: { id: 'hud-place-title' },
    });
    this.detail = el('div', { className: 'hud-panel-detail' });
    heading.append(this.title, this.detail);
    const close = el('button', {
      className: 'hud-panel-close',
      text: '×',
      attrs: {
        type: 'button',
        title: t('place.close'),
        'aria-label': t('place.close'),
      },
    });
    close.addEventListener('click', () => this.options.onClose());
    const header = el('div', { className: 'hud-place-header' });
    header.append(this.dot, heading, close);

    this.stats = el('dl', { className: 'hud-selection-stats' });
    this.sections = el('div', { className: 'hud-place-sections' });
    this.actions = el('div', {
      className: 'hud-place-actions',
      attrs: { role: 'group', 'aria-label': t('place.actions') },
    });
    this.hint = el('p', { className: 'hud-panel-hint' });

    this.element.append(header, this.stats, this.sections, this.actions, this.hint);
    this.element.hidden = true;
  }

  update(view: PlacePanelView | null): void {
    if (!view) {
      if (this.visible) this.visible = false;
      this.element.hidden = true;
      this.signature = '';
      return;
    }
    const wasHidden = !this.visible;
    this.element.hidden = false;
    this.visible = true;
    this.element.dataset.kind = view.kind;
    this.element.setAttribute('aria-label', t(PLACE_LABEL_KEYS[view.kind]));
    const signature = JSON.stringify(view);
    if (signature === this.signature) return;
    this.signature = signature;

    this.title.textContent = view.title;
    this.detail.textContent = view.detail;
    this.dot.style.background =
      view.colour === null ? 'var(--hud-accent)' : `#${view.colour.toString(16).padStart(6, '0')}`;
    this.renderStats(view);
    this.renderSections(view);
    this.renderActions(view);
    this.hint.textContent = view.hint;

    // Le panneau s'ouvre au clic sur la carte : le focus suit pour que les
    // lecteurs d'écran annoncent le contenu et que Tab atteigne ses actions.
    if (wasHidden) this.element.focus({ preventScroll: true });
  }

  private renderStats(view: PlacePanelView): void {
    this.stats.replaceChildren();
    for (const entry of view.stats) {
      const row = el('div', { className: 'hud-selection-stat' });
      row.append(
        el('dt', { text: entry.label }),
        el('dd', {
          className: entry.tone ? `is-${entry.tone}` : undefined,
          text: entry.value,
        }),
      );
      this.stats.append(row);
    }
  }

  private renderSections(view: PlacePanelView): void {
    this.sections.replaceChildren();
    for (const section of view.sections) {
      const sectionId = `hud-place-section-${view.kind}-${section.id}`;
      const element = el('section', {
        className: 'hud-place-section',
        attrs: { 'aria-labelledby': sectionId },
      });
      element.append(
        el('h3', {
          className: 'hud-panel-section',
          text: section.title,
          attrs: { id: sectionId },
        }),
      );
      if (section.items.length === 0) {
        element.append(el('p', { className: 'hud-panel-empty', text: section.empty }));
      } else {
        const list = el('ul', { className: 'hud-place-list' });
        for (const item of section.items) list.append(this.renderItem(item));
        element.append(list);
      }
      this.sections.append(element);
    }
  }

  private renderItem(item: PlacePanelItem): HTMLLIElement {
    const row = el('li', { className: 'hud-place-item' });
    const content = el('span', { className: 'hud-place-item-content' });
    content.append(
      el('span', { className: 'hud-place-item-label', text: item.label }),
      el('span', { className: 'hud-place-item-detail', text: item.detail }),
    );
    if (!item.target) {
      row.append(content);
      return row;
    }
    const target = item.target;
    const link = button('', {
      className: 'hud-place-link',
      attrs: { type: 'button', title: item.detail },
      onClick: () => this.options.onSelect(target),
    });
    link.append(content);
    row.append(link);
    return row;
  }

  private renderActions(view: PlacePanelView): void {
    this.actions.replaceChildren();
    for (const action of view.actions) {
      const group = el('div', { className: 'hud-place-action-group' });
      group.append(this.renderAction(view, action));
      if (action.reason) {
        group.append(
          el('p', {
            className: 'hud-place-note',
            text: action.reason,
            attrs: { id: this.noteId(view, action) },
          }),
        );
      }
      this.actions.append(group);
    }
  }

  private renderAction(view: PlacePanelView, action: PlacePanelAction): HTMLButtonElement {
    const supported = action.supported && action.kind === 'focus';
    const attrs: Record<string, string> = {
      type: 'button',
      title: action.reason ?? action.label,
    };
    if (!supported) attrs['aria-describedby'] = this.noteId(view, action);
    return button(action.label, {
      className: 'hud-place-action',
      disabled: !supported,
      attrs,
      onClick: supported ? () => this.options.onFocus(view.x, view.y) : undefined,
    });
  }

  private noteId(view: PlacePanelView, action: PlacePanelAction): string {
    return `hud-place-note-${view.kind}-${action.id}`;
  }
}
