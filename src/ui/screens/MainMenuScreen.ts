/**
 * Menu principal : nouvelle partie, multijoueur (bientôt), chargement
 * (bientôt), réglages et à propos. Navigation Tab + flèches, focus visible.
 */

import { el, enableListNavigation } from '../dom';
import { t } from '../i18n';
import { BaseScreen } from './BaseScreen';

export interface MainMenuOptions {
  onSolo: () => void;
  onMultiplayer: () => void;
  onLoad: () => void;
  onSettings: () => void;
  onAbout: () => void;
  /** Renseigné si WebGL est indisponible : les parties sont bloquées. */
  unavailableReason?: string | null;
  /** Complément affiché sous « Multijoueur » (mode local, avertissement). */
  multiplayerNote?: string;
  /** Une simulation tourne derrière le menu : affiche le badge « en direct ». */
  liveSimulation?: boolean;
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
    this.element.setAttribute('aria-label', t('menu.navLabel'));

    const layout = el('div', { className: 'menu-layout' });
    const main = el('div', { className: 'menu-main' });
    const column = el('div', { className: 'menu-column' });

    const hero = el('div', { className: 'menu-hero' });
    const brand = el('div', { className: 'menu-brand' });
    brand.append(
      el('span', { className: 'menu-brand-mark', text: '◆' }),
      el('span', { text: 'OpenTT3D' }),
    );
    hero.append(
      brand,
      el('h1', { className: 'menu-title', text: t('menu.heroTitle') }),
      el('p', {
        className: 'menu-tagline',
        text: t('menu.heroTagline'),
      }),
    );
    const badges = el('div', { className: 'menu-badges' });
    badges.append(
      el('span', { className: 'badge', text: t('menu.badge.mock') }),
      el('span', { className: 'badge', text: t('menu.badge.stack') }),
      el('span', { className: 'badge', text: t('menu.badge.license') }),
    );
    hero.append(badges);

    const actions = el('nav', {
      className: 'menu-actions',
      attrs: { 'aria-label': t('menu.navLabel'), 'data-menu': '' },
    });
    const soloDisabled = Boolean(options.unavailableReason);
    actions.append(
      menuItem({
        label: t('menu.newGame.label'),
        note: soloDisabled ? t('menu.unavailable.note') : t('menu.newGame.note'),
        primary: true,
        autofocus: true,
        disabled: soloDisabled,
        onClick: () => {
          if (soloDisabled) {
            this.showNotice(options.unavailableReason ?? t('menu.unavailable.fallback'));
            return;
          }
          options.onSolo();
        },
      }),
      menuItem({
        label: t('menu.multiplayer.label'),
        note:
          options.multiplayerNote ??
          (soloDisabled ? t('menu.unavailable.note') : t('menu.multiplayer.note')),
        disabled: soloDisabled,
        onClick: () => {
          if (soloDisabled) {
            this.showNotice(options.unavailableReason ?? t('menu.unavailable.fallback'));
            return;
          }
          options.onMultiplayer();
        },
      }),
      menuItem({
        label: t('menu.load.label'),
        note: soloDisabled ? t('menu.unavailable.note') : t('menu.load.note'),
        disabled: soloDisabled,
        onClick: () => {
          if (soloDisabled) {
            this.showNotice(options.unavailableReason ?? t('menu.unavailable.fallback'));
            return;
          }
          options.onLoad();
        },
      }),
      menuItem({
        label: t('menu.settings.label'),
        note: t('menu.settings.note'),
        onClick: () => options.onSettings(),
      }),
      menuItem({
        label: t('menu.about.label'),
        note: t('menu.about.note'),
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
      el('span', { text: t('menu.footer') }),
      el('span', {
        className: 'menu-footer-hint',
        text: t('menu.footerHint'),
      }),
    );

    column.append(hero, actions, this.notice);
    main.append(column);
    layout.append(main, footer);
    this.element.append(layout);

    if (options.liveSimulation) {
      const live = el('div', { className: 'menu-live' });
      live.append(
        el('span', { className: 'menu-live-dot' }),
        el('span', { text: 'Simulation en direct' }),
      );
      this.element.append(live);
    }
    this.cleanupNavigation = enableListNavigation(actions);

    if (options.unavailableReason) {
      const alert = el('p', { className: 'alert alert-error', text: options.unavailableReason });
      column.insertBefore(alert, actions);
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
