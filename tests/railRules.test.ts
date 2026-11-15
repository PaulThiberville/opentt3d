import { describe, expect, it } from 'vitest';
import { RAIL_TYPE_INDEX, TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';
import {
  RAIL_TYPE_CONVERT_COST,
  RAIL_TYPE_SURCHARGE,
  RAIL_TYPES,
  deriveRailTypes,
  hasCatenary,
  nextRailType,
  parseRailType,
  railTypeAt,
  railTypeFromIndex,
} from '../src/game/railRules';
import { modelCompatibleWithRail, modelsForDepot, vehicleModel } from '../src/game/vehicleRules';

function makeMap(width = 4, height = 2): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(size).fill(4),
    owner: new Uint8Array(size).fill(255),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

describe('railRules : types de voie', () => {
  it('expose quatre types stables, sans caténaire sauf électrifié', () => {
    expect(RAIL_TYPES).toEqual(['rail', 'electrified', 'monorail', 'maglev']);
    expect(RAIL_TYPE_INDEX).toEqual({ rail: 0, electrified: 1, monorail: 2, maglev: 3 });
    expect(hasCatenary('electrified')).toBe(true);
    expect(hasCatenary('rail')).toBe(false);
    expect(hasCatenary('monorail')).toBe(false);
    expect(hasCatenary('maglev')).toBe(false);
  });

  it('lit les index et alias, et cycle dans l’ordre rail → électrifié → mono → maglev', () => {
    expect(railTypeFromIndex(0)).toBe('rail');
    expect(railTypeFromIndex(3)).toBe('maglev');
    expect(railTypeFromIndex(42)).toBe('rail');
    expect(parseRailType('electric')).toBe('electrified');
    expect(parseRailType('électrifié')).toBe('electrified');
    expect(parseRailType('mono')).toBe('monorail');
    expect(parseRailType('nope')).toBeNull();
    expect(nextRailType('rail')).toBe('electrified');
    expect(nextRailType('maglev')).toBe('rail');
  });

  it('facture les surcoûts et les conversions de façon croissante', () => {
    expect(RAIL_TYPE_SURCHARGE.rail).toBe(0);
    expect(RAIL_TYPE_SURCHARGE.electrified).toBeGreaterThan(0);
    expect(RAIL_TYPE_SURCHARGE.monorail).toBeGreaterThan(RAIL_TYPE_SURCHARGE.electrified);
    expect(RAIL_TYPE_SURCHARGE.maglev).toBeGreaterThan(RAIL_TYPE_SURCHARGE.monorail);
    expect(RAIL_TYPE_CONVERT_COST.maglev).toBeGreaterThan(RAIL_TYPE_CONVERT_COST.rail);
  });

  it('lit railTypes explicite, sinon le m8 du pont, sinon rail', () => {
    const explicit = Uint8Array.from([RAIL_TYPE_INDEX.monorail]);
    expect(railTypeAt(explicit, undefined, 0, true)).toBe('monorail');
    expect(railTypeAt(undefined, Uint8Array.from([RAIL_TYPE_INDEX.maglev]), 0, true)).toBe(
      'maglev',
    );
    expect(railTypeAt(undefined, Uint8Array.from([2]), 0, false)).toBe('rail');
  });

  it('dérive les types de rail uniquement sur les tuiles ferroviaires', () => {
    const map = makeMap();
    map.kind[0] = TILE_KIND_INDEX.rail;
    map.trackBits[0] = RAIL_TYPE_INDEX.maglev;
    map.kind[1] = TILE_KIND_INDEX.rail;
    map.trackBits[1] = RAIL_TYPE_INDEX.electrified;
    map.kind[2] = TILE_KIND_INDEX.road;
    map.trackBits[2] = 9;
    const types = deriveRailTypes(map);
    expect(types[0]).toBe(RAIL_TYPE_INDEX.maglev);
    expect(types[1]).toBe(RAIL_TYPE_INDEX.electrified);
    expect(types[2]).toBe(RAIL_TYPE_INDEX.rail);
  });
});

describe('railRules : matériel compatible', () => {
  it('réserve la locomotive électrique aux voies électrifiées', () => {
    const electric = vehicleModel('rail_electric');
    const autorail = vehicleModel('rail_autorail');
    if (!electric || !autorail) throw new Error('modèles ferroviaires attendus');
    expect(modelCompatibleWithRail(electric, 'electrified')).toBe(true);
    expect(modelCompatibleWithRail(electric, 'rail')).toBe(false);
    expect(modelCompatibleWithRail(autorail, 'rail')).toBe(true);
    expect(modelCompatibleWithRail(autorail, 'electrified')).toBe(true);
    expect(modelsForDepot('rail', 'monorail').map((model) => model.id)).toContain('rail_monorail');
    expect(modelsForDepot('rail', 'monorail').map((model) => model.id)).not.toContain(
      'rail_electric',
    );
  });

  it('garde tout le catalogue quand le type du dépôt est inconnu', () => {
    expect(modelsForDepot('rail').length).toBeGreaterThanOrEqual(5);
    expect(modelsForDepot('rail', null).map((model) => model.id)).toContain('rail_maglev');
  });
});
