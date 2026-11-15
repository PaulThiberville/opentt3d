/**
 * Terrain 3D en chunks.
 *
 * Chaque chunk de 32×32 tuiles est un `Mesh` non indexé (une tuile = deux
 * triangles, couleur plate) avec ses normales calculées : rendu low-poly net,
 * frustum culling efficace et reconstruction indépendante.
 *
 * Les hauteurs de coin sont moyennées sur les tuiles adjacentes de façon
 * identique de part et d'autre d'une jonction : les bords de chunks partagent
 * exactement les mêmes sommets (pas de fissure ni de z-fighting).
 *
 * L'eau est un second maillage par chunk, plaqué 6 cm au-dessus du lit, dont
 * le shader animé donne le clapot.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { cornerHeightWorld, isWaterKind, sampleHeightWorld, tileKindFromIndex } from '../game/mapGrid';
import { hashUnit2d } from '../game/prng';
import { hexToRgb, rgbToHex, shallowWaterColour, tileColour } from './tileVisuals';
import { qualitySettings, type QualityLevel } from './quality';

export const CHUNK_SIZE = 32;
const WATER_OFFSET = 0.055;

interface Chunk {
  cx: number;
  cy: number;
  ground: THREE.Mesh;
  water: THREE.Mesh | null;
}

interface MapArrays {
  width: number;
  height: number;
  kind: Uint8Array;
  heightMap: Uint8Array;
  flags: Uint8Array;
  owner: Uint8Array;
  slope: Uint8Array;
  trackBits: Uint8Array;
}

function copyArrays(map: MapSnapshot): MapArrays {
  return {
    width: map.width,
    height: map.height,
    kind: map.kind.slice(),
    heightMap: map.heightMap.slice(),
    flags: map.flags.slice(),
    owner: map.owner.slice(),
    slope: map.slope.slice(),
    trackBits: map.trackBits.slice(),
  };
}

export class TerrainLayer {
  readonly group = new THREE.Group();
  readonly chunkSize = CHUNK_SIZE;

  private chunks = new Map<number, Chunk>();
  private map: MapSnapshot | null = null;
  private previous: MapArrays | null = null;
  private groundMaterial: THREE.MeshLambertMaterial;
  private waterMaterial: THREE.MeshPhongMaterial;
  private waterTime: { value: number } | null = null;
  private elapsed = 0;
  private animateWater = true;
  private chunksX = 0;
  private chunksY = 0;

  constructor() {
    this.group.name = 'terrain';
    this.groundMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false });
    this.waterMaterial = this.createWaterMaterial();
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  private createWaterMaterial(): THREE.MeshPhongMaterial {
    const material = new THREE.MeshPhongMaterial({
      color: 0x3f86ad,
      vertexColors: true,
      specular: 0xbfe6ff,
      shininess: 110,
      side: THREE.FrontSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterTime ?? { value: 0 };
      this.waterTime = shader.uniforms.uTime as { value: number };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nvarying vec3 vWaterWorld;',
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3( position );
           float wave = sin( uTime * 1.35 + position.x * 0.55 + position.z * 0.42 );
           float ripple = sin( uTime * 2.2 + position.x * 1.7 - position.z * 1.1 ) * 0.35;
           transformed.y += ( wave * 0.05 + ripple * 0.02 );
           vWaterWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nvarying vec3 vWaterWorld;',
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float waveA = sin( uTime * 1.15 + vWaterWorld.x * 0.55 + vWaterWorld.z * 0.45 );
           float waveB = sin( uTime * 0.7 - vWaterWorld.x * 0.2 + vWaterWorld.z * 0.35 );
           diffuseColor.rgb *= 1.0 + waveA * 0.045 + waveB * 0.035;`,
        );
    };
    material.customProgramCacheKey = () => 'opentt3d-water-v1';
    return material;
  }

  /** Applique une carte complète (premier snapshot ou changement de carte). */
  setMap(map: MapSnapshot): void {
    const sizeChanged =
      !this.map || this.map.width !== map.width || this.map.height !== map.height;
    this.map = map;
    if (sizeChanged) {
      this.disposeChunks();
      this.chunksX = Math.ceil(map.width / CHUNK_SIZE);
      this.chunksY = Math.ceil(map.height / CHUNK_SIZE);
      this.previous = null;
      this.rebuildAll();
    } else {
      this.applyDelta(map);
    }
    this.previous = copyArrays(map);
  }

  /** Reconstruit uniquement les chunks dont les tableaux ont changé. */
  applyDelta(map: MapSnapshot): void {
    if (!this.map || this.map.width !== map.width || this.map.height !== map.height) {
      this.setMap(map);
      return;
    }
    this.map = map;
    const previous = this.previous;
    for (let cy = 0; cy < this.chunksY; cy += 1) {
      for (let cx = 0; cx < this.chunksX; cx += 1) {
        if (!previous || this.chunkDiffers(map, previous, cx, cy)) {
          this.buildChunk(cx, cy);
        }
      }
    }
    this.previous = copyArrays(map);
  }

  private chunkDiffers(map: MapSnapshot, previous: MapArrays, cx: number, cy: number): boolean {
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const x1 = Math.min(map.width, x0 + CHUNK_SIZE);
    const y1 = Math.min(map.height, y0 + CHUNK_SIZE);
    for (let y = y0; y < y1; y += 1) {
      const row = y * map.width;
      for (let x = x0; x < x1; x += 1) {
        const index = row + x;
        if (map.kind[index] !== previous.kind[index]) return true;
        if (map.heightMap[index] !== previous.heightMap[index]) return true;
        if (map.flags[index] !== previous.flags[index]) return true;
        if (map.slope[index] !== previous.slope[index]) return true;
        if (map.owner[index] !== previous.owner[index]) return true;
        if (map.trackBits[index] !== previous.trackBits[index]) return true;
      }
    }
    return false;
  }

  rebuildAll(): void {
    if (!this.map) return;
    for (let cy = 0; cy < this.chunksY; cy += 1) {
      for (let cx = 0; cx < this.chunksX; cx += 1) this.buildChunk(cx, cy);
    }
  }

  markChunkDirty(cx: number, cy: number): void {
    if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) return;
    this.buildChunk(cx, cy);
  }

  private buildChunk(cx: number, cy: number): void {
    const map = this.map;
    if (!map) return;
    const key = cy * this.chunksX + cx;
    const existing = this.chunks.get(key);
    if (existing) {
      this.group.remove(existing.ground);
      existing.ground.geometry.dispose();
      if (existing.water) {
        this.group.remove(existing.water);
        existing.water.geometry.dispose();
      }
      this.chunks.delete(key);
    }

    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const width = Math.min(CHUNK_SIZE, map.width - x0);
    const height = Math.min(CHUNK_SIZE, map.height - y0);
    if (width <= 0 || height <= 0) return;

    const tileCount = width * height;
    const positions = new Float32Array(tileCount * 6 * 3);
    const colours = new Float32Array(tileCount * 6 * 3);
    let vertex = 0;

    // Hauteurs de coin du chunk, calculées une fois (33×33 au maximum).
    const cornerCountX = width + 1;
    const corners = new Float32Array(cornerCountX * (height + 1));
    for (let gy = 0; gy <= height; gy += 1) {
      for (let gx = 0; gx <= width; gx += 1) {
        corners[gy * cornerCountX + gx] = cornerHeightWorld(map, x0 + gx, y0 + gy);
      }
    }
    const cornerAt = (gx: number, gy: number): number => corners[gy * cornerCountX + gx] ?? 0;

    const rgb = { r: 0, g: 0, b: 0 };
    for (let ty = 0; ty < height; ty += 1) {
      for (let tx = 0; tx < width; tx += 1) {
        const wx = x0 + tx;
        const wy = y0 + ty;
        const index = wy * map.width + wx;
        const kind = tileKindFromIndex(map.kind[index] ?? 0);
        const level = map.heightMap[index] ?? 0;
        const steepness = map.slope[index] ?? 0;
        const variation = hashUnit2d(map.width, wx, wy);
        const colour = tileColour(kind, level, steepness, map.width);
        // Léger éclat aléatoire pour casser les aplats.
        const shade = 0.94 + variation * 0.12;
        hexToRgb(
          rgbToHex(((colour >> 16) & 0xff) * shade, ((colour >> 8) & 0xff) * shade, (colour & 0xff) * shade),
          rgb,
        );

        const hA = cornerAt(tx, ty);
        const hB = cornerAt(tx + 1, ty);
        const hC = cornerAt(tx + 1, ty + 1);
        const hD = cornerAt(tx, ty + 1);
        const px = wx;
        const pz = wy;

        // Triangle A, C, B
        positions[vertex * 3] = px;
        positions[vertex * 3 + 1] = hA;
        positions[vertex * 3 + 2] = pz;
        colours[vertex * 3] = rgb.r;
        colours[vertex * 3 + 1] = rgb.g;
        colours[vertex * 3 + 2] = rgb.b;
        vertex += 1;
        positions[vertex * 3] = px + 1;
        positions[vertex * 3 + 1] = hC;
        positions[vertex * 3 + 2] = pz + 1;
        colours[vertex * 3] = rgb.r;
        colours[vertex * 3 + 1] = rgb.g;
        colours[vertex * 3 + 2] = rgb.b;
        vertex += 1;
        positions[vertex * 3] = px + 1;
        positions[vertex * 3 + 1] = hB;
        positions[vertex * 3 + 2] = pz;
        colours[vertex * 3] = rgb.r;
        colours[vertex * 3 + 1] = rgb.g;
        colours[vertex * 3 + 2] = rgb.b;
        vertex += 1;

        // Triangle A, D, C
        positions[vertex * 3] = px;
        positions[vertex * 3 + 1] = hA;
        positions[vertex * 3 + 2] = pz;
        colours[vertex * 3] = rgb.r;
        colours[vertex * 3 + 1] = rgb.g;
        colours[vertex * 3 + 2] = rgb.b;
        vertex += 1;
        positions[vertex * 3] = px;
        positions[vertex * 3 + 1] = hD;
        positions[vertex * 3 + 2] = pz + 1;
        colours[vertex * 3] = rgb.r;
        colours[vertex * 3 + 1] = rgb.g;
        colours[vertex * 3 + 2] = rgb.b;
        vertex += 1;
        positions[vertex * 3] = px + 1;
        positions[vertex * 3 + 1] = hC;
        positions[vertex * 3 + 2] = pz + 1;
        colours[vertex * 3] = rgb.r;
        colours[vertex * 3 + 1] = rgb.g;
        colours[vertex * 3 + 2] = rgb.b;
        vertex += 1;
      }
    }

    const groundGeometry = new THREE.BufferGeometry();
    groundGeometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vertex * 3), 3));
    groundGeometry.setAttribute('color', new THREE.BufferAttribute(colours.subarray(0, vertex * 3), 3));
    groundGeometry.computeVertexNormals();
    groundGeometry.computeBoundingSphere();
    const ground = new THREE.Mesh(groundGeometry, this.groundMaterial);
    ground.name = `terrain-${cx}-${cy}`;
    ground.frustumCulled = true;
    ground.receiveShadow = true;
    this.group.add(ground);

    // --- Surcouche d'eau animée, uniquement sur les tuiles en eau.
    let waterTiles = 0;
    for (let ty = 0; ty < height; ty += 1) {
      for (let tx = 0; tx < width; tx += 1) {
        const index = (y0 + ty) * map.width + (x0 + tx);
        if (isWaterKind(tileKindFromIndex(map.kind[index] ?? 0))) waterTiles += 1;
      }
    }

    let water: THREE.Mesh | null = null;
    if (waterTiles > 0) {
      const waterPositions = new Float32Array(waterTiles * 6 * 3);
      const waterColours = new Float32Array(waterTiles * 6 * 3);
      let waterVertex = 0;
      const waterRgb = { r: 0, g: 0, b: 0 };
      for (let ty = 0; ty < height; ty += 1) {
        for (let tx = 0; tx < width; tx += 1) {
          const wx = x0 + tx;
          const wy = y0 + ty;
          const index = wy * map.width + wx;
          if (!isWaterKind(tileKindFromIndex(map.kind[index] ?? 0))) continue;
          const landNeighbour =
            (wx > 0 && !isWaterKind(tileKindFromIndex(map.kind[index - 1] ?? 0))) ||
            (wx + 1 < map.width && !isWaterKind(tileKindFromIndex(map.kind[index + 1] ?? 0))) ||
            (wy > 0 && !isWaterKind(tileKindFromIndex(map.kind[index - map.width] ?? 0))) ||
            (wy + 1 < map.height && !isWaterKind(tileKindFromIndex(map.kind[index + map.width] ?? 0)));
          const base = landNeighbour ? shallowWaterColour(wx * 31 + wy) : 0x2f7ba2;
          const shimmer = 0.93 + hashUnit2d(wx, wy, 91) * 0.14;
          hexToRgb(
            rgbToHex(((base >> 16) & 0xff) * shimmer, ((base >> 8) & 0xff) * shimmer, (base & 0xff) * shimmer),
            waterRgb,
          );
          const hA = cornerAt(tx, ty) + WATER_OFFSET;
          const hB = cornerAt(tx + 1, ty) + WATER_OFFSET;
          const hC = cornerAt(tx + 1, ty + 1) + WATER_OFFSET;
          const hD = cornerAt(tx, ty + 1) + WATER_OFFSET;
          const write = (x: number, h: number, z: number): void => {
            waterPositions[waterVertex * 3] = x;
            waterPositions[waterVertex * 3 + 1] = h;
            waterPositions[waterVertex * 3 + 2] = z;
            waterColours[waterVertex * 3] = waterRgb.r;
            waterColours[waterVertex * 3 + 1] = waterRgb.g;
            waterColours[waterVertex * 3 + 2] = waterRgb.b;
            waterVertex += 1;
          };
          write(wx, hA, wy);
          write(wx + 1, hC, wy + 1);
          write(wx + 1, hB, wy);
          write(wx, hA, wy);
          write(wx, hD, wy + 1);
          write(wx + 1, hC, wy + 1);
        }
      }
      const waterGeometry = new THREE.BufferGeometry();
      waterGeometry.setAttribute('position', new THREE.BufferAttribute(waterPositions, 3));
      waterGeometry.setAttribute('color', new THREE.BufferAttribute(waterColours, 3));
      waterGeometry.computeVertexNormals();
      waterGeometry.computeBoundingSphere();
      water = new THREE.Mesh(waterGeometry, this.waterMaterial);
      water.name = `water-${cx}-${cy}`;
      water.receiveShadow = false;
      this.group.add(water);
    }

    this.chunks.set(key, { cx, cy, ground, water });
  }

  /** Hauteur du terrain (unités monde) en coordonnées tuiles fractionnaires. */
  heightAt(x: number, z: number): number {
    if (!this.map) return 0;
    return sampleHeightWorld(this.map, x, z);
  }

  /** Hauteur maximale de la carte, pour les bornes caméra. */
  maxHeight(): number {
    if (!this.map) return 0;
    let max = 0;
    for (let i = 0; i < this.map.heightMap.length; i += 1) {
      const value = this.map.heightMap[i] ?? 0;
      if (value > max) max = value;
    }
    return max * 0.5;
  }

  setQuality(level: QualityLevel): void {
    this.animateWater = qualitySettings(level).waterAnimation;
    if (!this.animateWater && this.waterTime) this.waterTime.value = 0;
    const settings = qualitySettings(level);
    this.groundMaterial.dithering = level !== 'low';
    this.waterMaterial.shininess = settings.level === 'low' ? 40 : settings.level === 'high' ? 130 : 90;
  }

  update(deltaSeconds: number): void {
    if (!this.animateWater) return;
    this.elapsed += deltaSeconds;
    if (this.waterTime) this.waterTime.value = this.elapsed;
  }

  private disposeChunks(): void {
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.ground);
      chunk.ground.geometry.dispose();
      if (chunk.water) {
        this.group.remove(chunk.water);
        chunk.water.geometry.dispose();
      }
    }
    this.chunks.clear();
  }

  dispose(): void {
    this.disposeChunks();
    this.group.clear();
    this.groundMaterial.dispose();
    this.waterMaterial.dispose();
    this.map = null;
    this.previous = null;
  }
}
