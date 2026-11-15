/**
 * Scénario 2 — sauvegarde et chargement.
 *
 * Construit une route, met la partie en pause, sauvegarde via l'écran dédié,
 * revient au menu, recharge le slot et vérifie que le tick, la date et la carte
 * restaurés correspondent à l'état sauvegardé.
 */

import {
  MENU,
  PAUSE,
  SAVES,
  buildRoad,
  openGame,
  pauseGame,
  readEngineTick,
  readState,
  waitForHud,
  waitForScreen,
} from '../helpers.mjs';

function dateOrdinal(economy) {
  if (!economy) return null;
  // Mois OpenTTD de 31 jours : suffisant pour comparer deux dates voisines.
  return (economy.year * 12 + economy.month) * 31 + economy.day;
}

export const saveLoad = {
  id: 'save-load',
  title: 'Sauvegarde locale : capture, retour menu, rechargement',
  timeoutMs: 120_000,
  async run(ctx) {
    const page = await ctx.newPage('save-load');
    await openGame(page, ctx.baseUrl, 'autostart=1&engine=mock&size=128&quality=low&seed=2026', {
      timeout: 30_000,
    });
    const built = await buildRoad(page);
    ctx.check(`route de référence construite (${built.before} → ${built.after})`, built);

    const beforePause = await readState(page);
    const savedDate = beforePause.hud.date;
    const savedEconomy = beforePause.debug?.economy ?? null;
    const savedRoads = beforePause.debug?.map?.roads ?? null;
    ctx.assert(savedRoads !== null && savedRoads > 0, 'la carte contient la route à sauvegarder', {
      savedRoads,
    });

    await pauseGame(page);
    await ctx.capture(page, 'pause');

    await page.clickText('Sauvegarder la partie', PAUSE);
    await waitForScreen(page, SAVES);
    await page.waitForSelector('#save-name');
    await page.waitFor(
      () => {
        const note = document.querySelector('.save-storage')?.textContent ?? '';
        return note.length > 0 && !note.includes('Ouverture');
      },
      { timeout: 10_000, label: 'l’ouverture du stockage IndexedDB' },
    );

    const saveName = `E2E ${new Date().toISOString().slice(0, 19)}`;
    await page.setValue('#save-name', saveName);
    const tickAtSave = await readEngineTick(page);
    ctx.assert(Number.isFinite(tickAtSave), 'le tick moteur est lisible avant la sauvegarde', {
      tickAtSave,
    });

    await page.clickText('Sauvegarder maintenant', SAVES);
    await page.waitFor(
      (name) => {
        const status = document.querySelector('.save-status');
        return (
          status?.getAttribute('data-tone') === 'success' &&
          (status.textContent ?? '').includes(name)
        );
      },
      { timeout: 20_000, label: 'la confirmation de sauvegarde' },
      saveName,
    );
    const slot = await page.evaluate(
      (name) =>
        Array.from(document.querySelectorAll('.save-row')).some(
          (row) => row.querySelector('.save-name')?.textContent?.trim() === name,
        ),
      saveName,
    );
    ctx.assert(slot, 'le slot sauvegardé apparaît dans la liste', saveName);
    await ctx.capture(page, 'saved');

    await page.clickText('Retour à la pause', SAVES);
    await waitForScreen(page, PAUSE);
    await page.clickText('Retour au menu', PAUSE);
    await page.clickText('Confirmer l’abandon', PAUSE);
    await waitForScreen(page, MENU, 20_000);

    await page.clickText('Charger une partie', MENU);
    await waitForScreen(page, SAVES);
    await page.waitFor(
      (name) =>
        Array.from(document.querySelectorAll('.save-row')).some(
          (row) => row.querySelector('.save-name')?.textContent?.trim() === name,
        ),
      { timeout: 15_000, label: 'le slot dans l’écran de chargement' },
      saveName,
    );
    await ctx.capture(page, 'load-list');

    const clicked = await page.evaluate((name) => {
      const row = Array.from(document.querySelectorAll('.save-row')).find(
        (item) => item.querySelector('.save-name')?.textContent?.trim() === name,
      );
      if (!row) return false;
      const button = Array.from(row.querySelectorAll('button')).find(
        (item) => (item.textContent ?? '').trim() === 'Charger',
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    }, saveName);
    ctx.assert(clicked, 'le bouton Charger du slot est cliquable', saveName);

    await waitForHud(page, { timeout: 30_000 });
    await page.waitFor(() => Boolean(window.__opentt3d?.restored), {
      timeout: 15_000,
      label: 'l’état restauré exposé par la session',
    });

    const afterLoad = await readState(page);
    const restored = afterLoad.debug?.restored ?? null;
    ctx.assert(
      Boolean(restored && restored.tick === tickAtSave),
      'le tick restauré est exactement celui de la sauvegarde',
      { saved: tickAtSave, restored },
    );
    ctx.assert(
      Boolean(restored && typeof restored.hash === 'string' && restored.hash.length > 0),
      'un hash d’état est calculé après le chargement',
      restored,
    );
    const savedOrdinal = dateOrdinal(savedEconomy);
    const restoredOrdinal = dateOrdinal(afterLoad.debug?.economy ?? null);
    ctx.assert(
      savedOrdinal !== null &&
        restoredOrdinal !== null &&
        restoredOrdinal >= savedOrdinal &&
        restoredOrdinal - savedOrdinal <= 1,
      'la date restaurée reprend celle de la sauvegarde (au jour près)',
      {
        savedDate,
        restoredDate: afterLoad.hud.date,
        savedEconomy,
        restoredEconomy: afterLoad.debug?.economy ?? null,
      },
    );
    ctx.assert(
      (afterLoad.debug?.map?.roads ?? -1) === savedRoads,
      'la carte restaurée contient le même nombre de tuiles route',
      { savedRoads, restoredRoads: afterLoad.debug?.map?.roads },
    );
    ctx.assert(
      (afterLoad.debug?.tick ?? 0) >= (tickAtSave ?? 0),
      'la simulation a repris après le chargement',
      { saved: tickAtSave, current: afterLoad.debug?.tick },
    );

    await ctx.capture(page, 'loaded');
    ctx.check(`sauvegarde « ${saveName} » restaurée au tick ${tickAtSave}`, {
      savedDate,
      roads: savedRoads,
    });
  },
};
