import { describe, expect, it } from 'vitest';
import { BuildController } from '../src/ui/buildController';
import { describeBuildPlan } from '../src/ui/buildHint';
import {
  commandFromPlan,
  createBuildSettings,
  type BuildPlan,
  type BuildSettings,
} from '../src/game/buildRules';
import { TILE_KIND_INDEX, type MapSnapshot } from '../src/engine/protocol';

function makeMap(width = 16, height = 16): MapSnapshot {
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
    railTypes: new Uint8Array(size),
    signalData: new Uint8Array(size),
  };
}

function setTile(
  map: MapSnapshot,
  x: number,
  y: number,
  kind: number,
  bits = 0,
  owner = 255,
): void {
  const index = y * map.width + x;
  map.kind[index] = kind;
  map.trackBits[index] = bits;
  map.owner[index] = owner;
}

/**
 * Colline régulière au sens OpenTTD pour un tunnel +x : portail (2,y) en talus
 * SW, crête à 7 sur x=4..7, sortie (8,y) en talus NE. `heightMap` porte le coin
 * nord de chaque tuile, d'où le décalage d'un niveau sur la sortie.
 */
function tunnelMound(map: MapSnapshot, y = 4): void {
  const set = (x: number, dy: number, height: number): void => {
    map.heightMap[(y + dy) * map.width + x] = height;
  };
  set(3, 0, 5);
  set(3, 1, 5);
  for (let x = 4; x <= 7; x += 1) {
    set(x, 0, 7);
    set(x, 1, 7);
  }
  set(8, 0, 5);
  set(8, 1, 5);
}

interface Harness {
  controller: BuildController;
  previews: (BuildPlan | null)[];
  commits: BuildPlan[];
  notices: string[];
  settings: BuildSettings;
}

function harness(map: MapSnapshot = makeMap()): Harness {
  const previews: (BuildPlan | null)[] = [];
  const commits: BuildPlan[] = [];
  const notices: string[] = [];
  const settings = createBuildSettings();
  const controller = new BuildController({
    getMap: () => map,
    getCompany: () => ({ id: 0, money: 1_000_000, bankrupt: false }),
    onPreview: (plan) => previews.push(plan),
    onCommit: (plan) => commits.push(plan),
    onNotice: (_kind, text) => notices.push(text),
  });
  controller.setSettings(settings);
  return { controller, previews, commits, notices, settings };
}

function lastPlan(previews: (BuildPlan | null)[]): BuildPlan | null {
  return previews[previews.length - 1] ?? null;
}

describe('BuildController : gares', () => {
  it('affiche l’emprise multi-tuiles et la taille choisie', () => {
    const { controller, previews, settings } = harness();
    settings.station = {
      ...settings.station,
      kind: 'rail',
      platforms: 2,
      length: 3,
      direction: 'ne',
    };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleHover({ x: 2, y: 2 });

    const plan = lastPlan(previews);
    expect(plan?.tool).toBe('station');
    expect(plan?.valid).toBe(true);
    expect(plan?.tiles).toHaveLength(6);
    expect(plan?.cost).toBe(6 * 650);
    expect(describeBuildPlan(plan, 'station')?.text).toContain('Gare ferroviaire 3×2');
    expect(describeBuildPlan(plan, 'station')?.text).toContain('6 tuiles');
  });

  it('pivote le fantôme et le rectangle avec R', () => {
    const { controller, previews, settings } = harness();
    settings.station = { ...settings.station, platforms: 2, length: 3, direction: 'ne' };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleHover({ x: 2, y: 2 });

    expect(controller.rotate()).toBe(true);
    const plan = lastPlan(previews);
    expect(plan?.station?.direction).toBe('se');
    expect(plan?.axis).toBe('y');
    expect(plan?.tiles.map((tile) => tile.x)).toEqual([2, 3, 2, 3, 2, 3]);

    controller.rotate();
    expect(lastPlan(previews)?.station?.direction).toBe('sw');
  });

  it('construit la gare au clic et transmet les options', () => {
    const { controller, commits, settings } = harness();
    settings.station = { ...settings.station, platforms: 2, length: 3, direction: 'ne' };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleEnd({ x: 2, y: 2 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tiles).toHaveLength(6);
    expect(commits[0]?.station?.platforms).toBe(2);
    expect(commits[0]?.station?.length).toBe(3);
  });

  it('bascule une gare routière en passage depuis les options', () => {
    const { controller, previews, settings } = harness();
    settings.station = { ...settings.station, kind: 'road', driveThrough: true, direction: 'nw' };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleHover({ x: 4, y: 4 });
    const plan = lastPlan(previews);
    expect(plan?.tiles).toHaveLength(1);
    expect(plan?.station?.driveThrough).toBe(true);
    expect(plan?.tiles[0]?.connections).toBe(1 | 4);
  });

  it('pose un arrêt en passage sur une route verticale en l’alignant seul', () => {
    const map = makeMap();
    setTile(map, 4, 4, TILE_KIND_INDEX.road, 1 | 4, 0);
    const { controller, previews, commits, settings } = harness(map);
    settings.station = { ...settings.station, kind: 'road', driveThrough: true, direction: 'ne' };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleHover({ x: 4, y: 4 });
    controller.handleBegin({ x: 4, y: 4 });

    const plan = lastPlan(previews);
    expect(plan?.valid).toBe(true);
    expect(plan?.axis).toBe('y');
    expect(plan?.station?.direction).toBe('nw');
    expect(plan?.tiles[0]?.connections).toBe(1 | 4);
    controller.handleEnd({ x: 4, y: 4 });
    expect(commits).toHaveLength(1);
    expect(commandFromPlan(commits[0]!, 0).options).toMatchObject({
      kind: 'road',
      direction: 'nw',
      axis: 'y',
      drive_through: true,
    });
  });

  it('revalide l’aperçu quand « en passage » est coché sur une route', () => {
    const map = makeMap();
    setTile(map, 4, 4, TILE_KIND_INDEX.road, 2 | 8, 0);
    const { controller, previews, settings } = harness(map);
    settings.station = { ...settings.station, kind: 'road', driveThrough: false, direction: 'ne' };
    controller.setSettings(settings);
    controller.setTool('station');
    controller.handleHover({ x: 4, y: 4 });

    expect(lastPlan(previews)?.valid).toBe(false);
    expect(lastPlan(previews)?.reason).toContain('en passage');

    settings.station = { ...settings.station, kind: 'road', driveThrough: true, direction: 'ne' };
    controller.setSettings(settings);
    const plan = lastPlan(previews);
    expect(plan?.valid).toBe(true);
    expect(plan?.station?.driveThrough).toBe(true);
    expect(plan?.tiles[0]?.connections).toBe(2 | 8);
  });

  it('annule le survol au clic droit sans désarmer l’outil', () => {
    const { controller, commits } = harness();
    controller.setTool('station');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 5, y: 5 });
    controller.handleCancel();
    controller.handleEnd({ x: 5, y: 5 });
    expect(commits).toHaveLength(0);
    expect(controller.activeTool).toBe('station');
  });
});

describe('BuildController : ponts et tunnels', () => {
  it('affiche un pont A→B, mémorise le matériau et le commit', () => {
    const map = makeMap();
    for (let x = 4; x <= 6; x += 1) {
      setTile(map, x, 4, TILE_KIND_INDEX.water);
      map.heightMap[4 * map.width + x] = 0;
    }
    const { controller, previews, commits, settings } = harness(map);
    settings.bridge = { kind: 'rail', material: 'suspension' };
    controller.setSettings(settings);
    controller.setTool('bridge');
    controller.handleBegin({ x: 2, y: 4 });
    controller.handleMove({ x: 8, y: 4 });
    const plan = lastPlan(previews);
    expect(plan?.tool).toBe('bridge');
    expect(plan?.valid).toBe(true);
    // Les culées sont ramenées au bord de l'eau (#243).
    expect(plan?.from).toEqual({ x: 3, y: 4 });
    expect(plan?.to).toEqual({ x: 7, y: 4 });
    expect(plan?.tiles).toHaveLength(5);
    expect(plan?.bridge).toMatchObject({ kind: 'rail', material: 'suspension', span: 4 });
    expect(describeBuildPlan(plan, 'bridge')?.text.toLowerCase()).toContain('suspendu');
    controller.handleEnd({ x: 8, y: 4 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.bridge?.material).toBe('suspension');
    expect(commits[0]?.to).toEqual({ x: 7, y: 4 });
  });

  it('projette un drag diagonal sur l’axe dominant au lieu de le refuser', () => {
    const { controller, previews, commits } = harness();
    controller.setTool('bridge');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 6, y: 6 });
    const plan = lastPlan(previews);
    expect(plan?.from).toEqual({ x: 2, y: 2 });
    expect(plan?.to).toEqual({ x: 6, y: 2 });
    expect(plan?.axis).toBe('x');
    expect(plan?.valid).toBe(false);
    controller.handleEnd({ x: 6, y: 6 });
    expect(commits).toHaveLength(0);
  });

  it('construit un pont après un drag diagonal grâce au calage sur l’axe', () => {
    const map = makeMap();
    // Une route au milieu du tracé : le tablier a un obstacle réel à franchir.
    setTile(map, 4, 2, TILE_KIND_INDEX.road, 0x0c, 0);
    const { controller, previews, commits, settings } = harness(map);
    settings.bridge = { kind: 'road', material: 'wood' };
    controller.setSettings(settings);
    controller.setTool('bridge');
    // Le geste descend de trois tuiles : l'axe X doit être conservé.
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleMove({ x: 6, y: 5 });
    // L'axe X est conservé, puis les culées sont recalées sur la route (3..5).
    expect(lastPlan(previews)?.to).toEqual({ x: 5, y: 2 });
    expect(lastPlan(previews)?.valid).toBe(true);
    controller.handleEnd({ x: 6, y: 5 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.to).toEqual({ x: 5, y: 2 });
  });

  it('trouve la sortie du tunnel quand le drag s’arrête sur le relief', () => {
    const map = makeMap();
    tunnelMound(map);
    const { controller, previews, commits, settings } = harness(map);
    settings.tunnel = { kind: 'rail' };
    controller.setSettings(settings);
    controller.setTool('tunnel');
    controller.handleBegin({ x: 2, y: 4 });
    // Le curseur est sur la colline et non sur un portail : la sortie est
    // retrouvée à la même surface, pas au coin nord surélevé.
    controller.handleMove({ x: 5, y: 5 });
    const plan = lastPlan(previews);
    expect(plan?.from).toEqual({ x: 2, y: 4 });
    expect(plan?.to).toEqual({ x: 8, y: 4 });
    expect(plan?.valid).toBe(true);
    expect(plan?.tunnel?.depth).toBe(3);
    controller.handleEnd({ x: 5, y: 5 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.to).toEqual({ x: 8, y: 4 });
  });

  it('refuse un clic sans drag avec un message explicite', () => {
    const { controller, notices, commits } = harness();
    controller.setTool('bridge');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleEnd({ x: 2, y: 2 });
    expect(commits).toHaveLength(0);
    expect(notices.some((text) => text.includes('Glissez d’une culée'))).toBe(true);
  });

  it('prévisualise et construit un tunnel entre deux portails', () => {
    const map = makeMap();
    tunnelMound(map);
    const { controller, previews, commits, settings } = harness(map);
    settings.tunnel = { kind: 'rail' };
    controller.setSettings(settings);
    controller.setTool('tunnel');
    controller.handleBegin({ x: 2, y: 4 });
    controller.handleMove({ x: 8, y: 4 });
    expect(lastPlan(previews)?.valid).toBe(true);
    expect(lastPlan(previews)?.tunnel?.depth).toBe(3);
    controller.handleEnd({ x: 8, y: 4 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tool).toBe('tunnel');
  });

  it('affiche un aperçu par défaut au simple survol, sans commit', () => {
    const { controller, previews, commits } = harness();
    controller.setTool('bridge');
    controller.handleHover({ x: 3, y: 5 });
    expect(lastPlan(previews)?.tool).toBe('bridge');
    expect(lastPlan(previews)?.tiles.length).toBeGreaterThan(1);
    expect(commits).toHaveLength(0);
  });
});

describe('BuildController : dépôts et signaux', () => {
  it('pose un dépôt route adjacent à une route', () => {
    const map = makeMap();
    setTile(map, 6, 5, TILE_KIND_INDEX.road, 2 | 8, 0);
    const { controller, previews, commits, settings } = harness(map);
    settings.depot = { kind: 'road', direction: null };
    controller.setSettings(settings);
    controller.setTool('depot');
    controller.handleHover({ x: 5, y: 5 });
    const plan = lastPlan(previews);
    expect(plan?.valid).toBe(true);
    expect(plan?.depot).toEqual({ kind: 'road', direction: 'ne' });
    controller.handleBegin({ x: 5, y: 5 });
    controller.handleEnd({ x: 5, y: 5 });
    expect(commits).toHaveLength(1);
  });

  it('refuse un signal hors voie ferrée et accepte une voie de l’entreprise', () => {
    const grass = harness();
    grass.controller.setTool('signal');
    grass.controller.handleHover({ x: 4, y: 4 });
    expect(lastPlan(grass.previews)?.valid).toBe(false);
    expect(lastPlan(grass.previews)?.reason).toContain('voie ferrée');

    const map = makeMap();
    setTile(map, 4, 4, TILE_KIND_INDEX.rail, 2 | 8, 0);
    const rail = harness(map);
    rail.controller.setTool('signal');
    rail.controller.handleHover({ x: 4, y: 4 });
    expect(lastPlan(rail.previews)?.valid).toBe(true);
    rail.controller.handleBegin({ x: 4, y: 4 });
    rail.controller.handleEnd({ x: 4, y: 4 });
    expect(rail.commits).toHaveLength(1);
    expect(rail.commits[0]?.tool).toBe('signal');
    expect(rail.controller.rotate()).toBe(false);
  });

  it('trace une ligne de signaux en glissant sur un axe', () => {
    const map = makeMap();
    for (let x = 3; x <= 5; x += 1) setTile(map, x, 3, TILE_KIND_INDEX.rail, 2 | 8, 0);
    const { controller, commits } = harness(map);
    controller.setTool('signal');
    controller.handleBegin({ x: 3, y: 3 });
    controller.handleMove({ x: 5, y: 3 });
    controller.handleEnd({ x: 5, y: 3 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.tiles).toHaveLength(3);
    expect(describeBuildPlan(commits[0] ?? null, 'signal')?.text).toContain('3 signaux');
  });
});

describe('BuildController : signaux et types de rail (#156/#157)', () => {
  it('transmet le type de signal, le sens et la densité', () => {
    const map = makeMap();
    for (let x = 2; x <= 8; x += 1) setTile(map, x, 2, TILE_KIND_INDEX.rail, 2 | 8, 0);
    const { controller, commits, settings } = harness(map);
    settings.signal = {
      type: 'exit',
      track: null,
      direction: 'both',
      spacing: 3,
    };
    controller.setSettings(settings);
    controller.setTool('signal');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleEnd({ x: 8, y: 2 });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.tool).toBe('signal');
    expect(commits[0]?.signal).toMatchObject({
      type: 'exit',
      direction: 'both',
      spacing: 3,
    });
    expect(commits[0]?.tiles.map((tile) => tile.x)).toEqual([2, 5, 8]);
    expect(describeBuildPlan(commits[0] ?? null, 'signal')?.text).toContain('3 signaux');
  });

  it('arme la conversion avec le type de rail choisi', () => {
    const map = makeMap();
    for (let x = 2; x <= 4; x += 1) setTile(map, x, 2, TILE_KIND_INDEX.rail, 2 | 8, 0);
    const { controller, commits, settings } = harness(map);
    settings.rail = { type: 'maglev' };
    controller.setSettings(settings);
    controller.setTool('convert');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleEnd({ x: 4, y: 2 });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.tool).toBe('convert');
    expect(commits[0]?.railType).toBe('maglev');
    expect(describeBuildPlan(commits[0] ?? null, 'convert')?.text).toContain('3 tuiles');
  });

  it('arme le retrait de signaux sans confondre avec la démolition', () => {
    const map = makeMap();
    setTile(map, 2, 2, TILE_KIND_INDEX.rail, 2 | 8, 0);
    map.flags[2 * map.width + 2] = 1 << 6;
    map.signalData![2 * map.width + 2] = 0x41;
    const { controller, commits, settings } = harness(map);
    controller.setSettings(settings);
    controller.setTool('unsignal');
    controller.handleBegin({ x: 2, y: 2 });
    controller.handleEnd({ x: 2, y: 2 });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.tool).toBe('unsignal');
    expect(commits[0]?.tiles).toHaveLength(1);
  });
});
