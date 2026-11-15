/**
 * Choix du moteur côté UI (#78) : état pur, sans DOM.
 *
 * Règles :
 *  - une valeur `?engine=` explicite reste prioritaire (tests, CI, partages) ;
 *  - sinon le réglage persistant `settings.engine` décide ;
 *  - si les artefacts sont confirmés absents (404), l'option WASM est
 *    désactivée et une sélection WASM retombe sur le mock ;
 *  - une simple panne réseau ne désactive rien : la vérification est
 *    « non concluante » et le menu ne doit jamais être bloqué.
 */

import type { EngineArtifacts } from '../engine/engineAssets';
import { engineBuildId, type EngineMode } from '../engine/loadEngine';
import type { TranslationKey } from './i18n';

export interface EngineChoiceOption {
  value: EngineMode;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  /** Identifiant de build affiché à côté de l'option. */
  buildId: string;
  disabled: boolean;
  /** Explication affichée quand l'option est indisponible. */
  reasonKey: TranslationKey | null;
}

export interface EngineChoiceState {
  /** Moteur effectivement sélectionné (éventuellement rétrogradé). */
  mode: EngineMode;
  /** Vrai si `?engine=` impose le choix : les radios sont verrouillées. */
  locked: boolean;
  /** Vrai si la sélection persistée a dû retomber sur le mock. */
  downgraded: boolean;
  options: EngineChoiceOption[];
}

/**
 * Clé i18n de la ligne d'état. `null` = vérification en cours ou inconnue :
 * on affiche le texte « vérification… ».
 */
export function engineArtifactsStatusKey(artifacts: EngineArtifacts | null): TranslationKey {
  if (!artifacts) return 'engine.status.checking';
  switch (artifacts.reason) {
    case 'available':
      return 'engine.status.available';
    case 'missing':
      return 'engine.status.missing';
    default:
      return 'engine.status.network';
  }
}

/** Variables d'interpolation de la ligne d'état. */
export function engineArtifactsStatusVars(artifacts: EngineArtifacts | null): {
  build: string;
  files: string;
} {
  return {
    build: engineBuildId('wasm'),
    files: artifacts?.missing.join(', ') ?? '',
  };
}

/**
 * Options affichées dans les deux écrans. Seul un 404 explicite désactive
 * WASM ; une panne réseau laisse le choix actif (l'utilisateur peut réessayer).
 */
export function engineChoiceOptions(artifacts: EngineArtifacts | null): EngineChoiceOption[] {
  const missing = artifacts?.reason === 'missing';
  const network = artifacts?.reason === 'network';
  return [
    {
      value: 'mock',
      labelKey: 'engine.mock.label',
      hintKey: 'engine.mock.hint',
      buildId: engineBuildId('mock'),
      disabled: false,
      reasonKey: null,
    },
    {
      value: 'wasm',
      labelKey: 'engine.wasm.label',
      hintKey: 'engine.wasm.hint',
      buildId: engineBuildId('wasm'),
      disabled: missing,
      reasonKey: missing ? 'engine.option.missing' : network ? 'engine.option.network' : null,
    },
  ];
}

/**
 * État complet d'un sélecteur. Une URL `?engine=` verrouille les radios et
 * n'est jamais rétrogradée : les tests et la CI doivent obtenir exactement le
 * moteur demandé (même si les artefacts manquent, l'erreur est alors explicite).
 */
export function resolveEngineChoice(input: {
  urlMode: EngineMode | null;
  storedMode: EngineMode;
  artifacts: EngineArtifacts | null;
}): EngineChoiceState {
  const options = engineChoiceOptions(input.artifacts);
  const target = input.urlMode ?? input.storedMode;
  const locked = input.urlMode !== null;
  const option = options.find((entry) => entry.value === target);
  const mode = !locked && option?.disabled ? 'mock' : target;
  return { mode, locked, downgraded: mode !== target, options };
}

/** Vrai si l'option demandée peut être utilisée telle quelle. */
export function isEngineChoiceAvailable(
  artifacts: EngineArtifacts | null,
  mode: EngineMode,
): boolean {
  return engineChoiceOptions(artifacts).find((entry) => entry.value === mode)?.disabled !== true;
}
