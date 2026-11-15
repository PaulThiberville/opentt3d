/**
 * Outils de construction des modèles procéduraux.
 *
 * Aucune texture ni ressource binaire : chaque pièce est une géométrie Three.js
 * (boîte biseautée, cylindre, extrusion) colorée par sommets, puis fusionnée
 * en une seule géométrie. Les couleurs de sommets sont volontairement claires
 * pour le corps : `InstancedMesh.setColorAt()` les multiplie par la couleur
 * d'entreprise. Les parties sombres (vitres, châssis, roues) restent sombres
 * dans toutes les livrées.
 *
 * Chaque sommet porte aussi `aFinish` (peinture, verre, métal, accent, etc.)
 * et `aGlow` (fenêtre, phare, feu) : le matériau partagé de `materials.ts`
 * module la rugosité, le métal et l'émission nocturne sans draw call en plus.
 * La couleur de base subit une usure déterministe (grain et salissure basse).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashUnit2d } from '../../game/prng';
import { hexToRgb } from '../tileVisuals';
import { MODEL_FINISH, MODEL_GLOW, type ModelFinish, type ModelGlow } from './materials';

/** Palette des parties de modèles (hex sRGB, multipliée par la couleur d'instance). */
export const MODEL_COLOURS = {
  /** Corps principal : blanc pur, prend toute la couleur d'entreprise. */
  body: 0xffffff,
  /** Panneaux secondaires ou livrée : très clair, teinté légèrement. */
  bodyShade: 0xf1f3f5,
  /** Toit : gris clair, garde un léger relief sous la teinte. */
  roof: 0xe2e6e9,
  /** Arêtes, jonc, entourages de vitres. */
  trim: 0xf7f8f9,
  /** Vitres : bleu-gris très sombre. */
  glass: 0x27333f,
  /** Vitres éclairées/secondaires. */
  glassLight: 0x3d5366,
  /** Châssis, bogies, passages de roues. */
  chassis: 0x24272c,
  /** Pneus et roues. */
  wheel: 0x1a1c20,
  /** Jantes, rambardes, métal sombre. */
  metal: 0x6d767f,
  /** Bois des wagons, teinté par la livrée. */
  wood: 0xb99a72,
  /** Cargaison sombre (charbon, conteneurs). */
  cargo: 0x30343a,
  /** Phares : jaune très clair. */
  lamp: 0xfff0c0,
  /** Feux arrière. */
  tailLight: 0x7a2323,
  /** Cheminée, échappement. */
  stack: 0x3a3d42,
  /** Filet de livrée clair, indépendant de la couleur d'entreprise. */
  accent: 0xf2efe6,
  /** Laiton, cuivre, ornements de machines à vapeur. */
  brass: 0xb08a4a,
  /** Œuvre vive / ligne de flottaison des navires, indépendante de la livrée. */
  hullRed: 0x7a2f28,
} as const;

export type ModelColour = number;

export type Axis = 'x' | 'y' | 'z';

export interface PartOptions {
  x?: number;
  y?: number;
  z?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  /** Finition imposée ; sinon déduite de la couleur de la pièce. */
  finish?: ModelFinish;
  /** Émission nocturne imposée ; sinon déduite de la couleur. */
  glow?: ModelGlow;
}

const FINISH_BY_COLOUR = new Map<number, ModelFinish>([
  [MODEL_COLOURS.body, MODEL_FINISH.paint],
  [MODEL_COLOURS.bodyShade, MODEL_FINISH.paint],
  [MODEL_COLOURS.trim, MODEL_FINISH.paint],
  [MODEL_COLOURS.roof, MODEL_FINISH.satin],
  [MODEL_COLOURS.glass, MODEL_FINISH.glass],
  [MODEL_COLOURS.glassLight, MODEL_FINISH.glass],
  [MODEL_COLOURS.chassis, MODEL_FINISH.metal],
  [MODEL_COLOURS.wheel, MODEL_FINISH.rubber],
  [MODEL_COLOURS.metal, MODEL_FINISH.metal],
  [MODEL_COLOURS.stack, MODEL_FINISH.metal],
  [MODEL_COLOURS.wood, MODEL_FINISH.accent],
  [MODEL_COLOURS.cargo, MODEL_FINISH.accent],
  [MODEL_COLOURS.lamp, MODEL_FINISH.accent],
  [MODEL_COLOURS.tailLight, MODEL_FINISH.accent],
  [MODEL_COLOURS.accent, MODEL_FINISH.accent],
  [MODEL_COLOURS.brass, MODEL_FINISH.metal],
  [MODEL_COLOURS.hullRed, MODEL_FINISH.accent],
]);

const GLOW_BY_COLOUR = new Map<number, ModelGlow>([
  [MODEL_COLOURS.lamp, MODEL_GLOW.headlight],
  [MODEL_COLOURS.tailLight, MODEL_GLOW.taillight],
  [MODEL_COLOURS.glass, MODEL_GLOW.windowDim],
  [MODEL_COLOURS.glassLight, MODEL_GLOW.window],
]);

/** Couleurs qui ne reçoivent ni grain ni salissure (phares, feux). */
const UNWEATHERED = new Set<number>([MODEL_COLOURS.lamp, MODEL_COLOURS.tailLight]);

/** Finition par défaut d'une couleur de pièce. */
export function finishForModelColour(colour: ModelColour): ModelFinish {
  return FINISH_BY_COLOUR.get(colour) ?? MODEL_FINISH.paint;
}

/** Émission nocturne par défaut d'une couleur de pièce. */
export function glowForModelColour(colour: ModelColour): ModelGlow {
  return GLOW_BY_COLOUR.get(colour) ?? MODEL_GLOW.none;
}

/**
 * Transforme une géométrie, la dé-indexe (pour que toutes les pièces d'un
 * modèle partagent les mêmes attributs) et lui applique une couleur uniforme
 * nuancée par une usure déterministe. La géométrie d'origine est libérée si
 * `toNonIndexed()` en crée une copie.
 */
export function paintPart(
  geometry: THREE.BufferGeometry,
  colour: ModelColour,
  options: PartOptions = {},
): THREE.BufferGeometry {
  if (options.rotateX) geometry.rotateX(options.rotateX);
  if (options.rotateY) geometry.rotateY(options.rotateY);
  if (options.rotateZ) geometry.rotateZ(options.rotateZ);
  geometry.translate(options.x ?? 0, options.y ?? 0, options.z ?? 0);

  let flat = geometry;
  if (geometry.index) {
    flat = geometry.toNonIndexed();
    geometry.dispose();
  }

  const position = flat.getAttribute('position');
  const count = position?.count ?? 0;
  const colours = new Float32Array(count * 3);
  const finishes = new Float32Array(count);
  const glows = new Float32Array(count);
  const rgb = hexToRgb(colour);
  const finish = options.finish ?? finishForModelColour(colour);
  const glow = options.glow ?? glowForModelColour(colour);
  const weathered = !UNWEATHERED.has(colour);
  finishes.fill(finish);
  glows.fill(glow);
  for (let i = 0; i < count; i += 1) {
    let factor = 1;
    if (weathered && position) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      // Voile de salissure près du sol, grain léger sur toute la pièce.
      const grime = Math.max(0, Math.min(1, 1 - y / 0.2));
      const grain = hashUnit2d(
        colour & 0xffffff,
        Math.round(x * 211 + z * 97),
        Math.round(y * 431),
      );
      factor = 1 - grime * 0.12 + (grain - 0.5) * 0.055;
    }
    colours[i * 3] = Math.max(0, Math.min(1, rgb.r * factor));
    colours[i * 3 + 1] = Math.max(0, Math.min(1, rgb.g * factor));
    colours[i * 3 + 2] = Math.max(0, Math.min(1, rgb.b * factor));
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  flat.setAttribute('aFinish', new THREE.BufferAttribute(finishes, 1));
  flat.setAttribute('aGlow', new THREE.BufferAttribute(glows, 1));
  return flat;
}

/** Boîte simple (12 triangles), centrée sur `(x, y, z)`. */
export function box(
  width: number,
  height: number,
  depth: number,
  colour: ModelColour,
  x = 0,
  y = 0,
  z = 0,
  options: Omit<PartOptions, 'x' | 'y' | 'z'> = {},
): THREE.BufferGeometry {
  return paintPart(new THREE.BoxGeometry(width, height, depth), colour, {
    ...options,
    x,
    y,
    z,
  });
}

/** Rectangle arrondi centré en (0, 0), utilisable dans une `Shape` ou une extrusion. */
export function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.max(0, Math.min(radius, halfWidth, halfHeight));
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + r, -halfHeight);
  shape.lineTo(halfWidth - r, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + r);
  shape.lineTo(halfWidth, halfHeight - r);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - r, halfHeight);
  shape.lineTo(-halfWidth + r, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - r);
  shape.lineTo(-halfWidth, -halfHeight + r);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + r, -halfHeight);
  shape.closePath();
  return shape;
}

/**
 * Boîte biseautée : extrusion d'un rectangle arrondi. Les arêtes verticales
 * sont adoucies sans ajouter de faces superflues sur les faces planes.
 */
export function beveledBox(
  width: number,
  height: number,
  depth: number,
  colour: ModelColour,
  options: PartOptions & { radius?: number; curveSegments?: number } = {},
): THREE.BufferGeometry {
  const radius = options.radius ?? Math.min(width, height) * 0.12;
  const shape = roundedRectShape(width, height, radius);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: options.curveSegments ?? 2,
    bevelEnabled: false,
  });
  geometry.translate(0, 0, -depth / 2);
  return paintPart(geometry, colour, options);
}

/** Cylindre orienté par défaut sur Y, centré sur `(x, y, z)`. */
export function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
  colour: ModelColour,
  options: PartOptions & { axis?: Axis } = {},
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    Math.max(3, Math.round(segments)),
    1,
    false,
  );
  if (options.axis === 'x') geometry.rotateZ(-Math.PI / 2);
  else if (options.axis === 'z') geometry.rotateX(Math.PI / 2);
  return paintPart(geometry, colour, options);
}

/** Roue : cylindre couché sur l'axe Z (essieu transversal) avec un moyeu sombre. */
export function wheel(
  radius: number,
  width: number,
  colour: ModelColour,
  x: number,
  y: number,
  z: number,
  segments = 10,
): THREE.BufferGeometry {
  return cylinder(radius, radius, width, segments, colour, { axis: 'z', x, y, z });
}

/** Jante plus claire, posée sur la face extérieure d'une roue (détail visuel). */
export function hub(
  radius: number,
  width: number,
  colour: ModelColour,
  x: number,
  y: number,
  z: number,
  segments = 8,
): THREE.BufferGeometry {
  const side = Math.sign(z) || 1;
  return cylinder(radius, radius, width, segments, colour, {
    axis: 'z',
    x,
    y,
    z: z + side * 0.002,
  });
}

/**
 * Extrude une forme 2D. Par défaut la forme est dans le plan XY et l'épaisseur
 * part de part et d'autre de Z (`-depth/2` à `+depth/2`) : pratique pour les
 * silhouettes latérales de véhicules (X = longueur, Y = hauteur).
 */
export function extrudeShape(
  shape: THREE.Shape,
  depth: number,
  colour: ModelColour,
  options: PartOptions & { curveSegments?: number; bevel?: number } = {},
): THREE.BufferGeometry {
  const bevel = options.bevel ?? 0;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: options.curveSegments ?? 3,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  return paintPart(geometry, colour, {
    x: options.x,
    y: options.y,
    z: options.z,
    rotateX: options.rotateX,
    rotateY: options.rotateY,
    rotateZ: options.rotateZ,
  });
}

/** Extrude une forme horizontale (plan XZ) sur une hauteur donnée, base à Y = 0. */
export function extrudePlan(
  shape: THREE.Shape,
  height: number,
  colour: ModelColour,
  options: PartOptions & { curveSegments?: number } = {},
): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    steps: 1,
    curveSegments: options.curveSegments ?? 3,
    bevelEnabled: false,
  });
  // Le plan de la forme devient XZ ; l'extrusion (Z local) devient Y.
  geometry.rotateX(-Math.PI / 2);
  // Après rotation, la base de l'extrusion est à Y = 0 et le sommet à Y = height.
  return paintPart(geometry, colour, {
    x: options.x,
    y: options.y,
    z: options.z,
    rotateY: options.rotateY,
    rotateZ: options.rotateZ,
  });
}

/** Fusionne des pièces hétérogènes (toutes dé-indexées et colorées). */
export function mergeParts(
  parts: readonly THREE.BufferGeometry[],
  name = 'model',
): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error(`Modèle « ${name} » sans aucune pièce`);
  const merged = mergeGeometries(parts as THREE.BufferGeometry[], false);
  if (!merged) throw new Error(`Fusion impossible pour le modèle « ${name} »`);
  for (const part of parts) part.dispose();
  merged.name = name;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Nombre de triangles d'une géométrie indexée ou non. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const position = geometry.getAttribute('position');
  return position ? Math.floor(position.count / 3) : 0;
}

export interface ModelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface GeometryMeasure {
  triangles: number;
  bounds: ModelBounds;
}

/** Mesure les bornes et le budget triangles d'une géométrie fusionnée. */
export function measureGeometry(geometry: THREE.BufferGeometry): GeometryMeasure {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const bounds: ModelBounds = {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
  return { triangles: triangleCount(geometry), bounds };
}

/** Libère une liste de géométries sans doublon. */
export function disposeGeometries(geometries: Iterable<THREE.BufferGeometry>): void {
  const seen = new Set<THREE.BufferGeometry>();
  for (const geometry of geometries) {
    if (seen.has(geometry)) continue;
    seen.add(geometry);
    geometry.dispose();
  }
}
