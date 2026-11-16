/**
 * Scénario — rapports v1.5 (#164/#169).
 *
 * Ouvre la modale depuis la barre supérieure, vérifie les trois onglets
 * (finances, véhicules, statistiques), la gestion des groupes (#164), le
 * panneau véhicule (fiabilité #163), le clavier et le rendu mobile.
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
      groupControls: document.querySelector('.hud-report-group-controls') !== null,
      groupCreateEnabled: !(
        document.querySelector('[data-focus-key="group-create"]')?.disabled ?? true
      ),
      groupRenameDisabled:
        document.querySelector('[data-focus-key="group-rename"]')?.disabled ?? false,
      groupActions: document.querySelectorAll('[data-focus-key^="group-action-"]').length,
    }));
    ctx.assert(vehicleState.filters === 6, 'les six filtres véhicule sont présents', vehicleState);
    ctx.assert(
      vehicleState.groupControls && vehicleState.groupCreateEnabled,
      'la gestion des groupes est disponible (#164)',
      vehicleState,
    );
    ctx.assert(
      vehicleState.groupRenameDisabled && vehicleState.groupActions === 0,
      'les actions groupées attendent un groupe sélectionné',
      vehicleState,
    );
    await ctx.capture(page, 'reports-vehicles-desktop');

    // Création d'un groupe, affectation d'un véhicule et autoreplace (#164).
    await page.evaluate(() => {
      const input = document.querySelector('[data-focus-key="group-name"]');
      if (input && input.tagName === 'INPUT') {
        input.value = 'Ligne E2E';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('[data-focus-key="group-create"]')?.click();
    });
    await sleep(450);
    const created = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('.hud-report-group-chip')].map(
        (chip) => chip.textContent ?? '',
      );
      const options = [...document.querySelectorAll('#vehicle-group option')];
      const group = options.find((option) => option.textContent === 'Ligne E2E');
      return { chips, groupValue: group?.value ?? null };
    });
    ctx.assert(
      created.chips.some((text) => text.includes('Ligne E2E')),
      'le groupe créé apparaît dans la liste',
      created,
    );
    ctx.assert(created.groupValue !== null, 'le groupe est proposé dans le filtre', created);
    const groupValue = created.groupValue ?? '';

    const assigned = await page.evaluate((value) => {
      const select = document.querySelector('[data-focus-key^="vehicle-group-"]');
      if (!select || select.tagName !== 'SELECT') return false;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, groupValue);
    ctx.assert(assigned, 'un véhicule peut être affecté au groupe');
    await sleep(400);

    await setSelect(page, '#vehicle-group', groupValue);
    await sleep(300);
    const groupReady = await page.evaluate(() => ({
      enabled: [...document.querySelectorAll('[data-focus-key^="group-action-"]')].filter(
        (node) => !node.disabled,
      ).length,
      rows: document.querySelectorAll('.hud-report-vehicle').length,
    }));
    ctx.assert(groupReady.enabled >= 4, 'les actions groupées sont actives', groupReady);
    ctx.assert(groupReady.rows >= 1, 'le filtre de groupe affiche le véhicule affecté', groupReady);

    const autoreplace = await page.evaluate(() => {
      const select = document.querySelector('[data-focus-key="group-autoreplace-model"]');
      if (select && select.tagName === 'SELECT' && select.options.length > 0) {
        select.selectedIndex = Math.max(0, select.options.length - 1);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('[data-focus-key="group-autoreplace-apply"]')?.click();
      return select && select.tagName === 'SELECT' ? select.options.length : 0;
    });
    ctx.assert(autoreplace > 0, 'des modèles d’autoreplace sont proposés', autoreplace);
    await sleep(350);
    const autoreplaceState = await page.evaluate(() => ({
      chip: [...document.querySelectorAll('.hud-report-group-chip')].map(
        (node) => node.textContent ?? '',
      ),
      rows: [...document.querySelectorAll('.hud-report-vehicle')].filter((row) =>
        (row.textContent ?? '').includes('Ligne E2E'),
      ).length,
    }));
    ctx.assert(
      autoreplaceState.chip.some((text) => text.includes('Autoreplace')),
      'la règle d’autoreplace est affichée',
      autoreplaceState,
    );
    ctx.assert(
      autoreplaceState.rows >= 1,
      'le véhicule affecté affiche son groupe',
      autoreplaceState,
    );
    await ctx.capture(page, 'reports-groups-desktop');

    // Panneau véhicule : fiabilité, groupe et actions d'entretien (#163).
    await page.evaluate(() =>
      document.querySelector('[data-focus-key^="vehicle-select-"]')?.click(),
    );
    await page.waitForSelector('.hud-vehicle:not([hidden])');
    await sleep(250);
    const vehiclePanel = await page.evaluate(() => {
      const panel = document.querySelector('.hud-vehicle');
      const labels = [...(panel?.querySelectorAll('.hud-selection-stat dt') ?? [])].map(
        (node) => node.textContent ?? '',
      );
      const buttons = [...(panel?.querySelectorAll('.hud-vehicle-action') ?? [])].map(
        (node) => node.textContent ?? '',
      );
      return { labels, buttons, text: panel?.textContent ?? '' };
    });
    ctx.assert(
      vehiclePanel.labels.includes('Fiabilité') && vehiclePanel.labels.includes('Usure'),
      'le panneau véhicule expose la fiabilité et l’usure',
      vehiclePanel,
    );
    ctx.assert(
      vehiclePanel.labels.includes('Groupe'),
      'le panneau véhicule affiche le groupe',
      vehiclePanel,
    );
    ctx.assert(
      vehiclePanel.buttons.includes('Entretenir') &&
        vehiclePanel.buttons.includes('Envoyer au dépôt'),
      'les actions d’entretien sont proposées',
      vehiclePanel,
    );
    await ctx.capture(page, 'vehicle-reliability-desktop');

    // Entretien depuis le panneau : la commande véhicule #163 part au moteur.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.hud-vehicle-action')];
      const service = buttons.find((node) => (node.textContent ?? '').includes('Entretenir'));
      service?.click();
    });
    await sleep(450);
    const serviced = await page.evaluate(() => ({
      panel: document.querySelector('.hud-vehicle')?.textContent ?? '',
    }));
    ctx.assert(
      serviced.panel.includes('en dépôt'),
      'l’entretien place le véhicule au dépôt',
      serviced,
    );
    await page.click('.hud-news-button');
    await page.waitForSelector('.hud-news-panel:not([hidden])');
    const serviceNews = await page.evaluate(
      () => document.querySelector('.hud-news-panel')?.textContent ?? '',
    );
    ctx.assert(serviceNews.includes('entretenu'), 'l’entretien produit une actualité de coût', {
      serviceNews,
    });
    await ctx.capture(page, 'vehicle-service-desktop');
    await page.click('[data-report-tab="vehicles"]');
    await page.waitForSelector('.hud-reports:not([hidden])');

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
