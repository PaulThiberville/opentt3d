import { describe, expect, it } from 'vitest';
import { TILE_KIND_INDEX, type IndustrySnapshot, type MapSnapshot } from '../src/engine/protocol';
import type { IndustryArchetype } from '../src/render/industryPlan';
import { planIndustry } from '../src/render/industryPlan';
import { buildIndustryGeometry } from '../src/render/models/industries';

const ARCHETYPES: { archetype: IndustryArchetype; kind: string }[] = [
  { archetype: 'mine', kind: 'coal_mine' },
  { archetype: 'power', kind: 'power_station' },
  { archetype: 'factory', kind: 'factory' },
  { archetype: 'sawmill', kind: 'sawmill' },
  { archetype: 'farm', kind: 'farm' },
  { archetype: 'forest', kind: 'forest' },
  { archetype: 'refinery', kind: 'oil_refinery' },
  { archetype: 'quarry', kind: 'quarry' },
  { archetype: 'generic', kind: 'bank' },
];

function makeMap(width = 32, height = 32): MapSnapshot {
  const size = width * height;
  const map: MapSnapshot = {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
  for (let y = 10; y <= 12; y += 1) {
    for (let x = 10; x <= 12; x += 1) {
      const index = y * width + x;
      map.kind[index] = TILE_KIND_INDEX.industry;
      map.heightMap[index] = 5;
    }
  }
  return map;
}

function footprint(): { x: number; y: number; height: number }[] {
  const tiles: { x: number; y: number; height: number }[] = [];
  for (let y = 10; y <= 12; y += 1) {
    for (let x = 10; x <= 12; x += 1) tiles.push({ x, y, height: 2.5 });
  }
  return tiles;
}

function industry(kind: string, id = 0): IndustrySnapshot {
  return {
    id,
    name: kind,
    kind,
    x: 11.5,
    y: 11.5,
    production: 240,
    transported: 80,
    stocks: [],
  };
}

describe('modèles d’industries', () => {
  it('livre les huit archétypes sous 2 000 triangles, détails compris', () => {
    const map = makeMap();
    for (const { archetype, kind } of ARCHETYPES) {
      const plan = planIndustry(industry(kind), footprint(), 2);
      expect(plan.archetype).toBe(archetype);
      const result = buildIndustryGeometry([plan], 2);
      expect(result.stats.triangles).toBeLessThan(2_000);
      expect(result.stats.windows).toBeGreaterThan(0);
      expect(result.geometry.getAttribute('position').count).toBeGreaterThan(0);
      result.geometry.dispose();
    }
    void map;
  });

  it('borne les ajouts de détail à l’emprise de l’industrie', () => {
    for (const { kind } of ARCHETYPES) {
      const plan = planIndustry(industry(kind), footprint(), 2);
      const result = buildIndustryGeometry([plan], 2);
      const position = result.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index += 1) {
        expect(position.getX(index)).toBeGreaterThanOrEqual(9.9);
        expect(position.getX(index)).toBeLessThanOrEqual(13.1);
        expect(position.getZ(index)).toBeGreaterThanOrEqual(9.9);
        expect(position.getZ(index)).toBeLessThanOrEqual(13.1);
      }
      result.geometry.dispose();
    }
  });

  it('réduit fortement la géométrie au niveau de détail 0', () => {
    for (const { kind } of ARCHETYPES) {
      const plan = planIndustry(industry(kind), footprint(), 2);
      const detailed = buildIndustryGeometry([plan], 2);
      const coarse = buildIndustryGeometry([plan], 0);
      expect(coarse.stats.triangles).toBeLessThan(detailed.stats.triangles);
      expect(coarse.stats.windows).toBe(0);
      expect(coarse.stats.parts).toBe(plan.parts.length);
      detailed.geometry.dispose();
      coarse.geometry.dispose();
    }
  });

  it('varie de façon déterministe selon l’identifiant', () => {
    for (const { kind } of ARCHETYPES) {
      const first = planIndustry(industry(kind, 3), footprint(), 2);
      const again = planIndustry(industry(kind, 3), footprint(), 2);
      const other = planIndustry(industry(kind, 9), footprint(), 2);
      const firstGeometry = buildIndustryGeometry([first], 2);
      const againGeometry = buildIndustryGeometry([again], 2);
      const otherGeometry = buildIndustryGeometry([other], 2);
      const read = (geometry: typeof firstGeometry.geometry): number[] =>
        Array.from(geometry.getAttribute('position').array as Float32Array);
      expect(read(againGeometry.geometry)).toEqual(read(firstGeometry.geometry));
      expect(read(otherGeometry.geometry)).not.toEqual(read(firstGeometry.geometry));
      firstGeometry.geometry.dispose();
      againGeometry.geometry.dispose();
      otherGeometry.geometry.dispose();
    }
  });

  it('fusionne plusieurs industries en une seule géométrie', () => {
    const planA = planIndustry(industry('factory', 0), footprint(), 2);
    const planB = planIndustry(industry('factory', 1), [], 2);
    const one = buildIndustryGeometry([planA], 2);
    const both = buildIndustryGeometry([planA, planB], 2);
    expect(both.stats.triangles).toBeGreaterThan(one.stats.triangles);
    expect(both.geometry.getAttribute('position').count).toBe(both.stats.triangles * 3);
    one.geometry.dispose();
    both.geometry.dispose();
  });
});
