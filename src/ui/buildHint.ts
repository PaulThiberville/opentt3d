/**
 * Texte du bandeau d'aide du mode construction.
 *
 * Pur : plan + outil → libellé, coût et motif d'invalidité. Les montants sont
 * ceux de l'aperçu ; la dépense réelle est décidée par le moteur.
 */

import { stationFootprint, type BuildPlan, type BuildTool } from '../game/buildRules';
import { formatInt, formatMoney } from './format';

export interface BuildHintView {
  tone: 'idle' | 'valid' | 'invalid';
  text: string;
}

const TOOL_LABELS: Record<BuildTool, string> = {
  road: 'Routes',
  rail: 'Rails',
  clear: 'Démolition',
  station: 'Gares',
  depot: 'Dépôts',
  signal: 'Signaux',
};

const TOOL_HINTS: Record<BuildTool, string> = {
  road: 'cliquez ou glissez d’une tuile à l’autre',
  rail: 'cliquez ou glissez d’une tuile à l’autre',
  clear: 'cliquez ou glissez pour démolir un tronçon',
  station: 'choisissez taille et orientation, puis cliquez pour poser',
  depot: 'cliquez à côté d’une voie',
  signal: 'cliquez ou glissez le long d’une voie ferrée',
};

function stationLabel(plan: BuildPlan): string {
  const settings = plan.station;
  if (!settings) return 'Gare';
  if (settings.kind === 'road') {
    return settings.driveThrough ? 'Gare routière en passage' : 'Gare routière';
  }
  const footprint = stationFootprint(settings);
  return `Gare ferroviaire ${footprint.width}×${footprint.height}`;
}

function countLabel(plan: BuildPlan): string {
  if (plan.tool === 'station' && plan.station?.kind === 'rail') {
    return `${formatInt(plan.tiles.length)} tuiles`;
  }
  if (plan.tool === 'station' && plan.station?.kind === 'road') return '1 tuile';
  if (plan.tool === 'depot') return '1 tuile';
  if (plan.tool === 'signal') {
    const count = plan.tiles.length;
    return count > 1 ? `${formatInt(count)} signaux` : '1 signal';
  }
  const count = plan.tiles.length;
  return `${formatInt(count)} tuile${count > 1 ? 's' : ''}`;
}

export function describeBuildPlan(
  plan: BuildPlan | null,
  tool: BuildTool | null,
): BuildHintView | null {
  if (!tool) return null;
  const label = TOOL_LABELS[tool];
  if (!plan || plan.tiles.length === 0) {
    const rotate = tool === 'station' || tool === 'depot' ? ' · R pivote' : '';
    return {
      tone: 'idle',
      text: `${label} : ${TOOL_HINTS[tool]}${rotate} · clic droit annule · Échap quitte`,
    };
  }
  if (!plan.valid) {
    return {
      tone: 'invalid',
      text: `${label} : impossible — ${plan.reason ?? 'tracé invalide'}`,
    };
  }
  const detail = plan.tool === 'station' ? `${stationLabel(plan)} · ` : '';
  return {
    tone: 'valid',
    text: `${label} : ${detail}${countLabel(plan)} · ${formatMoney(plan.cost)}`,
  };
}
