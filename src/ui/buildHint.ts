/**
 * Texte du bandeau d'aide du mode construction.
 *
 * Pur : plan + outil → libellé, coût et motif d'invalidité. Les montants sont
 * ceux de l'aperçu ; la dépense réelle est décidée par le moteur.
 */

import { stationFootprint, type BuildPlan, type BuildTool } from '../game/buildRules';
import { formatInt, formatMoney } from './format';
import { t, type TranslationKey } from './i18n';

export interface BuildHintView {
  tone: 'idle' | 'valid' | 'invalid';
  text: string;
}

const TOOL_LABEL_KEYS: Record<BuildTool, TranslationKey> = {
  road: 'toolbar.road.label',
  rail: 'toolbar.rail.label',
  clear: 'build.tool.clear',
  station: 'toolbar.station.label',
  depot: 'toolbar.depot.label',
  signal: 'toolbar.signal.label',
  unsignal: 'toolbar.unsignal.label',
  convert: 'toolbar.convert.label',
  terraform: 'toolbar.terraform.label',
  tree: 'toolbar.tree.label',
  canal: 'toolbar.canal.label',
  lock: 'toolbar.lock.label',
  aqueduct: 'toolbar.aqueduct.label',
  crossing: 'toolbar.crossing.label',
  bridge: 'toolbar.bridge.label',
  tunnel: 'toolbar.tunnel.label',
};

const TOOL_HINT_KEYS: Record<BuildTool, TranslationKey> = {
  road: 'build.hint.road',
  rail: 'build.hint.rail',
  clear: 'build.hint.clear',
  station: 'build.hint.station',
  depot: 'build.hint.depot',
  signal: 'build.hint.signal',
  unsignal: 'build.hint.unsignal',
  convert: 'build.hint.convert',
  terraform: 'build.hint.terraform',
  tree: 'build.hint.tree',
  canal: 'build.hint.canal',
  lock: 'build.hint.lock',
  aqueduct: 'build.hint.aqueduct',
  crossing: 'build.hint.crossing',
  bridge: 'build.hint.bridge',
  tunnel: 'build.hint.tunnel',
};

function countLabel(plan: BuildPlan): string {
  const count = plan.tiles.length;
  const formatted = formatInt(count);
  if (plan.tool === 'signal' || plan.tool === 'unsignal') {
    return t(count > 1 ? 'build.count.signal.other' : 'build.count.signal.one', {
      count: formatted,
    });
  }
  if (plan.tool === 'bridge') {
    return t('build.count.bridge', {
      count: formatted,
      span: formatInt(plan.bridge?.span ?? Math.max(0, count - 1)),
    });
  }
  if (plan.tool === 'tunnel') {
    return t('build.count.tunnel', { count: formatted });
  }
  if (plan.tool === 'station' && plan.station?.kind === 'road') {
    return t('build.count.tile.one', { count: '1' });
  }
  if (plan.tool === 'depot') return t('build.count.tile.one', { count: '1' });
  return t(count > 1 ? 'build.count.tile.other' : 'build.count.tile.one', {
    count: formatted,
  });
}

function stationLabel(plan: BuildPlan): string {
  const settings = plan.station;
  if (!settings) return t('build.station.generic');
  if (settings.kind === 'road') {
    return t(settings.driveThrough ? 'build.station.roadThrough' : 'build.station.road');
  }
  const footprint = stationFootprint(settings);
  return t('build.station.rail', { width: footprint.width, height: footprint.height });
}

export function describeBuildPlan(
  plan: BuildPlan | null,
  tool: BuildTool | null,
): BuildHintView | null {
  if (!tool) return null;
  const label = t(TOOL_LABEL_KEYS[tool]);
  if (!plan || plan.tiles.length === 0) {
    const rotate = tool === 'station' || tool === 'depot' ? t('build.idle.rotate') : '';
    return {
      tone: 'idle',
      text: t('build.idle', { label, hint: t(TOOL_HINT_KEYS[tool]), rotate }),
    };
  }
  if (!plan.valid) {
    return {
      tone: 'invalid',
      text: t('build.invalid', {
        label,
        reason: plan.reason ?? t('build.invalid.reason'),
      }),
    };
  }
  const detail =
    plan.tool === 'station'
      ? t('build.station.detail', { station: stationLabel(plan) })
      : plan.tool === 'bridge'
        ? t('build.bridge.detail', {
            material: t(`build.material.${plan.bridge?.material ?? 'wood'}` as TranslationKey),
            kind: t(plan.bridge?.kind === 'road' ? 'build.road' : 'build.rail'),
            maintenance: formatMoney(plan.bridge?.maintenance ?? 0),
          })
        : plan.tool === 'tunnel'
          ? t('build.tunnel.detail', {
              kind: t(plan.tunnel?.kind === 'road' ? 'build.road' : 'build.rail'),
              depth: formatInt(plan.tunnel?.depth ?? 0),
              maintenance: formatMoney(plan.tunnel?.maintenance ?? 0),
            })
          : '';
  return {
    tone: 'valid',
    text: t('build.valid', {
      label,
      detail,
      count: countLabel(plan),
      cost: formatMoney(plan.cost),
    }),
  };
}
