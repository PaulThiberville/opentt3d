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
  | 'river'
  | 'lock'
  | 'aqueduct'
  | 'crossing';

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
  lock: 19,
  aqueduct: 20,
  crossing: 21,
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
 * Bit de `trackBits` réservé aux passages à niveau : il mémorise le réseau
 * d'origine (0 = route, 1 = rail). Les quatre bits bas restent l'axe de la
 * voie, comme pour les autres tuiles du mock.
 */
export const TRACK_BIT_CROSSING_RAIL = 1 << 4;

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
  heightMap: Uint8Array;
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

/** Type d'une cible de tournée (gare, industrie ou dépôt). */
export type OrderTargetKind = 'station' | 'industry' | 'depot';

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
  /** Identifiants de gares/industries/dépôts de la tournée, dans l'ordre. */
  orderTargets: number[];
  /**
   * Type de chaque cible de `orderTargets` (même index). Optionnel : le pont
   * v1 n'expose que des cibles de gare dans `orderTargets`, l'UI retombe alors
   * sur une inférence. Le mock le fournit pour lever toute ambiguïté entre
   * pools d'identifiants.
   */
  orderKinds?: OrderTargetKind[];
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

export type DepotKind = 'road' | 'rail';

/**
 * Dépôt route ou rail. `id` est l'index du pool OpenTTD : il reste stable tant
 * que le dépôt existe et sert directement de cible aux commandes véhicule
 * (`depotId`, `orders[].target`). Les dépôts maritimes et hangars ne sont pas
 * exposés en v1.
 */
export interface DepotSnapshot {
  id: number;
  company: CompanyId;
  kind: DepotKind;
  /** Tuile entière du dépôt (coin nord-ouest de l'emprise). */
  x: number;
  y: number;
  /** Direction d'entrée 0..3 (DiagDirection : 0 = NE, 1 = SE, 2 = SW, 3 = NW). */
  direction: number;
  /** Emprise en tuiles ; 1×1 en v1. */
  width: number;
  height: number;
}

/** Action municipale proposée par l'autorité locale (#166). */
export type TownActionKind = 'advertise' | 'fund_roads' | 'fund_buildings';

/**
 * Disponibilité et coût d'une action municipale. Le coût est déjà indexé sur
 * l'inflation par le moteur : l'UI l'affiche tel quel et ne le recalcule pas.
 */
export interface TownActionSnapshot {
  available: boolean;
  cost: number;
}

/** Autorité locale d'une ville pour l'entreprise locale (#166). */
export interface TownAuthoritySnapshot {
  /**
   * Échelle moteur : mock 0..100, pont OpenTTD 0..1000. L'UI normalise toute
   * comparaison via `normalizeRating` et n'affiche jamais la valeur brute.
   */
  rating: number;
  actions: Record<TownActionKind, TownActionSnapshot>;
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
  /** Absent des snapshots antérieurs à #166 : l'UI retombe sur `rating`. */
  authority?: TownAuthoritySnapshot;
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
  /** Cargaisons acceptées par l'industrie (chaînes de production, #167). */
  accepts?: string[];
  /** Taux de service 0..100 (transporté / production), exposé depuis #167. */
  serviceRate?: number;
}

/**
 * Subvention proposée ou attribuée (#166/#167).
 *
 * Une offre est attribuée automatiquement au premier transporteur qui relie
 * la source à la destination avec la cargaison concernée : il n'existe pas de
 * commande « accepter » dans OpenTTD, l'UI explique cette règle.
 */
export interface SubsidySnapshot {
  id: number;
  cargo: string;
  from: string;
  to: string;
  fromKind: 'town' | 'industry';
  toKind: 'town' | 'industry';
  /** Mois restants avant expiration de l'offre ou de la subvention. */
  remainingMonths: number;
  /** Entreprise bénéficiaire, ou `null` tant que l'offre n'est pas attribuée. */
  awardedTo: CompanyId | null;
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
  /** Plafond de prêt courant (#165), absent des snapshots antérieurs. */
  maxLoan?: number;
  /** Mois consécutifs de trésorerie négative ; 0 = entreprise saine. */
  monthsOfBankruptcy?: number;
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
  /** Inflation cumulée en pourcentage depuis le début de partie (#165). */
  inflation?: number;
  /** Difficulté 0..3 lue par le moteur (#165). */
  difficulty?: number;
  /** Taux d'intérêt annuel des prêts, en pourcentage (#165). */
  interestRate?: number;
  /** Plafond de prêt global avant application par entreprise (#165). */
  maxLoan?: number;
  /** Pas minimal de remboursement/emprunt (#165). */
  loanInterval?: number;
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
  /** Dépôts route/rail, ids de pool stables (voir `DepotSnapshot`). */
  depots: DepotSnapshot[];
  vehicles: VehicleSnapshot[];
  /** Subventions proposées et attribuées (#166/#167). */
  subsidies?: SubsidySnapshot[];
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
  | { type: 'industry_production'; industry: number; amount: number; tick: number }
  | { type: 'loan_changed'; company: CompanyId; loan: number; tick: number }
  | { type: 'subsidy_awarded'; subsidy: number; company: CompanyId; tick: number }
  | { type: 'subsidy_expired'; subsidy: number; tick: number }
  | { type: 'town_action'; town: number; action: TownActionKind; tick: number };

export interface EngineInitOptions {
  /** URL du module WASM ou chemin local. */
  moduleUrl: string;
  /**
   * Mémoire initiale demandée en MiB. Le module Emscripten actuel fige sa
   * mémoire à la compilation (32 Mio) : la valeur est donc traitée comme une
   * exigence, pas comme un redimensionnement à chaud. Le loader avertit si le
   * module est plus petit que demandé.
   */
  memoryMiB?: number;
  /** Active les logs de debug du pont C++. */
  debug?: boolean;
  /** Progression du chargement, de 0 à 1 (facultatif). */
  onProgress?: (progress: number, message: string) => void;
  /**
   * Avertissements non bloquants : options de partie ignorées par le pont,
   * commandes indisponibles, mémoire insuffisante… (facultatif).
   */
  onWarning?: (message: string) => void;
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
  /**
   * Entreprises humaines à créer au démarrage (#99), dans l'ordre des ids
   * 0..n-1. Absent : une seule entreprise locale (comportement solo). En
   * réseau, la liste vient du `StartInfo` et est identique sur tous les pairs.
   */
  companies?: CompanyProfile[];
}

/** Profil d'une entreprise humaine créée au démarrage (#99). */
export interface CompanyProfile {
  name: string;
  /** Couleur OpenTTD 0..15. */
  colour: number;
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
        | 'clear'
        | 'terraform'
        | 'tree'
        | 'canal'
        | 'lock'
        | 'aqueduct'
        | 'crossing';
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
      /** Dépôt d'achat par identifiant stable de `depots[]` (prioritaire). */
      depotId?: number;
      /** Compatibilité : tuile du dépôt quand le client n'a pas d'id. */
      depot?: { x: number; y: number };
      model?: string;
      /**
       * Tournée complète. `target` est un id de gare, d'industrie ou de dépôt
       * (`depots[].id` pour `kind: 'depot'`).
       */
      orders?: { target: number; kind: OrderTargetKind }[];
    }
  | {
      /** Prêts bancaires (#165). `amount` absent = un pas de prêt. */
      type: 'finance';
      action: 'increase_loan' | 'decrease_loan';
      company: CompanyId;
      amount?: number;
    }
  | {
      /** Actions de l'autorité locale (#166). */
      type: 'town_action';
      action: TownActionKind;
      company: CompanyId;
      town: number;
    };

export interface EngineStatus {
  ready: boolean;
  loading: boolean;
  progress: number;
  tick: number;
  paused: boolean;
  speed: number;
  lastError: string | null;
  /**
   * Avertissements cumulés depuis le dernier `newGame` : options de partie non
   * appliquées, commandes ignorées, mémoire demandée indisponible. Les
   * implémentations qui n'en produisent pas peuvent omettre ce champ.
   */
  warnings?: string[];
}

/**
 * Façade utilisée par le jeu. Deux implémentations : le pont WASM réel et un
 * moteur simulé (mock) pour le développement frontend et les tests réseau.
 */
export interface EngineDriver {
  init(options: EngineInitOptions): Promise<void>;
  newGame(options: NewGameOptions): Promise<void>;
  /**
   * Indique l'entreprise contrôlée par ce module (#99) : le snapshot la marque
   * `isLocal` et les commandes sans `company` la ciblent. Retourne faux si
   * l'entreprise n'existe pas (ou est contrôlée par une IA). Chaque pair réseau
   * choisit la sienne : l'état simulé et le hash ne changent pas.
   */
  setLocalCompany?(company: CompanyId): boolean;
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
