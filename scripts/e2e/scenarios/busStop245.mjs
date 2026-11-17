/**
 * Scénario — arrêt de bus compact sur le trottoir (#245) et flèche blanche du
 * fantôme de route à sens unique (#246).
 *
 * Construit une route droite est-ouest et une gare routière en passage, puis
 * pose la caméra côté trottoir : l'abri doit rester petit et collé au bord de
 * chaussée, jamais au centre de la voie. Le second plan montre une route à sens
 * unique déjà posée, puis le fantôme d'un tronçon à sens unique survolé : les
 * flèches blanches doivent être visibles et orientées comme sur la route.
 */

import { sleep } from '../cdp.mjs';
import { gameUrl, waitForHud } from '../helpers.mjs';

const NATURAL = new Set([1, 2, 3, 9]); // clear, grass, rough, trees

function projectTile(page, tile) {
  return page.evaluate(({ x, y }) => {
    const api = window.__opentt3d;
    const map = api?.world?.getMap?.();
    const camera = api?.renderer?.camera;
    const canvas = document.querySelector('#scene');
    if (!map?.heightMap || !camera || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const height = (map.heightMap[y * map.width + x] ?? 0) * 0.5;
    const vector = camera.position.clone();
    vector.set(x + 0.5, height + 0.08, y + 0.5);
    vector.project(camera);
    if (!(vector.z > -1 && vector.z < 1)) return null;
    return {
      x: Math.round(rect.left + (vector.x * 0.5 + 0.5) * rect.width),
      y: Math.round(rect.top + (-vector.y * 0.5 + 0.5) * rect.height),
    };
  }, tile);
}

function sceneInfo(page) {
  return page.evaluate(() => {
    const api = window.__opentt3d;
    const overlay = api?.world?.buildOverlay;
    const group = overlay?.group ?? null;
    const arrows = group?.children?.find?.((child) => child.name === 'build-oneway-arrows') ?? null;
    return {
      tool: api?.buildTool ?? null,
      roadDirection: api?.buildSettings?.road?.direction ?? null,
      overlayVisible: Boolean(group?.visible),
      arrowVisible: Boolean(arrows?.visible),
      arrowCount: arrows?.count ?? 0,
      arrowColour: arrows?.material?.color?.getHexString?.() ?? null,
    };
  });
}

export const busStop245 = {
  id: 'bus-stop-245',
  title: 'Arrêt de bus compact et flèche de sens unique (#245/#246)',
  timeoutMs: 120_000,
  async run(ctx) {
    const page = await ctx.newPage('bus-stop-245');
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await page.goto(gameUrl(ctx.baseUrl, 'autostart=1&engine=mock&size=96&quality=high&seed=245'));
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

    const site = await page.evaluate(
      (naturalValues) => {
        const natural = new Set(naturalValues);
        const api = window.__opentt3d;
        const map = api?.world?.getMap?.();
        if (!map) return null;
        const width = 13;
        const height = 6;
        for (let y = 3; y + height < map.height - 3; y += 1) {
          for (let x = 3; x + width < map.width - 3; x += 1) {
            const base = map.heightMap[y * map.width + x];
            let ok = true;
            for (let dy = 0; dy < height && ok; dy += 1) {
              for (let dx = 0; dx < width; dx += 1) {
                const index = (y + dy) * map.width + x + dx;
                if (!natural.has(map.kind[index]) || map.heightMap[index] !== base) {
                  ok = false;
                  break;
                }
              }
            }
            if (ok) return { x, y, base };
          }
        }
        return null;
      },
      [...NATURAL],
    );
    ctx.assert(Boolean(site), 'un terrain plat et dégagé est trouvé', site);
    if (!site) return;

    const built = await page.evaluate(({ x, y }) => {
      const api = window.__opentt3d;
      const game = api.game;
      const company = 0;
      const row = y + 4;
      const left = x;
      const right = x + 11;
      const stationTile = { x: x + 5, y: row };
      const command = (options) => game.issueCommand({ company, ...options });
      command({
        type: 'build',
        tool: 'road',
        from: { x: left, y: row },
        to: { x: right, y: row },
        options: { axis: 'x' },
      });
      command({
        type: 'build',
        tool: 'station',
        from: stationTile,
        options: { kind: 'road', direction: 'ne', drive_through: true },
      });
      // Second tronçon, à sens unique est, pour comparer le fantôme aux
      // flèches réellement posées sur la chaussée.
      const oneWayRow = y + 2;
      command({
        type: 'build',
        tool: 'road',
        from: { x: left, y: oneWayRow },
        to: { x: right - 4, y: oneWayRow },
        options: { axis: 'x', one_way: 'east' },
      });
      const snapshot = game.refresh();
      const station = snapshot.stations.find(
        (item) => item.kind === 'road' && item.x === stationTile.x + 0.5,
      );
      return {
        row,
        left,
        right,
        stationTile,
        oneWayRow,
        oneWayEnd: right - 4,
        station: station
          ? {
              id: station.id,
              driveThrough: Boolean(station.driveThrough),
              roadAxis: station.roadAxis ?? null,
            }
          : null,
      };
    }, site);
    ctx.assert(Boolean(built.station), 'la gare routière en passage est construite', built);
    if (!built.station) return;
    ctx.assert(built.station.driveThrough, 'la gare est bien un arrêt en passage', built.station);

    // Vue de trois quarts côté trottoir (+Z) : l'abri et son panneau sont
    // lisibles, la chaussée et le marquage central restent dégagés.
    await page.evaluate(({ stationTile }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(stationTile.x + 0.5, 0, stationTile.y + 0.5);
      controller.applyPose({ yaw: 0.06, pitch: 0.38, distance: 7.2, target });
      controller.setFov(40);
    }, built);
    await sleep(600);
    const stop = await ctx.capture(page, 'bus-stop-245');
    ctx.assert(Boolean(stop && stop.size > 20_000), 'la capture de l’arrêt est valide', stop);

    // Vue quasi verticale : contrôle visuel du débordement sur la chaussée.
    await page.evaluate(({ stationTile }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(stationTile.x + 0.5, 0, stationTile.y + 0.5);
      controller.applyPose({ yaw: 0.02, pitch: 0.9, distance: 5, target });
      controller.setFov(38);
    }, built);
    await sleep(450);
    const top = await ctx.capture(page, 'bus-stop-245-top');
    ctx.assert(Boolean(top && top.size > 20_000), 'la vue de dessus est valide', top);

    // Route à sens unique posée : cadrage sur la fin du tronçon et la tuile
    // libre qui suivra le fantôme.
    await page.evaluate(({ oneWayEnd, oneWayRow }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(oneWayEnd + 0.5, 0, oneWayRow + 0.5);
      controller.applyPose({ yaw: 0.18, pitch: 0.72, distance: 9, target });
      controller.setFov(40);
    }, built);
    await sleep(500);
    const arrows = await ctx.capture(page, 'oneway-road-245');
    ctx.assert(
      Boolean(arrows && arrows.size > 20_000),
      'la capture des flèches posées est valide',
      arrows,
    );

    // Outil route + rotation R jusqu'au sens unique est, puis drag maintenu :
    // le fantôme affiche ses propres flèches avant validation.
    await page.focusBody();
    await page.evaluate(() => window.__opentt3d.setBuildTool('road'));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const direction = await page.evaluate(
        () => window.__opentt3d?.buildSettings?.road?.direction ?? null,
      );
      if (direction === 'east') break;
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'r',
        code: 'KeyR',
        windowsVirtualKeyCode: 82,
        nativeVirtualKeyCode: 82,
      });
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'r',
        code: 'KeyR',
        windowsVirtualKeyCode: 82,
        nativeVirtualKeyCode: 82,
      });
      await sleep(80);
    }
    const settings = await page.evaluate(() => window.__opentt3d?.buildSettings ?? null);
    ctx.assert(
      settings?.road?.direction === 'east',
      'le fantôme est réglé en sens unique est',
      settings,
    );

    const from = await projectTile(page, { x: built.oneWayEnd + 1, y: built.oneWayRow });
    const to = await projectTile(page, { x: built.oneWayEnd + 3, y: built.oneWayRow });
    ctx.assert(Boolean(from && to), 'les tuiles du fantôme sont projetées à l’écran', { from, to });
    if (!from || !to) return;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 1,
    });
    await sleep(400);
    const ghostState = await sceneInfo(page);
    ctx.assert(ghostState.overlayVisible, 'le fantôme de route est affiché', ghostState);
    ctx.assert(ghostState.arrowVisible, 'le fantôme porte une flèche de sens unique', ghostState);
    ctx.assert(ghostState.arrowCount >= 2, 'une flèche par voie est instanciée', ghostState);
    ctx.assert(ghostState.arrowColour === 'ffffff', 'la flèche du fantôme est blanche', ghostState);
    const ghost = await ctx.capture(page, 'oneway-ghost-245');
    ctx.assert(Boolean(ghost && ghost.size > 20_000), 'la capture du fantôme est valide', ghost);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  },
};
