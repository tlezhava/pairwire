// Relay → client text frames (02 §5, ADR-031). The relay is an adversary (05, A1): every
// field the client uses is bounded here before it reaches the handshake, timers or state.
import { z } from "zod";

/** The longest pause a relay can ask for with `retry_after`, in seconds. */
export const MAX_RETRY_AFTER_S = 3600;

const u32 = z.number().int().min(0).max(0xffffffff);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const relayFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("joined"),
    member: z.enum(["a", "b"]),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    epoch: u32,
    peer_present: z.boolean(),
    buffered: count,
    expires_at: count,
  }),
  z.object({ t: z.literal("peer_joined"), epoch: u32 }),
  z.object({ t: z.literal("peer_left"), reason: z.enum(["disconnected", "left"]) }),
  z.object({
    t: z.literal("error"),
    code: z.string().regex(/^[a-z_]{1,32}$/),
    retry_after: z.number().min(0).max(MAX_RETRY_AFTER_S).optional(),
  }),
  z.object({ t: z.literal("pong") }),
]);
export type RelayFrame = z.output<typeof relayFrameSchema>;

const KNOWN: ReadonlySet<string> = new Set(relayFrameSchema.options.map((o) => o.shape.t.value));

export type RelayFrameResult =
  | { ok: true; frame: RelayFrame }
  /** A newer relay's frame: ignore it. */
  | { ok: false; reason: "unknown_type" }
  /**
   * A relay protocol error. `t` is set only for a known type and `fields` holds only names
   * from the schema, so both can be logged: no relay-chosen text reaches them.
   */
  | { ok: false; reason: "invalid"; t: RelayFrame["t"] | null; fields: string[] };

export function parseRelayFrame(text: string): RelayFrameResult {
  const invalid = (t: RelayFrame["t"] | null, fields: string[] = []): RelayFrameResult => ({ ok: false, reason: "invalid", t, fields });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid(null);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return invalid(null);
  const t = (json as { t?: unknown }).t;
  if (typeof t !== "string") return invalid(null);
  if (!KNOWN.has(t)) return { ok: false, reason: "unknown_type" };
  const parsed = relayFrameSchema.safeParse(json);
  if (parsed.success) return { ok: true, frame: parsed.data };
  const fields = new Set(parsed.error.issues.map((i) => i.path[0]).filter((k): k is string => typeof k === "string"));
  return invalid(t as RelayFrame["t"], [...fields].sort());
}
