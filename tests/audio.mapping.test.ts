import { describe, expect, it } from 'vitest';
import type { MapSnapshot, VehicleSnapshot, WorldSnapshot } from '../src/engine/protocol';
import { TILE_KIND_INDEX } from '../src/engine/protocol';
import {
  ambienceFromSnapshot,
  gainForDistance,
  panForOffset,
  passSoundForKind,
  soundForCommand,
  soundForNotification,
  waterRatio,
} from '../src/audio/mapping';
import { SoundThrottle } from '../src/audio/throttle';
import {
  AUDIO_PREFERENCES_KEY,
  DEFAULT_AUDIO_PREFERENCES,
  loadAudioPreferences,
  saveAudioPreferences,
  type AudioStorageLike,
} from '../src/audio/preferences';

function emptyMap(width = 5, height = 5): MapSnapshot {
  return {
    width,
    height,
    kind: new Uint8Array(width * height).fill(TILE_KIND_INDEX.grass),
    heightMap: new Uint8Array(width * height),
    owner: new Uint8Array(width * height),
    slope: new Uint8Array(width * height),
    flags: new Uint8Array(width * height),
    trackBits: new Uint8Array(width * height),
  };
}

function vehicle(patch: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: 1,
    kind: 'train',
    company: 0,
    x: 0,
    y: 0,
    z: 0,
    direction: 0,
    speed: 10,
    status: 1,
    cargo: null,
    orderTargets: [],
    profitLastYear: 0,
    ageDays: 0,
    ...patch,
  };
}

function snapshot(patch: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    meta: { protocol: 1, tick: 0, hash: 'h', sequence: 0 },
    economy: { year: 1950, month: 0, day: 1, dayFraction: 0, speed: 1, paused: false },
    map: null,
    companies: [],
    towns: [],
    industries: [],
    stations: [],
    depots: [],
    vehicles: [vehicle()],
    news: [],
    events: [],
    ...patch,
  };
}

describe('mapping événement → son', () => {
  it('associe les outils de construction', () => {
    const tool = (name: 'road' | 'rail' | 'station' | 'depot' | 'clear' | 'signal') => ({
      type: 'build' as const,
      tool: name,
      company: 0,
      from: { x: 0, y: 0 },
    });
    expect(soundForCommand(tool('road'))).toBe('build.road');
    expect(soundForCommand(tool('rail'))).toBe('build.rail');
    expect(soundForCommand(tool('signal'))).toBe('build.rail');
    expect(soundForCommand(tool('station'))).toBe('build.station');
    expect(soundForCommand(tool('depot'))).toBe('build.depot');
    expect(soundForCommand(tool('clear'))).toBe('build.clear');
    expect(soundForCommand({ type: 'pause', paused: true })).toBeNull();
  });

  it('associe les actions véhicule', () => {
    const action = (name: 'buy' | 'sell' | 'start' | 'stop' | 'order') => ({
      type: 'vehicle' as const,
      action: name,
      company: 0,
    });
    expect(soundForCommand(action('buy'))).toBe('vehicle.buy');
    expect(soundForCommand(action('sell'))).toBe('vehicle.sell');
    expect(soundForCommand(action('start'))).toBe('vehicle.start');
    expect(soundForCommand(action('stop'))).toBe('vehicle.stop');
    expect(soundForCommand(action('order'))).toBe('ui.click');
  });

  it('ne sonorise que les notifications utiles', () => {
    expect(soundForNotification('error', 'boum')).toBe('ui.error');
    expect(soundForNotification('warning', 'gare occupée')).toBe('alert');
    expect(soundForNotification('company', 'Nouvelle entreprise')).toBe('ui.notify');
    expect(soundForNotification('info', 'Monde 256×256 généré en 120 ms.')).toBeNull();
    expect(soundForNotification('info', 'Revenu : 12 400 £')).toBe('money.in');
    expect(soundForNotification('info', 'Coût des travaux : 4 200 £')).toBe('money.out');
  });

  it('choisit un son de passage par type de véhicule', () => {
    expect(passSoundForKind('train')).toBe('train.pass');
    expect(passSoundForKind('road')).toBe('bus.pass');
    expect(passSoundForKind('ship')).toBeNull();
    expect(passSoundForKind('aircraft')).toBeNull();
  });
});

describe('throttle', () => {
  it('laisse passer une fois par fenêtre', () => {
    const throttle = new SoundThrottle({ 'ui.hover': 90 });
    expect(throttle.allow('ui.hover', 1000)).toBe(true);
    expect(throttle.allow('ui.hover', 1050)).toBe(false);
    expect(throttle.allow('ui.hover', 1091)).toBe(true);
    throttle.reset();
    expect(throttle.allow('ui.hover', 1092)).toBe(true);
  });
});

describe('spatialisation et ambiance', () => {
  it('atténue avec la distance et borne le panoramique', () => {
    expect(gainForDistance(0, 20)).toBe(1);
    expect(gainForDistance(20, 20)).toBe(0);
    expect(gainForDistance(10, 20)).toBeCloseTo(0.25);
    expect(panForOffset(10, 0, 0)).toBeCloseTo(10 / 16);
    expect(panForOffset(100, 0, 0)).toBe(1);
    expect(panForOffset(-100, 0, 0)).toBe(-1);
  });

  it('mesure l’eau autour de la caméra', () => {
    const map = emptyMap();
    expect(waterRatio(map, 2, 2, 2)).toBe(0);
    map.kind[2 * 5 + 2] = TILE_KIND_INDEX.water;
    expect(waterRatio(map, 2, 2, 1)).toBeGreaterThan(0);
    expect(waterRatio(null, 2, 2)).toBe(0);
  });

  it('déduit la nuit et le jour du snapshot', () => {
    const night = ambienceFromSnapshot(
      snapshot({
        economy: { year: 1950, month: 0, day: 1, dayFraction: 52, speed: 1, paused: false },
      }),
      null,
      { x: 0, z: 0 },
      'medium',
    );
    expect(night.night).toBeGreaterThan(0.5);
    const day = ambienceFromSnapshot(
      snapshot({
        economy: { year: 1950, month: 0, day: 1, dayFraction: 15, speed: 1, paused: false },
      }),
      null,
      { x: 0, z: 0 },
      'high',
    );
    expect(day.daylight).toBeGreaterThan(0.5);
    expect(day.quality).toBe('high');
  });
});

class MemoryStorage implements AudioStorageLike {
  readonly data = new Map<string, string>();
  fail = false;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.fail) throw new Error('quota');
    this.data.set(key, value);
  }
}

describe('préférences audio', () => {
  it('charge les défauts sans stockage', () => {
    expect(loadAudioPreferences(null)).toEqual(DEFAULT_AUDIO_PREFERENCES);
    expect(loadAudioPreferences(new MemoryStorage())).toEqual(DEFAULT_AUDIO_PREFERENCES);
  });

  it('persiste le mute', () => {
    const storage = new MemoryStorage();
    expect(saveAudioPreferences(storage, { muted: true })).toBe(true);
    expect(storage.getItem(AUDIO_PREFERENCES_KEY)).toBe('{"muted":true}');
    expect(loadAudioPreferences(storage)).toEqual({ muted: true });
  });

  it('ignore un JSON corrompu ou un champ invalide', () => {
    const storage = new MemoryStorage();
    storage.data.set(AUDIO_PREFERENCES_KEY, '{oops');
    expect(loadAudioPreferences(storage)).toEqual(DEFAULT_AUDIO_PREFERENCES);
    storage.data.set(AUDIO_PREFERENCES_KEY, '{"muted":"yes"}');
    expect(loadAudioPreferences(storage)).toEqual(DEFAULT_AUDIO_PREFERENCES);
  });

  it('signale un échec d’écriture', () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    expect(saveAudioPreferences(storage, { muted: true })).toBe(false);
  });
});
