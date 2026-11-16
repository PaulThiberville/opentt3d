/**
 * Formatage des valeurs de jeu, localisé FR/EN.
 *
 * Pur, sans DOM : testé sous Node. L'UI ne calcule jamais une valeur de
 * simulation ; elle ne fait que mettre en forme ce que contient le snapshot.
 * La langue courante vient du socle i18n ; un paramètre explicite reste
 * possible pour les tests et les aperçus.
 */

import { getLanguage, t, type Language } from './i18n';

export interface GameDateLike {
  year: number;
  month: number;
  day: number;
}

const MONTHS: Record<Language, string[]> = {
  fr: [
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
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
};

const MONTHS_SHORT: Record<Language, string[]> = {
  fr: [
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
  ],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

const LOCALES: Record<Language, string> = { fr: 'fr-FR', en: 'en-GB' };
const INTEGER_FORMATS = new Map<Language, Intl.NumberFormat>();
const DECIMAL_FORMATS = new Map<Language, Intl.NumberFormat>();
const MONEY_FORMATS = new Map<Language, Intl.NumberFormat>();

function localeOf(language: Language): string {
  return LOCALES[language];
}

function integerFormat(language: Language): Intl.NumberFormat {
  let format = INTEGER_FORMATS.get(language);
  if (!format) {
    format = new Intl.NumberFormat(localeOf(language), { maximumFractionDigits: 0 });
    INTEGER_FORMATS.set(language, format);
  }
  return format;
}

function decimalFormat(language: Language): Intl.NumberFormat {
  let format = DECIMAL_FORMATS.get(language);
  if (!format) {
    format = new Intl.NumberFormat(localeOf(language), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    DECIMAL_FORMATS.set(language, format);
  }
  return format;
}

function moneyFormat(language: Language): Intl.NumberFormat {
  let format = MONEY_FORMATS.get(language);
  if (!format) {
    format = new Intl.NumberFormat(localeOf(language), {
      style: 'currency',
      currency: 'GBP',
      maximumFractionDigits: 0,
      currencyDisplay: 'narrowSymbol',
    });
    MONEY_FORMATS.set(language, format);
  }
  return format;
}

const MINUS = '−';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatInt(value: number, language: Language = getLanguage()): string {
  if (!isFiniteNumber(value)) return '—';
  return integerFormat(language).format(Math.round(value));
}

export function formatDecimal(value: number, language: Language = getLanguage()): string {
  if (!isFiniteNumber(value)) return '—';
  return decimalFormat(language).format(value);
}

/** Montant absolu en livres sterling : « 2 400 000 £ » / « £2,400,000 ». */
export function formatMoney(value: number, language: Language = getLanguage()): string {
  if (!isFiniteNumber(value)) return '—';
  const rounded = Math.round(value);
  const absolute =
    language === 'en'
      ? moneyFormat(language).format(Math.abs(rounded))
      : `${integerFormat(language).format(Math.abs(rounded))} £`;
  return rounded < 0 ? `${MINUS}${absolute}` : absolute;
}

/** Montant signé : « +12 400 £ » / « −3 200 £ » (ou « −£3,200 » en anglais). */
export function formatSignedMoney(value: number, language: Language = getLanguage()): string {
  if (!isFiniteNumber(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : '';
  const absolute =
    language === 'en'
      ? moneyFormat(language).format(Math.abs(rounded))
      : `${integerFormat(language).format(Math.abs(rounded))} £`;
  return `${sign}${absolute}`;
}

/** Millions compactés pour les gros montants (titre, fin de partie). */
export function formatMoneyCompact(value: number, language: Language = getLanguage()): string {
  if (!isFiniteNumber(value)) return '—';
  const absolute = Math.abs(value);
  if (language === 'en') {
    if (absolute >= 1_000_000) return `£${formatDecimal(value / 1_000_000, language)}M`;
    if (absolute >= 10_000) return `£${formatInt(value / 1_000, language)}k`;
    return formatMoney(value, language);
  }
  if (absolute >= 1_000_000) return `${formatDecimal(value / 1_000_000, language)} M£`;
  if (absolute >= 10_000) return `${formatInt(value / 1_000, language)} k£`;
  return formatMoney(value, language);
}

export function formatGameDate(
  date: GameDateLike | null | undefined,
  language: Language = getLanguage(),
): string {
  if (!date || !isFiniteNumber(date.year) || !isFiniteNumber(date.month)) return '—';
  const month = MONTHS[language][date.month];
  if (!month) return '—';
  const day = isFiniteNumber(date.day) ? Math.max(1, Math.round(date.day)) : 1;
  return `${day} ${month} ${Math.round(date.year)}`;
}

export function formatShortGameDate(
  date: GameDateLike | null | undefined,
  language: Language = getLanguage(),
): string {
  if (!date || !isFiniteNumber(date.year) || !isFiniteNumber(date.month)) return '—';
  const month = MONTHS_SHORT[language][date.month];
  if (!month) return '—';
  const day = isFiniteNumber(date.day) ? Math.max(1, Math.round(date.day)) : 1;
  return `${day} ${month} ${Math.round(date.year)}`;
}

/** Vitesse de véhicule, en tuiles par jour de jeu. */
export function formatVehicleSpeed(value: number, language: Language = getLanguage()): string {
  if (!isFiniteNumber(value)) return '—';
  return t('format.tilesPerDay', { value: formatInt(value, language) });
}

/** Note de ville normalisée 0..100 (le pont expose parfois 0..1000). */
export function formatRating(value: number): string {
  if (!isFiniteNumber(value)) return '—';
  const normalized = value > 100 ? value / 10 : value;
  return `${formatInt(Math.max(0, Math.min(100, normalized)))} / 100`;
}

export function formatPercent(
  value: number,
  digits = 0,
  language: Language = getLanguage(),
): string {
  if (!isFiniteNumber(value)) return '—';
  const rounded = new Intl.NumberFormat(localeOf(language), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return language === 'en' ? `${rounded}%` : `${rounded} %`;
}

/** Horodatage court d'une news, purement basé sur la date de jeu. */
export function formatNewsStamp(date: GameDateLike | null | undefined): string {
  return formatShortGameDate(date);
}
