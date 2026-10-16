// Protocol constants (02 §1).

/** Wire protocol version, also in the share string prefix and relay URLs (01, Versioning). */
export const PROTOCOL_VERSION = 1;

export const SHARE_PREFIX = "pw1_";

/** Bytes of CSPRNG output in a room secret. */
export const SECRET_BYTES = 32;

/**
 * Relay used by share strings without an `@host` part: the hosted relay, deployed in M2-6 and
 * kept as the production host for 0.1.0. If set to `null`, such share strings are refused with
 * "no default relay configured; set PAIRWIRE_RELAY".
 */
export const DEFAULT_RELAY_HOST: string | null = "pairwire-relay.tazo.workers.dev";
