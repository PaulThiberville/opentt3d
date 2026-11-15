/**
 * Scénario — rapports v1.5 (#164/#169).
 *
 * Ouvre la modale depuis la barre supérieure, vérifie les trois onglets
 * (finances, véhicules, statistiques), les états désactivés des actions non
 * supportées, le clavier et le rendu mobile. Aucune commande de simulation
 * n'est émise par le panneau.
 */

import { sleep } from '../cdp.mjs';
import { openGame } from '../helpers.mjs';

async function setSelect(page, selector, value) {
  return page.evaluate(
    (sel, next) => {
      const element = document.querySelector(sel);
      if (!element || element.tagName !== 'SELECT') return false;
      element.value = next;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value === next;
    },
    selector,
    value,
  );
}

export const reports = {
  id: 'reports',
  title: 'Rapports : finances, véhicules et statistiques',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage({ width: 1440, height: 900 });
    await openGame(page, ctx.baseUrl, 'autostart=1&engine=mock&size=128&quality=low&seed=169');

    // Coupe l'intro cinématique et laisse quelques relevés alimenter le
    // graphique de trésorerie avant la capture.
    await page.focusBody();
    await page.press('Enter');
    await page.waitFor(() => !document.querySelector('.intro-hint'), {
      timeout: 10_000,
      label: 'la fin de l’intro',
    });
    await sleep(2_500);

    const button = await page.evaluate(
      () => document.querySelector('[data-report-tab="finance"]') !== null,
    );
    ctx.assert(button, 'le bouton Rapports est présent dans la barre supérieure');

    await page.click('[data-report-tab="finance"]');
    await page.waitForSelector('.hud-reports:not([hidden])');
    const dialog = await page.evaluate(() => {
      const root = document.querySelector('.hud-reports');
      return {
        role: root?.getAttribute('role') ?? null,
        modal: root?.getAttribute('aria-modal') ?? null,
        cards: root?.querySelectorAll('.hud-report-stat').length ?? 0,
        ranking: root?.querySelectorAll('.hud-report-table tbody tr').length ?? 0,
        disabledActions: root?.querySelectorAll('.hud-report-action:disabled').length ?? 0,
        tabs: root?.querySelectorAll('[role="tab"]').length ?? 0,
      };
    });
    ctx.assert(
      dialog.role === 'dialog' && dialog.modal === 'true',
      'la modale est un dialogue modal',
    );
    ctx.assert(dialog.tabs === 3, 'trois onglets de rapports sont exposés', dialog);
    ctx.assert(dialog.cards >= 4, 'les indicateurs financiers sont affichés', dialog);
    ctx.assert(dialog.ranking >= 1, 'le classement des entreprises est rempli', dialog);
    ctx.assert(
      dialog.disabledActions >= 2,
      'les commandes de prêt restent désactivées sans protocole',
      dialog,
    );
    await ctx.capture(page, 'reports-finance-desktop');

    // Navigation clavier : les flèches changent d'onglet, Tab reste piégé.
    await page.evaluate(() => document.querySelector('#hud-reports-tab-finance')?.focus());
    await page.press('ArrowRight');
    const activeTab = await page.evaluate(() => document.activeElement?.id ?? null);
    ctx.assert(
      activeTab === 'hud-reports-tab-vehicles',
      'la flèche droite active l’onglet Véhicules',
      activeTab,
    );
    for (let index = 0; index < 4; index += 1) await page.press('Tab');
    const trapped = await page.evaluate(
      () => document.activeElement?.closest('.hud-reports') !== null,
    );
    ctx.assert(trapped, 'le focus reste piégé dans la modale');

    const filtered = await setSelect(page, '#vehicle-kind', 'road');
    ctx.assert(filtered, 'le filtre de type véhicule accepte « route »');
    await sleep(150);
    const vehicleState = await page.evaluate(() => ({
      rows: document.querySelectorAll('.hud-report-vehicle').length,
      filters: document.querySelectorAll('.hud-report-filters select').length,
      groupActions: document.querySelectorAll('[data-focus-key^="vehicle-group-"]:disabled').length,
    }));
    ctx.assert(vehicleState.filters === 6, 'les six filtres véhicule sont présents', vehicleState);
    ctx.assert(
      vehicleState.groupActions === 3,
      'les actions de groupe sont désactivées avec explication',
      vehicleState,
    );
    await ctx.capture(page, 'reports-vehicles-desktop');

    await page.click('#hud-reports-tab-stats');
    await page.waitForSelector('#hud-reports-panel-stats:not([hidden])');
    const stats = await page.evaluate(() => ({
      market: document.querySelectorAll('.hud-report-bars .hud-report-bar-row').length,
      industries: document.querySelectorAll('.hud-report-data-list .hud-report-data-row').length,
      meters: document.querySelectorAll('.hud-reports-panel svg.hud-meter').length,
    }));
    ctx.assert(stats.market >= 1, 'les parts de marché sont affichées', stats);
    ctx.assert(stats.meters >= 1, 'les graphiques SVG sont rendus', stats);
    await ctx.capture(page, 'reports-stats-desktop');

    // Rendu mobile : la modale reste dans le viewport et les onglets restent
    // accessibles sans défilement horizontal de la page.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await sleep(250);
    await page.click('#hud-reports-tab-finance');
    const mobile = await page.evaluate(() => {
      const card = document.querySelector('.hud-reports-card');
      const rect = card?.getBoundingClientRect();
      return {
        width: rect?.width ?? 0,
        viewport: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        tabs: document.querySelectorAll('.hud-reports-tab').length,
      };
    });
    ctx.assert(
      mobile.width > 0 && mobile.width <= mobile.viewport,
      'la modale tient dans le viewport mobile',
      mobile,
    );
    ctx.assert(!mobile.overflow, 'aucun débordement horizontal sur mobile', mobile);
    await ctx.capture(page, 'reports-finance-mobile');

    await page.click('#hud-reports-tab-vehicles');
    await page.waitForSelector('#hud-reports-panel-vehicles:not([hidden])');
    const mobileVehicles = await page.evaluate(() => {
      const filters = document.querySelector('.hud-report-filters');
      const style = filters ? getComputedStyle(filters) : null;
      return {
        filters: document.querySelectorAll('.hud-report-filters select').length,
        columns: style?.gridTemplateColumns ?? null,
      };
    });
    ctx.assert(
      mobileVehicles.filters === 6,
      'les filtres restent présents sur mobile',
      mobileVehicles,
    );
    await ctx.capture(page, 'reports-vehicles-mobile');

    await page.press('Escape');
    const closed = await page.evaluate(
      () => document.querySelector('.hud-reports')?.hasAttribute('hidden') ?? true,
    );
    ctx.assert(closed, 'Échap ferme la modale et rend la main à la carte');
  },
};
