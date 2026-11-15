import { describe, expect, it } from 'vitest';
import { NewsQueue } from '../src/ui/news';

function add(queue: NewsQueue, text: string, tick = 0): void {
  queue.add({ tick, kind: 'info', text, dateLabel: '1 janvier 1950' });
}

describe('file de news', () => {
  it('ajoute, horodate et renvoie du plus récent au plus ancien', () => {
    const queue = new NewsQueue();
    queue.add({ tick: 12, kind: 'company', text: 'Ligne ouverte', dateLabel: '2 janvier 1950' });
    queue.add({ tick: 18, kind: 'warning', text: 'Retard', dateLabel: '3 janvier 1950' });
    const list = queue.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.text).toBe('Retard');
    expect(list[0]?.dateLabel).toBe('3 janvier 1950');
    expect(list[1]?.text).toBe('Ligne ouverte');
  });

  it('borne la file et oublie les plus anciennes', () => {
    const queue = new NewsQueue(3);
    for (let index = 0; index < 6; index += 1) add(queue, `news ${index}`, index);
    expect(queue.size).toBe(3);
    expect(queue.list().map((item) => item.text)).toEqual(['news 5', 'news 4', 'news 3']);
  });

  it('déduplique sur (tick, type, texte)', () => {
    const queue = new NewsQueue();
    expect(queue.add({ tick: 3, kind: 'info', text: 'Doublon', dateLabel: 'x' })).not.toBeNull();
    expect(queue.add({ tick: 3, kind: 'info', text: 'Doublon', dateLabel: 'x' })).toBeNull();
    expect(queue.add({ tick: 3, kind: 'warning', text: 'Doublon', dateLabel: 'x' })).not.toBeNull();
    expect(queue.size).toBe(2);
  });

  it('ignore un texte vide', () => {
    const queue = new NewsQueue();
    expect(queue.add({ tick: 0, kind: 'info', text: '   ', dateLabel: '—' })).toBeNull();
    expect(queue.size).toBe(0);
  });

  it('suit l’état lu et non lu', () => {
    const queue = new NewsQueue();
    add(queue, 'A');
    add(queue, 'B');
    expect(queue.unreadCount()).toBe(2);
    const first = queue.latest();
    expect(first).not.toBeNull();
    expect(queue.markRead(first!.id)).toBe(true);
    expect(queue.markRead(first!.id)).toBe(false);
    expect(queue.unreadCount()).toBe(1);
    expect(queue.markAllRead()).toBe(1);
    expect(queue.unreadCount()).toBe(0);
  });

  it('se vide sans conserver la déduplication', () => {
    const queue = new NewsQueue(2);
    add(queue, 'A');
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.unreadCount()).toBe(0);
    add(queue, 'A');
    expect(queue.size).toBe(1);
  });
});
