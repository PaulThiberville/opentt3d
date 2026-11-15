/**
 * Terrain 3D en chunks.
 *
 * Une tuile reste un quad (deux triangles) en basse et moyenne qualité : la
 * géométrie est simplement indexée, avec des sommets partagés à l'intérieur du
 * chunk et des bords identiques de part et d'autre des jonctions. Les facettes
 * disparaissent par le shading, pas par la topologie :
 *
 * - normales de sommets lissées (`computeVertexNormals` sur une grille avec
 *   une couronne de sommets hors chunk, pour que les bords restent cohérents) ;
 * - couleurs par sommet interpolées entre tuiles voisines, avec occlusion
 *   locale calculée depuis les hauteurs ;
 * - peau procédurale dans le matériau : bruit multi-échelles world-space,
 *   blending herbe/terre/roche par pente et altitude, micro-perturbation de
 *   normale atténuée avec la distance (anti-moiré).
 *
 * La haute qualité subdivise chaque tuile (2×2) pour adoucir la silhouette ;
 * la moyenne garde exactement le budget de triangles d'avant #122.
 *
 * L'eau est un second maillage par chunk. Sa surface est posée just sous le
 * dessus de la tuile et le lit est creusé d'un demi-niveau : l'eau reste donc
 * sous les routes, ponts et quais voisins, sans recouvrement coplanaire ni
 * z-fighting. Le shader mélange la teinte selon la profondeur mesurée à la
 * côte, anime la houle et les reflets, et dessine une écume déterministe sur
 * les berges.
 */

import * as THREE from 'three';
import type { MapSnapshot, TileKind } from '../engine/protocol';
import { clamp, isWaterKind, sampleHeightWorld, tileKindFromIndex } from '../game/mapGrid';
import { hashUnit2d } from '../game/prng';
import {
  TERRAIN_SKIN_COLOURS,
  WATER_DEEP_COLOUR,
  WATER_SHALLOW_COLOUR,
  glslLinearColour,
  hexToLinearRgb,
  rgbToHex,
  tileColour,
  waterColourAtDepth,
} from './tileVisuals';
import { qualitySettings, type QualityLevel } from './quality';
import {
  TERRAIN_CHUNK_SIZE,
  TERRAIN_SKIN_BOUNDS,
  glslBound,
  terrainSkinStrength,
  terrainSubdivision,
} from './terrainSurface';
import {
  WATER_SHADER_CONSTANTS,
  buildShoreFields,
  buildWaterHeightFields,
  sampleCornerField,
  sampleField,
  waterBedHeight,
  waterDepthAt,
  waterDepthFactor,
  waterSurfaceHeight,
  type ShoreFields,
  type WaterHeightFields,
} from './waterSurface';

export const CHUNK_SIZE = TERRAIN_CHUNK_SIZE;
/** Demi-pas (en tuiles) utilisé pour l'AO et les dérivées de la peau. */
const AO_STEP = 0.5;

/** Bornes et teintes injectées dans les shaders (une seule source de vérité). */
const SKIN_SHADER_CONSTANTS = `
const vec3 SKIN_EARTH = ${glslLinearColour(TERRAIN_SKIN_COLOURS.earth)};
const vec3 SKIN_ROCK = ${glslLinearColour(TERRAIN_SKIN_COLOURS.rock)};
const vec3 SKIN_ROCK_DARK = ${glslLinearColour(TERRAIN_SKIN_COLOURS.rockDark)};
const vec3 SKIN_SAND = ${glslLinearColour(TERRAIN_SKIN_COLOURS.sand)};
const vec3 SKIN_WET_SAND = ${glslLinearColour(TERRAIN_SKIN_COLOURS.wetSand)};
const vec3 SKIN_BED_SHALLOW = ${glslLinearColour(TERRAIN_SKIN_COLOURS.bedShallow)};
const vec3 SKIN_BED_DEEP = ${glslLinearColour(TERRAIN_SKIN_COLOURS.bedDeep)};
const vec3 SKIN_DRY_GRASS = ${glslLinearColour(TERRAIN_SKIN_COLOURS.dryGrass)};
const vec3 SKY_REFLECTION = ${glslLinearColour(TERRAIN_SKIN_COLOURS.skyReflection)};
const vec3 WATER_SHALLOW = ${glslLinearColour(WATER_SHALLOW_COLOUR)};
const vec3 WATER_DEEP = ${glslLinearColour(WATER_DEEP_COLOUR)};
const float TERRAIN_EARTH_START = ${glslBound(TERRAIN_SKIN_BOUNDS.earthSlope.start)};
const float TERRAIN_EARTH_END = ${glslBound(TERRAIN_SKIN_BOUNDS.earthSlope.end)};
const float TERRAIN_ROCK_START = ${glslBound(TERRAIN_SKIN_BOUNDS.rockSlope.start)};
const float TERRAIN_ROCK_END = ${glslBound(TERRAIN_SKIN_BOUNDS.rockSlope.end)};
const float TERRAIN_ALPINE_START = ${glslBound(TERRAIN_SKIN_BOUNDS.alpine.start)};
const float TERRAIN_ALPINE_END = ${glslBound(TERRAIN_SKIN_BOUNDS.alpine.end)};
const float TERRAIN_ALPINE_WEIGHT = ${glslBound(TERRAIN_SKIN_BOUNDS.alpine.weight)};
const float TERRAIN_SAND_INNER = ${glslBound(TERRAIN_SKIN_BOUNDS.sand.inner)};
const float TERRAIN_SAND_OUTER = ${glslBound(TERRAIN_SKIN_BOUNDS.sand.outer)};
const float TERRAIN_SAND_ALT_START = ${glslBound(TERRAIN_SKIN_BOUNDS.sand.altitudeStart)};
const float TERRAIN_SAND_ALT_END = ${glslBound(TERRAIN_SKIN_BOUNDS.sand.altitudeEnd)};
const float TERRAIN_BUMP_STRENGTH = ${glslBound(TERRAIN_SKIN_BOUNDS.bumpStrength)};
const float TERRAIN_DRY_GRASS = ${glslBound(TERRAIN_SKIN_BOUNDS.dryGrass)};
`;

/**
 * Émission nocturne par type de tuile : les routes, rails et ouvrages restent
 * lisibles à l'échelle carte sans ajouter de géométrie ni de draw call.
 */
const NIGHT_GLOW: Partial<Record<TileKind, readonly [number, number, number]>> = {
  road: [0.14, 0.09, 0.04],
  rail: [0.07, 0.1, 0.14],
  bridge: [0.11, 0.075, 0.035],
  tunnel: [0.04, 0.04, 0.03],
  station: [0.1, 0.075, 0.04],
  airport: [0.06, 0.07, 0.09],
  dock: [0.07, 0.05, 0.025],
  water: [0.015, 0.04, 0.07],
  river: [0.015, 0.04, 0.07],
  canal: [0.015, 0.04, 0.07],
  lock: [0.02, 0.045, 0.075],
  aqueduct: [0.02, 0.03, 0.035],
  crossing: [0.09, 0.05, 0.025],
};

/**
 * Bruit de valeur GLSL, déterministe et sans texture. Les octaves sont
 * volontairement peu nombreuses : le but est une variation de teinte, pas un
 * détail qui scintille au loin.
 */
const SKIN_NOISE_GLSL = `
float skinHash( vec2 p ) {
  // Hash de Dave Hoskins : bien moins directionnel que fract( p * vec2(...) ),
  // ce qui évite les rayures diagonales et le moiré.
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float skinNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = skinHash( i );
  float b = skinHash( i + vec2( 1.0, 0.0 ) );
  float c = skinHash( i + vec2( 0.0, 1.0 ) );
  float d = skinHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
`;

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
  /** Champs de distance côte/terre, recalculés uniquement si les types changent. */
  private shoreFields: ShoreFields | null = null;
  /** Lit/surface par tuile, recalculés dès qu'un type ou une hauteur change. */
  private heightFields: WaterHeightFields | null = null;
  private kindSnapshot: Uint8Array | null = null;
  private heightSnapshot: Uint8Array | null = null;
  private groundMaterial: THREE.MeshLambertMaterial;
  private waterMaterial: THREE.MeshPhongMaterial;
  private waterTime: { value: number } | null = null;
  private nightUniform: { value: number } = { value: 0 };
  private skinUniform: { value: number } = { value: 1 };
  private nightAmount = 0;
  private quality: QualityLevel = 'medium';
  private subdivision = terrainSubdivision('medium');
  private oceanDayColor = new THREE.Color(WATER_DEEP_COLOUR);
  private oceanNightColor = new THREE.Color(0x071a28);
  private elapsed = 0;
  private animateWater = true;
  private chunksX = 0;
  private chunksY = 0;
  /** Compteur de chunks reconstruits (diagnostic/tests). */
  chunksBuilt = 0;
  /** Nombre de calculs du champ de distance côte/terre (diagnostic/tests). */
  shoreFieldBuilds = 0;
  private ocean: THREE.Mesh;
  private oceanGeometry: THREE.PlaneGeometry;
  private oceanMaterial: THREE.MeshBasicMaterial;

  constructor() {
    this.group.name = 'terrain';
    this.groundMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false });
    this.groundMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.nightUniform;
      shader.uniforms.uSkin = this.skinUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aAo;
attribute float aShore;
attribute float aDepth;
attribute vec3 aNightGlow;
varying vec3 vNightGlow;
varying float vAo;
varying float vShore;
varying float vWaterDepth;
varying vec3 vSkinWorld;
varying vec3 vSkinNormal;
varying float vSkinDistance;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
  vSkinNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  vec4 skinWorld = modelMatrix * vec4( transformed, 1.0 );
  vSkinWorld = skinWorld.xyz;
  vSkinDistance = -( modelViewMatrix * vec4( transformed, 1.0 ) ).z;
  vAo = aAo;
  vShore = aShore;
  vWaterDepth = aDepth;
  vNightGlow = aNightGlow;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uNight;
uniform float uSkin;
varying vec3 vNightGlow;
varying float vAo;
varying float vShore;
varying float vWaterDepth;
varying vec3 vSkinWorld;
varying vec3 vSkinNormal;
varying float vSkinDistance;
${SKIN_NOISE_GLSL}
${SKIN_SHADER_CONSTANTS}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  float skinFade = 1.0 - smoothstep( 70.0, 210.0, vSkinDistance );
  vec3 skinNormalWorld = normalize( vSkinNormal );
  float skinSlope = clamp( 1.0 - skinNormalWorld.y, 0.0, 1.0 );
  float skinMacro = skinNoise( vSkinWorld.xz * 0.11 + 4.7 ) - 0.5;
  float skinMeso = skinNoise( vSkinWorld.xz * 0.37 - 1.9 ) - 0.5;
  float skinFine = ( skinNoise( vSkinWorld.xz * 1.15 + 9.3 ) - 0.5 ) * skinFade;
  float skinSubmerged = smoothstep( 0.0, 0.08, vWaterDepth );
  float skinLand = 1.0 - skinSubmerged;

  // Bruit de pente : les transitions ne suivent pas des courbes de niveau.
  float skinSlopeNoise = skinMacro * 0.18;
  float skinRock = smoothstep(
      TERRAIN_ROCK_START,
      TERRAIN_ROCK_END,
      skinSlope + skinSlopeNoise
    )
    + smoothstep( TERRAIN_ALPINE_START, TERRAIN_ALPINE_END, vSkinWorld.y ) * TERRAIN_ALPINE_WEIGHT;
  skinRock = clamp( skinRock, 0.0, 1.0 );
  float skinEarth = smoothstep(
      TERRAIN_EARTH_START,
      TERRAIN_EARTH_END,
      skinSlope + skinSlopeNoise
    ) * ( 1.0 - skinRock );

  // Plages et berges : sable au ras de l'eau, sable mouillé au contact.
  float skinShore = max( 0.0, vShore ) + skinMeso * 0.85;
  float skinSand = ( 1.0 - smoothstep( TERRAIN_SAND_INNER, TERRAIN_SAND_OUTER, skinShore ) )
    * ( 1.0 - smoothstep( TERRAIN_SAND_ALT_START, TERRAIN_SAND_ALT_END, vSkinWorld.y ) )
    * skinLand;
  float skinWet = skinSand * ( 1.0 - smoothstep( 0.06, 0.95, max( 0.0, vShore ) ) );
  float skinLandMask = ( 1.0 - skinSand ) * skinLand;
  skinEarth *= skinLandMask;
  skinRock *= skinLandMask;

  // Variation de teinte et de rugosité perçue (le Lambert n'a pas de roughness).
  diffuseColor.rgb *= 1.0 + ( skinMeso * 0.08 + skinFine * 0.06 ) * uSkin;

  // Plaques d'herbe sèche, minoritaires : cassent l'aplat sans virer au beige.
  float skinDry = smoothstep(
      0.58, 0.9, skinNoise( vSkinWorld.xz * 0.085 + 21.0 )
    ) * TERRAIN_DRY_GRASS * skinLandMask;
  diffuseColor.rgb = mix( diffuseColor.rgb, SKIN_DRY_GRASS, skinDry * uSkin );

  // Terre : brune et mate, jamais grise.
  vec3 skinEarthTint = SKIN_EARTH * ( 0.9 + skinFine * 0.22 );
  diffuseColor.rgb = mix( diffuseColor.rgb, skinEarthTint, skinEarth * 0.5 * uSkin );

  // Roche : strates verticales discrètes, plus sombres dans les creux.
  float skinStrata = 0.5 + 0.5 * sin( vSkinWorld.y * 17.0 + skinMacro * 6.0 );
  vec3 skinRockTint = mix( SKIN_ROCK_DARK, SKIN_ROCK, skinStrata );
  skinRockTint *= 0.9 + skinMeso * 0.18;
  diffuseColor.rgb = mix( diffuseColor.rgb, skinRockTint, skinRock * 0.78 * uSkin );

  // Sable clair puis sable mouillé, en bande continue le long des côtes.
  vec3 skinSandTint = SKIN_SAND * ( 0.94 + skinFine * 0.12 );
  diffuseColor.rgb = mix( diffuseColor.rgb, skinSandTint, skinSand * 0.84 * uSkin );
  diffuseColor.rgb = mix( diffuseColor.rgb, SKIN_WET_SAND, skinWet * 0.4 * uSkin );

  // Lit sous l'eau : sombre au large, sableux près de la rive.
  vec3 skinBed = mix( SKIN_BED_SHALLOW, SKIN_BED_DEEP, smoothstep( 0.02, 0.65, vWaterDepth ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, skinBed, skinSubmerged * 0.92 );

  // Creux légèrement assombris, reliefs intacts.
  diffuseColor.rgb *= mix( 1.0, vAo, 0.65 * uSkin );
  diffuseColor.rgb = max( diffuseColor.rgb, vec3( 0.0 ) );`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
  float bumpSlope = clamp( 1.0 - normalize( vSkinNormal ).y, 0.0, 1.0 );
  float bumpFade = ( 1.0 - smoothstep( 38.0, 130.0, vSkinDistance ) )
    * ( 1.0 - smoothstep( 0.34, 0.78, bumpSlope ) )
    * ( 1.0 - smoothstep( 0.0, 0.08, vWaterDepth ) );
  float bumpHeight = skinNoise( vSkinWorld.xz * 2.6 ) * 0.55
    + skinNoise( vSkinWorld.xz * 6.1 + 5.0 ) * 0.32
    + skinNoise( vSkinWorld.xz * 0.85 + 2.0 ) * 0.13;
  vec2 bumpGrad = clamp(
    vec2( dFdx( bumpHeight ), dFdy( bumpHeight ) ) * 16.0,
    vec2( -0.45 ),
    vec2( 0.45 )
  );
  vec3 bumpView = mat3( viewMatrix ) * vec3( -bumpGrad.x, 0.0, -bumpGrad.y );
  normal = normalize( normal + bumpView * TERRAIN_BUMP_STRENGTH * uSkin * bumpFade );`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  totalEmissiveRadiance += vNightGlow * uNight;`,
        );
    };
    this.groundMaterial.customProgramCacheKey = () => 'opentt3d-terrain-skin-v4';
    this.waterMaterial = this.createWaterMaterial();
    // Fond océanique : masque la découpe de la carte et donne une île crédible.
    this.oceanGeometry = new THREE.PlaneGeometry(1, 1);
    this.oceanGeometry.rotateX(-Math.PI / 2);
    this.oceanMaterial = new THREE.MeshBasicMaterial({ color: WATER_DEEP_COLOUR, fog: true });
    this.ocean = new THREE.Mesh(this.oceanGeometry, this.oceanMaterial);
    this.ocean.name = 'ocean-backdrop';
    // Sous le lit de l'eau : le fond opaque ne doit jamais masquer la
    // bathymétrie réelle à travers la surface transparente.
    this.ocean.position.y = waterBedHeight(0) - 0.25;
    this.ocean.frustumCulled = false;
    this.group.add(this.ocean);
    this.setQuality('medium');
  }

  get mapSnapshot(): MapSnapshot | null {
    return this.map;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  /** Subdivision courante (1 en basse/moyenne, 2 en haute). */
  get tileSubdivision(): number {
    return this.subdivision;
  }

  /** Qualité courante appliquée à la peau. */
  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  private createWaterMaterial(): THREE.MeshPhongMaterial {
    const material = new THREE.MeshPhongMaterial({
      // Les teintes viennent des sommets (rampe de profondeur) et du shader.
      color: 0xffffff,
      vertexColors: true,
      specular: 0xbfe8ff,
      shininess: 120,
      side: THREE.FrontSide,
      // L'eau laisse voir le lit : alpha mélangé, sans écriture de profondeur
      // (le test de profondeur reste actif pour ne pas traverser les ponts).
      transparent: true,
      depthWrite: false,
      // Biais poussé *derrière* le terrain : à profondeur égale, c'est toujours
      // la terre sèche qui gagne. Le lit étant 0,62 sous la surface, ce biais
      // ne sert qu'aux cas extrêmes (arêtes rasant la surface).
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterTime ?? { value: 0 };
      shader.uniforms.uNight = this.nightUniform;
      this.waterTime = shader.uniforms.uTime as { value: number };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uTime;
attribute float aDepth;
varying vec3 vWaterWorld;
varying float vWaterDepth;
varying float vWaterDistance;
${WATER_SHADER_CONSTANTS}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float waterWave = sin( uTime * 1.35 + position.x * 0.55 + position.z * 0.42 ) * 0.6
             + sin( uTime * 2.2 + position.x * 1.7 - position.z * 1.1 ) * 0.28
             + sin( uTime * 0.8 - position.x * 0.35 + position.z * 0.9 ) * 0.12;
           transformed.y += waterWave * WATER_WAVE_AMPLITUDE;
           vWaterWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
           vWaterDistance = -( modelViewMatrix * vec4( transformed, 1.0 ) ).z;
           vWaterDepth = aDepth;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uTime;
uniform float uNight;
varying vec3 vWaterWorld;
varying float vWaterDepth;
varying float vWaterDistance;
${WATER_SHADER_CONSTANTS}
${SKIN_SHADER_CONSTANTS}
${SKIN_NOISE_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float waveA = sin( uTime * 1.15 + vWaterWorld.x * 0.55 + vWaterWorld.z * 0.45 );
           float waveB = sin( uTime * 0.7 - vWaterWorld.x * 0.2 + vWaterWorld.z * 0.35 );
           // Teinte par profondeur : turquoise au bord, bleu nuit au large.
           vec3 depthTint = mix(
             WATER_SHALLOW,
             WATER_DEEP,
             smoothstep( 0.05, 0.9, vWaterDepth )
           );
           diffuseColor.rgb = mix( diffuseColor.rgb, depthTint, 0.55 );
           diffuseColor.rgb *= 1.0 + waveA * 0.045 + waveB * 0.03;

           // Écume de côte : bruit animé, atténué avec la distance.
           float shoreFoam = 1.0 - smoothstep( 0.0, WATER_FOAM_DEPTH, vWaterDepth );
           float foamNoise = skinNoise( vec2(
             vWaterWorld.x * WATER_RIPPLE_SCALE + uTime * 0.35,
             vWaterWorld.z * WATER_RIPPLE_SCALE - uTime * 0.27
           ) );
           float foamFade = 1.0 - smoothstep(
             WATER_RIPPLE_FADE_NEAR,
             WATER_RIPPLE_FADE_FAR,
             vWaterDistance
           );
           float foam = shoreFoam * smoothstep( 0.42, 0.78, foamNoise + 0.18 ) * foamFade;
           diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.82, 0.84 ), foam * 0.38 );
           diffuseColor.a = mix( 0.78, 0.93, smoothstep( 0.0, 0.7, vWaterDepth ) );
           diffuseColor.a = mix( diffuseColor.a, 0.97, foam );`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
           // Clapot de normale : reflets animés sans scintillement lointain.
           float rippleFade = 1.0 - smoothstep(
             WATER_RIPPLE_FADE_NEAR,
             WATER_RIPPLE_FADE_FAR,
             vWaterDistance
           );
           vec2 ripples = vWaterWorld.xz;
           float rippleX = cos( ripples.x * 1.9 + uTime * 1.5 ) * 0.11
             + cos( ripples.x * 3.7 - ripples.y * 2.3 + uTime * 2.1 ) * 0.05;
           float rippleZ = cos( ripples.y * 2.2 - uTime * 1.2 ) * 0.10
             + cos( ripples.y * 4.1 + ripples.x * 1.7 - uTime * 1.8 ) * 0.04;
           vec3 waterNormalWorld = normalize( vec3(
             -rippleX * rippleFade,
             1.0,
             -rippleZ * rippleFade
           ) );
           normal = normalize( mat3( viewMatrix ) * waterNormalWorld );`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // Reflet de ciel léger, plus marqué à incidence rasante.
           vec3 waterView = normalize( cameraPosition - vWaterWorld );
           float fresnel = pow( 1.0 - clamp( dot( vec3( 0.0, 1.0, 0.0 ), waterView ), 0.0, 1.0 ), 3.0 );
           totalEmissiveRadiance += SKY_REFLECTION * fresnel * 0.12;
           totalEmissiveRadiance += vec3( 0.035, 0.075, 0.13 ) * uNight;`,
        );
    };
    material.customProgramCacheKey = () => 'opentt3d-water-depth-v2';
    return material;
  }

  /** Applique une carte complète (premier snapshot ou changement de carte). */
  setMap(map: MapSnapshot): void {
    const sizeChanged = !this.map || this.map.width !== map.width || this.map.height !== map.height;
    this.map = map;
    if (sizeChanged) {
      this.refreshDerivedFields(map);
      this.disposeChunks();
      this.chunksX = Math.ceil(map.width / CHUNK_SIZE);
      this.chunksY = Math.ceil(map.height / CHUNK_SIZE);
      this.ocean.scale.set(map.width * 6, 1, map.height * 6);
      this.ocean.position.set(map.width / 2, waterBedHeight(0) - 0.25, map.height / 2);
      this.previous = null;
      this.subdivision = this.resolveSubdivision();
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
    this.refreshDerivedFields(map);
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

  /**
   * Recalcule les champs dérivés de la carte.
   *
   * - distances côte/terre : uniquement si un type de tuile a changé ;
   * - lit et surface : si un type **ou une hauteur** a changé, car une tuile
   *   d'eau creusée ou remblayée doit déplacer sa surface sans z-fighting.
   */
  private refreshDerivedFields(map: MapSnapshot): void {
    const previousKinds = this.kindSnapshot;
    const previousHeights = this.heightSnapshot;
    let kindsSame = previousKinds !== null && previousKinds.length === map.kind.length;
    let heightsSame = previousHeights !== null && previousHeights.length === map.heightMap.length;
    let waterChanged = false;
    if (kindsSame || heightsSame) {
      for (let index = 0; index < map.kind.length; index += 1) {
        const kind = map.kind[index] ?? 0;
        if (kindsSame && kind !== previousKinds?.[index]) {
          kindsSame = false;
          const wasWater = isWaterKind(tileKindFromIndex(previousKinds?.[index] ?? 0));
          const isWater = isWaterKind(tileKindFromIndex(kind));
          if (wasWater !== isWater) waterChanged = true;
        }
        if (heightsSame && map.heightMap[index] !== previousHeights?.[index]) heightsSame = false;
        if (!kindsSame && !heightsSame && waterChanged) break;
      }
    }
    if (kindsSame && heightsSame) return;
    // Le lit dépend des types (eau ou sec) autant que des hauteurs ; une route
    // posée sur la terre ferme ne doit pas réallouer trois champs.
    if (waterChanged || !heightsSame || !this.heightFields) {
      this.heightFields = buildWaterHeightFields(map);
    }
    if (!kindsSame) {
      this.shoreFields = buildShoreFields(map);
      this.kindSnapshot = map.kind.slice();
      this.shoreFieldBuilds += 1;
    }
    this.heightSnapshot = map.heightMap.slice();
  }

  /**
   * Un chunk dépend d'une couronne d'une tuile : les hauteurs de coin, les
   * couleurs interpolées et l'eau de bord lisent les tuiles voisines. Sans
   * cette marge, modifier une tuile en bord de chunk laisserait une fissure
   * ou une couleur figée sur le chunk d'à côté.
   */
  private chunkDiffers(map: MapSnapshot, previous: MapArrays, cx: number, cy: number): boolean {
    const x0 = Math.max(0, cx * CHUNK_SIZE - 1);
    const y0 = Math.max(0, cy * CHUNK_SIZE - 1);
    const x1 = Math.min(map.width, (cx + 1) * CHUNK_SIZE + 1);
    const y1 = Math.min(map.height, (cy + 1) * CHUNK_SIZE + 1);
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
    const shoreFields = this.shoreFields;
    const heightFields = this.heightFields;
    if (!shoreFields || !heightFields) return;
    this.chunksBuilt += 1;
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

    const subdivision = this.subdivision;
    const invSubdivision = 1 / subdivision;
    const nx = width * subdivision + 1;
    const nz = height * subdivision + 1;
    const vertexCount = nx * nz;
    const positions = new Float32Array(vertexCount * 3);
    const colours = new Float32Array(vertexCount * 3);
    const nightColours = new Float32Array(vertexCount * 3);
    const occlusion = new Float32Array(vertexCount);
    const shoreValues = new Float32Array(vertexCount);
    const waterDepths = new Float32Array(vertexCount);

    // Couleurs et émissions par tuile, avec une couronne d'une tuile : les
    // sommets de bord interpolent ainsi exactement les mêmes valeurs de part
    // et d'autre d'un chunk.
    const haloW = width + 2;
    const haloH = height + 2;
    const haloR = new Float32Array(haloW * haloH);
    const haloG = new Float32Array(haloW * haloH);
    const haloB = new Float32Array(haloW * haloH);
    const haloGlowR = new Float32Array(haloW * haloH);
    const haloGlowG = new Float32Array(haloW * haloH);
    const haloGlowB = new Float32Array(haloW * haloH);
    const rgb = { r: 0, g: 0, b: 0 };
    for (let hy = 0; hy < haloH; hy += 1) {
      const ty = clamp(y0 + hy - 1, 0, map.height - 1);
      for (let hx = 0; hx < haloW; hx += 1) {
        const tx = clamp(x0 + hx - 1, 0, map.width - 1);
        const index = ty * map.width + tx;
        const kind = tileKindFromIndex(map.kind[index] ?? 0);
        const level = map.heightMap[index] ?? 0;
        const steepness = map.slope[index] ?? 0;
        const colour = tileColour(kind, level, steepness, map.width);
        // Très légère variation par tuile : casse la régularité sans créer
        // d'aplat visible, le bruit fin étant ajouté par le shader.
        const shade = 0.986 + hashUnit2d(map.width + 7, tx, ty) * 0.028;
        hexToLinearRgb(
          rgbToHex(
            ((colour >> 16) & 0xff) * shade,
            ((colour >> 8) & 0xff) * shade,
            (colour & 0xff) * shade,
          ),
          rgb,
        );
        const slot = hy * haloW + hx;
        haloR[slot] = rgb.r;
        haloG[slot] = rgb.g;
        haloB[slot] = rgb.b;
        const glow = NIGHT_GLOW[kind];
        haloGlowR[slot] = glow?.[0] ?? 0;
        haloGlowG[slot] = glow?.[1] ?? 0;
        haloGlowB[slot] = glow?.[2] ?? 0;
      }
    }

    // Lit rendu : les tuiles d'eau sont creusées, les autres gardent leur
    // dessus. L'échantillonnage est identique à `sampleHeightWorld` (mêmes
    // coins, même bilinéaire), donc aucune couture aux jonctions de chunks.
    const bedAt = (x: number, z: number): number =>
      sampleCornerField(heightFields.bed, map.width, map.height, x, z);

    let vertex = 0;
    for (let gz = 0; gz < nz; gz += 1) {
      const tileZ = gz * invSubdivision;
      const z = y0 + tileZ;
      const cellY = Math.floor(tileZ - 0.5);
      const fz = tileZ - 0.5 - cellY;
      const rowA = cellY + 1;
      const rowB = rowA + 1;
      const wRowA = 1 - fz;
      for (let gx = 0; gx < nx; gx += 1) {
        const tileX = gx * invSubdivision;
        const x = x0 + tileX;
        const cellX = Math.floor(tileX - 0.5);
        const fx = tileX - 0.5 - cellX;
        const colA = cellX + 1;
        const colB = colA + 1;
        const wColA = 1 - fx;

        const i00 = rowA * haloW + colA;
        const i10 = rowA * haloW + colB;
        const i01 = rowB * haloW + colA;
        const i11 = rowB * haloW + colB;
        const w00 = wColA * wRowA;
        const w10 = fx * wRowA;
        const w01 = wColA * fz;
        const w11 = fx * fz;
        const r =
          (haloR[i00] ?? 0) * w00 +
          (haloR[i10] ?? 0) * w10 +
          (haloR[i01] ?? 0) * w01 +
          (haloR[i11] ?? 0) * w11;
        const g =
          (haloG[i00] ?? 0) * w00 +
          (haloG[i10] ?? 0) * w10 +
          (haloG[i01] ?? 0) * w01 +
          (haloG[i11] ?? 0) * w11;
        const b =
          (haloB[i00] ?? 0) * w00 +
          (haloB[i10] ?? 0) * w10 +
          (haloB[i01] ?? 0) * w01 +
          (haloB[i11] ?? 0) * w11;

        const height = bedAt(x, z);
        const base = vertex * 3;
        positions[base] = x;
        positions[base + 1] = height;
        positions[base + 2] = z;
        colours[base] = r;
        colours[base + 1] = g;
        colours[base + 2] = b;
        nightColours[base] = Math.max(
          haloGlowR[i00] ?? 0,
          haloGlowR[i10] ?? 0,
          haloGlowR[i01] ?? 0,
          haloGlowR[i11] ?? 0,
        );
        nightColours[base + 1] = Math.max(
          haloGlowG[i00] ?? 0,
          haloGlowG[i10] ?? 0,
          haloGlowG[i01] ?? 0,
          haloGlowG[i11] ?? 0,
        );
        nightColours[base + 2] = Math.max(
          haloGlowB[i00] ?? 0,
          haloGlowB[i10] ?? 0,
          haloGlowB[i01] ?? 0,
          haloGlowB[i11] ?? 0,
        );

        // AO locale : un creux (sommet plus bas que ses voisins) s'assombrit.
        const average =
          (bedAt(x - AO_STEP, z) +
            bedAt(x + AO_STEP, z) +
            bedAt(x, z - AO_STEP) +
            bedAt(x, z + AO_STEP)) *
          0.25;
        const concavity = Math.max(0, average - height);
        occlusion[vertex] = Math.max(0.58, 1 - concavity * 0.85);

        // Distance à l'eau pour la plage, et profondeur réelle du lit sous la
        // surface voisine. Une tuile sèche (route, quai, berge) renvoie 0 :
        // elle ne reçoit jamais la teinte du fond sous-marin.
        shoreValues[vertex] = sampleField(shoreFields.landDistance, map.width, map.height, x, z);
        waterDepths[vertex] = waterDepthAt(heightFields, map.width, map.height, x, z, height);
        vertex += 1;
      }
    }

    const indexCount = width * height * subdivision * subdivision * 6;
    const indices =
      vertexCount > 65_535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let cursor = 0;
    for (let gz = 0; gz < nz - 1; gz += 1) {
      for (let gx = 0; gx < nx - 1; gx += 1) {
        const a = gz * nx + gx;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        // Même diagonale et même sens que l'ancien maillage non indexé.
        indices[cursor] = a;
        indices[cursor + 1] = d;
        indices[cursor + 2] = b;
        indices[cursor + 3] = a;
        indices[cursor + 4] = c;
        indices[cursor + 5] = d;
        cursor += 6;
      }
    }

    const normals = this.computeChunkNormals(map, heightFields, x0, y0, nx, nz, invSubdivision);

    const groundGeometry = new THREE.BufferGeometry();
    groundGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    groundGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    groundGeometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    groundGeometry.setAttribute('aNightGlow', new THREE.BufferAttribute(nightColours, 3));
    groundGeometry.setAttribute('aAo', new THREE.BufferAttribute(occlusion, 1));
    groundGeometry.setAttribute('aShore', new THREE.BufferAttribute(shoreValues, 1));
    groundGeometry.setAttribute('aDepth', new THREE.BufferAttribute(waterDepths, 1));
    groundGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
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
      const waterDepthValues = new Float32Array(waterTiles * 6);
      let waterVertex = 0;
      const waterRgb = { r: 0, g: 0, b: 0 };
      for (let ty = 0; ty < height; ty += 1) {
        for (let tx = 0; tx < width; tx += 1) {
          const wx = x0 + tx;
          const wy = y0 + ty;
          const index = wy * map.width + wx;
          if (!isWaterKind(tileKindFromIndex(map.kind[index] ?? 0))) continue;
          const surface = waterSurfaceHeight(map.heightMap[index] ?? 0);
          const write = (x: number, z: number): void => {
            const depth = waterDepthFactor(
              sampleField(shoreFields.waterDistance, map.width, map.height, x, z),
            );
            const base = waterColourAtDepth(depth, wx * 31 + wy);
            const shimmer = 0.975 + hashUnit2d(wx, wy, 91) * 0.05;
            hexToLinearRgb(
              rgbToHex(
                ((base >> 16) & 0xff) * shimmer,
                ((base >> 8) & 0xff) * shimmer,
                (base & 0xff) * shimmer,
              ),
              waterRgb,
            );
            waterPositions[waterVertex * 3] = x;
            waterPositions[waterVertex * 3 + 1] = surface;
            waterPositions[waterVertex * 3 + 2] = z;
            waterColours[waterVertex * 3] = waterRgb.r;
            waterColours[waterVertex * 3 + 1] = waterRgb.g;
            waterColours[waterVertex * 3 + 2] = waterRgb.b;
            waterDepthValues[waterVertex] = depth;
            waterVertex += 1;
          };
          write(wx, wy);
          write(wx + 1, wy + 1);
          write(wx + 1, wy);
          write(wx, wy);
          write(wx, wy + 1);
          write(wx + 1, wy + 1);
        }
      }
      const waterGeometry = new THREE.BufferGeometry();
      waterGeometry.setAttribute('position', new THREE.BufferAttribute(waterPositions, 3));
      waterGeometry.setAttribute('color', new THREE.BufferAttribute(waterColours, 3));
      waterGeometry.setAttribute('aDepth', new THREE.BufferAttribute(waterDepthValues, 1));
      waterGeometry.computeVertexNormals();
      waterGeometry.computeBoundingSphere();
      water = new THREE.Mesh(waterGeometry, this.waterMaterial);
      water.name = `water-${cx}-${cy}`;
      water.receiveShadow = false;
      water.renderOrder = 2;
      this.group.add(water);
    }

    this.chunks.set(key, { cx, cy, ground, water });
  }

  /**
   * Normales lissées par `computeVertexNormals` sur une grille entourée d'une
   * couronne d'un pas. Les sommets de bord d'un chunk voient ainsi exactement
   * les mêmes faces que son voisin : aucune couture d'éclairage à la jonction.
   */
  private computeChunkNormals(
    map: MapSnapshot,
    heightFields: WaterHeightFields,
    x0: number,
    y0: number,
    nx: number,
    nz: number,
    invSubdivision: number,
  ): Float32Array {
    const haloNx = nx + 2;
    const haloNz = nz + 2;
    const haloPositions = new Float32Array(haloNx * haloNz * 3);
    for (let hz = 0; hz < haloNz; hz += 1) {
      const z = clamp(y0 + (hz - 1) * invSubdivision, 0, map.height);
      for (let hx = 0; hx < haloNx; hx += 1) {
        const x = clamp(x0 + (hx - 1) * invSubdivision, 0, map.width);
        const offset = (hz * haloNx + hx) * 3;
        haloPositions[offset] = x;
        haloPositions[offset + 1] = sampleCornerField(
          heightFields.bed,
          map.width,
          map.height,
          x,
          z,
        );
        haloPositions[offset + 2] = z;
      }
    }
    const cellCount = (haloNx - 1) * (haloNz - 1);
    const haloIndices =
      haloNx * haloNz > 65_535 ? new Uint32Array(cellCount * 6) : new Uint16Array(cellCount * 6);
    let cursor = 0;
    for (let hz = 0; hz < haloNz - 1; hz += 1) {
      for (let hx = 0; hx < haloNx - 1; hx += 1) {
        const a = hz * haloNx + hx;
        const b = a + 1;
        const c = a + haloNx;
        const d = c + 1;
        haloIndices[cursor] = a;
        haloIndices[cursor + 1] = d;
        haloIndices[cursor + 2] = b;
        haloIndices[cursor + 3] = a;
        haloIndices[cursor + 4] = c;
        haloIndices[cursor + 5] = d;
        cursor += 6;
      }
    }
    const haloGeometry = new THREE.BufferGeometry();
    haloGeometry.setAttribute('position', new THREE.BufferAttribute(haloPositions, 3));
    haloGeometry.setIndex(new THREE.BufferAttribute(haloIndices, 1));
    haloGeometry.computeVertexNormals();
    const haloNormals = haloGeometry.getAttribute('normal').array;
    const normals = new Float32Array(nx * nz * 3);
    for (let gz = 0; gz < nz; gz += 1) {
      for (let gx = 0; gx < nx; gx += 1) {
        const source = ((gz + 1) * haloNx + (gx + 1)) * 3;
        const target = (gz * nx + gx) * 3;
        normals[target] = haloNormals[source] ?? 0;
        normals[target + 1] = haloNormals[source + 1] ?? 1;
        normals[target + 2] = haloNormals[source + 2] ?? 0;
      }
    }
    haloGeometry.dispose();
    return normals;
  }

  /** Maillages ciblables au raycast (exclut le fond océanique). */
  pickTargets(): THREE.Object3D[] {
    const meshes: THREE.Object3D[] = [];
    for (const chunk of this.chunks.values()) meshes.push(chunk.ground);
    return meshes;
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
    this.quality = level;
    const settings = qualitySettings(level);
    this.animateWater = settings.waterAnimation;
    if (!this.animateWater && this.waterTime) this.waterTime.value = 0;
    this.groundMaterial.dithering = level !== 'low';
    this.skinUniform.value = terrainSkinStrength(level);
    this.waterMaterial.shininess =
      settings.level === 'low' ? 40 : settings.level === 'high' ? 130 : 90;
    const subdivision = this.resolveSubdivision();
    if (subdivision !== this.subdivision) {
      this.subdivision = subdivision;
      if (this.map) this.rebuildAll();
    }
  }

  /** Subdivision applicable à la carte courante (adaptative en haute qualité). */
  private resolveSubdivision(): number {
    const tiles = this.map ? this.map.width * this.map.height : 0;
    return terrainSubdivision(this.quality, tiles);
  }

  /** 0 = jour, 1 = nuit : active l'émission des routes, rails et de l'eau. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.nightUniform.value = this.nightAmount;
    this.oceanMaterial.color.copy(this.oceanDayColor).lerp(this.oceanNightColor, this.nightAmount);
  }

  get night(): number {
    return this.nightAmount;
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
    this.group.remove(this.ocean);
    this.oceanGeometry.dispose();
    this.oceanMaterial.dispose();
    this.groundMaterial.dispose();
    this.waterMaterial.dispose();
    this.map = null;
    this.previous = null;
    this.shoreFields = null;
    this.heightFields = null;
    this.kindSnapshot = null;
    this.heightSnapshot = null;
  }
}
