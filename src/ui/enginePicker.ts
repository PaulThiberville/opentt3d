/**
 * Sélecteur de moteur partagé par « Nouvelle partie » et « Réglages » (#78).
 *
 * Deux radios dans un `fieldset` (legend + description + état `aria-live`).
 * L'option WASM se désactive uniquement quand les artefacts sont confirmés
 * absents ; un échec réseau laisse le choix actif et l'explique.
 */

import type { EngineArtifacts } from '../engine/engineAssets';
import type { EngineMode } from '../engine/loadEngine';
import { el } from './dom';
import {
  engineArtifactsStatusKey,
  engineArtifactsStatusVars,
  resolveEngineChoice,
  type EngineChoiceState,
} from './engineChoice';
import { t, type TranslationKey } from './i18n';

export interface EnginePickerOptions {
  /** Préfixe des ids DOM, unique par écran. */
  idPrefix: string;
  legend: string;
  hint: string;
  /** Moteur issu des réglages persistants. */
  storedMode: EngineMode;
  /** Moteur imposé par `?engine=`, le cas échéant. */
  urlMode: EngineMode | null;
  artifacts: EngineArtifacts | null;
  onChange: (mode: EngineMode) => void;
}

export class EnginePicker {
  readonly element: HTMLFieldSetElement;

  private options: EnginePickerOptions;
  private status: HTMLParagraphElement;
  private lockedHint: HTMLParagraphElement;
  private radios = new Map<EngineMode, HTMLInputElement>();
  private optionNodes = new Map<EngineMode, HTMLElement>();
  private reasonNodes = new Map<EngineMode, HTMLElement>();
  private artifacts: EngineArtifacts | null;
  private state: EngineChoiceState;

  constructor(options: EnginePickerOptions) {
    this.options = options;
    this.artifacts = options.artifacts;
    this.state = resolveEngineChoice({
      urlMode: options.urlMode,
      storedMode: options.storedMode,
      artifacts: options.artifacts,
    });

    this.element = el('fieldset', {
      className: 'field field-full engine-field',
      dataset: { field: 'engine' },
    });
    const legendId = `${options.idPrefix}-engine-legend`;
    const hintId = `${options.idPrefix}-engine-hint`;
    this.element.append(
      el('legend', { className: 'field-label', text: options.legend, attrs: { id: legendId } }),
      el('p', { className: 'field-hint', text: options.hint, attrs: { id: hintId } }),
    );

    const list = el('div', { className: 'engine-options' });
    list.setAttribute('aria-describedby', hintId);
    for (const option of this.state.options) {
      const inputId = `${options.idPrefix}-engine-${option.value}`;
      const optionHintId = `${inputId}-hint`;
      const reasonId = `${inputId}-reason`;
      const label = el('label', { className: 'engine-option' });
      label.dataset.engine = option.value;
      const input = el('input', {
        attrs: {
          type: 'radio',
          name: `${options.idPrefix}-engine`,
          id: inputId,
          value: option.value,
          'aria-label': t(option.labelKey),
          'aria-describedby': `${optionHintId} ${reasonId} ${options.idPrefix}-engine-status`,
        },
      });
      input.checked = option.value === this.state.mode;
      input.disabled = option.disabled || this.state.locked;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.select(option.value);
      });

      const body = el('span', { className: 'engine-option-body' });
      const title = el('span', { className: 'engine-option-title' });
      title.append(
        el('span', { text: t(option.labelKey) }),
        el('span', {
          className: `badge engine-option-build${option.value === 'wasm' ? ' engine-option-build-wasm' : ''}`,
          text: option.buildId,
        }),
      );
      const reason = el('span', {
        className: 'engine-option-reason',
        attrs: { id: reasonId },
      });
      reason.hidden = true;
      body.append(
        title,
        el('span', {
          className: 'engine-option-hint',
          text: t(option.hintKey),
          attrs: { id: optionHintId },
        }),
        reason,
      );
      label.append(input, body);
      list.append(label);
      this.radios.set(option.value, input);
      this.optionNodes.set(option.value, label);
      this.reasonNodes.set(option.value, reason);
    }
    this.element.append(list);

    this.status = el('p', {
      className: 'engine-status',
      attrs: { id: `${options.idPrefix}-engine-status`, role: 'status', 'aria-live': 'polite' },
    });
    this.lockedHint = el('p', { className: 'field-hint engine-locked' });
    this.lockedHint.hidden = true;
    this.element.append(this.status, this.lockedHint);
    this.render();
  }

  /** Moteur actuellement sélectionné (après éventuelle rétrogradation). */
  get selection(): EngineMode {
    return this.state.mode;
  }

  /** Applique un nouveau résultat de détection ou un réglage modifié. */
  update(input: { artifacts: EngineArtifacts | null; storedMode: EngineMode }): EngineChoiceState {
    this.artifacts = input.artifacts;
    this.state = resolveEngineChoice({
      urlMode: this.options.urlMode,
      storedMode: input.storedMode,
      artifacts: input.artifacts,
    });
    for (const option of this.state.options) {
      const input = this.radios.get(option.value);
      if (!input) continue;
      input.disabled = option.disabled || this.state.locked;
      input.checked = option.value === this.state.mode;
      const node = this.optionNodes.get(option.value);
      node?.classList.toggle('is-disabled', option.disabled);
      const reason = this.reasonNodes.get(option.value);
      if (reason) {
        reason.hidden = option.reasonKey === null;
        reason.textContent = option.reasonKey ? t(option.reasonKey) : '';
      }
    }
    this.render();
    return this.state;
  }

  private select(mode: EngineMode): void {
    if (mode === this.state.mode) return;
    this.state = { ...this.state, mode, downgraded: false };
    this.options.onChange(mode);
  }

  private render(): void {
    const artifacts = this.options.artifacts;
    const key: TranslationKey = engineArtifactsStatusKey(artifacts);
    this.status.textContent = t(key, engineArtifactsStatusVars(artifacts));
    this.status.dataset.state = artifacts?.reason ?? 'checking';
    this.lockedHint.hidden = !this.state.locked;
    if (this.state.locked) {
      this.lockedHint.textContent = t('engine.locked.url', { mode: this.state.mode });
    }
    for (const option of this.state.options) {
      const node = this.optionNodes.get(option.value);
      node?.classList.toggle('is-disabled', option.disabled);
      const reason = this.reasonNodes.get(option.value);
      if (reason) {
        reason.hidden = option.reasonKey === null;
        reason.textContent = option.reasonKey ? t(option.reasonKey) : '';
      }
    }
  }
}
