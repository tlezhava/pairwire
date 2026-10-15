// pairwire client: MCP server, hooks and CLI (specs/04-client.md).
export { bindProject, bindingPath, claimProject, isProcessAlive, PassiveSessionError, readBinding, removeBindingFor, sessionOwnsBinding } from "./binding.js";
export { ConfigError, DEFAULT_CONFIG, loadConfig, resolveDisplayName } from "./config.js";
export { LockTimeoutError, withLock, writeFileAtomic } from "./fs-util.js";
export { closeRoomLocally } from "./lifecycle.js";
export { pairwireHome } from "./paths.js";
export { assertStatePrivate, checkStatePermissions, StatePermissionError } from "./permissions.js";
export { projectHash, resolveProjectDir } from "./project.js";
export { createRoom, expiresAt, isOpen, listRooms, readSecret, readState, refreshActiveFlag, StateError, updateState } from "./state.js";
//# sourceMappingURL=index.js.map