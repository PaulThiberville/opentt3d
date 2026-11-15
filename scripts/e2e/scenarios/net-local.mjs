/**
 * Scénario 3 — réseau local à deux onglets.
 *
 * Crée un salon BroadcastChannel (`?net=local`), joint depuis un second onglet,
 * démarre la partie, vérifie que les deux HUD avancent sans resync sur une
 * fenêtre de hash complète, qu'une route construite par l'hôte apparaît chez
 * l'invité, puis provoque volontairement une divergence pour vérifier que le
 * lockstep la détecte et resynchronise.
 */

import { sleep } from '../cdp.mjs';
import {
  buildRoad,
  createLocalRoom,
  forceDivergence,
  joinLocalRoom,
  readyUp,
  readRoadCount,
  readState,
  sampleNetwork,
  startHostGame,
  waitForHud,
  waitForResync,
} from '../helpers.mjs';

function networkText(page) {
  return page.evaluate(() => document.querySelector('.hud-net')?.textContent?.trim() ?? null);
}

async function waitForNetText(page, pattern, timeout = 20_000) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = pattern instanceof RegExp ? pattern.flags : '';
  await page.waitFor(
    (expression, expressionFlags) => {
      const text = document.querySelector('.hud-net')?.textContent ?? '';
      return new RegExp(expression, expressionFlags).test(text);
    },
    { timeout, label: `le statut réseau ${source}` },
    source,
    flags,
  );
}

async function waitForRoadCount(page, expected, timeout = 15_000) {
  await page.waitFor(
    (count) => {
      const map = window.__opentt3d?.world?.getMap?.();
      if (!map?.kind) return false;
      let total = 0;
      for (const value of map.kind) if (value === 7) total += 1;
      return total === count;
    },
    { timeout, label: `${expected} tuiles route` },
    expected,
  );
}

export const netLocal = {
  id: 'net-local',
  title: 'Réseau local : salon, deux pairs, hashes et resync',
  timeoutMs: 180_000,
  async run(ctx) {
    const host = await ctx.newPage('host');
    const client = await ctx.newPage('client');
    host.baseUrl = ctx.baseUrl;
    client.baseUrl = ctx.baseUrl;

    const invite = await createLocalRoom(host, ctx.baseUrl, {
      lobbyName: 'Salon E2E local',
      playerName: 'Hôte E2E',
      seed: 424242,
    });
    ctx.check('salon local créé avec un lien d’invitation', invite);
    await joinLocalRoom(client, invite, 2, { playerName: 'Invité E2E' });
    await host.waitFor(() => document.querySelectorAll('.lobby-screen .slot-row').length >= 2, {
      timeout: 20_000,
      label: 'le second joueur côté hôte',
    });
    ctx.check('les deux onglets voient deux joueurs dans le salon');
    await ctx.capture(host, 'lobby-host');
    await ctx.capture(client, 'lobby-client');

    await readyUp(client);
    await startHostGame(host);
    await waitForHud(client, { timeout: 30_000 });
    await client.waitFor(() => window.__opentt3d?.netStatus !== null, {
      timeout: 20_000,
      label: 'la session réseau de l’invité',
    });
    ctx.check('les deux pairs ont démarré la partie');

    await waitForNetText(host, /Hôte · tick \d+/, 20_000);
    await waitForNetText(client, /Invité · ping/, 20_000);
    await sleep(2_000);
    const startHost = await sampleNetwork(host);
    const startClient = await sampleNetwork(client);
    ctx.assert(Boolean(startHost && startClient), 'les deux sessions réseau exposent des stats', {
      startHost,
      startClient,
    });

    await sleep(2_500);
    const hostState = await readState(host);
    const clientState = await readState(client);
    ctx.assert(
      (hostState.debug?.tick ?? 0) > (startHost?.tick ?? 0) + 5,
      'le tick de l’hôte avance',
      { from: startHost?.tick, to: hostState.debug?.tick },
    );
    ctx.assert(
      (clientState.debug?.tick ?? 0) > (startClient?.tick ?? 0) + 5,
      'le tick de l’invité avance',
      { from: startClient?.tick, to: clientState.debug?.tick },
    );

    const hostLabel = await networkText(host);
    const clientLabel = await networkText(client);
    ctx.assert(
      Boolean(hostLabel && /aucun resync/.test(hostLabel)),
      'le HUD de l’hôte ne signale aucun resync avant le test de divergence',
      hostLabel,
    );
    ctx.assert(
      Boolean(clientLabel && /aucun resync/.test(clientLabel)),
      'le HUD de l’invité ne signale aucun resync avant le test de divergence',
      clientLabel,
    );

    const beforeRoads = await readRoadCount(host);
    const built = await buildRoad(host);
    ctx.assert(
      beforeRoads >= 0 && built.after > beforeRoads,
      'l’hôte construit une route pendant la partie réseau',
      built,
    );
    await waitForRoadCount(client, built.after, 20_000);
    const hostRoads = await readRoadCount(host);
    const clientRoads = await readRoadCount(client);
    ctx.assert(
      hostRoads === clientRoads,
      'la route de l’hôte est répliquée à l’identique chez l’invité',
      { hostRoads, clientRoads },
    );

    // Les hashes sont échangés toutes les 50 ticks. Attendre une fenêtre
    // complète sans resync prouve que les états post-construction concordent,
    // sans dépendre d'un échantillonnage simultané de deux moteurs.
    const afterBuild = await sampleNetwork(host);
    const hashWindowTarget = (afterBuild?.tick ?? 0) + 60;
    await host.waitFor(
      (target) => (window.__opentt3d?.netStatus?.tick ?? 0) >= target,
      { timeout: 45_000, label: `le tick ${hashWindowTarget} (fenêtre de hash)` },
      hashWindowTarget,
    );
    const afterHashWindow = await Promise.all([host, client].map((page) => sampleNetwork(page)));
    ctx.assert(
      afterHashWindow.every((state) => state?.desyncs === 0),
      'aucun resync sur une fenêtre complète de comparaison de hashes après construction',
      afterHashWindow.map((state) => state?.desyncs),
    );
    await waitForNetText(host, /aucun resync/, 10_000);
    await waitForNetText(client, /aucun resync/, 10_000);
    ctx.check(`hashes stables sur la fenêtre ${afterBuild?.tick} → ${hashWindowTarget}`);

    await ctx.capture(host, 'host-game');
    await ctx.capture(client, 'client-game');

    // Divergence volontaire : une commande directe au moteur du client, hors
    // lockstep. Le prochain cycle de hash (50 ticks) doit la détecter.
    const forced = await forceDivergence(client);
    ctx.assert(forced.ok, 'une commande locale a pu être injectée hors lockstep', forced);
    const resyncStates = await waitForResync([host, client], 90_000);
    const desyncs = resyncStates.reduce((sum, state) => sum + (state?.desyncs ?? 0), 0);
    ctx.assert(desyncs > 0, 'un désaccord de hash a été détecté et un resync déclenché', {
      desyncs,
      states: resyncStates,
    });
    ctx.check('désaccord de hash détecté par le lockstep', resyncStates);

    await waitForNetText(host, /[1-9]\d* resync/, 15_000);
    await waitForNetText(client, /[1-9]\d* resync/, 15_000);
    await sleep(3_000);

    // Après le resync, le compteur doit se stabiliser et les ticks continuer.
    // Une divergence persistante relancerait des resyncs à chaque cycle.
    const stableBefore = await Promise.all([host, client].map((page) => sampleNetwork(page)));
    await sleep(2_000);
    const stableAfter = await Promise.all([host, client].map((page) => sampleNetwork(page)));
    ctx.assert(
      stableAfter.every(
        (state, index) => (state?.desyncs ?? -1) === (stableBefore[index]?.desyncs ?? -2),
      ),
      'aucun nouveau resync après la reprise : les hashes sont reconvergés',
      {
        before: stableBefore.map((state) => state?.desyncs),
        after: stableAfter.map((state) => state?.desyncs),
      },
    );
    ctx.assert(
      (stableAfter[0]?.tick ?? 0) > (stableBefore[0]?.tick ?? 0) + 2 &&
        (stableAfter[1]?.tick ?? 0) > (stableBefore[1]?.tick ?? 0) + 2,
      'la simulation continue d’avancer après le resync',
      {
        before: stableBefore.map((state) => state?.tick),
        after: stableAfter.map((state) => state?.tick),
      },
    );
    const finalHostRoads = await readRoadCount(host);
    const finalClientRoads = await readRoadCount(client);
    ctx.assert(
      finalHostRoads === finalClientRoads,
      'les deux cartes sont identiques après le resync',
      { finalHostRoads, finalClientRoads },
    );
    ctx.check(
      `resync stabilisé (${stableAfter[0]?.desyncs ?? 0} resync, ticks ${stableAfter
        .map((state) => state?.tick)
        .join('/')})`,
    );

    await ctx.capture(host, 'host-resync');
    await ctx.capture(client, 'client-resync');
  },
};
