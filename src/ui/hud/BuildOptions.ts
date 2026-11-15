/**
 * Barre d'options du mode construction (gares, dépôts, signaux).
 *
 * Purement présentationnelle : elle ne valide rien et ne construit rien. Elle
 * expose les réglages (type, quais, longueur, passage, orientation) et renvoie
 * une copie modifiée à `GameSession`, qui la transmet au contrôleur et au HUD.
 */

import {
  DIRECTION_LABELS,
  STATION_MAX_LENGTH,
  STATION_MAX_PLATFORMS,
  cloneBuildSettings,
  type BuildDirection,
  type BuildSettings,
  type BuildTool,
} from '../../game/buildRules';
import { el } from '../dom';

export interface BuildOptionsCallbacks {
  onChange: (settings: BuildSettings) => void;
  onRotate: () => void;
}

const DIRECTION_GLYPHS: Record<BuildDirection, string> = {
  ne: '↗',
  se: '↘',
  sw: '↙',
  nw: '↖',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export class BuildOptions {
  readonly element: HTMLElement;

  private callbacks: BuildOptionsCallbacks;
  private tool: BuildTool | null = null;
  private settings: BuildSettings;

  constructor(callbacks: BuildOptionsCallbacks, initial: BuildSettings) {
    this.callbacks = callbacks;
    this.settings = cloneBuildSettings(initial);
    this.element = el('div', {
      className: 'hud-build-options',
      attrs: { role: 'group', 'aria-label': 'Options de construction' },
    });
    this.element.hidden = true;
  }

  update(tool: BuildTool | null, settings: BuildSettings): void {
    this.tool = tool;
    this.settings = cloneBuildSettings(settings);
    this.render();
  }

  private commit(next: BuildSettings): void {
    this.settings = cloneBuildSettings(next);
    this.callbacks.onChange(cloneBuildSettings(next));
    this.render();
  }

  private render(): void {
    const tool = this.tool;
    this.element.replaceChildren();
    if (tool !== 'station' && tool !== 'depot' && tool !== 'signal') {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;

    const title = tool === 'station' ? 'Gare' : tool === 'depot' ? 'Dépôt' : 'Signal de bloc';
    this.element.append(el('span', { className: 'hud-build-options-title', text: title }));

    if (tool === 'station') this.renderStation();
    else if (tool === 'depot') this.renderDepot();
    else this.renderSignal();
  }

  private renderStation(): void {
    const station = this.settings.station;
    this.element.append(
      this.segmented(
        [
          { id: 'rail', label: 'Rail' },
          { id: 'road', label: 'Routier' },
        ],
        station.kind,
        (kind) => {
          this.commit({
            ...this.settings,
            station: { ...station, kind: kind as 'rail' | 'road' },
          });
        },
        'station-kind',
      ),
    );

    if (station.kind === 'rail') {
      this.element.append(
        this.stepper('Quais', station.platforms, 1, STATION_MAX_PLATFORMS, 'platforms', (value) =>
          this.commit({
            ...this.settings,
            station: { ...station, platforms: value },
          }),
        ),
        this.stepper('Longueur', station.length, 1, STATION_MAX_LENGTH, 'length', (value) =>
          this.commit({
            ...this.settings,
            station: { ...station, length: value },
          }),
        ),
      );
    } else {
      const toggle = el('button', {
        className: 'hud-build-option-toggle',
        text: 'En passage',
        attrs: {
          type: 'button',
          'aria-pressed': station.driveThrough ? 'true' : 'false',
        },
        dataset: { action: 'drive-through' },
      });
      toggle.addEventListener('click', () => {
        this.commit({
          ...this.settings,
          station: { ...station, driveThrough: !station.driveThrough },
        });
      });
      this.element.append(toggle);
    }
    this.element.append(this.directionButton(station.direction));
  }

  private renderDepot(): void {
    const depot = this.settings.depot;
    this.element.append(
      this.segmented(
        [
          { id: 'rail', label: 'Rail' },
          { id: 'road', label: 'Route' },
        ],
        depot.kind,
        (kind) => {
          this.commit({ ...this.settings, depot: { ...depot, kind: kind as 'rail' | 'road' } });
        },
        'depot-kind',
      ),
      this.directionButton(depot.direction ?? 'se'),
    );
  }

  private renderSignal(): void {
    this.element.append(
      el('span', {
        className: 'hud-build-options-note',
        text: 'Bloc simple · voie existante requise',
      }),
    );
  }

  private segmented(
    options: { id: string; label: string }[],
    active: string,
    onSelect: (id: string) => void,
    prefix: string,
  ): HTMLElement {
    const group = el('span', {
      className: 'hud-build-segments',
      attrs: { role: 'group' },
    });
    for (const option of options) {
      const button = el('button', {
        className: 'hud-build-option-segment',
        text: option.label,
        attrs: {
          type: 'button',
          'aria-pressed': option.id === active ? 'true' : 'false',
        },
        dataset: { action: `${prefix}-${option.id}` },
      });
      if (option.id === active) button.classList.add('is-active');
      button.addEventListener('click', () => onSelect(option.id));
      group.append(button);
    }
    return group;
  }

  private stepper(
    label: string,
    value: number,
    min: number,
    max: number,
    action: string,
    onChange: (value: number) => void,
  ): HTMLElement {
    const group = el('span', {
      className: 'hud-build-stepper',
      attrs: { role: 'group', 'aria-label': label },
    });
    const output = el('output', {
      className: 'hud-build-stepper-value',
      text: String(value),
      attrs: { 'aria-live': 'polite' },
    });
    const minus = el('button', {
      className: 'hud-build-stepper-button',
      text: '−',
      attrs: { type: 'button', 'aria-label': `${label} : diminuer` },
      dataset: { action: `${action}-minus` },
    });
    const plus = el('button', {
      className: 'hud-build-stepper-button',
      text: '+',
      attrs: { type: 'button', 'aria-label': `${label} : augmenter` },
      dataset: { action: `${action}-plus` },
    });
    if (value <= min) minus.disabled = true;
    if (value >= max) plus.disabled = true;
    minus.addEventListener('click', () => onChange(clamp(value - 1, min, max)));
    plus.addEventListener('click', () => onChange(clamp(value + 1, min, max)));
    group.append(
      el('span', { className: 'hud-build-options-label', text: label }),
      minus,
      output,
      plus,
    );
    return group;
  }

  private directionButton(direction: BuildDirection): HTMLElement {
    const group = el('span', { className: 'hud-build-direction' });
    const rotate = el('button', {
      className: 'hud-build-option-button',
      text: 'Pivoter (R)',
      attrs: { type: 'button' },
      dataset: { action: 'rotate' },
    });
    rotate.addEventListener('click', () => this.callbacks.onRotate());
    group.append(
      rotate,
      el('span', {
        className: 'hud-build-direction-value',
        text: `${DIRECTION_GLYPHS[direction]} ${DIRECTION_LABELS[direction]}`,
      }),
    );
    return group;
  }
}
