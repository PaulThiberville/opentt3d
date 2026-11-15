/**
 * Résumé lisible d'une sélection pour le panneau du HUD.
 *
 * Pur : `snapshot` + `selection` → textes et statistiques. Aucune valeur n'est
 * recalculée à partir de la simulation, tout vient du dernier snapshot.
 */

import { COMPANY_NONE, type MapSnapshot, type WorldSnapshot } from '../engine/protocol';
import { TILE_KINDS, tileIndex } from '../game/mapGrid';
import { depotAtTile, depotKindLabel } from '../game/vehicleRules';
import type { Selection } from '../game/Game';
import type { WorldTarget } from '../render/WorldView';
import { companyColour } from '../render/tileVisuals';
import {
  cargoLabel,
  industryKindLabel,
  stationLabel,
  tileKindLabel,
  vehicleLabel,
  vehicleStatusLabel,
} from './labels';
import { formatDecimal, formatInt, formatRating, formatSignedMoney } from './format';
import { t } from './i18n';
import type { SelectionStat, SelectionSummary } from './types';

function cargoText(cargo: { type: string; amount: number; capacity: number } | null): string {
  if (!cargo) return t('selection.vacant');
  return `${cargoLabel(cargo.type)} · ${formatInt(cargo.amount)} / ${formatInt(cargo.capacity)}`;
}

function waitingTotal(station: { waiting: { amount: number }[] }): number {
  return station.waiting.reduce((total, entry) => total + entry.amount, 0);
}

function waitingBreakdown(station: { waiting: { cargo: string; amount: number }[] }): string {
  if (station.waiting.length === 0) return t('selection.noWaiting');
  return station.waiting
    .map((entry) => `${cargoLabel(entry.cargo)} ${formatInt(entry.amount)}`)
    .join(' · ');
}

export function describeSelection(
  snapshot: WorldSnapshot | null,
  selection: Selection | null,
  target: WorldTarget | null,
  map: MapSnapshot | null,
): SelectionSummary | null {
  if (!snapshot || !selection) return null;

  switch (selection.kind) {
    case 'vehicle': {
      const vehicle = snapshot.vehicles.find((item) => item.id === selection.id);
      if (!vehicle) return null;
      const company = snapshot.companies.find((item) => item.id === vehicle.company);
      const status = vehicleStatusLabel(vehicle.status);
      const stats: SelectionStat[] = [
        { label: t('selection.stat.type'), value: vehicleLabel(vehicle.kind) },
        {
          label: t('selection.stat.speed'),
          value: t('format.tilesPerDay', { value: formatInt(vehicle.speed) }),
        },
        { label: t('selection.stat.cargo'), value: cargoText(vehicle.cargo) },
        { label: t('selection.stat.status'), value: status },
        {
          label: t('selection.stat.profit'),
          value: formatSignedMoney(vehicle.profitLastYear),
          tone: vehicle.profitLastYear >= 0 ? 'good' : 'bad',
        },
        {
          label: t('selection.stat.age'),
          value: t('selection.unit.days', { value: formatInt(vehicle.ageDays) }),
          tone: 'muted',
        },
      ];
      return {
        selection,
        title: t('selection.vehicleTitle', { id: vehicle.id, kind: vehicleLabel(vehicle.kind) }),
        detail: `${company?.name ?? t('selection.unknownCompany')} · ${status}`,
        stats,
        colour: companyColour(company?.colour ?? 8),
      };
    }
    case 'town': {
      const town = snapshot.towns.find((item) => item.id === selection.id);
      if (!town) return null;
      return {
        selection,
        title: town.name,
        detail: t('selection.townDetail', {
          population: formatInt(town.population),
          buildings: formatInt(town.buildings),
        }),
        stats: [
          { label: t('selection.stat.population'), value: formatInt(town.population) },
          { label: t('selection.stat.buildings'), value: formatInt(town.buildings) },
          {
            label: t('selection.stat.growth'),
            value: t('selection.unit.perDay', { value: formatInt(town.growthRate) }),
            tone: 'good',
          },
          { label: t('selection.stat.rating'), value: formatRating(town.rating) },
        ],
        colour: null,
      };
    }
    case 'industry': {
      const industry = snapshot.industries.find((item) => item.id === selection.id);
      if (!industry) return null;
      const stocks =
        industry.stocks.length > 0
          ? industry.stocks
              .map((entry) => `${cargoLabel(entry.cargo)} ${formatInt(entry.amount)}`)
              .join(' · ')
          : t('selection.noStock');
      return {
        selection,
        title: industry.name,
        detail: t('selection.industryDetail', {
          kind: industryKindLabel(industry.kind),
          value: formatInt(industry.production),
        }),
        stats: [
          { label: t('selection.stat.type'), value: industryKindLabel(industry.kind) },
          { label: t('selection.stat.production'), value: formatInt(industry.production) },
          {
            label: t('selection.stat.transported'),
            value: formatInt(industry.transported),
            tone: 'good',
          },
          { label: t('selection.stat.stocks'), value: stocks, tone: 'muted' },
        ],
        colour: null,
      };
    }
    case 'station': {
      const station = snapshot.stations.find((item) => item.id === selection.id);
      if (!station) return null;
      const total = waitingTotal(station);
      const company = snapshot.companies.find((item) => item.id === station.company);
      return {
        selection,
        title: station.name,
        detail: t('selection.stationDetail', {
          kind: stationLabel(station.kind),
          count: formatInt(total),
        }),
        stats: [
          { label: t('selection.stat.type'), value: stationLabel(station.kind) },
          {
            label: t('selection.stat.waiting'),
            value: t('selection.unit.units', { count: formatInt(total) }),
            tone: total > 0 ? 'good' : 'muted',
          },
          { label: t('selection.stat.cargoes'), value: waitingBreakdown(station) },
          { label: t('selection.stat.company'), value: company?.name ?? '—', tone: 'muted' },
        ],
        colour: company ? companyColour(company.colour) : null,
      };
    }
    case 'tile': {
      const x = target && target.kind === 'tile' ? target.x : null;
      const y = target && target.kind === 'tile' ? target.y : null;
      if (x === null || y === null) {
        return {
          selection,
          title: t('selection.tile'),
          detail: t('selection.tileSelected'),
          stats: [],
          colour: null,
        };
      }
      if (
        !map ||
        x < 0 ||
        y < 0 ||
        x >= map.width ||
        y >= map.height ||
        tileIndex(x, y, map.width) >= map.kind.length
      ) {
        return {
          selection,
          title: t('selection.tileCoords', { x, y }),
          detail: t('selection.mapNotLoaded'),
          stats: [
            { label: t('selection.stat.coords'), value: t('selection.tileCoords', { x, y }) },
          ],
          colour: null,
        };
      }
      const index = tileIndex(x, y, map.width);
      const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
      const height = ((map.heightMap[index] ?? 0) * 0.5).toFixed(1);
      const ownerId = map.owner[index] ?? COMPANY_NONE;
      const owner =
        ownerId === COMPANY_NONE
          ? t('selection.ownerNone')
          : (snapshot.companies.find((company) => company.id === ownerId)?.name ?? `#${ownerId}`);
      const depot = depotAtTile(snapshot, x, y);
      const typeLabel = depot ? depotKindLabel(depot.kind) : tileKindLabel(kind);
      return {
        selection,
        title: depot ? `${typeLabel} (${x}, ${y})` : t('selection.tileCoords', { x, y }),
        detail: t('selection.tileDetail', {
          type: typeLabel,
          height: formatDecimal(Number(height)),
        }),
        stats: [
          { label: t('selection.stat.type'), value: typeLabel },
          { label: t('selection.stat.height'), value: formatDecimal(Number(height)) },
          {
            label: t('selection.stat.owner'),
            value: owner,
            tone: ownerId === COMPANY_NONE ? 'muted' : undefined,
          },
          {
            label: t('selection.stat.coords'),
            value: `${formatInt(x)} · ${formatInt(y)}`,
            tone: 'muted',
          },
        ],
        colour: null,
      };
    }
    default:
      return null;
  }
}
