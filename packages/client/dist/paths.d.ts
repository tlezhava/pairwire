export declare const ROOM_ID_PATTERN: RegExp;
export type RoomFile = "secret" | "state.json" | "inbox.jsonl" | "delivered.json" | "outbox.jsonl" | "transcript.md";
/** `PAIRWIRE_HOME`, else `~/.pairwire`. */
export declare function pairwireHome(env?: NodeJS.ProcessEnv): string;
export declare const configPath: (home: string) => string;
export declare const activeFlagPath: (home: string) => string;
export declare const hookErrorsPath: (home: string) => string;
export declare const bindingsDir: (home: string) => string;
export declare const roomsDir: (home: string) => string;
export declare function assertRoomId(roomId: string): void;
export declare function roomDir(home: string, roomId: string): string;
export declare function roomFile(home: string, roomId: string, file: RoomFile): string;
/**
 * `rooms/<id>/ctl.sock` if that is under 100 bytes, else `$XDG_RUNTIME_DIR/pairwire-<id12>.sock`,
 * else `/tmp/pairwire-<uid>/<id12>.sock` (the caller creates that directory as 0700).
 */
export declare function chooseCtlPath(home: string, roomId: string, env?: NodeJS.ProcessEnv, uid?: number): string;
//# sourceMappingURL=paths.d.ts.map