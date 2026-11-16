/**
 * Écran « Salon » : slots, couleurs, prêt, chat, invitation et démarrage.
 *
 * L'écran ne décide de rien : il lit `Lobby.state` et n'envoie que des
 * intentions (`setReady`, `setColour`, `start`…). L'hôte reste l'unique
 * autorité, ce qui garantit que deux onglets affichent le même salon.
 */

import type { Lobby } from '../../net/lobby';
import type {
  AIDifficulty,
  Climate,
  LobbyEngine,
  LobbyState,
  MapSize,
  Slot,
  StartInfo,
} from '../../net/lobby-types';
import { LOBBY_COLOURS, LOBBY_ENGINES } from '../../net/lobby-types';
import { el, fieldLabel } from '../dom';
import { formatMoney } from '../format';
import { t, tn } from '../i18n';
import {
  MAP_SIZE_LABELS,
  buildRoomInvite,
  climateLabel,
  difficultyLabel,
  engineLabel,
  lobbyStartReadiness,
  type NetworkKind,
} from '../netlobby';
import { BaseScreen } from './BaseScreen';

export interface LobbyScreenOptions {
  lobby: Lobby;
  kind: NetworkKind;
  onStart: (info: StartInfo) => void;
  onLeave: () => void;
}

const COLOUR_SWATCHES = [
  '#e2706a',
  '#e6b45c',
  '#d8c07a',
  '#7fd4a0',
  '#7fb3e8',
  '#b28ae0',
  '#e08ab8',
  '#8ad9d2',
  '#f0a05a',
  '#b9d46a',
  '#6aa8e0',
  '#d06ad0',
  '#a0a0a0',
  '#e0e0e0',
  '#8a6a4a',
  '#4a6a8a',
] as const;

const CLIMATES: Climate[] = ['temperate', 'arctic', 'tropical', 'toyland'];
const DIFFICULTIES: AIDifficulty[] = ['easy', 'normal', 'hard'];
const MAP_SIZES: MapSize[] = [256, 512, 1024, 2048];
const MAX_PLAYERS = [2, 3, 4, 5, 6, 7, 8];

function baseUrl(): string {
  return typeof window === 'undefined' ? '' : window.location.href;
}

function tag(text: string, tone = ''): HTMLSpanElement {
  return el('span', { className: ['slot-tag', tone].filter(Boolean).join(' '), text });
}

export class LobbyScreen extends BaseScreen {
  private options: LobbyScreenOptions;
  private state: LobbyState;
  private title: HTMLHeadingElement;
  private codeValue: HTMLSpanElement;
  private roleBadge: HTMLSpanElement;
  private summary: HTMLParagraphElement;
  private error: HTMLParagraphElement;
  private slots: HTMLDivElement;
  private settingsBox: HTMLDivElement;
  private selfPanel: HTMLDivElement;
  private selfName!: HTMLInputElement;
  private selfCompany!: HTMLInputElement;
  private selfColour!: HTMLSelectElement;
  private readyButton: HTMLButtonElement;
  private startButton: HTMLButtonElement;
  private startHint: HTMLParagraphElement;
  private chatList: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private chatForm: HTMLFormElement;
  private inviteInput: HTMLInputElement;
  private copyButton: HTMLButtonElement;
  private copyStatus: HTMLSpanElement;
  private leaveButton: HTMLButtonElement;
  private confirmLeave: HTMLDivElement;
  private offs: (() => void)[] = [];
  private disposed = false;

  constructor(options: LobbyScreenOptions) {
    super('panel-screen lobby-screen');
    this.options = options;
    this.state = options.lobby.state;

    const panel = el('div', { className: 'panel panel-wide lobby-panel' });
    const header = el('div', { className: 'panel-header lobby-head' });
    const heading = el('div', { className: 'lobby-head-main' });
    this.roleBadge = el('span', {
      className: 'slot-tag',
      text: options.lobby.isHost ? t('lobby.role.host') : t('lobby.role.guest'),
    });
    this.title = el('h1', { className: 'panel-title', text: t('lobby.title') });
    this.codeValue = el('span', { className: 'lobby-code-value', text: '····' });
    const code = el('div', { className: 'lobby-code' });
    code.append(
      el('span', { className: 'field-label', text: t('lobby.codeLabel') }),
      this.codeValue,
    );
    this.summary = el('p', { className: 'panel-subtitle', text: t('lobby.connecting') });
    heading.append(el('div', { className: 'lobby-eyebrow' }), this.title, this.summary);
    heading
      .querySelector('.lobby-eyebrow')
      ?.append(
        el('span', { className: 'panel-eyebrow', text: t('lobby.eyebrow') }),
        this.roleBadge,
      );
    header.append(heading, code);
    this.error = el('p', {
      className: 'alert alert-error',
      text: '',
      attrs: { role: 'alert', 'aria-live': 'assertive' },
    });
    this.error.hidden = true;

    const body = el('div', { className: 'lobby-body' });
    const left = el('div', { className: 'lobby-column' });
    this.slots = el('div', {
      className: 'slot-list',
      attrs: { role: 'list', 'aria-label': t('lobby.playersAria') },
    });
    this.selfPanel = el('div', { className: 'lobby-self' });
    this.settingsBox = el('div', { className: 'lobby-settings' });
    this.startHint = el('p', { className: 'field-hint', text: '' });
    this.readyButton = el('button', {
      className: 'btn btn-primary',
      text: t('lobby.ready'),
      attrs: { type: 'button' },
    });
    this.readyButton.addEventListener('click', () => {
      const self = this.selfSlot();
      this.options.lobby.setReady(!(self?.ready ?? false));
    });
    this.startButton = el('button', {
      className: 'btn btn-primary',
      text: t('lobby.start'),
      attrs: { type: 'button' },
    });
    this.startButton.addEventListener('click', () => this.options.lobby.start());
    const actions = el('div', { className: 'panel-actions lobby-actions' });
    this.leaveButton = el('button', {
      className: 'btn btn-ghost',
      text: t('lobby.leave'),
      attrs: { type: 'button' },
    });
    this.leaveButton.addEventListener('click', () => this.showLeaveConfirm());
    actions.append(this.leaveButton, this.readyButton, this.startButton);
    left.append(this.slots, this.selfPanel, this.settingsBox, this.startHint, actions);

    const right = el('div', { className: 'lobby-column' });
    const invite = el('div', { className: 'lobby-invite' });
    const inviteLabel = fieldLabel(t('lobby.inviteLabel'), 'lobby-invite');
    this.inviteInput = el('input', {
      className: 'input lobby-invite-input',
      attrs: { id: 'lobby-invite', type: 'text', readonly: 'readonly', spellcheck: 'false' },
    });
    this.copyButton = el('button', {
      className: 'btn btn-ghost',
      text: t('lobby.copy'),
      attrs: { type: 'button' },
    });
    this.copyButton.addEventListener('click', () => void this.copyInvite());
    this.copyStatus = el('span', {
      className: 'field-hint',
      text: '',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    invite.append(inviteLabel, el('div', { className: 'field-row' }));
    const inviteRow = invite.querySelector('.field-row');
    inviteRow?.append(this.inviteInput, this.copyButton);
    invite.append(
      this.copyStatus,
      el('p', {
        className: 'field-hint',
        text: t('lobby.inviteHint'),
      }),
    );

    const chat = el('div', { className: 'lobby-chat' });
    chat.append(el('h2', { className: 'lobby-section-title', text: t('lobby.chat.title') }));
    this.chatList = el('div', {
      className: 'chat-list',
      attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': t('lobby.chat.aria') },
    });
    this.chatInput = el('input', {
      className: 'input',
      attrs: {
        id: 'lobby-chat-input',
        type: 'text',
        maxlength: '300',
        autocomplete: 'off',
        placeholder: t('lobby.chat.placeholder'),
      },
    });
    this.chatForm = el('form', { className: 'chat-form' });
    this.chatForm.append(
      this.chatInput,
      el('button', {
        className: 'btn btn-primary',
        text: t('lobby.chat.send'),
        attrs: { type: 'submit' },
      }),
    );
    this.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.chatInput.value;
      if (!text.trim()) return;
      this.options.lobby.sendChat(text);
      this.chatInput.value = '';
    });
    chat.append(this.chatList, this.chatForm);
    right.append(invite, chat);

    this.confirmLeave = el('div', {
      className: 'confirm lobby-leave-confirm',
      attrs: { role: 'alertdialog', 'aria-label': t('lobby.confirm.aria') },
    });
    const confirmText = el('p', {
      className: 'confirm-text',
      text: t('lobby.confirm.text'),
    });
    const confirmActions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', {
      className: 'btn btn-ghost',
      text: t('lobby.confirm.stay'),
      attrs: { type: 'button' },
    });
    cancel.addEventListener('click', () => this.hideLeaveConfirm());
    const quit = el('button', {
      className: 'btn btn-danger',
      text: t('lobby.leave'),
      attrs: { type: 'button' },
    });
    quit.addEventListener('click', () => this.options.onLeave());
    confirmActions.append(cancel, quit);
    this.confirmLeave.append(confirmText, confirmActions);
    this.confirmLeave.hidden = true;

    body.append(left, right);
    panel.append(header, this.error, body, this.confirmLeave);
    this.element.append(panel);

    this.buildSelfPanel();

    this.offs.push(options.lobby.onChange((state) => this.applyState(state)));
    this.offs.push(options.lobby.onError((message) => this.showError(message)));
    this.offs.push(options.lobby.onChat((event) => this.appendChat(event.name, event.text)));
    this.offs.push(
      options.lobby.onStart((info) => {
        this.options.onStart(info);
      }),
    );

    this.applyState(options.lobby.state);
  }

  private required<T extends HTMLElement>(id: string): T {
    const node = this.element.querySelector<T>(`#${id}`);
    if (!node) throw new Error(t('lobby.error.missing', { id }));
    return node;
  }

  private get lobby(): Lobby {
    return this.options.lobby;
  }

  private selfSlot(): Slot | undefined {
    return this.state.slots.find((slot) => slot.id === this.options.lobby.selfId);
  }

  private bindSelf(): void {
    this.selfName.addEventListener('change', () => this.lobby.setName(this.selfName.value));
    this.selfCompany.addEventListener('change', () =>
      this.lobby.setCompanyName(this.selfCompany.value),
    );
    this.selfColour.addEventListener('change', () =>
      this.lobby.setColour(Number(this.selfColour.value)),
    );
  }

  private buildSelfPanel(): void {
    this.selfPanel.replaceChildren();
    const head = el('h2', { className: 'lobby-section-title', text: t('lobby.self.title') });
    const grid = el('div', { className: 'lobby-self-grid' });

    const nameField = el('div', { className: 'field' });
    this.selfName = el('input', {
      className: 'input',
      attrs: {
        id: 'lobby-self-name',
        type: 'text',
        maxlength: '24',
        autocomplete: 'nickname',
      },
    });
    nameField.append(fieldLabel(t('lobby.field.name'), 'lobby-self-name'), this.selfName);

    const companyField = el('div', { className: 'field' });
    this.selfCompany = el('input', {
      className: 'input',
      attrs: {
        id: 'lobby-self-company',
        type: 'text',
        maxlength: '32',
        autocomplete: 'organization',
        placeholder: t('lobby.company.placeholder'),
      },
    });
    companyField.append(
      fieldLabel(t('lobby.field.company'), 'lobby-self-company'),
      this.selfCompany,
    );

    const colourField = el('div', { className: 'field' });
    this.selfColour = el('select', {
      className: 'input',
      attrs: { id: 'lobby-self-colour' },
    });
    for (let colour = 0; colour < LOBBY_COLOURS; colour++) {
      this.selfColour.append(
        el('option', {
          text: t('lobby.colour.option', { index: colour + 1 }),
          attrs: { value: `${colour}` },
        }),
      );
    }
    colourField.append(fieldLabel(t('lobby.field.colour'), 'lobby-self-colour'), this.selfColour);

    grid.append(nameField, companyField, colourField);
    this.selfPanel.append(head, grid);
    this.bindSelf();
  }

  private applyState(state: LobbyState): void {
    if (this.disposed) return;
    this.state = state;
    this.title.textContent = state.name || t('lobby.title');
    this.codeValue.textContent = state.roomId.toUpperCase();
    this.roleBadge.textContent = this.lobby.isHost ? t('lobby.role.host') : t('lobby.role.guest');
    this.roleBadge.classList.toggle('is-host', this.lobby.isHost);
    this.summary.textContent = this.describeState(state);
    this.inviteInput.value =
      state.hostId.length > 0
        ? buildRoomInvite(state.roomId, state.hostId, this.options.kind, baseUrl())
        : '';
    this.inviteInput.disabled = state.hostId.length === 0;

    if (state.error) this.showError(state.error);
    else if (!state.closed) this.error.hidden = true;

    this.renderSlots();
    this.renderSettings();
    this.renderSelf();
    this.renderActions();
    this.chatForm.querySelectorAll('input, button').forEach((node) => {
      (node as HTMLInputElement | HTMLButtonElement).disabled = state.closed || state.started;
    });
  }

  private describeState(state: LobbyState): string {
    if (state.closed) return t('lobby.state.closed');
    if (state.started) return t('lobby.state.started');
    const humans = state.slots.filter((slot) => slot.ai === null).length;
    const ai = state.slots.length - humans;
    const pieces = [
      tn(humans, 'lobby.summary.humans.one', 'lobby.summary.humans.other'),
      ai > 0 ? t('lobby.summary.ai', { count: ai }) : null,
      t('lobby.summary.places', { count: state.slots.length, max: state.maxPlayers }),
    ].filter((value): value is string => value !== null);
    return pieces.join(' · ');
  }

  private renderSlots(): void {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement ? (active.dataset.focusKey ?? null) : null;
    this.slots.replaceChildren();

    if (this.state.slots.length === 0) {
      this.slots.append(el('p', { className: 'field-hint', text: t('lobby.awaiting') }));
    }

    this.state.slots.forEach((slot, index) => {
      const row = el('div', {
        className: ['slot-row', slot.connected ? '' : 'is-offline'].filter(Boolean).join(' '),
        attrs: { role: 'listitem' },
      });
      const swatch = el('span', { className: 'slot-swatch', attrs: { 'aria-hidden': 'true' } });
      swatch.style.background = COLOUR_SWATCHES[slot.colour] ?? '#888';
      const identity = el('div', { className: 'slot-identity' });
      identity.append(
        el('span', { className: 'slot-name', text: slot.name }),
        el('span', {
          className: 'slot-company',
          text: slot.companyName || t('lobby.company.unnamed'),
        }),
      );
      row.append(swatch, identity);

      const tags = el('div', { className: 'slot-tags' });
      if (slot.isHost) tags.append(tag(t('lobby.tag.host'), 'is-host'));
      if (slot.ai)
        tags.append(tag(t('lobby.tag.ai', { difficulty: difficultyLabel(slot.ai) }), 'is-ai'));
      if (slot.id === this.lobby.selfId) tags.append(tag(t('lobby.tag.self'), 'is-self'));
      if (slot.ai === null && (slot.isHost || slot.ready))
        tags.append(tag(t('lobby.tag.ready'), 'is-ready'));
      if (!slot.connected) tags.append(tag(t('lobby.tag.offline'), 'is-offline'));
      row.append(tags);

      if (this.lobby.isHost) {
        const controls = el('div', { className: 'slot-controls' });
        const colour = el('select', {
          className: 'input input-compact',
          attrs: {
            'aria-label': t('lobby.slot.colourAria', { name: slot.name }),
            'data-focus-key': `slot-colour-${index}`,
          },
        });
        for (let value = 0; value < LOBBY_COLOURS; value++) {
          const option = el('option', { text: `${value + 1}`, attrs: { value: `${value}` } });
          option.selected = value === slot.colour;
          colour.append(option);
        }
        colour.addEventListener('change', () =>
          this.lobby.setSlotColour(index, Number(colour.value)),
        );
        controls.append(colour);
        if (!slot.isHost) {
          const remove = el('button', {
            className: 'btn btn-ghost btn-compact',
            text: slot.ai ? t('lobby.slot.remove') : t('lobby.slot.exclude'),
            attrs: { type: 'button', 'data-focus-key': `slot-remove-${index}` },
          });
          remove.addEventListener('click', () => this.lobby.removeSlot(index));
          controls.append(remove);
        }
        row.append(controls);
      }

      this.slots.append(row);
    });

    if (this.lobby.isHost) {
      const addRow = el('div', { className: 'slot-add' });
      const difficulty = el('select', {
        className: 'input input-compact',
        attrs: { 'aria-label': t('lobby.ai.difficultyAria') },
      });
      for (const value of DIFFICULTIES) {
        const option = el('option', {
          text: t('lobby.tag.ai', { difficulty: difficultyLabel(value) }),
          attrs: { value },
        });
        option.selected = value === 'normal';
        difficulty.append(option);
      }
      const add = el('button', {
        className: 'btn btn-ghost btn-compact',
        text: t('lobby.ai.add'),
        attrs: { type: 'button' },
      });
      add.addEventListener('click', () =>
        this.lobby.addAI((difficulty.value as AIDifficulty) ?? 'normal'),
      );
      addRow.append(difficulty, add);
      if (this.state.slots.length < this.state.maxPlayers) this.slots.append(addRow);
    }

    if (focusKey) {
      this.slots.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
    }
  }

  private renderSettings(): void {
    this.settingsBox.replaceChildren();
    const settings = this.state.settings;
    const head = el('h2', { className: 'lobby-section-title', text: t('lobby.settings.title') });
    this.settingsBox.append(head);

    if (this.lobby.isHost && !this.state.started && !this.state.closed) {
      const grid = el('div', { className: 'lobby-settings-grid' });
      grid.append(
        this.settingSelect(
          t('lobby.setting.engine'),
          LOBBY_ENGINES.map((value) => ({ value, label: engineLabel(value) })),
          settings.engine,
          (value) => this.lobby.setSettings({ engine: value as LobbyEngine }),
        ),
        this.settingSelect(
          t('lobby.setting.size'),
          MAP_SIZES.map((size) => ({ value: `${size}`, label: MAP_SIZE_LABELS[size] })),
          `${settings.mapSize}`,
          (value) => this.lobby.setSettings({ mapSize: Number(value) as MapSize }),
        ),
        this.settingSelect(
          t('lobby.setting.climate'),
          CLIMATES.map((value) => ({ value, label: climateLabel(value) })),
          settings.climate,
          (value) => this.lobby.setSettings({ climate: value as Climate }),
        ),
        this.settingSelect(
          t('lobby.setting.difficulty'),
          DIFFICULTIES.map((value) => ({ value, label: difficultyLabel(value) })),
          settings.difficulty,
          (value) => this.lobby.setSettings({ difficulty: value as AIDifficulty }),
        ),
        this.settingSelect(
          t('lobby.setting.maxPlayers'),
          MAX_PLAYERS.map((value) => ({ value: `${value}`, label: `${value}` })),
          `${settings.maxPlayers}`,
          (value) => this.lobby.setSettings({ maxPlayers: Number(value) }),
        ),
        this.settingSelect(
          t('lobby.setting.capital'),
          [50000, 100000, 250000, 500000].map((value) => ({
            value: `${value}`,
            label: formatMoney(value),
          })),
          `${settings.startingMoney}`,
          (value) => this.lobby.setSettings({ startingMoney: Number(value) }),
        ),
      );
      this.settingsBox.append(grid);
      return;
    }

    const badges = el('div', { className: 'menu-badges' });
    badges.append(
      el('span', { className: 'badge', text: engineLabel(settings.engine) }),
      el('span', {
        className: 'badge',
        text: t('lobby.badge.map', { size: MAP_SIZE_LABELS[settings.mapSize] }),
      }),
      el('span', { className: 'badge', text: climateLabel(settings.climate) }),
      el('span', {
        className: 'badge',
        text: t('lobby.badge.difficulty', {
          difficulty: difficultyLabel(settings.difficulty),
        }),
      }),
      el('span', { className: 'badge', text: formatMoney(settings.startingMoney) }),
      el('span', {
        className: 'badge',
        text: t('lobby.badge.places', { count: settings.maxPlayers }),
      }),
    );
    this.settingsBox.append(badges);
  }

  private settingSelect(
    label: string,
    entries: { value: string; label: string }[],
    selected: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const field = el('div', { className: 'field' });
    const id = `lobby-setting-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    const select = el('select', { className: 'input input-compact', attrs: { id } });
    for (const entry of entries) {
      const option = el('option', { text: entry.label, attrs: { value: entry.value } });
      option.selected = entry.value === selected;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    field.append(fieldLabel(label, id), select);
    return field;
  }

  private renderSelf(): void {
    const self = this.selfSlot();
    if (!self) {
      this.selfPanel.hidden = true;
      return;
    }
    this.selfPanel.hidden = false;
    if (document.activeElement !== this.selfName) this.selfName.value = self.name;
    if (document.activeElement !== this.selfCompany) this.selfCompany.value = self.companyName;
    if (document.activeElement !== this.selfColour) this.selfColour.value = `${self.colour}`;
    this.selfName.disabled = this.state.closed || this.state.started;
    this.selfCompany.disabled = this.state.closed || this.state.started;
    this.selfColour.disabled = this.state.closed || this.state.started;
  }

  private renderActions(): void {
    const self = this.selfSlot();
    const readiness = lobbyStartReadiness(this.state);
    const isClient = !this.lobby.isHost;
    this.readyButton.hidden = !isClient;
    this.readyButton.textContent = self?.ready ? t('lobby.readyCancel') : t('lobby.ready');
    this.readyButton.classList.toggle('is-primary', !self?.ready);
    this.readyButton.classList.toggle('btn-ghost', Boolean(self?.ready));
    this.readyButton.disabled = this.state.closed || this.state.started;

    this.startButton.hidden = !this.lobby.isHost;
    this.startButton.disabled = !readiness.ready;
    this.startHint.textContent = this.startHintText(readiness);
  }

  private startHintText(readiness: ReturnType<typeof lobbyStartReadiness>): string {
    if (this.state.closed) return t('lobby.startHint.closed');
    if (this.state.started) return t('lobby.startHint.started');
    if (this.state.slots.length < 2) {
      return t('lobby.startHint.minPlayers');
    }
    if (readiness.waiting.length > 0) {
      return t('lobby.startHint.waiting', { names: readiness.waiting.join(', ') });
    }
    if (!this.lobby.isHost) {
      const self = this.selfSlot();
      return self?.ready ? t('lobby.startHint.readyClient') : t('lobby.startHint.notReadyClient');
    }
    return t('lobby.startHint.allReady');
  }

  private appendChat(name: string, text: string): void {
    const row = el('div', { className: 'chat-message' });
    row.append(
      el('span', { className: 'chat-author', text: name }),
      el('span', { className: 'chat-text', text }),
    );
    this.chatList.append(row);
    this.chatList.scrollTop = this.chatList.scrollHeight;
  }

  private async copyInvite(): Promise<void> {
    const value = this.inviteInput.value;
    if (!value) {
      this.copyStatus.textContent = t('lobby.copy.unavailable');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      this.copyStatus.textContent = t('lobby.copy.copied');
    } catch {
      this.inviteInput.focus();
      this.inviteInput.select();
      this.copyStatus.textContent = t('lobby.copy.manual');
    }
  }

  private showLeaveConfirm(): void {
    this.confirmLeave.hidden = false;
    this.leaveButton.disabled = true;
    this.confirmLeave.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private hideLeaveConfirm(): void {
    this.confirmLeave.hidden = true;
    this.leaveButton.disabled = false;
    this.leaveButton.focus();
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!this.confirmLeave.hidden) this.hideLeaveConfirm();
    else this.showLeaveConfirm();
  }

  override dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    super.dispose();
  }
}
