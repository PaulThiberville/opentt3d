/**
 * Socle i18n de l'interface : catalogues FR/EN, interpolation simple et
 * langue persistée.
 *
 * Le français est la langue de référence : toute clé absente du catalogue EN
 * retombe sur le texte FR, puis sur la clé elle-même. Le module reste sans
 * dépendance DOM pour les tests ; les helpers `bindText`/`bindAttr` ne font
 * que rafraîchir des nœuds déjà créés quand la langue change.
 *
 * Aucune chaîne n'est interprétée comme du HTML : les valeurs sont toujours
 * injectées via `textContent` ou un attribut.
 */

import type { QualityLevel } from '../render/quality';
import { SETTINGS_STORAGE_KEY, type Language, type StorageLike } from './settings';

export type { Language } from './settings';

export type TranslationVars = Record<string, string | number>;

export const LANGUAGE_STORAGE_KEY = 'opentt3d.language.v1';

/** Langue de référence. Les catalogues doivent exposer exactement ses clés. */
const FR = {
  // Commun ---------------------------------------------------------------
  'common.cancel': 'Annuler',
  'common.close': 'Fermer',
  'common.backToMenu': 'Retour au menu',
  'common.settings': 'Réglages',

  // Menu principal -------------------------------------------------------
  'menu.heroTitle': 'Bâtissez votre empire',
  'menu.heroTagline':
    'Transport Tycoon en 3D : villes vivantes, industries, trains, camions, bateaux et avions sur une carte générée.',
  'menu.badge.mock': 'Moteur mock déterministe',
  'menu.badge.stack': 'DOM + Three.js',
  'menu.badge.license': 'GPL-2.0',
  'menu.navLabel': 'Menu principal',
  'menu.newGame.label': 'Nouvelle partie',
  'menu.newGame.note': 'Solo · monde mock',
  'menu.multiplayer.label': 'Multijoueur',
  'menu.multiplayer.note': 'Salon P2P · création, invitation et chat',
  'menu.load.label': 'Charger une partie',
  'menu.load.note': 'Sauvegardes locales · import de fichier .ot3s',
  'menu.settings.label': 'Réglages',
  'menu.settings.note': 'Qualité, volumes, langue, relais P2P',
  'menu.about.label': 'À propos',
  'menu.about.note': 'Licence, crédits et état du projet',
  'menu.unavailable.note': 'WebGL indisponible',
  'menu.unavailable.fallback': 'Le rendu 3D est indisponible.',
  'menu.footer': 'OpenTT3D · fork 3D d’OpenTTD, non affilié à Transport Tycoon.',
  'menu.footerHint': '↑ ↓ pour naviguer · Entrée pour valider',

  // Réglages -------------------------------------------------------------
  'settings.eyebrow': 'Réglages',
  'settings.title': 'Préférences',
  'settings.subtitle':
    'Les réglages sont enregistrés immédiatement dans ce navigateur (localStorage).',
  'quality.low': 'Faible',
  'quality.medium': 'Moyenne',
  'quality.high': 'Élevée',
  'settings.quality.label': 'Qualité de rendu',
  'settings.quality.hint': 'Appliquée immédiatement à la scène 3D (ombres, distance, végétation).',
  'settings.daynight.label': 'Cycle jour/nuit',
  'settings.daynight.toggle': 'Activer le cycle jour/nuit',
  'settings.daynight.duration': 'Durée d’un cycle',
  'settings.daynight.hint':
    'Le cycle est purement visuel : il n’a aucun effet sur le gameplay. Désactivé, l’heure est figée à midi. 120 s = 2 minutes par journée.',
  'settings.daynight.hintOff':
    'Cycle désactivé : l’heure est figée à midi, la scène reste en plein jour.',
  'settings.language.label': 'Langue de l’interface',
  'settings.language.hint':
    'Le français est la langue de référence ; la traduction anglaise couvre les écrans et le HUD principaux.',
  'settings.language.fr': 'Français',
  'settings.language.en': 'English',
  'settings.volumes.title': 'Volumes (placeholder)',
  'settings.volumes.hint':
    'Les curseurs sont persistés mais aucun moteur audio n’est encore branché.',
  'settings.volume.master': 'Volume général',
  'settings.volume.effects': 'Effets',
  'settings.volume.music': 'Musique',
  'settings.relay.label': 'Relais P2P',
  'settings.relay.hint':
    'Lecture seule pour l’instant : le choix du relais sera exposé avec l’interface de salon.',
  'settings.status.local': 'Réglages enregistrés localement.',
  'settings.status.saved': 'Réglages enregistrés.',
  'settings.done': 'Terminer',

  // Pause ----------------------------------------------------------------
  'pause.eyebrow.paused': 'Partie en pause',
  'pause.eyebrow.network': 'Menu de partie',
  'pause.title.paused': 'Pause',
  'pause.title.network': 'Menu local',
  'pause.subtitle.paused': 'Le temps de jeu est arrêté. Reprenez quand vous voulez.',
  'pause.subtitle.network':
    'La simulation continue en réseau : ce menu ne met que votre affichage en pause. La vitesse est contrôlée par l’hôte.',
  'pause.stats.company': 'Entreprise',
  'pause.stats.date': 'Date',
  'pause.stats.money': 'Trésorerie',
  'pause.stats.vehicles': 'Véhicules',
  'pause.stats.stations': 'Gares et arrêts',
  'pause.resume': 'Reprendre la partie',
  'pause.closeMenu': 'Fermer le menu',
  'pause.save': 'Sauvegarder la partie',
  'pause.load': 'Charger une sauvegarde',
  'pause.networkNote':
    'Les sauvegardes locales sont désactivées pendant une partie réseau : la progression est détenue par l’hôte.',
  'pause.confirm.label': 'Confirmer l’abandon',
  'pause.confirm.text': 'Abandonner cette partie ? La progression non sauvegardée sera perdue.',
  'pause.confirm.ok': 'Confirmer l’abandon',
  'pause.quit': 'Retour au menu',

  // À propos -------------------------------------------------------------
  'about.eyebrow': 'À propos',
  'about.subtitle':
    'Un fork expérimental d’OpenTTD qui conserve la simulation d’origine et remplace la présentation isométrique par une scène Three.js.',
  'about.principles.title': 'Principe',
  'about.principles.engine':
    'Le moteur OpenTTD reste la source de vérité (WASM à terme). Le frontend lit des snapshots, interpole et affiche : l’UI ne simule jamais.',
  'about.principles.mock':
    'Cette vague utilise le MockEngine déterministe : carte, villes, industries, réseaux et véhicules sont générés localement.',
  'about.interface.title': 'Interface',
  'about.interface.stack':
    'DOM + CSS sans framework, écrans et HUD modulaires, navigation clavier et focus visible.',
  'about.interface.safety':
    'Aucun innerHTML avec des données de jeu : seuls textContent et les attributs sont utilisés.',
  'about.tech.title': 'Technique',
  'about.tech.stack': 'Vite 8, TypeScript strict, Three.js 0.187, Vitest 5.',
  'about.tech.render': 'Rendu low-poly stylisé, presets qualité, minimap 2D et panneaux tycoon.',
  'about.license.title': 'Licence',
  'about.license.gpl': 'GPL-2.0-or-later. Projet non affilié à Transport Tycoon ou à Chris Sawyer.',
  'about.license.sources':
    'Les sources du moteur et les crédits complets sont dans le dépôt GitHub.',
  'about.repo': 'Dépôt GitHub',
  'about.wiki': 'Wiki du projet',

  // Chargement -----------------------------------------------------------
  'loading.title': 'Chargement',
  'loading.prepare': 'Préparation du monde…',
  'loading.progressLabel': 'Progression du chargement',
  'loading.cancel': 'Annuler le chargement',
  'loading.cancelling': 'Annulation…',
  'loading.cancellingMessage': 'Annulation en cours…',

  // Fin de partie --------------------------------------------------------
  'gameover.eyebrow': 'Fin de partie',
  'gameover.stats.company': 'Entreprise',
  'gameover.stats.date': 'Date',
  'gameover.stats.money': 'Trésorerie',
  'gameover.stats.value': 'Valeur',
  'gameover.stats.vehicles': 'Véhicules',
  'gameover.stats.stations': 'Gares et arrêts',
  'gameover.note':
    'Écran de démonstration : le moteur mock n’a pas de condition de victoire. Le classement complet et les statistiques arriveront avec le moteur WASM.',
  'gameover.replay': 'Rejouer avec les mêmes options',

  // Déconnexion ----------------------------------------------------------
  'disconnected.eyebrow': 'Réseau',
  'disconnected.title': 'Connexion perdue',
  'disconnected.note':
    'Le transfert de sauvegarde et la reconnexion en cours de partie arriveront avec #38 et #39. Le salon est fermé.',

  // Barre supérieure -----------------------------------------------------
  'topbar.company': 'Entreprise',
  'topbar.money': 'Trésorerie',
  'topbar.flow': 'Flux du jour',
  'topbar.date': 'Date',
  'topbar.speed': 'Vitesse',
  'topbar.fps': 'FPS',
  'topbar.pause': 'Pause',
  'topbar.resume': 'Reprendre',
  'topbar.pauseTooltip': 'Pause (Espace)',
  'topbar.resumeTooltip': 'Reprendre (Espace)',
  'topbar.lockedPause': 'Pause contrôlée par l’hôte en réseau',
  'topbar.lockedSpeed': 'Vitesse contrôlée par l’hôte en réseau',
  'topbar.companyTitle': '{name} · prêt {loan} · valeur {value}',
  'topbar.speedButton': 'Vitesse {speed}×',
  'topbar.speedAria': 'Vitesse {speed}',
  'topbar.qualityTitle': 'Changer la qualité de rendu',
  'topbar.qualityAria': 'Qualité de rendu : {label}. Changer',
  'topbar.news': 'Actualités',
  'topbar.newsTitle': 'Actualités',
  'topbar.reset': 'Recentrer la carte',
  'topbar.resetTitle': 'Recentrer la carte (Début)',
  'topbar.help': 'Aide',
  'topbar.helpTitle': 'Aide et contrôles',
  'topbar.unread.one': '{count} actualité non lue',
  'topbar.unread.other': '{count} actualités non lues',

  // Barre d'outils -------------------------------------------------------
  'toolbar.label': 'Outils de construction',
  'toolbar.labelActive': 'Outils de construction — {tool} actif',
  'toolbar.road.label': 'Routes',
  'toolbar.road.hint': 'Cliquer puis glisser sur la carte pour construire une route.',
  'toolbar.rail.label': 'Rails',
  'toolbar.rail.hint': 'Cliquer puis glisser sur la carte pour construire une voie ferrée.',
  'toolbar.station.label': 'Gares',
  'toolbar.station.hint':
    'Gare ferroviaire ou routière : cliquez pour poser, R pivote, taille dans la barre d’options.',
  'toolbar.depot.label': 'Dépôts',
  'toolbar.depot.hint': 'Dépôt route ou rail : posez-le à côté d’une voie, R oriente l’entrée.',
  'toolbar.signal.label': 'Signaux',
  'toolbar.signal.hint': 'Signal de bloc : cliquez (ou glissez) sur une voie ferrée existante.',
  'toolbar.short.road': 'routes',
  'toolbar.short.rail': 'rails',
  'toolbar.short.station': 'gares',
  'toolbar.short.depot': 'dépôts',
  'toolbar.short.signal': 'signaux',
  'toolbar.activeTooltip': '{label} — outil actif (Échap pour quitter)',

  // Aide -----------------------------------------------------------------
  'help.label': 'Aide et contrôles',
  'help.title': 'Contrôles',
  'help.hint':
    'Minimap : clic pour recentrer. Gares, dépôts et signaux : barre du bas. Un dépôt ouvre l’achat de véhicules et l’éditeur de tournée.',
  'help.controls.orbit.keys': 'Clic droit / Alt + glisser',
  'help.controls.orbit.desc': 'Orbite',
  'help.controls.pan.keys': 'Clic gauche / molette',
  'help.controls.pan.desc': 'Déplacer (hors outil), zoomer',
  'help.controls.move.keys': 'Flèches / WASD',
  'help.controls.move.desc': 'Déplacer la caméra',
  'help.controls.rotate.keys': 'Q / E',
  'help.controls.rotate.desc': 'Pivoter',
  'help.controls.zoom.keys': '+ / −',
  'help.controls.zoom.desc': 'Zoomer',
  'help.controls.home.keys': 'Début (Home)',
  'help.controls.home.desc': 'Recadrer la carte',
  'help.controls.select.keys': 'Clic',
  'help.controls.select.desc': 'Sélectionner',
  'help.controls.follow.keys': 'Double-clic',
  'help.controls.follow.desc': 'Centrer et suivre',
  'help.controls.build.keys': 'Routes / Rails + glisser',
  'help.controls.build.desc': 'Construire un tronçon',
  'help.controls.place.keys': 'Gares / Dépôts / Signaux + clic',
  'help.controls.place.desc': 'Poser une infrastructure',
  'help.controls.rotateBuild.keys': 'R (gare/dépôt)',
  'help.controls.rotateBuild.desc': 'Pivoter l’orientation',
  'help.controls.undo.keys': 'Ctrl + Z',
  'help.controls.undo.desc': 'Démolir la dernière construction',
  'help.controls.cancel.keys': 'Clic droit (construction)',
  'help.controls.cancel.desc': 'Annuler le tracé',
  'help.controls.depot.keys': 'Clic sur un dépôt',
  'help.controls.depot.desc': 'Acheter, vendre ou démarrer un véhicule',
  'help.controls.orders.keys': 'Ajouter une gare',
  'help.controls.orders.desc': 'Puis clic sur une gare/dépôt pour compléter la tournée',
  'help.controls.escape.keys': 'Échap',
  'help.controls.escape.desc': 'Quitter l’outil / pause',
  'help.controls.space.keys': 'Espace',
  'help.controls.space.desc': 'Pause',

  // Sélection ------------------------------------------------------------
  'selection.label': 'Sélection',
  'selection.close': 'Fermer la sélection',
  'selection.none': 'Aucune sélection',
  'selection.followingTitle': 'Suivi caméra',
  'selection.followingDetail': 'Échap pour revenir à la vue carte.',

  // Actualités -----------------------------------------------------------
  'news.label': 'Actualités',
  'news.title': 'Actualités',
  'news.markAll': 'Tout lire',
  'news.markAllTitle': 'Marquer toutes les actualités comme lues',
  'news.close': 'Fermer les actualités',
  'news.unread.one': '{count} non lue',
  'news.unread.other': '{count} non lues',
  'news.upToDate': 'À jour',
  'news.empty': 'Aucune actualité pour le moment.',
  'news.itemAria': 'Actualité : {text}',

  // Minimap --------------------------------------------------------------
  'minimap.label': 'Minimap',
  'minimap.title': 'Minimap',
  'minimap.aria': 'Carte du monde : clic ou Entrée pour recentrer la caméra',
  'minimap.hint': 'Clic / Entrée : recentrer · cadre = caméra',
  'minimap.titleAttr': 'Clic ou Entrée : recentrer la caméra',

  // Toasts ---------------------------------------------------------------
  'toasts.info': 'Information',
  'toasts.warning': 'Avertissement',
  'toasts.error': 'Erreur',
  'toasts.company': 'Entreprise',

  // HUD ------------------------------------------------------------------
  'hud.error': 'Erreur',
  'hud.reload': 'Recharger la page',
  'hud.errorDialog': 'Erreur de rendu',

  // Options de construction ---------------------------------------------
  'build.optionsLabel': 'Options de construction',
  'build.title.station': 'Gare',
  'build.title.depot': 'Dépôt',
  'build.title.signal': 'Signal de bloc',
  'build.rail': 'Rail',
  'build.road': 'Routier',
  'build.route': 'Route',
  'build.stationKind': 'Type de gare',
  'build.depotKind': 'Type de dépôt',
  'build.platforms': 'Quais',
  'build.length': 'Longueur',
  'build.driveThrough': 'En passage',
  'build.blockNote': 'Bloc simple · voie existante requise',
  'build.rotate': 'Pivoter (R)',
  'build.decrease': '{label} : diminuer',
  'build.increase': '{label} : augmenter',
  'build.direction.ne': 'nord-est',
  'build.direction.se': 'sud-est',
  'build.direction.sw': 'sud-ouest',
  'build.direction.nw': 'nord-ouest',

  'format.tilesPerDay': '{value} tuiles/j',
} as const;

export type TranslationKey = keyof typeof FR;

/** Catalogue anglais : mêmes clés que le FR (vérifié par le typage et les tests). */
const EN: Record<TranslationKey, string> = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.backToMenu': 'Back to main menu',
  'common.settings': 'Settings',

  'menu.heroTitle': 'Build your empire',
  'menu.heroTagline':
    'Transport Tycoon in 3D: living towns, industries, trains, trucks, ships and aircraft on a generated map.',
  'menu.badge.mock': 'Deterministic mock engine',
  'menu.badge.stack': 'DOM + Three.js',
  'menu.badge.license': 'GPL-2.0',
  'menu.navLabel': 'Main menu',
  'menu.newGame.label': 'New game',
  'menu.newGame.note': 'Solo · mock world',
  'menu.multiplayer.label': 'Multiplayer',
  'menu.multiplayer.note': 'P2P lobby · create, invite and chat',
  'menu.load.label': 'Load game',
  'menu.load.note': 'Local saves · import .ot3s file',
  'menu.settings.label': 'Settings',
  'menu.settings.note': 'Quality, volume, language, P2P relay',
  'menu.about.label': 'About',
  'menu.about.note': 'License, credits and project status',
  'menu.unavailable.note': 'WebGL unavailable',
  'menu.unavailable.fallback': '3D rendering is unavailable.',
  'menu.footer': 'OpenTT3D · 3D fork of OpenTTD, not affiliated with Transport Tycoon.',
  'menu.footerHint': '↑ ↓ to navigate · Enter to confirm',

  'settings.eyebrow': 'Settings',
  'settings.title': 'Preferences',
  'settings.subtitle': 'Settings are saved immediately in this browser (localStorage).',
  'quality.low': 'Low',
  'quality.medium': 'Medium',
  'quality.high': 'High',
  'settings.quality.label': 'Render quality',
  'settings.quality.hint': 'Applied immediately to the 3D scene (shadows, distance, vegetation).',
  'settings.daynight.label': 'Day/night cycle',
  'settings.daynight.toggle': 'Enable the day/night cycle',
  'settings.daynight.duration': 'Cycle duration',
  'settings.daynight.hint':
    'The cycle is purely visual: it has no effect on gameplay. When disabled, time is frozen at noon. 120 s = 2 minutes per day.',
  'settings.daynight.hintOff':
    'Cycle disabled: time is frozen at noon and the scene stays in daylight.',
  'settings.language.label': 'Interface language',
  'settings.language.hint':
    'French is the reference language; the English translation covers the main screens and HUD.',
  'settings.language.fr': 'Français',
  'settings.language.en': 'English',
  'settings.volumes.title': 'Volumes (placeholder)',
  'settings.volumes.hint': 'Sliders are persisted but no audio engine is connected yet.',
  'settings.volume.master': 'Master volume',
  'settings.volume.effects': 'Effects',
  'settings.volume.music': 'Music',
  'settings.relay.label': 'P2P relay',
  'settings.relay.hint':
    'Read-only for now: relay selection will be exposed with the lobby interface.',
  'settings.status.local': 'Settings saved locally.',
  'settings.status.saved': 'Settings saved.',
  'settings.done': 'Done',

  'pause.eyebrow.paused': 'Game paused',
  'pause.eyebrow.network': 'Game menu',
  'pause.title.paused': 'Pause',
  'pause.title.network': 'Local menu',
  'pause.subtitle.paused': 'Game time is stopped. Resume whenever you like.',
  'pause.subtitle.network':
    'The simulation keeps running online: this menu only pauses your view. Speed is controlled by the host.',
  'pause.stats.company': 'Company',
  'pause.stats.date': 'Date',
  'pause.stats.money': 'Cash',
  'pause.stats.vehicles': 'Vehicles',
  'pause.stats.stations': 'Stations and stops',
  'pause.resume': 'Resume game',
  'pause.closeMenu': 'Close menu',
  'pause.save': 'Save game',
  'pause.load': 'Load a save',
  'pause.networkNote':
    'Local saves are disabled during a network game: progress belongs to the host.',
  'pause.confirm.label': 'Confirm quitting',
  'pause.confirm.text': 'Quit this game? Unsaved progress will be lost.',
  'pause.confirm.ok': 'Confirm quit',
  'pause.quit': 'Back to main menu',

  'about.eyebrow': 'About',
  'about.subtitle':
    'An experimental OpenTTD fork that keeps the original simulation and replaces the isometric presentation with a Three.js scene.',
  'about.principles.title': 'Principles',
  'about.principles.engine':
    'The OpenTTD engine remains the source of truth (WASM eventually). The frontend reads snapshots, interpolates and displays: the UI never simulates.',
  'about.principles.mock':
    'This wave uses the deterministic MockEngine: map, towns, industries, networks and vehicles are generated locally.',
  'about.interface.title': 'Interface',
  'about.interface.stack':
    'Plain DOM + CSS, modular screens and HUD, keyboard navigation and visible focus.',
  'about.interface.safety':
    'No innerHTML with game data: only textContent and attributes are used.',
  'about.tech.title': 'Technical',
  'about.tech.stack': 'Vite 8, strict TypeScript, Three.js 0.187, Vitest 5.',
  'about.tech.render':
    'Stylised low-poly rendering, quality presets, 2D minimap and tycoon panels.',
  'about.license.title': 'License',
  'about.license.gpl': 'GPL-2.0-or-later. Not affiliated with Transport Tycoon or Chris Sawyer.',
  'about.license.sources': 'Engine sources and full credits are in the GitHub repository.',
  'about.repo': 'GitHub repository',
  'about.wiki': 'Project wiki',

  'loading.title': 'Loading',
  'loading.prepare': 'Preparing the world…',
  'loading.progressLabel': 'Loading progress',
  'loading.cancel': 'Cancel loading',
  'loading.cancelling': 'Cancelling…',
  'loading.cancellingMessage': 'Cancelling…',

  'gameover.eyebrow': 'Game over',
  'gameover.stats.company': 'Company',
  'gameover.stats.date': 'Date',
  'gameover.stats.money': 'Cash',
  'gameover.stats.value': 'Value',
  'gameover.stats.vehicles': 'Vehicles',
  'gameover.stats.stations': 'Stations and stops',
  'gameover.note':
    'Demo screen: the mock engine has no victory condition. Full rankings and statistics will arrive with the WASM engine.',
  'gameover.replay': 'Play again with the same options',

  'disconnected.eyebrow': 'Network',
  'disconnected.title': 'Connection lost',
  'disconnected.note':
    'Save transfer and mid-game reconnection will arrive with #38 and #39. The lobby is closed.',

  'topbar.company': 'Company',
  'topbar.money': 'Cash',
  'topbar.flow': 'Today’s flow',
  'topbar.date': 'Date',
  'topbar.speed': 'Speed',
  'topbar.fps': 'FPS',
  'topbar.pause': 'Pause',
  'topbar.resume': 'Resume',
  'topbar.pauseTooltip': 'Pause (Space)',
  'topbar.resumeTooltip': 'Resume (Space)',
  'topbar.lockedPause': 'Pause controlled by the network host',
  'topbar.lockedSpeed': 'Speed controlled by the network host',
  'topbar.companyTitle': '{name} · loan {loan} · value {value}',
  'topbar.speedButton': 'Speed {speed}×',
  'topbar.speedAria': 'Speed {speed}',
  'topbar.qualityTitle': 'Change render quality',
  'topbar.qualityAria': 'Render quality: {label}. Change',
  'topbar.news': 'News',
  'topbar.newsTitle': 'News',
  'topbar.reset': 'Recenter map',
  'topbar.resetTitle': 'Recenter map (Home)',
  'topbar.help': 'Help',
  'topbar.helpTitle': 'Help and controls',
  'topbar.unread.one': '{count} unread news item',
  'topbar.unread.other': '{count} unread news items',

  'toolbar.label': 'Build tools',
  'toolbar.labelActive': 'Build tools — {tool} active',
  'toolbar.road.label': 'Roads',
  'toolbar.road.hint': 'Click then drag on the map to build a road.',
  'toolbar.rail.label': 'Rails',
  'toolbar.rail.hint': 'Click then drag on the map to build a railway.',
  'toolbar.station.label': 'Stations',
  'toolbar.station.hint':
    'Rail or road station: click to place, R rotates, size in the options bar.',
  'toolbar.depot.label': 'Depots',
  'toolbar.depot.hint': 'Road or rail depot: place it next to a track, R flips the entrance.',
  'toolbar.signal.label': 'Signals',
  'toolbar.signal.hint': 'Block signal: click (or drag) on an existing railway.',
  'toolbar.short.road': 'roads',
  'toolbar.short.rail': 'rails',
  'toolbar.short.station': 'stations',
  'toolbar.short.depot': 'depots',
  'toolbar.short.signal': 'signals',
  'toolbar.activeTooltip': '{label} — tool active (Escape to exit)',

  'help.label': 'Help and controls',
  'help.title': 'Controls',
  'help.hint':
    'Minimap: click to recenter. Stations, depots and signals: bottom bar. A depot opens vehicle purchase and the order editor.',
  'help.controls.orbit.keys': 'Right click / Alt + drag',
  'help.controls.orbit.desc': 'Orbit',
  'help.controls.pan.keys': 'Left click / wheel',
  'help.controls.pan.desc': 'Pan (without a tool), zoom',
  'help.controls.move.keys': 'Arrows / WASD',
  'help.controls.move.desc': 'Move the camera',
  'help.controls.rotate.keys': 'Q / E',
  'help.controls.rotate.desc': 'Rotate',
  'help.controls.zoom.keys': '+ / −',
  'help.controls.zoom.desc': 'Zoom',
  'help.controls.home.keys': 'Home',
  'help.controls.home.desc': 'Frame the whole map',
  'help.controls.select.keys': 'Click',
  'help.controls.select.desc': 'Select',
  'help.controls.follow.keys': 'Double click',
  'help.controls.follow.desc': 'Center and follow',
  'help.controls.build.keys': 'Roads / Rails + drag',
  'help.controls.build.desc': 'Build a section',
  'help.controls.place.keys': 'Stations / Depots / Signals + click',
  'help.controls.place.desc': 'Place infrastructure',
  'help.controls.rotateBuild.keys': 'R (station/depot)',
  'help.controls.rotateBuild.desc': 'Rotate orientation',
  'help.controls.undo.keys': 'Ctrl + Z',
  'help.controls.undo.desc': 'Demolish the last build',
  'help.controls.cancel.keys': 'Right click (build)',
  'help.controls.cancel.desc': 'Cancel the drag',
  'help.controls.depot.keys': 'Click a depot',
  'help.controls.depot.desc': 'Buy, sell or start a vehicle',
  'help.controls.orders.keys': 'Add station',
  'help.controls.orders.desc': 'Then click a station/depot to complete the route',
  'help.controls.escape.keys': 'Escape',
  'help.controls.escape.desc': 'Exit tool / pause',
  'help.controls.space.keys': 'Space',
  'help.controls.space.desc': 'Pause',

  'selection.label': 'Selection',
  'selection.close': 'Close selection',
  'selection.none': 'No selection',
  'selection.followingTitle': 'Camera follow',
  'selection.followingDetail': 'Press Escape to return to the map view.',

  'news.label': 'News',
  'news.title': 'News',
  'news.markAll': 'Mark all read',
  'news.markAllTitle': 'Mark all news as read',
  'news.close': 'Close news',
  'news.unread.one': '{count} unread',
  'news.unread.other': '{count} unread',
  'news.upToDate': 'Up to date',
  'news.empty': 'No news yet.',
  'news.itemAria': 'News: {text}',

  'minimap.label': 'Minimap',
  'minimap.title': 'Minimap',
  'minimap.aria': 'World map: click or Enter to recenter the camera',
  'minimap.hint': 'Click / Enter: recenter · frame = camera',
  'minimap.titleAttr': 'Click or Enter: recenter the camera',

  'toasts.info': 'Information',
  'toasts.warning': 'Warning',
  'toasts.error': 'Error',
  'toasts.company': 'Company',

  'hud.error': 'Error',
  'hud.reload': 'Reload the page',
  'hud.errorDialog': 'Rendering error',

  'build.optionsLabel': 'Build options',
  'build.title.station': 'Station',
  'build.title.depot': 'Depot',
  'build.title.signal': 'Block signal',
  'build.rail': 'Rail',
  'build.road': 'Road',
  'build.route': 'Road',
  'build.stationKind': 'Station type',
  'build.depotKind': 'Depot type',
  'build.platforms': 'Platforms',
  'build.length': 'Length',
  'build.driveThrough': 'Drive-through',
  'build.blockNote': 'Single block · existing track required',
  'build.rotate': 'Rotate (R)',
  'build.decrease': '{label}: decrease',
  'build.increase': '{label}: increase',
  'build.direction.ne': 'north-east',
  'build.direction.se': 'south-east',
  'build.direction.sw': 'south-west',
  'build.direction.nw': 'north-west',

  'format.tilesPerDay': '{value} tiles/day',
};

export const CATALOGS: Record<Language, Record<TranslationKey, string>> = { fr: FR, en: EN };

export const TRANSLATION_KEYS = Object.keys(FR) as TranslationKey[];

/** Résout une valeur stockée inconnue en langue supportée. */
export function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'fr';
}

function isLanguage(value: unknown): value is Language {
  return value === 'fr' || value === 'en';
}

function format(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Traduit une clé dans une langue donnée (pur, testable). */
export function translate(language: Language, key: TranslationKey, vars?: TranslationVars): string {
  const template = CATALOGS[language][key] ?? FR[key] ?? key;
  return format(template, vars);
}

/** Traduit une paire singulier/pluriel selon `count`. */
export function plural(
  language: Language,
  count: number,
  one: TranslationKey,
  other: TranslationKey,
  vars?: TranslationVars,
): string {
  return translate(language, count === 1 ? one : other, { count, ...vars });
}

let currentLanguage: Language | null = null;
const listeners = new Set<(language: Language) => void>();

interface Binding {
  ref: WeakRef<HTMLElement>;
  key: TranslationKey;
  vars?: TranslationVars;
  attr?: string;
}

const bindings = new Set<Binding>();

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Lit la langue persistée, avec repli sur le réglage `opentt3d.settings.v1`. */
export function readStoredLanguage(storage: StorageLike | null = storageOrNull()): Language {
  if (!storage) return 'fr';
  try {
    const direct = storage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(direct)) return direct;
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const language = (parsed as Record<string, unknown>).language;
        if (isLanguage(language)) return language;
      }
    }
  } catch {
    // Stockage refusé ou JSON corrompu : on reste en français.
  }
  return 'fr';
}

function syncDocument(language: Language): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dataset.language = language;
}

/** Langue courante (lue depuis le stockage au premier appel). */
export function getLanguage(): Language {
  currentLanguage ??= readStoredLanguage();
  syncDocument(currentLanguage);
  return currentLanguage;
}

function applyBinding(binding: Binding): void {
  const node = binding.ref.deref();
  if (!node) {
    bindings.delete(binding);
    return;
  }
  const value = translate(getLanguage(), binding.key, binding.vars);
  if (binding.attr) node.setAttribute(binding.attr, value);
  else node.textContent = value;
}

/** Applique et suit la langue courante. Renvoie la langue effective. */
export function setLanguage(
  language: Language,
  options: { storage?: StorageLike | null; persist?: boolean } = {},
): Language {
  const next = normalizeLanguage(language);
  currentLanguage = next;
  if (options.persist !== false) {
    const storage = options.storage === undefined ? storageOrNull() : options.storage;
    try {
      storage?.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // Quota ou stockage bloqué : la langue reste active pour la session.
    }
  }
  syncDocument(next);
  for (const binding of Array.from(bindings)) applyBinding(binding);
  for (const listener of Array.from(listeners)) listener(next);
  return next;
}

/** Abonnement aux changements de langue ; renvoie la fonction de nettoyage. */
export function onLanguageChange(listener: (language: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Traduit dans la langue courante. */
export function t(key: TranslationKey, vars?: TranslationVars): string {
  return translate(getLanguage(), key, vars);
}

/** Traduit une paire singulier/pluriel dans la langue courante. */
export function tn(
  count: number,
  one: TranslationKey,
  other: TranslationKey,
  vars?: TranslationVars,
): string {
  return plural(getLanguage(), count, one, other, vars);
}

/** Renseigne le texte d'un nœud et le retraduit si la langue change. */
export function bindText<T extends HTMLElement>(
  node: T,
  key: TranslationKey,
  vars?: TranslationVars,
): T {
  const binding: Binding = { ref: new WeakRef(node), key, vars };
  bindings.add(binding);
  applyBinding(binding);
  return node;
}

/** Renseigne un attribut (aria-label, title…) et le retraduit au changement. */
export function bindAttr<T extends HTMLElement>(
  node: T,
  attr: string,
  key: TranslationKey,
  vars?: TranslationVars,
): T {
  const binding: Binding = { ref: new WeakRef(node), key, vars, attr };
  bindings.add(binding);
  applyBinding(binding);
  return node;
}

const QUALITY_KEYS: Record<QualityLevel, TranslationKey> = {
  low: 'quality.low',
  medium: 'quality.medium',
  high: 'quality.high',
};

/** Libellé localisé d'un preset de rendu (la source reste `render/quality`). */
export function qualityLabel(level: QualityLevel): string {
  return t(QUALITY_KEYS[level]);
}

/** Remet le module à zéro (tests et hot reload). */
export function resetI18n(): void {
  currentLanguage = null;
  bindings.clear();
  listeners.clear();
}
