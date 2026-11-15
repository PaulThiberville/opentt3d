/**
 * Texte du bandeau d'aide du mode construction.
 *
 * Pur : plan + outil → libellé, coût et motif d'invalidité. Les montants sont
 * ceux de l'aperçu ; la dépense réelle est décidée par le moteur.
 */

import type { BuildPlan, BuildTool } from '../game/buildRules';
import { formatInt, formatMoney } from './format';

export interface BuildHintView {
  tone: 'idle' | 'valid' | 'invalid';
  text: string;
}

const TOOL_LABELS: Record<BuildTool, string> = {
  road: 'Routes',
  rail: 'Rails',
  clear: 'Démolition',
};

export function describeBuildPlan(
  plan: BuildPlan | null,
  tool: BuildTool | null,
): BuildHintView | null {
  if (!tool) return null;
  const label = TOOL_LABELS[tool];
  if (!plan || plan.tiles.length === 0) {
    return {
      tone: 'idle',
      text: `${label} : cliquez ou glissez d’une tuile à l’autre · clic droit annule · Échap quitte`,
    };
  }
  if (!plan.valid) {
    return {
      tone: 'invalid',
      text: `${label} : impossible — ${plan.reason ?? 'tracé invalide'}`,
    };
  }
  const count = plan.tiles.length;
  return {
    tone: 'valid',
    text: `${label} : ${formatInt(count)} tuile${count > 1 ? 's' : ''} · ${formatMoney(plan.cost)}`,
  };
}
