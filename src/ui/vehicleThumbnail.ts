/**
 * Vignettes des modèles de véhicules, rendues hors écran.
 *
 * Le panneau dépôt affiche une carte par modèle achetables et par véhicule sur
 * place. Plutôt qu'un asset binaire, chaque vignette est un rendu WebGL d'un
 * archétype procédural existant (`buildVehicleModel`), converti en data URL
 * PNG puis mis en cache.
 *
 * Contraintes tenues par ce module :
 * - un seul `WebGLRenderer` hors écran, créé paresseusement et réutilisé ;
 * - un rendu par tour de boucle d'animation au plus, pour ne pas bloquer le
 *   thread principal quand le panneau s'ouvre ;
 * - cache LRU borné (clé = variante + couleur + qualité) ;
 * - `suspend()` libère le contexte et annule la file dès que le panneau se
 *   ferme ; `dispose()` vide aussi le cache ;
 * - repli silencieux (`null`) quand WebGL ou le hors-écran est indisponible :
 *   le panneau garde alors son gabarit et son pictogramme.
 *
 * Aucun accès réseau, aucun asset : la géométrie vient du même module que le
 * rendu principal, en lecture seule.
 */

import * as THREE from 'three';
import type { QualityLevel } from '../render/quality';
import {
  buildVehicleModel,
  type VehicleModelDefinition,
  type VehicleVariant,
} from '../render/vehicleModels';
import { createModelMaterial } from '../render/models/materials';

/** Qualité de rendu d'une vignette (alignée sur les presets du jeu). */
export type ThumbnailQuality = QualityLevel;

export interface ThumbnailRequest {
  variant: VehicleVariant;
  /** Couleur d'entreprise au format 0xRRGGBB. */
  colour: number;
  quality: ThumbnailQuality;
}

/** Moteur de rendu d'une vignette ; `null` signale un échec ponctuel. */
export interface ThumbnailBackend {
  render(request: ThumbnailRequest): string | null;
  dispose(): void;
}

/** Taille en pixels du canevas hors écran selon la qualité. */
export const THUMBNAIL_SIZES: Record<ThumbnailQuality, { width: number; height: number }> = {
  low: { width: 96, height: 60 },
  medium: { width: 144, height: 90 },
  high: { width: 192, height: 120 },
};

/** Clé de cache stable : variante, couleur et qualité. */
export function thumbnailKey(request: ThumbnailRequest): string {
  return `${request.variant}|${request.colour.toString(16)}|${request.quality}`;
}

/** Pictogramme de repli quand la vignette n'est pas (encore) disponible. */
export function thumbnailGlyph(variant: VehicleVariant): string {
  switch (variant) {
    case 'train-steam':
    case 'train-coach':
    case 'train-freight':
      return '🚆';
    case 'truck-flat':
    case 'truck-tanker':
      return '🚚';
    case 'bus-city':
    case 'bus-coach':
      return '🚌';
    case 'ship':
      return '🚢';
    case 'plane':
      return '✈';
  }
}

export interface ThumbnailCacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * Cache LRU simple et borné.
 *
 * `Map` conserve l'ordre d'insertion : relire une entrée la déplace en fin de
 * liste, et une insertion au-delà de la limite retire la plus ancienne.
 */
export class ThumbnailCache {
  private readonly entries = new Map<string, string>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly limit: number;

  constructor(limit = 64) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get(key: string): string | null {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: string): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get limitSize(): number {
    return this.limit;
  }

  stats(): ThumbnailCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

export interface VehicleThumbnailsOptions {
  /** Nombre maximal de vignettes en cache. */
  limit?: number;
  /** Fabrique du backend ; renvoyer `null` force le mode dégradé. */
  createBackend?: () => ThumbnailBackend | null;
  /** Ordonnanceur d'un rendu (par défaut : prochaine frame d'animation). */
  schedule?: (task: () => void) => void;
}

function defaultSchedule(task: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => task());
    return;
  }
  setTimeout(task, 0);
}

export type ThumbnailReady = (url: string | null) => void;

/**
 * Service de vignettes partagé par le panneau dépôt.
 *
 * `resume()` est appelé à l'ouverture du panneau, `suspend()` à sa fermeture.
 * Tant que le service est suspendu aucune tâche n'est planifiée : une demande
 * reçoit immédiatement `null` et le panneau affiche son repli.
 */
export class VehicleThumbnails {
  readonly cache: ThumbnailCache;

  private readonly createBackend: () => ThumbnailBackend | null;
  private readonly schedule: (task: () => void) => void;
  private backend: ThumbnailBackend | null = null;
  private backendReady = false;
  private backendFailed = false;
  private readonly queue = new Map<string, ThumbnailRequest>();
  private listeners = new Map<string, Set<ThumbnailReady>>();
  private scheduled = false;
  private active = false;
  private disposed = false;
  private renders = 0;

  constructor(options: VehicleThumbnailsOptions = {}) {
    this.cache = new ThumbnailCache(options.limit);
    this.createBackend = options.createBackend ?? createWebglThumbnailBackend;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  /** Nombre de rendus réellement tentés (diagnostic/tests). */
  get renderCount(): number {
    return this.renders;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Vignette déjà en cache, sans planifier de rendu. */
  cached(request: ThumbnailRequest): string | null {
    return this.cache.get(thumbnailKey(request));
  }

  /** Autorise de nouveau les rendus (ouverture du panneau). */
  resume(): void {
    if (this.disposed) return;
    this.active = true;
    this.backendFailed = false;
    this.backendReady = false;
  }

  /** Annule la file et libère le contexte WebGL (fermeture du panneau). */
  suspend(): void {
    this.active = false;
    this.queue.clear();
    this.listeners.clear();
    this.scheduled = false;
    this.releaseBackend();
  }

  /** Suspend puis oublie le cache (démontage du HUD). */
  dispose(): void {
    this.suspend();
    this.disposed = true;
    this.cache.clear();
  }

  /**
   * Demande une vignette. `done` reçoit l'URL dès qu'elle est disponible, ou
   * `null` si le rendu est indisponible ou si le panneau s'est fermé avant.
   */
  request(request: ThumbnailRequest, done: ThumbnailReady): void {
    if (this.disposed) {
      done(null);
      return;
    }
    const key = thumbnailKey(request);
    const cached = this.cache.get(key);
    if (cached !== null) {
      done(cached);
      return;
    }
    // Panneau fermé : aucun travail GPU ne doit démarrer.
    if (!this.active) {
      done(null);
      return;
    }
    // Contexte déjà perdu/absent : inutile de replanifier à chaque rendu.
    if (this.backendFailed) {
      done(null);
      return;
    }
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set<ThumbnailReady>();
      this.listeners.set(key, listeners);
    }
    listeners.add(done);
    if (!this.queue.has(key)) this.queue.set(key, request);
    this.pump();
  }

  private pump(): void {
    if (this.scheduled || !this.active || this.queue.size === 0) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.step();
    });
  }

  /** Rend une seule vignette : garde le thread principal réactif. */
  private step(): void {
    if (!this.active || this.disposed) return;
    const first = this.queue.entries().next();
    if (first.done) return;
    const [key, request] = first.value;
    this.queue.delete(key);
    const url = this.renderOne(request);
    const listeners = this.listeners.get(key);
    this.listeners.delete(key);
    if (listeners) for (const done of listeners) done(url);
    // Contexte absent ou perdu : inutile de planifier les demandes restantes.
    if (this.backendFailed) {
      this.failPending();
      return;
    }
    this.pump();
  }

  private renderOne(request: ThumbnailRequest): string | null {
    const key = thumbnailKey(request);
    const cached = this.cache.get(key);
    if (cached !== null) return cached;
    const backend = this.ensureBackend();
    if (!backend) return null;
    this.renders += 1;
    let url: string | null;
    try {
      url = backend.render(request);
    } catch {
      url = null;
      this.backendFailed = true;
      this.releaseBackend();
    }
    if (url) this.cache.set(key, url);
    return url;
  }

  private ensureBackend(): ThumbnailBackend | null {
    if (this.backendFailed) return null;
    if (this.backendReady) return this.backend;
    this.backendReady = true;
    try {
      this.backend = this.createBackend();
    } catch {
      this.backend = null;
    }
    if (!this.backend) this.backendFailed = true;
    return this.backend;
  }

  /** Repli : toutes les demandes en attente reçoivent `null`. */
  private failPending(): void {
    this.queue.clear();
    const listeners = this.listeners;
    this.listeners = new Map();
    for (const set of listeners.values()) for (const done of set) done(null);
  }

  private releaseBackend(): void {
    if (this.backend) {
      try {
        this.backend.dispose();
      } catch {
        // Un contexte déjà perdu ne doit pas empêcher la fermeture du panneau.
      }
    }
    this.backend = null;
    this.backendReady = false;
  }
}

// ---------------------------------------------------------------------------
// Backend WebGL hors écran
// ---------------------------------------------------------------------------

/** Direction fixe de la caméra : vue trois-quarts avant-droite. */
const VIEW_DIRECTION = new THREE.Vector3(0.92, 0.58, 1.18).normalize();

interface Framing {
  center: THREE.Vector3;
  distance: number;
}

/**
 * Crée le backend WebGL unique. Renvoie `null` quand le navigateur n'expose pas
 * de contexte : le service bascule alors en mode dégradé sans lever d'erreur.
 */
export function createWebglThumbnailBackend(): ThumbnailBackend | null {
  if (typeof document === 'undefined') return null;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: document.createElement('canvas'),
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
  } catch {
    return null;
  }

  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40);
  const night = { value: 0 };
  const material = createModelMaterial({
    night,
    glowStrength: 0,
    nightAmbient: 0,
    roughness: 0.6,
    metalness: 0.06,
    name: 'vehicle-thumbnail',
  });

  scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x1f232a, 2.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.9);
  keyLight.position.set(4, 6, 5);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xbcd2ff, 1.15);
  fillLight.position.set(-5, 2.5, -4);
  scene.add(fillLight);

  const models = new Map<VehicleVariant, VehicleModelDefinition>();
  const framings = new Map<VehicleVariant, Framing>();
  let mesh: THREE.Mesh | null = null;
  let disposed = false;

  function modelFor(variant: VehicleVariant): VehicleModelDefinition {
    const cached = models.get(variant);
    if (cached) return cached;
    const definition = buildVehicleModel(variant);
    models.set(variant, definition);
    return definition;
  }

  function framingFor(variant: VehicleVariant, definition: VehicleModelDefinition): Framing {
    const cached = framings.get(variant);
    if (cached) return cached;
    const bounds = definition.bounds;
    const center = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );
    const radius =
      0.5 *
      Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
    const halfFov = (camera.fov * Math.PI) / 360;
    const framing = { center, distance: (radius / Math.sin(halfFov)) * 0.78 };
    framings.set(variant, framing);
    return framing;
  }

  return {
    render(request: ThumbnailRequest): string | null {
      if (disposed) return null;
      const size = THUMBNAIL_SIZES[request.quality] ?? THUMBNAIL_SIZES.medium;
      const definition = modelFor(request.variant);
      if (!mesh) {
        mesh = new THREE.Mesh(definition.geometry, material);
        mesh.name = 'vehicle-thumbnail';
        scene.add(mesh);
      } else {
        mesh.geometry = definition.geometry;
      }

      const framing = framingFor(request.variant, definition);
      material.color.setHex(request.colour & 0xffffff);
      camera.position.copy(framing.center).addScaledVector(VIEW_DIRECTION, framing.distance);
      camera.lookAt(framing.center);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();

      renderer.setSize(size.width, size.height, false);
      renderer.render(scene, camera);
      const canvas = renderer.domElement;
      // La présentation peut vider le tampon : on lit dans la même tâche.
      return canvas.toDataURL('image/png');
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const definition of models.values()) definition.geometry.dispose();
      models.clear();
      framings.clear();
      if (mesh) {
        scene.remove(mesh);
        mesh = null;
      }
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      const canvas = renderer.domElement;
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
