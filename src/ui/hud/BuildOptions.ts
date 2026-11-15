/**
 * Barre d'options du mode construction (gares, dépôts, signaux).
 *
 * Purement présentationnelle : elle ne valide rien et ne construit rien. Elle
 * expose les réglages (type, quais, longueur, passage, orientation) et renvoie
 * une copie modifiée à `GameSession`, qui la transmet au contrôleur et au HUD.
 */

import {
  STATION_MAX_LENGTH,
  STATION_MAX_PLATFORMS,
  TERRAFORM_MAX_SIZE,
  TREE_MAX_SIZE,
  cloneBuildSettings,
  type BuildDirection,
  type BuildSettings,
  type BuildTool,
} from '../../game/buildRules';
import { el } from '../dom';
import { onLanguageChange, t, type TranslationKey } from '../i18n';

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

const DIRECTION_KEYS: Record<BuildDirection, TranslationKey> = {
  ne: 'build.direction.ne',
  se: 'build.direction.se',
  sw: 'build.direction.sw',
  nw: 'build.direction.nw',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export class BuildOptions {
  readonly element: HTMLElement;

  private callbacks: BuildOptionsCallbacks;
  private tool: BuildTool | null = null;
  private settings: BuildSettings;
  private stopListening: () => void;

  constructor(callbacks: BuildOptionsCallbacks, initial: BuildSettings) {
    this.callbacks = callbacks;
    this.settings = cloneBuildSettings(initial);
    this.element = el('div', {
      className: 'hud-build-options',
      attrs: { role: 'group', 'aria-label': t('build.optionsLabel') },
    });
    this.element.hidden = true;
    this.stopListening = onLanguageChange(() => {
      this.element.setAttribute('aria-label', t('build.optionsLabel'));
      this.render();
    });
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
    if (
      tool !== 'station' &&
      tool !== 'depot' &&
      tool !== 'signal' &&
      tool !== 'terraform' &&
      tool !== 'tree' &&
      tool !== 'lock'
    ) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;

    const title =
      tool === 'station'
        ? t('build.title.station')
        : tool === 'depot'
          ? t('build.title.depot')
          : tool === 'signal'
            ? t('build.title.signal')
            : tool === 'terraform'
              ? t('build.title.terraform')
              : tool === 'tree'
                ? t('build.title.tree')
                : t('build.title.lock');
    this.element.append(el('span', { className: 'hud-build-options-title', text: title }));

    if (tool === 'station') this.renderStation();
    else if (tool === 'depot') this.renderDepot();
    else if (tool === 'signal') this.renderSignal();
    else if (tool === 'terraform') this.renderTerraform();
    else if (tool === 'tree') this.renderTree();
    else this.renderLock();
  }

  private renderTerraform(): void {
    const terraform = this.settings.terraform;
    this.element.append(
      this.segmented(
        [
          { id: 'up', label: t('build.terraform.up') },
          { id: 'down', label: t('build.terraform.down') },
        ],
        terraform.direction,
        (direction) => {
          this.commit({
            ...this.settings,
            terraform: { ...terraform, direction: direction === 'down' ? 'down' : 'up' },
          });
        },
        'terraform-direction',
        'build.terraformDirection',
      ),
      this.stepper(
        t('build.size'),
        terraform.size,
        1,
        TERRAFORM_MAX_SIZE,
        'terraform-size',
        (value) => this.commit({ ...this.settings, terraform: { ...terraform, size: value } }),
      ),
    );
  }

  private renderTree(): void {
    const tree = this.settings.tree;
    this.element.append(
      this.stepper(t('build.size'), tree.size, 1, TREE_MAX_SIZE, 'tree-size', (value) =>
        this.commit({ ...this.settings, tree: { ...tree, size: value } }),
      ),
    );
  }

  private renderLock(): void {
    const lock = this.settings.lock;
    this.element.append(
      el('span', {
        className: 'hud-build-options-note',
        text: t('build.lockNote'),
      }),
      this.directionButton(lock.direction ?? 'ne'),
    );
  }

  private renderStation(): void {
    const station = this.settings.station;
    this.element.append(
      this.segmented(
        [
          { id: 'rail', label: t('build.rail') },
          { id: 'road', label: t('build.road') },
        ],
        station.kind,
        (kind) => {
          this.commit({
            ...this.settings,
            station: { ...station, kind: kind as 'rail' | 'road' },
          });
        },
        'station-kind',
        'build.stationKind',
      ),
    );

    if (station.kind === 'rail') {
      this.element.append(
        this.stepper(
          t('build.platforms'),
          station.platforms,
          1,
          STATION_MAX_PLATFORMS,
          'platforms',
          (value) =>
            this.commit({
              ...this.settings,
              station: { ...station, platforms: value },
            }),
        ),
        this.stepper(t('build.length'), station.length, 1, STATION_MAX_LENGTH, 'length', (value) =>
          this.commit({
            ...this.settings,
            station: { ...station, length: value },
          }),
        ),
      );
    } else {
      const toggle = el('button', {
        className: 'hud-build-option-toggle',
        text: t('build.driveThrough'),
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
          { id: 'rail', label: t('build.rail') },
          { id: 'road', label: t('build.route') },
        ],
        depot.kind,
        (kind) => {
          this.commit({ ...this.settings, depot: { ...depot, kind: kind as 'rail' | 'road' } });
        },
        'depot-kind',
        'build.depotKind',
      ),
      this.directionButton(depot.direction ?? 'se'),
    );
  }

  private renderSignal(): void {
    this.element.append(
      el('span', {
        className: 'hud-build-options-note',
        text: t('build.blockNote'),
      }),
    );
  }

  private segmented(
    options: { id: string; label: string }[],
    active: string,
    onSelect: (id: string) => void,
    prefix: string,
    labelKey: TranslationKey,
  ): HTMLElement {
    const group = el('span', {
      className: 'hud-build-segments',
      attrs: { role: 'group', 'aria-label': t(labelKey) },
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
      attrs: { type: 'button', 'aria-label': t('build.decrease', { label }) },
      dataset: { action: `${action}-minus` },
    });
    const plus = el('button', {
      className: 'hud-build-stepper-button',
      text: '+',
      attrs: { type: 'button', 'aria-label': t('build.increase', { label }) },
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

  dispose(): void {
    this.stopListening();
  }

  private directionButton(direction: BuildDirection): HTMLElement {
    const group = el('span', { className: 'hud-build-direction' });
    const rotate = el('button', {
      className: 'hud-build-option-button',
      text: t('build.rotate'),
      attrs: { type: 'button' },
      dataset: { action: 'rotate' },
    });
    rotate.addEventListener('click', () => this.callbacks.onRotate());
    group.append(
      rotate,
      el('span', {
        className: 'hud-build-direction-value',
        text: `${DIRECTION_GLYPHS[direction]} ${t(DIRECTION_KEYS[direction])}`,
      }),
    );
    return group;
  }
}
