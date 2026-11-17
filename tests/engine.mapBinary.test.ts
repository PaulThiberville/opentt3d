import { describe, expect, it } from 'vitest';
import {
  MAP_DATA_OFFSET,
  MAP_DIRECTORY_ENTRY_SIZE,
  MAP_HEADER_SIZE,
  MAP_LAYER_ORDER,
  MapSnapshotError,
  decodeMapSnapshot,
} from '../src/engine/mapBinary';
import {
  buildMapFixture,
  layerOffset,
  setHeaderU16,
  setHeaderU32,
} from './fixtures/mapBinaryFixture';

describe('décodeur de snapshot carte', () => {
  it('décode l’en-tête, les couches et les métadonnées', () => {
    const bytes = buildMapFixture({ width: 4, height: 2, tick: 4321, sequence: 7 });
    const decoded = decodeMapSnapshot(bytes);

    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(2);
    expect(decoded.tileCount).toBe(8);
    expect(decoded.tick).toBe(4321);
    expect(decoded.sequence).toBe(7);
    expect(decoded.header.magic).toBe(0x314d544f);
    expect(decoded.header.version).toBe(3);
    expect(decoded.header.dataOffset).toBe(MAP_DATA_OFFSET);
    expect(decoded.map.width).toBe(4);
    expect(decoded.map.height).toBe(2);
  });

  it('associe chaque couche du répertoire au bon champ', () => {
    const width = 2;
    const height = 2;
    const bytes = buildMapFixture({ width, height });
    const view = new DataView(bytes.buffer);
    const decoded = decodeMapSnapshot(bytes);

    for (const name of MAP_LAYER_ORDER) {
      const offset = layerOffset(name, width, height);
      const expected = bytes.slice(offset, offset + width * height);
      expect(decoded.map[name]!).toEqual(expected);
      // Le champ décodé est une copie, pas une vue sur le buffer source.
      expect(decoded.map[name]!.buffer).not.toBe(bytes.buffer);
    }
    // Le motif par défaut dépend bien de l'identifiant de couche.
    expect(decoded.map.kind).not.toEqual(decoded.map.heightMap);
    expect(view.getUint8(MAP_HEADER_SIZE)).toBe(1);
  });

  it('respecte l’ordre physique des couches, pas l’ordre du répertoire', () => {
    // Répertoire volontairement inversé : les offsets font foi.
    const width = 2;
    const height = 2;
    const bytes = buildMapFixture({
      width,
      height,
      corrupt: (view) => {
        for (let index = 0; index < MAP_LAYER_ORDER.length; index += 1) {
          const entry = MAP_HEADER_SIZE + index * MAP_DIRECTORY_ENTRY_SIZE;
          const mirrored = MAP_LAYER_ORDER.length - 1 - index;
          view.setUint8(entry, mirrored + 1);
          view.setUint32(entry + 4, MAP_DATA_OFFSET + mirrored * width * height, true);
          view.setUint32(entry + 8, width * height, true);
        }
      },
    });

    const decoded = decodeMapSnapshot(bytes);
    expect(decoded.map.kind).toEqual(
      bytes.slice(
        layerOffset('kind', width, height),
        layerOffset('kind', width, height) + width * height,
      ),
    );
    expect(decoded.map.trackBits).toEqual(
      bytes.slice(
        layerOffset('trackBits', width, height),
        layerOffset('trackBits', width, height) + width * height,
      ),
    );
  });

  it('vérifie les dimensions et le tick attendus', () => {
    const bytes = buildMapFixture({ width: 2, height: 2, tick: 10 });
    expect(() => decodeMapSnapshot(bytes, { width: 2, height: 2, tick: 10 })).not.toThrow();
    expect(() => decodeMapSnapshot(bytes, { width: 4 })).toThrow(/Largeur inattendue/);
    expect(() => decodeMapSnapshot(bytes, { tick: 11 })).toThrow(/désynchronisées/);
  });

  it('refuse un magic invalide', () => {
    const bytes = buildMapFixture();
    setHeaderU32(bytes, 0, 0xdeadbeef);
    expect(() => decodeMapSnapshot(bytes)).toThrow(MapSnapshotError);
    expect(() => decodeMapSnapshot(bytes)).toThrow(/Magic de carte invalide/);
  });

  it('lit encore une carte v1 sans couche de signaux', () => {
    const bytes = buildMapFixture({ width: 2, height: 2, version: 1 });
    const decoded = decodeMapSnapshot(bytes);
    expect(decoded.header.version).toBe(1);
    expect(decoded.map.signalData).toEqual(new Uint8Array(4));
    expect(decoded.map.roadData).toEqual(new Uint8Array(4));
    expect(decoded.map.trackBits).toHaveLength(4);
  });

  it('lit une carte v2 sans couche de sens unique (#231)', () => {
    const bytes = buildMapFixture({ width: 2, height: 2, version: 2 });
    const decoded = decodeMapSnapshot(bytes);
    expect(decoded.header.version).toBe(2);
    expect(decoded.map.signalData).toHaveLength(4);
    expect(decoded.map.roadData).toEqual(new Uint8Array(4));
  });

  it('refuse une version inconnue', () => {
    const bytes = buildMapFixture();
    setHeaderU16(bytes, 4, 4);
    expect(() => decodeMapSnapshot(bytes)).toThrow(/Version de snapshot carte non supportée/);
  });

  it('refuse un buffer tronqué', () => {
    const bytes = buildMapFixture();
    expect(() => decodeMapSnapshot(bytes.slice(0, 32))).toThrow(/tronqué/);
    expect(() => decodeMapSnapshot(bytes.slice(0, bytes.byteLength - 4))).toThrow(/tronqué/);
  });

  it('refuse des dimensions incohérentes', () => {
    const bytes = buildMapFixture();
    setHeaderU32(bytes, 16, 99);
    expect(() => decodeMapSnapshot(bytes)).toThrow(/Nombre de tuiles incohérent/);
  });

  it('refuse un répertoire incomplet ou mal formé', () => {
    const missing = buildMapFixture({
      corrupt: (view) => view.setUint8(MAP_HEADER_SIZE, 9),
    });
    expect(() => decodeMapSnapshot(missing)).toThrow(/Couche inconnue/);

    const duplicated = buildMapFixture({
      corrupt: (view) => view.setUint8(MAP_HEADER_SIZE + MAP_DIRECTORY_ENTRY_SIZE, 1),
    });
    expect(() => decodeMapSnapshot(duplicated)).toThrow(/Couche dupliquée/);

    const wrongLength = buildMapFixture({
      corrupt: (view) => view.setUint32(MAP_HEADER_SIZE + 8, 1, true),
    });
    expect(() => decodeMapSnapshot(wrongLength)).toThrow(/Longueur invalide/);

    const wrongElementSize = buildMapFixture({
      corrupt: (view) => view.setUint8(MAP_HEADER_SIZE + 1, 2),
    });
    expect(() => decodeMapSnapshot(wrongElementSize)).toThrow(/Taille d’élément invalide/);
  });

  it('refuse un offset de données ou de couche hors limites', () => {
    const badDataOffset = buildMapFixture();
    setHeaderU32(badDataOffset, 36, MAP_HEADER_SIZE);
    expect(() => decodeMapSnapshot(badDataOffset)).toThrow(/Offset de données invalide/);

    const outOfBounds = buildMapFixture({
      corrupt: (view) => view.setUint32(MAP_HEADER_SIZE + 4, 0xffff, true),
    });
    expect(() => decodeMapSnapshot(outOfBounds)).toThrow(/hors du buffer/);
  });
});
