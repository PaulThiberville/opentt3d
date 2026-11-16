import { describe, expect, it } from 'vitest';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import {
  findWaterLevelBreaks,
  normalizeWaterLevels,
  waterComponents,
  type WaterLevelMap,
} from '../src/game/waterLevels';

function makeWorld(width: number, height: number, level = 0): WaterLevelMap {
  return {
    width,
    height,
    kind: new Uint8Array(width * height).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(width * height).fill(level),
  };
}

function setTile(world: WaterLevelMap, x: number, y: number, kind: number, level: number): void {
  const index = y * world.width + x;
  world.kind[index] = kind;
  world.heightMap[index] = level;
}

describe('niveaux d’eau connexes (#205)', () => {
  it('aligne une composante sans écluse sur son niveau le plus bas', () => {
    const world = makeWorld(8, 8, 4);
    setTile(world, 2, 3, TILE_KIND_INDEX.water, 6);
    setTile(world, 3, 3, TILE_KIND_INDEX.river, 0);
    setTile(world, 4, 3, TILE_KIND_INDEX.water, 3);
    setTile(world, 4, 4, TILE_KIND_INDEX.canal, 6);
    const components = waterComponents(world);
    expect(components).toHaveLength(1);
    expect(components[0]?.levels).toEqual([0, 3, 6]);
    const changed = normalizeWaterLevels(world);
    expect(changed).toBe(3);
    expect(findWaterLevelBreaks(world)).toEqual([]);
    expect(waterComponents(world).every((component) => component.levels.length === 1)).toBe(true);
  });

  it('laisse une écluse séparer deux biefs de niveaux légitimes', () => {
    const world = makeWorld(10, 6, 4);
    for (let y = 2; y < 4; y += 1) {
      setTile(world, 2, y, TILE_KIND_INDEX.water, 0);
      setTile(world, 3, y, TILE_KIND_INDEX.water, 0);
      setTile(world, 4, y, TILE_KIND_INDEX.lock, 5);
      setTile(world, 5, y, TILE_KIND_INDEX.canal, 5);
      setTile(world, 6, y, TILE_KIND_INDEX.canal, 5);
    }
    // Une tuile erratique plus haute dans le bief haut est corrigée, pas l'écluse.
    setTile(world, 6, 2, TILE_KIND_INDEX.canal, 9);
    const changed = normalizeWaterLevels(world);
    expect(changed).toBe(1);
    expect(world.heightMap[4 + 2 * world.width]).toBe(5);
    expect(world.heightMap[6 + 2 * world.width]).toBe(5);
    expect(world.heightMap[2 + 2 * world.width]).toBe(0);
    // Les écluses ne sont pas comptées comme des ruptures.
    expect(findWaterLevelBreaks(world)).toEqual([]);
    expect(waterComponents(world)).toHaveLength(2);
  });

  it('ne touche ni la terre, ni le vide, ni une nappe isolée', () => {
    const world = makeWorld(8, 8, 3);
    setTile(world, 1, 1, TILE_KIND_INDEX.water, 5);
    setTile(world, 6, 6, TILE_KIND_INDEX.water, 2);
    setTile(world, 6, 7, TILE_KIND_INDEX.void, 0);
    const changed = normalizeWaterLevels(world);
    expect(changed).toBe(0);
    expect(world.heightMap[1 + 1 * world.width]).toBe(5);
    expect(world.heightMap[6 + 6 * world.width]).toBe(2);
    expect(world.heightMap[6 + 7 * world.width]).toBe(0);
  });

  it('reste déterministe et idempotente', () => {
    const build = (): WaterLevelMap => {
      const world = makeWorld(12, 12, 4);
      for (let x = 2; x < 10; x += 1) {
        setTile(world, x, 5, TILE_KIND_INDEX.river, x % 3 === 0 ? 7 : 2);
      }
      setTile(world, 5, 6, TILE_KIND_INDEX.canal, 9);
      return world;
    };
    const a = build();
    const b = build();
    expect(normalizeWaterLevels(a)).toBe(normalizeWaterLevels(b));
    expect([...a.heightMap]).toEqual([...b.heightMap]);
    expect(normalizeWaterLevels(a)).toBe(0);
  });
});
