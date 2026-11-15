/**
 * Bus d'événements typé, minimal et sans dépendance.
 *
 * Les abonnements renvoient une fonction de désabonnement ; `clear()` coupe
 * tout, ce qui garantit que `dispose()` ne laisse aucun listener derrière lui.
 */

export type EventMap = Record<string, unknown>;

type AnyListener = (payload: never) => void;

export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(type: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set<AnyListener>();
      this.listeners.set(type, set);
    }
    set.add(listener as AnyListener);
    return () => this.off(type, listener);
  }

  off<K extends keyof Events>(type: K, listener: (payload: Events[K]) => void): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(listener as AnyListener);
    if (set.size === 0) this.listeners.delete(type);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of set) {
      (listener as (value: Events[K]) => void)(payload);
    }
  }

  count(type?: keyof Events): number {
    if (type === undefined) {
      let total = 0;
      for (const set of this.listeners.values()) total += set.size;
      return total;
    }
    return this.listeners.get(type)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
