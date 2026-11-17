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
const PORTAL_STONE_LIGHT = 0x8c8579;
const TUNNEL_FLOOR_COLOUR = 0x151513;
const TUNNEL_DEEP_COLOUR = 0x030405;
const TUNNEL_WALL_COLOUR = 0x4a463e;
const TUNNEL_CEILING_COLOUR = 0x302d28;
const DECK_THICKNESS = 0.13;
const RAIL_HEIGHT = 0.24;
const PILLAR_INTERVAL = 3;
const TUNNEL_CLEARANCE = 0.9;
const TUNNEL_MIN_CLEARANCE = 0.34;
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
  private interiorMesh: THREE.Mesh;
  private detailMesh: THREE.Mesh;
  private material: THREE.MeshLambertMaterial;
  private interiorMaterial: THREE.MeshBasicMaterial;
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
    // Les parois de tunnel sont volontairement non éclairées : un matériau
    // Lambert laisserait le soleil éclairer l'intérieur de la galerie. Le
    // dégradé de couleurs vers le noir suggère la profondeur (#244).
    this.interiorMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      // Seules les faces tournées vers l'intérieur de la galerie sont rendues :
      // depuis l'extérieur, on voit les parois opposées par l'ouverture du
      // portail, jamais la boîte noire posée sur le terrain (#244).
      side: THREE.BackSide,
      fog: true,
    });
    this.baseMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.baseMesh.name = 'structure-base';
    this.baseMesh.receiveShadow = true;
    this.interiorMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.interiorMaterial);
    this.interiorMesh.name = 'structure-tunnel-interior';
    this.interiorMesh.receiveShadow = false;
    this.detailMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.detailMesh.name = 'structure-detail';
    this.detailMesh.receiveShadow = true;
    this.group.add(this.baseMesh, this.interiorMesh, this.detailMesh);
    this.group.visible = false;
  }

  get count(): number {
    return this.structures.length;
  }

  /** Ouvrages résolus (snapshot + inférence), utilisés aussi par les véhicules. */
  get items(): readonly StructureSnapshot[] {
    return this.structures;
  }

  get triangleCount(): number {
    return (
      triangleCount(this.baseMesh.geometry) +
      triangleCount(this.interiorMesh.geometry) +
      triangleCount(this.detailMesh.geometry)
    );
  }

  get drawCallCount(): number {
    let calls = 0;
    if (this.baseMesh.geometry.getAttribute('position')) calls += 1;
    if (this.interiorMesh.geometry.getAttribute('position')) calls += 1;
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
      this.replaceGeometry(this.interiorMesh, null);
      this.replaceGeometry(this.detailMesh, null);
      this.group.visible = false;
      return;
    }

    const base = createWriter();
    const interior = createWriter();
    const detail = createWriter();
    for (const structure of this.structures) {
      if (structure.kind === 'bridge') this.emitBridge(base, detail, map, structure);
      else this.emitTunnel(base, interior, detail, map, structure);
    }

    this.replaceGeometry(this.baseMesh, writerToGeometry(base));
    this.replaceGeometry(this.interiorMesh, writerToGeometry(interior));
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
    interior: GeometryWriter,
    detail: GeometryWriter,
    map: MapSnapshot,
    structure: StructureSnapshot & { kind: 'tunnel' },
  ): void {
    const dir = directionOf(structure);
    const perp = { x: -dir.y, y: dir.x };
    const alongX = dir.x !== 0;
    const tiles =
      Math.abs(structure.to.x - structure.from.x) + Math.abs(structure.to.y - structure.from.y) + 1;
    const portalColour = new THREE.Color(PORTAL_COLOUR);
    const stoneLight = new THREE.Color(PORTAL_STONE_LIGHT);
    const floorColour = new THREE.Color(TUNNEL_FLOOR_COLOUR);
    const deep = new THREE.Color(TUNNEL_DEEP_COLOUR);
    const wallNear = new THREE.Color(TUNNEL_WALL_COLOUR);
    const ceilingNear = new THREE.Color(TUNNEL_CEILING_COLOUR);
    const trackColour = new THREE.Color(0x3b362d);
    const floorY =
      (structure.portalHeight > 0
        ? structure.portalHeight * 0.5
        : sampleHeightWorld(
            map,
            (structure.from.x + structure.to.x) / 2 + 0.5,
            (structure.from.y + structure.to.y) / 2 + 0.5,
          )) + 0.02;
    const halfWidth = structure.transport === 'road' ? 0.36 : 0.3;
    const inner = halfWidth - 0.035;

    // Le plafond reste sous le relief traversé. Sur un tunnel peu profond,
    // une galerie pleine hauteur dépasserait de la colline ; on abaisse donc
    // la voûte jusqu'à laisser quelques centimètres de roche au-dessus.
    let clearance = TUNNEL_CLEARANCE;
    if (tiles > 2) {
      let lowestTop = Number.POSITIVE_INFINITY;
      for (let i = 1; i < tiles - 1; i += 1) {
        const cx = structure.from.x + dir.x * i + 0.5;
        const cz = structure.from.y + dir.y * i + 0.5;
        lowestTop = Math.min(lowestTop, sampleHeightWorld(map, cx, cz));
      }
      if (Number.isFinite(lowestTop)) {
        clearance = Math.max(
          TUNNEL_MIN_CLEARANCE,
          Math.min(TUNNEL_CLEARANCE, lowestTop - floorY - 0.06),
        );
      }
    }
    const ceilingY = floorY + clearance;

    // Galerie : radier, parois et plafond. Les couleurs s'assombrissent vers
    // le milieu du tunnel, ce qui donne l'obscurité d'un vrai souterrain sans
    // texture ni lumière supplémentaire.
    for (let i = 0; i < tiles - 1; i += 1) {
      const ax = structure.from.x + dir.x * i + 0.5;
      const az = structure.from.y + dir.y * i + 0.5;
      const bx = ax + dir.x;
      const bz = az + dir.y;
      const depth = tiles <= 2 ? 0.5 : Math.min(i + 1, tiles - 1 - i) / (tiles - 1);
      const shade = Math.min(1, depth * 1.2);
      const wall = wallNear.clone().lerp(deep, shade);
      const ceiling = ceilingNear.clone().lerp(deep, Math.min(1, shade * 1.12));
      const ground = floorColour.clone().lerp(deep, Math.min(1, shade * 0.9));

      // Paroi gauche et paroi droite.
      quad(
        interior,
        { x: ax + perp.x * inner, y: floorY, z: az + perp.y * inner },
        { x: bx + perp.x * inner, y: floorY, z: bz + perp.y * inner },
        { x: bx + perp.x * inner, y: ceilingY, z: bz + perp.y * inner },
        { x: ax + perp.x * inner, y: ceilingY, z: az + perp.y * inner },
        wall,
      );
      quad(
        interior,
        { x: bx - perp.x * inner, y: floorY, z: bz - perp.y * inner },
        { x: ax - perp.x * inner, y: floorY, z: az - perp.y * inner },
        { x: ax - perp.x * inner, y: ceilingY, z: az - perp.y * inner },
        { x: bx - perp.x * inner, y: ceilingY, z: bz - perp.y * inner },
        wall,
      );
      // Plafond et radier.
      quad(
        interior,
        { x: ax + perp.x * inner, y: ceilingY, z: az + perp.y * inner },
        { x: bx + perp.x * inner, y: ceilingY, z: bz + perp.y * inner },
        { x: bx - perp.x * inner, y: ceilingY, z: bz - perp.y * inner },
        { x: ax - perp.x * inner, y: ceilingY, z: az - perp.y * inner },
        ceiling,
      );
      quad(
        interior,
        { x: ax - perp.x * inner, y: floorY, z: az - perp.y * inner },
        { x: bx - perp.x * inner, y: floorY, z: bz - perp.y * inner },
        { x: bx + perp.x * inner, y: floorY, z: bz + perp.y * inner },
        { x: ax + perp.x * inner, y: floorY, z: az + perp.y * inner },
        ground,
      );

      // Chaussée ou voie ferrée au fond de la galerie : sans cela, le tunnel
      // ressemble à un simple trou noir et le raccord au portail est illisible.
      if (structure.transport === 'rail') {
        for (const offset of [-0.13, 0.13] as const) {
          const railColour = trackColour.clone().lerp(deep, shade * 0.6);
          quad(
            interior,
            {
              x: ax + perp.x * offset - 0.025,
              y: floorY + 0.012,
              z: az + perp.y * offset - 0.025,
            },
            {
              x: bx + perp.x * offset - 0.025,
              y: floorY + 0.012,
              z: bz + perp.y * offset - 0.025,
            },
            {
              x: bx + perp.x * offset + 0.035,
              y: floorY + 0.012,
              z: bz + perp.y * offset + 0.035,
            },
            {
              x: ax + perp.x * offset + 0.035,
              y: floorY + 0.012,
              z: az + perp.y * offset + 0.035,
            },
            railColour,
          );
        }
      } else {
        const lane = trackColour.clone().lerp(deep, shade * 0.7);
        quad(
          interior,
          { x: ax + perp.x * 0.2, y: floorY + 0.01, z: az + perp.y * 0.2 },
          { x: bx + perp.x * 0.2, y: floorY + 0.01, z: bz + perp.y * 0.2 },
          { x: bx - perp.x * 0.2, y: floorY + 0.01, z: bz - perp.y * 0.2 },
          { x: ax - perp.x * 0.2, y: floorY + 0.01, z: az - perp.y * 0.2 },
          lane,
        );
      }

      // Nervures de pierre tous les deux segments : elles donnent l'échelle
      // de la galerie quand la caméra s'approche du portail.
      if (i > 0 && i % 2 === 0) {
        const rib = wallNear
          .clone()
          .lerp(stoneLight, 0.25)
          .lerp(deep, shade * 0.75);
        for (const side of [1, -1] as const) {
          quad(
            interior,
            {
              x: ax + perp.x * (inner - 0.004) * side,
              y: floorY + 0.05,
              z: az + perp.y * (inner - 0.004) * side,
            },
            {
              x: ax + dir.x * 0.06 + perp.x * (inner - 0.004) * side,
              y: floorY + 0.05,
              z: az + dir.y * 0.06 + perp.y * (inner - 0.004) * side,
            },
            {
              x: ax + dir.x * 0.06 + perp.x * (inner - 0.004) * side,
              y: ceilingY - 0.04,
              z: az + dir.y * 0.06 + perp.y * (inner - 0.004) * side,
            },
            {
              x: ax + perp.x * (inner - 0.004) * side,
              y: ceilingY - 0.04,
              z: az + perp.y * (inner - 0.004) * side,
            },
            rib,
          );
        }
      }
    }

    // Portails : cadre de pierre et linteau, alignés sur le radier de la
    // galerie pour que le raccord soit continu.
    for (const end of [structure.from, structure.to]) {
      const cx = end.x + 0.5;
      const cz = end.y + 0.5;
      const ground = floorY;
      const frameHeight = clearance + 0.2;
      for (const side of [1, -1] as const) {
        const px = cx + perp.x * (halfWidth + 0.05) * side;
        const pz = cz + perp.y * (halfWidth + 0.05) * side;
        box(base, px, ground + frameHeight / 2, pz, 0.18, frameHeight, 0.18, portalColour);
        box(detail, px, ground + frameHeight + 0.06, pz, 0.26, 0.12, 0.26, stoneLight);
      }
      // Linteau horizontal, orienté perpendiculairement à l'axe.
      const acrossX = Math.abs(perp.x) * (halfWidth * 2 + 0.3) + Math.abs(dir.x) * 0.22;
      const acrossZ = Math.abs(perp.y) * (halfWidth * 2 + 0.3) + Math.abs(dir.y) * 0.22;
      box(base, cx, ground + frameHeight + 0.05, cz, acrossX, 0.2, acrossZ, portalColour);
      // Clé de voûte, visible en détail.
      box(
        detail,
        cx,
        ground + frameHeight + 0.18,
        cz,
        alongX ? 0.2 : 0.32,
        0.12,
        alongX ? 0.32 : 0.2,
        stoneLight,
      );
      // Seuil au sol : simple liseré de chaque côté pour ne pas masquer la
      // chaussée qui entre dans la galerie.
      for (const side of [1, -1] as const) {
        box(
          base,
          cx + perp.x * (halfWidth + 0.05) * side,
          ground + 0.045,
          cz + perp.y * (halfWidth + 0.05) * side,
          alongX ? 0.2 : 0.1,
          0.04,
          alongX ? 0.1 : 0.2,
          portalColour,
        );
      }
      // Boyau d'entrée : un court renfoncement de pierre, fermé par un fond
      // sombre. La galerie complète existe sous le relief, mais la pente de
      // terrain la recouvre : ce renfoncement donne au portail sa profondeur
      // visible et empêche de voir la colline (ou le ciel) à travers (#244).
      const inwardSign = end === structure.from ? 1 : -1;
      const throatDepth = 0.46;
      const throatX = cx + dir.x * inwardSign * throatDepth * 0.5;
      const throatZ = cz + dir.y * inwardSign * throatDepth * 0.5;
      const throatAlongX = alongX ? throatDepth : 0.06;
      const throatAlongZ = alongX ? 0.06 : throatDepth;
      for (const side of [1, -1] as const) {
        box(
          base,
          throatX + perp.x * (halfWidth + 0.01) * side,
          (floorY + ceilingY) / 2,
          throatZ + perp.y * (halfWidth + 0.01) * side,
          throatAlongX,
          clearance,
          throatAlongZ,
          stoneLight,
        );
      }
      box(
        base,
        throatX,
        ceilingY + 0.02,
        throatZ,
        alongX ? throatDepth : halfWidth * 2,
        0.05,
        alongX ? halfWidth * 2 : throatDepth,
        stoneLight,
      );
      // Chaussée ou voie dans le renfoncement : l'infrastructure extérieure se
      // prolonge dans la galerie. Sans cela, l'ouverture n'est qu'un rectangle
      // noir sans échelle.
      box(
        base,
        throatX,
        floorY + 0.012,
        throatZ,
        alongX ? throatDepth : halfWidth * 1.75,
        0.024,
        alongX ? halfWidth * 1.75 : throatDepth,
        new THREE.Color(structure.transport === 'road' ? 0x7c7c7e : 0x3a352c),
      );
      if (structure.transport === 'road') {
        for (const depth of [0.12, 0.3] as const) {
          const markX = cx + dir.x * inwardSign * depth;
          const markZ = cz + dir.y * inwardSign * depth;
          box(
            base,
            markX,
            floorY + 0.03,
            markZ,
            alongX ? 0.12 : 0.035,
            0.012,
            alongX ? 0.035 : 0.12,
            new THREE.Color(0xd8d4c4),
          );
        }
      } else {
        for (const offset of [-0.12, 0.12] as const) {
          box(
            base,
            throatX + perp.x * offset,
            floorY + 0.03,
            throatZ + perp.y * offset,
            alongX ? throatDepth : 0.035,
            0.012,
            alongX ? 0.035 : throatDepth,
            new THREE.Color(0x8a8172),
          );
        }
      }
      // Nervures de pierre dans le renfoncement : elles donnent la profondeur
      // de la galerie même quand la caméra est presque dans l'axe.
      for (const depth of [0.16, 0.34] as const) {
        const ribX = cx + dir.x * inwardSign * depth;
        const ribZ = cz + dir.y * inwardSign * depth;
        for (const side of [1, -1] as const) {
          box(
            base,
            ribX + perp.x * (halfWidth + 0.005) * side,
            (floorY + ceilingY) / 2,
            ribZ + perp.y * (halfWidth + 0.005) * side,
            alongX ? 0.035 : 0.04,
            clearance - 0.08,
            alongX ? 0.04 : 0.035,
            stoneLight,
          );
        }
      }
      const backX = cx + dir.x * inwardSign * throatDepth;
      const backZ = cz + dir.y * inwardSign * throatDepth;
      const dark = new THREE.Color(TUNNEL_DEEP_COLOUR);
      quad(
        base,
        { x: backX + perp.x * inner, y: floorY + 0.01, z: backZ + perp.y * inner },
        { x: backX - perp.x * inner, y: floorY + 0.01, z: backZ - perp.y * inner },
        { x: backX - perp.x * inner, y: ceilingY - 0.01, z: backZ - perp.y * inner },
        { x: backX + perp.x * inner, y: ceilingY - 0.01, z: backZ + perp.y * inner },
        dark,
      );
    }
  }

  clear(): void {
    this.structures = [];
    this.map = null;
    this.replaceGeometry(this.baseMesh, null);
    this.replaceGeometry(this.interiorMesh, null);
    this.replaceGeometry(this.detailMesh, null);
    this.group.visible = false;
  }

  dispose(): void {
    this.group.remove(this.baseMesh, this.interiorMesh, this.detailMesh);
    this.baseMesh.geometry.dispose();
    this.interiorMesh.geometry.dispose();
    this.detailMesh.geometry.dispose();
    this.material.dispose();
    this.interiorMaterial.dispose();
    this.structures = [];
    this.map = null;
    this.group.clear();
  }
}
