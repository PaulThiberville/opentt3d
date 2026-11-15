/**
 * Petits helpers DOM sans framework.
 *
 * Toutes les écritures passent par `textContent` ou des attributs : aucun
 * `innerHTML`, donc aucune donnée de jeu ou de sauvegarde ne peut être
 * interprétée comme du HTML.
 */

export interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, value);
  }
  if (options.dataset) {
    for (const [name, value] of Object.entries(options.dataset)) node.dataset[name] = value;
  }
  return node;
}

export interface ButtonOptions extends ElementOptions {
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const node = el('button', {
    className: ['btn', options.variant ? `btn-${options.variant}` : '', options.className ?? '']
      .filter(Boolean)
      .join(' '),
    attrs: options.attrs,
    dataset: options.dataset,
  });
  node.type = 'button';
  node.textContent = label;
  if (options.disabled) node.disabled = true;
  if (options.onClick) node.addEventListener('click', options.onClick);
  return node;
}

/** Libellé de champ accessible : `<label>` relié à un contrôle. */
export function fieldLabel(text: string, controlId?: string): HTMLLabelElement {
  const label = el('label', { className: 'field-label', text });
  if (controlId) label.htmlFor = controlId;
  return label;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getClientRects().length > 0,
  );
}

export function focusFirst(root: HTMLElement): void {
  const explicit = root.querySelector<HTMLElement>('[data-autofocus]');
  const fallback = focusableElements(root)[0];
  (explicit ?? fallback)?.focus();
}

/**
 * Calcule la cible d'un focus trap circulaire.
 *
 * `null` signifie « laisser le navigateur avancer normalement » : le focus est
 * déjà à l'intérieur et ne franchit aucune borne. Un index négatif représente
 * un focus hors du conteneur.
 */
export function resolveFocusTrap(
  count: number,
  activeIndex: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey) return activeIndex === 0 ? count - 1 : null;
  return activeIndex === count - 1 ? 0 : null;
}

export interface MediaQueryLike {
  matches: boolean;
}

/** Respecte `prefers-reduced-motion` sans dépendre d'un vrai `window` en test. */
export function prefersReducedMotion(
  matchMedia: ((query: string) => MediaQueryLike) | undefined = typeof window === 'undefined'
    ? undefined
    : (query: string) => window.matchMedia(query),
): boolean {
  return matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

const GAME_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  '+',
  '-',
  '=',
]);

const GAME_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'Equal',
  'Minus',
  'NumpadAdd',
  'NumpadSubtract',
  'Space',
]);

export interface GameKeyGuardInput {
  key: string;
  code: string;
  /** Le focus est dans la couche d'écrans modaux. */
  inScreen: boolean;
  /** Un écran modal est visible (même si le focus traîne ailleurs). */
  screenOpen: boolean;
}

/**
 * Les raccourcis de caméra et de pause ne doivent pas voler les flèches, Home
 * ou Espace à un contrôle de formulaire ou à un écran modal.
 */
export function shouldGuardGameKey(input: GameKeyGuardInput): boolean {
  if (!input.inScreen && !input.screenOpen) return false;
  return GAME_KEYS.has(input.key) || GAME_CODES.has(input.code);
}

let gameKeyGuardInstalled = false;

/**
 * Filtre les raccourcis de jeu au niveau de `document` (phase bulle) : les
 * écouteurs de `window` (caméra, session) ne les reçoivent plus pendant qu'un
 * écran modal est ouvert ou qu'un de ses contrôles a le focus.
 */
export function installGameKeyGuard(): () => void {
  if (gameKeyGuardInstalled || typeof document === 'undefined') return () => {};
  gameKeyGuardInstalled = true;
  const handler = (event: KeyboardEvent): void => {
    const target = event.target;
    const inScreen = target instanceof Element && target.closest('.screens') !== null;
    const screenOpen = document.querySelector('.screens .screen.is-visible') !== null;
    if (!shouldGuardGameKey({ key: event.key, code: event.code, inScreen, screenOpen })) return;
    event.stopPropagation();
  };
  document.addEventListener('keydown', handler);
  return () => {
    document.removeEventListener('keydown', handler);
    gameKeyGuardInstalled = false;
  };
}

/**
 * Navigation circulaire au clavier dans une liste verticale de boutons
 * (flèches haut/bas, Home/End). Retourne la fonction de nettoyage.
 */
export function enableListNavigation(container: HTMLElement): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-menu-item]:not([disabled])'),
    );
    if (items.length === 0) return;
    const current = document.activeElement;
    const index = current instanceof HTMLElement ? items.indexOf(current) : -1;
    let next: number;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
    else if (event.key === 'ArrowUp')
      next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else next = items.length - 1;
    items[next]?.focus();
    event.preventDefault();
  };
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}
