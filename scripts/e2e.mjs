#!/usr/bin/env node
/**
 * Harnais E2E navigateur d'OpenTT3D — sans Playwright.
 *
 * Lance un serveur Vite de développement, Chrome headless avec un port CDP
 * éphémère, puis les scénarios demandés. Chaque scénario écrit ses captures et
 * son résultat dans `e2e-out/`. Le code de retour est non nul dès qu'un
 * scénario échoue ; les scénarios optionnels (WASM) peuvent être ignorés.
 *
 * Exemples :
 *   npm run e2e
 *   npm run e2e -- --scenario=solo-mock
 *   npm run e2e -- --scenario=multi --headed
 *   npm run e2e -- --list
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpBrowser, DEFAULT_VIEWPORT } from './e2e/cdp.mjs';
import { startDevServer } from './e2e/server.mjs';
import { scenarios } from './e2e/scenarios/index.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outRoot = join(repoRoot, 'e2e-out');

const ALIASES = {
  all: scenarios.map((scenario) => scenario.id),
  multi: ['net-local', 'late-join'],
};

function usage() {
  const ids = scenarios.map((scenario) => scenario.id).join(', ');
  return `Usage : npm run e2e -- [options]

Options :
  --scenario=<id[,id]>  Scénarios à exécuter (défaut : tous). Alias : all, multi.
  --list                Liste les scénarios et quitte.
  --headed              Lance Chrome avec une fenêtre visible.
  --chrome=<chemin>     Binaire Chrome (sinon CHROME_PATH / détection auto).
  --timeout=<ms>        Remplace le timeout de chaque scénario.
  --keep                Conserve les artefacts du run précédent.
  --verbose             Affiche chaque vérification.
  --help                Affiche cette aide.

Scénarios : ${ids}
`;
}

function parseArgs(argv) {
  const options = {
    scenarioIds: [],
    list: false,
    headed: false,
    chromePath: null,
    timeoutMs: null,
    keep: false,
    verbose: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--headed') {
      options.headed = true;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg.startsWith('--chrome=')) {
      options.chromePath = arg.slice('--chrome='.length);
    } else if (arg === '--chrome') {
      options.chromePath = argv[++index] ?? null;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = Number(arg.slice('--timeout='.length));
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg.startsWith('--scenario=')) {
      options.scenarioIds.push(...arg.slice('--scenario='.length).split(','));
    } else if (arg === '--scenario') {
      options.scenarioIds.push(...String(argv[++index] ?? '').split(','));
    } else {
      throw new Error(`Option inconnue : ${arg}`);
    }
  }
  options.scenarioIds = options.scenarioIds
    .flatMap((value) => ALIASES[value] ?? [value])
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000)
  ) {
    throw new Error('--timeout doit être un nombre de millisecondes supérieur à 1000');
  }
  return options;
}

function slug(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
}

function duration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function safeJson(value, maxLength = 600) {
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(value, (key, item) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      if (typeof item === 'bigint') return item.toString();
      return item;
    });
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  // La promesse perdante du race continue après un timeout : on absorbe son
  // éventuel rejet lorsque le scénario est interrompu par la fermeture des
  // onglets.
  promise.catch(() => undefined);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout du scénario (${timeoutMs} ms) : ${label}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

class ScenarioContext {
  constructor(options) {
    this.id = options.id;
    this.title = options.title;
    this.repoRoot = options.repoRoot;
    this.baseUrl = options.baseUrl;
    this.browser = options.browser;
    this.outDir = options.outDir;
    this.verbose = options.verbose;
    this.pages = [];
    this.checks = [];
    this.captures = [];
  }

  log(message) {
    if (this.verbose) console.log(`    ${message}`);
  }

  async newPage(name, viewport = undefined) {
    const page = viewport ? await this.browser.newPage(viewport) : await this.browser.newPage();
    this.pages.push({ name, page });
    return page;
  }

  check(label, details = undefined) {
    this.checks.push({ status: 'pass', label, details: details ?? null });
    this.log(`✓ ${label}`);
  }

  assert(condition, label, details = undefined) {
    if (!condition) {
      this.checks.push({ status: 'fail', label, details: details ?? null });
      throw new Error(`${label}${details === undefined ? '' : ` — ${safeJson(details)}`}`);
    }
    this.check(label, details);
  }

  async capture(page, name) {
    const index = String(this.captures.length + 1).padStart(2, '0');
    const filePath = join(this.outDir, `${index}-${slug(name)}.png`);
    await page.screenshot(filePath);
    const info = await stat(filePath);
    const capture = {
      name,
      file: filePath,
      relative: relative(this.repoRoot, filePath),
      size: info.size,
    };
    this.captures.push(capture);
    this.log(`capture ${capture.relative} (${Math.round(info.size / 1024)} Kio)`);
    return capture;
  }

  async diagnostics() {
    const lines = [
      `Scénario : ${this.id} — ${this.title}`,
      `URL de base : ${this.baseUrl}`,
      `Dossier : ${relative(this.repoRoot, this.outDir)}`,
      '',
    ];
    for (const entry of this.pages) {
      const { name, page } = entry;
      lines.push(`--- Onglet ${name} ---`);
      if (page.closed) {
        lines.push('(fermé)');
        lines.push('');
        continue;
      }
      try {
        const info = await page.evaluate(() => {
          const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
          return {
            url: location.href,
            readyState: document.readyState,
            screen: window.__opentt3d?.screens?.key ?? null,
            money: text('.hud-money-value'),
            date: text('.hud-date .hud-value'),
            net: text('.hud-net'),
            title: document.title,
            body: String(document.body?.innerText ?? '').slice(0, 1200),
          };
        });
        lines.push(`URL : ${info.url}`);
        lines.push(`readyState : ${info.readyState} · écran : ${info.screen ?? '—'}`);
        lines.push(`HUD : date=${info.date ?? '—'} · trésorerie=${info.money ?? '—'}`);
        lines.push(`Réseau : ${info.net ?? '—'}`);
        lines.push(`Texte visible (extrait) :\n${info.body}`);
      } catch (error) {
        lines.push(`Diagnostics indisponibles : ${error.message}`);
      }
      const entries = page.entries.filter(
        (entry) =>
          entry.level === 'error' ||
          entry.level === 'warn' ||
          entry.level === 'warning' ||
          entry.source === 'exception',
      );
      if (entries.length > 0) {
        lines.push('Console (erreurs/avertissements) :');
        for (const entry of entries.slice(-40)) {
          lines.push(
            `  [${entry.source}/${entry.level}] ${entry.text}` +
              (entry.url ? ` (${entry.url}:${entry.line ?? 0})` : ''),
          );
        }
      } else {
        lines.push('Console : aucune erreur ni avertissement.');
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}

async function captureFailures(ctx) {
  for (const entry of ctx.pages) {
    if (entry.page.closed) continue;
    try {
      await ctx.capture(entry.page, `failure-${entry.name}`);
    } catch (error) {
      ctx.log(`capture d'échec impossible pour ${entry.name} : ${error.message}`);
    }
  }
}

function consoleDigest(pages) {
  let errors = 0;
  let warnings = 0;
  for (const { page } of pages) {
    errors += page.errors().length;
    warnings += page.warnings().length;
  }
  return { errors, warnings };
}

function consoleErrors(pages) {
  const lines = [];
  for (const { name, page } of pages) {
    for (const entry of page.errors()) {
      lines.push(
        `[${name}/${entry.source}] ${entry.text}` +
          (entry.url ? ` (${entry.url}:${entry.line ?? 0})` : ''),
      );
    }
  }
  return lines;
}

async function runScenario(definition, runtime) {
  const startedAt = Date.now();
  const outDir = join(outRoot, definition.id);
  await mkdir(outDir, { recursive: true });
  const ctx = new ScenarioContext({
    id: definition.id,
    title: definition.title,
    repoRoot,
    baseUrl: runtime.server.url,
    browser: runtime.browser,
    outDir,
    verbose: runtime.options.verbose,
  });
  let status = 'passed';
  let error = null;
  let skipReason = null;
  try {
    const result = await withTimeout(
      definition.run(ctx),
      runtime.options.timeoutMs ?? definition.timeoutMs,
      definition.id,
    );
    if (result?.skip) {
      status = 'skipped';
      skipReason = result.skip;
    }
  } catch (caught) {
    status = 'failed';
    error = caught instanceof Error ? caught : new Error(String(caught));
  }

  if (status === 'passed') {
    const errors = consoleErrors(ctx.pages);
    if (errors.length > 0) {
      status = 'failed';
      error = new Error(
        `Erreurs console détectées dans ${errors.length} entrée(s) :\n${errors.join('\n')}`,
      );
    }
  }

  if (status === 'failed' && error) {
    await captureFailures(ctx);
    try {
      await writeFile(
        join(outDir, 'failure.txt'),
        `${await ctx.diagnostics()}\n=== Erreur ===\n${error.stack ?? error.message}\n`,
      );
    } catch {
      // Le diagnostic ne doit pas masquer l'échec initial.
    }
  }

  const result = {
    id: definition.id,
    title: definition.title,
    status,
    durationMs: Date.now() - startedAt,
    checks: ctx.checks,
    captures: ctx.captures,
    console: consoleDigest(ctx.pages),
    error: error ? (error.stack ?? error.message) : null,
    skipReason,
  };
  await writeFile(join(outDir, 'scenario.json'), `${JSON.stringify(result, null, 2)}\n`);

  for (const { page } of ctx.pages) await runtime.browser.closePage(page).catch(() => undefined);
  return result;
}

function printSummary(results, runtime, totalMs) {
  const totals = {
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  };
  console.log('');
  console.log('Résumé E2E');
  console.log('==========');
  console.log(`Chrome      : ${runtime.browser.version?.Browser ?? 'inconnu'}`);
  console.log(`Serveur     : ${runtime.server.mode} · ${runtime.server.url}`);
  console.log(`Vue         : ${DEFAULT_VIEWPORT.width}×${DEFAULT_VIEWPORT.height}`);
  console.log(`Node        : ${process.version} · ${process.platform}/${process.arch}`);
  console.log('');
  for (const result of results) {
    const icon =
      result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(
      `${icon}  ${result.id.padEnd(12)} ${duration(result.durationMs).padStart(7)} · ` +
        `${result.checks.length} vérifications · ${result.captures.length} captures` +
        (result.skipReason ? ` · ${result.skipReason}` : ''),
    );
  }
  console.log('');
  console.log(
    `Total       : ${totals.passed} réussis, ${totals.skipped} ignorés, ` +
      `${totals.failed} échoués · ${duration(totalMs)}`,
  );
  console.log(`Artefacts   : ${relative(repoRoot, outRoot)}/`);
  return totals;
}

async function writeSummary(results, runtime, totalMs, totals) {
  const summary = {
    startedAt: runtime.startedAt,
    durationMs: totalMs,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      chrome: runtime.browser.version?.Browser ?? null,
      protocol: runtime.browser.version?.['Protocol-Version'] ?? null,
      browserArgs: runtime.browser.args ?? null,
      server: runtime.server.mode,
      baseUrl: runtime.server.url,
      viewport: DEFAULT_VIEWPORT,
    },
    totals,
    scenarios: results,
  };
  await writeFile(join(outRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [
    'OpenTT3D — rapport E2E navigateur',
    `Démarré : ${runtime.startedAt}`,
    `Durée : ${duration(totalMs)}`,
    `Chrome : ${runtime.browser.version?.Browser ?? 'inconnu'}`,
    `Serveur : ${runtime.server.mode} · ${runtime.server.url}`,
    `Vue : ${DEFAULT_VIEWPORT.width}×${DEFAULT_VIEWPORT.height}`,
    `Node : ${process.version} · ${process.platform}/${process.arch}`,
    '',
  ];
  for (const result of results) {
    lines.push(
      `[${result.status.toUpperCase()}] ${result.id} — ${result.title} (${duration(result.durationMs)})`,
    );
    if (result.skipReason) lines.push(`  Ignoré : ${result.skipReason}`);
    for (const check of result.checks) {
      lines.push(`  ${check.status === 'pass' ? '✓' : '✗'} ${check.label}`);
    }
    for (const capture of result.captures) lines.push(`  capture : ${capture.relative}`);
    if (result.error) lines.push(`  Erreur : ${result.error.split('\n')[0]}`);
    lines.push('');
  }
  lines.push(
    `Total : ${totals.passed} réussis, ${totals.skipped} ignorés, ${totals.failed} échoués`,
  );
  await writeFile(join(outRoot, 'summary.txt'), `${lines.join('\n')}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[e2e] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.list) {
    for (const scenario of scenarios) console.log(`${scenario.id.padEnd(14)} ${scenario.title}`);
    return;
  }

  const known = new Set(scenarios.map((scenario) => scenario.id));
  const selected =
    options.scenarioIds.length === 0
      ? scenarios
      : scenarios.filter((scenario) => options.scenarioIds.includes(scenario.id));
  const unknown = options.scenarioIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`[e2e] Scénario(s) inconnu(s) : ${unknown.join(', ')}`);
    console.error(`[e2e] Disponibles : ${[...known].join(', ')}`);
    process.exit(2);
  }
  if (selected.length === 0) {
    console.error('[e2e] Aucun scénario sélectionné.');
    process.exit(2);
  }

  if (!options.keep) await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  console.log(`[e2e] ${selected.length} scénario(s) · sortie ${relative(repoRoot, outRoot)}/`);

  let server = null;
  let browser = null;
  const cleanup = async () => {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await server.close().catch(() => undefined);
  };
  const onSignal = () => {
    console.error('\n[e2e] Interrompu.');
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    server = await startDevServer({ root: repoRoot });
    browser = await CdpBrowser.launch({
      headed: options.headed,
      chromePath: options.chromePath,
    });
    console.log(`[e2e] Vite prêt sur ${server.url}`);
    console.log(`[e2e] ${browser.version?.Browser ?? 'Chrome'} headless`);
    const runtime = { server, browser, options, startedAt };
    const results = [];
    for (const definition of selected) {
      const result = await runScenario(definition, runtime);
      results.push(result);
      const icon =
        result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
      console.log(
        `${icon}  ${result.id.padEnd(12)} ${duration(result.durationMs).padStart(7)}` +
          (result.skipReason ? ` · ${result.skipReason}` : ''),
      );
      if (result.status === 'failed' && result.error) {
        console.error(`      ${result.error.split('\n').join('\n      ')}`);
      }
    }
    const totalMs = Date.now() - startedMs;
    const totals = printSummary(results, runtime, totalMs);
    await writeSummary(results, runtime, totalMs, totals);
    await cleanup();
    process.exitCode = totals.failed > 0 ? 1 : 0;
  } catch (error) {
    console.error(`[e2e] Erreur fatale : ${error.stack ?? error.message}`);
    await cleanup();
    process.exitCode = 1;
  }
}

await main();
