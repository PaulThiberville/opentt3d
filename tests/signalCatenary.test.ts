import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { RAIL_TYPE_INDEX, TILE_FLAG, TILE_KIND_INDEX } from '../src/engine/protocol';
import { SignalLayer } from '../src/render/SignalLayer';
import { CatenaryLayer } from '../src/render/CatenaryLayer';
import { encodeSignalBits } from '../src/game/signalRules';

function makeMap(width = 16, height = 8): MapSnapshot {
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
    railTypes: new Uint8Array(size).fill(RAIL_TYPE_INDEX.rail),
    signalData: new Uint8Array(size),
  };
}

function layRail(map: MapSnapshot, y: number, fromX: number, toX: number): void {
  for (let x = fromX; x <= toX; x += 1) {
    map.kind[y * map.width + x] = TILE_KIND_INDEX.rail;
    map.trackBits[y * map.width + x] = 2 | 8;
  }
}

describe('SignalLayer (#156)', () => {
  it('affiche les signaux typés et conserve deux InstancedMesh', () => {
    const map = makeMap();
    layRail(map, 3, 2, 8);
    for (const x of [3, 5, 7]) {
      map.flags[3 * map.width + x] = TILE_FLAG.SIGNAL;
      map.signalData![3 * map.width + x] = encodeSignalBits({
        kind: x === 5 ? 'path' : 'block',
        direction: x === 5 ? 'both' : 'one-way',
        aspect: x === 7 ? 'red' : 'green',
        semaphore: false,
      });
    }
    const layer = new SignalLayer();
    layer.setSignals(
      [
        {
          x: 3,
          y: 3,
          kind: 'block',
          direction: 'one-way',
          aspect: 'green',
          semaphore: false,
        },
        {
          x: 5,
          y: 3,
          kind: 'path',
          direction: 'both',
          aspect: 'yellow',
          semaphore: false,
        },
        {
          x: 7,
          y: 3,
          kind: 'combo',
          direction: 'both',
          aspect: 'red',
          semaphore: true,
        },
      ],
      map,
    );
    try {
      expect(layer.count).toBe(3);
      expect(layer.group.visible).toBe(true);
      expect(layer.group.children).toHaveLength(2);
      expect(
        layer.group.children.every((child) => (child as THREE.InstancedMesh).isInstancedMesh),
      ).toBe(true);
      const lights = layer.group.children[1] as THREE.InstancedMesh;
      expect(lights.count).toBe(3);
      expect(lights.instanceColor).not.toBeNull();
      const poles = layer.group.children[0] as THREE.InstancedMesh;
      expect(poles.instanceColor).not.toBeNull();
      // Le path est plus haut que le bloc.
      const matrices = poles.instanceMatrix.array;
      expect(matrices.length).toBeGreaterThan(0);
    } finally {
      layer.dispose();
    }
  });

  it('retombe sur les drapeaux de la carte et alterne au rythme du jour', () => {
    const map = makeMap();
    layRail(map, 2, 1, 4);
    for (const x of [1, 2, 3, 4]) map.flags[2 * map.width + x] = TILE_FLAG.SIGNAL;
    const layer = new SignalLayer();
    layer.setMap(map);
    try {
      expect(layer.count).toBe(4);
      const lights = layer.group.children[1] as THREE.InstancedMesh;
      const before = Array.from(lights.instanceColor?.array ?? []);
      layer.update(74);
      const after = Array.from(lights.instanceColor?.array ?? []);
      expect(after).not.toEqual(before);
    } finally {
      layer.dispose();
    }
  });
});

describe('CatenaryLayer (#157)', () => {
  it('pose poteaux et câbles uniquement sur les voies électrifiées', () => {
    const map = makeMap();
    layRail(map, 2, 1, 6);
    layRail(map, 5, 1, 6);
    for (let x = 1; x <= 6; x += 1) {
      map.railTypes![2 * map.width + x] = RAIL_TYPE_INDEX.electrified;
      map.flags[2 * map.width + x] = TILE_FLAG.ELECTRIFIED;
    }
    const layer = new CatenaryLayer();
    layer.setMap(map);
    try {
      expect(layer.countPosts).toBeGreaterThanOrEqual(12);
      expect(layer.countWires).toBeGreaterThanOrEqual(10);
      expect(layer.group.visible).toBe(true);
      expect(layer.group.children).toHaveLength(2);
      expect(
        layer.group.children.every((child) => (child as THREE.InstancedMesh).isInstancedMesh),
      ).toBe(true);
      expect(layer.drawCallCount).toBe(2);
    } finally {
      layer.dispose();
    }
  });

  it('reste invisible sans voie électrifiée et ignore monorail/maglev', () => {
    const map = makeMap();
    layRail(map, 2, 1, 8);
    for (let x = 1; x <= 8; x += 1) {
      map.railTypes![2 * map.width + x] = RAIL_TYPE_INDEX.monorail;
      map.flags[2 * map.width + x] = TILE_FLAG.ELECTRIFIED;
    }
    const layer = new CatenaryLayer();
    layer.setMap(map);
    try {
      expect(layer.countPosts).toBe(0);
      expect(layer.countWires).toBe(0);
      expect(layer.group.visible).toBe(false);
    } finally {
      layer.dispose();
    }
  });
});
