import { describe, expect, it } from 'vitest';
import type { VehicleSnapshot } from '../src/engine/protocol';
import {
  VehicleInterpolator,
  modelKindFor,
  segmentPitch,
  type RenderVehicle,
} from '../src/game/vehicleInterpolation';
import { lerpAngle, lerpDirection, normalizeAngle, smoothstep01 } from '../src/game/interpolation';

function vehicle(overrides: Partial<VehicleSnapshot> & { id: number }): VehicleSnapshot {
  return {
    kind: 'road',
    company: 0,
    x: 0,
    y: 0,
    z: 0,
    direction: 0,
    speed: 10,
    status: 1,
    cargo: { type: 'goods', amount: 0, capacity: 10 },
    orderTargets: [],
    profitLastYear: 0,
    ageDays: 0,
    ...overrides,
  };
}

describe('maths d’interpolation', () => {
  it('normalise les angles', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0);
    expect(normalizeAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((Math.PI * 3) / 2);
  });

  it('interpole les angles par le plus court chemin', () => {
    const a = Math.PI * 0.95;
    const b = -Math.PI * 0.95;
    const mid = lerpAngle(a, b, 0.5);
    const normalized = normalizeAngle(mid);
    // Le point médian doit être proche de ±π, pas de 0.
    expect(Math.abs(Math.abs(normalized) - Math.PI)).toBeLessThan(0.2);
  });

  it('interpole les directions 0..255 avec rebouclage', () => {
    expect(lerpDirection(0, 120, 0.5)).toBe(60);
    expect(lerpDirection(250, 10, 0.5)).toBe(2);
    expect(lerpDirection(10, 250, 0.5)).toBe(2);
    expect(lerpDirection(0, 128, 0)).toBe(0);
    expect(lerpDirection(0, 128, 1)).toBe(128);
    for (let i = 0; i < 100; i += 1) {
      const value = lerpDirection(i * 2, i * 3 + 40, i / 100);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(256);
    }
  });

  it('adoucit dans [0, 1]', () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(0)).toBe(0);
    expect(smoothstep01(0.5)).toBeCloseTo(0.5);
    expect(smoothstep01(1)).toBe(1);
    expect(smoothstep01(2)).toBe(1);
  });
});

describe('interpolation des véhicules', () => {
  it('interpole linéairement la position', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 1, x: 0, y: 0, z: 2 })];
    const to = [vehicle({ id: 1, x: 2, y: 4, z: 4 })];
    expect(interpolator.interpolate(from, to, 0, out)).toBe(1);
    expect(out[0]?.x).toBe(0);
    expect(out[0]?.y).toBe(0);
    interpolator.interpolate(from, to, 0.5, out);
    expect(out[0]?.x).toBeCloseTo(1);
    expect(out[0]?.y).toBeCloseTo(2);
    expect(out[0]?.z).toBeCloseTo(3);
    interpolator.interpolate(from, to, 1, out);
    expect(out[0]?.x).toBe(2);
  });

  it('interpole le tangage fourni par le moteur (#232)', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 8, x: 0, y: 0, z: 1, pitch: 0.1 })];
    const to = [vehicle({ id: 8, x: 1, y: 0, z: 1.3, pitch: 0.3 })];
    interpolator.interpolate(from, to, 0.5, out);
    expect(out[0]?.pitch).toBeCloseTo(0.2);
    interpolator.interpolate(from, to, 1, out);
    expect(out[0]?.pitch).toBeCloseTo(0.3);
  });

  it('déduit le tangage du déplacement quand le moteur ne le fournit pas', () => {
    const from = vehicle({ id: 9, x: 2, y: 3, z: 1 });
    const to = vehicle({ id: 9, x: 2, y: 4, z: 1.5 });
    expect(segmentPitch(from, to)).toBeCloseTo(Math.atan2(0.5, 1));
    expect(segmentPitch(to, from)).toBeCloseTo(Math.atan2(-0.5, 1));

    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    interpolator.interpolate([from], [to], 0.5, out);
    expect(out[0]?.pitch).toBeCloseTo(Math.atan2(0.5, 1));
  });

  it('garde les navires et avions horizontaux', () => {
    const from = vehicle({ id: 10, kind: 'ship', x: 0, y: 0, z: 0 });
    const to = vehicle({ id: 10, kind: 'ship', x: 1, y: 1, z: 2 });
    expect(segmentPitch(from, to)).toBe(0);
    const plane = vehicle({ id: 11, kind: 'aircraft', x: 0, y: 0, z: 5 });
    expect(segmentPitch(plane, { ...plane, z: 9 })).toBe(0);
  });

  it('recale les téléportations au lieu de traverser la carte', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 3, x: 10, y: 10 })];
    const to = [vehicle({ id: 3, x: 60, y: 60 })];
    interpolator.interpolate(from, to, 0.5, out);
    expect(out[0]?.x).toBe(60);
    expect(out[0]?.y).toBe(60);
  });

  it('conserve un véhicule qui disparaît jusqu’à alpha = 1', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 4, x: 5, y: 5 })];
    interpolator.interpolate(from, [], 0.5, out);
    expect(out).toHaveLength(1);
    expect(out[0]?.x).toBe(5);
    interpolator.interpolate(from, [], 1, out);
    expect(out).toHaveLength(0);
  });

  it('réutilise les objets du pool (aucune allocation par frame)', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 1 })];
    const to = [vehicle({ id: 1, x: 1 })];
    interpolator.interpolate(from, to, 0.5, out);
    const first = out[0];
    interpolator.interpolate(from, to, 0.6, out);
    expect(out[0]).toBe(first);
  });

  it('gère un mélange d’identifiants et l’ordre', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 1 }), vehicle({ id: 2, x: 4 })];
    const to = [vehicle({ id: 2, x: 6 }), vehicle({ id: 5, x: 1 })];
    expect(interpolator.interpolate(from, to, 0.5, out)).toBe(3);
    expect(out.map((item) => item.id).sort((a, b) => a - b)).toEqual([1, 2, 5]);
  });

  it('choisit le bon modèle visuel', () => {
    expect(modelKindFor(vehicle({ id: 1, kind: 'train' }))).toBe('train');
    expect(modelKindFor(vehicle({ id: 2, kind: 'ship' }))).toBe('ship');
    expect(modelKindFor(vehicle({ id: 3, kind: 'aircraft' }))).toBe('plane');
    expect(
      modelKindFor(
        vehicle({ id: 4, kind: 'road', cargo: { type: 'passengers', amount: 0, capacity: 1 } }),
      ),
    ).toBe('bus');
    expect(
      modelKindFor(
        vehicle({ id: 5, kind: 'road', cargo: { type: 'coal', amount: 0, capacity: 1 } }),
      ),
    ).toBe('truck');
    // Le modèle catalogue prime sur la cargaison : un bus refité ou dont la
    // cargaison est momentanément nulle reste visuellement un bus (#203).
    expect(
      modelKindFor(
        vehicle({
          id: 6,
          kind: 'road',
          model: 'bus_city',
          cargo: { type: 'coal', amount: 0, capacity: 1 },
        }),
      ),
    ).toBe('bus');
    expect(modelKindFor(vehicle({ id: 7, kind: 'road', model: 'truck_tanker', cargo: null }))).toBe(
      'truck',
    );
  });

  it('interpole la direction avec rebouclage', () => {
    const interpolator = new VehicleInterpolator();
    const out: RenderVehicle[] = [];
    const from = [vehicle({ id: 6, direction: 250 })];
    const to = [vehicle({ id: 6, direction: 10 })];
    interpolator.interpolate(from, to, 0.5, out);
    expect(out[0]?.direction).toBe(2);
  });
});
