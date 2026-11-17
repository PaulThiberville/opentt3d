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
  planBuild,
  planTunnel,
  resolveBridgeSpan,
  type BuildPlan,
  type BuildPoint,
} from '../src/game/buildRules';
import { BuildController } from '../src/ui/buildController';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { tileIndex } from '../src/game/mapGrid';

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

describe('UI → plan → MockEngine : arrêt de bus en passage (#230)', () => {
  function findVerticalRoad(map: MapSnapshot): { from: BuildPoint; to: BuildPoint } {
    for (let x = 1; x < map.width - 1; x += 1) {
      for (let y = 1; y < map.height - 4; y += 1) {
        const plan = planBuild({
          map,
          tool: 'road',
          from: { x, y },
          to: { x, y: y + 2 },
          budget: 10_000_000,
        });
        if (plan.valid) return { from: plan.from, to: plan.to };
      }
    }
    throw new Error('aucune route verticale constructible');
  }

  it('un clic du contrôleur pose l’arrêt sur la chaussée, sans halle', async () => {
    const engine = await createEngine(9090);
    const road = findVerticalRoad(mapOf(engine));
    engine.send({ type: 'build', tool: 'road', company: 0, from: road.from, to: road.to });
    const map = engine.snapshot().map;
    if (!map) throw new Error('la route doit invalider la carte');

    const middle = { x: road.from.x, y: road.from.y + 1 };
    const { controller, plans } = harness(map);
    const settings = createBuildSettings();
    settings.station = {
      ...settings.station,
      kind: 'road',
      driveThrough: true,
      // Direction perpendiculaire au départ : l'aperçu doit s'aligner sur Y.
      direction: 'ne',
    };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleBegin(middle);
    controller.handleEnd(middle);

    const plan = lastPlan(plans);
    expect(plan.valid).toBe(true);
    expect(plan.station?.driveThrough).toBe(true);
    expect(plan.station?.direction).toBe('nw');
    expect(plan.axis).toBe('y');

    engine.send(commandFromPlan(plan, 0));
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('l’arrêt doit invalider la carte');
    const index = tileIndex(middle.x, middle.y, built.width);
    expect(built.kind[index]).toBe(TILE_KIND_INDEX.station);
    expect((built.trackBits[index] ?? 0) & 0x0f).toBe(1 | 4);
    const station = after.stations.find(
      (item) => item.kind === 'road' && item.x === middle.x + 0.5 && item.y === middle.y + 0.5,
    );
    expect(station?.driveThrough).toBe(true);
    expect(station?.roadAxis).toBe('y');
    expect(after.news.some((item) => item.text.includes('en passage'))).toBe(true);
  });
});

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
    // Le drag s'arrête parfois sur l'eau : les culées sont recalées sur les
    // berges réelles (#243).
    const snapped = resolveBridgeSpan(map, site.from, site.to);
    expect(snapped).not.toBeNull();
    expect(plan.from).toEqual(snapped?.from);
    expect(plan.to).toEqual(snapped?.to);

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
