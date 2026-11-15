/**
 * Panneau dépôt : catalogue des modèles et véhicules sur place.
 *
 * Il n'achète rien lui-même : chaque bouton remonte au `GameSession`, qui
 * émet la commande via `Game.issueCommand` puis rafraîchit le snapshot.
 */

import { button, el } from '../dom';
import { formatInt, formatMoney } from '../format';
import type { DepotPanelView } from '../types';

export interface DepotPanelOptions {
  onBuy: (modelId: string) => void;
  onSelectVehicle: (vehicleId: number) => void;
  onStartVehicle: (vehicleId: number) => void;
  onSellVehicle: (vehicleId: number) => void;
  onClose: () => void;
}

export class DepotPanel {
  readonly element: HTMLElement;

  private body: HTMLDivElement;
  private title: HTMLDivElement;
  private detail: HTMLDivElement;
  private money: HTMLSpanElement;
  private hint: HTMLParagraphElement;
  private options: DepotPanelOptions;
  private signature = '';

  constructor(options: DepotPanelOptions) {
    this.options = options;
    this.element = el('aside', {
      className: 'hud-depot',
      attrs: { 'aria-live': 'polite', 'aria-label': 'Dépôt' },
    });
    const header = el('div', { className: 'hud-panel-header' });
    const text = el('div', { className: 'hud-panel-heading' });
    this.title = el('div', { className: 'hud-panel-title' });
    this.detail = el('div', { className: 'hud-panel-detail' });
    text.append(this.title, this.detail);
    this.money = el('span', { className: 'hud-panel-money' });
    const close = el('button', {
      className: 'hud-panel-close',
      text: '×',
      attrs: { type: 'button', title: 'Fermer le dépôt', 'aria-label': 'Fermer le dépôt' },
    });
    close.addEventListener('click', () => this.options.onClose());
    header.append(text, this.money, close);

    this.body = el('div', { className: 'hud-panel-body' });
    this.hint = el('p', { className: 'hud-panel-hint' });
    this.element.append(header, this.body, this.hint);
    this.element.hidden = true;
  }

  update(view: DepotPanelView | null): void {
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
    this.detail.textContent = `Achat et gestion · ${view.detail}`;
    this.money.textContent = view.money;
    this.hint.textContent = view.hint;
    this.render(view);
  }

  private render(view: DepotPanelView): void {
    this.body.replaceChildren();
    const modelsTitle = el('h3', { className: 'hud-panel-section', text: 'Modèles disponibles' });
    const models = el('div', { className: 'hud-depot-models' });
    for (const model of view.models) {
      const row = el('div', { className: 'hud-depot-model' });
      const info = el('div', { className: 'hud-depot-model-info' });
      info.append(
        el('div', { className: 'hud-depot-model-name', text: model.name }),
        el('div', {
          className: 'hud-depot-model-specs',
          text: `${model.cargo} · ${model.capacity} unités · ${model.speed} tuiles/j`,
        }),
        el('div', { className: 'hud-depot-model-note', text: model.description }),
      );
      const side = el('div', { className: 'hud-depot-model-side' });
      side.append(
        el('div', { className: 'hud-depot-model-price', text: formatMoney(model.cost) }),
        el('div', {
          className: 'hud-depot-model-maintenance',
          text: `entretien ${formatInt(model.maintenance)} £/an`,
        }),
      );
      const buy = button('Acheter', {
        variant: 'primary',
        className: 'hud-depot-buy',
        disabled: !model.affordable,
        attrs: {
          type: 'button',
          title: model.affordable
            ? `Acheter ${model.name}`
            : `Trésorerie insuffisante pour ${model.name}`,
          'aria-label': `Acheter ${model.name} pour ${formatInt(model.cost)} livres`,
        },
        onClick: () => this.options.onBuy(model.id),
      });
      side.append(buy);
      row.append(info, side);
      models.append(row);
    }
    if (view.models.length === 0) {
      models.append(el('div', { className: 'hud-panel-empty', text: 'Aucun modèle disponible.' }));
    }

    const vehiclesTitle = el('h3', { className: 'hud-panel-section', text: 'Véhicules sur place' });
    const vehicles = el('div', { className: 'hud-depot-vehicles' });
    for (const vehicle of view.vehicles) {
      const row = el('div', { className: 'hud-depot-vehicle' });
      const info = el('div', { className: 'hud-depot-vehicle-info' });
      info.append(
        el('div', { className: 'hud-depot-vehicle-name', text: vehicle.name }),
        el('div', { className: 'hud-depot-vehicle-detail', text: vehicle.detail }),
      );
      const actions = el('div', { className: 'hud-depot-vehicle-actions' });
      actions.append(
        button('Sélectionner', {
          className: 'hud-depot-action',
          onClick: () => this.options.onSelectVehicle(vehicle.id),
        }),
        button('Démarrer', {
          variant: 'primary',
          className: 'hud-depot-action',
          disabled: !vehicle.canStart,
          attrs: {
            type: 'button',
            title: vehicle.canStart
              ? 'Démarrer la tournée'
              : 'Ajoutez d’abord une gare à la tournée',
          },
          onClick: () => this.options.onStartVehicle(vehicle.id),
        }),
        button('Vendre', {
          variant: 'danger',
          className: 'hud-depot-action',
          onClick: () => this.options.onSellVehicle(vehicle.id),
        }),
      );
      row.append(info, actions);
      vehicles.append(row);
    }
    if (view.vehicles.length === 0) {
      vehicles.append(
        el('div', { className: 'hud-panel-empty', text: 'Aucun véhicule dans ce dépôt.' }),
      );
    }

    this.body.append(modelsTitle, models, vehiclesTitle, vehicles);
  }
}
