import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CityLayer } from '../src/render/CityLayer';
import { DepotLayer } from '../src/render/DepotLayer';
import { IndustryLayer } from '../src/render/IndustryLayer';
import { VehicleLayer } from '../src/render/VehicleLayer';
import {
  BUILDING_ARCHETYPES,
  createBuildingGeometry,
  createDepotLiveryGeometry,
} from '../src/render/models/buildings';
import {
  MODEL_FINISH,
  MODEL_GLOW,
  createModelMaterial,
  isModelMaterial,
} from '../src/render/models/materials';
import {
  MODEL_COLOURS,
  finishForModelColour,
  glowForModelColour,
} from '../src/render/models/modelUtils';
import { VEHICLE_VARIANTS, buildVehicleModel } from '../src/render/models/vehicles';
import {
  hexToRgb,
  mixColour,
  shadeColour,
  tileColour,
  weatherColour,
} from '../src/render/tileVisuals';

interface FakeShader {
  uniforms: Record<string, { value: number }>;
  vertexShader: string;
  fragmentShader: string;
}

function compile(material: THREE.MeshStandardMaterial): FakeShader {
  const shader: FakeShader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <color_vertex>',
    fragmentShader: [
      '#include <common>',
      '#include <color_fragment>',
      '#include <roughnessmap_fragment>',
      '#include <metalnessmap_fragment>',
      '#include <emissivemap_fragment>',
    ].join('\n'),
  };
  const compileHook = material.onBeforeCompile as unknown as (
    target: FakeShader,
    renderer: null,
  ) => void;
  compileHook(shader, null);
  return shader;
}

function finishCounts(geometry: THREE.BufferGeometry): Map<number, number> {
  const finish = geometry.getAttribute('aFinish');
  const counts = new Map<number, number>();
  for (let index = 0; index < finish.count; index += 1) {
    const value = Math.round(finish.getX(index));
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

describe('matière de surface des modèles', () => {
  it('crée un MeshStandardMaterial par couche, sans texture', () => {
    const night = { value: 0 };
    const material = createModelMaterial({
      night,
      glowStrength: 1.2,
      nightAmbient: 0.18,
      roughness: 0.66,
      metalness: 0.05,
      name: 'test-surface',
    });
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.vertexColors).toBe(true);
    expect(material.map).toBeNull();
    expect(material.envMap).toBeNull();
    expect(material.name).toBe('test-surface');
    expect(material.roughness).toBeCloseTo(0.66, 5);
    expect(material.metalness).toBeCloseTo(0.05, 5);
    expect(isModelMaterial(material)).toBe(true);
    expect(material.customProgramCacheKey()).toBe('opentt3d-model-surface-v1');
    material.dispose();
  });

  it('injecte les finitions, l’absence de teinte et l’émission nocturne', () => {
    const night = { value: 0.7 };
    const material = createModelMaterial({ night });
    const shader = compile(material);
    // Les deux étages lisent les attributs de sommet.
    expect(shader.vertexShader).toContain('attribute float aFinish;');
    expect(shader.vertexShader).toContain('attribute float aGlow;');
    expect(shader.vertexShader).toContain('attribute float aWindow;');
    expect(shader.vertexShader).toContain('vBaseColour = color;');
    expect(shader.fragmentShader).toContain('uniform float uNightAmbient;');
    expect(shader.fragmentShader).toContain('float untinted = step( 1.5, vFinish );');
    expect(shader.fragmentShader).toContain('opentt3dGlowColour');
    expect(shader.fragmentShader).toContain('uGlowStrength');
    // L'uniforme partagé avec la couche est bien câblé.
    expect(shader.uniforms.uNight).toBe(night);
    expect(shader.uniforms.uGlowStrength?.value).toBeCloseTo(1.15, 5);
    expect(shader.uniforms.uNightAmbient?.value).toBe(0);
    material.dispose();
  });

  it('déduit finition et émission des couleurs de pièces', () => {
    expect(finishForModelColour(MODEL_COLOURS.glass)).toBe(MODEL_FINISH.glass);
    expect(finishForModelColour(MODEL_COLOURS.roof)).toBe(MODEL_FINISH.satin);
    expect(finishForModelColour(MODEL_COLOURS.metal)).toBe(MODEL_FINISH.metal);
    expect(finishForModelColour(MODEL_COLOURS.wheel)).toBe(MODEL_FINISH.rubber);
    expect(finishForModelColour(MODEL_COLOURS.wood)).toBe(MODEL_FINISH.accent);
    expect(finishForModelColour(MODEL_COLOURS.body)).toBe(MODEL_FINISH.paint);
    expect(glowForModelColour(MODEL_COLOURS.lamp)).toBe(MODEL_GLOW.headlight);
    expect(glowForModelColour(MODEL_COLOURS.tailLight)).toBe(MODEL_GLOW.taillight);
    expect(glowForModelColour(MODEL_COLOURS.glassLight)).toBe(MODEL_GLOW.window);
    expect(glowForModelColour(MODEL_COLOURS.glass)).toBe(MODEL_GLOW.windowDim);
    expect(glowForModelColour(MODEL_COLOURS.body)).toBe(MODEL_GLOW.none);
  });
});

describe('variations procédurales de couleurs', () => {
  it('mélange et éclaircit de façon bornée', () => {
    expect(mixColour(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(shadeColour(0x808080, 0)).toBe(0x808080);
    expect(shadeColour(0xffffff, 1)).toBe(0xffffff);
    expect(shadeColour(0x000000, -1)).toBe(0x000000);
  });

  it('reste déterministe et distinguable par graine', () => {
    const first = weatherColour(0x8f4132, 42, 0.09);
    const again = weatherColour(0x8f4132, 42, 0.09);
    const other = weatherColour(0x8f4132, 43, 0.09);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    for (const seed of [0, 1, 7, 99, 65535]) {
      const value = weatherColour(0x8f4132, seed, 0.09);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('nuance le ballast et la voirie de façon déterministe', () => {
    for (const kind of ['rail', 'road', 'station', 'industry', 'dock'] as const) {
      const samples = new Set<number>();
      for (let seed = 1; seed <= 16; seed += 1) {
        const colour = tileColour(kind, 4, 0, seed);
        expect(colour).toBeGreaterThanOrEqual(0);
        expect(colour).toBeLessThanOrEqual(0xffffff);
        expect(tileColour(kind, 4, 0, seed)).toBe(colour);
        samples.add(colour);
      }
      expect(samples.size).toBeGreaterThan(4);
    }
  });
});

describe('attributs de surface des géométries', () => {
  it('marque chaque véhicule avec des finitions lisibles et non monochromes', () => {
    for (const variant of VEHICLE_VARIANTS) {
      const model = buildVehicleModel(variant);
      try {
        const count = model.geometry.getAttribute('position').count;
        expect(model.geometry.getAttribute('aFinish').count).toBe(count);
        expect(model.geometry.getAttribute('aGlow').count).toBe(count);
        const counts = finishCounts(model.geometry);
        // Peinture teintée + au moins verre et métal/caoutchouc/accent.
        expect(counts.get(MODEL_FINISH.paint) ?? 0).toBeGreaterThan(0);
        expect(counts.size).toBeGreaterThanOrEqual(3);
        let detailed = 0;
        for (const [finish, amount] of counts) {
          if (finish !== MODEL_FINISH.paint) detailed += amount;
        }
        expect(detailed / count).toBeGreaterThan(0.12);

        const glow = model.geometry.getAttribute('aGlow');
        let emitted = 0;
        for (let index = 0; index < glow.count; index += 1) {
          if (glow.getX(index) > 0) emitted += 1;
        }
        expect(emitted).toBeGreaterThan(0);
      } finally {
        model.geometry.dispose();
      }
    }
  });

  it('garde les phares et feux exactement colorés malgré l’usure', () => {
    const model = buildVehicleModel('bus-coach');
    try {
      const position = model.geometry.getAttribute('position');
      const colour = model.geometry.getAttribute('color');
      const lamp = hexToRgb(MODEL_COLOURS.lamp);
      let found = 0;
      for (let index = 0; index < colour.count; index += 1) {
        if (
          Math.abs(colour.getX(index) - lamp.r) < 1e-6 &&
          Math.abs(colour.getY(index) - lamp.g) < 1e-6 &&
          Math.abs(colour.getZ(index) - lamp.b) < 1e-6
        ) {
          found += 1;
        }
      }
      expect(found).toBeGreaterThan(0);
      expect(position.count).toBeGreaterThan(0);
    } finally {
      model.geometry.dispose();
    }
  });

  it('est déterministe pour les finitions et l’émission', () => {
    for (const variant of VEHICLE_VARIANTS) {
      const first = buildVehicleModel(variant);
      const second = buildVehicleModel(variant);
      try {
        expect(second.geometry.getAttribute('aFinish').array).toEqual(
          first.geometry.getAttribute('aFinish').array,
        );
        expect(second.geometry.getAttribute('aGlow').array).toEqual(
          first.geometry.getAttribute('aGlow').array,
        );
        expect(second.geometry.getAttribute('color').array).toEqual(
          first.geometry.getAttribute('color').array,
        );
      } finally {
        first.geometry.dispose();
        second.geometry.dispose();
      }
    }
  });

  it('ajoute finitions et vitrages émissifs aux bâtiments sans perdre aWindow', () => {
    for (const archetype of BUILDING_ARCHETYPES) {
      const geometry = createBuildingGeometry(archetype, 0, 2);
      const count = geometry.getAttribute('position').count;
      expect(geometry.getAttribute('aWindow').count).toBe(count);
      expect(geometry.getAttribute('aFinish').count).toBe(count);
      expect(geometry.getAttribute('aGlow').count).toBe(count);
      const counts = finishCounts(geometry);
      expect(counts.get(MODEL_FINISH.paint) ?? 0).toBeGreaterThan(0);
      expect(counts.get(MODEL_FINISH.glass) ?? 0).toBeGreaterThan(0);
      geometry.dispose();
    }
  });

  it('conserve des couleurs de livrée parfaitement blanches pour la teinte', () => {
    for (const kind of ['road', 'rail'] as const) {
      const livery = createDepotLiveryGeometry(kind);
      const colours = livery.getAttribute('color');
      expect(colours.getX(0)).toBeCloseTo(1, 6);
      expect(colours.getY(0)).toBeCloseTo(1, 6);
      expect(colours.getZ(0)).toBeCloseTo(1, 6);
      livery.dispose();
    }
  });
});

describe('matériaux des couches', () => {
  it('partage un matériau standard par couche et expose la nuit', () => {
    const vehicles = new VehicleLayer();
    const city = new CityLayer();
    const industries = new IndustryLayer();
    const depots = new DepotLayer();
    try {
      for (const layer of [vehicles, city, industries, depots]) {
        expect(layer.surfaceMaterial).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(isModelMaterial(layer.surfaceMaterial)).toBe(true);
      }
      vehicles.setNight(0.6);
      city.setNight(0.7);
      industries.setNight(0.8);
      depots.setNight(0.9);
      expect(vehicles.night).toBeCloseTo(0.6, 6);
      expect(city.night).toBeCloseTo(0.7, 6);
      expect(industries.night).toBeCloseTo(0.8, 6);
      expect(depots.night).toBeCloseTo(0.9, 6);
      industries.setNight(Number.NaN);
      depots.setNight(4);
      expect(industries.night).toBe(0);
      expect(depots.night).toBe(1);
    } finally {
      vehicles.dispose();
      city.dispose();
      industries.dispose();
      depots.dispose();
    }
  });

  it('borne le budget triangles des véhicules avec les nouveaux détails', () => {
    for (const variant of VEHICLE_VARIANTS) {
      const model = buildVehicleModel(variant);
      try {
        expect(model.triangles).toBeLessThan(3000);
      } finally {
        model.geometry.dispose();
      }
    }
  });
});
