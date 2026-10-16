# The doability check, item 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core of the doability check and the owner's own example end to end: "check my email every morning and send me a brief", hosted by TaskFollow's runner on Claude Code (Home 1) or by Claude Cowork's own scheduler (Home 2), with every answer saying how it is known.

**Architecture:** A `checks` module keeps challenges on disk (`state/checks/<id>.json`, the word's hash only), records results in `state/abilities.json` and the hash-chained audit, and decides a workflow's home with a pure function over code constants and fresh results. A `check-page` module serves a person-only page: the word shown once on request, and a separate confirmation page. The agent reaches checks only through `taskfollow check mark|answer` and the L0 tool `check.ping`. A delivery module writes a workflow as a Cowork skill zip (D158) plus schedule text, scrubbed.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies (zip writing uses the `zip` command on macOS/Linux and PowerShell `Compress-Archive` on Windows, like other OS commands the engine prints; tests use an injected writer).

**Spec:** `docs/superpowers/specs/2026-10-16-doability-check.md` version 3.1 (sections 2–11), D156, D158. **Measured against:** v1, `docs/scope-refresh.md` 9.15 and section 6.

## Global Constraints

- The agent never holds what proves it: no word, page address or expected value in any output of a command an agent runs; challenge files hold hashes; `abilities.json` never holds answer text (spec 5.1).
- Code decides the home; the shipped shapes' needs and hard-rule flags are constants in code; a described workflow is hard-rule work unless the person confirms on their page (spec 7).
- Hard-rule work never leaves TaskFollow's runner except as draft-only (spec 7).
- A test never sends to anyone but the person, writes into a real record, deletes anything of theirs, or asks for a standing permission (spec 5.3).
- Plain words on every page and message; INSTALL.md stays free of industry words and names Skills Wiki only from section 11.
- Tests never touch the real `~/.claude`; the page opener is `none` in tests; full `npm test` twice and `npm run typecheck` before each PR.
- Two PRs: **4a** (Tasks 1–6) and **4b** (Tasks 7–11), each with a Fable code review before merge.

## Review Focus

1. **The agent runs `taskfollow check start` with a hostile environment** (`INSTALLER_BROWSER=/tmp/log.sh`, a fake `open` first in PATH, `SSH_CONNECTION` set): the page address must never reach its stdout, stderr, a hint, or a file it can read.
2. **The person reloads the word page, or the computer restarts during a 24-hour T8**: reload cancels the word and says why; the confirmation page reopens from disk after a restart.
3. **A workflow file the agent wrote claims fewer needs or no hard rule**: the home must come from the code constant or the person's confirmation, never from the file.
4. **Clock and timing**: a T8 confirmation submitted before the scheduled time; a challenge expired; a stale result (agent version changed) at decision time.
5. **The delivered Cowork skill**: must contain no keychain value, member code, token pattern, local path or `taskfollow` command, and must be the zip shape Cowork accepts.

---

## PR 4a: the core

### Task 1: Words, challenges and results (`src/core/checks.ts`)

**Files:** create `src/core/checks.ts`, `src/core/words.ts`; modify `src/core/members.ts` (import the alphabet from `words.ts`); tests `tests/unit/checks.test.ts`, `tests/unit/words.test.ts`.

**Interfaces:**

```ts
// words.ts
export const WORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // D77
export function newWord(prefix?: string): string;            // e.g. "HERON-7K3P": a fixed list of 32 short words + 4 alphabet chars
export function sameWord(typed: string, expected: string): boolean; // ignores case, spaces, dashes
export const wordHash: (word: string) => string;             // sha256 hex

// checks.ts
export type Need = "answers" | `reads:${string}` | `writes:${string}` | "skills" | "tools" | "runner" | "scheduler" | "asks-first" | "hooks";
export type ResultKind = "yes-tested" | "yes-you-told-us" | "not-checked" | "no-tested";
export interface CheckResult { need: Need; workflow?: string; result: ResultKind; reason: string; at: string; agent: string; agent_version: string | null; test: string; detail?: string }
export interface Challenge { id: string; need: Need; test: string; workflow?: string; agent: string; word_hash?: string; created_at: string; expires_at: string; opens_at?: string; shown_at?: string; done?: boolean }
export const CHECKS_DIR = join("state", "checks");
export const ABILITIES_FILE = join("state", "abilities.json");
export async function startChallenge(home: string, spec: { need: Need; test: string; workflow?: string; agent: string; ttlMs: number; opensAt?: string; word?: string }, now: string): Promise<{ challenge: Challenge; word?: string }>; // word returned only to in-process callers that put it on the page or plant it
export async function loadChallenge(home: string, id: string): Promise<Challenge | null>;
export async function recordResult(home: string, result: CheckResult): Promise<void>; // abilities.json + appendAudit("check.result", hashes only)
export async function abilities(home: string): Promise<readonly CheckResult[]>;
export async function freshResult(home: string, need: Need, agent: string, agentVersion: string | null, now: string, workflow?: string): Promise<CheckResult | null>; // spec 8: version change, 30 days
export async function markChallenge(home: string, id: string, word: string, origin: { interactive: boolean; parents: readonly string[] }, now: string): Promise<CheckResult>; // single use; unknown/expired/used → InputError + audit "check.refused"
export async function answerChallenge(home: string, id: string, text: string, now: string): Promise<CheckResult>; // compares hash; never stores text
```

- [ ] Failing tests: `newWord` uses only the alphabet and the word list; `sameWord("heron 7k3p","HERON-7K3P")`; a challenge file holds the hash, never the word; `markChallenge` single use, refuses unknown and expired ids and audits the refusal; a mark from an interactive terminal records `run by you` in `reason`, not yes-tested; `answerChallenge` with the right word → yes-tested, wrong → not-checked after two tries, and `abilities.json` never contains the typed text; `freshResult` returns null after a version change or 30 days; `members.ts` still makes invite codes with the shared alphabet (existing tests pass).
- [ ] Implement; tests pass; commit `feat(checks): words, challenges and results on disk`.

### Task 2: The person-only page (`src/core/check-page.ts`)

**Files:** create `src/core/check-page.ts`; modify `src/cli.ts` (hidden `check-serve <id>` entry, like `secret-serve`); tests `tests/unit/check-page.test.ts`.

**Interfaces:**

```ts
export function systemOpener(platform: string, env: Env): { cmd: string; args: (url: string) => string[] } | null; // /usr/bin/open, /usr/bin/xdg-open, %SYSTEMROOT%\System32\rundll32.exe; env only for the literal "none"
export function serveCheckPage(home: string, id: string, options: { word?: string; now: () => string; ttlMs: number }): Promise<{ url: string; close: () => void }>;
export function launchCheckPage(id: string): Promise<{ pid: number }>; // detached child; reports only its pid over IPC; opens the browser itself
```

- Word page: GET shows a button *"Show me the word"* and the instructions; POST (same origin) shows the word once and writes `shown_at`; a second POST, or a GET after `shown_at`, shows *"This word was already shown (a reload or another window can cause this). The test is cancelled; start it again."* and cancels the challenge with an audit entry.
- Confirmation page (separate path): a form for the word(s) received, plus fixed answers where the test needs them (T8: *around / before / well after the scheduled time*; T6 later: *I pressed Yes by mistake*); closed until `opens_at`; served from the challenge file, so `check page <id>` can reopen it during the challenge's life.
- Headers as the secret page (no-store, CSP); 127.0.0.1 only; random path.
- [ ] Failing tests (HTTP client against the server, injected clock): word shown only after POST, once; reload cancels and audits; confirmation closed before `opens_at`; reopened after a "restart" (new server from the same challenge file); `systemOpener` ignores `INSTALLER_BROWSER` except `none` and returns absolute paths; `launchCheckPage` output contains no URL.
- [ ] Implement; pass; commit `feat(checks): the person-only check page`.

### Task 3: `taskfollow check` commands and `check.ping`

**Files:** modify `src/cli.ts` (COMMANDS, ON_INSTALL: `check`), create `src/core/check-commands.ts`, add `check.ping` to the tool set (`src/core/tool-set.ts`, new `src/core/check-tools.ts`); tests `tests/unit/check-commands.test.ts`, `tests/e2e/check-cli.test.ts`.

**Interfaces:** `taskfollow check start <test> [--workflow <id>]` → `{ id, instruction, page: "opened in your browser" | "run 'taskfollow check page <id>' in your own terminal" }`; `check page <id>` (refused unless interactive, D61) prints the URL; `check mark <id> <word>`; `check answer <id> <text>`; `check list` (results, plain words). `check.ping {id, word}`: L0, `meta: true`, never outbound; its own `run` calls `markChallenge` and writes its audit line (the gate audits only above L0).

- [ ] Failing tests: Review Focus 1 (hostile env and PATH: no URL in stdout/stderr/JSON); `check page` refused from a non-interactive caller; `check.ping` listed by the MCP server, L0, records a result; e2e: `check start t1` prints only id and instruction.
- [ ] Implement; pass; commit `feat(checks): the check commands and check.ping`.

### Task 4: T1, T5 and T7 (preflight and per workflow)

**Files:** modify `src/core/check-commands.ts`, `src/core/agent-task.ts` only if needed (T7 uses the existing task runner), tests in `tests/unit/check-tests.test.ts` with the fake agent.

- T1: instruction *"Run: taskfollow check mark <id> <word>"* (word in the instruction by design); pass = mark from a non-interactive parent.
- T5: instruction *"Call the tool check.ping with id <id> and word <word>"*; the result records the path (mcp or command).
- T7 preflight: TaskFollow runs one task step itself through the runner (`may_use: ["mcp__installer__check_ping"]`), the prompt holding id and word; pass = the ping arrives under the hook → yes-tested for `runner` and `tools`. Agents without a task command: `not-checked`, reason *"TaskFollow cannot run this agent unattended here, so its own runner is not a home"*.
- T7 per workflow: same, with the workflow's skills inlined (D154) and its source tool added to `may_use` when it reads one; the prompt asks for the skill's word and the newest `TASKFOLLOW-CHECK <id>` subject in the ping → yes-tested for `skills` and `reads:<source>` in Home 1.
- [ ] Failing tests with the fake agent (FAKE_AGENT_TASK scripts a `check.ping` call): preflight yes; fake agent that does not call → not-checked; per-workflow with a skill word; a profile without `task` → the plain reason. Implement; pass; commit `feat(checks): T1, T5 and the runner test T7`.

### Task 5: Needs, hard rules and the home

**Files:** create `src/core/homes.ts`; modify `src/core/workflow.ts` only to expose a workflow's shape id (`shape` field, optional, set by `workflow add` from a suggestion id, never trusted for needs); tests `tests/unit/homes.test.ts`.

**Interfaces:**

```ts
export const SHAPES: Readonly<Record<string, { needs: readonly Need[]; hardRule: boolean | "ask" }>>; // inbox-triage (report-only), inbox-triage-replies, lead-qualification, crm-update, invoice-processing, meeting-follow-up ("ask")
export async function confirmDescribed(home: string, workflow: string, descriptionHash: string, answers: { sendsToOthers: boolean; writesOrDeletes: boolean }, now: string): Promise<void>; // only from the confirmation page
export type Home = { home: "runner" } | { home: "agent-scheduler"; agent: string } | { home: "draft-only" } | { home: "by-hand" };
export async function decideHome(home: string, workflow: Workflow, wish: { whileAway: boolean }, now: string): Promise<{ home: Home; why: string; missing: readonly Need[] }>;
```

- Hard rule = `SHAPES[shape].hardRule` for a shipped shape; for anything else, true unless a confirmation exists whose `descriptionHash` equals sha256 of the current description and both answers are no.
- Table of spec section 7, with fresh results only.
- [ ] Failing tests: Review Focus 3 (a workflow file without needs and with a fake `shape` still gets the constant for a real shape and hard-rule for an unknown one); a described workflow confirmed, then its description edited → hard-rule again; hard-rule + runner fresh → runner; hard-rule + no runner → draft-only, never agent-scheduler even with every other result yes; report-only + scheduler yes + whileAway → agent-scheduler; stale results ignored (Review Focus 4). Implement; pass; commit `feat(checks): needs, hard rules and the home, decided by code`.

### Task 6: The report and PR 4a

**Files:** `src/core/report.ts` (runtime limits read `abilities.json` failures and stale results), `INSTALL.md` (a short "Checking what your agent can do" section: `check start`, never ask the person for a word, never open the page yourself), `DECISIONS.md` D159, `docs/next-steps.md` build map.

- [ ] Tests for the report line; the docs tests (`install-doc`, `neutrality`, `install-examples`); typecheck, full suite twice; Fable code review of the branch; fix; PR in plain words; merge under the owner's session authorization.

---

## PR 4b: Home 2 and the owner's example

### Task 7: The work done once (level 0)

**Files:** `src/core/check-commands.ts` (`check once <workflow>`), INSTALL.md operator rule.

- With tools: runs `taskfollow run <workflow> --sandbox` (the gate holds) and shows the result. Without: the operator rule says *read and draft only; nothing sent, written or deleted*; the person confirms on their page *"I saw it, it looked right / it was wrong"* → a `yes-you-told-us` result for `answers` with test `once`.
- [ ] Tests: a sandbox run's result is shown; the page confirmation records the result. Commit `feat(checks): the work done once before any test`.

### Task 8: T2, reading email

**Files:** `src/core/check-commands.ts`, `src/core/check-plant.ts` (TaskFollow plants the email when its email channel exists, through the email connector's `send` to the configured address itself; otherwise the page shows the subject).

- Subject `TASKFOLLOW-CHECK <id> <word>`; instruction to the agent: *"Find the newest email whose subject starts with TASKFOLLOW-CHECK <id> and run: taskfollow check answer <id> '<the rest of the subject>'"*.
- No email tool or connection: *not checked: blocked (connect your email: <how>)*.
- [ ] Tests with the fake email server (existing `fake-mail` helpers or the email-channel test doubles): TaskFollow plants with a word nobody sees; the agent's correct answer → yes-tested; wrong → not-checked; no channel → page variant. Commit `feat(checks): T2, reading email, with a planted test message`.

### Task 9: Delivering a workflow to Claude Cowork

**Files:** create `src/core/deliver.ts`; tests `tests/unit/deliver.test.ts`.

**Interfaces:** `deliverToCowork(home, workflow, options): Promise<{ zip: string; schedule: string; steps: readonly string[] }>`: writes `<install folder>/taskfollow-deliver/<workflow>.zip` with one folder `<workflow>/SKILL.md` (+ `references/my-rules.md`), no manifest (D158); the schedule text in plain words (*"Set a scheduled task every weekday at 8:00: use the skill <name>; read … ; send me a short brief with SendUserMessage. End the brief with: Sent by your scheduled TaskFollow workflow <name>."*); checked before writing: no keychain value, member code, secret pattern (`agent-hook.ts`), local path or `taskfollow` command (Review Focus 5).
- [ ] Tests: zip structure (one top folder, `SKILL.md` at its top, no `.claude-plugin`); a planted keychain value or local path in the description is refused with a plain message; the footer line is present. Commit `feat(checks): deliver a workflow to Claude Cowork as a skill zip`.

### Task 10: T8, the agent's own scheduler

**Files:** `src/core/check-commands.ts`, `src/core/check-page.ts` (the T8 confirmation form).

- The order of spec 5.2 T8, driven by `check start t8 --workflow <id>`: (1) the test skill is delivered as in Task 9 with a word in it; (2) instruction for the home agent (shown to the person to paste when the home agent is not the operator); (3) the person ticks *"I see the task in its list"*; (4) when they plant the email themselves, the page shows the subject first; (5) they close the window; (6) TaskFollow plants the email if it can; (7) the confirmation page opens at the scheduled time, lives 24 hours, asks for both words and *around / before / well after*.
- Results: around → yes-you-told-us for `scheduler`, `reads:email`, and `skills` with the honest wording; before → not-checked; well after → `scheduler` yes, the *while away* wish not met; nothing → no-tested only when the person says so.
- Clean-up on Cowork is manual (D158): the page lists *"Delete the task 'TaskFollow check' in your scheduled tasks list, and the skill in Settings, Skills"*; it never tells the person to ask the assistant to delete them. Until the person ticks *done*, the page keeps *"a test task may still be in your Cowork list"*.
- [ ] Tests with an injected clock: confirmation closed before `opens_at`; around/before/after mapping; the skill wording; a late `check mark` after the challenge is done is refused and audited. Commit `feat(checks): T8, the agent's own scheduler`.

### Task 11: The person's page, the operator rules, the human task, PR 4b

**Files:** `src/core/check-commands.ts` (`check page-summary <workflow>` / the report's per-workflow block: spec section 6's layout with the glosses), `INSTALL.md` (operator rules: the check flow for a new workflow; the next-session question for Home 2 briefs), `DECISIONS.md` D160, `docs/human-tasks.md` task 33, `docs/next-steps.md`.

- **Human task 33 (the owner):** the email-brief example end to end. On Claude Code: the work done once, T7 per workflow, Home 1 decided, a scheduled run of the brief by TaskFollow's runner. On Claude Cowork: T8 with the delivered skill zip, Home 2 decided, the real brief scheduled from the delivered schedule text, arriving on the phone. The owner judges whether it felt worth it (spec section 11: the test of the whole idea).
- [ ] Docs tests, typecheck, full suite twice, Fable code review, fix, PR in plain words, merge.

---

## Fable review of 2026-10-16, applied (overrides the tasks above where they differ)

Verdict: ready after six blocking fixes; all applied below.

**Blocking**
1. **Slow hash** (Task 1). The word has about 25 bits; sha256 is reversible in under a second by the same-user agent. `wordHash` → `scryptSync(normalize(word), salt, 32, { N: 2**15 })` with a per-challenge random salt stored beside it; `normalize` = what `sameWord` ignores (case, spaces, dashes), applied on both sides. `abilities.json` stores the challenge id, not a hash of the word.
2. **The shape is not read from a file the agent writes** (Tasks 5, 3). `workflow add <suggested id>` records `{ shape, content_hash }` in the workflow's *state* (`saveWorkflowState`), never in `workflow.json`; `decideHome` honours the shape only while sha256 of the current file's canonical JSON equals `content_hash` (a hardened or edited workflow is treated as described until reconfirmed). **Code floor**: any tool step or approve step whose level needs approval (`needsApproval`, `levels.ts`), any task step with `changes: true`, makes it hard-rule work, whatever the shape or the person's answers. Review Focus 3's test is rewritten: a `"shape"` written into `workflow.json` is ignored; a hard-rule workflow with a forged state shape but a different content hash is hard-rule.
3. **The page child gets the home and the word** (Task 2). `launchCheckPage(home, id, word?)` spawns `[cli, "--home", home, "check-serve", id]`; after the child reports its pid over IPC, the parent sends `{ word }` over the same IPC channel (never argv, a file or the environment). `check-serve` has **no stdout fallback**: without IPC it exits with an error. A restart during the word page cancels that challenge; the confirmation page needs no word and reopens from disk.
4. **The fake agent really calls TaskFollow's tools** (Task 4). Extend `task()` in `tests/fakes/fake-agent.mjs`: a tool named `mcp__installer__<x>` parses `--mcp-config`, spawns the stdio server (pattern of `tests/helpers/stdio-mcp.ts`), does initialize + tools/call, and uses the real result. T7 calls `runTask` directly with a `TaskRequest` (`parseMayUse` refuses `mcp__installer*` in workflows); its pass needs both the result recorded with `ctx.via === "mcp"` and a `mcp__installer__check_ping` line with `outcome: ok` in the step's calls record.
5. **Planting email** (Task 8, recorded in D159/D160). The plant calls the email connector's `send` directly (`email-channel.ts`), only ever to the configured address itself, audited `check.planted` without the word; it is not a message to anyone else, so it is not routed through `deliver` (D79 covers messages to people; this is a self-addressed test). TaskFollow's inbound filter drops mail from the mailbox's own address, so TaskFollow's own channel never sees a plant: that is fine, because a TaskFollow-channel source is met by construction for Home 1 only (spec 4).
6. **Home 1 reads through TaskFollow's email channel** (decided). The owner's email brief on Claude Code is an agentic workflow with `channel.inbox` and `channel.notify` (the starter's pattern), needing TaskFollow's email channel and its gateway. Per-workflow T7 proves `runner`, `tools` and `skills`; `reads:email` on Home 1 is met by construction. Human task 33 sets up the email channel with the owner's test Gmail (app password).

**High**
7. **Review Focus 1's test** (Task 3): `systemOpener(platform, env)` is unit-tested as a pure function (ignores the environment except `none`, ignores PATH, absolute paths). The e2e runs `check start` with `INSTALLER_BROWSER=none`, `SSH_CONNECTION` set and a fake `open` first in PATH, and asserts no `127.0.0.1:<port>` or page path in stdout, stderr, JSON or any file under the home, and an empty fake-`open` log. `headlessHint` is not reused.
8. **CLI arguments** (Task 3): `check mark <id> <word>` and `check answer <id> <text>` need a fourth positional; add it to the parser, and add `--workflow` and an agent name for a profile-less home agent (`--value '{"agent":"Claude Cowork"}'`, or asked on the page), stored with `agent_version: null` (only the 30-day rule applies, said on the page).
9. **Report** (Task 6): abilities reach `buildReport` through its extras (the `pushNote` pattern), from the callers that have them; `buildReport` stays synchronous.
10. **No write races** (Task 1): results are numbered records (`state/abilities/<n>.json`, `numbered.ts`), not one shared file; `abilities()` reads them all.
11. **Zip writer** (Task 9): a small stored-entries zip writer with `zlib.crc32` (Node 22), no OS command; the test parses the central directory: one top folder, `SKILL.md` at its top, no `.claude-plugin`.

**Medium**
12. **The T8 checklist is a third page state** (Task 10): *I see the task in its list* → (manual plant) the subject shown → *I closed the window* → the page process plants the email (it is the only process alive then). D160 records that this page kind writes `state/checks` and the audit (D47's page writes only the keychain), through `appendAudit`.
13. **`check mark` from this computer's own scheduler** (OpenClaw/Hermes cron): at or after the scheduled time, not from a terminal → yes-tested; included in Task 10. Two wrong words cancel a challenge (`mark` as `answer`).
14. **Parent chain**: a best-effort `ps -o ppid=` walk by absolute path on POSIX, empty on Windows; it only annotates the reason.
15. **The two-question confirmation for described workflows** is part of Task 5's confirmation page in 4a; until a workflow is confirmed it is hard-rule work, Home 1 or draft-only.
16. **`answers`** is derived in `decideHome` from any fresh acting result (T1, T2, T7, T8, the work done once), not only T1.

**Split**: Task 2 becomes 2a (opener and launch) and 2b (the pages).
