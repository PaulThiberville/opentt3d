/**
 * Scénario — bus bloqués au dépôt et rotation (#247).
 *
 * Construit une boucle routière compacte avec quatre dépôts, un par
 * orientation. Le dépôt nord est posé **dans** la route du haut : la route
 * existe de part et d'autre de sa porte (est) et un contournement par le tour
 * de la boucle permet de rejoindre la gare à l'ouest. Avant #247, A* coupait
 * par la tuile du dépôt, déclenchait une arrivée fantôme juste après la sortie
 * et le bus oscillait sur place ; la rotation au repos était aussi décalée de
 * 45°.
 *
 * Les captures montrent les bus garés (orientation de porte), puis la flotte
 * en circulation après quelques secondes. Les assertions portent sur les
 * événements réels et la direction des bus, pas sur des unités internes.
 */

import { sleep } from '../cdp.mjs';
import { gameUrl, waitForHud } from '../helpers.mjs';

const NATURAL = new Set([1, 2, 3, 9]); // clear, grass, rough, trees

export const depot247 = {
  id: 'depot-247',
  title: 'Bus bloqués au dépôt et rotation (#247)',
  timeoutMs: 120_000,
  async run(ctx) {
    const page = await ctx.newPage('depot-247');
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
        const DOOR_DIRECTION = { ne: 64, se: 128, sw: 192, nw: 0 };
        const natural = new Set(naturalValues);
        const api = window.__opentt3d;
        const game = api.game;
        const map = api.world.getMap();
        if (!map) return null;
        let site = null;
        for (const [w, h] of [
          [12, 10],
          [10, 8],
          [8, 6],
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
                site = { x, y, width: w, height: h };
                break;
              }
            }
          }
          if (site) break;
        }
        if (!site) return null;

        const company = 0;
        const x0 = site.x + 1;
        const x1 = site.x + 6;
        const y0 = site.y + 1;
        const y1 = site.y + 4;
        const depotTop = x0 + 3;
        const build = (command) => game.issueCommand(command);
        const road = (x, y) =>
          build({
            type: 'build',
            tool: 'road',
            company,
            from: { x, y },
            to: { x, y },
            options: { axis: 'x' },
          });

        // Boucle : le dépôt nord occupe une tuile de la route du haut.
        for (let x = x0; x <= depotTop - 1; x += 1) road(x, y0);
        for (let x = depotTop + 1; x <= x1; x += 1) road(x, y0);
        for (let y = y0 + 1; y <= y1; y += 1) {
          road(x0, y);
          road(x1, y);
        }
        for (let x = x0; x <= x1; x += 1) road(x, y1);

        const stationTile = { x: x0 - 1, y: y0 + 2 };
        build({
          type: 'build',
          tool: 'station',
          company,
          from: stationTile,
          options: { kind: 'road', direction: 'ne' },
        });

        const depotTiles = [
          { x: depotTop, y: y0, expected: 'ne' }, // dans la route du haut, porte est
          { x: x0 + 1, y: y0 - 1, expected: 'se' }, // au nord, porte sud
          { x: x1 + 1, y: y0 + 1, expected: 'sw' }, // à l'est, porte ouest
          { x: x0 + 4, y: y1 + 1, expected: 'nw' }, // au sud, porte nord
        ];
        for (const tile of depotTiles) {
          build({ type: 'build', tool: 'depot', company, from: tile, options: { kind: 'road' } });
        }

        const snapshot = game.refresh();
        const station = snapshot.stations.find(
          (item) => item.kind === 'road' && Math.floor(item.x) === stationTile.x,
        );
        const depots = depotTiles.map((tile) =>
          snapshot.depots.find((item) => item.x === tile.x && item.y === tile.y),
        );
        if (!station || depots.some((depot) => !depot)) return null;

        const buses = [];
        for (let index = 0; index < depots.length; index += 1) {
          const depot = depots[index];
          if (!depot) continue;
          build({ type: 'vehicle', action: 'buy', company, depotId: depot.id, model: 'bus_city' });
          const afterBuy = game.refresh();
          const bus = afterBuy.vehicles[afterBuy.vehicles.length - 1];
          if (!bus) continue;
          buses.push({
            id: bus.id,
            depotId: depot.id,
            depotX: depot.x,
            depotY: depot.y,
            direction: DOOR_DIRECTION[depotTiles[index].expected],
            expected: depotTiles[index].expected,
          });
        }

        const controller = api.world.getCameraController();
        const target = controller.getPose().target.clone();
        target.set(depotTop + 0.5, 0, y0 + 2.5);
        controller.applyPose({ yaw: 0.72, pitch: 0.58, distance: 17, target });
        controller.setFov(42);

        return {
          site,
          loop: { x0, x1, y0, y1, depotTop },
          stationId: station.id,
          depots: depots.map(
            (depot) =>
              depot && { id: depot.id, x: depot.x, y: depot.y, direction: depot.direction },
          ),
          buses,
        };
      },
      [...NATURAL],
    );

    ctx.assert(Boolean(built), 'la boucle et les quatre dépôts sont construits', built);
    if (!built) return;
    ctx.assert(built.depots.length === 4, 'quatre dépôts posés', built.depots);
    ctx.assert(built.buses.length === 4, 'un bus par dépôt', built.buses);

    // --- Avant démarrage : orientation au repos et porte -------------------
    // Les valeurs sont vérifiées après le run, pour que les deux captures
    // existent même si une régression réapparaît (#247).
    const parked = await page.evaluate(() => {
      const snapshot = window.__opentt3d.game.getLatestSnapshot();
      return snapshot.vehicles.map((vehicle) => ({
        id: vehicle.id,
        x: vehicle.x,
        y: vehicle.y,
        direction: vehicle.direction,
        status: vehicle.status,
      }));
    });

    await page.evaluate(({ depotTop, y0 }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(depotTop + 0.5, 0, y0 + 0.5);
      controller.applyPose({ yaw: 0.95, pitch: 0.36, distance: 4.2, target });
    }, built.loop);
    await sleep(400);
    const parkedShot = await ctx.capture(page, 'depot-247-parked');
    ctx.assert(
      Boolean(parkedShot && parkedShot.size > 20_000),
      'capture des bus garés valide',
      parkedShot,
    );

    // --- Démarrage et observation en jeu réel ------------------------------
    await page.evaluate(
      ({ stationId, buses }) => {
        const game = window.__opentt3d.game;
        for (const bus of buses) {
          game.issueCommand({
            type: 'vehicle',
            action: 'order',
            company: 0,
            vehicle: bus.id,
            orders: [
              { kind: 'station', target: stationId },
              { kind: 'depot', target: bus.depotId },
            ],
          });
          game.issueCommand({ type: 'vehicle', action: 'start', company: 0, vehicle: bus.id });
        }
        game.refresh();
        game.setPaused(false);
        game.setSpeed(2);
      },
      { stationId: built.stationId, buses: built.buses },
    );

    const busIds = built.buses.map((bus) => bus.id);
    const arrivals = new Map(busIds.map((id) => [id, []]));
    const seenEvents = new Set();
    const maxDistance = new Map(busIds.map((id) => [id, 0]));
    let nonCardinal = null;
    let misaligned = null;
    let previous = new Map();

    for (let sample = 0; sample < 50; sample += 1) {
      await sleep(200);
      const state = await page.evaluate((ids) => {
        const game = window.__opentt3d.game;
        const snapshot = game.getLatestSnapshot();
        const buffered = game.getSnapshotBuffer?.() ?? [];
        return {
          tick: snapshot.meta.tick,
          vehicles: snapshot.vehicles
            .filter((vehicle) => ids.includes(vehicle.id))
            .map((vehicle) => ({
              id: vehicle.id,
              x: vehicle.x,
              y: vehicle.y,
              direction: vehicle.direction,
              status: vehicle.status,
            })),
          events: buffered.flatMap((entry) =>
            entry.snapshot.events
              .filter((event) => ids.includes(event.vehicle))
              .map((event) => ({
                type: event.type,
                vehicle: event.vehicle,
                station: event.station,
                tick: event.tick,
              })),
          ),
        };
      }, busIds);

      for (const event of state.events) {
        const key = `${event.vehicle}:${event.type}:${event.station ?? '-'}:${event.tick}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        if (event.type === 'vehicle_arrived' && event.station !== undefined) {
          arrivals.get(event.vehicle)?.push(event.station);
        }
      }

      for (const vehicle of state.vehicles) {
        if (vehicle.direction % 64 !== 0) nonCardinal ??= vehicle;
        const bus = built.buses.find((item) => item.id === vehicle.id);
        if (bus) {
          const dx = vehicle.x - (bus.depotX + 0.5);
          const dy = vehicle.y - (bus.depotY + 0.5);
          maxDistance.set(
            vehicle.id,
            Math.max(maxDistance.get(vehicle.id) ?? 0, Math.hypot(dx, dy)),
          );
        }
        const last = previous.get(vehicle.id);
        if (last && last.status === 1 && vehicle.status === 1) {
          const dx = vehicle.x - last.x;
          const dy = vehicle.y - last.y;
          const distance = Math.hypot(dx, dy);
          // Un échantillon qui chevauche un virage donne une corde diagonale :
          // on ne compare la direction qu'aux déplacements alignés sur un axe.
          const axisAligned = Math.abs(dx) < 0.02 || Math.abs(dy) < 0.02;
          if (axisAligned && distance > 0.05 && distance < 0.8) {
            const expected = Math.round((Math.atan2(dx, -dy) / (Math.PI * 2)) * 256) & 255;
            const delta = Math.abs(((vehicle.direction - expected + 384) % 256) - 128);
            if (delta > 40) {
              misaligned ??= { ...vehicle, expected, delta, from: last, to: vehicle };
            }
          }
        }
      }
      previous = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle]));
    }

    await page.evaluate(() => window.__opentt3d.game.setPaused(true));
    await page.evaluate(({ depotTop, y0 }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(depotTop + 0.5, 0, y0 + 0.5);
      controller.applyPose({ yaw: 0.95, pitch: 0.4, distance: 7, target });
    }, built.loop);
    await sleep(400);
    const depotShot = await ctx.capture(page, 'depot-247-depot');
    ctx.assert(
      Boolean(depotShot && depotShot.size > 20_000),
      'capture du dépôt traversant valide',
      depotShot,
    );

    await page.evaluate(({ depotTop, y0 }) => {
      const controller = window.__opentt3d.world.getCameraController();
      const target = controller.getPose().target.clone();
      target.set(depotTop + 0.5, 0, y0 + 2.5);
      controller.applyPose({ yaw: 0.72, pitch: 0.58, distance: 17, target });
    }, built.loop);
    await sleep(400);
    const fleetShot = await ctx.capture(page, 'depot-247-fleet');
    ctx.assert(
      Boolean(fleetShot && fleetShot.size > 20_000),
      'capture de la flotte valide',
      fleetShot,
    );

    // --- Assertions de comportement ---------------------------------------
    const problems = [];
    if (nonCardinal) problems.push({ kind: 'direction non cardinale', vehicle: nonCardinal });
    if (misaligned) problems.push({ kind: 'rotation hors trajectoire', vehicle: misaligned });

    for (const bus of built.buses) {
      const vehicle = parked.find((item) => item.id === bus.id);
      if (!vehicle) {
        problems.push({ kind: 'bus absent', bus: bus.id });
      } else {
        if (vehicle.status !== 3) problems.push({ kind: 'bus non garé', bus: bus.id, vehicle });
        if (vehicle.direction !== bus.direction) {
          problems.push({
            kind: 'orientation de porte incorrecte',
            bus: bus.id,
            expected: bus.direction,
            actual: vehicle.direction,
          });
        }
        if (vehicle.direction % 64 !== 0) {
          problems.push({
            kind: 'rotation diagonale au repos',
            bus: bus.id,
            direction: vehicle.direction,
          });
        }
      }

      const stops = arrivals.get(bus.id) ?? [];
      const distance = maxDistance.get(bus.id) ?? 0;
      if (stops.length === 0 || distance <= 3) {
        problems.push({ kind: 'bus bloqué au dépôt', bus: bus.id, stops, distance });
      } else if (stops[0] !== built.stationId) {
        problems.push({
          kind: 'arrivée au dépôt en sortant',
          bus: bus.id,
          firstArrival: stops[0],
          stationId: built.stationId,
          stops,
        });
      }
      const depotArrivals = stops.filter((stop) => stop === bus.depotId).length;
      const stationArrivals = stops.filter((stop) => stop === built.stationId).length;
      if (depotArrivals > stationArrivals) {
        problems.push({
          kind: 'ordre courant incohérent',
          bus: bus.id,
          depotArrivals,
          stationArrivals,
          stops,
        });
      }
    }
    ctx.assert(problems.length === 0, 'aucune anomalie de dépôt ni de rotation (#247)', problems);
  },
};
