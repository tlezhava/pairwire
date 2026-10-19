import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  StatePermissionError,
  checkStatePermissions
} from "./chunk-4D5YGOHL.mjs";
import {
  CtlProofError,
  CtlUnreachableError,
  ctlCall,
  ctlTarget
} from "./chunk-FJWEKDSO.mjs";
import {
  CtlKeyError,
  readCtlKey
} from "./chunk-5CJHYWD5.mjs";
import {
  bindingsForRoom,
  expiresAt,
  isOpen,
  isProcessAlive,
  listRooms,
  loadConfig,
  readState,
  refreshActiveFlag
} from "./chunk-5SBZMDCF.mjs";
import {
  activeFlagPath,
  roomDir,
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  envValue,
  findDistDir,
  findGitBash,
  isInsideDir
} from "./chunk-HDMYU3UC.mjs";
import {
  DEFAULT_RELAY_HOST,
  displayName,
  parseRelayAddress,
  relayUrl
} from "./chunk-O5I4E6QX.mjs";
import "./chunk-KARZWXGF.mjs";

// packages/client/src/doctor.ts
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var MIN_NODE_MAJOR = 20;
function nodeAdvice(version) {
  const major = version ? Number.parseInt(version.replace(/^v/, ""), 10) : NaN;
  if (major >= MIN_NODE_MAJOR) return null;
  const have = version ? `Node ${version} is installed` : "Node.js was not found";
  return `${have}, but pairwire needs Node ${MIN_NODE_MAJOR} or newer. Install the current LTS from https://nodejs.org (or with your version manager, e.g. \`nvm install --lts\`), then restart your agent session.`;
}
async function runDoctor(o) {
  let failed = false;
  const line = (level, text) => {
    if (level === "FAIL") failed = true;
    o.out.write(`${level.padEnd(4)}  ${text}
`);
  };
  const version = o.nodeVersion ?? process.versions.node;
  const advice = nodeAdvice(version);
  if (advice) line("FAIL", advice);
  else line("ok", `Node ${version}`);
  let relays = /* @__PURE__ */ new Set();
  try {
    const { config, warnings } = loadConfig(o.home, o.env);
    line("ok", `config: relay ${config.relay ?? `${DEFAULT_RELAY_HOST ?? "(none)"} (default)`}, hop budget ${config.hopBudget}, delivery ${config.delivery}`);
    for (const w of warnings) line("warn", w);
    relays.add(config.relay ?? DEFAULT_RELAY_HOST ?? "");
  } catch (e) {
    line("FAIL", `config: ${e.message}`);
  }
  const platform = o.platform ?? process.platform;
  if (platform === "win32") {
    line("ok", `state directory ${o.home}: permissions are not checked on Windows`);
    const profile = envValue(o.env, "USERPROFILE") ?? homedir();
    if (!isInsideDir(o.home, profile)) {
      line("warn", `state directory ${o.home} is outside your profile ${profile}, so other users of this computer may be able to read it; keep it under your profile`);
    }
  } else {
    const problems = checkStatePermissions(o.home, platform);
    if (problems.length > 0) line("FAIL", new StatePermissionError(o.home, problems).message);
    else line("ok", `state directory ${o.home} is private`);
  }
  const now = (o.now ?? Date.now)();
  const rooms = listRooms(o.home);
  for (const id of rooms) {
    try {
      const s = readState(o.home, id);
      if (!s) continue;
      const peer = s.peer ? `${displayName(s.peer.name)} (${displayName(s.peer.harness)})` : "no peer yet";
      const until = isOpen(s) ? `, expires ${new Date(expiresAt(s)).toISOString()}` : "";
      line(s.error && isOpen(s) ? "warn" : "ok", `room ${id.slice(0, 6)}\u2026: ${s.status}${s.error ? ` (${s.error})` : ""}, ${peer}${until}`);
      if (isOpen(s)) relays.add(s.relay ?? DEFAULT_RELAY_HOST ?? "");
      if (isOpen(s) && now >= expiresAt(s)) line("warn", `room ${id.slice(0, 6)}\u2026 is past its expiry; it is removed the next time a session opens it.`);
      if (isOpen(s)) {
        const proof = await checkCtlProof(o.home, id, s.ctl_path);
        if (proof) line(proof.level, `room ${id.slice(0, 6)}\u2026: ${proof.text}`);
      }
    } catch (e) {
      line("FAIL", `room ${id.slice(0, 6)}\u2026: ${e.message}`);
    }
  }
  if (rooms.length === 0) line("ok", "no rooms stored");
  const hadFlag = existsSync(activeFlagPath(o.home));
  if (rooms.length > 0 || hadFlag) {
    const shouldHave = refreshActiveFlag(o.home);
    if (hadFlag !== shouldHave) line("warn", `the "active" flag was ${hadFlag ? "set" : "missing"}; repaired`);
  }
  relays = new Set([...relays].filter(Boolean));
  if (relays.size === 0) line("warn", "no relay configured: set PAIRWIRE_RELAY or relay in config.json");
  for (const host of relays) {
    const result = await checkRelay(host, o.fetch ?? fetch);
    line(result ? "FAIL" : "ok", `relay ${host}${result ? `: ${result}` : " answers /health"}`);
  }
  const bundle = o.bundleDir === void 0 ? defaultBundleDir() : o.bundleDir;
  if (bundle) {
    const root = dirname(bundle);
    const missing = ["hooks/run.sh", "hooks/hooks.json"].filter((p) => !existsSync(join(root, p)));
    if (missing.length > 0) line("FAIL", `plugin at ${root} is missing ${missing.join(", ")}; reinstall the plugin`);
    else line("ok", `plugin hooks wired at ${root}`);
  }
  if (platform === "win32") {
    const bash = findGitBash(o.env);
    if (bash) line("ok", `Git Bash ${bash} (runs pairwire's hooks)`);
    else
      line(
        "warn",
        "Git for Windows was not found. Claude Code runs plugin hooks with Git Bash; without it pairwire's hooks fail and messages arrive only when your agent checks its inbox. Install Git for Windows from https://git-scm.com/downloads/win, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe."
      );
  }
  return failed ? 1 : 0;
}
var PROOF_REASONS = {
  timeout: "it sent no proof in time",
  closed: "it closed the connection",
  malformed: "it answered with something that isn't a proof",
  wrong_mac: "its proof is wrong",
  refused: "it doesn't know the proof",
  key_unreadable: "the room's ctl.key can't be read"
};
async function checkCtlProof(home, roomId, ctlPath) {
  const keyPath = roomFile(home, roomId, "ctl.key");
  if (!existsSync(keyPath)) return null;
  if (!bindingsForRoom(home, roomId).some((b) => isProcessAlive(b.owner_pid))) return null;
  try {
    readCtlKey(home, roomId);
  } catch (e) {
    const problem = e instanceof CtlKeyError ? e.problem : "unreadable";
    const what = problem === "corrupt" ? "is corrupt" : problem === "not_private" ? "is not private (it must be a file of yours with mode 0600)" : "can't be read";
    return { level: "FAIL", text: `its ctl.key ${what}. Stop your agent session, delete ${keyPath}, and start the session again; it creates a new one` };
  }
  try {
    await ctlCall(ctlTarget(home, roomId, ctlPath), null, { log: false });
    return { level: "ok", text: "the session on its control channel proves it is yours" };
  } catch (e) {
    if (e instanceof CtlUnreachableError) return { level: "FAIL", text: "its owning session is running, but nothing answers on its control channel; restart your agent session" };
    const reason = e instanceof CtlProofError ? e.reason : "malformed";
    let text = `the program on its control channel could not prove it is your pairwire session: ${PROOF_REASONS[reason]}`;
    if (reason === "refused") {
      text += `. It answers like pairwire 0.1.x, which has no proof, but any program can answer this way. If you went back to 0.1.x, delete ${keyPath} so its commands work again, but only if you are sure your agent session runs pairwire 0.1.x: deleting it turns the proof off. Otherwise restart your agent session, and if this stays, another program may be listening in its place`;
    } else text += "; restart your agent session, and if this stays, another program may be listening in its place";
    return { level: "FAIL", text };
  }
}
async function checkRelay(host, fetcher) {
  let url;
  try {
    url = relayUrl(parseRelayAddress(host)).replace(/^ws/, "http") + "/health";
  } catch (e) {
    return e.message;
  }
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(5e3) });
    const body = await res.text();
    return res.ok && body.trim() === "ok" ? null : `unexpected answer (HTTP ${res.status})`;
  } catch (e) {
    return `unreachable (${e.name === "TimeoutError" ? "timed out" : e.message})`;
  }
}
function defaultBundleDir() {
  return findDistDir(dirname(fileURLToPath(import.meta.url)), (root) => existsSync(join(root, ".claude-plugin")));
}
function runPurge(o) {
  const say = (t) => o.out.write(`${t}
`);
  const rooms = listRooms(o.home).map((id) => {
    try {
      return { id, state: readState(o.home, id) };
    } catch {
      return { id, state: null };
    }
  });
  if (o.all) {
    const open = rooms.filter((r) => r.state && isOpen(r.state));
    if (open.length > 0 && !o.force) {
      say(`pairwire purge --all: ${open.length} room(s) still open; leave them first (/pairwire:leave) or add --force to abandon them.`);
      return 1;
    }
    rmSync(o.home, { recursive: true, force: true });
    say(`deleted ${o.home}`);
    return 0;
  }
  let n = 0;
  for (const r of rooms) {
    if (r.state && !isOpen(r.state)) {
      rmSync(roomDir(o.home, r.id), { recursive: true, force: true });
      say(`deleted room ${r.id.slice(0, 6)}\u2026 (${r.state.status})`);
      n++;
    }
  }
  if (n === 0) say("nothing to purge: no left or ended rooms");
  return 0;
}
export {
  MIN_NODE_MAJOR,
  nodeAdvice,
  runDoctor,
  runPurge
};
