/**
 * Vue du panneau Statistiques.
 *
 * Aucune statistique n'est simulée : production et transport viennent des
 * industries du snapshot, la population des villes, et les parts de marché
 * sont dérivées de la valeur d'entreprise exposée. Les valeurs absentes
 * retombent sur « — » et les listes vides affichent leur état vide.
 */

import type { WorldSnapshot } from '../engine/protocol';
import { COMPANY_NONE } from '../engine/protocol';
import { ordersFromSnapshot } from '../game/vehicleRules';
import { formatInt, formatPercent, formatRating } from './format';
import { industryKindLabel } from './labels';
import { t, type TranslationKey } from './i18n';
import { companyShares } from './financeView';
import { percentOf } from './charts';
import type {
  DisasterStatsRow,
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
    isAI: entry.company.isAI,
    aiLevel: entry.company.isAI ? (entry.company.aiLevel ?? null) : null,
  }));
}

function disasterRows(snapshot: WorldSnapshot): DisasterStatsRow[] {
  return (snapshot.disasters ?? []).map((disaster) => {
    const kindLabel = t(`disaster.kind.${disaster.kind}` as TranslationKey);
    const remainingLabel =
      disaster.remainingDays > 1
        ? t('stats.disaster.remaining', { days: formatInt(disaster.remainingDays) })
        : t('stats.disaster.remainingOne');
    let location = `(${Math.round(disaster.x)}, ${Math.round(disaster.y)})`;
    if (disaster.town !== undefined) {
      const town = snapshot.towns.find((item) => item.id === disaster.town);
      if (town) location = t('stats.disaster.town', { name: town.name });
    } else if (disaster.industry !== undefined) {
      const industry = snapshot.industries.find((item) => item.id === disaster.industry);
      if (industry) location = t('stats.disaster.industry', { name: industry.name });
    } else if (disaster.vehicle !== undefined) {
      location = t('stats.disaster.vehicle', { id: formatInt(disaster.vehicle) });
    }
    const company =
      disaster.company !== COMPANY_NONE
        ? snapshot.companies.find((item) => item.id === disaster.company)
        : undefined;
    return {
      id: disaster.id,
      kindLabel,
      detail: t('stats.disaster.detail', {
        severity: disaster.severity,
        remaining: remainingLabel,
      }),
      location,
      companyLabel: company ? t('stats.disaster.company', { name: company.name }) : null,
      severity: disaster.severity,
      remainingDays: disaster.remainingDays,
      remainingLabel,
    };
  });
}

/** Construit la vue complète du panneau Statistiques. */
export function describeStatsPanel(snapshot: WorldSnapshot | null): StatsPanelView {
  const industries = snapshot ? industryRows(snapshot) : [];
  const towns = snapshot ? townRows(snapshot) : [];
  const market = snapshot ? marketRows(snapshot) : [];
  const disasters = snapshot ? disasterRows(snapshot) : [];
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
    disasters,
    activeDisasterCount: disasters.length,
    activeDisasterCountLabel: formatInt(disasters.length),
    disastersEnabled: null,
    alerts,
    hint: t('stats.hint'),
  };
}
