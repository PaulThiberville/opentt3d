/**
 * Écran de réglages : qualité, volumes (placeholder), langue et relais P2P.
 *
 * Les modifications sont enregistrées immédiatement dans `localStorage` via
 * le callback de l'application ; aucun réglage n'est perdu en quittant.
 * Le changement de langue reconstruit l'écran et rafraîchit le HUD via le
 * socle `i18n`.
 */

import { QUALITY_LEVELS } from '../../render/quality';
import { el, fieldLabel } from '../dom';
import { normalizeLanguage, qualityLabel, setLanguage, t } from '../i18n';
import { DEFAULT_P2P_RELAY, updateSettings, type GameSettings } from '../settings';
import { BaseScreen } from './BaseScreen';

export interface SettingsScreenOptions {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
  onBack: () => void;
}

export class SettingsScreen extends BaseScreen {
  private options: SettingsScreenOptions;
  private settings: GameSettings;
  private qualitySelect!: HTMLSelectElement;
  private dayNightToggle!: HTMLInputElement;
  private cycleInput!: HTMLInputElement;
  private cycleOutput!: HTMLOutputElement;
  private cycleHint!: HTMLParagraphElement;
  private introToggle!: HTMLInputElement;
  private languageSelect!: HTMLSelectElement;
  private volumeInputs = new Map<keyof GameSettings, HTMLInputElement>();
  private volumeOutputs = new Map<keyof GameSettings, HTMLOutputElement>();
  private status!: HTMLParagraphElement;

  constructor(options: SettingsScreenOptions) {
    super('panel-screen settings-screen');
    this.options = options;
    this.settings = { ...options.settings };
    this.element.setAttribute('aria-label', t('settings.title'));
    // Aligne le socle i18n sur la langue enregistrée sans réécrire le stockage.
    setLanguage(this.settings.language, { persist: false });
    this.build();
  }

  private build(): void {
    this.element.setAttribute('aria-label', t('settings.title'));
    this.volumeInputs.clear();
    this.volumeOutputs.clear();

    const panel = el('div', { className: 'panel panel-wide' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: t('settings.eyebrow') }),
      el('h1', { className: 'panel-title', text: t('settings.title') }),
      el('p', { className: 'panel-subtitle', text: t('settings.subtitle') }),
    );

    const grid = el('div', { className: 'settings-grid' });

    // Qualité ----------------------------------------------------------------
    this.qualitySelect = el('select', {
      className: 'input',
      attrs: {
        id: 'settings-quality',
        'aria-describedby': 'settings-quality-hint',
        'data-autofocus': '',
      },
    });
    for (const level of QUALITY_LEVELS) {
      const option = el('option', {
        text: qualityLabel(level),
        attrs: { value: level },
      });
      option.selected = level === this.settings.quality;
      this.qualitySelect.append(option);
    }
    this.qualitySelect.addEventListener('change', () => {
      this.patch({ quality: this.qualitySelect.value });
    });
    const qualityField = this.field(t('settings.quality.label'), this.qualitySelect);
    qualityField.append(this.hint('settings-quality-hint', t('settings.quality.hint')));

    // Cycle jour/nuit ---------------------------------------------------------
    const dayNightField = el('div', { className: 'field' });
    const toggleRow = el('div', { className: 'settings-toggle-row' });
    this.dayNightToggle = el('input', {
      attrs: { id: 'settings-day-night', type: 'checkbox' },
    });
    this.dayNightToggle.checked = this.settings.dayNightCycle;
    this.dayNightToggle.addEventListener('change', () => {
      this.patch({ dayNightCycle: this.dayNightToggle.checked });
    });
    toggleRow.append(
      this.dayNightToggle,
      fieldLabel(t('settings.daynight.toggle'), 'settings-day-night'),
    );

    const cycleRow = el('div', { className: 'volume-row settings-cycle-row' });
    this.cycleInput = el('input', {
      className: 'range',
      attrs: {
        id: 'settings-day-night-seconds',
        type: 'range',
        min: '30',
        max: '900',
        step: '10',
        value: `${this.settings.dayNightCycleSeconds}`,
      },
    });
    this.cycleOutput = el('output', {
      className: 'volume-value settings-cycle-value',
      text: `${this.settings.dayNightCycleSeconds} s`,
      attrs: { for: 'settings-day-night-seconds' },
    });
    this.cycleInput.addEventListener('input', () => {
      this.cycleOutput.textContent = `${this.cycleInput.value} s`;
      this.patch({ dayNightCycleSeconds: Number(this.cycleInput.value) });
    });
    cycleRow.append(
      fieldLabel(t('settings.daynight.duration'), 'settings-day-night-seconds'),
      this.cycleInput,
      this.cycleOutput,
    );

    this.cycleHint = el('p', {
      className: 'field-hint',
      text: t('settings.daynight.hint'),
    });
    dayNightField.append(
      fieldLabel(t('settings.daynight.label')),
      toggleRow,
      cycleRow,
      this.cycleHint,
    );

    // Intro cinématique ------------------------------------------------------
    const introField = el('div', { className: 'field' });
    const introRow = el('div', { className: 'settings-toggle-row' });
    this.introToggle = el('input', {
      attrs: { id: 'settings-cinematic-intro', type: 'checkbox' },
    });
    this.introToggle.checked = this.settings.cinematicIntro;
    this.introToggle.addEventListener('change', () => {
      this.patch({ cinematicIntro: this.introToggle.checked });
    });
    introRow.append(
      this.introToggle,
      fieldLabel(t('settings.intro.toggle'), 'settings-cinematic-intro'),
    );
    introField.append(
      fieldLabel(t('settings.intro.label')),
      introRow,
      this.hint('settings-intro-hint', t('settings.intro.hint')),
    );

    // Langue -----------------------------------------------------------------
    this.languageSelect = el('select', {
      className: 'input',
      attrs: { id: 'settings-language', 'aria-describedby': 'settings-language-hint' },
    });
    const fr = el('option', {
      text: t('settings.language.fr'),
      attrs: { value: 'fr', lang: 'fr' },
    });
    fr.selected = this.settings.language === 'fr';
    const en = el('option', {
      text: t('settings.language.en'),
      attrs: { value: 'en', lang: 'en' },
    });
    en.selected = this.settings.language === 'en';
    this.languageSelect.append(fr, en);
    this.languageSelect.addEventListener('change', () => this.changeLanguage());
    const languageField = this.field(t('settings.language.label'), this.languageSelect);
    languageField.append(this.hint('settings-language-hint', t('settings.language.hint')));

    // Volumes ----------------------------------------------------------------
    const volumes = el('div', { className: 'settings-volumes' });
    volumes.append(
      el('h2', { className: 'settings-section-title', text: t('settings.volumes.title') }),
      el('p', { className: 'field-hint', text: t('settings.volumes.hint') }),
    );
    const volumeDefs: { key: 'masterVolume' | 'effectsVolume' | 'musicVolume'; label: string }[] = [
      { key: 'masterVolume', label: t('settings.volume.master') },
      { key: 'effectsVolume', label: t('settings.volume.effects') },
      { key: 'musicVolume', label: t('settings.volume.music') },
    ];
    for (const def of volumeDefs) {
      const row = el('div', { className: 'volume-row' });
      const value = this.settings[def.key];
      const input = el('input', {
        className: 'range',
        attrs: {
          id: `settings-${def.key}`,
          type: 'range',
          min: '0',
          max: '100',
          step: '1',
          value: `${value}`,
          'aria-valuetext': `${value} %`,
        },
      });
      const output = el('output', {
        className: 'volume-value',
        text: `${value} %`,
        attrs: { for: `settings-${def.key}` },
      });
      input.addEventListener('input', () => {
        output.textContent = `${input.value} %`;
        input.setAttribute('aria-valuetext', `${input.value} %`);
        this.patch({ [def.key]: Number(input.value) });
      });
      this.volumeInputs.set(def.key, input);
      this.volumeOutputs.set(def.key, output);
      row.append(fieldLabel(def.label, `settings-${def.key}`), input, output);
      volumes.append(row);
    }

    // Relais P2P -------------------------------------------------------------
    const relayField = el('div', { className: 'field' });
    const relay = el('input', {
      className: 'input',
      attrs: {
        id: 'settings-relay',
        type: 'text',
        readonly: 'readonly',
        disabled: 'disabled',
        'aria-describedby': 'settings-relay-hint',
      },
    });
    const relayValue = this.settings.p2pRelay || DEFAULT_P2P_RELAY;
    relay.value = relayValue === DEFAULT_P2P_RELAY ? t('settings.relay.auto') : relayValue;
    relayField.append(fieldLabel(t('settings.relay.label'), 'settings-relay'), relay);
    relayField.append(this.hint('settings-relay-hint', t('settings.relay.hint')));

    grid.append(qualityField, dayNightField, introField, languageField, volumes, relayField);

    this.status = el('p', {
      className: 'settings-status',
      text: t('settings.status.local'),
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.status.hidden = true;

    const actions = el('div', { className: 'panel-actions' });
    const back = el('button', {
      className: 'btn btn-primary',
      text: t('settings.done'),
      attrs: { type: 'button' },
    });
    back.addEventListener('click', () => this.options.onBack());
    actions.append(back);

    panel.append(header, grid, this.status, actions);
    this.element.replaceChildren(panel);
  }

  private hint(id: string, text: string): HTMLParagraphElement {
    return el('p', { className: 'field-hint', text, attrs: { id } });
  }

  private field(labelText: string, control: HTMLElement): HTMLDivElement {
    const wrapper = el('div', { className: 'field' });
    wrapper.append(fieldLabel(labelText, control.id), control);
    return wrapper;
  }

  private changeLanguage(): void {
    const language = normalizeLanguage(this.languageSelect.value);
    if (language === this.settings.language) return;
    setLanguage(language);
    this.settings = updateSettings(this.settings, { language });
    this.options.onChange(this.settings);
    this.build();
    this.languageSelect.focus();
    this.showStatus(t('settings.status.saved'));
  }

  private showStatus(text: string): void {
    this.status.hidden = false;
    this.status.textContent = text;
  }

  private patch(patch: Partial<Record<keyof GameSettings, unknown>>): void {
    this.settings = updateSettings(this.settings, patch);
    for (const [key, input] of this.volumeInputs) {
      const value = this.settings[key];
      if (typeof value === 'number') {
        input.value = `${value}`;
        input.setAttribute('aria-valuetext', `${value} %`);
        this.volumeOutputs.get(key)?.replaceChildren(`${value} %`);
      }
    }
    this.languageSelect.value = this.settings.language;
    this.qualitySelect.value = this.settings.quality;
    this.dayNightToggle.checked = this.settings.dayNightCycle;
    this.introToggle.checked = this.settings.cinematicIntro;
    this.cycleInput.value = `${this.settings.dayNightCycleSeconds}`;
    this.cycleOutput.textContent = `${this.settings.dayNightCycleSeconds} s`;
    this.cycleInput.disabled = !this.settings.dayNightCycle;
    this.cycleHint.textContent = this.settings.dayNightCycle
      ? t('settings.daynight.hint')
      : t('settings.daynight.hintOff');
    this.showStatus(t('settings.status.saved'));
    this.options.onChange(this.settings);
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    const active = document.activeElement;
    if (active instanceof HTMLSelectElement) return;
    event.preventDefault();
    this.options.onBack();
  }
}
