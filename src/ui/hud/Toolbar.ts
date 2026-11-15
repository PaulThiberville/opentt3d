/**
 * Barre d'outils de construction.
 *
 * Routes, rails, gares, dépôts et signaux sont actifs (#27, #28) : un clic
 * arme l'outil, un second clic sur le même bouton le désarme. Chaque bouton
 * rappelle le geste attendu au survol et au focus.
 */

import type { BuildTool } from '../../game/buildRules';
import { el } from '../dom';

export type BuildToolId = BuildTool;

interface ToolDefinition {
  id: BuildToolId;
  icon: string;
  label: string;
  hint: string;
}

const TOOLS: ToolDefinition[] = [
  {
    id: 'road',
    icon: '▤',
    label: 'Routes',
    hint: 'Cliquer puis glisser sur la carte pour construire une route.',
  },
  {
    id: 'rail',
    icon: '╪',
    label: 'Rails',
    hint: 'Cliquer puis glisser sur la carte pour construire une voie ferrée.',
  },
  {
    id: 'station',
    icon: '▣',
    label: 'Gares',
    hint: 'Gare ferroviaire ou routière : cliquez pour poser, R pivote, taille dans la barre d’options.',
  },
  {
    id: 'depot',
    icon: '◫',
    label: 'Dépôts',
    hint: 'Dépôt route ou rail : posez-le à côté d’une voie, R oriente l’entrée.',
  },
  {
    id: 'signal',
    icon: '◉',
    label: 'Signaux',
    hint: 'Signal de bloc : cliquez (ou glissez) sur une voie ferrée existante.',
  },
];

const SHORT_LABELS: Record<BuildToolId, string> = {
  road: 'routes',
  rail: 'rails',
  station: 'gares',
  depot: 'dépôts',
  signal: 'signaux',
  clear: 'démolition',
};

export interface ToolbarOptions {
  onToggleTool: (tool: BuildToolId) => void;
}

export class Toolbar {
  readonly element: HTMLElement;

  private buttons = new Map<ToolDefinition['id'], HTMLButtonElement>();

  constructor(options: ToolbarOptions) {
    this.element = el('nav', {
      className: 'hud-toolbar',
      attrs: { 'aria-label': 'Outils de construction' },
    });
    for (const tool of TOOLS) {
      const button = el('button', {
        className: 'hud-tool',
        attrs: {
          type: 'button',
          'aria-pressed': 'false',
          'aria-disabled': 'false',
          title: tool.hint,
          'data-tooltip': tool.hint,
        },
        dataset: { tool: tool.id },
      });
      button.append(
        el('span', {
          className: 'hud-tool-icon',
          text: tool.icon,
          attrs: { 'aria-hidden': 'true' },
        }),
        el('span', { className: 'hud-tool-label', text: tool.label }),
      );
      button.addEventListener('click', () => options.onToggleTool(tool.id));
      this.buttons.set(tool.id, button);
      this.element.append(button);
    }
  }

  /** Met en évidence l'outil armé (ou aucun). */
  setActive(tool: BuildToolId | null): void {
    for (const [id, button] of this.buttons) {
      const active = id === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      const definition = TOOLS.find((candidate) => candidate.id === id);
      if (definition) {
        button.title = active
          ? `${definition.label} — outil actif (Échap pour quitter)`
          : definition.hint;
      }
    }
    this.element.setAttribute(
      'aria-label',
      tool ? `Outils de construction — ${SHORT_LABELS[tool]} actif` : 'Outils de construction',
    );
  }
}
