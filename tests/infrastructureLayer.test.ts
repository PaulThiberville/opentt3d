import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { InfrastructureLayer } from '../src/render/InfrastructureLayer';
import {
  COMPANY_NONE,
  TILE_KIND_INDEX,
  TRACK_BIT_CROSSING_RAIL,
  type MapSnapshot,
} from '../src/engine/protocol';

function makeMap(width = 8, height = 8): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function setTile(map: MapSnapshot, x: number, y: number, kind: number, bits = 0): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  map.trackBits[index] = bits;
}

describe('InfrastructureLayer : ouvrages #158/#159', () => {
  it('rend les écluses, aqueducs et passages à niveau sans nouvel asset', () => {
    const map = makeMap();
    setTile(map, 1, 1, TILE_KIND_INDEX.lock, 2 | 8);
    setTile(map, 2, 3, TILE_KIND_INDEX.aqueduct, 4);
    setTile(map, 3, 3, TILE_KIND_INDEX.aqueduct, 4);
    setTile(map, 4, 3, TILE_KIND_INDEX.aqueduct, 4);
    setTile(map, 5, 5, TILE_KIND_INDEX.crossing, 2 | 8 | TRACK_BIT_CROSSING_RAIL);

    const layer = new InfrastructureLayer();
    layer.setMap(map);
    expect(layer.lockCount).toBe(1);
    expect(layer.aqueductCount).toBe(3);
    expect(layer.crossingCount).toBe(1);
    expect(layer.group.children).toHaveLength(2);
    const structures = layer.group.children[0];
    const lights = layer.group.children[1];
    expect(structures?.name).toBe('infrastructure-structures');
    expect(lights?.name).toBe('infrastructure-lights');
    const positions = (structures as THREE.Mesh).geometry.getAttribute('position');
    expect(positions.count).toBeGreaterThan(300);
    layer.dispose();
  });

  it('met les feux en veille le jour et les intensifie la nuit', () => {
    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.lock, 2 | 8);
    const layer = new InfrastructureLayer();
    layer.setMap(map);
    layer.setNight(0);
    const material = (layer.group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const day = material.color.getHex();
    layer.setNight(1);
    const night = material.color.getHex();
    expect(day).not.toBe(night);
    layer.dispose();
  });

  it('reste vide sur une carte sans ouvrage', () => {
    const layer = new InfrastructureLayer();
    layer.setMap(makeMap());
    expect(layer.lockCount).toBe(0);
    expect(layer.aqueductCount).toBe(0);
    expect(layer.crossingCount).toBe(0);
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
  });
});
