/**
 * Branchement DOM du moteur audio : premier geste, clics/survols de l'UI,
 * visibilité de l'onglet et focus de la fenêtre.
 *
 * Toute la logique sonore reste dans `AudioEngine` ; ce fichier ne fait que
 * traduire des événements navigateur en appels explicites. Il est isolé pour
 * que le moteur et le directeur restent testables sans DOM.
 */

import type { AudioEngine } from './AudioEngine';

export interface AudioUiOptions {
  engine: AudioEngine;
  win: Window;
  doc: Document;
}

const INTERACTIVE =
  'button, a[href], [role="button"], select, input[type="checkbox"], input[type="radio"], input[type="range"]';

function interactiveTarget(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(INTERACTIVE);
}

/**
 * Installe les écouteurs globaux et renvoie la fonction de nettoyage.
 * Sans geste utilisateur, aucun contexte audio n'est créé.
 */
export function installAudioUi(options: AudioUiOptions): () => void {
  const { engine, win, doc } = options;
  const cleanups: (() => void)[] = [];

  const unlock = (): void => {
    engine.unlock();
    if (engine.isUnlocked) removeUnlock();
  };
  const removeUnlock = (): void => {
    win.removeEventListener('pointerdown', unlock, true);
    win.removeEventListener('keydown', unlock, true);
    win.removeEventListener('touchstart', unlock, true);
  };
  win.addEventListener('pointerdown', unlock, true);
  win.addEventListener('keydown', unlock, true);
  win.addEventListener('touchstart', unlock, true);
  cleanups.push(removeUnlock);

  const onPointerDown = (event: Event): void => {
    if (interactiveTarget(event)) engine.play('ui.click');
  };
  const onPointerOver = (event: Event): void => {
    if (interactiveTarget(event)) engine.play('ui.hover');
  };
  const onChange = (event: Event): void => {
    if (interactiveTarget(event)) engine.play('ui.click', { gain: 0.7 });
  };
  const onVisibility = (): void => {
    engine.setTabHidden(doc.hidden);
  };
  const onBlur = (): void => {
    engine.setFocused(false);
  };
  const onFocus = (): void => {
    engine.setFocused(true);
  };
  const onPageHide = (): void => {
    engine.setFocused(false);
  };

  doc.addEventListener('pointerdown', onPointerDown, { passive: true });
  doc.addEventListener('pointerover', onPointerOver, { passive: true });
  doc.addEventListener('change', onChange, { passive: true });
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  win.addEventListener('pagehide', onPageHide);

  cleanups.push(() => {
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointerover', onPointerOver);
    doc.removeEventListener('change', onChange);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('pagehide', onPageHide);
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
