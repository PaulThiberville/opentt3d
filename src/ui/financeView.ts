/**
 * Vue du panneau Finances.
 *
 * Le protocole v1 n'expose que des agrégats (`income`, `expenses`, `loan`,
 * `value`). Les snapshots étendus peuvent ajouter un détail par catégorie et
 * des limites de prêt : ce module les lit de façon défensive (tableau, objet
 * de nombres ou objet d'objets) sans jamais inventer de montant. À défaut, une
 * seule ligne agrégée est affichée et le panneau explique la limite.
 */

import type { CompanySnapshot, WorldSnapshot } from '../engine/protocol';
import { formatInt, formatMoney, formatPercent, formatSignedMoney } from './format';
import { cargoLabel, CARGO_LABEL_KEYS } from './labels';
import { t, type TranslationKey } from './i18n';
import type {
  FinanceAlertView,
  FinanceCategoryView,
  FinanceHistoryPoint,
  FinancePanelView,
  FinanceRankingRow,
  ReportActionView,
} from './types';
import { percentOf } from './charts';

type UnknownRecord = Record<string, unknown>;

const CATEGORY_KEYS: Record<string, TranslationKey> = {
  passengers: 'label.cargo.passengers',
  mail: 'label.cargo.mail',
  coal: 'label.cargo.coal',
  wood: 'label.cargo.wood',
  grain: 'label.cargo.grain',
  goods: 'label.cargo.goods',
  oil: 'label.cargo.oil',
  livestock: 'label.cargo.livestock',
  valuables: 'label.cargo.valuables',
  iron_ore: 'label.cargo.iron_ore',
  steel: 'label.cargo.steel',
  water: 'label.cargo.water',
  fruit: 'label.cargo.fruit',
  maize: 'label.cargo.maize',
  food: 'label.cargo.food',
  vehicle_purchase: 'finance.category.vehiclePurchase',
  vehicle_running: 'finance.category.vehicleRunning',
  vehicle_maintenance: 'finance.category.vehicleMaintenance',
  infrastructure: 'finance.category.infrastructure',
  construction: 'finance.category.construction',
  station_maintenance: 'finance.category.stationMaintenance',
  loan_interest: 'finance.category.loanInterest',
  interest: 'finance.category.loanInterest',
  land: 'finance.category.land',
  other: 'finance.category.other',
  revenue: 'finance.category.revenue',
  expenses: 'finance.category.expenses',
};

const HISTORY_LIMIT = 60;

export interface CompanyShare {
  company: CompanySnapshot;
  value: number;
  share: number | null;
}

interface RawCategory {
  id: string;
  label: string | null;
  amount: number;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readAmount(record: UnknownRecord): number | null {
  return firstFinite(record.amount, record.value, record.total, record.money, record.sum);
}

function readId(record: UnknownRecord): string | null {
  for (const field of ['id', 'key', 'category', 'type', 'code']) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readLabel(record: UnknownRecord): string | null {
  for (const field of ['label', 'name', 'title']) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Normalise les formes de détail rencontrées dans les snapshots étendus. */
function readCategories(value: unknown): RawCategory[] {
  const categories: RawCategory[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && typeof item[0] === 'string') {
        const amount = finite(item[1]);
        if (amount !== null) categories.push({ id: item[0], label: null, amount });
        continue;
      }
      const record = asRecord(item);
      if (!record) continue;
      const amount = readAmount(record);
      if (amount === null) continue;
      const label = readLabel(record);
      const id = readId(record) ?? label ?? 'other';
      categories.push({ id, label, amount });
    }
    return categories;
  }
  const record = asRecord(value);
  if (!record) return categories;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number') {
      if (Number.isFinite(item)) categories.push({ id: key, label: null, amount: item });
      continue;
    }
    const nested = asRecord(item);
    if (!nested) continue;
    const amount = readAmount(nested);
    if (amount === null) continue;
    categories.push({ id: key, label: readLabel(nested), amount });
  }
  return categories;
}

function humanize(id: string): string {
  return id.replace(/[_-]+/g, ' ').trim() || id;
}

/** Libellé localisé d'une catégorie ; une clé inconnue reste lisible. */
export function financeCategoryLabel(id: string, fallback: string | null = null): string {
  if (fallback?.trim()) return fallback.trim();
  const key = CATEGORY_KEYS[id];
  if (key) return t(key);
  if (CARGO_LABEL_KEYS[id]) return cargoLabel(id);
  return humanize(id);
}

function toViews(categories: readonly RawCategory[], sharedMax: number): FinanceCategoryView[] {
  return [...categories]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((category) => ({
      id: category.id,
      label: financeCategoryLabel(category.id, category.label),
      amount: category.amount,
      amountLabel: formatMoney(category.amount),
      percent: percentOf(Math.abs(category.amount), sharedMax),
    }));
}

function financeRecord(company: CompanySnapshot): UnknownRecord | null {
  const record = company as unknown as UnknownRecord;
  return asRecord(record.finance) ?? asRecord(record.finances) ?? asRecord(record.economy) ?? null;
}

function readRevenueCategories(
  company: CompanySnapshot,
  finance: UnknownRecord | null,
): RawCategory[] {
  const record = company as unknown as UnknownRecord;
  return readCategories(
    finance?.revenue ??
      finance?.revenues ??
      finance?.incomeBreakdown ??
      finance?.income ??
      record.revenueBreakdown ??
      record.incomeBreakdown,
  );
}

function readExpenseCategories(
  company: CompanySnapshot,
  finance: UnknownRecord | null,
): RawCategory[] {
  const record = company as unknown as UnknownRecord;
  return readCategories(
    finance?.expenses ??
      finance?.expense ??
      finance?.costs ??
      finance?.expenseBreakdown ??
      record.expenseBreakdown ??
      record.expensesBreakdown,
  );
}

function readLoanLimit(company: CompanySnapshot, finance: UnknownRecord | null): number | null {
  const record = company as unknown as UnknownRecord;
  return firstFinite(
    finance?.loanLimit,
    finance?.maxLoan,
    finance?.loanCeiling,
    record.loanLimit,
    record.maxLoan,
  );
}

function readInterestRate(company: CompanySnapshot, finance: UnknownRecord | null): number | null {
  const record = company as unknown as UnknownRecord;
  return firstFinite(
    finance?.interestRate,
    finance?.loanRate,
    record.interestRate,
    record.loanRate,
  );
}

/** Entreprise locale (`isLocal`), sinon la première entreprise du snapshot. */
export function localCompany(snapshot: WorldSnapshot | null): CompanySnapshot | null {
  if (!snapshot) return null;
  return snapshot.companies.find((company) => company.isLocal) ?? snapshot.companies[0] ?? null;
}

/**
 * Valeur d'entreprise positive et part relative. Une valeur totale nulle
 * laisse `share` à `null` : le panneau affiche « — » plutôt que 0 % trompeur.
 */
export function companyShares(snapshot: WorldSnapshot | null): CompanyShare[] {
  if (!snapshot) return [];
  const rows = snapshot.companies
    .map((company) => ({
      company,
      value: Math.max(0, finite(company.value) ?? 0),
      money: finite(company.money) ?? 0,
    }))
    .sort((a, b) => b.value - a.value || b.money - a.money || a.company.id - b.company.id);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return rows.map((row) => ({
    company: row.company,
    value: row.value,
    share: total > 0 ? (row.value / total) * 100 : null,
  }));
}

function rankingRows(snapshot: WorldSnapshot | null): FinanceRankingRow[] {
  return companyShares(snapshot).map((entry, index) => {
    const value = finite(entry.company.value);
    return {
      id: entry.company.id,
      rank: index + 1,
      name: entry.company.name || t('finance.companyUnknown'),
      colour: entry.company.colour,
      value,
      valueLabel: value === null ? '—' : formatMoney(value),
      share: entry.share,
      shareLabel: entry.share === null ? '—' : formatPercent(entry.share, 1),
      isLocal: entry.company.isLocal,
      bankrupt: entry.company.bankrupt,
    };
  });
}

function alertList(
  snapshot: WorldSnapshot | null,
  company: CompanySnapshot | null,
): FinanceAlertView[] {
  if (!snapshot || !company) {
    return [
      {
        id: 'no-company',
        tone: 'info',
        title: t('finance.alert.noCompany.title'),
        detail: t('finance.alert.noCompany.detail'),
      },
    ];
  }
  const alerts: FinanceAlertView[] = [];
  for (const entry of snapshot.companies) {
    if (!entry.bankrupt) continue;
    alerts.push({
      id: `bankrupt-${entry.id}`,
      tone: 'error',
      title: t('finance.alert.bankrupt.title'),
      detail: t('finance.alert.bankrupt.detail', {
        company: entry.name || t('finance.companyUnknown'),
      }),
    });
  }
  const money = finite(company.money);
  if (money !== null && money < 0 && !company.bankrupt) {
    alerts.push({
      id: 'negative-cash',
      tone: 'error',
      title: t('finance.alert.negativeCash.title'),
      detail: t('finance.alert.negativeCash.detail', {
        company: company.name || t('finance.companyUnknown'),
        money: formatSignedMoney(money),
      }),
    });
  }
  const income = finite(company.income);
  const expenses = finite(company.expenses);
  const result = income !== null && expenses !== null ? income - expenses : null;
  if (result !== null && result < 0) {
    alerts.push({
      id: 'deficit',
      tone: 'warning',
      title: t('finance.alert.deficit.title'),
      detail: t('finance.alert.deficit.detail', { value: formatMoney(Math.abs(result)) }),
    });
  }
  return alerts.slice(0, 5);
}

/** Points d'historique valides, les plus récents en dernier. */
export function sanitizeHistory(history: readonly FinanceHistoryPoint[]): FinanceHistoryPoint[] {
  return history
    .filter(
      (point) =>
        Number.isFinite(point.tick) &&
        Number.isFinite(point.money) &&
        Number.isFinite(point.income) &&
        Number.isFinite(point.expenses),
    )
    .slice(-HISTORY_LIMIT);
}

function aggregateCategories(total: number | null, id: 'revenue' | 'expenses'): RawCategory[] {
  return total === null ? [] : [{ id, label: null, amount: total }];
}

/** Construit la vue complète du panneau Finances. */
export function describeFinancePanel(
  snapshot: WorldSnapshot | null,
  history: readonly FinanceHistoryPoint[] = [],
): FinancePanelView {
  const company = localCompany(snapshot);
  const money = company ? finite(company.money) : null;
  const value = company ? finite(company.value) : null;
  const loan = company ? finite(company.loan) : null;
  const income = company ? finite(company.income) : null;
  const expenses = company ? finite(company.expenses) : null;
  const result = income !== null && expenses !== null ? income - expenses : null;
  const finance = company ? financeRecord(company) : null;
  const rawRevenue = company ? readRevenueCategories(company, finance) : [];
  const rawExpenses = company ? readExpenseCategories(company, finance) : [];
  const breakdownAvailable = rawRevenue.length > 0 || rawExpenses.length > 0;
  const revenue = rawRevenue.length > 0 ? rawRevenue : aggregateCategories(income, 'revenue');
  const expenseRows =
    rawExpenses.length > 0 ? rawExpenses : aggregateCategories(expenses, 'expenses');
  const sharedMax = Math.max(
    0,
    ...[...revenue, ...expenseRows].map((category) => Math.abs(category.amount)),
  );
  const loanLimit = company ? readLoanLimit(company, finance) : null;
  const interestRate = company ? readInterestRate(company, finance) : null;
  const reason = t('finance.reason.loan');
  const actions: ReportActionView[] = [
    { id: 'borrow', label: t('finance.action.borrow'), supported: false, reason },
    { id: 'repay', label: t('finance.action.repay'), supported: false, reason },
  ];
  return {
    companyId: company?.id ?? null,
    companyName: company?.name || t('finance.companyUnknown'),
    money,
    moneyLabel: money === null ? '—' : formatMoney(money),
    value,
    valueLabel: value === null ? '—' : formatMoney(value),
    loan,
    loanLabel: loan === null ? '—' : formatMoney(loan),
    loanLimitLabel: loanLimit === null ? null : formatMoney(loanLimit),
    interestRateLabel: interestRate === null ? null : formatPercent(interestRate, 1),
    income,
    incomeLabel: income === null ? '—' : formatSignedMoney(income),
    expenses,
    expensesLabel: expenses === null ? '—' : formatMoney(expenses),
    result,
    resultLabel: result === null ? '—' : formatSignedMoney(result),
    resultTone: result === null ? 'muted' : result > 0 ? 'good' : result < 0 ? 'bad' : 'muted',
    revenue: toViews(revenue, sharedMax),
    expensesByCategory: toViews(expenseRows, sharedMax),
    breakdownAvailable,
    history: sanitizeHistory(history),
    ranking: rankingRows(snapshot),
    alerts: alertList(snapshot, company),
    actions,
    hint: breakdownAvailable ? t('finance.hint.detail') : t('finance.hint.aggregate'),
  };
}

/** Libellé compact d'une valeur d'historique, pour l'axe et l'aria. */
export function historyLabel(points: readonly FinanceHistoryPoint[]): string {
  const last = points[points.length - 1];
  if (!last) return '—';
  return formatMoney(last.money);
}

/** Résumé textuel accessible du graphique de trésorerie. */
export function financeChartLabel(points: readonly FinanceHistoryPoint[]): string {
  if (points.length === 0) return t('finance.chart.empty');
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return t('finance.chart.empty');
  const delta = last.money - first.money;
  return t('finance.chart.aria', {
    start: formatMoney(first.money),
    end: formatMoney(last.money),
    delta: formatSignedMoney(delta),
    points: formatInt(points.length),
  });
}
