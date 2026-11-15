/**
 * Minimap 2D à gauche du HUD : carte, eau, villes, industries, gares,
 * véhicules et cadre caméra. Un clic recentre la caméra.
 *
 * La carte est pré-rendue dans un canvas hors écran uniquement quand un
 * nouveau snapshot de carte arrive ; les entités et le cadre caméra sont
 * redessinés à la fréquence du HUD. Aucun `innerHTML`.
 */

import type { MapSnapshot, TileKind, WorldSnapshot } from '../../engine/protocol';
import type { Selection } from '../../game/Game';
import { TILE_KINDS, tileIndex } from '../../game/mapGrid';
import { companyColour } from '../../render/tileVisuals';
import { el } from '../dom';
import {
  cameraFootprint,
  computeMapSignature,
  computeMinimapLayout,
  minimapToWorld,
  RedrawThrottle,
  worldToMinimap,
  type MinimapLayout,
  type Point,
} from '../minimapMath';
import type { CameraView } from '../types';

const MINIMAP_REDRAW_INTERVAL_MS = 100;

const MINIMAP_COLORS: Record<TileKind, number> = {
  void: 0x0a0f15,
  clear: 0x5f8a43,
  grass: 0x44702f,
  rough: 0x6b6450,
  water: 0x24567c,
  coast: 0xc2a878,
  rail: 0x6a5f50,
  road: 0x5b5d60,
  house: 0xa29582,
  trees: 0x2c4f28,
  station: 0xc9c4b4,
  industry: 0xb97b43,
  bridge: 0x7b6248,
  tunnel: 0x34343b,
  object: 0x6f6f76,
  airport: 0x9a9b9f,
  dock: 0x7b6a4a,
  canal: 0x2b6087,
  river: 0x2d6a8e,
};

export interface MinimapOptions {
  onRecenter: (x: number, y: number) => void;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  point: Point,
  radius: number,
  fill: string,
  stroke?: string,
): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
}

function drawSquare(
  ctx: CanvasRenderingContext2D,
  point: Point,
  size: number,
  fill: string,
  stroke?: string,
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.8;
    ctx.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
  }
}

export class Minimap {
  readonly element: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private base: HTMLCanvasElement;
  private map: MapSnapshot | null = null;
  private snapshot: WorldSnapshot | null = null;
  private selection: Selection | null = null;
  private camera: CameraView | null = null;
  private aspect = 16 / 9;
  private layout: MinimapLayout;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private mapLabel: HTMLSpanElement;
  private observer: ResizeObserver | null = null;
  private baseDirty = true;
  private mapSignature = 0;
  private hasMapSignature = false;
  private throttle = new RedrawThrottle(MINIMAP_REDRAW_INTERVAL_MS);
  private cachedRect: DOMRect | null = null;
  private baseRebuilds = 0;
  private draws = 0;

  constructor(options: MinimapOptions) {
    this.element = el('aside', {
      className: 'hud-minimap',
      attrs: { 'aria-label': 'Minimap' },
    });
    const header = el('div', { className: 'hud-minimap-header' });
    header.append(el('h3', { text: 'Minimap' }));
    this.mapLabel = el('span', { className: 'hud-minimap-size', text: '—' });
    header.append(this.mapLabel);

    this.canvas = el('canvas', {
      className: 'hud-minimap-canvas',
      attrs: {
        'aria-label': 'Carte du monde : cliquer pour recentrer la caméra',
        role: 'img',
        title: 'Clic : recentrer la caméra',
      },
    });
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.layout = computeMinimapLayout(1, 1, 1, 1);

    const hint = el('div', {
      className: 'hud-minimap-hint',
      text: 'Clic : recentrer · cadre = caméra',
    });
    this.element.append(header, this.canvas, hint);

    this.canvas.addEventListener('click', (event) => {
      const map = this.map;
      if (!map) return;
      const rect = this.cachedRect ?? this.canvas.getBoundingClientRect();
      const world = minimapToWorld(
        event.clientX - rect.left,
        event.clientY - rect.top,
        this.layout,
        map.width,
        map.height,
      );
      options.onRecenter(world.x, world.y);
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.canvas);
    }
    if (typeof window !== 'undefined') {
      // Le cache du rectangle ne sert qu'au clic : une lecture par resize ou
      // par scroll suffit, jamais une lecture par frame.
      window.addEventListener('scroll', this.refreshRect, true);
    }
    this.resize();
  }

  private refreshRect = (): void => {
    if (typeof this.canvas.getBoundingClientRect !== 'function') return;
    this.cachedRect = this.canvas.getBoundingClientRect();
  };

  setSnapshot(snapshot: WorldSnapshot | null): void {
    this.snapshot = snapshot;
    if (snapshot?.map) this.setMap(snapshot.map);
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection;
    this.draw();
  }

  setCamera(view: CameraView | null, aspect = this.aspect): void {
    this.camera = view;
    if (Number.isFinite(aspect) && aspect > 0.2) this.aspect = aspect;
    this.draw();
  }

  private setMap(map: MapSnapshot): void {
    const previous = this.map;
    const signature = computeMapSignature(map);
    this.map = map;
    if (this.hasMapSignature && signature === this.mapSignature) return;
    this.mapSignature = signature;
    this.hasMapSignature = true;
    const sizeChanged = !previous || previous.width !== map.width || previous.height !== map.height;
    if (sizeChanged) {
      this.mapLabel.textContent = `${map.width} × ${map.height}`;
      this.canvas.style.aspectRatio = `${map.width} / ${map.height}`;
      this.applyLayout();
    }
    this.baseDirty = true;
    this.draw();
  }

  private applyLayout(): void {
    const map = this.map;
    this.layout = computeMinimapLayout(
      map?.width ?? 1,
      map?.height ?? 1,
      this.cssWidth,
      this.cssHeight,
    );
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cachedRect = rect;
    this.cssWidth = Math.max(1, Math.round(rect.width));
    this.cssHeight = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const pixelHeight = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.baseDirty = true;
    }
    this.applyLayout();
    this.draw(true);
  }

  /** Nombre de reconstructions de l'ImageData de base (diagnostic/tests). */
  get baseRebuildCount(): number {
    return this.baseRebuilds;
  }

  /** Nombre de redraws effectifs (diagnostic/tests). */
  get drawCount(): number {
    return this.draws;
  }

  private rebuildBase(): void {
    const map = this.map;
    const context = this.base.getContext('2d');
    if (!map || !context) return;
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    this.base.width = width;
    this.base.height = height;
    const image = context.createImageData(width, height);
    const data = image.data;
    const layout = this.layout;
    for (let py = 0; py < height; py += 1) {
      const cssY = (py + 0.5) / this.dpr;
      if (cssY < layout.frame.y || cssY > layout.frame.y + layout.frame.height) continue;
      for (let px = 0; px < width; px += 1) {
        const cssX = (px + 0.5) / this.dpr;
        if (cssX < layout.frame.x || cssX > layout.frame.x + layout.frame.width) continue;
        const worldX = ((cssX - layout.frame.x) / layout.frame.width) * map.width;
        const worldY = ((cssY - layout.frame.y) / layout.frame.height) * map.height;
        const x = clampInt(Math.floor(worldX), 0, map.width - 1);
        const y = clampInt(Math.floor(worldY), 0, map.height - 1);
        const index = tileIndex(x, y, map.width);
        const kind = TILE_KINDS[map.kind[index] ?? 0] ?? 'void';
        const colour = MINIMAP_COLORS[kind] ?? MINIMAP_COLORS.void;
        const water = kind === 'water' || kind === 'river' || kind === 'canal' || kind === 'void';
        const relief = water ? 1 : 0.82 + ((map.heightMap[index] ?? 0) / 15) * 0.34;
        const offset = (py * width + px) * 4;
        data[offset] = Math.min(255, Math.round(((colour >> 16) & 0xff) * relief));
        data[offset + 1] = Math.min(255, Math.round(((colour >> 8) & 0xff) * relief));
        data[offset + 2] = Math.min(255, Math.round((colour & 0xff) * relief));
        data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    this.baseDirty = false;
    this.baseRebuilds += 1;
  }

  private now(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  private draw(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Un snapshot WASM arrive à ~5 Hz : inutile de reconstruire le fond pour
    // une carte identique, ni de redessiner plus vite que le HUD.
    if (!this.throttle.shouldDraw(this.now(), force)) return;
    if (this.baseDirty) this.rebuildBase();
    this.draws += 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.map && this.base.width > 0) ctx.drawImage(this.base, 0, 0);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const layout = this.layout;
    const map = this.map;
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.frame.x, layout.frame.y, layout.frame.width, layout.frame.height);
    ctx.clip();

    if (map && this.snapshot) this.drawEntities(ctx, this.snapshot, map);
    if (this.camera) this.drawCamera(ctx);

    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      layout.frame.x + 0.5,
      layout.frame.y + 0.5,
      Math.max(0, layout.frame.width - 1),
      Math.max(0, layout.frame.height - 1),
    );
  }

  private point(x: number, y: number, map: MapSnapshot): Point {
    return worldToMinimap(x, y, this.layout, map.width, map.height);
  }

  private drawEntities(
    ctx: CanvasRenderingContext2D,
    snapshot: WorldSnapshot,
    map: MapSnapshot,
  ): void {
    for (const station of snapshot.stations) {
      drawSquare(
        ctx,
        this.point(station.x, station.y, map),
        this.layout.scale >= 0.7 ? 3 : 2,
        '#d9d4c4',
        'rgba(0, 0, 0, 0.55)',
      );
    }
    for (const industry of snapshot.industries) {
      drawSquare(ctx, this.point(industry.x, industry.y, map), 4, '#d6863f', 'rgba(0, 0, 0, 0.6)');
    }
    for (const town of snapshot.towns) {
      drawCircle(ctx, this.point(town.x, town.y, map), 3, '#f2d47c', 'rgba(0, 0, 0, 0.65)');
    }

    const companies = new Map(snapshot.companies.map((company) => [company.id, company]));
    for (const vehicle of snapshot.vehicles) {
      const company = companies.get(vehicle.company);
      const colour = `#${companyColour(company?.colour ?? 8)
        .toString(16)
        .padStart(6, '0')}`;
      drawCircle(ctx, this.point(vehicle.x, vehicle.y, map), 1.5, colour);
    }

    this.drawSelection(ctx, snapshot, map);
  }

  private drawSelection(
    ctx: CanvasRenderingContext2D,
    snapshot: WorldSnapshot,
    map: MapSnapshot,
  ): void {
    const selection = this.selection;
    if (!selection) return;
    let position: Point | null = null;
    if (selection.kind === 'vehicle') {
      const vehicle = snapshot.vehicles.find((item) => item.id === selection.id);
      if (vehicle) position = this.point(vehicle.x, vehicle.y, map);
    } else if (selection.kind === 'town') {
      const town = snapshot.towns.find((item) => item.id === selection.id);
      if (town) position = this.point(town.x, town.y, map);
    } else if (selection.kind === 'industry') {
      const industry = snapshot.industries.find((item) => item.id === selection.id);
      if (industry) position = this.point(industry.x, industry.y, map);
    } else if (selection.kind === 'station') {
      const station = snapshot.stations.find((item) => item.id === selection.id);
      if (station) position = this.point(station.x, station.y, map);
    } else if (selection.kind === 'tile') {
      const x = selection.id % map.width;
      const y = Math.floor(selection.id / map.width);
      position = this.point(x + 0.5, y + 0.5, map);
    }
    if (!position) return;
    ctx.beginPath();
    ctx.arc(position.x, position.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#7fd4a0';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  private drawCamera(ctx: CanvasRenderingContext2D): void {
    const map = this.map;
    const camera = this.camera;
    if (!map || !camera) return;
    const points = cameraFootprint(camera, this.aspect).map((point) =>
      worldToMinimap(point.x, point.y, this.layout, map.width, map.height),
    );
    const first = points[0];
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(232, 238, 242, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(232, 238, 242, 0.82)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (typeof window !== 'undefined') window.removeEventListener('scroll', this.refreshRect, true);
    this.cachedRect = null;
    this.ctx = null;
    this.throttle.reset();
    this.element.remove();
  }
}
