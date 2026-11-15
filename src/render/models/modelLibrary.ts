/**
 * Cache de modèles procéduraux.
 *
 * Les géométries sont construites à la première demande puis réutilisées par
 * tous les `InstancedMesh`. Le cache ne dépend d'aucune ressource externe :
 * `dispose()` libère les géométries et permet une reconstruction propre.
 */

import type * as THREE from 'three';
import { disposeGeometries } from './modelUtils';

export interface LibraryModel {
  geometry: THREE.BufferGeometry;
  triangles: number;
}

export interface LibraryStats {
  models: number;
  triangles: number;
  builds: number;
}

export class ModelLibrary<K extends string, M extends LibraryModel> {
  private readonly models = new Map<K, M>();
  private readonly factory: (key: K) => M;
  private builds = 0;

  constructor(factory: (key: K) => M) {
    this.factory = factory;
  }

  /** Renvoie le modèle demandé, en le construisant une seule fois. */
  get(key: K): M {
    const cached = this.models.get(key);
    if (cached) return cached;
    const model = this.factory(key);
    this.models.set(key, model);
    this.builds += 1;
    return model;
  }

  has(key: K): boolean {
    return this.models.has(key);
  }

  /** Préconstruit une liste de clés (évite un à-coup au premier affichage). */
  preload(keys: readonly K[]): void {
    for (const key of keys) this.get(key);
  }

  get size(): number {
    return this.models.size;
  }

  /** Budget triangles cumulé des modèles déjà construits. */
  get triangleCount(): number {
    let total = 0;
    for (const model of this.models.values()) total += model.triangles;
    return total;
  }

  get buildCount(): number {
    return this.builds;
  }

  stats(): LibraryStats {
    return { models: this.models.size, triangles: this.triangleCount, builds: this.builds };
  }

  entries(): IterableIterator<[K, M]> {
    return this.models.entries();
  }

  dispose(): void {
    disposeGeometries(Array.from(this.models.values(), (model) => model.geometry));
    this.models.clear();
  }
}
