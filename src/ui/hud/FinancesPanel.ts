/**
 * Panneau finances (#165/#166) : trésorerie, prêt, valeur d'entreprise,
 * inflation, graphique simple et subventions disponibles/actives.
 *
 * Le composant est passif : `FinanceView` contient déjà les montants formatés
 * et l'état des boutons. Aucun accès au moteur, aucune dépense simulée.
 */

import { button, el } from '../dom';
import { t, type TranslationKey } from '../i18n';
import type { FinanceHistoryPoint, FinanceView } from '../types';

export interface FinancesPanelOptions {
  onClose: () => void;
  onIncreaseLoan: () => void;
  onDecreaseLoan: () => void;
}

const CHART_WIDTH = 280;
const CHART_HEIGHT = 72;
const CHART_PADDING = 4;

/** Construit un graphique SVG à deux courbes (trésorerie, valeur). */
function renderChart(points: readonly FinanceHistoryPoint[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'hud-finance-chart');
  svg.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('finance.chart.aria'));
  svg.setAttribute('preserveAspectRatio', 'none');

  const grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  grid.setAttribute('x1', '0');
  grid.setAttribute('x2', `${CHART_WIDTH}`);
  grid.setAttribute('y1', `${CHART_HEIGHT / 2}`);
  grid.setAttribute('y2', `${CHART_HEIGHT / 2}`);
  grid.setAttribute('class', 'hud-finance-chart-grid');
  svg.append(grid);

  if (points.length < 2) {
    const empty = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    empty.setAttribute('x', `${CHART_WIDTH / 2}`);
    empty.setAttribute('y', `${CHART_HEIGHT / 2 + 4}`);
    empty.setAttribute('text-anchor', 'middle');
    empty.setAttribute('class', 'hud-finance-chart-empty');
    empty.textContent = t('finance.chart.empty');
    svg.append(empty);
    return svg;
  }

  const values = points.flatMap((point) => [point.money, point.value ?? 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number): number =>
    CHART_PADDING + (index / Math.max(1, points.length - 1)) * (CHART_WIDTH - CHART_PADDING * 2);
  const y = (value: number): number =>
    CHART_HEIGHT - CHART_PADDING - ((value - min) / span) * (CHART_HEIGHT - CHART_PADDING * 2);

  const line = (key: 'money' | 'value', className: string): void => {
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('class', className);
    polyline.setAttribute(
      'points',
      points.map((point, index) => `${x(index)},${y(point[key] ?? 0)}`).join(' '),
    );
    polyline.setAttribute('fill', 'none');
    svg.append(polyline);
  };
  line('value', 'hud-finance-chart-value');
  line('money', 'hud-finance-chart-money');
  return svg;
}

export class FinancesPanel {
  readonly element: HTMLElement;

  private options: FinancesPanelOptions;
  private title: HTMLHeadingElement;
  private money: HTMLSpanElement;
  private loan: HTMLSpanElement;
  private value: HTMLSpanElement;
  private flow: HTMLSpanElement;
  private loanButton: HTMLButtonElement;
  private repayButton: HTMLButtonElement;
  private stats: HTMLDListElement;
  private warning: HTMLParagraphElement;
  private chart: HTMLDivElement;
  private subsidies: HTMLDivElement;
  private hint: HTMLParagraphElement;
  private visible = false;
  private signature = '';
  private lastView: FinanceView | null = null;

  constructor(options: FinancesPanelOptions) {
    this.options = options;
    this.element = el('aside', {
      className: 'hud-finance',
      attrs: {
        role: 'region',
        'aria-live': 'polite',
        'aria-labelledby': 'hud-finance-title',
      },
    });
    this.element.hidden = true;
    this.element.tabIndex = -1;

    const header = el('div', { className: 'hud-panel-heading hud-finance-heading' });
    this.title = el('h2', {
      className: 'hud-finance-title',
      text: t('finance.title'),
      attrs: { id: 'hud-finance-title' },
    });
    const close = el('button', {
      className: 'hud-panel-close',
      text: '×',
      attrs: {
        type: 'button',
        title: t('finance.close'),
        'aria-label': t('finance.close'),
      },
    });
    close.addEventListener('click', () => this.options.onClose());
    header.append(this.title, close);

    const summary = el('div', { className: 'hud-finance-summary' });
    const block = (
      labelKey: TranslationKey,
      valueClass: string,
    ): { block: HTMLDivElement; value: HTMLSpanElement } => {
      const wrap = el('div', { className: 'hud-finance-stat' });
      wrap.append(el('span', { className: 'hud-label', text: t(labelKey) }));
      const value = el('span', { className: `hud-value ${valueClass}`, text: '—' });
      wrap.append(value);
      return { block: wrap, value };
    };
    const money = block('finance.money', 'hud-finance-money');
    this.money = money.value;
    const loan = block('finance.loan', 'hud-finance-loan');
    this.loan = loan.value;
    const value = block('finance.value', 'hud-finance-value');
    this.value = value.value;
    const flow = block('finance.flow', 'hud-finance-flow');
    this.flow = flow.value;
    summary.append(money.block, loan.block, value.block, flow.block);

    const controls = el('div', { className: 'hud-finance-loans' });
    this.loanButton = button('', {
      className: 'btn hud-finance-loan-increase',
      onClick: () => this.options.onIncreaseLoan(),
    });
    this.repayButton = button('', {
      className: 'btn hud-finance-loan-decrease',
      onClick: () => this.options.onDecreaseLoan(),
    });
    controls.append(this.loanButton, this.repayButton);

    this.stats = el('dl', { className: 'hud-selection-stats hud-finance-stats' });
    this.warning = el('p', {
      className: 'hud-finance-warning',
      attrs: { role: 'alert' },
    });
    this.warning.hidden = true;

    const chartSection = el('section', {
      className: 'hud-finance-section',
      attrs: { 'aria-labelledby': 'hud-finance-chart-title' },
    });
    const chartTitle = el('h3', {
      className: 'hud-panel-section',
      text: t('finance.chart.title'),
      attrs: { id: 'hud-finance-chart-title' },
    });
    this.chart = el('div', { className: 'hud-finance-chart-wrap' });
    const legend = el('div', { className: 'hud-finance-legend' });
    legend.append(
      el('span', { className: 'hud-finance-legend-money', text: t('finance.chart.money') }),
      el('span', { className: 'hud-finance-legend-value', text: t('finance.chart.value') }),
    );
    chartSection.append(chartTitle, this.chart, legend);

    const subsidySection = el('section', {
      className: 'hud-finance-section',
      attrs: { 'aria-labelledby': 'hud-finance-subsidies-title' },
    });
    subsidySection.append(
      el('h3', {
        className: 'hud-panel-section',
        text: t('finance.subsidies.title'),
        attrs: { id: 'hud-finance-subsidies-title' },
      }),
    );
    this.subsidies = el('div', { className: 'hud-finance-subsidies' });
    subsidySection.append(this.subsidies);

    this.hint = el('p', { className: 'hud-panel-hint' });

    this.element.append(
      header,
      summary,
      controls,
      this.stats,
      this.warning,
      chartSection,
      subsidySection,
      this.hint,
    );
  }

  isOpen(): boolean {
    return this.visible;
  }

  show(): void {
    this.visible = true;
    this.element.hidden = false;
    this.element.focus({ preventScroll: true });
    if (this.lastView) this.render(this.lastView);
  }

  hide(): void {
    this.visible = false;
    this.element.hidden = true;
    this.signature = '';
  }

  update(view: FinanceView | null): void {
    this.lastView = view;
    if (!this.visible) return;
    if (!view) {
      this.hide();
      return;
    }
    this.render(view);
  }

  private render(view: FinanceView): void {
    const signature = JSON.stringify(view);
    if (signature === this.signature) return;
    this.signature = signature;

    this.title.textContent = t('finance.titleWithCompany', { company: view.company });
    this.money.textContent = view.money;
    this.money.classList.toggle('hud-negative', view.money.startsWith('−'));
    this.loan.textContent = `${view.loan} / ${view.maxLoan}`;
    this.value.textContent = view.value;
    this.flow.textContent = `${view.income} · ${view.expenses}`;
    this.loanButton.textContent = view.increaseLabel;
    this.loanButton.disabled = !view.canIncrease;
    this.loanButton.title = view.canIncrease ? view.increaseLabel : t('finance.loan.blocked');
    this.repayButton.textContent = view.decreaseLabel;
    this.repayButton.disabled = !view.canDecrease;
    this.repayButton.title = view.canDecrease ? view.decreaseLabel : t('finance.loan.blocked');

    this.stats.replaceChildren();
    for (const [label, value] of [
      [t('finance.stat.interest'), view.interestRate],
      [t('finance.stat.inflation'), view.inflation],
      [t('finance.stat.difficulty'), view.difficulty],
      [t('finance.stat.step'), view.loanStep],
      [
        t('finance.stat.bankruptcy'),
        t('finance.stat.bankruptcyMonths', { months: view.monthsOfBankruptcy }),
      ],
    ] as const) {
      const row = el('div', { className: 'hud-selection-stat' });
      row.append(el('dt', { text: label }), el('dd', { text: value }));
      this.stats.append(row);
    }

    this.warning.hidden = !view.warning;
    this.warning.textContent = view.warning ?? '';
    this.warning.dataset.tone = view.bankrupt ? 'error' : 'warning';

    this.chart.replaceChildren(renderChart(view.history));
    this.renderSubsidies(view);
    this.hint.textContent = view.hint;
  }

  private renderSubsidies(view: FinanceView): void {
    this.subsidies.replaceChildren();
    if (view.subsidies.length === 0) {
      this.subsidies.append(
        el('p', { className: 'hud-panel-empty', text: t('finance.subsidies.empty') }),
      );
      return;
    }
    for (const subsidy of view.subsidies) {
      const item = el('div', {
        className: 'hud-finance-subsidy',
        dataset: { state: subsidy.state },
      });
      item.append(
        el('span', {
          className: 'hud-finance-subsidy-title',
          text: subsidy.title,
        }),
        el('span', {
          className: `hud-finance-subsidy-detail is-${subsidy.tone}`,
          text: subsidy.detail,
        }),
      );
      this.subsidies.append(item);
    }
  }

  dispose(): void {
    this.element.remove();
  }
}
