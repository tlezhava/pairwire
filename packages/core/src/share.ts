// Share string codec and relay address rules (02 §1, REQ-ROOM-8, REQ-INST-2).
// Error messages describe what is wrong and never echo the input (INV-7).
import { randomBytes } from "@noble/hashes/utils.js";
import { base32Decode, base32Encode } from "./base32.js";
import { DEFAULT_RELAY_HOST, SECRET_BYTES, SHARE_PREFIX } from "./config.js";

export interface RelayAddress {
  /** Lowercase hostname, IPv4 address, or the literal "[::1]". */
  host: string;
  port?: number;
}

export interface ParsedShareString {
  secret: Uint8Array;
  /** `null` means the built-in default relay. */
  relay: RelayAddress | null;
}

export type ShareStringErrorCode =
  | "empty"
  | "too_long"
  | "bad_prefix"
  | "unsupported_version"
  | "bad_secret_chars"
  | "bad_secret_length"
  | "non_canonical"
  | "bad_host"
  | "bad_port";

export class ShareStringError extends Error {
  override readonly name = "ShareStringError";
  constructor(
    readonly code: ShareStringErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class NoDefaultRelayError extends Error {
  override readonly name = "NoDefaultRelayError";
  constructor() {
    super("no default relay configured; set PAIRWIRE_RELAY");
  }
}

const SECRET_CHARS = 52;
/** Longest valid string: prefix + secret + "@" + 253-char host + ":65535". */
const MAX_INPUT = 400;
const HOST = /^[a-z0-9.-]{1,253}$/;
const IPV6_LOOPBACK = "[::1]";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", IPV6_LOOPBACK]);

const fail = (code: ShareStringErrorCode, message: string): never => {
  throw new ShareStringError(code, message);
};

export function generateSecret(): Uint8Array {
  return randomBytes(SECRET_BYTES);
}

export function encodeShareString(secret: Uint8Array, relay?: RelayAddress): string {
  if (secret.length !== SECRET_BYTES) throw new Error(`secret must be ${SECRET_BYTES} bytes`);
  let out = SHARE_PREFIX + base32Encode(secret);
  if (relay) {
    const text = formatRelayAddress(relay);
    parseHostPort(text); // validates host and port with the parser's rules
    out += `@${text}`;
  }
  return out;
}

export function parseShareString(input: string): ParsedShareString {
  const text = input.trim();
  if (text === "") fail("empty", "The share string is empty. Paste the whole string, starting with pw1_.");
  if (text.length > MAX_INPUT) fail("too_long", "That text is too long to be a pairwire share string.");

  const lower = text.toLowerCase();
  if (!lower.startsWith(SHARE_PREFIX)) {
    if (/^pw\d+_/.test(lower)) {
      fail(
        "unsupported_version",
        "This share string is for a pairwire protocol version this client doesn't support (it speaks pw1). Update pairwire on both sides.",
      );
    }
    fail("bad_prefix", "This is not a pairwire share string: it should start with pw1_.");
  }

  const rest = lower.slice(SHARE_PREFIX.length);
  const at = rest.indexOf("@");
  const secretPart = at < 0 ? rest : rest.slice(0, at);

  if (!/^[a-z2-7]*$/.test(secretPart)) {
    fail(
      "bad_secret_chars",
      "The key part of the share string contains characters other than a-z and 2-7. It may have been mangled when copying.",
    );
  }
  if (secretPart.length !== SECRET_CHARS) {
    fail(
      "bad_secret_length",
      `The key part of the share string has ${secretPart.length} characters but should have ${SECRET_CHARS}. Part of it may be missing.`,
    );
  }
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretPart);
  } catch {
    return fail("non_canonical", "The key part of the share string is not valid: its last character is wrong. It may have been mistyped.");
  }

  return { secret, relay: at < 0 ? null : parseHostPort(rest.slice(at + 1)) };
}

/** Parses a relay address from configuration (`PAIRWIRE_RELAY`, `config.json` "relay"). */
export function parseRelayAddress(input: string): RelayAddress {
  const text = input.trim().toLowerCase();
  if (text.includes("://")) {
    fail("bad_host", "Give the relay as a host name with an optional port, without a scheme such as wss://.");
  }
  return parseHostPort(text);
}

export function formatRelayAddress(relay: RelayAddress): string {
  return relay.port === undefined ? relay.host : `${relay.host}:${relay.port}`;
}

/** WebSocket base URL for a relay; `null` selects the default relay. */
export function relayUrl(relay: RelayAddress | null, defaultHost: string | null = DEFAULT_RELAY_HOST): string {
  let address = relay;
  if (address === null) {
    if (defaultHost === null) throw new NoDefaultRelayError();
    address = parseRelayAddress(defaultHost);
  }
  const scheme = LOOPBACK_HOSTS.has(address.host) ? "ws" : "wss";
  return `${scheme}://${formatRelayAddress(address)}`;
}

function parseHostPort(text: string): RelayAddress {
  let host: string;
  let port: string | undefined;
  if (text.startsWith("[")) {
    if (!text.startsWith(IPV6_LOOPBACK)) badHost();
    host = IPV6_LOOPBACK;
    const after = text.slice(IPV6_LOOPBACK.length);
    if (after !== "" && !after.startsWith(":")) badHost();
    port = after === "" ? undefined : after.slice(1);
  } else {
    const colon = text.indexOf(":");
    host = colon < 0 ? text : text.slice(0, colon);
    port = colon < 0 ? undefined : text.slice(colon + 1);
    if (!HOST.test(host)) badHost();
  }
  if (port === undefined) return { host };
  const n = /^[0-9]{1,5}$/.test(port) ? Number(port) : NaN;
  if (!(n >= 1 && n <= 65535)) fail("bad_port", "The relay port after ':' must be a number from 1 to 65535.");
  return { host, port: n };
}

function badHost(): never {
  return fail(
    "bad_host",
    "The relay address is not a valid host name: use letters, digits, dots and hyphens (IPv6 only as [::1]).",
  );
}
