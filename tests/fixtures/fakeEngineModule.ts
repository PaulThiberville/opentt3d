/**
 * Faux module Emscripten pour tester `WasmEngine` sans WebAssembly.
 *
 * Reproduit le contrat minimal du pont (engine/bridge/ottd_bridge.cpp) et le
 * format binaire du snapshot carte, y compris les cas d'erreur (tick
 * désynchronisé, capacité insuffisante, absence de partie).
 */

import { PROTOCOL_VERSION } from '../../src/engine/protocol';
import type { EmscriptenModule } from '../../src/engine/loadEngine';
import { buildMapFixture, layerOffset } from './mapBinaryFixture';

export interface FakeEngineState {
  booted: boolean;
  inGame: boolean;
  width: number;
  height: number;
  tick: number;
  seed: number;
  /** Décalage injecté entre le tick JSON et le tick de la carte. */
  mapTickOffset: number;
  /** Suraddition appliquée au hash quand le tick change (déterminisme simulé). */
  hash: bigint;
  json: Record<string, unknown>;
  stepCalls: number[];
  shutdownCalls: number;
  mapSequence: number;
  jsonSequence: number;
}

export class FakeEngineModule implements EmscriptenModule {
  HEAPU8: Uint8Array;
  readonly state: FakeEngineState;

  private heapTop = 16;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(heapBytes = 1 << 20) {
    this.HEAPU8 = new Uint8Array(heapBytes);
    this.state = {
      booted: false,
      inGame: false,
      width: 0,
      height: 0,
      tick: 0,
      seed: 0,
      mapTickOffset: 0,
      hash: 0n,
      json: this.emptyJson(),
      stepCalls: [],
      shutdownCalls: 0,
      mapSequence: 0,
      jsonSequence: 0,
    };
  }

  /** Accès typé au faux module pour la fabrique Emscripten. */
  asModule(): EmscriptenModule {
    return this as unknown as EmscriptenModule;
  }

  /** Injecte le JSON renvoyé par `ottd_snapshot_json`. */
  setJson(json: Record<string, unknown>): void {
    this.state.json = json;
  }

  /* --- Contrat Emscripten ------------------------------------------------- */

  _malloc(size: number): number {
    const pointer = Math.ceil(this.heapTop / 8) * 8;
    this.heapTop = pointer + size + 8;
    if (this.heapTop >= this.HEAPU8.byteLength) {
      throw new Error('FakeEngineModule : heap épuisé');
    }
    return pointer;
  }

  _free(_pointer: number): void {
    // Pas de réutilisation : suffisant pour la durée d'un test.
    void _pointer;
  }

  UTF8ToString(pointer: number): string {
    let end = pointer;
    while (end < this.HEAPU8.byteLength && this.HEAPU8[end] !== 0) end += 1;
    return this.decoder.decode(this.HEAPU8.subarray(pointer, end));
  }

  ccall(name: string, _returnType: string | null, _argTypes: string[], args: unknown[]): unknown {
    void _returnType;
    void _argTypes;
    const fn = (this as unknown as Record<string, unknown>)[name];
    if (typeof fn !== 'function') throw new Error(`FakeEngineModule : ${name} inconnu`);
    return (fn as (...values: unknown[]) => unknown).apply(this, args);
  }

  cwrap(
    name: string,
    _returnType: string | null,
    _argTypes: string[],
  ): (...args: number[]) => number {
    void _returnType;
    void _argTypes;
    const fn = (this as unknown as Record<string, (...args: number[]) => number>)[name];
    if (typeof fn !== 'function') throw new Error(`FakeEngineModule : ${name} inconnu`);
    return fn.bind(this);
  }

  /* --- Pont OpenTT3D ------------------------------------------------------ */

  _ottd_boot(): number {
    if (this.state.booted) return 0;
    this.state.booted = true;
    return 0;
  }

  _ottd_new_game(seed: number, width: number, height: number): number {
    if (!this.state.booted) return 1;
    this.state.inGame = true;
    this.state.seed = seed;
    this.state.width = width;
    this.state.height = height;
    this.state.tick = 0;
    this.state.mapSequence = 0;
    this.state.jsonSequence = 0;
    this.state.json = this.worldJson();
    return 0;
  }

  _ottd_step(ticks: number): number {
    this.state.stepCalls.push(ticks);
    if (!this.state.inGame) return 0;
    this.state.tick += ticks;
    this.state.hash = BigInt(this.state.tick) * 0x9e3779b97f4a7c15n;
    this.state.json = this.worldJson();
    return ticks;
  }

  _ottd_tick(): number {
    return this.state.tick;
  }

  _ottd_hash(): bigint {
    return BigInt.asUintN(64, this.state.hash);
  }

  _ottd_snapshot_json(out: number, capacity: number): number {
    if (!this.state.inGame) return 0;
    const bytes = this.encoder.encode(JSON.stringify(this.state.json));
    const required = bytes.byteLength + 1;
    if (out === 0 || capacity < required) return required;
    this.HEAPU8.set(bytes, out);
    this.HEAPU8[out + bytes.byteLength] = 0;
    this.state.jsonSequence += 1;
    return required;
  }

  _ottd_snapshot_map(out: number, capacity: number): number {
    if (!this.state.inGame) return -1;
    const fixture = this.mapFixture();
    if (out === 0 || capacity < fixture.byteLength) return fixture.byteLength;
    this.HEAPU8.set(fixture, out);
    this.state.mapSequence += 1;
    return fixture.byteLength;
  }

  _ottd_last_error(): number {
    // Octet 0 du heap : chaîne vide.
    return 0;
  }

  _ottd_shutdown(): void {
    this.state.shutdownCalls += 1;
    this.state.inGame = false;
    this.state.booted = false;
  }

  /* --- Fabriques de données ------------------------------------------------- */

  /** Buffer carte correspondant à l'état courant (tick décalable). */
  mapFixture(): Uint8Array {
    return buildMapFixture({
      width: this.state.width,
      height: this.state.height,
      tick: this.state.tick + this.state.mapTickOffset,
      sequence: this.state.mapSequence + 1,
    });
  }

  /** Écrit un motif reconnaissable dans une couche du buffer carte factice. */
  static paintLayer(
    bytes: Uint8Array,
    name: Parameters<typeof layerOffset>[0],
    value: number,
  ): void {
    const width = new DataView(bytes.buffer).getUint32(8, true);
    const height = new DataView(bytes.buffer).getUint32(12, true);
    const offset = layerOffset(name, width, height);
    bytes.fill(value, offset, offset + width * height);
  }

  private emptyJson(): Record<string, unknown> {
    return {
      meta: { protocol: PROTOCOL_VERSION, tick: 0, hash: '0x0000000000000000', sequence: 0 },
      economy: null,
      map: null,
      companies: [],
      towns: [],
      industries: [],
      stations: [],
      vehicles: [],
      news: [],
      events: [],
    };
  }

  /** JSON minimal et stable, calqué sur la sortie réelle du pont. */
  private worldJson(): Record<string, unknown> {
    const { width, height, tick } = this.state;
    return {
      meta: {
        protocol: PROTOCOL_VERSION,
        tick,
        hash: `0x${BigInt.asUintN(64, this.state.hash).toString(16).padStart(16, '0')}`,
        sequence: this.state.jsonSequence + 1,
      },
      economy: {
        year: 1950,
        month: 0,
        day: 1,
        dayFraction: tick % 74,
        speed: 1,
        paused: false,
      },
      map: { width, height, encoding: 'binary', layers: 6, elementSize: 1 },
      counts: { companies: 1, towns: 1, industries: 1, stations: 0, vehicles: 1 },
      companies: [
        {
          id: 0,
          name: 'OpenTT3D Transport',
          president: 'Paul',
          colour: 8,
          money: 200_000,
          loan: 0,
          value: 200_000,
          income: 0,
          expenses: 0,
          vehicles: 1,
          stations: 0,
          isAI: false,
          isLocal: true,
          bankrupt: false,
        },
      ],
      towns: [
        {
          id: 0,
          name: 'Bois-le-Duc',
          x: 12,
          y: 18,
          population: 320,
          growthRate: 3,
          buildings: 24,
          rating: 500,
        },
      ],
      industries: [
        {
          id: 0,
          name: 'Scierie',
          kind: 'Scierie',
          x: 30.5,
          y: 40.5,
          production: 90,
          transported: 10,
          stocks: [{ cargo: 'Bois', amount: 25, rate: 2 }],
        },
      ],
      stations: [],
      vehicles: [
        {
          id: 7,
          kind: 'train',
          company: 0,
          x: 10.25,
          y: 20.5,
          z: 1,
          direction: 64,
          speed: 12.5,
          status: 1,
          cargo: { type: 'Passagers', amount: 30, capacity: 60 },
          orderTargets: [0],
          profitLastYear: 1000,
          ageDays: 5,
        },
      ],
      news: [],
      events: [],
    };
  }
}
