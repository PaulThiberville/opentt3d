/**
 * Modèles d'industries en code Three.js.
 *
 * `industryPlan.ts` décide de l'emprise et des volumes principaux ; ce module
 * transforme ce plan en une silhouette détaillée : façades vitrées, portes,
 * convoyeurs, terrasses de carrière, tuyauteries de raffinerie, clôtures de
 * ferme, piles de grumes. Toutes les parties sont fusionnées en une seule
 * géométrie à couleurs de sommets par archétype, ce qui garde quelques draw
 * calls pour une carte entière.
 *
 * Les ajouts de détail sont déterministes (graine dérivée de l'id et du type)
 * et bornés : chaque archétype reste sous 2 000 triangles, y compris au
 * niveau de détail maximal. Le niveau 0 ne conserve que les volumes du plan.
 * Chaque sommet reçoit une finition (`aFinish`) et une émission (`aGlow`) :
 * vitrages réflectifs, cheminées métalliques, toits satinés et fenêtres
 * éclairées la nuit, sans matériau ni draw call par archétype.
 */

import * as THREE from 'three';
import type { IndustryPlan, IndustryPart } from '../industryPlan';
import type { IndustryArchetype, IndustryDetail } from '../industryPlan';
import { Prng, hashUnit2d } from '../../game/prng';
import { MODEL_FINISH, MODEL_GLOW, type ModelFinish, type ModelGlow } from './materials';

type ModelShape = 'box' | 'prism' | 'cylinder' | 'cone' | 'ico' | 'sphere' | 'plane';

interface ModelPart {
  shape: ModelShape;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  colour: number;
  yaw: number;
  tiltX: number;
  tiltZ: number;
  topScale: number;
  /** Origine au centre vertical (objets couchés ou suspendus). */
  centre: boolean;
  /** Rôle du volume dans le plan (main, annex, stock, silo, chimney). */
  role?: string;
}

export interface IndustryGeometryStats {
  triangles: number;
  windows: number;
  parts: number;
}

export interface IndustryGeometryResult {
  geometry: THREE.BufferGeometry;
  stats: IndustryGeometryStats;
}

const GLASS = 0x33414d;
const DOOR = 0x3f3227;
const WARM_LIGHT = 0xff9a3c;

/** Finition et émission d'une partie d'industrie, déduites du plan. */
function industrySurface(part: { colour: number; shape: ModelShape; role?: string }): {
  finish: ModelFinish;
  glow: ModelGlow;
} {
  if (part.colour === GLASS) {
    return { finish: MODEL_FINISH.glass, glow: MODEL_GLOW.window };
  }
  if (part.colour === DOOR) {
    return { finish: MODEL_FINISH.accent, glow: MODEL_GLOW.none };
  }
  if (part.colour === WARM_LIGHT) {
    return { finish: MODEL_FINISH.accent, glow: MODEL_GLOW.headlight };
  }
  if (part.role === 'chimney') {
    return { finish: MODEL_FINISH.metal, glow: MODEL_GLOW.none };
  }
  if (part.role === 'silo' || part.shape === 'prism') {
    return { finish: MODEL_FINISH.satin, glow: MODEL_GLOW.none };
  }
  if (part.role === 'stock') {
    return { finish: MODEL_FINISH.accent, glow: MODEL_GLOW.none };
  }
  return { finish: MODEL_FINISH.paint, glow: MODEL_GLOW.none };
}

/** Convertit les parties du plan en parties de modèle (repère monde). */
function planParts(plan: IndustryPlan): ModelPart[] {
  return plan.parts.map((part) => ({
    shape: part.shape,
    x: part.x,
    y: part.ground + part.base,
    z: part.z,
    width: part.width,
    height: part.height,
    depth: part.depth,
    colour: part.colour,
    yaw: part.rotation,
    tiltX: part.tiltX,
    tiltZ: part.tiltZ,
    topScale: part.topScale,
    centre: part.centre,
    role: part.role,
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function findPart(
  parts: readonly IndustryPart[],
  roles: readonly string[],
  predicate?: (part: IndustryPart) => boolean,
): IndustryPart | undefined {
  return parts.find((part) => roles.includes(part.role) && (!predicate || predicate(part)));
}

/**
 * Ajoute les ouvertures sur les plus grands volumes du plan.
 * Les vitrages sont des quads fusionnés, jamais des meshes séparés.
 */
function addFacadeDetails(
  target: ModelPart[],
  plan: IndustryPlan,
  detail: IndustryDetail,
  rng: Prng,
): void {
  const facades = plan.parts
    .filter(
      (part) =>
        part.shape === 'box' &&
        part.tiltX === 0 &&
        part.tiltZ === 0 &&
        part.width >= 0.42 &&
        part.depth >= 0.36 &&
        part.height >= 0.42 &&
        (part.role === 'main' || part.role === 'annex'),
    )
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, detail >= 2 ? 3 : 2);

  for (const part of facades) {
    const base = part.ground + part.base;
    const columns = clamp(Math.round(part.width / 0.22), 1, 3);
    const rows = clamp(Math.floor((part.height - 0.14) / 0.22), 1, 3);
    const winWidth = Math.min(0.1, (part.width - 0.18) / columns - 0.03);
    const winHeight = Math.min(0.12, (part.height - 0.12) / rows - 0.04);
    if (winWidth > 0.03 && winHeight > 0.03) {
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const offset =
            columns === 1
              ? 0
              : -part.width / 2 + 0.09 + (column * (part.width - 0.18)) / (columns - 1);
          const y = base + 0.09 + row * ((part.height - 0.12) / Math.max(1, rows));
          if (y + winHeight / 2 > base + part.height - 0.03) continue;
          target.push({
            shape: 'plane',
            x: part.x + offset,
            y,
            z: part.z + part.depth / 2 + 0.004,
            width: winWidth,
            height: winHeight,
            depth: 1,
            colour: GLASS,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
          // Un tiers des volumes reçoivent aussi un vitrage arrière.
          if (rng.chance(0.45)) {
            target.push({
              shape: 'plane',
              x: part.x + offset,
              y,
              z: part.z - part.depth / 2 - 0.004,
              width: winWidth,
              height: winHeight,
              depth: 1,
              colour: GLASS,
              yaw: Math.PI,
              tiltX: 0,
              tiltZ: 0,
              topScale: 1,
              centre: false,
            });
          }
        }
      }
    }
    // Porte au centre de la façade, toujours visible depuis le sud.
    target.push({
      shape: 'plane',
      x: part.x,
      y: base + 0.085,
      z: part.z + part.depth / 2 + 0.006,
      width: Math.min(0.14, part.width * 0.26),
      height: Math.min(0.17, part.height * 0.4),
      depth: 1,
      colour: DOOR,
      yaw: 0,
      tiltX: 0,
      tiltZ: 0,
      topScale: 1,
      centre: false,
    });
    target.push({
      shape: 'box',
      x: part.x,
      y: base,
      z: part.z + part.depth / 2 + 0.012,
      width: Math.min(0.2, part.width * 0.5),
      height: 0.015,
      depth: 0.05,
      colour: 0xb9b2a2,
      yaw: 0,
      tiltX: 0,
      tiltZ: 0,
      topScale: 1,
      centre: false,
    });
  }
}

interface Point {
  x: number;
  y: number;
  z: number;
}

/** Convoyeur incliné entre deux points, avec deux pieds de soutien. */
function addConveyor(
  target: ModelPart[],
  from: Point,
  to: Point,
  colour: number,
  width = 0.22,
): void {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 0.12) return;
  const dy = to.y - from.y;
  const length = Math.hypot(horizontal, dy);
  const yaw = Math.atan2(-dz, dx);
  const tiltZ = Math.atan2(dy, horizontal);
  target.push({
    shape: 'box',
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
    z: (from.z + to.z) / 2,
    width: length,
    height: 0.055,
    depth: width,
    colour,
    yaw,
    tiltX: 0,
    tiltZ,
    topScale: 1,
    centre: true,
  });
  // Bordures latérales : le convoyeur se lit comme une bande, pas un rail.
  const sideX = Math.sin(yaw) * 0.13;
  const sideZ = Math.cos(yaw) * 0.13;
  for (const side of [-1, 1]) {
    target.push({
      shape: 'box',
      x: (from.x + to.x) / 2 + sideX * side,
      y: (from.y + to.y) / 2 + 0.035,
      z: (from.z + to.z) / 2 + sideZ * side,
      width: length,
      height: 0.07,
      depth: 0.022,
      colour: 0x4b443a,
      yaw,
      tiltX: 0,
      tiltZ,
      topScale: 1,
      centre: true,
    });
  }
  // Pieds verticaux sous le tablier.
  for (const ratio of [0.3, 0.72]) {
    const x = from.x + dx * ratio;
    const z = from.z + dz * ratio;
    const y = from.y + dy * ratio;
    target.push({
      shape: 'box',
      x,
      y: 0,
      z,
      width: 0.04,
      height: Math.max(0.05, y),
      depth: 0.04,
      colour: 0x5f5a52,
      yaw: 0,
      tiltX: 0,
      tiltZ: 0,
      topScale: 1,
      centre: false,
    });
  }
}

function addPipe(
  target: ModelPart[],
  from: Point,
  to: Point,
  colour: number,
  diameter = 0.07,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  const length = Math.hypot(horizontal, dy);
  if (length < 0.05) return;
  target.push({
    shape: 'cylinder',
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
    z: (from.z + to.z) / 2,
    width: diameter,
    height: length,
    depth: diameter,
    colour,
    yaw: Math.atan2(-dz, dx),
    tiltX: 0,
    tiltZ: Math.PI / 2 - Math.atan2(dy, horizontal),
    topScale: 1,
    centre: true,
  });
}

function addLog(
  target: ModelPart[],
  x: number,
  y: number,
  z: number,
  length: number,
  colour: number,
): void {
  target.push({
    shape: 'cylinder',
    x,
    y: y + 0.08,
    z,
    width: 0.16,
    height: length,
    depth: 0.16,
    colour,
    yaw: 0,
    tiltX: 0,
    tiltZ: Math.PI / 2,
    topScale: 1,
    centre: true,
  });
}

/** Détails de silhouette spécifiques à chaque archétype. */
function addArchetypeDetails(
  target: ModelPart[],
  plan: IndustryPlan,
  archetype: IndustryArchetype,
): void {
  const main = findPart(plan.parts, ['main'], (part) => part.width >= 0.4);
  const stock = findPart(plan.parts, ['stock']);
  const annex = findPart(plan.parts, ['annex']);
  const chimney = findPart(plan.parts, ['chimney']);
  const silo = findPart(plan.parts, ['silo']);

  switch (archetype) {
    case 'mine': {
      if (main && stock) {
        addConveyor(
          target,
          { x: main.x, y: main.ground + main.height * 0.9, z: main.z },
          { x: stock.x, y: stock.ground + stock.height + 0.05, z: stock.z },
          0x5b4a36,
        );
        target.push({
          shape: 'cone',
          x: stock.x,
          y: stock.ground + stock.height + 0.02,
          z: stock.z,
          width: 0.3,
          height: 0.24,
          depth: 0.3,
          colour: 0x4a4038,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      // Voie étroite et wagonnet devant le chevalement.
      if (main) {
        for (let index = 0; index < 5; index += 1) {
          target.push({
            shape: 'box',
            x: main.x - 0.32 + index * 0.16,
            y: main.ground + 0.015,
            z: main.z + 0.38,
            width: 0.14,
            height: 0.02,
            depth: 0.06,
            colour: 0x4f463c,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
        target.push({
          shape: 'box',
          x: main.x - 0.16,
          y: main.ground + 0.03,
          z: main.z + 0.38,
          width: 0.16,
          height: 0.12,
          depth: 0.14,
          colour: 0x5a5148,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      break;
    }
    case 'power': {
      if (silo) {
        // Anneaux de refroidissement autour de la tour.
        for (let ring = 0; ring < 2; ring += 1) {
          target.push({
            shape: 'cylinder',
            x: silo.x,
            y: silo.ground + 0.18 + ring * 0.34,
            z: silo.z,
            width: silo.width * (1.04 + ring * 0.04),
            height: 0.09,
            depth: silo.width * (1.04 + ring * 0.04),
            colour: 0x8f9296,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
      }
      if (chimney) {
        target.push({
          shape: 'cylinder',
          x: chimney.x,
          y: chimney.ground + chimney.height - 0.18,
          z: chimney.z,
          width: chimney.width + 0.06,
          height: 0.06,
          depth: chimney.width + 0.06,
          colour: 0x6d6a67,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      // Transformateurs et pylônes basse tension.
      if (annex) {
        target.push({
          shape: 'box',
          x: annex.x + annex.width * 0.36,
          y: annex.ground,
          z: annex.z - annex.depth * 0.34,
          width: 0.18,
          height: 0.14,
          depth: 0.12,
          colour: 0x707478,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
        target.push({
          shape: 'box',
          x: annex.x + annex.width * 0.36,
          y: annex.ground + 0.14,
          z: annex.z - annex.depth * 0.34,
          width: 0.16,
          height: 0.03,
          depth: 0.1,
          colour: 0x4f5357,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      break;
    }
    case 'factory': {
      if (main && annex) {
        addConveyor(
          target,
          { x: main.x, y: main.ground + main.height * 0.7, z: main.z },
          { x: annex.x, y: annex.ground + annex.height * 0.8, z: annex.z },
          0x6b6257,
        );
      }
      // Lanterneaux et évents de toit.
      const roofPart = plan.parts.find((part) => part.shape === 'prism');
      if (roofPart) {
        for (let index = 0; index < 3; index += 1) {
          target.push({
            shape: 'box',
            x: roofPart.x - 0.24 + index * 0.24,
            y: roofPart.ground + roofPart.base + roofPart.height - 0.02,
            z: roofPart.z,
            width: 0.14,
            height: 0.08,
            depth: 0.2,
            colour: 0x7c8288,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
      }
      if (annex) {
        target.push({
          shape: 'box',
          x: annex.x,
          y: annex.ground,
          z: annex.z + annex.depth / 2 + 0.08,
          width: annex.width * 0.8,
          height: 0.1,
          depth: 0.16,
          colour: 0x8a8378,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      break;
    }
    case 'sawmill': {
      if (main && stock) {
        addConveyor(
          target,
          { x: main.x, y: main.ground + main.height * 0.72, z: main.z },
          { x: stock.x, y: stock.ground + stock.height + 0.04, z: stock.z },
          0x5c452e,
        );
      }
      // Tuyau d'extraction de sciure le long du toit.
      if (main) {
        addPipe(
          target,
          { x: main.x - 0.3, y: main.ground + main.height + 0.24, z: main.z },
          { x: main.x + 0.3, y: main.ground + main.height + 0.24, z: main.z },
          0x7d7f80,
          0.06,
        );
      }
      break;
    }
    case 'farm': {
      // Clôture légère sur le bord sud de l'emprise.
      const footprint = plan.footprint;
      if (footprint.length > 1) {
        let minX = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        for (const tile of footprint) {
          minX = Math.min(minX, tile.x);
          maxX = Math.max(maxX, tile.x);
          maxZ = Math.max(maxZ, tile.y);
        }
        const z = maxZ + 0.92;
        const length = Math.min(1.7, maxX - minX + 0.8);
        const startX = (minX + maxX) / 2 + 0.5 - length / 2;
        for (let index = 0; index < 7; index += 1) {
          target.push({
            shape: 'box',
            x: startX + (index * length) / 6,
            y: 0,
            z,
            width: 0.025,
            height: 0.17,
            depth: 0.025,
            colour: 0x8a7350,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
        for (const height of [0.07, 0.13]) {
          target.push({
            shape: 'box',
            x: startX + length / 2,
            y: height,
            z,
            width: length,
            height: 0.018,
            depth: 0.018,
            colour: 0x9b825a,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
      }
      // Bottes de foin.
      if (annex) {
        for (let index = 0; index < 3; index += 1) {
          target.push({
            shape: 'cylinder',
            x: annex.x - 0.24 + index * 0.12,
            y: annex.ground + 0.08 + (index % 2) * 0.02,
            z: annex.z + annex.depth / 2 + 0.12,
            width: 0.14,
            height: 0.18,
            depth: 0.14,
            colour: 0xc7a95e,
            yaw: 0,
            tiltX: 0,
            tiltZ: Math.PI / 2,
            topScale: 1,
            centre: true,
          });
        }
      }
      break;
    }
    case 'forest': {
      if (annex) {
        for (let index = 0; index < 3; index += 1) {
          addLog(
            target,
            annex.x - 0.2 + index * 0.12,
            annex.ground + (index % 2) * 0.13,
            annex.z + annex.depth / 2 + 0.16,
            0.42,
            0x6d5334,
          );
        }
        // Chemin de terre sombre devant la cabane.
        target.push({
          shape: 'plane',
          x: annex.x,
          y: annex.ground + 0.004,
          z: annex.z + annex.depth / 2 + 0.3,
          width: annex.width * 1.1,
          height: 0.3,
          depth: 1,
          colour: 0x6b5942,
          yaw: 0,
          tiltX: -Math.PI / 2,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      break;
    }
    case 'refinery': {
      const silos = plan.parts.filter((part) => part.role === 'silo');
      const first = silos[0];
      const second = silos[1];
      if (first && second) {
        addPipe(
          target,
          {
            x: first.x,
            y: first.ground + first.height * 0.82,
            z: first.z,
          },
          {
            x: second.x,
            y: second.ground + second.height * 0.82,
            z: second.z,
          },
          0x9ba0a4,
          0.06,
        );
      }
      if (stock) {
        // Cuve sphérique sur trois pieds.
        target.push({
          shape: 'sphere',
          x: stock.x,
          y: stock.ground + 0.38,
          z: stock.z,
          width: 0.36,
          height: 0.36,
          depth: 0.36,
          colour: 0xb6babd,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: true,
        });
        for (const offset of [-1, 0, 1]) {
          target.push({
            shape: 'box',
            x: stock.x + offset * 0.11,
            y: 0,
            z: stock.z + (offset === 0 ? 0.12 : -0.06),
            width: 0.03,
            height: 0.32,
            depth: 0.03,
            colour: 0x777b7e,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
      }
      if (chimney) {
        target.push({
          shape: 'cylinder',
          x: chimney.x,
          y: chimney.ground + chimney.height + 0.02,
          z: chimney.z,
          width: chimney.width * 1.15,
          height: 0.05,
          depth: chimney.width * 1.15,
          colour: 0x8c9094,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      // Salle de contrôle : petit volume vitré qui donne une échelle humaine.
      const controlTile = plan.footprint[plan.footprint.length - 1];
      if (controlTile) {
        const x = controlTile.x + 0.5;
        const z = controlTile.y + 0.5;
        const base = controlTile.height;
        target.push({
          shape: 'box',
          x,
          y: base,
          z,
          width: 0.46,
          height: 0.34,
          depth: 0.38,
          colour: 0xa8adb2,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
        target.push({
          shape: 'box',
          x,
          y: base + 0.34,
          z,
          width: 0.5,
          height: 0.04,
          depth: 0.42,
          colour: 0x757b82,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
        for (const offset of [-0.12, 0.06]) {
          target.push({
            shape: 'plane',
            x: x + offset,
            y: base + 0.2,
            z: z + 0.192,
            width: 0.11,
            height: 0.1,
            depth: 1,
            colour: GLASS,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
        target.push({
          shape: 'plane',
          x: x + 0.14,
          y: base + 0.09,
          z: z + 0.194,
          width: 0.09,
          height: 0.17,
          depth: 1,
          colour: DOOR,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      break;
    }
    case 'quarry': {
      // Terrasses concentriques de l'excavation.
      const pit = findPart(plan.parts, ['main', 'stock']);
      if (pit) {
        for (let terrace = 0; terrace < 3; terrace += 1) {
          target.push({
            shape: 'cylinder',
            x: pit.x,
            y: pit.ground + terrace * 0.1,
            z: pit.z,
            width: 0.9 - terrace * 0.2,
            height: 0.11,
            depth: 0.9 - terrace * 0.2,
            colour: terrace % 2 === 0 ? 0x8e877a : 0x9d978a,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1.08,
            centre: false,
          });
        }
        if (stock) {
          addConveyor(
            target,
            { x: pit.x, y: pit.ground + 0.24, z: pit.z },
            { x: stock.x, y: stock.ground + stock.height + 0.02, z: stock.z },
            0x6f6a60,
            0.2,
          );
        }
      }
      // Tas de gravats supplémentaires.
      if (annex) {
        target.push({
          shape: 'cone',
          x: annex.x + annex.width * 0.3,
          y: annex.ground,
          z: annex.z + annex.depth * 0.3,
          width: 0.26,
          height: 0.16,
          depth: 0.26,
          colour: 0x8a8275,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          topScale: 1,
          centre: false,
        });
      }
      break;
    }
    case 'generic':
    default: {
      if (annex) {
        for (let index = 0; index < 3; index += 1) {
          target.push({
            shape: 'box',
            x: annex.x - 0.18 + index * 0.1,
            y: annex.ground,
            z: annex.z - annex.depth / 2 - 0.1,
            width: 0.09,
            height: 0.08,
            depth: 0.09,
            colour: 0x8a6a45,
            yaw: 0,
            tiltX: 0,
            tiltZ: 0,
            topScale: 1,
            centre: false,
          });
        }
      }
      break;
    }
  }
}

function detailParts(plan: IndustryPlan, detail: IndustryDetail): ModelPart[] {
  const parts = planParts(plan);
  if (detail < 1) return parts;
  const rng = new Prng((plan.id + 1) * 6151 + plan.archetype.length * 131);
  addFacadeDetails(parts, plan, detail, rng);
  if (detail >= 2) addArchetypeDetails(parts, plan, plan.archetype);
  return parts;
}

function primitiveGeometry(part: ModelPart): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  switch (part.shape) {
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(
        Math.max(0.02, part.topScale) * 0.5,
        0.5,
        1,
        8,
        1,
        false,
      );
      break;
    case 'cone':
      geometry = new THREE.ConeGeometry(0.5, 1, 8);
      break;
    case 'prism':
      geometry = prismGeometry();
      break;
    case 'ico':
      geometry = new THREE.IcosahedronGeometry(0.5, 0);
      break;
    case 'sphere':
      geometry = new THREE.IcosahedronGeometry(0.5, 1);
      break;
    case 'plane':
      geometry = new THREE.PlaneGeometry(1, 1);
      break;
    case 'box':
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
  }
  if (part.shape === 'plane') return geometry;
  // Les primitives Three sont centrées (box, cylindre, cône, sphère) ;
  // seuls les grumes/objets couchés restent centrés, tout le reste est posé
  // sur le sol. Le prisme maison a déjà sa base à y = 0.
  if (part.centre || part.shape === 'ico' || part.shape === 'sphere') return geometry;
  if (part.shape !== 'prism') geometry.translate(0, 0.5, 0);
  return geometry;
}

function prismGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array([
    -0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5, -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0,
    1, -0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0,
    -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Fusionne les parties d'un lot de plans en une géométrie unique. */
export function buildIndustryGeometry(
  plans: readonly IndustryPlan[],
  detail: IndustryDetail,
): IndustryGeometryResult {
  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];
  const finishes: number[] = [];
  const glows: number[] = [];
  const rgb = { r: 0, g: 0, b: 0 };
  let triangles = 0;
  let windows = 0;
  let partCount = 0;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const euler = new THREE.Euler();
  const up = new THREE.Vector3(0, 1, 0);

  for (const plan of plans) {
    for (const part of detailParts(plan, detail)) {
      const geometry = primitiveGeometry(part);
      euler.set(part.tiltX, part.yaw, part.tiltZ, 'YXZ');
      quaternion.setFromEuler(euler);
      position.set(part.x, part.y, part.z);
      scale.set(part.width, part.height, part.depth);
      matrix.compose(position, quaternion, scale);
      geometry.applyMatrix4(matrix);
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      const positionAttribute = flat.getAttribute('position');
      const normalAttribute = flat.getAttribute('normal');
      hexToRgb(part.colour, rgb);
      const surface = industrySurface(part);
      const count = positionAttribute.count;
      for (let index = 0; index < count; index += 1) {
        const px = positionAttribute.getX(index);
        const py = positionAttribute.getY(index);
        const pz = positionAttribute.getZ(index);
        positions.push(px, py, pz);
        normals.push(
          normalAttribute ? normalAttribute.getX(index) : up.x,
          normalAttribute ? normalAttribute.getY(index) : up.y,
          normalAttribute ? normalAttribute.getZ(index) : up.z,
        );
        // Usure et salissure déterministes, sans texture.
        const grime = Math.max(0, Math.min(1, 1 - py / 0.2));
        const grain = hashUnit2d(
          part.colour & 0xffffff,
          Math.round(px * 181 + pz * 73),
          Math.round(py * 397),
        );
        const factor = 1 - grime * 0.11 + (grain - 0.5) * 0.05;
        colours.push(
          Math.max(0, Math.min(1, rgb.r * factor)),
          Math.max(0, Math.min(1, rgb.g * factor)),
          Math.max(0, Math.min(1, rgb.b * factor)),
        );
        finishes.push(surface.finish);
        glows.push(surface.glow);
      }
      triangles += count / 3;
      partCount += 1;
      if (part.shape === 'plane') windows += 1;
      if (flat !== geometry) flat.dispose();
      geometry.dispose();
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  merged.setAttribute('aFinish', new THREE.Float32BufferAttribute(finishes, 1));
  merged.setAttribute('aGlow', new THREE.Float32BufferAttribute(glows, 1));
  merged.computeBoundingSphere();
  return { geometry: merged, stats: { triangles, windows, parts: partCount } };
}

function hexToRgb(hex: number, out: { r: number; g: number; b: number }): typeof out {
  out.r = ((hex >> 16) & 0xff) / 255;
  out.g = ((hex >> 8) & 0xff) / 255;
  out.b = (hex & 0xff) / 255;
  return out;
}
