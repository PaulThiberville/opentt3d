import { describe, expect, it } from 'vitest';
import { BuildController } from '../src/ui/buildController';
import { describeBuildPlan } from '../src/ui/buildHint';
import { createBuildSettings, type BuildPlan, type BuildSettings } from '../src/game/buildRules';
import { COMPANY_NONE, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';

function makeMap(width = 16, height = 16, level = 4): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(level),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function setTile(
  map: MapSnapshot,
  x: number,
  y: number,
  kind: number,
  bits = 0,
  owner = COMPANY_NONE,
): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  map.trackBits[index] = bits;
  map.owner[index] = owner;
}

interface Harness {
  controller: BuildController;
  previews: (BuildPlan | null)[];
  commits: BuildPlan[];
  notices: string[];
  settings: BuildSettings;
}

function harness(map: MapSnapshot = makeMap()): Harness {
  const previews: (BuildPlan | null)[] = [];
  const commits: BuildPlan[] = [];
  const notices: string[] = [];
  const settings = createBuildSettings();
  const controller = new BuildController({
    getMap: () => map,
    getCompany: () => ({ id: 0, money: 1_000_000, bankrupt: false }),
    onPreview: (plan) => previews.push(plan),
    onCommit: (plan) => commits.push(plan),
    onNotice: (_kind, text) => notices.push(text),
  });
  controller.setSettings(settings);
  return { controller, previews, commits, notices, settings };
}

function lastPlan(previews: (BuildPlan | null)[]): BuildPlan | null {
  return previews[previews.length - 1] ?? null;
}

describe('BuildController : terrassement et arbres (#158)', () => {
  it('affiche le carré de terrassement et transmet le sens', () => {
    const { controller, previews, commits, settings } = harness();
    settings.terraform = { direction: 'down', size: 2 };
    controller.setSettings(settings);
    controller.setTool('terraform');
    controller.handleHover({ x: 3, y: 3 });
    const plan = lastPlan(previews);
    expect(plan?.tool).toBe('terraform');
    expect(plan?.tiles).toHaveLength(4);
    expect(plan?.terraform?.direction).toBe('down');
    expect(describeBuildPlan(plan, 'terraform')?.text).toContain('Terrassement');
    expect(describeBuildPlan(plan, 'terraform')?.text).toContain('4 tuiles');

    controller.handleBegin({ x: 3, y: 3 });
    controller.handleEnd({ x: 3, y: 3 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.terraform?.direction).toBe('down');
  });

  it('trace une plantation rectangulaire au drag et l’annule au clic droit', () => {
    const { controller, commits, notices, settings } = harness();
    settings.tree = { size: 2 };
    controller.setSettings(settings);
    controller.setTool('tree');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 4, y: 3 });
    controller.handleEnd({ x: 4, y: 3 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tiles).toHaveLength(6);
    expect(commits[0]?.tool).toBe('tree');

    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 3, y: 3 });
    controller.handleCancel();
    controller.handleEnd({ x: 3, y: 3 });
    expect(commits).toHaveLength(1);
    expect(notices).toHaveLength(0);
  });
});

describe('BuildController : canaux, écluses, aqueducs (#158)', () => {
  it('aperçoit un canal puis le construit au drag', () => {
    const { controller, previews, commits } = harness();
    controller.setTool('canal');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 5, y: 2 });
    const plan = lastPlan(previews);
    expect(plan?.tool).toBe('canal');
    expect(plan?.valid).toBe(true);
    expect(plan?.tiles).toHaveLength(4);
    controller.handleEnd({ x: 5, y: 2 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tool).toBe('canal');
  });

  it('pose une écluse sur un canal adjacent et pivote avec R', () => {
    const map = makeMap();
    setTile(map, 3, 4, TILE_KIND_INDEX.canal, 2 | 8);
    setTile(map, 4, 4, TILE_KIND_INDEX.canal, 2 | 8);
    const { controller, previews, commits, settings } = harness(map);
    settings.lock = { direction: null };
    controller.setSettings(settings);
    controller.setTool('lock');
    controller.handleHover({ x: 4, y: 4 });
    const plan = lastPlan(previews);
    expect(plan?.valid).toBe(true);
    expect(plan?.lock?.direction).toBeDefined();

    expect(controller.rotate()).toBe(true);
    expect(lastPlan(previews)?.lock?.direction).toBe('se');
    controller.handleBegin({ x: 4, y: 4 });
    controller.handleEnd({ x: 4, y: 4 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tool).toBe('lock');
  });

  it('trace un aqueduc au drag et refuse un tracé diagonal', () => {
    const { controller, previews, commits } = harness();
    controller.setTool('aqueduct');
    controller.handleBegin({ x: 2, y: 4 });
    controller.handleMove({ x: 6, y: 4 });
    const plan = lastPlan(previews);
    expect(plan?.tool).toBe('aqueduct');
    expect(plan?.valid).toBe(true);
    expect(plan?.aqueduct?.axis).toBe('x');
    controller.handleEnd({ x: 6, y: 4 });
    expect(commits).toHaveLength(1);

    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 4, y: 4 });
    expect(lastPlan(previews)?.valid).toBe(false);
    expect(lastPlan(previews)?.reason).toContain('X ou Y');
  });
});

describe('BuildController : passages à niveau (#159)', () => {
  it('aperçoit et pose un passage sur une voie droite', () => {
    const map = makeMap();
    setTile(map, 5, 5, TILE_KIND_INDEX.rail, 2 | 8, 0);
    const { controller, previews, commits } = harness(map);
    controller.setTool('crossing');
    controller.handleHover({ x: 5, y: 5 });
    const plan = lastPlan(previews);
    expect(plan?.tool).toBe('crossing');
    expect(plan?.valid).toBe(true);
    expect(plan?.crossing).toEqual({ network: 'rail', axis: 'x' });
    expect(describeBuildPlan(plan, 'crossing')?.text).toContain('niveau');
    controller.handleBegin({ x: 5, y: 5 });
    controller.handleEnd({ x: 5, y: 5 });
    expect(commits).toHaveLength(1);
  });

  it('refuse une courbe et n’arme pas le bouton Pivoter', () => {
    const map = makeMap();
    setTile(map, 5, 5, TILE_KIND_INDEX.rail, 1 | 2, 0);
    const { controller, previews, notices } = harness(map);
    controller.setTool('crossing');
    controller.handleHover({ x: 5, y: 5 });
    expect(lastPlan(previews)?.valid).toBe(false);
    expect(lastPlan(previews)?.reason).toContain('droite');
    expect(controller.rotate()).toBe(false);

    controller.handleBegin({ x: 5, y: 5 });
    controller.handleEnd({ x: 5, y: 5 });
    expect(notices.some((text) => text.includes('droite'))).toBe(true);
  });
});
