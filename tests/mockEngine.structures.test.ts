import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import { TILE_FLAG, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { planBridge, planTunnel, type BuildPoint } from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';

async function createEngine(seed = 4242, size = 128): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: size, height: size });
  return engine;
}

function mapOf(engine: MockEngine): MapSnapshot {
  const map = engine.snapshot().map;
  if (!map) throw new Error('carte attendue dans le premier snapshot');
  return map;
}

function findBridge(map: MapSnapshot): { from: BuildPoint; to: BuildPoint } {
  let fallback: { from: BuildPoint; to: BuildPoint } | null = null;
  for (let y = 2; y < map.height - 2; y += 1) {
    for (let x = 2; x < map.width - 6; x += 1) {
      for (let span = 2; span <= 10; span += 1) {
        const from = { x, y };
        const to = { x: x + span, y };
        const plan = planBridge({
          map,
          from,
          to,
          settings: { kind: 'rail', material: 'wood' },
          budget: 10_000_000,
        });
        if (!plan.valid) continue;
        const crossesWater = plan.tiles
          .slice(1, -1)
          .some(
            (tile) =>
              map.kind[tile.index] === TILE_KIND_INDEX.water ||
              map.kind[tile.index] === TILE_KIND_INDEX.river,
          );
        if (crossesWater) return { from, to };
        fallback ??= { from, to };
      }
    }
  }
  if (fallback) return fallback;
  throw new Error('aucun site de pont dans la carte de test');
}

function findTunnel(map: MapSnapshot): { from: BuildPoint; to: BuildPoint } {
  for (let y = 2; y < map.height - 2; y += 1) {
    for (let x = 2; x < map.width - 8; x += 1) {
      for (let span = 3; span <= 10; span += 1) {
        const from = { x, y };
        const to = { x: x + span, y };
        const plan = planTunnel({
          map,
          from,
          to,
          settings: { kind: 'rail' },
          budget: 10_000_000,
        });
        if (plan.valid) return { from, to };
      }
    }
  }
  throw new Error('aucun site de tunnel dans la carte de test');
}

describe('MockEngine : ponts', () => {
  it('pose un tablier sur l’eau, débite le coût et publie une news', async () => {
    const engine = await createEngine();
    const map = mapOf(engine);
    const site = findBridge(map);
    const plan = planBridge({
      map,
      from: site.from,
      to: site.to,
      settings: { kind: 'rail', material: 'wood' },
      budget: 10_000_000,
    });
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;

    engine.send({
      type: 'build',
      tool: 'bridge',
      company: 0,
      from: site.from,
      to: site.to,
      options: { kind: 'rail', material: 'wood' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le pont doit invalider la carte');
    for (const tile of plan.tiles) {
      expect((built.flags[tile.index] ?? 0) & TILE_FLAG.BRIDGE).toBe(TILE_FLAG.BRIDGE);
    }
    for (const end of [site.from, site.to]) {
      const index = tileIndex(end.x, end.y, built.width);
      expect(built.kind[index]).toBe(TILE_KIND_INDEX.bridge);
      expect(built.owner[index]).toBe(0);
    }
    expect(after.structures).toHaveLength(1);
    expect(after.structures?.[0]).toMatchObject({
      kind: 'bridge',
      company: 0,
      transport: 'rail',
      material: 'wood',
      from: site.from,
      to: site.to,
    });
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-plan.cost);
    expect(after.news.some((item) => item.text.includes('Pont en bois construit'))).toBe(true);
  });

  it('restaure l’eau et l’herbe à la démolition (Ctrl+Z)', async () => {
    const engine = await createEngine(77);
    const map = mapOf(engine);
    const site = findBridge(map);
    engine.send({
      type: 'build',
      tool: 'bridge',
      company: 0,
      from: site.from,
      to: site.to,
      options: { kind: 'rail', material: 'wood' },
    });
    engine.snapshot();
    // Ctrl+Z ne démolit qu'une culée : OpenTTD retire tout l'ouvrage.
    engine.send({ type: 'build', tool: 'clear', company: 0, from: site.from });
    const after = engine.snapshot();
    expect(after.structures).toEqual([]);
    const restored = after.map;
    if (!restored) throw new Error('la démolition doit invalider la carte');
    for (let x = site.from.x; x <= site.to.x; x += 1) {
      const index = tileIndex(x, site.from.y, restored.width);
      expect(restored.kind[index]).toBe(map.kind[index]);
      expect(restored.owner[index]).toBe(map.owner[index]);
    }
  });

  it('refuse un pont diagonal sans modifier la carte ni la trésorerie', async () => {
    const engine = await createEngine(88);
    const map = mapOf(engine);
    const from = { x: 4, y: 4 };
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    engine.send({
      type: 'build',
      tool: 'bridge',
      company: 0,
      from,
      to: { x: from.x + 4, y: from.y + 4 },
      options: { kind: 'rail' },
    });
    const after = engine.snapshot();
    expect(after.map).toBeNull();
    expect(after.structures).toEqual([]);
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.news.some((item) => item.kind === 'error' && item.text.includes('droit'))).toBe(
      true,
    );
    expect(map.owner[tileIndex(from.x, from.y, map.width)]).toBe(255);
  });
});

describe('MockEngine : tunnels', () => {
  it('perce un tunnel, occupe les tuiles et publie une news', async () => {
    const engine = await createEngine(99);
    const map = mapOf(engine);
    const site = findTunnel(map);
    const plan = planTunnel({
      map,
      from: site.from,
      to: site.to,
      settings: { kind: 'rail' },
      budget: 10_000_000,
    });
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;

    engine.send({
      type: 'build',
      tool: 'tunnel',
      company: 0,
      from: site.from,
      to: site.to,
      options: { kind: 'rail' },
    });
    const after = engine.snapshot();
    const built = after.map;
    if (!built) throw new Error('le tunnel doit invalider la carte');
    for (const tile of plan.tiles) {
      expect((built.flags[tile.index] ?? 0) & TILE_FLAG.TUNNEL).toBe(TILE_FLAG.TUNNEL);
    }
    for (const end of [site.from, site.to]) {
      const index = tileIndex(end.x, end.y, built.width);
      expect(built.kind[index]).toBe(TILE_KIND_INDEX.tunnel);
      expect(built.owner[index]).toBe(0);
    }
    expect(after.structures?.[0]).toMatchObject({
      kind: 'tunnel',
      company: 0,
      transport: 'rail',
      length: plan.tiles.length,
    });
    expect((after.companies[0]?.money ?? 0) - moneyBefore).toBe(-plan.cost);
    expect(after.news.some((item) => item.text.includes('Tunnel ferroviaire construit'))).toBe(
      true,
    );

    engine.send({ type: 'build', tool: 'clear', company: 0, from: site.from, to: site.to });
    expect(engine.snapshot().structures).toEqual([]);
  });

  it('refuse un tunnel dont un portail est sur l’eau', async () => {
    const engine = await createEngine(101);
    const map = mapOf(engine);
    const moneyBefore = engine.snapshot().companies[0]?.money ?? 0;
    let water: BuildPoint | null = null;
    let second: BuildPoint | null = null;
    for (let y = 1; y < map.height - 1 && !water; y += 1) {
      for (let x = 1; x < map.width - 8 && !water; x += 1) {
        if (map.kind[tileIndex(x, y, map.width)] !== TILE_KIND_INDEX.water) continue;
        for (let span = 4; span <= 8; span += 1) {
          if (map.kind[tileIndex(x + span, y, map.width)] === TILE_KIND_INDEX.water) {
            water = { x, y };
            second = { x: x + span, y };
            break;
          }
        }
      }
    }
    if (!water || !second) throw new Error('deux tuiles d’eau alignées sont requises');
    engine.send({
      type: 'build',
      tool: 'tunnel',
      company: 0,
      from: water,
      to: second,
      options: { kind: 'rail' },
    });
    const after = engine.snapshot();
    expect(after.map).toBeNull();
    expect(after.structures).toEqual([]);
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.news.some((item) => item.kind === 'error' && item.text.includes('portail'))).toBe(
      true,
    );
  });
});

describe('MockEngine : déterminisme des ouvrages', () => {
  it('produit le même hash pour la même suite pont + tunnel', async () => {
    const run = async (): Promise<string> => {
      const engine = await createEngine(555);
      const map = mapOf(engine);
      const bridge = findBridge(map);
      engine.send({
        type: 'build',
        tool: 'bridge',
        company: 0,
        from: bridge.from,
        to: bridge.to,
        options: { kind: 'rail', material: 'steel' },
      });
      const afterBridge = engine.snapshot().map ?? map;
      const tunnel = findTunnel(afterBridge);
      engine.send({
        type: 'build',
        tool: 'tunnel',
        company: 0,
        from: tunnel.from,
        to: tunnel.to,
        options: { kind: 'rail' },
      });
      engine.step(74);
      engine.snapshot();
      return engine.hash();
    };
    expect(await run()).toBe(await run());
  });
});
