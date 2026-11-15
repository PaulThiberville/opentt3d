import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGS, TRANSLATION_KEYS } from '../src/ui/i18n';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const style = readFileSync(join(root, 'src/style.css'), 'utf8');

function uiSources(directory = join(root, 'src/ui')): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...uiSources(path));
    } else if (entry.endsWith('.ts')) {
      files.push({ path, text: readFileSync(path, 'utf8') });
    }
  }
  return files;
}

/** Toutes les durées écrites en millisecondes dans une déclaration CSS. */
function durations(declaration: string): number[] {
  return [...declaration.matchAll(/(\d+(?:\.\d+)?)ms/g)].map((match) => Number(match[1]));
}

describe('budget de mouvement', () => {
  it('garde les micro-transitions sous 250 ms', () => {
    const declarations = [...style.matchAll(/transition:\s*([^;]+);/g)].map(
      (match) => match[1] ?? '',
    );
    expect(declarations.length).toBeGreaterThan(10);
    // Fondus ambiants, hors micro-animation : démo de menu et hint d'intro.
    const ambient = new Set(['opacity 800ms ease', 'opacity 400ms ease']);
    for (const declaration of declarations) {
      if (ambient.has(declaration.trim())) continue;
      for (const duration of durations(declaration)) {
        expect(duration, declaration).toBeLessThanOrEqual(250);
      }
    }
  });

  it('utilise les jetons de durée partagés', () => {
    expect(style).toContain('--fast: 140ms;');
    expect(style).toContain('--medium: 190ms;');
    expect(style).toMatch(/\.screen \{[\s\S]*?transition:[\s\S]*?200ms/);
    expect(style).toMatch(/\.btn \{[\s\S]*?var\(--fast\)/);
  });

  it('conserve la démo de fond et son fondu hors budget micro-animation', () => {
    expect(style).toContain('.menu-scene');
    expect(style).toMatch(/\.menu-scene \{[\s\S]*?transition: opacity 800ms ease;/);
    expect(style).toMatch(/body\.menu-attract #scene \{\s*display: none;/);
  });

  it('désactive animations et transitions en mouvement réduit', () => {
    const blocks = [
      ...style.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g),
    ].map((match) => match[1] ?? '');
    expect(blocks.length).toBeGreaterThan(0);
    const global = blocks.find((block) => block.includes('animation-duration'));
    expect(global).toBeTruthy();
    expect(global).toContain('animation-duration: 0.01ms !important');
    expect(global).toContain('transition-duration: 0.01ms !important');
    expect(blocks.some((block) => block.includes('.menu-column'))).toBe(true);
  });
});

describe('surfaces et états clés', () => {
  it('conserve la hiérarchie verre / panneaux / HUD', () => {
    for (const selector of [
      '.menu-screen',
      '.menu-column',
      '.menu-live',
      '.menu-live-dot',
      '.menu-button.is-primary',
      '.panel',
      '.panel-screen',
      '.screen--overlay',
      '.loading-card',
      '.loading-progress-value',
      '.hud-bar',
      '.hud-stat',
      '.hud-minimap',
      '.hud-toolbar',
      '.hud-selection',
      '.hud-news-panel',
    ]) {
      expect(style, selector).toContain(selector);
    }
  });

  it('préserve le flou des modales au-dessus de la démo', () => {
    expect(style).toMatch(
      /body\.menu-attract \.panel-screen \{[\s\S]*?backdrop-filter: blur\(16px\)/,
    );
    expect(style).toMatch(/body\.menu-attract \.panel \{[\s\S]*?background:/);
  });

  it('expose un focus visible et des variantes de contraste', () => {
    expect(style).toContain(':focus-visible');
    expect(style).toContain(':focus-visible {\n  outline: 2px solid var(--hud-accent);');
    expect(style).toContain('@media (prefers-contrast: more)');
    expect(style).toContain('@media (forced-colors: active)');
  });

  it('couvre mobile, tablette et zoom 200 %', () => {
    expect(style).toContain('@media (max-width: 900px)');
    expect(style).toContain('@media (max-width: 720px)');
    expect(style).toContain('@media (max-width: 520px)');
    expect(style).toContain('@media (max-height: 640px)');
    expect(style).toMatch(
      /@media \(max-width: 520px\) \{[\s\S]*?\.hud-minimap \{\s*display: none;/,
    );
  });
});

describe('i18n des écrans polis', () => {
  const prefixes = new Set(TRANSLATION_KEYS.map((key) => key.split('.')[0]));

  it('résout toutes les clés littérales utilisées par src/ui', () => {
    const missing: string[] = [];
    for (const { path, text } of uiSources()) {
      for (const match of text.matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        const key = match[1] ?? '';
        const prefix = key.split('.')[0] ?? '';
        if (!prefixes.has(prefix)) continue;
        if (!(key in CATALOGS.fr) || !(key in CATALOGS.en)) {
          missing.push(`${path.split('/src/')[1]}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('expose les libellés de la nouvelle vague dans les deux langues', () => {
    const keys = [
      'menu.live',
      'loading.eyebrow',
      'loading.progressShort',
      'hud.audio.mute',
      'hud.audio.unmute',
      'newgame.title',
      'build.tool.clear',
      'build.idle',
      'save.current.title',
      'depot.models',
      'vehicle.orderTitle',
      'selection.stat.speed',
      'label.cargo.passengers',
      'label.tile.rail',
      'label.industry.factory',
    ] as const;
    for (const key of keys) {
      expect(CATALOGS.fr[key]?.trim(), `FR ${key}`).toBeTruthy();
      expect(CATALOGS.en[key]?.trim(), `EN ${key}`).toBeTruthy();
    }
  });

  it('ne laisse aucun texte français en dur dans les écrans polis', () => {
    const polished = [
      'screens/MainMenuScreen.ts',
      'screens/LoadingScreen.ts',
      'screens/NewGameScreen.ts',
      'screens/SaveScreen.ts',
      'hud/TopBar.ts',
      'hud/DepotPanel.ts',
      'hud/VehiclePanel.ts',
      'Hud.ts',
      'selection.ts',
      'buildHint.ts',
    ];
    const accentedLiteral =
      /(?:text|title):\s*'[^']*[éèêàçùûîôœ][^']*'|button\('[^']*[éèêàçùûîôœ][^']*'/;
    const offenders: string[] = [];
    for (const relative of polished) {
      const text = readFileSync(join(root, 'src/ui', relative), 'utf8');
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        if (accentedLiteral.test(line)) offenders.push(`${relative}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('composants de la nouvelle vague', () => {
  it('conserve les crochets de structure des écrans', () => {
    const menu = readFileSync(join(root, 'src/ui/screens/MainMenuScreen.ts'), 'utf8');
    expect(menu).toContain("'menu-column'");
    expect(menu).toContain("'menu-live'");
    expect(menu).toContain("t('menu.live')");
    const loading = readFileSync(join(root, 'src/ui/screens/LoadingScreen.ts'), 'utf8');
    expect(loading).toContain('loading-card');
    expect(loading).toContain('loading-progress-value');
    expect(loading).toContain("'loading.eyebrow'");
  });

  it('garde la barre supérieure, la minimap et la barre d’outils', () => {
    expect(readFileSync(join(root, 'src/ui/hud/TopBar.ts'), 'utf8')).toContain("'hud-bar'");
    expect(readFileSync(join(root, 'src/ui/hud/Minimap.ts'), 'utf8')).toContain("'hud-minimap'");
    expect(readFileSync(join(root, 'src/ui/hud/Toolbar.ts'), 'utf8')).toContain("'hud-toolbar'");
  });

  it('maintient le focus sur le dialogue et le piège clavier', () => {
    const base = readFileSync(join(root, 'src/ui/screens/BaseScreen.ts'), 'utf8');
    expect(base).toContain('this.element.tabIndex = -1;');
    expect(base).toContain('this.trapFocus(event);');
    const manager = readFileSync(join(root, 'src/ui/screens/ScreenManager.ts'), 'utf8');
    expect(manager).toContain('focusFirst(element)');
    expect(manager).toContain('previous.focus()');
  });
});
