#!/usr/bin/env node
/**
 * Harnais de performance OpenTT3D (issue #24).
 *
 * Mesure le rendu réel dans Chrome headless via le CDP natif (aucune
 * dépendance lourde) :
 *  - FPS et temps de frame p50/p95/p99 (rAF instrumenté avant le chargement) ;
 *  - draw calls, triangles et requêtes GPU (patch WebGL2/WebGL1) ;
 *  - mémoire JS (performance.memory + CDP Performance) et ressources GPU
 *    vivantes (buffers, textures, programmes, shaders, VAO) pour la chasse aux
 *    fuites ;
 *  - temps de snapshot et de step du moteur (mock ou WASM) ;
 *  - stabilité sur une durée paramétrable (soak) ;
 *  - scénarios : carte, ville rapprochée, 300 véhicules, construction active,
 *    onglet caché/reprise, resize.
 *
 * Le bundle est construit avec `NODE_ENV=development --mode development` pour
 * conserver la surface de debug `window.__opentt3d` (exposée par main.ts en
 * DEV uniquement) tout en servant un bundle de production (rollup, minifié).
 * Sans cet accès, impossible de piloter dépôts, véhicules et caméra.
 *
 * Sortie : JSON complet + résumé lisible + captures PNG dans
 * `perf-artifacts/` (gitignoré). Code retour 1 si un budget est dépassé.
 *
 * Usage :
 *   node scripts/perf.mjs
 *   node scripts/perf.mjs --sizes=128,256,512 --qualities=low,medium,high
 *   node scripts/perf.mjs --engine=wasm --sizes=512 --soak=180
 *   node scripts/perf.mjs --swiftshader --report-only
 *   node scripts/perf.mjs --server=dev --duration=5
 *
 * Options principales :
 *   --sizes=128,256         tailles de carte
 *   --qualities=low,medium,high
 *   --engine=mock,wasm      moteurs (wasm ignoré si artefacts absents)
 *   --wasm-sizes / --wasm-qualities  sous-matrice WASM (défaut : medium)
 *   --scenarios=map,city,vehicles,build,hidden,resize
 *   --duration=8            secondes mesurées par scénario
 *   --soak=60               secondes de stabilité (0 = désactivé)
 *   --soak-size=256 --soak-quality=medium
 *   --dpr=1                 deviceScaleFactor simulé
 *   --swiftshader           force le rendu logiciel (comparaison)
 *   --report-only           mesure sans échec sur budget
 *   --no-build              réutilise dist-perf
 *   --server=preview|dev|URL
 *   --port=5199
 *   --json=path             chemin du JSON (défaut perf-artifacts/<ts>.json)
 *   --keep-artifacts        conserve les PNG même en cas d'échec précoce
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'perf-artifacts');
const SCREEN_DIR = path.join(ARTIFACTS, 'screens');
const VIEWPORT = { width: 1280, height: 800 };

// ---------------------------------------------------------------------------
// Budgets : dépassement = code retour 1 (sauf --report-only).
// Les seuils de frame sont volontairement larges pour absorber la variance
// d'un Chrome headless ; le GPU réel fait mieux (voir rapport).
// ---------------------------------------------------------------------------
const BUDGETS = {
  fpsMin: 45,
  frameP95Ms: { low: 22, medium: 24, high: 28 },
  frameMaxMs: 250,
  /** Pic toléré pendant un déplacement rapide de caméra (critère #24). */
  frameMaxFastMs: 25,
  drawCalls: {
    map: { 128: 150, 256: 240, 512: 560 },
    city: { 128: 160, 256: 200, 512: 220 },
    vehicles: { 128: 120, 256: 180, 512: 380 },
    build: { 128: 240, 256: 320, 512: 580 },
    hidden: { 128: 140, 256: 240, 512: 560 },
    resize: { 128: 180, 256: 280, 512: 620 },
    move: { 128: 180, 256: 280, 512: 620 },
  },
  /** Triangles soumis par frame, par taille de carte. */
  triangles: { 128: 180_000, 256: 600_000, 512: 1_800_000 },
  /** Supplément du scénario 300 véhicules (9 variantes détaillées, ≤ 1 500 tri). */
  vehicleTrianglesFor300: 450_000,
  /** Moteur : un snapshot (carte incluse) et un tick. */
  snapshotMs: 45,
  snapshotMapMs: 90,
  stepMs: 10,
  /** Mémoire JS : croissance après échauffement (fuite lente). */
  heapGrowthMB: 16,
  /** Ressources GPU vivantes créées pendant un scénario (hors warmup). */
  resourceGrowth: 32,
  /**
   * Taux toléré pendant une construction active. Une fuite connue existe
   * (attribut `aPhase` de la végétation remplacé sans dispose) : le budget
   * l'encadre pour détecter une aggravation sans bloquer la CI.
   */
  resourceGrowthPerMinute: 400,
  /** Plancher de ressources encore vivantes après `session.dispose()`. */
  disposeResidual: 16,
  /** Tolérance relative : les ressources internes de Three.js restent. */
  disposeResidualRatio: 0.12,
};

const DEFAULTS = {
  sizes: [128, 256],
  qualities: ['low', 'medium', 'high'],
  engine: 'mock,wasm',
  wasmSizes: [128, 512],
  wasmQualities: ['medium'],
  scenarios: ['map', 'city', 'vehicles', 'build', 'move', 'hidden', 'resize'],
  duration: 8,
  soak: 60,
  soakSize: 256,
  soakQuality: 'medium',
  dpr: 1,
  port: 5199,
  server: 'preview',
  swiftshader: false,
  reportOnly: false,
  build: true,
  json: null,
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [flag, inline] = raw.slice(2).split('=');
    const nextValue = () => {
      if (inline !== undefined) return inline;
      const index = argv.indexOf(raw);
      const candidate = argv[index + 1];
      return candidate && !candidate.startsWith('--') ? candidate : undefined;
    };
    switch (flag) {
      case 'sizes':
        options.sizes = parseList(nextValue(), DEFAULTS.sizes).map(Number);
        break;
      case 'qualities':
        options.qualities = parseList(nextValue(), DEFAULTS.qualities);
        break;
      case 'engine':
        options.engine = nextValue() ?? DEFAULTS.engine;
        break;
      case 'wasm-sizes':
        options.wasmSizes = parseList(nextValue(), DEFAULTS.wasmSizes).map(Number);
        break;
      case 'wasm-qualities':
        options.wasmQualities = parseList(nextValue(), DEFAULTS.wasmQualities);
        break;
      case 'scenarios':
        options.scenarios = parseList(nextValue(), DEFAULTS.scenarios);
        break;
      case 'duration':
        options.duration = Number(nextValue() ?? DEFAULTS.duration);
        break;
      case 'soak':
        options.soak = Number(nextValue() ?? DEFAULTS.soak);
        break;
      case 'soak-size':
        options.soakSize = Number(nextValue() ?? DEFAULTS.soakSize);
        break;
      case 'soak-quality':
        options.soakQuality = nextValue() ?? DEFAULTS.soakQuality;
        break;
      case 'dpr':
        options.dpr = Number(nextValue() ?? DEFAULTS.dpr);
        break;
      case 'port':
        options.port = Number(nextValue() ?? DEFAULTS.port);
        break;
      case 'server':
        options.server = nextValue() ?? DEFAULTS.server;
        break;
      case 'swiftshader':
        options.swiftshader = true;
        break;
      case 'report-only':
        options.reportOnly = true;
        break;
      case 'no-build':
        options.build = false;
        break;
      case 'json':
        options.json = nextValue() ?? null;
        break;
      case 'keep-artifacts':
        options.keepArtifacts = true;
        break;
      case 'help':
      case 'h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.warn(`[perf] option inconnue : --${flag}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Harnais de performance OpenTT3D

  node scripts/perf.mjs [--sizes=128,256] [--qualities=low,medium,high]
       [--engine=mock,wasm] [--scenarios=map,city,vehicles,build,hidden,resize]
       [--duration=8] [--soak=60] [--dpr=1] [--swiftshader] [--report-only]
       [--no-build] [--server=preview|dev|http://...] [--port=5199]

Sortie : perf-artifacts/<horodatage>.json + résumé + captures.`);
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
function log(message) {
  process.stdout.write(`${message}\n`);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 30_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `Délai dépassé en attendant ${label}${lastError ? ` (${lastError.message})` : ''}`,
  );
}

function gitInfo() {
  const run = (args) =>
    spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: run(['rev-parse', 'HEAD']),
    commitShort: run(['rev-parse', '--short', 'HEAD']),
    dirty: run(['status', '--porcelain']) !== '',
  };
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync('which', ['google-chrome'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new Error(
    'Chrome introuvable. Définissez CHROME_PATH ou installez Google Chrome/Chromium.',
  );
}

function hasWasmArtifacts() {
  return (
    existsSync(path.join(ROOT, 'public', 'engine', 'opentt3d-engine.js')) &&
    existsSync(path.join(ROOT, 'public', 'engine', 'opentt3d-engine.wasm')) &&
    existsSync(path.join(ROOT, 'public', 'engine', 'opentt3d-engine.data'))
  );
}

// ---------------------------------------------------------------------------
// Build + serveur
// ---------------------------------------------------------------------------
function viteBin() {
  const bin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(bin)) throw new Error('Vite est absent : lancez npm install.');
  return bin;
}

function buildBundle() {
  log('[perf] build du bundle de mesure (mode development, hooks de debug)…');
  const result = spawnSync(
    process.execPath,
    [viteBin(), 'build', '--mode', 'development', '--outDir', 'dist-perf', '--emptyOutDir'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'development' },
    },
  );
  if (result.status !== 0) throw new Error('Échec du build Vite pour la mesure.');
}

async function startServer(options) {
  if (/^https?:\/\//.test(options.server)) {
    return { url: options.server.replace(/\/$/, ''), stop: async () => {} };
  }
  const dev = options.server === 'dev';
  const args = dev
    ? [viteBin(), '--port', String(options.port), '--strictPort', '--host', '127.0.0.1']
    : [
        viteBin(),
        'preview',
        '--outDir',
        'dist-perf',
        '--port',
        String(options.port),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ];
  log(`[perf] serveur ${dev ? 'dev' : 'preview'} sur http://127.0.0.1:${options.port}`);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: dev ? 'development' : process.env.NODE_ENV },
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, label: 'le serveur Vite' },
  );
  return {
    url: `http://127.0.0.1:${options.port}`,
    stop: async () => {
      child.kill('SIGTERM');
      await sleep(200);
      if (!child.killed) child.kill('SIGKILL');
    },
    output,
  };
}

// ---------------------------------------------------------------------------
// Client CDP minimal (WebSocket natif de Node 22)
// ---------------------------------------------------------------------------
class Cdp {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result ?? {});
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params ?? {});
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Connexion CDP impossible : ${this.url}`));
      socket.onclose = () => {
        this.closed = true;
        for (const pending of this.pending.values()) pending.reject(new Error('CDP fermé'));
        this.pending.clear();
      };
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP fermé'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'évaluation échouée';
      throw new Error(description);
    }
    return result.result?.value;
  }

  close() {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // déjà fermé
    }
  }
}

// ---------------------------------------------------------------------------
// Instrumentation injectée avant le chargement de la page
// ---------------------------------------------------------------------------
const INSTRUMENTATION = `(() => {
  if (window.__perf) return;
  const live = { buffer: 0, texture: 0, program: 0, shader: 0, vertexArray: 0, framebuffer: 0, renderbuffer: 0 };
  const created = { buffer: 0, texture: 0, program: 0, shader: 0, vertexArray: 0, framebuffer: 0, renderbuffer: 0 };
  const deleted = { buffer: 0, texture: 0, program: 0, shader: 0, vertexArray: 0, framebuffer: 0, renderbuffer: 0 };
  const counters = { draws: 0, tris: 0, lines: 0, points: 0, instanced: 0 };
  const byteSizes = new WeakMap();
  const bytesLive = { buffer: 0, texture: 0, renderbuffer: 0 };
  const bytesTotal = () => bytesLive.buffer + bytesLive.texture + bytesLive.renderbuffer;
  const setBytes = (kind, resource, bytes) => {
    if (!resource) return;
    const previous = byteSizes.get(resource) ?? 0;
    const next = Math.max(0, bytes);
    byteSizes.set(resource, next);
    bytesLive[kind] += next - previous;
  };
  const removeBytes = (kind, resource) => {
    if (!resource) return;
    const previous = byteSizes.get(resource) ?? 0;
    byteSizes.delete(resource);
    bytesLive[kind] = Math.max(0, bytesLive[kind] - previous);
  };
  const perf = {
    frames: [],
    longTasks: [],
    errors: [],
    samples: [],
    frameStart: 0,
    lastTimestamp: 0,
    label: '',
    live,
    created,
    deleted,
    counters,
    now: () => performance.now(),
  };
  window.__perf = perf;

  const resetCounters = () => {
    counters.draws = 0;
    counters.tris = 0;
    counters.lines = 0;
    counters.points = 0;
    counters.instanced = 0;
  };

  const trianglesFor = (mode, count) => {
    if (mode === 4) return Math.floor(count / 3);
    if (mode === 5 || mode === 6) return Math.max(0, count - 2);
    return 0;
  };

  const recordDraw = (mode, count, instances) => {
    counters.draws += 1;
    if (instances > 1) counters.instanced += 1;
    if (mode === 4 || mode === 5 || mode === 6) counters.tris += trianglesFor(mode, count) * instances;
    else if (mode === 0 || mode === 1 || mode === 3) counters.points += count;
    else counters.lines += count;
  };

  const patchGl = (proto) => {
    if (!proto || proto.__perfPatched) return;
    proto.__perfPatched = true;
    // Chaque signature WebGL est wrappée explicitement : drawElements a
    // (mode, count, type, offset), drawElementsInstanced ajoute instanceCount.
    const originalDrawArrays = proto.drawArrays;
    if (originalDrawArrays) {
      proto.drawArrays = function (mode, first, count) {
        recordDraw(mode, count, 1);
        return originalDrawArrays.call(this, mode, first, count);
      };
    }
    const originalDrawElements = proto.drawElements;
    if (originalDrawElements) {
      proto.drawElements = function (mode, count, type, offset) {
        recordDraw(mode, count, 1);
        return originalDrawElements.call(this, mode, count, type, offset);
      };
    }
    const originalDrawArraysInstanced = proto.drawArraysInstanced;
    if (originalDrawArraysInstanced) {
      proto.drawArraysInstanced = function (mode, first, count, instances) {
        recordDraw(mode, count, instances);
        return originalDrawArraysInstanced.call(this, mode, first, count, instances);
      };
    }
    const originalDrawElementsInstanced = proto.drawElementsInstanced;
    if (originalDrawElementsInstanced) {
      proto.drawElementsInstanced = function (mode, count, type, offset, instances) {
        recordDraw(mode, count, instances);
        return originalDrawElementsInstanced.call(this, mode, count, type, offset, instances);
      };
    }
    const wrapCreateDelete = (kind, create, remove) => {
      const originalCreate = proto[create];
      if (originalCreate) {
        proto[create] = function (...args) {
          const resource = originalCreate.apply(this, args);
          if (resource) {
            created[kind] += 1;
            live[kind] += 1;
            if (kind in bytesLive) setBytes(kind, resource, 0);
          }
          return resource;
        };
      }
      const originalRemove = proto[remove];
      if (originalRemove) {
        proto[remove] = function (...args) {
          const result = originalRemove.apply(this, args);
          if (args[0]) {
            deleted[kind] += 1;
            live[kind] = Math.max(0, live[kind] - 1);
            if (kind in bytesLive) removeBytes(kind, args[0]);
          }
          return result;
        };
      }
    };
    wrapCreateDelete('buffer', 'createBuffer', 'deleteBuffer');
    wrapCreateDelete('texture', 'createTexture', 'deleteTexture');
    wrapCreateDelete('program', 'createProgram', 'deleteProgram');
    wrapCreateDelete('shader', 'createShader', 'deleteShader');
    wrapCreateDelete('vertexArray', 'createVertexArray', 'deleteVertexArray');
    wrapCreateDelete('framebuffer', 'createFramebuffer', 'deleteFramebuffer');
    wrapCreateDelete('renderbuffer', 'createRenderbuffer', 'deleteRenderbuffer');

    // Estimation de la mémoire GPU : taille des buffers et des textures
    // actuellement alloués (approximation RGBA8 pour les textures).
    const boundBuffers = new Map();
    const originalBindBuffer = proto.bindBuffer;
    if (originalBindBuffer) {
      proto.bindBuffer = function (target, buffer) {
        boundBuffers.set(target, buffer);
        return originalBindBuffer.call(this, target, buffer);
      };
    }
    const originalBufferData = proto.bufferData;
    if (originalBufferData) {
      proto.bufferData = function (...args) {
        const [target, data] = args;
        const bytes =
          typeof data === 'number'
            ? data
            : data && typeof data.byteLength === 'number'
              ? data.byteLength
              : 0;
        setBytes('buffer', boundBuffers.get(target), bytes);
        return originalBufferData.apply(this, args);
      };
    }
    const boundTextures = new Map();
    const originalBindTexture = proto.bindTexture;
    if (originalBindTexture) {
      proto.bindTexture = function (target, texture) {
        boundTextures.set(target, texture);
        return originalBindTexture.call(this, target, texture);
      };
    }
    const textureBytes = (width, height, type) => {
      const channels = type === 0x8d61 ? 8 : 4; // HALF_FLOAT = 8 octets/px approx.
      return Math.max(0, width) * Math.max(0, height) * channels;
    };
    const originalTexImage2D = proto.texImage2D;
    if (originalTexImage2D) {
      proto.texImage2D = function (...args) {
        if (args.length >= 9 && typeof args[3] === 'number' && typeof args[4] === 'number') {
          setBytes('texture', boundTextures.get(args[0]), textureBytes(args[3], args[4], args[7]));
        } else if (args.length === 6 && args[5] && typeof args[5] === 'object') {
          const source = args[5];
          const width = source.width ?? source.videoWidth ?? 0;
          const height = source.height ?? source.videoHeight ?? 0;
          setBytes('texture', boundTextures.get(args[0]), textureBytes(width, height, args[4]));
        }
        return originalTexImage2D.apply(this, args);
      };
    }
    const originalTexStorage2D = proto.texStorage2D;
    if (originalTexStorage2D) {
      proto.texStorage2D = function (target, levels, format, width, height) {
        setBytes('texture', boundTextures.get(target), textureBytes(width, height, 0));
        return originalTexStorage2D.call(this, target, levels, format, width, height);
      };
    }
    const boundRenderbuffers = new Map();
    const originalBindRenderbuffer = proto.bindRenderbuffer;
    if (originalBindRenderbuffer) {
      proto.bindRenderbuffer = function (target, renderbuffer) {
        boundRenderbuffers.set(target, renderbuffer);
        return originalBindRenderbuffer.call(this, target, renderbuffer);
      };
    }
    const originalRenderbufferStorage = proto.renderbufferStorage;
    if (originalRenderbufferStorage) {
      proto.renderbufferStorage = function (target, format, width, height) {
        setBytes('renderbuffer', boundRenderbuffers.get(target), textureBytes(width, height, 0));
        return originalRenderbufferStorage.call(this, target, format, width, height);
      };
    }
  };
  patchGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    return raf((timestamp) => {
      resetCounters();
      perf.frameStart = performance.now();
      const start = performance.now();
      try {
        callback(timestamp);
      } catch (error) {
        perf.errors.push(String(error));
        throw error;
      }
      perf.frames.push({
        t: timestamp,
        dt: perf.lastTimestamp ? timestamp - perf.lastTimestamp : 0,
        cpu: performance.now() - start,
        draws: counters.draws,
        tris: counters.tris,
        lines: counters.lines,
        points: counters.points,
        instanced: counters.instanced,
      });
      perf.lastTimestamp = timestamp;
    });
  };

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          perf.longTasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // longtask non supporté : pas bloquant
    }
  }

  window.addEventListener('error', (event) => {
    perf.errors.push(event.message || String(event.error));
  });
  window.addEventListener('unhandledrejection', (event) => {
    perf.errors.push(String(event.reason));
  });

  perf.liveResources = () => {
    let total = 0;
    for (const value of Object.values(live)) total += value;
    return { ...live, total };
  };
  perf.liveBytes = () => ({
    buffer: bytesLive.buffer,
    texture: bytesLive.texture,
    renderbuffer: bytesLive.renderbuffer,
    total: bytesTotal(),
  });
  perf.heap = () =>
    performance.memory
      ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
          limit: performance.memory.jsHeapSizeLimit,
        }
      : null;
  perf.startSampling = () => {
    perf.samples = [];
    if (perf.sampler) clearInterval(perf.sampler);
    perf.sampler = setInterval(() => {
      perf.samples.push({
        t: performance.now(),
        heap: perf.heap()?.used ?? 0,
        resources: perf.liveResources(),
        bytes: perf.liveBytes().total,
      });
    }, 1000);
  };
  perf.stopSampling = () => {
    if (perf.sampler) clearInterval(perf.sampler);
    perf.sampler = null;
    return perf.samples;
  };
  perf.collectHeap = () => {
    if (typeof gc === 'function') {
      gc();
      gc();
    }
    return perf.heap()?.used ?? 0;
  };

  let screenshotRequests = 0;
  window.__perfSeq = () => ++screenshotRequests;
})()`;

// ---------------------------------------------------------------------------
// API de pilotage installée après le démarrage de la session
// ---------------------------------------------------------------------------
const PAGE_API = `(() => {
  if (window.__perfApi) return true;
  const session = () => window.__opentt3d.session;
  const game = () => session().gameInstance;
  const world = () => session().worldInstance;
  const renderer = () => session().rendererInstance;
  const controller = () => world().getCameraController();
  const perf = window.__perf;
  const snapshot = () => game().getLatestSnapshot();

  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const percentile = (values, ratio) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))];
  };
  const stats = (values) => {
    if (!values.length) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
      count: sorted.length,
      avg: sum / sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
    };
  };

  const frameSummary = () => {
    const byTimestamp = new Map();
    for (const frame of perf.frames) {
      const entry = byTimestamp.get(frame.t) || {
        t: frame.t,
        draws: 0,
        tris: 0,
        lines: 0,
        points: 0,
        instanced: 0,
        cpu: 0,
        callbacks: 0,
      };
      entry.draws += frame.draws;
      entry.tris += frame.tris;
      entry.lines += frame.lines;
      entry.points += frame.points;
      entry.instanced += frame.instanced;
      entry.cpu += frame.cpu;
      entry.callbacks += 1;
      byTimestamp.set(frame.t, entry);
    }
    const frames = [...byTimestamp.values()].sort((a, b) => a.t - b.t);
    const intervals = [];
    for (let index = 1; index < frames.length; index += 1) {
      intervals.push(frames[index].t - frames[index - 1].t);
    }
    const duration =
      frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
    return {
      frames: frames.length,
      durationSeconds: duration,
      fps: duration > 0 ? (frames.length - 1) / duration : 0,
      interval: stats(intervals),
      draws: stats(frames.map((frame) => frame.draws)),
      triangles: stats(frames.map((frame) => frame.tris)),
      cpu: stats(frames.map((frame) => frame.cpu)),
      instancedDraws: stats(frames.map((frame) => frame.instanced)),
    };
  };

  const counts = () => {
    const scene = world();
    const snap = snapshot();
    const diag = renderer()?.diagnostics();
    const webglInfo = renderer()?.webgl?.info;
    const threeMemory = webglInfo?.memory ?? null;
    let sceneObjects = 0;
    let sceneMeshes = 0;
    const geometryIds = new Set();
    scene.getScene().traverse((object) => {
      sceneObjects += 1;
      const mesh = object;
      if (!mesh.isMesh && !mesh.isLine && !mesh.isPoints) return;
      sceneMeshes += 1;
      if (mesh.geometry) geometryIds.add(mesh.geometry.uuid);
    });
    return {
      quality: session().currentQuality,
      tick: game().getTick(),
      mapSize: scene.getMap() ? [scene.getMap().width, scene.getMap().height] : null,
      drawCallsWorld: scene.getDrawCalls(),
      renderer: diag,
      terrainChunks: scene.terrain.chunkCount,
      terrainChunksBuilt: scene.terrain.chunksBuilt,
      vehicles: scene.getVehicleCount(),
      trees: scene.getTreeCount(),
      buildings: scene.getBuildingCount(),
      industries: scene.getIndustryCount(),
      industryParts: scene.getIndustryPartCount(),
      industryDrawCalls: scene.getIndustryDrawCalls(),
      signals: scene.getSignalCount(),
      depots: scene.getDepotCount(),
      snapshotVehicles: snap?.vehicles?.length ?? 0,
      snapshotTowns: snap?.towns?.length ?? 0,
      companies: snap?.companies?.length ?? 0,
      domNodes: document.getElementsByTagName('*').length,
      sceneObjects,
      sceneMeshes,
      sceneGeometries: geometryIds.size,
      threeMemory: threeMemory
        ? {
            geometries: threeMemory.geometries ?? 0,
            textures: threeMemory.textures ?? 0,
            programs: webglInfo?.programs?.length ?? 0,
          }
        : null,
      canvas: (() => {
        const canvas = document.querySelector('#scene');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return {
          css: [Math.round(rect.width), Math.round(rect.height)],
          buffer: [canvas.width, canvas.height],
        };
      })(),
    };
  };

  const resourcesOnly = () => ({
    live: perf.liveResources(),
    bytes: perf.liveBytes(),
    created: { ...perf.created },
    deleted: { ...perf.deleted },
    heap: perf.heap(),
    domNodes: document.getElementsByTagName('*').length,
  });

  const resetFrames = () => {
    perf.frames.length = 0;
    perf.longTasks.length = 0;
    perf.errors.length = 0;
    perf.lastTimestamp = 0;
    perf.baselineRetained = perf.collectHeap();
    perf.startSampling();
    return true;
  };

  const finish = () => {
    const samples = perf.stopSampling();
    const retainedHeap = perf.collectHeap();
    const frames = frameSummary();
    const longTasks = perf.longTasks.slice();
    const errors = perf.errors.slice();
    const heapSamples = samples.map((sample) => sample.heap).filter((value) => value > 0);
    const resourceSamples = samples.map((sample) => sample.resources.total);
    const resourceSeries = samples.map((sample) => ({
      t: Math.round(sample.t),
      ...sample.resources,
      bytes: sample.bytes,
    }));
    // Croissance mesurée entre creux de GC (minima) plutôt qu'entre pics :
    // le tas JS est en dents de scie et un simple last-baseline est trompeur.
    const windowSize = Math.max(1, Math.floor(heapSamples.length / 5));
    const baselineHeap = heapSamples.length
      ? Math.min(...heapSamples.slice(0, windowSize))
      : (perf.heap()?.used ?? 0);
    const lastHeap = heapSamples.length
      ? Math.min(...heapSamples.slice(-windowSize))
      : baselineHeap;
    const peakHeap = heapSamples.length ? Math.max(...heapSamples) : baselineHeap;
    return {
      frame: frames,
      longTasks: {
        count: longTasks.length,
        total: longTasks.reduce((total, task) => total + task.duration, 0),
        max: longTasks.reduce((max, task) => Math.max(max, task.duration), 0),
      },
      errors: errors.slice(0, 20),
      heap: {
        samples: heapSamples,
        baseline: baselineHeap,
        last: lastHeap,
        peak: peakHeap,
        growth: lastHeap - baselineHeap,
        retained: retainedHeap,
        retainedBaseline: perf.baselineRetained ?? baselineHeap,
        retainedGrowth: retainedHeap - (perf.baselineRetained ?? baselineHeap),
      },
      resources: {
        ...resourcesOnly(),
        samples: resourceSamples,
        series: resourceSeries,
      },
      counts: (() => {
        try {
          return counts();
        } catch {
          return null;
        }
      })(),
    };
  };

  const spreadVehicles = (mockWorld) => {
    const width = mockWorld.width;
    const height = mockWorld.height;
    const heights = mockWorld.heightMap;
    for (const vehicle of mockWorld.vehicles) {
      if (vehicle.orders && vehicle.orders.length > 0) continue;
      const x = 4 + Math.random() * (width - 8);
      const y = 4 + Math.random() * (height - 8);
      const index = Math.floor(y) * width + Math.floor(x);
      vehicle.path = [{ x, y }];
      vehicle.pathLengths = [0];
      vehicle.segment = 0;
      vehicle.segmentT = 0;
      vehicle.x = x;
      vehicle.y = y;
      vehicle.z = (heights[index] ?? 2) * 0.5 + 0.08;
    }
  };

  const api = {
    ready: true,
    counts,
    resourcesOnly,
    begin(label) {
      perf.label = label;
      return resetFrames();
    },
    /** Efface les frames après l'échauffement (le GC de begin peut créer un long task). */
    clearFrames() {
      perf.frames.length = 0;
      perf.longTasks.length = 0;
      perf.errors.length = 0;
      perf.lastTimestamp = 0;
      return true;
    },
    end: finish,
    info() {
      const snap = snapshot();
      return {
        engine: window.__opentt3d.engineMode,
        quality: session().currentQuality,
        tick: game().getTick(),
        mapSize: snap?.map
          ? [snap.map.width, snap.map.height]
          : (() => {
              const map = world().getMap();
              return map ? [map.width, map.height] : null;
            })(),
        towns: snap?.towns?.length ?? 0,
        vehicles: snap?.vehicles?.length ?? 0,
        depots: snap?.depots?.length ?? 0,
        companies: snap?.companies?.length ?? 0,
        protocol: snap?.meta?.protocol ?? null,
        restored: window.__opentt3d.restored ?? null,
      };
    },
    resetView() {
      world().resetView();
      const pose = controller().getPose();
      pose.pitch = 0.92;
      return true;
    },
    cityView(index = 0, distance = 26) {
      const snap = snapshot();
      const town = snap?.towns?.[index];
      if (!town) return null;
      world().stopFollowing();
      controller().focusOn(town.x, town.y, distance);
      const pose = controller().getPose();
      pose.pitch = 0.6;
      return { town: town.name, x: town.x, y: town.y, distance };
    },
    vehicles(count = 300) {
      const g = game();
      const scene = world();
      const snap = snapshot();
      const depot = snap?.depots?.find((item) => item.kind === 'road') ?? snap?.depots?.[0];
      const company = snap?.companies?.find((item) => item.isLocal) ?? snap?.companies?.[0];
      if (!depot || !company) return { error: 'dépôt ou entreprise introuvable' };
      const driver = g.driver;
      const mockWorld = driver && driver.world ? driver.world : null;
      if (!mockWorld) return { error: 'scénario véhicules réservé au moteur mock' };
      const entry = mockWorld.companies.find((item) => item.id === company.id);
      if (entry) entry.money = 1e9;
      const model = depot.kind === 'rail' ? 'rail_autorail' : 'bus_city';
      const before = snap.vehicles.length;
      let issued = 0;
      for (let index = before; index < count; index += 1) {
        g.issueCommand({ type: 'vehicle', action: 'buy', company: company.id, depotId: depot.id, model });
        issued += 1;
      }
      g.refresh();
      spreadVehicles(mockWorld);
      g.refresh();
      return { issued, vehicles: snapshot().vehicles.length, depot: depot.id, model };
    },
    buildStep(batch = 2) {
      const g = game();
      const scene = world();
      const api = window.__perfApi;
      const map = scene.getMap();
      const snap = snapshot();
      const company = snap?.companies?.find((item) => item.isLocal) ?? snap?.companies?.[0];
      const mockWorld = g.driver && g.driver.world ? g.driver.world : null;
      if (!map || !company) return { built: 0 };
      if (mockWorld) {
        const entry = mockWorld.companies.find((item) => item.id === company.id);
        if (entry) entry.money = 1e9;
      }
      const allowed = new Set([1, 2, 3, 9]); // clear, grass, rough, trees
      const builtBefore = scene.terrain.chunksBuilt;
      let built = 0;
      let cursor = api._buildCursor || 0;
      for (let attempt = 0; attempt < 400 && built < batch; attempt += 1) {
        cursor += 1;
        const stride = 11;
        const y = 5 + ((cursor * 7) % Math.max(1, map.height - 12));
        const x = 5 + ((cursor * stride) % Math.max(1, map.width - 18));
        let valid = true;
        for (let dx = 0; dx < 6; dx += 1) {
          const kind = map.kind[y * map.width + x + dx];
          if (!allowed.has(kind)) {
            valid = false;
            break;
          }
        }
        if (!valid) continue;
        g.issueCommand({
          type: 'build',
          tool: 'road',
          company: company.id,
          from: { x, y },
          to: { x: x + 5, y },
        });
        g.refresh();
        built += 1;
      }
      api._buildCursor = cursor;
      return {
        built,
        chunksBuilt: scene.terrain.chunksBuilt - builtBefore,
        totalChunksBuilt: scene.terrain.chunksBuilt,
        vegetationRebuilds: window.__perfApi._vegetationRebuilds ?? 0,
        cityRebuilds: window.__perfApi._cityRebuilds ?? 0,
        industryRebuilds: window.__perfApi._industryRebuilds ?? 0,
      };
    },
    /** Compteurs de reconstruction (diagnostic construction). */
    trackRebuilds() {
      const api = window.__perfApi;
      if (api._tracked) return true;
      api._tracked = true;
      api._vegetationRebuilds = 0;
      api._cityRebuilds = 0;
      api._industryRebuilds = 0;
      const scene = world();
      const canopy = scene.vegetation.canopyGeometry;
      const originalSetAttribute = canopy.setAttribute.bind(canopy);
      canopy.setAttribute = (name, attribute) => {
        if (name === 'aPhase') api._vegetationRebuilds += 1;
        return originalSetAttribute(name, attribute);
      };
      const cityBuild = scene.cityLayer.build.bind(scene.cityLayer);
      scene.cityLayer.build = (...args) => {
        api._cityRebuilds += 1;
        return cityBuild(...args);
      };
      const industryBuild = scene.industries.build.bind(scene.industries);
      scene.industries.build = (...args) => {
        api._industryRebuilds += 1;
        return industryBuild(...args);
      };
      return true;
    },
    measure(rounds = 15, includeMap = true) {
      const g = game();
      const driver = g.driver;
      const wasPaused = g.isPaused();
      if (!wasPaused) g.setPaused(true);
      const snapshots = [];
      const maps = [];
      for (let index = 0; index < rounds; index += 1) {
        const start = performance.now();
        driver.snapshot();
        snapshots.push(performance.now() - start);
      }
      const mockWorld = driver && driver.world ? driver.world : null;
      if (includeMap && mockWorld) {
        for (let index = 0; index < Math.min(rounds, 8); index += 1) {
          mockWorld.mapDirty = true;
          const start = performance.now();
          driver.snapshot();
          maps.push(performance.now() - start);
        }
      }
      const steps = [];
      for (let index = 0; index < rounds; index += 1) {
        const start = performance.now();
        driver.step(1);
        steps.push(performance.now() - start);
      }
      if (!wasPaused) g.setPaused(false);
      return { snapshot: stats(snapshots), snapshotMap: stats(maps), step: stats(steps) };
    },
    hide() {
      if (!document.__perfHiddenDescriptor) {
        document.__perfHiddenDescriptor = Object.getOwnPropertyDescriptor(
          Document.prototype,
          'hidden',
        );
      }
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      return {
        hidden: document.hidden,
        frames: perf.frames.length,
        time: performance.now(),
        tick: game().getTick(),
      };
    },
    show() {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      return {
        hidden: document.hidden,
        frames: perf.frames.length,
        time: performance.now(),
        tick: game().getTick(),
      };
    },
    frameTimesSince(time) {
      return perf.frames.filter((frame) => frame.t > time).map((frame) => frame.t);
    },
    framesCount() {
      return perf.frames.length;
    },
    setBuildTool(tool) {
      session().setBuildTool(tool);
      return session().getBuildTool();
    },
    disposeSession() {
      session().dispose();
      return true;
    },
  };
  window.__perfApi = api;
  return true;
})()`;

// ---------------------------------------------------------------------------
// Chrome headless
// ---------------------------------------------------------------------------
class ChromePage {
  constructor({ chromePath, swiftshader }) {
    this.chromePath = chromePath;
    this.swiftshader = swiftshader;
    this.process = null;
    this.profile = null;
    this.port = null;
    this.cdp = null;
    this.console = [];
    this.exceptions = [];
  }

  async launch() {
    this.profile = mkdtempSync(path.join(tmpdir(), 'opentt3d-perf-'));
    const port = 9400 + Math.floor(Math.random() * 400);
    this.port = port;
    const args = [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,TranslateUI',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--mute-audio',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ];
    if (this.swiftshader) {
      args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    }
    args.push('about:blank');
    this.process = spawn(this.chromePath, args, { stdio: 'ignore' });
    const targets = await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`);
          const list = await response.json();
          return list.find((target) => target.type === 'page') ?? null;
        } catch {
          return null;
        }
      },
      { timeout: 20_000, label: 'Chrome headless' },
    );
    this.cdp = new Cdp(targets.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Performance.enable');
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        this.console.push({
          level: params.type,
          text: params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '),
        });
      }
    });
    this.cdp.on('Runtime.exceptionThrown', (params) => {
      this.exceptions.push(params.exceptionDetails?.exception?.description ?? 'exception');
    });
    this.cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error')
        this.console.push({ level: 'error', text: params.entry.text });
    });
    await this.cdp.send('Log.enable');
    return this;
  }

  async prepare({ dpr }) {
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION });
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: dpr,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
    });
  }

  async navigate(url) {
    this.console.length = 0;
    this.exceptions.length = 0;
    await this.cdp.send('Page.navigate', { url });
  }

  async waitForGame({ timeout = 120_000 } = {}) {
    await waitFor(
      async () =>
        this.cdp.evaluate(
          'Boolean(window.__opentt3d && window.__opentt3d.game && window.__opentt3d.renderer && window.__opentt3d.world && window.__perf)',
        ),
      { timeout, interval: 200, label: 'la session de jeu' },
    );
    await this.cdp.evaluate(PAGE_API);
    // Laisse le premier rendu complet s'installer (géométries, shaders).
    await this.cdp.evaluate(
      `new Promise((resolve) => { let count = 0; const tick = () => { if (++count >= 30) resolve(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`,
      { awaitPromise: true },
    );
    return this.cdp.evaluate('window.__perfApi.info()');
  }

  async screenshot(filePath) {
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async evaluate(expression, options) {
    return this.cdp.evaluate(expression, options);
  }

  async setViewport(width, height, dpr = 1) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    await sleep(300);
  }

  async dispatchMouse(type, x, y, extra = {}) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  }

  async close() {
    this.cdp?.close();
    if (this.process) {
      this.process.kill('SIGTERM');
      await sleep(200);
      if (this.process.exitCode === null) this.process.kill('SIGKILL');
    }
    if (this.profile) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
      } catch {
        // profil temporaire déjà nettoyé
      }
    }
  }
}

async function readRendererInfo(page) {
  return page.evaluate(`(() => {
    const canvas = document.querySelector('#scene');
    const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
    if (!gl) return null;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shading: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    };
  })()`);
}

async function cdpMetrics(page) {
  const result = await page.cdp.send('Performance.getMetrics');
  const metrics = {};
  for (const item of result.metrics ?? []) metrics[item.name] = item.value;
  return {
    jsHeapUsed: metrics.JSHeapUsedSize ?? 0,
    jsHeapTotal: metrics.JSHeapTotalSize ?? 0,
    documents: metrics.Documents ?? 0,
    nodes: metrics.Nodes ?? 0,
    listeners: metrics.JSEventListeners ?? 0,
    layouts: metrics.LayoutCount ?? 0,
    recalcStyle: metrics.RecalcStyleCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Scénarios
// ---------------------------------------------------------------------------
async function prepareScenario(page, scenario) {
  await page.evaluate('window.__perfApi.resetView()');
  if (scenario === 'city') {
    return page.evaluate('window.__perfApi.cityView(0, 26)');
  }
  if (scenario === 'vehicles') {
    const result = await page.evaluate('window.__perfApi.vehicles(300)');
    await page.evaluate('window.__perfApi.resetView()');
    return result;
  }
  if (scenario === 'build') {
    await page.evaluate("window.__perfApi.setBuildTool('road')");
    await page.evaluate('window.__perfApi.trackRebuilds()');
    return { tool: 'road' };
  }
  if (scenario === 'move') {
    // Débloque l'audio hors fenêtre de mesure : le premier geste crée le
    // contexte WebAudio et charge les ambiances (long task observé ~100-160 ms
    // sur la première interaction). Le scénario mesure ensuite le déplacement.
    await page.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 24,
      y: VIEWPORT.height - 24,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await page.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 24,
      y: VIEWPORT.height - 24,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(500);
    await page.evaluate('window.__perfApi.resetView()');
    return { unlockedAudio: true };
  }
  return {};
}

async function runScenario(page, scenario, durationSeconds, artifacts, dpr = 1) {
  const details = await prepareScenario(page, scenario);

  if (scenario !== 'hidden' && scenario !== 'resize') {
    // Échauffement : shaders compilés, premières frames écartées.
    await sleep(1800);
  }

  await page.evaluate(`window.__perfApi.begin('${scenario}')`);
  // Laisse passer le GC forcé et le premier long task associé avant de
  // démarrer la fenêtre de mesure : sinon il est compté comme un pic de frame.
  await sleep(350);
  await page.evaluate('window.__perfApi.clearFrames()');
  const viewport = await page.evaluate('window.__perfApi.counts().canvas');

  let resize = null;
  let hidden = null;
  if (scenario === 'build') {
    // 2 tracés toutes les 400 ms + survol continu de l'outil (aperçu).
    const deadline = Date.now() + durationSeconds * 1000;
    let cursor = 0;
    let totalBuilt = 0;
    let totalChunks = 0;
    let nextSample = Date.now() + 5000;
    const timeline = [];
    let lastResult = null;
    while (Date.now() < deadline) {
      const result = await page.evaluate('window.__perfApi.buildStep(2)');
      lastResult = result;
      totalBuilt += result.built ?? 0;
      totalChunks += result.chunksBuilt ?? 0;
      const x = 200 + ((cursor * 47) % 800);
      const y = 180 + ((cursor * 31) % 480);
      await page.dispatchMouse('mouseMoved', x, y, { buttons: 0 });
      cursor += 1;
      await sleep(400);
      if (Date.now() >= nextSample) {
        nextSample += 5000;
        timeline.push(await page.evaluate('window.__perfApi.counts()'));
      }
    }
    details.built = totalBuilt;
    details.chunksRebuilt = totalChunks;
    details.vegetationRebuilds = lastResult?.vegetationRebuilds ?? 0;
    details.cityRebuilds = lastResult?.cityRebuilds ?? 0;
    details.industryRebuilds = lastResult?.industryRebuilds ?? 0;
    details.timeline = timeline;
  } else if (scenario === 'move') {
    // Déplacement rapide : zoom molette alterné + orbite au bouton droit.
    const deadline = Date.now() + durationSeconds * 1000;
    let moves = 0;
    while (Date.now() < deadline) {
      const cx = VIEWPORT.width / 2;
      const cy = VIEWPORT.height / 2;
      await page.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: cx,
        y: cy,
        deltaX: 0,
        deltaY: moves % 2 === 0 ? -260 : 260,
      });
      await page.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: cx,
        y: cy,
        button: 'right',
        buttons: 2,
        clickCount: 1,
      });
      for (let step = 1; step <= 6; step += 1) {
        await page.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: cx + step * 24,
          y: cy + Math.sin(step / 2) * 60,
          button: 'right',
          buttons: 2,
        });
      }
      await page.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: cx + 144,
        y: cy,
        button: 'right',
        buttons: 0,
        clickCount: 1,
      });
      moves += 1;
      await sleep(120);
    }
    details.moves = moves;
  } else if (scenario === 'hidden') {
    // 1 s visible avant de masquer : le delta de reprise est mesuré sur la
    // première frame qui suit `show()`.
    await sleep(1000);
    const before = await page.evaluate('window.__perfApi.hide()');
    await sleep(2500);
    const afterHide = await page.evaluate(
      `({ frames: window.__perfApi.framesCount(), tick: window.__perfApi.counts().tick, time: performance.now() })`,
    );
    const shown = await page.evaluate('window.__perfApi.show()');
    await sleep(2500);
    const frameTimes = await page.evaluate(
      `window.__perfApi.frameTimesSince(${shown.time}).slice(0, 6)`,
    );
    const resumed = await page.evaluate(
      `({ frames: window.__perfApi.framesCount(), tick: window.__perfApi.counts().tick })`,
    );
    const resumeGap = frameTimes.length > 0 ? Math.max(0, frameTimes[0] - shown.time) : null;
    hidden = {
      framesBeforeHide: before.frames,
      framesDuringHide: afterHide.frames - before.frames,
      hiddenMs: Math.round(afterHide.time - before.time),
      framesAfterResume: resumed.frames - afterHide.frames,
      resumeGapMs: resumeGap === null ? null : round(resumeGap, 1),
      tickBefore: before.tick,
      tickAfter: resumed.tick,
      tickDelta: resumed.tick - before.tick,
    };
  } else if (scenario === 'resize') {
    const sizes = [];
    sizes.push(await page.evaluate('window.__perfApi.counts().canvas'));
    for (const size of [
      { width: 1024, height: 640 },
      { width: 1600, height: 900 },
      { width: VIEWPORT.width, height: VIEWPORT.height },
    ]) {
      await page.setViewport(size.width, size.height, dpr);
      const canvas = await page.evaluate('window.__perfApi.counts().canvas');
      const diag = await page.evaluate('window.__perfApi.counts().renderer');
      sizes.push({ css: [size.width, size.height], canvas, diag });
    }
    resize = sizes;
    await sleep(durationSeconds * 1000);
  } else {
    await sleep(durationSeconds * 1000);
  }

  const summary = await page.evaluate('window.__perfApi.end()');
  const engineMetrics = await page.evaluate('window.__perfApi.measure(15, true)');
  const resourceAfter = await page.evaluate('window.__perfApi.resourcesOnly()');
  const cdp = await cdpMetrics(page);

  const screenshotPath = path.join(
    SCREEN_DIR,
    `${artifacts.engine}-${artifacts.size}-${artifacts.quality}-${scenario}.png`,
  );
  await page.screenshot(screenshotPath);

  return {
    scenario,
    durationSeconds,
    details,
    viewport,
    resize,
    hidden,
    metrics: summary.frame,
    longTasks: summary.longTasks,
    errors: summary.errors,
    heap: summary.heap,
    resources: {
      live: summary.resources.live,
      bytes: summary.resources.bytes,
      created: summary.resources.created,
      deleted: summary.resources.deleted,
      after: resourceAfter,
      samples: summary.resources.samples,
      series: summary.resources.series,
    },
    counts: summary.counts,
    engine: engineMetrics,
    cdp,
    screenshot: path.relative(ROOT, screenshotPath),
  };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
function evaluateBudgets(run, quality, size, rendererKind) {
  const checks = [];
  const push = (name, actual, budget, comparator = 'lte', note = '') => {
    const ok =
      comparator === 'lte' ? actual <= budget : comparator === 'gte' ? actual >= budget : true;
    checks.push({ name, actual: round(actual, 2), budget, ok, note });
  };
  const { metrics } = run;
  const scenario = run.scenario;
  const isSwiftShader = rendererKind === 'swiftshader';

  if (scenario !== 'hidden' && scenario !== 'resize' && metrics.frames > 10) {
    push(
      'fps',
      metrics.fps,
      isSwiftShader ? 5 : BUDGETS.fpsMin,
      'gte',
      isSwiftShader ? 'SwiftShader : seuil plancher' : '',
    );
    push(
      'frame p95 (ms)',
      metrics.interval.p95,
      isSwiftShader ? 120 : (BUDGETS.frameP95Ms[quality] ?? 28),
      'lte',
      isSwiftShader ? 'SwiftShader : seuil assoupli' : '',
    );
    push('frame max (ms)', metrics.interval.max, BUDGETS.frameMaxMs, 'lte');
    if (scenario === 'move') {
      push(
        'pic frame en déplacement (ms)',
        metrics.interval.max,
        BUDGETS.frameMaxFastMs,
        'lte',
        'critère #24 : aucun pic > 25 ms',
      );
    }
  }
  const drawTable = BUDGETS.drawCalls[scenario] ?? BUDGETS.drawCalls.map;
  const drawBudget = typeof drawTable === 'number' ? drawTable : (drawTable[size] ?? 320);
  push('draw calls max', metrics.draws.max, drawBudget);
  const triangleBudget =
    (BUDGETS.triangles[size] ?? 1_800_000) +
    (scenario === 'vehicles' ? BUDGETS.vehicleTrianglesFor300 : 0);
  push('triangles max', metrics.triangles.max, triangleBudget);

  if (run.engine) {
    push('snapshot p95 (ms)', run.engine.snapshot.p95, BUDGETS.snapshotMs);
    if (run.engine.snapshotMap.count > 0) {
      push('snapshot carte p95 (ms)', run.engine.snapshotMap.p95, BUDGETS.snapshotMapMs);
    }
    push('step p95 (ms)', run.engine.step.p95, BUDGETS.stepMs);
  }
  const growthMB = (run.heap.retainedGrowth ?? run.heap.growth) / (1024 * 1024);
  push('heap retenu après GC (Mo)', growthMB, BUDGETS.heapGrowthMB);
  const resourceGrowth =
    (run.resources.live?.total ?? 0) -
    (run.resources.samples?.[0] ?? run.resources.live?.total ?? 0);
  if (scenario === 'build' && run.durationSeconds > 0) {
    push(
      'ressources GPU / minute',
      (resourceGrowth / run.durationSeconds) * 60,
      BUDGETS.resourceGrowthPerMinute,
      'lte',
      'fuite connue : attribut aPhase de la végétation',
    );
  } else {
    push('ressources GPU (delta)', resourceGrowth, BUDGETS.resourceGrowth);
  }
  if (run.hidden) {
    push('frames pendant onglet caché', run.hidden.framesDuringHide, 2);
    if (run.hidden.resumeGapMs !== null) {
      push('reprise sans delta géant (ms)', run.hidden.resumeGapMs, 250);
    }
    push('avance de simulation (ticks)', run.hidden.tickDelta, 150);
  }
  if (run.resize) {
    const first = run.resize[0];
    const last = run.resize[run.resize.length - 1];
    const stable = first && last && first.css[0] === last.css[0] && first.css[1] === last.css[1];
    checks.push({
      name: 'taille de rendu restaurée',
      actual: stable ? 'oui' : `${last?.css}`,
      budget: `${first?.css}`,
      ok: Boolean(stable),
      note: 'resize/DPR',
    });
    for (const entry of run.resize.slice(1)) {
      const canvas = entry.canvas;
      const diag = entry.diag;
      const ok =
        canvas &&
        diag &&
        diag.width === canvas.buffer[0] &&
        diag.height === canvas.buffer[1] &&
        canvas.buffer[0] === Math.floor(canvas.css[0] * diag.pixelRatio) &&
        canvas.buffer[1] === Math.floor(canvas.css[1] * diag.pixelRatio);
      checks.push({
        name: `buffer ${entry.css?.[0]}×${entry.css?.[1]} cohérent`,
        actual: canvas ? `${canvas.buffer[0]}×${canvas.buffer[1]}` : 'absent',
        budget: 'css × DPR',
        ok: Boolean(ok),
        note: 'resize/DPR',
      });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Résumé lisible
// ---------------------------------------------------------------------------
function printSummary(report) {
  log('');
  log('=== Résumé performance OpenTT3D ===');
  log(
    `Machine : ${report.meta.machine.platform}/${report.meta.machine.arch} · ${report.meta.machine.cpu} · ${report.meta.machine.memoryGB} Go`,
  );
  log(
    `Chrome : ${report.meta.chrome} · GPU : ${report.gpu?.renderer ?? 'inconnu'} (${report.gpuKind})`,
  );
  log(`Bundle : ${report.meta.bundleMode} · Node ${report.meta.node} · DPR ${report.meta.dpr}`);
  log('');
  const header = [
    'moteur',
    'carte',
    'qual.',
    'scénario',
    'bootms',
    'fps',
    'p50',
    'p95',
    'draws',
    'tris',
    'snap p95',
    'step p95',
    'heap ret.',
    'GPU Mo',
  ];
  log(header.join('\t'));
  for (const run of report.runs) {
    const timed = run.scenario !== 'hidden' && run.scenario !== 'resize';
    log(
      [
        run.engineMode,
        run.size,
        run.quality,
        run.scenario,
        run.bootMs ?? '—',
        timed ? round(run.metrics.fps, 1) : '—',
        timed ? round(run.metrics.interval.p50, 2) : '—',
        timed ? round(run.metrics.interval.p95, 2) : '—',
        run.metrics.draws.max,
        run.metrics.triangles.max,
        round(run.engine?.snapshot.p95 ?? 0, 2),
        round(run.engine?.step.p95 ?? 0, 3),
        round((run.heap.retainedGrowth ?? run.heap.growth) / (1024 * 1024), 2),
        round((run.resources.after?.bytes?.total ?? 0) / (1024 * 1024), 1),
      ].join('\t'),
    );
  }
  const failed = report.checks.filter((check) => !check.ok);
  log('');
  if (report.soak) {
    const soak = report.soak;
    log(
      `Soak ${soak.engineMode}/${soak.size}/${soak.quality} ${soak.durationSeconds}s : ` +
        `${round(soak.metrics.fps, 1)} fps · p95 ${round(soak.metrics.interval.p95, 2)} ms · ` +
        `heap ${round((soak.heap.retainedGrowth ?? soak.heap.growth) / (1024 * 1024), 2)} Mo · ` +
        `GPU ${soak.resources.live?.total ?? '?'} objets · ` +
        `${round((soak.resources.bytes?.total ?? 0) / (1024 * 1024), 1)} Mo · ` +
        `${soak.resources.after?.live?.total ?? '?'} après dispose · ` +
        `long tasks ${soak.longTasks.count}`,
    );
    log('');
  }
  if (failed.length === 0) {
    log(`Budgets : OK (${report.checks.length} vérifications)`);
  } else {
    log(`Budgets DÉPASSÉS : ${failed.length}/${report.checks.length}`);
    for (const check of failed) {
      log(
        `  ✗ ${check.engine}/${check.size}/${check.quality}/${check.scenario} · ${check.name} : ${check.actual} > ${check.budget}`,
      );
    }
  }
  log(`JSON : ${report.meta.jsonPath}`);
  log(`Captures : ${path.relative(ROOT, SCREEN_DIR)}/`);
  log('');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function runConfig(page, options, config, artifacts, rendererInfo) {
  const runs = [];
  const url = `${artifacts.baseUrl}/?engine=${config.engine}&autostart&size=${config.size}&seed=42&quality=${config.quality}`;
  for (const scenario of config.scenarios) {
    log(
      `[perf] ${config.engine} ${config.size} ${config.quality} · ${scenario} (${options.duration}s)`,
    );
    await page.navigate(url);
    const bootStart = Date.now();
    const info = await page.waitForGame({ timeout: config.engine === 'wasm' ? 180_000 : 60_000 });
    const bootMs = Date.now() - bootStart;
    if (!info || info.mapSize === null) {
      throw new Error(
        `La partie ne démarre pas (${scenario}) : ${page.exceptions[0] ?? page.console[0]?.text ?? 'inconnu'}`,
      );
    }
    const run = await runScenario(
      page,
      scenario,
      options.duration,
      {
        engine: config.engine,
        size: config.size,
        quality: config.quality,
      },
      options.dpr,
    );
    run.engineMode = config.engine;
    run.size = config.size;
    run.quality = config.quality;
    run.bootMs = bootMs;
    run.qualityFromSession = info.quality;
    run.console = page.console.slice(0, 10);
    run.exceptions = page.exceptions.slice(0, 10);
    run.rendererInfo = rendererInfo;
    runs.push(run);

    // Fin de scénario : vérifie que `dispose()` libère le GPU et le DOM.
    const beforeDispose = await page.evaluate('window.__perfApi.resourcesOnly()');
    await page.evaluate('window.__perfApi.disposeSession()');
    await sleep(700);
    const afterDispose = await page.evaluate('window.__perfApi.resourcesOnly()');
    run.dispose = {
      liveBefore: beforeDispose.live.total,
      liveAfter: afterDispose.live.total,
      breakdown: afterDispose.live,
      bytesBefore: beforeDispose.bytes?.total ?? 0,
      bytesAfter: afterDispose.bytes?.total ?? 0,
      domBefore: beforeDispose.domNodes,
      domAfter: afterDispose.domNodes,
      residual: afterDispose.live.total,
    };
  }
  return runs;
}

async function runSoak(page, options, config, artifacts, rendererInfo) {
  const url = `${artifacts.baseUrl}/?engine=${config.engine}&autostart&size=${config.size}&seed=42&quality=${config.quality}`;
  log(`[perf] soak ${config.engine} ${config.size} ${config.quality} · ${options.soak}s`);
  await page.navigate(url);
  const info = await page.waitForGame({ timeout: config.engine === 'wasm' ? 180_000 : 60_000 });
  await page.evaluate('window.__perfApi.resetView()');
  await sleep(2000);
  await page.evaluate("window.__perfApi.begin('soak')");
  const samples = [];
  const deadline = Date.now() + options.soak * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    samples.push(await page.evaluate('window.__perfApi.counts()'));
  }
  const summary = await page.evaluate('window.__perfApi.end()');
  const engineMetrics = await page.evaluate('window.__perfApi.measure(15, true)');
  const cdp = await cdpMetrics(page);
  const screenshot = await page.screenshot(
    path.join(SCREEN_DIR, `soak-${config.engine}-${config.size}-${config.quality}.png`),
  );
  const beforeDispose = await page.evaluate('window.__perfApi.resourcesOnly()');
  await page.evaluate('window.__perfApi.disposeSession()');
  await sleep(700);
  const afterDispose = await page.evaluate('window.__perfApi.resourcesOnly()');
  return {
    scenario: 'soak',
    durationSeconds: options.soak,
    engineMode: config.engine,
    size: config.size,
    quality: config.quality,
    bootMs: 0,
    details: { samples: samples.length },
    metrics: summary.frame,
    longTasks: summary.longTasks,
    errors: summary.errors,
    heap: summary.heap,
    resources: {
      live: summary.resources.live,
      bytes: summary.resources.bytes,
      created: summary.resources.created,
      deleted: summary.resources.deleted,
      after: afterDispose,
      samples: summary.resources.samples,
      series: summary.resources.series,
    },
    dispose: {
      liveBefore: beforeDispose.live.total,
      liveAfter: afterDispose.live.total,
      breakdown: afterDispose.live,
      bytesBefore: beforeDispose.bytes?.total ?? 0,
      bytesAfter: afterDispose.bytes?.total ?? 0,
      residual: afterDispose.live.total,
      domBefore: beforeDispose.domNodes,
      domAfter: afterDispose.domNodes,
    },
    counts: summary.counts,
    engine: engineMetrics,
    cdp,
    info,
    rendererInfo,
    console: page.console.slice(0, 10),
    exceptions: page.exceptions.slice(0, 10),
    screenshot: path.relative(ROOT, screenshot),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(SCREEN_DIR, { recursive: true });

  if (options.build && options.server === 'preview') buildBundle();
  const server = await startServer(options);
  const chromePath = findChrome();
  const wasmReady = hasWasmArtifacts();
  const engines = parseList(options.engine, ['mock'])
    .map((item) => item.toLowerCase())
    .filter((item) => item === 'mock' || (item === 'wasm' && wasmReady));
  if (wasmReady && parseList(options.engine, ['mock']).includes('wasm')) {
    log('[perf] artefacts WASM détectés : moteur réel inclus.');
  } else if (parseList(options.engine, ['mock']).includes('wasm')) {
    log('[perf] artefacts WASM absents : moteur WASM ignoré.');
  }

  const startedAt = new Date();
  const report = {
    meta: {
      startedAt: startedAt.toISOString(),
      durationSeconds: 0,
      node: process.version,
      chrome:
        spawnSync(chromePath, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? chromePath,
      bundleMode: options.server === 'dev' ? 'vite dev' : 'vite build --mode development',
      git: gitInfo(),
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpu: (await import('node:os')).cpus()[0]?.model ?? 'inconnu',
        cores: (await import('node:os')).cpus().length,
        memoryGB: round((await import('node:os')).totalmem() / 1024 ** 3, 1),
      },
      dpr: options.dpr,
      viewport: VIEWPORT,
      options: {
        sizes: options.sizes,
        qualities: options.qualities,
        engines,
        scenarios: options.scenarios,
        duration: options.duration,
        soak: options.soak,
        swiftshader: options.swiftshader,
      },
      jsonPath:
        options.json ??
        path.join(ARTIFACTS, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`),
    },
    gpu: null,
    gpuKind: options.swiftshader ? 'swiftshader' : 'hardware',
    runs: [],
    checks: [],
    soak: null,
  };

  let page = null;
  try {
    page = await new ChromePage({ chromePath, swiftshader: options.swiftshader }).launch();
    await page.prepare({ dpr: options.dpr });
    // Une navigation à blanc suffit à lire le renderer WebGL.
    await page.navigate(`${server.url}/?engine=mock&autostart&size=128&seed=42&quality=low`);
    await page.waitForGame({ timeout: 60_000 });
    report.gpu = await readRendererInfo(page);
    report.gpuKind =
      report.gpu?.renderer && /swiftshader|software/i.test(report.gpu.renderer)
        ? 'swiftshader'
        : 'hardware';
    log(`[perf] GPU : ${report.gpu?.renderer ?? 'inconnu'} (${report.gpuKind})`);

    const configs = [];
    for (const engine of engines) {
      const sizes = engine === 'wasm' ? options.wasmSizes : options.sizes;
      const qualities = engine === 'wasm' ? options.wasmQualities : options.qualities;
      // Le scénario 300 véhicules pilote les internes du mock ; le moteur WASM
      // n'expose pas d'achat en masse sans partie jouée.
      const scenarios = options.scenarios.filter(
        (scenario) => engine === 'mock' || scenario !== 'vehicles',
      );
      for (const size of sizes) {
        for (const quality of qualities) {
          configs.push({ engine, size, quality, scenarios });
        }
      }
    }

    for (const config of configs) {
      const runs = await runConfig(page, options, config, { baseUrl: server.url }, report.gpu);
      report.runs.push(...runs);
      for (const run of runs) {
        report.checks.push(
          ...evaluateBudgets(run, config.quality, config.size, report.gpuKind).map((check) => ({
            ...check,
            engine: config.engine,
            size: config.size,
            quality: config.quality,
            scenario: run.scenario,
          })),
        );
        report.checks.push({
          name: 'dispose résiduel GPU',
          actual: run.dispose?.residual ?? 0,
          budget: Math.max(
            BUDGETS.disposeResidual,
            Math.ceil((run.dispose?.liveBefore ?? 0) * BUDGETS.disposeResidualRatio),
          ),
          ok:
            (run.dispose?.residual ?? 0) <=
            Math.max(
              BUDGETS.disposeResidual,
              Math.ceil((run.dispose?.liveBefore ?? 0) * BUDGETS.disposeResidualRatio),
            ),
          engine: config.engine,
          size: config.size,
          quality: config.quality,
          scenario: run.scenario,
          note: 'Three.js conserve ses textures/programmes par défaut',
        });
        const bytesBefore = run.dispose?.bytesBefore ?? 0;
        const bytesAfter = run.dispose?.bytesAfter ?? 0;
        const bytesRatio = bytesBefore > 0 ? bytesAfter / bytesBefore : 0;
        report.checks.push({
          name: 'dispose mémoire GPU libérée',
          actual: round(bytesRatio * 100, 1),
          budget: 10,
          ok: bytesRatio <= 0.1,
          engine: config.engine,
          size: config.size,
          quality: config.quality,
          scenario: run.scenario,
          note: `${round(bytesAfter / (1024 * 1024), 1)} Mo restants sur ${round(bytesBefore / (1024 * 1024), 1)} Mo`,
        });
        report.checks.push({
          name: 'erreurs console',
          actual:
            run.console.filter((entry) => entry.level === 'error').length + run.exceptions.length,
          budget: 0,
          ok:
            run.console.filter((entry) => entry.level === 'error').length === 0 &&
            run.exceptions.length === 0,
          engine: config.engine,
          size: config.size,
          quality: config.quality,
          scenario: run.scenario,
        });
      }
    }

    if (options.soak > 0) {
      const soakConfig = {
        engine: engines.includes('mock') ? 'mock' : engines[0],
        size: options.soakSize,
        quality: options.soakQuality,
      };
      report.soak = await runSoak(page, options, soakConfig, { baseUrl: server.url }, report.gpu);
      report.checks.push(
        ...evaluateBudgets(report.soak, soakConfig.quality, soakConfig.size, report.gpuKind).map(
          (check) => ({
            ...check,
            engine: soakConfig.engine,
            size: soakConfig.size,
            quality: soakConfig.quality,
            scenario: 'soak',
          }),
        ),
      );
      const soakResidual = report.soak.dispose?.residual ?? 0;
      const soakBefore = report.soak.dispose?.liveBefore ?? 0;
      report.checks.push({
        name: 'dispose résiduel GPU',
        actual: soakResidual,
        budget: Math.max(
          BUDGETS.disposeResidual,
          Math.ceil(soakBefore * BUDGETS.disposeResidualRatio),
        ),
        ok:
          soakResidual <=
          Math.max(BUDGETS.disposeResidual, Math.ceil(soakBefore * BUDGETS.disposeResidualRatio)),
        engine: soakConfig.engine,
        size: soakConfig.size,
        quality: soakConfig.quality,
        scenario: 'soak',
      });
      const soakBytesBefore = report.soak.dispose?.bytesBefore ?? 0;
      const soakBytesAfter = report.soak.dispose?.bytesAfter ?? 0;
      report.checks.push({
        name: 'dispose mémoire GPU libérée',
        actual: round((soakBytesBefore > 0 ? soakBytesAfter / soakBytesBefore : 0) * 100, 1),
        budget: 10,
        ok: soakBytesBefore === 0 || soakBytesAfter / soakBytesBefore <= 0.1,
        engine: soakConfig.engine,
        size: soakConfig.size,
        quality: soakConfig.quality,
        scenario: 'soak',
        note: `${round(soakBytesAfter / (1024 * 1024), 1)} Mo restants sur ${round(soakBytesBefore / (1024 * 1024), 1)} Mo`,
      });
      const soakErrors =
        (report.soak.console ?? []).filter((entry) => entry.level === 'error').length +
        (report.soak.exceptions?.length ?? 0);
      report.checks.push({
        name: 'erreurs console',
        actual: soakErrors,
        budget: 0,
        ok: soakErrors === 0,
        engine: soakConfig.engine,
        size: soakConfig.size,
        quality: soakConfig.quality,
        scenario: 'soak',
      });
    }
  } finally {
    await page?.close();
    await server.stop();
  }

  report.meta.durationSeconds = Math.round(
    (Date.now() - new Date(report.meta.startedAt).getTime()) / 1000,
  );
  const failures = report.checks.filter((check) => !check.ok);
  report.pass = failures.length === 0;

  writeFileSync(report.meta.jsonPath, JSON.stringify(report, null, 2));
  printSummary(report);
  if (!options.reportOnly && !report.pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[perf] échec : ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
