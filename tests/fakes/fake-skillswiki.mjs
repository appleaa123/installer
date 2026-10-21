// Plays python, pipx and skillswiki for the local Skills Wiki tests (D178); its answers have the shapes recorded from
// the real skillswiki 0.3.2 (`--json setup`, `doctor`, `uninstall`). The role comes from the wrapper that started it.
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const role = env.FAKE_ROLE ?? "";
const args = process.argv.slice(2);
if (env.FAKE_SW_LOG) appendFileSync(env.FAKE_SW_LOG, `${JSON.stringify({ role, args, cwd: process.cwd() })}\n`);

/** A command file that starts this fake in a role, with node's absolute path, so PATH needs no node. */
export const wrapper = (fakeRole) => `#!${env.FAKE_NODE}\nprocess.env.FAKE_ROLE = ${JSON.stringify(fakeRole)};\nimport(${JSON.stringify(env.FAKE_MODULE)});\n`;

function pipx() {
  if (env.FAKE_PIPX_FAIL) {
    process.stderr.write("pip failed to build package:\n    cryptography\nFatal error from pip prevented installation.\n");
    process.exit(1);
  }
  if (args[0] === "install" && env.FAKE_SW_BIN) {
    const path = join(env.FAKE_SW_BIN, "skillswiki");
    writeFileSync(path, wrapper("skillswiki"));
    chmodSync(path, 0o755);
  }
}

function setup() {
  if (env.FAKE_SW_SETUP === "stopped") return { mode: "automatic", stopped: true, plan: null, moved: null, agents: [], backup: null };
  const adopted = [{ slug: "check-word", from: join(process.cwd(), ".claude/skills/check-word"), to: join(env.FAKE_SW_LIBRARY ?? "", "check-word") }];
  const failed = env.FAKE_SW_SETUP === "failed" ? [{ slug: "big-skill", error: "TARGET_EXISTS" }] : [];
  return { mode: "automatic", stopped: false, plan: { adopted, failed }, moved: { adopted, failed }, agents: [{ agent: "claude_code", name: "Claude Code", method: "hook", self_setup: false, test: "vouched" }], backup: join(process.cwd(), ".skillswiki/backups/setup-20261020-114754.zip") };
}

function skillswiki() {
  const command = args.filter((arg) => arg !== "--json")[0];
  if (command === "doctor") {
    if (env.FAKE_SW_DOCTOR === "broken") {
      process.stderr.write('{"ok": false, "code": "DB", "message": "database is locked"}\n');
      process.exit(1);
    }
    return { version: env.FAKE_SW_VERSION ?? "0.3.3", library: { path: env.FAKE_SW_LIBRARY, adopted: ["check-word"], missing: [] }, wiring: [{ agent: "claude_code", method: "hook", mcp: env.FAKE_SW_MCP ?? "done" }] };
  }
  if (command === "setup") return setup();
  if (command === "uninstall") {
    if (env.FAKE_SW_UNINSTALL === "blocked") {
      console.log(JSON.stringify({ stopped: false, blocked: true, released: { released: [], blocked: [{ slug: "check-word" }] } }));
      process.exit(1);
    }
    // FAKE_SW_UNINSTALL=self_setup: the agent's CLI was not on the PATH, so Skills Wiki says what to run by hand.
    const disconnected = env.FAKE_SW_UNINSTALL === "self_setup" ? [{ agent: "claude_code", method: { state: "restored", prompt: null }, mcp: { state: "self_setup", prompt: "Run: claude mcp remove skillswiki --scope user" } }] : [{ agent: "claude_code", method: { state: "restored", prompt: null }, mcp: { state: "removed" } }];
    return { stopped: false, blocked: false, exported: [], released: { released: [{ slug: "check-word" }] }, disconnected, backups_deleted: [] };
  }
  process.stderr.write(`{"ok": false, "code": "USAGE", "message": "unknown command ${command}"}\n`);
  process.exit(2);
}

if (role.startsWith("python:")) console.log(role.slice("python:".length));
else if (role === "pipx") pipx();
else if (role === "skillswiki") console.log(JSON.stringify(skillswiki()));
