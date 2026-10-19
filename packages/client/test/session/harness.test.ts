// The MCP server in harnesses without a session id (04 §10, ADR-033): Cursor and Gemini CLI.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPidPath, readBinding } from "../../src/binding.js";
import { CURSOR_APPROVAL_WARNING } from "../../src/session.js";
import { startRelay } from "../connection/harness.js";
import { side } from "./pairing.js";

const env = (port: number, harness: string) => ({ PAIRWIRE_RELAY: `127.0.0.1:${port}`, PAIRWIRE_NAME: "Tazo", PAIRWIRE_HARNESS: harness });

describe("harnesses without a session id (ADR-033)", () => {
  it("the owning server records its parent beside the binding, and not in it", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo", { env: env(port, "gemini-cli"), ppid: 31337 });
    expect((await a.session.start({})).isError).toBeUndefined();
    expect(readBinding(a.home, a.project)).toMatchObject({ owner_session: null, owner_harness: "gemini-cli" });
    expect(JSON.parse(readFileSync(harnessPidPath(a.home, a.project), "utf8"))).toEqual({ owner_pid: process.pid, harness_pid: 31337 });
    // Claude Code gives the server its session: no sidecar.
    const c = side(port, "Nika");
    await c.session.start({});
    expect(existsSync(harnessPidPath(c.home, c.project))).toBe(false);
  });

  it("REQ-SAFE-5 in Cursor, whose hooks can't warn the human, status says that sends may skip approval", async () => {
    const { port } = await startRelay();
    const cursor = side(port, "Tazo", { env: env(port, "cursor") });
    await cursor.session.start({});
    expect((await cursor.session.status()).text).toContain(CURSOR_APPROVAL_WARNING);
    const claude = side(port, "Nika");
    await claude.session.start({});
    expect((await claude.session.status()).text).not.toContain("Approval:");
    const gemini = side(port, "Ana", { env: env(port, "gemini-cli") });
    await gemini.session.start({});
    expect((await gemini.session.status()).text).not.toContain("Approval:");
  });
});
