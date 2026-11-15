/**
 * Atmosphère et vie du monde : ciel gradué, nuages, faune, lumières de nuit,
 * météo optionnelle et poussière de chantier.
 *
 * Toutes les particules sont des `THREE.Points` à capacité fixe (jamais un mesh
 * par particule) : les buffers sont alloués une fois au constructeur, puis
 * réécrits en place chaque frame. Aucune géométrie, matériau ou texture n'est
 * créé pendant `update`, et `dispose` libère l'intégralité des ressources.
 *
 * Les budgets dépendent du preset de qualité : rien d'animé en `low`, un
 * sous-ensemble borné en `medium`, le maximum en `high`. `prefers-reduced-motion`
 * coupe toutes les particules animées (les nuages restent figés) ; la météo est
 * désactivée par défaut et n'est jamais animée sous reduced motion.
 *
 * Aucun asset binaire : les textures de nuage sont générées en canvas à
 * l'exécution (absentes sous Node, où les matériaux restent valides).
 */

import * as THREE from 'three';
import type { MapSnapshot, StationSnapshot, TownSnapshot } from '../engine/protocol';
import { TILE_KIND_INDEX } from '../engine/protocol';
import { sampleHeightWorld } from '../game/mapGrid';
import { Prng } from '../game/prng';
import { sunState } from './dayNight';
import type { QualityLevel } from './quality';

export type WeatherKind = 'clear' | 'rain' | 'snow';

export interface AtmosphereBudget {
  /** Dôme de ciel gradué (1 draw call). */
  skyDome: boolean;
  clouds: number;
  birds: number;
  butterflies: number;
  nightLights: number;
  rain: number;
  snow: number;
  dust: number;
}

/**
 * Budgets par preset. Les capacités GPU allouées valent le maximum `high` :
 * changer de qualité ne réalloue donc jamais de buffer, seul le `drawRange`
 * (ou la visibilité) change.
 */
export const ATMOSPHERE_BUDGETS: Record<QualityLevel, AtmosphereBudget> = {
  low: {
    skyDome: false,
    clouds: 0,
    birds: 0,
    butterflies: 0,
    nightLights: 0,
    rain: 0,
    snow: 0,
    dust: 0,
  },
  medium: {
    skyDome: true,
    clouds: 72,
    birds: 24,
    butterflies: 24,
    nightLights: 32,
    rain: 400,
    snow: 300,
    dust: 32,
  },
  high: {
    skyDome: true,
    clouds: 120,
    birds: 48,
    butterflies: 48,
    nightLights: 64,
    rain: 800,
    snow: 600,
    dust: 64,
  },
};

/** Capacité maximale allouée, indépendante du preset courant. */
const MAX = ATMOSPHERE_BUDGETS.high;

const DOME_RADIUS = 380;
const CLOUD_RADIUS = 360;
const CLOUD_MIN_RADIUS = 210;
const CLOUD_MIN_Y = 92;
const CLOUD_MAX_Y = 166;
const WIND_SPEED = 2.4;
const BIRD_HEIGHT = 7;
const NIGHT_LIGHT_HEIGHT = 2.2;
const RAIN_BOX_XZ = 46;
const RAIN_BOX_Y = 34;
const DUST_RADIUS = 2.2;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

interface Habitat {
  x: number;
  z: number;
  ground: number;
  radius: number;
  /** 0 = ville, 1 = forêt. */
  kind: 0 | 1;
}

interface LightAnchor {
  x: number;
  y: number;
  z: number;
  strength: number;
}

interface ConstructionSite {
  x: number;
  z: number;
  ground: number;
}

const DOME_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAGMENT = /* glsl */ `
  uniform vec3 uSky;
  uniform vec3 uFog;
  uniform vec3 uSun;
  uniform vec3 uSunDirection;
  uniform float uSunGlow;
  varying vec3 vDirection;
  void main() {
    vec3 direction = normalize(vDirection);
    float height = clamp(direction.y * 1.7 + 0.04, -1.0, 1.0);
    vec3 colour = mix(uFog, uSky, smoothstep(-0.06, 0.62, height));
    // Bande horizon : la brume se fond dans le ciel bas.
    colour = mix(colour, uFog, smoothstep(0.16, -0.02, height) * 0.32);
    float sun = max(dot(direction, normalize(uSunDirection)), 0.0);
    colour += uSun * pow(sun, 260.0) * uSunGlow * 1.35;
    colour += uSun * pow(sun, 10.0) * uSunGlow * 0.16;
    gl_FragColor = vec4(colour, 1.0);
  }
`;

/** Sprite procédural généré à l'exécution (aucun asset binaire). */
function createSpriteTexture(kind: 'cloud' | 'snow' | 'bird' | 'butterfly'): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.clearRect(0, 0, size, size);
  const half = size / 2;
  if (kind === 'cloud') {
    // Trois disques diffus : une bouffée de nuage irrégulière mais lisible.
    const blobs: [number, number, number][] = [
      [half, half, half * 0.82],
      [half * 0.62, half * 0.58, half * 0.6],
      [half * 1.28, half * 0.64, half * 0.52],
    ];
    for (const [x, y, radius] of blobs) {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
      gradient.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    }
  } else if (kind === 'bird') {
    // Silhouette en V : deux ailes fines, corps central discret.
    context.strokeStyle = 'rgba(255,255,255,0.98)';
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(half * 0.35, half * 0.62);
    context.quadraticCurveTo(half * 0.68, half * 0.38, half, half * 0.58);
    context.quadraticCurveTo(half * 1.32, half * 0.38, half * 1.65, half * 0.62);
    context.stroke();
  } else if (kind === 'butterfly') {
    context.fillStyle = 'rgba(255,255,255,0.96)';
    for (const side of [-1, 1]) {
      context.beginPath();
      context.ellipse(
        half + side * half * 0.36,
        half * 0.72,
        half * 0.42,
        half * 0.3,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.beginPath();
      context.ellipse(
        half + side * half * 0.28,
        half * 1.24,
        half * 0.3,
        half * 0.22,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  } else {
    const gradient = context.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Empreinte stable des données qui positionnent la faune et les lumières :
 * carte (échantillonnée), villes, gares et preset.
 */
export function computeAtmosphereSignature(
  map: MapSnapshot | null,
  towns: readonly TownSnapshot[],
  stations: readonly StationSnapshot[],
  level: QualityLevel,
): number {
  let hash = FNV_OFFSET;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ (value | 0), FNV_PRIME) >>> 0;
  };
  mix(level.length);
  for (let index = 0; index < level.length; index += 1) mix(level.charCodeAt(index));
  mix(towns.length);
  for (const town of towns) {
    mix(town.id);
    mix(Math.round(town.x * 16));
    mix(Math.round(town.y * 16));
  }
  mix(stations.length);
  for (const station of stations) {
    mix(station.id);
    mix(Math.round(station.x * 16));
    mix(Math.round(station.y * 16));
    for (let index = 0; index < station.kind.length; index += 1) {
      mix(station.kind.charCodeAt(index));
    }
  }
  if (map) {
    mix(map.width);
    mix(map.height);
    // Échantillonnage régulier : détecte une forêt nouvelle sans rescanner
    // 512² tuiles à chaque snapshot.
    const stride = Math.max(1, Math.floor(Math.min(map.width, map.height) / 48));
    let trees = 0;
    for (let y = 0; y < map.height; y += stride) {
      const row = y * map.width;
      for (let x = 0; x < map.width; x += stride) {
        if ((map.kind[row + x] ?? 0) === TILE_KIND_INDEX.trees) {
          trees += 1;
          mix(x);
          mix(y);
        }
      }
    }
    mix(trees);
  }
  return hash >>> 0;
}

export class AtmosphereLayer {
  readonly group = new THREE.Group();

  private quality: QualityLevel = 'medium';
  private budget: AtmosphereBudget = ATMOSPHERE_BUDGETS.medium;
  private reducedMotion = false;
  private nightAmount = 0;
  private phase = 0.5;
  private lastSkyPhase = -1;
  private weather: WeatherKind = 'clear';
  private elapsed = 0;
  private map: MapSnapshot | null = null;
  private towns: readonly TownSnapshot[] = [];
  private stations: readonly StationSnapshot[] = [];
  private signature = 0;
  private built = false;
  private disposed = false;

  private habitats: Habitat[] = [];
  private forestHabitats: Habitat[] = [];
  private lightAnchors: LightAnchor[] = [];
  private construction: ConstructionSite | null = null;
  private dustInRange = true;

  // --- Systèmes (capacités fixes) -----------------------------------------
  private dome: THREE.Mesh;
  private domeMaterial: THREE.ShaderMaterial;
  private domeSky = new THREE.Color(0x9dc3dc);
  private domeFog = new THREE.Color(0x9dc3dc);
  private domeSun = new THREE.Color(0xfff0cf);
  private domeSunDirection = new THREE.Vector3(0, 1, 0);
  private domeSunGlow = 0;

  private clouds: THREE.Points;
  private cloudMaterial: THREE.PointsMaterial;
  private cloudPositions: Float32Array;
  private cloudData: Float32Array;

  private birds: THREE.Points;
  private birdMaterial: THREE.PointsMaterial;
  private birdPositions: Float32Array;
  private birdData: Float32Array;

  private butterflies: THREE.Points;
  private butterflyMaterial: THREE.PointsMaterial;
  private butterflyPositions: Float32Array;
  private butterflyData: Float32Array;

  private lights: THREE.Points;
  private lightMaterial: THREE.PointsMaterial;
  private lightPositions: Float32Array;

  private rain: THREE.Points;
  private rainMaterial: THREE.PointsMaterial;
  private rainPositions: Float32Array;
  private rainOffsets: Float32Array;

  private snow: THREE.Points;
  private snowMaterial: THREE.PointsMaterial;
  private snowPositions: Float32Array;
  private snowOffsets: Float32Array;
  private snowPhase: Float32Array;

  private dust: THREE.Points;
  private dustMaterial: THREE.PointsMaterial;
  private dustPositions: Float32Array;

  private softCloudTexture: THREE.Texture | null = null;
  private softSnowTexture: THREE.Texture | null = null;
  private birdTexture: THREE.Texture | null = null;
  private butterflyTexture: THREE.Texture | null = null;
  private lightTexture: THREE.Texture | null = null;

  /** Nombre de reconstructions de placements (diagnostic/tests). */
  builds = 0;
  /** Nombre d'upload du buffer de nuages (diagnostic/tests). */
  cloudUploads = 0;

  constructor() {
    this.group.name = 'atmosphere';

    this.domeMaterial = new THREE.ShaderMaterial({
      name: 'atmosphere-dome',
      uniforms: {
        uSky: { value: this.domeSky },
        uFog: { value: this.domeFog },
        uSun: { value: this.domeSun },
        uSunDirection: { value: this.domeSunDirection },
        uSunGlow: { value: 0 },
      },
      vertexShader: DOME_VERTEX,
      fragmentShader: DOME_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 24, 12), this.domeMaterial);
    this.dome.name = 'atmosphere-dome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -4;
    this.group.add(this.dome);

    // --- Nuages -----------------------------------------------------------
    this.cloudPositions = new Float32Array(MAX.clouds * 3);
    this.cloudData = new Float32Array(MAX.clouds * 2);
    const cloudRng = new Prng(0x0c10d5);
    for (let index = 0; index < MAX.clouds; index += 1) {
      const angle = cloudRng.float(0, Math.PI * 2);
      const radius = cloudRng.float(CLOUD_MIN_RADIUS, CLOUD_RADIUS);
      this.cloudPositions[index * 3] = Math.cos(angle) * radius;
      this.cloudPositions[index * 3 + 1] = cloudRng.float(CLOUD_MIN_Y, CLOUD_MAX_Y);
      this.cloudPositions[index * 3 + 2] = Math.sin(angle) * radius;
      this.cloudData[index * 2] = cloudRng.float(0.55, 1.45);
      this.cloudData[index * 2 + 1] = cloudRng.float(0.7, 1.35);
    }
    this.softCloudTexture = createSpriteTexture('cloud');
    this.cloudMaterial = new THREE.PointsMaterial({
      color: 0xf4f8ff,
      size: 36,
      map: this.softCloudTexture,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      fog: false,
      sizeAttenuation: true,
    });
    this.clouds = this.makePoints('atmosphere-clouds', this.cloudPositions, this.cloudMaterial, -3);
    this.group.add(this.clouds);

    // --- Oiseaux ----------------------------------------------------------
    this.birdPositions = new Float32Array(MAX.birds * 3);
    this.birdData = new Float32Array(MAX.birds * 5);
    this.birdTexture = createSpriteTexture('bird');
    this.birdMaterial = new THREE.PointsMaterial({
      color: 0x222a33,
      size: 1.15,
      map: this.birdTexture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    });
    this.birds = this.makePoints('atmosphere-birds', this.birdPositions, this.birdMaterial, 4);
    this.birds.visible = false;
    this.group.add(this.birds);

    // --- Papillons --------------------------------------------------------
    this.butterflyPositions = new Float32Array(MAX.butterflies * 3);
    this.butterflyData = new Float32Array(MAX.butterflies * 5);
    this.butterflyTexture = createSpriteTexture('butterfly');
    this.butterflyMaterial = new THREE.PointsMaterial({
      color: 0xffd27a,
      size: 0.32,
      map: this.butterflyTexture,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    });
    this.butterflies = this.makePoints(
      'atmosphere-butterflies',
      this.butterflyPositions,
      this.butterflyMaterial,
      4,
    );
    this.butterflies.visible = false;
    this.group.add(this.butterflies);

    // --- Lumières de nuit (gares + centres-villes) ------------------------
    this.lightPositions = new Float32Array(MAX.nightLights * 3);
    this.lightTexture = createSpriteTexture('snow');
    this.lightMaterial = new THREE.PointsMaterial({
      color: 0xffc978,
      size: 2.6,
      map: this.lightTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    this.lights = this.makePoints(
      'atmosphere-night-lights',
      this.lightPositions,
      this.lightMaterial,
      5,
    );
    this.lights.visible = false;
    this.group.add(this.lights);

    // --- Pluie ------------------------------------------------------------
    this.rainPositions = new Float32Array(MAX.rain * 3);
    this.rainOffsets = new Float32Array(MAX.rain * 3);
    const rainRng = new Prng(0x7a1901);
    for (let index = 0; index < MAX.rain; index += 1) {
      this.rainOffsets[index * 3] = rainRng.float(-RAIN_BOX_XZ, RAIN_BOX_XZ);
      this.rainOffsets[index * 3 + 1] = rainRng.float(0, RAIN_BOX_Y);
      this.rainOffsets[index * 3 + 2] = rainRng.float(-RAIN_BOX_XZ, RAIN_BOX_XZ);
    }
    this.rainMaterial = new THREE.PointsMaterial({
      color: 0xa8c4dc,
      size: 0.42,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    });
    this.rain = this.makePoints('atmosphere-rain', this.rainPositions, this.rainMaterial, 6);
    this.rain.visible = false;
    this.group.add(this.rain);

    // --- Neige ------------------------------------------------------------
    this.snowPositions = new Float32Array(MAX.snow * 3);
    this.snowOffsets = new Float32Array(MAX.snow * 3);
    this.snowPhase = new Float32Array(MAX.snow);
    const snowRng = new Prng(0x5f10a2);
    for (let index = 0; index < MAX.snow; index += 1) {
      this.snowOffsets[index * 3] = snowRng.float(-RAIN_BOX_XZ, RAIN_BOX_XZ);
      this.snowOffsets[index * 3 + 1] = snowRng.float(0, RAIN_BOX_Y);
      this.snowOffsets[index * 3 + 2] = snowRng.float(-RAIN_BOX_XZ, RAIN_BOX_XZ);
      this.snowPhase[index] = snowRng.float(0, Math.PI * 2);
    }
    this.softSnowTexture = createSpriteTexture('snow');
    this.snowMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.55,
      map: this.softSnowTexture,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    });
    this.snow = this.makePoints('atmosphere-snow', this.snowPositions, this.snowMaterial, 6);
    this.snow.visible = false;
    this.group.add(this.snow);

    // --- Poussière de construction ---------------------------------------
    this.dustPositions = new Float32Array(MAX.dust * 3);
    this.dustMaterial = new THREE.PointsMaterial({
      color: 0xd8c7a6,
      size: 1.15,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    });
    this.dust = this.makePoints('atmosphere-dust', this.dustPositions, this.dustMaterial, 5);
    this.dust.visible = false;
    this.group.add(this.dust);

    this.reducedMotion =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;

    this.applyQuality('medium');
    this.applyWeatherVisibility();
  }

  private makePoints(
    name: string,
    positions: Float32Array,
    material: THREE.Material,
    renderOrder: number,
  ): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    const points = new THREE.Points(geometry, material);
    points.name = name;
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    points.visible = false;
    return points;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Applique carte, villes et gares ; ne reconstruit que sur changement. */
  applyWorld(
    map: MapSnapshot | null,
    towns: readonly TownSnapshot[],
    stations: readonly StationSnapshot[],
  ): void {
    this.map = map;
    this.towns = towns;
    this.stations = stations;
    const signature = computeAtmosphereSignature(map, towns, stations, this.quality);
    if (this.built && signature === this.signature) {
      this.applyNightVisibility();
      return;
    }
    this.signature = signature;
    this.built = true;
    this.builds += 1;
    this.collectHabitats();
    this.collectLightAnchors();
    this.writeHabitatParticles();
  }

  setQuality(level: QualityLevel): void {
    if (level === this.quality) return;
    this.quality = level;
    this.applyQuality(level);
    // Les placements d'oiseaux dépendent du budget : on les réécrit sans
    // rescanner la carte (les habitats restent valides).
    if (this.built) {
      this.writeHabitatParticles();
      this.signature = computeAtmosphereSignature(
        this.map,
        this.towns,
        this.stations,
        this.quality,
      );
    }
    this.applyNightVisibility();
  }

  /** Réduit ou coupe les particules animées (accessibilité). */
  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    this.applyWeatherVisibility();
    this.applyNightVisibility();
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Météo optionnelle, désactivée par défaut (`clear`). */
  setWeather(kind: WeatherKind): void {
    this.weather = kind === 'rain' || kind === 'snow' ? kind : 'clear';
    this.applyWeatherVisibility();
  }

  get weatherKind(): WeatherKind {
    return this.weather;
  }

  /** 0 = jour, 1 = nuit profonde. */
  setNight(amount: number): void {
    this.nightAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.applyNightVisibility();
  }

  get night(): number {
    return this.nightAmount;
  }

  /** Zone de chantier : poussière tant que le plan est affiché. */
  setConstructionSite(site: { x: number; z: number } | null): void {
    if (!site) {
      this.construction = null;
      this.dust.visible = false;
      return;
    }
    this.dustInRange = true;
    const ground = this.map ? sampleHeightWorld(this.map, site.x, site.z) : 0;
    if (this.construction) {
      this.construction.x = site.x;
      this.construction.z = site.z;
      this.construction.ground = ground;
    } else {
      this.construction = { x: site.x, z: site.z, ground };
    }
    this.dust.visible = this.dustEnabled();
  }

  get hasConstructionSite(): boolean {
    return this.construction !== null;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * Avance les systèmes. Aucune allocation : les tableaux de particules sont
   * réécrits en place et les couleurs du dôme ne sont recalculées que lorsque
   * la phase change réellement.
   */
  update(deltaSeconds: number, camera: THREE.Vector3, phase: number): void {
    if (this.disposed) return;
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(0.1, deltaSeconds)) : 0;
    this.elapsed += delta;
    if (Number.isFinite(phase)) this.phase = phase;
    this.updateSky(camera);

    const animate = !this.reducedMotion;
    this.updateClouds(camera, delta, animate);
    this.updateBirds(animate);
    this.updateButterflies(animate);
    this.updateWeather(camera, delta, animate);
    this.updateDust(camera, animate);
    this.applyNightVisibility();
  }

  private updateSky(camera: THREE.Vector3): void {
    this.dome.position.copy(camera);
    if (!this.dome.visible) return;
    // La phase avance lentement : recalculer les couleurs seulement quand
    // l'écart est perceptible évite une allocation de `sunState` par frame.
    if (Math.abs(this.phase - this.lastSkyPhase) < 0.0015) return;
    this.lastSkyPhase = this.phase;
    const state = sunState(this.phase);
    const night = state.night;
    this.domeSky.setHex(state.skyColour);
    this.domeFog.setHex(state.fogColour);
    this.domeSun.setHex(state.colour);
    this.domeSunDirection.set(state.direction.x, state.direction.y, state.direction.z);
    this.domeSunGlow = Math.max(0, state.daylight) * (1 - night * 0.65);
    this.domeMaterial.uniforms.uSunGlow!.value = this.domeSunGlow;
    this.cloudMaterial.color.setHex(0xffffff).lerp(this.domeFog, 0.55);
    this.cloudMaterial.opacity = 0.05 + (1 - night) * 0.34;
  }

  private updateClouds(camera: THREE.Vector3, delta: number, animate: boolean): void {
    if (!this.clouds.visible) return;
    const count = this.budget.clouds;
    const positions = this.cloudPositions;
    const data = this.cloudData;
    const drift = animate ? delta * WIND_SPEED : 0;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = positions[offset]! + drift * data[index * 2]!;
      // Enroulement autour de la caméra : la nappe reste toujours couvrante.
      let x = positions[offset]! - camera.x;
      if (x > CLOUD_RADIUS) x -= CLOUD_RADIUS * 2;
      else if (x < -CLOUD_RADIUS) x += CLOUD_RADIUS * 2;
      positions[offset] = x + camera.x;
      const indexZ = offset + 2;
      let z = positions[indexZ]! - camera.z;
      if (z > CLOUD_RADIUS) z -= CLOUD_RADIUS * 2;
      else if (z < -CLOUD_RADIUS) z += CLOUD_RADIUS * 2;
      positions[indexZ] = z + camera.z;
    }
    this.clouds.geometry.attributes.position!.needsUpdate = true;
    this.cloudUploads += 1;
  }

  private updateBirds(animate: boolean): void {
    if (!this.birds.visible) return;
    const count = this.budget.birds;
    const positions = this.birdPositions;
    const data = this.birdData;
    const time = this.elapsed;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const meta = index * 5;
      const anchorX = data[meta]!;
      const anchorZ = data[meta + 1]!;
      const radius = data[meta + 2]!;
      const phase = data[meta + 3]!;
      const ground = data[meta + 4]!;
      const angle = phase + (animate ? time * 0.35 : 0);
      positions[offset] = anchorX + Math.cos(angle) * radius;
      positions[offset + 1] = ground + BIRD_HEIGHT + Math.sin(time * 1.7 + phase) * 0.8;
      positions[offset + 2] = anchorZ + Math.sin(angle) * radius;
    }
    this.birds.geometry.attributes.position!.needsUpdate = true;
  }

  private updateButterflies(animate: boolean): void {
    if (!this.butterflies.visible) return;
    const count = this.budget.butterflies;
    const positions = this.butterflyPositions;
    const data = this.butterflyData;
    const time = this.elapsed;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const meta = index * 5;
      const anchorX = data[meta]!;
      const anchorZ = data[meta + 1]!;
      const radius = data[meta + 2]!;
      const phase = data[meta + 3]!;
      const ground = data[meta + 4]!;
      const angle = phase + (animate ? time * 0.8 : 0);
      positions[offset] = anchorX + Math.cos(angle) * radius;
      positions[offset + 1] = ground + 1.1 + Math.sin(time * 2.3 + phase) * 0.35;
      positions[offset + 2] = anchorZ + Math.sin(angle * 1.3) * radius;
    }
    this.butterflies.geometry.attributes.position!.needsUpdate = true;
  }

  private updateWeather(camera: THREE.Vector3, delta: number, animate: boolean): void {
    if (this.weather === 'clear') return;
    const isRain = this.weather === 'rain';
    const points = isRain ? this.rain : this.snow;
    if (!points.visible) return;
    const count = isRain ? this.budget.rain : this.budget.snow;
    const positions = isRain ? this.rainPositions : this.snowPositions;
    const offsets = isRain ? this.rainOffsets : this.snowOffsets;
    const fall = isRain ? 22 : 3.2;
    const drift = isRain ? 1.8 : 1.1;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      if (animate) {
        offsets[offset + 1] = offsets[offset + 1]! - fall * delta;
        if (offsets[offset + 1]! < 0) offsets[offset + 1] = RAIN_BOX_Y;
        offsets[offset] = offsets[offset]! + drift * delta;
        if (offsets[offset]! > RAIN_BOX_XZ) offsets[offset] = -RAIN_BOX_XZ;
        if (!isRain) {
          const sway = Math.sin(this.elapsed * 1.3 + this.snowPhase[index]!) * delta * 0.6;
          offsets[offset] = offsets[offset]! + sway;
        }
      }
      positions[offset] = camera.x + offsets[offset]!;
      positions[offset + 1] = camera.y + offsets[offset + 1]! - 8;
      positions[offset + 2] = camera.z + offsets[offset + 2]!;
    }
    points.geometry.attributes.position!.needsUpdate = true;
  }

  private updateDust(camera: THREE.Vector3, animate: boolean): void {
    if (!this.dust.visible) return;
    const site = this.construction;
    if (!site) {
      this.dust.visible = false;
      return;
    }
    const count = this.budget.dust;
    const positions = this.dustPositions;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const seed = index / Math.max(1, count);
      const t = animate ? (this.elapsed * 0.45 + seed) % 1 : seed;
      const angle = seed * Math.PI * 2 * 7.13;
      const radius = (0.25 + t * DUST_RADIUS) * (0.6 + (seed % 0.4));
      positions[offset] = site.x + Math.cos(angle) * radius;
      positions[offset + 1] = site.ground + 0.25 + t * 2.4;
      positions[offset + 2] = site.z + Math.sin(angle) * radius;
    }
    // La poussière n'est utile que proche de la caméra.
    const distance = Math.hypot(site.x - camera.x, site.z - camera.z);
    this.dustInRange = distance < 140;
    this.dust.visible = this.dustInRange;
    this.dust.geometry.attributes.position!.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Placements
  // -------------------------------------------------------------------------

  private applyQuality(level: QualityLevel): void {
    this.quality = level;
    this.budget = ATMOSPHERE_BUDGETS[level] ?? ATMOSPHERE_BUDGETS.medium;
    this.dome.visible = this.budget.skyDome;
    this.group.visible = true;
    this.applyWeatherVisibility();
    this.applyNightVisibility();
  }

  private collectHabitats(): void {
    const habitats: Habitat[] = [];
    const map = this.map;
    const townGround = (x: number, z: number): number => (map ? sampleHeightWorld(map, x, z) : 0);

    for (const town of this.towns) {
      if (habitats.length >= 6) break;
      habitats.push({
        x: town.x,
        z: town.y,
        ground: townGround(town.x, town.y),
        radius: 3.2,
        kind: 0,
      });
    }

    const bushes: Habitat[] = [];
    if (map) {
      // Regroupement grossier des tuiles d'arbres : au plus 4 cellules denses.
      const cell = Math.max(16, Math.floor(Math.max(map.width, map.height) / 12));
      const buckets = new Map<number, { count: number; x: number; z: number }>();
      for (let y = 0; y < map.height; y += 1) {
        const row = y * map.width;
        for (let x = 0; x < map.width; x += 1) {
          if ((map.kind[row + x] ?? 0) !== TILE_KIND_INDEX.trees) continue;
          const key = Math.floor(y / cell) * 1024 + Math.floor(x / cell);
          const bucket = buckets.get(key);
          if (bucket) {
            bucket.count += 1;
            bucket.x += x + 0.5;
            bucket.z += y + 0.5;
          } else {
            buckets.set(key, { count: 1, x: x + 0.5, z: y + 0.5 });
          }
        }
      }
      const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 4);
      for (const bucket of ranked) {
        if (bucket.count < 6) continue;
        const x = bucket.x / bucket.count;
        const z = bucket.z / bucket.count;
        bushes.push({
          x,
          z,
          ground: townGround(x, z),
          radius: 2.4,
          kind: 1,
        });
      }
    }

    this.habitats = habitats.concat(bushes);
    this.forestHabitats = bushes;
  }

  private collectLightAnchors(): void {
    const anchors: LightAnchor[] = [];
    const map = this.map;
    const ground = (x: number, z: number): number => (map ? sampleHeightWorld(map, x, z) : 0);

    // Les gares ont un halo plus marqué que les centres-villes.
    for (const station of this.stations) {
      if (anchors.length >= MAX.nightLights) break;
      anchors.push({
        x: station.x,
        y: ground(station.x, station.y) + NIGHT_LIGHT_HEIGHT,
        z: station.y,
        strength: 1,
      });
    }
    for (const town of this.towns) {
      if (anchors.length >= MAX.nightLights) break;
      anchors.push({
        x: town.x,
        y: ground(town.x, town.y) + NIGHT_LIGHT_HEIGHT,
        z: town.y,
        strength: 0.7,
      });
    }
    // Remplit avec un semis régulier dans les villes pour un halo continu.
    for (const town of this.towns) {
      if (anchors.length >= MAX.nightLights) break;
      for (let ring = 1; ring <= 3; ring += 1) {
        if (anchors.length >= MAX.nightLights) break;
        const radius = 1.6 * ring;
        for (let step = 0; step < 4; step += 1) {
          if (anchors.length >= MAX.nightLights) break;
          const angle = (step / 4) * Math.PI * 2 + ring * 0.7;
          const x = town.x + Math.cos(angle) * radius;
          const z = town.y + Math.sin(angle) * radius;
          anchors.push({
            x,
            y: ground(x, z) + NIGHT_LIGHT_HEIGHT,
            z,
            strength: 0.45,
          });
        }
      }
    }
    this.lightAnchors = anchors;
  }

  private writeHabitatParticles(): void {
    // Oiseaux : répartis sur les villes puis les forêts.
    const birdBudget = this.budget.birds;
    const birdCount = Math.min(birdBudget, this.habitats.length * 8);
    const birdAnchors = this.habitats.slice(0, Math.max(1, Math.ceil(birdCount / 8)));
    for (let index = 0; index < MAX.birds; index += 1) {
      const meta = index * 5;
      if (index >= birdCount || birdAnchors.length === 0) {
        this.birdData[meta] = 0;
        this.birdData[meta + 1] = 0;
        this.birdData[meta + 2] = 1;
        this.birdData[meta + 3] = 0;
        this.birdData[meta + 4] = 0;
        continue;
      }
      const anchor = birdAnchors[index % birdAnchors.length]!;
      const flock = Math.floor(index / birdAnchors.length);
      const ring = 0.9 + (index % 8) * 0.22;
      this.birdData[meta] = anchor.x + (flock % 2 === 0 ? 0 : anchor.radius * 0.4);
      this.birdData[meta + 1] = anchor.z;
      this.birdData[meta + 2] = ring;
      this.birdData[meta + 3] = (index / Math.max(1, birdCount)) * Math.PI * 2 + flock * 0.9;
      this.birdData[meta + 4] = anchor.ground;
    }
    this.birds.geometry.setDrawRange(0, birdCount);

    // Papillons : près des forêts, sinon des villes.
    const butterflyBudget = this.budget.butterflies;
    const butterflyAnchors = this.forestHabitats.length > 0 ? this.forestHabitats : this.habitats;
    const butterflyCount =
      butterflyAnchors.length > 0 ? Math.min(butterflyBudget, butterflyAnchors.length * 12) : 0;
    for (let index = 0; index < MAX.butterflies; index += 1) {
      const meta = index * 5;
      if (index >= butterflyCount) {
        this.butterflyData[meta] = 0;
        this.butterflyData[meta + 1] = 0;
        this.butterflyData[meta + 2] = 1;
        this.butterflyData[meta + 3] = 0;
        this.butterflyData[meta + 4] = 0;
        continue;
      }
      const anchor = butterflyAnchors[index % butterflyAnchors.length]!;
      this.butterflyData[meta] = anchor.x;
      this.butterflyData[meta + 1] = anchor.z;
      this.butterflyData[meta + 2] = 0.7 + (index % 12) * 0.16;
      this.butterflyData[meta + 3] = (index / Math.max(1, butterflyCount)) * Math.PI * 2;
      this.butterflyData[meta + 4] = anchor.ground;
    }
    this.butterflies.geometry.setDrawRange(0, butterflyCount);

    // Lumières : gares d'abord, puis villes.
    const lightCount = Math.min(this.budget.nightLights, this.lightAnchors.length);
    for (let index = 0; index < MAX.nightLights; index += 1) {
      const anchor: LightAnchor | undefined = this.lightAnchors[index];
      const offset = index * 3;
      this.lightPositions[offset] = anchor?.x ?? 0;
      this.lightPositions[offset + 1] = anchor?.y ?? -1_000;
      this.lightPositions[offset + 2] = anchor?.z ?? 0;
    }
    this.lights.geometry.setDrawRange(0, lightCount);
    this.lightMaterial.size = this.quality === 'high' ? 3 : 2.6;

    this.applyNightVisibility();
    this.applyWeatherVisibility();
  }

  private dustEnabled(): boolean {
    return this.budget.dust > 0 && !this.reducedMotion && this.construction !== null;
  }

  private applyNightVisibility(): void {
    const showLights = this.budget.nightLights > 0 && this.nightAmount > 0.08;
    this.lights.visible = showLights;
    this.lightMaterial.opacity = Math.min(1, (this.nightAmount - 0.05) * 1.2) * 0.55;
    this.lights.geometry.setDrawRange(
      0,
      Math.min(this.budget.nightLights, this.lightAnchors.length),
    );
    // Les oiseaux et papillons dorment la nuit.
    const daytime = 1 - this.nightAmount;
    const showBirds = this.budget.birds > 0 && !this.reducedMotion && daytime > 0.35;
    this.birds.visible = showBirds;
    this.birdMaterial.opacity = 0.25 + daytime * 0.65;
    const showButterflies = this.budget.butterflies > 0 && !this.reducedMotion && daytime > 0.45;
    this.butterflies.visible = showButterflies;
    this.butterflyMaterial.opacity = 0.3 + daytime * 0.6;
    this.clouds.visible = this.budget.clouds > 0;
    this.clouds.geometry.setDrawRange(0, this.budget.clouds);
    this.dome.visible = this.budget.skyDome;
    this.dust.visible = this.dustEnabled() && this.dustInRange;
  }

  private applyWeatherVisibility(): void {
    const animated = !this.reducedMotion;
    const rain = this.weather === 'rain' && this.budget.rain > 0 && animated;
    const snow = this.weather === 'snow' && this.budget.snow > 0 && animated;
    this.rain.visible = rain;
    this.snow.visible = snow;
    this.rain.geometry.setDrawRange(0, rain ? this.budget.rain : 0);
    this.snow.geometry.setDrawRange(0, snow ? this.budget.snow : 0);
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  get budgetSnapshot(): AtmosphereBudget {
    return { ...this.budget };
  }

  get habitatCount(): number {
    return this.habitats.length;
  }

  get forestCount(): number {
    return this.forestHabitats.length;
  }

  get lightCount(): number {
    return Math.min(this.budget.nightLights, this.lightAnchors.length);
  }

  /** Particules effectivement soumises cette frame. */
  get particleCount(): number {
    if (this.disposed) return 0;
    let total = 0;
    if (this.clouds.visible) total += this.budget.clouds;
    if (this.birds.visible) total += this.budget.birds;
    if (this.butterflies.visible) total += this.budget.butterflies;
    if (this.lights.visible) total += this.lightCount;
    if (this.rain.visible) total += this.budget.rain;
    if (this.snow.visible) total += this.budget.snow;
    if (this.dust.visible) total += this.budget.dust;
    return total;
  }

  /** Budget théorique maximal du preset, météo comprise. */
  get budgetParticles(): number {
    return (
      this.budget.clouds +
      this.budget.birds +
      this.budget.butterflies +
      this.budget.nightLights +
      Math.max(this.budget.rain, this.budget.snow) +
      this.budget.dust
    );
  }

  get drawCallCount(): number {
    if (this.disposed) return 0;
    let total = 0;
    if (this.dome.visible) total += 1;
    for (const points of [
      this.clouds,
      this.birds,
      this.butterflies,
      this.lights,
      this.rain,
      this.snow,
      this.dust,
    ]) {
      if (points.visible) total += 1;
    }
    return total;
  }

  /** Capacité GPU allouée (constante, pour vérifier qu'aucun rebuild ne fuit). */
  get particleCapacity(): number {
    return (
      MAX.clouds + MAX.birds + MAX.butterflies + MAX.nightLights + MAX.rain + MAX.snow + MAX.dust
    );
  }

  /** Couleur de ciel effectivement poussée au shader du dôme. */
  get skyColour(): number {
    return this.domeSky.getHex();
  }

  get sunGlow(): number {
    return this.domeSunGlow;
  }

  get domeVisible(): boolean {
    return this.dome.visible;
  }

  /** Buffer interne d'un système (lecture seule, diagnostic/tests). */
  positionsOf(
    system: 'clouds' | 'birds' | 'butterflies' | 'lights' | 'rain' | 'snow' | 'dust',
  ): Float32Array {
    switch (system) {
      case 'clouds':
        return this.cloudPositions;
      case 'birds':
        return this.birdPositions;
      case 'butterflies':
        return this.butterflyPositions;
      case 'lights':
        return this.lightPositions;
      case 'rain':
        return this.rainPositions;
      case 'snow':
        return this.snowPositions;
      case 'dust':
        return this.dustPositions;
    }
  }

  systemVisible(
    system: 'clouds' | 'birds' | 'butterflies' | 'lights' | 'rain' | 'snow' | 'dust',
  ): boolean {
    return this[system].visible;
  }

  get pointSystems(): {
    clouds: number;
    birds: number;
    butterflies: number;
    lights: number;
    rain: number;
    snow: number;
    dust: number;
  } {
    return {
      clouds: this.budget.clouds,
      birds: this.budget.birds,
      butterflies: this.budget.butterflies,
      lights: this.lightCount,
      rain: this.rain.visible ? this.budget.rain : 0,
      snow: this.snow.visible ? this.budget.snow : 0,
      dust: this.dust.visible ? this.budget.dust : 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.clear();
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    for (const points of [
      this.clouds,
      this.birds,
      this.butterflies,
      this.lights,
      this.rain,
      this.snow,
      this.dust,
    ]) {
      points.geometry.dispose();
      const material = points.material;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else {
        material.dispose();
      }
    }
    this.softCloudTexture?.dispose();
    this.softSnowTexture?.dispose();
    this.birdTexture?.dispose();
    this.butterflyTexture?.dispose();
    this.lightTexture?.dispose();
    this.softCloudTexture = null;
    this.softSnowTexture = null;
    this.birdTexture = null;
    this.butterflyTexture = null;
    this.lightTexture = null;
    this.habitats = [];
    this.forestHabitats = [];
    this.lightAnchors = [];
    this.construction = null;
    this.dustInRange = true;
    this.map = null;
    this.towns = [];
    this.stations = [];
    this.signature = 0;
    this.built = false;
    this.builds = 0;
  }
}
