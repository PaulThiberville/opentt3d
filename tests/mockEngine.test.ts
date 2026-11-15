import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import { COMPANY_NONE, PROTOCOL_VERSION, TILE_KIND_INDEX } from '../src/engine/protocol';

async function createEngine(seed = 1234, width = 192, height = 192): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width, height });
  return engine;
}

/** `step()` est plafonné par sécurité : on boucle pour simuler de longues durées. */
function stepAll(engine: MockEngine, ticks: number): number {
  let remaining = ticks;
  let executed = 0;
  while (remaining > 0) {
    const chunk = Math.min(200, remaining);
    const done = engine.step(chunk);
    executed += done;
    if (done === 0) break;
    remaining -= chunk;
  }
  return executed;
}

describe('MockEngine : génération', () => {
  it('produit un monde conforme au contrat', async () => {
    const engine = await createEngine();
    const snapshot = engine.snapshot();

    expect(snapshot.meta.protocol).toBe(PROTOCOL_VERSION);
    expect(snapshot.meta.sequence).toBe(1);
    expect(snapshot.meta.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(snapshot.map).not.toBeNull();
    const map = snapshot.map;
    if (!map) throw new Error('carte absente');
    expect(map.width).toBe(192);
    expect(map.height).toBe(192);
    for (const array of [map.kind, map.heightMap, map.owner, map.slope, map.flags, map.trackBits]) {
      expect(array).toBeInstanceOf(Uint8Array);
      expect(array).toHaveLength(192 * 192);
    }
    expect(snapshot.companies).toHaveLength(2);
    expect(snapshot.towns).toHaveLength(3);
    expect(snapshot.industries).toHaveLength(5);
    expect(snapshot.stations).toHaveLength(6);
    expect(snapshot.vehicles).toHaveLength(40);
    expect(snapshot.economy.paused).toBe(false);
    expect(snapshot.economy.dayFraction).toBe(0);
    expect(snapshot.news.length).toBeGreaterThan(0);
  });

  it('génère de l’eau, des côtes, des arbres et des voies', async () => {
    const engine = await createEngine(77);
    const map = engine.snapshot().map;
    if (!map) throw new Error('carte absente');
    const counts = new Map<number, number>();
    for (const kind of map.kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    expect(counts.get(TILE_KIND_INDEX.water) ?? 0).toBeGreaterThan(200);
    expect(counts.get(TILE_KIND_INDEX.coast) ?? 0).toBeGreaterThan(10);
    expect(counts.get(TILE_KIND_INDEX.trees) ?? 0).toBeGreaterThan(100);
    expect(counts.get(TILE_KIND_INDEX.rail) ?? 0).toBeGreaterThan(5);
    expect(counts.get(TILE_KIND_INDEX.road) ?? 0).toBeGreaterThan(5);
    expect(counts.get(TILE_KIND_INDEX.house) ?? 0).toBeGreaterThan(20);
    expect(counts.get(TILE_KIND_INDEX.industry) ?? 0).toBeGreaterThanOrEqual(30);
  });

  it('ne renvoie la carte complète qu’une fois puis en delta', async () => {
    const engine = await createEngine();
    expect(engine.snapshot().map).not.toBeNull();
    const second = engine.snapshot();
    expect(second.map).toBeNull();
    expect(second.meta.sequence).toBe(2);
  });

  it('reste déterministe pour une même graine', async () => {
    const a = await createEngine(2024);
    const b = await createEngine(2024);
    expect(a.hash()).toBe(b.hash());
    expect(stepAll(a, 300)).toBe(300);
    expect(stepAll(b, 300)).toBe(300);
    expect(a.hash()).toBe(b.hash());
    const snapA = a.snapshot();
    const snapB = b.snapshot();
    expect(snapA.vehicles.map((vehicle) => [vehicle.x, vehicle.y, vehicle.direction])).toEqual(
      snapB.vehicles.map((vehicle) => [vehicle.x, vehicle.y, vehicle.direction]),
    );
  });

  it('produit des mondes différents pour des graines différentes', async () => {
    const a = await createEngine(1);
    const b = await createEngine(2);
    const mapA = a.snapshot().map;
    const mapB = b.snapshot().map;
    if (!mapA || !mapB) throw new Error('cartes absentes');
    let differences = 0;
    for (let i = 0; i < mapA.heightMap.length; i += 97) {
      if (mapA.heightMap[i] !== mapB.heightMap[i]) differences += 1;
    }
    expect(differences).toBeGreaterThan(0);
  });
});

describe('MockEngine : simulation', () => {
  it('fait avancer les véhicules et la date', async () => {
    const engine = await createEngine();
    const before = engine.snapshot();
    stepAll(engine, 500);
    const after = engine.snapshot();
    expect(after.meta.tick).toBe(500);
    expect(after.economy.day).toBe(1 + Math.floor(500 / 74));
    const moved = after.vehicles.filter((vehicle, index) => {
      const previous = before.vehicles[index];
      return previous ? previous.x !== vehicle.x || previous.y !== vehicle.y : false;
    });
    expect(moved.length).toBeGreaterThan(30);
  });

  it('s’arrête quand la pause est active', async () => {
    const engine = await createEngine();
    engine.send({ type: 'pause', paused: true });
    expect(engine.step(60)).toBe(0);
    expect(engine.status().tick).toBe(0);
    engine.send({ type: 'pause', paused: false });
    expect(engine.step(60)).toBe(60);
    expect(engine.status().tick).toBe(60);
  });

  it('respecte la vitesse 0', async () => {
    const engine = await createEngine();
    engine.send({ type: 'speed', speed: 0 });
    expect(engine.step(10)).toBe(0);
    expect(engine.status().paused).toBe(true);
  });

  it('conserve l’état via save/load', async () => {
    const engine = await createEngine(555);
    stepAll(engine, 240);
    engine.snapshot();
    const hash = engine.hash();
    const saved = await engine.save();
    expect(saved).toBeInstanceOf(Uint8Array);
    expect(saved.length).toBeGreaterThan(1000);

    const restored = new MockEngine();
    await restored.load(saved);
    expect(restored.hash()).toBe(hash);
    expect(restored.status().tick).toBe(240);
    const snapshot = restored.snapshot();
    expect(snapshot.map).not.toBeNull();
    expect(snapshot.vehicles).toHaveLength(40);

    stepAll(engine, 120);
    stepAll(restored, 120);
    expect(restored.hash()).toBe(engine.hash());
  });

  it('rejette une sauvegarde corrompue', async () => {
    const engine = new MockEngine();
    await expect(engine.load(new TextEncoder().encode('{"nope":true}'))).rejects.toThrow();
  });

  it('expose des propriétaires valides', async () => {
    const engine = await createEngine();
    const snapshot = engine.snapshot();
    const map = snapshot.map;
    if (!map) throw new Error('carte absente');
    const owners = new Set(map.owner);
    expect(owners.has(COMPANY_NONE)).toBe(true);
    expect(owners.has(0)).toBe(true);
    expect(owners.has(1)).toBe(true);
    for (const station of snapshot.stations) {
      expect(station.company === 0 || station.company === 1).toBe(true);
    }
  });

  it('désalloue proprement', async () => {
    const engine = await createEngine();
    engine.dispose();
    expect(engine.isLoaded()).toBe(false);
    expect(engine.step(10)).toBe(0);
    expect(() => engine.snapshot()).toThrow();
  });
});
