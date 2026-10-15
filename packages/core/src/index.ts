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
export { CLIENT_LIMITS, RELAY_LIMITS, SUPPORTED_PROTOCOLS, relayInfo } from "./limits.js";
export {
  CLOSE,
  RelayRoom,
  base64url,
  type BufferedFrame,
  type Effect,
  type Member,
  type Output,
  type RoomState,
  type Slot,
  type SocketId,
} from "./relay-room.js";
export {
  HOOK_CONTEXT_CAP,
  HOOK_MAX_BODY,
  PREAMBLE,
  noticePeerChanged,
  noticePeerJoined,
  noticePeerLeft,
  noticeWrongKey,
  renderForHook,
  renderItems,
  renderTranscript,
  TRANSCRIPT_PREAMBLE,
  type HookRender,
  type Notice,
  type NoticeEvent,
  type RenderItem,
} from "./render.js";
export { SECRET_RULES_VERSION, redact, scanSecrets, type SecretFinding, type SecretRuleId } from "./secrets.js";
export { ANONYMOUS, NAME_MAX_CHARS, displayName, escapeAttr, sanitizeAttr, sanitizeText } from "./sanitize.js";
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
