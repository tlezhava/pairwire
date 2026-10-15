// @pairwire/core — isomorphic protocol library (specs/02-protocol.md). No I/O.
export { base32Decode, base32Encode } from "./base32.js";
export { SALT, deriveRoomKeys, type RoomKeys } from "./keys.js";
export { DEFAULT_RELAY_HOST, PROTOCOL_VERSION, SECRET_BYTES, SHARE_PREFIX } from "./config.js";
export {
  NoDefaultRelayError,
  ShareStringError,
  encodeShareString,
  formatRelayAddress,
  generateSecret,
  parseRelayAddress,
  parseShareString,
  relayUrl,
  type ParsedShareString,
  type RelayAddress,
  type ShareStringErrorCode,
} from "./share.js";
