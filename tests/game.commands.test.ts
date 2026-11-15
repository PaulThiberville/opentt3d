import { beforeEach, describe, expect, it } from 'vitest';
import { Game } from '../src/game/Game';
import { MockEngine } from '../src/engine/MockEngine';
import { TILE_KIND_INDEX, type EngineCommand, type MapSnapshot } from '../src/engine/protocol';
import { planBuild } from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';
import { DEPOT_TRACK_BIT, buyVehicleCommand, orderVehicleCommand } from '../src/game/vehicleRules';

async function setup(sink?: (command: EngineCommand) => void): Promise<{
  game: Game;
  engine: MockEngine;
}> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed: 4242, width: 128, height: 128 });
  const game = new Game({ driver: engine, clock: () => 0, ...(sink ? { commandSink: sink } : {}) });
  game.start();
  return { game, engine };
}

function firstRoadPair(map: MapSnapshot): {
  from: { x: number; y: number };
  to: { x: number; y: number };
} {
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 4; x += 1) {
      const from = { x, y };
      const to = { x: x + 2, y };
      if (planBuild({ map, tool: 'road', from, to }).valid) return { from, to };
    }
  }
  throw new Error('aucune tuile constructible');
}

describe('Game.issueCommand', () => {
  let game: Game;
  let engine: MockEngine;

  beforeEach(async () => {
    ({ game, engine } = await setup());
  });

  it('envoie la commande au moteur en solo et force le snapshot', () => {
    const map = game.getLatestSnapshot()?.map;
    if (!map) throw new Error('carte attendue');
    const { from, to } = firstRoadPair(map);
    const commands: EngineCommand[] = [];
    const snapshots: number[] = [];
    game.events.on('command', ({ command }) => commands.push(command));
    game.events.on('snapshot', ({ snapshot }) => snapshots.push(snapshot.meta.sequence));

    game.issueCommand({
      type: 'build',
      tool: 'road',
      company: 0,
      from,
      to,
      options: { axis: 'x' },
    });
    game.refresh();

    expect(commands).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    const after = game.getLatestSnapshot();
    if (!after?.map) throw new Error('le snapshot doit contenir la carte modifiée');
    expect(after.map.kind[tileIndex(from.x, from.y, after.map.width)]).toBe(TILE_KIND_INDEX.road);
  });

  it('confie la commande au sink réseau au lieu du moteur', () => {
    const map = game.getLatestSnapshot()?.map;
    if (!map) throw new Error('carte attendue');
    const { from, to } = firstRoadPair(map);
    const before = engine.hash();
    const received: EngineCommand[] = [];
    const networked = new Game({
      driver: engine,
      clock: () => 0,
      commandSink: (command) => received.push(command),
    });
    networked.issueCommand({ type: 'build', tool: 'road', company: 0, from, to });
    expect(received).toHaveLength(1);
    expect(engine.hash()).toBe(before);
    networked.dispose();
  });

  it('achemine une commande véhicule par le sink réseau', () => {
    const map = game.getLatestSnapshot()?.map;
    if (!map) throw new Error('carte attendue');
    let depot: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !depot; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const index = tileIndex(x, y, map.width);
        if (((map.trackBits[index] ?? 0) & DEPOT_TRACK_BIT) !== 0) {
          depot = { x, y };
          break;
        }
      }
    }
    if (!depot) throw new Error('dépôt de démonstration attendu');
    const received: EngineCommand[] = [];
    const networked = new Game({
      driver: engine,
      clock: () => 0,
      commandSink: (command) => received.push(command),
    });
    const before = engine.hash();
    networked.issueCommand(buyVehicleCommand(0, depot, 'bus_city'));
    networked.issueCommand(orderVehicleCommand(0, 4, [{ target: 0, kind: 'station' }]));
    expect(received).toEqual([
      {
        type: 'vehicle',
        action: 'buy',
        company: 0,
        depot,
        model: 'bus_city',
      },
      {
        type: 'vehicle',
        action: 'order',
        company: 0,
        vehicle: 4,
        orders: [{ target: 0, kind: 'station' }],
      },
    ]);
    expect(engine.hash()).toBe(before);
    networked.dispose();
  });

  it('ignore les commandes après dispose', async () => {
    const received: EngineCommand[] = [];
    const local = await setup((command) => received.push(command));
    local.game.dispose();
    local.game.issueCommand({ type: 'build', tool: 'road', company: 0, from: { x: 1, y: 1 } });
    expect(received).toHaveLength(0);
  });
});
