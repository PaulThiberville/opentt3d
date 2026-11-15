import { describe, expect, it } from 'vitest';
import type { EngineCommand, VehicleSnapshot, WorldSnapshot } from '../src/engine/protocol';
import { AudioDirector, type AudioSink } from '../src/audio/director';
import type { AmbienceEnvironment } from '../src/audio/mapping';
import type { ListenerState, PlayOptions } from '../src/audio/AudioEngine';
import type { SoundId } from '../src/audio/soundIds';

interface Played {
  id: SoundId;
  options: PlayOptions;
  position?: { x: number; z: number };
}

class FakeSink implements AudioSink {
  played: Played[] = [];
  ambience: AmbienceEnvironment[] = [];
  updates = 0;

  play(id: SoundId, options: PlayOptions = {}): boolean {
    this.played.push({ id, options });
    return true;
  }

  playAt(
    id: SoundId,
    position: { x: number; z: number },
    _listener: ListenerState,
    options: PlayOptions = {},
  ): boolean {
    this.played.push({ id, options, position });
    return true;
  }

  setAmbience(environment: AmbienceEnvironment): void {
    this.ambience.push(environment);
  }

  update(): void {
    this.updates += 1;
  }
}

function vehicle(patch: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: 7,
    kind: 'train',
    company: 0,
    x: 2,
    y: 0,
    z: 0,
    direction: 0,
    speed: 20,
    status: 1,
    cargo: null,
    orderTargets: [],
    profitLastYear: 0,
    ageDays: 0,
    ...patch,
  };
}

function snapshot(vehicles: VehicleSnapshot[]): WorldSnapshot {
  return {
    meta: { protocol: 1, tick: 0, hash: 'h', sequence: 0 },
    economy: { year: 1950, month: 0, day: 1, dayFraction: 15, speed: 1, paused: false },
    map: null,
    companies: [],
    towns: [],
    industries: [],
    stations: [],
    depots: [],
    vehicles,
    news: [],
    events: [],
  };
}

const listener: ListenerState = { x: 0, z: 0, yaw: 0 };
const buy: EngineCommand = { type: 'vehicle', action: 'buy', company: 0, depotId: 1 };

describe('AudioDirector', () => {
  it('joue la commande locale et filtre les commandes muettes', () => {
    const sink = new FakeSink();
    const director = new AudioDirector(sink);
    expect(director.handleCommand(buy)).toBe('vehicle.buy');
    expect(director.handleCommand({ type: 'pause', paused: true })).toBeNull();
    expect(sink.played.map((entry) => entry.id)).toEqual(['vehicle.buy']);
  });

  it('filtre les notifications informatives', () => {
    const sink = new FakeSink();
    const director = new AudioDirector(sink);
    expect(director.handleNotification('info', 'Monde généré')).toBeNull();
    expect(director.handleNotification('warning', 'Voie occupée')).toBe('alert');
    expect(director.handleNotification('info', 'Revenu : 2 000 £')).toBe('money.in');
    expect(sink.played).toHaveLength(2);
  });

  it('déclenche un passage de train proche avec volume et pan', () => {
    let now = 1000;
    const sink = new FakeSink();
    const director = new AudioDirector(sink, 'medium', { now: () => now });
    director.ingestSnapshot(snapshot([vehicle()]), null, listener);
    expect(sink.played).toHaveLength(1);
    expect(sink.played[0]?.id).toBe('train.pass');
    expect(sink.played[0]?.options.gain).toBeGreaterThan(0);
    expect(sink.played[0]?.options.pan).toBeGreaterThan(0);
    expect(sink.ambience.at(-1)?.quality).toBe('medium');

    now += 3000;
    director.ingestSnapshot(snapshot([vehicle()]), null, listener);
    expect(sink.played).toHaveLength(1);
  });

  it('ignore les véhicules arrêtés, lointains ou silencieux', () => {
    const sink = new FakeSink();
    const director = new AudioDirector(sink, 'medium', { now: () => 1000 });
    director.ingestSnapshot(
      snapshot([
        vehicle({ id: 1, status: 0 }),
        vehicle({ id: 2, x: 80 }),
        vehicle({ id: 3, kind: 'ship' }),
        vehicle({ id: 4, speed: 0 }),
      ]),
      null,
      listener,
    );
    expect(sink.played).toHaveLength(0);
  });

  it('délègue l’ambiance et la mise à jour du moteur', () => {
    const sink = new FakeSink();
    const director = new AudioDirector(sink, 'low');
    director.ingestSnapshot(snapshot([]), null, { x: 4, z: 6, yaw: 1 }, 'low');
    expect(sink.ambience.at(-1)).toMatchObject({ quality: 'low' });
    director.frame(0.016);
    expect(sink.updates).toBe(1);
  });
});
