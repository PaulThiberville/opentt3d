import { describe, expect, it } from 'vitest';
import { VEHICLE_VARIANTS, type VehicleVariant } from '../src/render/vehicleModels';
import {
  THUMBNAIL_SIZES,
  ThumbnailCache,
  VehicleThumbnails,
  thumbnailGlyph,
  thumbnailKey,
  type ThumbnailBackend,
  type ThumbnailRequest,
} from '../src/ui/vehicleThumbnail';

const PNG = 'data:image/png;base64,AAAA';

const BASE_REQUEST: ThumbnailRequest = {
  variant: 'bus-city',
  colour: 0x1c2f83,
  quality: 'medium',
};

interface FakeBackend {
  backend: ThumbnailBackend;
  requests: ThumbnailRequest[];
  disposes: () => number;
}

function fakeBackend(result: string | null = PNG): FakeBackend {
  const requests: ThumbnailRequest[] = [];
  let disposes = 0;
  return {
    backend: {
      render(request: ThumbnailRequest): string | null {
        requests.push(request);
        return result;
      },
      dispose(): void {
        disposes += 1;
      },
    },
    requests,
    disposes: () => disposes,
  };
}

/** Service synchrone : le rendu part dans le même tick (tests déterministes). */
function immediateService(
  createBackend: () => ThumbnailBackend | null,
  limit?: number,
): VehicleThumbnails {
  return new VehicleThumbnails({
    createBackend,
    limit,
    schedule: (task) => task(),
  });
}

describe('clé de vignette', () => {
  it('distingue variante, couleur et qualité', () => {
    expect(thumbnailKey(BASE_REQUEST)).toBe('bus-city|1c2f83|medium');
    const keys = new Set([
      thumbnailKey(BASE_REQUEST),
      thumbnailKey({ ...BASE_REQUEST, variant: 'bus-coach' }),
      thumbnailKey({ ...BASE_REQUEST, colour: 0xffffff }),
      thumbnailKey({ ...BASE_REQUEST, quality: 'high' }),
    ]);
    expect(keys.size).toBe(4);
  });

  it('est stable pour une même demande', () => {
    expect(thumbnailKey({ ...BASE_REQUEST })).toBe(thumbnailKey({ ...BASE_REQUEST }));
  });

  it('définit une taille croissante par qualité', () => {
    expect(THUMBNAIL_SIZES.low.width).toBeLessThan(THUMBNAIL_SIZES.medium.width);
    expect(THUMBNAIL_SIZES.medium.width).toBeLessThan(THUMBNAIL_SIZES.high.width);
    for (const size of Object.values(THUMBNAIL_SIZES)) {
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });

  it('fournit un pictogramme de repli pour chaque variante', () => {
    for (const variant of VEHICLE_VARIANTS) {
      expect(thumbnailGlyph(variant as VehicleVariant).length).toBeGreaterThan(0);
    }
  });
});

describe('cache LRU', () => {
  it('borne le nombre d’entrées et évince la plus ancienne', () => {
    const cache = new ThumbnailCache(2);
    cache.set('a', '1');
    cache.set('b', '2');
    // Relire `a` la rend plus récente que `b`.
    expect(cache.get('a')).toBe('1');
    cache.set('c', '3');
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.size).toBe(2);
    expect(cache.stats().evictions).toBe(1);
  });

  it('compte les succès et les absences', () => {
    const cache = new ThumbnailCache(2);
    cache.set('a', '1');
    cache.get('a');
    cache.get('missing');
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  it('oublie tout au clear', () => {
    const cache = new ThumbnailCache();
    cache.set('a', '1');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });
});

describe('service de vignettes', () => {
  it('ne rend qu’une fois une même clé et sert le cache', () => {
    const fake = fakeBackend();
    const service = immediateService(() => fake.backend);
    service.resume();

    const urls: (string | null)[] = [];
    service.request(BASE_REQUEST, (url) => urls.push(url));
    service.request(BASE_REQUEST, (url) => urls.push(url));

    expect(urls).toEqual([PNG, PNG]);
    expect(fake.requests).toHaveLength(1);
    expect(service.renderCount).toBe(1);
    expect(service.cache.size).toBe(1);
  });

  it('rend une vignette par couleur et par qualité', () => {
    const fake = fakeBackend();
    const service = immediateService(() => fake.backend);
    service.resume();

    service.request(BASE_REQUEST, () => {});
    service.request({ ...BASE_REQUEST, colour: 0xffffff }, () => {});
    service.request({ ...BASE_REQUEST, quality: 'high' }, () => {});

    expect(fake.requests).toHaveLength(3);
    expect(service.cache.size).toBe(3);
  });

  it('ne bloque pas : un seul rendu par tour d’ordonnanceur', () => {
    const fake = fakeBackend();
    const tasks: (() => void)[] = [];
    const service = new VehicleThumbnails({
      createBackend: () => fake.backend,
      schedule: (task) => tasks.push(task),
    });
    service.resume();

    service.request(BASE_REQUEST, () => {});
    service.request({ ...BASE_REQUEST, variant: 'train-steam' }, () => {});

    expect(tasks).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);

    tasks.shift()?.();
    expect(fake.requests).toHaveLength(1);
    expect(tasks).toHaveLength(1);

    tasks.shift()?.();
    expect(fake.requests).toHaveLength(2);
  });

  it('ne rend rien tant que le panneau est fermé', () => {
    const fake = fakeBackend();
    const service = immediateService(() => fake.backend);
    const urls: (string | null)[] = [];

    service.request(BASE_REQUEST, (url) => urls.push(url));

    expect(urls).toEqual([null]);
    expect(fake.requests).toHaveLength(0);
    expect(service.isActive).toBe(false);

    service.resume();
    service.request(BASE_REQUEST, (url) => urls.push(url));
    expect(urls).toEqual([null, PNG]);
    expect(fake.requests).toHaveLength(1);
  });

  it('annule la file et libère le contexte à la fermeture', () => {
    const fake = fakeBackend();
    const tasks: (() => void)[] = [];
    const done: (string | null)[] = [];
    const service = new VehicleThumbnails({
      createBackend: () => fake.backend,
      schedule: (task) => tasks.push(task),
    });
    service.resume();
    service.request(BASE_REQUEST, (url) => done.push(url));
    expect(service.pendingCount).toBe(1);

    service.suspend();
    expect(service.pendingCount).toBe(0);
    expect(service.isActive).toBe(false);

    // La tâche déjà planifiée ne doit plus rien rendre.
    tasks.shift()?.();
    expect(fake.requests).toHaveLength(0);
    expect(done).toHaveLength(0);

    // Une réouverture recrée le backend puis rend à nouveau.
    service.resume();
    service.request(BASE_REQUEST, (url) => done.push(url));
    tasks.shift()?.();
    expect(fake.requests).toHaveLength(1);
    expect(done).toEqual([PNG]);
  });

  it('libère le backend après un rendu puis le recrée à la réouverture', () => {
    const fake = fakeBackend();
    let created = 0;
    const service = immediateService(() => {
      created += 1;
      return fake.backend;
    });
    service.resume();
    service.request(BASE_REQUEST, () => {});
    expect(created).toBe(1);

    service.suspend();
    expect(fake.disposes()).toBe(1);

    service.resume();
    service.request({ ...BASE_REQUEST, colour: 0xffffff }, () => {});
    expect(created).toBe(2);
    expect(fake.requests).toHaveLength(2);
  });

  it('bascule en repli quand WebGL est indisponible', () => {
    const service = immediateService(() => null);
    service.resume();
    const urls: (string | null)[] = [];

    service.request(BASE_REQUEST, (url) => urls.push(url));
    service.request({ ...BASE_REQUEST, variant: 'ship' }, (url) => urls.push(url));

    expect(urls).toEqual([null, null]);
    expect(service.renderCount).toBe(0);
    expect(service.pendingCount).toBe(0);
  });

  it('bascule en repli quand le rendu lève une erreur', () => {
    let throwOnce = true;
    let disposes = 0;
    const backend: ThumbnailBackend = {
      render(): string | null {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('contexte perdu');
        }
        return PNG;
      },
      dispose(): void {
        disposes += 1;
      },
    };
    const service = immediateService(() => backend);
    service.resume();
    const urls: (string | null)[] = [];

    service.request(BASE_REQUEST, (url) => urls.push(url));
    service.request({ ...BASE_REQUEST, variant: 'ship' }, (url) => urls.push(url));

    expect(urls).toEqual([null, null]);
    expect(disposes).toBe(1);
    expect(service.renderCount).toBe(1);
  });

  it('dispose vide le cache et refuse tout nouveau rendu', () => {
    const fake = fakeBackend();
    const service = immediateService(() => fake.backend);
    service.resume();
    service.request(BASE_REQUEST, () => {});
    expect(service.cache.size).toBe(1);

    service.dispose();
    expect(fake.disposes()).toBe(1);
    expect(service.cache.size).toBe(0);

    const urls: (string | null)[] = [];
    service.request(BASE_REQUEST, (url) => urls.push(url));
    expect(urls).toEqual([null]);
    expect(fake.requests).toHaveLength(1);
  });
});
