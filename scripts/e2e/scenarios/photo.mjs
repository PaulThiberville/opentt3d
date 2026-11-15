/**
 * Scénario #121 — intro cinématique et mode photo.
 *
 * Parcours : lancement → intro qui se coupe à Échap → P (pause + UI masquée) →
 * preset rue → capture PNG non vide → sortie qui restaure le HUD et la
 * simulation. Un second onglet vérifie `prefers-reduced-motion` (aucune intro,
 * preset appliqué sans transition).
 */

import { gameUrl } from '../helpers.mjs';

async function pressKey(page, key, code, keyCode) {
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(key.length === 1 ? { text: key } : {}),
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

export const photoMode = {
  id: 'photo-mode',
  title: 'Intro cinématique et mode photo (#121)',
  timeoutMs: 90_000,
  async run(ctx) {
    const page = await ctx.newPage('photo');

    await page.goto(gameUrl(ctx.baseUrl, 'autostart=1&engine=mock&size=96&quality=low&seed=121'));
    await page.waitFor(() => window.__opentt3d?.isIntroRunning?.() === true, {
      timeout: 30_000,
      label: 'intro cinématique démarrée',
    });
    const intro = await page.evaluate(() => {
      const pose = window.__opentt3d.world.getCameraController().getPose();
      return { distance: pose.distance, pitch: pose.pitch };
    });
    ctx.assert(
      intro.distance >= 6 && intro.distance <= 340 && intro.pitch >= 0.18 && intro.pitch <= 1.45,
      'la pose d’intro reste dans les bornes caméra',
      intro,
    );
    await ctx.capture(page, 'intro');

    // Échap coupe l'intro sans ouvrir le menu de pause.
    await page.press('Escape');
    await page.waitFor(() => window.__opentt3d?.isIntroRunning?.() === false, {
      timeout: 5_000,
      label: 'intro coupée',
    });
    const pausedAfterSkip = await page.evaluate(() => window.__opentt3d.game.isPaused());
    ctx.assert(pausedAfterSkip === false, 'le skip de l’intro n’ouvre pas la pause');

    // P entre en mode photo : pause et HUD masqué.
    await pressKey(page, 'p', 'KeyP', 80);
    await page.waitFor(() => window.__opentt3d?.photo?.isActive?.() === true, {
      timeout: 5_000,
      label: 'mode photo actif',
    });
    const entered = await page.evaluate(() => {
      const hud = document.querySelector('.hud');
      return {
        paused: window.__opentt3d.game.isPaused(),
        masked: document.body.classList.contains('photo-mode'),
        hudHidden: hud ? getComputedStyle(hud).visibility === 'hidden' : false,
      };
    });
    ctx.assert(entered.paused, 'le mode photo met la simulation en pause', entered);
    ctx.assert(
      entered.masked && entered.hudHidden,
      'le mode photo masque le HUD et la barre d’outils',
      entered,
    );

    // Preset rue par la touche 2, puis capture PNG via l'API du mode.
    await pressKey(page, '2', 'Digit2', 50);
    await page.waitFor(() => window.__opentt3d?.photo?.getPreset?.() === 'street', {
      timeout: 3_000,
      label: 'preset rue',
    });
    const street = await page.evaluate(() => {
      const controller = window.__opentt3d.world.getCameraController();
      return { fov: controller.getFov(), distance: controller.getPose().distance };
    });
    ctx.assert(
      street.fov >= 30 && street.fov <= 68 && street.distance >= 6,
      'le preset rue applique un FOV et une distance bornés',
      street,
    );
    const shot = await page.evaluate(() => {
      const capture = window.__opentt3d.photo.capture();
      return capture ? { filename: capture.filename, length: capture.dataUrl.length } : null;
    });
    ctx.assert(
      Boolean(shot && shot.length > 10_000 && shot.filename.endsWith('.png')),
      'la capture du mode photo produit un PNG non vide',
      shot,
    );
    await ctx.capture(page, 'photo-street');

    // Échap restaure l'UI et reprend la simulation.
    await page.press('Escape');
    await page.waitFor(() => window.__opentt3d?.photo?.isActive?.() === false, {
      timeout: 5_000,
      label: 'sortie du mode photo',
    });
    const exited = await page.evaluate(() => {
      const hud = document.querySelector('.hud');
      return {
        paused: window.__opentt3d.game.isPaused(),
        masked: document.body.classList.contains('photo-mode'),
        hudHidden: hud ? getComputedStyle(hud).visibility === 'hidden' : false,
      };
    });
    ctx.assert(!exited.paused, 'la sortie du mode photo reprend la simulation', exited);
    ctx.assert(
      !exited.masked && !exited.hudHidden,
      'la sortie restaure le HUD et les contrôles',
      exited,
    );

    // Reduced motion : pas d'intro et preset immédiat, sans transition.
    const reduced = await ctx.newPage('photo-reduced');
    await reduced.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await reduced.goto(
      gameUrl(ctx.baseUrl, 'autostart=1&engine=mock&size=96&quality=low&seed=4242'),
    );
    await reduced.waitFor(() => Boolean(window.__opentt3d?.game?.getLatestSnapshot?.()), {
      timeout: 30_000,
      label: 'session reduced motion',
    });
    const reducedState = await reduced.evaluate(() => {
      const api = window.__opentt3d;
      api.togglePhotoMode('street');
      const controller = api.world.getCameraController();
      return {
        intro: api.isIntroRunning(),
        active: api.photo.isActive(),
        transitioning: controller.isTransitioning(),
        fov: controller.getFov(),
      };
    });
    ctx.assert(!reducedState.intro, 'reduced motion : aucune intro cinématique', reducedState);
    ctx.assert(
      reducedState.active && !reducedState.transitioning && reducedState.fov >= 30,
      'reduced motion : preset appliqué sans transition',
      reducedState,
    );
  },
};
