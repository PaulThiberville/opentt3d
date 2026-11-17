import { describe, expect, it } from 'vitest';
import type { MapSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import { sampleHeightWorld } from '../src/game/mapGrid';
import {
  SHORE_MAX_DISTANCE,
  WATER_BED_DROP,
  WATER_CASCADE_MAX_RUN,
  WATER_CASCADE_MIN_RUN,
  WATER_CASCADE_RUN_RATIO,
  WATER_CASCADE_TOP_INSET,
  WATER_DEPTH_RANGE,
  WATER_DEPTH_SPAN,
  WATER_FOAM_DEPTH,
  WATER_LEVEL_OFFSET,
  WATER_RIPPLE_FADE_FAR,
  WATER_RIPPLE_FADE_NEAR,
  WATER_RIPPLE_SCALE,
  WATER_SHADER_CONSTANTS,
  WATER_SHORE_FADE,
  WATER_SHORE_OVERLAP,
  WATER_WALL_EPSILON,
  WATER_WAVE_AMPLITUDE,
  buildShoreFields,
  buildWaterHeightFields,
  sampleCornerField,
  sampleField,
  waterBedHeight,
  waterCascadeOffset,
  waterCascadeRun,
  waterDepthAt,
  waterDepthFactor,
  waterFoamAmount,
  waterPhysicalDepth,
  waterShoreFade,
  waterSurfaceHeight,
  waterWallForEdge,
  waterWaveHeight,
} from '../src/render/waterSurface';

function makeMap(width: number, height: number, seaFrom: number): MapSnapshot {
  const size = width * height;
  const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
  const heightMap = new Uint8Array(size).fill(4);
  for (let y = 0; y < height; y += 1) {
    for (let x = seaFrom; x < width; x += 1) {
      kind[y * width + x] = TILE_KIND_INDEX.water;
      heightMap[y * width + x] = 0;
    }
  }
  return {
    width,
    height,
    kind,
    heightMap,
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

describe('hauteur et profondeur de l’eau', () => {
  it('place la surface sous le dessus de la tuile et le lit encore plus bas', () => {
    // Régression #176 : la surface était à +0,5, soit exactement le niveau de
    // la terre voisine ; elle recouvrait routes, ponts et quais.
    expect(WATER_LEVEL_OFFSET).toBeLessThan(0);
    expect(Math.abs(WATER_LEVEL_OFFSET)).toBeLessThanOrEqual(0.12);
    // La marge couvre la crête de houle : surface + amplitude < dessus.
    expect(Math.abs(WATER_LEVEL_OFFSET)).toBeGreaterThan(WATER_WAVE_AMPLITUDE);
    expect(waterSurfaceHeight(0)).toBeCloseTo(WATER_LEVEL_OFFSET, 6);
    expect(waterSurfaceHeight(2)).toBeCloseTo(WATER_LEVEL_OFFSET + 1, 6);
    expect(waterSurfaceHeight(4)).toBeGreaterThan(waterSurfaceHeight(2));
    // Entrées invalides : jamais de NaN dans la géométrie.
    expect(Number.isFinite(waterSurfaceHeight(Number.NaN))).toBe(true);
    expect(waterSurfaceHeight(-3)).toBeCloseTo(WATER_LEVEL_OFFSET, 6);

    for (let level = 0; level <= 15; level += 1) {
      const surface = waterSurfaceHeight(level);
      const bed = waterBedHeight(level);
      const top = level * 0.5;
      expect(surface).toBeLessThan(top);
      expect(bed).toBeLessThan(surface);
      // Écart exact lit/surface : la profondeur ne dépend que des constantes.
      expect(surface - bed).toBeCloseTo(WATER_BED_DROP + WATER_LEVEL_OFFSET, 5);
      // Assez de fond pour exclure tout z-fighting et voir la transparence.
      expect(surface - bed).toBeGreaterThan(0.4);
      // Une crête de houle reste sous le dessus de la tuile.
      expect(surface + WATER_WAVE_AMPLITUDE).toBeLessThan(top);
    }
  });

  it('convertit la distance à la côte en profondeur bornée', () => {
    expect(waterDepthFactor(0)).toBe(0);
    expect(waterDepthFactor(-2)).toBe(0);
    expect(waterDepthFactor(WATER_DEPTH_RANGE)).toBe(1);
    expect(waterDepthFactor(WATER_DEPTH_RANGE * 4)).toBe(1);
    expect(waterDepthFactor(1)).toBeLessThan(waterDepthFactor(4));
    for (let distance = 0; distance <= 12; distance += 0.25) {
      const depth = waterDepthFactor(distance);
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
  });

  it('borne la houle et la rend déterministe', () => {
    expect(WATER_WAVE_AMPLITUDE).toBeGreaterThan(0);
    expect(WATER_WAVE_AMPLITUDE).toBeLessThanOrEqual(0.08);
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let i = 0; i < 512; i += 1) {
      const height = waterWaveHeight(i * 0.37, (i % 13) - 6, ((i * 7) % 17) - 8);
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
      expect(Number.isFinite(height)).toBe(true);
    }
    expect(minimum).toBeGreaterThanOrEqual(-WATER_WAVE_AMPLITUDE - 1e-9);
    expect(maximum).toBeLessThanOrEqual(WATER_WAVE_AMPLITUDE + 1e-9);
    expect(maximum - minimum).toBeGreaterThan(WATER_WAVE_AMPLITUDE);
    expect(waterWaveHeight(3.5, 2, 7)).toBeCloseTo(waterWaveHeight(3.5, 2, 7), 12);
  });

  it('réserve l’écume à la frange côtière', () => {
    expect(waterFoamAmount(0, 1)).toBeGreaterThan(0.9);
    expect(waterFoamAmount(WATER_FOAM_DEPTH, 1)).toBe(0);
    expect(waterFoamAmount(1, 1)).toBe(0);
    expect(waterFoamAmount(0, 0)).toBe(0);
    for (const depth of [0, 0.02, 0.1, 0.4, 1]) {
      const foam = waterFoamAmount(depth, 0.6);
      expect(foam).toBeGreaterThanOrEqual(0);
      expect(foam).toBeLessThanOrEqual(1);
    }
  });
});

describe('champs de distance côte/terre', () => {
  it('mesure la profondeur depuis la terre et plafonne au large', () => {
    const map = makeMap(64, 64, 40);
    const fields = buildShoreFields(map);
    const across: number[] = [];
    for (let x = 40; x < 52; x += 1) across.push(fields.waterDistance[32 * 64 + x] ?? -1);
    // Les premières tuiles d'eau sont à 1..7 de la terre, puis le champ sature.
    expect(across).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7]);
    // Régression : les tuiles inatteignables restaient à 0 (eau « peu profonde »
    // partout, écume sur tout le large).
    expect(fields.waterDistance[32 * 64 + 63]).toBe(WATER_DEPTH_RANGE);
  });

  it('mesure la distance à l’eau sur la terre et sature à la limite', () => {
    const map = makeMap(64, 64, 40);
    const fields = buildShoreFields(map);
    expect(fields.landDistance[32 * 64 + 39]).toBe(1);
    expect(fields.landDistance[32 * 64 + 38]).toBe(2);
    expect(fields.landDistance[32 * 64 + 0]).toBe(SHORE_MAX_DISTANCE);
    for (let index = 0; index < map.kind.length; index += 1) {
      const water = map.kind[index] === TILE_KIND_INDEX.water;
      const distance = fields.landDistance[index] ?? 0;
      expect(distance).toBeGreaterThanOrEqual(0);
      expect(distance).toBeLessThanOrEqual(SHORE_MAX_DISTANCE);
      if (water) expect(distance).toBe(0);
      else expect(distance).toBeGreaterThanOrEqual(1);
      expect(fields.waterDistance[index] ?? 0).toBeLessThanOrEqual(WATER_DEPTH_RANGE);
    }
  });

  it('échantillonne au coin sans discontinuité entre tuiles', () => {
    const map = makeMap(64, 64, 40);
    const fields = buildShoreFields(map);
    for (let x = 36; x < 44; x += 0.5) {
      const value = sampleField(fields.waterDistance, 64, 64, x, 32);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(WATER_DEPTH_RANGE);
    }
    // Un même coin est échantillonné à l'identique par les quatre tuiles.
    const corner = sampleField(fields.landDistance, 64, 64, 40, 32);
    expect(sampleField(fields.landDistance, 64, 64, 40, 32)).toBeCloseTo(corner, 12);
    expect(sampleField(fields.landDistance, 64, 64, 64, 64)).toBe(
      fields.landDistance[63 * 64 + 63],
    );
  });
});

describe('champs de hauteur lit/surface', () => {
  function makeShoreMap(): MapSnapshot {
    const width = 24;
    const height = 24;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(2);
    // Étang de 6×6 au centre, lit au niveau 0.
    for (let y = 9; y < 15; y += 1) {
      for (let x = 9; x < 15; x += 1) {
        const index = y * width + x;
        kind[index] = TILE_KIND_INDEX.water;
        heightMap[index] = 0;
      }
    }
    // Quai sec au même niveau que la berge, collé à l'eau.
    kind[10 * width + 8] = TILE_KIND_INDEX.dock;
    heightMap[10 * width + 8] = 2;
    // Route côtière au niveau de la surface des tuiles d'eau.
    kind[14 * width + 8] = TILE_KIND_INDEX.road;
    heightMap[14 * width + 8] = 0;
    return {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
  }

  it('creuse le lit sous l’eau et laisse la terre intacte', () => {
    const map = makeShoreMap();
    const fields = buildWaterHeightFields(map);
    for (let index = 0; index < map.kind.length; index += 1) {
      const level = map.heightMap[index] ?? 0;
      const water =
        map.kind[index] === TILE_KIND_INDEX.water ||
        map.kind[index] === TILE_KIND_INDEX.river ||
        map.kind[index] === TILE_KIND_INDEX.canal;
      if (water) {
        expect(fields.bed[index]).toBeCloseTo(waterBedHeight(level), 5);
        expect(fields.surface[index]).toBeCloseTo(waterSurfaceHeight(level), 5);
        expect(fields.weight[index]).toBe(1);
        expect(fields.bed[index] ?? 0).toBeLessThan(fields.surface[index] ?? 0);
      } else {
        // Aucune tuile sèche n'est creusée ni marquée comme eau.
        expect(fields.bed[index]).toBeCloseTo(level * 0.5, 5);
        expect(fields.surface[index]).toBe(0);
        expect(fields.weight[index]).toBe(0);
      }
    }
  });

  it('échantillonne le lit exactement comme la hauteur du terrain', () => {
    // Carte entièrement sèche, avec des hauteurs variées : le champ de lit
    // doit reproduire exactement `sampleHeightWorld`.
    const width = 12;
    const height = 12;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) heightMap[y * width + x] = 1 + ((x * 3 + y * 5) % 9);
    }
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    for (let z = 0; z <= map.height; z += 0.5) {
      for (let x = 0; x <= map.width; x += 0.5) {
        expect(sampleCornerField(fields.bed, map.width, map.height, x, z)).toBeCloseTo(
          sampleHeightWorld(map, x, z),
          5,
        );
      }
    }
  });

  it('ne peint jamais une tuile sèche en fond sous-marin', () => {
    const map = makeShoreMap();
    const fields = buildWaterHeightFields(map);
    const depthAtTileCentre = (x: number, y: number): number => {
      const bed = sampleCornerField(fields.bed, map.width, map.height, x + 0.5, y + 0.5);
      return waterDepthAt(fields, map.width, map.height, x + 0.5, y + 0.5, bed);
    };
    // Quai, berge et route : profondeur nulle, même au contact de l'eau.
    expect(depthAtTileCentre(8, 10)).toBe(0);
    expect(depthAtTileCentre(8, 12)).toBe(0);
    expect(depthAtTileCentre(8, 14)).toBe(0);
    expect(depthAtTileCentre(12, 8)).toBe(0);
    // Au large, le lit est bien sous la surface.
    expect(depthAtTileCentre(12, 12)).toBeGreaterThan(0.5);
    // La rive exacte ne renvoie pas de profondeur (pas de liseré bleu).
    const shoreBed = sampleCornerField(fields.bed, map.width, map.height, 9, 12);
    expect(waterDepthAt(fields, map.width, map.height, 9, 12, shoreBed)).toBe(0);
  });

  it('garde l’eau sous une route ou un canal au même niveau', () => {
    const width = 8;
    const height = 8;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.road);
    const heightMap = new Uint8Array(size).fill(4);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        kind[y * width + x] = TILE_KIND_INDEX.canal;
        heightMap[y * width + x] = 4;
      }
    }
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    const surface = fields.surface[3 * width + 3] ?? 0;
    expect(surface).toBeCloseTo(waterSurfaceHeight(4), 5);
    // Le dessus du canal et la route voisine sont au niveau 4 : l'eau est
    // dessous, même avec la crête de houle.
    const top = waterSurfaceHeight(4) - WATER_LEVEL_OFFSET;
    expect(surface + WATER_WAVE_AMPLITUDE).toBeLessThan(top);
    const roadBed = sampleCornerField(fields.bed, width, height, 1.5, 3.5);
    expect(waterDepthAt(fields, width, height, 1.5, 3.5, roadBed)).toBe(0);
  });
});

describe('bornes du shader d’eau', () => {
  it('garde des constantes glissées dans le shader dans des plages sûres', () => {
    expect(WATER_FOAM_DEPTH).toBeGreaterThan(0);
    expect(WATER_FOAM_DEPTH).toBeLessThan(0.12);
    expect(WATER_RIPPLE_SCALE).toBeGreaterThan(1);
    expect(WATER_RIPPLE_SCALE).toBeLessThan(12);
    expect(WATER_RIPPLE_FADE_NEAR).toBeLessThan(WATER_RIPPLE_FADE_FAR);
    expect(WATER_SHADER_CONSTANTS).toContain(
      `const float WATER_WAVE_AMPLITUDE = ${WATER_WAVE_AMPLITUDE.toFixed(5)};`,
    );
    expect(WATER_SHADER_CONSTANTS).toContain('WATER_FOAM_DEPTH');
    expect(WATER_SHADER_CONSTANTS).not.toContain('NaN');
    expect(WATER_SHADER_CONSTANTS).not.toContain('Infinity');
  });
});

describe('rive adoucie et recouvrement (#204)', () => {
  function makeFlatCanal(): MapSnapshot {
    const width = 16;
    const height = 12;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(4);
    // Canal de 3 tuiles de large, au même niveau que la berge.
    for (let y = 3; y < 9; y += 1) {
      for (let x = 6; x < 9; x += 1) {
        const index = y * width + x;
        kind[index] = TILE_KIND_INDEX.canal;
      }
    }
    return {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
  }

  it('étend la nappe d’une couronne, jamais de deux', () => {
    const map = makeFlatCanal();
    const fields = buildWaterHeightFields(map);
    const covered = (x: number, y: number): boolean => fields.coverage[y * map.width + x] === 1;
    expect(WATER_SHORE_OVERLAP).toBe(1);
    // Eau.
    expect(covered(7, 5)).toBe(true);
    // Première couronne (bord et coin diagonal).
    expect(covered(5, 5)).toBe(true);
    expect(covered(5, 2)).toBe(true);
    expect(covered(9, 2)).toBe(true);
    // Deuxième couronne : exclue.
    expect(covered(4, 5)).toBe(false);
    expect(covered(4, 2)).toBe(false);
    expect(covered(10, 9)).toBe(false);
    // Toute berge recouverte reste sous le dessus de sa tuile.
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const index = y * map.width + x;
        if (fields.coverage[index] !== 1 || fields.weight[index] === 1) continue;
        const top = (map.heightMap[index] ?? 0) * 0.5;
        expect(fields.shoreSurface[index] ?? 0).toBeLessThanOrEqual(top);
      }
    }
  });

  it('n’étend pas une nappe haute sur une terre plus basse', () => {
    const width = 8;
    const height = 8;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(2);
    // Canal haut (niveau 6) longé par une terre basse (niveau 2).
    kind[3 * width + 3] = TILE_KIND_INDEX.canal;
    heightMap[3 * width + 3] = 6;
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    expect(fields.coverage[3 * width + 4]).toBe(0);
    expect(fields.coverage[4 * width + 3]).toBe(0);
  });

  it('prend le niveau bas quand deux nappes se touchent', () => {
    const width = 8;
    const height = 8;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(4);
    kind[3 * width + 3] = TILE_KIND_INDEX.canal;
    heightMap[3 * width + 3] = 7;
    kind[3 * width + 4] = TILE_KIND_INDEX.water;
    heightMap[3 * width + 4] = 0;
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    // La terre mitoyenne est recouverte avec la surface la plus basse.
    expect(fields.coverage[2 * width + 3]).toBe(1);
    expect(fields.shoreSurface[2 * width + 3]).toBeCloseTo(waterSurfaceHeight(0), 6);
  });

  it('suit la profondeur réelle sans seuil rectangulaire', () => {
    const map = makeFlatCanal();
    const fields = buildWaterHeightFields(map);
    const bed = (x: number, z: number): number =>
      sampleCornerField(fields.bed, map.width, map.height, x, z);
    const depth = (x: number, z: number): number =>
      waterDepthAt(fields, map.width, map.height, x, z, bed(x, z));
    // Au bord du canal, l'ancien seuil « poids d'eau = 1 » renvoyait 0 et
    // peignait une bande de sable rectangulaire ; la profondeur suit
    // maintenant la pente du lit.
    expect(depth(6, 5.5)).toBeGreaterThan(0);
    expect(depth(7, 5.5)).toBeGreaterThan(depth(6, 5.5));
    // Au centre, le lit est franchement immergé.
    expect(depth(7.5, 5.5)).toBeGreaterThan(0.5);
    // Sur la terre ferme, aucune teinte de fond.
    expect(depth(3, 5.5)).toBe(0);
    expect(depth(12, 5.5)).toBe(0);
    // Le fondu de rive s'annule sous le sol et sature au large.
    expect(waterShoreFade(-0.1)).toBe(0);
    expect(waterShoreFade(0)).toBe(0);
    expect(waterShoreFade(WATER_SHORE_FADE)).toBe(1);
    expect(waterPhysicalDepth(WATER_DEPTH_SPAN)).toBe(1);
    expect(waterPhysicalDepth(-1)).toBe(0);
  });

  it('garde des hauteurs et un fondu bornés avec des entrées invalides', () => {
    expect(Number.isFinite(waterShoreFade(Number.NaN))).toBe(true);
    expect(waterShoreFade(Number.NaN)).toBe(0);
    expect(waterPhysicalDepth(Number.NaN)).toBe(0);
    expect(WATER_SHORE_FADE).toBeGreaterThan(0.1);
    expect(WATER_SHORE_FADE).toBeLessThan(0.5);
    expect(WATER_DEPTH_SPAN).toBeCloseTo(WATER_BED_DROP + WATER_LEVEL_OFFSET, 8);
  });
});

describe('parois de rive (#205)', () => {
  function stepMap(): MapSnapshot {
    const width = 12;
    const height = 12;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(2);
    // Bief bas à gauche, écluse au milieu (niveau haut), bief haut à droite.
    for (let y = 4; y < 8; y += 1) {
      kind[y * width + 4] = TILE_KIND_INDEX.water;
      heightMap[y * width + 4] = 0;
      kind[y * width + 5] = TILE_KIND_INDEX.lock;
      heightMap[y * width + 5] = 4;
      kind[y * width + 6] = TILE_KIND_INDEX.water;
      heightMap[y * width + 6] = 4;
    }
    return {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
  }

  it('ferme la marche entre deux biefs de niveaux différents', () => {
    const map = stepMap();
    const fields = buildWaterHeightFields(map);
    // Côté écluse (haut) vers le bief bas : paroi d'eau.
    const wall = waterWallForEdge(map, fields, 5, 5, -1, 0);
    expect(wall).not.toBeNull();
    expect(wall?.water).toBe(true);
    expect(wall?.kind).toBe('lock');
    expect(wall?.run).toBe(0);
    expect(wall?.bottom).toBeCloseTo(waterSurfaceHeight(0), 6);
    expect(wall?.top).toBeCloseTo(waterSurfaceHeight(4) + WATER_WAVE_AMPLITUDE, 6);
    expect((wall?.top ?? 0) - (wall?.bottom ?? 0)).toBeGreaterThan(1.9);
    // Pas de doublon depuis le bief bas, qui regarde une surface plus haute.
    expect(waterWallForEdge(map, fields, 4, 5, 1, 0)).toBeNull();
    // Le bief haut est aussi plus haut que la berge sèche (niveau 2).
    const bank = waterWallForEdge(map, fields, 6, 5, 1, 0);
    expect(bank).not.toBeNull();
    expect(bank?.water).toBe(false);
    expect(bank?.kind).toBe('bank');
    expect(bank?.run).toBe(0);
    expect(bank?.bottom).toBeLessThan(waterSurfaceHeight(4));
  });

  it('transforme une chute libre en rideau incliné, pas en cube', () => {
    const width = 8;
    const height = 8;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(2);
    // Rivière haute (niveau 4) qui dévale dans une nappe basse (niveau 0).
    kind[3 * width + 3] = TILE_KIND_INDEX.river;
    heightMap[3 * width + 3] = 4;
    kind[3 * width + 4] = TILE_KIND_INDEX.river;
    heightMap[3 * width + 4] = 0;
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    const cascade = waterWallForEdge(map, fields, 3, 3, 1, 0);
    expect(cascade).not.toBeNull();
    expect(cascade?.water).toBe(true);
    expect(cascade?.kind).toBe('cascade');
    expect(cascade?.run).toBeGreaterThanOrEqual(WATER_CASCADE_MIN_RUN);
    expect(cascade?.run).toBeLessThanOrEqual(WATER_CASCADE_MAX_RUN);
    expect(cascade?.run).toBeCloseTo(
      waterCascadeRun((cascade?.top ?? 0) - (cascade?.bottom ?? 0)),
      6,
    );
    // Le rideau mord légèrement sur la nappe haute et avance vers la basse.
    expect(waterCascadeOffset(0, cascade?.run ?? 0)).toBeCloseTo(-WATER_CASCADE_TOP_INSET, 6);
    expect(waterCascadeOffset(1, cascade?.run ?? 0)).toBeCloseTo(cascade?.run ?? 0, 6);
    let previous = -Infinity;
    for (let step = 0; step <= 10; step += 1) {
      const offset = waterCascadeOffset(step / 10, cascade?.run ?? 0);
      expect(Number.isFinite(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
    // La course grandit avec la chute mais reste bornée.
    expect(waterCascadeRun(0)).toBe(0);
    expect(waterCascadeRun(1)).toBeGreaterThan(waterCascadeRun(0.4));
    expect(waterCascadeRun(1)).toBeLessThanOrEqual(waterCascadeRun(4));
    expect(waterCascadeRun(10)).toBe(WATER_CASCADE_MAX_RUN);
    expect(WATER_CASCADE_RUN_RATIO).toBeGreaterThan(0);
    expect(WATER_CASCADE_RUN_RATIO).toBeLessThan(1);
  });

  it('ne crée aucune paroi quand la berge atteint la surface', () => {
    const width = 8;
    const height = 8;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.grass);
    const heightMap = new Uint8Array(size).fill(4);
    kind[3 * width + 3] = TILE_KIND_INDEX.canal;
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      expect(waterWallForEdge(map, fields, 3, 3, dx, dy)).toBeNull();
    }
    expect(WATER_WALL_EPSILON).toBeGreaterThan(0);
  });

  it('raccorde une nappe haute au bord de carte sans vide', () => {
    const width = 4;
    const height = 4;
    const size = width * height;
    const kind = new Uint8Array(size).fill(TILE_KIND_INDEX.water);
    const heightMap = new Uint8Array(size).fill(0);
    const map: MapSnapshot = {
      width,
      height,
      kind,
      heightMap,
      owner: new Uint8Array(size).fill(255),
      slope: new Uint8Array(size),
      flags: new Uint8Array(size),
      trackBits: new Uint8Array(size),
    };
    const fields = buildWaterHeightFields(map);
    // Au niveau de la mer, le décor hors-limites prend le relais.
    expect(waterWallForEdge(map, fields, 0, 1, -1, 0)).toBeNull();
    expect(waterWallForEdge(map, fields, 1, 0, 0, -1)).toBeNull();

    // Un canal haut au bord ferme sa paroi jusqu'au niveau de la mer.
    const raised = buildWaterHeightFields({ ...map, heightMap: new Uint8Array(size).fill(4) });
    const wall = waterWallForEdge(map, raised, 0, 1, -1, 0);
    expect(wall).not.toBeNull();
    expect(wall?.water).toBe(true);
    expect(wall?.bottom).toBeCloseTo(waterSurfaceHeight(0), 6);
    expect(wall?.top).toBeCloseTo(waterSurfaceHeight(4) + WATER_WAVE_AMPLITUDE, 6);
  });
});
