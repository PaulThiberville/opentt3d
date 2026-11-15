/**
 * Disponibilité des artefacts WASM partagée par les écrans (#78).
 *
 * Le bootstrap lance la détection au démarrage et les écrans s'abonnent : le
 * menu s'affiche immédiatement, puis les radios se mettent à jour quand la
 * réponse arrive. Une panne réseau ne rejette jamais la promesse.
 */

import {
  cachedEngineArtifacts,
  peekEngineArtifacts,
  type EngineArtifacts,
} from '../engine/engineAssets';

export type EngineArtifactsListener = (artifacts: EngineArtifacts) => void;

export interface EngineAvailability {
  /** Dernier résultat connu, `null` tant que la vérification n'a pas abouti. */
  get(): EngineArtifacts | null;
  /** S'abonne aux mises à jour ; renvoie la fonction de désabonnement. */
  subscribe(listener: EngineArtifactsListener): () => void;
  /** Lance (ou rejoint) la vérification partagée. */
  refresh(): Promise<EngineArtifacts>;
}

export interface EngineAvailabilityOptions {
  detect?: () => Promise<EngineArtifacts>;
}

/** Crée un store indépendant (tests) ou branché sur le cache global. */
export function createEngineAvailability(
  options: EngineAvailabilityOptions = {},
): EngineAvailability {
  const detect = options.detect ?? (() => cachedEngineArtifacts());
  const listeners = new Set<EngineArtifactsListener>();
  let current = peekEngineArtifacts();
  let pending: Promise<EngineArtifacts> | null = null;

  const publish = (artifacts: EngineArtifacts): void => {
    current = artifacts;
    for (const listener of [...listeners]) listener(artifacts);
  };

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      if (pending) return pending;
      pending = detect()
        .then((artifacts) => {
          publish(artifacts);
          return artifacts;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}

let shared: EngineAvailability | null = null;

/** Store unique de la page (créé à la première demande). */
export function sharedEngineAvailability(): EngineAvailability {
  shared ??= createEngineAvailability();
  return shared;
}
