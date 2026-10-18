// Relay-wide limits (03, Node implementation: Relay-wide limits; ADR-032). All rooms share
// one process, so these bound the relay as a whole on top of the per-room limits.

const MiB = 1024 * 1024;

export interface RelayCaps {
  /** Open WebSockets on the relay; 0: no cap. */
  maxSockets: number;
  /** Open WebSockets from one client address; 0: no cap (the default, see trustProxy). */
  maxSocketsPerAddress: number;
  /** Rooms the relay holds (state, sockets or a timer); 0: no cap. */
  maxRooms: number;
  /** Offline-buffered frame bytes across all rooms; 0: no cap. */
  maxBufferedBytes: number;
  /** Per-socket send queue; a frame that would pass it closes the socket with 4008. Not an env setting. */
  maxOutboundBytes: number;
  /** Take the client address from the last X-Forwarded-For entry instead of the TCP peer. */
  trustProxy: boolean;
}

export const DEFAULT_CAPS: RelayCaps = {
  maxSockets: 1024,
  maxSocketsPerAddress: 0,
  maxRooms: 10_000,
  maxBufferedBytes: 256 * MiB,
  maxOutboundBytes: 2 * MiB,
  trustProxy: false,
};

const COUNTS = {
  PAIRWIRE_RELAY_MAX_SOCKETS: ["maxSockets", 1],
  PAIRWIRE_RELAY_MAX_SOCKETS_PER_ADDRESS: ["maxSocketsPerAddress", 1],
  PAIRWIRE_RELAY_MAX_ROOMS: ["maxRooms", 1],
  PAIRWIRE_RELAY_MAX_BUFFERED_MIB: ["maxBufferedBytes", MiB],
} as const;

/** The caps set in the environment; unset or empty variables are left out. Throws on a bad value. */
export function capsFromEnv(env: Record<string, string | undefined>): Partial<RelayCaps> {
  const caps: Partial<RelayCaps> = {};
  for (const [name, [key, unit]] of Object.entries(COUNTS)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    const n = /^\d+$/.test(value) ? Number(value) * unit : NaN;
    if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a non-negative integer (0 turns the cap off)`);
    caps[key] = n;
  }
  const trust = env.PAIRWIRE_RELAY_TRUST_PROXY;
  if (trust !== undefined) {
    if (trust !== "" && trust !== "0" && trust !== "1") throw new Error("PAIRWIRE_RELAY_TRUST_PROXY must be 1, 0 or unset");
    caps.trustProxy = trust === "1";
  }
  return caps;
}
