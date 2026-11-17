import { describe, expect, it } from 'vitest';
import { BuildController } from '../src/ui/buildController';
import { describeBuildPlan } from '../src/ui/buildHint';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import type { BuildPlan } from '../src/game/buildRules';

function makeMap(width = 16, height = 16): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

interface Harness {
  controller: BuildController;
  previews: (BuildPlan | null)[];
  commits: BuildPlan[];
  notices: string[];
}

function harness(map: MapSnapshot = makeMap()): Harness {
  const previews: (BuildPlan | null)[] = [];
  const commits: BuildPlan[] = [];
  const notices: string[] = [];
  const controller = new BuildController({
    getMap: () => map,
    getCompany: () => ({ id: 0, money: 1_000_000, bankrupt: false }),
    onPreview: (plan) => previews.push(plan),
    onCommit: (plan) => commits.push(plan),
    onNotice: (_kind, text) => notices.push(text),
  });
  return { controller, previews, commits, notices };
}

describe('BuildController', () => {
  it('affiche un aperçu d’une tuile au survol', () => {
    const { controller, previews } = harness();
    controller.setTool('road');
    controller.handleHover({ x: 4, y: 4 });
    const plan = previews[previews.length - 1];
    expect(plan?.valid).toBe(true);
    expect(plan?.tiles).toHaveLength(1);
    expect(plan?.cost).toBe(120);
  });

  it('construit un segment A→B relâché', () => {
    const { controller, commits } = harness();
    controller.setTool('road');
    controller.handleHover({ x: 2, y: 3 });
    controller.handleBegin({ x: 2, y: 3 });
    controller.handleMove({ x: 5, y: 5 });
    controller.handleEnd({ x: 5, y: 5 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tiles).toHaveLength(6);
    expect(commits[0]?.axis).toBe('x');
  });

  it('privilégie l’axe vertical d’un drag vertical', () => {
    const { controller, commits } = harness();
    controller.setTool('rail');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 3, y: 7 });
    controller.handleEnd({ x: 3, y: 7 });
    expect(commits[0]?.axis).toBe('y');
    expect(commits[0]?.tool).toBe('rail');
  });

  it('explique un tracé invalide sans émettre de commande', () => {
    const map = makeMap();
    map.kind[4 * map.width + 4] = TILE_KIND_INDEX.water;
    map.heightMap[4 * map.width + 4] = 0;
    const { controller, commits, notices } = harness(map);
    controller.setTool('road');
    controller.handleBegin({ x: 4, y: 4 });
    controller.handleEnd({ x: 4, y: 4 });
    expect(commits).toHaveLength(0);
    expect(notices[0]).toContain('Construction impossible');
    expect(notices[0]).toContain('eau');
  });

  it('annule le drag au clic droit sans désarmer l’outil', () => {
    const { controller, commits, previews } = harness();
    controller.setTool('road');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 6, y: 2 });
    controller.handleCancel();
    controller.handleEnd({ x: 6, y: 2 });
    expect(commits).toHaveLength(0);
    expect(controller.activeTool).toBe('road');
    expect(previews[previews.length - 1]?.tiles).toHaveLength(1);
  });

  it('désarme l’outil et efface l’aperçu à la sortie', () => {
    const { controller, previews } = harness();
    controller.setTool('road');
    controller.handleHover({ x: 3, y: 3 });
    controller.exit();
    expect(controller.activeTool).toBeNull();
    expect(previews[previews.length - 1]).toBeNull();
  });
});

describe('describeBuildPlan', () => {
  it('résume le coût d’un plan valide', () => {
    const plan = {
      tool: 'road',
      from: { x: 2, y: 2 },
      to: { x: 4, y: 2 },
      axis: 'x',
      tiles: [{}, {}, {}],
      cost: 360,
      valid: true,
      reason: null,
    } as unknown as BuildPlan;
    expect(describeBuildPlan(plan, 'road')).toEqual({
      tone: 'valid',
      text: 'Routes : 3 tuiles · 360 £',
    });
  });

  it('affiche le motif d’invalidité et l’état inactif', () => {
    const plan = {
      tool: 'rail',
      from: { x: 2, y: 2 },
      to: { x: 2, y: 2 },
      axis: 'x',
      tiles: [{}],
      cost: 400,
      valid: false,
      reason: 'Pente trop raide.',
    } as unknown as BuildPlan;
    expect(describeBuildPlan(plan, 'rail')).toEqual({
      tone: 'invalid',
      text: 'Rails : impossible — Pente trop raide.',
    });
    expect(describeBuildPlan(null, 'road')?.tone).toBe('idle');
    expect(describeBuildPlan(null, null)).toBeNull();
  });
});

describe('BuildController : sens unique (#231)', () => {
  it('cycle le sens avec R et transmet le sens au plan', () => {
    const { controller, previews } = harness();
    controller.setTool('road');
    expect(controller.buildSettings.road.direction).toBe('both');
    expect(controller.rotate()).toBe(true);
    expect(controller.buildSettings.road.direction).toBe('east');

    controller.handleHover({ x: 4, y: 4 });
    const plan = previews[previews.length - 1];
    expect(plan?.road?.oneWay).toBe('east');
    expect(plan?.axis).toBe('x');
    expect(plan?.valid).toBe(true);
  });

  it('refuse un glissement en L en sens unique', () => {
    const { controller, notices, commits } = harness();
    controller.setTool('road');
    controller.rotate();
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 5, y: 5 });
    controller.handleEnd({ x: 5, y: 5 });
    expect(commits).toHaveLength(0);
    expect(notices.some((text) => text.includes('segment droit'))).toBe(true);
  });
});
