/**
 * helpers.mjs — actions de haut niveau partagées par les scénarios E2E.
 *
 * Les fonctions de ce module ne connaissent que le DOM public et, quand il est
 * disponible, `window.__opentt3d` (mode développement). Elles ne modifient
 * jamais l'état directement : chaque action passe par un clic, une touche ou un
 * drag, comme un joueur. Les lectures d'état servent uniquement aux assertions.
 */

import { sleep } from './cdp.mjs';

export const MENU = '.menu-screen.is-visible';
export const MULTIPLAYER = '.multiplayer-screen.is-visible';
export const LOBBY = '.lobby-screen.is-visible';
export const PAUSE = '.pause-screen.is-visible';
export const SAVES = '.save-screen.is-visible';
export const HUD = '.hud .hud-bar';

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function gameUrl(baseUrl, search) {
  const query = search.startsWith('?') ? search : `?${search}`;
  return `${baseUrl}/${query}`;
}

export async function waitForScreen(page, screenSelector, timeout = 15_000) {
  await page.waitForSelector(screenSelector, { timeout });
}

/**
 * Attend le HUD et, en développement, le premier snapshot complet. Le HUD est
 * affiché avant que la session ne soit totalement câblée : `__opentt3d` et le
 * snapshot évitent les courses dans les assertions suivantes.
 */
export async function waitForHud(page, options = {}) {
  const timeout = options.timeout ?? 25_000;
  await page.waitForSelector(HUD, { timeout });
  await page.waitFor(
    () => {
      const money = document.querySelector('.hud-money-value')?.textContent?.trim();
      return Boolean(money && money !== '—');
    },
    { timeout, label: 'la trésorerie du HUD' },
  );
  await page.waitFor(
    () => {
      const api = window.__opentt3d;
      return Boolean(api?.game?.getLatestSnapshot?.());
    },
    { timeout, label: 'la session de jeu (__opentt3d)' },
  );
}

/** Ouvre une partie par URL puis attend le HUD. */
export async function openGame(page, baseUrl, search, options = {}) {
  page.baseUrl = baseUrl;
  await page.goto(gameUrl(baseUrl, search));
  await waitForHud(page, options);
}

/**
 * Lit le HUD et l'état de debug en un seul aller-retour CDP.
 *
 * `world.getMap()` est utilisé plutôt que `snapshot.map` : ce dernier peut être
 * `null` sur les snapshots delta, alors que le monde fusionné garde la carte
 * courante.
 */
export async function readState(page) {
  return page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    const api = window.__opentt3d;
    let snapshot = null;
    let map = null;
    try {
      snapshot = api?.game?.getLatestSnapshot?.() ?? null;
      map = api?.world?.getMap?.() ?? snapshot?.map ?? null;
    } catch {
      // Session en cours de libération : les champs restent null.
    }
    let roads = 0;
    let rails = 0;
    let stations = 0;
    let water = 0;
    let grass = 0;
    if (map?.kind) {
      for (const value of map.kind) {
        if (value === 7) roads += 1;
        else if (value === 6) rails += 1;
        else if (value === 10) stations += 1;
        else if (value === 4) water += 1;
        else if (value === 2) grass += 1;
      }
    }
    let status = null;
    let hash = null;
    try {
      status = api?.engine?.status?.() ?? null;
      hash = api?.engine?.hash?.() ?? null;
    } catch {
      // Moteur absent (écran de chargement, partie libérée).
    }
    const net = api?.netStatus ?? null;
    return {
      url: location.href,
      screen: api?.screens?.key ?? null,
      hud: {
        money: text('.hud-money-value'),
        date: text('.hud-date .hud-value'),
        company: text('.hud-company .hud-value'),
        speed: text('.hud-speed .hud-value'),
        net: text('.hud-net'),
        engineBadge: text('#ui [data-engine]'),
      },
      debug: api
        ? {
            tick: net?.tick ?? status?.tick ?? null,
            engineTick: status?.tick ?? null,
            hash,
            engineMode: api.engineMode ?? null,
            restored: api.restored ?? null,
            desyncs: net?.desyncs ?? null,
            isHost: net?.isHost ?? null,
            ping: net?.ping ?? null,
            economy: snapshot?.economy ?? null,
            map: map
              ? { width: map.width, height: map.height, roads, rails, stations, water, grass }
              : null,
            companies:
              snapshot?.companies?.map((company) => ({
                id: company.id,
                name: company.name,
                money: company.money,
                isLocal: Boolean(company.isLocal),
              })) ?? [],
            vehicles: snapshot?.vehicles?.length ?? null,
            depots: snapshot?.depots?.length ?? null,
            stations: snapshot?.stations?.length ?? null,
            towns: snapshot?.towns?.length ?? null,
          }
        : null,
    };
  });
}

/** Nombre de routes visibles dans le monde fusionné (léger, pour les polls). */
export function readRoadCount(page) {
  return page.evaluate(() => {
    const map = window.__opentt3d?.world?.getMap?.();
    if (!map?.kind) return -1;
    let count = 0;
    for (const value of map.kind) if (value === 7) count += 1;
    return count;
  });
}

async function waitForButtonText(page, text, scopeSelector = null, timeout = 10_000) {
  const wanted = normalizeText(text);
  await page.waitFor(
    (target, scopeSel) => {
      const normalize = (value) =>
        String(value ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const scope = scopeSel ? document.querySelector(scopeSel) : document;
      if (!scope) return false;
      return Array.from(
        scope.querySelectorAll('button, [role="button"], a, input[type="submit"]'),
      ).some((element) => normalize(element.textContent ?? element.value ?? '').includes(target));
    },
    { timeout, label: `le bouton « ${wanted} »` },
    wanted,
    scopeSelector,
  );
}

export async function openMultiplayer(page) {
  await page.clickText('Multijoueur');
  await waitForScreen(page, MULTIPLAYER);
}

/** Crée un salon local et renvoie son lien d'invitation complet. */
export async function createLocalRoom(page, baseUrl, options = {}) {
  // Le lobby ne peut pas recevoir `?quality=low` : ce paramètre déclenche
  // l'autostart solo. On écrit donc la préférence de qualité avant d'ouvrir le
  // menu ; les autres fenêtres du même profil la partagent.
  await page.goto(gameUrl(baseUrl, ''));
  await page.evaluate(() =>
    localStorage.setItem('opentt3d.settings.v1', JSON.stringify({ quality: 'low' })),
  );
  await page.goto(gameUrl(baseUrl, 'net=local&engine=mock'));
  page.baseUrl = baseUrl;
  await waitForScreen(page, MENU);
  await openMultiplayer(page);
  await page.setValue('#mp-lobby-name', options.lobbyName ?? 'Salon E2E');
  await page.setValue('#mp-player-name', options.playerName ?? 'Hôte E2E');
  await page.setValue('#mp-seed', String(options.seed ?? 424242));
  await page.choose('#mp-private');
  await page.choose('input[name="mp-size"][value="256"]');
  await page.clickText('Créer le salon', '.multiplayer-screen');
  await waitForScreen(page, LOBBY, 20_000);
  await page.waitFor(
    () => {
      const input = document.querySelector('#lobby-invite');
      return Boolean(
        input &&
        input.value.includes('room=') &&
        input.value.includes('host=') &&
        input.value.includes('net=local'),
      );
    },
    { timeout: 15_000, label: 'le lien d’invitation du salon' },
  );
  const invite = await page.evaluate(() => document.querySelector('#lobby-invite')?.value ?? null);
  if (!invite) throw new Error('Lien d’invitation vide dans le salon local');
  return invite;
}

/** Rejoint un salon local depuis son lien, puis attend que les slots arrivent. */
export async function joinLocalRoom(page, invite, expectedPlayers = 2, options = {}) {
  await page.goto(invite);
  await waitForScreen(page, LOBBY, 20_000);
  await page.waitFor(
    (count) => document.querySelectorAll('.lobby-screen .slot-row').length >= count,
    { timeout: 20_000, label: `${expectedPlayers} joueurs dans le salon` },
    expectedPlayers,
  );
  if (options.playerName) {
    await page.setValue('#lobby-self-name', options.playerName);
    await sleep(200);
  }
}

export async function readyUp(page) {
  await page.clickText('Je suis prêt', '.lobby-screen');
  await waitForButtonText(page, 'Annuler « prêt »', '.lobby-screen');
}

export async function startHostGame(page) {
  await waitForButtonText(page, 'Démarrer la partie', '.lobby-screen');
  await page.waitFor(
    () => {
      const button = Array.from(document.querySelectorAll('.lobby-screen button')).find((element) =>
        (element.textContent ?? '').includes('Démarrer la partie'),
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    { timeout: 15_000, label: 'le bouton Démarrer activé' },
  );
  await page.clickText('Démarrer la partie', '.lobby-screen');
  await waitForHud(page, { timeout: 30_000 });
  await page.waitFor(() => window.__opentt3d?.netStatus !== null, {
    timeout: 20_000,
    label: 'la session réseau locale',
  });
}

/** Ouvre le panneau d'actualités et renvoie le texte des entrées. */
export async function openNews(page) {
  const open = await page.evaluate(
    () => document.querySelector('.hud-news-panel')?.classList.contains('is-visible') ?? false,
  );
  if (!open) await page.click('.hud-news-button');
  await page.waitForSelector('.hud-news-panel.is-visible');
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.hud-news-item .hud-news-text')).map((element) =>
      String(element.textContent ?? '').trim(),
    ),
  );
}

export async function waitForNews(page, pattern, timeout = 8_000) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = pattern instanceof RegExp ? pattern.flags : '';
  await page.waitFor(
    (expression, expressionFlags) => {
      const regex = new RegExp(expression, expressionFlags);
      return Array.from(document.querySelectorAll('.hud-news-item .hud-news-text')).some(
        (element) => regex.test(String(element.textContent ?? '')),
      );
    },
    { timeout, label: `une actualité correspondant à ${source}` },
    source,
    flags,
  );
}

/**
 * Trouve des cibles de construction réellement visibles : on part du centre de
 * la caméra, on cherche des tuiles d'herbe plates, puis on projette leur centre
 * à l'écran avec la caméra Three.js de la page. Cela évite de draguer au hasard
 * sur une carte WASM inconnue. Renvoie plusieurs candidats, du plus proche du
 * centre au plus loin.
 */
export function findBuildPoints(page, maxCandidates = 12) {
  return page.evaluate((limit) => {
    const api = window.__opentt3d;
    const map = api?.world?.getMap?.();
    const camera = api?.renderer?.camera;
    const canvas = document.querySelector('#scene');
    if (!map?.kind || !map.slope || !map.heightMap || !camera || !canvas) return [];
    const controller = api?.world?.getCameraController?.();
    const pose = controller?.getPose?.();
    const rect = canvas.getBoundingClientRect();
    const centerX = Math.floor(pose?.target?.x ?? map.width / 2);
    const centerY = Math.floor(pose?.target?.z ?? map.height / 2);
    const project = (x, y) => {
      const height = (map.heightMap[y * map.width + x] ?? 0) * 0.5;
      const vector = camera.position.clone();
      vector.set(x + 0.5, height + 0.08, y + 0.5);
      vector.project(camera);
      if (!(vector.z > -1 && vector.z < 1)) return null;
      const screenX = rect.left + (vector.x * 0.5 + 0.5) * rect.width;
      const screenY = rect.top + (-vector.y * 0.5 + 0.5) * rect.height;
      if (screenX < 48 || screenX > rect.width - 240) return null;
      if (screenY < 120 || screenY > rect.height - 140) return null;
      return { x: Math.round(screenX), y: Math.round(screenY) };
    };
    const buildable = (x, y) => {
      if (x < 1 || y < 1 || x >= map.width - 2 || y >= map.height - 2) return false;
      const index = y * map.width + x;
      // Herbe (2) ou champ clair (1) plat : constructible en mock comme en WASM.
      return (map.kind[index] === 2 || map.kind[index] === 1) && map.slope[index] === 0;
    };
    const tiles = [];
    const radius = 44;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance > radius * radius) continue;
        const x = centerX + dx;
        const y = centerY + dy;
        if (!buildable(x, y)) continue;
        const point = project(x, y);
        if (!point) continue;
        tiles.push({ x, y, point, distance, dx, dy });
      }
    }
    tiles.sort((a, b) => a.distance - b.distance);
    const results = [];
    const seen = new Set();
    for (const tile of tiles) {
      const key = `${tile.x},${tile.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Un tronçon de deux tuiles rend le drag visible et reste court.
      for (const [neighbourX, neighbourY] of [
        [tile.x + 2, tile.y],
        [tile.x, tile.y + 2],
      ]) {
        if (!buildable(neighbourX, neighbourY)) continue;
        const neighbour = project(neighbourX, neighbourY);
        if (!neighbour) continue;
        results.push({
          from: tile.point,
          to: neighbour,
          fromTile: { x: tile.x, y: tile.y },
          toTile: { x: neighbourX, y: neighbourY },
          tiles: 3,
        });
        break;
      }
      if (results.length === 0) {
        results.push({
          from: tile.point,
          to: tile.point,
          fromTile: { x: tile.x, y: tile.y },
          toTile: { x: tile.x, y: tile.y },
          tiles: 1,
        });
      }
      if (results.length >= limit) break;
    }
    return results;
  }, maxCandidates);
}

const DRAG_ATTEMPTS = [
  [
    [0.5, 0.5],
    [0.53, 0.5],
  ],
  [
    [0.44, 0.5],
    [0.47, 0.5],
  ],
  [
    [0.5, 0.45],
    [0.5, 0.48],
  ],
  [
    [0.5, 0.55],
    [0.5, 0.58],
  ],
  [
    [0.38, 0.46],
    [0.41, 0.46],
  ],
  [
    [0.62, 0.46],
    [0.65, 0.46],
  ],
  [
    [0.38, 0.58],
    [0.41, 0.58],
  ],
  [
    [0.62, 0.58],
    [0.65, 0.58],
  ],
  [
    [0.5, 0.38],
    [0.53, 0.38],
  ],
  [
    [0.5, 0.62],
    [0.53, 0.62],
  ],
];

/**
 * Arme l'outil Routes puis tente des drags courts sur la carte jusqu'à ce que
 * le nombre de tuiles route augmente. Le drag est un vrai événement souris CDP
 * (pointerdown/move/up), pas un appel direct au contrôleur.
 */
export async function buildRoad(page, options = {}) {
  const timeout = options.timeout ?? 5_000;
  const before = await readRoadCount(page);
  if (before < 0) throw new Error('Carte indisponible avant la construction de route');
  await page.click('[data-tool="road"]');
  await page.waitFor(
    () => document.querySelector('[data-tool="road"]')?.getAttribute('aria-pressed') === 'true',
    { timeout: 5_000, label: 'l’outil Routes actif' },
  );
  const precise = await findBuildPoints(page);
  const preciseTimeout = options.preciseTimeout ?? 1_200;
  for (const candidate of precise) {
    if (candidate.tiles > 1) {
      await page.mouseDragPoints(candidate.from, candidate.to, 8);
    } else {
      await page.mouseClickPoint(candidate.from);
    }
    const deadline = Date.now() + preciseTimeout;
    while (Date.now() < deadline) {
      const current = await readRoadCount(page);
      if (current > before) {
        return {
          before,
          after: current,
          mode: 'projection',
          fromTile: candidate.fromTile,
          toTile: candidate.toTile,
        };
      }
      await sleep(150);
    }
  }
  const attempts = options.attempts ?? DRAG_ATTEMPTS;
  for (const [from, to] of attempts) {
    await page.mouseDrag('#scene', from, to, 8);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await readRoadCount(page);
      if (current > before) {
        return { before, after: current, mode: 'ratio', from, to };
      }
      await sleep(150);
    }
  }
  const notices = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.hud-toast, .hud-news-text'))
      .map((element) => String(element.textContent ?? '').trim())
      .filter(Boolean)
      .slice(-8),
  );
  throw new Error(
    `Aucune route construite après ${precise.length} cibles projetées et ` +
      `${attempts.length} drags. Derniers messages : ${notices.join(' | ') || 'aucun'}`,
  );
}

/**
 * Échap sur le corps de page : ouvre l'écran de pause solo. Le premier Échap
 * peut désarmer l'outil de construction ou fermer un panneau ; on répète donc
 * l'action jusqu'à voir la pause (chaque appui reprend le focus du corps).
 */
export async function pauseGame(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.focusBody();
    await page.press('Escape');
    try {
      await page.waitForSelector(PAUSE, { timeout: 1_500 });
      return;
    } catch {
      // Outil ou panneau encore ouvert : un nouvel Échap est nécessaire.
    }
  }
  throw new Error('Impossible d’ouvrir l’écran de pause après plusieurs Échap');
}

/** Lit le tick moteur courant sans dépendre du HUD. */
export async function readEngineTick(page) {
  return page.evaluate(() => {
    const api = window.__opentt3d;
    if (!api) return null;
    const net = api.netStatus;
    if (net) return net.tick;
    return api.engine?.status?.().tick ?? null;
  });
}

/** Échantillonne le tick et les compteurs réseau dans le même tour JS. */
export function sampleNetwork(page) {
  return page.evaluate(() => {
    const api = window.__opentt3d;
    if (!api?.netStatus) return null;
    return {
      tick: api.netStatus.tick,
      desyncs: api.netStatus.desyncs,
      isHost: api.netStatus.isHost,
      ping: api.netStatus.ping,
    };
  });
}

/**
 * Provoque volontairement une divergence : envoie une commande directement au
 * moteur d'un client, sans passer par le lockstep. Au prochain cycle de hash,
 * les pairs doivent détecter le désaccord et déclencher un resync.
 */
export async function forceDivergence(page) {
  return page.evaluate(() => {
    const api = window.__opentt3d;
    const snapshot = api?.game?.getLatestSnapshot?.();
    const map = api?.world?.getMap?.() ?? snapshot?.map;
    const company = snapshot?.companies?.find((item) => item.isLocal) ?? snapshot?.companies?.[0];
    if (!api?.engine || !map?.kind || !company) {
      return { ok: false, reason: 'état de jeu incomplet' };
    }
    // Une tuile d'herbe plate et vide : route d'une tuile, toujours valide.
    for (let y = 16; y < map.height - 16; y += 1) {
      for (let x = 16; x < map.width - 16; x += 1) {
        const index = y * map.width + x;
        if (map.kind[index] === 2 && map.slope[index] === 0) {
          const command = {
            type: 'build',
            tool: 'road',
            company: company.id,
            from: { x, y },
            to: { x, y },
            options: { axis: 'x' },
          };
          try {
            api.engine.send(command);
          } catch (error) {
            return { ok: false, reason: String(error?.message ?? error) };
          }
          return { ok: true, x, y, company: company.id };
        }
      }
    }
    return { ok: false, reason: 'aucune tuile d’herbe plate trouvée' };
  });
}

/** Attend qu'un resync soit observé sur au moins un pair. */
export async function waitForResync(pages, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const states = await Promise.all(pages.map((page) => sampleNetwork(page)));
    const total = states.reduce((sum, state) => sum + (state?.desyncs ?? 0), 0);
    if (total > 0) return states;
    await sleep(200);
  }
  throw new Error(
    `Aucun resync détecté en ${timeout} ms après la divergence forcée ` +
      `(le hash n'a peut-être pas changé).`,
  );
}
