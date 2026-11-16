/**
 * Rendu des ponts et tunnels (#154/#155).
 *
 * Une seule géométrie fusionnée porte tous les tabliers et tous les portails :
 * il n'y a jamais un mesh par segment d'ouvrage. Deux niveaux de détail sont
 * construits une fois :
 *
 * - base : tablier, rampes, encadrements de portails — visible de loin ;
 * - détail : garde-corps, piles et claveaux — visible à courte distance.
 *
 * Le snapshot fournit `structures[]` quand le moteur les expose ; sinon la
 * couche infère des ouvrages rectilignes à partir des types de tuiles, ce qui
 * garde les anciens builds WASM lisibles.
 */

import * as THREE from 'three';
import {
  COMPANY_NONE,
  TILE_KIND_INDEX,
  type BridgeMaterial,
  type MapSnapshot,
  type StructureSnapshot,
} from '../engine/protocol';
import { sampleHeightWorld, tileIndex } from '../game/mapGrid';
import type { QualityLevel } from './quality';

const TILE_KIND_BRIDGE = TILE_KIND_INDEX.bridge;
const TILE_KIND_TUNNEL = TILE_KIND_INDEX.tunnel;

const MATERIAL_COLOURS: Record<BridgeMaterial, { deck: number; side: number; rail: number }> = {
  wood: { deck: 0x8a6a43, side: 0x6a4e30, rail: 0x5c4329 },
  concrete: { deck: 0xa8a49b, side: 0x7d7a72, rail: 0x8d8a82 },
  steel: { deck: 0x7d8b99, side: 0x596570, rail: 0x4d5963 },
  suspension: { deck: 0xb06a45, side: 0x804a30, rail: 0xd08a62 },
  cantilever: { deck: 0x9a5a4a, side: 0x6f3e33, rail: 0xbb7a68 },
  tubular: { deck: 0x5f8f8a, side: 0x416863, rail: 0x8ab8b2 },
};

const PORTAL_COLOUR = 0x6b655b;
const PORTAL_DARK = 0x1f2226;
const DECK_THICKNESS = 0.18;
const RAIL_HEIGHT = 0.34;
const PILLAR_INTERVAL = 3;
const DETAIL_RANGE_MEDIUM = 48;
const DETAIL_RANGE_HIGH = 76;

interface GeometryWriter {
  positions: number[];
  colours: number[];
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

function createWriter(): GeometryWriter {
  return { positions: [], colours: [] };
}

function pushVertex(writer: GeometryWriter, point: Point3, colour: THREE.Color): void {
  writer.positions.push(point.x, point.y, point.z);
  writer.colours.push(colour.r, colour.g, colour.b);
}

function quad(
  writer: GeometryWriter,
  a: Point3,
  b: Point3,
  c: Point3,
  d: Point3,
  colour: THREE.Color,
): void {
  pushVertex(writer, a, colour);
  pushVertex(writer, b, colour);
  pushVertex(writer, c, colour);
  pushVertex(writer, a, colour);
  pushVertex(writer, c, colour);
  pushVertex(writer, d, colour);
}

/** Boîte alignée sur les axes du monde (suffisante pour piles et portails). */
function box(
  writer: GeometryWriter,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  colour: THREE.Color,
): void {
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  quad(
    writer,
    { x: x0, y: y1, z: z0 },
    { x: x1, y: y1, z: z0 },
    { x: x1, y: y1, z: z1 },
    { x: x0, y: y1, z: z1 },
    colour,
  );
  quad(
    writer,
    { x: x0, y: y0, z: z1 },
    { x: x1, y: y0, z: z1 },
    { x: x1, y: y0, z: z0 },
    { x: x0, y: y0, z: z0 },
    colour,
  );
  quad(
    writer,
    { x: x0, y: y1, z: z1 },
    { x: x1, y: y1, z: z1 },
    { x: x1, y: y0, z: z1 },
    { x: x0, y: y0, z: z1 },
    colour,
  );
  quad(
    writer,
    { x: x1, y: y1, z: z0 },
    { x: x0, y: y1, z: z0 },
    { x: x0, y: y0, z: z0 },
    { x: x1, y: y0, z: z0 },
    colour,
  );
  quad(
    writer,
    { x: x1, y: y1, z: z1 },
    { x: x1, y: y1, z: z0 },
    { x: x1, y: y0, z: z0 },
    { x: x1, y: y0, z: z1 },
    colour,
  );
  quad(
    writer,
    { x: x0, y: y1, z: z0 },
    { x: x0, y: y1, z: z1 },
    { x: x0, y: y0, z: z1 },
    { x: x0, y: y0, z: z0 },
    colour,
  );
}

function writerToGeometry(writer: GeometryWriter): THREE.BufferGeometry | null {
  if (writer.positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(writer.positions), 3),
  );
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(writer.colours), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function triangleCount(geometry: THREE.BufferGeometry | null): number {
  if (!geometry) return 0;
  const position = geometry.getAttribute('position');
  return position ? Math.floor(position.count / 3) : 0;
}

/** Lit un tableau `structures[]` absent en inférant les ouvrages de la carte. */
export function inferStructures(map: MapSnapshot): StructureSnapshot[] {
  const structures: StructureSnapshot[] = [];
  let nextId = 0;
  for (const kind of ['bridge', 'tunnel'] as const) {
    const target = kind === 'bridge' ? TILE_KIND_BRIDGE : TILE_KIND_TUNNEL;
    const visited = new Uint8Array(map.width * map.height);
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const start = tileIndex(x, y, map.width);
        if (visited[start] || map.kind[start] !== target) continue;
        const tiles: number[] = [];
        const stack = [start];
        visited[start] = 1;
        while (stack.length > 0) {
          const index = stack.pop();
          if (index === undefined) continue;
          tiles.push(index);
          const tx = index % map.width;
          const ty = Math.floor(index / map.width);
          for (const [nx, ny] of [
            [tx - 1, ty],
            [tx + 1, ty],
            [tx, ty - 1],
            [tx, ty + 1],
          ] as const) {
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            const neighbour = tileIndex(nx, ny, map.width);
            if (visited[neighbour] || map.kind[neighbour] !== target) continue;
            visited[neighbour] = 1;
            stack.push(neighbour);
          }
        }
        if (tiles.length < 2) continue;
        let minX = map.width;
        let maxX = 0;
        let minY = map.height;
        let maxY = 0;
        for (const index of tiles) {
          const tx = index % map.width;
          const ty = Math.floor(index / map.width);
          minX = Math.min(minX, tx);
          maxX = Math.max(maxX, tx);
          minY = Math.min(minY, ty);
          maxY = Math.max(maxY, ty);
        }
        // Un ouvrage est rectiligne : on ignore une composante en L.
        if (minX !== maxX && minY !== maxY) continue;
        const from = { x: minX, y: minY };
        const to = { x: maxX, y: maxY };
        const first = tileIndex(from.x, from.y, map.width);
        const last = tileIndex(to.x, to.y, map.width);
        const company = map.owner[first] ?? COMPANY_NONE;
        if (kind === 'bridge') {
          structures.push({
            id: nextId,
            kind: 'bridge',
            company,
            transport: 'rail',
            material: 'wood',
            from,
            to,
            length: tiles.length,
            deckHeight: Math.max(map.heightMap[first] ?? 0, map.heightMap[last] ?? 0) + 2,
          });
        } else {
          structures.push({
            id: nextId,
            kind: 'tunnel',
            company,
            transport: 'rail',
            from,
            to,
            length: tiles.length,
            portalHeight: map.heightMap[first] ?? 0,
          });
        }
        nextId += 1;
      }
    }
  }
  return structures;
}

function structureTileIndices(structure: StructureSnapshot, width: number): number[] {
  const dx = Math.sign(structure.to.x - structure.from.x);
  const dy = Math.sign(structure.to.y - structure.from.y);
  const count =
    Math.abs(structure.to.x - structure.from.x) + Math.abs(structure.to.y - structure.from.y) + 1;
  const indices: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = structure.from.x + dx * i;
    const y = structure.from.y + dy * i;
    indices.push(tileIndex(x, y, width));
  }
  return indices;
}

function structureCentre(structure: StructureSnapshot): { x: number; y: number } {
  return {
    x: (structure.from.x + structure.to.x) / 2 + 0.5,
    y: (structure.from.y + structure.to.y) / 2 + 0.5,
  };
}

function directionOf(structure: StructureSnapshot): { x: number; y: number } {
  return {
    x: Math.sign(structure.to.x - structure.from.x),
    y: Math.sign(structure.to.y - structure.from.y),
  };
}

export class StructureLayer {
  readonly group = new THREE.Group();

  private baseMesh: THREE.Mesh;
  private detailMesh: THREE.Mesh;
  private material: THREE.MeshLambertMaterial;
  private structures: StructureSnapshot[] = [];
  private map: MapSnapshot | null = null;
  private signature = '';
  private detailRange = DETAIL_RANGE_MEDIUM;
  private shadows = false;
  private detailVisible = true;
  private cameraX = 0;
  private cameraZ = 0;
  private cameraKnown = false;

  constructor() {
    this.group.name = 'structures';
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.baseMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.baseMesh.name = 'structure-base';
    this.baseMesh.receiveShadow = true;
    this.detailMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.detailMesh.name = 'structure-detail';
    this.detailMesh.receiveShadow = true;
    this.group.add(this.baseMesh, this.detailMesh);
    this.group.visible = false;
  }

  get count(): number {
    return this.structures.length;
  }

  get triangleCount(): number {
    return triangleCount(this.baseMesh.geometry) + triangleCount(this.detailMesh.geometry);
  }

  get drawCallCount(): number {
    let calls = 0;
    if (this.baseMesh.geometry.getAttribute('position')) calls += 1;
    if (this.detailVisible && this.detailMesh.geometry.getAttribute('position')) calls += 1;
    return calls;
  }

  get detailShown(): boolean {
    return this.detailVisible;
  }

  /** Reconstruit tabliers, rampes et portails depuis le snapshot. */
  setStructures(structures: readonly StructureSnapshot[], map: MapSnapshot | null): void {
    const signature = `${map?.width ?? 0}x${map?.height ?? 0}:${structures
      .map(
        (structure) =>
          `${structure.id}/${structure.kind}/${structure.from.x},${structure.from.y}-${structure.to.x},${structure.to.y}/${structure.length}/${structure.kind === 'bridge' ? structure.material : structure.portalHeight}`,
      )
      .join('|')}`;
    if (signature === this.signature && map === this.map) return;
    this.map = map;
    this.signature = signature;
    const resolved = structures.length > 0 ? [...structures] : map ? inferStructures(map) : [];
    if (map && structures.length > 0) {
      // Les ouvrages antérieurs au protocole `structures[]` (réseau de
      // démonstration du mock, anciens builds) restent visibles : on ajoute
      // ceux qui ne recoupent aucune tuile déjà décrite.
      const covered = new Set<number>();
      for (const structure of resolved) {
        for (const index of structureTileIndices(structure, map.width)) covered.add(index);
      }
      for (const inferred of inferStructures(map)) {
        if (structureTileIndices(inferred, map.width).some((index) => covered.has(index))) continue;
        resolved.push(inferred);
      }
    }
    this.structures = resolved;
    this.rebuild();
  }

  setQuality(level: QualityLevel): void {
    this.detailRange =
      level === 'low' ? 0 : level === 'high' ? DETAIL_RANGE_HIGH : DETAIL_RANGE_MEDIUM;
    this.applyDetailVisibility();
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    this.baseMesh.castShadow = enabled;
  }

  /** Bascule le LOD détaillé selon la distance caméra. */
  update(camera: THREE.Vector3 | { x: number; z: number }): void {
    this.cameraX = camera.x;
    this.cameraZ = camera.z;
    this.cameraKnown = true;
    this.applyDetailVisibility();
  }

  private applyDetailVisibility(): void {
    if (this.detailRange <= 0) {
      this.detailVisible = false;
    } else if (!this.cameraKnown) {
      this.detailVisible = true;
    } else {
      const rangeSquared = this.detailRange * this.detailRange;
      this.detailVisible = this.structures.some((structure) => {
        const centre = structureCentre(structure);
        const dx = centre.x - this.cameraX;
        const dz = centre.y - this.cameraZ;
        return dx * dx + dz * dz <= rangeSquared;
      });
    }
    this.detailMesh.visible = this.detailVisible;
  }

  private rebuild(): void {
    const map = this.map;
    if (!map || this.structures.length === 0) {
      this.replaceGeometry(this.baseMesh, null);
      this.replaceGeometry(this.detailMesh, null);
      this.group.visible = false;
      return;
    }

    const base = createWriter();
    const detail = createWriter();
    for (const structure of this.structures) {
      if (structure.kind === 'bridge') this.emitBridge(base, detail, map, structure);
      else this.emitTunnel(base, detail, map, structure);
    }

    this.replaceGeometry(this.baseMesh, writerToGeometry(base));
    this.replaceGeometry(this.detailMesh, writerToGeometry(detail));
    this.baseMesh.castShadow = this.shadows;
    this.group.visible = this.structures.length > 0;
    this.applyDetailVisibility();
  }

  private replaceGeometry(mesh: THREE.Mesh, geometry: THREE.BufferGeometry | null): void {
    mesh.geometry.dispose();
    mesh.geometry = geometry ?? new THREE.BufferGeometry();
    mesh.visible = geometry !== null;
  }

  private emitBridge(
    base: GeometryWriter,
    detail: GeometryWriter,
    map: MapSnapshot,
    structure: StructureSnapshot & { kind: 'bridge' },
  ): void {
    const palette = MATERIAL_COLOURS[structure.material] ?? MATERIAL_COLOURS.wood;
    const deckColour = new THREE.Color(palette.deck);
    const sideColour = new THREE.Color(palette.side);
    const railColour = new THREE.Color(palette.rail);
    const dir = directionOf(structure);
    const perp = { x: -dir.y, y: dir.x };
    const deckY = structure.deckHeight * 0.5 + 0.34;
    const halfWidth = 0.42;
    const span =
      Math.abs(structure.to.x - structure.from.x) + Math.abs(structure.to.y - structure.from.y);
    const tiles = span + 1;

    for (let i = 0; i < tiles; i += 1) {
      const cx = structure.from.x + dir.x * i + 0.5;
      const cz = structure.from.y + dir.y * i + 0.5;
      const ground = sampleHeightWorld(map, cx, cz);
      const rampSide = i === 0 ? -1 : i === tiles - 1 ? 1 : 0;
      const bottomY = deckY - DECK_THICKNESS;
      const lateral = (side: 1 | -1, along: number, height: number): Point3 => ({
        x: cx + dir.x * along + perp.x * halfWidth * side,
        y: height,
        z: cz + dir.y * along + perp.y * halfWidth * side,
      });

      if (rampSide === 0) {
        const outerEdge = 0.5;
        const leftTopFront = lateral(1, -outerEdge, deckY);
        const rightTopFront = lateral(-1, -outerEdge, deckY);
        const leftTopBack = lateral(1, outerEdge, deckY);
        const rightTopBack = lateral(-1, outerEdge, deckY);
        const leftBottomFront = lateral(1, -outerEdge, bottomY);
        const rightBottomFront = lateral(-1, -outerEdge, bottomY);
        const leftBottomBack = lateral(1, outerEdge, bottomY);
        const rightBottomBack = lateral(-1, outerEdge, bottomY);
        quad(base, leftTopFront, leftTopBack, rightTopBack, rightTopFront, deckColour);
        quad(base, rightBottomFront, rightBottomBack, leftBottomBack, leftBottomFront, sideColour);
        quad(base, leftTopFront, rightTopFront, rightBottomFront, leftBottomFront, sideColour);
        quad(base, rightTopBack, leftTopBack, leftBottomBack, rightBottomBack, sideColour);
        quad(base, leftTopBack, leftTopFront, leftBottomFront, leftBottomBack, sideColour);
        quad(base, rightTopFront, rightTopBack, rightBottomBack, rightBottomFront, sideColour);
      } else {
        // Rampe : la face extérieure rejoint le sol, la face intérieure est
        // au niveau du tablier.
        const outer = 0.5 * rampSide;
        const inner = -0.5 * rampSide;
        const outerY = ground + 0.06;
        const leftOuter = lateral(1, outer, outerY);
        const rightOuter = lateral(-1, outer, outerY);
        const leftInner = lateral(1, inner, deckY);
        const rightInner = lateral(-1, inner, deckY);
        const leftOuterBottom = lateral(1, outer, outerY - 0.12);
        const rightOuterBottom = lateral(-1, outer, outerY - 0.12);
        const leftInnerBottom = lateral(1, inner, bottomY);
        const rightInnerBottom = lateral(-1, inner, bottomY);
        quad(base, leftOuter, leftInner, rightInner, rightOuter, deckColour);
        quad(base, leftOuterBottom, leftOuter, leftInner, leftInnerBottom, sideColour);
        quad(base, rightOuter, rightOuterBottom, rightInnerBottom, rightInner, sideColour);
        quad(base, leftInner, rightInner, rightInnerBottom, leftInnerBottom, sideColour);
        quad(base, leftOuter, leftOuterBottom, rightOuterBottom, rightOuter, sideColour);
      }

      // Garde-corps : uniquement en détail proche.
      const railTop = deckY + RAIL_HEIGHT;
      for (const side of [1, -1] as const) {
        box(
          detail,
          cx + perp.x * halfWidth * side * 0.92,
          (deckY + railTop) / 2,
          cz + perp.y * halfWidth * side * 0.92,
          0.06,
          RAIL_HEIGHT,
          0.06,
          railColour,
        );
      }
      if (rampSide === 0 && i % PILLAR_INTERVAL === 0) {
        const pillarHeight = Math.max(0.2, bottomY - ground);
        box(detail, cx, ground + pillarHeight / 2, cz, 0.24, pillarHeight, 0.24, sideColour);
      }
    }
  }

  private emitTunnel(
    base: GeometryWriter,
    detail: GeometryWriter,
    map: MapSnapshot,
    structure: StructureSnapshot & { kind: 'tunnel' },
  ): void {
    const dir = directionOf(structure);
    const perp = { x: -dir.y, y: dir.x };
    const portalColour = new THREE.Color(PORTAL_COLOUR);
    const dark = new THREE.Color(PORTAL_DARK);
    for (const end of [structure.from, structure.to]) {
      const cx = end.x + 0.5;
      const cz = end.y + 0.5;
      const ground = sampleHeightWorld(map, cx, cz);
      const frameHeight = 1.15;
      const postHeight = frameHeight;
      for (const side of [1, -1] as const) {
        const px = cx + perp.x * 0.36 * side;
        const pz = cz + perp.y * 0.36 * side;
        box(base, px, ground + postHeight / 2, pz, 0.18, postHeight, 0.18, portalColour);
        box(
          detail,
          px,
          ground + postHeight + 0.06,
          pz,
          0.26,
          0.12,
          0.26,
          new THREE.Color(0x8c8579),
        );
      }
      // Linteau horizontal, orienté perpendiculairement à l'axe.
      const acrossX = Math.abs(perp.x) * 0.98 + Math.abs(dir.x) * 0.2;
      const acrossZ = Math.abs(perp.y) * 0.98 + Math.abs(dir.y) * 0.2;
      box(base, cx, ground + frameHeight + 0.06, cz, acrossX, 0.2, acrossZ, portalColour);
      // Seuil au sol : matérialise l'entrée même sans découpe du terrain.
      box(base, cx, ground + 0.05, cz, acrossX * 0.9, 0.1, acrossZ * 0.9, portalColour);
      // Ouverture sombre, légèrement en retrait du portail.
      const inward = { x: -dir.x * 0.08, y: -dir.y * 0.08 };
      quad(
        base,
        { x: cx + inward.x - perp.x * 0.3, y: ground + 0.12, z: cz + inward.y - perp.y * 0.3 },
        { x: cx + inward.x + perp.x * 0.3, y: ground + 0.12, z: cz + inward.y + perp.y * 0.3 },
        {
          x: cx + inward.x + perp.x * 0.3,
          y: ground + frameHeight - 0.05,
          z: cz + inward.y + perp.y * 0.3,
        },
        {
          x: cx + inward.x - perp.x * 0.3,
          y: ground + frameHeight - 0.05,
          z: cz + inward.y - perp.y * 0.3,
        },
        dark,
      );
    }
    // Key- stone / arche centrale en détail.
    const centre = structureCentre(structure);
    const ground = sampleHeightWorld(map, centre.x, centre.y);
    box(detail, centre.x, ground + 1.25, centre.y, 0.34, 0.12, 0.34, new THREE.Color(0x8c8579));
  }

  clear(): void {
    this.structures = [];
    this.map = null;
    this.replaceGeometry(this.baseMesh, null);
    this.replaceGeometry(this.detailMesh, null);
    this.group.visible = false;
  }

  dispose(): void {
    this.group.remove(this.baseMesh, this.detailMesh);
    this.baseMesh.geometry.dispose();
    this.detailMesh.geometry.dispose();
    this.material.dispose();
    this.structures = [];
    this.map = null;
    this.group.clear();
  }
}
