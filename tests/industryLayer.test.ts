import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Mesh } from 'three';
import type { IndustrySnapshot, MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { MockEngine } from '../src/engine/MockEngine';
import { IndustryLayer } from '../src/render/IndustryLayer';
import {
  collectIndustryFootprint,
  industryArchetype,
  planDetail,
  planIndustry,
} from '../src/render/industryPlan';

function makeMap(width = 32, height = 32): MapSnapshot {
  const size = width * height;
  const heightMap = new Uint8Array(size);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) heightMap[y * width + x] = 4 + ((x + y) % 2);
  }
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap,
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function paint(map: MapSnapshot, x: number, y: number, kind: number, level?: number): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  if (level !== undefined) map.heightMap[index] = level;
}

function industry(kind: string, id = 0, x = 10.5, y = 10.5): IndustrySnapshot {
  return {
    id,
    name: `Industrie ${id}`,
    kind,
    x,
    y,
    production: 240,
    transported: 80,
    stocks: [{ cargo: 'coal', amount: 40 }],
  };
}

function makeIndustrialMap(): MapSnapshot {
  const map = makeMap();
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      paint(map, 10 + dx, 10 + dy, TILE_KIND_INDEX.industry, 5);
    }
  }
  // Routes et gare adjacentes : elles ne doivent jamais entrer dans l'emprise.
  paint(map, 9, 10, TILE_KIND_INDEX.road);
  paint(map, 9, 11, TILE_KIND_INDEX.station);
  paint(map, 10, 12, TILE_KIND_INDEX.rail);
  return map;
}

function triangleCount(layer: IndustryLayer): number {
  let total = 0;
  for (const child of layer.group.children) {
    if (!(child as Mesh).isMesh) continue;
    const mesh = child as Mesh;
    const geometry = mesh.geometry;
    if (geometry.index) total += geometry.index.count / 3;
    else total += (geometry.getAttribute('position')?.count ?? 0) / 3;
  }
  return total;
}

function meshNames(layer: IndustryLayer): string[] {
  return layer.group.children.map((child) => child.name);
}

describe('archétypes et plans d’industrie', () => {
  it('reconnaît les silhouettes OpenTTD et retombe sur un modèle générique', () => {
    expect(industryArchetype('coal_mine')).toBe('mine');
    expect(industryArchetype('iron_ore_mine')).toBe('mine');
    expect(industryArchetype('power_station')).toBe('power');
    expect(industryArchetype('sawmill')).toBe('sawmill');
    expect(industryArchetype('farm')).toBe('farm');
    expect(industryArchetype('factory')).toBe('factory');
    expect(industryArchetype('oil_refinery')).toBe('refinery');
    expect(industryArchetype('forest')).toBe('forest');
    expect(industryArchetype('quarry')).toBe('quarry');
    expect(industryArchetype('bank')).toBe('generic');
    expect(industryArchetype('')).toBe('generic');
  });

  it('traduit la qualité en niveau de détail', () => {
    expect(planDetail('low')).toBe(0);
    expect(planDetail('medium')).toBe(1);
    expect(planDetail('high')).toBe(2);
    expect(planDetail('inconnu')).toBe(1);
  });

  it('limite l’emprise aux tuiles industry contiguës', () => {
    const map = makeIndustrialMap();
    const footprint = collectIndustryFootprint(map, industry('coal_mine'));
    expect(footprint).toHaveLength(7);
    const keys = new Set(footprint.map((tile) => `${tile.x},${tile.y}`));
    expect(keys.has('9,10')).toBe(false);
    expect(keys.has('9,11')).toBe(false);
    expect(keys.has('10,12')).toBe(false);
    expect(footprint.every((tile) => tile.height === 2.5)).toBe(true);
  });

  it('retrouve une tuile industrielle voisine si le centre est décalé', () => {
    const map = makeIndustrialMap();
    const footprint = collectIndustryFootprint(map, industry('farm', 0, 11.5, 10.5));
    expect(footprint.length).toBeGreaterThan(0);
  });

  it('construit des volumes bornés à leur tuile', () => {
    const map = makeIndustrialMap();
    const footprint = collectIndustryFootprint(map, industry('factory'));
    const plan = planIndustry(industry('factory'), footprint, 2);
    expect(plan.parts.length).toBeGreaterThan(4);
    for (const part of plan.parts) {
      const tileX = Math.floor(part.x);
      const tileY = Math.floor(part.z);
      expect(footprint.some((tile) => tile.x === tileX && tile.y === tileY)).toBe(true);
      expect(part.width).toBeLessThanOrEqual(0.92);
      expect(part.depth).toBeLessThanOrEqual(0.92);
      if (part.tiltZ === 0 && !part.centre) {
        expect(part.x - part.width / 2).toBeGreaterThanOrEqual(tileX - 1e-6);
        expect(part.x + part.width / 2).toBeLessThanOrEqual(tileX + 1 + 1e-6);
        expect(part.z - part.depth / 2).toBeGreaterThanOrEqual(tileY - 1e-6);
        expect(part.z + part.depth / 2).toBeLessThanOrEqual(tileY + 1 + 1e-6);
      }
    }
  });

  it('varie de façon déterministe selon l’identifiant', () => {
    const map = makeIndustrialMap();
    const first = planIndustry(
      industry('coal_mine', 0),
      collectIndustryFootprint(map, industry('coal_mine', 0)),
      2,
    );
    const again = planIndustry(
      industry('coal_mine', 0),
      collectIndustryFootprint(map, industry('coal_mine', 0)),
      2,
    );
    const other = planIndustry(
      industry('coal_mine', 7),
      collectIndustryFootprint(map, industry('coal_mine', 7)),
      2,
    );
    expect(again).toEqual(first);
    expect(JSON.stringify(other.parts)).not.toBe(JSON.stringify(first.parts));
  });

  it('réduit le nombre de volumes en basse qualité', () => {
    const map = makeIndustrialMap();
    const footprint = collectIndustryFootprint(map, industry('power_station'));
    const low = planIndustry(industry('power_station'), footprint, 0);
    const medium = planIndustry(industry('power_station'), footprint, 1);
    const high = planIndustry(industry('power_station'), footprint, 2);
    expect(low.parts.length).toBeLessThan(medium.parts.length);
    expect(medium.parts.length).toBeLessThanOrEqual(high.parts.length);
    expect(low.parts.length).toBeLessThanOrEqual(4);
  });

  it('expose les cheminées pour la fumée', () => {
    const map = makeIndustrialMap();
    const footprint = collectIndustryFootprint(map, industry('power_station'));
    const plan = planIndustry(industry('power_station'), footprint, 2);
    expect(plan.smokeStacks.length).toBe(2);
    expect(plan.smokeStacks[0]?.y).toBeGreaterThan(footprint[0]?.height ?? 0);
  });
});

describe('IndustryLayer', () => {
  const engine = new MockEngine();

  afterAll(() => engine.dispose());

  async function mockSnapshot(): Promise<ReturnType<MockEngine['snapshot']>> {
    await engine.init({ moduleUrl: 'mock://test' });
    await engine.newGame({ seed: 1337, width: 96, height: 96, aiCompanies: 1 });
    return engine.snapshot();
  }

  it('fusionne les industries par archétype et reste dans le budget', async () => {
    const snapshot = await mockSnapshot();
    expect(snapshot.map).not.toBeNull();
    if (!snapshot.map) throw new Error('carte manquante');
    const layer = new IndustryLayer();
    layer.build(snapshot.industries, snapshot.map, 'medium');
    expect(layer.industryCount).toBe(snapshot.industries.length);
    expect(layer.builds).toBe(1);
    expect(layer.drawCallCount).toBeLessThanOrEqual(8);
    expect(layer.drawCallCount).toBe(meshNames(layer).length);
    expect(layer.partCount).toBeGreaterThan(layer.industryCount * 3);
    expect(triangleCount(layer)).toBeLessThan(30_000);
    expect(meshNames(layer).some((name) => name === 'industry-smoke')).toBe(true);
    layer.dispose();
  });

  it('ne reconstruit pas quand seule la production change', async () => {
    const snapshot = await mockSnapshot();
    if (!snapshot.map) throw new Error('carte manquante');
    const layer = new IndustryLayer();
    layer.build(snapshot.industries, snapshot.map, 'medium');
    const before = triangleCount(layer);
    const productionOnly = snapshot.industries.map((item) => ({
      ...item,
      production: item.production + 50,
      transported: item.transported + 10,
    }));
    layer.build(productionOnly, snapshot.map, 'medium');
    expect(layer.builds).toBe(1);
    expect(triangleCount(layer)).toBe(before);
    const geometry = (layer.group.children[0] as Mesh).geometry;
    layer.update(0.5);
    expect((layer.group.children[0] as Mesh).geometry).toBe(geometry);
    layer.dispose();
  });

  it('applique le LOD de qualité et coupe la fumée en basse qualité', async () => {
    const snapshot = await mockSnapshot();
    if (!snapshot.map) throw new Error('carte manquante');
    const layer = new IndustryLayer();
    layer.build(snapshot.industries, snapshot.map, 'medium');
    const archetypes = new Set(snapshot.industries.map((item) => industryArchetype(item.kind)))
      .size;
    expect(layer.drawCallCount).toBe(archetypes + 1);

    layer.setQuality('low');
    expect(layer.detailLevel).toBe(0);
    expect(layer.drawCallCount).toBe(archetypes);
    expect(meshNames(layer).includes('industry-smoke')).toBe(false);

    layer.setQuality('high');
    expect(layer.detailLevel).toBe(2);
    expect(meshNames(layer).includes('industry-smoke')).toBe(true);
    layer.dispose();
  });

  it('bascule les archétypes lointains en silhouette simplifiée', async () => {
    const snapshot = await mockSnapshot();
    if (!snapshot.map) throw new Error('carte manquante');
    const initial = snapshot.industries[0];
    if (!initial) throw new Error('industrie manquante');
    const layer = new IndustryLayer();
    layer.build(snapshot.industries, snapshot.map, 'medium');
    expect(layer.coarseLods).toBe(0);
    const detailedTriangles = triangleCount(layer);
    const detailedGeometry = (layer.group.children[0] as Mesh).geometry;
    layer.update(0.1, new THREE.Vector3(initial.x, 40, initial.y));
    expect(layer.coarseLods).toBe(0);
    expect((layer.group.children[0] as Mesh).geometry).toBe(detailedGeometry);
    layer.update(0.1, new THREE.Vector3(initial.x + 2_000, 40, initial.y + 2_000));
    expect(layer.coarseLods).toBeGreaterThan(0);
    expect(triangleCount(layer)).toBeLessThan(detailedTriangles);
    layer.update(0.1, new THREE.Vector3(initial.x, 40, initial.y));
    expect(layer.coarseLods).toBe(0);
    expect((layer.group.children[0] as Mesh).geometry).toBe(detailedGeometry);
    layer.dispose();
  });

  it('se libère complètement', async () => {
    const snapshot = await mockSnapshot();
    if (!snapshot.map) throw new Error('carte manquante');
    const layer = new IndustryLayer();
    layer.build(snapshot.industries, snapshot.map, 'high');
    expect(layer.group.children.length).toBeGreaterThan(0);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    expect(layer.drawCallCount).toBe(0);
    expect(layer.industryCount).toBe(0);
    expect(layer.builds).toBe(0);
  });
});
