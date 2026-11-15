/**
 * Encodage base64 autonome (pas de `Buffer`, pas de `btoa`) : il sert à la
 * sérialisation JSON des tableaux binaires de la carte dans `save()`.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  const length = bytes.length;
  for (let i = 0; i < length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < length ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < length ? (bytes[i + 2] ?? 0) : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triplet >> 18) & 63];
    out += ALPHABET[(triplet >> 12) & 63];
    out += i + 1 < length ? ALPHABET[(triplet >> 6) & 63] : '=';
    out += i + 2 < length ? ALPHABET[triplet & 63] : '=';
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(byteLength);
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)] ?? -1;
    const c1 = LOOKUP[clean.charCodeAt(i + 1)] ?? -1;
    const c2 = LOOKUP[clean.charCodeAt(i + 2)] ?? -1;
    const c3 = LOOKUP[clean.charCodeAt(i + 3)] ?? -1;
    const triplet = ((c0 & 63) << 18) | ((c1 & 63) << 12) | ((c2 & 63) << 6) | (c3 & 63);
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 16) & 0xff;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 8) & 0xff;
    if (byteIndex < bytes.length) bytes[byteIndex++] = triplet & 0xff;
  }
  return bytes;
}
