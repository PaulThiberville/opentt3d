/**
 * Vue du panneau Statistiques.
 *
 * Aucune statistique n'est simulée : production et transport viennent des
 * industries du snapshot, la population des villes, et les parts de marché
 * sont dérivées de la valeur d'entreprise exposée. Les valeurs absentes
 * retombent sur « — » et les listes vides affichent leur état vide.
 */

import type { WorldSnapshot } from '../engine/protocol';
import { ordersFromSnapshot } from '../game/vehicleRules';
import { formatInt, formatPercent, formatRating } from './format';
import { industryKindLabel } from './labels';
import { t } from './i18n';
import { companyShares } from './financeView';
import { percentOf } from './charts';
import type {
  FinanceAlertView,
  IndustryStatsRow,
  MarketShareRow,
  StatsPanelView,
  TownStatsRow,
} from './types';

/** Rayon d'association d'une gare à une ville (tuiles), comme les panneaux lieu. */
const TOWN_RADIUS = 24;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function servedStations(snapshot: WorldSnapshot): Set<number> {
  const served = new Set<number>();
  for (const vehicle of snapshot.vehicles) {
    for (const order of ordersFromSnapshot(vehicle, snapshot)) {
      if (order.kind === 'station') served.add(order.target);
    }
  }
  return served;
}

function industryRows(snapshot: WorldSnapshot): IndustryStatsRow[] {
  const max = Math.max(
    0,
    ...snapshot.industries.map((industry) => finite(industry.production) ?? 0),
  );
  return [...snapshot.industries]
    .map((industry) => {
      const production = finite(industry.production) ?? 0;
      const transported = finite(industry.transported) ?? 0;
      const rate = production > 0 ? (transported / production) * 100 : null;
      const kindLabel = industryKindLabel(industry.kind);
      return {
        id: industry.id,
        name: industry.name,
        kindLabel,
        production,
        transported,
        detail: t('stats.industry.detail', {
          kind: kindLabel,
          production: formatInt(production),
          transported: formatInt(transported),
        }),
        rate,
        rateLabel: rate === null ? t('stats.rate.unavailable') : formatPercent(rate, 0),
        percent: percentOf(production, max),
        transportedPercent: percentOf(transported, max),
      };
    })
    .sort((a, b) => b.production - a.production || a.id - b.id);
}

function townRows(snapshot: WorldSnapshot): TownStatsRow[] {
  const served = servedStations(snapshot);
  const max = Math.max(0, ...snapshot.towns.map((town) => finite(town.population) ?? 0));
  return [...snapshot.towns]
    .map((town) => {
      const population = finite(town.population) ?? 0;
      const stations = snapshot.stations.filter(
        (station) => Math.hypot(station.x - town.x, station.y - town.y) <= TOWN_RADIUS,
      );
      const servedCount = stations.filter((station) => served.has(station.id)).length;
      return {
        id: town.id,
        name: town.name,
        population,
        detail: t('stats.town.detail', {
          population: formatInt(population),
          rating: formatRating(town.rating),
          stations: formatInt(stations.length),
        }),
        stations: stations.length,
        served: servedCount,
        percent: percentOf(population, max),
      };
    })
    .sort((a, b) => b.population - a.population || a.id - b.id);
}

function marketRows(snapshot: WorldSnapshot): MarketShareRow[] {
  return companyShares(snapshot).map((entry) => ({
    id: entry.company.id,
    name: entry.company.name || t('finance.companyUnknown'),
    colour: entry.company.colour,
    value: entry.value,
    valueLabel: entry.value === 0 ? '—' : formatInt(entry.value),
    share: entry.share,
    shareLabel: entry.share === null ? '—' : formatPercent(entry.share, 1),
    isLocal: entry.company.isLocal,
  }));
}

/** Construit la vue complète du panneau Statistiques. */
export function describeStatsPanel(snapshot: WorldSnapshot | null): StatsPanelView {
  const industries = snapshot ? industryRows(snapshot) : [];
  const towns = snapshot ? townRows(snapshot) : [];
  const market = snapshot ? marketRows(snapshot) : [];
  const totalProduction = industries.reduce((sum, row) => sum + row.production, 0);
  const totalTransported = industries.reduce((sum, row) => sum + row.transported, 0);
  const totalPopulation = towns.reduce((sum, row) => sum + row.population, 0);
  const alerts: FinanceAlertView[] = [];
  if (!snapshot) {
    alerts.push({
      id: 'no-snapshot',
      tone: 'info',
      title: t('stats.alert.noSnapshot.title'),
      detail: t('stats.alert.noSnapshot.detail'),
    });
  } else if (market.every((row) => row.share === null)) {
    alerts.push({
      id: 'no-market',
      tone: 'warning',
      title: t('stats.alert.noMarket.title'),
      detail: t('stats.alert.noMarket.detail'),
    });
  }
  return {
    industryCount: industries.length,
    totalProduction,
    totalTransported,
    totalProductionLabel: formatInt(totalProduction),
    totalTransportedLabel: formatInt(totalTransported),
    townCount: towns.length,
    totalPopulation,
    totalPopulationLabel: formatInt(totalPopulation),
    industries,
    towns,
    market,
    marketBasis: t('stats.market.basis'),
    alerts,
    hint: t('stats.hint'),
  };
}
