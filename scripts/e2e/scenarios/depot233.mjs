/**
 * Scénario — sortie et porte des dépôts (#233).
 *
 * Pose un croisement routier et quatre dépôts, un par orientation, puis lance
 * un bus dans chacun. Les captures avant/après utilisent la même graine, les
 * mêmes commandes et la même caméra : la porte doit regarder la route et les
 * bus doivent sortir sans tourner dans le dépôt.
 */

import { sleep } from '../cdp.mjs';
import { gameUrl, waitForHud } from '../helpers.mjs';

const NATURAL = new Set([1, 2, 3, 9]); // clear, grass, rough, trees

export const depot233 = {
  id: 'depot-233',
  title: 'Sortie et porte des dépôts (#233)',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage('depot-233');
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await page.goto(gameUrl(ctx.baseUrl, 'autostart=1&engine=mock&size=96&quality=high&seed=2024'));
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

    const built = await page.evaluate(
      (naturalValues) => {
        const natural = new Set(naturalValues);
        const api = window.__opentt3d;
        const game = api.game;
        const map = api.world.getMap();
        if (!map) return null;
        let site = null;
        for (const [w, h] of [
          [20, 14],
          [12, 10],
          [10, 8],
        ]) {
          for (let y = 4; y + h < map.height - 4 && !site; y += 1) {
            for (let x = 4; x + w < map.width - 4; x += 1) {
              const base = map.heightMap[y * map.width + x];
              let ok = true;
              for (let dy = 0; dy < h && ok; dy += 1) {
                for (let dx = 0; dx < w; dx += 1) {
                  const index = (y + dy) * map.width + x + dx;
                  if (!natural.has(map.kind[index]) || map.heightMap[index] !== base) {
                    ok = false;
                    break;
                  }
                }
              }
              if (ok) {
                site = { x, y };
                break;
              }
            }
          }
          if (site) break;
        }
        if (!site) return null;

        const company = 0;
        const cx = site.x + 6;
        const cy = site.y + 5;
        const build = (command) => game.issueCommand(command);
        const road = (from, to, axis) =>
          build({ type: 'build', tool: 'road', company, from, to, options: { axis } });

        road({ x: cx - 5, y: cy }, { x: cx + 5, y: cy }, 'x');
        road({ x: cx, y: cy - 4 }, { x: cx, y: cy - 1 }, 'y');
        road({ x: cx, y: cy + 1 }, { x: cx, y: cy + 4 }, 'y');
        const stationTile = { x: cx + 4, y: cy - 1 };
        build({
          type: 'build',
          tool: 'station',
          company,
          from: stationTile,
          options: { kind: 'road', direction: 'ne' },
        });
        const depotTiles = [
          { x: cx - 1, y: cy - 2 }, // entrée à l’est
          { x: cx - 2, y: cy - 1 }, // entrée au sud
          { x: cx + 1, y: cy - 2 }, // entrée à l’ouest
          { x: cx - 2, y: cy + 1 }, // entrée au nord
        ];
        for (const tile of depotTiles) {
          build({ type: 'build', tool: 'depot', company, from: tile, options: { kind: 'road' } });
        }

        const snapshot = game.refresh();
        const station = snapshot.stations.find(
          (item) => item.kind === 'road' && item.x === stationTile.x + 0.5,
        );
        const depots = depotTiles.map((tile) =>
          snapshot.depots.find((item) => item.x === tile.x && item.y === tile.y),
        );
        if (!station || depots.some((depot) => !depot)) return null;

        const buses = [];
        for (const depot of depots) {
          if (!depot) continue;
          build({ type: 'vehicle', action: 'buy', company, depotId: depot.id, model: 'bus_city' });
          const afterBuy = game.refresh();
          const bus = afterBuy.vehicles[afterBuy.vehicles.length - 1];
          if (!bus) continue;
          build({
            type: 'vehicle',
            action: 'order',
            company,
            vehicle: bus.id,
            orders: [
              { kind: 'station', target: station.id },
              { kind: 'depot', target: depot.id },
            ],
          });
          build({ type: 'vehicle', action: 'start', company, vehicle: bus.id });
          buses.push(bus.id);
        }

        const controller = api.world.getCameraController();
        const target = controller.getPose().target.clone();
        target.set(cx + 0.5, 0, cy + 0.5);
        controller.applyPose({ yaw: 0.68, pitch: 0.58, distance: 18, target });
        controller.setFov(42);
        return {
          site: { cx, cy },
          station: station.id,
          depots: depots.map((depot) => depot && { id: depot.id, direction: depot.direction }),
          buses,
        };
      },
      [...NATURAL],
    );

    ctx.assert(Boolean(built), 'le croisement et les quatre dépôts sont construits', built);
    if (!built) return;
    ctx.assert(built.depots.length === 4, 'quatre dépôts posés', built.depots);
    ctx.assert(built.buses.length === 4, 'un bus par dépôt', built.buses);

    await page.evaluate(() => {
      const game = window.__opentt3d.game;
      game.setPaused(false);
      game.setSpeed(2);
    });
    await sleep(2600);
    await page.evaluate(() => window.__opentt3d.game.setPaused(true));
    await sleep(350);

    const wide = await ctx.capture(page, 'depot-233');
    ctx.assert(Boolean(wide && wide.size > 20_000), 'la capture des dépôts est valide', wide);

    // Vue rapprochée sur le dépôt dont l’entrée regarde l’ouest : la porte et
    // la sortie du bus restent lisibles.
    await page.evaluate(({ cx, cy }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(cx + 1.5, 0, cy - 1.5);
      controller.applyPose({ yaw: 0.9, pitch: 0.42, distance: 7.5, target });
    }, built.site);
    await sleep(450);
    const close = await ctx.capture(page, 'depot-233-close');
    ctx.assert(Boolean(close && close.size > 20_000), 'la capture rapprochée est valide', close);
  },
};
