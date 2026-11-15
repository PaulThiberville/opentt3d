/**
 * Barre d'outils de construction.
 *
 * Routes, rails, gares, dépôts et signaux sont actifs (#27, #28) : un clic
 * arme l'outil, un second clic sur le même bouton le désarme. Chaque bouton
 * rappelle le geste attendu au survol et au focus.
 */

import type { BuildTool } from '../../game/buildRules';
import { el } from '../dom';
import { bindText, onLanguageChange, t, type TranslationKey } from '../i18n';

export type BuildToolId = BuildTool;

interface ToolDefinition {
  id: BuildToolId;
  icon: string;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}

const TOOLS: ToolDefinition[] = [
  {
    id: 'road',
    icon: '▤',
    labelKey: 'toolbar.road.label',
    hintKey: 'toolbar.road.hint',
  },
  {
    id: 'rail',
    icon: '╪',
    labelKey: 'toolbar.rail.label',
    hintKey: 'toolbar.rail.hint',
  },
  {
    id: 'station',
    icon: '▣',
    labelKey: 'toolbar.station.label',
    hintKey: 'toolbar.station.hint',
  },
  {
    id: 'depot',
    icon: '◫',
    labelKey: 'toolbar.depot.label',
    hintKey: 'toolbar.depot.hint',
  },
  {
    id: 'signal',
    icon: '◉',
    labelKey: 'toolbar.signal.label',
    hintKey: 'toolbar.signal.hint',
  },
];

const SHORT_LABELS: Record<BuildToolId, TranslationKey> = {
  road: 'toolbar.short.road',
  rail: 'toolbar.short.rail',
  station: 'toolbar.short.station',
  depot: 'toolbar.short.depot',
  signal: 'toolbar.short.signal',
  clear: 'toolbar.short.road',
};

export interface ToolbarOptions {
  onToggleTool: (tool: BuildToolId) => void;
}

export class Toolbar {
  readonly element: HTMLElement;

  private buttons = new Map<ToolDefinition['id'], HTMLButtonElement>();
  private active: BuildToolId | null = null;
  private stopListening: () => void;

  constructor(options: ToolbarOptions) {
    this.element = el('nav', {
      className: 'hud-toolbar',
      attrs: { 'aria-label': t('toolbar.label') },
    });
    for (const tool of TOOLS) {
      const button = el('button', {
        className: 'hud-tool',
        attrs: {
          type: 'button',
          'aria-pressed': 'false',
          'aria-label': t(tool.labelKey),
          title: t(tool.hintKey),
          'data-tooltip': t(tool.hintKey),
        },
        dataset: { tool: tool.id },
      });
      button.append(
        el('span', {
          className: 'hud-tool-icon',
          text: tool.icon,
          attrs: { 'aria-hidden': 'true' },
        }),
        bindText(el('span', { className: 'hud-tool-label' }), tool.labelKey),
      );
      button.addEventListener('click', () => options.onToggleTool(tool.id));
      this.buttons.set(tool.id, button);
      this.element.append(button);
    }
    this.stopListening = onLanguageChange(() => this.refreshLabels());
  }

  /** Met en évidence l'outil armé (ou aucun). */
  setActive(tool: BuildToolId | null): void {
    this.active = tool;
    for (const [id, button] of this.buttons) {
      const active = id === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    this.refreshLabels();
  }

  private refreshLabels(): void {
    this.element.setAttribute(
      'aria-label',
      this.active
        ? t('toolbar.labelActive', { tool: t(SHORT_LABELS[this.active]) })
        : t('toolbar.label'),
    );
    for (const tool of TOOLS) {
      const button = this.buttons.get(tool.id);
      if (!button) continue;
      button.setAttribute('aria-label', t(tool.labelKey));
      const hint = t(tool.hintKey);
      const text =
        tool.id === this.active ? t('toolbar.activeTooltip', { label: t(tool.labelKey) }) : hint;
      button.title = text;
      button.dataset.tooltip = text;
    }
  }

  dispose(): void {
    this.stopListening();
  }
}
