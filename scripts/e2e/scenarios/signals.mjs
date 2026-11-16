/**
 * Scénario — signalisation avancée et caténaires (#156/#157).
 *
 * Construit une voie, pose des signaux path bidirectionnels, convertit le
 * tronçon en rail électrifié puis capture la scène et la barre d'options.
 * Toutes les actions passent par les commandes publiques du moteur mock.
 */

import { sleep } from '../cdp.mjs';
import { gameUrl, openGame, waitForHud } from '../helpers.mjs';

export const signals = {
  id: 'signals',
  title: 'Signaux path, conversion électrifiée et caténaires',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage('signals');
    await page.goto(gameUrl(ctx.baseUrl, ''));
    page.baseUrl = ctx.baseUrl;
    await openGame(page, ctx.baseUrl, 'autostart=1&engine=mock&size=128&quality=medium&seed=1337', {
      timeout: 30_000,
    });
    await waitForHud(page, { timeout: 25_000 });

    // Pause : la construction et la capture ne dépendent pas des véhicules.
    await page.focusBody();
    await page.press('Space');
    await page.waitFor(() => document.querySelector('.hud-pause')?.textContent?.trim() === '▶', {
      timeout: 5_000,
      label: 'la simulation en pause',
    });

    const corridor = await page.evaluate(() => {
      const api = window.__opentt3d;
      const map = api?.world?.getMap?.();
      if (!map) return null;
      const length = 8;
      const buildable = new Set([1, 2, 3, 9]); // clear, grass, rough, trees
      for (let y = 2; y < map.height - 2; y += 1) {
        for (let x = 2; x < map.width - length - 2; x += 1) {
          const base = map.heightMap[y * map.width + x];
          let ok = true;
          for (let dx = 0; dx < length; dx += 1) {
            const index = y * map.width + x + dx;
            if (!buildable.has(map.kind[index]) || map.heightMap[index] !== base) {
              ok = false;
              break;
            }
          }
          if (ok) return { x, y, length, base };
        }
      }
      return null;
    });
    ctx.assert(Boolean(corridor), 'un corridor plat constructible est trouvé', corridor);

    const result = await page.evaluate(({ x, y, length }) => {
      const api = window.__opentt3d;
      const game = api.game;
      const company = 0;
      const toX = x + length - 1;
      game.issueCommand({
        type: 'build',
        tool: 'rail',
        company,
        from: { x, y },
        to: { x: toX, y },
        options: { axis: 'x', railType: 'rail' },
      });
      game.refresh();
      game.issueCommand({
        type: 'build',
        tool: 'signal',
        company,
        from: { x: x + 1, y },
        to: { x: toX - 1, y },
        options: { type: 'path', direction: 'both', spacing: 3 },
      });
      game.refresh();
      game.issueCommand({
        type: 'build',
        tool: 'convert',
        company,
        from: { x, y },
        to: { x: toX, y },
        options: { railType: 'electrified' },
      });
      const snapshot = game.refresh();
      const railType = snapshot.map?.railTypes?.[y * 128 + x] ?? null;
      const electrified = ((snapshot.map?.flags?.[y * 128 + x] ?? 0) & (1 << 7)) !== 0;
      api.world.getCameraController().focusOn(x + length / 2, y + 0.5, 9);
      api.setBuildTool('signal');
      return {
        signals: snapshot.signals?.length ?? 0,
        kinds: (snapshot.signals ?? []).map((signal) => signal.kind),
        directions: (snapshot.signals ?? []).map((signal) => signal.direction),
        railType,
        electrified,
        catenaryPosts: api.world.catenary?.countPosts ?? null,
      };
    }, corridor);

    ctx.assert(result.signals >= 2, 'au moins deux signaux path sont posés', result);
    ctx.assert(
      result.kinds.every((kind) => kind === 'path'),
      'tous les signaux sont de type path',
      result,
    );
    ctx.assert(
      result.directions.every((direction) => direction === 'both'),
      'les signaux sont bidirectionnels',
      result,
    );
    ctx.assert(result.railType === 1, 'le tronçon est converti en rail électrifié', result);
    ctx.assert(result.electrified, 'le drapeau ELECTRIFIED est posé', result);
    ctx.assert((result.catenaryPosts ?? 0) > 0, 'des poteaux de caténaire sont rendus', result);

    await page.click('[data-action="signal-kind-path"]');
    await page.click('[data-action="signal-direction-both"]');
    await sleep(400);
    const shot = await ctx.capture(page, 'signals-catenary');
    ctx.assert(
      Boolean(shot && shot.size > 20_000),
      'la capture signaux/caténaires est valide',
      shot,
    );

    await page.evaluate(() => window.__opentt3d?.setBuildTool('convert'));
    await page.waitFor(() => document.querySelector('.hud-build-options') !== null, {
      timeout: 5_000,
      label: 'la barre de type de rail',
    });
    await page.click('[data-action="rail-type-electrified"]');
    await sleep(300);
    const shotOptions = await ctx.capture(page, 'rail-type-options');
    ctx.assert(
      Boolean(shotOptions && shotOptions.size > 10_000),
      'la capture des options de rail est valide',
      shotOptions,
    );
  },
};
