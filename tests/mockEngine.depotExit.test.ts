import { describe, expect, it } from 'vitest';
import { MockEngine, depotDirection } from '../src/engine/MockEngine';
import { TILE_KIND_INDEX, type DepotSnapshot, type MapSnapshot } from '../src/engine/protocol';
import {
  directionFromIndex,
  directionOffset,
  directionToIndex,
  type BuildDirection,
} from '../src/game/buildRules';
import { tileIndex } from '../src/game/mapGrid';
import { depotOrder, orderVehicleCommand } from '../src/game/vehicleRules';

async function createEngine(): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed: 2024, width: 128, height: 128 });
  return engine;
}

function run(engine: MockEngine, ticks: number): void {
  let remaining = ticks;
  while (remaining > 0) {
    const executed = engine.step(Math.min(240, remaining));
    if (executed <= 0) break;
    remaining -= executed;
  }
}

/** Zone plate constructible, loin des villes, pour un petit croisement routier. */
function findFlat(map: MapSnapshot, width: number, height: number): { x: number; y: number } {
  const natural = new Set([
    TILE_KIND_INDEX.grass,
    TILE_KIND_INDEX.clear,
    TILE_KIND_INDEX.rough,
    TILE_KIND_INDEX.trees,
  ]);
  for (const [w, h] of [
    [width, height],
    [12, 10],
    [10, 8],
    [8, 6],
  ] as const) {
    for (let y = 4; y + h < map.height - 4; y += 1) {
      for (let x = 4; x + w < map.width - 4; x += 1) {
        const base = map.heightMap[tileIndex(x, y, map.width)] ?? 0;
        let ok = true;
        for (let dy = 0; dy < h && ok; dy += 1) {
          for (let dx = 0; dx < w; dx += 1) {
            const index = tileIndex(x + dx, y + dy, map.width);
            if (!natural.has(map.kind[index] ?? 0) || map.heightMap[index] !== base) {
              ok = false;
              break;
            }
          }
        }
        if (ok) return { x, y };
      }
    }
  }
  throw new Error('aucune zone plate constructible');
}

interface DepotCase {
  direction: BuildDirection;
  dx: number;
  dy: number;
}

const CASES: DepotCase[] = [
  { direction: 'ne', dx: -1, dy: -2 },
  { direction: 'se', dx: -2, dy: -1 },
  { direction: 'sw', dx: 1, dy: -2 },
  { direction: 'nw', dx: -2, dy: 1 },
];

async function buildCrossing(
  testCase: DepotCase,
): Promise<{ engine: MockEngine; depot: DepotSnapshot; stationId: number }> {
  const engine = await createEngine();
  const map = engine.snapshot().map;
  if (!map) throw new Error('carte attendue');
  const site = findFlat(map, 20, 14);
  const cx = site.x + 6;
  const cy = site.y + 5;

  engine.send({
    type: 'build',
    tool: 'road',
    company: 0,
    from: { x: cx - 5, y: cy },
    to: { x: cx + 5, y: cy },
    options: { axis: 'x' },
  });
  // Deux moitiés pour ne pas reconstruire la tuile du croisement.
  engine.send({
    type: 'build',
    tool: 'road',
    company: 0,
    from: { x: cx, y: cy - 4 },
    to: { x: cx, y: cy - 1 },
    options: { axis: 'y' },
  });
  engine.send({
    type: 'build',
    tool: 'road',
    company: 0,
    from: { x: cx, y: cy + 1 },
    to: { x: cx, y: cy + 4 },
    options: { axis: 'y' },
  });
  const stationTile = { x: cx + 4, y: cy - 1 };
  engine.send({
    type: 'build',
    tool: 'station',
    company: 0,
    from: stationTile,
    options: { kind: 'road', direction: 'ne' },
  });
  const depotTile = { x: cx + testCase.dx, y: cy + testCase.dy };
  engine.send({
    type: 'build',
    tool: 'depot',
    company: 0,
    from: depotTile,
    options: { kind: 'road' },
  });

  const snapshot = engine.snapshot();
  const depot = snapshot.depots.find((item) => item.x === depotTile.x && item.y === depotTile.y);
  const station = snapshot.stations.find(
    (item) => item.x === stationTile.x + 0.5 && item.y === stationTile.y + 0.5,
  );
  if (!depot) throw new Error(`dépôt ${testCase.direction} non construit`);
  if (!station) throw new Error('gare non construite');
  return { engine, depot, stationId: station.id };
}

async function buyAndStart(
  engine: MockEngine,
  depot: DepotSnapshot,
  stationId: number,
): Promise<number> {
  engine.send({
    type: 'vehicle',
    action: 'buy',
    company: 0,
    depotId: depot.id,
    model: 'bus_city',
  });
  const snapshot = engine.snapshot();
  const bus = snapshot.vehicles[snapshot.vehicles.length - 1];
  if (!bus) throw new Error('bus acheté attendu');
  engine.send(orderVehicleCommand(0, bus.id, [stationOrderById(stationId), depotOrder(depot)]));
  engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bus.id });
  return bus.id;
}

/** `stationOrder` exige l’objet gare ; ce raccourci évite de le conserver. */
function stationOrderById(id: number) {
  return { target: id, kind: 'station' as const };
}

interface SavedWorld {
  world: { vehicles: { id: number; path: { x: number; y: number }[]; status: number }[] };
}

async function savedVehiclePath(
  engine: MockEngine,
  vehicleId: number,
): Promise<{ x: number; y: number }[]> {
  const saved = JSON.parse(new TextDecoder().decode(await engine.save())) as SavedWorld;
  const vehicle = saved.world.vehicles.find((item) => item.id === vehicleId);
  return vehicle?.path ?? [];
}

describe('MockEngine : sortie de dépôt (#233)', () => {
  it('oriente chaque dépôt construit vers sa route adjacente', async () => {
    for (const testCase of CASES) {
      const { depot } = await buildCrossing(testCase);
      expect(depot.direction).toBe(directionToIndex(testCase.direction));
    }
  });

  it('sort par la porte dans les quatre orientations, sans boucle dans le dépôt', async () => {
    for (const testCase of CASES) {
      const { engine, depot, stationId } = await buildCrossing(testCase);
      const busId = await buyAndStart(engine, depot, stationId);
      const offset = directionOffset(testCase.direction);
      const depotCentre = { x: depot.x + 0.5, y: depot.y + 0.5 };
      const doorCentre = {
        x: depot.x + offset.dx + 0.5,
        y: depot.y + offset.dy + 0.5,
      };

      const path = await savedVehiclePath(engine, busId);
      expect(path[0]).toEqual(depotCentre);
      // Le premier déplacement quitte le dépôt par la porte, pas par un mur.
      expect(path[1]).toEqual(doorCentre);
      // Le retour se fait aussi par la porte, puis rentre dans le dépôt.
      expect(path[path.length - 1]).toEqual(depotCentre);
      expect(path[path.length - 2]).toEqual(doorCentre);
      // Aucune boucle sur place : le dépôt n’apparaît qu’au départ et à
      // l’arrivée, jamais au milieu du tracé.
      const depotStops = path
        .map((point, index) => ({ point, index }))
        .filter(({ point }) => point.x === depotCentre.x && point.y === depotCentre.y)
        .map(({ index }) => index);
      expect(depotStops).toEqual([0, path.length - 1]);

      // Le véhicule ne déclenche pas une arrivée au dépôt en franchissant sa
      // porte : l'ancien rayon d'arrêt englobait les tuiles voisines.
      run(engine, 24);
      const early = engine.snapshot();
      expect(
        early.events.some(
          (event) =>
            event.type === 'vehicle_arrived' &&
            event.vehicle === busId &&
            event.station === depot.id,
        ),
      ).toBe(false);
      expect(early.vehicles.find((item) => item.id === busId)?.status).not.toBe(2);

      // Il rejoint ensuite réellement la gare, donc la sortie est praticable.
      let arrived = false;
      for (let step = 0; step < 30 && !arrived; step += 1) {
        run(engine, 240);
        const snapshot = engine.snapshot();
        arrived = snapshot.events.some(
          (event) =>
            event.type === 'vehicle_arrived' &&
            event.vehicle === busId &&
            event.station === stationId,
        );
        const vehicle = snapshot.vehicles.find((item) => item.id === busId);
        expect(vehicle).toBeDefined();
      }
      expect(arrived, `gare atteinte depuis un dépôt ${testCase.direction}`).toBe(true);

      // Et il revient au dépôt par sa porte, seulement après la gare.
      let depotArrived = false;
      for (let step = 0; step < 30 && !depotArrived; step += 1) {
        run(engine, 240);
        const snapshot = engine.snapshot();
        depotArrived = snapshot.events.some(
          (event) =>
            event.type === 'vehicle_arrived' &&
            event.vehicle === busId &&
            event.station === depot.id,
        );
      }
      expect(depotArrived, `retour au dépôt ${testCase.direction}`).toBe(true);
    }
  });

  it('refuse de démarrer un dépôt dont la porte ne donne sur aucune voie', async () => {
    const engine = await createEngine();
    const map = engine.snapshot().map;
    if (!map) throw new Error('carte attendue');
    const site = findFlat(map, 8, 6);
    const tile = { x: site.x + 3, y: site.y + 3 };
    engine.send({
      type: 'build',
      tool: 'depot',
      company: 0,
      from: tile,
      options: { kind: 'road', direction: 'ne' },
    });
    const built = engine.snapshot();
    const depot = built.depots.find((item) => item.x === tile.x && item.y === tile.y);
    if (!depot) throw new Error('dépôt isolé attendu');
    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'bus_city',
    });
    const bought = engine.snapshot();
    const bus = bought.vehicles[bought.vehicles.length - 1];
    if (!bus) throw new Error('bus attendu');
    engine.send(
      orderVehicleCommand(0, bus.id, [
        stationOrderById(bought.stations.find((item) => item.kind === 'road')?.id ?? 0),
        depotOrder(depot),
      ]),
    );
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bus.id });
    const after = engine.snapshot();
    expect(
      after.news.some((item) => item.text.includes('aucune voie praticable devant l’entrée')),
    ).toBe(true);
    expect(after.vehicles.find((item) => item.id === bus.id)?.status).toBe(3);
  });

  it('raccorde les dépôts de démonstration par leur porte', async () => {
    const engine = await createEngine();
    const snapshot = engine.snapshot();
    const map = snapshot.map;
    if (!map) throw new Error('carte attendue');
    for (const depot of snapshot.depots) {
      const offset = directionOffset(directionFromIndex(depot.direction));
      const kind = map.kind[tileIndex(depot.x + offset.dx, depot.y + offset.dy, map.width)];
      expect(
        kind,
        `dépôt ${depot.id} (${depot.kind}) orienté ${directionFromIndex(depot.direction)}`,
      ).toBe(depot.kind === 'rail' ? TILE_KIND_INDEX.rail : TILE_KIND_INDEX.road);
    }
  });
});

describe('MockEngine : rotation et itinéraires de dépôt (#247)', () => {
  /** Plus grande zone plate constructible, avec ses dimensions réelles. */
  function findFlatArea(
    map: MapSnapshot,
    maxWidth: number,
    maxHeight: number,
  ): { x: number; y: number; width: number; height: number } {
    const natural = new Set([
      TILE_KIND_INDEX.grass,
      TILE_KIND_INDEX.clear,
      TILE_KIND_INDEX.rough,
      TILE_KIND_INDEX.trees,
    ]);
    for (const [width, height] of [
      [maxWidth, maxHeight],
      [12, 10],
      [10, 8],
      [8, 6],
    ] as const) {
      for (let y = 4; y + height < map.height - 4; y += 1) {
        for (let x = 4; x + width < map.width - 4; x += 1) {
          const base = map.heightMap[tileIndex(x, y, map.width)] ?? 0;
          let ok = true;
          for (let dy = 0; dy < height && ok; dy += 1) {
            for (let dx = 0; dx < width; dx += 1) {
              const index = tileIndex(x + dx, y + dy, map.width);
              if (!natural.has(map.kind[index] ?? 0) || map.heightMap[index] !== base) {
                ok = false;
                break;
              }
            }
          }
          if (ok) return { x, y, width, height };
        }
      }
    }
    throw new Error('aucune zone plate constructible');
  }

  it('oriente chaque bus garé vers sa porte, dans les quatre orientations', async () => {
    for (const testCase of CASES) {
      const { engine, depot } = await buildCrossing(testCase);
      engine.send({
        type: 'vehicle',
        action: 'buy',
        company: 0,
        depotId: depot.id,
        model: 'bus_city',
      });
      const bus = engine.snapshot().vehicles.find((item) => item.status === 3);
      if (!bus) throw new Error('bus au dépôt attendu');
      const offset = directionOffset(testCase.direction);
      const expected = Math.round((Math.atan2(offset.dx, -offset.dy) / (Math.PI * 2)) * 256) & 255;
      expect(bus.direction, `bus garé ${testCase.direction}`).toBe(expected);
      expect(bus.direction).toBe(depotDirection(depot.direction));
      expect(bus.direction % 64).toBe(0);
    }
  });

  it('ne traverse pas le dépôt et n’y arrive pas en sortant (#247)', async () => {
    const engine = await createEngine();
    const map = engine.snapshot().map;
    if (!map) throw new Error('carte attendue');
    const site = findFlatArea(map, 20, 14);
    const cx = site.x + Math.floor(site.width / 2);
    const cy = site.y + Math.floor(site.height / 2);
    const build = (command: Parameters<MockEngine['send']>[0]): void => engine.send(command);
    const road = (x: number, y: number): void =>
      build({
        type: 'build',
        tool: 'road',
        company: 0,
        from: { x, y },
        to: { x, y },
        options: { axis: 'x' },
      });

    // Deux tronçons devant/derrière le dépôt et un contournement au sud : sans
    // interdir la traversée du bâtiment, A* coupait par le dépôt (plus court)
    // et déclenchait une arrivée fantôme juste après la porte.
    for (let i = 1; i <= 3; i += 1) {
      road(cx + i, cy);
      road(cx - i, cy);
    }
    for (let i = -3; i <= 3; i += 1) road(cx + i, cy + 1);
    build({
      type: 'build',
      tool: 'depot',
      company: 0,
      from: { x: cx, y: cy },
      options: { kind: 'road', direction: 'ne' },
    });
    const stationTile = { x: cx - 2, y: cy - 1 };
    build({
      type: 'build',
      tool: 'station',
      company: 0,
      from: stationTile,
      options: { kind: 'road', direction: 'ne' },
    });

    const snapshot = engine.snapshot();
    const depot = snapshot.depots.find((item) => item.x === cx && item.y === cy);
    const station = snapshot.stations.find(
      (item) => item.kind === 'road' && Math.floor(item.x) === stationTile.x,
    );
    if (!depot) throw new Error('dépôt attendu');
    if (!station) throw new Error('gare attendue');

    engine.send({
      type: 'vehicle',
      action: 'buy',
      company: 0,
      depotId: depot.id,
      model: 'bus_city',
    });
    const bus = engine.snapshot().vehicles.find((item) => item.status === 3);
    if (!bus) throw new Error('bus attendu');
    engine.send(orderVehicleCommand(0, bus.id, [stationOrderById(station.id), depotOrder(depot)]));
    engine.send({ type: 'vehicle', action: 'start', company: 0, vehicle: bus.id });

    const centre = { x: cx + 0.5, y: cy + 0.5 };
    const path = await savedVehiclePath(engine, bus.id);
    expect(path[0]).toEqual(centre);
    expect(path[path.length - 1]).toEqual(centre);
    const interiorDepotTiles = path
      .slice(1, -1)
      .filter((point) => Math.floor(point.x) === cx && Math.floor(point.y) === cy);
    expect(interiorDepotTiles).toEqual([]);

    const arrivals: number[] = [];
    let arrivedAtDepot = false;
    for (let step = 0; step < 240 && !arrivedAtDepot; step += 1) {
      run(engine, 10);
      const current = engine.snapshot();
      for (const event of current.events) {
        if (event.type !== 'vehicle_arrived' || event.vehicle !== bus.id) continue;
        if (event.station === undefined) continue;
        if (arrivals[arrivals.length - 1] === event.station) continue;
        arrivals.push(event.station);
        if (event.station === depot.id) arrivedAtDepot = true;
      }
    }
    expect(arrivedAtDepot).toBe(true);
    // Une seule arrivée à la gare, puis une seule au dépôt : l'ordre courant
    // suit la tournée au lieu de boucler sur la porte.
    expect(arrivals).toEqual([station.id, depot.id]);

    const parked = engine.snapshot().vehicles.find((item) => item.id === bus.id);
    expect(parked?.status).toBe(2);
    expect(parked?.direction).toBe(depotDirection(depot.direction));
  });

  it('sort d’un dépôt dont la porte donne sur une route à sens unique', async () => {
    const engine = await createEngine();
    const map = engine.snapshot().map;
    if (!map) throw new Error('carte attendue');
    const site = findFlatArea(map, 20, 14);
    const cx = site.x + 3;
    const cy = site.y + 3;
    const build = (command: Parameters<MockEngine['send']>[0]): void => engine.send(command);
    const road = (x: number, y: number): void =>
      build({
        type: 'build',
        tool: 'road',
        company: 0,
        from: { x, y },
        to: { x, y },
        options: { axis: 'x' },
      });

    // Boucle : les quatre coins restent à double sens, les côtés sont à sens
    // unique. Le dépôt ouvre sur le côté nord, dans le sens de circulation.
    for (let x = cx - 3; x <= cx + 3; x += 1) {
      road(x, cy - 2);
      road(x, cy + 2);
    }
    for (let y = cy - 1; y <= cy + 1; y += 1) {
      road(cx - 3, y);
      road(cx + 3, y);
    }
    const oneWay = (x: number, y: number, axis: 'x' | 'y', direction: string): void =>
      build({
        type: 'build',
        tool: 'road',
        company: 0,
        from: { x, y },
        to: { x, y },
        options: { axis, one_way: direction },
      });
    for (let x = cx - 2; x <= cx + 2; x += 1) {
      oneWay(x, cy - 2, 'x', 'east');
      oneWay(x, cy + 2, 'x', 'west');
    }
    for (let y = cy - 1; y <= cy + 1; y += 1) {
      oneWay(cx - 3, y, 'y', 'north');
      oneWay(cx + 3, y, 'y', 'south');
    }

    const depotTile = { x: cx, y: cy - 3 };
    build({ type: 'build', tool: 'depot', company: 0, from: depotTile, options: { kind: 'road' } });
    const stationTile = { x: cx - 3, y: cy - 3 };
    build({
      type: 'build',
      tool: 'station',
      company: 0,
      from: stationTile,
      options: { kind: 'road', direction: 'ne' },
    });

    const snapshot = engine.snapshot();
    const depot = snapshot.depots.find((item) => item.x === depotTile.x && item.y === depotTile.y);
    const station = snapshot.stations.find(
      (item) =>
        item.kind === 'road' &&
        Math.floor(item.x) === stationTile.x &&
        Math.floor(item.y) === stationTile.y,
    );
    if (!depot) throw new Error('dépôt attendu');
    if (!station) throw new Error('gare attendue');
    expect(depot.direction).toBe(directionToIndex('se'));

    const busId = await buyAndStart(engine, depot, station.id);
    const path = await savedVehiclePath(engine, busId);
    expect(path[0]).toEqual({ x: cx + 0.5, y: cy - 2.5 });
    expect(path[1]).toEqual({ x: cx + 0.5, y: cy - 1.5 });
    // La sortie emprunte le sens unique vers l'est, pas à contresens.
    expect(path[2]).toEqual({ x: cx + 1.5, y: cy - 1.5 });

    let arrived = false;
    for (let step = 0; step < 120 && !arrived; step += 1) {
      run(engine, 120);
      arrived = engine
        .snapshot()
        .events.some(
          (event) =>
            event.type === 'vehicle_arrived' &&
            event.vehicle === busId &&
            event.station === station.id,
        );
    }
    expect(arrived).toBe(true);
  });
});
