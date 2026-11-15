/**
 * Barre d'outils de construction.
 *
 * Routes et rails sont actifs (#27) : un clic arme l'outil, un second clic sur
 * le même bouton le désarme. Gares, dépôts et signaux restent désactivés et
 * expliquent leur feuille de route (#28) au survol, au focus et au clic.
 */

import { el } from '../dom';

export type BuildToolId = 'road' | 'rail';

interface ToolDefinition {
  id: BuildToolId | 'station' | 'depot' | 'signal';
  icon: string;
  label: string;
  available: boolean;
  hint: string;
}

const TOOLS: ToolDefinition[] = [
  {
    id: 'road',
    icon: '▤',
    label: 'Routes',
    available: true,
    hint: 'Cliquer puis glisser sur la carte pour construire une route.',
  },
  {
    id: 'rail',
    icon: '╪',
    label: 'Rails',
    available: true,
    hint: 'Cliquer puis glisser sur la carte pour construire une voie ferrée.',
  },
  {
    id: 'station',
    icon: '▣',
    label: 'Gares',
    available: false,
    hint: 'Gares — à venir (#28).',
  },
  {
    id: 'depot',
    icon: '◫',
    label: 'Dépôts',
    available: false,
    hint: 'Dépôts — à venir (#28).',
  },
  {
    id: 'signal',
    icon: '◉',
    label: 'Signaux',
    available: false,
    hint: 'Signaux — à venir (#28).',
  },
];

export interface ToolbarOptions {
  onToggleTool: (tool: BuildToolId) => void;
  onUnavailable: (label: string, reason: string) => void;
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
      const available = tool.available;
      const button = el('button', {
        className: 'hud-tool',
        attrs: {
          type: 'button',
          'aria-pressed': 'false',
          'aria-disabled': available ? 'false' : 'true',
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
      button.addEventListener('click', () => {
        if (available) options.onToggleTool(tool.id as BuildToolId);
        else options.onUnavailable(tool.label, tool.hint);
      });
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
      if (definition?.available) {
        button.title = active
          ? `${definition.label} — outil actif (Échap pour quitter)`
          : definition.hint;
      }
    }
    this.element.setAttribute(
      'aria-label',
      tool
        ? `Outils de construction — ${tool === 'road' ? 'routes' : 'rails'} actif`
        : 'Outils de construction',
    );
  }
}
