#!/usr/bin/env node
// Test double for a Codex-shaped CLI (`codex exec --json …`, `codex exec resume <id> …`, `--output-schema <file>`),
// written from Codex's documentation: JSON Lines events on stdout, the thread id in `thread.started`, the answer
// in the last `item.completed` whose item is an `agent_message`. A reasoning item comes first, so a reader that
// takes any `item.text` gets the wrong one. FAKE_AGENT_HOME: where threads live and each call's arguments are
// appended to calls.jsonl (default ./.fake-codex).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const store = process.env.FAKE_AGENT_HOME ?? join(process.cwd(), ".fake-codex");
const VALUED = ["--output-schema", "--sandbox", "-s", "-m", "--model", "-c"];

/** Positionals after `exec` (and `resume`), with every flag and its value taken out. */
function positionals(list) {
  return list.filter((part, index) => !part.startsWith("-") && !VALUED.includes(list[index - 1]));
}

const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function answer(prompt, thread) {
  const exact = /Reply with exactly this word: (\S+)/.exec(prompt);
  if (exact) return exact[1];
  const remember = /Remember this word: (\S+?)\./.exec(prompt);
  if (remember) writeFileSync(join(store, `${thread}.txt`), remember[1]);
  if (/What word did I ask you to remember/.test(prompt) && existsSync(join(store, `${thread}.txt`))) return readFileSync(join(store, `${thread}.txt`), "utf8");
  return "OK";
}

function main() {
  if (args[0] === "--version") return process.stdout.write("codex-cli 9.9.9\n");
  if (args[0] !== "exec") process.exit(2);
  const resumed = args[1] === "resume";
  const [first, second] = positionals(args.slice(resumed ? 2 : 1));
  const thread = resumed ? first : randomUUID();
  const prompt = (resumed ? second : first) ?? "";
  mkdirSync(store, { recursive: true });
  appendFileSync(join(store, "calls.jsonl"), `${JSON.stringify(args)}\n`);
  const schemaFile = valueOf("--output-schema");
  const field = /in the field word: (\S+)/.exec(prompt);
  const text = schemaFile && JSON.parse(readFileSync(schemaFile, "utf8")).type === "object" ? JSON.stringify({ word: field ? field[1] : "" }) : answer(prompt, thread);
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Thinking it over**" } });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
}

main();
