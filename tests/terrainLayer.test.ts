import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { sampleHeightWorld } from '../src/game/mapGrid';
import { CHUNK_SIZE, TerrainLayer } from '../src/render/TerrainLayer';

function makeMap(width: number, height: number, water = false): MapSnapshot {
  const kind = new Uint8Array(width * height).fill(TILE_KIND_INDEX.grass);
  const heightMap = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      heightMap[y * width + x] = 2 + ((x + y) % 4);
    }
  }
  if (water) {
    for (let y = 4; y < 12; y += 1) {
      for (let x = 4; x < 12; x += 1) {
        const index = y * width + x;
        kind[index] = TILE_KIND_INDEX.water;
        heightMap[index] = 0;
      }
    }
  }
  return {
    width,
    height,
    kind,
    heightMap,
    owner: new Uint8Array(width * height).fill(255),
    slope: new Uint8Array(width * height),
    flags: new Uint8Array(width * height),
    trackBits: new Uint8Array(width * height),
  };
}

function vertexCount(layer: TerrainLayer): number {
  const terrain = layer.group.children.find((child) => child.name.startsWith('terrain-'));
  if (!terrain || !(terrain as Mesh).geometry) return 0;
  const geometry = (terrain as Mesh).geometry;
  return geometry.getAttribute('position').count;
}

describe('TerrainLayer', () => {
  it('découpe la carte en chunks de 32×32', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    expect(layer.chunkCount).toBe(4);
    expect(layer.chunksBuilt).toBe(4);
    layer.dispose();
  });

  it('crée 6 sommets par tuile (deux triangles)', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    expect(vertexCount(layer)).toBe(CHUNK_SIZE * CHUNK_SIZE * 6);
    layer.dispose();
  });

  it('ne reconstruit que les chunks modifiés', () => {
    const layer = new TerrainLayer();
    const map = makeMap(64, 64);
    layer.setMap(map);
    expect(layer.chunksBuilt).toBe(4);

    const identical = makeMap(64, 64);
    layer.applyDelta(identical);
    expect(layer.chunksBuilt).toBe(4);

    const changed = makeMap(64, 64);
    changed.heightMap[0] = 9;
    changed.kind[1] = TILE_KIND_INDEX.road;
    layer.applyDelta(changed);
    expect(layer.chunksBuilt).toBe(5);

    changed.heightMap[40 * 64 + 40] = 1;
    layer.applyDelta(changed);
    expect(layer.chunksBuilt).toBe(6);
    layer.dispose();
  });

  it('ajoute un maillage d’eau sur les tuiles en eau', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64, true));
    const names = layer.group.children.map((child) => child.name);
    expect(names.filter((name) => name.startsWith('water-')).length).toBeGreaterThan(0);
    layer.dispose();
  });

  it('échantillonne la même hauteur que le terrain', () => {
    const layer = new TerrainLayer();
    const map = makeMap(64, 64);
    layer.setMap(map);
    expect(layer.heightAt(10.5, 12.5)).toBeCloseTo(sampleHeightWorld(map, 10.5, 12.5), 6);
    expect(layer.heightAt(10.5, 12.5)).toBeGreaterThan(0);
    layer.dispose();
  });

  it('partage exactement les sommets de bord entre chunks', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    const meshes = layer.group.children.filter((child): child is Mesh =>
      child.name.startsWith('terrain-'),
    );
    const left = meshes.find((mesh) => mesh.name === 'terrain-0-0');
    const right = meshes.find((mesh) => mesh.name === 'terrain-1-0');
    if (!left || !right) throw new Error('chunks manquants');

    const collectEdge = (mesh: Mesh): Map<string, number[]> => {
      const positions = mesh.geometry.getAttribute('position');
      const edge = new Map<string, number[]>();
      for (let i = 0; i < positions.count; i += 1) {
        const x = positions.getX(i);
        if (x !== CHUNK_SIZE) continue;
        const key = String(positions.getZ(i));
        const values = edge.get(key) ?? [];
        values.push(positions.getY(i));
        edge.set(key, values);
      }
      return edge;
    };

    const leftEdge = collectEdge(left);
    const rightEdge = collectEdge(right);
    expect(leftEdge.size).toBeGreaterThan(0);
    expect([...leftEdge.keys()].sort()).toEqual([...rightEdge.keys()].sort());
    for (const [key, leftHeights] of leftEdge) {
      const rightHeights = rightEdge.get(key) ?? [];
      // Chaque coin peut être référencé par 1 ou 2 triangles : on compare les
      // hauteurs distinctes, qui doivent être identiques de part et d'autre.
      const a = [...new Set(leftHeights)].sort((x, y) => x - y);
      const b = [...new Set(rightHeights)].sort((x, y) => x - y);
      expect(b).toEqual(a);
    }
    layer.dispose();
  });

  it('se libère sans laisser de ressources', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64, true));
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.chunkCount).toBe(0);
  });
});
