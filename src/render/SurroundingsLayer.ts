/**
 * Décor continu autour de la carte jouable (issue #174).
 *
 * Trois éléments purement visuels, hors picking et hors simulation :
 *
 * - une **jupe de terrain** qui prolonge les hauteurs et les couleurs des
 *   tuiles de bord sur quelques tuiles, puis descend vers le lit océanique ;
 * - une **surface océanique** continue (houle et profondeur au bord, large
 *   grossier au loin) assez étendue pour couvrir le frustum ;
 * - des **îles lointaines** fusionnées en un seul mesh, pour donner une échelle
 *   à l'horizon.
 *
 * La carte est seulement lue (`sampleHeightWorld`, types de tuiles) : aucune
 * géométrie de `TerrainLayer` n'est modifiée, aucun mesh n'est ciblable par le
 * picking, et la caméra garde ses bornes jouables. Toute la reconstruction est
 * pilotée par deux signatures (bords et types de tuiles) : un snapshot qui ne
 * touche pas les bords ne réalloue rien.
 */

import * as THREE from 'three';
import type { MapSnapshot } from '../engine/protocol';
import { clamp } from '../game/mapGrid';
import { hashUnit2d } from '../game/prng';
import { qualitySettings, type QualityLevel } from './quality';
import {
  buildIslandMesh,
  buildOceanGrid,
  buildSkirtGrid,
  distanceOutsideMap,
  islandPlan,
  layoutSignature,
  shoreSignature,
  surroundingColourLinear,
  surroundingNormal,
  surroundingHeight,
  surroundingWaterDepth,
  surroundingsBudget,
  type SurroundingsBudget,
} from './surroundingsPlan';
import { terrainSkinStrength } from './terrainSurface';
import {
  TERRAIN_SKIN_COLOURS,
  WATER_DEEP_COLOUR,
  WATER_SHALLOW_COLOUR,
  glslLinearColour,
  hexToLinearRgb,
  rgbToHex,
  waterColourAtDepth,
  type Rgb,
} from './tileVisuals';
import { WATER_SHADER_CONSTANTS, buildShoreFields, type ShoreFields } from './waterSurface';

/** Bruit de valeur partagé avec la peau du terrain (mêmes octaves). */
const SURROUND_NOISE_GLSL = /* glsl */ `
float surroundHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float surroundNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = surroundHash( i );
  float b = surroundHash( i + vec2( 1.0, 0.0 ) );
  float c = surroundHash( i + vec2( 0.0, 1.0 ) );
  float d = surroundHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
`;

const COAST_COLOUR_GLSL = /* glsl */ `
const vec3 COAST_SHALLOW = ${glslLinearColour(WATER_SHALLOW_COLOUR)};
const vec3 COAST_DEEP = ${glslLinearColour(WATER_DEEP_COLOUR)};
const vec3 COAST_SKY = ${glslLinearColour(TERRAIN_SKIN_COLOURS.skyReflection)};
`;

export class SurroundingsLayer {
  readonly group = new THREE.Group();

  private map: MapSnapshot | null = null;
  private quality: QualityLevel = 'medium';
  private budget: SurroundingsBudget = surroundingsBudget('medium');
  private settings = qualitySettings('medium');
  private shoreFields: ShoreFields | null = null;
  private worldKey = '';
  private layout = '';
  private shore = '';
  private nightAmount = 0;
  private elapsed = 0;

  private skirt: THREE.Mesh | null = null;
  private ocean: THREE.Mesh | null = null;
  private islands: THREE.Mesh | null = null;

  private skirtMaterial: THREE.MeshLambertMaterial;
  private coastalMaterial: THREE.MeshPhongMaterial;
  private oceanMaterial: THREE.MeshBasicMaterial;
  private islandMaterial: THREE.MeshBasicMaterial;

  private nightUniform: { value: number } = { value: 0 };
  private timeUniform: { value: number } = { value: 0 };
  private skinUniform: { value: number } = { value: 1 };
  private oceanDayColour = new THREE.Color(WATER_DEEP_COLOUR);
  private oceanNightColour = new THREE.Color(0x071a28);

  /** Nombre de reconstructions complètes (diagnostic/tests). */
  builds = 0;
  private skirtBuilds = 0;
  private oceanBuilds = 0;

  constructor() {
    this.group.name = 'surroundings';
    this.skirtMaterial = this.createSkirtMaterial();
    this.coastalMaterial = this.createCoastalMaterial();
    this.oceanMaterial = new THREE.MeshBasicMaterial({
      color: WATER_DEEP_COLOUR,
      fog: true,
    });
    this.islandMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      fog: true,
    });
    this.applyQualitySettings();
  }

  private createSkirtMaterial(): THREE.MeshLambertMaterial {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSkinStrength = this.skinUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vSurroundWorld;
varying float vSurroundDistance;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  vSurroundWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vSurroundDistance = -( modelViewMatrix * vec4( transformed, 1.0 ) ).z;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uSkinStrength;
varying vec3 vSurroundWorld;
varying float vSurroundDistance;
${SURROUND_NOISE_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  // Même grain que la peau du terrain : la jupe ne se détache pas au raccord.
  float surroundFade = 1.0 - smoothstep( 70.0, 210.0, vSurroundDistance );
  float surroundMeso = surroundNoise( vSurroundWorld.xz * 0.37 - 1.9 ) - 0.5;
  float surroundFine = ( surroundNoise( vSurroundWorld.xz * 1.15 + 9.3 ) - 0.5 ) * surroundFade;
  diffuseColor.rgb *= 1.0 + ( surroundMeso * 0.08 + surroundFine * 0.06 ) * uSkinStrength;`,
        );
    };
    material.customProgramCacheKey = () => 'opentt3d-surroundings-skirt-v1';
    return material;
  }

  private createCoastalMaterial(): THREE.MeshPhongMaterial {
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      vertexColors: true,
      specular: 0x9fc4d8,
      shininess: 90,
      // Opaque : la jupe sous-marine et le fond restent cachés, sans couture
      // de transparence ni fond supplémentaire à dessiner.
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.timeUniform;
      shader.uniforms.uNight = this.nightUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uTime;
attribute float aDepth;
attribute float aWave;
varying vec3 vCoastWorld;
varying float vCoastDepth;
varying float vCoastDistance;
${WATER_SHADER_CONSTANTS}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  // Même houle que l'eau de la carte : le raccord au bord reste continu.
  float coastWave = sin( uTime * 1.35 + position.x * 0.55 + position.z * 0.42 ) * 0.6
    + sin( uTime * 2.2 + position.x * 1.7 - position.z * 1.1 ) * 0.28
    + sin( uTime * 0.8 - position.x * 0.35 + position.z * 0.9 ) * 0.12;
  transformed.y += coastWave * WATER_WAVE_AMPLITUDE * aWave;
  vCoastWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vCoastDistance = -( modelViewMatrix * vec4( transformed, 1.0 ) ).z;
  vCoastDepth = aDepth;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uTime;
uniform float uNight;
varying vec3 vCoastWorld;
varying float vCoastDepth;
varying float vCoastDistance;
${WATER_SHADER_CONSTANTS}
${COAST_COLOUR_GLSL}
${SURROUND_NOISE_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  float coastA = sin( uTime * 1.15 + vCoastWorld.x * 0.55 + vCoastWorld.z * 0.45 );
  float coastB = sin( uTime * 0.7 - vCoastWorld.x * 0.2 + vCoastWorld.z * 0.35 );
  vec3 coastDepthTint = mix(
    COAST_SHALLOW,
    COAST_DEEP,
    smoothstep( 0.05, 0.9, vCoastDepth )
  );
  diffuseColor.rgb = mix( diffuseColor.rgb, coastDepthTint, 0.55 );
  diffuseColor.rgb *= 1.0 + coastA * 0.045 + coastB * 0.03;

  float coastFoamDepth = 1.0 - smoothstep( 0.0, WATER_FOAM_DEPTH, vCoastDepth );
  float coastFoamNoise = surroundNoise( vec2(
    vCoastWorld.x * WATER_RIPPLE_SCALE + uTime * 0.35,
    vCoastWorld.z * WATER_RIPPLE_SCALE - uTime * 0.27
  ) );
  float coastFoamFade = 1.0 - smoothstep(
    WATER_RIPPLE_FADE_NEAR,
    WATER_RIPPLE_FADE_FAR,
    vCoastDistance
  );
  float coastFoam = coastFoamDepth * smoothstep( 0.42, 0.78, coastFoamNoise + 0.18 ) * coastFoamFade;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.82, 0.84 ), coastFoam * 0.38 );`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
  // Clapot atténué plus tôt que l'eau jouable : au large, un océan immense
  // ne doit pas scintiller en motif régulier sous le soleil rasant.
  float coastRippleFade = 1.0 - smoothstep( 35.0, 120.0, vCoastDistance );
  float coastRippleX = cos( vCoastWorld.x * 1.9 + uTime * 1.5 ) * 0.06
    + cos( vCoastWorld.x * 3.7 - vCoastWorld.z * 2.3 + uTime * 2.1 ) * 0.03;
  float coastRippleZ = cos( vCoastWorld.z * 2.2 - uTime * 1.2 ) * 0.055
    + cos( vCoastWorld.z * 4.1 + vCoastWorld.x * 1.7 - uTime * 1.8 ) * 0.022;
  vec3 coastNormalWorld = normalize( vec3(
    -coastRippleX * coastRippleFade,
    1.0,
    -coastRippleZ * coastRippleFade
  ) );
  normal = normalize( mat3( viewMatrix ) * coastNormalWorld );`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  vec3 coastView = normalize( cameraPosition - vCoastWorld );
  float coastFresnel = pow( 1.0 - clamp( dot( vec3( 0.0, 1.0, 0.0 ), coastView ), 0.0, 1.0 ), 3.0 );
  totalEmissiveRadiance += COAST_SKY * coastFresnel * 0.12;
  totalEmissiveRadiance += vec3( 0.035, 0.075, 0.13 ) * uNight;`,
        );
    };
    material.customProgramCacheKey = () => 'opentt3d-surroundings-coast-v1';
    return material;
  }

  /** Reconstruit le décor si les bords, les types de tuiles ou la qualité changent. */
  build(map: MapSnapshot, quality: QualityLevel = this.quality): void {
    this.map = map;
    if (quality !== this.quality) {
      this.quality = quality;
      this.applyQualitySettings();
    }
    this.rebuildIfNeeded(map);
  }

  private rebuildIfNeeded(map: MapSnapshot): void {
    const worldKey = `${map.width}x${map.height}:${this.quality}`;
    const layout = layoutSignature(map);
    const shore = shoreSignature(map);
    const worldChanged = worldKey !== this.worldKey;
    const layoutChanged = layout !== this.layout;
    const shoreChanged = shore !== this.shore;

    if (!worldChanged && !layoutChanged && !shoreChanged) return;

    if (worldChanged || shoreChanged) {
      this.shoreFields = buildShoreFields(map);
    }
    if (worldChanged || layoutChanged) {
      this.rebuildSkirt(map);
    }
    if (worldChanged || shoreChanged) {
      this.rebuildOcean(map);
    }
    if (worldChanged) {
      this.rebuildIslands(map);
    }

    this.worldKey = worldKey;
    this.layout = layout;
    this.shore = shore;
    this.builds += 1;
  }

  private rebuildSkirt(map: MapSnapshot): void {
    this.disposeMesh(this.skirt);
    this.skirt = null;
    const grid = buildSkirtGrid(map, this.budget);
    if (grid.xs.length === 0) return;

    const colours = new Float32Array(grid.xs.length * 3);
    const normals = new Float32Array(grid.xs.length * 3);
    const colour: Rgb = { r: 0, g: 0, b: 0 };
    const normal: Rgb = { r: 0, g: 0, b: 0 };
    for (let index = 0; index < grid.xs.length; index += 1) {
      const x = grid.xs[index] ?? 0;
      const z = grid.zs[index] ?? 0;
      surroundingColourLinear(map, x, z, this.budget, colour);
      surroundingNormal(map, x, z, this.budget, normal);
      colours[index * 3] = colour.r;
      colours[index * 3 + 1] = colour.g;
      colours[index * 3 + 2] = colour.b;
      normals[index * 3] = normal.r;
      normals[index * 3 + 1] = normal.g;
      normals[index * 3 + 2] = normal.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(Float32Array.from(grid.positions), 3),
    );
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(grid.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.skirtMaterial);
    mesh.name = 'surroundings-skirt';
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    this.skirt = mesh;
    this.group.add(mesh);
    this.skirtBuilds += 1;
  }

  private rebuildOcean(map: MapSnapshot): void {
    this.disposeMesh(this.ocean);
    this.ocean = null;
    const grid = buildOceanGrid(map, this.quality);
    if (grid.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(Float32Array.from(grid.positions), 3),
    );
    geometry.setIndex(grid.indices);

    if (this.quality === 'low') {
      // Basse qualité : un seul plan uniforme, sans houle ni dégradé.
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.oceanMaterial);
      mesh.name = 'surroundings-ocean';
      mesh.frustumCulled = true;
      this.ocean = mesh;
      this.group.add(mesh);
      this.oceanBuilds += 1;
      return;
    }

    const fields = this.shoreFields;
    const count = grid.xs.length;
    const colours = new Float32Array(count * 3);
    const depths = new Float32Array(count);
    const waves = new Float32Array(count);
    const band = this.budget.coastalBand;
    const rgb: Rgb = { r: 0, g: 0, b: 0 };
    for (let index = 0; index < count; index += 1) {
      const x = grid.xs[index] ?? 0;
      const z = grid.zs[index] ?? 0;
      const distance = distanceOutsideMap(map, x, z);
      const depth = fields ? surroundingWaterDepth(map, fields, x, z, this.budget) : 1;
      depths[index] = depth;
      // La houle s'éteint avant le large : la surface y est parfaitement plate.
      waves[index] = 1 - smoothstep(Math.max(0, band - 2), band, distance);
      const tileX = Math.round(x);
      const tileZ = Math.round(z);
      const base = waterColourAtDepth(depth, tileX * 31 + tileZ);
      const shimmer = 0.975 + hashUnit2d(tileX, tileZ, 91) * 0.05;
      hexToLinearRgb(
        rgbToHex(
          ((base >> 16) & 0xff) * shimmer,
          ((base >> 8) & 0xff) * shimmer,
          (base & 0xff) * shimmer,
        ),
        rgb,
      );
      colours[index * 3] = rgb.r;
      colours[index * 3 + 1] = rgb.g;
      colours[index * 3 + 2] = rgb.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
    geometry.setAttribute('aWave', new THREE.BufferAttribute(waves, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.coastalMaterial);
    mesh.name = 'surroundings-ocean';
    mesh.frustumCulled = true;
    this.ocean = mesh;
    this.group.add(mesh);
    this.oceanBuilds += 1;
  }

  private rebuildIslands(map: MapSnapshot): void {
    this.disposeMesh(this.islands);
    this.islands = null;
    if (islandPlan(map, this.quality).length === 0) return;
    const data = buildIslandMesh(map, this.quality);
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(Float32Array.from(data.positions), 3),
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(data.colours), 3));
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.islandMaterial);
    mesh.name = 'surroundings-islands';
    mesh.frustumCulled = true;
    this.islands = mesh;
    this.group.add(mesh);
  }

  setQuality(level: QualityLevel): void {
    if (level === this.quality) return;
    this.quality = level;
    this.applyQualitySettings();
    if (this.map) this.rebuildIfNeeded(this.map);
  }

  private applyQualitySettings(): void {
    this.settings = qualitySettings(this.quality);
    this.budget = surroundingsBudget(this.quality);
    this.skinUniform.value = terrainSkinStrength(this.quality);
    this.skirtMaterial.dithering = this.quality !== 'low';
    this.coastalMaterial.shininess =
      this.quality === 'low' ? 30 : this.quality === 'high' ? 80 : 55;
    if (!this.settings.waterAnimation) this.timeUniform.value = 0;
  }

  setNight(amount: number): void {
    const value = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightAmount = value;
    this.nightUniform.value = value;
    this.oceanMaterial.color.copy(this.oceanDayColour).lerp(this.oceanNightColour, value);
  }

  get night(): number {
    return this.nightAmount;
  }

  /** Hauteur de la jupe hors carte (tests et diagnostics). */
  heightAt(x: number, z: number): number {
    if (!this.map) return 0;
    return surroundingHeight(this.map, x, z, this.budget);
  }

  /** Nombre de draw calls ajoutés par le décor (0 à 3). */
  get drawCallCount(): number {
    return (this.skirt ? 1 : 0) + (this.ocean ? 1 : 0) + (this.islands ? 1 : 0);
  }

  /** Triangles du décor, jupe et îles comprises. */
  get triangleCount(): number {
    let total = 0;
    for (const mesh of [this.skirt, this.ocean, this.islands]) {
      const index = mesh?.geometry.getIndex();
      if (index) total += index.count / 3;
    }
    return total;
  }

  get buildCount(): number {
    return this.builds;
  }

  get skirtBuildCount(): number {
    return this.skirtBuilds;
  }

  get oceanBuildCount(): number {
    return this.oceanBuilds;
  }

  /** Le décor est purement visuel : il ne doit jamais être ciblable. */
  pickTargets(): THREE.Object3D[] {
    return [];
  }

  update(deltaSeconds: number): void {
    if (!this.settings.waterAnimation) return;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    this.elapsed += deltaSeconds;
    this.timeUniform.value = this.elapsed;
  }

  private disposeMesh(mesh: THREE.Mesh | null): void {
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
  }

  dispose(): void {
    this.disposeMesh(this.skirt);
    this.disposeMesh(this.ocean);
    this.disposeMesh(this.islands);
    this.skirt = null;
    this.ocean = null;
    this.islands = null;
    this.skirtMaterial.dispose();
    this.coastalMaterial.dispose();
    this.oceanMaterial.dispose();
    this.islandMaterial.dispose();
    this.group.clear();
    this.map = null;
    this.shoreFields = null;
    this.worldKey = '';
    this.layout = '';
    this.shore = '';
  }
}

/** `smoothstep` local, pour éviter une dépendance circulaire de helpers. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
