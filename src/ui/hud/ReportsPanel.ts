/**
 * Panneau Rapports du HUD : finances, liste des véhicules et statistiques.
 *
 * Une seule modale accessible, trois onglets. Elle ne lit que les snapshots et
 * n'émet aucune commande : les actions non supportées par le protocole v1
 * (prêt, groupes) sont rendues désactivées avec leur explication. Les actions
 * véhicule existantes (sélection, départ, arrêt, vente) remontent au HUD, qui
 * les transmet à la session de jeu.
 */

import type { WorldSnapshot } from '../../engine/protocol';
import { button, el, focusableElements } from '../dom';
import { createBarMeter, createSparkline } from '../charts';
import { formatGameDate, formatInt } from '../format';
import { describeFinancePanel, financeChartLabel, localCompany } from '../financeView';
import { bindAttr, bindText, onLanguageChange, t } from '../i18n';
import { describeStatsPanel } from '../statsView';
import type {
  FinanceAlertView,
  FinanceHistoryPoint,
  FinancePanelView,
  ReportActionView,
  ReportOption,
  StatsPanelView,
  VehicleListFilters,
  VehicleListPanelView,
  VehicleListRowView,
} from '../types';
import { createDefaultVehicleFilters, describeVehicleListPanel } from '../vehicleListView';

export type ReportTab = 'finance' | 'vehicles' | 'stats';

export interface ReportsPanelOptions {
  onClose: () => void;
  onSelectVehicle: (vehicleId: number) => void;
  onStartVehicle: (vehicleId: number) => void;
  onStopVehicle: (vehicleId: number) => void;
  onSellVehicle: (vehicleId: number) => void;
}

const TABS: ReportTab[] = ['finance', 'vehicles', 'stats'];
const TAB_KEYS = {
  finance: 'reports.tab.finance',
  vehicles: 'reports.tab.vehicles',
  stats: 'reports.tab.stats',
} as const;
const HISTORY_LIMIT = 60;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function statCard(label: string, value: string, tone?: string): HTMLDivElement {
  const card = el('div', { className: 'hud-report-stat' });
  const strong = el('strong', { className: tone ? `is-${tone}` : undefined, text: value });
  card.append(el('span', { text: label }), strong);
  return card;
}

function sectionHeading(id: string, text: string): HTMLHeadingElement {
  return el('h3', {
    className: 'hud-report-section-title',
    text,
    attrs: { id },
  });
}

function emptyLine(text: string): HTMLParagraphElement {
  return el('p', { className: 'hud-report-empty', text });
}

export class ReportsPanel {
  readonly element: HTMLElement;

  private options: ReportsPanelOptions;
  private card: HTMLDivElement;
  private title: HTMLHeadingElement;
  private subtitle: HTMLDivElement;
  private tabList: HTMLDivElement;
  private tabs = new Map<ReportTab, HTMLButtonElement>();
  private panels = new Map<ReportTab, HTMLElement>();
  private content: HTMLDivElement;
  private active: ReportTab = 'finance';
  private visible = false;
  private snapshot: WorldSnapshot | null = null;
  private history: FinanceHistoryPoint[] = [];
  private filters: VehicleListFilters = createDefaultVehicleFilters();
  private controlsSignature = '';
  private signatures = new Map<ReportTab, string>();
  private opener: HTMLElement | null = null;
  private stopLanguage: () => void;
  private vehicleControls: HTMLDivElement;
  private vehicleSummary: HTMLDivElement;
  private vehicleGroups: HTMLDivElement;
  private vehicleList: HTMLDivElement;
  private vehicleHint: HTMLParagraphElement;

  constructor(options: ReportsPanelOptions) {
    this.options = options;
    this.element = el('div', {
      className: 'hud-reports',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'hud-reports-title',
      },
    });
    this.card = el('div', { className: 'hud-reports-card' });

    const header = el('div', { className: 'hud-reports-header' });
    const heading = el('div', { className: 'hud-reports-heading' });
    this.title = el('h2', {
      text: t('reports.title'),
      attrs: { id: 'hud-reports-title' },
    });
    bindText(this.title, 'reports.title');
    this.subtitle = el('div', { className: 'hud-reports-subtitle' });
    heading.append(this.title, this.subtitle);
    const close = button('×', {
      className: 'hud-reports-close',
      attrs: {
        type: 'button',
        title: t('reports.close'),
        'aria-label': t('reports.close'),
      },
      onClick: () => this.options.onClose(),
    });
    bindAttr(close, 'title', 'reports.close');
    bindAttr(close, 'aria-label', 'reports.close');
    header.append(heading, close);

    this.tabList = el('div', {
      className: 'hud-reports-tabs',
      attrs: { role: 'tablist', 'aria-label': t('reports.tabs') },
    });
    for (const tab of TABS) {
      const tabButton = el('button', {
        className: 'hud-reports-tab',
        attrs: {
          type: 'button',
          role: 'tab',
          id: this.tabId(tab),
          'aria-controls': this.panelId(tab),
          'aria-selected': tab === this.active ? 'true' : 'false',
          tabindex: tab === this.active ? '0' : '-1',
        },
      });
      bindText(tabButton, TAB_KEYS[tab]);
      tabButton.addEventListener('click', () => this.setActive(tab));
      tabButton.addEventListener('keydown', (event) => this.onTabKey(event, tab));
      this.tabs.set(tab, tabButton);
      this.tabList.append(tabButton);
    }
    bindAttr(this.tabList, 'aria-label', 'reports.tabs');

    this.content = el('div', { className: 'hud-reports-body' });
    for (const tab of TABS) {
      const panel = el('section', {
        className: 'hud-reports-panel',
        attrs: {
          role: 'tabpanel',
          id: this.panelId(tab),
          'aria-labelledby': this.tabId(tab),
          tabindex: '0',
        },
      });
      panel.hidden = tab !== this.active;
      this.panels.set(tab, panel);
      this.content.append(panel);
    }

    // La section véhicules garde ses contrôles entre deux snapshots : taper
    // dans la recherche ou garder un filtre au clavier ne perd pas le focus.
    const vehiclePanel = this.panels.get('vehicles');
    this.vehicleControls = el('div', {
      className: 'hud-report-filters',
      attrs: { role: 'group', 'aria-label': t('vehicleList.filters.aria') },
    });
    bindAttr(this.vehicleControls, 'aria-label', 'vehicleList.filters.aria');
    this.vehicleSummary = el('div', { className: 'hud-report-stats' });
    this.vehicleGroups = el('div', { className: 'hud-report-groups' });
    this.vehicleList = el('div', {
      className: 'hud-report-vehicle-list',
      attrs: { 'aria-label': t('vehicleList.list.aria'), role: 'list' },
    });
    bindAttr(this.vehicleList, 'aria-label', 'vehicleList.list.aria');
    this.vehicleHint = el('p', { className: 'hud-report-hint' });
    vehiclePanel?.append(
      this.vehicleControls,
      this.vehicleSummary,
      this.vehicleGroups,
      this.vehicleList,
      this.vehicleHint,
    );

    this.card.append(header, this.tabList, this.content);
    this.element.append(this.card);
    this.element.hidden = true;
    this.element.addEventListener('keydown', this.onKeyDown);
    this.stopLanguage = onLanguageChange(() => {
      this.controlsSignature = '';
      this.signatures.clear();
      this.render();
    });
  }

  private tabId(tab: ReportTab): string {
    return `hud-reports-tab-${tab}`;
  }

  private panelId(tab: ReportTab): string {
    return `hud-reports-panel-${tab}`;
  }

  isOpen(): boolean {
    return this.visible;
  }

  get activeTab(): ReportTab {
    return this.active;
  }

  /** Ouvre la modale sur un onglet, en mémorisant l'élément déclencheur. */
  open(tab: ReportTab = 'finance', snapshot: WorldSnapshot | null = this.snapshot): void {
    if (!this.visible) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.snapshot = snapshot;
    this.recordHistory(snapshot);
    this.element.hidden = false;
    this.visible = true;
    this.setActive(tab, false);
    this.tabs.get(tab)?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.element.hidden = true;
    this.signatures.clear();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  /** Nouveau snapshot : alimente l'historique puis rafraîchit l'onglet actif. */
  updateSnapshot(snapshot: WorldSnapshot | null): void {
    this.snapshot = snapshot;
    this.recordHistory(snapshot);
    if (this.visible) this.render();
  }

  private recordHistory(snapshot: WorldSnapshot | null): void {
    if (!snapshot) return;
    const company = localCompany(snapshot);
    if (!company) return;
    const money = finite(company.money);
    const income = finite(company.income);
    const expenses = finite(company.expenses);
    if (money === null || income === null || expenses === null) return;
    const tick = finite(snapshot.meta.tick);
    if (tick === null) return;
    const last = this.history[this.history.length - 1];
    if (last && tick < (last.tick ?? 0)) this.history = [];
    const current = this.history[this.history.length - 1];
    if (current && current.tick === tick) {
      current.money = money;
      current.income = income;
      current.expenses = expenses;
      return;
    }
    this.history.push({ tick, money, income, expenses });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  private setActive(tab: ReportTab, focus = true): void {
    this.active = tab;
    for (const [id, tabButton] of this.tabs) {
      const selected = id === tab;
      tabButton.setAttribute('aria-selected', selected ? 'true' : 'false');
      tabButton.tabIndex = selected ? 0 : -1;
    }
    for (const [id, panel] of this.panels) panel.hidden = id !== tab;
    this.content.scrollTop = 0;
    this.render(true);
    if (focus) this.tabs.get(tab)?.focus({ preventScroll: true });
  }

  private onTabKey(event: KeyboardEvent, tab: ReportTab): void {
    const index = TABS.indexOf(tab);
    let next: ReportTab | null = null;
    if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length] ?? null;
    else if (event.key === 'ArrowLeft')
      next = TABS[(index - 1 + TABS.length) % TABS.length] ?? null;
    else if (event.key === 'Home') next = TABS[0] ?? null;
    else if (event.key === 'End') next = TABS[TABS.length - 1] ?? null;
    if (!next) return;
    event.preventDefault();
    this.setActive(next, true);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(this.element);
    if (focusable.length === 0) return;
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    let target: number | null = null;
    if (index < 0) target = event.shiftKey ? focusable.length - 1 : 0;
    else if (event.shiftKey && index === 0) target = focusable.length - 1;
    else if (!event.shiftKey && index === focusable.length - 1) target = 0;
    if (target === null) return;
    event.preventDefault();
    focusable[target]?.focus();
  };

  private render(force = false): void {
    if (!this.visible) return;
    this.renderSubtitle();
    if (this.active === 'finance') this.renderFinance(force);
    else if (this.active === 'vehicles') this.renderVehicles(force);
    else this.renderStats(force);
  }

  private renderSubtitle(): void {
    const snapshot = this.snapshot;
    const company = localCompany(snapshot);
    this.subtitle.textContent = snapshot
      ? t('reports.companyLine', {
          company: company?.name ?? t('finance.companyUnknown'),
          date: formatGameDate(snapshot.economy),
        })
      : t('reports.empty');
  }

  private panelFor(tab: ReportTab): HTMLElement {
    const panel = this.panels.get(tab);
    if (!panel) throw new Error(`Panneau de rapport inconnu : ${tab}`);
    return panel;
  }

  private signatureMatches(tab: ReportTab, signature: string, force: boolean): boolean {
    if (force) return false;
    return this.signatures.get(tab) === signature;
  }

  private renderFinance(force: boolean): void {
    const view = describeFinancePanel(this.snapshot, this.history);
    const signature = JSON.stringify({
      ...view,
      history: view.history.map((point) => [point.tick, point.money]),
    });
    if (this.signatureMatches('finance', signature, force)) return;
    this.signatures.set('finance', signature);
    const panel = this.panelFor('finance');
    const focusKey = this.currentFocusKey();
    panel.replaceChildren();

    const stats = el('div', { className: 'hud-report-stats' });
    stats.append(
      statCard(
        t('finance.money'),
        view.moneyLabel,
        view.money !== null && view.money < 0 ? 'bad' : undefined,
      ),
      statCard(t('finance.value'), view.valueLabel),
      statCard(
        t('finance.loan'),
        view.loanLabel,
        view.loan !== null && view.loan > 0 ? 'muted' : undefined,
      ),
      statCard(t('finance.result'), view.resultLabel, view.resultTone),
    );
    panel.append(stats);

    if (view.loanLimitLabel || view.interestRateLabel) {
      const details = el('dl', { className: 'hud-report-inline-stats' });
      if (view.loanLimitLabel) {
        const row = el('div');
        row.append(
          el('dt', { text: t('finance.loanLimit') }),
          el('dd', { text: view.loanLimitLabel }),
        );
        details.append(row);
      }
      if (view.interestRateLabel) {
        const row = el('div');
        row.append(
          el('dt', { text: t('finance.interestRate') }),
          el('dd', { text: view.interestRateLabel }),
        );
        details.append(row);
      }
      panel.append(details);
    }

    if (view.alerts.length > 0) panel.append(this.renderAlerts(view.alerts, 'finance'));
    panel.append(this.renderCashChart(view));

    const categories = el('div', { className: 'hud-report-columns' });
    categories.append(
      this.renderCategories(
        'finance',
        t('finance.revenue.title'),
        view.revenue,
        view.breakdownAvailable,
      ),
      this.renderCategories(
        'expenses',
        t('finance.expense.title'),
        view.expensesByCategory,
        view.breakdownAvailable,
      ),
    );
    panel.append(categories);
    panel.append(this.renderActions(view.actions, 'finance-actions'));
    panel.append(this.renderRanking(view));
    panel.append(el('p', { className: 'hud-report-hint', text: view.hint }));
    this.restoreFocus(focusKey);
  }

  private renderCashChart(view: FinancePanelView): HTMLElement {
    const section = el('section', { className: 'hud-report-section' });
    section.append(sectionHeading('hud-report-chart-title', t('finance.chart.title')));
    if (view.history.length === 0) {
      section.append(emptyLine(t('finance.chart.empty')));
      return section;
    }
    const last = view.history[view.history.length - 1];
    const tone = last && last.money < 0 ? 'bad' : 'good';
    const chart = createSparkline(
      view.history.map((point) => point.money),
      { label: financeChartLabel(view.history), tone, className: 'hud-finance-chart' },
    );
    const wrap = el('div', { className: 'hud-chart-wrap' });
    wrap.append(chart);
    const first = view.history[0];
    if (first && last && first.tick !== last.tick) {
      const axis = el('div', { className: 'hud-chart-axis' });
      axis.append(
        el('span', { text: String(first.tick) }),
        el('span', { text: String(last.tick) }),
      );
      section.append(wrap, axis);
    } else {
      section.append(wrap);
    }
    return section;
  }

  private renderCategories(
    id: string,
    title: string,
    categories: FinancePanelView['revenue'],
    breakdownAvailable: boolean,
  ): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section',
      attrs: { 'aria-labelledby': `hud-report-${id}-title` },
    });
    section.append(sectionHeading(`hud-report-${id}-title`, title));
    if (!breakdownAvailable) {
      section.append(emptyLine(t('finance.breakdown.unavailable')));
    }
    if (categories.length === 0) {
      section.append(emptyLine(t('reports.empty')));
      return section;
    }
    const list = el('ul', { className: 'hud-report-bars' });
    for (const category of categories) {
      const item = el('li', { className: 'hud-report-bar-row' });
      const head = el('div', { className: 'hud-report-bar-head' });
      head.append(
        el('span', { className: 'hud-report-bar-label', text: category.label }),
        el('span', { className: 'hud-report-bar-value', text: category.amountLabel }),
      );
      item.append(
        head,
        createBarMeter(category.percent, 100, {
          label: `${category.label} : ${category.amountLabel}`,
          tone: id === 'expenses' ? 'bad' : 'good',
        }),
      );
      list.append(item);
    }
    section.append(list);
    return section;
  }

  private renderActions(actions: ReportActionView[], idPrefix: string): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section',
      attrs: { 'aria-labelledby': `${idPrefix}-title` },
    });
    section.append(sectionHeading(`${idPrefix}-title`, t('reports.actions')));
    const group = el('div', { className: 'hud-report-actions' });
    const noteId = `${idPrefix}-note`;
    const reason = actions.find((action) => action.reason)?.reason;
    if (reason) {
      group.append(
        el('p', {
          className: 'hud-report-note',
          text: reason,
          attrs: { id: noteId },
        }),
      );
    }
    for (const action of actions) {
      const actionButton = button(action.label, {
        className: 'hud-report-action',
        disabled: !action.supported,
        attrs: {
          type: 'button',
          title: action.reason ?? action.label,
          ...(reason ? { 'aria-describedby': noteId } : {}),
          'data-focus-key': `${idPrefix}-${action.id}`,
        },
      });
      group.append(actionButton);
    }
    section.append(group);
    return section;
  }

  private renderRanking(view: FinancePanelView): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section',
      attrs: { 'aria-labelledby': 'hud-report-ranking-title' },
    });
    section.append(sectionHeading('hud-report-ranking-title', t('finance.ranking.title')));
    if (view.ranking.length === 0) {
      section.append(emptyLine(t('finance.ranking.empty')));
      return section;
    }
    const table = el('table', {
      className: 'hud-report-table',
      attrs: { 'aria-label': t('finance.ranking.aria') },
    });
    const head = el('thead');
    const headRow = el('tr');
    for (const label of [
      t('finance.ranking.rank'),
      t('finance.ranking.company'),
      t('finance.ranking.value'),
      t('finance.ranking.share'),
    ]) {
      headRow.append(el('th', { text: label, attrs: { scope: 'col' } }));
    }
    head.append(headRow);
    const body = el('tbody');
    for (const row of view.ranking) {
      const tr = el('tr', { className: row.isLocal ? 'is-local' : undefined });
      tr.append(
        el('td', { text: String(row.rank) }),
        el('td', { className: 'hud-report-company' }),
        el('td', { className: 'hud-report-number', text: row.valueLabel }),
        el('td', { className: 'hud-report-share' }),
      );
      const companyCell = tr.children[1];
      if (companyCell instanceof HTMLElement) {
        const dot = el('span', { className: 'hud-report-dot' });
        dot.style.background = `#${row.colour.toString(16).padStart(6, '0')}`;
        companyCell.append(dot, el('span', { text: row.name }));
        if (row.isLocal) {
          companyCell.append(
            el('span', { className: 'hud-report-badge', text: t('finance.ranking.local') }),
          );
        }
        if (row.bankrupt) {
          companyCell.append(
            el('span', {
              className: 'hud-report-badge is-bad',
              text: t('finance.ranking.bankrupt'),
            }),
          );
        }
      }
      const shareCell = tr.children[3];
      if (shareCell instanceof HTMLElement) {
        shareCell.append(
          createBarMeter(row.share ?? 0, 100, {
            label: t('finance.shareAria', { name: row.name, share: row.shareLabel }),
            tone: row.isLocal ? 'good' : 'neutral',
          }),
          el('span', { className: 'hud-report-share-value', text: row.shareLabel }),
        );
      }
      body.append(tr);
    }
    table.append(head, body);
    section.append(table);
    return section;
  }

  private renderStats(force: boolean): void {
    const view = describeStatsPanel(this.snapshot);
    const signature = JSON.stringify(view);
    if (this.signatureMatches('stats', signature, force)) return;
    this.signatures.set('stats', signature);
    const panel = this.panelFor('stats');
    const focusKey = this.currentFocusKey();
    panel.replaceChildren();
    const stats = el('div', { className: 'hud-report-stats' });
    stats.append(
      statCard(t('stats.summary.industries'), formatInt(view.industryCount)),
      statCard(t('stats.summary.production'), view.totalProductionLabel),
      statCard(t('stats.summary.transported'), view.totalTransportedLabel),
      statCard(t('stats.summary.towns'), formatInt(view.townCount)),
      statCard(t('stats.summary.population'), view.totalPopulationLabel),
    );
    panel.append(stats);
    if (view.alerts.length > 0) panel.append(this.renderAlerts(view.alerts, 'stats'));
    panel.append(this.renderMarket(view));
    panel.append(this.renderIndustries(view));
    panel.append(this.renderTowns(view));
    panel.append(el('p', { className: 'hud-report-hint', text: view.hint }));
    this.restoreFocus(focusKey);
  }

  private renderMarket(view: StatsPanelView): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section',
      attrs: { 'aria-labelledby': 'hud-report-market-title' },
    });
    section.append(sectionHeading('hud-report-market-title', t('stats.market.title')));
    section.append(el('p', { className: 'hud-report-note', text: view.marketBasis }));
    if (view.market.length === 0) {
      section.append(emptyLine(t('stats.market.empty')));
      return section;
    }
    const list = el('ul', {
      className: 'hud-report-bars',
      attrs: { 'aria-label': t('stats.market.aria') },
    });
    for (const row of view.market) {
      const item = el('li', { className: 'hud-report-bar-row' });
      const head = el('div', { className: 'hud-report-bar-head' });
      const identity = el('span', { className: 'hud-report-bar-label' });
      const dot = el('span', { className: 'hud-report-dot' });
      dot.style.background = `#${row.colour.toString(16).padStart(6, '0')}`;
      identity.append(dot, el('span', { text: row.name }));
      if (row.isLocal) {
        identity.append(
          el('span', { className: 'hud-report-badge', text: t('finance.ranking.local') }),
        );
      }
      head.append(
        identity,
        el('span', { className: 'hud-report-bar-value', text: row.shareLabel }),
      );
      item.append(
        head,
        createBarMeter(row.share ?? 0, 100, {
          label: t('stats.shareAria', { name: row.name, share: row.shareLabel }),
          tone: row.isLocal ? 'good' : 'neutral',
        }),
      );
      list.append(item);
    }
    section.append(list);
    return section;
  }

  private renderIndustries(view: StatsPanelView): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section',
      attrs: { 'aria-labelledby': 'hud-report-industries-title' },
    });
    section.append(sectionHeading('hud-report-industries-title', t('stats.industries.title')));
    if (view.industries.length === 0) {
      section.append(emptyLine(t('stats.empty.industries')));
      return section;
    }
    const list = el('ul', { className: 'hud-report-data-list' });
    for (const row of view.industries) {
      const item = el('li', { className: 'hud-report-data-row' });
      const text = el('div', { className: 'hud-report-data-text' });
      text.append(
        el('strong', { text: row.name }),
        el('span', { className: 'hud-report-data-detail', text: row.detail }),
      );
      const numbers = el('div', { className: 'hud-report-data-numbers' });
      numbers.append(el('span', { text: row.rateLabel }));
      const bars = el('div', { className: 'hud-report-double-bars' });
      bars.append(
        createBarMeter(row.percent, 100, {
          label: t('stats.summary.production'),
          tone: 'good',
        }),
        createBarMeter(row.transportedPercent, 100, {
          label: t('stats.summary.transported'),
          tone: 'neutral',
        }),
      );
      item.append(text, numbers, bars);
      list.append(item);
    }
    section.append(list);
    return section;
  }

  private renderTowns(view: StatsPanelView): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section',
      attrs: { 'aria-labelledby': 'hud-report-towns-title' },
    });
    section.append(sectionHeading('hud-report-towns-title', t('stats.towns.title')));
    if (view.towns.length === 0) {
      section.append(emptyLine(t('stats.empty.towns')));
      return section;
    }
    const list = el('ul', { className: 'hud-report-data-list' });
    for (const row of view.towns) {
      const item = el('li', { className: 'hud-report-data-row' });
      const text = el('div', { className: 'hud-report-data-text' });
      text.append(
        el('strong', { text: row.name }),
        el('span', { className: 'hud-report-data-detail', text: row.detail }),
      );
      const numbers = el('div', { className: 'hud-report-data-numbers' });
      numbers.append(
        el('span', {
          text: t('stats.town.served', {
            served: formatInt(row.served),
            stations: formatInt(row.stations),
          }),
        }),
      );
      const bars = el('div', { className: 'hud-report-double-bars' });
      bars.append(
        createBarMeter(row.percent, 100, {
          label: t('selection.stat.population'),
          tone: 'good',
        }),
      );
      item.append(text, numbers, bars);
      list.append(item);
    }
    section.append(list);
    return section;
  }

  private renderVehicles(force: boolean): void {
    const view = describeVehicleListPanel(this.snapshot, this.localCompanyId(), this.filters);
    const focusKey = this.currentFocusKey();
    this.ensureVehicleControls(view);
    this.renderVehicleSummary(view);
    this.renderVehicleGroups(view);
    this.renderVehicleRows(view, force);
    this.vehicleHint.textContent = view.hint;
    this.restoreFocus(focusKey);
  }

  private localCompanyId(): number | null {
    return localCompany(this.snapshot)?.id ?? null;
  }

  private ensureVehicleControls(view: VehicleListPanelView): void {
    const signature = JSON.stringify({
      kinds: view.kindOptions,
      groups: view.groupOptions,
    });
    if (signature === this.controlsSignature) return;
    this.controlsSignature = signature;
    this.vehicleControls.replaceChildren();
    const kind = this.selectControl(
      'vehicle-kind',
      t('vehicleList.filter.type'),
      view.kindOptions,
      this.filters.kind,
      (value) => this.patchFilters({ kind: value }),
    );
    const group = this.selectControl(
      'vehicle-group',
      t('vehicleList.filter.group'),
      view.groupOptions,
      this.filters.group,
      (value) => this.patchFilters({ group: value }),
    );
    const status = this.selectControl(
      'vehicle-status',
      t('vehicleList.filter.status'),
      [
        { value: 'all', label: t('vehicleList.filter.all') },
        { value: 'moving', label: t('vehicleList.filter.status.moving') },
        { value: 'stopped', label: t('vehicleList.filter.status.stopped') },
        { value: 'depot', label: t('vehicleList.filter.status.depot') },
      ],
      this.filters.status,
      (value) => this.patchFilters({ status: value as VehicleListFilters['status'] }),
    );
    const profit = this.selectControl(
      'vehicle-profit',
      t('vehicleList.filter.profit'),
      [
        { value: 'all', label: t('vehicleList.filter.all') },
        { value: 'profit', label: t('vehicleList.filter.profit.positive') },
        { value: 'loss', label: t('vehicleList.filter.profit.negative') },
      ],
      this.filters.profit,
      (value) => this.patchFilters({ profit: value as VehicleListFilters['profit'] }),
    );
    const age = this.selectControl(
      'vehicle-age',
      t('vehicleList.filter.age'),
      [
        { value: 'all', label: t('vehicleList.filter.all') },
        { value: 'recent', label: t('vehicleList.filter.age.recent') },
        { value: 'old', label: t('vehicleList.filter.age.old') },
      ],
      this.filters.age,
      (value) => this.patchFilters({ age: value as VehicleListFilters['age'] }),
    );
    const sort = this.selectControl(
      'vehicle-sort',
      t('vehicleList.sort.label'),
      [
        { value: 'profit', label: t('vehicleList.sort.profit') },
        { value: 'age', label: t('vehicleList.sort.age') },
        { value: 'id', label: t('vehicleList.sort.id') },
        { value: 'type', label: t('vehicleList.sort.type') },
        { value: 'status', label: t('vehicleList.sort.status') },
        { value: 'group', label: t('vehicleList.sort.group') },
      ],
      this.filters.sort,
      (value) => this.patchFilters({ sort: value as VehicleListFilters['sort'] }),
    );

    const search = el('label', { className: 'hud-report-field hud-report-search' });
    search.append(el('span', { text: t('vehicleList.filter.search') }));
    const input = el('input', {
      attrs: {
        type: 'search',
        placeholder: t('vehicleList.filter.searchPlaceholder'),
        value: this.filters.query,
        'data-focus-key': 'vehicle-search',
      },
    });
    input.value = this.filters.query;
    input.addEventListener('input', () => this.patchFilters({ query: input.value }));
    search.append(input);

    const reset = button(t('vehicleList.filter.reset'), {
      className: 'hud-report-reset',
      attrs: { type: 'button', 'data-focus-key': 'vehicle-reset' },
      onClick: () => {
        this.filters = createDefaultVehicleFilters();
        this.controlsSignature = '';
        this.signatures.delete('vehicles');
        this.renderVehicles(true);
      },
    });
    this.vehicleControls.append(kind, group, status, profit, age, sort, search, reset);
  }

  private selectControl(
    id: string,
    label: string,
    options: ReportOption[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLLabelElement {
    const field = el('label', { className: 'hud-report-field', attrs: { for: id } });
    field.append(el('span', { text: label }));
    const select = el('select', { attrs: { id, 'data-focus-key': id } });
    for (const option of options) {
      const node = el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === value) node.selected = true;
      select.append(node);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    field.append(select);
    return field;
  }

  private patchFilters(patch: Partial<VehicleListFilters>): void {
    this.filters = { ...this.filters, ...patch };
    this.renderVehicles(true);
  }

  private renderVehicleSummary(view: VehicleListPanelView): void {
    this.vehicleSummary.replaceChildren(
      statCard(
        t('vehicleList.summary.count'),
        t('vehicleList.summary.countValue', {
          count: formatInt(view.summary.count),
          total: formatInt(this.snapshot?.vehicles.length ?? 0),
        }),
      ),
      statCard(t('vehicleList.summary.moving'), formatInt(view.summary.moving)),
      statCard(
        t('vehicleList.summary.profit'),
        view.summary.profitLabel,
        view.summary.profit < 0 ? 'bad' : view.summary.profit > 0 ? 'good' : 'muted',
      ),
      statCard(t('vehicleList.summary.age'), view.summary.averageAgeLabel),
    );
  }

  private renderVehicleGroups(view: VehicleListPanelView): void {
    this.vehicleGroups.replaceChildren();
    const title = el('h3', {
      className: 'hud-report-section-title',
      text: t('vehicleList.groups.title'),
    });
    const list = el('div', { className: 'hud-report-group-list' });
    for (const group of view.groups) {
      list.append(
        el('span', {
          className: 'hud-report-group-chip',
          text: `${group.label} · ${t('vehicleList.groups.count', {
            count: formatInt(group.count),
          })}`,
        }),
      );
    }
    const actions = el('div', { className: 'hud-report-actions' });
    const noteId = 'vehicle-group-note';
    actions.append(
      el('p', {
        className: 'hud-report-note',
        text: view.groupNote,
        attrs: { id: noteId },
      }),
    );
    for (const action of view.groupActions) {
      actions.append(
        button(action.label, {
          className: 'hud-report-action',
          disabled: !action.supported,
          attrs: {
            type: 'button',
            title: action.reason ?? action.label,
            'aria-describedby': noteId,
            'data-focus-key': `vehicle-group-${action.id}`,
          },
        }),
      );
    }
    this.vehicleGroups.append(title, list, actions);
  }

  private renderVehicleRows(view: VehicleListPanelView, force: boolean): void {
    const signature = JSON.stringify(view.rows);
    if (!force && this.signatures.get('vehicles') === signature) return;
    this.signatures.set('vehicles', signature);
    this.vehicleList.replaceChildren();
    if (view.rows.length === 0) {
      this.vehicleList.append(emptyLine(view.empty));
      return;
    }
    for (const row of view.rows) this.vehicleList.append(this.renderVehicleRow(row));
  }

  private renderVehicleRow(row: VehicleListRowView): HTMLElement {
    const item = el('div', {
      className: `hud-report-vehicle${row.isLocal ? ' is-local' : ''}`,
      attrs: { role: 'listitem' },
    });
    const dot = el('span', { className: 'hud-report-dot' });
    dot.style.background = `#${row.colour.toString(16).padStart(6, '0')}`;
    const text = el('div', { className: 'hud-report-vehicle-text' });
    const title = el('strong', { text: row.title });
    if (row.isLocal) {
      title.append(el('span', { className: 'hud-report-badge', text: t('finance.ranking.local') }));
    }
    text.append(
      title,
      el('span', { className: 'hud-report-data-detail', text: row.detail }),
      el('span', {
        className: 'hud-report-data-detail',
        text: `${row.companyName} · ${row.groupLabel}`,
      }),
      el('span', {
        className: `hud-report-vehicle-profit${row.profit !== null && row.profit < 0 ? ' is-bad' : ''}`,
        text: `${row.profitLabel} · ${row.ageLabel}`,
      }),
    );
    if (row.note) {
      text.append(el('span', { className: 'hud-report-note', text: row.note }));
    }
    const actions = el('div', { className: 'hud-report-vehicle-actions' });
    const select = button(t('vehicleList.action.select'), {
      className: 'hud-report-action',
      disabled: !row.canSelect,
      attrs: { type: 'button', 'data-focus-key': `vehicle-select-${row.id}` },
      onClick: () => this.options.onSelectVehicle(row.id),
    });
    const start = button(t('vehicleList.action.start'), {
      variant: 'primary',
      className: 'hud-report-action',
      disabled: !row.canStart,
      attrs: {
        type: 'button',
        title: row.canStart ? t('depot.startTitle') : t('vehicle.startBlocked'),
        'data-focus-key': `vehicle-start-${row.id}`,
      },
      onClick: () => this.options.onStartVehicle(row.id),
    });
    const stop = button(t('vehicleList.action.stop'), {
      className: 'hud-report-action',
      disabled: !row.canStop,
      attrs: {
        type: 'button',
        title: t('vehicle.stopTitle'),
        'data-focus-key': `vehicle-stop-${row.id}`,
      },
      onClick: () => this.options.onStopVehicle(row.id),
    });
    const sell = button(t('vehicleList.action.sell'), {
      variant: 'danger',
      className: 'hud-report-action',
      disabled: !row.canSell,
      attrs: { type: 'button', 'data-focus-key': `vehicle-sell-${row.id}` },
      onClick: () => this.options.onSellVehicle(row.id),
    });
    actions.append(select, start, stop, sell);
    item.append(dot, text, actions);
    return item;
  }

  private renderAlerts(alerts: FinanceAlertView[], idPrefix: string): HTMLElement {
    const section = el('section', {
      className: 'hud-report-section hud-report-alerts',
      attrs: { 'aria-labelledby': `${idPrefix}-alerts-title` },
    });
    section.append(sectionHeading(`${idPrefix}-alerts-title`, t('reports.alerts.title')));
    const list = el('ul', { className: 'hud-report-alert-list', attrs: { role: 'list' } });
    for (const alert of alerts) {
      const item = el('li', {
        className: `hud-report-alert is-${alert.tone}`,
        attrs: { role: 'status' },
      });
      item.append(el('strong', { text: alert.title }), el('span', { text: alert.detail }));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  private currentFocusKey(): string | null {
    const active = document.activeElement;
    return active instanceof HTMLElement ? (active.dataset.focusKey ?? null) : null;
  }

  private restoreFocus(key: string | null): void {
    if (!key) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.dataset.focusKey === key &&
      this.element.contains(active)
    ) {
      return;
    }
    for (const node of this.element.querySelectorAll<HTMLElement>('[data-focus-key]')) {
      if (node.dataset.focusKey === key) {
        node.focus({ preventScroll: true });
        return;
      }
    }
  }

  dispose(): void {
    this.stopLanguage();
    this.element.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }
}
