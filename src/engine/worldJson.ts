/**
 * Mapping du snapshot JSON du pont (`ottd_snapshot_json`) vers `WorldSnapshot`.
 *
 * Le pont omet volontairement certains champs du contrat (IA, cargaison
 * détaillée, actualités) : chaque champ absent reçoit une valeur par défaut
 * **documentée** ci-dessous plutôt que `undefined`, pour que le rendu et le HUD
 * n'aient jamais à tester la forme des données.
 *
 * Défauts appliqués quand le champ (ou l'entité) manque :
 *
 * | Champ | Défaut |
 * |---|---|
 * | `meta.hash` | `'0x0000000000000000'` |
 * | `meta.sequence` | `0` |
 * | `economy` absent/null | 1950-01-01, jour 1, vitesse 1, non pause |
 * | `economy.month` | tel quel (le pont et le protocole sont en base 0) |
 * | `company.*` absent | 0, `''`, couleur 0, `isLocal = false` |
 * | `town.growthRate` | 0 |
 * | `town.rating` | 0 (échelle 0..1000) |
 * | `town.authority` absent | aucune action locale exposée |
 * | `industry.kind` | `'unknown'` |
 * | `industry.serviceRate` | `transported / production × 100` |
 * | `company.maxLoan`/`monthsOfBankruptcy` | absents = repli UI |
 * | `economy.inflation`/`interestRate`… | absents = repli UI |
 * | `subsidies` absent | `[]` |
 * | `station.kind` inconnu | `'train'` |
 * | `depot.kind` inconnu | dépôt ignoré (aucune cible d'achat/ordre) |
 * | `depot.id` | 0 minimum, entier |
 * | `depot.company` | `COMPANY_NONE` |
 * | `depot.direction` | 0..3 |
 * | `depot.width`/`height` | 1 |
 * | `vehicle.cargo` | `null` |
 * | `vehicle.status` | 0 (arrêté) |
 * | `vehicle.orderTargets` | `[]` |
 * | `vehicle.orderDetails` | absent : l'UI retombe sur `orderTargets` |
 * | `vehicle.currentOrder` | absent |
 * | `vehicle.model` | absent : modèle inféré par type/cargaison |
 * | `vehicle.kind` inconnu | véhicule ignoré (aucun modèle de rendu) |
 * | `news`/`events` absents | `[]` |
 *
 * Une carte (`map`) n'est jamais produite ici : elle arrive par le buffer
 * binaire (`mapBinary.ts`) et est attachée par `WasmEngine`.
 */

import {
  COMPANY_NONE,
  PROTOCOL_VERSION,
  type CompanyId,
  type CompanySnapshot,
  type DepotKind,
  type DepotSnapshot,
  type DisasterKind,
  type DisasterSnapshot,
  type EconomySnapshot,
  type IndustrySnapshot,
  type OrderAction,
  type OrderComparator,
  type OrderCondition,
  type OrderConditionType,
  type OrderOptions,
  type OrderTargetKind,
  type OrderTimetable,
  type SnapshotMeta,
  type StationSnapshot,
  type StructureSnapshot,
  type SubsidySnapshot,
  type TownActionKind,
  type TownActionSnapshot,
  type TownAuthoritySnapshot,
  type TownSnapshot,
  type VehicleKind,
  type VehicleOrderSnapshot,
  type VehicleSnapshot,
  type WorldEvent,
  type WorldSnapshot,
} from './protocol';
import { parseRailType } from '../game/railRules';

export type WorldJsonErrorCode = 'not-json' | 'protocol' | 'shape';

export class WorldJsonError extends Error {
  readonly code: WorldJsonErrorCode;

  constructor(code: WorldJsonErrorCode, message: string) {
    super(message);
    this.name = 'WorldJsonError';
    this.code = code;
  }
}

const DEFAULT_HASH = '0x0000000000000000';
const DEFAULT_ECONOMY: EconomySnapshot = {
  year: 1950,
  month: 0,
  day: 1,
  dayFraction: 0,
  speed: 1,
  paused: false,
};

type JsonRecord = Record<string, unknown>;

function fail(code: WorldJsonErrorCode, message: string): never {
  throw new WorldJsonError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = int(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function companyId(value: unknown): CompanyId {
  const id = int(value, COMPANY_NONE);
  return id >= 0 && id <= 255 ? id : COMPANY_NONE;
}

function cargoList(
  value: unknown,
  amountKey: 'amount' | 'rate' = 'amount',
): {
  cargo: string;
  amount: number;
}[] {
  const entries: { cargo: string; amount: number }[] = [];
  for (const item of list(value)) {
    if (!isRecord(item)) continue;
    entries.push({
      cargo: str(item.cargo, 'inconnu'),
      amount: Math.max(0, int(item[amountKey], 0)),
    });
  }
  return entries;
}

const VEHICLE_KINDS: readonly VehicleKind[] = ['train', 'road', 'ship', 'aircraft'];

const ORDER_KINDS: readonly OrderTargetKind[] = ['station', 'industry', 'depot', 'conditional'];
const ORDER_ACTIONS: readonly OrderAction[] = [
  'normal',
  'full_load',
  'no_load',
  'unload',
  'transfer',
];
const ORDER_CONDITION_TYPES: readonly OrderConditionType[] = [
  'cargo',
  'money',
  'date',
  'percentage',
];
const ORDER_COMPARATORS: readonly OrderComparator[] = [
  'equal',
  'not_equal',
  'less',
  'less_or_equal',
  'more',
  'more_or_equal',
];

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function parseOrderOptions(value: unknown): OrderOptions | undefined {
  if (!isRecord(value)) return undefined;
  const action = oneOf(value.action, ORDER_ACTIONS);
  const conditionRaw = value.condition;
  let condition: OrderCondition | undefined;
  if (isRecord(conditionRaw)) {
    const type = oneOf(conditionRaw.type, ORDER_CONDITION_TYPES);
    const comparator = oneOf(conditionRaw.comparator, ORDER_COMPARATORS);
    if (type && comparator) {
      condition = {
        type,
        comparator,
        value: int(conditionRaw.value, 0),
        ...(typeof conditionRaw.cargo === 'string' ? { cargo: conditionRaw.cargo } : {}),
        ...(Number.isFinite(conditionRaw.month)
          ? { month: clampInt(conditionRaw.month, 0, 11, 0) }
          : {}),
      };
    }
  }
  const jump = Number.isFinite(value.jump) ? Math.max(0, int(value.jump, 0)) : undefined;
  const timetableRaw = value.timetable;
  let timetable: OrderTimetable | undefined;
  if (isRecord(timetableRaw)) {
    const waitTicks = Number.isFinite(timetableRaw.waitTicks)
      ? Math.max(0, int(timetableRaw.waitTicks, 0))
      : undefined;
    const travelTicks = Number.isFinite(timetableRaw.travelTicks)
      ? Math.max(0, int(timetableRaw.travelTicks, 0))
      : undefined;
    const autostart = timetableRaw.autostart === true ? true : undefined;
    if (waitTicks !== undefined || travelTicks !== undefined || autostart !== undefined) {
      timetable = {
        ...(waitTicks !== undefined ? { waitTicks } : {}),
        ...(travelTicks !== undefined ? { travelTicks } : {}),
        ...(autostart !== undefined ? { autostart } : {}),
      };
    }
  }
  if (!action && !condition && jump === undefined && !timetable) return undefined;
  return {
    ...(action ? { action } : {}),
    ...(condition ? { condition } : {}),
    ...(jump !== undefined ? { jump } : {}),
    ...(timetable ? { timetable } : {}),
  };
}

function parseOrderDetails(value: unknown): VehicleOrderSnapshot[] {
  const orders: VehicleOrderSnapshot[] = [];
  for (const entry of list(value)) {
    if (!isRecord(entry)) continue;
    const kind = oneOf(entry.kind, ORDER_KINDS);
    if (!kind) continue;
    const target = Math.trunc(num(entry.target, kind === 'conditional' ? -1 : 0));
    const options = parseOrderOptions(entry.options);
    orders.push({
      target,
      kind,
      ...(options ? { options } : {}),
    });
  }
  return orders;
}

function vehicleKind(value: unknown): VehicleKind | null {
  return typeof value === 'string' && (VEHICLE_KINDS as readonly string[]).includes(value)
    ? (value as VehicleKind)
    : null;
}

const STATION_KINDS = ['train', 'road', 'ship', 'airport', 'buoy'] as const;

function stationKind(value: unknown): StationSnapshot['kind'] {
  return typeof value === 'string' && (STATION_KINDS as readonly string[]).includes(value)
    ? (value as StationSnapshot['kind'])
    : 'train';
}

const NEWS_KINDS = ['info', 'warning', 'error', 'company'] as const;

function newsKind(value: unknown): WorldSnapshot['news'][number]['kind'] {
  return typeof value === 'string' && (NEWS_KINDS as readonly string[]).includes(value)
    ? (value as WorldSnapshot['news'][number]['kind'])
    : 'info';
}

const DEPOT_KINDS: readonly DepotKind[] = ['road', 'rail'];

function depotKind(value: unknown): DepotKind | null {
  return typeof value === 'string' && (DEPOT_KINDS as readonly string[]).includes(value)
    ? (value as DepotKind)
    : null;
}

/* ------------------------------------------------------------------------- */
/*  Entités                                                                  */
/* ------------------------------------------------------------------------- */

export function parseCompany(value: unknown): CompanySnapshot {
  const raw = record(value);
  const id = clampInt(raw.id, 0, 254, 0);
  return {
    id,
    name: str(raw.name, `Entreprise ${id + 1}`),
    president: str(raw.president, ''),
    colour: clampInt(raw.colour, 0, 15, id % 16),
    money: num(raw.money, 0),
    loan: num(raw.loan, 0),
    value: num(raw.value, 0),
    income: num(raw.income, 0),
    expenses: num(raw.expenses, 0),
    vehicles: Math.max(0, int(raw.vehicles, 0)),
    stations: Math.max(0, int(raw.stations, 0)),
    isAI: bool(raw.isAI),
    isLocal: bool(raw.isLocal),
    bankrupt: bool(raw.bankrupt),
    ...(typeof raw.maxLoan === 'number' ? { maxLoan: Math.max(0, num(raw.maxLoan, 0)) } : {}),
    ...(typeof raw.monthsOfBankruptcy === 'number'
      ? { monthsOfBankruptcy: Math.max(0, int(raw.monthsOfBankruptcy, 0)) }
      : {}),
    ...(typeof raw.aiLevel === 'number' && raw.aiLevel > 0
      ? { aiLevel: clampInt(raw.aiLevel, 1, 3, 1) }
      : {}),
  };
}

const TOWN_ACTIONS: readonly TownActionKind[] = ['advertise', 'fund_roads', 'fund_buildings'];

function parseTownAction(value: unknown): TownActionSnapshot {
  const raw = record(value);
  return {
    available: bool(raw.available, true),
    cost: Math.max(0, num(raw.cost, 0)),
  };
}

/** Autorité locale : chaque action absente retombe sur « indisponible ». */
export function parseTownAuthority(value: unknown, rating: number): TownAuthoritySnapshot {
  const raw = record(value);
  const actionsRaw = record(raw.actions);
  const actions = {} as Record<TownActionKind, TownActionSnapshot>;
  for (const action of TOWN_ACTIONS) {
    const entry = actionsRaw[action];
    actions[action] = entry === undefined ? { available: false, cost: 0 } : parseTownAction(entry);
  }
  return {
    rating: clampInt(raw.rating, 0, 1000, rating),
    actions,
  };
}

export function parseTown(value: unknown): TownSnapshot {
  const raw = record(value);
  const rating = clampInt(raw.rating, 0, 1000, 0);
  return {
    id: Math.max(0, int(raw.id, 0)),
    name: str(raw.name, 'Ville'),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    population: Math.max(0, int(raw.population, 0)),
    growthRate: int(raw.growthRate, 0),
    buildings: Math.max(0, int(raw.buildings, 0)),
    rating,
    ...(isRecord(raw.authority) ? { authority: parseTownAuthority(raw.authority, rating) } : {}),
  };
}

function stringList(value: unknown): string[] {
  const entries: string[] = [];
  for (const item of list(value)) {
    if (typeof item === 'string' && item.trim() !== '') entries.push(item);
  }
  return entries;
}

export function parseIndustry(value: unknown): IndustrySnapshot {
  const raw = record(value);
  const production = Math.max(0, int(raw.production, 0));
  const transported = Math.max(0, int(raw.transported, 0));
  return {
    id: Math.max(0, int(raw.id, 0)),
    name: str(raw.name, 'Industrie'),
    kind: str(raw.kind, 'unknown'),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    production,
    transported,
    stocks: cargoList(raw.stocks),
    ...(Array.isArray(raw.accepts) ? { accepts: stringList(raw.accepts) } : {}),
    ...(typeof raw.serviceRate === 'number'
      ? { serviceRate: Math.max(0, Math.min(100, num(raw.serviceRate, 0))) }
      : production > 0
        ? { serviceRate: Math.max(0, Math.min(100, (transported / production) * 100)) }
        : {}),
  };
}

export function parseStation(value: unknown): StationSnapshot {
  const raw = record(value);
  return {
    id: Math.max(0, int(raw.id, 0)),
    company: companyId(raw.company),
    name: str(raw.name, 'Gare'),
    kind: stationKind(raw.kind),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    width: Math.max(1, int(raw.width, 1)),
    height: Math.max(1, int(raw.height, 1)),
    waiting: cargoList(raw.waiting),
  };
}

/** Renvoie `null` pour un dépôt d'un type non exposé (maritime, hangar). */
export function parseDepot(value: unknown): DepotSnapshot | null {
  const raw = record(value);
  const kind = depotKind(raw.kind);
  if (!kind) return null;
  return {
    id: Math.max(0, int(raw.id, 0)),
    company: companyId(raw.company),
    kind,
    x: Math.max(0, int(raw.x, 0)),
    y: Math.max(0, int(raw.y, 0)),
    direction: clampInt(raw.direction, 0, 3, 0),
    width: Math.max(1, int(raw.width, 1)),
    height: Math.max(1, int(raw.height, 1)),
    ...(kind === 'rail'
      ? (() => {
          const railType = parseRailType(raw.railType);
          return railType ? { railType } : {};
        })()
      : {}),
  };
}

const BRIDGE_MATERIALS = [
  'wood',
  'concrete',
  'steel',
  'suspension',
  'cantilever',
  'tubular',
] as const;

function bridgeMaterial(value: unknown): (typeof BRIDGE_MATERIALS)[number] {
  return typeof value === 'string' && (BRIDGE_MATERIALS as readonly string[]).includes(value)
    ? (value as (typeof BRIDGE_MATERIALS)[number])
    : 'wood';
}

/** Pont ou tunnel exposé par le pont ; `null` si le type est inconnu. */
export function parseStructure(value: unknown): StructureSnapshot | null {
  const raw = record(value);
  const kind = str(raw.kind, '');
  const from = record(raw.from);
  const to = record(raw.to);
  const transport = raw.transport === 'road' ? 'road' : 'rail';
  const id = Math.max(0, int(raw.id, 0));
  const length = Math.max(1, int(raw.length, 1));
  if (kind === 'bridge') {
    return {
      id,
      kind: 'bridge',
      company: companyId(raw.company),
      transport,
      material: bridgeMaterial(raw.material),
      from: { x: int(from.x, 0), y: int(from.y, 0) },
      to: { x: int(to.x, 0), y: int(to.y, 0) },
      length,
      deckHeight: Math.max(0, int(raw.deckHeight, 0)),
    };
  }
  if (kind === 'tunnel') {
    return {
      id,
      kind: 'tunnel',
      company: companyId(raw.company),
      transport,
      from: { x: int(from.x, 0), y: int(from.y, 0) },
      to: { x: int(to.x, 0), y: int(to.y, 0) },
      length,
      portalHeight: Math.max(0, int(raw.portalHeight, 0)),
    };
  }
  return null;
}

/** Renvoie `null` pour un véhicule dont le type n'a pas de représentation 3D. */
export function parseVehicle(value: unknown): VehicleSnapshot | null {
  const raw = record(value);
  const kind = vehicleKind(raw.kind);
  if (!kind) return null;

  const cargoRaw = raw.cargo;
  const cargo = isRecord(cargoRaw)
    ? {
        type: str(cargoRaw.type, 'inconnu'),
        amount: Math.max(0, int(cargoRaw.amount, 0)),
        capacity: Math.max(0, int(cargoRaw.capacity, 0)),
      }
    : null;

  const orderTargets: number[] = [];
  for (const target of list(raw.orderTargets)) {
    if (typeof target === 'number' && Number.isFinite(target)) {
      orderTargets.push(Math.trunc(target));
    }
  }

  const orderKinds: OrderTargetKind[] = [];
  for (const kind of list(raw.orderKinds)) {
    if (kind !== 'station' && kind !== 'industry' && kind !== 'depot') break;
    orderKinds.push(kind);
  }

  const orderDetails = parseOrderDetails(raw.orderDetails);
  const currentOrder = Number.isFinite(raw.currentOrder)
    ? Math.max(0, int(raw.currentOrder, 0))
    : undefined;

  return {
    id: Math.max(0, int(raw.id, 0)),
    kind,
    company: companyId(raw.company),
    ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model } : {}),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    z: num(raw.z, 0),
    direction: clampInt(raw.direction, 0, 255, 0),
    speed: num(raw.speed, 0),
    status: clampInt(raw.status, 0, 4, 0),
    cargo,
    orderTargets,
    ...(orderKinds.length === orderTargets.length && orderKinds.length > 0 ? { orderKinds } : {}),
    ...(orderDetails.length > 0 ? { orderDetails } : {}),
    ...(currentOrder !== undefined ? { currentOrder } : {}),
    profitLastYear: num(raw.profitLastYear, 0),
    ageDays: Math.max(0, int(raw.ageDays, 0)),
  };
}

/* ------------------------------------------------------------------------- */
/*  Actualités et événements                                                 */
/* ------------------------------------------------------------------------- */

function parseNews(value: unknown, fallbackTick: number): WorldSnapshot['news'] {
  const items: WorldSnapshot['news'] = [];
  for (const entry of list(value)) {
    if (!isRecord(entry)) continue;
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (text === '') continue;
    items.push({
      tick: Math.max(0, int(entry.tick, fallbackTick)),
      kind: newsKind(entry.kind),
      text,
    });
  }
  return items;
}

/** Ne conserve que les événements connus et bien formés ; ignore le reste. */
function parseEvents(value: unknown): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (const entry of list(value)) {
    if (!isRecord(entry)) continue;
    const tick = Math.max(0, int(entry.tick, 0));
    switch (entry.type) {
      case 'vehicle_arrived':
      case 'vehicle_departed':
        events.push({
          type: entry.type,
          vehicle: Math.max(0, int(entry.vehicle, 0)),
          station: Math.max(0, int(entry.station, 0)),
          tick,
        });
        break;
      case 'company_bankrupt':
        events.push({ type: 'company_bankrupt', company: companyId(entry.company), tick });
        break;
      case 'town_growth':
        events.push({
          type: 'town_growth',
          town: Math.max(0, int(entry.town, 0)),
          population: Math.max(0, int(entry.population, 0)),
          tick,
        });
        break;
      case 'industry_production':
        events.push({
          type: 'industry_production',
          industry: Math.max(0, int(entry.industry, 0)),
          amount: int(entry.amount, 0),
          tick,
        });
        break;
      case 'loan_changed':
        events.push({
          type: 'loan_changed',
          company: companyId(entry.company),
          loan: Math.max(0, num(entry.loan, 0)),
          tick,
        });
        break;
      case 'subsidy_awarded':
        events.push({
          type: 'subsidy_awarded',
          subsidy: Math.max(0, int(entry.subsidy, 0)),
          company: companyId(entry.company),
          tick,
        });
        break;
      case 'subsidy_expired':
        events.push({
          type: 'subsidy_expired',
          subsidy: Math.max(0, int(entry.subsidy, 0)),
          tick,
        });
        break;
      case 'disaster_started':
        events.push({
          type: 'disaster_started',
          disaster: Math.max(0, int(entry.disaster, 0)),
          kind: disasterKind(entry.kind),
          tick,
        });
        break;
      case 'disaster_ended':
        events.push({
          type: 'disaster_ended',
          disaster: Math.max(0, int(entry.disaster, 0)),
          tick,
        });
        break;
      case 'town_action':
        events.push({
          type: 'town_action',
          town: Math.max(0, int(entry.town, 0)),
          action: TOWN_ACTIONS.includes(entry.action as TownActionKind)
            ? (entry.action as TownActionKind)
            : 'advertise',
          tick,
        });
        break;
      default:
        break;
    }
  }
  return events;
}

/* ------------------------------------------------------------------------- */
/*  Snapshot complet                                                         */
/* ------------------------------------------------------------------------- */

const DISASTER_KINDS: readonly DisasterKind[] = [
  'fire',
  'road_accident',
  'train_crash',
  'aircraft_crash',
];

function disasterKind(value: unknown): DisasterKind {
  return DISASTER_KINDS.includes(value as DisasterKind) ? (value as DisasterKind) : 'fire';
}

function parseDisasters(value: unknown): DisasterSnapshot[] {
  const disasters: DisasterSnapshot[] = [];
  for (const entry of list(value)) {
    if (!isRecord(entry)) continue;
    const kind = disasterKind(entry.kind);
    disasters.push({
      id: Math.max(0, int(entry.id, disasters.length)),
      kind,
      x: num(entry.x, 0),
      y: num(entry.y, 0),
      company: companyId(entry.company),
      ...(typeof entry.vehicle === 'number' ? { vehicle: Math.max(0, int(entry.vehicle, 0)) } : {}),
      ...(typeof entry.town === 'number' ? { town: Math.max(0, int(entry.town, 0)) } : {}),
      ...(typeof entry.industry === 'number'
        ? { industry: Math.max(0, int(entry.industry, 0)) }
        : {}),
      severity: clampInt(entry.severity, 1, 3, 1),
      startedTick: Math.max(0, int(entry.startedTick, 0)),
      remainingDays: Math.max(0, int(entry.remainingDays, 0)),
    });
  }
  return disasters;
}

function parseMeta(value: unknown): SnapshotMeta {
  const raw = record(value);
  const protocol = int(raw.protocol, PROTOCOL_VERSION);
  if (protocol !== PROTOCOL_VERSION) {
    fail(
      'protocol',
      `Protocole moteur incompatible : ${protocol} (frontend ${PROTOCOL_VERSION}). ` +
        'Reconstruisez le moteur WASM depuis la même révision que le frontend.',
    );
  }
  return {
    protocol,
    tick: Math.max(0, int(raw.tick, 0)),
    hash: str(raw.hash, DEFAULT_HASH),
    sequence: Math.max(0, int(raw.sequence, 0)),
  };
}

function parseEconomy(value: unknown): EconomySnapshot {
  if (!isRecord(value)) return { ...DEFAULT_ECONOMY };
  const raw = value;
  const economy: EconomySnapshot = {
    year: int(raw.year, DEFAULT_ECONOMY.year),
    month: clampInt(raw.month, 0, 11, DEFAULT_ECONOMY.month),
    day: clampInt(raw.day, 1, 31, DEFAULT_ECONOMY.day),
    dayFraction: Math.max(0, num(raw.dayFraction, DEFAULT_ECONOMY.dayFraction)),
    speed: num(raw.speed, DEFAULT_ECONOMY.speed),
    paused: bool(raw.paused, DEFAULT_ECONOMY.paused),
  };
  /* Les champs #165 restent absents des snapshots antérieurs : ne pas les
   * inventer ici, l'UI applique ses propres replis. */
  if (typeof raw.inflation === 'number' && Number.isFinite(raw.inflation)) {
    economy.inflation = Math.max(0, raw.inflation);
  }
  if (typeof raw.difficulty === 'number' && Number.isFinite(raw.difficulty)) {
    economy.difficulty = clampInt(raw.difficulty, 0, 3, 1);
  }
  if (typeof raw.interestRate === 'number' && Number.isFinite(raw.interestRate)) {
    economy.interestRate = Math.max(0, raw.interestRate);
  }
  if (typeof raw.maxLoan === 'number' && Number.isFinite(raw.maxLoan)) {
    economy.maxLoan = Math.max(0, raw.maxLoan);
  }
  if (typeof raw.loanInterval === 'number' && Number.isFinite(raw.loanInterval)) {
    economy.loanInterval = Math.max(1, raw.loanInterval);
  }
  return economy;
}

/* ------------------------------------------------------------------------- */
/*  Subventions                                                              */
/* ------------------------------------------------------------------------- */

function sourceKind(value: unknown): 'town' | 'industry' {
  return value === 'town' ? 'town' : 'industry';
}

function parseSubsidy(value: unknown): SubsidySnapshot | null {
  const raw = record(value);
  if (!isRecord(value)) return null;
  const awarded = int(raw.awardedTo, -1);
  return {
    id: Math.max(0, int(raw.id, 0)),
    cargo: str(raw.cargo, 'inconnu'),
    from: str(raw.from, '—'),
    to: str(raw.to, '—'),
    fromKind: sourceKind(raw.fromKind),
    toKind: sourceKind(raw.toKind),
    remainingMonths: Math.max(0, int(raw.remainingMonths, 0)),
    awardedTo: awarded >= 0 && awarded <= 254 ? awarded : null,
  };
}

function parseSubsidies(value: unknown): SubsidySnapshot[] {
  const subsidies: SubsidySnapshot[] = [];
  for (const entry of list(value)) {
    const subsidy = parseSubsidy(entry);
    if (subsidy) subsidies.push(subsidy);
  }
  return subsidies;
}

/**
 * Convertit le JSON du pont en `WorldSnapshot` sans carte (`map: null`).
 * `input` peut être la chaîne brute ou l'objet déjà parsé.
 */
export function parseWorldJson(input: unknown): WorldSnapshot {
  let root: unknown = input;
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input) as unknown;
    } catch (cause) {
      fail(
        'not-json',
        `Snapshot moteur illisible (JSON invalide) : ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
  if (!isRecord(root)) {
    fail('shape', 'Snapshot moteur illisible : objet JSON attendu.');
  }

  const meta = parseMeta(root.meta);
  const depots: DepotSnapshot[] = [];
  for (const entry of list(root.depots)) {
    const depot = parseDepot(entry);
    if (depot) depots.push(depot);
  }
  const vehicles: VehicleSnapshot[] = [];
  for (const entry of list(root.vehicles)) {
    const vehicle = parseVehicle(entry);
    if (vehicle) vehicles.push(vehicle);
  }
  const structures: StructureSnapshot[] = [];
  for (const entry of list(root.structures)) {
    const structure = parseStructure(entry);
    if (structure) structures.push(structure);
  }

  return {
    meta,
    economy: parseEconomy(root.economy),
    map: null,
    companies: list(root.companies).map(parseCompany),
    towns: list(root.towns).map(parseTown),
    industries: list(root.industries).map(parseIndustry),
    stations: list(root.stations).map(parseStation),
    depots,
    structures,
    vehicles,
    subsidies: parseSubsidies(root.subsidies),
    news: parseNews(root.news, meta.tick),
    disasters: parseDisasters(root.disasters),
    events: parseEvents(root.events),
  };
}
