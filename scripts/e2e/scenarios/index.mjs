/**
 * Ordre d'exécution des scénarios E2E. Les parcours solo passent en premier
 * (plus rapides à diagnostiquer), puis le réseau et enfin WASM, optionnel.
 */

import { lateJoin } from './late-join.mjs';
import { netLocal } from './net-local.mjs';
import { photoMode } from './photo.mjs';
import { reports } from './reports.mjs';
import { saveLoad } from './save-load.mjs';
import { soloMock } from './solo.mjs';
import { wasm } from './wasm.mjs';

export const scenarios = [soloMock, reports, photoMode, saveLoad, netLocal, lateJoin, wasm];
