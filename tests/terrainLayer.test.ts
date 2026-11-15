import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Mesh } from 'three';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { sampleHeightWorld } from '../src/game/mapGrid';
import { CHUNK_SIZE, TerrainLayer } from '../src/render/TerrainLayer';
import {
  TERRAIN_SKIN_BOUNDS,
  glslBound,
  terrainBudget,
  terrainSubdivision,
} from '../src/render/terrainSurface';
import {
  SHORE_MAX_DISTANCE,
  WATER_WAVE_AMPLITUDE,
  waterSurfaceHeight,
} from '../src/render/waterSurface';

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

function waterMeshes(layer: TerrainLayer): Mesh[] {
  return layer.group.children.filter(
    (child): child is Mesh => child instanceof THREE.Mesh && child.name.startsWith('water-'),
  );
}

function extent(attribute: THREE.BufferAttribute): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < attribute.count; index += 1) {
    const value = attribute.getX(index);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
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
      for (const attribute of [
        'position',
        'normal',
        'color',
        'aNightGlow',
        'aAo',
        'aShore',
        'aDepth',
      ]) {
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

  it('expose la distance à l’eau et la profondeur sans changer le budget', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64, true));
    expect(layer.tileSubdivision).toBe(1);
    expect(totalTriangles(layer)).toBe(64 * 64 * 2);

    const geometry = chunkMesh(layer, 'terrain-0-0').geometry;
    const position = geometry.getAttribute('position');
    for (const name of ['aShore', 'aDepth']) {
      const attribute = geometry.getAttribute(name);
      expect(attribute.count).toBe(position.count);
      expect(attribute.itemSize).toBe(1);
    }

    const shore = extent(geometry.getAttribute('aShore') as THREE.BufferAttribute);
    expect(shore.min).toBe(0);
    expect(shore.max).toBeGreaterThan(1);
    expect(shore.max).toBeLessThanOrEqual(SHORE_MAX_DISTANCE);
    // À l'autre bout de la carte, on est loin de l'eau : plage nulle.
    const inland = extent(
      chunkMesh(layer, 'terrain-1-1').geometry.getAttribute('aShore') as THREE.BufferAttribute,
    );
    expect(inland.min).toBeGreaterThan(3);

    const depths = extent(geometry.getAttribute('aDepth') as THREE.BufferAttribute);
    expect(depths.min).toBeGreaterThanOrEqual(0);
    expect(depths.max).toBeLessThanOrEqual(1);
    expect(depths.min).toBeLessThan(0.1);
    expect(depths.max).toBeGreaterThan(0.3);

    // Le maillage d'eau porte la même profondeur, interpolée par coin.
    for (const water of waterMeshes(layer)) {
      const waterDepth = extent(water.geometry.getAttribute('aDepth') as THREE.BufferAttribute);
      expect(waterDepth.min).toBeGreaterThanOrEqual(0);
      expect(waterDepth.max).toBeLessThanOrEqual(1);
    }
    layer.dispose();
  });

  it('tient l’eau au-dessus du lit et hors de tout z-fighting', () => {
    const map = makeMap(64, 64, true);
    const layer = new TerrainLayer();
    layer.setMap(map);
    const bed = sampleHeightWorld(map, 8.5, 8.5);
    expect(bed).toBe(0);
    const surface = waterSurfaceHeight(0);
    expect(surface - bed).toBeGreaterThan(0.4);

    const ground = chunkMesh(layer, 'terrain-0-0');
    for (const water of waterMeshes(layer)) {
      const positions = water.geometry.getAttribute('position');
      for (let index = 0; index < positions.count; index += 1) {
        const y = positions.getY(index);
        expect(y).toBeCloseTo(surface, 6);
        expect(y - bed).toBeGreaterThan(0.4);
      }
      const material = water.material as THREE.MeshPhongMaterial;
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.polygonOffset).toBe(true);
      expect(water.renderOrder).toBeGreaterThan(ground.renderOrder);
    }

    const ocean = layer.group.children.find((child) => child.name === 'ocean-backdrop') as
      THREE.Mesh | undefined;
    expect(ocean).toBeDefined();
    expect(ocean?.position.y ?? 0).toBeLessThan(surface - 0.1);
    layer.dispose();
  });

  it('ne recalcule le champ de distance que si un type de tuile change', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64, true));
    expect(layer.shoreFieldBuilds).toBe(1);

    const heightsOnly = makeMap(64, 64, true);
    heightsOnly.heightMap[20 * 64 + 20] = 9;
    layer.applyDelta(heightsOnly);
    expect(layer.shoreFieldBuilds).toBe(1);

    const kinds = makeMap(64, 64, true);
    kinds.kind[20 * 64 + 20] = TILE_KIND_INDEX.road;
    layer.applyDelta(kinds);
    expect(layer.shoreFieldBuilds).toBe(2);
    layer.dispose();
  });

  it('borne les seuils et la houle injectés dans les shaders', () => {
    const layer = new TerrainLayer();
    layer.setMap(makeMap(64, 64, true));

    const ground = chunkMesh(layer, 'terrain-0-0');
    const groundMaterial = ground.material as THREE.MeshLambertMaterial;
    const groundShader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader:
        '#include <common>\n#include <color_fragment>\n#include <normal_fragment_begin>\n#include <emissivemap_fragment>',
    };
    groundMaterial.onBeforeCompile(groundShader as never, null as never);
    expect(groundShader.vertexShader).toContain('attribute float aShore');
    expect(groundShader.vertexShader).toContain('attribute float aDepth');
    const fragment = groundShader.fragmentShader;
    const earthStart = Number(/TERRAIN_EARTH_START = ([0-9.]+);/.exec(fragment)?.[1]);
    const rockStart = Number(/TERRAIN_ROCK_START = ([0-9.]+);/.exec(fragment)?.[1]);
    expect(earthStart).toBeCloseTo(TERRAIN_SKIN_BOUNDS.earthSlope.start, 4);
    expect(rockStart).toBeCloseTo(TERRAIN_SKIN_BOUNDS.rockSlope.start, 4);
    expect(earthStart).toBeLessThan(rockStart);
    expect(fragment).toContain(
      `TERRAIN_ALPINE_WEIGHT = ${glslBound(TERRAIN_SKIN_BOUNDS.alpine.weight)};`,
    );
    expect(fragment).toContain('SKIN_SAND');
    expect(fragment).toContain('SKIN_BED_DEEP');
    expect(fragment).not.toContain('NaN');

    const water = waterMeshes(layer)[0];
    if (!water) throw new Error('maillage d’eau manquant');
    const waterMaterial = water.material as THREE.MeshPhongMaterial;
    const waterShader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader:
        '#include <common>\n#include <color_fragment>\n#include <normal_fragment_begin>\n#include <emissivemap_fragment>',
    };
    waterMaterial.onBeforeCompile(waterShader as never, null as never);
    expect(waterShader.vertexShader).toContain(
      `const float WATER_WAVE_AMPLITUDE = ${WATER_WAVE_AMPLITUDE.toFixed(5)};`,
    );
    expect(waterShader.vertexShader).toContain('vWaterDepth = aDepth;');
    expect(waterShader.fragmentShader).toContain('WATER_SHALLOW');
    expect(waterShader.fragmentShader).toContain('WATER_DEEP');
    expect(waterShader.fragmentShader).toContain('diffuseColor.a');
    expect(waterShader.fragmentShader).toContain('SKY_REFLECTION');
    expect(waterShader.fragmentShader).not.toContain('NaN');
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
