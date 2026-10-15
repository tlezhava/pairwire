import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "../src/base32.js";

describe("base32 (RFC 4648, lowercase, no padding)", () => {
  it("encodes the 02 §7 secret and room_id vectors", () => {
    const secret = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    expect(base32Encode(secret)).toBe("aaaqeayeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypq");
    expect(base32Encode(hexToBytes("3055abda71ec19045c0abb9f69044b15"))).toBe("gbk2xwtr5qmqixakxopwsbclcu");
  });

  it("matches the RFC 4648 §10 test vectors (lowercased, padding removed)", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["f", "my"],
      ["fo", "mzxq"],
      ["foo", "mzxw6"],
      ["foob", "mzxw6yq"],
      ["fooba", "mzxw6ytb"],
      ["foobar", "mzxw6ytboi"],
    ];
    for (const [text, encoded] of cases) {
      const bytes = new TextEncoder().encode(text);
      expect(base32Encode(bytes)).toBe(encoded);
      expect(bytesToHex(base32Decode(encoded))).toBe(bytesToHex(bytes));
    }
  });

  it("round-trips every length from 0 to 40 bytes", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it("rejects non-canonical input whose padding bits are not zero", () => {
    // "my" is canonical for "f"; "mz" carries a 1 in the discarded low bits.
    expect(() => base32Decode("mz")).toThrow(/non-canonical/);
    expect(() => base32Decode("aaaqeayeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypr")).toThrow(/non-canonical/);
  });

  it("rejects impossible lengths, uppercase, padding and characters outside a-z2-7", () => {
    for (const bad of ["a", "abc", "abcdef", "MY", "my======", "m1", "m8", "m0", "m y"]) {
      expect(() => base32Decode(bad), bad).toThrow();
    }
  });
});
