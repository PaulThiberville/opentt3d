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
  /** Tangage en radians (#232), `undefined` si le moteur ne le fournit pas. */
  pitch?: number;
  status: number;
  speed: number;
}

/** Au-delà de ce seuil (en tuiles), on considère un téléport et on recale. */
export const TELEPORT_DISTANCE_SQUARED = 64;

export function modelKindFor(
  vehicle: Pick<VehicleSnapshot, 'kind' | 'cargo' | 'id' | 'model'>,
): VehicleModelKind {
  switch (vehicle.kind) {
    case 'train':
      return 'train';
    case 'ship':
      return 'ship';
    case 'aircraft':
      return 'plane';
    case 'road': {
      // Le modèle catalogue est la source la plus fiable : un bus refité ou
      // cloné reste visuellement un bus, même si sa cargaison est nulle.
      const model = vehicle.model?.toLowerCase() ?? '';
      if (model.startsWith('bus')) return 'bus';
      if (model.startsWith('truck')) return 'truck';
      // Le contrat regroupe bus et camions : on départage sur la cargaison,
      // puis sur l'identifiant pour rester déterministe.
      if (vehicle.cargo?.type === 'passengers') return 'bus';
      if (vehicle.cargo === null) return vehicle.id % 3 === 0 ? 'bus' : 'truck';
      return 'truck';
    }
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
    pitch: vehicle.pitch,
    status: vehicle.status,
    speed: vehicle.speed,
  };
}

/**
 * Tangage déduit du déplacement entre deux snapshots (#232).
 *
 * Le pont WASM n'expose pas encore de tangage : la différence de `z` entre
 * deux positions successives donne la pente réelle du segment, y compris sur
 * un tablier de pont. Les navires et avions restent horizontaux.
 */
export function segmentPitch(
  from: Pick<VehicleSnapshot, 'x' | 'y' | 'z' | 'kind'>,
  to: Pick<VehicleSnapshot, 'x' | 'y' | 'z' | 'kind'>,
): number {
  if (to.kind === 'ship' || to.kind === 'aircraft') return 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-4) return 0;
  return Math.atan2(to.z - from.z, distance);
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
        slot.pitch = target.pitch;
      } else {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        if (dx * dx + dy * dy > TELEPORT_DISTANCE_SQUARED) {
          slot.x = target.x;
          slot.y = target.y;
          slot.z = target.z;
          slot.direction = target.direction;
          slot.pitch = target.pitch;
        } else {
          slot.x = lerp(source.x, target.x, t);
          slot.y = lerp(source.y, target.y, t);
          slot.z = lerp(source.z, target.z, t);
          slot.direction = lerpDirection(source.direction, target.direction, t);
          if (source.pitch !== undefined && target.pitch !== undefined) {
            slot.pitch = lerp(source.pitch, target.pitch, t);
          } else if (target.pitch !== undefined) {
            slot.pitch = target.pitch;
          } else if (source.pitch !== undefined) {
            slot.pitch = source.pitch;
          } else {
            // Moteur sans tangage : la pente du déplacement entre les deux
            // snapshots reste constante sur l'intervalle d'interpolation.
            slot.pitch = dx * dx + dy * dy < 1e-8 ? undefined : segmentPitch(source, target);
          }
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
        slot.pitch = source.pitch;
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
