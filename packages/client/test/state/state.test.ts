// Room state, bindings, passive mode and takeover, and INV-9 (04 §3).
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_LIMITS } from "@pairwire/core";
import { describe, expect, it } from "vitest";
import { bindingPath, bindProject, claimProject, PassiveSessionError, readBinding, sessionOwnsBinding } from "../../src/binding.js";
import { closeRoomLocally } from "../../src/lifecycle.js";
import { activeFlagPath, chooseCtlPath, isNamedPipePath, roomDir, roomFile } from "../../src/paths.js";
import { assertStatePrivate, checkStatePermissions, StatePermissionError } from "../../src/permissions.js";
import { createRoom, expiresAt, listRooms, readSecret, readState, StateError, updateState } from "../../src/state.js";
import { runChild, tempDir } from "./helpers.js";

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const ROOM2 = "zyxwvutsrqponmlkjihgfedcba";
const NOW = Date.UTC(2026, 9, 16, 12);
const secret = () => new Uint8Array(32).fill(7);
const mode = (path: string) => statSync(path).mode & 0o777;
const onWindows = process.platform === "win32";

function newHome() {
  return join(tempDir(), ".pairwire");
}

describe("room state", () => {
  it("creates a waiting room: 0700 directories, 0600 secret and state, the active flag", () => {
    const home = newHome();
    const state = createRoom(home, { roomId: ROOM, secret: secret(), relay: "relay.example.com", name: "Tazo", now: NOW }, {});
    expect(state).toMatchObject({ status: "waiting", relay: "relay.example.com", member: null, my_seq: 0, hop_count: 0, created_at: NOW, expires_at: null });
    if (onWindows) {
      // A named pipe with a random name, and no mode bits to check (04 §3).
      expect(isNamedPipePath(state.ctl_path)).toBe(true);
    } else {
      expect(state.ctl_path).toBe(chooseCtlPath(home, ROOM, {}));
      expect(mode(home)).toBe(0o700);
      expect(mode(roomDir(home, ROOM))).toBe(0o700);
      expect(mode(roomFile(home, ROOM, "secret"))).toBe(0o600);
      expect(mode(roomFile(home, ROOM, "state.json"))).toBe(0o600);
    }
    expect(readSecret(home, ROOM)).toEqual(secret());
    expect(readState(home, ROOM)).toEqual(state);
    expect(existsSync(activeFlagPath(home))).toBe(true);
    expect(listRooms(home)).toEqual([ROOM]);
  });

  it("refuses to create a room that is already stored", () => {
    const home = newHome();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    expect(() => createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {})).toThrow(StateError);
  });

  it("updates state under its lock and refuses an invalid result without touching the file", () => {
    const home = newHome();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    const next = updateState(home, ROOM, (s) => ({ ...s, status: "active", member: "a", epoch: 1, my_seq: 4 }));
    expect(readState(home, ROOM)).toEqual(next);
    expect(() => updateState(home, ROOM, (s) => ({ ...s, my_seq: -1 }))).toThrow();
    expect(() => updateState(home, ROOM, (s) => ({ ...s, extra: true }) as typeof s)).toThrow();
    expect(readState(home, ROOM)).toEqual(next);
    expect(readdirSync(roomDir(home, ROOM)).sort()).toEqual(["secret", "state.json"]);
  });

  it("reports a corrupt state file without quoting it", () => {
    const home = newHome();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    writeFileSync(roomFile(home, ROOM, "state.json"), '{"token":"pw1_leak');
    expect(() => readState(home, ROOM)).toThrow(StateError);
    expect(() => readState(home, ROOM)).not.toThrow(/pw1_/);
  });

  it("expires at the relay-reported time, else 7 days after creation", () => {
    const home = newHome();
    const state = createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    expect(expiresAt(state)).toBe(NOW + RELAY_LIMITS.maxAgeMs);
    expect(expiresAt({ ...state, expires_at: NOW + 1000 })).toBe(NOW + 1000);
  });

  it("REQ-ROOM-5 closing a room deletes the secret, keys and token and the binding, but keeps the transcript", () => {
    const home = newHome();
    const project = tempDir();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    updateState(home, ROOM, (s) => ({
      ...s,
      status: "active",
      token: "member-token",
      sessions: { current: { sid: "00".repeat(8), send_key: "11".repeat(32), recv_key: "22".repeat(32) }, previous: null },
    }));
    writeFileSync(roomFile(home, ROOM, "transcript.md"), "log\n", { mode: 0o600 });
    bindProject(home, project, ROOM, { pid: process.pid, session: "s1", now: NOW });

    const closed = closeRoomLocally(home, ROOM, "left");
    expect(closed).toMatchObject({ status: "left", token: null, sessions: { current: null, previous: null } });
    expect(readSecret(home, ROOM)).toBeNull();
    expect(readBinding(home, project)).toBeNull();
    expect(readFileSync(roomFile(home, ROOM, "transcript.md"), "utf8")).toBe("log\n");
    expect(existsSync(activeFlagPath(home))).toBe(false);
  });

  it("keeps the active flag while any room is open", () => {
    const home = newHome();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    createRoom(home, { roomId: ROOM2, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    closeRoomLocally(home, ROOM, "ended", "room expired");
    expect(readState(home, ROOM)?.error).toBe("room expired");
    expect(existsSync(activeFlagPath(home))).toBe(true);
    closeRoomLocally(home, ROOM2, "ended");
    expect(existsSync(activeFlagPath(home))).toBe(false);
  });
});

describe("bindings: one room per project directory", () => {
  const me = { pid: 1000, session: "session-me", now: NOW };
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  function boundHome(ownerPid: number) {
    const home = newHome();
    const project = tempDir();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    bindProject(home, project, ROOM, { pid: ownerPid, session: `session-${ownerPid}`, now: NOW }, alive([]));
    return { home, project };
  }

  it("is idle without a binding", () => {
    expect(claimProject(newHome(), tempDir(), me)).toEqual({ kind: "idle" });
  });

  it("runs passive while another live session owns the room, and cannot bind over it", () => {
    const { home, project } = boundHome(2000);
    expect(claimProject(home, project, me, alive([2000]))).toEqual({ kind: "passive", ownerPid: 2000, roomId: ROOM });
    expect(() => bindProject(home, project, ROOM2, me, alive([2000]))).toThrow(PassiveSessionError);
    expect(() => bindProject(home, project, ROOM2, me, alive([2000]))).toThrow("Another session in this project (pid 2000) owns the pairwire room.");
    expect(readBinding(home, project)?.owner_pid).toBe(2000);
  });

  it("REQ-ROOM-6 takes over the room of a dead owner and records the new session", () => {
    const { home, project } = boundHome(2000);
    expect(claimProject(home, project, me, alive([]))).toEqual({ kind: "owner", roomId: ROOM, tookOver: true });
    expect(readBinding(home, project)).toMatchObject({ room_id: ROOM, owner_pid: 1000, owner_session: "session-me" });
    expect(claimProject(home, project, me, alive([]))).toEqual({ kind: "owner", roomId: ROOM, tookOver: false });
  });

  it("drops a binding whose room has ended", () => {
    const { home, project } = boundHome(2000);
    updateState(home, ROOM, (s) => ({ ...s, status: "ended" }));
    expect(claimProject(home, project, me, alive([2000]))).toEqual({ kind: "idle" });
    expect(existsSync(bindingPath(home, project))).toBe(false);
  });

  it("lets exactly one of two servers starting together take over a dead owner", async () => {
    const { home, project } = boundHome(2000);
    const results = await Promise.all([3001, 3002, 3003].map((pid) => runChild(["claim", home, project, String(pid), "2000"])));
    const kinds = results.map((r) => JSON.parse(r) as { kind: string; tookOver?: boolean });
    expect(kinds.filter((k) => k.kind === "owner" && k.tookOver)).toHaveLength(1);
    expect(kinds.filter((k) => k.kind === "passive")).toHaveLength(2);
  }, 30_000);

  it("lets hooks deliver only for the owning session", () => {
    const { home, project } = boundHome(2000);
    const binding = readBinding(home, project);
    expect(sessionOwnsBinding(binding, "session-2000")).toBe(true);
    expect(sessionOwnsBinding(binding, "session-other")).toBe(false);
    expect(sessionOwnsBinding(binding, undefined)).toBe(false);
    expect(sessionOwnsBinding(binding && { ...binding, owner_session: null }, undefined)).toBe(false);
    expect(sessionOwnsBinding(null, "session-2000")).toBe(false);
  });
});

describe("INV-9 local state is private", () => {
  function homeWithRoom() {
    const home = newHome();
    createRoom(home, { roomId: ROOM, secret: secret(), relay: null, name: "Tazo", now: NOW }, {});
    bindProject(home, tempDir(), ROOM, { pid: process.pid, session: null, now: NOW });
    return home;
  }

  it("INV-9 accepts freshly created state", () => {
    const home = homeWithRoom();
    expect(checkStatePermissions(home)).toEqual([]);
    expect(() => assertStatePrivate(home)).not.toThrow();
    expect(checkStatePermissions(newHome())).toEqual([]); // nothing created yet
  });

  // Windows has no mode bits, and the check does not run there (04 §3, ADR-021).
  it.skipIf(onWindows)("INV-9 refuses a state directory or room file readable by others, and says how to fix it", () => {
    const home = homeWithRoom();
    chmodSync(home, 0o755);
    chmodSync(roomFile(home, ROOM, "secret"), 0o644);
    chmodSync(roomFile(home, ROOM, "state.json"), 0o640);
    const problems = checkStatePermissions(home);
    expect(problems.map((p) => p.path)).toEqual([home, roomFile(home, ROOM, "secret"), roomFile(home, ROOM, "state.json")]);
    expect(() => assertStatePrivate(home)).toThrow(StatePermissionError);
    expect(() => assertStatePrivate(home)).toThrow(`chmod -R go-rwx '${home}'`);
  });

  // Creating a symlink on Windows needs Developer Mode or an elevated process.
  it.skipIf(onWindows)("INV-9 refuses a symlinked room file", () => {
    const home = homeWithRoom();
    const elsewhere = join(tempDir(), "secret");
    writeFileSync(elsewhere, secret(), { mode: 0o600 });
    unlinkSync(roomFile(home, ROOM, "secret"));
    symlinkSync(elsewhere, roomFile(home, ROOM, "secret"));
    expect(checkStatePermissions(home)).toEqual([{ path: roomFile(home, ROOM, "secret"), problem: "symlink" }]);
  });

  it("INV-9 is skipped on Windows, which has no mode bits (ADR-021)", () => {
    const home = homeWithRoom();
    chmodSync(home, 0o777);
    expect(checkStatePermissions(home, "win32")).toEqual([]);
  });
});
