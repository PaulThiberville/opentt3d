import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BUILDING_ARCHETYPES,
  BUILDING_VARIANTS,
  chooseBuildingArchetype,
  createBuildingGeometry,
  createDepotBodyGeometry,
  createDepotLiveryGeometry,
  createDistantBuildingGeometry,
  createStationHallGeometry,
  createStationPlatformGeometry,
  geometryTriangleCount,
  type BuildingDetail,
} from '../src/render/models/buildings';

const DETAILS: BuildingDetail[] = [0, 1, 2];

function bounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox ?? new THREE.Box3();
}

function positions(geometry: THREE.BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

describe('modèles de bâtiments', () => {
  it('borne chaque archétype à une empreinte de tuile et au sol', () => {
    for (const archetype of BUILDING_ARCHETYPES) {
      for (let variant = 0; variant < BUILDING_VARIANTS; variant += 1) {
        for (const detail of DETAILS) {
          const geometry = createBuildingGeometry(archetype, variant, detail);
          const box = bounds(geometry);
          expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
          expect(box.min.x).toBeGreaterThanOrEqual(-0.5);
          expect(box.max.x).toBeLessThanOrEqual(0.5);
          expect(box.min.z).toBeGreaterThanOrEqual(-0.5);
          expect(box.max.z).toBeLessThanOrEqual(0.5);
          expect(box.max.y).toBeGreaterThan(0.3);
          geometry.dispose();
        }
      }
    }
  });

  it('centre la boîte englobante de chaque modèle sur sa tuile', () => {
    const models: [string, THREE.BufferGeometry][] = [];
    for (const archetype of BUILDING_ARCHETYPES) {
      models.push([archetype, createBuildingGeometry(archetype, 0, 2)]);
    }
    models.push(['hall', createStationHallGeometry(2)]);
    models.push(['platform', createStationPlatformGeometry(2)]);
    models.push(['distant', createDistantBuildingGeometry()]);
    for (const [label, geometry] of models) {
      const box = bounds(geometry);
      expect((box.min.x + box.max.x) / 2, label).toBeCloseTo(0, 6);
      expect((box.min.z + box.max.z) / 2, label).toBeCloseTo(0, 6);
      expect(box.min.y, label).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.x - box.min.x, label).toBeLessThanOrEqual(1);
      expect(box.max.z - box.min.z, label).toBeLessThanOrEqual(1);
      geometry.dispose();
    }
  });

  it('reste sous 2 000 triangles par archétype, détails compris', () => {
    for (const archetype of BUILDING_ARCHETYPES) {
      for (let variant = 0; variant < BUILDING_VARIANTS; variant += 1) {
        const geometry = createBuildingGeometry(archetype, variant, 2);
        expect(geometryTriangleCount(geometry)).toBeLessThan(2_000);
        geometry.dispose();
      }
    }
  });

  it('ajoute des fenêtres fusionnées sans mesh séparé', () => {
    const geometry = createBuildingGeometry('apartment', 0, 2);
    const windowAttribute = geometry.getAttribute('aWindow');
    expect(windowAttribute).toBeDefined();
    let lit = 0;
    for (let index = 0; index < windowAttribute.count; index += 1) {
      if (windowAttribute.getX(index) > 0) lit += 1;
    }
    expect(lit).toBeGreaterThan(4);
    // Les fenêtres sont des quads : 2 triangles chacune, pas 12 comme une boîte.
    const plain = createBuildingGeometry('apartment', 0, 0);
    expect(geometryTriangleCount(geometry)).toBeGreaterThan(geometryTriangleCount(plain));
    plain.dispose();
    geometry.dispose();
  });

  it('est déterministe pour une même graine', () => {
    for (const archetype of BUILDING_ARCHETYPES) {
      const first = createBuildingGeometry(archetype, 1, 2);
      const second = createBuildingGeometry(archetype, 1, 2);
      expect(Array.from(positions(second))).toEqual(Array.from(positions(first)));
      first.dispose();
      second.dispose();
    }
  });

  it('fournit une silhouette lointaine très légère', () => {
    const geometry = createDistantBuildingGeometry();
    expect(geometryTriangleCount(geometry)).toBeLessThanOrEqual(40);
    const box = bounds(geometry);
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(0.88);
    geometry.dispose();
  });

  it('choisit les archétypes de façon stable et une seule église par ville', () => {
    const first = chooseBuildingArchetype({
      seed: 42,
      x: 10,
      y: 12,
      centrality: 0.9,
      hasChurch: false,
    });
    const again = chooseBuildingArchetype({
      seed: 42,
      x: 10,
      y: 12,
      centrality: 0.9,
      hasChurch: false,
    });
    expect(again).toBe(first);
    let churches = 0;
    for (let x = 0; x < 20; x += 1) {
      const archetype = chooseBuildingArchetype({
        seed: 7,
        x,
        y: 3,
        centrality: 0.9,
        hasChurch: false,
      });
      if (archetype === 'church') churches += 1;
    }
    expect(churches).toBeGreaterThan(0);
    expect(churches).toBeLessThan(20);
    for (let x = 0; x < 20; x += 1) {
      expect(
        chooseBuildingArchetype({ seed: 7, x, y: 3, centrality: 0.9, hasChurch: true }),
      ).not.toBe('church');
    }
  });
});

describe('modèles de gares et dépôts', () => {
  it('construit une halle et un quai bornés à leur tuile', () => {
    for (const geometry of [createStationHallGeometry(2), createStationPlatformGeometry(2)]) {
      const box = bounds(geometry);
      expect(box.min.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.max.x).toBeLessThanOrEqual(0.5);
      expect(box.min.z).toBeGreaterThanOrEqual(-0.5);
      expect(box.max.z).toBeLessThanOrEqual(0.5);
      expect(box.min.y).toBeGreaterThanOrEqual(0);
      expect(geometryTriangleCount(geometry)).toBeLessThan(300);
      geometry.dispose();
    }
  });

  it('distingue dépôt route et rail, corps et livrée', () => {
    for (const kind of ['road', 'rail'] as const) {
      const body = createDepotBodyGeometry(kind, 2);
      const livery = createDepotLiveryGeometry(kind);
      expect(geometryTriangleCount(body)).toBeLessThan(300);
      expect(geometryTriangleCount(livery)).toBeLessThan(100);
      const bodyBox = bounds(body);
      expect(bodyBox.max.x - bodyBox.min.x).toBeLessThanOrEqual(0.9);
      expect(bodyBox.max.z - bodyBox.min.z).toBeLessThanOrEqual(0.9);
      // La livrée est blanche : la couleur d'entreprise la teinte entièrement.
      const colours = livery.getAttribute('color');
      expect(colours.getX(0)).toBeCloseTo(1, 5);
      expect(colours.getY(0)).toBeCloseTo(1, 5);
      expect(colours.getZ(0)).toBeCloseTo(1, 5);
      body.dispose();
      livery.dispose();
    }
  });

  it('est déterministe', () => {
    const first = createStationHallGeometry(2);
    const second = createStationHallGeometry(2);
    expect(Array.from(positions(second))).toEqual(Array.from(positions(first)));
    first.dispose();
    second.dispose();
  });
});
