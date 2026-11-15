/**
 * Round-trip réel : `MockEngine.save()` → métadonnées de slot → IndexedDB
 * (backend mémoire) → `load()` → hash, tick et snapshot identiques.
 *
 * Note : le mock lisse l'orientation des véhicules de 12 unités par tick. Une
 * sauvegarde prise juste après un changement de segment peut donc rejouer un
 * cap transitoire au chargement ; le test dédié vérifie que l'état reconverge.
 * Le moteur WASM, lui, restaure l'état complet sans ce lissage.
 */

import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/engine/MockEngine';
import { MemorySaveBackend, SaveStore } from '../src/ui/saveStore';

const MAP_SIZE = 192;
const SEED = 555;

async function createEngine(seed = SEED, size = MAP_SIZE): Promise<MockEngine> {
  const engine = new MockEngine();
  await engine.init({ moduleUrl: 'mock://engine' });
  await engine.newGame({ seed, width: size, height: size });
  return engine;
}

/** `step()` plafonne à 240 ticks : on découpe comme les tests moteur. */
function stepAll(engine: MockEngine, ticks: number): void {
  let remaining = ticks;
  while (remaining > 0) {
    const chunk = Math.min(200, remaining);
    engine.step(chunk);
    remaining -= chunk;
  }
}

describe('sauvegarde et chargement locaux', () => {
  it('restaure exactement l’état du MockEngine (hash, tick, snapshot)', async () => {
    const source = await createEngine();
    stepAll(source, 240);
    const before = source.snapshot();
    const hashBefore = source.hash();
    const tickBefore = before.meta.tick;
    const vehiclesBefore = before.vehicles.length;
    const moneyBefore = before.companies[0]?.money;

    const bytes = await source.save();
    const store = new SaveStore(new MemorySaveBackend(), { now: () => 1_700_000_000_000 });
    const slot = await store.save({
      name: 'Round-trip',
      bytes,
      engine: 'mock',
      seed: SEED,
      mapSize: MAP_SIZE,
      gameDate: {
        year: before.economy.year,
        month: before.economy.month,
        day: before.economy.day,
      },
      companies: before.companies.map((company) => company.name),
      tick: tickBefore,
      protocol: before.meta.protocol,
    });

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('Round-trip');
    expect(listed[0]?.size).toBe(bytes.length);
    expect(listed[0]?.companies.length).toBe(before.companies.length);
    expect(listed[0]?.mapSize).toBe(MAP_SIZE);
    expect(listed[0]?.seed).toBe(SEED);

    const record = await store.get(slot.id);
    if (!record) throw new Error('sauvegarde absente du store');

    const restored = new MockEngine();
    await restored.load(record.bytes);

    expect(restored.hash()).toBe(hashBefore);
    expect(restored.status().tick).toBe(tickBefore);
    const after = restored.snapshot();
    expect(after.meta.tick).toBe(before.meta.tick);
    expect(after.vehicles).toHaveLength(vehiclesBefore);
    expect(after.companies[0]?.money).toBe(moneyBefore);
    expect(after.economy).toEqual(before.economy);
    expect(after.map?.width).toBe(MAP_SIZE);
  });

  it('conserve la continuité après reprise (mêmes ticks suivants)', async () => {
    const source = await createEngine();
    stepAll(source, 240);
    const saved = await source.save();
    const hashBefore = source.hash();

    const restored = new MockEngine();
    await restored.load(saved);
    expect(restored.hash()).toBe(hashBefore);

    stepAll(source, 60);
    stepAll(restored, 60);
    expect(restored.hash()).toBe(source.hash());
    expect(restored.snapshot().meta.tick).toBe(source.snapshot().meta.tick);
  });

  it('documente le cap transitoire du mock et sa reconvergence', async () => {
    // Une sauvegarde au milieu d'un virage peut restaurer un cap lissé
    // différemment ; l'état converge en quelques ticks, sans perte de données.
    const source = await createEngine(2026, 128);
    source.step(240);
    const saved = await source.save();
    const restored = new MockEngine();
    await restored.load(saved);
    const tick = source.status().tick;
    expect(restored.status().tick).toBe(tick);

    for (let index = 0; index < 8; index += 1) {
      source.step(1);
      restored.step(1);
    }
    expect(restored.hash()).toBe(source.hash());
  });

  it('charge une sauvegarde antérieure aux ordres enrichis', async () => {
    const source = await createEngine(4040, 128);
    source.step(240);
    const raw = JSON.parse(new TextDecoder().decode(await source.save())) as {
      world: {
        vehicles: Record<string, unknown>[];
      };
    };
    // Champs ajoutés par #160/#161 : absents des sauvegardes v1.5.
    for (const vehicle of raw.world.vehicles) {
      delete vehicle.segmentOrders;
      delete vehicle.currentOrder;
      delete vehicle.routeOrders;
      delete vehicle.model;
    }
    const restored = new MockEngine();
    await restored.load(new TextEncoder().encode(JSON.stringify(raw)));
    const snapshot = restored.snapshot();
    expect(snapshot.vehicles.length).toBeGreaterThan(0);
    for (const vehicle of snapshot.vehicles) {
      expect(vehicle.currentOrder ?? 0).toBeGreaterThanOrEqual(0);
    }
    restored.step(48);
    expect(restored.status().tick).toBeGreaterThan(0);
  });

  it('refuse un conteneur incompatible sans modifier le moteur', async () => {
    const source = await createEngine(5);
    source.step(30);
    const hash = source.hash();
    const restored = new MockEngine();
    await restored.load(await source.save());
    await expect(restored.load(new TextEncoder().encode('{"v":99}'))).rejects.toThrow();
    expect(restored.hash()).toBe(hash);
  });
});
