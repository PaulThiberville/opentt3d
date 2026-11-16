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

/**
 * Type de voie ferrée (#157). L'index est stable dans le snapshot et reprend
 * l'ordre des types de base d'OpenTTD : rail, électrifié, monorail, maglev.
 */
export type RailType = 'rail' | 'electrified' | 'monorail' | 'maglev';

export const RAIL_TYPE_INDEX: Record<RailType, number> = {
  rail: 0,
  electrified: 1,
  monorail: 2,
  maglev: 3,
};

export const RAIL_TYPES: readonly RailType[] = ['rail', 'electrified', 'monorail', 'maglev'];

/** Type de signal avancé (#156). `path` correspond au signal PBS d'OpenTTD. */
export type SignalKind = 'block' | 'path' | 'entry' | 'exit' | 'combo';

/** Sens d'un signal : unique ou bidirectionnel. */
export type SignalDirection = 'one-way' | 'both';

/** État lumineux d'un signal. `yellow` n'est pas émis par le pont OpenTTD. */
export type SignalAspect = 'green' | 'red' | 'yellow';

/** Voie choisie quand une tuile porte plusieurs voies (signal). */
export type SignalTrack = 'x' | 'y' | 'upper' | 'lower' | 'left' | 'right';

/** Signal exposé par le snapshot, dérivé des bits de la carte (#156). */
export interface SignalSnapshot {
  /** Tuile entière. */
  x: number;
  y: number;
  kind: SignalKind;
  direction: SignalDirection;
  aspect: SignalAspect;
  /** Signal mécanique (true) ou lumineux (false). */
  semaphore: boolean;
}

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
  /**
   * Uint8Array, type de rail par tuile (`RAIL_TYPE_INDEX`, #157). Optionnel :
   * le mock et le pont le fournissent ; un snapshot ancien retombe sur `rail`.
   */
  railTypes?: Uint8Array;
  /**
   * Uint8Array, bits de signal par tuile (#156). 0 = aucun signal ; sinon
   * bits 0..2 = type, bit 3 = bidirectionnel, bits 4..5 = état, bit 6 =
   * mécanique. Voir `src/game/signalRules.ts` pour l'encodage.
   */
  signalData?: Uint8Array;
}

export type VehicleKind = 'train' | 'road' | 'ship' | 'aircraft';

/** État de panne en cours d'un véhicule (#163). */
export type BreakdownState = 'none' | 'slowing' | 'stopped';

/**
 * Usure et fiabilité d'un véhicule (#163).
 *
 * `wear` et `reliability` sont des pourcentages : `wear` 0 = neuf, 100 = usé ;
 * `reliability` vaut `100 - wear`. Les moteurs antérieurs à #163 n'exposent pas
 * ce bloc, l'UI masque alors les indicateurs d'entretien.
 */
export interface VehicleReliabilitySnapshot {
  /** Usure 0..100 (100 = véhicule à remplacer). */
  wear: number;
  /** Fiabilité restante 0..100. */
  reliability: number;
  /** Panne en cours : aucune, ralentissement ou arrêt temporaire. */
  breakdown: BreakdownState;
  /** Ticks restants de la panne courante (0 = aucune). */
  breakdownTicks: number;
  /** Tick du dernier service au dépôt, ou null si jamais entretenu. */
  lastServiceTick: number | null;
  /** Intervalle d'entretien recommandé, en jours de jeu. */
  serviceIntervalDays: number;
  /** Jours écoulés depuis le dernier service. */
  daysSinceService: number;
  /** Coût d'entretien annuel indicatif, en livres. */
  maintenancePerYear: number;
}

/** Groupe auquel appartient un véhicule (#164). */
export interface VehicleGroupRef {
  id: number;
  name: string;
}

/**
 * Groupe de véhicules d'une entreprise (#164). Les groupes sont typés : un
 * groupe routier ne peut contenir que des véhicules routiers, comme dans
 * OpenTTD. `parent` permet une hiérarchie facultative.
 */
export interface VehicleGroupSnapshot {
  id: number;
  company: CompanyId;
  name: string;
  kind: VehicleKind;
  /** Groupe parent, ou null pour un groupe racine. */
  parent: number | null;
  /** Nombre de véhicules rattachés. */
  vehicles: number;
  /**
   * Règle de remplacement automatique du groupe. `model` est un identifiant
   * du catalogue partagé (mock) ou un nom de moteur (pont WASM).
   */
  autoreplace: { model: string; whenOld: boolean } | null;
}

/**
 * Type d'une cible de tournée : gare, industrie, dépôt, ou ordre conditionnel
 * (#161). Un ordre conditionnel n'a pas de cible physique : `target` est
 * ignoré et `options.condition`/`options.jump` décident de la suite.
 */
export type OrderTargetKind = 'station' | 'industry' | 'depot' | 'conditional';

/**
 * Comportement à l'arrêt (#161). Regroupe les modes OpenTTD « full load »,
 * « no load », « unload » et « transfer » en une seule option lisible par l'UI.
 *
 * - `normal` : décharge si possible puis charge ce qui est disponible ;
 * - `full_load` : décharge puis attend le plein (avec délai de garde) ;
 * - `no_load` : décharge mais ne charge pas ;
 * - `unload` : force le déchargement (revenu immédiat), sans chargement ;
 * - `transfer` : dépose la cargaison en gare sans revenu, puis recharge.
 */
export type OrderAction = 'normal' | 'full_load' | 'no_load' | 'unload' | 'transfer';

/** Variable évaluée par un ordre conditionnel (#161). */
export type OrderConditionType = 'cargo' | 'money' | 'date' | 'percentage';

/** Comparateur d'une condition, aligné sur `OrderConditionComparator` d'OpenTTD. */
export type OrderComparator =
  'equal' | 'not_equal' | 'less' | 'less_or_equal' | 'more' | 'more_or_equal';

/**
 * Condition d'un ordre conditionnel (#161).
 *
 * `value` porte la quantité (cargaison), la somme (argent), l'année (date) ou
 * le pourcentage de chargement. Pour `date`, `month` (0..11) complète l'année.
 */
export interface OrderCondition {
  type: OrderConditionType;
  comparator: OrderComparator;
  value: number;
  /** Cargaison comparée quand `type === 'cargo'`. */
  cargo?: string;
  /** Mois 0..11 quand `type === 'date'`. */
  month?: number;
}

/** Horaire d'un ordre (#162), exprimé en ticks moteur. */
export interface OrderTimetable {
  /** Attente planifiée à l'arrêt. */
  waitTicks?: number;
  /** Durée de trajet planifiée jusqu'à l'ordre suivant. */
  travelTicks?: number;
  /** Démarre automatiquement le véhicule quand la tournée est valide. */
  autostart?: boolean;
}

/** Options d'un ordre de tournée (#161/#162). */
export interface OrderOptions {
  action?: OrderAction;
  /** Présent sur un ordre conditionnel. */
  condition?: OrderCondition;
  /** Index de l'ordre à sauter quand la condition est vraie. */
  jump?: number;
  timetable?: OrderTimetable;
}

/** Ordre transmis au moteur (`vehicle.order`). */
export interface VehicleOrderSpec {
  /** Id de gare, d'industrie ou de dépôt ; ignoré pour `conditional`. */
  target: number;
  kind: OrderTargetKind;
  options?: OrderOptions;
}

/** Ordre exposé dans le snapshot, options incluses (#161). */
export interface VehicleOrderSnapshot extends VehicleOrderSpec {
  /** Index dans la tournée (identique à la position dans `orderDetails`). */
  index?: number;
}

export interface VehicleSnapshot {
  id: number;
  kind: VehicleKind;
  company: CompanyId;
  /** Identifiant du catalogue partagé (`vehicleRules`) si connu (#160). */
  model?: string;
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
  /**
   * Tournée complète, ordres conditionnels et options inclus (#161). Absent
   * des moteurs antérieurs : l'UI retombe alors sur `orderTargets`/`orderKinds`.
   */
  orderDetails?: VehicleOrderSnapshot[];
  /** Index de l'ordre courant dans `orderDetails` (#161/#162). */
  currentOrder?: number;
  profitLastYear: number;
  ageDays: number;
  /** Usure, fiabilité et panne en cours (#163), absent des anciens moteurs. */
  reliability?: VehicleReliabilitySnapshot;
  /** Groupe de véhicules (#164), absent pour un véhicule non groupé. */
  group?: VehicleGroupRef;
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
  /** Type de rail d'un dépôt ferroviaire (#157), absent en v1. */
  railType?: RailType;
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

/** Matériau d'un pont, aligné sur les familles de ponts d'OpenTTD. */
export type BridgeMaterial =
  'wood' | 'concrete' | 'steel' | 'suspension' | 'cantilever' | 'tubular';

/** Réseau porté par un pont ou un tunnel. */
export type StructureTransport = 'road' | 'rail';

/** Extrémité d'un ouvrage, en tuiles entières. */
export interface StructureEnd {
  x: number;
  y: number;
}

/**
 * Pont construit. `from` et `to` sont les deux culées (rampes) ; `length`
 * compte les rampes et le tablier. `deckHeight` est exprimé en demi-niveaux
 * OpenTTD, comme `heightMap`.
 */
export interface BridgeStructureSnapshot {
  id: number;
  kind: 'bridge';
  company: CompanyId;
  transport: StructureTransport;
  material: BridgeMaterial;
  from: StructureEnd;
  to: StructureEnd;
  length: number;
  deckHeight: number;
}

/** Tunnel construit : deux portails et la longueur enterrée. */
export interface TunnelStructureSnapshot {
  id: number;
  kind: 'tunnel';
  company: CompanyId;
  transport: StructureTransport;
  from: StructureEnd;
  to: StructureEnd;
  length: number;
  /** Hauteur des portails en demi-niveaux OpenTTD. */
  portalHeight: number;
}

export type StructureSnapshot = BridgeStructureSnapshot | TunnelStructureSnapshot;

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
  /**
   * Niveau de l'IA 1..3 (#168), absent pour une entreprise humaine. Le mock
   * l'utilise pour espacer ses constructions ; le pont le dérive de la
   * difficulté (vitesse des concurrents).
   */
  aiLevel?: number;
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
  /** Signaux présents sur la carte (#156), dérivés de `map.signalData`. */
  signals?: SignalSnapshot[];
  /**
   * Ponts et tunnels, optionnel : les moteurs antérieurs à #154/#155 n'en
   * produisent pas. Le rendu retombe alors sur une inférence depuis `map`.
   */
  structures?: StructureSnapshot[];
  vehicles: VehicleSnapshot[];
  /** Subventions proposées et attribuées (#166/#167). */
  subsidies?: SubsidySnapshot[];
  /** Groupes de véhicules de toutes les entreprises (#164). */
  groups?: VehicleGroupSnapshot[];
  /** Nouvelles du jeu, consommées par le HUD. */
  news: { tick: number; kind: 'info' | 'warning' | 'error' | 'company'; text: string }[];
  /**
   * Désastres actifs (#172). Absent = aucun désastre dans cette partie, ce qui
   * est le comportement par défaut (option désactivée).
   */
  disasters?: DisasterSnapshot[];
  /** Événements ponctuels entre deux snapshots (départ, arrivée, panne…). */
  events: WorldEvent[];
}

/** Type de désastre (#172), aligné sur les catastrophes d'OpenTTD. */
export type DisasterKind = 'fire' | 'road_accident' | 'train_crash' | 'aircraft_crash';

/**
 * Désastre actif exposé par le snapshot. Les coordonnées sont en tuiles
 * fractionnaires, comme les entités ; `remainingDays` permet au HUD et au
 * rendu de faire disparaître l'incident sans commande supplémentaire.
 */
export interface DisasterSnapshot {
  id: number;
  kind: DisasterKind;
  x: number;
  y: number;
  /** Entreprise touchée, ou `COMPANY_NONE` pour un incident neutre. */
  company: CompanyId;
  /** Véhicule détruit/immobilisé, si le désastre en vise un. */
  vehicle?: number;
  /** Ville ou industrie touchée, selon le type. */
  town?: number;
  industry?: number;
  /** Gravité 1..3 (nombre de dégâts et rayon visuel). */
  severity: number;
  /** Tick de déclenchement. */
  startedTick: number;
  /** Jours restants avant la fin de l'incident (0 = dernier jour). */
  remainingDays: number;
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
  | { type: 'disaster_started'; disaster: number; kind: DisasterKind; tick: number }
  | { type: 'disaster_ended'; disaster: number; tick: number }
  | { type: 'town_action'; town: number; action: TownActionKind; tick: number }
  | { type: 'vehicle_breakdown'; vehicle: number; breakdown: BreakdownState; tick: number }
  | { type: 'vehicle_repaired'; vehicle: number; cost: number; tick: number }
  | { type: 'vehicle_autoreplaced'; vehicle: number; model: string; tick: number }
  | { type: 'group_created'; group: number; company: CompanyId; tick: number }
  | { type: 'group_deleted'; group: number; company: CompanyId; tick: number };

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
   * Active les catastrophes d'OpenTTD (#172) : incendies, accidents et
   * crashes. Désactivées par défaut ; la difficulté règle leur fréquence.
   */
  disasters?: boolean;
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
        | 'unsignal'
        | 'convert'
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
      action:
        | 'buy'
        | 'sell'
        | 'refit'
        | 'order'
        | 'start'
        | 'stop'
        | 'clone'
        | 'service'
        | 'send_to_depot';
      company: CompanyId;
      vehicle?: number;
      /** Dépôt d'achat par identifiant stable de `depots[]` (prioritaire). */
      depotId?: number;
      /** Compatibilité : tuile du dépôt quand le client n'a pas d'id. */
      depot?: { x: number; y: number };
      model?: string;
      /** Cargaison cible d'un `refit` (#160), slug stable (`goods`, `coal`…). */
      cargo?: string;
      /**
       * Tournée complète. `target` est un id de gare, d'industrie ou de dépôt
       * (`depots[].id` pour `kind: 'depot'`), ou -1 pour un ordre conditionnel.
       */
      orders?: VehicleOrderSpec[];
      /** `clone` : partage la tournée du véhicule source au lieu de la copier. */
      shareOrders?: boolean;
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
    }
  | {
      /**
       * Groupes de véhicules et actions groupées (#164). `group` cible un
       * groupe existant ; `vehicles` liste les véhicules à affecter.
       */
      type: 'group';
      action:
        | 'create'
        | 'rename'
        | 'delete'
        | 'assign'
        | 'remove'
        | 'start'
        | 'stop'
        | 'send_to_depot'
        | 'sell'
        | 'autoreplace';
      company: CompanyId;
      group?: number;
      /** Nom du groupe à créer ou renommer. */
      name?: string;
      /** Type du groupe à créer (obligatoire pour un groupe non vide). */
      kind?: VehicleKind;
      /** Groupe parent d'un nouveau groupe. */
      parent?: number;
      /** Véhicules ciblés par `assign` (null = véhicules non groupés). */
      vehicles?: number[];
      /** Modèle cible d'un `autoreplace` ; absent/null efface la règle. */
      model?: string | null;
      /** Remplace seulement les véhicules anciens (défaut : true). */
      whenOld?: boolean;
    };

/** Index OpenTTD du type de rail/route demandé (`rail_type`, `road_type`). */
export type BuildRailTypeOption = number;

/**
 * Options typées de l'outil `bridge` (#154). `length` et `direction` sont des
 * indications de l'aperçu : le pont est déterminé par `from` → `to`, comme
 * dans OpenTTD où les deux culées doivent être alignées.
 */
export interface BridgeBuildOptions {
  /** Réseau porté par l'ouvrage (défaut : rail). */
  kind?: StructureTransport;
  /** Famille de pont (défaut : wood). */
  material?: BridgeMaterial;
  /** Index brut `BridgeType` OpenTTD (0..12), prioritaire sur `material`. */
  bridge?: number;
  /** Longueur totale en tuiles, rampes comprises (contrôle de cohérence). */
  length?: number;
  /** Axe du pont (`x` ou `y`), déduit de `from`/`to` par le moteur. */
  direction?: 'x' | 'y';
  /** Type de rail OpenTTD (index) pour un pont ferroviaire. */
  rail_type?: BuildRailTypeOption;
  /** Type de route OpenTTD (index) pour un pont routier. */
  road_type?: BuildRailTypeOption;
}

/** Options typées de l'outil `tunnel` (#155). */
export interface TunnelBuildOptions {
  kind?: StructureTransport;
  length?: number;
  direction?: 'x' | 'y';
  rail_type?: BuildRailTypeOption;
  road_type?: BuildRailTypeOption;
}

/** Codes d'erreur stables renvoyés par `ottd_command` pour les ouvrages. */
export type BuildErrorCode =
  | 'OK'
  | 'INVALID_PARAMETER'
  | 'UNKNOWN_TOOL'
  | 'NO_ROAD_TYPE'
  | 'NO_RAIL_TYPE'
  | 'NOT_ENOUGH_MONEY'
  | 'COMMAND_FAILED'
  | 'BRIDGE_TOO_LONG'
  | 'BRIDGE_THROUGH_MAP_BORDER'
  | 'BRIDGEHEADS_NOT_SAME_HEIGHT'
  | 'BRIDGE_TOO_LOW_FOR_TERRAIN'
  | 'BRIDGE_TOO_HIGH_FOR_TERRAIN'
  | 'TUNNEL_TOO_LONG'
  | 'TUNNEL_THROUGH_MAP_BORDER'
  | 'ANOTHER_TUNNEL_IN_THE_WAY'
  | 'SITE_UNSUITABLE_FOR_TUNNEL'
  | 'SLOPE_TOO_STEEP'
  | 'TOO_CLOSE_TO_EDGE'
  | 'MUST_DEMOLISH_BRIDGE_FIRST'
  | 'ALREADY_BUILT'
  | 'NOT_SUPPORTED';

/** Résultat JSON d'une commande de construction d'ouvrage. */
export interface StructureCommandResult {
  ok: boolean;
  code: BuildErrorCode | (string & {});
  message: string;
  detail?: string;
  /** Coût effectivement débité (uniquement si `ok`). */
  cost?: number;
  /** Entretien annuel estimé, en livres. */
  maintenance?: number;
  /** Nombre de tuiles couvertes par l'ouvrage. */
  tiles?: number;
  /** Ouvrage créé, pour rafraîchir immédiatement le rendu. */
  structure?: StructureSnapshot;
}

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
