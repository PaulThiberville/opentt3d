/**
 * Écran « Multijoueur » : création d'un salon et rejoindre une partie.
 *
 * L'écran ne possède ni transport ni salon : il collecte les intentions et
 * affiche l'annuaire fourni par le bootstrap. Cela garde les écrans testables
 * sans DOM réseau et laisse `main.ts` seul propriétaire des ressources P2P.
 */

import type { Directory, LobbyInfo } from '../../net/directory';
import type { AIDifficulty } from '../../net/lobby-types';
import { el, fieldLabel } from '../dom';
import { parseSeed, randomSeed } from '../gameOptions';
import { t } from '../i18n';
import { MAP_SIZE_LABELS, parseJoinTarget, type JoinTarget, type NetworkKind } from '../netlobby';
import { BaseScreen } from './BaseScreen';

export interface CreateRoomRequest {
  lobbyName: string;
  playerName: string;
  isPublic: boolean;
  mapSize: 256 | 512;
  difficulty: AIDifficulty;
  seed: number;
}

export interface MultiplayerScreenOptions {
  kind: NetworkKind;
  directory: Directory | null;
  initialName: string;
  initialJoin?: string;
  notice?: string | null;
  onCreate: (request: CreateRoomRequest) => void;
  onJoin: (target: JoinTarget, playerName: string) => void;
  onBack: () => void;
}

const ROOM_SIZES: (256 | 512)[] = [256, 512];

function statusLabel(info: LobbyInfo): string {
  if (info.status === 'full') return t('mp.status.full');
  if (info.status === 'started') return t('mp.status.started');
  return t('mp.status.players', { players: info.players, max: info.max });
}

export class MultiplayerScreen extends BaseScreen {
  private options: MultiplayerScreenOptions;
  private lobbyNameInput!: HTMLInputElement;
  private playerNameInput!: HTMLInputElement;
  private seedInput!: HTMLInputElement;
  private difficultySelect!: HTMLSelectElement;
  private sizeInputs: HTMLInputElement[] = [];
  private publicInput!: HTMLInputElement;
  private privateInput!: HTMLInputElement;
  private createError!: HTMLParagraphElement;
  private joinNameInput!: HTMLInputElement;
  private joinInput!: HTMLInputElement;
  private joinError!: HTMLParagraphElement;
  private lobbyList!: HTMLDivElement;
  private lobbyEmpty!: HTMLParagraphElement;
  private refreshButton!: HTMLButtonElement;
  private directoryOff: (() => void) | null = null;
  private disposed = false;

  constructor(options: MultiplayerScreenOptions) {
    super('panel-screen multiplayer-screen');
    this.options = options;

    const panel = el('div', { className: 'panel panel-wide' });
    const header = el('div', { className: 'panel-header' });
    const modeBadge = options.kind === 'local' ? t('mp.mode.local') : t('mp.mode.trystero');
    header.append(
      el('span', { className: 'panel-eyebrow', text: t('mp.eyebrow') }),
      el('h1', { className: 'panel-title', text: t('mp.title') }),
      el('p', {
        className: 'panel-subtitle',
        text: t('mp.subtitle'),
      }),
      el('div', { className: 'menu-badges' }),
    );
    const badges = header.querySelector('.menu-badges');
    badges?.append(
      el('span', { className: 'badge', text: modeBadge }),
      el('span', { className: 'badge', text: t('mp.badge.lockstep') }),
    );

    if (options.notice) {
      const alert = el('p', { className: 'alert alert-error', text: options.notice });
      header.append(alert);
    }

    const columns = el('div', { className: 'multiplayer-columns' });
    columns.append(this.buildCreatePanel(), this.buildJoinPanel());
    panel.append(header, columns, this.buildFooter());
    this.element.append(panel);

    this.lobbyNameInput = this.required<HTMLInputElement>('mp-lobby-name');
    this.playerNameInput = this.required<HTMLInputElement>('mp-player-name');
    this.seedInput = this.required<HTMLInputElement>('mp-seed');
    this.difficultySelect = this.required<HTMLSelectElement>('mp-difficulty');
    this.publicInput = this.required<HTMLInputElement>('mp-public');
    this.privateInput = this.required<HTMLInputElement>('mp-private');
    this.createError = this.required<HTMLParagraphElement>('mp-create-error');
    this.joinNameInput = this.required<HTMLInputElement>('mp-join-name');
    this.joinInput = this.required<HTMLInputElement>('mp-join');
    this.joinError = this.required<HTMLParagraphElement>('mp-join-error');
    this.lobbyList = this.required<HTMLDivElement>('mp-lobbies');
    this.lobbyEmpty = this.required<HTMLParagraphElement>('mp-lobbies-empty');
    this.refreshButton = this.required<HTMLButtonElement>('mp-refresh');

    this.lobbyNameInput.value = t('mp.lobby.defaultName', { name: options.initialName });
    this.playerNameInput.value = options.initialName;
    this.joinNameInput.value = options.initialName;
    this.seedInput.value = String(randomSeed());
    if (options.initialJoin) this.joinInput.value = options.initialJoin;

    this.sizeInputs = Array.from(
      this.element.querySelectorAll<HTMLInputElement>('input[name="mp-size"]'),
    );

    this.bindCreate();
    this.bindJoin();

    this.directoryOff =
      options.directory?.subscribe((lobbies) => this.renderLobbies(lobbies)) ?? null;
    this.renderLobbies([]);
  }

  private required<T extends HTMLElement>(id: string): T {
    const node = this.element.querySelector<T>(`#${id}`);
    if (!node) throw new Error(t('mp.error.missing', { id }));
    return node;
  }

  private buildCreatePanel(): HTMLElement {
    const section = el('section', {
      className: 'multiplayer-card',
      attrs: { 'aria-labelledby': 'mp-create-title' },
    });
    const heading = el('div', { className: 'multiplayer-card-head' });
    heading.append(
      el('h2', {
        className: 'multiplayer-card-title',
        text: t('mp.create.title'),
        attrs: { id: 'mp-create-title' },
      }),
      el('p', {
        className: 'field-hint',
        text: t('mp.create.hint'),
      }),
    );

    const form = el('form', {
      className: 'form multiplayer-form',
      attrs: { id: 'mp-create-form', novalidate: '' },
    });
    const lobbyField = el('div', { className: 'field field-full' });
    lobbyField.append(
      fieldLabel(t('mp.field.lobbyName'), 'mp-lobby-name'),
      el('input', {
        className: 'input',
        attrs: {
          id: 'mp-lobby-name',
          name: 'lobbyName',
          type: 'text',
          maxlength: '32',
          autocomplete: 'off',
          'data-autofocus': '',
        },
      }),
    );

    const playerField = el('div', { className: 'field field-full' });
    playerField.append(
      fieldLabel(t('mp.field.playerName'), 'mp-player-name'),
      el('input', {
        className: 'input',
        attrs: {
          id: 'mp-player-name',
          name: 'playerName',
          type: 'text',
          maxlength: '24',
          autocomplete: 'nickname',
        },
      }),
    );

    const visibility = el('fieldset', { className: 'field field-full' });
    visibility.append(el('legend', { className: 'field-label', text: t('mp.field.visibility') }));
    const visibilitySegments = el('div', { className: 'segmented' });
    visibilitySegments.append(
      this.radioSegment('mp-public', 'mp-visibility', 'public', t('mp.visibility.public'), true) ??
        el('span'),
      this.radioSegment(
        'mp-private',
        'mp-visibility',
        'private',
        t('mp.visibility.private'),
        false,
      ) ?? el('span'),
    );
    visibility.append(
      visibilitySegments,
      el('p', {
        className: 'field-hint',
        text: t('mp.hint.visibility'),
      }),
    );

    const sizes = el('fieldset', { className: 'field field-full' });
    sizes.append(el('legend', { className: 'field-label', text: t('mp.field.mapSize') }));
    const sizeSegments = el('div', { className: 'segmented' });
    for (const size of ROOM_SIZES) {
      const label = el('label', { className: 'segment' });
      const input = el('input', {
        attrs: {
          type: 'radio',
          name: 'mp-size',
          value: `${size}`,
          ...(size === 256 ? { checked: 'checked' } : {}),
        },
      });
      label.append(input, el('span', { text: MAP_SIZE_LABELS[size] }));
      sizeSegments.append(label);
    }
    sizes.append(
      sizeSegments,
      el('p', {
        className: 'field-hint',
        text: t('mp.hint.mapSize'),
      }),
    );

    const seedField = el('div', { className: 'field' });
    const seedRow = el('div', { className: 'field-row' });
    const seedInput = el('input', {
      className: 'input',
      attrs: {
        id: 'mp-seed',
        name: 'seed',
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    });
    const randomButton = el('button', {
      className: 'btn btn-ghost',
      text: t('mp.random'),
      attrs: { type: 'button', title: t('mp.randomTitle') },
    });
    randomButton.addEventListener('click', () => {
      seedInput.value = String(randomSeed());
      seedInput.focus();
    });
    seedRow.append(seedInput, randomButton);
    seedField.append(fieldLabel(t('mp.field.seed'), 'mp-seed'), seedRow);

    const difficultyField = el('div', { className: 'field' });
    const difficultySelect = el('select', {
      className: 'input',
      attrs: { id: 'mp-difficulty', name: 'difficulty' },
    });
    for (const entry of [
      { value: 'easy', label: t('difficulty.easy') },
      { value: 'normal', label: t('difficulty.normal') },
      { value: 'hard', label: t('difficulty.hard') },
    ]) {
      const option = el('option', { text: entry.label, attrs: { value: entry.value } });
      option.selected = entry.value === 'normal';
      difficultySelect.append(option);
    }
    difficultyField.append(fieldLabel(t('mp.field.difficulty'), 'mp-difficulty'), difficultySelect);

    this.createError = el('p', {
      className: 'field-error',
      attrs: { id: 'mp-create-error', role: 'alert' },
    });
    this.createError.hidden = true;

    form.append(
      lobbyField,
      playerField,
      visibility,
      sizes,
      seedField,
      difficultyField,
      this.createError,
    );
    const actions = el('div', { className: 'panel-actions panel-actions-column' });
    const create = el('button', {
      className: 'btn btn-primary',
      text: t('mp.create.submit'),
      attrs: { type: 'submit' },
    });
    actions.append(create);
    form.append(actions);

    section.append(heading, form);
    return section;
  }

  private radioSegment(
    id: string,
    name: string,
    value: string,
    label: string,
    checked: boolean,
  ): HTMLLabelElement {
    const wrapper = el('label', { className: 'segment' });
    const input = el('input', {
      attrs: {
        type: 'radio',
        id,
        name,
        value,
        ...(checked ? { checked: 'checked' } : {}),
      },
    });
    wrapper.append(input, el('span', { text: label }));
    return wrapper;
  }

  private buildJoinPanel(): HTMLElement {
    const section = el('section', {
      className: 'multiplayer-card',
      attrs: { 'aria-labelledby': 'mp-join-title' },
    });
    const heading = el('div', { className: 'multiplayer-card-head' });
    heading.append(
      el('h2', {
        className: 'multiplayer-card-title',
        text: t('mp.join.title'),
        attrs: { id: 'mp-join-title' },
      }),
      el('p', {
        className: 'field-hint',
        text: t('mp.join.hint'),
      }),
    );

    const form = el('form', {
      className: 'form multiplayer-form',
      attrs: { id: 'mp-join-form', novalidate: '' },
    });
    const nameField = el('div', { className: 'field field-full' });
    nameField.append(
      fieldLabel(t('mp.field.playerName'), 'mp-join-name'),
      el('input', {
        className: 'input',
        attrs: {
          id: 'mp-join-name',
          name: 'playerName',
          type: 'text',
          maxlength: '24',
          autocomplete: 'nickname',
        },
      }),
    );
    const joinField = el('div', { className: 'field field-full' });
    joinField.append(
      fieldLabel(t('mp.field.codeOrLink'), 'mp-join'),
      el('input', {
        className: 'input',
        attrs: {
          id: 'mp-join',
          name: 'join',
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: t('mp.join.placeholder'),
        },
      }),
    );
    this.joinError = el('p', {
      className: 'field-error',
      attrs: { id: 'mp-join-error', role: 'alert' },
    });
    this.joinError.hidden = true;
    form.append(nameField, joinField, this.joinError);
    const joinActions = el('div', { className: 'panel-actions panel-actions-column' });
    joinActions.append(
      el('button', {
        className: 'btn btn-primary',
        text: t('mp.join.submit'),
        attrs: { type: 'submit' },
      }),
    );
    form.append(joinActions);

    const listHead = el('div', { className: 'lobby-list-head' });
    listHead.append(el('h3', { className: 'multiplayer-card-title', text: t('mp.public.title') }));
    this.refreshButton = el('button', {
      className: 'btn btn-ghost btn-compact',
      text: t('mp.refresh'),
      attrs: { id: 'mp-refresh', type: 'button', 'aria-label': t('mp.refreshAria') },
    });
    listHead.append(this.refreshButton);

    this.lobbyList = el('div', {
      className: 'lobby-list',
      attrs: { id: 'mp-lobbies', role: 'list', 'aria-live': 'polite' },
    });
    this.lobbyEmpty = el('p', {
      className: 'field-hint',
      text: t('mp.empty'),
      attrs: { id: 'mp-lobbies-empty' },
    });

    section.append(heading, form, listHead, this.lobbyEmpty, this.lobbyList);
    return section;
  }

  private buildFooter(): HTMLElement {
    const footer = el('div', { className: 'multiplayer-footer' });
    const back = el('button', {
      className: 'btn btn-ghost',
      text: t('common.backToMenu'),
      attrs: { type: 'button' },
    });
    back.addEventListener('click', () => this.options.onBack());
    footer.append(
      back,
      el('p', {
        className: 'screen-note',
        text: t('mp.footer.tip'),
      }),
    );
    return footer;
  }

  private bindCreate(): void {
    const form = this.element.querySelector<HTMLFormElement>('#mp-create-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitCreate();
    });
  }

  private bindJoin(): void {
    const joinForm = this.element.querySelector<HTMLFormElement>('#mp-join-form');
    joinForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitJoin();
    });
    this.refreshButton.addEventListener('click', () => {
      this.options.directory?.tick(Date.now());
    });
  }

  private submitCreate(): void {
    this.createError.hidden = true;
    const lobbyName = this.lobbyNameInput.value.trim();
    const playerName = this.playerNameInput.value.trim();
    const seed = parseSeed(this.seedInput.value);
    if (lobbyName.length === 0) {
      this.showCreateError(t('mp.error.lobbyName'));
      this.lobbyNameInput.focus();
      return;
    }
    if (playerName.length === 0) {
      this.showCreateError(t('mp.error.playerName'));
      this.playerNameInput.focus();
      return;
    }
    if (seed === null) {
      this.showCreateError(t('mp.error.seed'));
      this.seedInput.focus();
      return;
    }
    const size = Number(this.sizeInputs.find((input) => input.checked)?.value ?? 256);
    if (size !== 256 && size !== 512) {
      this.showCreateError(t('mp.error.size'));
      return;
    }
    const rawDifficulty = this.difficultySelect.value;
    const difficulty: AIDifficulty =
      rawDifficulty === 'easy' || rawDifficulty === 'hard' ? rawDifficulty : 'normal';
    this.options.onCreate({
      lobbyName: lobbyName.slice(0, 32),
      playerName: playerName.slice(0, 24),
      isPublic: this.publicInput.checked,
      mapSize: size,
      difficulty,
      seed,
    });
  }

  private submitJoin(): void {
    this.joinError.hidden = true;
    const playerName = this.joinNameInput.value.trim();
    if (playerName.length === 0) {
      this.joinError.textContent = t('mp.join.error.name');
      this.joinError.hidden = false;
      this.joinNameInput.focus();
      return;
    }
    const target = parseJoinTarget(this.joinInput.value);
    if (!target) {
      this.joinError.textContent = t('mp.join.error.code');
      this.joinError.hidden = false;
      this.joinInput.focus();
      return;
    }
    this.options.onJoin(target, playerName.slice(0, 24));
  }

  private showCreateError(message: string): void {
    this.createError.textContent = message;
    this.createError.hidden = false;
  }

  private renderLobbies(lobbies: LobbyInfo[]): void {
    if (this.disposed) return;
    this.lobbyList.replaceChildren();
    const open = lobbies.filter((info) => info.status === 'open' && info.players < info.max);
    this.lobbyEmpty.hidden = open.length > 0;
    for (const info of open) {
      const row = el('button', {
        className: 'lobby-row',
        attrs: {
          type: 'button',
          role: 'listitem',
          title: t('mp.lobby.joinTitle', { name: info.name }),
          'aria-label': t('mp.lobby.joinAria', {
            name: info.name,
            status: statusLabel(info),
          }),
        },
      });
      const main = el('span', { className: 'lobby-row-main' });
      main.append(
        el('span', { className: 'lobby-row-name', text: info.name }),
        el('span', {
          className: 'lobby-row-meta',
          text: t('mp.lobby.meta', { status: statusLabel(info) }),
        }),
      );
      row.append(
        main,
        el('span', { className: 'lobby-row-code', text: info.roomId.toUpperCase() }),
      );
      row.addEventListener('click', () =>
        this.options.onJoin(
          { roomId: info.roomId, hostId: info.hostPeerId },
          this.joinNameInput.value.trim() || this.options.initialName,
        ),
      );
      this.lobbyList.append(row);
    }
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.options.onBack();
    }
  }

  override dispose(): void {
    this.disposed = true;
    this.directoryOff?.();
    this.directoryOff = null;
    super.dispose();
  }
}
