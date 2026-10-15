// @pairwire/core — isomorphic protocol library (specs/02-protocol.md). No I/O.
export { base32Decode, base32Encode } from "./base32.js";
export {
  EnvelopeTooLargeError,
  KINDS,
  MAX_BODY_BYTES,
  MAX_ENVELOPE_BYTES,
  MSG_TYPE,
  envelopeSchema,
  makeAck,
  msgAad,
  openMsg,
  parseEnvelope,
  receiveDecision,
  sealMsg,
  serializeEnvelope,
  type Envelope,
  type EnvelopeRejection,
  type Kind,
  type OpenMsgResult,
} from "./envelope.js";
export {
  HARNESSES,
  HELLO_TYPE,
  Handshake,
  HandshakeAbort,
  MAX_HELLO_FAILURES,
  deriveSession,
  helloAad,
  helloPayloadSchema,
  openHello,
  sealHello,
  type HandshakeAbortReason,
  type Harness,
  type HelloEvent,
  type HelloPayload,
  type OpenHelloResult,
  type Session,
} from "./handshake.js";
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
