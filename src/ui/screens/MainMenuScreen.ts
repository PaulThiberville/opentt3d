/**
 * Menu principal : nouvelle partie, multijoueur (bientôt), chargement
 * (bientôt), réglages et à propos. Navigation Tab + flèches, focus visible.
 */

import { el, enableListNavigation } from '../dom';
import { BaseScreen } from './BaseScreen';

export interface MainMenuOptions {
  onSolo: () => void;
  onSettings: () => void;
  onAbout: () => void;
  /** Renseigné si WebGL est indisponible : la partie solo est bloquée. */
  unavailableReason?: string | null;
}

interface MenuItemOptions {
  label: string;
  note: string;
  disabled?: boolean;
  primary?: boolean;
  autofocus?: boolean;
  onClick: () => void;
}

function menuItem(options: MenuItemOptions): HTMLButtonElement {
  const item = el('button', {
    className: [
      'menu-button',
      options.primary ? 'is-primary' : '',
      options.disabled ? 'is-disabled' : '',
    ]
      .filter(Boolean)
      .join(' '),
    attrs: {
      type: 'button',
      'data-menu-item': '',
      'aria-disabled': options.disabled ? 'true' : 'false',
      ...(options.autofocus ? { 'data-autofocus': '' } : {}),
    },
  });
  item.append(
    el('span', { className: 'menu-button-label', text: options.label }),
    el('span', { className: 'menu-button-note', text: options.note }),
  );
  item.addEventListener('click', () => options.onClick());
  return item;
}

export class MainMenuScreen extends BaseScreen {
  private cleanupNavigation: () => void;
  private notice: HTMLParagraphElement;

  constructor(options: MainMenuOptions) {
    super('menu-screen');

    const layout = el('div', { className: 'menu-layout' });

    const hero = el('div', { className: 'menu-hero' });
    const brand = el('div', { className: 'menu-brand' });
    brand.append(
      el('span', { className: 'menu-brand-mark', text: '◆' }),
      el('span', { text: 'OpenTT3D' }),
    );
    hero.append(
      brand,
      el('h1', { className: 'menu-title', text: 'Bâtissez votre empire' }),
      el('p', {
        className: 'menu-tagline',
        text: 'Transport Tycoon en 3D : villes vivantes, industries, trains, camions, bateaux et avions sur une carte générée.',
      }),
    );
    const badges = el('div', { className: 'menu-badges' });
    badges.append(
      el('span', { className: 'badge', text: 'Moteur mock déterministe' }),
      el('span', { className: 'badge', text: 'DOM + Three.js' }),
      el('span', { className: 'badge', text: 'GPL-2.0' }),
    );
    hero.append(badges);

    const actions = el('nav', {
      className: 'menu-actions',
      attrs: { 'aria-label': 'Menu principal', 'data-menu': '' },
    });
    const soloDisabled = Boolean(options.unavailableReason);
    actions.append(
      menuItem({
        label: 'Nouvelle partie',
        note: soloDisabled ? 'WebGL indisponible' : 'Solo · monde mock',
        primary: true,
        autofocus: true,
        disabled: soloDisabled,
        onClick: () => {
          if (soloDisabled) {
            this.showNotice(options.unavailableReason ?? 'Le rendu 3D est indisponible.');
            return;
          }
          options.onSolo();
        },
      }),
      menuItem({
        label: 'Multijoueur',
        note: 'Bientôt — le lobby P2P est en préparation',
        disabled: true,
        onClick: () =>
          this.showNotice(
            'Le multijoueur arrive bientôt : transport P2P et lobby sont livrés côté réseau, l’interface de salon sera branchée dans une prochaine vague.',
          ),
      }),
      menuItem({
        label: 'Charger une partie',
        note: 'Bientôt — sauvegardes locales et partage de fichier',
        disabled: true,
        onClick: () =>
          this.showNotice(
            'Le chargement de sauvegarde sera disponible avec le moteur WASM ; le format de sauvegarde existe déjà côté protocole.',
          ),
      }),
      menuItem({
        label: 'Réglages',
        note: 'Qualité, volumes, langue, relais P2P',
        onClick: () => options.onSettings(),
      }),
      menuItem({
        label: 'À propos',
        note: 'Licence, crédits et état du projet',
        onClick: () => options.onAbout(),
      }),
    );

    this.notice = el('p', {
      className: 'menu-notice',
      text: '',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    this.notice.hidden = true;

    const footer = el('footer', { className: 'menu-footer' });
    footer.append(
      el('span', { text: 'OpenTT3D · fork 3D d’OpenTTD, non affilié à Transport Tycoon.' }),
      el('span', {
        className: 'menu-footer-hint',
        text: '↑ ↓ pour naviguer · Entrée pour valider',
      }),
    );

    layout.append(hero, actions, this.notice, footer);
    this.element.append(layout);
    this.cleanupNavigation = enableListNavigation(actions);

    if (options.unavailableReason) {
      const alert = el('p', { className: 'alert alert-error', text: options.unavailableReason });
      layout.insertBefore(alert, actions);
    }
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
  }

  override dispose(): void {
    this.cleanupNavigation();
    super.dispose();
  }
}
