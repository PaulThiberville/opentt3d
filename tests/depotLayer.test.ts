import { describe, expect, it } from 'vitest';
import { COMPANY_NONE, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import { DEPOT_TRACK_BIT } from '../src/game/vehicleRules';
import { DepotLayer } from '../src/render/DepotLayer';

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

describe('DepotLayer', () => {
  it('pose un auvent instancié par tuile marquée dépôt', () => {
    const map = makeMap();
    map.trackBits[2 * map.width + 3] = DEPOT_TRACK_BIT;
    map.trackBits[5 * map.width + 6] = DEPOT_TRACK_BIT;
    map.owner[5 * map.width + 6] = 0;
    const layer = new DepotLayer();
    layer.setMap(map);
    expect(layer.count).toBe(2);
    expect(layer.group.visible).toBe(true);
    expect(layer.group.children.length).toBe(1);
    layer.dispose();
    expect(layer.count).toBe(0);
  });

  it('reste invisible sans dépôt', () => {
    const layer = new DepotLayer();
    layer.setMap(makeMap());
    expect(layer.count).toBe(0);
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });
});
