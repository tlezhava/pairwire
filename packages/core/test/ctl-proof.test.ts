// Control-channel server proof (04 §8, ADR-029, INV-10).
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { CTL_KEY_BYTES, CTL_NONCE_BYTES, ctlProof, verifyCtlProof } from "../src/ctl-proof.js";

const KEY = hexToBytes("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f");
const ROOM = hexToBytes("3055abda71ec19045c0abb9f69044b15");
const NONCE = hexToBytes("606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f");
const MAC = "053e28b6b8107561bec09bdee867de359bcc1e426dd096daa3373d814abc6e2d";

describe("ctl server proof (04 §8)", () => {
  it("INV-10 ctlProof reproduces the 04 §8 vector", () => {
    expect(bytesToHex(ctlProof(KEY, ROOM, NONCE))).toBe(MAC);
    expect(CTL_KEY_BYTES).toBe(32);
    expect(CTL_NONCE_BYTES).toBe(32);
  });

  it("INV-10 verifyCtlProof accepts the vector and refuses any change", () => {
    const mac = hexToBytes(MAC);
    expect(verifyCtlProof(KEY, ROOM, NONCE, mac)).toBe(true);
    for (let i = 0; i < mac.length * 8; i += 37) {
      const bad = mac.slice();
      bad[i >> 3]! ^= 1 << (i & 7);
      expect(verifyCtlProof(KEY, ROOM, NONCE, bad)).toBe(false);
    }
    const flip = (b: Uint8Array) => {
      const c = b.slice();
      c[0]! ^= 1;
      return c;
    };
    expect(verifyCtlProof(flip(KEY), ROOM, NONCE, mac)).toBe(false);
    expect(verifyCtlProof(KEY, flip(ROOM), NONCE, mac)).toBe(false);
    expect(verifyCtlProof(KEY, ROOM, flip(NONCE), mac)).toBe(false);
    expect(verifyCtlProof(KEY, ROOM, NONCE, mac.slice(0, 31))).toBe(false);
    expect(verifyCtlProof(KEY, ROOM, NONCE, new Uint8Array(0))).toBe(false);
  });

  it("rejects inputs of the wrong length", () => {
    expect(() => ctlProof(KEY.slice(0, 31), ROOM, NONCE)).toThrow();
    expect(() => ctlProof(KEY, ROOM.slice(0, 15), NONCE)).toThrow();
    expect(() => ctlProof(KEY, ROOM, NONCE.slice(0, 16))).toThrow();
    expect(verifyCtlProof(KEY.slice(0, 31), ROOM, NONCE, hexToBytes(MAC))).toBe(false);
  });
});
