// Protocol constants (02 §1).

/** Wire protocol version, also in the share string prefix and relay URLs (01, Versioning). */
export const PROTOCOL_VERSION = 1;

export const SHARE_PREFIX = "pw1_";

/** Bytes of CSPRNG output in a room secret. */
export const SECRET_BYTES = 32;

/**
 * Relay used by share strings without an `@host` part. Set before the first release
 * (task M2-6 for development builds). While `null`, such share strings are refused with
 * "no default relay configured; set PAIRWIRE_RELAY".
 */
export const DEFAULT_RELAY_HOST: string | null = null;
