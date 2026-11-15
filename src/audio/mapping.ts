/**
 * Règles pures « événement → son » et calculs d'ambiance/spatialisation.
 *
 * Ce module ne touche ni au DOM ni à WebAudio : il est testable sous Node et
 * sert au `AudioDirector` comme à l'interface. Les textes de news sont en
 * français (langue de l'interface) ; les motifs restent tolérants pour que le
 * moteur WASM, qui peut les produire en anglais, déclenche aussi les sons.
 */

import type { EngineCommand, MapSnapshot, VehicleKind, WorldSnapshot } from '../engine/protocol';
import { TILE_KIND_INDEX } from '../engine/protocol';
import type { QualityLevel } from '../render/quality';
import { phaseFromEconomy, sunState } from '../render/dayNight';
import type { SoundId } from './soundIds';
import { clamp01 } from './context';

export type NotifyKind = 'info' | 'warning' | 'error' | 'company';

const MONEY_IN =
  /revenu|recette|b[ée]n[ée]fice|profit|gagn[ée]|encaiss|versement|subvention|income|revenue/i;
const MONEY_OUT = /co[ûu]t|d[ée]pense|pay[ée]|amende|perte|perdu|maintenance|expense|cost|fine/i;

/** Son associé à une commande acceptée, ou `null` si rien d'audible. */
export function soundForCommand(command: EngineCommand): SoundId | null {
  if (command.type === 'build') {
    switch (command.tool) {
      case 'road':
      case 'bridge':
      case 'tunnel':
        return 'build.road';
      case 'rail':
      case 'signal':
        return 'build.rail';
      case 'station':
        return 'build.station';
      case 'depot':
        return 'build.depot';
      case 'clear':
        return 'build.clear';
      default:
        return null;
    }
  }
  if (command.type === 'vehicle') {
    switch (command.action) {
      case 'buy':
        return 'vehicle.buy';
      case 'sell':
        return 'vehicle.sell';
      case 'start':
        return 'vehicle.start';
      case 'stop':
        return 'vehicle.stop';
      case 'order':
      case 'refit':
        return 'ui.click';
      default:
        return null;
    }
  }
  return null;
}

/**
 * Son associé à une notification du jeu. Les infos de démarrage et le bavardage
 * réseau restent muets : seuls les avertissements, erreurs, nouvelles
 * d'entreprise et mouvements d'argent sont audibles.
 */
export function soundForNotification(kind: NotifyKind, text: string): SoundId | null {
  if (kind === 'error') return 'ui.error';
  if (kind === 'warning') return 'alert';
  if (kind === 'company') return 'ui.notify';
  if (MONEY_IN.test(text)) return 'money.in';
  if (MONEY_OUT.test(text)) return 'money.out';
  return null;
}

/** Un véhicule en mouvement peut produire un passage audible. */
export function passSoundForKind(kind: VehicleKind): SoundId | null {
  if (kind === 'train') return 'train.pass';
  if (kind === 'road') return 'bus.pass';
  return null;
}

export function distance2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Atténuation quadratique douce : 1 au contact, 0 à `maxDistance`. */
export function gainForDistance(distance: number, maxDistance = 24): number {
  if (!Number.isFinite(distance) || maxDistance <= 0) return 0;
  const t = clamp01(1 - distance / maxDistance);
  return t * t;
}

/**
 * Panoramique d'après la base caméra (voir `panBasis`) : +1 à droite.
 * `spread` est la distance latérale qui sature le panoramique.
 */
export function panForOffset(dx: number, dz: number, yaw: number, spread = 16): number {
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const lateral = dx * rightX + dz * rightZ;
  const normalized = lateral / Math.max(1, spread);
  if (normalized < -1) return -1;
  if (normalized > 1) return 1;
  return normalized;
}

const WATER_KINDS = new Set<number>([
  TILE_KIND_INDEX.water,
  TILE_KIND_INDEX.coast,
  TILE_KIND_INDEX.canal,
  TILE_KIND_INDEX.river,
]);

/**
 * Part d'eau dans un disque de `radius` tuiles autour du point visé (0..1).
 * Sert à doser la boucle « eau à proximité » ; les snapshots partiels ne
 * fournissent pas toujours la carte, l'appelant passe alors `null`.
 */
export function waterRatio(map: MapSnapshot | null, x: number, z: number, radius = 5): number {
  if (!map || map.width <= 0 || map.height <= 0) return 0;
  const cx = Math.round(x);
  const cz = Math.round(z);
  let water = 0;
  let total = 0;
  for (let dz = -radius; dz <= radius; dz += 1) {
    const row = cz + dz;
    if (row < 0 || row >= map.height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const column = cx + dx;
      if (column < 0 || column >= map.width) continue;
      if (dx * dx + dz * dz > radius * radius) continue;
      total += 1;
      const kind = map.kind[row * map.width + column] ?? 0;
      if (WATER_KINDS.has(kind)) water += 1;
    }
  }
  return total === 0 ? 0 : water / total;
}

export interface AmbienceEnvironment {
  /** 0 = plein jour, 1 = nuit profonde. */
  night: number;
  /** 0 = nuit, 1 = plein jour. */
  daylight: number;
  /** Part d'eau autour de la caméra (0..1). */
  water: number;
  quality: QualityLevel;
}

export const CALM_AMBIENCE: AmbienceEnvironment = {
  night: 0,
  daylight: 1,
  water: 0,
  quality: 'medium',
};

/** Ambiance déduite de l'heure de jeu et de la carte autour de la caméra. */
export function ambienceFromSnapshot(
  snapshot: WorldSnapshot | null,
  map: MapSnapshot | null,
  listener: { x: number; z: number },
  quality: QualityLevel,
): AmbienceEnvironment {
  const sun = snapshot ? sunState(phaseFromEconomy(snapshot.economy)) : sunState(0.5);
  return {
    night: sun.night,
    daylight: sun.daylight,
    water: waterRatio(map, listener.x, listener.z),
    quality,
  };
}

/** Densité relative d'ambiance selon la qualité de rendu. */
export function ambienceDensity(quality: QualityLevel): number {
  if (quality === 'low') return 0.45;
  if (quality === 'high') return 1;
  return 0.75;
}
