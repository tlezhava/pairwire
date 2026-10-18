// Minimal MCP stdio server for S11: records how the harness starts it and what each call carries.
// argv[2] names the harness ("gemini" or "cursor"). Tools: probe (read-only), send (open-world).
import { createInterface } from "node:readline";
import { append, proc } from "./lib.mjs";

const harness = process.argv[2] ?? "unknown";
append("mcp-start.jsonl", { harness, argv: process.argv.slice(2), ...proc() });

const tools = [
  {
    name: "probe",
    description: "pairwire spike S11: report this MCP server's process facts.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "send",
    description: "pairwire spike S11: pretend to send a message to the paired agent (nothing leaves this machine).",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
const text = (s) => ({ content: [{ type: "text", text: s }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  // Record the envelope of every request (method, _meta, client info), never argument values.
  append("mcp-rpc.jsonl", {
    harness,
    pid: process.pid,
    method,
    tool: params?.name,
    meta: params?._meta,
    clientInfo: method === "initialize" ? params?.clientInfo : undefined,
    capabilities: method === "initialize" ? params?.capabilities : undefined,
    argKeys: params?.arguments ? Object.keys(params.arguments) : undefined,
  });
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "s11", version: "0.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools });
    case "tools/call":
      if (params?.name === "probe") {
        const now = proc();
        append("mcp-probe.jsonl", { harness, ...now });
        return reply(id, text(JSON.stringify({ pid: now.pid, ppid: now.ppid, cwd: now.cwd, env: now.env.values }, null, 2)));
      }
      if (params?.name === "send") {
        const body = String(params?.arguments?.body ?? "");
        return reply(id, text(`S11 send received ${body.length} characters (nothing was sent).`));
      }
      return fail(id, -32602, "unknown tool");
    default:
      return fail(id, -32601, "method not found");
  }
});
