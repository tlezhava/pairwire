// RFC 4648 base32, lowercase alphabet, no padding (02 §1, §2). Decoding is strict:
// lowercase only, no padding, and the unused low bits of the last character must be zero.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const VALUES = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Character counts mod 8 that some byte length produces (0, 2, 4, 5 or 7). */
const VALID_REMAINDERS = new Set([0, 2, 4, 5, 7]);

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  if (!VALID_REMAINDERS.has(text.length % 8)) throw new Error("base32: invalid length");
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let i = 0;
  for (const c of text) {
    const v = VALUES.get(c);
    if (v === undefined) throw new Error("base32: invalid character");
    buffer = ((buffer << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error("base32: non-canonical encoding");
  return out;
}
