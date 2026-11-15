/*
 * OpenTT3D - IA minimale embarquée dans le moteur WebAssembly.
 *
 * OpenTTD ne livre aucun script IA dans les sources (ils sont téléchargés via
 * le service de contenu, inaccessible en headless). Ce script comble ce vide :
 * il construit une ligne de bus déterministe entre deux villes, ce qui donne
 * des gares et des véhicules observables dans le snapshot dès les premiers
 * ticks. Il n'utilise aucune fonction aléatoire du moteur : pour une même
 * graine et une même configuration, le résultat est reproductible.
 *
 * Documentation : wiki, Moteur-WASM > Entreprises IA.
 */

class OpenTT3D extends AIInfo {
	function GetAuthor()      { return "OpenTT3D"; }
	function GetName()        { return "OpenTT3D"; }
	function GetShortName()   { return "OTT3"; }
	function GetDescription() { return "IA déterministe : ligne de bus entre deux villes."; }
	function GetVersion()     { return 1; }
	function GetDate()        { return "2026-11-15"; }
	function CreateInstance() { return "OpenTT3D"; }
	function GetAPIVersion()  { return "15"; }
	function UseAsRandomAI()  { return true; }
}

RegisterAI(OpenTT3D());
