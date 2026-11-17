/**
 * Panneau dépôt : catalogue des modèles et véhicules sur place.
 *
 * Il n'achète rien lui-même : chaque bouton remonte au `GameSession`, qui
 * émet la commande via `Game.issueCommand` puis rafraîchit le snapshot.
 */

import { button, el } from '../dom';
import { formatInt, formatMoney } from '../format';
import { t } from '../i18n';
import type { QualityLevel } from '../../render/quality';
import type { VehicleVariant } from '../../render/vehicleModels';
import { VehicleThumbnails, thumbnailGlyph, type ThumbnailRequest } from '../vehicleThumbnail';
import type { DepotPanelView } from '../types';

export interface DepotPanelOptions {
  onBuy: (modelId: string) => void;
  onSelectVehicle: (vehicleId: number) => void;
  onStartVehicle: (vehicleId: number) => void;
  onSellVehicle: (vehicleId: number) => void;
  onClose: () => void;
  /** Service de vignettes partagé ; à défaut le panneau crée le sien. */
  thumbnails?: VehicleThumbnails;
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
  private thumbnails: VehicleThumbnails;
  private readonly ownsThumbnails: boolean;
  private quality: QualityLevel = 'medium';
  private open = false;

  constructor(options: DepotPanelOptions) {
    this.options = options;
    this.ownsThumbnails = options.thumbnails === undefined;
    this.thumbnails = options.thumbnails ?? new VehicleThumbnails();
    this.element = el('aside', {
      className: 'hud-depot',
      attrs: { 'aria-live': 'polite', 'aria-label': t('depot.label') },
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
      attrs: { type: 'button', title: t('depot.close'), 'aria-label': t('depot.close') },
    });
    close.addEventListener('click', () => this.options.onClose());
    header.append(text, this.money, close);

    this.body = el('div', { className: 'hud-panel-body' });
    this.hint = el('p', { className: 'hud-panel-hint' });
    this.element.append(header, this.body, this.hint);
    this.element.hidden = true;
  }

  update(view: DepotPanelView | null, quality: QualityLevel = this.quality): void {
    this.quality = quality;
    if (!view) {
      if (this.open) {
        this.open = false;
        // Panneau fermé : plus aucune vignette ne doit être rendue.
        this.thumbnails.suspend();
      }
      this.element.hidden = true;
      this.signature = '';
      return;
    }
    this.element.hidden = false;
    if (!this.open) {
      this.open = true;
      this.thumbnails.resume();
    }
    const signature = `${quality}|${JSON.stringify(view)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.title.textContent = view.title;
    this.detail.textContent = t('depot.headerDetail', { detail: view.detail });
    this.money.textContent = view.money;
    this.hint.textContent = view.hint;
    this.render(view);
  }

  /** Libère le contexte WebGL et le cache (démontage du HUD). */
  dispose(): void {
    if (this.ownsThumbnails) this.thumbnails.dispose();
    else this.thumbnails.suspend();
    this.open = false;
  }

  /**
   * Vignette d'une carte : image en cache ou rendue en tâche de fond.
   *
   * Le pictogramme est toujours présent sous l'image ; il reste visible tant
   * que le rendu n'est pas prêt, et sert de repli si WebGL est indisponible.
   */
  private thumbnail(variant: VehicleVariant, colour: number, className: string): HTMLElement {
    const request: ThumbnailRequest = { variant, colour, quality: this.quality };
    const box = el('div', {
      className: ['hud-depot-thumb', className].filter(Boolean).join(' '),
      attrs: { 'aria-hidden': 'true' },
      dataset: { variant, state: 'pending' },
    });
    const glyph = el('span', { className: 'hud-depot-thumb-glyph', text: thumbnailGlyph(variant) });
    const image = el('img', {
      className: 'hud-depot-thumb-image',
      attrs: { alt: '', draggable: 'false', decoding: 'async' },
    });
    box.append(glyph, image);
    this.thumbnails.request(request, (url) => {
      // Une carte retirée entre-temps est simplement ignorée par le DOM ;
      // l'écriture reste sans effet visible et ne bloque rien.
      if (!url) {
        box.dataset.state = 'fallback';
        return;
      }
      image.src = url;
      box.dataset.state = 'ready';
    });
    return box;
  }

  private render(view: DepotPanelView): void {
    this.body.replaceChildren();
    const modelsTitle = el('h3', { className: 'hud-panel-section', text: t('depot.models') });
    const models = el('div', { className: 'hud-depot-models' });
    for (const model of view.models) {
      const row = el('div', { className: 'hud-depot-model' });
      const thumb = this.thumbnail(model.variant, model.colour, 'hud-depot-thumb-model');
      const info = el('div', { className: 'hud-depot-model-info' });
      info.append(
        el('div', { className: 'hud-depot-model-name', text: model.name }),
        el('div', {
          className: 'hud-depot-model-specs',
          text: t('depot.modelSpecs', {
            cargo: model.cargo,
            capacity: model.capacity,
            speed: model.speed,
          }),
        }),
        el('div', { className: 'hud-depot-model-note', text: model.description }),
      );
      if (model.blockedReason) {
        info.append(
          el('div', {
            className: 'hud-depot-model-note hud-depot-model-warning',
            text: model.blockedReason,
          }),
        );
      }
      const blocked = model.blockedReason !== null || !model.affordable;
      const side = el('div', { className: 'hud-depot-model-side' });
      side.append(
        el('div', { className: 'hud-depot-model-price', text: formatMoney(model.cost) }),
        el('div', {
          className: 'hud-depot-model-maintenance',
          text: t('depot.maintenance', { value: formatInt(model.maintenance) }),
        }),
      );
      const buy = button(t('depot.buy'), {
        variant: 'primary',
        className: 'hud-depot-buy',
        disabled: blocked,
        attrs: {
          type: 'button',
          title: blocked
            ? (model.blockedReason ?? t('depot.buyBlocked', { name: model.name }))
            : t('depot.buyTitle', { name: model.name }),
          'aria-label': t('depot.buyAria', {
            name: model.name,
            value: formatInt(model.cost),
          }),
        },
        onClick: () => this.options.onBuy(model.id),
      });
      side.append(buy);
      row.append(thumb, info, side);
      models.append(row);
    }
    if (view.models.length === 0) {
      models.append(el('div', { className: 'hud-panel-empty', text: t('depot.none') }));
    }

    const vehiclesTitle = el('h3', { className: 'hud-panel-section', text: t('depot.vehicles') });
    const vehicles = el('div', { className: 'hud-depot-vehicles' });
    for (const vehicle of view.vehicles) {
      const row = el('div', { className: 'hud-depot-vehicle' });
      const thumb = this.thumbnail(vehicle.variant, vehicle.colour, 'hud-depot-thumb-vehicle');
      const info = el('div', { className: 'hud-depot-vehicle-info' });
      info.append(
        el('div', { className: 'hud-depot-vehicle-name', text: vehicle.name }),
        el('div', { className: 'hud-depot-vehicle-detail', text: vehicle.detail }),
      );
      const actions = el('div', { className: 'hud-depot-vehicle-actions' });
      actions.append(
        button(t('depot.select'), {
          className: 'hud-depot-action',
          onClick: () => this.options.onSelectVehicle(vehicle.id),
        }),
        button(t('depot.start'), {
          variant: 'primary',
          className: 'hud-depot-action',
          disabled: !vehicle.canStart,
          attrs: {
            type: 'button',
            title: vehicle.canStart ? t('depot.startTitle') : t('depot.startBlocked'),
          },
          onClick: () => this.options.onStartVehicle(vehicle.id),
        }),
        button(t('depot.sell'), {
          variant: 'danger',
          className: 'hud-depot-action',
          onClick: () => this.options.onSellVehicle(vehicle.id),
        }),
      );
      row.append(thumb, info, actions);
      vehicles.append(row);
    }
    if (view.vehicles.length === 0) {
      vehicles.append(el('div', { className: 'hud-panel-empty', text: t('depot.noVehicles') }));
    }

    this.body.append(modelsTitle, models, vehiclesTitle, vehicles);
  }
}
