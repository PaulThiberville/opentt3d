/**
 * Shader de finition : color grading, split toning, vignette, grain et
 * tilt-shift léger.
 *
 * Il s'applique APRÈS `OutputPass` : les valeurs sont déjà tone-mappées (ACES) et
 * encodées en sRGB. Le grading se comporte donc comme un filtre photo, avec des
 * réglages prévisibles, sans dépendre de l'exposition linéaire de la scène.
 */

import { Vector2 } from 'three';

export const GradeShader = {
  name: 'CinematicGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new Vector2(1, 1) },
    time: { value: 0 },
    vignette: { value: 0.2 },
    grain: { value: 0.012 },
    saturation: { value: 1.05 },
    contrast: { value: 1.02 },
    warmth: { value: 0.14 },
    splitTone: { value: 0.35 },
    tiltShift: { value: 0 },
    tiltFocus: { value: 0.56 },
    tiltBand: { value: 0.18 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time;
    uniform float vignette;
    uniform float grain;
    uniform float saturation;
    uniform float contrast;
    uniform float warmth;
    uniform float splitTone;
    uniform float tiltShift;
    uniform float tiltFocus;
    uniform float tiltBand;

    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    vec3 tiltBlur(vec2 uv, float radiusPixels) {
      vec2 px = radiusPixels / max(resolution, vec2(1.0));
      vec3 sum = texture2D(tDiffuse, uv).rgb * 0.28;
      sum += texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb * 0.09;
      sum += texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb * 0.09;
      sum += texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb * 0.09;
      sum += texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb * 0.09;
      sum += texture2D(tDiffuse, uv + px * 0.7).rgb * 0.09;
      sum += texture2D(tDiffuse, uv - px * 0.7).rgb * 0.09;
      sum += texture2D(tDiffuse, uv + vec2(px.x, -px.y) * 0.7).rgb * 0.09;
      sum += texture2D(tDiffuse, uv + vec2(-px.x, px.y) * 0.7).rgb * 0.09;
      return sum;
    }

    void main() {
      vec2 uv = vUv;
      vec3 colour = texture2D(tDiffuse, uv).rgb;

      if (tiltShift > 0.001) {
        float edge = smoothstep(tiltBand, tiltBand + 0.34, abs(uv.y - tiltFocus));
        float radius = tiltShift * edge * 3.2;
        vec3 blurred = tiltBlur(uv, radius);
        colour = mix(colour, blurred, edge * 0.9);
      }

      // Saturation et contraste en espace d'affichage (post-ACES/sRGB).
      float luma = dot(colour, LUMA);
      colour = mix(vec3(luma), colour, saturation);
      colour = (colour - 0.5) * contrast + 0.5;

      // Balance chaud/froid : positive le jour, négative la nuit.
      colour += vec3(0.034, 0.012, -0.036) * warmth;

      // Split toning discret : ombres bleutées, hautes lumières dorées.
      float tone = smoothstep(0.15, 0.85, luma);
      colour += mix(vec3(-0.014, 0.0, 0.022), vec3(0.022, 0.009, -0.014), tone) * splitTone;

      // Vignette corrigée en aspect, douce pour ne pas manger l'UI de bord.
      vec2 q = uv - 0.5;
      q.x *= resolution.x / max(1.0, resolution.y);
      float vignetteMask = smoothstep(0.56, 1.0, length(q));
      colour *= 1.0 - vignette * vignetteMask;

      // Grain animé, centré, très faible : casse les aplats sans scintiller.
      float noise = hash12(gl_FragCoord.xy + floor(time * 24.0) * 17.0) - 0.5;
      colour += noise * grain;

      gl_FragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
    }
  `,
};
