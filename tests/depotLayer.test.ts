import { describe, expect, it } from 'vitest';
import {
  COMPANY_NONE,
  TILE_KIND_INDEX,
  type DepotSnapshot,
  type MapSnapshot,
} from '../src/engine/protocol';
import { DepotLayer, depotYawForDirection } from '../src/render/DepotLayer';

function makeMap(width = 8, height = 8): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(3),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function depot(id: number, x: number, y: number, overrides: Partial<DepotSnapshot> = {}) {
  return {
    id,
    company: 0,
    kind: 'road' as const,
    x,
    y,
    direction: 0,
    width: 1,
    height: 1,
    ...overrides,
  };
}

describe('DepotLayer', () => {
  it('pose un auvent instancié par entrée de snapshot.depots', () => {
    const layer = new DepotLayer();
    layer.setDepots([depot(3, 3, 2), depot(9, 6, 5, { kind: 'rail' })], makeMap());
    expect(layer.count).toBe(2);
    expect(layer.ids).toEqual([3, 9]);
    expect(layer.group.visible).toBe(true);
    // Deux paires corps + livrée (route et rail) toujours présentes.
    expect(layer.group.children.length).toBe(4);
    expect(layer.drawCallCount).toBe(4);
    layer.dispose();
    expect(layer.count).toBe(0);
  });

  it('ignore les ids dupliqués (un seul auvent par dépôt)', () => {
    const layer = new DepotLayer();
    layer.setDepots([depot(2, 1, 1), depot(2, 1, 1), depot(4, 3, 3)], makeMap());
    expect(layer.ids).toEqual([2, 4]);
    layer.dispose();
  });

  it('oriente la porte vers l’entrée indiquée par le snapshot', () => {
    const layer = new DepotLayer();
    layer.setDepots(
      [
        depot(1, 1, 1, { direction: 0 }),
        depot(2, 2, 2, { direction: 1 }),
        depot(3, 3, 3, { direction: 2 }),
        depot(4, 4, 4, { direction: 3 }),
      ],
      makeMap(),
    );
    // La porte locale est en +Z : ne→est, se→sud, sw→ouest, nw→nord.
    expect(layer.rotations[0]).toBeCloseTo(Math.PI / 2);
    expect(layer.rotations[1]).toBeCloseTo(0);
    expect(layer.rotations[2]).toBeCloseTo((Math.PI * 3) / 2);
    expect(layer.rotations[3]).toBeCloseTo(Math.PI);
    layer.dispose();
  });

  it('aligne la normale de porte sur la voie adjacente', () => {
    const cases: [number, number, number][] = [
      [0, 1, 0],
      [1, 0, 1],
      [2, -1, 0],
      [3, 0, -1],
    ];
    for (const [direction, dx, dy] of cases) {
      const yaw = depotYawForDirection(direction);
      // +Z local tourne vers (sin(yaw), cos(yaw)) dans le plan monde (x, z).
      expect(Math.sin(yaw)).toBeCloseTo(dx, 6);
      expect(Math.cos(yaw)).toBeCloseTo(dy, 6);
    }
  });

  it('reste invisible sans dépôt et se vide quand la liste disparaît', () => {
    const layer = new DepotLayer();
    layer.setDepots([], makeMap());
    expect(layer.count).toBe(0);
    expect(layer.group.visible).toBe(false);
    layer.setDepots([depot(1, 1, 1)], makeMap());
    expect(layer.count).toBe(1);
    layer.setDepots([], makeMap());
    expect(layer.count).toBe(0);
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });
});
