// Limits shared by both relays and the client (03, Limits; 02 §3, §6; 04 §7).

const SECOND = 1000;
const HOUR = 3600 * SECOND;

/** Relay limits, reported at GET /v1/info. */
export const RELAY_LIMITS = {
  membersPerRoom: 2,
  joinDeadlineMs: 10 * SECOND,
  maxBinaryFrameBytes: 64 * 1024,
  maxControlFrameBytes: 1024,
  binaryFramesPerMinute: 60,
  binaryFrameBurst: 20,
  offlineBufferFrames: 100,
  offlineBufferBytes: 1024 * 1024,
  bufferedFrameLifetimeMs: 72 * HOUR,
  idleExpiryMs: 72 * HOUR,
  maxAgeMs: 7 * 24 * HOUR,
} as const;

/** Client-side limits; each stays below the matching relay limit. */
export const CLIENT_LIMITS = {
  maxFrameBytes: 32 * 1024,
  sendsPerMinute: 20,
  binaryFramesPer10s: 8,
  pingIntervalMs: 30 * SECOND,
  ackDelayMs: 2 * SECOND,
  resendAfterMs: 15 * SECOND,
} as const;

export const SUPPORTED_PROTOCOLS = [1] as const;

/** Body of GET /v1/info (03, HTTP surface). */
export function relayInfo(relayVersion: string) {
  return { protocol: [...SUPPORTED_PROTOCOLS], relay: relayVersion, limits: RELAY_LIMITS };
}
