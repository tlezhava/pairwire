// Control-channel server proof (04 §8, ADR-029): the owning MCP server proves it holds the
// room's ctl.key by answering a client nonce with HMAC-SHA256 over a label, room_id_bytes and
// the nonce. No I/O; the client and server do the file and socket work.
import { equalBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const CTL_KEY_BYTES = 32;
export const CTL_NONCE_BYTES = 32;
const ROOM_ID_BYTES = 16;
const LABEL = utf8ToBytes("pairwire/v1/ctl-proof");

/** mac = HMAC-SHA256(key, "pairwire/v1/ctl-proof" || room_id_bytes || nonce). Throws on wrong lengths. */
export function ctlProof(key: Uint8Array, roomIdBytes: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (key.length !== CTL_KEY_BYTES) throw new Error(`ctl key must be ${CTL_KEY_BYTES} bytes`);
  if (roomIdBytes.length !== ROOM_ID_BYTES) throw new Error(`room_id_bytes must be ${ROOM_ID_BYTES} bytes`);
  if (nonce.length !== CTL_NONCE_BYTES) throw new Error(`ctl nonce must be ${CTL_NONCE_BYTES} bytes`);
  return hmac(sha256, key, concatBytes(LABEL, roomIdBytes, nonce));
}

/** Constant-time check of a server's proof; false (never a throw) for any malformed input. */
export function verifyCtlProof(key: Uint8Array, roomIdBytes: Uint8Array, nonce: Uint8Array, mac: Uint8Array): boolean {
  let expected: Uint8Array;
  try {
    expected = ctlProof(key, roomIdBytes, nonce);
  } catch {
    return false;
  }
  return mac.length === expected.length && equalBytes(expected, mac);
}
