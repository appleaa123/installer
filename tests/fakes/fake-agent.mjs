#!/usr/bin/env node
// Test double for a headless agent CLI (shaped like `claude -p … --output-format json`).
// FAKE_AGENT_DROP switches off one capability: c4 | json | schema | c5 | hang.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const drop = process.env.FAKE_AGENT_DROP ?? "";
const store = process.env.FAKE_AGENT_HOME ?? join(process.cwd(), ".fake-agent");
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function answer(prompt, resumed, session) {
  const exact = /Reply with exactly this word: (\S+)/.exec(prompt);
  if (exact) return exact[1];
  if (!resumed) return "OK";
  try {
    return readFileSync(join(store, `${session}.txt`), "utf8");
  } catch {
    return "I do not know";
  }
}

if (args[0] === "--version") {
  process.stdout.write("9.9.9 (Fake Agent)\n");
} else if (drop === "c4") {
  process.exit(1);
} else if (drop === "hang") {
  setInterval(() => undefined, 1000);
} else {
  const prompt = valueOf("-p") ?? "";
  const resumed = valueOf("-r");
  const session = resumed && drop !== "c5" ? resumed : randomUUID();
  mkdirSync(store, { recursive: true });
  const remember = /Remember this word: (\S+?)\./.exec(prompt);
  if (remember) writeFileSync(join(store, `${session}.txt`), remember[1]);
  const result = answer(prompt, resumed, session);
  const field = /in the field word: (\S+)/.exec(prompt);
  const structured = valueOf("--json-schema") && drop !== "schema" ? { structured_output: { word: field ? field[1] : result } } : {};
  const out = { result, session_id: session, is_error: false, ...structured };
  process.stdout.write(drop === "json" ? "this is not json" : JSON.stringify(out));
}
