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
