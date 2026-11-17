/**
 * Surface d'eau : profondeur, houle, écume et parois de rive, sans dépendance
 * Three.js.
 *
 * L'eau reste un quad par tuile (deux triangles). Le relief des vagues vient
 * du shader, la profondeur d'un champ de distance calculé une fois par carte :
 * la teinte et l'écume suivent donc la distance à la côte sans ajouter de
 * géométrie. La nappe s'étend d'une couronne sous la berge (#204) et une paroi
 * ferme les marches légitimes entre deux biefs d'écluse (#205/#242). Une écluse
 * garde un bajoyer de pierre vertical ; aucune cascade ni mur d'eau n'est
 * généré. Les helpers sont purs et testables sous Node.
 *
 * Nivellement (#242) : chaque composante d'eau 4-connexe sans écluse est
 * rendue au niveau de surface le plus bas qu'elle contient. Une rivière qui
 * « descend » par marches dans les données OpenTTD redevient donc un seul plan
 * horizontal, au lieu d'empiler des cubes d'eau. Les écluses, qui séparent deux
 * composantes, restent des barrières et conservent leur dénivellation.
 *
 * Modèle de hauteur (correctif #176) : dans le protocole, la hauteur d'une
 * tuile d'eau est le niveau de sa surface dans OpenTTD. La surface 3D est donc
 * posée *très légèrement sous* ce niveau, et le lit rendu plus bas encore.
 * L'eau ne peut ainsi jamais dépasser le dessus d'une tuile voisine (route,
 * pont, quai, berge), même au creux de la houle.
 */

import type { MapSnapshot, TileKind } from '../engine/protocol';
import { HEIGHT_SCALE, isWaterKind, tileKindFromIndex } from '../game/mapGrid';
import { waterRenderLevels } from '../game/waterLevels';

/**
 * Décalage de la surface sous le dessus de la tuile, en unités monde.
 *
 * Négatif : l'eau est sous le niveau de la tuile, donc sous toute route, tout
 * pont et tout quai construits au même niveau. La marge (8 cm) couvre
 * l'amplitude de la houle (5 cm) : la crête reste toujours sous le terrain sec
 * et aucun tri de transparence ne peut faire passer l'eau au-dessus.
 */
export const WATER_LEVEL_OFFSET = -0.08;

/**
 * Descente du lit rendu sous le dessus de la tuile, en unités monde.
 *
 * Le lit n'est pas coplanaire avec la surface : l'écart donne une profondeur
 * visible, supprime tout z-fighting et laisse la transparence montrer le fond.
 * Aux berges, l'interpolation des coins ramène progressivement le lit sous la
 * surface, ce qui dessine la plage au lieu d'un mur d'eau.
 */
export const WATER_BED_DROP = 0.62;

/**
 * Écart vertical réel entre la surface et le lit : sert d'échelle à la
 * profondeur physique utilisée par le shader.
 */
export const WATER_DEPTH_SPAN = WATER_BED_DROP + WATER_LEVEL_OFFSET;

/** Distance (en tuiles) au-delà de laquelle l'eau est considérée profonde. */
export const WATER_DEPTH_RANGE = 7;

/**
 * Recouvrement de la nappe sous la berge, en tuiles (correctif #204).
 *
 * Le maillage d'eau ne s'arrête plus au bord exact des tuiles d'eau : il
 * s'étend d'une couronne sous le terrain sec. La rive visible est alors
 * l'intersection entre le plan d'eau et la pente du terrain, pas l'arête
 * rectangulaire du quad. L'extension reste sous le dessus des tuiles sèches
 * (surface < niveau de la tuile), donc aucun risque d'eau sur terrain sec.
 */
export const WATER_SHORE_OVERLAP = 1;

/**
 * Largeur du fondu d'opacité au contact de la berge, en unités monde.
 *
 * Calculé sur la hauteur libre entre la surface et le lit, il adoucit la ligne
 * d'intersection et masque les dents de scie du maillage de terrain.
 */
export const WATER_SHORE_FADE = 0.22;

/**
 * Hauteur libre minimale d'une berge recarveé au-dessus de la nappe abaissée.
 *
 * Quand une composante est ramenée à un niveau plus bas (#242), la moyenne de
 * coins du terrain masquerait la rivière : les tuiles de berge mitoyennes
 * gardent leur altitude et recouvrent le plan d'eau, surtout sur un chenal
 * d'une tuile de large. On abaisse donc le lit **rendu** de la couronne de
 * berge naturelle à `surface + WATER_SHORE_CLEARANCE`. La berge reste sèche
 * (au-dessus de la nappe), mais la pente ne dépasse plus la surface et la
 * rivière reste visible. La valeur 0,12 garantit qu'un coin mêlant une tuile
 * d'eau et trois tuiles de berge reste sous la surface.
 */
export const WATER_SHORE_CLEARANCE = 0.12;

/** Distance maximale suivie pour les plages et les berges (en tuiles). */
export const SHORE_MAX_DISTANCE = 8;

/** Amplitude maximale de la houle verticale, en unités monde. */
export const WATER_WAVE_AMPLITUDE = 0.05;

/** Fréquence/spatialité de la houle, partagées entre JS et GLSL. */
export const WATER_WAVE_TERMS = [
  { time: 1.35, x: 0.55, z: 0.42, weight: 0.6 },
  { time: 2.2, x: 1.7, z: -1.1, weight: 0.28 },
  { time: 0.8, x: -0.35, z: 0.9, weight: 0.12 },
] as const;

/** Profondeur (0..1) sous laquelle l'écume de côte apparaît. */
export const WATER_FOAM_DEPTH = 0.055;

/** Échelle spatiale du clapot de normal, en unités monde inverses. */
export const WATER_RIPPLE_SCALE = 5.5;

/** Distance où le clapot de normale s'atténue pour éviter le scintillement. */
export const WATER_RIPPLE_FADE_NEAR = 90;
export const WATER_RIPPLE_FADE_FAR = 210;

export interface ShoreFields {
  /** Distance à la première tuile d'eau (0 sur l'eau, plafonnée). */
  landDistance: Float32Array;
  /** Distance à la première tuile terrestre (0 sur la terre, plafonnée). */
  waterDistance: Float32Array;
}

/**
 * Champs de hauteur par tuile alimentant le maillage du terrain.
 *
 * `bed` couvre toute la carte (terre incluse) : il sert directement aux
 * positions et aux normales, sans branche par type de tuile. `surface` et
 * `weight` ne sont renseignés que sur l'eau, ce qui permet de calculer la
 * profondeur réelle d'un sommet sans peindre les tuiles sèches voisines.
 */
export interface WaterHeightFields {
  /** Hauteur monde du lit physique, pour chaque tuile. */
  bed: Float32Array;
  /**
   * Lit utilisé par le maillage du terrain.
   *
   * Sous une marche d'écluse, le lit physique d'une tuile haute reste à son
   * niveau : l'interpolation bilinéaire des coins ferait remonter une grande
   * rampe de terre au-dessus de la nappe basse. Les tuiles d'eau qui dominent
   * une nappe plus basse sont donc creusées ici jusqu'à passer sous cette
   * nappe.
   *
   * Quand une composante libre est aplanie plus bas (#242), la couronne de
   * berge naturelle est aussi abaissée juste au-dessus de la nouvelle surface
   * (`WATER_SHORE_CLEARANCE`) : les coins du maillage ne recouvrent plus le
   * chenal, la rivière reste visible et la berge reste sèche.
   */
  bedRender: Float32Array;
  /** Hauteur monde de la surface de l'eau (0 sur la terre). */
  surface: Float32Array;
  /** 1 sur une tuile d'eau, 0 ailleurs. */
  weight: Float32Array;
  /**
   * Surface de référence de la nappe pour chaque tuile couverte : la propre
   * surface d'une tuile d'eau, ou celle de l'eau voisine pour la couronne de
   * berge (recouvrement #204). 0 hors couverture.
   */
  shoreSurface: Float32Array;
  /** 1 sur l'eau **et** sur la couronne de berge recouverte, 0 ailleurs. */
  coverage: Uint8Array;
}

function clampIndex(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

/** BFS 4-voisinage, plafonné : suffisant pour une bande de plage. */
function distanceField(
  width: number,
  height: number,
  isSource: (index: number) => boolean,
  limit: number,
): Float32Array {
  const size = width * height;
  const distances = new Int16Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < size; index += 1) {
    if (!isSource(index)) continue;
    distances[index] = 0;
    queue[tail] = index;
    tail += 1;
  }
  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const next = (distances[index] ?? 0) + 1;
    if (next > limit) continue;
    const x = index % width;
    const y = (index - x) / width;
    const visit = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const neighbour = ny * width + nx;
      if ((distances[neighbour] ?? -1) >= 0) return;
      distances[neighbour] = next;
      queue[tail] = neighbour;
      tail += 1;
    };
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }
  const result = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const distance = distances[index] ?? -1;
    result[index] = distance < 0 ? limit : distance;
  }
  return result;
}

/**
 * Champs de distance d'une carte : terre → eau et eau → terre.
 * Coût linéaire en tuiles, une seule fois par changement de carte.
 */
export function buildShoreFields(map: MapSnapshot): ShoreFields {
  const isWater = (index: number): boolean => isWaterKind(tileKindFromIndex(map.kind[index] ?? 0));
  return {
    landDistance: distanceField(map.width, map.height, isWater, SHORE_MAX_DISTANCE),
    waterDistance: distanceField(
      map.width,
      map.height,
      (index) => !isWater(index),
      WATER_DEPTH_RANGE,
    ),
  };
}

function safeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, level) : 0;
}

/**
 * Hauteur monde du dessus d'une tuile, indépendamment de l'eau.
 *
 * C'est la même convention que `sampleHeightWorld` : une tuile de niveau `n`
 * culmine à `n * HEIGHT_SCALE`.
 */
function tileTopHeight(level: number): number {
  return safeLevel(level) * HEIGHT_SCALE;
}

function cornerFieldValue(
  field: ArrayLike<number>,
  width: number,
  height: number,
  cx: number,
  cy: number,
): number {
  let sum = 0;
  let count = 0;
  for (let dy = -1; dy <= 0; dy += 1) {
    for (let dx = -1; dx <= 0; dx += 1) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      sum += field[ty * width + tx] ?? 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Échantillonne un champ par tuile comme le maillage du terrain.
 *
 * Même moyenne de coins puis même bilinéaire que `sampleHeightWorld`
 * (`src/game/mapGrid.ts`) : les positions, les normales et la profondeur du
 * lit restent donc exactement alignées sur la géométrie du terrain. La
 * version « centre de tuile » (`sampleField`) sert aux distances de côte, pas
 * aux hauteurs.
 */
export function sampleCornerField(
  field: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  z: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const h00 = cornerFieldValue(field, width, height, x0, z0);
  const h10 = cornerFieldValue(field, width, height, x0 + 1, z0);
  const h01 = cornerFieldValue(field, width, height, x0, z0 + 1);
  const h11 = cornerFieldValue(field, width, height, x0 + 1, z0 + 1);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fz;
}

/**
 * Lit et surface de chaque tuile, en hauteurs monde.
 *
 * Une seule passe linéaire, sans allocation intermédiaire par tuile. Les
 * tuiles sèches gardent leur dessus habituel ; seules les tuiles d'eau sont
 * creusées pour créer le lit, ce qui laisse routes, ponts et quais au-dessus
 * de la surface.
 */
export function buildWaterHeightFields(map: MapSnapshot): WaterHeightFields {
  const size = map.width * map.height;
  const bed = new Float32Array(size);
  const bedRender = new Float32Array(size);
  const surface = new Float32Array(size);
  const weight = new Float32Array(size);
  const shoreSurface = new Float32Array(size);
  const coverage = new Uint8Array(size);
  const isWater = new Uint8Array(size);
  const lowered = new Uint8Array(size);
  // Niveaux réellement rendus : une composante sans écluse est aplanie sur son
  // niveau le plus bas (#242). Les écluses et la terre gardent leur hauteur.
  const levels = waterRenderLevels(map);
  for (let index = 0; index < size; index += 1) {
    const level = levels[index] ?? 0;
    if (isWaterKind(tileKindFromIndex(map.kind[index] ?? 0))) {
      bed[index] = waterBedHeight(level);
      surface[index] = waterSurfaceHeight(level);
      weight[index] = 1;
      shoreSurface[index] = surface[index] ?? 0;
      coverage[index] = 1;
      isWater[index] = 1;
      if (level < (map.heightMap[index] ?? 0)) lowered[index] = 1;
    } else {
      bed[index] = tileTopHeight(level);
    }
    bedRender[index] = bed[index] ?? 0;
  }

  // Lit rendu des marches : une tuile d'eau qui domine une nappe voisine est
  // creusée sous cette nappe. Sans cela, la moyenne de coins du maillage
  // dessine une rampe de terre au-dessus de l'eau basse, lue comme un plateau
  // ou une plaque triangulaire au pied de la chute (#226).
  const { width, height } = map;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (isWater[index] !== 1) continue;
      const ownSurface = surface[index] ?? 0;
      let lowest = Infinity;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (neighbour === index || isWater[neighbour] !== 1) continue;
          const neighbourSurface = surface[neighbour] ?? 0;
          if (neighbourSurface < ownSurface - WATER_WALL_EPSILON) {
            lowest = Math.min(lowest, neighbourSurface);
          }
        }
      }
      if (Number.isFinite(lowest)) {
        bedRender[index] = Math.min(bedRender[index] ?? 0, lowest - WATER_STEP_BED_MARGIN);
      }
    }
  }

  // Rive recarveé sous une nappe abaissée (#242) : sans cela la moyenne de
  // coins du terrain recouvre la rivière aplanie, surtout sur un chenal d'une
  // tuile. On n'abaisse que le lit **rendu** des berges naturelles, jamais
  // au-dessous de la surface : la berge reste sèche et les routes, arbres,
  // bâtiments et quais gardent leur altitude d'origine.
  const carveableKind = (kind: TileKind): boolean =>
    kind === 'clear' || kind === 'grass' || kind === 'rough' || kind === 'coast';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (isWater[index] === 1) continue;
      if (!carveableKind(tileKindFromIndex(map.kind[index] ?? 0))) continue;
      let reference = Infinity;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (lowered[neighbour] !== 1) continue;
          reference = Math.min(reference, surface[neighbour] ?? 0);
        }
      }
      if (!Number.isFinite(reference)) continue;
      const target = reference + WATER_SHORE_CLEARANCE;
      if ((bedRender[index] ?? 0) > target) bedRender[index] = target;
    }
  }

  // Couronne de berge : chaque tuile sèche au contact (8-voisinage) d'une
  // tuile d'eau reçoit la surface de l'eau voisine la plus basse. Sa nappe
  // s'étend ainsi sous la pente, y compris aux coins diagonaux, sans jamais
  // dépasser le dessus de la tuile sèche (`surface < level * HEIGHT_SCALE`).
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (isWater[index] === 1) continue;
      if (tileKindFromIndex(map.kind[index] ?? 0) === 'void') continue;
      let reference = 0;
      let touched = false;
      for (let dy = -WATER_SHORE_OVERLAP; dy <= WATER_SHORE_OVERLAP; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -WATER_SHORE_OVERLAP; dx <= WATER_SHORE_OVERLAP; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (isWater[neighbour] !== 1) continue;
          const candidate = surface[neighbour] ?? 0;
          // La surface la plus basse évite qu'une nappe haute (canal, écluse)
          // ne déborde sur une berge mitoyenne d'une eau plus basse.
          if (!touched || candidate < reference) reference = candidate;
          touched = true;
        }
      }
      // Ne recouvrir que les berges qui dominent la nappe : sans ce garde-fou,
      // une rivière en canyon déborderait visuellement sur la terre plus basse.
      if (touched && tileTopHeight(map.heightMap[index] ?? 0) >= reference) {
        shoreSurface[index] = reference;
        coverage[index] = 1;
      }
    }
  }

  return { bed, bedRender, surface, weight, shoreSurface, coverage };
}

/**
 * Échantillonne un champ par tuile à un coin de grille (bilinéaire).
 *
 * Le champ est défini au centre des tuiles : un sommet de coin partage donc la
 * même valeur de part et d'autre d'une arête, y compris entre deux chunks.
 */
export function sampleField(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  z: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const fx = x - 0.5;
  const fz = z - 0.5;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const x0 = clampIndex(ix, width - 1);
  const x1 = clampIndex(ix + 1, width - 1);
  const z0 = clampIndex(iz, height - 1);
  const z1 = clampIndex(iz + 1, height - 1);
  const top = (field[z0 * width + x0] ?? 0) * (1 - tx) + (field[z0 * width + x1] ?? 0) * tx;
  const bottom = (field[z1 * width + x0] ?? 0) * (1 - tx) + (field[z1 * width + x1] ?? 0) * tx;
  return top * (1 - tz) + bottom * tz;
}

/**
 * Hauteur monde du lit rendu sous une tuile d'eau.
 *
 * Toujours strictement sous `waterSurfaceHeight`, d'au moins
 * `WATER_BED_DROP - |WATER_LEVEL_OFFSET|` : aucun z-fighting possible.
 */
export function waterBedHeight(level: number): number {
  return tileTopHeight(level) - WATER_BED_DROP;
}

/** Hauteur monde de la surface pour un niveau de tuile d'eau. */
export function waterSurfaceHeight(level: number): number {
  return tileTopHeight(level) + WATER_LEVEL_OFFSET;
}

/**
 * Profondeur 0..1 d'un sommet du terrain, mesurée entre la surface d'eau
 * voisine et le lit réel.
 *
 * Le champ `shoreSurface` couvre l'eau **et** sa couronne de berge : la
 * profondeur suit donc la pente réelle du terrain au lieu de s'arrêter net au
 * premier sommet entièrement entouré d'eau (effet de rectangle #204). Un
 * sommet au-dessus de la nappe renvoie 0, ce qui réserve la teinte du fond aux
 * parties réellement immergées.
 */
export function waterDepthAt(
  fields: WaterHeightFields,
  width: number,
  height: number,
  x: number,
  z: number,
  bedHeight: number,
): number {
  const coverage = sampleCornerField(fields.coverage, width, height, x, z);
  if (!(coverage > 0)) return 0;
  const surface = sampleCornerField(fields.shoreSurface, width, height, x, z);
  const depth = (surface - bedHeight) / WATER_DEPTH_SPAN;
  return Number.isFinite(depth) ? Math.max(0, Math.min(1, depth)) : 0;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Distance à la terre → profondeur 0..1 (0 au bord, 1 au large). */
export function waterDepthFactor(distanceToLand: number): number {
  const distance = Number.isFinite(distanceToLand) ? Math.max(0, distanceToLand) : 0;
  return smoothstep(0.5, WATER_DEPTH_RANGE, distance);
}

/** Houle verticale déterministe, bornée par `WATER_WAVE_AMPLITUDE`. */
export function waterWaveHeight(seconds: number, x: number, z: number): number {
  const t = Number.isFinite(seconds) ? seconds : 0;
  let sum = 0;
  for (const term of WATER_WAVE_TERMS) {
    sum += Math.sin(t * term.time + x * term.x + z * term.z) * term.weight;
  }
  return sum * WATER_WAVE_AMPLITUDE;
}

/** Écume de côte : forte au bord, nulle au large. */
export function waterFoamAmount(depth: number, ripple: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.min(1, depth)) : 1;
  const r = Number.isFinite(ripple) ? Math.max(0, Math.min(1, ripple)) : 0;
  return (1 - smoothstep(0.01, WATER_FOAM_DEPTH, d)) * r;
}

/**
 * Opacité 0..1 de la nappe selon la hauteur libre au-dessus du terrain.
 *
 * Miroir CPU du fondu appliqué par le shader : nulle dès que le terrain
 * atteint la surface, pleine à `WATER_SHORE_FADE` au-dessus. C'est ce fondu
 * qui remplace l'arête rectangulaire du quad par une rive douce.
 */
export function waterShoreFade(clearance: number): number {
  const value = Number.isFinite(clearance) ? clearance : 0;
  return smoothstep(0, WATER_SHORE_FADE, value);
}

/**
 * Profondeur physique 0..1 sous la surface, bornée par l'écart lit/surface.
 */
export function waterPhysicalDepth(clearance: number): number {
  const value = Number.isFinite(clearance) ? clearance : 0;
  return Math.max(0, Math.min(1, value / WATER_DEPTH_SPAN));
}

/** Écart minimal (unités monde) avant de générer une paroi de rive. */
export const WATER_WALL_EPSILON = 0.02;

/**
 * Creusement minimal du lit rendu sous la nappe aval d'une marche, en unités
 * monde. Il garantit qu'aucun sommet du terrain ne dépasse la surface basse.
 */
export const WATER_STEP_BED_MARGIN = 0.28;

/**
 * Nature d'une marche d'eau :
 *
 * - `lock` : une écluse sépare deux biefs → bajoyer de pierre vertical ;
 * - `bank` : l'eau domine une berge sèche ou le décor hors-limites →
 *   soutènement minéral.
 *
 * Les nappes libres d'une même composante sont désormais aplanie sur un seul
 * niveau (#242) : plus aucune cascade ni rideau d'eau n'est produit.
 */
export type WaterWallKind = 'bank' | 'lock';

/**
 * Paroi verticale ou soutènement à la limite d'une tuile d'eau (#205).
 *
 * - autour d'une écluse, un bajoyer de pierre reste vertical : c'est la seule
 *   dénivellation légitime entre deux biefs ;
 * - entre l'eau et une berge plus basse, une paroi de berge remonte du sol
 *   jusqu'à la surface : la rive ne flotte plus au-dessus du vide.
 *
 * La face est générée par la tuile d'eau **haute** uniquement : deux tuiles
 * voisines ne produisent donc jamais la même face. Les bords de carte et le
 * vide reçoivent un soutènement minéral, jamais un mur d'eau.
 */
export interface WaterWallSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Hauteur basse (surface de l'eau voisine ou sol de la berge). */
  bottom: number;
  /** Hauteur haute, juste au-dessus de la crête de houle. */
  top: number;
  /** Vrai si la paroi sépare deux nappes, faux si c'est une berge. */
  water: boolean;
  /** Nature de la marche, pour choisir matériau et géométrie. */
  kind: WaterWallKind;
}

export function waterWallForEdge(
  map: MapSnapshot,
  fields: WaterHeightFields,
  x: number,
  y: number,
  dx: number,
  dy: number,
): WaterWallSegment | null {
  const { width, height } = map;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const index = y * width + x;
  if (fields.weight[index] !== 1) return null;
  const surface = fields.surface[index] ?? 0;
  const top = surface + WATER_WAVE_AMPLITUDE;
  const sourceKind = tileKindFromIndex(map.kind[index] ?? 0);
  const nx = x + dx;
  const ny = y + dy;
  const outside = nx < 0 || ny < 0 || nx >= width || ny >= height;
  const neighbour = outside ? -1 : ny * width + nx;
  const neighbourKind =
    neighbour >= 0 ? tileKindFromIndex(map.kind[neighbour] ?? 0) : ('void' as const);

  let bottom: number;
  let water: boolean;
  let kind: WaterWallKind;
  if (outside || neighbourKind === 'void') {
    // Raccord avec le décor hors-limites : le fond océanique est au niveau de
    // la mer. Une nappe plus haute (canal aboutissant au bord) ferme sa rive
    // par un soutènement minéral, sinon on laisserait un vide vertical. Plus
    // de rideau d'eau : la carte se termine sur une coupe de terrain propre.
    const sea = waterSurfaceHeight(0);
    if (surface <= sea + WATER_WALL_EPSILON) return null;
    bottom = sea;
    water = true;
    kind = sourceKind === 'lock' ? 'lock' : 'bank';
  } else if (fields.weight[neighbour] === 1) {
    // Deux nappes : la plus basse sert de pied à la paroi. Seule une écluse
    // peut encore créer une marche ; entre deux tuiles d'une même composante,
    // le nivellement du rendu (#242) garantit des surfaces identiques. Le
    // garde-fou minéral couvre un éventuel écart résiduel sans jamais dessiner
    // un mur d'eau.
    const other = fields.surface[neighbour] ?? 0;
    if (other >= surface - WATER_WALL_EPSILON) return null;
    bottom = other;
    water = true;
    kind = sourceKind === 'lock' || neighbourKind === 'lock' ? 'lock' : 'bank';
  } else {
    // Berge : si son dessus atteint déjà la nappe, le recouvrement de rive
    // suffit. Sinon l'eau flotte au-dessus d'un terrain plus bas : on ferme
    // le vide par une paroi qui monte jusqu'à la surface.
    const neighbourLevel = map.heightMap[neighbour] ?? 0;
    if (tileTopHeight(neighbourLevel) >= surface - WATER_WALL_EPSILON) return null;
    const leftX = dx !== 0 ? Math.max(x, nx) : x;
    const leftZ = dy !== 0 ? Math.max(y, ny) : y;
    const rightX = dx !== 0 ? leftX : x + 1;
    const rightZ = dy !== 0 ? leftZ : y + 1;
    const groundA = sampleCornerField(fields.bedRender, width, height, leftX, leftZ);
    const groundB = sampleCornerField(fields.bedRender, width, height, rightX, rightZ);
    const groundMid = sampleCornerField(
      fields.bedRender,
      width,
      height,
      (leftX + rightX) / 2,
      (leftZ + rightZ) / 2,
    );
    bottom = Math.min(tileTopHeight(neighbourLevel), groundA, groundB, groundMid);
    water = false;
    kind = sourceKind === 'lock' ? 'lock' : 'bank';
  }

  let x0: number;
  let z0: number;
  let x1: number;
  let z1: number;
  if (dx !== 0) {
    const edgeX = dx > 0 ? x + 1 : x;
    x0 = edgeX;
    z0 = y;
    x1 = edgeX;
    z1 = y + 1;
  } else {
    const edgeZ = dy > 0 ? y + 1 : y;
    x0 = x;
    z0 = edgeZ;
    x1 = x + 1;
    z1 = edgeZ;
  }
  return { x0, z0, x1, z1, bottom, top, water, kind };
}

/**
 * Constantes GLSL générées depuis les valeurs ci-dessus : une seule source de
 * vérité pour les bornes de houle, d'écume et d'atténuation.
 */
export const WATER_SHADER_CONSTANTS = `
const float WATER_WAVE_AMPLITUDE = ${WATER_WAVE_AMPLITUDE.toFixed(5)};
const float WATER_FOAM_DEPTH = ${WATER_FOAM_DEPTH.toFixed(5)};
const float WATER_RIPPLE_SCALE = ${WATER_RIPPLE_SCALE.toFixed(5)};
const float WATER_RIPPLE_FADE_NEAR = ${WATER_RIPPLE_FADE_NEAR.toFixed(1)};
const float WATER_RIPPLE_FADE_FAR = ${WATER_RIPPLE_FADE_FAR.toFixed(1)};
const float WATER_DEPTH_SPAN = ${WATER_DEPTH_SPAN.toFixed(5)};
const float WATER_SHORE_FADE = ${WATER_SHORE_FADE.toFixed(5)};
`;
