import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { findLeaks, forms } from "./blindness.js";

describe("INV-1 leak detector (control)", () => {
  it("INV-1 finds secrets planted in a path, a text frame or a binary frame, in any encoding", () => {
    const psk = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const rec = {
      paths: ["/v1/rooms/abc"],
      frames: [
        utf8ToBytes('{"t":"join","v":1,"token":null,"note":"Tazo-Display-Name"}'),
        Uint8Array.from([0x02, ...utf8ToBytes(`junk${bytesToHex(psk)}junk`)]),
      ],
    };
    const leaks = findLeaks(rec, [...forms("name", "Tazo-Display-Name"), ...forms("psk", psk), ...forms("absent", "NOT-THERE")]);
    expect(leaks).toEqual(["name", "psk (hex)"]);
  });
});
