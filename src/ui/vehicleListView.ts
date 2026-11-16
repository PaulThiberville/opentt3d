/**
 * Liste complète des véhicules, filtrable et triable.
 *
 * Depuis #164, les groupes exposés par `snapshot.groups` sont listés, filtrables
 * et gérables (création, renommage, affectation, actions groupées et
 * autoreplace). Un snapshot antérieur à #164 retombe sur un affichage non
 * groupé et des actions désactivées avec une explication. Les actions
 * start/stop/sell réutilisent exactement les règles du panneau véhicule.
 */

import type { VehicleSnapshot, WorldSnapshot } from '../engine/protocol';
import { ordersFromSnapshot } from '../game/vehicleRules';
import { modelsForGroupKind } from '../game/vehicleGroups';
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
  if (vehicle.group && Number.isFinite(vehicle.group.id)) {
    return { id: String(vehicle.group.id), label: vehicle.group.name };
  }
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
  const reliability =
    typeof vehicle.reliability?.reliability === 'number' &&
    Number.isFinite(vehicle.reliability.reliability)
      ? vehicle.reliability.reliability
      : null;
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
    groupId: group?.id ?? UNGROUPED_ID,
    groupLabel: group?.label ?? t('vehicleList.group.none'),
    status,
    statusLabel,
    profit,
    profitLabel: profit === null ? '—' : formatSignedMoney(profit),
    ageDays: age,
    ageLabel: age === null ? '—' : t('selection.unit.days', { value: formatInt(age) }),
    orders,
    reliability,
    reliabilityLabel:
      reliability === null
        ? '—'
        : t('vehicleList.reliabilityValue', { value: formatInt(reliability) }),
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

function groupViews(snapshot: WorldSnapshot, companyId: number | null): VehicleGroupView[] {
  const groups = new Map<string, VehicleGroupView>();
  const counts = new Map<string, number>();
  for (const vehicle of snapshot.vehicles) {
    const id = readGroup(vehicle)?.id ?? UNGROUPED_ID;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const group of snapshot.groups ?? []) {
    if (companyId !== null && group.company !== companyId) continue;
    groups.set(String(group.id), {
      id: String(group.id),
      label: group.name,
      count: counts.get(String(group.id)) ?? group.vehicles,
      kind: group.kind,
      autoreplaceLabel: group.autoreplace
        ? t('vehicleList.groups.autoreplaceValue', {
            model: group.autoreplace.model,
            when: group.autoreplace.whenOld
              ? t('vehicleList.groups.whenOld')
              : t('vehicleList.groups.always'),
          })
        : null,
    });
  }
  for (const vehicle of snapshot.vehicles) {
    const group = readGroup(vehicle);
    if (!group) continue;
    if (groups.has(group.id)) continue;
    groups.set(group.id, {
      id: group.id,
      label: group.label,
      count: counts.get(group.id) ?? 1,
      kind: vehicle.kind,
      autoreplaceLabel: null,
    });
  }
  if ((counts.get(UNGROUPED_ID) ?? 0) > 0) {
    groups.set(UNGROUPED_ID, {
      id: UNGROUPED_ID,
      label: t('vehicleList.group.none'),
      count: counts.get(UNGROUPED_ID) ?? 0,
      kind: null,
      autoreplaceLabel: null,
    });
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
  const groups = snapshot ? groupViews(snapshot, companyId) : [];
  const canManageGroups = Boolean(snapshot && Array.isArray(snapshot.groups));
  const selectedGroup =
    canManageGroups && filters.group !== 'all'
      ? (groups.find((group) => group.id === filters.group) ?? null)
      : null;
  const groupReason = t(
    canManageGroups ? 'vehicleList.groups.manageHint' : 'vehicleList.groups.reason',
  );
  const kindOptions: ReportOption[] = [
    { value: 'all', label: t('vehicleList.filter.all') },
    ...KINDS.map((kind) => ({ value: kind, label: vehicleLabel(kind) })),
  ];
  const groupOptions: ReportOption[] = [
    { value: 'all', label: t('vehicleList.filter.all') },
    ...groups.map((group) => ({ value: group.id, label: group.label })),
  ];
  const action = (
    id: string,
    label: string,
    supported: boolean,
    reason?: string,
  ): { id: string; label: string; supported: boolean; reason?: string } =>
    supported ? { id, label, supported } : { id, label, supported, ...(reason ? { reason } : {}) };
  const groupActions = [
    action('create', t('vehicleList.groups.create'), canManageGroups, groupReason),
    action(
      'rename',
      t('vehicleList.groups.rename'),
      canManageGroups && selectedGroup !== null && selectedGroup.id !== UNGROUPED_ID,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
    action(
      'delete',
      t('vehicleList.groups.delete'),
      canManageGroups && selectedGroup !== null && selectedGroup.id !== UNGROUPED_ID,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
    action(
      'start',
      t('vehicleList.groups.start'),
      canManageGroups && selectedGroup !== null && selectedGroup.id !== UNGROUPED_ID,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
    action(
      'stop',
      t('vehicleList.groups.stop'),
      canManageGroups && selectedGroup !== null && selectedGroup.id !== UNGROUPED_ID,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
    action(
      'send_to_depot',
      t('vehicleList.groups.sendToDepot'),
      canManageGroups && selectedGroup !== null && selectedGroup.id !== UNGROUPED_ID,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
    action(
      'sell',
      t('vehicleList.groups.sell'),
      canManageGroups && selectedGroup !== null && selectedGroup.id !== UNGROUPED_ID,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
    action(
      'autoreplace',
      t('vehicleList.groups.autoreplace'),
      canManageGroups && selectedGroup !== null && selectedGroup.kind !== null,
      canManageGroups ? t('vehicleList.groups.selectFirst') : groupReason,
    ),
  ];
  const selectedSnapshotGroup =
    selectedGroup && snapshot?.groups
      ? (snapshot.groups.find((group) => String(group.id) === selectedGroup.id) ?? null)
      : null;
  const autoreplaceOptions: ReportOption[] = selectedGroup?.kind
    ? modelsForGroupKind(selectedGroup.kind as VehicleSnapshot['kind']).map((model) => ({
        value: model.id,
        label: model.name,
      }))
    : [];
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
    groupActions,
    groupNote: groupReason,
    selectedGroup,
    canManageGroups,
    autoreplaceOptions,
    autoreplace: selectedSnapshotGroup?.autoreplace ?? null,
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
