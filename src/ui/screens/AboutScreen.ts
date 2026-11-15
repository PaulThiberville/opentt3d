/**
 * Écran « À propos » : nature du projet, stack, licence et liens.
 */

import { el } from '../dom';
import { t } from '../i18n';
import { BaseScreen } from './BaseScreen';

export interface AboutScreenOptions {
  onBack: () => void;
}

export class AboutScreen extends BaseScreen {
  private options: AboutScreenOptions;

  constructor(options: AboutScreenOptions) {
    super('panel-screen about-screen');
    this.options = options;
    this.element.setAttribute('aria-label', t('about.eyebrow'));

    const panel = el('div', { className: 'panel panel-wide' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: t('about.eyebrow') }),
      el('h1', { className: 'panel-title', text: 'OpenTT3D' }),
      el('p', { className: 'panel-subtitle', text: t('about.subtitle') }),
    );
    const version = el('p', {
      className: 'about-version',
      text: `Version ${__APP_VERSION__}`,
    });

    const body = el('div', { className: 'about-grid' });
    body.append(
      this.section(t('about.principles.title'), [
        t('about.principles.engine'),
        t('about.principles.mock'),
      ]),
      this.section(t('about.interface.title'), [
        t('about.interface.stack'),
        t('about.interface.safety'),
      ]),
      this.section(t('about.tech.title'), [t('about.tech.stack'), t('about.tech.render')]),
      this.section(t('about.license.title'), [t('about.license.gpl'), t('about.license.sources')]),
    );

    const links = el('div', { className: 'about-links' });
    const repo = el('a', {
      className: 'btn btn-ghost',
      text: t('about.repo'),
      attrs: {
        href: 'https://github.com/PaulThiberville/opentt3d',
        target: '_blank',
        rel: 'noreferrer noopener',
      },
    });
    const wiki = el('a', {
      className: 'btn btn-ghost',
      text: t('about.wiki'),
      attrs: {
        href: 'https://github.com/PaulThiberville/opentt3d/wiki',
        target: '_blank',
        rel: 'noreferrer noopener',
      },
    });
    links.append(repo, wiki);

    const actions = el('div', { className: 'panel-actions' });
    const back = el('button', {
      className: 'btn btn-primary',
      text: t('common.backToMenu'),
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    back.addEventListener('click', () => options.onBack());
    actions.append(back);

    panel.append(header, version, body, links, actions);
    this.element.append(panel);
  }

  private section(title: string, paragraphs: string[]): HTMLElement {
    const section = el('section', { className: 'about-section' });
    section.append(el('h2', { text: title }));
    for (const text of paragraphs) section.append(el('p', { text }));
    return section;
  }

  protected override onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.options.onBack();
    }
  }
}
