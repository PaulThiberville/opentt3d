/**
 * File de news bornée, purement en mémoire.
 *
 * Le `Game` consomme les news du snapshot sans doublon ; la file ajoute une
 * déduplication de sécurité sur (tick, type, texte), un horodatage de jeu et
 * un état lu/non lu affiché dans le HUD.
 */

export type NewsKind = 'info' | 'warning' | 'error' | 'company';

export interface NewsInput {
  tick: number;
  kind: NewsKind;
  text: string;
  /** Date de jeu au moment de la réception, ex. « 1 janvier 1950 ». */
  dateLabel: string;
}

export interface NewsItem extends NewsInput {
  id: number;
  read: boolean;
}

export const DEFAULT_NEWS_LIMIT = 40;

function dedupeKey(input: NewsInput): string {
  return `${input.tick}|${input.kind}|${input.text}`;
}

export class NewsQueue {
  readonly limit: number;

  private items: NewsItem[] = [];
  private seen = new Set<string>();
  private nextId = 1;

  constructor(limit = DEFAULT_NEWS_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get size(): number {
    return this.items.length;
  }

  /** Ajoute une news ; renvoie `null` si c'est un doublon. */
  add(input: NewsInput): NewsItem | null {
    const text = input.text.trim();
    if (text === '') return null;
    const normalized: NewsInput = {
      tick: Number.isFinite(input.tick) ? Math.round(input.tick) : 0,
      kind: input.kind,
      text,
      dateLabel: input.dateLabel,
    };
    const key = dedupeKey(normalized);
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    const item: NewsItem = { ...normalized, id: this.nextId, read: false };
    this.nextId += 1;
    this.items.push(item);
    while (this.items.length > this.limit) {
      const dropped = this.items.shift();
      if (dropped) this.seen.delete(dedupeKey(dropped));
    }
    return item;
  }

  /** Du plus récent au plus ancien. */
  list(): readonly NewsItem[] {
    return this.items.slice().reverse();
  }

  latest(): NewsItem | null {
    return this.items[this.items.length - 1] ?? null;
  }

  unreadCount(): number {
    let count = 0;
    for (const item of this.items) if (!item.read) count += 1;
    return count;
  }

  markAllRead(): number {
    let changed = 0;
    for (const item of this.items) {
      if (!item.read) {
        item.read = true;
        changed += 1;
      }
    }
    return changed;
  }

  markRead(id: number): boolean {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.read) return false;
    item.read = true;
    return true;
  }

  clear(): void {
    this.items = [];
    this.seen.clear();
  }
}
