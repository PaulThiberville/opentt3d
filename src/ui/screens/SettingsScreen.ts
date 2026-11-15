/**
 * Écran de réglages : qualité, volumes (placeholder), langue et relais P2P.
 *
 * Les modifications sont enregistrées immédiatement dans `localStorage` via
 * le callback de l'application ; aucun réglage n'est perdu en quittant.
 */

import { QUALITY_LEVELS, QUALITY_PRESETS } from '../../render/quality';
import { el, fieldLabel } from '../dom';
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
  private qualitySelect: HTMLSelectElement;
  private languageSelect: HTMLSelectElement;
  private volumeInputs = new Map<keyof GameSettings, HTMLInputElement>();
  private volumeOutputs = new Map<keyof GameSettings, HTMLOutputElement>();
  private status: HTMLParagraphElement;

  constructor(options: SettingsScreenOptions) {
    super('panel-screen settings-screen');
    this.options = options;
    this.settings = { ...options.settings };

    const panel = el('div', { className: 'panel panel-wide' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: 'Réglages' }),
      el('h1', { className: 'panel-title', text: 'Préférences' }),
      el('p', {
        className: 'panel-subtitle',
        text: 'Les réglages sont enregistrés immédiatement dans ce navigateur (localStorage).',
      }),
    );

    const grid = el('div', { className: 'settings-grid' });

    // Qualité ----------------------------------------------------------------
    this.qualitySelect = el('select', {
      className: 'input',
      attrs: { id: 'settings-quality' },
    });
    for (const level of QUALITY_LEVELS) {
      const option = el('option', {
        text: QUALITY_PRESETS[level].label,
        attrs: { value: level },
      });
      option.selected = level === this.settings.quality;
      this.qualitySelect.append(option);
    }
    this.qualitySelect.addEventListener('change', () => {
      this.patch({ quality: this.qualitySelect.value });
    });
    const qualityField = this.field('Qualité de rendu', this.qualitySelect);
    qualityField.append(
      el('p', {
        className: 'field-hint',
        text: 'Appliquée immédiatement à la scène 3D (ombres, distance, végétation).',
      }),
    );

    // Langue -----------------------------------------------------------------
    this.languageSelect = el('select', {
      className: 'input',
      attrs: { id: 'settings-language' },
    });
    const fr = el('option', { text: 'Français', attrs: { value: 'fr' } });
    fr.selected = this.settings.language === 'fr';
    const en = el('option', {
      text: 'Anglais — bientôt',
      attrs: { value: 'en', disabled: 'disabled' },
    });
    this.languageSelect.append(fr, en);
    this.languageSelect.addEventListener('change', () => {
      this.patch({ language: this.languageSelect.value });
    });
    const languageField = this.field('Langue de l’interface', this.languageSelect);
    languageField.append(
      el('p', {
        className: 'field-hint',
        text: 'Seul le français est disponible pour cette vague.',
      }),
    );

    // Volumes ----------------------------------------------------------------
    const volumes = el('div', { className: 'settings-volumes' });
    volumes.append(
      el('h2', { className: 'settings-section-title', text: 'Volumes (placeholder)' }),
      el('p', {
        className: 'field-hint',
        text: 'Les curseurs sont persistés mais aucun moteur audio n’est encore branché.',
      }),
    );
    const volumeDefs: { key: 'masterVolume' | 'effectsVolume' | 'musicVolume'; label: string }[] = [
      { key: 'masterVolume', label: 'Volume général' },
      { key: 'effectsVolume', label: 'Effets' },
      { key: 'musicVolume', label: 'Musique' },
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
        },
      });
      const output = el('output', {
        className: 'volume-value',
        text: `${value} %`,
        attrs: { for: `settings-${def.key}` },
      });
      input.addEventListener('input', () => {
        output.textContent = `${input.value} %`;
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
      },
    });
    relay.value = this.settings.p2pRelay || DEFAULT_P2P_RELAY;
    relayField.append(fieldLabel('Relais P2P', 'settings-relay'), relay);
    relayField.append(
      el('p', {
        className: 'field-hint',
        text: 'Lecture seule pour l’instant : le choix du relais sera exposé avec l’interface de salon.',
      }),
    );

    grid.append(qualityField, languageField, volumes, relayField);

    this.status = el('p', {
      className: 'settings-status',
      text: 'Réglages enregistrés localement.',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.status.hidden = true;

    const actions = el('div', { className: 'panel-actions' });
    const back = el('button', {
      className: 'btn btn-primary',
      text: 'Terminer',
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    back.addEventListener('click', () => options.onBack());
    actions.append(back);

    panel.append(header, grid, this.status, actions);
    this.element.append(panel);
  }

  private field(labelText: string, control: HTMLElement): HTMLDivElement {
    const wrapper = el('div', { className: 'field' });
    wrapper.append(fieldLabel(labelText, control.id), control);
    return wrapper;
  }

  private patch(patch: Partial<Record<keyof GameSettings, unknown>>): void {
    this.settings = updateSettings(this.settings, patch);
    for (const [key, input] of this.volumeInputs) {
      const value = this.settings[key];
      if (typeof value === 'number') {
        input.value = `${value}`;
        this.volumeOutputs.get(key)?.replaceChildren(`${value} %`);
      }
    }
    this.languageSelect.value = this.settings.language;
    this.qualitySelect.value = this.settings.quality;
    this.status.hidden = false;
    this.status.textContent = 'Réglages enregistrés.';
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
