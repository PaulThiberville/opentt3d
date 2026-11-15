/**
 * Rendu des villes : bâtiments low-poly instanciés.
 *
 * Pour chaque ville, deux `InstancedMesh` (corps + toits) sont reconstruits à
 * partir des tuiles `house` de la carte. La variation (taille, hauteur, teinte)
 * est déterministe : une même ville produit toujours le même bâti. Les
 * empreintes sont bornées à 0,78 tuile pour ne jamais déborder.
 */

import * as THREE from 'three';
import type { MapSnapshot, TownSnapshot } from '../engine/protocol';
import { sampleHeightWorld, tileKindFromIndex } from '../game/mapGrid';
import { Prng, hashUnit2d } from '../game/prng';
import { buildingColour, hexToRgb } from './tileVisuals';

const MAX_RADIUS = 10;
const MAX_FOOTPRINT = 0.78;

export interface CityPickTarget {
  mesh: THREE.InstancedMesh;
  townForInstance(instanceId: number): number | null;
}

interface CityInstances {
  townId: number;
  bodies: THREE.InstancedMesh;
  roofs: THREE.InstancedMesh;
  townIds: number[];
}

export class CityLayer {
  readonly group = new THREE.Group();

  private bodyGeometry: THREE.BoxGeometry;
  private roofGeometry: THREE.ConeGeometry;
  private bodyMaterial: THREE.MeshLambertMaterial;
  private roofMaterial: THREE.MeshLambertMaterial;
  private nightUniform: { value: number } = { value: 0 };
  private nightAmount = 0;
  private nightLights = true;
  private cities = new Map<number, CityInstances>();
  private map: MapSnapshot | null = null;
  private shadows = false;

  constructor() {
    this.group.name = 'cities';
    this.bodyGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.bodyGeometry.translate(0, 0.5, 0);
    this.roofGeometry = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
    this.roofGeometry.rotateY(Math.PI / 4);
    this.roofGeometry.translate(0, 0.5, 0);
    this.bodyMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.roofMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    // Fenêtres procédurales : aucun draw call ni géométrie supplémentaire.
    this.bodyMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.nightUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vBoxPosition;\nvarying vec3 vBoxNormal;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vBoxPosition = position;\n  vBoxNormal = normal;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uNight;\nvarying vec3 vBoxPosition;\nvarying vec3 vBoxNormal;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           if ( uNight > 0.001 ) {
             float facade = 1.0 - step( 0.5, abs( vBoxNormal.y ) );
             float u = abs( vBoxNormal.x ) > abs( vBoxNormal.z ) ? vBoxPosition.z : vBoxPosition.x;
             vec2 grid = vec2( u * 2.0, vBoxPosition.y * 3.0 );
             vec2 cell = fract( grid );
             float frame = step( 0.2, cell.x ) * step( cell.x, 0.8 ) *
                           step( 0.2, cell.y ) * step( cell.y, 0.8 );
             float seed = fract( sin( dot(
               vec3( floor( grid.x ), floor( grid.y ), dot( vColor.rgb, vec3( 31.0, 17.0, 7.0 ) ) ),
               vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
             float lit = step( 0.35, seed );
             totalEmissiveRadiance += vColor.rgb * facade * uNight * 0.045;
             totalEmissiveRadiance += vec3( 1.0, 0.56, 0.2 ) * facade * frame * lit * uNight * 1.2;
           }`,
        );
    };
    this.bodyMaterial.customProgramCacheKey = () => 'opentt3d-city-windows-v1';
  }

  /** Reconstruit les bâtiments de toutes les villes. */
  build(towns: readonly TownSnapshot[], map: MapSnapshot): void {
    this.map = map;
    this.clear();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const colour = new THREE.Color();
    const rgb = { r: 0, g: 0, b: 0 };

    for (const town of towns) {
      const placements: {
        x: number;
        y: number;
        height: number;
        width: number;
        depth: number;
        body: number;
        roof: number;
        roofHeight: number;
      }[] = [];
      const rng = new Prng((town.id + 1) * 7919 + map.width);
      const centerX = Math.floor(town.x);
      const centerY = Math.floor(town.y);

      for (let dy = -MAX_RADIUS; dy <= MAX_RADIUS; dy += 1) {
        for (let dx = -MAX_RADIUS; dx <= MAX_RADIUS; dx += 1) {
          const x = centerX + dx;
          const y = centerY + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          const index = y * map.width + x;
          if (tileKindFromIndex(map.kind[index] ?? 0) !== 'house') continue;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > MAX_RADIUS) continue;

          const footprint = Math.min(MAX_FOOTPRINT, 0.6 + rng.float(0, 0.18));
          const centrality = Math.max(0, 1 - distance / MAX_RADIUS);
          const tall = centrality > 0.55 && hashUnit2d(town.id, x, y) > 0.52;
          const height = tall ? 1.4 + rng.float(0, 1.3) : 0.8 + rng.float(0, 0.7);
          placements.push({
            x: x + 0.5 + rng.float(-0.03, 0.03),
            y: y + 0.5 + rng.float(-0.03, 0.03),
            height,
            width: footprint,
            depth: Math.min(MAX_FOOTPRINT, footprint * rng.float(0.85, 1.08)),
            body: buildingColour(town.id * 31 + x, y, 0x9aa0a4),
            roof: tall ? 0x454b55 : rng.chance(0.55) ? 0x8f4132 : 0x555a60,
            roofHeight: tall ? 0.2 : 0.3 + rng.float(0, 0.2),
          });
        }
      }

      if (placements.length === 0) continue;
      const bodies = new THREE.InstancedMesh(
        this.bodyGeometry,
        this.bodyMaterial,
        placements.length,
      );
      const roofs = new THREE.InstancedMesh(
        this.roofGeometry,
        this.roofMaterial,
        placements.length,
      );
      bodies.name = `city-${town.id}-bodies`;
      roofs.name = `city-${town.id}-roofs`;
      bodies.castShadow = this.shadows;
      bodies.receiveShadow = true;
      roofs.castShadow = this.shadows;
      const townIds: number[] = [];
      quaternion.identity();

      for (let i = 0; i < placements.length; i += 1) {
        const placement = placements[i];
        if (!placement) continue;
        const ground = sampleHeightWorld(map, placement.x, placement.y);
        position.set(placement.x, ground, placement.y);
        scale.set(placement.width, placement.height, placement.depth);
        matrix.compose(position, quaternion, scale);
        bodies.setMatrixAt(i, matrix);
        hexToRgb(placement.body, rgb);
        colour.setRGB(rgb.r, rgb.g, rgb.b);
        bodies.setColorAt(i, colour);

        position.set(placement.x, ground + placement.height, placement.y);
        scale.set(placement.width * 1.04, placement.roofHeight, placement.depth * 1.04);
        matrix.compose(position, quaternion, scale);
        roofs.setMatrixAt(i, matrix);
        hexToRgb(placement.roof, rgb);
        colour.setRGB(rgb.r, rgb.g, rgb.b);
        roofs.setColorAt(i, colour);
        townIds.push(town.id);
      }

      bodies.instanceMatrix.needsUpdate = true;
      roofs.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
      bodies.computeBoundingSphere();
      roofs.computeBoundingSphere();
      this.group.add(bodies);
      this.group.add(roofs);
      this.cities.set(town.id, { townId: town.id, bodies, roofs, townIds });
    }
  }

  /** 0 = jour, 1 = nuit profonde : allume les fenêtres des bâtiments. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightLights ? this.nightAmount : 0;
  }

  get night(): number {
    return this.nightAmount;
  }

  /** Active/désactive les fenêtres éclairées (preset basse qualité). */
  setNightLights(enabled: boolean): void {
    this.nightLights = enabled;
    this.nightUniform.value = enabled ? this.nightAmount : 0;
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const city of this.cities.values()) {
      city.bodies.castShadow = enabled;
      city.roofs.castShadow = enabled;
    }
  }

  get buildingCount(): number {
    let total = 0;
    for (const city of this.cities.values()) total += city.bodies.count;
    return total;
  }

  get drawCallCount(): number {
    return this.cities.size * 2;
  }

  pickTargets(): CityPickTarget[] {
    const targets: CityPickTarget[] = [];
    for (const city of this.cities.values()) {
      targets.push({
        mesh: city.bodies,
        townForInstance: (instanceId: number) => city.townIds[instanceId] ?? null,
      });
      targets.push({
        mesh: city.roofs,
        townForInstance: (instanceId: number) => city.townIds[instanceId] ?? null,
      });
    }
    return targets;
  }

  private clear(): void {
    for (const city of this.cities.values()) {
      this.group.remove(city.bodies);
      this.group.remove(city.roofs);
      city.bodies.dispose();
      city.roofs.dispose();
    }
    this.cities.clear();
  }

  dispose(): void {
    this.clear();
    this.group.clear();
    this.bodyGeometry.dispose();
    this.roofGeometry.dispose();
    this.bodyMaterial.dispose();
    this.roofMaterial.dispose();
    this.map = null;
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }
}
