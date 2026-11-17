/**
 * Scénarios — ouvrages d'art (#243/#244).
 *
 * - `bridge-243` reproduit un vrai drag de souris qui déborde de deux tuiles
 *   de chaque côté d'une rivière. Les culées doivent se recaler sur les berges
 *   et le pont doit être construit.
 * - `tunnel-244` perce une colline, relie deux arrêts par une ligne de bus et
 *   attend que le bus soit dans la galerie : il doit disparaître, et la
 *   galerie (parois, plafond, obscurité) rester visible au portail.
 */

import { sleep } from '../cdp.mjs';
import { gameUrl, waitForHud } from '../helpers.mjs';

const NATURAL = [1, 2, 3, 5, 9];

export const bridge243 = {
  id: 'bridge-243',
  title: 'Pont : drag réel recalé sur les berges (#243)',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage('bridge-243');
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await page.goto(
      gameUrl(ctx.baseUrl, 'autostart=1&engine=mock&size=128&quality=high&seed=1337'),
    );
    await waitForHud(page, { timeout: 30_000 });
    await page.evaluate(() => window.__opentt3d?.game?.setPaused(true));
    await page.waitFor(() => Boolean(window.__opentt3d?.world?.getMap?.()), {
      timeout: 15_000,
      label: 'le monde 3D et sa carte',
    });

    const site = await page.evaluate((naturalValues) => {
      const api = window.__opentt3d;
      const map = api.world.getMap();
      if (!map) return null;
      const natural = new Set(naturalValues);
      const water = new Set([4, 18, 17, 19]);
      const candidates = [];
      for (let y = 4; y < map.height - 4; y += 1) {
        let x = 4;
        while (x < map.width - 4) {
          if (!water.has(map.kind[y * map.width + x])) {
            x += 1;
            continue;
          }
          let end = x;
          while (end + 1 < map.width - 4 && water.has(map.kind[y * map.width + end + 1])) {
            end += 1;
          }
          const run = end - x + 1;
          const west = x - 1;
          const east = end + 1;
          if (
            run >= 1 &&
            run <= 4 &&
            west >= 3 &&
            east <= map.width - 4 &&
            natural.has(map.kind[y * map.width + west]) &&
            natural.has(map.kind[y * map.width + east]) &&
            natural.has(map.kind[y * map.width + west - 2]) &&
            natural.has(map.kind[y * map.width + east + 2])
          ) {
            const wh = map.heightMap[y * map.width + west];
            const eh = map.heightMap[y * map.width + east];
            const wa = map.heightMap[y * map.width + west - 1];
            const ea = map.heightMap[y * map.width + east + 1];
            const ramp = (height, bank) => height <= bank && bank - height <= 1;
            let clear = true;
            for (let dy = -2; dy <= 2 && clear; dy += 1) {
              for (let dx = -3; dx <= 3; dx += 1) {
                const kind = map.kind[(y + dy) * map.width + west + dx];
                if (kind === 12 || kind === 13) {
                  clear = false;
                  break;
                }
              }
            }
            if (
              clear &&
              Math.abs(wh - eh) <= 1 &&
              ramp(wa, wh) &&
              ramp(ea, eh) &&
              natural.has(map.kind[y * map.width + west - 1]) &&
              natural.has(map.kind[y * map.width + east + 1])
            ) {
              candidates.push({ y, west, east, run, wh, eh });
            }
          }
          x = end + 1;
        }
      }
      // On évite les bords de carte et les zones de démonstration.
      candidates.sort(
        (a, b) =>
          Math.abs(a.y - map.height * 0.45) - Math.abs(b.y - map.height * 0.45) ||
          Math.abs(a.west - map.width * 0.45) - Math.abs(b.west - map.width * 0.45),
      );
      return candidates[0] ?? null;
    }, NATURAL);
    ctx.assert(Boolean(site), 'une rivière franchissable est trouvée', site);
    if (!site) return;

    await page.evaluate((found) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set((found.west + found.east + 1) / 2, 0, found.y + 0.5);
      controller.applyPose({ yaw: 0.04, pitch: 0.58, distance: 16, target });
      controller.setFov(42);
    }, site);
    await sleep(700);

    const points = await page.evaluate((found) => {
      const api = window.__opentt3d;
      const map = api.world.getMap();
      const camera = api.renderer.camera;
      const rect = document.querySelector('#scene').getBoundingClientRect();
      const project = (x, y) => {
        const height = (map.heightMap[y * map.width + x] ?? 0) * 0.5;
        const vector = camera.position.clone();
        vector.set(x + 0.5, height + 0.1, y + 0.5);
        vector.project(camera);
        return {
          x: rect.left + (vector.x * 0.5 + 0.5) * rect.width,
          y: rect.top + (-vector.y * 0.5 + 0.5) * rect.height,
        };
      };
      // Le geste part deux tuiles avant la berge et finit deux tuiles après :
      // un drag humain qui ne vise pas le bord exact de l'eau.
      return {
        start: project(found.west - 2, found.y),
        end: project(found.east + 2, found.y),
      };
    }, site);

    await page.click('[data-tool="bridge"]');
    await page.waitFor(
      () => document.querySelector('[data-tool="bridge"]')?.getAttribute('aria-pressed') === 'true',
      { timeout: 5_000, label: 'l’outil Pont actif' },
    );
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(points.start.x),
      y: Math.round(points.start.y),
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(points.start.x),
      y: Math.round(points.start.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    const steps = 12;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(points.start.x + (points.end.x - points.start.x) * t),
        y: Math.round(points.start.y + (points.end.y - points.start.y) * t),
        button: 'left',
        buttons: 1,
      });
    }
    await sleep(250);
    const preview = await page.evaluate(() => {
      const plan = window.__opentt3d?.session?.buildController?.currentPlan ?? null;
      return plan
        ? {
            from: plan.from,
            to: plan.to,
            valid: plan.valid,
            reason: plan.reason,
            span: plan.bridge?.span,
          }
        : null;
    });
    ctx.assert(preview?.valid === true, 'le drag débordant produit un pont valide', preview);
    ctx.assert(
      preview?.from?.x === site.west &&
        preview?.from?.y === site.y &&
        preview?.to?.x === site.east &&
        preview?.to?.y === site.y,
      'les culées sont recalées sur les deux berges',
      { preview, site },
    );
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(points.end.x),
      y: Math.round(points.end.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(900);

    const built = await page.evaluate(() => {
      const api = window.__opentt3d;
      const snapshot = api.game.getLatestSnapshot();
      const bridges = (snapshot.structures ?? []).filter(
        (structure) => structure.kind === 'bridge',
      );
      return {
        last: bridges[bridges.length - 1] ?? null,
        count: bridges.length,
        news: snapshot.news.slice(-6).map((item) => item.text),
      };
    });
    ctx.assert(
      built.last?.from.x === site.west &&
        built.last?.from.y === site.y &&
        built.last?.to.x === site.east &&
        built.last?.to.y === site.y,
      'le pont construit couvre exactement la rivière',
      built,
    );
    ctx.assert(
      built.news.some((text) => /Pont en .* construit/.test(text)),
      'une actualité confirme la construction du pont',
      built.news,
    );

    await page.evaluate((found) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set((found.west + found.east + 1) / 2, 0, found.y + 0.5);
      controller.applyPose({ yaw: 0.5, pitch: 0.4, distance: 14, target });
      controller.setFov(44);
    }, site);
    await sleep(500);
    const wide = await ctx.capture(page, 'bridge-243');
    ctx.assert(Boolean(wide && wide.size > 20_000), 'la capture du pont est valide', wide);

    await page.evaluate((found) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set((found.west + found.east + 1) / 2, 4.2, found.y + 0.5);
      controller.applyPose({ yaw: 0.5, pitch: 0.38, distance: 10, target });
    }, site);
    await sleep(450);
    const close = await ctx.capture(page, 'bridge-243-close');
    ctx.assert(
      Boolean(close && close.size > 20_000),
      'la capture rapprochée du pont est valide',
      close,
    );
  },
};

export const tunnel244 = {
  id: 'tunnel-244',
  title: 'Tunnel : galerie et véhicule masqué (#244)',
  timeoutMs: 120_000,
  async run(ctx) {
    const page = await ctx.newPage('tunnel-244');
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

    const built = await page.evaluate((naturalValues) => {
      const api = window.__opentt3d;
      const game = api.game;
      const map = api.world.getMap();
      if (!map) return { error: 'carte indisponible' };
      const natural = new Set(naturalValues);
      let site = null;
      for (const [width, height] of [
        [22, 12],
        [18, 10],
        [14, 8],
      ]) {
        for (let y = 4; y + height < map.height - 4 && !site; y += 1) {
          for (let x = 4; x + width < map.width - 4; x += 1) {
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
            if (ok) {
              site = { x, y, base };
              break;
            }
          }
        }
        if (site) break;
      }
      if (!site) return { error: 'aucun plateau naturel pour la colline' };

      // Dégage les arbres de la zone du chantier.
      for (let ty = site.y - 2; ty <= site.y + 12; ty += 1) {
        for (let tx = site.x - 2; tx <= site.x + 22; tx += 1) {
          if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
          const index = ty * map.width + tx;
          if (map.kind[index] !== 9) continue;
          game.issueCommand({
            type: 'build',
            tool: 'clear',
            company: 0,
            from: { x: tx, y: ty },
            to: { x: tx, y: ty },
          });
        }
      }

      const cx = site.x + 10;
      const cy = site.y + 6;
      const terraform = (from, to) =>
        game.issueCommand({
          type: 'build',
          tool: 'terraform',
          company: 0,
          from,
          to,
          options: { direction: 'up' },
        });
      // Talus d'un niveau au contact des portails, cœur de colline à quatre
      // niveaux : une falaise verticale ne serait pas un portail régulier.
      terraform({ x: cx - 1, y: cy - 2 }, { x: cx - 1, y: cy + 2 });
      for (let step = 0; step < 4; step += 1) {
        terraform({ x: cx, y: cy - 2 }, { x: cx + 2, y: cy + 2 });
      }
      terraform({ x: cx + 3, y: cy - 2 }, { x: cx + 3, y: cy + 2 });

      const road = (from, to) =>
        game.issueCommand({
          type: 'build',
          tool: 'road',
          company: 0,
          from,
          to,
          options: { axis: 'x' },
        });
      road({ x: cx - 9, y: cy }, { x: cx - 3, y: cy });
      road({ x: cx + 4, y: cy }, { x: cx + 9, y: cy });
      game.issueCommand({
        type: 'build',
        tool: 'station',
        company: 0,
        from: { x: cx - 8, y: cy },
        options: { kind: 'road', direction: 'ne', drive_through: true },
      });
      game.issueCommand({
        type: 'build',
        tool: 'station',
        company: 0,
        from: { x: cx + 8, y: cy },
        options: { kind: 'road', direction: 'ne', drive_through: true },
      });
      game.issueCommand({
        type: 'build',
        tool: 'depot',
        company: 0,
        from: { x: cx - 7, y: cy - 1 },
        options: { kind: 'road', direction: 'se' },
      });
      game.issueCommand({
        type: 'build',
        tool: 'tunnel',
        company: 0,
        from: { x: cx - 2, y: cy },
        to: { x: cx + 3, y: cy },
        options: { kind: 'road' },
      });

      let snapshot = game.refresh();
      const stations = snapshot.stations.filter(
        (station) =>
          station.kind === 'road' &&
          Math.abs(station.y - (cy + 0.5)) < 1.1 &&
          Math.abs(Math.abs(station.x - (cx + 0.5)) - 8) < 1.1,
      );
      const depot = snapshot.depots.find((item) => item.x === cx - 7 && item.y === cy - 1);
      const tunnel = snapshot.structures.find((structure) => structure.kind === 'tunnel');
      if (!tunnel || stations.length < 2 || !depot) {
        return {
          error: 'tunnel, gares ou dépôt manquant',
          news: snapshot.news.map((item) => item.text),
          stations,
          depot,
          tunnel,
        };
      }
      const stationA = stations.find((station) => station.x < cx + 0.5) ?? stations[0];
      const stationB = stations.find((station) => station.x > cx + 0.5) ?? stations[1];
      game.issueCommand({
        type: 'vehicle',
        action: 'buy',
        company: 0,
        depotId: depot.id,
        model: 'bus_city',
      });
      snapshot = game.refresh();
      const bus = snapshot.vehicles[snapshot.vehicles.length - 1];
      if (!bus)
        return { error: 'bus non acheté', news: snapshot.news.slice(-8).map((i) => i.text) };
      game.issueCommand({
        type: 'vehicle',
        action: 'order',
        company: 0,
        vehicle: bus.id,
        orders: [
          { kind: 'station', target: stationA.id },
          { kind: 'station', target: stationB.id },
          { kind: 'depot', target: depot.id },
        ],
      });
      game.issueCommand({ type: 'vehicle', action: 'start', company: 0, vehicle: bus.id });
      snapshot = game.refresh();
      const routeNews = snapshot.news.slice(-4).map((item) => item.text);
      if (routeNews.some((text) => text.includes('refusée'))) {
        return { error: 'itinéraire du bus refusé', news: routeNews, tunnel, stations, depot };
      }
      const controller = api.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(tunnel.from.x + 0.5, 0, tunnel.from.y + 0.5);
      controller.applyPose({ yaw: -Math.PI / 2 + 0.22, pitch: 0.22, distance: 8.5, target });
      controller.setFov(46);
      return {
        cx,
        cy,
        tunnel,
        bus: bus.id,
        stations: [stationA.id, stationB.id],
        depot: depot.id,
        news: snapshot.news.slice(-8).map((item) => item.text),
      };
    }, NATURAL);

    ctx.assert(!built.error, 'la ligne de bus traversant le tunnel est construite', built);
    if (built.error) return;
    ctx.assert(Boolean(built.tunnel), 'le tunnel est présent dans le snapshot', built.tunnel);

    await page.evaluate(() => {
      const game = window.__opentt3d.game;
      game.setPaused(false);
      game.setSpeed(2);
    });

    let inside = null;
    let approach = null;
    let approachCaptured = false;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate((busId) => {
        const api = window.__opentt3d;
        const snapshot = api.game.getLatestSnapshot();
        const bus = snapshot?.vehicles?.find((vehicle) => vehicle.id === busId);
        const layer = api.world.vehicles;
        // Diagnostic du rendu : le bus est-il encore dans un slot instancié ?
        const busVisible = [...layer.slots.values()].some((slot) =>
          slot.ids.slice(0, slot.used).includes(busId),
        );
        return {
          bus: bus ? { x: bus.x, y: bus.y, status: bus.status } : null,
          visible: api.world.vehicles.instanceCount,
          busVisible,
        };
      }, built.bus);
      if (state.bus) {
        const alongX = built.tunnel.from.y === built.tunnel.to.y;
        const total = alongX
          ? Math.abs(built.tunnel.to.x - built.tunnel.from.x)
          : Math.abs(built.tunnel.to.y - built.tunnel.from.y);
        const along = alongX
          ? (state.bus.x - (built.tunnel.from.x + 0.5)) *
            Math.sign(built.tunnel.to.x - built.tunnel.from.x)
          : (state.bus.y - (built.tunnel.from.y + 0.5)) *
            Math.sign(built.tunnel.to.y - built.tunnel.from.y);
        if (!approach && along > -0.8 && along < -0.05) {
          approach = { ...state, along, total };
        }
        if (approach && !approachCaptured) {
          // Fige la simulation avant que le bus n'entre dans la galerie.
          await page.evaluate(() => window.__opentt3d.game.setPaused(true));
          const shot = await ctx.capture(page, 'tunnel-244-approach');
          ctx.assert(
            Boolean(shot && shot.size > 20_000),
            'la capture du bus au portail est valide',
            shot,
          );
          approachCaptured = true;
          await page.evaluate(() => window.__opentt3d.game.setPaused(false));
        }
        if (along > 1.1 && along < total - 1.1) {
          inside = { ...state, along, total };
          break;
        }
      }
      await sleep(120);
    }

    ctx.assert(Boolean(approach), 'le bus arrive au portail', approach);
    if (approach) {
      ctx.assert(approach.busVisible === true, 'le bus est encore visible au portail', approach);
    }

    ctx.assert(Boolean(inside), 'le bus est engagé dans la galerie', inside);
    if (!inside) return;
    ctx.assert(inside.busVisible === false, 'le bus est masqué à l’intérieur de la galerie', {
      approach,
      inside,
    });

    await page.evaluate(() => window.__opentt3d.game.setPaused(true));
    await page.evaluate(({ tunnel }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(tunnel.from.x + 0.5, 0, tunnel.from.y + 0.5);
      controller.applyPose({ yaw: -Math.PI / 2 + 0.32, pitch: 0.1, distance: 4.8, target });
      controller.setFov(48);
    }, built);
    await sleep(350);
    const gallery = await ctx.capture(page, 'tunnel-244-gallery');
    ctx.assert(
      Boolean(gallery && gallery.size > 20_000),
      'la capture de la galerie est valide',
      gallery,
    );

    await page.evaluate(({ tunnel }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set((tunnel.from.x + tunnel.to.x) / 2 + 0.5, 0, tunnel.from.y + 0.5);
      controller.applyPose({ yaw: 0.45, pitch: 0.6, distance: 18, target });
      controller.setFov(44);
    }, built);
    await sleep(450);
    const wide = await ctx.capture(page, 'tunnel-244-wide');
    ctx.assert(Boolean(wide && wide.size > 20_000), 'la capture large du tunnel est valide', wide);
  },
};
