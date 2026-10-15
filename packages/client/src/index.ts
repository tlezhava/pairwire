// pairwire client: MCP server, hooks and CLI (specs/04-client.md).
export { bindProject, bindingPath, claimProject, isProcessAlive, PassiveSessionError, readBinding, removeBindingFor, sessionOwnsBinding, type Binding, type Claimant, type Ownership } from "./binding.js";
export { ConfigError, DEFAULT_CONFIG, loadConfig, resolveDisplayName, type Config, type Delivery, type LoadedConfig } from "./config.js";
export { LockTimeoutError, withLock, writeFileAtomic } from "./fs-util.js";
export { closeRoomLocally } from "./lifecycle.js";
export { createLogger, fileSink, hookErrorLogger, parseLogLevel, roomTag, type LogFields, type Logger, type LogLevel, type LogSink } from "./log.js";
export { pairwireHome } from "./paths.js";
export { assertStatePrivate, checkStatePermissions, StatePermissionError, type PermissionProblem } from "./permissions.js";
export { projectHash, resolveProjectDir } from "./project.js";
export { createRoom, expiresAt, isOpen, listRooms, readSecret, readState, refreshActiveFlag, StateError, updateState, type RoomState, type RoomStatus } from "./state.js";
export { DEFAULT_TUNING, RoomConnection, realTimers, wsSocketFactory, type ConnectionEvents, type ConnectionOptions, type ConnectionStatus, type EndReason, type SendInput, type SocketFactory, type Timers, type Tuning } from "./connection.js";
export { appendInbox, readInbox, readOutbox, updateOutbox, type InboxEntry, type OutboxEntry } from "./room-files.js";
export { createMcpServer, runMcpServer } from "./mcp.js";
export { ClientSession, type SessionOptions, type ToolResult } from "./session.js";
export { CLIENT_VERSION } from "./version.js";
export { appendTranscript, transcriptTail } from "./transcript.js";
export { runCtl } from "./ctl.js";
export { nodeAdvice, runDoctor, runPurge } from "./doctor.js";
