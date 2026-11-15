/**
 * Matières partagées des modèles procéduraux.
 *
 * Tous les modèles restent construits en code, sans texture ni environnement
 * précalculé. La richesse vient d'un `MeshStandardMaterial` unique par couche,
 * dont le shader lit deux attributs de sommet :
 *
 * - `aFinish` : classe de finition (peinture teintée, satinée, verre, métal,
 *   accent clair indépendant de la livrée, caoutchouc). Elle module la rugosité,
 *   le métal et le fait qu'un sommet subisse ou non la couleur d'entreprise.
 * - `aGlow` : classe d'émission nocturne (fenêtre, phare, feu arrière, balise).
 *   Le facteur `uNight` est fourni par la couche ; rien n'est allumé le jour.
 *
 * L'attribut historique `aWindow` des bâtiments est conservé et reste prioritaire
 * pour les fenêtres éclairées : les deux sources sont fusionnées dans le shader.
 * Aucun draw call ni matériau supplémentaire n'est créé par modèle.
 */

import * as THREE from 'three';

/** Finitions par sommet (valeurs stockées dans `aFinish`). */
export const MODEL_FINISH = {
  /** Peinture mate teintée par l'entreprise. */
  paint: 0,
  /** Peinture satinée teintée (toits, bandeaux). */
  satin: 1,
  /** Verre non teinté, lisse et légèrement métallique. */
  glass: 2,
  /** Métal non teinté, très réfléchissant. */
  metal: 3,
  /** Accent clair non teinté (filets blancs, bois, cargaison). */
  accent: 4,
  /** Caoutchouc non teinté, très rugueux. */
  rubber: 5,
} as const;

export type ModelFinish = (typeof MODEL_FINISH)[keyof typeof MODEL_FINISH];

/** Classes d'émission nocturne (valeurs stockées dans `aGlow`). */
export const MODEL_GLOW = {
  none: 0,
  /** Fenêtre ou vitrage intérieur : chaud. */
  window: 1,
  /** Phare avant : blanc chaud. */
  headlight: 2,
  /** Feu arrière : rouge. */
  taillight: 3,
  /** Balise ou enseigne : bleu-cyan. */
  beacon: 4,
  /** Vitrage discret (pare-brise, hublot) : chaud atténué. */
  windowDim: 5,
} as const;

export type ModelGlow = (typeof MODEL_GLOW)[keyof typeof MODEL_GLOW];

/** Uniforme de nuit partagé entre un matériau et sa couche. */
export interface NightUniform {
  value: number;
}

export interface ModelMaterialOptions {
  /** Uniforme 0..1 piloté par `setNight` de la couche. */
  night: NightUniform;
  /** Intensité globale de l'émission nocturne (1 = référence). */
  glowStrength?: number;
  /** Éclairage ambiant nocturne de la peinture (0 = aucune auto-émission). */
  nightAmbient?: number;
  /** Rugosité de base de la peinture. */
  roughness?: number;
  /** Métal de base de la peinture. */
  metalness?: number;
  /** Nom lisible du matériau (diagnostic). */
  name?: string;
}

/** Clé de programme stable : toutes les couches partagent le même shader. */
const SURFACE_PROGRAM_KEY = 'opentt3d-model-surface-v1';

/**
 * Crée le matériau standard des modèles. Le même shader sert aux véhicules,
 * villes, industries et dépôts ; seuls les paramètres et l'uniforme changent.
 */
export function createModelMaterial(options: ModelMaterialOptions): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: options.roughness ?? 0.72,
    metalness: options.metalness ?? 0.05,
  });
  material.name = options.name ?? 'model-surface';
  const glowStrength = options.glowStrength ?? 1.15;
  const nightAmbient = options.nightAmbient ?? 0;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = options.night;
    shader.uniforms.uGlowStrength = { value: glowStrength };
    shader.uniforms.uNightAmbient = { value: nightAmbient };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aFinish;
        attribute float aGlow;
        attribute float aWindow;
        varying float vFinish;
        varying float vGlow;
        varying float vWindow;
        varying vec3 vBaseColour;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        vBaseColour = color;
        vFinish = aFinish;
        vGlow = aGlow;
        vWindow = aWindow;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform float uGlowStrength;
        uniform float uNightAmbient;
        varying float vFinish;
        varying float vGlow;
        varying float vWindow;
        varying vec3 vBaseColour;

        vec3 opentt3dGlowColour( float cls ) {
          if ( cls < 0.5 ) return vec3( 0.0 );
          if ( cls < 1.5 ) return vec3( 1.0, 0.58, 0.26 );
          if ( cls < 2.5 ) return vec3( 1.0, 0.92, 0.70 );
          if ( cls < 3.5 ) return vec3( 0.95, 0.14, 0.07 );
          if ( cls < 4.5 ) return vec3( 0.42, 0.76, 1.0 );
          return vec3( 1.0, 0.58, 0.26 ) * 0.42;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Verre, métal et accents ne prennent pas la couleur d'entreprise :
        // ils gardent leur teinte propre, ce qui rend la livrée lisible.
        float untinted = step( 1.5, vFinish );
        diffuseColor.rgb = mix( diffuseColor.rgb, vBaseColour, untinted );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float glassMask = step( 1.5, vFinish ) * ( 1.0 - step( 2.5, vFinish ) );
        float metalMask = step( 2.5, vFinish ) * ( 1.0 - step( 3.5, vFinish ) );
        float accentMask = step( 3.5, vFinish ) * ( 1.0 - step( 4.5, vFinish ) );
        float rubberMask = step( 4.5, vFinish );
        roughnessFactor = mix( roughnessFactor, 0.12, glassMask );
        roughnessFactor = mix( roughnessFactor, 0.34, metalMask );
        roughnessFactor = mix( roughnessFactor, 0.52, accentMask );
        roughnessFactor = mix( roughnessFactor, 0.94, rubberMask );`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = mix( metalnessFactor, 0.30, glassMask );
        metalnessFactor = mix( metalnessFactor, 0.85, metalMask );
        metalnessFactor = mix( metalnessFactor, 0.02, accentMask );
        metalnessFactor = mix( metalnessFactor, 0.0, rubberMask );`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Reflet de ciel low-cost : Fresnel sur le verre, sans envmap.
          float fresnel = pow(
            1.0 - clamp( dot( normalize( vNormal ), normalize( vViewPosition ) ), 0.0, 1.0 ),
            3.0
          );
          totalEmissiveRadiance += vec3( 0.32, 0.46, 0.62 ) * fresnel * glassMask * 0.34;

          float glow = max( vGlow, vWindow );
          totalEmissiveRadiance += opentt3dGlowColour( glow ) * uNight * uGlowStrength;
          totalEmissiveRadiance += vColor.rgb * uNight * uNightAmbient;
        }`,
      );
  };
  material.customProgramCacheKey = () => SURFACE_PROGRAM_KEY;
  material.userData.modelSurface = true;
  return material;
}

/** Vrai si le matériau a été créé par `createModelMaterial`. */
export function isModelMaterial(material: THREE.Material): material is THREE.MeshStandardMaterial {
  return material instanceof THREE.MeshStandardMaterial && material.userData.modelSurface === true;
}
