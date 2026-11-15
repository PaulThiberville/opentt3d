import { describe, expect, it } from 'vitest';
import {
  COMPANY_NONE,
  PROTOCOL_VERSION,
  TILE_FLAG,
  TILE_KIND_INDEX,
  type CompanySnapshot,
  type MapSnapshot,
  type WorldSnapshot,
} from '../src/engine/protocol';

function emptyMap(width: number, height: number): MapSnapshot {
  const size = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(size),
    heightMap: new Uint8Array(size),
    owner: new Uint8Array(size).fill(COMPANY_NONE),
    slope: new Uint8Array(size),
    flags: new Uint8Array(size),
    trackBits: new Uint8Array(size),
  };
}

function company(id: number): CompanySnapshot {
  return {
    id,
    name: `Entreprise ${id}`,
    president: 'Paul',
    colour: id,
    money: 100_000,
    loan: 0,
    value: 250_000,
    income: 0,
    expenses: 0,
    vehicles: 0,
    stations: 0,
    isAI: id !== 0,
    isLocal: id === 0,
    bankrupt: false,
  };
}

function emptySnapshot(): WorldSnapshot {
  return {
    meta: { protocol: PROTOCOL_VERSION, tick: 0, hash: '0', sequence: 0 },
    economy: { year: 1950, month: 0, day: 1, dayFraction: 0, speed: 1, paused: false },
    map: emptyMap(4, 4),
    companies: [company(0)],
    towns: [],
    industries: [],
    stations: [],
    depots: [],
    vehicles: [],
    news: [],
    events: [],
  };
}

describe('protocole moteur v1', () => {
  it('expose une version stable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('associe un index unique et contigu à chaque type de tuile', () => {
    const indexes = Object.values(TILE_KIND_INDEX);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes.map((_, i) => i));
  });

  it('définit des drapeaux de tuile sur des bits distincts', () => {
    const flags = Object.values(TILE_FLAG);
    expect(new Set(flags).size).toBe(flags.length);
    for (const flag of flags) {
      expect(flag & (flag - 1)).toBe(0);
    }
  });

  it('construit un snapshot vide conforme', () => {
    const snapshot = emptySnapshot();
    const map = snapshot.map;
    expect(map).not.toBeNull();
    expect(map?.kind).toHaveLength(4 * 4);
    expect(map?.owner.every((owner) => owner === COMPANY_NONE)).toBe(true);
    expect(snapshot.meta.protocol).toBe(1);
    expect(snapshot.companies[0]?.isLocal).toBe(true);
  });
});
