import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { StationSnapshot, WorldSnapshot } from '../src/engine/protocol';
import { resetI18n, setLanguage } from '../src/ui/i18n';
import {
  describeIndustryPanel,
  describePlacePanel,
  describeStationPanel,
  describeTownPanel,
  industryAtTile,
  isPlaceSelection,
  placeTargetExists,
} from '../src/ui/placeView';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function snapshot(): WorldSnapshot {
  return {
    meta: { protocol: 1, tick: 42, hash: 'abc', sequence: 1 },
    economy: { year: 1950, month: 0, day: 1, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies: [
      {
        id: 0,
        name: 'Transports Valmont',
        president: 'A. Martin',
        colour: 3,
        money: 1_200_000,
        loan: 0,
        value: 900_000,
        income: 12_000,
        expenses: 8_000,
        vehicles: 2,
        stations: 2,
        isAI: false,
        isLocal: true,
        bankrupt: false,
      },
    ],
    towns: [
      {
        id: 0,
        name: 'Valmont',
        x: 4.5,
        y: 4.5,
        population: 900,
        growthRate: 2,
        buildings: 40,
        rating: 72,
      },
    ],
    industries: [
      {
        id: 0,
        name: 'Mine de Valmont',
        kind: 'coal_mine',
        x: 5.5,
        y: 5.5,
        production: 320,
        transported: 180,
        stocks: [
          { cargo: 'coal', amount: 112 },
          { cargo: 'goods', amount: 8 },
        ],
      },
      {
        id: 1,
        name: 'Usine lointaine',
        kind: 'factory',
        x: 15.5,
        y: 15.5,
        production: 90,
        transported: 40,
        stocks: [],
      },
    ],
    stations: [
      {
        id: 0,
        company: 0,
        name: 'Valmont Gare',
        kind: 'train',
        x: 10.5,
        y: 10.5,
        width: 2,
        height: 1,
        waiting: [
          { cargo: 'passengers', amount: 45 },
          { cargo: 'mail', amount: 5 },
        ],
      },
      {
        id: 1,
        company: 0,
        name: 'Halte du Lac',
        kind: 'road',
        x: 40.5,
        y: 4.5,
        width: 1,
        height: 1,
        waiting: [],
      },
    ],
    depots: [],
    vehicles: [
      {
        id: 7,
        kind: 'train',
        company: 0,
        x: 10,
        y: 10,
        z: 0,
        direction: 0,
        speed: 30,
        status: 1,
        cargo: { type: 'coal', amount: 20, capacity: 140 },
        orderTargets: [0, 0],
        orderKinds: ['industry', 'station'],
        profitLastYear: 4_000,
        ageDays: 120,
      },
      {
        id: 8,
        kind: 'road',
        company: 0,
        x: 20,
        y: 4,
        z: 0,
        direction: 0,
        speed: 18,
        status: 2,
        cargo: null,
        orderTargets: [0],
        orderKinds: ['station'],
        profitLastYear: 900,
        ageDays: 60,
      },
    ],
    news: [],
    events: [],
  };
}

function statValue(view: { stats: { label: string; value: string }[] }, label: string): string {
  return view.stats.find((entry) => entry.label === label)?.value ?? '';
}

afterEach(() => {
  resetI18n();
});

describe('panneau ville', () => {
  it('mappe le snapshot en statistiques et listes proches', () => {
    const view = describeTownPanel(snapshot(), 0);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.kind).toBe('town');
    expect(view.title).toBe('Valmont');
    expect(view.detail).toContain('900');
    expect(statValue(view, 'Population')).toBe('900');
    expect(statValue(view, 'Satisfaction')).toBe('72 / 100');
    expect(statValue(view, 'Gares proches')).toBe('1');
    expect(statValue(view, 'Industries proches')).toBe('2');
    expect(view.sections.map((section) => section.id)).toEqual(['stations', 'industries']);
    expect(view.sections[0]?.items[0]?.label).toBe('Valmont Gare');
    expect(view.sections[0]?.items[0]?.target).toEqual({ kind: 'station', id: 0 });
    expect(view.sections[1]?.items[0]?.label).toBe('Mine de Valmont');
    expect(view.actions.map((action) => action.kind)).toEqual(['focus', 'unsupported']);
  });

  it('garde le financement local désactivé avec une explication', () => {
    const view = describeTownPanel(snapshot(), 0);
    const funding = view?.actions.find((action) => action.id === 'fund-town');
    expect(funding?.supported).toBe(false);
    expect(funding?.reason).toMatch(/protocole v1/);
    expect(funding?.reason).toMatch(/Aucune dépense/);
  });

  it('signale les valeurs manquantes sans inventer de gare', () => {
    const empty = { ...snapshot(), stations: [], industries: [] };
    const view = describeTownPanel(empty, 0);
    expect(view?.sections[0]?.items).toEqual([]);
    expect(view?.sections[0]?.empty).toBe('Aucune gare dans le rayon.');
    expect(view?.sections[1]?.empty).toBe('Aucune industrie dans le rayon.');
    expect(statValue(view!, 'Gares proches')).toBe('0');
  });

  it('tonalise la satisfaction basse', () => {
    const base = snapshot();
    const town = base.towns[0];
    if (!town) throw new Error('fixture sans ville');
    const view = describeTownPanel({ ...base, towns: [{ ...town, rating: 12 }] }, 0);
    const rating = view?.stats.find((entry) => entry.label === 'Satisfaction');
    expect(rating?.tone).toBe('bad');
  });
});

describe('panneau industrie', () => {
  it('mappe production, stocks, gares desservies et véhicules', () => {
    const view = describeIndustryPanel(snapshot(), 0);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.kind).toBe('industry');
    expect(view.title).toBe('Mine de Valmont');
    expect(statValue(view, 'Production')).toBe('320');
    expect(statValue(view, 'Transporté')).toBe('180');
    expect(statValue(view, 'Stocks')).toBe('120 unités');
    expect(statValue(view, 'Gares desservies')).toBe('1');
    expect(statValue(view, 'Véhicules')).toBe('1');
    const stocks = view.sections.find((section) => section.id === 'stocks');
    expect(stocks?.items.map((item) => item.label)).toEqual(['Charbon', 'Marchandises']);
    const served = view.sections.find((section) => section.id === 'served-stations');
    expect(served?.items[0]?.target).toEqual({ kind: 'station', id: 0 });
    const vehicles = view.sections.find((section) => section.id === 'vehicles');
    expect(vehicles?.items[0]?.target).toEqual({ kind: 'vehicle', id: 7 });
    expect(vehicles?.items[0]?.detail).toContain('en route');
  });

  it('affiche des listes vides quand rien ne dessert l’industrie', () => {
    const base = snapshot();
    const view = describeIndustryPanel({ ...base, vehicles: [] }, 0);
    expect(view?.sections.find((section) => section.id === 'served-stations')?.items).toEqual([]);
    expect(view?.sections.find((section) => section.id === 'vehicles')?.empty).toBe(
      'Aucun véhicule ne dessert ce lieu.',
    );
    expect(view?.sections.find((section) => section.id === 'stocks')?.items).toHaveLength(2);
    expect(describeIndustryPanel({ ...base, industries: [] }, 0)).toBeNull();
  });

  it('garde la subvention désactivée sans commande factice', () => {
    const view = describeIndustryPanel(snapshot(), 0);
    const subsidy = view?.actions.find((action) => action.id === 'subsidize');
    expect(subsidy?.supported).toBe(false);
    expect(subsidy?.reason).toMatch(/subventions/);
    expect(view).not.toHaveProperty('cost');
  });
});

describe('panneau gare', () => {
  it('affiche l’attente par cargaison et les véhicules desservants', () => {
    const view = describeStationPanel(snapshot(), 0);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.kind).toBe('station');
    expect(view.title).toBe('Valmont Gare');
    expect(view.detail).toContain('Transports Valmont');
    expect(statValue(view, 'Attente')).toBe('50 unités');
    expect(statValue(view, 'Véhicules')).toBe('2');
    expect(statValue(view, 'Emprise')).toBe('2 × 1 tuiles');
    const waiting = view.sections.find((section) => section.id === 'waiting');
    expect(waiting?.items.map((item) => item.label)).toEqual(['Voyageurs', 'Courrier']);
    expect(waiting?.items.map((item) => item.detail)).toEqual(['45 unités', '5 unités']);
    const vehicles = view.sections.find((section) => section.id === 'vehicles');
    expect(vehicles?.items.map((item) => item.target)).toEqual([
      { kind: 'vehicle', id: 7 },
      { kind: 'vehicle', id: 8 },
    ]);
  });

  it('affiche « non exposé » quand le taux de service manque', () => {
    const view = describeStationPanel(snapshot(), 0);
    const service = view?.stats.find((entry) => entry.label === 'Taux de service');
    expect(service?.value).toBe('Non exposé');
    expect(service?.tone).toBe('muted');
    expect(view?.hint).toMatch(/protocole v1/);
  });

  it('affiche le taux de service quand une version du snapshot le fournit', () => {
    const base = snapshot();
    const station = base.stations[0];
    if (!station) throw new Error('fixture sans gare');
    const withRate: StationSnapshot = { ...station, serviceRate: 64 } as StationSnapshot;
    const view = describeStationPanel({ ...base, stations: [withRate] }, 0);
    const service = view?.stats.find((entry) => entry.label === 'Taux de service');
    expect(service?.value).toBe('64 %');
    expect(view?.hint).not.toMatch(/protocole v1/);
  });

  it('gère une gare sans attente', () => {
    const view = describeStationPanel(snapshot(), 1);
    expect(view?.sections.find((section) => section.id === 'waiting')?.empty).toBe(
      'Aucune cargaison en attente.',
    );
    expect(statValue(view!, 'Attente')).toBe('0 unités');
    expect(describeStationPanel(snapshot(), 99)).toBeNull();
  });
});

describe('ouverture et fermeture', () => {
  it('associe chaque type de lieu à un panneau', () => {
    for (const [kind, id] of [
      ['town', 0],
      ['industry', 0],
      ['station', 0],
    ] as const) {
      const view = describePlacePanel(snapshot(), { kind, id });
      expect(view?.kind).toBe(kind);
    }
  });

  it('ne rend aucun panneau sans sélection ou pour une sélection de tuile', () => {
    expect(describePlacePanel(snapshot(), null)).toBeNull();
    expect(describePlacePanel(null, { kind: 'town', id: 0 })).toBeNull();
    expect(describePlacePanel(snapshot(), { kind: 'tile', id: 12 })).toBeNull();
    expect(isPlaceSelection({ kind: 'tile', id: 12 })).toBe(false);
    expect(isPlaceSelection({ kind: 'vehicle', id: 7 })).toBe(false);
    expect(isPlaceSelection(null)).toBe(false);
  });

  it('referme le panneau quand la sélection est effacée', () => {
    const selection = { kind: 'town', id: 0 } as const;
    expect(isPlaceSelection(selection)).toBe(true);
    expect(describePlacePanel(snapshot(), selection)).not.toBeNull();
    expect(isPlaceSelection(null)).toBe(false);
    expect(describePlacePanel(snapshot(), null)).toBeNull();
  });

  it('revalide les cibles listées avant de les ouvrir', () => {
    expect(placeTargetExists(snapshot(), { kind: 'station', id: 0 })).toBe(true);
    expect(placeTargetExists(snapshot(), { kind: 'industry', id: 0 })).toBe(true);
    expect(placeTargetExists(snapshot(), { kind: 'vehicle', id: 8 })).toBe(true);
    expect(placeTargetExists(snapshot(), { kind: 'station', id: 42 })).toBe(false);
    expect(placeTargetExists(null, { kind: 'industry', id: 0 })).toBe(false);
  });
});

describe('tuile industrie', () => {
  it('retrouve l’industrie sous une tuile de son emprise 3×3', () => {
    expect(industryAtTile(snapshot(), 5, 5)?.id).toBe(0);
    expect(industryAtTile(snapshot(), 6, 6)?.id).toBe(0);
    expect(industryAtTile(snapshot(), 8, 5)).toBeNull();
    expect(industryAtTile(null, 5, 5)).toBeNull();
  });
});

describe('i18n des panneaux lieu', () => {
  it('traduit les libellés, listes et explications en anglais', () => {
    setLanguage('en', { storage: null });
    const town = describeTownPanel(snapshot(), 0);
    expect(town?.sections[0]?.title).toBe('Nearby stations');
    expect(town?.actions[0]?.label).toBe('Show on map');
    expect(town?.actions[1]?.reason).toMatch(/protocol v1/);
    const industry = describeIndustryPanel(snapshot(), 0);
    expect(industry?.sections[1]?.title).toBe('Served stations');
    expect(industry?.actions[1]?.reason).toMatch(/industry subsidies/);
    const station = describeStationPanel(snapshot(), 0);
    expect(station?.stats.find((entry) => entry.label === 'Service rate')?.value).toBe(
      'Not exposed',
    );
    expect(station?.sections[0]?.items[0]?.label).toBe('Passengers');
  });
});

describe('accessibilité et absence d’appel moteur', () => {
  const panel = readFileSync(join(root, 'src/ui/hud/PlacePanel.ts'), 'utf8');
  const view = readFileSync(join(root, 'src/ui/placeView.ts'), 'utf8');
  const hud = readFileSync(join(root, 'src/ui/Hud.ts'), 'utf8');
  const session = readFileSync(join(root, 'src/ui/gameSession.ts'), 'utf8');
  const style = readFileSync(join(root, 'src/style.css'), 'utf8');

  it('expose une région nommée, un focus initial et un bouton de fermeture', () => {
    expect(panel).toContain("role: 'region'");
    expect(panel).toContain("'aria-labelledby': 'hud-place-title'");
    expect(panel).toContain('this.element.tabIndex = -1;');
    expect(panel).toContain("t('place.close')");
    expect(panel).toContain('disabled: !supported');
    expect(panel).toContain("attrs['aria-describedby']");
    expect(panel).toContain('hud-place-note');
  });

  it('n’ouvre qu’un panneau lieu à la fois', () => {
    expect(hud).toContain('const place = vehicle || depot ? null : (state.place ?? null);');
    expect(hud).toContain('vehicle !== null || depot !== null || place !== null');
  });

  it('ferme le panneau à Échap et restaure le focus sur le canvas', () => {
    expect(session).toContain('if (isPlaceSelection(this.game?.getSelection() ?? null))');
    expect(session).toContain("active.closest('.hud-place')");
  });

  it('n’émet aucune commande moteur pour les actions non supportées', () => {
    expect(view).not.toMatch(/issueCommand|EngineCommand|\.send\(/);
    expect(panel).not.toMatch(/issueCommand|EngineCommand|\.send\(/);
    expect(view).toMatch(/supported: false/);
    expect(panel).toContain('disabled: !supported');
  });

  it('ajoute les styles desktop et mobile du panneau', () => {
    expect(style).toContain('.hud-place {');
    expect(style).toContain('.hud-place-link');
    expect(style).toMatch(/@media \(max-width: 520px\) \{[\s\S]*?\.hud-place \{/);
  });
});
