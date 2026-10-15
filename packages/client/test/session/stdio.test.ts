// `pairwire mcp` as a real process over stdio, the way a harness launches it.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { tempDir } from "../state/helpers.js";

const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
// Absolute, because the child runs in a temp directory where "tsx" would not resolve.
const TSX = import.meta.resolve("tsx");

describe("pairwire mcp (stdio)", () => {
  it("starts, lists its tools, answers status, and logs only to stderr", async () => {
    const home = `${tempDir()}/.pairwire`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--conditions=source", "--import", TSX, MAIN, "mcp"],
      env: { PATH: process.env.PATH ?? "", HOME: tempDir(), PAIRWIRE_HOME: home, PAIRWIRE_HARNESS: "claude-code" },
      cwd: tempDir(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d) => (stderr += d));
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    const res = await client.callTool({ name: "status", arguments: {} });
    expect((res.content as { text: string }[])[0]!.text).toContain("No pairwire room in this project.");
    await client.close();
    expect(stderr).toContain('"event":"mcp_started"');
  }, 30_000);
});
