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
  'menu.live': 'Simulation en direct',

  // Nouvelle partie ------------------------------------------------------
  'newgame.eyebrow': 'Nouvelle partie',
  'newgame.title': 'Générer un monde',
  'newgame.subtitle':
    'La carte, les villes, les industries et les réseaux de départ sont générés de façon déterministe à partir de la graine.',
  'newgame.seed.label': 'Graine',
  'newgame.random': 'Aléatoire',
  'newgame.randomTitle': 'Tirer une nouvelle graine',
  'newgame.seed.hint': 'Entier ou hexadécimal (0x…). Une même graine donne le même monde.',
  'newgame.size.label': 'Taille de carte',
  'newgame.size.hint':
    '128 pour une partie rapide, 256 pour l’expérience par défaut, 512 pour une grande carte. Le moteur WASM exige des puissances de 2.',
  'newgame.quality.label': 'Qualité de rendu',
  'newgame.quality.hint': 'Peut être changée en jeu depuis le HUD ou les réglages.',
  'newgame.difficulty.label': 'Difficulté',
  'newgame.difficulty.hint': 'Transmise au moteur ; l’effet complet arrive avec le WASM.',
  'newgame.ai.label': 'Entreprises IA',
  'newgame.ai.none': 'Aucune (bac à sable)',
  'newgame.ai.one': '{count} entreprise IA',
  'newgame.ai.other': '{count} entreprises IA',
  'newgame.climate.label': 'Climat',
  'newgame.year.label': 'Année de départ',
  'newgame.back': 'Retour',
  'newgame.start': 'Démarrer la partie',
  'newgame.footer': 'Astuce : Échap revient au menu. Aucune donnée n’est envoyée sur le réseau.',
  'newgame.engine.label': 'Moteur',
  'newgame.engine.hint':
    'Choisit le moteur de cette partie. Une sauvegarde conserve le moteur qui l’a créée.',
  'engine.mock.label': 'Mock (démo)',
  'engine.wasm.label': 'OpenTTD réel (expérimental)',
  'engine.mock.hint': 'Simulation locale déterministe, sans artefact requis.',
  'engine.wasm.hint':
    'OpenTTD compilé en WebAssembly. Climat, IA et économie viennent du moteur réel ; certaines fonctions restent partielles.',
  'engine.status.checking': 'Vérification des artefacts du moteur…',
  'engine.status.available': 'Artefacts WASM détectés · {build}',
  'engine.status.missing':
    'Artefacts WASM absents ({files}). Lancez npm run engine:build puis rechargez la page.',
  'engine.status.network':
    'Vérification des artefacts impossible (réseau). Le mode mock reste disponible.',
  'engine.option.missing': 'Indisponible : les fichiers WASM sont absents.',
  'engine.option.network':
    'Vérification réseau impossible : le moteur peut malgré tout fonctionner.',
  'engine.locked.url': 'Moteur imposé par l’URL (?engine={mode}) : le choix est verrouillé.',
  'settings.engine.label': 'Moteur des nouvelles parties',
  'settings.engine.hint':
    'Appliqué aux prochaines parties solo. Une partie en cours et le réseau gardent leur moteur d’origine.',
  'difficulty.easy': 'Facile',
  'difficulty.normal': 'Normale',
  'difficulty.hard': 'Difficile',
  'difficulty.expert': 'Expert',
  'climate.temperate': 'Tempéré',
  'climate.subarctic': 'Subarctique',
  'climate.subtropical': 'Subtropical',
  'climate.toyland': 'Jouet',

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
  'settings.intro.label': 'Intro cinématique',
  'settings.intro.toggle': 'Jouer l’intro au lancement d’une partie',
  'settings.intro.hint':
    'Survol doux de la carte pendant quelques secondes, coupable au clic ou à la touche. Ignorée si le système demande des animations réduites.',
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
    'Automatique par défaut (relais publics Trystero). Liste personnalisée : ajoutez ?relays=wss://relais-1,wss://relais-2 à l’URL. TURN n’est pas fourni : certains NAT symétriques restent bloqués.',
  'settings.relay.auto': 'Automatique (Trystero)',
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
  'loading.eyebrow': 'Initialisation du monde',
  'loading.prepare': 'Préparation du monde…',
  'loading.progressLabel': 'Progression du chargement',
  'loading.progressShort': 'Progression',
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

  // Réseau (#39) ---------------------------------------------------------
  'net.pair': 'pair {id}',
  'net.pairUnknown': 'un pair',
  'net.listAnd': 'et',
  'net.status.host': 'Hôte · tick {tick} · {peers} · {metrics} · {resync}',
  'net.status.guest': 'Invité · {metrics} · tick {tick} · {peers} · {resync}',
  'net.status.peerOne': '{count} joueur',
  'net.status.peerOther': '{count} joueurs',
  'net.status.ping': 'ping {value} ms',
  'net.status.pingPending': 'ping…',
  'net.status.loss': 'perte {value} %',
  'net.status.delay': 'retard {value} s',
  'net.status.resyncNone': 'aucun resync',
  'net.status.resyncOne': '{count} resync',
  'net.status.resyncOther': '{count} resync',
  'net.status.waitingHost': 'En attente de {who}…',
  'net.status.waitingTurn': 'En attente du tour de l’hôte…',
  'net.status.peerLost': 'Pause réseau : {who} ne répond plus…',
  'net.status.hostLost': 'Hôte injoignable — élection d’un nouvel hôte…',
  'net.status.join': 'Synchronisation de {who}…',
  'net.status.lost': 'Hôte perdu — reconnexion impossible',
  'net.alert.title': 'Pair hors ligne',
  'net.alert.hostDetail':
    '{who} ne répond plus. La partie est en pause ; vous pouvez continuer sans ce joueur ou attendre. Reprise automatique dans {seconds} s.',
  'net.alert.guestDetail':
    '{who} ne répond plus. La partie est en pause : l’hôte décide de continuer sans ce joueur ou d’attendre.',
  'net.alert.continue': 'Continuer sans ce joueur',
  'net.alert.wait': 'Attendre encore',
  'net.notice.host-migration': 'Ce pair reprend l’hébergement de la partie.',
  'net.notice.host-unreachable':
    'L’hôte ne répond plus : recherche d’un nouveau pair pour reprendre la partie…',
  'net.notice.host-yield': 'Un autre pair a repris l’hébergement de la partie.',
  'net.notice.peer-resumed': 'La partie reprend sans les joueurs hors ligne.',
  'net.notice.desync': 'Divergence détectée : resynchronisation avec l’hôte…',
  'net.lost.hud': 'Hôte perdu : la session réseau est interrompue.',
  'net.lost.reason':
    'L’hôte a disparu et aucun autre joueur n’a pu prendre le relais. La partie réseau est arrêtée.',
  'net.chatFallback': 'Joueur',
  'net.notice.transport-error':
    'Réseau : {detail} Vérifiez le pare-feu/NAT ou configurez d’autres relais Nostr.',
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

  // Mode photo -----------------------------------------------------------
  'photo.open': 'Mode photo (P)',
  'photo.title': 'Mode photo',
  'photo.hint':
    'Glisser : orbite · Molette : zoom · 1/2/3 : carte, rue, train · C : capture · P ou Échap : quitter',
  'photo.capture': 'Capturer (C)',
  'photo.exit': 'Quitter (P)',
  'photo.captured': 'Capture enregistrée',
  'photo.preset.map': 'Carte',
  'photo.preset.street': 'Rue',
  'photo.preset.train': 'Train',
  'intro.skip': 'Clic ou touche pour passer l’intro',

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
  'hud.audio.mute': 'Couper le son',
  'hud.audio.unmute': 'Rétablir le son',

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
  'build.tool.clear': 'Démolition',
  'build.hint.road': 'cliquez ou glissez d’une tuile à l’autre',
  'build.hint.rail': 'cliquez ou glissez d’une tuile à l’autre',
  'build.hint.clear': 'cliquez ou glissez pour démolir un tronçon',
  'build.hint.station': 'choisissez taille et orientation, puis cliquez pour poser',
  'build.hint.depot': 'cliquez à côté d’une voie',
  'build.hint.signal': 'cliquez ou glissez le long d’une voie ferrée',
  'build.idle': '{label} : {hint}{rotate} · clic droit annule · Échap quitte',
  'build.idle.rotate': ' · R pivote',
  'build.valid': '{label} : {detail}{count} · {cost}',
  'build.station.detail': '{station} · ',
  'build.invalid': '{label} : impossible — {reason}',
  'build.invalid.reason': 'tracé invalide',
  'build.station.generic': 'Gare',
  'build.station.road': 'Gare routière',
  'build.station.roadThrough': 'Gare routière en passage',
  'build.station.rail': 'Gare ferroviaire {width}×{height}',
  'build.count.tile.one': '{count} tuile',
  'build.count.tile.other': '{count} tuiles',
  'build.count.signal.one': '{count} signal',
  'build.count.signal.other': '{count} signaux',

  // Sauvegardes -------------------------------------------------------
  'save.eyebrow': 'Sauvegardes locales',
  'save.title.both': 'Sauvegarder / Charger',
  'save.title.load': 'Charger une partie',
  'save.subtitle.both':
    'Vos sauvegardes restent dans ce navigateur. Exportez un conteneur .ot3s pour la conserver ailleurs.',
  'save.subtitle.load':
    'Reprenez une partie enregistrée dans ce navigateur, ou importez un conteneur .ot3s exporté depuis une autre machine.',
  'save.storage.opening': 'Ouverture du stockage local…',
  'save.storage.indexed': 'Stockage local IndexedDB',
  'save.storage.memory': 'Stockage mémoire (session uniquement)',
  'save.storage.usage': '{base} · {usage} utilisés sur {quota}.',
  'save.list.title': 'Sauvegardes',
  'save.list.hint': 'Autosave toutes les 5 min · 3 slots conservés.',
  'save.list.loading': 'Chargement des sauvegardes…',
  'save.import': 'Importer un fichier…',
  'save.import.hint':
    'Conteneur .ot3s ou sauvegarde mock .json · 32 Mio maximum · validé avant écriture.',
  'save.current.title': 'Sauvegarder la partie en cours',
  'save.saveNow': 'Sauvegarder maintenant',
  'save.empty.title': 'Aucune sauvegarde locale.',
  'save.empty.both': 'Nommez la partie ci-dessus puis cliquez sur « Sauvegarder maintenant ».',
  'save.empty.load':
    'Lancez une partie, ouvrez la pause puis « Sauvegarder ». Vous pouvez aussi importer un fichier.',
  'save.tag.autosave': 'Autosave',
  'save.tag.import': 'Import',
  'save.detail.date': 'Date de jeu : {date}',
  'save.detail.dateUnknown': 'Date de jeu inconnue',
  'save.detail.map': 'Carte {size}×{size}',
  'save.detail.seed': 'Graine {seed}',
  'save.detail.tick': 'Tick {tick}',
  'save.detail.companies': 'Entreprises : {names}',
  'save.detail.created': 'Enregistré le {date}',
  'save.action.load': 'Charger',
  'save.action.export': 'Exporter',
  'save.action.delete': 'Supprimer',
  'save.back.pause': 'Retour à la pause',
  'save.reading': 'Lecture de « {name} »…',
  'save.missing': 'Cette sauvegarde n’existe plus dans le stockage local.',
  'save.exported': 'Fichier exporté : {name}.',

  // Dépôt et véhicule ------------------------------------------------
  'depot.label': 'Dépôt',
  'depot.close': 'Fermer le dépôt',
  'depot.headerDetail': 'Achat et gestion · {detail}',
  'depot.models': 'Modèles disponibles',
  'depot.modelSpecs': '{cargo} · {capacity} unités · {speed} tuiles/j',
  'depot.maintenance': 'entretien {value} £/an',
  'depot.buy': 'Acheter',
  'depot.buyTitle': 'Acheter {name}',
  'depot.buyBlocked': 'Trésorerie insuffisante pour {name}',
  'depot.buyAria': 'Acheter {name} pour {value} livres',
  'depot.none': 'Aucun modèle disponible.',
  'depot.vehicles': 'Véhicules sur place',
  'depot.select': 'Sélectionner',
  'depot.start': 'Démarrer',
  'depot.startTitle': 'Démarrer la tournée',
  'depot.startBlocked': 'Ajoutez d’abord une gare à la tournée',
  'depot.sell': 'Vendre',
  'depot.noVehicles': 'Aucun véhicule dans ce dépôt.',
  'depot.kind': 'Dépôt',
  'vehicle.label': 'Véhicule sélectionné',
  'vehicle.orderTitle': 'Tournée',
  'vehicle.noOrders': 'Aucun ordre pour l’instant.',
  'vehicle.stop': 'Arrêter',
  'vehicle.stopTitle': 'Arrêter le véhicule sur place',
  'vehicle.addOrder': 'Ajouter une gare',
  'vehicle.cancelOrder': 'Annuler l’ajout',
  'vehicle.startBlocked': 'Ajoutez au moins un ordre avant de démarrer',
  'vehicle.orderPickTitle': 'Cliquer ensuite sur une gare ou un dépôt de la carte',
  'vehicle.orderUpTitle': 'Monter l’ordre',
  'vehicle.orderDownTitle': 'Descendre l’ordre',
  'vehicle.orderRemoveTitle': 'Retirer cet ordre',
  'vehicle.orderUpAria': 'Monter l’ordre {index}',
  'vehicle.orderDownAria': 'Descendre l’ordre {index}',
  'vehicle.orderRemoveAria': 'Retirer l’ordre {index}',

  // Sélection et libellés du protocole --------------------------------
  'selection.vacant': 'Vide',
  'selection.noWaiting': 'Aucune',
  'selection.noStock': 'Aucun',
  'selection.unknownCompany': 'Entreprise inconnue',
  'selection.vehicleTitle': 'Véhicule #{id} — {kind}',
  'selection.townDetail': '{population} habitants · {buildings} bâtiments',
  'selection.industryDetail': '{kind} · production {value}',
  'selection.stationDetail': '{kind} · {count} unités en attente',
  'selection.tile': 'Tuile',
  'selection.tileCoords': 'Tuile ({x}, {y})',
  'selection.tileSelected': 'Sélectionnée sur la carte',
  'selection.mapNotLoaded': 'Carte non chargée',
  'selection.tileDetail': '{type} · hauteur {height}',
  'selection.ownerNone': 'Aucune',
  'selection.stat.type': 'Type',
  'selection.stat.speed': 'Vitesse',
  'selection.stat.cargo': 'Cargaison',
  'selection.stat.status': 'Statut',
  'selection.stat.profit': 'Bénéfice',
  'selection.stat.age': 'Âge',
  'selection.stat.population': 'Population',
  'selection.stat.buildings': 'Bâtiments',
  'selection.stat.growth': 'Croissance',
  'selection.stat.rating': 'Note',
  'selection.stat.production': 'Production',
  'selection.stat.transported': 'Transporté',
  'selection.stat.stocks': 'Stocks',
  'selection.stat.waiting': 'Attente',
  'selection.stat.cargoes': 'Cargaisons',
  'selection.stat.company': 'Entreprise',
  'selection.stat.height': 'Hauteur',
  'selection.stat.owner': 'Propriétaire',
  'selection.stat.coords': 'Coordonnées',
  'selection.unit.days': '{value} j',
  'selection.unit.perDay': '+{value}/jour',
  'selection.unit.units': '{count} unités',

  'label.vehicle.train': 'Train',
  'label.vehicle.road': 'Véhicule routier',
  'label.vehicle.ship': 'Bateau',
  'label.vehicle.aircraft': 'Avion',
  'label.station.train': 'Gare',
  'label.station.road': 'Arrêt',
  'label.station.ship': 'Dock',
  'label.station.airport': 'Aéroport',
  'label.station.buoy': 'Bouée',
  'label.cargo.passengers': 'Voyageurs',
  'label.cargo.mail': 'Courrier',
  'label.cargo.coal': 'Charbon',
  'label.cargo.wood': 'Bois',
  'label.cargo.grain': 'Céréales',
  'label.cargo.goods': 'Marchandises',
  'label.cargo.oil': 'Pétrole',
  'label.cargo.livestock': 'Bétail',
  'label.cargo.valuables': 'Objets de valeur',
  'label.cargo.iron_ore': 'Minerai de fer',
  'label.cargo.steel': 'Acier',
  'label.cargo.water': 'Eau',
  'label.cargo.fruit': 'Fruits',
  'label.cargo.maize': 'Maïs',
  'label.cargo.food': 'Nourriture',
  'label.status.stopped': 'à l’arrêt',
  'label.status.route': 'en route',
  'label.status.station': 'en gare',
  'label.status.depot': 'en dépôt',
  'label.status.waiting': 'en attente',
  'label.status.unknown': 'état inconnu',
  'label.tile.void': 'Vide',
  'label.tile.clear': 'Terrain dégagé',
  'label.tile.grass': 'Herbe',
  'label.tile.rough': 'Broussailles',
  'label.tile.water': 'Eau',
  'label.tile.coast': 'Côte',
  'label.tile.rail': 'Voie ferrée',
  'label.tile.road': 'Route',
  'label.tile.house': 'Bâtiment',
  'label.tile.trees': 'Arbres',
  'label.tile.station': 'Gare',
  'label.tile.industry': 'Industrie',
  'label.tile.bridge': 'Pont',
  'label.tile.tunnel': 'Tunnel',
  'label.tile.object': 'Objet',
  'label.tile.airport': 'Aéroport',
  'label.tile.dock': 'Dock',
  'label.tile.canal': 'Canal',
  'label.tile.river': 'Rivière',
  'label.industry.coal_mine': 'Mine de charbon',
  'label.industry.power_station': 'Centrale électrique',
  'label.industry.sawmill': 'Scierie',
  'label.industry.farm': 'Ferme',
  'label.industry.factory': 'Usine',
  'label.industry.oil_well': 'Puits de pétrole',
  'label.industry.refinery': 'Raffinerie',
  'label.industry.steel_mill': 'Aciérie',
  'label.industry.forest': 'Forêt',

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
  'menu.live': 'Live simulation',

  'newgame.eyebrow': 'New game',
  'newgame.title': 'Generate a world',
  'newgame.subtitle':
    'The map, towns, industries and starting networks are generated deterministically from the seed.',
  'newgame.seed.label': 'Seed',
  'newgame.random': 'Random',
  'newgame.randomTitle': 'Draw a new seed',
  'newgame.seed.hint': 'Integer or hexadecimal (0x…). The same seed yields the same world.',
  'newgame.size.label': 'Map size',
  'newgame.size.hint':
    '128 for a quick game, 256 for the default experience, 512 for a large map. The WASM engine requires powers of two.',
  'newgame.quality.label': 'Render quality',
  'newgame.quality.hint': 'Can be changed in game from the HUD or the settings.',
  'newgame.difficulty.label': 'Difficulty',
  'newgame.difficulty.hint': 'Passed to the engine; the full effect arrives with WASM.',
  'newgame.ai.label': 'AI companies',
  'newgame.ai.none': 'None (sandbox)',
  'newgame.ai.one': '{count} AI company',
  'newgame.ai.other': '{count} AI companies',
  'newgame.climate.label': 'Climate',
  'newgame.year.label': 'Start year',
  'newgame.back': 'Back',
  'newgame.start': 'Start game',
  'newgame.footer': 'Tip: Escape returns to the menu. No data is sent over the network.',
  'newgame.engine.label': 'Engine',
  'newgame.engine.hint':
    'Chooses the engine for this game. A save keeps the engine that created it.',
  'engine.mock.label': 'Mock (demo)',
  'engine.wasm.label': 'Real OpenTTD (experimental)',
  'engine.mock.hint': 'Deterministic local simulation, no artifact required.',
  'engine.wasm.hint':
    'OpenTTD compiled to WebAssembly. Climate, AI and economy come from the real engine; some features remain partial.',
  'engine.status.checking': 'Checking engine artifacts…',
  'engine.status.available': 'WASM artifacts detected · {build}',
  'engine.status.missing':
    'WASM artifacts missing ({files}). Run npm run engine:build then reload the page.',
  'engine.status.network': 'Could not check artifacts (network). Mock mode remains available.',
  'engine.option.missing': 'Unavailable: WASM files are missing.',
  'engine.option.network': 'Network check failed: the engine may still work.',
  'engine.locked.url': 'Engine forced by the URL (?engine={mode}): the choice is locked.',
  'settings.engine.label': 'Engine for new games',
  'settings.engine.hint':
    'Applies to future solo games. A running game and network sessions keep their original engine.',
  'difficulty.easy': 'Easy',
  'difficulty.normal': 'Normal',
  'difficulty.hard': 'Hard',
  'difficulty.expert': 'Expert',
  'climate.temperate': 'Temperate',
  'climate.subarctic': 'Subarctic',
  'climate.subtropical': 'Subtropical',
  'climate.toyland': 'Toyland',

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
  'settings.intro.label': 'Cinematic intro',
  'settings.intro.toggle': 'Play the intro when a game starts',
  'settings.intro.hint':
    'A gentle flyover for a few seconds, skipped by click or key. Ignored when the system asks for reduced motion.',
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
    'Automatic by default (public Trystero relays). Custom list: append ?relays=wss://relay-1,wss://relay-2 to the URL. TURN is not provided: some symmetric NATs remain blocked.',
  'settings.relay.auto': 'Automatic (Trystero)',
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
  'loading.eyebrow': 'Initialising the world',
  'loading.prepare': 'Preparing the world…',
  'loading.progressLabel': 'Loading progress',
  'loading.progressShort': 'Progress',
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

  // Network (#39) --------------------------------------------------------
  'net.pair': 'peer {id}',
  'net.pairUnknown': 'a peer',
  'net.listAnd': 'and',
  'net.status.host': 'Host · tick {tick} · {peers} · {metrics} · {resync}',
  'net.status.guest': 'Guest · {metrics} · tick {tick} · {peers} · {resync}',
  'net.status.peerOne': '{count} player',
  'net.status.peerOther': '{count} players',
  'net.status.ping': 'ping {value} ms',
  'net.status.pingPending': 'ping…',
  'net.status.loss': '{value} % loss',
  'net.status.delay': '{value} s delay',
  'net.status.resyncNone': 'no resync',
  'net.status.resyncOne': '{count} resync',
  'net.status.resyncOther': '{count} resyncs',
  'net.status.waitingHost': 'Waiting for {who}…',
  'net.status.waitingTurn': 'Waiting for the host’s turn…',
  'net.status.peerLost': 'Network pause: {who} stopped responding…',
  'net.status.hostLost': 'Host unreachable — electing a new host…',
  'net.status.join': 'Synchronising {who}…',
  'net.status.lost': 'Host lost — reconnection impossible',
  'net.alert.title': 'Peer offline',
  'net.alert.hostDetail':
    '{who} stopped responding. The game is paused; you can continue without this player or wait. Automatic resume in {seconds} s.',
  'net.alert.guestDetail':
    '{who} stopped responding. The game is paused: the host decides to continue without this player or to wait.',
  'net.alert.continue': 'Continue without this player',
  'net.alert.wait': 'Wait longer',
  'net.notice.host-migration': 'This peer is now hosting the game.',
  'net.notice.host-unreachable': 'The host stopped responding: looking for a new host…',
  'net.notice.host-yield': 'Another peer took over hosting the game.',
  'net.notice.peer-resumed': 'The game resumes without the offline players.',
  'net.notice.desync': 'Divergence detected: resynchronising with the host…',
  'net.lost.hud': 'Host lost: the network session is interrupted.',
  'net.lost.reason':
    'The host disappeared and no other player could take over. The network game has stopped.',
  'net.chatFallback': 'Player',
  'net.notice.transport-error':
    'Network: {detail} Check your firewall/NAT or configure other Nostr relays.',
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

  // Photo mode -----------------------------------------------------------
  'photo.open': 'Photo mode (P)',
  'photo.title': 'Photo mode',
  'photo.hint':
    'Drag: orbit · Wheel: zoom · 1/2/3: map, street, train · C: capture · P or Escape: exit',
  'photo.capture': 'Capture (C)',
  'photo.exit': 'Exit (P)',
  'photo.captured': 'Capture saved',
  'photo.preset.map': 'Map',
  'photo.preset.street': 'Street',
  'photo.preset.train': 'Train',
  'intro.skip': 'Click or press a key to skip the intro',

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
  'hud.audio.mute': 'Mute sound',
  'hud.audio.unmute': 'Unmute sound',

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
  'build.tool.clear': 'Demolish',
  'build.hint.road': 'click or drag from one tile to the next',
  'build.hint.rail': 'click or drag from one tile to the next',
  'build.hint.clear': 'click or drag to demolish a section',
  'build.hint.station': 'choose size and orientation, then click to place',
  'build.hint.depot': 'click next to a track',
  'build.hint.signal': 'click or drag along a railway',
  'build.idle': '{label}: {hint}{rotate} · right click cancels · Escape exits',
  'build.idle.rotate': ' · R rotates',
  'build.valid': '{label}: {detail}{count} · {cost}',
  'build.station.detail': '{station} · ',
  'build.invalid': '{label}: impossible — {reason}',
  'build.invalid.reason': 'invalid layout',
  'build.station.generic': 'Station',
  'build.station.road': 'Road station',
  'build.station.roadThrough': 'Drive-through road station',
  'build.station.rail': 'Rail station {width}×{height}',
  'build.count.tile.one': '{count} tile',
  'build.count.tile.other': '{count} tiles',
  'build.count.signal.one': '{count} signal',
  'build.count.signal.other': '{count} signals',

  'save.eyebrow': 'Local saves',
  'save.title.both': 'Save / Load',
  'save.title.load': 'Load game',
  'save.subtitle.both':
    'Your saves stay in this browser. Export an .ot3s container to keep them elsewhere.',
  'save.subtitle.load':
    'Resume a game saved in this browser, or import an .ot3s container exported from another machine.',
  'save.storage.opening': 'Opening local storage…',
  'save.storage.indexed': 'IndexedDB local storage',
  'save.storage.memory': 'In-memory storage (this session only)',
  'save.storage.usage': '{base} · {usage} used of {quota}.',
  'save.list.title': 'Saves',
  'save.list.hint': 'Autosave every 5 min · 3 slots kept.',
  'save.list.loading': 'Loading saves…',
  'save.import': 'Import a file…',
  'save.import.hint':
    '.ot3s container or mock .json save · 32 MiB maximum · validated before writing.',
  'save.current.title': 'Save the current game',
  'save.saveNow': 'Save now',
  'save.empty.title': 'No local save.',
  'save.empty.both': 'Name the game above, then click “Save now”.',
  'save.empty.load': 'Start a game, open the pause menu, then “Save”. You can also import a file.',
  'save.tag.autosave': 'Autosave',
  'save.tag.import': 'Import',
  'save.detail.date': 'Game date: {date}',
  'save.detail.dateUnknown': 'Unknown game date',
  'save.detail.map': 'Map {size}×{size}',
  'save.detail.seed': 'Seed {seed}',
  'save.detail.tick': 'Tick {tick}',
  'save.detail.companies': 'Companies: {names}',
  'save.detail.created': 'Saved on {date}',
  'save.action.load': 'Load',
  'save.action.export': 'Export',
  'save.action.delete': 'Delete',
  'save.back.pause': 'Back to pause',
  'save.reading': 'Reading “{name}”…',
  'save.missing': 'This save no longer exists in local storage.',
  'save.exported': 'File exported: {name}.',

  'depot.label': 'Depot',
  'depot.close': 'Close depot',
  'depot.headerDetail': 'Purchase and management · {detail}',
  'depot.models': 'Available models',
  'depot.modelSpecs': '{cargo} · {capacity} units · {speed} tiles/day',
  'depot.maintenance': 'maintenance {value} £/year',
  'depot.buy': 'Buy',
  'depot.buyTitle': 'Buy {name}',
  'depot.buyBlocked': 'Not enough cash for {name}',
  'depot.buyAria': 'Buy {name} for {value} pounds',
  'depot.none': 'No model available.',
  'depot.vehicles': 'Vehicles on site',
  'depot.select': 'Select',
  'depot.start': 'Start',
  'depot.startTitle': 'Start the route',
  'depot.startBlocked': 'Add a station to the route first',
  'depot.sell': 'Sell',
  'depot.noVehicles': 'No vehicle in this depot.',
  'depot.kind': 'Depot',
  'vehicle.label': 'Selected vehicle',
  'vehicle.orderTitle': 'Route',
  'vehicle.noOrders': 'No order yet.',
  'vehicle.stop': 'Stop',
  'vehicle.stopTitle': 'Stop the vehicle here',
  'vehicle.addOrder': 'Add a station',
  'vehicle.cancelOrder': 'Cancel add',
  'vehicle.startBlocked': 'Add at least one order before starting',
  'vehicle.orderPickTitle': 'Then click a station or depot on the map',
  'vehicle.orderUpTitle': 'Move order up',
  'vehicle.orderDownTitle': 'Move order down',
  'vehicle.orderRemoveTitle': 'Remove this order',
  'vehicle.orderUpAria': 'Move order {index} up',
  'vehicle.orderDownAria': 'Move order {index} down',
  'vehicle.orderRemoveAria': 'Remove order {index}',

  'selection.vacant': 'Empty',
  'selection.noWaiting': 'None',
  'selection.noStock': 'None',
  'selection.unknownCompany': 'Unknown company',
  'selection.vehicleTitle': 'Vehicle #{id} — {kind}',
  'selection.townDetail': '{population} inhabitants · {buildings} buildings',
  'selection.industryDetail': '{kind} · production {value}',
  'selection.stationDetail': '{kind} · {count} units waiting',
  'selection.tile': 'Tile',
  'selection.tileCoords': 'Tile ({x}, {y})',
  'selection.tileSelected': 'Selected on the map',
  'selection.mapNotLoaded': 'Map not loaded',
  'selection.tileDetail': '{type} · height {height}',
  'selection.ownerNone': 'None',
  'selection.stat.type': 'Type',
  'selection.stat.speed': 'Speed',
  'selection.stat.cargo': 'Cargo',
  'selection.stat.status': 'Status',
  'selection.stat.profit': 'Profit',
  'selection.stat.age': 'Age',
  'selection.stat.population': 'Population',
  'selection.stat.buildings': 'Buildings',
  'selection.stat.growth': 'Growth',
  'selection.stat.rating': 'Rating',
  'selection.stat.production': 'Production',
  'selection.stat.transported': 'Transported',
  'selection.stat.stocks': 'Stocks',
  'selection.stat.waiting': 'Waiting',
  'selection.stat.cargoes': 'Cargoes',
  'selection.stat.company': 'Company',
  'selection.stat.height': 'Height',
  'selection.stat.owner': 'Owner',
  'selection.stat.coords': 'Coordinates',
  'selection.unit.days': '{value} d',
  'selection.unit.perDay': '+{value}/day',
  'selection.unit.units': '{count} units',

  'label.vehicle.train': 'Train',
  'label.vehicle.road': 'Road vehicle',
  'label.vehicle.ship': 'Ship',
  'label.vehicle.aircraft': 'Aircraft',
  'label.station.train': 'Station',
  'label.station.road': 'Stop',
  'label.station.ship': 'Dock',
  'label.station.airport': 'Airport',
  'label.station.buoy': 'Buoy',
  'label.cargo.passengers': 'Passengers',
  'label.cargo.mail': 'Mail',
  'label.cargo.coal': 'Coal',
  'label.cargo.wood': 'Wood',
  'label.cargo.grain': 'Grain',
  'label.cargo.goods': 'Goods',
  'label.cargo.oil': 'Oil',
  'label.cargo.livestock': 'Livestock',
  'label.cargo.valuables': 'Valuables',
  'label.cargo.iron_ore': 'Iron ore',
  'label.cargo.steel': 'Steel',
  'label.cargo.water': 'Water',
  'label.cargo.fruit': 'Fruit',
  'label.cargo.maize': 'Maize',
  'label.cargo.food': 'Food',
  'label.status.stopped': 'stopped',
  'label.status.route': 'en route',
  'label.status.station': 'at station',
  'label.status.depot': 'in depot',
  'label.status.waiting': 'waiting',
  'label.status.unknown': 'unknown state',
  'label.tile.void': 'Empty',
  'label.tile.clear': 'Clear ground',
  'label.tile.grass': 'Grass',
  'label.tile.rough': 'Scrub',
  'label.tile.water': 'Water',
  'label.tile.coast': 'Coast',
  'label.tile.rail': 'Railway',
  'label.tile.road': 'Road',
  'label.tile.house': 'Building',
  'label.tile.trees': 'Trees',
  'label.tile.station': 'Station',
  'label.tile.industry': 'Industry',
  'label.tile.bridge': 'Bridge',
  'label.tile.tunnel': 'Tunnel',
  'label.tile.object': 'Object',
  'label.tile.airport': 'Airport',
  'label.tile.dock': 'Dock',
  'label.tile.canal': 'Canal',
  'label.tile.river': 'River',
  'label.industry.coal_mine': 'Coal mine',
  'label.industry.power_station': 'Power station',
  'label.industry.sawmill': 'Sawmill',
  'label.industry.farm': 'Farm',
  'label.industry.factory': 'Factory',
  'label.industry.oil_well': 'Oil well',
  'label.industry.refinery': 'Refinery',
  'label.industry.steel_mill': 'Steel mill',
  'label.industry.forest': 'Forest',

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
