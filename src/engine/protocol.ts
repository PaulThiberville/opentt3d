/**
 * Contrat d'interface entre le moteur OpenTTD compilé en WebAssembly et le
 * frontend Three.js. Ce fichier est la source de vérité du protocole v1 :
 * toute évolution doit être documentée dans le wiki (Architecture > Protocole).
 *
 * Unités : les positions du monde sont exprimées en tuiles (1 tuile = 16 px
 * OpenTTD), l'axe X va vers l'est, Y vers le sud, Z vers le haut.
 */

export const PROTOCOL_VERSION = 1;

export type CompanyId = number;
export const COMPANY_NONE: CompanyId = 255;

export type TileKind =
  | 'void'
  | 'clear'
  | 'grass'
  | 'rough'
  | 'water'
  | 'coast'
  | 'rail'
  | 'road'
  | 'house'
  | 'trees'
  | 'station'
  | 'industry'
  | 'bridge'
  | 'tunnel'
  | 'object'
  | 'airport'
  | 'dock'
  | 'canal'
  | 'river';

/** Index stable de TileKind, utilisé dans les tableaux binaires du snapshot. */
export const TILE_KIND_INDEX: Record<TileKind, number> = {
  void: 0,
  clear: 1,
  grass: 2,
  rough: 3,
  water: 4,
  coast: 5,
  rail: 6,
  road: 7,
  house: 8,
  trees: 9,
  station: 10,
  industry: 11,
  bridge: 12,
  tunnel: 13,
  object: 14,
  airport: 15,
  dock: 16,
  canal: 17,
  river: 18,
};

export const TILE_FLAG = {
  WATER: 1 << 0,
  SNOW: 1 << 1,
  DESERT: 1 << 2,
  RAINFOREST: 1 << 3,
  BRIDGE: 1 << 4,
  TUNNEL: 1 << 5,
  SIGNAL: 1 << 6,
  ELECTRIFIED: 1 << 7,
} as const;

/**
 * Carte brute. Les tableaux ont tous `width * height` entrées, indexés
 * `y * width + x`. `slope` reprend la sémantique OpenTTD (bits de coins).
 * Le snapshot complet n'est envoyé qu'au premier tick et lorsque la carte
 * change ; les updates suivants peuvent omettre `map`.
 */
export interface MapSnapshot {
  width: number;
  height: number;
  /** Uint8Array, valeurs = TILE_KIND_INDEX */
  kind: Uint8Array;
  /** Uint8Array, hauteur 0..15 (demi-niveaux OpenTTD) */
  height: Uint8Array;
  /** Uint8Array, entreprise propriétaire ou COMPANY_NONE */
  owner: Uint8Array;
  /** Uint8Array, pente OpenTTD (0 = plat) */
  slope: Uint8Array;
  /** Uint8Array, TILE_FLAG */
  flags: Uint8Array;
  /** Uint8Array, bits rail/road bruts (m8) pour le rendu des voies */
  trackBits: Uint8Array;
}

export type VehicleKind = 'train' | 'road' | 'ship' | 'aircraft';

export interface VehicleSnapshot {
  id: number;
  kind: VehicleKind;
  company: CompanyId;
  /** Position en tuiles (fractionnaire, pour l'interpolation). */
  x: number;
  y: number;
  z: number;
  /** Direction OpenTTD 0..255. */
  direction: number;
  /** Vitesse en tuiles par jour de jeu (approximation d'affichage). */
  speed: number;
  /** 0 = arrêté, 1 = en route, 2 = en gare, 3 = en dépôt, 4 = en attente. */
  status: number;
  cargo: { type: string; amount: number; capacity: number } | null;
  /** Identifiants de gares/industries de la tournée, dans l'ordre. */
  orderTargets: number[];
  profitLastYear: number;
  ageDays: number;
}

export interface StationSnapshot {
  id: number;
  company: CompanyId;
  name: string;
  kind: 'train' | 'road' | 'ship' | 'airport' | 'buoy';
  /** Centre en tuiles. */
  x: number;
  y: number;
  /** Emprise rectangulaire en tuiles. */
  width: number;
  height: number;
  waiting: { cargo: string; amount: number }[];
}

export interface TownSnapshot {
  id: number;
  name: string;
  x: number;
  y: number;
  population: number;
  growthRate: number;
  /** Nombre de bâtiments de la ville, pour le niveau de détail. */
  buildings: number;
  rating: number;
}

export interface IndustrySnapshot {
  id: number;
  name: string;
  /** Type OpenTTD (ex. 'coal_mine', 'power_station'). */
  kind: string;
  x: number;
  y: number;
  production: number;
  transported: number;
  stocks: { cargo: string; amount: number }[];
}

export interface CompanySnapshot {
  id: CompanyId;
  name: string;
  president: string;
  /** Couleur d'entreprise OpenTTD 0..15. */
  colour: number;
  money: number;
  loan: number;
  value: number;
  income: number;
  expenses: number;
  vehicles: number;
  stations: number;
  isAI: boolean;
  isLocal: boolean;
  bankrupt: boolean;
}

export interface EconomySnapshot {
  year: number;
  month: number;
  day: number;
  /** Fraction de jour 0..73 (TickCounter OpenTTD). */
  dayFraction: number;
  /** Multiplicateur de vitesse courant (1 = normal). */
  speed: number;
  paused: boolean;
}

export interface SnapshotMeta {
  protocol: number;
  tick: number;
  /** Hash déterministe de l'état, utilisé par le lockstep. */
  hash: string;
  /** Numéro de séquence du snapshot, strictement croissant. */
  sequence: number;
}

export interface WorldSnapshot {
  meta: SnapshotMeta;
  economy: EconomySnapshot;
  map: MapSnapshot | null;
  companies: CompanySnapshot[];
  towns: TownSnapshot[];
  industries: IndustrySnapshot[];
  stations: StationSnapshot[];
  vehicles: VehicleSnapshot[];
  /** Nouvelles du jeu, consommées par le HUD. */
  news: { tick: number; kind: 'info' | 'warning' | 'error' | 'company'; text: string }[];
  /** Événements ponctuels entre deux snapshots (départ, arrivée, panne…). */
  events: WorldEvent[];
}

export type WorldEvent =
  | { type: 'vehicle_arrived'; vehicle: number; station: number; tick: number }
  | { type: 'vehicle_departed'; vehicle: number; station: number; tick: number }
  | { type: 'company_bankrupt'; company: CompanyId; tick: number }
  | { type: 'town_growth'; town: number; population: number; tick: number }
  | { type: 'industry_production'; industry: number; amount: number; tick: number };

export interface EngineInitOptions {
  /** URL du module WASM ou chemin local. */
  moduleUrl: string;
  /** Mémoire initiale en MiB. */
  memoryMiB?: number;
  /** Active les logs de debug du pont C++. */
  debug?: boolean;
}

export interface NewGameOptions {
  seed: number;
  width: number;
  height: number;
  /** Nombre d'entreprises IA (0 = bac à sable). */
  aiCompanies?: number;
  /** Difficulté 0..3. */
  difficulty?: number;
  /** Année de départ. */
  startYear?: number;
  /** Climat : temperate, subarctic, subtropical, toyland. */
  climate?: 'temperate' | 'subarctic' | 'subtropical' | 'toyland';
}

/**
 * Commandes envoyées au moteur. En lockstep, elles sont horodatées par l'hôte
 * et rejouées au même tick sur tous les pairs : une commande doit donc être
 * entièrement déterministe et ne jamais dépendre de l'heure locale.
 */
export type EngineCommand =
  | { type: 'pause'; paused: boolean }
  | { type: 'speed'; speed: 0 | 1 | 2 }
  | { type: 'console'; command: string }
  | {
      type: 'build';
      tool:
        | 'road'
        | 'rail'
        | 'station'
        | 'depot'
        | 'signal'
        | 'bridge'
        | 'tunnel'
        | 'clear';
      company: CompanyId;
      /** Points en coordonnées tuiles, arrondis par le pont. */
      from: { x: number; y: number };
      to?: { x: number; y: number };
      /** Paramètres spécifiques à l'outil (orientation, type de gare…). */
      options?: Record<string, number | string | boolean>;
    }
  | {
      type: 'vehicle';
      action: 'buy' | 'sell' | 'refit' | 'order' | 'start' | 'stop';
      company: CompanyId;
      vehicle?: number;
      depot?: { x: number; y: number };
      model?: string;
      orders?: { target: number; kind: 'station' | 'industry' | 'depot' }[];
    };

export interface EngineStatus {
  ready: boolean;
  loading: boolean;
  progress: number;
  tick: number;
  paused: boolean;
  speed: number;
  lastError: string | null;
}

/**
 * Façade utilisée par le jeu. Deux implémentations : le pont WASM réel et un
 * moteur simulé (mock) pour le développement frontend et les tests réseau.
 */
export interface EngineDriver {
  init(options: EngineInitOptions): Promise<void>;
  newGame(options: NewGameOptions): Promise<void>;
  /** Avance la simulation et renvoie le nombre de ticks réellement exécutés. */
  step(ticks: number): number;
  /** Snapshot complet ou delta selon l'implémentation (voir `map: null`). */
  snapshot(): WorldSnapshot;
  send(command: EngineCommand): void;
  hash(): string;
  save(): Promise<Uint8Array>;
  load(data: Uint8Array): Promise<void>;
  status(): EngineStatus;
  dispose(): void;
}
