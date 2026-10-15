import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { generateSecret } from "../src/share.js";
import { deriveRoomKeys } from "../src/keys.js";

describe("key schedule (02 §2)", () => {
  it("reproduces the 02 §7 vectors", () => {
    const keys = deriveRoomKeys(hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"));
    expect(bytesToHex(keys.roomIdBytes)).toBe("3055abda71ec19045c0abb9f69044b15");
    expect(keys.roomId).toBe("gbk2xwtr5qmqixakxopwsbclcu");
    expect(bytesToHex(keys.psk)).toBe("dd78b7e928a668e3c93bf42626691e45f11124b3c748a839dea5801791185bc5");
    expect(bytesToHex(keys.helloKey)).toBe("7fac867115a026060f67d251f5144e264b7b8dbfa256faf31b320b2e51e9d122");
  });

  it("produces a room_id the relay accepts (03: ^[a-z2-7]{26}$) and independent keys", () => {
    for (let i = 0; i < 20; i++) {
      const keys = deriveRoomKeys(generateSecret());
      expect(keys.roomId).toMatch(/^[a-z2-7]{26}$/);
      expect(keys.roomIdBytes).toHaveLength(16);
      expect(keys.psk).toHaveLength(32);
      expect(keys.helloKey).toHaveLength(32);
      expect(bytesToHex(keys.psk)).not.toBe(bytesToHex(keys.helloKey));
      expect(bytesToHex(keys.psk).startsWith(bytesToHex(keys.roomIdBytes))).toBe(false);
    }
  });

  it("is deterministic and rejects secrets that are not 32 bytes", () => {
    const secret = generateSecret();
    expect(deriveRoomKeys(secret)).toEqual(deriveRoomKeys(secret));
    expect(() => deriveRoomKeys(new Uint8Array(16))).toThrow();
    expect(() => deriveRoomKeys(new Uint8Array(33))).toThrow();
  });
});
