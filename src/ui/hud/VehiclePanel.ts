/**
 * Panneau véhicule : état, actions et éditeur de tournée.
 *
 * Les ordres sont affichés dans l'ordre du snapshot ; chaque modification
 * remonte au `GameSession` qui émet une commande `vehicle.order` complète.
 */

import { button, el } from '../dom';
import type { VehiclePanelView } from '../types';

export interface VehiclePanelOptions {
  onClear: () => void;
  onStart: (vehicleId: number) => void;
  onStop: (vehicleId: number) => void;
  onSell: (vehicleId: number) => void;
  onAddOrder: (vehicleId: number) => void;
  onRemoveOrder: (vehicleId: number, index: number) => void;
  onMoveOrder: (vehicleId: number, index: number, delta: -1 | 1) => void;
}

const ORDER_KIND_LABELS: Record<VehiclePanelView['orders'][number]['kind'], string> = {
  station: 'Gare',
  industry: 'Industrie',
  depot: 'Dépôt',
};

export class VehiclePanel {
  readonly element: HTMLElement;

  private dot: HTMLSpanElement;
  private title: HTMLDivElement;
  private detail: HTMLDivElement;
  private stats: HTMLDListElement;
  private actions: HTMLDivElement;
  private orderList: HTMLOListElement;
  private orderTitle: HTMLHeadingElement;
  private hint: HTMLParagraphElement;
  private options: VehiclePanelOptions;
  private signature = '';

  constructor(options: VehiclePanelOptions) {
    this.options = options;
    this.element = el('aside', {
      className: 'hud-vehicle',
      attrs: { 'aria-live': 'polite', 'aria-label': 'Véhicule sélectionné' },
    });
    this.dot = el('span', { className: 'hud-selection-dot' });
    const text = el('div', { className: 'hud-selection-text' });
    this.title = el('div', { className: 'hud-selection-title' });
    this.detail = el('div', { className: 'hud-selection-detail' });
    this.stats = el('dl', { className: 'hud-selection-stats' });
    text.append(this.title, this.detail, this.stats);
    const close = el('button', {
      className: 'hud-selection-close',
      text: '×',
      attrs: { type: 'button', title: 'Fermer la sélection', 'aria-label': 'Fermer la sélection' },
    });
    close.addEventListener('click', () => this.options.onClear());
    const header = el('div', { className: 'hud-vehicle-header' });
    header.append(this.dot, text, close);

    this.actions = el('div', { className: 'hud-vehicle-actions' });
    this.orderTitle = el('h3', { className: 'hud-panel-section', text: 'Tournée' });
    this.orderList = el('ol', { className: 'hud-orders' });
    this.hint = el('p', { className: 'hud-panel-hint' });
    this.element.append(header, this.actions, this.orderTitle, this.orderList, this.hint);
    this.element.hidden = true;
  }

  update(view: VehiclePanelView | null): void {
    if (!view) {
      this.element.hidden = true;
      this.signature = '';
      return;
    }
    this.element.hidden = false;
    const signature = JSON.stringify(view);
    if (signature === this.signature) return;
    this.signature = signature;

    this.title.textContent = view.title;
    this.detail.textContent = view.detail;
    this.dot.style.background =
      view.colour === null ? 'var(--hud-accent)' : `#${view.colour.toString(16).padStart(6, '0')}`;
    this.renderStats(view);
    this.renderActions(view);
    this.renderOrders(view);
    this.hint.textContent = view.hint;
    this.hint.dataset.tone = view.orderPicking
      ? 'picking'
      : view.orders.length === 0
        ? 'empty'
        : 'idle';
  }

  private renderStats(view: VehiclePanelView): void {
    this.stats.replaceChildren();
    for (const stat of view.stats) {
      const row = el('div', { className: 'hud-selection-stat' });
      row.append(
        el('dt', { text: stat.label }),
        el('dd', { className: stat.tone ? `is-${stat.tone}` : undefined, text: stat.value }),
      );
      this.stats.append(row);
    }
  }

  private renderActions(view: VehiclePanelView): void {
    const id = view.selection.id;
    this.actions.replaceChildren();
    this.actions.append(
      button('Démarrer', {
        variant: 'primary',
        className: 'hud-vehicle-action',
        disabled: !view.canStart,
        attrs: {
          type: 'button',
          title: view.canStart
            ? 'Démarrer la tournée'
            : 'Ajoutez au moins un ordre avant de démarrer',
        },
        onClick: () => this.options.onStart(id),
      }),
      button('Arrêter', {
        className: 'hud-vehicle-action',
        disabled: !view.canStop,
        attrs: { type: 'button', title: 'Arrêter le véhicule sur place' },
        onClick: () => this.options.onStop(id),
      }),
      button('Vendre', {
        variant: 'danger',
        className: 'hud-vehicle-action',
        onClick: () => this.options.onSell(id),
      }),
      button(view.orderPicking ? 'Annuler l’ajout' : 'Ajouter une gare', {
        className: `hud-vehicle-action${view.orderPicking ? ' is-active' : ''}`,
        attrs: {
          type: 'button',
          'aria-pressed': view.orderPicking ? 'true' : 'false',
          title: 'Cliquer ensuite sur une gare ou un dépôt de la carte',
        },
        onClick: () => this.options.onAddOrder(id),
      }),
    );
  }

  private renderOrders(view: VehiclePanelView): void {
    const id = view.selection.id;
    this.orderList.replaceChildren();
    if (view.orders.length === 0) {
      this.orderList.append(
        el('li', { className: 'hud-order-empty', text: 'Aucun ordre pour l’instant.' }),
      );
      return;
    }
    for (const order of view.orders) {
      const row = el('li', { className: 'hud-order' });
      const up = button('↑', {
        className: 'hud-order-button',
        disabled: order.index === 0,
        attrs: {
          type: 'button',
          title: 'Monter l’ordre',
          'aria-label': `Monter l’ordre ${order.index + 1}`,
        },
        onClick: () => this.options.onMoveOrder(id, order.index, -1),
      });
      const down = button('↓', {
        className: 'hud-order-button',
        disabled: order.index === view.orders.length - 1,
        attrs: {
          type: 'button',
          title: 'Descendre l’ordre',
          'aria-label': `Descendre l’ordre ${order.index + 1}`,
        },
        onClick: () => this.options.onMoveOrder(id, order.index, 1),
      });
      const remove = button('×', {
        className: 'hud-order-button hud-order-remove',
        attrs: {
          type: 'button',
          title: 'Retirer cet ordre',
          'aria-label': `Retirer l’ordre ${order.index + 1}`,
        },
        onClick: () => this.options.onRemoveOrder(id, order.index),
      });
      row.append(
        el('span', { className: 'hud-order-index', text: String(order.index + 1) }),
        el('span', { className: 'hud-order-label', text: order.label }),
        el('span', { className: 'hud-order-kind', text: ORDER_KIND_LABELS[order.kind] }),
        up,
        down,
        remove,
      );
      this.orderList.append(row);
    }
  }
}
