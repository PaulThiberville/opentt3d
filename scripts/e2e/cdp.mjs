/**
 * Client CDP minimal pour piloter Chrome sans Playwright.
 *
 * Le navigateur est lancé en headless avec un port de debug éphémère
 * (`--remote-debugging-port=0` + fichier `DevToolsActivePort`). Un seul
 * WebSocket relie ensuite toutes les cibles avec `Target.attachToTarget`
 * (`flatten: true`) : un onglet = une session CDP, ce qui permet de garder
 * plusieurs pages en vie pour les scénarios multi-onglets.
 *
 * Les dépendances restent volontairement limitées à `node:*` et au WebSocket
 * natif de Node 22. Aucun service externe n'est contacté.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
];

/** Résout le binaire Chrome depuis l'env, les chemins macOS/Linux ou le PATH. */
export function findChrome(explicit = null) {
  const candidates = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('/') || candidate.includes('\\')) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Chemin absent : essayer le suivant.
      }
      continue;
    }
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue;
      const full = join(dir, candidate);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // Pas dans ce dossier du PATH.
      }
    }
  }
  throw new Error(
    'Chrome introuvable. Installez Google Chrome ou renseignez CHROME_PATH ' +
      '(ex. CHROME_PATH="/usr/bin/google-chrome" npm run e2e).',
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remoteString(arg) {
  if (!arg) return '';
  if ('value' in arg) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  }
  if ('unserializableValue' in arg) return String(arg.unserializableValue);
  if (arg.description) return arg.description;
  return String(arg.type ?? '');
}

function consoleText(args) {
  return args.map(remoteString).join(' ').trim();
}

/**
 * Connexion CDP paresseuse : `send` numérote les messages et résout la promesse
 * correspondante. Les événements sont routés vers les sessions d'onglets.
 */
class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.onmessage = (event) => {
      void this.handleMessage(event.data);
    };
    ws.onerror = () => {
      this.failAll(new Error('WebSocket CDP en erreur'));
    };
    ws.onclose = () => {
      this.closed = true;
      this.failAll(new Error('WebSocket CDP fermé'));
    };
  }

  async handleMessage(data) {
    let text = data;
    if (typeof text !== 'string') {
      if (typeof text?.text === 'function') text = await text.text();
      else if (text?.arrayBuffer) text = Buffer.from(await text.arrayBuffer()).toString('utf8');
      else text = String(text);
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (error) {
        console.error('[e2e:cdp] listener error', error);
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error(`CDP fermé (${method})`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Déjà fermé.
    }
  }
}

/** Une page (onglet) et sa session CDP dédiée. */
export class CdpPage {
  constructor(browser, targetId, sessionId, viewport = DEFAULT_VIEWPORT) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.viewport = viewport;
    this.closed = false;
    this.entries = [];
    this.handlers = new Map();
    this.navigationError = null;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  on(method, fn) {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  handleEvent(message) {
    if (message.sessionId !== this.sessionId) return;
    const set = this.handlers.get(message.method);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(message.params ?? {});
        } catch (error) {
          console.error('[e2e:cdp] page handler error', error);
        }
      }
    }
  }

  async init() {
    this.on('Runtime.consoleAPICalled', (params) => {
      const text = consoleText(params.args ?? []);
      const frame = params.stackTrace?.callFrames?.[0];
      this.entries.push({
        source: 'console',
        level: params.type ?? 'log',
        text,
        url: frame?.url ?? null,
        line: frame?.lineNumber ?? null,
        at: Date.now(),
      });
      this.trimEntries();
    });
    this.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {};
      const description =
        details.exception?.description ?? details.text ?? 'Exception JavaScript inconnue';
      const frame = details.stackTrace?.callFrames?.[0];
      this.entries.push({
        source: 'exception',
        level: 'error',
        text: description,
        url: details.url ?? frame?.url ?? null,
        line: details.lineNumber ?? frame?.lineNumber ?? null,
        at: Date.now(),
      });
      this.trimEntries();
    });
    this.on('Log.entryAdded', (params) => {
      const entry = params.entry ?? {};
      this.entries.push({
        source: 'log',
        level: entry.level ?? 'info',
        text: entry.text ?? '',
        url: entry.url ?? null,
        line: entry.lineNumber ?? null,
        at: Date.now(),
      });
      this.trimEntries();
    });
    this.on('Network.loadingFailed', (params) => {
      const errorText = params.errorText ?? 'échec réseau';
      if (errorText.includes('ERR_ABORTED') || params.canceled) return;
      this.entries.push({
        source: 'network',
        level: 'warning',
        text: `${params.type ?? 'ressource'} : ${errorText}`,
        url: params.requestId ?? null,
        line: null,
        at: Date.now(),
      });
      this.trimEntries();
    });
    this.on('Inspector.targetCrashed', () => {
      this.entries.push({
        source: 'exception',
        level: 'error',
        text: 'La cible (onglet) a planté.',
        at: Date.now(),
      });
    });

    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Log.enable'),
      this.send('Network.enable'),
      this.send('Inspector.enable'),
      this.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: this.viewport.width,
        screenHeight: this.viewport.height,
      }),
    ]);
  }

  trimEntries() {
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400);
  }

  errors() {
    return this.entries.filter(
      (entry) =>
        entry.level === 'error' || entry.level === 'assert' || entry.source === 'exception',
    );
  }

  warnings() {
    return this.entries.filter((entry) => entry.level === 'warning' || entry.level === 'warn');
  }

  async evaluate(fn, ...args) {
    if (this.closed) throw new Error('Onglet fermé');
    const source =
      typeof fn === 'function'
        ? `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`
        : String(fn);
    const result = await this.send('Runtime.evaluate', {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      replMode: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const message = details.exception?.description ?? details.text ?? 'Exception dans evaluate()';
      throw new Error(message);
    }
    return result.result?.value;
  }

  async waitFor(fn, options = {}, ...args) {
    const timeout = options.timeout ?? 10_000;
    const interval = options.interval ?? 100;
    const label = options.label ?? 'condition';
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error(`Onglet fermé pendant l'attente de ${label}`);
      try {
        const value = await this.evaluate(fn, ...args);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    const suffix = lastError ? ` Dernière erreur : ${lastError.message}` : '';
    throw new Error(`Timeout (${timeout} ms) en attendant ${label}.${suffix}`);
  }

  async waitForSelector(selector, options = {}) {
    const visible = options.visible !== false;
    return this.waitFor(
      (sel, mustBeVisible) => {
        const element = document.querySelector(sel);
        if (!element) return false;
        if (!mustBeVisible) return true;
        const style = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        );
      },
      {
        timeout: options.timeout ?? 10_000,
        interval: options.interval ?? 100,
        label: `le sélecteur ${selector}`,
      },
      selector,
      visible,
    );
  }

  async waitForGone(selector, options = {}) {
    return this.waitFor(
      (sel) => !document.querySelector(sel),
      {
        timeout: options.timeout ?? 10_000,
        label: `la disparition de ${selector}`,
      },
      selector,
    );
  }

  async text(selector) {
    return this.evaluate(
      (sel) => document.querySelector(sel)?.textContent?.trim() ?? null,
      selector,
    );
  }

  async attr(selector, name) {
    return this.evaluate(
      (sel, attrName) => document.querySelector(sel)?.getAttribute(attrName) ?? null,
      selector,
      name,
    );
  }

  async setValue(selector, value) {
    return this.evaluate(
      (sel, next) => {
        const element = document.querySelector(sel);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return false;
        }
        element.focus();
        element.value = next;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      selector,
      value,
    );
  }

  async choose(selector) {
    return this.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (!(element instanceof HTMLInputElement)) return false;
      element.click();
      return element.checked;
    }, selector);
  }

  async click(selector) {
    return this.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (!(element instanceof HTMLElement)) return false;
      if ('disabled' in element && element.disabled) return false;
      element.click();
      return true;
    }, selector);
  }

  /**
   * Clique un bouton par son texte, en préférant la correspondance exacte puis
   * le préfixe (les boutons du menu concatènent leur libellé et leur sous-titre).
   */
  async clickText(text, scopeSelector = null) {
    const result = await this.evaluate(
      (wanted, scopeSel) => {
        const normalize = (value) =>
          String(value ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const want = normalize(wanted);
        const scope = scopeSel ? document.querySelector(scopeSel) : document;
        if (!scope) return { ok: false, reason: `scope ${scopeSel} introuvable` };
        const candidates = Array.from(
          scope.querySelectorAll('button, [role="button"], a, input[type="submit"]'),
        ).filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          if ('disabled' in element && element.disabled) return false;
          const style = getComputedStyle(element);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getClientRects().length > 0
          );
        });
        const label = (element) => normalize(element.textContent ?? element.value ?? '');
        const target =
          candidates.find((element) => label(element) === want) ??
          candidates.find((element) => label(element).startsWith(want)) ??
          candidates.find((element) => label(element).includes(want));
        if (!target) {
          return {
            ok: false,
            reason: `bouton « ${want} » introuvable`,
            available: candidates.map(label).slice(0, 25),
          };
        }
        target.click();
        return { ok: true, text: label(target) };
      },
      text,
      scopeSelector,
    );
    if (!result?.ok) {
      const available = result?.available?.length
        ? ` Boutons visibles : ${result.available.join(' | ')}`
        : '';
      throw new Error(`${result?.reason ?? 'Clic impossible'}.${available}`);
    }
    return result.text;
  }

  async getRect(selector) {
    return this.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, selector);
  }

  async mouseDragPoints(start, end, steps = 8) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(start.x),
      y: Math.round(start.y),
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(start.x),
      y: Math.round(start.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let index = 1; index <= steps; index++) {
      const t = index / steps;
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(start.x + (end.x - start.x) * t),
        y: Math.round(start.y + (end.y - start.y) * t),
        button: 'left',
        buttons: 1,
      });
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(end.x),
      y: Math.round(end.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async mouseClickPoint(point) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async mouseDrag(selector, fromRatio, toRatio, steps = 8) {
    const rect = await this.getRect(selector);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Élément ${selector} sans surface pour le drag`);
    }
    const point = (ratio) => ({
      x: Math.round(rect.x + rect.width * ratio[0]),
      y: Math.round(rect.y + rect.height * ratio[1]),
    });
    await this.mouseDragPoints(point(fromRatio), point(toRatio), steps);
  }

  async focusBody() {
    return this.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      document.body.tabIndex = -1;
      document.body.focus();
      return document.activeElement === document.body;
    });
  }

  async press(key) {
    const codes = {
      Escape: { code: 'Escape', keyCode: 27 },
      Enter: { code: 'Enter', keyCode: 13 },
      Space: { code: 'Space', keyCode: 32 },
    };
    const info = codes[key];
    if (!info) throw new Error(`Touche non gérée : ${key}`);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    });
  }

  async goto(url, options = {}) {
    this.navigationError = null;
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) {
      this.navigationError = result.errorText;
      throw new Error(`Navigation vers ${url} impossible : ${result.errorText}`);
    }
    await this.waitFor(() => document.readyState === 'complete', {
      timeout: options.timeout ?? 20_000,
      label: 'le chargement du document',
    });
    return url;
  }

  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      // La cible peut déjà être détruite.
    }
  }
}

/** Navigateur Chrome headless partagé entre scénarios. */
export class CdpBrowser {
  constructor(options = {}) {
    this.options = options;
    this.process = null;
    this.userDataDir = null;
    this.connection = null;
    this.pages = new Set();
    this.version = null;
    this.stderr = '';
  }

  static async launch(options = {}) {
    const browser = new CdpBrowser(options);
    await browser.start();
    return browser;
  }

  async start() {
    const chrome = findChrome(this.options.chromePath ?? null);
    const userDataDir = await mkdtemp(join(tmpdir(), 'opentt3d-e2e-chrome-'));
    this.userDataDir = userDataDir;
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
      '--disable-dev-shm-usage',
      // Accélération matérielle si disponible (Metal sur macOS, GPU sur les
      // runners) ; SwiftShader reste autorisé en secours pour la CI sans GPU.
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--window-size=1440,900',
      '--hide-scrollbars',
      '--mute-audio',
      'about:blank',
    ];
    if (this.options.headed) {
      args.unshift('--window-position=40,40');
    } else {
      args.unshift('--headless=new');
    }
    if (process.getuid?.() === 0 || process.env.CI) args.unshift('--no-sandbox');
    // Reproduit les conditions d'une CI sans GPU (rendu logiciel) pour mesurer
    // les timeouts avant de pousser.
    if (process.env.E2E_FORCE_SWIFTSHADER === '1') args.push('--use-angle=swiftshader');
    if (this.options.extraArgs) args.push(...this.options.extraArgs);
    this.args = args;
    this.process = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.process.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    this.process.on('exit', (code, signal) => {
      if (!this.connection?.closed && code !== 0) {
        this.stderr = `${this.stderr}\nChrome sorti (${code ?? signal}).`.slice(-8000);
      }
    });

    const activePortFile = join(userDataDir, 'DevToolsActivePort');
    let activePort = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.process.exitCode !== null) {
        throw new Error(`Chrome s'est arrêté au démarrage.\n${this.stderr}`);
      }
      try {
        const content = await readFile(activePortFile, 'utf8');
        const [port] = content.trim().split('\n');
        if (port) {
          activePort = Number(port);
          break;
        }
      } catch {
        // Le fichier apparaît après l'initialisation.
      }
      await sleep(100);
    }
    if (!activePort) throw new Error(`Chrome n'a pas ouvert de port CDP.\n${this.stderr}`);

    const versionResponse = await fetch(`http://127.0.0.1:${activePort}/json/version`);
    if (!versionResponse.ok) {
      throw new Error(`Endpoint CDP indisponible (${versionResponse.status})`);
    }
    this.version = await versionResponse.json();
    const ws = new WebSocket(this.version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout de connexion CDP')), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Connexion WebSocket CDP impossible'));
      };
    });
    this.connection = new CdpConnection(ws);
    this.connection.onEvent((message) => {
      for (const page of this.pages) page.handleEvent(message);
    });
    await this.send('Target.setDiscoverTargets', { discover: true });
    return this;
  }

  send(method, params = {}, sessionId = undefined) {
    return this.connection.send(method, params, sessionId);
  }

  async newPage(viewport = DEFAULT_VIEWPORT) {
    // Chaque page vit dans sa propre fenêtre : deux onglets du même window
    // masqueraient le premier (`document.hidden`), ce qui suspend la boucle de
    // rendu et bloquerait le chargement ou le lockstep. En headless, plusieurs
    // fenêtres restent simultanément visibles et gardent leur rAF actif.
    const { targetId } = await this.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(this, targetId, sessionId, viewport);
    this.pages.add(page);
    await page.init();
    return page;
  }

  async closePage(page) {
    if (!page) return;
    this.pages.delete(page);
    await page.close();
  }

  async close() {
    for (const page of [...this.pages]) await this.closePage(page).catch(() => undefined);
    try {
      await this.send('Browser.close');
    } catch {
      // Browser.close peut fermer le socket avant la réponse.
    }
    this.connection?.close();
    const proc = this.process;
    if (proc && proc.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        await rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export { DEFAULT_VIEWPORT, sleep };
