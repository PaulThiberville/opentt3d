/**
 * Types partagés par les composants d'interface.
 *
 * Aucun accès DOM : uniquement des formes de données consommées par le HUD,
 * les écrans et les modules purs.
 */

import type {
  OrderAction,
  OrderOptions,
  OrderTargetKind,
  TownActionKind,
  WorldSnapshot,
} from '../engine/protocol';
import type { GameSpeed, Selection } from '../game/Game';
import type { QualityLevel } from '../render/quality';
import type { VehicleVariant } from '../render/vehicleModels';
import type { NewsKind } from './news';

export interface SelectionStat {
  label: string;
  value: string;
  tone?: 'muted' | 'good' | 'bad';
}

export interface SelectionSummary {
  selection: Selection;
  title: string;
  detail: string;
  stats: SelectionStat[];
  colour: number | null;
}

/** Cible cliquable d'un panneau lieu : gare, industrie ou véhicule. */
export interface PlaceTarget {
  kind: 'station' | 'industry' | 'vehicle';
  id: number;
}

export interface PlacePanelItem {
  /** Identifiant stable dans la liste (gare, industrie, véhicule). */
  id: string;
  label: string;
  detail: string;
  /** Présent : l'élément ouvre le panneau correspondant. */
  target?: PlaceTarget;
}

export interface PlacePanelSection {
  id: string;
  title: string;
  empty: string;
  items: PlacePanelItem[];
}

/**
 * Action de panneau lieu. `supported` est faux quand le protocole v1 n'expose
 * pas la commande : le bouton reste désactivé et `reason` explique l'absence.
 * `kind: 'town'` porte une action municipale payante (#166).
 */
export interface PlacePanelAction {
  id: string;
  label: string;
  kind: 'focus' | 'unsupported' | 'town';
  supported: boolean;
  reason?: string;
  /** Coût formaté de l'action municipale, quand `kind === 'town'`. */
  cost?: string;
  /** Action transmise au moteur (`town_action`). */
  townAction?: TownActionKind;
}

/** Panneau ville, industrie ou gare, alimenté par le seul snapshot. */
export interface PlacePanelView {
  kind: 'town' | 'industry' | 'station';
  id: number;
  /** Centre du lieu, pour recentrer la caméra. */
  x: number;
  y: number;
  title: string;
  detail: string;
  colour: number | null;
  stats: SelectionStat[];
  sections: PlacePanelSection[];
  actions: PlacePanelAction[];
  hint: string;
}

export interface DepotModelView {
  id: string;
  name: string;
  cargo: string;
  capacity: number;
  speed: number;
  cost: number;
  maintenance: number;
  description: string;
  affordable: boolean;
  /** `false` si le rail du dépôt ne permet pas ce matériel (#219). */
  available: boolean;
  /** Explication affichée quand `available` est faux, sinon `null`. */
  blockedReason: string | null;
  /** Archétype visuel utilisé pour la vignette. */
  variant: VehicleVariant;
  /** Couleur d'entreprise 0xRRGGBB de la livrée de la vignette. */
  colour: number;
}

export interface DepotVehicleView {
  id: number;
  name: string;
  detail: string;
  canStart: boolean;
  canStop: boolean;
  /** Archétype visuel réel du véhicule sur place. */
  variant: VehicleVariant;
  /** Couleur d'entreprise 0xRRGGBB de la livrée de la vignette. */
  colour: number;
}

export interface DepotPanelView {
  /** Id stable de `snapshot.depots` (transmis à l'achat). */
  id: number;
  x: number;
  y: number;
  kindLabel: string;
  title: string;
  detail: string;
  money: string;
  models: DepotModelView[];
  vehicles: DepotVehicleView[];
  hint: string;
}

export interface VehicleOrderView {
  index: number;
  label: string;
  kind: OrderTargetKind;
  /** Mode d'arrêt normalisé (#161). */
  action: OrderAction;
  actionLabel: string;
  /** Résumé de la condition, ou null. */
  conditionLabel: string | null;
  /** « saut vers l'ordre N », ou null. */
  jumpLabel: string | null;
  /** Résumé d'horaire (attente/trajet/autostart), ou null. */
  timetableLabel: string | null;
  /** Ordre en cours d'exécution (#161). */
  current: boolean;
  /** Options complètes, pour préremplir l'éditeur. */
  options: OrderOptions;
}

/** Cargaison proposée au refit d'un véhicule (#160). */
export interface VehicleRefitView {
  cargo: string;
  label: string;
  capacity: number;
  cost: number;
  /** Refit possible maintenant (dépôt, cargaison différente, fonds). */
  available: boolean;
  reason: string | null;
}

/** Véhicule candidat au partage de tournée (#161). */
export interface VehicleShareView {
  id: number;
  label: string;
}

/** Vue d'usure et d'entretien d'un véhicule (#163). */
export interface VehicleReliabilityView {
  wear: number;
  reliability: number;
  wearLabel: string;
  reliabilityLabel: string;
  breakdown: 'none' | 'slowing' | 'stopped';
  breakdownLabel: string | null;
  serviceIntervalLabel: string;
  daysSinceService: number;
  maintenanceLabel: string;
  serviceCost: number;
  serviceCostLabel: string;
  canService: boolean;
  reason: string | null;
}

export interface VehiclePanelView extends SelectionSummary {
  status: string;
  /** Nom du modèle catalogue, ou null pour la flotte de démonstration. */
  modelName: string | null;
  /** Cargaison courante et remplissage. */
  cargo: { label: string; amount: number; capacity: number; percent: number };
  orders: VehicleOrderView[];
  /** Index de l'ordre courant, ou null. */
  currentOrder: number | null;
  /** Refits disponibles pour le modèle, vide si inconnu. */
  refits: VehicleRefitView[];
  /** Le véhicule est arrêté dans un dépôt : refit et duplication possibles. */
  inDepot: boolean;
  /** Cargaison qui sera perdue par un refit. */
  cargoAtRisk: number;
  /** Autres véhicules de l'entreprise pour partager la tournée. */
  shareCandidates: VehicleShareView[];
  canStart: boolean;
  canStop: boolean;
  canSell: boolean;
  /** Le prochain clic sur la carte ajoute une gare/dépôt à la tournée. */
  orderPicking: boolean;
  /** Usure, panne et entretien (#163), absent des anciens moteurs. */
  reliability: VehicleReliabilityView | null;
  /** Libellé du groupe (#164), ou null si non groupé. */
  groupLabel: string | null;
  /** Groupes de l'entreprise proposés à l'affectation. */
  groupOptions: { id: number; label: string }[];
  /** Envoi au dépôt possible (véhicule de l'entreprise hors dépôt). */
  canSendToDepot: boolean;
  hint: string;
}

export interface CameraView {
  targetX: number;
  targetZ: number;
  /** Hauteur du point visé (unités monde). */
  targetY?: number;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface NetworkStatusView {
  text: string;
  tone: 'ok' | 'wait' | 'warn' | 'error';
}

/** Point d'historique du panneau finances (graphique simple, #165). */
export interface FinanceHistoryPoint {
  tick?: number;
  money: number;
  income?: number;
  expenses?: number;
  /** Valeur d'entreprise, absente des anciens historiques de rapports. */
  value?: number;
}

/** Subvention affichée dans le panneau finances (#166/#167). */
export interface FinanceSubsidyView {
  id: number;
  title: string;
  detail: string;
  state: 'offer' | 'awarded' | 'foreign' | 'expired';
  tone: 'good' | 'muted' | 'bad';
}

/** Panneau finances : trésorerie, prêts, valeur, inflation et subventions. */
export interface FinanceView {
  company: string;
  money: string;
  loan: string;
  maxLoan: string;
  value: string;
  income: string;
  expenses: string;
  interestRate: string;
  inflation: string;
  difficulty: string;
  loanStep: string;
  increaseLabel: string;
  decreaseLabel: string;
  canIncrease: boolean;
  canDecrease: boolean;
  monthsOfBankruptcy: number;
  bankrupt: boolean;
  warning: string | null;
  history: FinanceHistoryPoint[];
  subsidies: FinanceSubsidyView[];
  hint: string;
}

/** Alerte faillite persistante du HUD (#165). */
export interface BankruptcyAlertView {
  text: string;
  tone: 'warning' | 'error';
}

export interface HudState {
  snapshot: WorldSnapshot | null;
  fps: number;
  paused: boolean;
  speed: GameSpeed;
  selection: SelectionSummary | null;
  /** Panneau dépôt ouvert (prioritaire sur le panneau de sélection). */
  depot?: DepotPanelView | null;
  /** Panneau véhicule (sélection d'un véhicule). */
  vehicle?: VehiclePanelView | null;
  /** Panneau ville, industrie ou gare (sélection d'un lieu). */
  place?: PlacePanelView | null;
  /** Panneau finances (#165), ouvert à la demande. */
  finance?: FinanceView | null;
  /** Bandeau faillite persistant (#165). */
  bankruptcyAlert?: BankruptcyAlertView | null;
  quality: QualityLevel;
  following: boolean;
  drawCalls: number;
  /** Pause et vitesse sont séquencées par l'hôte en réseau. */
  controlsLocked?: boolean;
  networkStatus?: NetworkStatusView | null;
}

/** Action de rapport : désactivée quand le protocole ne l'expose pas. */
export interface ReportActionView {
  id: string;
  label: string;
  supported: boolean;
  reason?: string;
}

export interface ReportOption {
  value: string;
  label: string;
}

/** Catégorie de revenu ou de dépense, fournie par un snapshot étendu. */
export interface FinanceCategoryView {
  id: string;
  label: string;
  amount: number;
  amountLabel: string;
  /** Largeur relative 0..100 pour la barre SVG. */
  percent: number;
}

export interface FinanceRankingRow {
  id: number;
  rank: number;
  name: string;
  colour: number;
  value: number | null;
  valueLabel: string;
  share: number | null;
  shareLabel: string;
  isLocal: boolean;
  isAI: boolean;
  /** Niveau de l'IA 1..3, pour le badge du classement (#168). */
  aiLevel: number | null;
  vehicles: number;
  stations: number;
  networkLabel: string;
  result: number | null;
  resultLabel: string;
  bankrupt: boolean;
}

export interface FinanceAlertView {
  id: string;
  tone: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
}

export interface FinancePanelView {
  companyId: number | null;
  companyName: string;
  money: number | null;
  moneyLabel: string;
  value: number | null;
  valueLabel: string;
  loan: number | null;
  loanLabel: string;
  loanLimitLabel: string | null;
  interestRateLabel: string | null;
  income: number | null;
  incomeLabel: string;
  expenses: number | null;
  expensesLabel: string;
  result: number | null;
  resultLabel: string;
  resultTone: 'good' | 'bad' | 'muted';
  revenue: FinanceCategoryView[];
  expensesByCategory: FinanceCategoryView[];
  /** Faux quand le snapshot n'expose que les totaux du protocole v1. */
  breakdownAvailable: boolean;
  history: FinanceHistoryPoint[];
  ranking: FinanceRankingRow[];
  alerts: FinanceAlertView[];
  actions: ReportActionView[];
  hint: string;
}

export type VehicleListSort = 'profit' | 'age' | 'id' | 'type' | 'status' | 'group';
export type VehicleListStatusFilter = 'all' | 'moving' | 'stopped' | 'depot';
export type VehicleListProfitFilter = 'all' | 'profit' | 'loss';
export type VehicleListAgeFilter = 'all' | 'recent' | 'old';

export interface VehicleListFilters {
  kind: string;
  group: string;
  status: VehicleListStatusFilter;
  profit: VehicleListProfitFilter;
  age: VehicleListAgeFilter;
  query: string;
  sort: VehicleListSort;
}

export interface VehicleGroupView {
  id: string;
  label: string;
  count: number;
  /** Type du groupe (train, road…), null pour « non groupé ». */
  kind: string | null;
  /** Résumé de la règle d'autoreplace, ou null. */
  autoreplaceLabel: string | null;
}

export interface VehicleListRowView {
  id: number;
  title: string;
  detail: string;
  companyName: string;
  colour: number;
  kind: string;
  /** Identifiant du groupe (`UNGROUPED_ID` si non groupé). */
  groupId: string;
  groupLabel: string;
  status: number | null;
  statusLabel: string;
  profit: number | null;
  profitLabel: string;
  ageDays: number | null;
  ageLabel: string;
  orders: number;
  reliability: number | null;
  reliabilityLabel: string;
  isLocal: boolean;
  canSelect: boolean;
  canStart: boolean;
  canStop: boolean;
  canSell: boolean;
  note: string | null;
}

export interface VehicleListSummary {
  count: number;
  moving: number;
  profit: number;
  profitLabel: string;
  averageAgeLabel: string;
}

export interface VehicleListPanelView {
  summary: VehicleListSummary;
  rows: VehicleListRowView[];
  groups: VehicleGroupView[];
  kindOptions: ReportOption[];
  groupOptions: ReportOption[];
  groupActions: ReportActionView[];
  groupNote: string;
  /** Groupe actuellement sélectionné par le filtre, ou null (tous). */
  selectedGroup: VehicleGroupView | null;
  /** Création de groupe possible si le snapshot expose `groups`. */
  canManageGroups: boolean;
  /** Modèles compatibles avec le groupe sélectionné, pour l'autoreplace. */
  autoreplaceOptions: ReportOption[];
  /** Règle d'autoreplace active du groupe sélectionné. */
  autoreplace: { model: string; whenOld: boolean } | null;
  empty: string;
  hint: string;
}

export interface IndustryStatsRow {
  id: number;
  name: string;
  kindLabel: string;
  production: number;
  transported: number;
  detail: string;
  rate: number | null;
  rateLabel: string;
  percent: number;
  transportedPercent: number;
}

export interface TownStatsRow {
  id: number;
  name: string;
  population: number;
  detail: string;
  stations: number;
  served: number;
  percent: number;
}

export interface MarketShareRow {
  id: number;
  name: string;
  colour: number;
  value: number;
  valueLabel: string;
  share: number | null;
  shareLabel: string;
  isLocal: boolean;
  isAI: boolean;
  aiLevel: number | null;
}

/** Ligne du panneau « Désastres » (#172). */
export interface DisasterStatsRow {
  id: number;
  kindLabel: string;
  detail: string;
  location: string;
  companyLabel: string | null;
  severity: number;
  remainingDays: number;
  remainingLabel: string;
}

export interface StatsPanelView {
  industryCount: number;
  totalProduction: number;
  totalTransported: number;
  totalProductionLabel: string;
  totalTransportedLabel: string;
  townCount: number;
  totalPopulation: number;
  totalPopulationLabel: string;
  industries: IndustryStatsRow[];
  towns: TownStatsRow[];
  market: MarketShareRow[];
  marketBasis: string;
  disasters: DisasterStatsRow[];
  activeDisasterCount: number;
  activeDisasterCountLabel: string;
  disastersEnabled: boolean | null;
  alerts: FinanceAlertView[];
  hint: string;
}

export interface NewsFeedItem {
  id: number;
  kind: NewsKind;
  text: string;
  dateLabel: string;
  read: boolean;
}

export interface SessionOverview {
  company: string;
  date: string;
  money: string;
  vehicles: number;
  stations: number;
}

export interface GameOverSummary {
  title: string;
  reason: string;
  company: string;
  money: string;
  value: string;
  vehicles: number;
  stations: number;
  date: string;
}
