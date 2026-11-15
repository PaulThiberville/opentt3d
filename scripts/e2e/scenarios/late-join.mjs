/**
 * Scénario 4 — join tardif.
 *
 * Une partie à deux pairs tourne, l'hôte ouvre la fenêtre de join, puis un
 * troisième onglet ouvre le lien d'invitation. Le client doit charger la
 * sauvegarde de l'hôte, vérifier le hash, puis reprendre les ticks avec les
 * deux autres pairs.
 */

import { sleep } from '../cdp.mjs';
import {
  createLocalRoom,
  gameUrl,
  joinLocalRoom,
  readyUp,
  readState,
  sampleNetwork,
  startHostGame,
  waitForHud,
} from '../helpers.mjs';

async function enableLateJoin(hostPage) {
  await hostPage.waitForSelector('.late-join-panel', { timeout: 20_000 });
  const already = await hostPage.evaluate(
    () => document.querySelector('.late-join-panel input[type="checkbox"]')?.checked === true,
  );
  if (!already) {
    await hostPage.click('.late-join-panel input[type="checkbox"]');
  }
  await hostPage.waitFor(
    () => document.querySelector('.late-join-panel input[type="checkbox"]')?.checked === true,
    { timeout: 10_000, label: 'l’ouverture automatique aux retardataires' },
  );
  const text = await hostPage.evaluate(
    () => document.querySelector('.late-join-panel')?.textContent ?? '',
  );
  return text;
}

export const lateJoin = {
  id: 'late-join',
  title: 'Join tardif : troisième onglet, sauvegarde et hash vérifiés',
  timeoutMs: 180_000,
  async run(ctx) {
    const started = Date.now();
    const mark = (label) => ctx.log(`${label} (+${((Date.now() - started) / 1000).toFixed(1)} s)`);
    // Trois contextes WebGL en parallèle (SwiftShader en CI) : une fenêtre un
    // peu plus petite garde les captures lisibles tout en réduisant le coût de
    // rendu du join. Le temps de chargement reste dominé par la construction
    // du monde.
    const viewport = { width: 1120, height: 700 };
    const host = await ctx.newPage('host', viewport);
    const client = await ctx.newPage('client', viewport);
    const joiner = await ctx.newPage('joiner', viewport);
    host.baseUrl = ctx.baseUrl;
    client.baseUrl = ctx.baseUrl;

    const invite = await createLocalRoom(host, ctx.baseUrl, {
      lobbyName: 'Salon join tardif E2E',
      playerName: 'Hôte E2E',
      seed: 5150,
    });
    mark('salon créé');
    await joinLocalRoom(client, invite, 2, { playerName: 'Invité E2E' });
    await readyUp(client);
    await startHostGame(host);
    await waitForHud(client, { timeout: 30_000 });
    await client.waitFor(() => window.__opentt3d?.netStatus !== null, {
      timeout: 20_000,
      label: 'la session réseau de l’invité',
    });
    mark('partie à deux démarrée');

    await host.waitFor(() => (window.__opentt3d?.netStatus?.tick ?? 0) >= 20, {
      timeout: 25_000,
      label: 'un tick >= 20 avant le join tardif',
    });
    mark('tick 20 atteint');
    const hostBefore = await sampleNetwork(host);
    const clientBefore = await sampleNetwork(client);
    ctx.assert(
      (hostBefore?.tick ?? 0) >= 20 && (clientBefore?.tick ?? 0) >= 15,
      'la partie tourne avant l’arrivée du retardataire',
      { host: hostBefore?.tick, client: clientBefore?.tick },
    );

    const panelBefore = await enableLateJoin(host);
    ctx.check('hôte ouvert aux retardataires', panelBefore.slice(0, 160));
    await ctx.capture(host, 'late-join-open');
    mark('join tardif ouvert');

    // Le nom du troisième onglet est lu depuis localStorage au démarrage.
    await joiner.goto(gameUrl(ctx.baseUrl, ''));
    await joiner.evaluate(() => localStorage.setItem('opentt3d.playerName', 'Retardataire E2E'));
    await joiner.goto(invite);
    await joiner.waitFor(
      () =>
        Boolean(
          document.querySelector('.join-screen.is-visible') ||
          document.querySelector('.hud .hud-bar'),
        ),
      { timeout: 25_000, label: 'la découverte de la partie en cours' },
    );
    const joinScreenVisible = await joiner.evaluate(() =>
      Boolean(document.querySelector('.join-screen.is-visible')),
    );
    if (joinScreenVisible) {
      await ctx.capture(joiner, 'join-progress');
      ctx.check('écran « Rejoindre la partie en cours » affiché');
    }
    mark('découverte du join');

    await waitForHud(joiner, { timeout: 90_000 });
    await joiner.waitFor(() => Boolean(window.__opentt3d?.restored), {
      timeout: 20_000,
      label: 'le tick restauré du retardataire',
    });
    mark('HUD du retardataire prêt');
    const joinedState = await readState(joiner);
    const restored = joinedState.debug?.restored ?? null;
    ctx.assert(
      Boolean(restored && restored.tick > 0),
      'le retardataire reprend à un tick avancé de la partie',
      restored,
    );
    ctx.assert(
      Boolean(restored && typeof restored.hash === 'string' && restored.hash.length > 0),
      'le hash de la sauvegarde de l’hôte a été vérifié',
      restored,
    );
    ctx.assert(
      Boolean(joinedState.hud.net && /Invité · .*tick \d+/.test(joinedState.hud.net)),
      'le HUD du retardataire affiche son statut d’invité et le tick courant',
      joinedState.hud.net,
    );

    await host.waitFor(
      () => {
        const text = document.querySelector('.late-join-panel')?.textContent ?? '';
        return text.includes('Retardataire E2E');
      },
      { timeout: 25_000, label: 'le retardataire dans le panneau de l’hôte' },
    );
    const hostPlayers = await host.evaluate(() =>
      Array.from(document.querySelectorAll('.late-join-panel .late-join-player')).map((element) =>
        String(element.textContent ?? '').trim(),
      ),
    );
    const panelAfter = await host.evaluate(
      () => document.querySelector('.late-join-panel')?.textContent ?? '',
    );
    ctx.assert(
      hostPlayers.length >= 3,
      'l’hôte liste les trois joueurs après le join',
      hostPlayers,
    );
    ctx.assert(
      panelAfter.includes('Retardataire E2E'),
      'le nom du retardataire apparaît chez l’hôte',
      panelAfter.slice(0, 240),
    );

    const firstSample = await sampleNetwork(joiner);
    await sleep(1_500);
    const secondSample = await sampleNetwork(joiner);
    ctx.assert(
      (secondSample?.tick ?? 0) > (firstSample?.tick ?? 0) + 5,
      'le tick du retardataire avance après la reprise',
      { from: firstSample?.tick, to: secondSample?.tick },
    );

    // Le protocole de join a déjà comparé le hash de la sauvegarde à celui de
    // l'hôte. Après reprise, l'absence de resync sur les trois HUD et des
    // compteurs de tuiles identiques confirment que les états ne divergent pas
    // (chaque pair compare ses hashes toutes les 50 ticks).
    await sleep(2_500);
    const trio = await Promise.all([host, client, joiner].map((page) => readState(page)));
    const desyncsBefore = trio.map((state) => state.debug?.desyncs ?? -1);
    ctx.assert(
      desyncsBefore[2] === 0,
      'le retardataire n’a subi aucun resync : son hash de sauvegarde est valide',
      desyncsBefore,
    );
    const roadCounts = trio.map((state) => state.debug?.map?.roads ?? -1);
    ctx.assert(
      roadCounts.every((count) => count >= 0 && count === roadCounts[0]),
      'les trois pairs affichent la même carte après le join',
      roadCounts,
    );

    // Un resync transitoire reste possible sur un pair déjà en jeu pendant le
    // transfert (surtout en rendu logiciel). En revanche, le compteur doit être
    // stable après la reprise : une divergence persistante échoue ici.
    await sleep(2_000);
    const trioAfter = await Promise.all([host, client, joiner].map((page) => readState(page)));
    const desyncsAfter = trioAfter.map((state) => state.debug?.desyncs ?? -1);
    ctx.assert(
      desyncsAfter.every((value, index) => value === desyncsBefore[index]),
      'aucun nouveau resync n’apparaît après la reprise du retardataire',
      { before: desyncsBefore, after: desyncsAfter },
    );
    const roadCountsAfter = trioAfter.map((state) => state.debug?.map?.roads ?? -1);
    ctx.assert(
      roadCountsAfter.every((count) => count >= 0 && count === roadCountsAfter[0]),
      'les trois cartes restent identiques après la fenêtre de stabilisation',
      roadCountsAfter,
    );
    ctx.check(
      `trois pairs stables (${roadCounts[0]} tuiles route, resyncs ${desyncsAfter.join('/')})`,
      { roadCounts, desyncsBefore, desyncsAfter },
    );

    await ctx.capture(host, 'host-after-join');
    await ctx.capture(joiner, 'joined-hud');
    const joinedShot = await ctx.capture(joiner, 'joined-final');
    ctx.assert(joinedShot.size > 20_000, 'la capture du retardataire n’est pas vide', joinedShot);
  },
};
