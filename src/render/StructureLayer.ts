/**
 * Rendu des ponts et tunnels (#154/#155).
 *
 * Une seule géométrie fusionnée porte tous les tabliers et tous les portails :
 * il n'y a jamais un mesh par segment d'ouvrage. Deux niveaux de détail sont
 * construits une fois :
 *
 * - base : tablier, rampes, garde-corps et piles — visible de loin ;
 * - détail : poteaux, chapiteaux, pylônes et claveaux — visible de près.
 *
 * Le snapshot fournit `structures[]` quand le moteur les expose ; sinon la
 * couche infère des ouvrages rectilignes à partir des types de tuiles, ce qui
 * garde les anciens builds WASM lisibles.
 */

import * as THREE from 'three';
import {
  COMPANY_NONE,
  TILE_FLAG,
  TILE_KIND_INDEX,
  type BridgeMaterial,
  type MapSnapshot,
  type StructureSnapshot,
  type StructureTransport,
} from '../engine/protocol';
import { isWaterKind, sampleHeightWorld, tileIndex, tileKindAt } from '../game/mapGrid';
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
const DECK_THICKNESS = 0.13;
const RAIL_HEIGHT = 0.24;
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

/** Tuile de terre ferme sur laquelle une rampe peut se raccorder. */
function isBridgeApproachTile(map: MapSnapshot, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const kind = tileKindAt(map, x, y);
  if (isWaterKind(kind) || kind === 'void') return false;
  if (kind === 'bridge' || kind === 'tunnel' || kind === 'aqueduct') return false;
  if (
    kind === 'house' ||
    kind === 'industry' ||
    kind === 'station' ||
    kind === 'airport' ||
    kind === 'dock' ||
    kind === 'object'
  ) {
    return false;
  }
  return true;
}

/**
 * Matériau crédible pour un ouvrage hérité qui n'expose pas `structures[]`.
 * Le bois reste réservé aux très courtes portées routières : une traversée
 * de lac ne doit pas devenir une pile de planches surdimensionnée.
 */
function inferredBridgeMaterial(transport: StructureTransport, span: number): BridgeMaterial {
  if (transport === 'rail') return span <= 6 ? 'steel' : 'tubular';
  if (span <= 3) return 'wood';
  return span <= 6 ? 'steel' : 'concrete';
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
        let from = { x: minX, y: minY };
        let to = { x: maxX, y: maxY };
        let first = tileIndex(from.x, from.y, map.width);
        let last = tileIndex(to.x, to.y, map.width);
        const company = map.owner[first] ?? COMPANY_NONE;
        if (kind === 'bridge') {
          const dx = Math.sign(maxX - minX);
          const dy = Math.sign(maxY - minY);
          // Anciens réseaux de démonstration : le moteur ne marquait que les
          // tuiles d'eau, sans culées. On rend la rampe crédible en étendant
          // l'ouvrage jusqu'à la terre ferme de chaque côté.
          if ((map.flags[first] ?? 0) & TILE_FLAG.WATER) {
            const nx = from.x - dx;
            const ny = from.y - dy;
            if (isBridgeApproachTile(map, nx, ny)) {
              from = { x: nx, y: ny };
              first = tileIndex(nx, ny, map.width);
            }
          }
          if ((map.flags[last] ?? 0) & TILE_FLAG.WATER) {
            const nx = to.x + dx;
            const ny = to.y + dy;
            if (isBridgeApproachTile(map, nx, ny)) {
              to = { x: nx, y: ny };
              last = tileIndex(nx, ny, map.width);
            }
          }
          let maxGround = Math.max(map.heightMap[first] ?? 0, map.heightMap[last] ?? 0);
          for (const index of tiles) {
            maxGround = Math.max(maxGround, map.heightMap[index] ?? 0);
          }
          const span = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
          const nearby = [
            { x: from.x - dx, y: from.y - dy },
            { x: to.x + dx, y: to.y + dy },
          ];
          let rail = 0;
          let road = 0;
          for (const point of nearby) {
            const neighbour = tileKindAt(map, point.x, point.y);
            if (neighbour === 'rail') rail += 1;
            else if (neighbour === 'road' || neighbour === 'crossing') road += 1;
          }
          const transport: StructureTransport = rail > road ? 'rail' : road > 0 ? 'road' : 'rail';
          structures.push({
            id: nextId,
            kind: 'bridge',
            company,
            transport,
            material: inferredBridgeMaterial(transport, span),
            from,
            to,
            length: span + 1,
            deckHeight: maxGround + 2,
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
    const trackColour = new THREE.Color(0x3a3a35);
    const dir = directionOf(structure);
    const perp = { x: -dir.y, y: dir.x };
    const span =
      Math.abs(structure.to.x - structure.from.x) + Math.abs(structure.to.y - structure.from.y);
    const tiles = span + 1;
    const halfWidth = structure.transport === 'road' ? 0.4 : 0.33;

    // Le tablier doit rester au-dessus du relief hérité (anciennes cartes)
    // comme du niveau OpenTTD exposé par le moteur.
    const groundAt: number[] = [];
    let highestGround = 0;
    for (let i = 0; i < tiles; i += 1) {
      const cx = structure.from.x + dir.x * i + 0.5;
      const cz = structure.from.y + dir.y * i + 0.5;
      const ground = sampleHeightWorld(map, cx, cz);
      groundAt.push(ground);
      highestGround = Math.max(highestGround, ground);
    }
    const deckY = Math.max(structure.deckHeight * 0.5 + 0.34, highestGround + 0.55);
    const bottomY = deckY - DECK_THICKNESS;
    const alongX = dir.x !== 0;

    /** Point du tablier : `perpOffset` écarte latéralement, `along` suit l'axe. */
    const point = (
      cx: number,
      cz: number,
      perpOffset: number,
      along: number,
      height: number,
    ): Point3 => ({
      x: cx + dir.x * along + perp.x * perpOffset,
      y: height,
      z: cz + dir.y * along + perp.y * perpOffset,
    });
    /**
     * Hauteur du tablier au bord extérieur d'une culée. La rampe descend sur la
     * tuile de culée elle-même : l'empreinte rendue reste exactement celle du
     * plan (#228), sans rallonge sur les tuiles voisines.
     */
    const rampEdgeHeight = (index: number, outward: 1 | -1): number => {
      const cx = structure.from.x + dir.x * index + 0.5;
      const cz = structure.from.y + dir.y * index + 0.5;
      const edgeGround = sampleHeightWorld(
        map,
        cx + dir.x * outward * 0.5,
        cz + dir.y * outward * 0.5,
      );
      const ground = Math.max(groundAt[index] ?? 0, edgeGround);
      return Math.min(deckY - 0.02, ground + 0.07);
    };

    for (let i = 0; i < tiles; i += 1) {
      const cx = structure.from.x + dir.x * i + 0.5;
      const cz = structure.from.y + dir.y * i + 0.5;
      const ground = groundAt[i] ?? 0;
      const kind = tileKindAt(map, structure.from.x + dir.x * i, structure.from.y + dir.y * i);
      const tileIndexNow = tileIndex(
        structure.from.x + dir.x * i,
        structure.from.y + dir.y * i,
        map.width,
      );
      const waterBelow =
        isWaterKind(kind) || ((map.flags[tileIndexNow] ?? 0) & TILE_FLAG.WATER) !== 0;
      const isFirst = i === 0;
      const isLast = i === tiles - 1;
      const isEnd = isFirst || isLast;
      const frontTop = isFirst ? rampEdgeHeight(i, -1) : deckY;
      const backTop = isLast ? rampEdgeHeight(i, 1) : deckY;
      const frontBottom = frontTop - DECK_THICKNESS;
      const backBottom = backTop - DECK_THICKNESS;

      // Dalle : dessus, dessous et chants latéraux. Épaisseur faible pour
      // éviter l'effet « structure massive » des anciens tabliers.
      const leftTopFront = point(cx, cz, halfWidth, -0.5, frontTop);
      const rightTopFront = point(cx, cz, -halfWidth, -0.5, frontTop);
      const leftTopBack = point(cx, cz, halfWidth, 0.5, backTop);
      const rightTopBack = point(cx, cz, -halfWidth, 0.5, backTop);
      const leftBottomFront = point(cx, cz, halfWidth, -0.5, frontBottom);
      const rightBottomFront = point(cx, cz, -halfWidth, -0.5, frontBottom);
      const leftBottomBack = point(cx, cz, halfWidth, 0.5, backBottom);
      const rightBottomBack = point(cx, cz, -halfWidth, 0.5, backBottom);
      quad(base, leftTopFront, leftTopBack, rightTopBack, rightTopFront, deckColour);
      quad(base, rightBottomFront, rightBottomBack, leftBottomBack, leftBottomFront, sideColour);
      quad(base, leftTopFront, rightTopFront, rightBottomFront, leftBottomFront, sideColour);
      quad(base, rightTopBack, leftTopBack, leftBottomBack, rightBottomBack, sideColour);
      if (isEnd) {
        const topLeft = isFirst ? leftTopFront : leftTopBack;
        const topRight = isFirst ? rightTopFront : rightTopBack;
        const bottomLeft = isFirst ? leftBottomFront : leftBottomBack;
        const bottomRight = isFirst ? rightBottomFront : rightBottomBack;
        quad(base, topLeft, topRight, bottomRight, bottomLeft, sideColour);
      }

      // Garde-corps visibles à tous les niveaux de détail. Le ruban suit la
      // pente de la culée pour rester solidaire du tablier.
      for (const side of [1, -1] as const) {
        const railFrontTop = point(cx, cz, halfWidth * side * 0.94, -0.5, frontTop + RAIL_HEIGHT);
        const railBackTop = point(cx, cz, halfWidth * side * 0.94, 0.5, backTop + RAIL_HEIGHT);
        const railFrontBase = point(cx, cz, halfWidth * side * 0.94, -0.5, frontTop);
        const railBackBase = point(cx, cz, halfWidth * side * 0.94, 0.5, backTop);
        quad(base, railFrontTop, railBackTop, railBackBase, railFrontBase, railColour);
        if (!isEnd && i % 2 === 0) {
          box(
            detail,
            cx + perp.x * halfWidth * side * 0.94,
            deckY + RAIL_HEIGHT / 2,
            cz + perp.y * halfWidth * side * 0.94,
            alongX ? 0.06 : 0.075,
            RAIL_HEIGHT + 0.08,
            alongX ? 0.075 : 0.06,
            railColour,
          );
        }
      }

      // Voie ou chaussée posée sur le tablier : le rendu des voies ignore les
      // tuiles `bridge`, il faut donc la dessiner ici.
      if (structure.transport === 'rail') {
        for (const offset of [-0.16, 0.16] as const) {
          const half = 0.035;
          quad(
            base,
            point(cx, cz, offset - half, -0.5, frontTop + 0.02),
            point(cx, cz, offset - half, 0.5, backTop + 0.02),
            point(cx, cz, offset + half, 0.5, backTop + 0.02),
            point(cx, cz, offset + half, -0.5, frontTop + 0.02),
            trackColour,
          );
        }
      }

      if (!isEnd && i % PILLAR_INTERVAL === 0) {
        const drop = bottomY - ground;
        const naturalValley =
          kind === 'grass' ||
          kind === 'clear' ||
          kind === 'rough' ||
          kind === 'trees' ||
          kind === 'coast';
        const canSupport = waterBelow || naturalValley;
        // Jamais de pile sur une route, une voie, une gare ou un ouvrage :
        // seules l'eau et les vallées portent des appuis.
        if (canSupport && drop > 0.45) {
          for (const side of [1, -1] as const) {
            const px = cx + perp.x * halfWidth * 0.55 * side;
            const pz = cz + perp.y * halfWidth * 0.55 * side;
            box(base, px, ground + drop / 2, pz, 0.15, drop, 0.15, sideColour);
          }
          box(
            detail,
            cx,
            bottomY - 0.055,
            cz,
            alongX ? 0.22 : halfWidth * 2,
            0.11,
            alongX ? halfWidth * 2 : 0.22,
            sideColour,
          );
        }
      }
    }

    // Détails propres au matériau : pas de poutres massives en bois sur les
    // longues portées, mais des appuis et un tablier lisible.
    if (structure.material === 'tubular') {
      for (let i = 1; i < tiles - 1; i += 1) {
        const cx = structure.from.x + dir.x * i + 0.5;
        const cz = structure.from.y + dir.y * i + 0.5;
        for (const side of [1, -1] as const) {
          box(
            detail,
            cx + perp.x * (halfWidth + 0.06) * side,
            deckY - 0.16,
            cz + perp.y * (halfWidth + 0.06) * side,
            alongX ? 1 : 0.16,
            0.18,
            alongX ? 0.16 : 1,
            sideColour,
          );
        }
      }
    } else if (structure.material === 'steel' || structure.material === 'concrete') {
      for (let i = 1; i < tiles - 1; i += 2) {
        const cx = structure.from.x + dir.x * i + 0.5;
        const cz = structure.from.y + dir.y * i + 0.5;
        for (const side of [1, -1] as const) {
          box(
            detail,
            cx + perp.x * (halfWidth + 0.02) * side,
            bottomY - 0.14,
            cz + perp.y * (halfWidth + 0.02) * side,
            0.09,
            0.28,
            0.09,
            sideColour,
          );
        }
      }
    } else if (
      (structure.material === 'suspension' || structure.material === 'cantilever') &&
      tiles >= 5
    ) {
      for (const i of [1, tiles - 2] as const) {
        const cx = structure.from.x + dir.x * i + 0.5;
        const cz = structure.from.y + dir.y * i + 0.5;
        const towerHeight = 1.35;
        for (const side of [1, -1] as const) {
          box(
            detail,
            cx + perp.x * (halfWidth + 0.08) * side,
            deckY + towerHeight / 2,
            cz + perp.y * (halfWidth + 0.08) * side,
            0.14,
            towerHeight,
            0.14,
            sideColour,
          );
        }
        box(
          detail,
          cx,
          deckY + towerHeight,
          cz,
          alongX ? 0.12 : halfWidth * 2 + 0.3,
          0.1,
          alongX ? halfWidth * 2 + 0.3 : 0.12,
          sideColour,
        );
        if (structure.material === 'suspension') {
          for (let j = 1; j < tiles - 1; j += 2) {
            const hx = structure.from.x + dir.x * j + 0.5;
            const hz = structure.from.y + dir.y * j + 0.5;
            for (const side of [1, -1] as const) {
              const height = 0.75;
              box(
                detail,
                hx + perp.x * (halfWidth + 0.02) * side,
                deckY + height / 2 + 0.1,
                hz + perp.y * (halfWidth + 0.02) * side,
                0.025,
                height,
                0.025,
                railColour,
              );
            }
          }
        }
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
