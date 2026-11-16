/**
 * Scénario — chaussée sans dévers (#202).
 *
 * Construit une route est-ouest sur un versant en travers : la rangée nord est
 * surélevée d'un niveau et la rangée sud abaissée d'un niveau. L'ancienne
 * géométrie suivait les quatre coins du terrain et inclinait donc la chaussée
 * dans sa largeur ; la nouvelle garde les deux bords à la même hauteur.
 *
 * Le scénario sert aux captures avant/après : même graine, même terrassement,
 * même pose de caméra.
 */

import { sleep } from '../cdp.mjs';
import { gameUrl, waitForHud } from '../helpers.mjs';

const NATURAL = new Set([1, 2, 3, 9]); // clear, grass, rough, trees

export const roadSlope = {
  id: 'road-slope',
  title: 'Routes sans dévers sur un versant (#202)',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage('road-slope');
    // Pas d'intro cinématique : elle reprendrait la caméra après la pose.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await page.goto(gameUrl(ctx.baseUrl, 'autostart=1&engine=mock&size=96&quality=high&seed=202'));
    // Fige la simulation dès que la session existe : le site et le terrassement
    // ne dépendent pas du temps de chargement du rendu, donc les captures
    // avant/après restent superposables.
    await page.waitFor(() => Boolean(window.__opentt3d?.game), {
      timeout: 30_000,
      label: 'la session de jeu',
    });
    await page.evaluate(() => window.__opentt3d?.game?.setPaused(true));
    await waitForHud(page, { timeout: 25_000 });

    await page.waitFor(() => Boolean(window.__opentt3d?.world?.getMap?.()), {
      timeout: 15_000,
      label: 'le monde 3D et sa carte',
    });
    await page.waitFor(
      () => {
        const pause = window.__opentt3d?.game?.isPaused?.();
        return pause === true && document.querySelector('.hud-pause')?.textContent?.trim() === '▶';
      },
      { timeout: 5_000, label: 'la simulation en pause' },
    );

    const site = await page.evaluate(
      (naturalValues) => {
        const natural = new Set(naturalValues);
        const api = window.__opentt3d;
        const map = api?.world?.getMap?.();
        if (!map) return null;
        const length = 24;
        for (let y = 3; y < map.height - 3; y += 1) {
          for (let x = 2; x < map.width - length - 2; x += 1) {
            const base = map.heightMap[y * map.width + x];
            if (base < 3) continue;
            let ok = true;
            for (let dy = -1; dy <= 1 && ok; dy += 1) {
              for (let dx = -1; dx <= length && ok; dx += 1) {
                const index = (y + dy) * map.width + x + dx;
                if (!natural.has(map.kind[index]) || map.heightMap[index] !== base) ok = false;
              }
            }
            if (ok) return { x, y, length, base };
          }
        }
        return null;
      },
      [...NATURAL],
    );
    ctx.assert(Boolean(site), 'un versant plat constructible est trouvé', site);
    if (!site) return;

    const built = await page.evaluate(({ x, y, length }) => {
      const api = window.__opentt3d;
      const game = api.game;
      const company = 0;
      const left = x - 1;
      const right = x + length;
      const terraform = (from, to, direction) =>
        game.issueCommand({
          type: 'build',
          tool: 'terraform',
          company,
          from,
          to,
          options: { direction, size: 1 },
        });
      // Dégage les arbres du secteur pour que la chaussée reste visible.
      const mapBefore = api.world.getMap();
      for (let ty = y - 3; ty <= y + 4; ty += 1) {
        for (let tx = left - 1; tx <= right + 1; tx += 1) {
          if (tx < 0 || ty < 0 || tx >= mapBefore.width || ty >= mapBefore.height) continue;
          if (mapBefore.kind[ty * mapBefore.width + tx] !== 9) continue;
          game.issueCommand({
            type: 'build',
            tool: 'clear',
            company,
            from: { x: tx, y: ty },
            to: { x: tx, y: ty },
          });
        }
      }
      // Versant en travers : une rangée surélevée au nord, une abaissée au sud.
      terraform({ x: left, y: y - 1 }, { x: right, y: y - 1 }, 'up');
      terraform({ x: left, y: y + 1 }, { x: right, y: y + 1 }, 'down');
      game.refresh();
      game.issueCommand({
        type: 'build',
        tool: 'road',
        company,
        from: { x, y },
        to: { x: x + length - 1, y },
        options: { axis: 'x' },
      });
      const snapshot = game.refresh();
      const map = api.world.getMap();
      const road = map.kind[y * map.width + x];

      const controller = api.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(x + Math.floor(length / 2), 0, y + 0.5);
      controller.applyPose({ yaw: 0.06, pitch: 0.52, distance: 15, target });
      controller.setFov(42);
      return {
        road,
        roads: snapshot.map ? snapshot.map.kind.filter((value) => value === 7).length : null,
        north: map.heightMap[(y - 1) * map.width + x],
        south: map.heightMap[(y + 1) * map.width + x],
        base: map.heightMap[y * map.width + x],
      };
    }, site);
    ctx.assert(built.road === 7, 'la route est construite sur la rangée plate', built);
    ctx.assert(
      built.north > built.base && built.south < built.base,
      'le versant est bien incliné dans la largeur de la route',
      built,
    );

    await sleep(700);
    const wide = await ctx.capture(page, 'road-slope');
    ctx.assert(Boolean(wide && wide.size > 20_000), 'la capture du versant est valide', wide);

    // Vue rasante dans l'axe de la route : la largeur est alors à l'écran,
    // ce qui rend le dévers immédiatement lisible (bords gauche/droit).
    await page.evaluate(({ x, y }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(x + 8, 0, y + 0.5);
      controller.applyPose({ yaw: Math.PI / 2 + 0.12, pitch: 0.26, distance: 9, target });
    }, site);
    await sleep(500);
    const close = await ctx.capture(page, 'road-slope-close');
    ctx.assert(Boolean(close && close.size > 20_000), 'la capture rapprochée est valide', close);

    // Vue transversale, depuis le bas du versant : la pente de la chaussée
    // apparaît directement en travers de l'image.
    await page.evaluate(({ x, y }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(x + 9, 0, y + 0.5);
      controller.applyPose({ yaw: 0.02, pitch: 0.34, distance: 8.5, target });
    }, site);
    await sleep(500);
    const side = await ctx.capture(page, 'road-slope-side');
    ctx.assert(Boolean(side && side.size > 20_000), 'la capture transversale est valide', side);
  },
};
