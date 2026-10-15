import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  NoDefaultRelayError,
  ShareStringError,
  encodeShareString,
  generateSecret,
  parseRelayAddress,
  parseShareString,
  relayUrl,
} from "../src/share.js";
import { DEFAULT_RELAY_HOST } from "../src/config.js";

const VECTOR_SECRET = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const VECTOR_SHARE = "pw1_aaaqeayeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypq";
const SECRET_PART = VECTOR_SHARE.slice(4);

function errorOf(input: string): ShareStringError {
  try {
    parseShareString(input);
  } catch (e) {
    if (e instanceof ShareStringError) return e;
    throw e;
  }
  throw new Error("expected parseShareString to throw");
}

describe("share string encoding (02 §1)", () => {
  it("encodes the 02 §7 vector", () => {
    expect(encodeShareString(VECTOR_SECRET)).toBe(VECTOR_SHARE);
  });

  it("decodes the 02 §7 vector to the default relay", () => {
    const parsed = parseShareString(VECTOR_SHARE);
    expect(parsed.secret).toEqual(VECTOR_SECRET);
    expect(parsed.relay).toBeNull();
  });

  it("round-trips random secrets with and without a relay suffix", () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateSecret();
      const relay = i % 2 ? { host: "relay.example.com", port: 8443 } : undefined;
      const parsed = parseShareString(encodeShareString(secret, relay));
      expect(parsed.secret).toEqual(secret);
      expect(parsed.relay).toEqual(relay ?? null);
    }
  });

  it("appends @host and :port only when given", () => {
    expect(encodeShareString(VECTOR_SECRET, { host: "relay.example.com" })).toBe(`${VECTOR_SHARE}@relay.example.com`);
    expect(encodeShareString(VECTOR_SECRET, { host: "localhost", port: 8787 })).toBe(`${VECTOR_SHARE}@localhost:8787`);
    expect(encodeShareString(VECTOR_SECRET, { host: "[::1]", port: 8787 })).toBe(`${VECTOR_SHARE}@[::1]:8787`);
  });

  it("refuses to encode a secret that is not 32 bytes or an invalid relay", () => {
    expect(() => encodeShareString(new Uint8Array(31))).toThrow();
    expect(() => encodeShareString(VECTOR_SECRET, { host: "bad_host" })).toThrow();
    expect(() => encodeShareString(VECTOR_SECRET, { host: "ok.example", port: 0 })).toThrow();
  });

  it("generates distinct 32-byte secrets", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });
});

describe("REQ-ROOM-8 share string parsing", () => {
  it("REQ-ROOM-8 accepts surrounding whitespace and uppercase, lowercasing the host", () => {
    const parsed = parseShareString(`  \n\t${VECTOR_SHARE.toUpperCase()}@Relay.Example.COM:443 \n`);
    expect(parsed.secret).toEqual(VECTOR_SECRET);
    expect(parsed.relay).toEqual({ host: "relay.example.com", port: 443 });
  });

  it("REQ-ROOM-8 accepts the IPv6 loopback and ports at the 1..65535 bounds", () => {
    expect(parseShareString(`${VECTOR_SHARE}@[::1]:1`).relay).toEqual({ host: "[::1]", port: 1 });
    expect(parseShareString(`${VECTOR_SHARE}@localhost:65535`).relay).toEqual({ host: "localhost", port: 65535 });
  });

  const malformed: [string, string, ShareStringError["code"]][] = [
    ["empty", "", "empty"],
    ["only whitespace", "   \n ", "empty"],
    ["no prefix", SECRET_PART, "bad_prefix"],
    ["unrelated text", "hello world", "bad_prefix"],
    ["future version", `pw2_${SECRET_PART}`, "unsupported_version"],
    ["secret too short", VECTOR_SHARE.slice(0, -1), "bad_secret_length"],
    ["secret too long", `${VECTOR_SHARE}a`, "bad_secret_length"],
    ["digit 1 in secret", `pw1_1${SECRET_PART.slice(1)}`, "bad_secret_chars"],
    ["padding in secret", `pw1_${SECRET_PART.slice(0, -1)}=`, "bad_secret_chars"],
    ["space inside secret", `pw1_${SECRET_PART.slice(0, 10)} ${SECRET_PART.slice(11)}`, "bad_secret_chars"],
    ["non-canonical last character", `${VECTOR_SHARE.slice(0, -1)}r`, "non_canonical"],
    ["empty host", `${VECTOR_SHARE}@`, "bad_host"],
    ["underscore in host", `${VECTOR_SHARE}@relay_host.example`, "bad_host"],
    ["IDN host", `${VECTOR_SHARE}@rélay.example`, "bad_host"],
    ["IPv6 other than ::1", `${VECTOR_SHARE}@[2001:db8::1]`, "bad_host"],
    ["host longer than 253", `${VECTOR_SHARE}@${"a".repeat(254)}`, "bad_host"],
    ["path after host", `${VECTOR_SHARE}@relay.example.com/v1`, "bad_host"],
    ["empty port", `${VECTOR_SHARE}@relay.example.com:`, "bad_port"],
    ["port 0", `${VECTOR_SHARE}@relay.example.com:0`, "bad_port"],
    ["port 65536", `${VECTOR_SHARE}@relay.example.com:65536`, "bad_port"],
    ["six-digit port", `${VECTOR_SHARE}@relay.example.com:100000`, "bad_port"],
    ["non-numeric port", `${VECTOR_SHARE}@relay.example.com:https`, "bad_port"],
    ["two @ signs", `${VECTOR_SHARE}@a.example@b.example`, "bad_host"],
    ["absurdly long input", `${VECTOR_SHARE}@${"a".repeat(5000)}`, "too_long"],
  ];

  for (const [name, input, code] of malformed) {
    it(`REQ-ROOM-8 rejects ${name} with ${code}, without echoing the input`, () => {
      const err = errorOf(input);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(10);
      // The message must not contain the string, its secret part, or the host the user typed.
      for (const fragment of [input.trim(), SECRET_PART, SECRET_PART.slice(0, 12), "relay_host", "rélay", "2001:db8"]) {
        if (fragment.length >= 6) expect(err.message.toLowerCase()).not.toContain(fragment.toLowerCase());
      }
    });
  }
});

describe("relay addresses and URLs", () => {
  it("parses configured relay addresses with the share-string host rules", () => {
    expect(parseRelayAddress("Relay.Example.com")).toEqual({ host: "relay.example.com" });
    expect(parseRelayAddress(" localhost:8787 ")).toEqual({ host: "localhost", port: 8787 });
    expect(parseRelayAddress("[::1]:8787")).toEqual({ host: "[::1]", port: 8787 });
    expect(() => parseRelayAddress("wss://relay.example.com")).toThrow(ShareStringError);
    expect(() => parseRelayAddress("relay.example.com:0")).toThrow(ShareStringError);
  });

  it("derives wss:// for remote hosts and ws:// only for loopback hosts", () => {
    expect(relayUrl({ host: "relay.example.com" }, null)).toBe("wss://relay.example.com");
    expect(relayUrl({ host: "relay.example.com", port: 8443 }, null)).toBe("wss://relay.example.com:8443");
    expect(relayUrl({ host: "localhost", port: 8787 }, null)).toBe("ws://localhost:8787");
    expect(relayUrl({ host: "127.0.0.1", port: 8787 }, null)).toBe("ws://127.0.0.1:8787");
    expect(relayUrl({ host: "[::1]", port: 8787 }, null)).toBe("ws://[::1]:8787");
    expect(relayUrl({ host: "localhost.example.com" }, null)).toBe("wss://localhost.example.com");
    expect(relayUrl({ host: "127.0.0.2" }, null)).toBe("wss://127.0.0.2");
  });

  it("uses the default relay when the share string has no host", () => {
    expect(relayUrl(null, "relay.pairwire.dev")).toBe("wss://relay.pairwire.dev");
    expect(relayUrl(null)).toBe(`wss://${DEFAULT_RELAY_HOST}`);
  });

  it("refuses a host-less share string while no default relay is configured", () => {
    expect(() => relayUrl(null, null)).toThrow(NoDefaultRelayError);
    expect(() => relayUrl(null, null)).toThrow("no default relay configured; set PAIRWIRE_RELAY");
  });
});
