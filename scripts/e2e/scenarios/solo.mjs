/**
 * Scénario 1 — solo mock.
 *
 * Parcours : menu → autostart → chargement → HUD → carte 3D → outil Routes →
 * drag réel sur le canvas → news et trésorerie. Aucun service externe.
 */

import {
  MENU,
  buildRoad,
  gameUrl,
  openGame,
  openNews,
  readState,
  waitForNews,
  waitForScreen,
} from '../helpers.mjs';

function parseMoney(text) {
  const digits = String(text ?? '').replace(/[^\d-]/g, '');
  return digits ? Number(digits) : null;
}

export const soloMock = {
  id: 'solo-mock',
  title: 'Solo mock : menu, chargement, HUD, carte et route',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage('solo');

    await page.goto(gameUrl(ctx.baseUrl, ''));
    page.baseUrl = ctx.baseUrl;
    await waitForScreen(page, MENU);
    ctx.check('menu principal affiché');
    await ctx.capture(page, 'menu');

    // Un observateur enregistré avant la navigation prouve que l'écran de
    // chargement a bien été traversé, même s'il est très bref en 128×128.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__e2eLoadingSeen = false;
        new MutationObserver(() => {
          if (document.querySelector('.loading-screen')) window.__e2eLoadingSeen = true;
        }).observe(document, { childList: true, subtree: true });
      `,
    });

    await openGame(page, ctx.baseUrl, 'autostart=1&engine=mock&size=128&quality=low&seed=1337', {
      timeout: 30_000,
    });
    const initialState = await readState(page);
    ctx.assert(
      Boolean(initialState.debug),
      'la session de debug est exposée par le serveur de dev',
      initialState,
    );
    ctx.assert(
      initialState.debug?.map?.width === 128 && initialState.debug?.map?.height === 128,
      'la carte générée fait 128×128',
      initialState.debug?.map,
    );
    ctx.assert(
      initialState.debug?.engineMode === 'mock',
      'le moteur actif est le mock',
      initialState.debug?.engineMode,
    );
    ctx.assert(
      (initialState.debug?.companies?.length ?? 0) >= 1,
      'au moins une entreprise est présente',
      initialState.debug?.companies,
    );

    const loadingSeen = await page.evaluate(() => Boolean(window.__e2eLoadingSeen));
    ctx.assert(loadingSeen, 'l’écran de chargement a été affiché avant le HUD');

    const canvas = await page.evaluate(() => {
      const element = document.querySelector('#scene');
      if (!(element instanceof HTMLCanvasElement)) return null;
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        backingWidth: element.width,
        backingHeight: element.height,
      };
    });
    ctx.assert(
      Boolean(canvas && canvas.width > 400 && canvas.height > 300 && canvas.backingWidth > 0),
      'le canvas 3D occupe la fenêtre et possède un framebuffer',
      canvas,
    );

    const toolCount = await page.evaluate(
      () => document.querySelectorAll('.hud-toolbar .hud-tool').length,
    );
    ctx.assert(toolCount === 11, 'les onze outils de construction sont présents', toolCount);

    ctx.assert(
      parseMoney(initialState.hud.money) !== null,
      'la trésorerie est renseignée dans le HUD',
      initialState.hud.money,
    );
    ctx.assert(
      Boolean(initialState.hud.date && initialState.hud.date !== '—'),
      'la date de jeu est renseignée dans le HUD',
      initialState.hud.date,
    );
    await ctx.capture(page, 'hud');

    // La simulation est mise en pause pendant la construction : la trésorerie
    // ne bouge alors que sous l'effet du coût des routes, sans revenus de
    // véhicules concurrents.
    await page.focusBody();
    await page.press('Space');
    await page.waitFor(() => document.querySelector('.hud-pause')?.textContent?.trim() === '▶', {
      timeout: 5_000,
      label: 'la simulation en pause',
    });
    const beforeBuild = await readState(page);
    const built = await buildRoad(page);
    ctx.check(
      `route construite (${built.before} → ${built.after} tuiles, mode ${built.mode})`,
      built,
    );
    const afterBuild = await readState(page);
    const beforeMoney = parseMoney(beforeBuild.hud.money);
    const afterMoney = parseMoney(afterBuild.hud.money);
    ctx.assert(
      beforeMoney !== null && afterMoney !== null && afterMoney < beforeMoney,
      'la trésorerie a diminué après la construction',
      { before: beforeBuild.hud.money, after: afterBuild.hud.money },
    );
    await page.focusBody();
    await page.press('Space');

    await page.click('.hud-news-button');
    await page.waitForSelector('.hud-news-panel.is-visible');
    await waitForNews(page, /^Route : \d+ tuile/);
    const news = await openNews(page);
    const roadNews = news.find((item) => /^Route : \d+ tuile/.test(item));
    ctx.assert(Boolean(roadNews), 'une actualité « Route : N tuiles » est publiée', roadNews);

    const shot = await ctx.capture(page, 'route-news');
    ctx.assert(
      Boolean(shot && shot.size > 20_000),
      'la capture du HUD et de la carte n’est pas vide',
      shot,
    );
  },
};
