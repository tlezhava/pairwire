// Key schedule (02 §2). The relay learns room_id only; it cannot derive psk from it.
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base32Encode } from "./base32.js";
import { SECRET_BYTES } from "./config.js";

/** HKDF salt for every derivation unless a section says otherwise. */
export const SALT = utf8ToBytes("pairwire/v1");

export interface RoomKeys {
  roomIdBytes: Uint8Array;
  /** base32(room_id_bytes): 26 lowercase characters, used in relay URLs. */
  roomId: string;
  psk: Uint8Array;
  helloKey: Uint8Array;
}

export function deriveRoomKeys(secret: Uint8Array): RoomKeys {
  if (secret.length !== SECRET_BYTES) throw new Error(`secret must be ${SECRET_BYTES} bytes`);
  const roomIdBytes = hkdf(sha256, secret, SALT, utf8ToBytes("room-id"), 16);
  const psk = hkdf(sha256, secret, SALT, utf8ToBytes("psk"), 32);
  const helloKey = hkdf(sha256, psk, SALT, utf8ToBytes("hello"), 32);
  return { roomIdBytes, roomId: base32Encode(roomIdBytes), psk, helloKey };
}
