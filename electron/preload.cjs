'use strict';
// Pont minimal entre la page sandboxée et l'enveloppe desktop.
//
// Aucune API sensible n'est exposée : uniquement des informations de lecture
// seule, utiles au frontend pour adapter son affichage. Pas d'IPC, pas d'accès
// au système de fichiers, pas de shell. Le jeu reste identique au web.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld(
  'opentt3dDesktop',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    versions: Object.freeze({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }),
  }),
);
