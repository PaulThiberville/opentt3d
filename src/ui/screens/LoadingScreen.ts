/**
 * Écran de chargement : progression, message, annulation possible entre deux
 * étapes asynchrones. En cas d'échec, le même écran affiche l'erreur et un
 * retour au menu.
 */

import { el } from '../dom';
import { t } from '../i18n';
import { BaseScreen } from './BaseScreen';

export interface LoadingScreenOptions {
  onCancel: () => void;
  onClose: () => void;
}

export class LoadingScreen extends BaseScreen {
  private options: LoadingScreenOptions;
  private title: HTMLHeadingElement;
  private message: HTMLParagraphElement;
  private progress: HTMLDivElement;
  private progressTrack: HTMLDivElement;
  private spinner: HTMLDivElement;
  private cancelButton: HTMLButtonElement;
  private errorMode = false;
  private cancelRequested = false;

  constructor(options: LoadingScreenOptions) {
    super('loading-screen');
    this.options = options;
    this.element.setAttribute('aria-label', t('loading.title'));

    const card = el('div', { className: 'panel loading-card' });
    this.spinner = el('div', { className: 'spinner' });
    this.title = el('h1', { className: 'panel-title', text: t('loading.title') });
    this.message = el('p', {
      className: 'loading-message',
      text: t('loading.prepare'),
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.progressTrack = el('div', {
      className: 'progress',
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
        'aria-label': t('loading.progressLabel'),
      },
    });
    this.progress = el('div', { className: 'progress-fill' });
    this.progressTrack.append(this.progress);

    this.cancelButton = el('button', {
      className: 'btn btn-ghost',
      text: t('loading.cancel'),
      attrs: { type: 'button' },
    });
    this.cancelButton.addEventListener('click', () => this.cancel());

    card.append(this.spinner, this.title, this.message, this.progressTrack, this.cancelButton);
    this.element.append(card);
  }

  setProgress(value: number, message?: string): void {
    if (this.errorMode) return;
    const clamped = Math.max(0, Math.min(1, value));
    this.progress.style.width = `${Math.round(clamped * 100)}%`;
    this.progressTrack.setAttribute('aria-valuenow', `${Math.round(clamped * 100)}`);
    if (message) this.message.textContent = message;
  }

  setCancelling(): void {
    if (this.errorMode) return;
    this.cancelRequested = true;
    this.cancelButton.disabled = true;
    this.cancelButton.textContent = t('loading.cancelling');
    this.message.textContent = t('loading.cancellingMessage');
  }

  setError(title: string, message: string): void {
    this.errorMode = true;
    this.spinner.hidden = true;
    this.progressTrack.hidden = true;
    this.cancelButton.hidden = true;
    this.title.textContent = title;
    this.title.classList.add('is-error');
    this.message.textContent = message;

    const back = el('button', {
      className: 'btn btn-primary',
      text: t('common.backToMenu'),
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    back.addEventListener('click', () => this.options.onClose());
    this.element.querySelector('.loading-card')?.append(back);
    back.focus();
  }

  private cancel(): void {
    if (this.cancelRequested || this.errorMode) return;
    this.setCancelling();
    this.options.onCancel();
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (this.errorMode) this.options.onClose();
    else this.cancel();
  }
}
