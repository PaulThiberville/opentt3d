/**
 * Parcours complet UI → plan → mock : un drag diagonal du contrôleur doit
 * produire un plan valide, puis la commande correspondante doit être appliquée
 * par le MockEngine. Couvre les ponts (#216) et les tunnels (#217).
 */

import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import {
  commandFromPlan,
  createBuildSettings,
  planBridge,
  planTunnel,
  type BuildPlan,
  type BuildPoint,
} from '../src/game/buildRules';
import { BuildController } from '../src/ui/buildController';
import type { MapSnapshot } from '../src/engine/protocol';

async function createEngine(seed = 4242): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: 128, height: 128 });
  return engine;
}

function mapOf(engine: MockEngine): MapSnapshot {
  const map = engine.snapshot().map;
  if (!map) throw new Error('carte attendue dans le premier snapshot');
  return map;
}

interface BridgeSite {
  from: BuildPoint;
  to: BuildPoint;
  raw: BuildPoint;
}

function findBridgeSite(map: MapSnapshot): BridgeSite {
  for (let y = 2; y < map.height - 2; y += 1) {
    for (let x = 2; x < map.width - 2; x += 1) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        for (let span = 3; span <= 8; span += 1) {
          const from = { x, y };
          const to = { x: x + dx * span, y: y + dy * span };
          if (to.x >= map.width - 2 || to.y >= map.height - 2) break;
          const plan = planBridge({
            map,
            from,
            to,
            settings: { kind: 'road', material: 'wood' },
            budget: 10_000_000,
          });
          if (!plan.valid) continue;
          // Décalage d'une tuile sur l'axe secondaire : le drag est diagonal,
          // mais l'axe dominant reste celui du pont.
          const raw = dx === 1 ? { x: to.x, y: to.y + 1 } : { x: to.x + 1, y: to.y };
          return { from, to, raw };
        }
      }
    }
  }
  throw new Error('aucun site de pont pour le parcours UI → mock');
}

interface TunnelSite {
  from: BuildPoint;
  to: BuildPoint;
  raw: BuildPoint;
}

function findTunnelSite(map: MapSnapshot): TunnelSite {
  for (let y = 2; y < map.height - 2; y += 1) {
    for (let x = 2; x < map.width - 10; x += 1) {
      for (let span = 2; span <= 10; span += 1) {
        const from = { x, y };
        const to = { x: x + span, y };
        const plan = planTunnel({
          map,
          from,
          to,
          settings: { kind: 'rail' },
          budget: 10_000_000,
        });
        if (!plan.valid) continue;
        // Le drag s'arrête sur le point le plus haut du relief, pas sur le
        // portail de sortie : le contrôleur doit le retrouver seul.
        let raw = to;
        let highest = map.heightMap[y * map.width + x] ?? 0;
        for (let offset = 1; offset < span; offset += 1) {
          const index = y * map.width + x + offset;
          const height = map.heightMap[index] ?? 0;
          if (height > highest) {
            highest = height;
            raw = { x: x + offset, y };
          }
        }
        if (raw.x === from.x) continue;
        return { from, to, raw };
      }
    }
  }
  throw new Error('aucun site de tunnel pour le parcours UI → mock');
}

interface Harness {
  controller: BuildController;
  plans: BuildPlan[];
}

function harness(map: MapSnapshot): Harness {
  const plans: BuildPlan[] = [];
  const controller = new BuildController({
    getMap: () => map,
    getCompany: () => ({ id: 0, money: 10_000_000, bankrupt: false }),
    onPreview: (plan) => {
      if (plan) plans.push(plan);
    },
    onCommit: () => undefined,
    onNotice: () => undefined,
  });
  controller.setSettings(createBuildSettings());
  return { controller, plans };
}

function lastPlan(plans: BuildPlan[]): BuildPlan {
  const plan = plans[plans.length - 1];
  if (!plan) throw new Error('aperçu attendu');
  return plan;
}

describe('UI → plan → MockEngine : ouvrages (#216/#217)', () => {
  it('construit le pont tracé par un drag diagonal du contrôleur', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    const site = findBridgeSite(map);
    const { controller, plans } = harness(map);
    controller.setTool('bridge');
    controller.handleBegin(site.from);
    controller.handleMove(site.raw);

    const plan = lastPlan(plans);
    expect(plan.valid).toBe(true);
    expect(plan.from).toEqual(site.from);
    expect(plan.to).toEqual(site.to);

    const structuresBefore = engine.snapshot().structures?.length ?? 0;
    engine.send(commandFromPlan(plan, 0));
    const after = engine.snapshot();
    expect(after.structures).toHaveLength(structuresBefore + 1);
    expect(after.news.some((item) => item.text.includes('Pont'))).toBe(true);
  });

  it('construit le tunnel dont la sortie est retrouvée depuis le relief', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    const site = findTunnelSite(map);
    const { controller, plans } = harness(map);
    controller.setTool('tunnel');
    controller.handleBegin(site.from);
    controller.handleMove(site.raw);

    const plan = lastPlan(plans);
    expect(plan.valid).toBe(true);
    expect(plan.from).toEqual(site.from);
    expect(plan.to).toEqual(site.to);
    expect(plan.tunnel?.depth).toBeGreaterThan(0);

    const structuresBefore = engine.snapshot().structures?.length ?? 0;
    engine.send(commandFromPlan(plan, 0));
    const after = engine.snapshot();
    expect(after.structures).toHaveLength(structuresBefore + 1);
    expect(after.news.some((item) => item.text.includes('Tunnel'))).toBe(true);
  });
});
