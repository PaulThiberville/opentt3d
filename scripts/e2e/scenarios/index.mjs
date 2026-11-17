/**
 * Ordre d'exécution des scénarios E2E. Les parcours solo passent en premier
 * (plus rapides à diagnostiquer), puis le réseau et enfin WASM, optionnel.
 */

import { lateJoin } from './late-join.mjs';
import { busStop245 } from './busStop245.mjs';
import { depot233 } from './depot233.mjs';
import { depot247 } from './depot247.mjs';
import { netLocal } from './net-local.mjs';
import { photoMode } from './photo.mjs';
import { reports } from './reports.mjs';
import { roadSlope } from './roadSlope.mjs';
import { saveLoad } from './save-load.mjs';
import { signals } from './signals.mjs';
import { soloMock } from './solo.mjs';
import { bridge243, tunnel244 } from './structures.mjs';
import { wasm } from './wasm.mjs';

export const scenarios = [
  soloMock,
  signals,
  reports,
  photoMode,
  roadSlope,
  busStop245,
  depot233,
  depot247,
  bridge243,
  tunnel244,
  saveLoad,
  netLocal,
  lateJoin,
  wasm,
];
