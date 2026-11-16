import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
}

function triggerBlock(name: string): string {
  const text = workflow(name);
  const start = text.indexOf('\non:');
  const end = text.indexOf('\npermissions:');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('workflows et artefacts', () => {
  for (const name of ['engine.yml', 'desktop.yml']) {
    it(`${name} reste strictement manuel`, () => {
      const triggers = triggerBlock(name);
      expect(triggers).toContain('workflow_dispatch:');
      expect(triggers).not.toMatch(/push:|pull_request:|tags:|release:/);
      const text = workflow(name);
      expect(text).not.toContain('actions/cache');
    });
  }

  it('l’artefact Pages est un déploiement éphémère, pas un artefact de release', () => {
    const pages = workflow('pages.yml');
    expect(pages).toContain('actions/upload-pages-artifact');
    expect(pages).toContain('retention-days: 1');
  });

  it('le workflow desktop couvre macOS, Windows et Linux sans déclencheur automatique', () => {
    const desktop = workflow('desktop.yml');
    expect(desktop).toContain('macos-15');
    expect(desktop).toContain('windows-latest');
    expect(desktop).toContain('ubuntu-latest');
    expect(desktop).toContain('platform: linux');
    expect(desktop).toContain('release/*.AppImage');
    expect(desktop).toContain('--publish never');
    expect(desktop).toContain('retention-days: 1');
  });

  it('le nettoyage des caches est planifié', () => {
    const cleanup = workflow('cache-cleanup.yml');
    expect(cleanup).toContain('schedule:');
    expect(cleanup).toContain('cron:');
  });
});
