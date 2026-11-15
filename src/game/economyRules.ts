/**
 * Règles économiques partagées par l'interface et le moteur mock (#165/#166).
 *
 * Module pur : plafonds de prêt, coûts des actions municipales, tarifs de
 * fret et fabriques de commandes. Le moteur reste seul juge de l'application
 * (fonds, plafond, disponibilité) ; l'UI s'en sert pour désactiver un bouton
 * et annoncer un coût sans jamais simuler la dépense.
 */

import type {
  CompanyId,
  CompanySnapshot,
  EconomySnapshot,
  EngineCommand,
  TownActionKind,
  TownAuthoritySnapshot,
  TownSnapshot,
} from '../engine/protocol';

/** Pas minimal d'emprunt/remboursement, aligné sur `LOAN_INTERVAL` OpenTTD. */
export const DEFAULT_LOAN_INTERVAL = 50_000;

/**
 * Tarif de base par unité de cargaison, en livres, avant distance et temps.
 * Ces valeurs sont une convention du mock ; le pont WASM laisse OpenTTD
 * calculer ses propres paiements.
 */
export const CARGO_RATES: Readonly<Record<string, number>> = {
  passengers: 55,
  mail: 48,
  coal: 36,
  wood: 40,
  grain: 42,
  goods: 85,
  oil: 55,
  livestock: 50,
  steel: 68,
  valuables: 95,
};

/** Tarif inconnu : valeur médiane pour ne jamais produire un revenu nul. */
export const DEFAULT_CARGO_RATE = 45;

export function cargoRate(cargo: string): number {
  return CARGO_RATES[cargo] ?? DEFAULT_CARGO_RATE;
}

/** Cargaison voyageurs ou courrier (véhicules de voyageurs). */
export function isPassengerCargo(cargo: string): boolean {
  return cargo === 'passengers' || cargo === 'mail';
}

/**
 * Note de ville normalisée 0..100.
 *
 * Le mock publie 0..100, le pont OpenTTD 0..1000 : l'UI accepte les deux
 * échelles et ne compare jamais une note brute à un seuil.
 */
export function normalizeRating(rating: number): number {
  if (!Number.isFinite(rating)) return 0;
  return Math.max(0, Math.min(100, rating > 100 ? rating / 10 : rating));
}

/** Note de l'autorité locale, avec repli sur `TownSnapshot.rating`. */
export function townAuthorityRating(town: TownSnapshot): number {
  return normalizeRating(town.authority?.rating ?? town.rating);
}

export function townAuthority(town: TownSnapshot): TownAuthoritySnapshot | null {
  return town.authority ?? null;
}

/** Coût d'une action municipale tel qu'exposé, ou `null` si indisponible. */
export function townActionCost(town: TownSnapshot, action: TownActionKind): number | null {
  const entry = town.authority?.actions[action];
  if (!entry) return null;
  return entry.available ? entry.cost : null;
}

/** Pas de prêt effectif : snapshot, puis repli sur la constante OpenTTD. */
export function loanIntervalOf(economy: EconomySnapshot | null | undefined): number {
  const value = economy?.loanInterval;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return DEFAULT_LOAN_INTERVAL;
}

/** Plafond de prêt effectif d'une entreprise. */
export function maxLoanOf(
  company: CompanySnapshot | null | undefined,
  economy: EconomySnapshot | null | undefined,
): number {
  if (company && typeof company.maxLoan === 'number' && Number.isFinite(company.maxLoan)) {
    return Math.max(0, company.maxLoan);
  }
  if (economy && typeof economy.maxLoan === 'number' && Number.isFinite(economy.maxLoan)) {
    return Math.max(0, economy.maxLoan);
  }
  return 300_000;
}

export interface LoanCapacity {
  canIncrease: boolean;
  canDecrease: boolean;
  /** Montant proposé pour un pas d'emprunt (borné par le plafond). */
  increaseAmount: number;
  /** Montant proposé pour un pas de remboursement (borné par la dette). */
  decreaseAmount: number;
}

/** Capacité d'emprunt/remboursement pour les boutons du panneau finances. */
export function loanCapacity(
  company: CompanySnapshot | null | undefined,
  economy: EconomySnapshot | null | undefined,
): LoanCapacity {
  const interval = loanIntervalOf(economy);
  const loan = Math.max(0, company?.loan ?? 0);
  const maxLoan = maxLoanOf(company, economy);
  const room = Math.max(0, maxLoan - loan);
  const money = company?.money ?? 0;
  const increaseAmount = room > 0 ? Math.min(interval, room) : 0;
  const repayable = Math.min(loan, Math.max(0, money));
  const decreaseAmount = repayable > 0 ? Math.min(interval, repayable) : 0;
  return {
    canIncrease: increaseAmount > 0 && !company?.bankrupt,
    canDecrease: decreaseAmount > 0 && !company?.bankrupt,
    increaseAmount,
    decreaseAmount,
  };
}

/** Libellé i18n d'une action municipale. */
export function townActionLabelKey(
  action: TownActionKind,
): 'authority.action.advertise' | 'authority.action.fundRoads' | 'authority.action.fundBuildings' {
  switch (action) {
    case 'advertise':
      return 'authority.action.advertise';
    case 'fund_roads':
      return 'authority.action.fundRoads';
    case 'fund_buildings':
      return 'authority.action.fundBuildings';
  }
}

/** Commande d'emprunt ou de remboursement. */
export function financeCommand(
  company: CompanyId,
  action: 'increase_loan' | 'decrease_loan',
  amount?: number,
): Extract<EngineCommand, { type: 'finance' }> {
  return amount === undefined
    ? { type: 'finance', action, company }
    : { type: 'finance', action, company, amount };
}

/** Commande d'action municipale. */
export function townActionCommand(
  company: CompanyId,
  town: number,
  action: TownActionKind,
): Extract<EngineCommand, { type: 'town_action' }> {
  return { type: 'town_action', action, company, town };
}

/** Niveau de difficulté lisible (0..3), avec repli « normale ». */
export function difficultyOf(economy: EconomySnapshot | null | undefined): number {
  const value = economy?.difficulty;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0, Math.round(value)));
}

/** Seuil de faillite : 6 mois de trésorerie négative (convention du mock). */
export const BANKRUPTCY_MONTHS = 6;

/** Vrai si l'entreprise locale doit afficher une alerte faillite. */
export function bankruptcyWarning(company: CompanySnapshot | null | undefined): {
  active: boolean;
  months: number;
  critical: boolean;
} {
  const months = Math.max(0, company?.monthsOfBankruptcy ?? 0);
  const negative = (company?.money ?? 0) < 0;
  return {
    active: !company?.bankrupt && (negative || months > 0),
    months,
    critical: months >= BANKRUPTCY_MONTHS - 2,
  };
}
