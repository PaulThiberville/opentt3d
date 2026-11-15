/**
 * Scénario 5 — moteur WASM (optionnel).
 *
 * Ne s'exécute que si `public/engine/` contient les trois artefacts du moteur.
 * Sinon le scénario est marqué « skipped » : la CI sans build WASM reste verte.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRoad, gameUrl, readState, waitForHud } from '../helpers.mjs';

async function engineArtifactsPresent(repoRoot) {
  const files = ['opentt3d-engine.js', 'opentt3d-engine.wasm', 'opentt3d-engine.data'];
  const checks = await Promise.all(
    files.map(async (file) => {
      try {
        await access(join(repoRoot, 'public', 'engine', file));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

export const wasm = {
  id: 'wasm',
  title: 'Moteur WASM : badge, carte OpenTTD réelle et route',
  timeoutMs: 240_000,
  async run(ctx) {
    if (!(await engineArtifactsPresent(ctx.repoRoot))) {
      return {
        skip:
          'public/engine/ absent (npm run engine:fetch && npm run engine:build) : ' +
          'scénario WASM ignoré.',
      };
    }
    const page = await ctx.newPage('wasm');
    await page.goto(gameUrl(ctx.baseUrl, 'autostart=1&engine=wasm&size=128&quality=low&seed=1337'));
    await page.waitFor(
      () =>
        Boolean(
          document.querySelector('.hud .hud-bar') ||
          document.querySelector('.loading-screen .panel-title.is-error'),
        ),
      { timeout: 120_000, label: 'le HUD ou une erreur de chargement WASM' },
    );
    const loadError = await page.text('.loading-screen .panel-title.is-error');
    if (loadError) {
      const detail = await page.text('.loading-screen .loading-message');
      throw new Error(`Chargement WASM en échec : ${loadError} — ${detail ?? ''}`);
    }
    await waitForHud(page, { timeout: 90_000 });

    const state = await readState(page);
    const badge = await page.attr('#ui [data-engine]', 'data-engine');
    ctx.assert(badge === 'wasm', 'la pastille indique le moteur WASM', badge);
    ctx.assert(
      state.debug?.engineMode === 'wasm',
      'la session utilise le moteur WASM réel',
      state.debug?.engineMode,
    );
    ctx.assert(
      state.debug?.map?.width === 128 && state.debug?.map?.height === 128,
      'la carte OpenTTD réelle fait 128×128',
      state.debug?.map,
    );
    ctx.assert(
      (state.debug?.towns ?? 0) > 0,
      'la carte WASM contient des villes générées par OpenTTD',
      state.debug?.towns,
    );
    ctx.check(`carte WASM chargée (${state.debug?.towns} villes)`, state.debug?.map);
    await ctx.capture(page, 'wasm-hud');

    const built = await buildRoad(page, { timeout: 4_000, preciseTimeout: 2_500 });
    ctx.check(
      `route construite avec le moteur WASM (${built.before} → ${built.after} tuiles)`,
      built,
    );
    // Le texte exact des news dépend du pont OpenTTD ; le compteur de tuiles
    // route ci-dessus est la preuve fonctionnelle de la construction.
    await page.click('.hud-news-button');
    await page.waitForSelector('.hud-news-panel.is-visible');
    await ctx.capture(page, 'wasm-route');
  },
};
