/**
 * Écran « Nouvelle partie » : graine, taille de carte, qualité, difficulté,
 * IA, climat et année de départ. Validation centralisée dans `gameOptions`.
 */

import { QUALITY_LEVELS, QUALITY_PRESETS } from '../../render/quality';
import type { EngineMode } from '../../engine/loadEngine';
import { el, fieldLabel, enableListNavigation } from '../dom';
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
      el('span', { className: 'panel-eyebrow', text: 'Nouvelle partie' }),
      el('h1', { className: 'panel-title', text: 'Générer un monde' }),
      el('p', {
        className: 'panel-subtitle',
        text: 'La carte, les villes, les industries et les réseaux de départ sont générés de façon déterministe à partir de la graine.',
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
      text: 'Aléatoire',
      attrs: { type: 'button', title: 'Tirer une nouvelle graine' },
    });
    randomButton.addEventListener('click', () => {
      this.seedInput.value = String(randomSeed());
      this.seedInput.focus();
    });
    seedRow.append(this.seedInput, randomButton);
    const seedField = this.field('Graine', 'seed', seedRow);
    seedField.append(
      el('p', {
        className: 'field-hint',
        text: 'Entier ou hexadécimal (0x…). Une même graine donne le même monde.',
      }),
    );

    // Taille de carte ---------------------------------------------------------
    const sizeField = el('fieldset', {
      className: 'field field-full',
      dataset: { field: 'size' },
    });
    sizeField.append(el('legend', { className: 'field-label', text: 'Taille de carte' }));
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
        text: '128 pour une partie rapide, 256 pour l’expérience par défaut, 512 pour une grande carte. Le moteur WASM exige des puissances de 2.',
      }),
    );

    // Qualité ----------------------------------------------------------------
    this.qualitySelect = this.select(
      'new-quality',
      QUALITY_LEVELS.map((level) => ({ value: level, label: QUALITY_PRESETS[level].label })),
      initial.quality,
    );
    const qualityField = this.field('Qualité de rendu', 'quality', this.qualitySelect);
    qualityField.append(
      el('p', {
        className: 'field-hint',
        text: 'Peut être changée en jeu depuis le HUD ou les réglages.',
      }),
    );

    // Difficulté --------------------------------------------------------------
    this.difficultySelect = this.select(
      'new-difficulty',
      DIFFICULTIES.map((entry) => ({ value: `${entry.value}`, label: entry.label })),
      `${initial.difficulty}`,
    );
    const difficultyField = this.field('Difficulté', 'difficulty', this.difficultySelect);
    difficultyField.append(
      el('p', {
        className: 'field-hint',
        text: 'Transmise au moteur ; l’effet complet arrive avec le WASM.',
      }),
    );

    // IA ---------------------------------------------------------------------
    this.aiSelect = this.select(
      'new-ai',
      AI_COMPANIES.map((count) => ({
        value: `${count}`,
        label:
          count === 0 ? 'Aucune (bac à sable)' : `${count} entreprise${count > 1 ? 's' : ''} IA`,
      })),
      `${initial.aiCompanies}`,
    );
    const aiField = this.field('Entreprises IA', 'aiCompanies', this.aiSelect);

    // Climat -----------------------------------------------------------------
    this.climateSelect = this.select(
      'new-climate',
      CLIMATES.map((entry) => ({ value: entry.value, label: entry.label })),
      initial.climate,
    );
    const climateField = this.field('Climat', 'climate', this.climateSelect);

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
    const yearField = this.field('Année de départ', 'startYear', this.yearInput);

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
      text: 'Retour',
      attrs: { type: 'button' },
    });
    back.addEventListener('click', () => options.onBack());
    const start = el('button', {
      className: 'btn btn-primary',
      text: 'Démarrer la partie',
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
      text: 'Astuce : Échap revient au menu. Aucune donnée n’est envoyée sur le réseau.',
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
        text: mode === 'wasm' ? 'Moteur WASM (OpenTTD réel)' : 'Moteur simulé (Mock)',
      }),
    );
    block.append(badges);
    block.append(
      el('p', {
        className: 'field-hint',
        text:
          mode === 'wasm'
            ? 'Le pont WASM ne gère pas encore le climat, l’année de départ, les IA ni la difficulté : la partie démarre en tempéré, en 1950, sans IA (#60).'
            : 'Simulation déterministe locale. Ajoutez ?engine=wasm à l’URL pour tester le moteur OpenTTD réel.',
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
