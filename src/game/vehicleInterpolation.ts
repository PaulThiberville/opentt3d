/**
 * Interpolation des véhicules entre deux snapshots.
 *
 * Ce module ne dépend pas de Three.js : il produit une liste de véhicules
 * « de rendu » réutilisable (pool d'objets) que `VehicleLayer` traduit en
 * matrices d'instances. La classe garde un index id → snapshot pour éviter
 * toute allocation par frame.
 */

import type { VehicleKind, VehicleSnapshot } from '../engine/protocol';
import { clamp01, lerp, lerpDirection } from './interpolation';

/** Modèle visuel : le contrat ne distingue que 4 types, le rendu en expose 5. */
export type VehicleModelKind = 'train' | 'truck' | 'bus' | 'ship' | 'plane';

export interface RenderVehicle {
  id: number;
  kind: VehicleKind;
  model: VehicleModelKind;
  company: number;
  x: number;
  y: number;
  z: number;
  direction: number;
  status: number;
  speed: number;
}

/** Au-delà de ce seuil (en tuiles), on considère un téléport et on recale. */
export const TELEPORT_DISTANCE_SQUARED = 64;

export function modelKindFor(vehicle: Pick<VehicleSnapshot, 'kind' | 'cargo' | 'id'>): VehicleModelKind {
  switch (vehicle.kind) {
    case 'train':
      return 'train';
    case 'ship':
      return 'ship';
    case 'aircraft':
      return 'plane';
    case 'road':
      // Le contrat regroupe bus et camions : on départage sur la cargaison,
      // puis sur l'identifiant pour rester déterministe.
      if (vehicle.cargo?.type === 'passengers') return 'bus';
      if (vehicle.cargo === null) return vehicle.id % 3 === 0 ? 'bus' : 'truck';
      return 'truck';
    default:
      return 'truck';
  }
}

function createRenderVehicle(vehicle: VehicleSnapshot): RenderVehicle {
  return {
    id: vehicle.id,
    kind: vehicle.kind,
    model: modelKindFor(vehicle),
    company: vehicle.company,
    x: vehicle.x,
    y: vehicle.y,
    z: vehicle.z,
    direction: vehicle.direction,
    status: vehicle.status,
    speed: vehicle.speed,
  };
}

export class VehicleInterpolator {
  private source: readonly VehicleSnapshot[] | null = null;
  private index = new Map<number, VehicleSnapshot>();
  private targetIds = new Set<number>();

  /** Remplit `out` (pool réutilisé) et renvoie le nombre de véhicules écrits. */
  interpolate(
    from: readonly VehicleSnapshot[],
    to: readonly VehicleSnapshot[],
    alpha: number,
    out: RenderVehicle[],
  ): number {
    if (this.source !== from) {
      this.source = from;
      this.index.clear();
      for (const vehicle of from) this.index.set(vehicle.id, vehicle);
    }
    const t = clamp01(alpha);
    this.targetIds.clear();
    let count = 0;
    for (const target of to) {
      this.targetIds.add(target.id);
      const source = this.index.get(target.id);
      const slot = out[count] ?? createRenderVehicle(target);
      slot.id = target.id;
      slot.kind = target.kind;
      slot.model = modelKindFor(target);
      slot.company = target.company;
      slot.status = target.status;
      slot.speed = target.speed;

      if (!source || t >= 1) {
        slot.x = target.x;
        slot.y = target.y;
        slot.z = target.z;
        slot.direction = target.direction;
      } else {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dz = target.z - source.z;
        if (dx * dx + dy * dy > TELEPORT_DISTANCE_SQUARED) {
          slot.x = target.x;
          slot.y = target.y;
          slot.z = target.z;
          slot.direction = target.direction;
        } else {
          slot.x = lerp(source.x, target.x, t);
          slot.y = lerp(source.y, target.y, t);
          slot.z = lerp(source.z, target.z, t);
          slot.direction = lerpDirection(source.direction, target.direction, t);
        }
      }
      out[count] = slot;
      count += 1;
    }

    // Véhicules disparus : on les garde sur place jusqu'à alpha = 1.
    if (t < 1) {
      for (const source of from) {
        if (this.targetIds.has(source.id)) continue;
        const slot = out[count] ?? createRenderVehicle(source);
        slot.id = source.id;
        slot.kind = source.kind;
        slot.model = modelKindFor(source);
        slot.company = source.company;
        slot.x = source.x;
        slot.y = source.y;
        slot.z = source.z;
        slot.direction = source.direction;
        slot.status = source.status;
        slot.speed = source.speed;
        out[count] = slot;
        count += 1;
      }
    }

    out.length = count;
    return count;
  }
}
