/**
 * Écran « À propos » : nature du projet, stack, licence et liens.
 */

import { el } from '../dom';
import { BaseScreen } from './BaseScreen';

export interface AboutScreenOptions {
  onBack: () => void;
}

export class AboutScreen extends BaseScreen {
  private options: AboutScreenOptions;

  constructor(options: AboutScreenOptions) {
    super('panel-screen about-screen');
    this.options = options;

    const panel = el('div', { className: 'panel panel-wide' });
    const header = el('div', { className: 'panel-header' });
    header.append(
      el('span', { className: 'panel-eyebrow', text: 'À propos' }),
      el('h1', { className: 'panel-title', text: 'OpenTT3D' }),
      el('p', {
        className: 'panel-subtitle',
        text: 'Un fork expérimental d’OpenTTD qui conserve la simulation d’origine et remplace la présentation isométrique par une scène Three.js.',
      }),
    );

    const body = el('div', { className: 'about-grid' });
    body.append(
      this.section('Principe', [
        'Le moteur OpenTTD reste la source de vérité (WASM à terme). Le frontend lit des snapshots, interpole et affiche : l’UI ne simule jamais.',
        'Cette vague utilise le MockEngine déterministe : carte, villes, industries, réseaux et véhicules sont générés localement.',
      ]),
      this.section('Interface', [
        'DOM + CSS sans framework, écrans et HUD modulaires, navigation clavier et focus visible.',
        'Aucun innerHTML avec des données de jeu : seuls textContent et les attributs sont utilisés.',
      ]),
      this.section('Technique', [
        'Vite 8, TypeScript strict, Three.js 0.187, Vitest 5.',
        'Rendu low-poly stylisé, presets qualité, minimap 2D et panneaux tycoon.',
      ]),
      this.section('Licence', [
        'GPL-2.0-or-later. Projet non affilié à Transport Tycoon ou à Chris Sawyer.',
        'Les sources du moteur et les crédits complets sont dans le dépôt GitHub.',
      ]),
    );

    const links = el('div', { className: 'about-links' });
    const repo = el('a', {
      className: 'btn btn-ghost',
      text: 'Dépôt GitHub',
      attrs: {
        href: 'https://github.com/PaulThiberville/opentt3d',
        target: '_blank',
        rel: 'noreferrer noopener',
      },
    });
    const wiki = el('a', {
      className: 'btn btn-ghost',
      text: 'Wiki du projet',
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
      text: 'Retour au menu',
      attrs: { type: 'button', 'data-autofocus': '' },
    });
    back.addEventListener('click', () => options.onBack());
    actions.append(back);

    panel.append(header, body, links, actions);
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
