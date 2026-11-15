/**
 * Écran « Sauvegarder / Charger » : liste des slots IndexedDB, chargement,
 * suppression confirmée, export de fichier et import validé.
 *
 * L'écran ne connaît ni le moteur ni la session : il reçoit une promesse de
 * `SaveStore` (ouverture IndexedDB asynchrone) et des callbacks. En mode
 * `both` (menu pause), il capture la partie courante via `capture()` ; en mode
 * `load` (menu principal), il se contente de lire et d'importer.
 *
 * Aucun `innerHTML` : noms de sauvegarde et noms d'entreprises passent par
 * `textContent`.
 */

import { button, el, fieldLabel } from '../dom';
import {
  defaultSaveName,
  engineLabel,
  formatSaveSize,
  formatSaveTimestamp,
  type SaveRecord,
  type SaveSlot,
} from '../saveFormat';
import { formatGameDate, formatInt } from '../format';
import { t } from '../i18n';
import {
  describeSaveError,
  downloadSaveFile,
  readSaveFile,
  type NewSaveInput,
  type SaveStore,
  type SaveStoreHandle,
} from '../saveStore';
import { BaseScreen } from './BaseScreen';

export type SaveScreenMode = 'load' | 'both';

export interface SaveScreenOptions {
  /** Ouverture asynchrone du stockage (IndexedDB, repli mémoire). */
  store: Promise<SaveStoreHandle>;
  mode: SaveScreenMode;
  onBack: () => void;
  /** Appelé avec les octets déjà lus ; le bootstrap libère l'ancienne session. */
  onLoad: (record: SaveRecord) => void;
  /** Capture la partie en cours (obligatoire en mode `both`). */
  capture?: () => Promise<Omit<NewSaveInput, 'name'>>;
  /** Nom proposé dans le formulaire de sauvegarde. */
  suggestedName?: string;
  /** Résumé de la partie en cours affiché au-dessus du formulaire. */
  currentLabel?: string;
  /** Confirmation après une sauvegarde manuelle réussie (toast HUD). */
  onSaved?: (slot: SaveSlot) => void;
}

type StatusTone = 'info' | 'success' | 'warning' | 'error';

export class SaveScreen extends BaseScreen {
  private options: SaveScreenOptions;
  private store: SaveStore | null = null;
  private handle: SaveStoreHandle | null = null;
  private slots: SaveSlot[] = [];
  private disposed = false;
  private busy = false;
  private pendingDelete: string | null = null;

  private storageNote: HTMLParagraphElement;
  private statusEl: HTMLParagraphElement;
  private listEl: HTMLDivElement;
  private listShell: HTMLDivElement;
  private nameInput: HTMLInputElement | null = null;
  private saveButton: HTMLButtonElement | null = null;
  private importButton: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  private backButton: HTMLButtonElement;

  constructor(options: SaveScreenOptions) {
    super('panel-screen save-screen');
    this.options = options;

    const panel = el('div', { className: 'panel panel-wide save-panel' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: t('save.eyebrow') }),
      el('h1', {
        className: 'panel-title',
        text: t(options.mode === 'both' ? 'save.title.both' : 'save.title.load'),
      }),
      el('p', {
        className: 'panel-subtitle',
        text: t(options.mode === 'both' ? 'save.subtitle.both' : 'save.subtitle.load'),
      }),
    );

    this.storageNote = el('p', {
      className: 'screen-note save-storage',
      text: t('save.storage.opening'),
    });

    this.statusEl = el('p', {
      className: 'save-status',
      text: '',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.statusEl.hidden = true;

    const body = el('div', { className: 'save-body' });

    if (options.mode === 'both' && options.capture) {
      body.append(this.buildSaveForm());
    }

    const listHeader = el('div', { className: 'save-list-header' });
    listHeader.append(
      el('h2', { className: 'save-list-title', text: t('save.list.title') }),
      el('span', {
        className: 'save-list-hint',
        text: t('save.list.hint'),
      }),
    );

    this.listEl = el('div', { className: 'save-list', attrs: { role: 'list' } });
    this.listEl.append(el('p', { className: 'save-empty', text: t('save.list.loading') }));
    this.listEl.addEventListener('scroll', this.handleListScroll, { passive: true });
    this.listShell = el('div', { className: 'save-list-shell' });
    this.listShell.append(this.listEl);

    this.fileInput = el('input', {
      className: 'save-file-input',
      attrs: { type: 'file', accept: '.ot3s,.json,.sav,application/octet-stream,application/json' },
    });
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => void this.importFromPicker());

    this.importButton = button(t('save.import'), {
      variant: 'ghost',
      className: 'save-import-button',
      onClick: () => this.fileInput.click(),
    });

    const importRow = el('div', { className: 'save-import' });
    importRow.append(
      this.importButton,
      el('p', {
        className: 'field-hint',
        text: t('save.import.hint'),
      }),
      this.fileInput,
    );

    body.append(listHeader, this.listShell, importRow);
    this.element.append(panel);
    panel.append(header, this.storageNote, this.statusEl, body);

    const actions = el('div', { className: 'panel-actions' });
    this.backButton = button(t(options.mode === 'both' ? 'save.back.pause' : 'common.backToMenu'), {
      variant: 'ghost',
      onClick: () => options.onBack(),
    });
    actions.append(this.backButton);
    panel.append(actions);

    void this.init();
  }

  private buildSaveForm(): HTMLDivElement {
    const wrapper = el('div', { className: 'save-current' });
    const header = el('div', { className: 'save-current-header' });
    header.append(
      el('h2', { className: 'save-list-title', text: t('save.current.title') }),
      ...(this.options.currentLabel
        ? [el('span', { className: 'save-current-label', text: this.options.currentLabel })]
        : []),
    );

    const form = el('form', { className: 'save-form', attrs: { novalidate: '' } });
    const field = el('div', { className: 'field field-full' });
    const input = el('input', {
      className: 'input',
      attrs: {
        id: 'save-name',
        name: 'save-name',
        type: 'text',
        maxlength: '60',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    });
    input.value = this.options.suggestedName ?? defaultSaveName(null);
    const submit = button(t('save.saveNow'), {
      variant: 'primary',
      onClick: () => undefined,
    });
    submit.addEventListener('click', (event) => {
      event.preventDefault();
      void this.saveCurrent();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveCurrent();
    });
    field.append(fieldLabel('Nom de la sauvegarde', 'save-name'), input);
    const row = el('div', { className: 'save-form-row' });
    row.append(field, submit);
    form.append(row);
    this.nameInput = input;
    this.saveButton = submit;
    wrapper.append(header, form);
    return wrapper;
  }

  private async init(): Promise<void> {
    try {
      const handle = await this.options.store;
      if (this.disposed) return;
      this.handle = handle;
      this.store = handle.store;
      this.storageNote.textContent = handle.persistent
        ? 'Stockage local IndexedDB : les sauvegardes survivent à la fermeture de l’onglet.'
        : (handle.warning ??
          'Stockage mémoire : les sauvegardes seront perdues à la fermeture de l’onglet.');
      if (handle.warning) this.showStatus(handle.warning, 'warning');
      await this.reload();
    } catch (error) {
      if (this.disposed) return;
      this.showStatus(describeSaveError(error), 'error');
    }
  }

  private async reload(): Promise<void> {
    const store = this.store;
    if (!store) return;
    try {
      const slots = await store.list();
      if (this.disposed) return;
      this.slots = slots;
      this.renderList();
      void this.refreshStorageNote();
    } catch (error) {
      if (this.disposed) return;
      this.showStatus(describeSaveError(error), 'error');
    }
  }

  private async refreshStorageNote(): Promise<void> {
    const store = this.store;
    if (!store || this.disposed) return;
    const estimate = await store.estimate();
    if (this.disposed || !estimate) return;
    const base = t(this.handle?.persistent ? 'save.storage.indexed' : 'save.storage.memory');
    this.storageNote.textContent = t('save.storage.usage', {
      base,
      usage: formatSaveSize(estimate.usage),
      quota: formatSaveSize(estimate.quota),
    });
  }

  private renderList(): void {
    if (this.disposed) return;
    this.listEl.replaceChildren();
    this.scheduleScrollAffordance();
    if (this.slots.length === 0) {
      const empty = el('div', { className: 'save-empty' });
      empty.append(
        el('strong', { text: t('save.empty.title') }),
        el('span', {
          text: t(this.options.mode === 'both' ? 'save.empty.both' : 'save.empty.load'),
        }),
      );
      this.listEl.append(empty);
      return;
    }
    for (const slot of this.slots) this.listEl.append(this.renderRow(slot));
  }

  private renderRow(slot: SaveSlot): HTMLElement {
    const row = el('article', {
      className: `save-row save-row-${slot.kind}`,
      dataset: { slot: slot.id },
      attrs: { role: 'listitem' },
    });

    const title = el('div', { className: 'save-row-title' });
    title.append(el('span', { className: 'save-name', text: slot.name }));
    if (slot.kind === 'autosave') {
      title.append(
        el('span', { className: 'save-tag save-tag-auto', text: t('save.tag.autosave') }),
      );
    } else if (slot.kind === 'import') {
      title.append(el('span', { className: 'save-tag', text: t('save.tag.import') }));
    }
    title.append(
      el('span', {
        className: `save-tag save-tag-engine save-tag-${slot.engine}`,
        text: engineLabel(slot.engine),
      }),
    );

    const details: string[] = [];
    details.push(
      slot.gameDate
        ? t('save.detail.date', { date: formatGameDate(slot.gameDate) })
        : t('save.detail.dateUnknown'),
    );
    if (slot.mapSize) details.push(t('save.detail.map', { size: slot.mapSize }));
    details.push(formatSaveSize(slot.size));
    if (slot.seed !== null) details.push(t('save.detail.seed', { seed: slot.seed }));
    if (slot.tick > 0) details.push(t('save.detail.tick', { tick: formatInt(slot.tick) }));
    if (slot.companies.length > 0) {
      const shown = slot.companies.slice(0, 3).join(', ');
      const more = slot.companies.length > 3 ? ` +${slot.companies.length - 3}` : '';
      details.push(t('save.detail.companies', { names: `${shown}${more}` }));
    }
    details.push(t('save.detail.created', { date: formatSaveTimestamp(slot.createdAt) }));

    const meta = el('p', { className: 'save-meta', text: details.join(' · ') });

    const actions = el('div', { className: 'save-row-actions' });
    const load = button(t('save.action.load'), {
      variant: 'primary',
      className: 'save-action',
      disabled: this.busy,
      onClick: () => void this.loadSlot(slot),
    });
    const exportButton = button(t('save.action.export'), {
      variant: 'ghost',
      className: 'save-action',
      disabled: this.busy,
      onClick: () => void this.exportSlot(slot),
    });
    actions.append(load, exportButton);

    if (this.pendingDelete === slot.id) {
      const confirm = button(t('save.action.delete'), {
        variant: 'danger',
        className: 'save-action',
        disabled: this.busy,
        onClick: () => void this.deleteSlot(slot),
      });
      const cancel = button(t('common.cancel'), {
        variant: 'ghost',
        className: 'save-action',
        disabled: this.busy,
        onClick: () => {
          this.pendingDelete = null;
          this.renderList();
        },
      });
      actions.append(confirm, cancel);
    } else {
      actions.append(
        button(t('save.action.delete'), {
          variant: 'ghost',
          className: 'save-action save-action-danger',
          disabled: this.busy,
          onClick: () => {
            this.pendingDelete = slot.id;
            this.renderList();
          },
        }),
      );
    }

    const body = el('div', { className: 'save-row-body' });
    body.append(title, meta);
    row.append(body, actions);
    return row;
  }

  private async loadSlot(slot: SaveSlot): Promise<void> {
    const store = this.store;
    if (!store || this.busy) return;
    this.busy = true;
    this.renderList();
    this.showStatus(t('save.reading', { name: slot.name }), 'info');
    try {
      const record = await store.get(slot.id);
      if (this.disposed) return;
      if (!record) throw new Error(t('save.missing'));
      this.options.onLoad(record);
    } catch (error) {
      if (this.disposed) return;
      this.busy = false;
      this.renderList();
      this.showStatus(describeSaveError(error), 'error');
    }
  }

  private async exportSlot(slot: SaveSlot): Promise<void> {
    const store = this.store;
    if (!store || this.busy) return;
    this.busy = true;
    this.renderList();
    try {
      const record = await store.get(slot.id);
      if (!record) throw new Error(t('save.missing'));
      const fileName = downloadSaveFile(record);
      if (this.disposed) return;
      this.showStatus(t('save.exported', { name: fileName }), 'success');
    } catch (error) {
      if (this.disposed) return;
      this.showStatus(describeSaveError(error), 'error');
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.renderList();
      }
    }
  }

  private async saveCurrent(): Promise<void> {
    const store = this.store;
    const capture = this.options.capture;
    const input = this.nameInput;
    if (!store || !capture || !input || this.busy) return;
    this.busy = true;
    this.renderList();
    this.showStatus('Sauvegarde de la partie en cours…', 'info');
    try {
      const captured = await capture();
      const slot = await store.save({ ...captured, name: input.value });
      if (this.disposed) return;
      input.value = defaultSaveName(slot.gameDate);
      this.options.onSaved?.(slot);
      this.showStatus(
        `Partie sauvegardée : « ${slot.name} » (${formatSaveSize(slot.size)}).`,
        'success',
      );
      await this.reload();
    } catch (error) {
      if (this.disposed) return;
      this.showStatus(describeSaveError(error), 'error');
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.renderList();
      }
    }
  }

  private async importFromPicker(): Promise<void> {
    const file = this.fileInput.files?.[0] ?? null;
    this.fileInput.value = '';
    if (!file || this.busy) return;
    const store = this.store;
    if (!store) return;
    this.busy = true;
    this.renderList();
    this.showStatus(`Import de « ${file.name} »…`, 'info');
    try {
      const bytes = await readSaveFile(file);
      const slot = await store.importFile(file.name, bytes);
      if (this.disposed) return;
      this.showStatus(
        `Sauvegarde importée : « ${slot.name} » (${formatSaveSize(slot.size)}). Cliquez sur « Charger » pour jouer.`,
        'success',
      );
      await this.reload();
    } catch (error) {
      if (this.disposed) return;
      this.showStatus(describeSaveError(error), 'error');
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.renderList();
      }
    }
  }

  private async deleteSlot(slot: SaveSlot): Promise<void> {
    const store = this.store;
    if (!store || this.busy) return;
    this.busy = true;
    this.pendingDelete = null;
    this.renderList();
    try {
      await store.remove(slot.id);
      if (this.disposed) return;
      this.showStatus(`Sauvegarde supprimée : « ${slot.name} ».`, 'success');
      await this.reload();
    } catch (error) {
      if (this.disposed) return;
      this.showStatus(describeSaveError(error), 'error');
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.renderList();
      }
    }
  }

  private showStatus(text: string, tone: StatusTone): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.tone = tone;
    this.statusEl.hidden = false;
    this.scheduleScrollAffordance();
  }

  /** Signale par un dégradé qu'il reste des slots sous la zone visible. */
  private updateScrollAffordance(): void {
    if (this.disposed) return;
    const list = this.listEl;
    const scrollable = list.scrollHeight > list.clientHeight + 1;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    this.listShell.classList.toggle('is-scrollable', scrollable && !atBottom);
  }

  private scheduleScrollAffordance(): void {
    if (this.disposed) return;
    requestAnimationFrame(() => this.updateScrollAffordance());
  }

  private handleListScroll = (): void => {
    this.updateScrollAffordance();
  };

  private handleResize = (): void => {
    this.updateScrollAffordance();
  };

  override show(): void {
    super.show();
    window.addEventListener('resize', this.handleResize);
    this.scheduleScrollAffordance();
    this.nameInput?.focus();
  }

  override hide(): void {
    window.removeEventListener('resize', this.handleResize);
    super.hide();
  }

  override dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.handleResize);
    this.listEl.removeEventListener('scroll', this.handleListScroll);
    // Le `SaveStore` appartient au bootstrap : la session et l'autosave le
    // réutilisent après la fermeture de l'écran, on ne ferme donc pas la base.
    this.handle = null;
    this.store = null;
    super.dispose();
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.options.onBack();
  }
}
