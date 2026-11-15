/**
 * Panneau de sélection : véhicule, ville, industrie, gare ou tuile.
 *
 * L'en-tête et les statistiques viennent exclusivement du résumé fourni par
 * `describeSelection` (donc du snapshot).
 */

import { el } from '../dom';
import type { SelectionSummary } from '../types';

export interface SelectionPanelOptions {
  onClear: () => void;
}

export class SelectionPanel {
  readonly element: HTMLElement;

  private dot: HTMLSpanElement;
  private title: HTMLDivElement;
  private detail: HTMLDivElement;
  private stats: HTMLDListElement;
  private signature = '';

  constructor(options: SelectionPanelOptions) {
    this.element = el('aside', {
      className: 'hud-selection',
      attrs: { 'aria-live': 'polite', 'aria-label': 'Sélection' },
    });
    this.dot = el('span', { className: 'hud-selection-dot' });
    const text = el('div', { className: 'hud-selection-text' });
    this.title = el('div', { className: 'hud-selection-title', text: 'Aucune sélection' });
    this.detail = el('div', { className: 'hud-selection-detail', text: '' });
    this.stats = el('dl', { className: 'hud-selection-stats' });
    text.append(this.title, this.detail, this.stats);
    const close = el('button', {
      className: 'hud-selection-close',
      text: '×',
      attrs: { type: 'button', title: 'Fermer la sélection', 'aria-label': 'Fermer la sélection' },
    });
    close.addEventListener('click', () => options.onClear());
    this.element.append(this.dot, text, close);
    this.element.hidden = true;
  }

  update(summary: SelectionSummary | null, following: boolean): void {
    if (!summary && !following) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    if (summary) {
      this.title.textContent = summary.title;
      this.detail.textContent = summary.detail;
      this.dot.style.background =
        summary.colour === null
          ? 'var(--hud-accent)'
          : `#${summary.colour.toString(16).padStart(6, '0')}`;
      this.renderStats(summary);
    } else {
      this.title.textContent = 'Suivi caméra';
      this.detail.textContent = 'Échap pour revenir à la vue carte.';
      this.dot.style.background = 'var(--hud-accent)';
      if (this.signature !== 'following') {
        this.signature = 'following';
        this.stats.replaceChildren();
      }
    }
  }

  private renderStats(summary: SelectionSummary): void {
    const signature = `${summary.title}|${summary.stats
      .map((stat) => `${stat.label}:${stat.value}:${stat.tone ?? ''}`)
      .join('|')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.stats.replaceChildren();
    for (const stat of summary.stats) {
      const row = el('div', { className: 'hud-selection-stat' });
      row.append(
        el('dt', { text: stat.label }),
        el('dd', { className: stat.tone ? `is-${stat.tone}` : undefined, text: stat.value }),
      );
      this.stats.append(row);
    }
  }
}
