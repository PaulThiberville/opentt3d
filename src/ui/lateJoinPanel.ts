/**
 * Panneau réseau de l'hôte pendant une partie démarrée (#92).
 *
 * Il expose l'ouverture aux retardataires, les demandes en attente et l'état
 * du transfert de sauvegarde. Toute la logique vit dans `LateJoinHost` ; ce
 * module ne fait que rendre `state()` et appeler ses intentions.
 */

import { button, el } from './dom';
import { t } from './i18n';
import type { LateJoinHost } from './lateJoinHost';
import {
  describeHostJoin,
  playerCountLabel,
  type HostJoinSummary,
  type HostJoinView,
} from './netjoin';

export interface LateJoinPanelOptions {
  mount: HTMLElement;
  host: LateJoinHost;
  roomId: string;
  inviteLink: string;
}

const REFRESH_MS = 400;

function shortPeer(peerId: string): string {
  return peerId.slice(0, 6);
}

export class LateJoinPanel {
  private options: LateJoinPanelOptions;
  private host: LateJoinHost;
  private element: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLParagraphElement;
  private hint: HTMLParagraphElement;
  private autoInput: HTMLInputElement;
  private primary: HTMLButtonElement;
  private pendingBox: HTMLDivElement;
  private pendingEmpty: HTMLParagraphElement;
  private playersBox: HTMLDivElement;
  private playersLabel: HTMLSpanElement;
  private inviteInput: HTMLInputElement;
  private copyButton: HTMLButtonElement;
  private copyStatus: HTMLSpanElement;
  private toggleButton: HTMLButtonElement;
  private offChange: () => void;
  private timer: ReturnType<typeof setInterval>;
  private pendingSignature = '';
  private disposed = false;
  private collapsed = false;

  constructor(options: LateJoinPanelOptions) {
    this.options = options;
    this.host = options.host;

    this.element = el('div', {
      className: 'late-join-panel',
      attrs: {
        role: 'region',
        'aria-label': t('late.regionAria'),
      },
    });
    const header = el('div', { className: 'late-join-head' });
    const heading = el('div', { className: 'late-join-heading' });
    heading.append(
      el('h2', { className: 'late-join-title', text: t('late.title') }),
      el('span', {
        className: 'late-join-room',
        text: t('late.room', { code: options.roomId.toUpperCase() }),
      }),
    );
    this.toggleButton = button(t('late.collapse'), {
      variant: 'ghost',
      className: 'btn-compact late-join-toggle',
      onClick: () => this.toggleCollapsed(),
    });
    header.append(heading, this.toggleButton);

    this.status = el('p', {
      className: 'late-join-status',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.hint = el('p', { className: 'late-join-hint', text: '' });

    const autoRow = el('label', { className: 'late-join-auto' });
    this.autoInput = el('input', {
      attrs: { type: 'checkbox', 'aria-describedby': 'late-join-auto-hint' },
    });
    this.autoInput.addEventListener('change', () => {
      this.host.setAutoAdmit(this.autoInput.checked);
      this.render();
    });
    autoRow.append(
      this.autoInput,
      el('span', {
        className: 'late-join-auto-text',
        text: t('late.auto'),
      }),
    );
    const autoHint = el('p', {
      className: 'field-hint',
      text: t('late.autoHint'),
      attrs: { id: 'late-join-auto-hint' },
    });

    this.primary = button(t('late.open'), {
      variant: 'primary',
      className: 'btn-compact',
      onClick: () => this.onPrimary(),
    });

    this.pendingBox = el('div', { className: 'late-join-pending' });
    this.pendingEmpty = el('p', {
      className: 'late-join-empty',
      text: t('late.empty'),
    });
    this.pendingBox.append(this.pendingEmpty);
    this.playersBox = el('div', { className: 'late-join-players' });
    this.playersLabel = el('span', { className: 'late-join-players-label' });

    const share = el('div', { className: 'late-join-share' });
    this.inviteInput = el('input', {
      className: 'input input-compact',
      attrs: {
        type: 'text',
        readonly: 'readonly',
        spellcheck: 'false',
        'aria-label': t('late.inviteAria'),
      },
    });
    this.inviteInput.value = options.inviteLink;
    this.copyButton = button(t('late.copy'), {
      variant: 'ghost',
      className: 'btn-compact',
      onClick: () => void this.copyInvite(),
    });
    this.copyStatus = el('span', {
      className: 'field-hint',
      text: '',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    share.append(this.inviteInput, this.copyButton);

    this.body = el('div', { className: 'late-join-body' });
    const playersTitle = el('p', { className: 'late-join-section-title', text: t('late.players') });
    playersTitle.append(this.playersLabel);
    this.body.append(
      this.status,
      this.hint,
      autoRow,
      autoHint,
      this.primary,
      el('p', { className: 'late-join-section-title', text: t('late.requests') }),
      this.pendingBox,
      playersTitle,
      this.playersBox,
      share,
      this.copyStatus,
    );

    this.element.append(header, this.body);
    options.mount.append(this.element);

    this.offChange = this.host.onChange(() => this.render());
    this.timer = setInterval(() => {
      this.host.tick();
      this.render();
    }, REFRESH_MS);
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.offChange();
    this.element.remove();
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.element.classList.toggle('is-collapsed', this.collapsed);
    this.toggleButton.textContent = this.collapsed ? t('late.expand') : t('late.collapse');
  }

  private onPrimary(): void {
    const view = this.host.state();
    if (view.windows.length > 0 || view.autoAdmit) {
      this.host.cancelAll();
    } else {
      this.host.setAutoAdmit(true);
    }
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const view = this.host.state();
    const summary: HostJoinSummary = describeHostJoin(view, Date.now());
    this.status.textContent = summary.text;
    this.status.dataset.tone = summary.tone;
    this.hint.textContent = summary.hint;
    this.primary.textContent = summary.primaryLabel;
    this.primary.classList.toggle('btn-danger', summary.active || view.autoAdmit);
    this.primary.classList.toggle('btn-primary', !(summary.active || view.autoAdmit));
    if (this.autoInput.checked !== view.autoAdmit) this.autoInput.checked = view.autoAdmit;
    this.renderPending(view);
    this.renderPlayers(view);
    this.playersLabel.textContent = ` · ${playerCountLabel(view)}`;
  }

  private renderPending(view: HostJoinView): void {
    const signature = view.pending.map((item) => `${item.peerId}:${item.ready}`).join('|');
    if (signature === this.pendingSignature) return;
    this.pendingSignature = signature;
    this.pendingBox.replaceChildren();
    if (view.pending.length === 0) {
      this.pendingBox.append(this.pendingEmpty);
      return;
    }
    for (const request of view.pending) {
      const row = el('div', { className: 'late-join-request' });
      const identity = el('div', { className: 'late-join-request-id' });
      identity.append(
        el('span', { className: 'late-join-request-name', text: request.name }),
        el('span', {
          className: 'late-join-request-peer',
          text: request.ready
            ? t('late.ready', { peer: shortPeer(request.peerId) })
            : shortPeer(request.peerId),
        }),
      );
      const actions = el('div', { className: 'late-join-request-actions' });
      const authorize = button(t('late.authorize'), {
        variant: 'primary',
        className: 'btn-compact',
        onClick: () => {
          this.host.admit(request.peerId);
          this.render();
        },
      });
      authorize.disabled = !request.ready;
      const refuse = button(t('late.refuse'), {
        variant: 'ghost',
        className: 'btn-compact',
        onClick: () => {
          this.host.deny(request.peerId);
          this.render();
        },
      });
      actions.append(authorize, refuse);
      row.append(identity, actions);
      this.pendingBox.append(row);
    }
  }

  private renderPlayers(view: HostJoinView): void {
    const signature = view.players.map((item) => `${item.player}:${item.name}`).join('|');
    if (this.playersBox.dataset.signature === signature) return;
    this.playersBox.dataset.signature = signature;
    this.playersBox.replaceChildren();
    for (const player of view.players) {
      const chip = el('span', {
        className: 'badge late-join-player',
        text: `${player.player + 1}. ${player.name}`,
      });
      this.playersBox.append(chip);
    }
  }

  private async copyInvite(): Promise<void> {
    const value = this.inviteInput.value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.copyStatus.textContent = t('late.copied');
    } catch {
      this.inviteInput.focus();
      this.inviteInput.select();
      this.copyStatus.textContent = t('late.copyManual');
    }
  }
}
