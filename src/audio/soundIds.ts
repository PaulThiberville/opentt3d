/**
 * Catalogue des sons procéduraux.
 *
 * Aucun fichier audio : chaque identifiant désigne une recette synthétique
 * (`recipes.ts`). Les identifiants sont stables pour les tests et le debug.
 */

export const SOUND_IDS = [
  'ui.click',
  'ui.hover',
  'ui.notify',
  'ui.error',
  'build.road',
  'build.rail',
  'build.station',
  'build.depot',
  'build.clear',
  'vehicle.buy',
  'vehicle.start',
  'vehicle.stop',
  'vehicle.sell',
  'money.in',
  'money.out',
  'alert',
  'train.pass',
  'bus.pass',
] as const;

export type SoundId = (typeof SOUND_IDS)[number];

/** Sons d'interface : audibles même en pause ou dans les menus. */
export const UI_SOUNDS: ReadonlySet<SoundId> = new Set<SoundId>([
  'ui.click',
  'ui.hover',
  'ui.notify',
  'ui.error',
]);

export function isUiSound(id: SoundId): boolean {
  return UI_SOUNDS.has(id);
}
