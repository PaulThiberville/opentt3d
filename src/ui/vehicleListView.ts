/**
 * Liste complète des véhicules, filtrable et triable.
 *
 * Le protocole v1 n'expose pas les groupes de véhicules : les champs `group`,
 * `groupName` ou `groupId` d'un snapshot étendu sont lus s'ils existent, sinon
 * tous les véhicules sont « non groupés » et les actions de groupe restent
 * désactivées avec une explication. Les actions start/stop/sell réutilisent
 * exactement les règles du panneau véhicule.
 */

import type { VehicleSnapshot, WorldSnapshot } from '../engine/protocol';
import { ordersFromSnapshot } from '../game/vehicleRules';
import { cargoLabel, vehicleLabel, vehicleStatusLabel } from './labels';
import { formatInt, formatMoney, formatSignedMoney } from './format';
import { t } from './i18n';
import type {
  ReportOption,
  VehicleGroupView,
  VehicleListFilters,
  VehicleListPanelView,
  VehicleListRowView,
  VehicleListSort,
} from './types';

type UnknownRecord = Record<string, unknown>;

export const RECENT_AGE_DAYS = 30;
export const OLD_AGE_DAYS = 90;
export const UNGROUPED_ID = '__none';

const KINDS = ['train', 'road', 'ship', 'aircraft'] as const;

interface VehicleGroup {
  id: string;
  label: string;
}

export function createDefaultVehicleFilters(): VehicleListFilters {
  return {
    kind: 'all',
    group: 'all',
    status: 'all',
    profit: 'all',
    age: 'all',
    query: '',
    sort: 'profit',
  };
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readGroup(vehicle: VehicleSnapshot): VehicleGroup | null {
  const record = vehicle as unknown as UnknownRecord;
  for (const candidate of [record.group, record.vehicleGroup, record.line]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return { id: candidate.trim(), label: candidate.trim() };
    }
    const nested = asRecord(candidate);
    if (!nested) continue;
    const label =
      typeof nested.name === 'string'
        ? nested.name.trim()
        : typeof nested.label === 'string'
          ? nested.label.trim()
          : '';
    const id = nested.id ?? nested.key;
    if (label || (typeof id === 'string' && id.trim()) || typeof id === 'number') {
      return {
        id: String(id ?? label),
        label: label || `#${String(id)}`,
      };
    }
  }
  const groupName = typeof record.groupName === 'string' ? record.groupName.trim() : '';
  const groupId = record.groupId;
  if (groupName || typeof groupId === 'string' || typeof groupId === 'number') {
    return {
      id: String(groupId ?? groupName),
      label: groupName || `#${String(groupId)}`,
    };
  }
  return null;
}

function statusGroup(status: number | null): 'moving' | 'stopped' | 'depot' | 'unknown' {
  if (status === 1 || status === 2) return 'moving';
  if (status === 3) return 'depot';
  if (status === 0 || status === 4) return 'stopped';
  return 'unknown';
}

function cargoText(vehicle: VehicleSnapshot): string {
  const cargo = vehicle.cargo;
  if (!cargo) return t('selection.vacant');
  return `${cargoLabel(cargo.type)} ${formatInt(cargo.amount)} / ${formatInt(cargo.capacity)}`;
}

function rowFromVehicle(
  vehicle: VehicleSnapshot,
  companyId: number | null,
  companyName: string,
  colour: number,
): VehicleListRowView {
  const kind = vehicleLabel(vehicle.kind);
  const status = finite(vehicle.status);
  const profit = finite(vehicle.profitLastYear);
  const age = finite(vehicle.ageDays);
  const orders = Array.isArray(vehicle.orderTargets) ? vehicle.orderTargets.length : 0;
  const group = readGroup(vehicle);
  const isLocal = companyId !== null && vehicle.company === companyId;
  const statusLabel = vehicleStatusLabel(status ?? -1);
  return {
    id: vehicle.id,
    title: t('vehicleList.rowTitle', { kind, id: vehicle.id }),
    detail: t('vehicleList.detail', {
      status: statusLabel,
      cargo: cargoText(vehicle),
      orders: formatInt(orders),
    }),
    companyName,
    colour,
    kind: vehicle.kind,
    groupLabel: group?.label ?? t('vehicleList.group.none'),
    status,
    statusLabel,
    profit,
    profitLabel: profit === null ? '—' : formatSignedMoney(profit),
    ageDays: age,
    ageLabel: age === null ? '—' : t('selection.unit.days', { value: formatInt(age) }),
    orders,
    isLocal,
    canSelect: true,
    canStart: isLocal && orders > 0 && status !== 1 && status !== 2,
    canStop: isLocal && (status === 1 || status === 2),
    canSell: isLocal,
    note: isLocal ? null : t('vehicleList.reason.otherCompany'),
  };
}

function matchesFilters(
  vehicle: VehicleSnapshot,
  row: VehicleListRowView,
  filters: VehicleListFilters,
): boolean {
  if (filters.kind !== 'all' && vehicle.kind !== filters.kind) return false;
  if (filters.group !== 'all') {
    const group = readGroup(vehicle);
    const id = group?.id ?? UNGROUPED_ID;
    if (id !== filters.group) return false;
  }
  const status = statusGroup(finite(vehicle.status));
  if (filters.status !== 'all' && status !== filters.status) return false;
  if (filters.profit === 'profit' && !(row.profit !== null && row.profit > 0)) return false;
  if (filters.profit === 'loss' && !(row.profit !== null && row.profit < 0)) return false;
  if (filters.age === 'recent' && !(row.ageDays !== null && row.ageDays <= RECENT_AGE_DAYS)) {
    return false;
  }
  if (filters.age === 'old' && !(row.ageDays !== null && row.ageDays >= OLD_AGE_DAYS)) return false;
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [
      String(vehicle.id),
      row.kind,
      row.groupLabel,
      row.companyName,
      row.statusLabel,
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function compareRows(a: VehicleListRowView, b: VehicleListRowView, sort: VehicleListSort): number {
  switch (sort) {
    case 'age':
      return (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.id - b.id;
    case 'id':
      return a.id - b.id;
    case 'type':
      return a.kind.localeCompare(b.kind) || a.id - b.id;
    case 'status':
      return a.statusLabel.localeCompare(b.statusLabel) || a.id - b.id;
    case 'group':
      return a.groupLabel.localeCompare(b.groupLabel) || a.id - b.id;
    case 'profit':
    default:
      return (b.profit ?? -Infinity) - (a.profit ?? -Infinity) || a.id - b.id;
  }
}

function groupViews(snapshot: WorldSnapshot): VehicleGroupView[] {
  const groups = new Map<string, VehicleGroupView>();
  for (const vehicle of snapshot.vehicles) {
    const group = readGroup(vehicle);
    const id = group?.id ?? UNGROUPED_ID;
    const label = group?.label ?? t('vehicleList.group.none');
    const existing = groups.get(id);
    if (existing) existing.count += 1;
    else groups.set(id, { id, label, count: 1 });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === UNGROUPED_ID) return 1;
    if (b.id === UNGROUPED_ID) return -1;
    return a.label.localeCompare(b.label);
  });
}

/** Construit la vue filtrée de tous les véhicules du snapshot. */
export function describeVehicleListPanel(
  snapshot: WorldSnapshot | null,
  companyId: number | null,
  filters: VehicleListFilters = createDefaultVehicleFilters(),
): VehicleListPanelView {
  const companies = new Map(
    (snapshot?.companies ?? []).map((company) => [company.id, company] as const),
  );
  const rows = (snapshot?.vehicles ?? [])
    .flatMap((vehicle) => {
      const company = companies.get(vehicle.company);
      const row = rowFromVehicle(
        vehicle,
        companyId,
        company?.name ?? t('finance.companyUnknown'),
        company?.colour ?? 8,
      );
      return matchesFilters(vehicle, row, filters) ? [row] : [];
    })
    .sort((a, b) => compareRows(a, b, filters.sort));

  const profit = rows.reduce((sum, row) => sum + (row.profit ?? 0), 0);
  const ages = rows
    .map((row) => row.ageDays)
    .filter((age): age is number => age !== null && Number.isFinite(age));
  const moving = rows.filter((row) => statusGroup(row.status) === 'moving').length;
  const groups = snapshot ? groupViews(snapshot) : [];
  const groupReason = t('vehicleList.groups.reason');
  const kindOptions: ReportOption[] = [
    { value: 'all', label: t('vehicleList.filter.all') },
    ...KINDS.map((kind) => ({ value: kind, label: vehicleLabel(kind) })),
  ];
  const groupOptions: ReportOption[] = [
    { value: 'all', label: t('vehicleList.filter.all') },
    ...groups.map((group) => ({ value: group.id, label: group.label })),
  ];
  return {
    summary: {
      count: rows.length,
      moving,
      profit,
      profitLabel: formatSignedMoney(profit),
      averageAgeLabel:
        ages.length === 0
          ? '—'
          : t('selection.unit.days', {
              value: formatInt(ages.reduce((sum, age) => sum + age, 0) / ages.length),
            }),
    },
    rows,
    groups,
    kindOptions,
    groupOptions,
    groupActions: [
      {
        id: 'create',
        label: t('vehicleList.groups.create'),
        supported: false,
        reason: groupReason,
      },
      {
        id: 'rename',
        label: t('vehicleList.groups.rename'),
        supported: false,
        reason: groupReason,
      },
      {
        id: 'assign',
        label: t('vehicleList.groups.assign'),
        supported: false,
        reason: groupReason,
      },
    ],
    groupNote: groupReason,
    empty: t('vehicleList.empty'),
    hint: t('vehicleList.hint'),
  };
}

/** Montant total des bénéfices de l'année, exposé pour les tests et le HUD. */
export function totalVehicleProfit(
  snapshot: WorldSnapshot | null,
  companyId: number | null,
): number {
  if (!snapshot) return 0;
  return snapshot.vehicles.reduce((sum, vehicle) => {
    if (companyId !== null && vehicle.company !== companyId) return sum;
    return sum + (finite(vehicle.profitLastYear) ?? 0);
  }, 0);
}

/** Nombre d'ordres d'un véhicule, tolérant aux snapshots partiels. */
export function vehicleOrderCount(
  vehicle: VehicleSnapshot,
  snapshot: WorldSnapshot | null,
): number {
  return ordersFromSnapshot(vehicle, snapshot).length;
}

/** Montant formaté pour un éventuel affichage compact. */
export function vehicleProfitLabel(
  snapshot: WorldSnapshot | null,
  companyId: number | null,
): string {
  return formatMoney(totalVehicleProfit(snapshot, companyId));
}
