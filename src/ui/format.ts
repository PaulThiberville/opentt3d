/**
 * Formatage des valeurs de jeu pour l'interface française.
 *
 * Pur, sans DOM : testé sous Node. L'UI ne calcule jamais une valeur de
 * simulation ; elle ne fait que mettre en forme ce que contient le snapshot.
 */

export interface GameDateLike {
  year: number;
  month: number;
  day: number;
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

const MONTHS_SHORT = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];

const INTEGER_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

const DECIMAL_FORMAT = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const MINUS = '−';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatInt(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  return INTEGER_FORMAT.format(Math.round(value));
}

export function formatDecimal(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  return DECIMAL_FORMAT.format(value);
}

/** Montant absolu en livres sterling : « 2 400 000 £ ». */
export function formatMoney(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? MINUS : '';
  return `${sign}${INTEGER_FORMAT.format(Math.abs(rounded))} £`;
}

/** Montant signé, typographie française : « +12 400 £ » / « −3 200 £ ». */
export function formatSignedMoney(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : '';
  return `${sign}${INTEGER_FORMAT.format(Math.abs(rounded))} £`;
}

/** Millions compactés pour les gros montants (titre, fin de partie). */
export function formatMoneyCompact(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${formatDecimal(value / 1_000_000)} M£`;
  if (absolute >= 10_000) return `${formatInt(value / 1_000)} k£`;
  return formatMoney(value);
}

export function formatGameDate(date: GameDateLike | null | undefined): string {
  if (!date || !isFiniteNumber(date.year) || !isFiniteNumber(date.month)) return '—';
  const month = MONTHS[date.month];
  if (!month) return '—';
  const day = isFiniteNumber(date.day) ? Math.max(1, Math.round(date.day)) : 1;
  return `${day} ${month} ${Math.round(date.year)}`;
}

export function formatShortGameDate(date: GameDateLike | null | undefined): string {
  if (!date || !isFiniteNumber(date.year) || !isFiniteNumber(date.month)) return '—';
  const month = MONTHS_SHORT[date.month];
  if (!month) return '—';
  const day = isFiniteNumber(date.day) ? Math.max(1, Math.round(date.day)) : 1;
  return `${day} ${month} ${Math.round(date.year)}`;
}

/** Vitesse de véhicule, en tuiles par jour de jeu. */
export function formatVehicleSpeed(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  return `${formatInt(value)} tuiles/j`;
}

/** Note de ville 0..100. */
export function formatRating(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  return `${formatInt(value)} / 100`;
}

export function formatPercent(value: number, digits = 0): string {
  if (!isFiniteNumber(value)) return '—';
  const rounded = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${rounded} %`;
}

/** Horodatage court d'une news, purement basé sur la date de jeu. */
export function formatNewsStamp(date: GameDateLike | null | undefined): string {
  return formatShortGameDate(date);
}
