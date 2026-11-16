/**
 * Règles des groupes de véhicules (#164).
 *
 * Module pur partagé par `MockEngine`, l'interface et les tests. Il valide les
 * noms, vérifie qu'un véhicule peut rejoindre un groupe typé et résume les
 * règles d'autoreplace. Les commandes restent validées par le moteur.
 */

import type {
  VehicleGroupSnapshot,
  VehicleKind,
  VehicleSnapshot,
  WorldSnapshot,
} from '../engine/protocol';
import { VEHICLE_MODELS, vehicleModel, type VehicleModel } from './vehicleRules';

export const MAX_GROUP_NAME_LENGTH = 32;
export const MAX_GROUPS = 64;

/** Nom par défaut d'un groupe créé sans libellé explicite. */
export function defaultGroupName(id: number): string {
  return `Groupe ${id + 1}`;
}

/** Normalise un nom de groupe : espaces compactés, longueur bornée. */
export function normalizeGroupName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME_LENGTH);
}

export function isValidGroupName(name: string): boolean {
  const normalized = normalizeGroupName(name);
  return normalized.length > 0 && normalized.length <= MAX_GROUP_NAME_LENGTH;
}

/** Groupe du snapshot par identifiant, ou null. */
export function groupById(
  snapshot: WorldSnapshot | null,
  id: number | null | undefined,
): VehicleGroupSnapshot | null {
  if (!snapshot || id === null || id === undefined || !Number.isFinite(id)) return null;
  return snapshot.groups?.find((group) => group.id === id) ?? null;
}

/** Libellé du groupe d'un véhicule, ou null s'il n'est pas groupé. */
export function vehicleGroupLabel(
  vehicle: VehicleSnapshot,
  snapshot: WorldSnapshot | null,
): string | null {
  if (vehicle.group?.name) return vehicle.group.name;
  const group = groupById(snapshot, vehicle.group?.id);
  return group?.name ?? null;
}

/** groupe d'un véhicule par identifiant stable, ou null. */
export function vehicleGroupId(vehicle: VehicleSnapshot): number | null {
  return vehicle.group?.id ?? null;
}

/**
 * Un véhicule peut-il rejoindre ce groupe ? Le type doit correspondre, comme
 * dans OpenTTD où un groupe est typé route/rail/marine/aérien.
 */
export function canAssignVehicleToGroup(
  vehicle: VehicleSnapshot,
  group: VehicleGroupSnapshot | null,
): boolean {
  if (!group) return true;
  if (vehicle.company !== group.company) return false;
  return vehicle.kind === group.kind;
}

/** Modèles compatibles avec le type d'un groupe (catalogue partagé). */
export function modelsForGroupKind(kind: VehicleKind): VehicleModel[] {
  return VEHICLE_MODELS.filter((model) => model.kind === kind);
}

/** Vérifie qu'un modèle cible existe et partage le type du groupe. */
export function compatibleAutoreplaceModel(
  modelId: string | null | undefined,
  kind: VehicleKind,
): VehicleModel | null {
  const model = vehicleModel(modelId);
  if (!model || model.kind !== kind) return null;
  return model;
}

/** Nombre de véhicules d'un groupe dans le snapshot. */
export function countGroupVehicles(snapshot: WorldSnapshot | null, groupId: number): number {
  if (!snapshot) return 0;
  return snapshot.vehicles.filter((vehicle) => vehicle.group?.id === groupId).length;
}

/** Groupes d'une entreprise, triés par nom. */
export function companyGroups(
  snapshot: WorldSnapshot | null,
  companyId: number | null,
): VehicleGroupSnapshot[] {
  if (!snapshot?.groups || companyId === null) return [];
  return snapshot.groups
    .filter((group) => group.company === companyId)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}
