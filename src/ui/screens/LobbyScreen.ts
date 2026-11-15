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
import {
  CLIMATE_LABELS,
  DIFFICULTY_LABELS,
  ENGINE_LABELS,
  MAP_SIZE_LABELS,
  buildRoomInvite,
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
      text: options.lobby.isHost ? 'Hôte' : 'Invité',
    });
    this.title = el('h1', { className: 'panel-title', text: 'Salon' });
    this.codeValue = el('span', { className: 'lobby-code-value', text: '····' });
    const code = el('div', { className: 'lobby-code' });
    code.append(el('span', { className: 'field-label', text: 'Code du salon' }), this.codeValue);
    this.summary = el('p', { className: 'panel-subtitle', text: 'Connexion au salon…' });
    heading.append(el('div', { className: 'lobby-eyebrow' }), this.title, this.summary);
    heading
      .querySelector('.lobby-eyebrow')
      ?.append(
        el('span', { className: 'panel-eyebrow', text: 'Salon multijoueur' }),
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
      attrs: { role: 'list', 'aria-label': 'Joueurs du salon' },
    });
    this.selfPanel = el('div', { className: 'lobby-self' });
    this.settingsBox = el('div', { className: 'lobby-settings' });
    this.startHint = el('p', { className: 'field-hint', text: '' });
    this.readyButton = el('button', {
      className: 'btn btn-primary',
      text: 'Je suis prêt',
      attrs: { type: 'button' },
    });
    this.readyButton.addEventListener('click', () => {
      const self = this.selfSlot();
      this.options.lobby.setReady(!(self?.ready ?? false));
    });
    this.startButton = el('button', {
      className: 'btn btn-primary',
      text: 'Démarrer la partie',
      attrs: { type: 'button' },
    });
    this.startButton.addEventListener('click', () => this.options.lobby.start());
    const actions = el('div', { className: 'panel-actions lobby-actions' });
    this.leaveButton = el('button', {
      className: 'btn btn-ghost',
      text: 'Quitter le salon',
      attrs: { type: 'button' },
    });
    this.leaveButton.addEventListener('click', () => this.showLeaveConfirm());
    actions.append(this.leaveButton, this.readyButton, this.startButton);
    left.append(this.slots, this.selfPanel, this.settingsBox, this.startHint, actions);

    const right = el('div', { className: 'lobby-column' });
    const invite = el('div', { className: 'lobby-invite' });
    const inviteLabel = fieldLabel('Lien d’invitation', 'lobby-invite');
    this.inviteInput = el('input', {
      className: 'input lobby-invite-input',
      attrs: { id: 'lobby-invite', type: 'text', readonly: 'readonly', spellcheck: 'false' },
    });
    this.copyButton = el('button', {
      className: 'btn btn-ghost',
      text: 'Copier',
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
        text: 'Toute personne avec ce lien rejoint directement ce salon.',
      }),
    );

    const chat = el('div', { className: 'lobby-chat' });
    chat.append(el('h2', { className: 'lobby-section-title', text: 'Chat du salon' }));
    this.chatList = el('div', {
      className: 'chat-list',
      attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages du salon' },
    });
    this.chatInput = el('input', {
      className: 'input',
      attrs: {
        id: 'lobby-chat-input',
        type: 'text',
        maxlength: '300',
        autocomplete: 'off',
        placeholder: 'Votre message…',
      },
    });
    this.chatForm = el('form', { className: 'chat-form' });
    this.chatForm.append(
      this.chatInput,
      el('button', { className: 'btn btn-primary', text: 'Envoyer', attrs: { type: 'submit' } }),
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
      attrs: { role: 'alertdialog', 'aria-label': 'Confirmer la sortie du salon' },
    });
    const confirmText = el('p', {
      className: 'confirm-text',
      text: 'Quitter ce salon ? Vous pourrez rejoindre une autre partie depuis le menu.',
    });
    const confirmActions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', {
      className: 'btn btn-ghost',
      text: 'Rester',
      attrs: { type: 'button' },
    });
    cancel.addEventListener('click', () => this.hideLeaveConfirm());
    const quit = el('button', {
      className: 'btn btn-danger',
      text: 'Quitter le salon',
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
    if (!node) throw new Error(`Élément #${id} introuvable dans l’écran salon`);
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
    const head = el('h2', { className: 'lobby-section-title', text: 'Votre place' });
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
    nameField.append(fieldLabel('Nom', 'lobby-self-name'), this.selfName);

    const companyField = el('div', { className: 'field' });
    this.selfCompany = el('input', {
      className: 'input',
      attrs: {
        id: 'lobby-self-company',
        type: 'text',
        maxlength: '32',
        autocomplete: 'organization',
        placeholder: 'Nom de l’entreprise',
      },
    });
    companyField.append(fieldLabel('Entreprise', 'lobby-self-company'), this.selfCompany);

    const colourField = el('div', { className: 'field' });
    this.selfColour = el('select', {
      className: 'input',
      attrs: { id: 'lobby-self-colour' },
    });
    for (let colour = 0; colour < LOBBY_COLOURS; colour++) {
      this.selfColour.append(
        el('option', { text: `Couleur ${colour + 1}`, attrs: { value: `${colour}` } }),
      );
    }
    colourField.append(fieldLabel('Couleur', 'lobby-self-colour'), this.selfColour);

    grid.append(nameField, companyField, colourField);
    this.selfPanel.append(head, grid);
    this.bindSelf();
  }

  private applyState(state: LobbyState): void {
    if (this.disposed) return;
    this.state = state;
    this.title.textContent = state.name || 'Salon';
    this.codeValue.textContent = state.roomId.toUpperCase();
    this.roleBadge.textContent = this.lobby.isHost ? 'Hôte' : 'Invité';
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
    if (state.closed) return 'Salon fermé.';
    if (state.started) return 'La partie a démarré.';
    const humans = state.slots.filter((slot) => slot.ai === null).length;
    const ai = state.slots.length - humans;
    const pieces = [
      `${humans} joueur${humans > 1 ? 's' : ''}`,
      ai > 0 ? `${ai} IA` : null,
      `${state.slots.length}/${state.maxPlayers} places`,
    ].filter((value): value is string => value !== null);
    return pieces.join(' · ');
  }

  private renderSlots(): void {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement ? (active.dataset.focusKey ?? null) : null;
    this.slots.replaceChildren();

    if (this.state.slots.length === 0) {
      this.slots.append(
        el('p', { className: 'field-hint', text: 'En attente de l’état du salon…' }),
      );
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
          text: slot.companyName || 'Entreprise à nommer',
        }),
      );
      row.append(swatch, identity);

      const tags = el('div', { className: 'slot-tags' });
      if (slot.isHost) tags.append(tag('Hôte', 'is-host'));
      if (slot.ai) tags.append(tag(`IA ${DIFFICULTY_LABELS[slot.ai]}`, 'is-ai'));
      if (slot.id === this.lobby.selfId) tags.append(tag('Vous', 'is-self'));
      if (slot.ai === null && (slot.isHost || slot.ready)) tags.append(tag('Prêt', 'is-ready'));
      if (!slot.connected) tags.append(tag('Hors ligne', 'is-offline'));
      row.append(tags);

      if (this.lobby.isHost) {
        const controls = el('div', { className: 'slot-controls' });
        const colour = el('select', {
          className: 'input input-compact',
          attrs: {
            'aria-label': `Couleur de ${slot.name}`,
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
            text: slot.ai ? 'Retirer' : 'Exclure',
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
        attrs: { 'aria-label': 'Difficulté de l’IA à ajouter' },
      });
      for (const value of DIFFICULTIES) {
        const option = el('option', { text: `IA ${DIFFICULTY_LABELS[value]}`, attrs: { value } });
        option.selected = value === 'normal';
        difficulty.append(option);
      }
      const add = el('button', {
        className: 'btn btn-ghost btn-compact',
        text: 'Ajouter une IA',
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
    const head = el('h2', { className: 'lobby-section-title', text: 'Réglages de la partie' });
    this.settingsBox.append(head);

    if (this.lobby.isHost && !this.state.started && !this.state.closed) {
      const grid = el('div', { className: 'lobby-settings-grid' });
      grid.append(
        this.settingSelect(
          'Moteur',
          LOBBY_ENGINES.map((value) => ({ value, label: ENGINE_LABELS[value] })),
          settings.engine,
          (value) => this.lobby.setSettings({ engine: value as LobbyEngine }),
        ),
        this.settingSelect(
          'Taille',
          MAP_SIZES.map((size) => ({ value: `${size}`, label: MAP_SIZE_LABELS[size] })),
          `${settings.mapSize}`,
          (value) => this.lobby.setSettings({ mapSize: Number(value) as MapSize }),
        ),
        this.settingSelect(
          'Climat',
          CLIMATES.map((value) => ({ value, label: CLIMATE_LABELS[value] })),
          settings.climate,
          (value) => this.lobby.setSettings({ climate: value as Climate }),
        ),
        this.settingSelect(
          'Difficulté',
          DIFFICULTIES.map((value) => ({ value, label: DIFFICULTY_LABELS[value] })),
          settings.difficulty,
          (value) => this.lobby.setSettings({ difficulty: value as AIDifficulty }),
        ),
        this.settingSelect(
          'Joueurs max.',
          MAX_PLAYERS.map((value) => ({ value: `${value}`, label: `${value}` })),
          `${settings.maxPlayers}`,
          (value) => this.lobby.setSettings({ maxPlayers: Number(value) }),
        ),
        this.settingSelect(
          'Capital',
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
      el('span', { className: 'badge', text: ENGINE_LABELS[settings.engine] }),
      el('span', { className: 'badge', text: `Carte ${MAP_SIZE_LABELS[settings.mapSize]}` }),
      el('span', { className: 'badge', text: CLIMATE_LABELS[settings.climate] }),
      el('span', {
        className: 'badge',
        text: `Difficulté ${DIFFICULTY_LABELS[settings.difficulty]}`,
      }),
      el('span', { className: 'badge', text: formatMoney(settings.startingMoney) }),
      el('span', { className: 'badge', text: `${settings.maxPlayers} places` }),
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
    this.readyButton.textContent = self?.ready ? 'Annuler « prêt »' : 'Je suis prêt';
    this.readyButton.classList.toggle('is-primary', !self?.ready);
    this.readyButton.classList.toggle('btn-ghost', Boolean(self?.ready));
    this.readyButton.disabled = this.state.closed || this.state.started;

    this.startButton.hidden = !this.lobby.isHost;
    this.startButton.disabled = !readiness.ready;
    this.startHint.textContent = this.startHintText(readiness);
  }

  private startHintText(readiness: ReturnType<typeof lobbyStartReadiness>): string {
    if (this.state.closed) return 'Le salon est fermé.';
    if (this.state.started) return 'La partie a démarré.';
    if (this.state.slots.length < 2) {
      return 'Il faut au moins deux participants (IA incluse) pour démarrer.';
    }
    if (readiness.waiting.length > 0) {
      return `En attente de : ${readiness.waiting.join(', ')}.`;
    }
    if (!this.lobby.isHost) {
      const self = this.selfSlot();
      return self?.ready
        ? 'Prêt : l’hôte peut démarrer la partie.'
        : 'Marquez-vous prêt pour permettre le démarrage.';
    }
    return 'Tout le monde est prêt : vous pouvez démarrer.';
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
      this.copyStatus.textContent = 'Lien pas encore disponible.';
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      this.copyStatus.textContent = 'Lien copié dans le presse-papiers.';
    } catch {
      this.inviteInput.focus();
      this.inviteInput.select();
      this.copyStatus.textContent = 'Lien sélectionné : copiez-le avec Ctrl+C / Cmd+C.';
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
