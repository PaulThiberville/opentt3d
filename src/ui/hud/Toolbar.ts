/**
 * Barre d'outils de construction.
 *
 * Le protocole de commandes existe, mais le branchement moteur (WASM) arrive
 * plus tard : les boutons sont marqués indisponibles et expliquent « à venir »
 * au survol et au focus, sans jamais envoyer de commande.
 */

import { el } from '../dom';

interface ToolDefinition {
  id: string;
  icon: string;
  label: string;
}

const TOOLS: ToolDefinition[] = [
  { id: 'road', icon: '▤', label: 'Routes' },
  { id: 'rail', icon: '╪', label: 'Rails' },
  { id: 'station', icon: '▣', label: 'Gares' },
  { id: 'depot', icon: '◫', label: 'Dépôts' },
  { id: 'signal', icon: '◉', label: 'Signaux' },
];

export interface ToolbarOptions {
  onUnavailable: (label: string) => void;
}

export class Toolbar {
  readonly element: HTMLElement;

  constructor(options: ToolbarOptions) {
    this.element = el('nav', {
      className: 'hud-toolbar',
      attrs: { 'aria-label': 'Outils de construction (indisponibles)' },
    });
    for (const tool of TOOLS) {
      const button = el('button', {
        className: 'hud-tool',
        attrs: {
          type: 'button',
          'aria-disabled': 'true',
          title: `${tool.label} — à venir`,
          'data-tooltip': 'À venir avec le moteur WASM',
        },
      });
      button.append(
        el('span', {
          className: 'hud-tool-icon',
          text: tool.icon,
          attrs: { 'aria-hidden': 'true' },
        }),
        el('span', { className: 'hud-tool-label', text: tool.label }),
      );
      button.addEventListener('click', () => options.onUnavailable(tool.label));
      this.element.append(button);
    }
  }
}
