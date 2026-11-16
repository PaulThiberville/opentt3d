/**
 * Écran « Rejoindre la partie en cours » (#92).
 *
 * Il ne pilote rien : `LateJoinClient` fournit des `LateJoinUiState` et l'écran
 * se contente de les traduire en progression, message et badges de config.
 * Le transfert de sauvegarde étant chunké, le nombre de blocs reçus est affiché
 * explicitement en plus de la barre.
 */

import type { StartPayload } from '../../net/lobby-types';
import { el } from '../dom';
import { t, tn } from '../i18n';
import { MAP_SIZE_LABELS, climateLabel, engineLabel } from '../netlobby';
import { describeLateJoinState, type LateJoinUiState } from '../netjoin';
import { BaseScreen } from './BaseScreen';

export interface JoinScreenOptions {
  payload: StartPayload;
  onCancel: () => void;
  onBack: () => void;
}

export class JoinScreen extends BaseScreen {
  private options: JoinScreenOptions;
  private title: HTMLHeadingElement;
  private message: HTMLParagraphElement;
  private progress: HTMLDivElement;
  private progressTrack: HTMLDivElement;
  private detail: HTMLParagraphElement;
  private cancelButton: HTMLButtonElement;
  private backButton: HTMLButtonElement;
  private errorMode = false;
  private cancelRequested = false;
  private locked = false;

  constructor(options: JoinScreenOptions) {
    super('join-screen');
    this.options = options;
    const payload = options.payload;
    const host = payload.players.find((player) => player.isHost);
    const humans = payload.players.filter((player) => player.ai === null).length;
    const ai = payload.players.length - humans;

    const card = el('div', { className: 'panel loading-card join-card' });
    const badges = el('div', { className: 'menu-badges' });
    badges.append(
      el('span', { className: 'badge', text: engineLabel(payload.settings.engine) }),
      el('span', {
        className: 'badge',
        text: t('join.badge.map', { size: MAP_SIZE_LABELS[payload.settings.mapSize] }),
      }),
      el('span', { className: 'badge', text: climateLabel(payload.settings.climate) }),
      el('span', {
        className: 'badge',
        text: `${tn(humans, 'join.badge.players.one', 'join.badge.players.other')}${
          ai > 0 ? ` · ${t('join.badge.ai', { count: ai })}` : ''
        }`,
      }),
    );

    this.title = el('h1', {
      className: 'panel-title',
      text: t('join.title'),
    });
    const subtitle = el('p', {
      className: 'panel-subtitle',
      text: host
        ? host.companyName
          ? t('join.hostTitleCompany', { name: host.name, company: host.companyName })
          : t('join.hostTitle', { name: host.name })
        : t('join.inProgress'),
    });
    this.message = el('p', {
      className: 'loading-message',
      text: t('join.searching'),
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.progressTrack = el('div', {
      className: 'progress',
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
        'aria-label': t('join.progressAria'),
      },
    });
    this.progress = el('div', { className: 'progress-fill' });
    this.progressTrack.append(this.progress);
    this.detail = el('p', {
      className: 'field-hint',
      text: t('join.detail'),
    });
    this.cancelButton = el('button', {
      className: 'btn btn-ghost',
      text: t('join.cancel'),
      attrs: { type: 'button' },
    });
    this.cancelButton.addEventListener('click', () => this.cancel());
    this.backButton = el('button', {
      className: 'btn btn-primary',
      text: t('join.back'),
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    this.backButton.hidden = true;
    this.backButton.addEventListener('click', () => this.options.onBack());

    card.append(
      el('span', { className: 'panel-eyebrow', text: t('join.eyebrow') }),
      this.title,
      subtitle,
      badges,
      this.message,
      this.progressTrack,
      this.detail,
      el('div', { className: 'join-actions' }),
    );
    const actions = card.querySelector('.join-actions');
    actions?.append(this.cancelButton, this.backButton);
    this.element.append(card);
  }

  setState(state: LateJoinUiState): void {
    if (this.errorMode) return;
    const description = describeLateJoinState(state);
    this.title.textContent = description.title;
    this.message.textContent = description.message;
    this.message.dataset.tone = description.tone;
    const percent = Math.round(Math.max(0, Math.min(1, description.progress)) * 100);
    this.progress.style.width = `${percent}%`;
    this.progressTrack.setAttribute('aria-valuenow', `${percent}`);
    if (state.stage === 'transfer') {
      this.detail.textContent =
        state.total > 0
          ? t('join.blocks', {
              received: state.received,
              total: state.total,
              percent,
            })
          : t('join.receiving');
    }
    if (state.stage === 'rejected') this.showFailure(description.message);
  }

  setError(title: string, message: string): void {
    if (this.errorMode) return;
    this.title.textContent = title;
    this.title.classList.add('is-error');
    this.showFailure(message);
  }

  setCancelling(): void {
    if (this.errorMode) return;
    this.cancelRequested = true;
    this.cancelButton.disabled = true;
    this.cancelButton.textContent = t('join.cancelling');
    this.message.textContent = t('join.cancellingMessage');
  }

  /** Progression de la construction du rendu après un join réussi. */
  setPreparation(progress: number, message: string): void {
    if (this.errorMode || this.cancelRequested) return;
    this.locked = true;
    this.cancelButton.disabled = true;
    this.cancelButton.textContent = t('join.accepted');
    this.title.textContent = t('join.preparingTitle');
    this.message.textContent = message;
    this.message.dataset.tone = 'ok';
    const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    this.progress.style.width = `${percent}%`;
    this.progressTrack.setAttribute('aria-valuenow', `${percent}`);
  }

  private showFailure(message: string): void {
    this.errorMode = true;
    this.title.classList.add('is-error');
    this.message.textContent = message;
    this.message.dataset.tone = 'error';
    this.progress.style.width = '100%';
    this.progressTrack.setAttribute('aria-valuenow', '100');
    this.detail.textContent = t('join.failureDetail');
    this.cancelButton.hidden = true;
    this.backButton.hidden = false;
    this.backButton.focus();
  }

  private cancel(): void {
    if (this.cancelRequested || this.errorMode || this.locked) return;
    this.setCancelling();
    this.options.onCancel();
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (this.errorMode) this.options.onBack();
    else this.cancel();
  }
}
