// Minimal MCP stdio server (newline-delimited JSON-RPC), no dependencies.
// Tools: `probe` (process facts for S2) and `send` (approval UX for S6).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { OUT, append, proc } from "./lib.mjs";

const startup = proc();
writeFileSync(join(OUT, `mcp-${process.pid}.json`), JSON.stringify({ t: new Date().toISOString(), ...startup }, null, 2));

const tools = [
  {
    name: "probe",
    description: "pairwire spike: report this MCP server's pid, ppid, cwd, ancestors and environment.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send",
    description: "pairwire spike: pretend to send a message to the paired agent (nothing leaves this machine).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["chat", "question", "answer"] },
        body: { type: "string" },
        reply_to: { type: "string" },
      },
      required: ["kind", "body"],
    },
  },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
const text = (s) => ({ content: [{ type: "text", text: s }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  append("mcp-rpc.jsonl", { pid: process.pid, method: msg.method, tool: msg.params?.name });
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pairwire-spike", version: "0.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools });
    case "tools/call": {
      const args = params?.arguments ?? {};
      if (params?.name === "probe") {
        const now = proc();
        append("mcp-probe.jsonl", now);
        return reply(id, text(JSON.stringify({ ...now, env: now.env.values }, null, 2)));
      }
      if (params?.name === "send") {
        const body = String(args.body ?? "");
        append("mcp-send.jsonl", { kind: args.kind, length: body.length, head: body.slice(0, 40), tail: body.slice(-40) });
        return reply(id, text(`spike send received: kind=${args.kind}, ${body.length} characters, ends with "${body.slice(-20)}"`));
      }
      return fail(id, -32602, "unknown tool");
    }
    default:
      return fail(id, -32601, "method not found");
  }
});
