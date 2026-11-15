import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Mesh } from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { sampleHeightWorld } from '../src/game/mapGrid';
import { CHUNK_SIZE, TerrainLayer } from '../src/render/TerrainLayer';
import { terrainBudget, terrainSubdivision } from '../src/render/terrainSurface';

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

function chunkMeshes(layer: TerrainLayer): Mesh[] {
  return layer.group.children.filter(
    (child): child is Mesh => child instanceof THREE.Mesh && child.name.startsWith('terrain-'),
  );
}

function chunkMesh(layer: TerrainLayer, name: string): Mesh {
  const mesh = chunkMeshes(layer).find((candidate) => candidate.name === name);
  if (!mesh) throw new Error(`chunk terrain ${name} manquant`);
  return mesh;
}

function totalTriangles(layer: TerrainLayer): number {
  return chunkMeshes(layer).reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? 0) / 3, 0);
}

describe('TerrainLayer', () => {
  it('découpe la carte en chunks de 32×32', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    expect(layer.chunkCount).toBe(4);
    expect(layer.chunksBuilt).toBe(4);
    layer.dispose();
  });

  it('garde deux triangles par tuile en moyenne qualité (budget #122)', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    expect(layer.tileSubdivision).toBe(1);
    expect(totalTriangles(layer)).toBe(64 * 64 * 2);

    const geometry = chunkMesh(layer, 'terrain-0-0').geometry;
    expect(geometry.index).not.toBeNull();
    expect(geometry.index?.count).toBe(CHUNK_SIZE * CHUNK_SIZE * 6);
    // Sommets partagés : (32 + 1)² au lieu de 32 × 32 × 6.
    expect(geometry.getAttribute('position').count).toBe((CHUNK_SIZE + 1) * (CHUNK_SIZE + 1));
    layer.dispose();
  });

  it('garde le budget en basse qualité et subdivise seulement en haute', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));

    layer.setQuality('low');
    expect(layer.tileSubdivision).toBe(1);
    expect(totalTriangles(layer)).toBe(64 * 64 * 2);
    expect(layer.chunksBuilt).toBe(4);

    layer.setQuality('high');
    expect(layer.tileSubdivision).toBe(2);
    expect(layer.qualityLevel).toBe('high');
    expect(totalTriangles(layer)).toBe(64 * 64 * 8);
    const geometry = chunkMesh(layer, 'terrain-0-0').geometry;
    expect(geometry.getAttribute('position').count).toBe(
      (CHUNK_SIZE * 2 + 1) * (CHUNK_SIZE * 2 + 1),
    );
    expect(layer.chunksBuilt).toBe(8);

    layer.setQuality('medium');
    expect(layer.tileSubdivision).toBe(1);
    expect(totalTriangles(layer)).toBe(64 * 64 * 2);
    layer.dispose();
  });

  it('désactive la subdivision haute sur une très grande carte', () => {
    const layer = new TerrainLayer();
    layer.setQuality('high');
    layer.setMap(makeMap(320, 320));
    expect(layer.tileSubdivision).toBe(1);
    expect(totalTriangles(layer)).toBe(320 * 320 * 2);
    layer.dispose();
  });

  it('lisse les normales par sommet au lieu de les laisser par face', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    const geometry = chunkMesh(layer, 'terrain-0-0').geometry;
    const normals = geometry.getAttribute('normal');
    const positions = geometry.getAttribute('position');
    expect(normals.count).toBe(positions.count);

    for (let i = 0; i < normals.count; i += 1) {
      const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i));
      expect(length).toBeCloseTo(1, 5);
    }

    // Compare les normales de sommets à la normale géométrique d'un triangle
    // pentu : un rendu plat donnerait une égalité presque parfaite.
    const index = geometry.index;
    if (!index) throw new Error('géométrie non indexée');
    let smoothed = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const face = new THREE.Vector3();
    const vertexNormal = new THREE.Vector3();
    for (let triangle = 0; triangle < Math.min(index.count / 3, 64); triangle += 1) {
      const ia = index.getX(triangle * 3);
      const ib = index.getX(triangle * 3 + 1);
      const ic = index.getX(triangle * 3 + 2);
      a.fromBufferAttribute(positions, ia);
      b.fromBufferAttribute(positions, ib);
      c.fromBufferAttribute(positions, ic);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      face.crossVectors(ab, ac).normalize();
      for (const vertex of [ia, ib, ic]) {
        vertexNormal.fromBufferAttribute(normals, vertex);
        const dot = face.dot(vertexNormal);
        if (dot < 0.999) smoothed += 1;
      }
    }
    expect(smoothed).toBeGreaterThan(0);
    layer.dispose();
  });

  it('partage exactement positions et normales aux bords de chunks', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64));
    const left = chunkMesh(layer, 'terrain-0-0').geometry;
    const right = chunkMesh(layer, 'terrain-1-0').geometry;

    interface BorderVertex {
      height: number;
      normal: [number, number, number];
    }
    const collectEdge = (geometry: THREE.BufferGeometry): Map<string, BorderVertex> => {
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      const edge = new Map<string, BorderVertex>();
      for (let i = 0; i < positions.count; i += 1) {
        if (positions.getX(i) !== CHUNK_SIZE) continue;
        const z = positions.getZ(i);
        edge.set(String(z), {
          height: positions.getY(i),
          normal: [normals.getX(i), normals.getY(i), normals.getZ(i)],
        });
      }
      return edge;
    };

    const leftEdge = collectEdge(left);
    const rightEdge = collectEdge(right);
    expect(leftEdge.size).toBe(CHUNK_SIZE + 1);
    expect([...leftEdge.keys()].sort()).toEqual([...rightEdge.keys()].sort());
    for (const [key, leftVertex] of leftEdge) {
      const rightVertex = rightEdge.get(key);
      if (!rightVertex) throw new Error(`sommet absent en face de z=${key}`);
      expect(rightVertex.height).toBeCloseTo(leftVertex.height, 6);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(rightVertex.normal[axis]).toBeCloseTo(leftVertex.normal[axis] ?? 0, 6);
      }
    }
    layer.dispose();
  });

  it('produit un maillage déterministe', () => {
    const map = makeMap(64, 64, true);
    const first = new TerrainLayer();
    const second = new TerrainLayer();
    first.setMap(map);
    second.setMap(map);
    for (const name of ['terrain-0-0', 'terrain-1-1']) {
      const a = chunkMesh(first, name).geometry;
      const b = chunkMesh(second, name).geometry;
      for (const attribute of ['position', 'normal', 'color', 'aNightGlow', 'aAo']) {
        expect(Array.from(a.getAttribute(attribute).array)).toEqual(
          Array.from(b.getAttribute(attribute).array),
        );
      }
      expect(Array.from(a.index?.array ?? [])).toEqual(Array.from(b.index?.array ?? []));
    }
    first.dispose();
    second.dispose();
  });

  it('borne l’occlusion locale et assombrit les creux', () => {
    const map = makeMap(64, 64);
    // Creuse une tuile : ses coins doivent être plus sombres que la plaine.
    map.heightMap[5 * 64 + 5] = 0;
    const layer = new TerrainLayer();
    layer.setMap(map);
    const geometry = chunkMesh(layer, 'terrain-0-0').geometry;
    const ao = geometry.getAttribute('aAo');
    expect(ao.count).toBe(geometry.getAttribute('position').count);
    let minimum = 1;
    for (let i = 0; i < ao.count; i += 1) minimum = Math.min(minimum, ao.getX(i));
    expect(minimum).toBeGreaterThanOrEqual(0.58);
    expect(minimum).toBeLessThan(1);
    layer.dispose();
  });

  it('ne reconstruit que les chunks modifiés, marge de bord comprise', () => {
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

    // Une tuile en bord de chunk change les hauteurs de coin du voisin.
    const reset = makeMap(64, 64);
    layer.applyDelta(reset);
    const beforeBorder = layer.chunksBuilt;
    const border = makeMap(64, 64);
    border.heightMap[10 * 64 + 31] = 12;
    layer.applyDelta(border);
    expect(layer.chunksBuilt - beforeBorder).toBe(2);
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

  it('se libère sans laisser de ressources', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64, true));
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.chunkCount).toBe(0);
  });
});

describe('budgets de terrain', () => {
  it('conserve le nombre de triangles historique en low et medium', () => {
    for (const size of [128, 256, 512]) {
      const low = terrainBudget(size, size, 'low');
      const medium = terrainBudget(size, size, 'medium');
      const high = terrainBudget(size, size, 'high');
      // La subdivision haute est désactivée au-delà de 100 000 tuiles.
      const highSubdivision = size > 256 ? 1 : 2;
      expect(low.subdivision).toBe(1);
      expect(medium.subdivision).toBe(1);
      expect(high.subdivision).toBe(highSubdivision);

      expect(low.triangles).toBe(size * size * 2);
      expect(medium.triangles).toBe(low.triangles);
      expect(high.triangles).toBe(low.triangles * highSubdivision ** 2);
      expect(low.indices).toBe(low.triangles * 3);
      expect(low.vertices).toBe(Math.ceil(size / CHUNK_SIZE) ** 2 * (CHUNK_SIZE + 1) ** 2);
      expect(high.vertices).toBe(
        Math.ceil(size / CHUNK_SIZE) ** 2 * (CHUNK_SIZE * highSubdivision + 1) ** 2,
      );
    }
  });

  it('expose 1×1 en basse/moyenne et 2×2 en haute qualité', () => {
    expect(terrainSubdivision('low')).toBe(1);
    expect(terrainSubdivision('medium')).toBe(1);
    expect(terrainSubdivision('high')).toBe(2);
    // Garde-fou : 512×512 dépasse le seuil, la haute qualité reste en 1×1.
    expect(terrainSubdivision('high', 200_000)).toBe(1);
  });

  it('gère les cartes non multiples de la taille de chunk', () => {
    const budget = terrainBudget(70, 40, 'medium');
    expect(budget.chunks).toBe(6);
    expect(budget.triangles).toBe(70 * 40 * 2);
    // 3 chunks de 32, 1 de 6 en X ; 1 chunk de 32 et 1 de 8 en Y.
    expect(budget.vertices).toBe(33 * 33 * 2 + 7 * 33 + 33 * 9 * 2 + 7 * 9);
  });
});
