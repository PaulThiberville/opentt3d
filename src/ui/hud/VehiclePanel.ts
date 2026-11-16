/**
 * Panneau véhicule : état, actions, refit et éditeur de tournée.
 *
 * Depuis #160/#161, le panneau couvre la reconfiguration de cargaison, les
 * options d'ordre (plein chargement, transfert, conditions, sauts, horaires),
 * le partage de tournée et la duplication de véhicule. Les ordres sont
 * affichés dans l'ordre du snapshot ; chaque modification remonte au
 * `GameSession` qui émet une commande `vehicle.*` complète.
 */

import type {
  OrderAction,
  OrderComparator,
  OrderCondition,
  OrderConditionType,
  OrderOptions,
} from '../../engine/protocol';
import {
  ORDER_ACTION_LABELS,
  ORDER_COMPARATORS,
  ORDER_CONDITION_TYPES,
  cloneOrderOptions,
} from '../../game/vehicleRules';
import { button, el } from '../dom';
import { t, type TranslationKey } from '../i18n';
import { CARGO_LABEL_KEYS, cargoLabel } from '../labels';
import type { VehicleOrderView, VehiclePanelView } from '../types';

export interface VehiclePanelOptions {
  onClear: () => void;
  onStart: (vehicleId: number) => void;
  onStop: (vehicleId: number) => void;
  onSell: (vehicleId: number) => void;
  onAddOrder: (vehicleId: number) => void;
  onRemoveOrder: (vehicleId: number, index: number) => void;
  onMoveOrder: (vehicleId: number, index: number, delta: -1 | 1) => void;
  onRefit: (vehicleId: number, cargo: string) => void;
  onUpdateOrder: (vehicleId: number, index: number, options: OrderOptions) => void;
  onAddConditional: (vehicleId: number) => void;
  onShareOrders: (vehicleId: number, targetId: number) => void;
  onCloneVehicle: (vehicleId: number) => void;
  onService: (vehicleId: number) => void;
  onSendToDepot: (vehicleId: number) => void;
}

const ORDER_KIND_KEYS: Record<VehicleOrderView['kind'], TranslationKey> = {
  station: 'build.station.generic',
  industry: 'label.tile.industry',
  depot: 'depot.kind',
  conditional: 'vehicle.orderConditional',
};

const ORDER_ACTION_KEYS: Record<OrderAction, TranslationKey> = {
  normal: 'order.action.normal',
  full_load: 'order.action.fullLoad',
  no_load: 'order.action.noLoad',
  unload: 'order.action.unload',
  transfer: 'order.action.transfer',
};

const ORDER_CONDITION_KEYS: Record<OrderConditionType, TranslationKey> = {
  cargo: 'order.condition.cargo',
  money: 'order.condition.money',
  date: 'order.condition.date',
  percentage: 'order.condition.percentage',
};

const ORDER_COMPARATOR_KEYS: Record<OrderComparator, TranslationKey> = {
  equal: 'order.comparator.equal',
  not_equal: 'order.comparator.notEqual',
  less: 'order.comparator.less',
  less_or_equal: 'order.comparator.lessOrEqual',
  more: 'order.comparator.more',
  more_or_equal: 'order.comparator.moreOrEqual',
};

/** Cargaisons proposées dans l'éditeur de condition. */
const CONDITION_CARGOS = Object.keys(CARGO_LABEL_KEYS);

function rowMain(label: string, badges: HTMLElement): HTMLSpanElement {
  const main = el('span', { className: 'hud-order-main' });
  main.append(el('span', { className: 'hud-order-label', text: label }), badges);
  return main;
}

function select(
  options: { value: string; label: string }[],
  value: string,
  onChange: (value: string) => void,
  label: string,
): HTMLLabelElement {
  const control = el('select', { className: 'hud-order-input' });
  for (const option of options) {
    const item = el('option', { text: option.label });
    item.value = option.value;
    if (option.value === value) item.selected = true;
    control.append(item);
  }
  control.addEventListener('change', () => onChange(control.value));
  const wrapper = el('label', { className: 'hud-order-field' });
  wrapper.append(el('span', { className: 'hud-order-field-label', text: label }), control);
  return wrapper;
}

function numberField(
  value: number | undefined,
  onChange: (value: number | undefined) => void,
  label: string,
  attrs: Record<string, string> = {},
): HTMLLabelElement {
  const input = el('input', {
    className: 'hud-order-input',
    attrs: { type: 'number', ...attrs },
  });
  if (value !== undefined) input.value = String(value);
  input.addEventListener('input', () => {
    const parsed = Number.parseInt(input.value, 10);
    onChange(Number.isFinite(parsed) ? parsed : undefined);
  });
  const wrapper = el('label', { className: 'hud-order-field' });
  wrapper.append(el('span', { className: 'hud-order-field-label', text: label }), input);
  return wrapper;
}

export class VehiclePanel {
  readonly element: HTMLElement;

  private dot: HTMLSpanElement;
  private title: HTMLDivElement;
  private detail: HTMLDivElement;
  private stats: HTMLDListElement;
  private actions: HTMLDivElement;
  private refitSection: HTMLElement;
  private refitList: HTMLDivElement;
  private orderTitle: HTMLHeadingElement;
  private orderList: HTMLOListElement;
  private editor: HTMLDivElement;
  private shareSection: HTMLElement;
  private shareList: HTMLDivElement;
  private hint: HTMLParagraphElement;
  private options: VehiclePanelOptions;
  private signature = '';
  private lastView: VehiclePanelView | null = null;
  private editingIndex: number | null = null;
  private editingVehicle: number | null = null;
  private shareTarget: number | null = null;

  constructor(options: VehiclePanelOptions) {
    this.options = options;
    this.element = el('aside', {
      className: 'hud-vehicle',
      attrs: { 'aria-live': 'polite', 'aria-label': t('vehicle.label') },
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
      attrs: { type: 'button', title: t('selection.close'), 'aria-label': t('selection.close') },
    });
    close.addEventListener('click', () => this.options.onClear());
    const header = el('div', { className: 'hud-vehicle-header' });
    header.append(this.dot, text, close);

    this.actions = el('div', { className: 'hud-vehicle-actions' });
    this.refitSection = el('section', { className: 'hud-vehicle-section' });
    this.refitList = el('div', { className: 'hud-refit-list' });
    this.refitSection.append(
      el('h3', { className: 'hud-panel-section', text: t('vehicle.refitTitle') }),
      this.refitList,
    );
    this.orderTitle = el('h3', { className: 'hud-panel-section', text: t('vehicle.orderTitle') });
    this.orderList = el('ol', { className: 'hud-orders' });
    this.editor = el('div', { className: 'hud-order-editor' });
    this.editor.hidden = true;
    this.shareSection = el('section', { className: 'hud-vehicle-section' });
    this.shareList = el('div', { className: 'hud-share' });
    this.shareSection.append(
      el('h3', { className: 'hud-panel-section', text: t('vehicle.shareTitle') }),
      this.shareList,
    );
    this.hint = el('p', { className: 'hud-panel-hint' });
    this.element.append(
      header,
      this.actions,
      this.refitSection,
      this.orderTitle,
      this.orderList,
      this.editor,
      this.shareSection,
      this.hint,
    );
    this.element.hidden = true;
  }

  update(view: VehiclePanelView | null): void {
    if (!view) {
      this.element.hidden = true;
      this.signature = '';
      this.lastView = null;
      this.closeEditor();
      return;
    }
    this.element.hidden = false;
    const vehicleId = view.selection.id;
    if (this.editingVehicle !== null && this.editingVehicle !== vehicleId) this.closeEditor();
    const signature = JSON.stringify(view);
    if (signature === this.signature) return;
    this.signature = signature;
    this.lastView = view;

    this.title.textContent = view.title;
    this.detail.textContent = view.detail;
    this.dot.style.background =
      view.colour === null ? 'var(--hud-accent)' : `#${view.colour.toString(16).padStart(6, '0')}`;
    this.renderStats(view);
    this.renderActions(view);
    this.renderRefit(view);
    this.renderOrders(view);
    this.renderShare(view);
    this.hint.textContent = view.hint;
    this.hint.dataset.tone = view.orderPicking
      ? 'picking'
      : view.orders.length === 0
        ? 'empty'
        : 'idle';
  }

  private renderStats(view: VehiclePanelView): void {
    this.stats.replaceChildren();
    const stats = [...view.stats];
    if (view.modelName) stats.push({ label: t('vehicle.modelStat'), value: view.modelName });
    if (view.groupLabel) {
      stats.push({ label: t('vehicle.group'), value: view.groupLabel });
    }
    if (view.reliability) {
      stats.push(
        {
          label: t('vehicle.reliability.reliability'),
          value: view.reliability.reliabilityLabel,
          tone:
            view.reliability.reliability <= 30
              ? 'bad'
              : view.reliability.reliability <= 60
                ? undefined
                : 'good',
        },
        { label: t('vehicle.reliability.wear'), value: view.reliability.wearLabel },
        {
          label: t('vehicle.reliability.maintenance'),
          value: view.reliability.maintenanceLabel,
        },
        {
          label: t('vehicle.reliability.serviceCost'),
          value: view.reliability.serviceCostLabel,
        },
      );
      if (view.reliability.breakdownLabel) {
        stats.push({
          label: t('vehicle.reliability.breakdown'),
          value: view.reliability.breakdownLabel,
          tone: 'bad',
        });
      }
    }
    for (const stat of stats) {
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
      button(t('depot.start'), {
        variant: 'primary',
        className: 'hud-vehicle-action',
        disabled: !view.canStart,
        attrs: {
          type: 'button',
          title: view.canStart ? t('depot.startTitle') : t('vehicle.startBlocked'),
        },
        onClick: () => this.options.onStart(id),
      }),
      button(t('vehicle.stop'), {
        className: 'hud-vehicle-action',
        disabled: !view.canStop,
        attrs: { type: 'button', title: t('vehicle.stopTitle') },
        onClick: () => this.options.onStop(id),
      }),
      button(t('depot.sell'), {
        variant: 'danger',
        className: 'hud-vehicle-action',
        onClick: () => this.options.onSell(id),
      }),
      button(view.orderPicking ? t('vehicle.cancelOrder') : t('vehicle.addOrder'), {
        className: `hud-vehicle-action${view.orderPicking ? ' is-active' : ''}`,
        attrs: {
          type: 'button',
          'aria-pressed': view.orderPicking ? 'true' : 'false',
          title: t('vehicle.orderPickTitle'),
        },
        onClick: () => this.options.onAddOrder(id),
      }),
      button(t('vehicle.addConditional'), {
        className: 'hud-vehicle-action',
        disabled: view.orders.length === 0,
        attrs: { type: 'button', title: t('vehicle.addConditionalTitle') },
        onClick: () => this.options.onAddConditional(id),
      }),
      button(t('vehicle.reliability.service'), {
        className: 'hud-vehicle-action',
        disabled: !view.reliability,
        attrs: {
          type: 'button',
          title: t('vehicle.reliability.serviceTitle'),
        },
        onClick: () => this.options.onService(id),
      }),
      button(t('vehicle.reliability.sendToDepot'), {
        className: 'hud-vehicle-action',
        disabled: !view.canSendToDepot,
        attrs: {
          type: 'button',
          title: t('vehicle.reliability.sendToDepotTitle'),
        },
        onClick: () => this.options.onSendToDepot(id),
      }),
    );
  }

  private renderRefit(view: VehiclePanelView): void {
    this.refitList.replaceChildren();
    if (view.refits.length === 0) {
      this.refitList.append(
        el('p', { className: 'hud-panel-empty', text: t('vehicle.refitEmpty') }),
      );
      return;
    }
    if (!view.inDepot) {
      this.refitList.append(
        el('p', { className: 'hud-panel-hint', text: t('vehicle.refitInDepot') }),
      );
    } else if (view.cargoAtRisk > 0) {
      this.refitList.append(
        el('p', {
          className: 'hud-panel-hint is-warning',
          text: t('vehicle.refitLoss', { amount: view.cargoAtRisk }),
        }),
      );
    }
    for (const refit of view.refits) {
      const card = el('div', {
        className: `hud-refit-option${refit.available ? '' : ' is-disabled'}`,
      });
      const info = el('div', { className: 'hud-refit-info' });
      info.append(
        el('div', { className: 'hud-refit-name', text: refit.label }),
        el('div', {
          className: 'hud-refit-specs',
          text: t('vehicle.refitSpecs', {
            capacity: refit.capacity,
            cost: refit.cost,
          }),
        }),
      );
      if (refit.reason) {
        info.append(el('div', { className: 'hud-refit-reason', text: refit.reason }));
      }
      card.append(
        info,
        button(t('vehicle.refitButton'), {
          className: 'hud-depot-action',
          disabled: !refit.available,
          attrs: {
            type: 'button',
            title: refit.reason ?? t('vehicle.refitButtonTitle', { cargo: refit.label }),
          },
          onClick: () => this.options.onRefit(view.selection.id, refit.cargo),
        }),
      );
      this.refitList.append(card);
    }
  }

  private renderOrders(view: VehiclePanelView): void {
    const id = view.selection.id;
    this.orderList.replaceChildren();
    if (view.orders.length === 0) {
      this.orderList.append(
        el('li', { className: 'hud-order-empty', text: t('vehicle.noOrders') }),
      );
      return;
    }
    for (const order of view.orders) {
      const row = el('li', {
        className: `hud-order${order.current ? ' is-current' : ''}`,
      });
      const up = button('↑', {
        className: 'hud-order-button',
        disabled: order.index === 0,
        attrs: {
          type: 'button',
          title: t('vehicle.orderUpTitle'),
          'aria-label': t('vehicle.orderUpAria', { index: order.index + 1 }),
        },
        onClick: () => this.options.onMoveOrder(id, order.index, -1),
      });
      const down = button('↓', {
        className: 'hud-order-button',
        disabled: order.index === view.orders.length - 1,
        attrs: {
          type: 'button',
          title: t('vehicle.orderDownTitle'),
          'aria-label': t('vehicle.orderDownAria', { index: order.index + 1 }),
        },
        onClick: () => this.options.onMoveOrder(id, order.index, 1),
      });
      const edit = button('✎', {
        className: 'hud-order-button',
        attrs: {
          type: 'button',
          title: t('vehicle.orderEditTitle'),
          'aria-label': t('vehicle.orderEditAria', { index: order.index + 1 }),
        },
        onClick: () => this.openEditor(view, order),
      });
      const remove = button('×', {
        className: 'hud-order-button hud-order-remove',
        attrs: {
          type: 'button',
          title: t('vehicle.orderRemoveTitle'),
          'aria-label': t('vehicle.orderRemoveAria', { index: order.index + 1 }),
        },
        onClick: () => {
          if (this.editingIndex === order.index) this.closeEditor();
          this.options.onRemoveOrder(id, order.index);
        },
      });
      const badges = el('span', { className: 'hud-order-badges' });
      if (order.kind !== 'conditional') {
        badges.append(
          el('span', {
            className: `hud-order-badge is-${order.action}`,
            text: t(ORDER_ACTION_KEYS[order.action]),
          }),
        );
      }
      if (order.conditionLabel) {
        badges.append(
          el('span', { className: 'hud-order-badge is-condition', text: order.conditionLabel }),
        );
      }
      if (order.timetableLabel) {
        badges.append(
          el('span', { className: 'hud-order-badge is-timetable', text: order.timetableLabel }),
        );
      }
      row.append(
        el('span', {
          className: 'hud-order-index',
          text: `${order.current ? '▶' : order.index + 1}`,
        }),
        rowMain(order.label, badges),
        el('span', { className: 'hud-order-kind', text: t(ORDER_KIND_KEYS[order.kind]) }),
        edit,
        up,
        down,
        remove,
      );
      this.orderList.append(row);
    }
  }

  private renderShare(view: VehiclePanelView): void {
    this.shareList.replaceChildren();
    if (view.shareCandidates.length === 0) {
      this.shareList.append(
        el('p', { className: 'hud-panel-empty', text: t('vehicle.shareNone') }),
      );
      return;
    }
    const candidates = view.shareCandidates;
    if (!candidates.some((candidate) => candidate.id === this.shareTarget)) {
      this.shareTarget = candidates[0]?.id ?? null;
    }
    const control = el('select', { className: 'hud-order-input' });
    for (const candidate of candidates) {
      const option = el('option', { text: candidate.label });
      option.value = String(candidate.id);
      if (candidate.id === this.shareTarget) option.selected = true;
      control.append(option);
    }
    control.addEventListener('change', () => {
      const value = Number.parseInt(control.value, 10);
      this.shareTarget = Number.isFinite(value) ? value : null;
    });
    const share = button(t('vehicle.shareButton'), {
      className: 'hud-depot-action',
      disabled: view.orders.length === 0 || this.shareTarget === null,
      attrs: { type: 'button', title: t('vehicle.shareButtonTitle') },
      onClick: () => {
        if (this.shareTarget === null) return;
        this.options.onShareOrders(view.selection.id, this.shareTarget);
      },
    });
    const clone = button(t('vehicle.cloneButton'), {
      className: 'hud-depot-action',
      disabled: !view.inDepot,
      attrs: {
        type: 'button',
        title: view.inDepot ? t('vehicle.cloneButtonTitle') : t('vehicle.cloneNeedsDepot'),
      },
      onClick: () => this.options.onCloneVehicle(view.selection.id),
    });
    const row = el('div', { className: 'hud-share-row' });
    row.append(control, share, clone);
    this.shareList.append(row);
  }

  private openEditor(view: VehiclePanelView, order: VehicleOrderView): void {
    this.editingIndex = order.index;
    this.editingVehicle = view.selection.id;
    this.editor.replaceChildren();
    this.editor.hidden = false;

    const draft = cloneOrderOptions(order.options);
    const heading = el('h4', {
      className: 'hud-order-editor-title',
      text: t('vehicle.editorTitle', { index: order.index + 1 }),
    });
    this.editor.append(heading);

    const fields = el('div', { className: 'hud-order-fields' });
    if (order.kind === 'conditional') {
      const condition: OrderCondition = draft.condition ?? {
        type: 'percentage',
        comparator: 'more_or_equal',
        value: 100,
      };
      draft.condition = condition;
      const cargoOptions = CONDITION_CARGOS.map((cargo) => ({
        value: cargo,
        label: cargoLabel(cargo),
      }));
      const conditionFields = el('div', { className: 'hud-order-condition' });
      conditionFields.append(
        select(
          ORDER_CONDITION_TYPES.map((type) => ({
            value: type,
            label: t(ORDER_CONDITION_KEYS[type]),
          })),
          condition.type,
          (value) => {
            condition.type = value as OrderConditionType;
            this.renderConditionFields(conditionFields, condition);
          },
          t('vehicle.conditionType'),
        ),
        select(
          ORDER_COMPARATORS.map((comparator) => ({
            value: comparator,
            label: t(ORDER_COMPARATOR_KEYS[comparator]),
          })),
          condition.comparator,
          (value) => {
            condition.comparator = value as OrderComparator;
          },
          t('vehicle.conditionComparator'),
        ),
        numberField(
          condition.value,
          (value) => {
            condition.value = value ?? 0;
          },
          t('vehicle.conditionValue'),
        ),
      );
      this.renderConditionFields(conditionFields, condition, cargoOptions);
      fields.append(conditionFields);
      const jumps = view.orders.map((item) => ({
        value: String(item.index),
        label: `#${item.index + 1} · ${item.label}`,
      }));
      if (draft.jump === undefined) draft.jump = 0;
      fields.append(
        select(
          jumps,
          String(draft.jump ?? 0),
          (value) => {
            draft.jump = Number.parseInt(value, 10);
          },
          t('vehicle.jumpTo'),
        ),
      );
    } else {
      fields.append(
        select(
          (['normal', 'full_load', 'no_load', 'unload', 'transfer'] as OrderAction[]).map(
            (action) => ({ value: action, label: t(ORDER_ACTION_KEYS[action]) }),
          ),
          draft.action ?? 'normal',
          (value) => {
            draft.action = value as OrderAction;
          },
          t('vehicle.orderAction'),
        ),
      );
    }

    const timetable = draft.timetable ?? {};
    draft.timetable = timetable;
    const timetableFields = el('div', { className: 'hud-order-timetable' });
    timetableFields.append(
      numberField(
        timetable.waitTicks,
        (value) => {
          timetable.waitTicks = value;
        },
        t('vehicle.waitTicks'),
        { min: '0', step: '1' },
      ),
      numberField(
        timetable.travelTicks,
        (value) => {
          timetable.travelTicks = value;
        },
        t('vehicle.travelTicks'),
        { min: '0', step: '1' },
      ),
    );
    const autostartLabel = el('label', { className: 'hud-order-check' });
    const autostart = el('input', { attrs: { type: 'checkbox' } });
    autostart.checked = timetable.autostart === true;
    autostart.addEventListener('change', () => {
      timetable.autostart = autostart.checked;
    });
    autostartLabel.append(autostart, el('span', { text: t('vehicle.autostart') }));
    timetableFields.append(autostartLabel);
    fields.append(timetableFields);

    const actions = el('div', { className: 'hud-order-editor-actions' });
    actions.append(
      button(t('common.cancel'), {
        className: 'hud-order-button-text',
        attrs: { type: 'button' },
        onClick: () => this.closeEditor(),
      }),
      button(t('vehicle.saveOrder'), {
        variant: 'primary',
        className: 'hud-order-button-text',
        attrs: { type: 'button' },
        onClick: () => {
          const normalized: OrderOptions = { ...draft };
          if (order.kind === 'conditional') {
            delete normalized.action;
          } else {
            delete normalized.condition;
            delete normalized.jump;
          }
          if (
            normalized.timetable &&
            normalized.timetable.waitTicks === undefined &&
            normalized.timetable.travelTicks === undefined &&
            normalized.timetable.autostart !== true
          ) {
            delete normalized.timetable;
          }
          this.options.onUpdateOrder(view.selection.id, order.index, normalized);
          this.closeEditor();
        },
      }),
    );
    this.editor.append(fields, actions);
  }

  /** (Re)construit les champs dépendant du type de condition. */
  private renderConditionFields(
    container: HTMLElement,
    condition: OrderCondition,
    cargoOptions?: { value: string; label: string }[],
  ): void {
    for (const node of [...container.querySelectorAll('.hud-order-dynamic')]) node.remove();
    if (condition.type === 'cargo') {
      const options =
        cargoOptions ??
        CONDITION_CARGOS.map((cargo) => ({ value: cargo, label: cargoLabel(cargo) }));
      if (!condition.cargo) condition.cargo = options[0]?.value ?? 'goods';
      const wrapper = select(
        options,
        condition.cargo,
        (value) => {
          condition.cargo = value;
        },
        t('vehicle.conditionCargo'),
      );
      wrapper.classList.add('hud-order-dynamic');
      container.append(wrapper);
    } else if (condition.type === 'date') {
      if (condition.month === undefined) condition.month = 0;
      const wrapper = numberField(
        condition.month + 1,
        (value) => {
          condition.month = Math.max(0, Math.min(11, (value ?? 1) - 1));
        },
        t('vehicle.conditionMonth'),
        { min: '1', max: '12', step: '1' },
      );
      wrapper.classList.add('hud-order-dynamic');
      container.append(wrapper);
    }
  }

  private closeEditor(): void {
    this.editingIndex = null;
    this.editingVehicle = null;
    this.editor.hidden = true;
    this.editor.replaceChildren();
    if (this.lastView) this.update(this.lastView);
  }
}

/** Libellé d'action exposé pour les tests de vue. */
export function orderActionLabel(action: OrderAction): string {
  return ORDER_ACTION_LABELS[action];
}

/** Réexport utilitaire pour les consommateurs de l'éditeur. */
export { ORDER_ACTION_KEYS };
