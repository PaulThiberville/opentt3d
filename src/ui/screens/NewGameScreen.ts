/**
 * Écran « Nouvelle partie » : graine, taille de carte, qualité, difficulté,
 * IA, climat et année de départ. Validation centralisée dans `gameOptions`.
 */

import { QUALITY_LEVELS } from '../../render/quality';
import type { EngineMode } from '../../engine/loadEngine';
import { el, fieldLabel, enableListNavigation } from '../dom';
import { qualityLabel, t, tn, type TranslationKey } from '../i18n';
import {
  AI_COMPANIES,
  CLIMATES,
  DIFFICULTIES,
  MAP_SIZES,
  MAX_START_YEAR,
  MIN_START_YEAR,
  randomSeed,
  validateNewGameOptions,
  type FieldError,
  type NewGameOptions,
} from '../gameOptions';
import { BaseScreen } from './BaseScreen';

export interface NewGameScreenOptions {
  initial: NewGameOptions;
  onStart: (options: NewGameOptions) => void;
  onBack: () => void;
  /** Moteur qui sera utilisé (?engine=mock|wasm). */
  engineMode?: EngineMode;
}

const DIFFICULTY_KEYS: Record<number, TranslationKey> = {
  0: 'difficulty.easy',
  1: 'difficulty.normal',
  2: 'difficulty.hard',
  3: 'difficulty.expert',
};

const CLIMATE_KEYS: Record<string, TranslationKey> = {
  temperate: 'climate.temperate',
  subarctic: 'climate.subarctic',
  subtropical: 'climate.subtropical',
  toyland: 'climate.toyland',
};

export class NewGameScreen extends BaseScreen {
  private options: NewGameScreenOptions;
  private seedInput: HTMLInputElement;
  private qualitySelect: HTMLSelectElement;
  private difficultySelect: HTMLSelectElement;
  private aiSelect: HTMLSelectElement;
  private climateSelect: HTMLSelectElement;
  private yearInput: HTMLInputElement;
  private sizeInputs: HTMLInputElement[] = [];
  private cleanupNavigation: () => void;

  constructor(options: NewGameScreenOptions) {
    super('panel-screen new-game-screen');
    this.options = options;
    const initial = options.initial;

    const panel = el('div', { className: 'panel panel-wide' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: t('newgame.eyebrow') }),
      el('h1', { className: 'panel-title', text: t('newgame.title') }),
      el('p', {
        className: 'panel-subtitle',
        text: t('newgame.subtitle'),
      }),
    );

    const form = el('form', { className: 'form', attrs: { novalidate: '' } });

    // Graine -----------------------------------------------------------------
    this.seedInput = el('input', {
      className: 'input',
      attrs: {
        id: 'new-seed',
        name: 'seed',
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        spellcheck: 'false',
        'data-autofocus': '',
      },
    });
    this.seedInput.value = String(initial.seed);
    const seedRow = el('div', { className: 'field-row' });
    const randomButton = el('button', {
      className: 'btn btn-ghost',
      text: t('newgame.random'),
      attrs: { type: 'button', title: t('newgame.randomTitle') },
    });
    randomButton.addEventListener('click', () => {
      this.seedInput.value = String(randomSeed());
      this.seedInput.focus();
    });
    seedRow.append(this.seedInput, randomButton);
    const seedField = this.field(t('newgame.seed.label'), 'seed', seedRow);
    seedField.append(
      el('p', {
        className: 'field-hint',
        text: t('newgame.seed.hint'),
      }),
    );

    // Taille de carte ---------------------------------------------------------
    const sizeField = el('fieldset', {
      className: 'field field-full',
      dataset: { field: 'size' },
    });
    sizeField.append(el('legend', { className: 'field-label', text: t('newgame.size.label') }));
    const segments = el('div', { className: 'segmented' });
    for (const size of MAP_SIZES) {
      const label = el('label', { className: 'segment' });
      const input = el('input', {
        attrs: {
          type: 'radio',
          name: 'size',
          value: `${size}`,
          ...(size === initial.size ? { checked: 'checked' } : {}),
        },
      });
      label.append(input, el('span', { text: `${size}×${size}` }));
      this.sizeInputs.push(input);
      segments.append(label);
    }
    sizeField.append(segments);
    sizeField.append(
      el('p', {
        className: 'field-hint',
        text: t('newgame.size.hint'),
      }),
    );

    // Qualité ----------------------------------------------------------------
    this.qualitySelect = this.select(
      'new-quality',
      QUALITY_LEVELS.map((level) => ({ value: level, label: qualityLabel(level) })),
      initial.quality,
    );
    const qualityField = this.field(t('newgame.quality.label'), 'quality', this.qualitySelect);
    qualityField.append(
      el('p', {
        className: 'field-hint',
        text: t('newgame.quality.hint'),
      }),
    );

    // Difficulté --------------------------------------------------------------
    this.difficultySelect = this.select(
      'new-difficulty',
      DIFFICULTIES.map((entry) => ({
        value: `${entry.value}`,
        label: t(DIFFICULTY_KEYS[entry.value] ?? 'difficulty.normal'),
      })),
      `${initial.difficulty}`,
    );
    const difficultyField = this.field(
      t('newgame.difficulty.label'),
      'difficulty',
      this.difficultySelect,
    );
    difficultyField.append(
      el('p', {
        className: 'field-hint',
        text: t('newgame.difficulty.hint'),
      }),
    );

    // IA ---------------------------------------------------------------------
    this.aiSelect = this.select(
      'new-ai',
      AI_COMPANIES.map((count) => ({
        value: `${count}`,
        label: count === 0 ? t('newgame.ai.none') : tn(count, 'newgame.ai.one', 'newgame.ai.other'),
      })),
      `${initial.aiCompanies}`,
    );
    const aiField = this.field(t('newgame.ai.label'), 'aiCompanies', this.aiSelect);

    // Climat -----------------------------------------------------------------
    this.climateSelect = this.select(
      'new-climate',
      CLIMATES.map((entry) => ({
        value: entry.value,
        label: t(CLIMATE_KEYS[entry.value] ?? 'climate.temperate'),
      })),
      initial.climate,
    );
    const climateField = this.field(t('newgame.climate.label'), 'climate', this.climateSelect);

    // Année ------------------------------------------------------------------
    this.yearInput = el('input', {
      className: 'input',
      attrs: {
        id: 'new-year',
        name: 'startYear',
        type: 'number',
        min: `${MIN_START_YEAR}`,
        max: `${MAX_START_YEAR}`,
        step: '1',
      },
    });
    this.yearInput.value = `${initial.startYear}`;
    const yearField = this.field(t('newgame.year.label'), 'startYear', this.yearInput);

    form.append(
      seedField,
      sizeField,
      qualityField,
      difficultyField,
      aiField,
      climateField,
      yearField,
    );

    const actions = el('div', { className: 'panel-actions' });
    const back = el('button', {
      className: 'btn btn-ghost',
      text: t('newgame.back'),
      attrs: { type: 'button' },
    });
    back.addEventListener('click', () => options.onBack());
    const start = el('button', {
      className: 'btn btn-primary',
      text: t('newgame.start'),
      attrs: { type: 'submit' },
    });
    actions.append(back, start);
    form.append(actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });

    panel.append(header, this.engineInfo(), form);
    this.element.append(panel);
    this.cleanupNavigation = enableListNavigation(panel);

    const footer = el('p', {
      className: 'screen-note',
      text: t('newgame.footer'),
    });
    panel.append(footer);
  }

  /** Indicateur du moteur actif et avertissement sur les options non gérées. */
  private engineInfo(): HTMLElement {
    const mode = this.options.engineMode ?? 'mock';
    const block = el('div', { className: 'field-hint' });
    const badges = el('div', { className: 'menu-badges' });
    badges.append(
      el('span', {
        className: 'badge',
        text: t(mode === 'wasm' ? 'newgame.engine.wasm' : 'newgame.engine.mock'),
      }),
    );
    block.append(badges);
    block.append(
      el('p', {
        className: 'field-hint',
        text: t(mode === 'wasm' ? 'newgame.engine.wasmHint' : 'newgame.engine.mockHint'),
      }),
    );
    return block;
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    const active = document.activeElement;
    if (event.key === 'Escape' && !(active instanceof HTMLSelectElement)) {
      event.preventDefault();
      this.options.onBack();
    }
  }

  private select(
    id: string,
    entries: { value: string; label: string }[],
    selected: string,
  ): HTMLSelectElement {
    const select = el('select', { className: 'input', attrs: { id, name: id } });
    for (const entry of entries) {
      const option = el('option', { text: entry.label, attrs: { value: entry.value } });
      option.selected = entry.value === selected;
      select.append(option);
    }
    return select;
  }

  private field(labelText: string, name: string, control: HTMLElement): HTMLDivElement {
    const wrapper = el('div', { className: 'field', dataset: { field: name } });
    const controlId =
      control.id || (control.querySelector('input, select') as HTMLElement | null)?.id;
    wrapper.append(fieldLabel(labelText, controlId), control);
    return wrapper;
  }

  private submit(): void {
    this.clearErrors();
    const selectedSize = this.sizeInputs.find((input) => input.checked)?.value;
    const result = validateNewGameOptions(
      {
        seed: this.seedInput.value,
        size: selectedSize,
        quality: this.qualitySelect.value,
        difficulty: this.difficultySelect.value,
        aiCompanies: this.aiSelect.value,
        climate: this.climateSelect.value,
        startYear: this.yearInput.value,
      },
      this.options.initial,
    );
    if (!result.ok) {
      this.showErrors(result.errors);
      return;
    }
    this.options.onStart(result.value);
  }

  private clearErrors(): void {
    for (const node of this.element.querySelectorAll<HTMLElement>('.field.has-error')) {
      node.classList.remove('has-error');
    }
    for (const node of this.element.querySelectorAll('.field-error')) node.remove();
  }

  private showErrors(errors: FieldError[]): void {
    let firstControl: HTMLElement | null = null;
    for (const error of errors) {
      const field = this.element.querySelector<HTMLElement>(`[data-field="${error.field}"]`);
      if (!field) continue;
      field.classList.add('has-error');
      field.append(el('p', { className: 'field-error', text: error.message }));
      const control =
        field.querySelector<HTMLElement>('input, select') ??
        (field.querySelector<HTMLElement>('.field-row input') as HTMLElement | null);
      if (!firstControl && control) firstControl = control;
    }
    firstControl?.focus();
  }

  override dispose(): void {
    this.cleanupNavigation();
    super.dispose();
  }
}
