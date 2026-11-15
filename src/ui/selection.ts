/**
 * Résumé lisible d'une sélection pour le panneau du HUD.
 *
 * Pur : `snapshot` + `selection` → textes et statistiques. Aucune valeur n'est
 * recalculée à partir de la simulation, tout vient du dernier snapshot.
 */

import { COMPANY_NONE, type MapSnapshot, type WorldSnapshot } from '../engine/protocol';
import { TILE_KINDS, tileIndex } from '../game/mapGrid';
import { depotKindAt, depotKindLabel } from '../game/vehicleRules';
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
import type { SelectionStat, SelectionSummary } from './types';

function cargoText(cargo: { type: string; amount: number; capacity: number } | null): string {
  if (!cargo) return 'Vide';
  return `${cargoLabel(cargo.type)} · ${formatInt(cargo.amount)} / ${formatInt(cargo.capacity)}`;
}

function waitingTotal(station: { waiting: { amount: number }[] }): number {
  return station.waiting.reduce((total, entry) => total + entry.amount, 0);
}

function waitingBreakdown(station: { waiting: { cargo: string; amount: number }[] }): string {
  if (station.waiting.length === 0) return 'Aucune';
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
        { label: 'Type', value: vehicleLabel(vehicle.kind) },
        { label: 'Vitesse', value: `${formatInt(vehicle.speed)} tuiles/j` },
        { label: 'Cargaison', value: cargoText(vehicle.cargo) },
        { label: 'Statut', value: status },
        {
          label: 'Bénéfice',
          value: formatSignedMoney(vehicle.profitLastYear),
          tone: vehicle.profitLastYear >= 0 ? 'good' : 'bad',
        },
        { label: 'Âge', value: `${formatInt(vehicle.ageDays)} j`, tone: 'muted' },
      ];
      return {
        selection,
        title: `Véhicule #${vehicle.id} — ${vehicleLabel(vehicle.kind)}`,
        detail: `${company?.name ?? 'Entreprise inconnue'} · ${status}`,
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
        detail: `${formatInt(town.population)} habitants · ${formatInt(town.buildings)} bâtiments`,
        stats: [
          { label: 'Population', value: formatInt(town.population) },
          { label: 'Bâtiments', value: formatInt(town.buildings) },
          { label: 'Croissance', value: `+${formatInt(town.growthRate)}/jour`, tone: 'good' },
          { label: 'Note', value: formatRating(town.rating) },
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
          : 'Aucun';
      return {
        selection,
        title: industry.name,
        detail: `${industryKindLabel(industry.kind)} · production ${formatInt(industry.production)}`,
        stats: [
          { label: 'Type', value: industryKindLabel(industry.kind) },
          { label: 'Production', value: formatInt(industry.production) },
          { label: 'Transporté', value: formatInt(industry.transported), tone: 'good' },
          { label: 'Stocks', value: stocks, tone: 'muted' },
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
        detail: `${stationLabel(station.kind)} · ${formatInt(total)} unités en attente`,
        stats: [
          { label: 'Type', value: stationLabel(station.kind) },
          {
            label: 'Attente',
            value: `${formatInt(total)} unités`,
            tone: total > 0 ? 'good' : 'muted',
          },
          { label: 'Cargaisons', value: waitingBreakdown(station) },
          { label: 'Entreprise', value: company?.name ?? '—', tone: 'muted' },
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
          title: 'Tuile',
          detail: 'Sélectionnée sur la carte',
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
          title: `Tuile (${x}, ${y})`,
          detail: 'Carte non chargée',
          stats: [
            { label: 'X', value: formatInt(x) },
            { label: 'Y', value: formatInt(y) },
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
          ? 'Aucune'
          : (snapshot.companies.find((company) => company.id === ownerId)?.name ?? `#${ownerId}`);
      const depot = depotKindAt(map, x, y);
      const typeLabel = depot ? depotKindLabel(depot) : tileKindLabel(kind);
      return {
        selection,
        title: depot ? `${typeLabel} (${x}, ${y})` : `Tuile (${x}, ${y})`,
        detail: `${typeLabel} · hauteur ${formatDecimal(Number(height))}`,
        stats: [
          { label: 'Type', value: typeLabel },
          { label: 'Hauteur', value: formatDecimal(Number(height)) },
          {
            label: 'Propriétaire',
            value: owner,
            tone: ownerId === COMPANY_NONE ? 'muted' : undefined,
          },
          { label: 'Coordonnées', value: `${formatInt(x)} · ${formatInt(y)}`, tone: 'muted' },
        ],
        colour: null,
      };
    }
    default:
      return null;
  }
}
