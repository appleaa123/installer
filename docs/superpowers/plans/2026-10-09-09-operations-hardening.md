# Operations and Security Hardening Implementation Plan (Plan 9 of 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a live install healthy and safe, and let a person stop or remove it: `installer doctor` (health checks with a fix for each finding, clearing run claims a crash left behind, naming damaged records, deleting data past a configurable retention period, run once a day by the tick), host readiness on a team host (Layer 1: read-only checks of the OS settings with printed fixes, a readiness score, boot service files, the dedicated-user steps), the kill switch (`installer pause` / `unpause`, `/pause` / `/unpause` from the decision maker), Skills Wiki packs pinned by content with a shadow upgrade the decision maker switches, the data-flow summary in the report, `installer uninstall` and a redacted `installer support bundle`.

**Architecture:** `src/core/pause.ts` is the kill switch: `outboundBlock`, the gate (`invokeTool`), `startRun` and the tick each ask `isPaused`, and the inbound pipeline reads `/pause` and `/unpause`. `src/core/retention.ts` prunes old operational files; `src/core/doctor-checks.ts` holds one function per check and `src/core/doctor.ts` runs them, keeps the result and runs daily from the tick. `src/core/host.ts` reads OS settings through an injectable `CommandRunner` and `src/core/host-service.ts` writes boot service files and computes the quiet window. `src/core/packs.ts` pins skill files by content and finds new versions; `src/core/shadow.ts` runs them in sandbox shadow, grades them through a `ShadowEval` interface and lets the decision maker switch. `src/core/data-flow.ts` adds the operations view to the report; `src/core/uninstall.ts` and `src/core/support-bundle.ts` remove the body and write the redacted bundle. No OS setting is ever changed by the engine: every OS change is a printed command a person runs.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22 built-ins only at runtime (`fs.promises.statfs` for disk space), Vitest. Still no runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-06-installer-design.md`](../specs/2026-10-06-installer-design.md) §5.1 (host readiness), §14 (threat model, controls, pack pinning and shadow upgrade, kill switch, privacy and retention, data-flow summary), §16.1 (`doctor`), §16.4 (uninstall), §16.5 (support bundle). Decisions in [`DECISIONS.md`](../../../DECISIONS.md) (D34, D36, D38, D42, D43, D50, D61, D78, D86, D99, and D101–D111 added by this plan). Roadmap: [`README.md`](README.md), row 9. Builds on Plans 1–8, in particular [Plan 6](2026-10-08-06-gateway-channels.md) (the R6 sink, the gateway), [Plan 7](2026-10-08-07-workflow-runner.md) (runs, keys, the tick, the scheduler) and [Plan 8](2026-10-08-08-workflow-lifecycle.md) (sandbox runs, judges with skills, terminal-only decisions).

**Design decisions adopted by this plan (recorded as D101–D111 in Task 10):**

- **D101 The kill switch.** `config/pause.json`. While paused every message is recorded (never sent), every call above L0 that is not a message tool is refused, no run starts or resumes, and inbound is still kept. Anyone may pause; `installer unpause` needs a person's terminal; `/pause` and `/unpause` count only from the decision maker on a channel that proves the sender.
- **D102 Retention.** Default 90 days (`config/retention.json`); doctor deletes finished runs with their keys, old inbound messages, recordings, sent counts and seen markers, keeping the newest numbered record and a first-contact marker; never the audit. Shortening needs a person's terminal.
- **D103 `installer doctor`.** Ordered checks with fixes; a check that cannot finish is a finding; orphan run claims older than 5 minutes are cleared; damaged run records are named; daily from the tick, failures told to the decision maker; the gateway's pid file is claimed exclusively.
- **D104 Host readiness.** Read-only OS checks per platform through an injectable `CommandRunner`, fixes printed, a score in the report, boot service files under the home with printed `sudo` commands; Personal mode is informed only; tests never run a real OS command (`INSTALLER_HOST_CHECKS=none`).
- **D105 The dedicated OS user** is documented and printed, never created; the agent still shares it (known limit).
- **D106 The data-flow summary** (which tagged fields go to which outside party) and the operations view join `installer report`.
- **D107 Pack pinning by content.** Skills Wiki serves no version, so the engine keeps each skill file's text by its sha256 and judges read only the pinned copy; a new text is a candidate.
- **D108 The shadow upgrade.** A candidate runs in sandbox shadow next to the pinned version; a `ShadowEval` grades it (v1: `shadow-runs`; hosted evals deferred, O11); only the decision maker switches, in their terminal.
- **D109 `installer uninstall`** and **D110 `installer support bundle`**, both as in §16.4 and §16.5, with the details below.
- **D111 Left for later:** hosted evals, `commit_sha`, the agent's own OS user, Windows, the 60 s cache, signed updates, drift alerts and expiring logins in doctor.

## Facts from the documentation (the opt-in live test and the live guide check them)

| # | Fact | Used in |
|---|---|---|
| 1 | Skills Wiki's MCP answers carry no pack version. `get_skill_resource(pack, skill_name, path)` answers `{path, kind, content}`, the content wrapped as `<skill_reference>\n…\n</skill_reference>` by `wrap_for_mcp` (deterministic); `skill_pack_meta.commit_sha` is read only by `fetch_skill_pack_meta` in `core/db.py`, which its scripts use (Skills Wiki source, read 2026-10-09; no call made) | Tasks 6, 9 |
| 2 | Hosted evals `eval_start(pack, arms, runs)`, `eval_outputs(run_token, outputs)`, `eval_submit(run_token, verdicts, judge_model)` and `eval_status(run_token)` are registered only when the hosted-eval flag is on, need the pack's eval suite switched on in the dashboard, and expect the calling model to answer each task and grade the batch itself (same source) | Task 7 |
| 3 | macOS: `pmset -g` prints one setting per line as `name value` (for example ` sleep 0`, ` autorestart 1`); `fdesetup status` prints `FileVault is On.` or `FileVault is Off.`; `systemsetup -getusingnetworktime` prints `Network Time: On` or `Off` and needs administrator rights (manual pages; not run on this machine) | Task 4 |
| 4 | Linux: `systemctl is-enabled <unit>…` prints one state per unit (`masked` when masked); `timedatectl show -p NTPSynchronized --value` prints `yes` or `no`; `lsblk -rno TYPE` lists `crypt` for an encrypted (LUKS) volume (manual pages; not run) | Task 4 |
| 5 | Node 22's `fs.promises.statfs(path)` returns `bavail` (free blocks for unprivileged users) and `bsize` | Task 3 |

## Global Constraints

- Everything in the Global Constraints of Plans 1–8 still applies: Node ≥ 22, strict TypeScript, ESM with `.js` suffixes, zero runtime dependencies, immutable updates, functions < 50 lines, files < 400 lines, no `console.log`, exit codes `0` OK / `1` internal / `2` usage, input or rule (including `ActionFailure`, `ToolRefusal`) / `3` corrupt state or audit, D34 confinement (every engine file through `confinedPath`, folders `0700`, files `0600`), R9/D27 neutrality (no industry vocabulary in `src/`, `tests/fixtures/`, `profiles/`, `connectors/`, `solutions/`, `INSTALL.md`; this plan adds nothing under `tests/fixtures/`; the words "listing", "property", "lease" and "rent" never appear in new prose there).
- The engine never changes an OS setting and never runs `sudo`, `pmset -a`, `systemsetup -set…`, `launchctl`, `crontab`, `systemctl enable|mask`, `powercfg` or `fdesetup enable`: host readiness only reads (through `CommandRunner`), and every change is a printed command for a person's own terminal. The test suite sets `INSTALLER_HOST_CHECKS=none`, so no real OS command runs in it; host tests answer with fakes.
- Anything that loosens safety needs a person's terminal (D61 pattern: `process.stdin.isTTY === true`, and an agent's attempt exits 2 and is audited): `installer unpause`, a shorter retention period, `installer uninstall`, `installer packs switch` (the decision maker only). Anything that tightens it may come from anywhere: `installer pause`, a longer retention period.
- R6 and the gate still hold: every message goes through `deliver`, every action through `invokeTool`; a shadow run is a sandbox run (D91).
- Tests stay offline: the fake Skills Wiki serves skill files from a temporary folder, the fake agent answers judges (`FAKE_AGENT_JUDGE`), the fake Telegram receives the kill switch's answers and the doctor's notices. Nothing reads `~/.config/installer-dev/.env`. Nothing calls the real `claude`. The opt-in live test (`tests/live/packs.live.test.ts`, `INSTALLER_LIVE=1`) reads one skill file twice; nothing writes to the real Skills Wiki.
- `install-state.json` and its `schema: 1` do not change; new data lives under `config/`, `state/doctor/`, `runtime/service/`, `packs/`, `data/channels/first-contact/` and `exports/`.

## Review Focus

1. **The agent's shell loosens safety: unpauses, shortens retention, uninstalls or switches a pack version.** Each exits 2 and is audited. Tests: Task 1 (`lets anyone pause from the CLI, but unpausing needs a person's terminal; the agent's attempt is refused and audited`), Task 2 (`keeps 90 days unless told; a longer period may come from anywhere, a shorter one only from a person's terminal`), Task 7 (`is switched by the decision maker alone, in their own terminal; judges then read the new version`), Task 8 (`needs a person's terminal: the agent's attempt is refused, audited, and removes nothing`), Task 9 (`refuses a shorter retention, a pack switch and an uninstall from the agent's shell`).
2. **Something still goes out while paused: a message, a write, a run, a gateway announcement.** Nothing does. Tests: Task 1 (`records every message while paused and refuses every other action above L0; reads still work`, `stops the runner: nothing starts, the tick only notes the host is alive, and slots in the pause are missed afterwards`).
3. **A support bundle leaks a secret, a name, an address, a message or the OS user's folder.** It holds none. Test: Task 8 (`never holds a secret, a name, an address, a message, a record, an answer or the OS user's home folder`, with sentinel values in the state, members, inbox, memos, approvals, sources and logs).
4. **A changed Skills Wiki pack reaches a live judge before the decision maker switched.** Judges read only the pinned copy; a candidate is read only by shadow runs. Tests: Task 6 (`pins a skill file the first time a judge needs it, and judges keep the pinned copy after Skills Wiki changes it`, `never uses a pinned copy that changed on disk`), Task 7 (`does not pass a candidate that needs a person more often, and such a version cannot be switched`).
5. **Doctor or retention destroys something that is still needed: the audit, a claim being written, a waiting run, the newest id a cursor compares against, a contact's consent.** None of them. Tests: Task 2 (`deletes finished runs older than the period with their keys, and keeps unfinished and recent ones`, `deletes old inbound messages and recordings but keeps the newest of each, and remembers who wrote first`, `never deletes from the audit …`), Task 3 (`clears a run claim a crash left without its run.json once it is old, and the key works again`).

---

## File Structure

```
INSTALL.md                     # MODIFY + section 10, health, the kill switch and support (Task 9)
vitest.config.ts               # MODIFY INSTALLER_HOST_CHECKS=none (4)
src/
  cli.ts                       # MODIFY report operations (5); doctor, pause, unpause, host, packs, retention, support, uninstall (9)
  core/
    pause.ts                   # NEW the kill switch (1, D101)
    retention.ts               # NEW the retention period and pruning (2, D102)
    doctor.ts, doctor-checks.ts    # NEW installer doctor, the daily run (3, D103); host (4) and packs (7) checks
    host.ts, host-service.ts   # NEW host readiness, boot services, quiet window, dedicated user (4, D104, D105)
    data-flow.ts               # NEW the data-flow summary and the report's operations view (5, D106)
    packs.ts                   # NEW pins by content and candidates (6, D107); shadow results (7)
    shadow.ts                  # NEW shadow runs, ShadowEval, the switch, installer packs (7, D108)
    uninstall.ts, support-bundle.ts    # NEW (8, D109, D110)
    envelope.ts, inbound.ts, outbound.ts, tools.ts, runner.ts, tick.ts   # MODIFY the kill switch (1); the daily doctor (3)
    runs.ts, inbox.ts          # MODIFY removeRun, first-contact markers (2); orphan claims (3); shadow runs (7)
    audit.ts, gateway-process.ts, channel-commands.ts   # MODIFY lock export, exclusive pid claim, checkChannel (3)
    scheduler.ts               # MODIFY export xml (4)
    runner-steps.ts            # MODIFY judges read pinned skills (6); shadow runs read the candidate (7)
    disconnect.ts              # MODIFY unregisterEverywhere by name (8)
tests/
  live/packs.live.test.ts      # NEW opt-in, one skill file read twice (9)
  unit/  pause, retention, doctor, host, data-flow, packs, shadow, uninstall, support-bundle (NEW)
  e2e/   operations-cli (NEW); gateway-cli, install-doc (MODIFY)
docs/  DECISIONS.md, spec, roadmap, human-tasks, testing/2026-10-09-plan-9-live-test.md (10)
```

**Edit conventions used below.** "Create `path`:" gives the whole new file. "Replace the whole of `path` with:" gives the whole new content of an existing file. "In `path`, replace: … with: …" replaces exactly one occurrence of the first block (it must match byte for byte, and occurs exactly once in the file at that point). "In `path`, add after: … this: …" inserts the second block on new lines directly after the whole line in which the anchor ends; "In `path`, add before: … this: …" inserts it on new lines directly before the whole line in which the anchor starts (no blank line is added in either case). Edits to one file are listed in file order and are applied in the order given. A file a block creates or replaces ends with one newline after the block's last line. Test counts in `Expected:` lines are for the named files; suite totals include the neutrality scan, which adds one test per new file under `src/` (this plan adds none under `tests/fixtures/`). Baseline before Task 1: 83 test files, 1180 tests (`feat/workflow-lifecycle` at `6ae6ecc`, after the Plan 8 review fixes). If the branch has later commits that add tests, every suite total below shifts by the same difference and the per-file counts do not change. Branch: create `feat/operations` from `feat/workflow-lifecycle` before Task 1.

---

### Task 1: The kill switch (§14.4, D34, D36, D101)

**Files:**
- Create: `src/core/pause.ts`, `tests/unit/pause.test.ts`
- Modify: `src/core/envelope.ts`, `src/core/inbound.ts`, `src/core/outbound.ts`, `src/core/runner.ts`, `src/core/tick.ts`, `src/core/tools.ts`

**Interfaces:**
- Consumes: `readConfig` / `writeConfig` (`data-source.ts`), `appendAudit`, `CHANNEL_FACTS` (`channels.ts`), `Member` (`members.ts`), `commandLine` (`envelope.ts`), Plan 6's `outboundBlock` and `handleInbound`, Plan 7's `startRun` and `tick`.
- Produces: `PAUSE_FILE`, `PAUSED_REASON`, `PAUSED_TEXT`, `UNPAUSED_TEXT`, `PauseState`, `Switcher`, `loadPause(home)`, `isPaused(home): Promise<boolean>`, `setPaused(home, paused, by: Switcher, now, reason?)`, `pauseCommand(home, sub, person, reason, now)`, `unpauseCommand(home, person, now)`, `switchRefusal(member, channel, command)` (`pause.ts`); `killSwitchIn(text): "pause" | "unpause" | null` (`envelope.ts`); `TickResult.status` gains `"paused"`. While paused: `outboundBlock` answers `PAUSED_REASON`, `invokeTool` refuses a non-message call above L0, `startRun` throws `InputError` ("No run starts: …").

- [ ] **Step 1: Write the failing tests**

The tests pin what the switch stops (messages, writes, runs), what it keeps (reads, inbound), who may switch it from where, and what the tick leaves behind: `alive` moves on, `last` does not, so slots that fell due during the pause are recorded as missed afterwards and no back-online notice is sent.

Create `tests/unit/pause.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRefusal } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { killSwitchIn } from "../../src/core/envelope.js";
import { handleInbound } from "../../src/core/inbound.js";
import { listInbox } from "../../src/core/inbox.js";
import { OUTBOX_DIR } from "../../src/core/outbound.js";
import { PAUSED_REASON, isPaused, loadPause, pauseCommand, setPaused, unpauseCommand } from "../../src/core/pause.js";
import { startRun } from "../../src/core/runner.js";
import { listRuns } from "../../src/core/runs.js";
import { HEARTBEAT_FILE, tick } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { ADA, OWNER, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const AGENT = { interactive: false };
const PERSON = { interactive: true, as: "Owner" };
/** Every ten minutes in Toronto, one memo each time. */
const EVERY_TEN = { workflow: "pulse", version: 1, trigger: { cron: "*/10 * * * *", tz: "America/Toronto" }, steps: [{ id: "note", tool: "memo.add", args: { text: "Pulse ${run.scheduled_for}" } }] };
let fake: FakeTelegram;
let ids = 0;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const from = (address: string, text: string) => ({ channel: "telegram", from: address, thread: address, text, message_id: `p${++ids}` });
const sentTo = async (chat: string): Promise<string[]> => (await fake.sent()).filter((message) => message.chat_id === chat).map((message) => message.text);
const ctxOf = async (home: string, via: "cli" | "gateway" = "cli") => toolContext(home, via, DEFAULT_TOOLS, () => AT);

describe("the kill switch (§14.4, D36, D101)", () => {
  it("reads /pause and /unpause only as the whole first line", () => {
    expect(killSwitchIn("/pause")).toBe("pause");
    expect(killSwitchIn("  /UNPAUSE@desk_test_bot\nthanks")).toBe("unpause");
    expect(killSwitchIn("please /pause")).toBeNull();
    expect(killSwitchIn("/pause now")).toBeNull();
  });

  it("is off when nothing set it; pausing and unpausing are audited with who did it", async () => {
    const home = await runnerHome();
    expect(await isPaused(home)).toBe(false);
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT, "checking a report");
    expect(await loadPause(home)).toEqual({ paused: true, at: AT, by: "agent", via: "cli", reason: "checking a report" });
    await setPaused(home, false, { name: "Owner", actor: "human", via: "cli" }, AT);
    expect(await isPaused(home)).toBe(false);
    expect((await events(home)).slice(-2)).toEqual(["engine.paused", "engine.unpaused"]);
  });

  it("records every message while paused and refuses every other action above L0; reads still work", async () => {
    const home = await channelHome(true);
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT);
    const ctx = await ctxOf(home);
    const notified = await invokeTool(ctx, "channel.notify", { member: "Owner", text: "Held back by the pause" });
    expect(notified.deliveries).toEqual([{ channel: "telegram", status: "recorded", outbox_id: 1, reason: PAUSED_REASON }]);
    expect(await sentTo(OWNER.address)).not.toContain("Held back by the pause");
    await expect(invokeTool(ctx, "memo.add", { text: "x" })).rejects.toThrow(ToolRefusal);
    expect(await invokeTool(ctx, "memo.list", {})).toEqual({ memos: [] });
    expect(JSON.parse(await readFile(join(home, OUTBOX_DIR, "1.json"), "utf8"))).toMatchObject({ text: "Held back by the pause", reason: PAUSED_REASON });
    expect(await events(home)).toContain("tool.refused");
  });

  it("stops the runner: nothing starts, the tick only notes the host is alive, and slots in the pause are missed afterwards", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, EVERY_TEN);
    await writeConfig(home, HEARTBEAT_FILE, { last: "2026-10-08T11:59:00.000Z", pid: 1 });
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT);
    expect(await tick(home, () => "2026-10-08T12:00:30.000Z")).toMatchObject({ status: "paused", started: [], missed: [] });
    expect(JSON.parse(await readFile(join(home, HEARTBEAT_FILE), "utf8"))).toMatchObject({ last: "2026-10-08T11:59:00.000Z", alive: "2026-10-08T12:00:30.000Z" });
    const workflow = parseWorkflow(EVERY_TEN, "pulse", DEFAULT_TOOLS);
    await expect(startRun({ home, workflow, key: "pulse:manual", trigger: { kind: "manual" }, now: () => AT })).rejects.toThrow("No run starts");
    expect(await tick(home, () => "2026-10-08T12:19:30.000Z")).toMatchObject({ status: "paused" });
    await setPaused(home, false, { name: "Owner", actor: "human", via: "cli" }, AT);
    const after = await tick(home, () => "2026-10-08T12:20:30.000Z");
    expect(after).toMatchObject({ status: "ran", back_online: false, missed: [expect.stringContaining("(missed)"), expect.stringContaining("(missed)")], started: [expect.stringContaining("(completed)")] });
    expect((await listRuns(home, "pulse")).map((run) => run.status)).toEqual(["missed", "missed", "completed"]);
  });

  it("works from the decision maker's Telegram: /pause answers before it stops, /unpause after it restarts", async () => {
    const home = await channelHome(true);
    const gateway = await ctxOf(home, "gateway");
    expect(await handleInbound(gateway, from(OWNER.address, "/pause"))).toBe("decided");
    expect(await loadPause(home)).toMatchObject({ paused: true, by: "Owner", via: "telegram" });
    expect(await sentTo(OWNER.address)).toContainEqual(expect.stringContaining("Paused."));
    expect(await handleInbound(gateway, from(OWNER.address, "/unpause"))).toBe("decided");
    expect(await isPaused(home)).toBe(false);
    expect(await sentTo(OWNER.address)).toContainEqual(expect.stringContaining("Running again"));
    expect((await listInbox(home)).map((item) => item.route)).toEqual(["command", "command"]);
  });

  it("refuses a member's /pause and audits it; a stranger's /pause is only a message", async () => {
    const home = await channelHome(true);
    const gateway = await ctxOf(home, "gateway");
    expect(await handleInbound(gateway, from(ADA.address, "/pause"))).toBe("refused");
    expect(await handleInbound(gateway, from("5005", "/pause"))).toBe("event");
    expect(await isPaused(home)).toBe(false);
    expect(await events(home)).toContain("engine.switch_refused");
    expect(await sentTo(ADA.address)).toContainEqual(expect.stringContaining("Only the decision maker"));
  });

  it("lets anyone pause from the CLI, but unpausing needs a person's terminal; the agent's attempt is refused and audited", async () => {
    const home = await runnerHome();
    expect(await pauseCommand(home, undefined, AGENT, "a test", () => AT)).toMatchObject({ status: "paused", by: "agent", reason: "a test" });
    await expect(unpauseCommand(home, AGENT, () => AT)).rejects.toThrow("in their own terminal");
    expect(await isPaused(home)).toBe(true);
    expect(await events(home)).toContain("engine.unpause_refused");
    expect(await unpauseCommand(home, PERSON, () => AT)).toMatchObject({ status: "unpaused", paused: false, by: "Owner" });
    expect(await pauseCommand(home, "status", AGENT, undefined, () => AT)).toEqual({ pause: { paused: false, at: AT, by: "Owner", via: "cli" } });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/pause.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/pause.js'`; no test runs.

- [ ] **Step 3: The switch itself**

`setPaused` writes the file and audits the switch; `pauseCommand` lets anyone stop the engine, `unpauseCommand` refuses (and audits) without a terminal; `switchRefusal` says why a channel message may not switch it.

Create `src/core/pause.ts`:

```ts
import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import type { Member } from "./members.js";
import { StateCorruptError } from "./state.js";

/**
 * The kill switch (spec §14.4, D34, D36, D101). `installer pause`, or `/pause` from the decision maker on a channel
 * that proves the sender, stops everything that leaves the host at once: every message goes to the recording sink
 * (`outboundBlock`), every tool call above L0 is refused, the tick starts and resumes no runs, and `installer run`
 * refuses. Inbound messages are still received and kept. Stopping is always safe, so anyone may pause, the agent
 * included; unpausing sends real messages again, so it needs a person's terminal (D61) or `/unpause` from the
 * decision maker on such a channel. Every switch, and every refusal, is audited.
 */
export const PAUSE_FILE = join("config", "pause.json");
export const PAUSED_REASON = "the engine is paused (installer pause or /pause): nothing goes out until a person runs 'installer unpause' or the decision maker sends /unpause (D36)";
export const PAUSED_TEXT = "Paused. Messages are recorded, not sent, and no workflow runs until you send /unpause or run 'installer unpause'. Incoming messages are still kept.";
export const UNPAUSED_TEXT = "Running again: messages are sent and workflows run as scheduled. Runs that fell due during the pause are recorded as missed, not run late.";

export interface PauseState {
  readonly paused: boolean;
  readonly at: string;
  readonly by: string;
  /** Where the switch came from: `cli`, or the channel of a `/pause` message. */
  readonly via: string;
  readonly reason?: string;
}

export interface Switcher {
  readonly name: string;
  readonly actor: "human" | "agent";
  readonly via: string;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export async function loadPause(home: string): Promise<PauseState | null> {
  const raw = await readConfig(home, PAUSE_FILE);
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.paused !== "boolean" || typeof raw.at !== "string") throw new StateCorruptError(`${PAUSE_FILE} has an unexpected shape; remove it, then run 'installer pause' again`);
  return raw as unknown as PauseState;
}

/** No file means the engine runs (installs before Plan 9 keep their behaviour). */
export const isPaused = async (home: string): Promise<boolean> => (await loadPause(home))?.paused === true;

export async function setPaused(home: string, paused: boolean, by: Switcher, now: string, reason?: string): Promise<PauseState> {
  const state: PauseState = { paused, at: now, by: by.name, via: by.via, ...(reason ? { reason } : {}) };
  await writeConfig(home, PAUSE_FILE, state);
  await appendAudit(home, { ts: now, actor: by.actor, event: paused ? "engine.paused" : "engine.unpaused", ref: PAUSE_FILE, payload: state });
  return state;
}

const switcher = (person: { interactive: boolean; as?: string }): Switcher =>
  person.interactive ? { name: person.as?.trim() || "terminal", actor: "human", via: "cli" } : { name: "agent", actor: "agent", via: "cli" };

/** `installer pause [status] [--reason <text>]`: anyone may stop the engine; the agent's pause is audited as the agent's. */
export async function pauseCommand(home: string, sub: string | undefined, person: { interactive: boolean; as?: string }, reason: string | undefined, now: () => string): Promise<Record<string, unknown>> {
  if (sub === "status") return { pause: (await loadPause(home)) ?? { paused: false } };
  if (sub !== undefined) throw new InputError("pause takes nothing (pause now) or: status");
  const state = await setPaused(home, true, switcher(person), now(), reason);
  return { status: "paused", ...state, note: "Messages are recorded, not sent; no run starts; incoming messages are still kept. A person runs 'installer unpause' in their own terminal to restart." };
}

/** `installer unpause`: sends real messages and starts runs again, so only a person, in their own terminal (D61). */
export async function unpauseCommand(home: string, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (!person.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "engine.unpause_refused", ref: PAUSE_FILE, payload: { command: "installer unpause" } });
    throw new InputError("Unpausing sends real messages and starts runs again: the person runs 'installer unpause' in their own terminal, or the decision maker sends /unpause in Telegram");
  }
  if (!(await isPaused(home))) return { status: "running", note: "The engine was not paused" };
  return { status: "unpaused", ...(await setPaused(home, false, switcher(person), now())) };
}

/**
 * Why a `/pause` or `/unpause` message decides nothing, or null when it may: only the decision maker (D26, D60), and
 * only on a channel that proves who wrote (D78: Telegram, not email).
 */
export function switchRefusal(member: Member, channel: string, command: "pause" | "unpause"): string | null {
  if (!CHANNEL_FACTS[requireChannelId(channel)].risk.sender_verified) return `/${command} is not accepted by ${channel}, where the sender can be forged: send it in Telegram, or run 'installer ${command}' in a terminal`;
  if (member.role !== "decision_maker") return `Only the decision maker can send /${command}; nothing was changed`;
  return null;
}
```

- [ ] **Step 4: `/pause` and `/unpause` as a command shape**

In `src/core/envelope.ts`, replace:

```ts
 * typed: a join code, a reply code (§11.9) or an opt-out keyword (§12.5).
```

with:

```ts
 * typed: a join code, a reply code (§11.9), an opt-out keyword (§12.5) or the kill switch (§14.4, D101).
```

In `src/core/envelope.ts`, replace:

```ts
}

/** The whole first line is an opt-out word (STOP, unsubscribe, a recipe's own), ignoring case and end punctuation. */
```

with:

```ts
}

const SWITCH = /^\/(pause|unpause)(?:@[A-Za-z0-9_]+)?$/i;

/** `/pause` or `/unpause` as the whole first line (Telegram may add `@<bot name>`): the kill switch (§14.4, D36). */
export function killSwitchIn(text: string): "pause" | "unpause" | null {
  const match = SWITCH.exec(commandLine(text));
  return match?.[1] ? (match[1].toLowerCase() as "pause" | "unpause") : null;
}

/** The whole first line is an opt-out word (STOP, unsubscribe, a recipe's own), ignoring case and end punctuation. */
```

- [ ] **Step 5: The inbound pipeline works the switch for the decision maker only**

A member's `/pause` is read before reply codes, so it never becomes a conversation. The answer to `/pause` goes out before the switch closes (a send that fails never keeps the engine running); the answer to `/unpause` after it opens.

In `src/core/inbound.ts`, replace:

```ts
import { DEFAULT_POLICY, recordOptOut } from "./channel-policy.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import { isOptOut, joinCodeIn, normalizeInbound, replyCodeIn, type InboundEnvelope, type RawInbound, type ReplyCode } from "./envelope.js";
import { storeInbound, type Route } from "./inbox.js";
import { joinWithCode, memberFor, type Identity, type Member } from "./members.js";
```

with:

```ts
import { ToolRefusal } from "./approvals.js";
import { DEFAULT_POLICY, recordOptOut } from "./channel-policy.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import { isOptOut, joinCodeIn, killSwitchIn, normalizeInbound, replyCodeIn, type InboundEnvelope, type RawInbound, type ReplyCode } from "./envelope.js";
import { ActionFailure } from "./failure.js";
import { storeInbound, type Route } from "./inbox.js";
import { InputError } from "./inputs.js";
import { joinWithCode, memberFor, type Identity, type Member } from "./members.js";
import { PAUSED_TEXT, PAUSE_FILE, UNPAUSED_TEXT, setPaused, switchRefusal } from "./pause.js";
```

In `src/core/inbound.ts`, replace:

```ts
 * only the three command shapes are read, and only a joined member's reply code can decide anything.
```

with:

```ts
 * only the command shapes are read, only a joined member's reply code can decide anything, and only the decision
 * maker's `/pause` or `/unpause` on a channel that proves the sender works the kill switch (D101).
```

In `src/core/inbound.ts`, replace:

```ts
}

/** Drops a message handled before; otherwise routes it and only then marks it seen (storing is idempotent). */
```

with:

```ts
}

/** Tells the member before the switch closes; a message that cannot go out never keeps the engine from pausing. */
async function tellFirst(ctx: ToolContext, member: Member, channel: string, text: string): Promise<boolean> {
  try {
    await tell(ctx, member, channel, text);
    return true;
  } catch (error) {
    if (error instanceof InputError || error instanceof ToolRefusal || error instanceof ActionFailure) return false;
    throw error;
  }
}

/** `/pause` and `/unpause` (§14.4, D101): the decision maker on a channel that proves the sender; anyone else is refused and audited. */
async function killSwitch(ctx: ToolContext, envelope: InboundEnvelope, member: Member, command: "pause" | "unpause"): Promise<Outcome> {
  await storeInbound(ctx.home, envelope, "command", member.name);
  const refusal = switchRefusal(member, envelope.channel, command);
  if (refusal !== null) {
    await appendAudit(ctx.home, { ts: ctx.now(), actor: "human", event: "engine.switch_refused", ref: PAUSE_FILE, payload: { command, by: member.name, channel: envelope.channel } });
    await tellFirst(ctx, member, envelope.channel, refusal);
    return "refused";
  }
  if (command === "pause") await tellFirst(ctx, member, envelope.channel, PAUSED_TEXT);
  await setPaused(ctx.home, command === "pause", { name: member.name, actor: "human", via: envelope.channel }, ctx.now());
  if (command === "unpause") await tell(ctx, member, envelope.channel, UNPAUSED_TEXT);
  return "decided";
}

/** Drops a message handled before; otherwise routes it and only then marks it seen (storing is idempotent). */
```

In `src/core/inbound.ts`, add after:

```ts
  const member = await memberFor(ctx.home, identity, ctx.now());
```

this:

```ts
  const command = member ? killSwitchIn(envelope.text) : null;
  if (member && command) return killSwitch(ctx, envelope, member, command);
```

- [ ] **Step 6: Nothing goes out, nothing acts, nothing runs**

`outboundBlock` answers first, so `deliver`, the gateway's announcements and `channel.list` agree; the gate refuses any other call above L0 (a message tool still runs, into the sink); `startRun` refuses; the tick marks only that the host is alive.

In `src/core/outbound.ts`, add after:

```ts
import { createRecord, listRecords } from "./numbered.js";
```

this:

```ts
import { PAUSED_REASON, isPaused } from "./pause.js";
```

In `src/core/outbound.ts`, replace:

```ts
 * run records every other action it would take as well (`recordAction`), so nothing it does is real.
```

with:

```ts
 * run records every other action it would take as well (`recordAction`), so nothing it does is real. While the
 * engine is paused (the kill switch, D101) every message is recorded as well.
```

In `src/core/outbound.ts`, add after:

```ts
export async function outboundBlock(home: string): Promise<string | null> {
```

this:

```ts
  if (await isPaused(home)) return PAUSED_REASON;
```

In `src/core/tools.ts`, add after:

```ts
import { recordAction } from "./outbound.js";
```

this:

```ts
import { PAUSED_REASON, isPaused } from "./pause.js";
```

In `src/core/tools.ts`, add after:

```ts
  const prepared = await prepareAction(ctx, tool, args);
```

this:

```ts
  // The kill switch (D101): nothing above L0 acts while paused; a message tool still runs, into the recording sink.
  if (prepared.level !== "L0" && !tool.outbound && (await isPaused(ctx.home))) return refuse(ctx, prepared, PAUSED_REASON);
```

In `src/core/runner.ts`, add after:

```ts
import { FINISHED, auditRun, claimRun, fingerprint, loadStep, runForKey, runIdFor, saveRun, saveStep, type RunRecord, type RunTrigger } from "./runs.js";
```

this:

```ts
import { PAUSED_REASON, isPaused } from "./pause.js";
```

In `src/core/runner.ts`, add after:

```ts
export async function startRun(request: RunRequest): Promise<RunRecord> {
```

this:

```ts
  if (await isPaused(request.home)) throw new InputError(`No run starts: ${PAUSED_REASON}`);
```

In `src/core/tick.ts`, add after:

```ts
import { listInbox, type InboxItem } from "./inbox.js";
```

this:

```ts
import { isPaused } from "./pause.js";
```

In `src/core/tick.ts`, replace:

```ts
  readonly status: "ran" | "busy";
```

with:

```ts
  /** `paused`: the kill switch is on (D101); the tick only notes that the host is alive. */
  readonly status: "ran" | "busy" | "paused";
```

In `src/core/tick.ts`, add after:

```ts
    await writeConfig(home, HEARTBEAT_FILE, { ...beat, alive: state.at, pid: process.pid });
```

this:

```ts
    // Paused (D101): no run starts or resumes; `last` stays, so slots that fall due meanwhile are recorded as missed afterwards.
    if (await isPaused(home)) return { ...result, status: "paused" };
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/unit/pause.test.ts tests/unit/tick.test.ts tests/unit/inbound.test.ts`
Expected: PASS, 45 tests (7 new, the 15 tick tests and the 23 inbound tests, unchanged).

- [ ] **Step 8: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 84 files, 1188 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/pause.ts src/core/envelope.ts src/core/inbound.ts src/core/outbound.ts src/core/tools.ts src/core/runner.ts src/core/tick.ts tests/unit/pause.test.ts
git commit -m "feat(core): add the kill switch"
```

---

### Task 2: Retention (§14.5, D86, D102)

**Files:**
- Create: `src/core/retention.ts`, `tests/unit/retention.test.ts`
- Modify: `src/core/runs.ts`, `src/core/inbox.ts`

**Interfaces:**
- Consumes: `listRuns`, `FINISHED` (`runs.ts`), `listRecords`, `removeRecord`, `listIds` (`numbered.ts`), `INBOX_DIR` (`inbox.ts`), `OUTBOX_DIR` (`outbound.ts`), `SENT_DIR` (`channel-policy.ts`), `SEEN_DIR` (`inbound.ts`).
- Produces: `RETENTION_FILE`, `DEFAULT_RETENTION_DAYS` (90), `MIN_RETENTION_DAYS` (7), `MAX_RETENTION_DAYS` (3650), `Retention`, `Pruned` (`{runs, inbox, recordings, sent, seen}`), `loadRetention(home)`, `retentionCommand(home, value, person, now)`, `pruneOld(home, now): Promise<Pruned>` (`retention.ts`); `removeRun(home, record)` (`runs.ts`); `CONTACTS_DIR`, `rememberContact(home, identity)` and a `hasWrittenFirst` that also reads the markers (`inbox.ts`). Task 3's doctor calls `pruneOld`.

- [ ] **Step 1: Write the failing tests**

The tests pin what goes (finished old runs with their keys, old messages, recordings, counts, markers) and what never does (unfinished runs, recent runs, the newest record of each folder, the audit), and that consent outlives a deleted message.

Create `tests/unit/retention.test.ts`:

```ts
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { SENT_DIR, recordSent } from "../../src/core/channel-policy.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { SEEN_DIR } from "../../src/core/inbound.js";
import { hasWrittenFirst, listInbox, storeInbound } from "../../src/core/inbox.js";
import { listIds } from "../../src/core/numbered.js";
import { OUTBOX_DIR, recordAction } from "../../src/core/outbound.js";
import { DEFAULT_RETENTION_DAYS, loadRetention, pruneOld, retentionCommand } from "../../src/core/retention.js";
import { startRun } from "../../src/core/runner.js";
import { KEYS_DIR, listRuns, runForKey } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const OLD = "2026-06-01T12:00:00.000Z";
const RECENT = "2026-10-01T12:00:00.000Z";
const AGENT = { interactive: false };
const PERSON = { interactive: true, as: "Owner" };
const NOTE = parseWorkflow({ workflow: "note", version: 1, steps: [{ id: "add", tool: "memo.add", args: { text: "x" } }] }, "note", DEFAULT_TOOLS);
const TIDY = parseWorkflow({ workflow: "tidy", version: 1, steps: [{ id: "drop", approve: { tool: "memo.delete", args: { id: 1 }, why: "Tidy up" } }] }, "tidy", DEFAULT_TOOLS);

const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const keyPath = (home: string, key: string): string => join(home, KEYS_DIR, createHash("sha256").update(key).digest("hex"));
const message = (from: string, text: string, at: string, id: string) => normalizeInbound({ channel: "telegram", from, thread: from, text, message_id: id }, at);

describe("retention (§14.5, D102)", () => {
  it("keeps 90 days unless told; a longer period may come from anywhere, a shorter one only from a person's terminal", async () => {
    const home = await runnerHome();
    expect(await loadRetention(home)).toEqual({ days: DEFAULT_RETENTION_DAYS });
    expect(await retentionCommand(home, "120", AGENT, () => AT)).toMatchObject({ status: "saved", retention: { days: 120, by: "agent" } });
    await expect(retentionCommand(home, "30", AGENT, () => AT)).rejects.toThrow("in their own terminal");
    expect(await events(home)).toContain("retention.refused");
    expect((await loadRetention(home)).days).toBe(120);
    expect(await retentionCommand(home, "30", PERSON, () => AT)).toMatchObject({ retention: { days: 30, by: "Owner" } });
    await expect(retentionCommand(home, "3", PERSON, () => AT)).rejects.toThrow("from 7 to 3650");
  });

  it("deletes finished runs older than the period with their keys, and keeps unfinished and recent ones", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => OLD), "memo.add", { text: "One" });
    const old = await startRun({ home, workflow: NOTE, key: "note:old", trigger: { kind: "manual" }, now: () => OLD });
    const waiting = await startRun({ home, workflow: TIDY, key: "tidy:old", trigger: { kind: "manual" }, now: () => OLD });
    await startRun({ home, workflow: NOTE, key: "note:recent", trigger: { kind: "manual" }, now: () => RECENT });
    expect([old.status, waiting.status]).toEqual(["completed", "waiting"]);
    expect(await pruneOld(home, AT)).toMatchObject({ runs: 1 });
    expect((await listRuns(home)).map((run) => `${run.workflow}:${run.status}`)).toEqual(["tidy:waiting", "note:completed"]);
    expect(await runForKey(home, "note:old")).toBeNull();
    await expect(access(keyPath(home, "note:old"))).rejects.toThrow();
  });

  it("deletes old inbound messages and recordings but keeps the newest of each, and remembers who wrote first", async () => {
    const home = await runnerHome();
    await storeInbound(home, message("5005", "Hello", OLD, "a"), "event");
    await storeInbound(home, message("5006", "Hi", OLD, "b"), "event");
    await recordAction(home, { tool: "memo.add", args: { text: "a" } }, "L1", OLD);
    await recordAction(home, { tool: "memo.add", args: { text: "b" } }, "L1", OLD);
    expect(await pruneOld(home, AT)).toMatchObject({ inbox: 1, recordings: 1 });
    expect((await listInbox(home)).map((item) => item.id)).toEqual([2]);
    expect(await listIds(home, OUTBOX_DIR)).toEqual([2]);
    expect(await hasWrittenFirst(home, { channel: "telegram", address: "5005" })).toBe(true);
    expect(await hasWrittenFirst(home, { channel: "telegram", address: "5007" })).toBe(false);
    expect((await storeInbound(home, message("5007", "New", AT, "c"), "event")).id).toBe(3);
  });

  it("deletes old sent counts and seen markers too", async () => {
    const home = await runnerHome();
    await recordSent(home, { channel: "telegram", address: "5005" }, OLD);
    await recordSent(home, { channel: "telegram", address: "5005" }, OLD);
    await mkdir(join(home, SEEN_DIR), { recursive: true });
    await writeFile(join(home, SEEN_DIR, "old-marker"), "");
    await utimes(join(home, SEEN_DIR, "old-marker"), new Date(OLD), new Date(OLD));
    await writeFile(join(home, SEEN_DIR, "new-marker"), "");
    expect(await pruneOld(home, AT)).toMatchObject({ sent: 1, seen: 1 });
    expect(await listIds(home, SENT_DIR)).toEqual([2]);
    expect(await readdir(join(home, SEEN_DIR))).toEqual(["new-marker"]);
  });

  it("never deletes from the audit: it only grows, its chain still verifies, and nothing is pruned within the period", async () => {
    const home = await runnerHome();
    await startRun({ home, workflow: NOTE, key: "note:old", trigger: { kind: "manual" }, now: () => OLD });
    const before = (await events(home)).length;
    await pruneOld(home, AT);
    expect((await events(home)).length).toBe(before + 1);
    expect((await events(home)).at(-1)).toBe("retention.pruned");
    expect(await verifyAudit(home)).toEqual({ ok: true, lines: before + 1 });
    expect(await pruneOld(home, AT)).toEqual({ runs: 0, inbox: 0, recordings: 0, sent: 0, seen: 0 });
    expect((await events(home)).length).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/retention.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/retention.js'`; no test runs.

- [ ] **Step 3: A run goes with its key**

The key is removed first: a crash in between leaves a run folder without a key, which the next prune removes again, never a claim without its run.

In `src/core/runs.ts`, replace:

```ts
import { mkdir, readdir } from "node:fs/promises";
```

with:

```ts
import { mkdir, readdir, rm } from "node:fs/promises";
```

In `src/core/runs.ts`, replace:

```ts
export const saveStep = (home: string, record: RunRecord, log: StepLog): Promise<void> => writeConfig(home, stepFile(record, log.step), log);

export async function loadStep(home: string, record: RunRecord, step: string): Promise<StepLog | null> {
```

with:

```ts
export const saveStep = (home: string, record: RunRecord, log: StepLog): Promise<void> => writeConfig(home, stepFile(record, log.step), log);

/** Retention (D102): the key goes first, then the folder, so a crash in between never leaves a claim without its run. */
export async function removeRun(home: string, record: RunRecord): Promise<void> {
  await rm(await confinedPath(home, keyFile(record.key)), { force: true });
  await rm(await confinedPath(home, join(RUNS_DIR, record.workflow, record.run_id)), { recursive: true, force: true });
}

export async function loadStep(home: string, record: RunRecord, step: string): Promise<StepLog | null> {
```

- [ ] **Step 4: Who wrote first outlives the message**

In `src/core/inbox.ts`, replace:

```ts
import { join } from "node:path";
```

with:

```ts
import { createHash } from "node:crypto";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
```

In `src/core/inbox.ts`, add after:

```ts
export const ROUTES = ["conversation", "event", "command"] as const;
```

this:

```ts
/** Who wrote first, kept as one empty file each when retention removes their messages (D102). */
export const CONTACTS_DIR = join("data", "channels", "first-contact");
```

In `src/core/inbox.ts`, replace:

```ts
/** `consent: inbound_first` (D80): has this contact ever written to us on this channel? */
export async function hasWrittenFirst(home: string, identity: Identity): Promise<boolean> {
  return (await listRecords(home, INBOX_DIR, isItem)).some((item) => item.channel === identity.channel && item.from === identity.address);
```

with:

```ts
const contactFile = (home: string, identity: Identity): Promise<string> =>
  confinedPath(home, join(CONTACTS_DIR, createHash("sha256").update(`${identity.channel}\n${identity.address}`).digest("hex")));

/** Called before retention removes a message (D102), so `inbound_first` consent outlives the message itself. */
export async function rememberContact(home: string, identity: Identity): Promise<void> {
  const path = await contactFile(home, identity);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** `consent: inbound_first` (D80): has this contact ever written to us on this channel? */
export async function hasWrittenFirst(home: string, identity: Identity): Promise<boolean> {
  if ((await listRecords(home, INBOX_DIR, isItem)).some((item) => item.channel === identity.channel && item.from === identity.address)) return true;
  try {
    await access(await contactFile(home, identity));
    return true;
  } catch {
    return false;
  }
```

- [ ] **Step 5: The retention period and the pruning**

Create `src/core/retention.ts`:

```ts
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { SENT_DIR } from "./channel-policy.js";
import { readConfig, writeConfig } from "./data-source.js";
import { SEEN_DIR } from "./inbound.js";
import { INBOX_DIR, rememberContact } from "./inbox.js";
import { InputError } from "./inputs.js";
import { listRecords, removeRecord } from "./numbered.js";
import { OUTBOX_DIR } from "./outbound.js";
import { FINISHED, listRuns, removeRun } from "./runs.js";
import { StateCorruptError } from "./state.js";

/**
 * Retention (spec §14.5, D86, D102). Raw operational data is kept for a configurable number of days (default 90):
 * finished run logs with their idempotency keys, inbound messages, recordings in the sink, sent-message counts and
 * the gateway's seen-message markers. The audit is never pruned: it is the record of who did what, and it is
 * exported instead (`installer uninstall`). Business records live in the client's own systems and are never touched.
 * A longer period may be set from anywhere; a shorter one deletes data sooner, so only a person, in a terminal (D61).
 */
export const RETENTION_FILE = join("config", "retention.json");
export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Retention {
  readonly days: number;
  readonly at?: string;
  readonly by?: string;
}

export interface Pruned {
  readonly runs: number;
  readonly inbox: number;
  readonly recordings: number;
  readonly sent: number;
  readonly seen: number;
}

type Raw = Record<string, unknown>;
type Numbered = { readonly id: number } & Raw;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumbered = (value: unknown): value is Numbered => isRecord(value) && typeof value.id === "number";
const validDays = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= MIN_RETENTION_DAYS && value <= MAX_RETENTION_DAYS;

export async function loadRetention(home: string): Promise<Retention> {
  const raw = await readConfig(home, RETENTION_FILE);
  if (raw === null) return { days: DEFAULT_RETENTION_DAYS };
  if (!isRecord(raw) || !validDays(raw.days)) throw new StateCorruptError(`${RETENTION_FILE} has an unexpected shape; remove it and set the period again with 'installer retention --value <days>'`);
  return raw as unknown as Retention;
}

function parseDays(value: string): number {
  const days = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!validDays(days)) throw new InputError(`retention --value must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}, for example --value 90`);
  return days;
}

/** `installer retention [--value <days>]`: shows the period, or sets it; shortening it needs a person's terminal. */
export async function retentionCommand(home: string, value: string | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  const current = await loadRetention(home);
  if (value === undefined) return { retention: current, note: "Run logs, inbound messages and recordings older than this are deleted by 'installer doctor'; the audit is never deleted" };
  const days = parseDays(value);
  if (days < current.days && !person.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "retention.refused", ref: RETENTION_FILE, payload: { from: current.days, to: days } });
    throw new InputError(`A shorter period deletes data sooner: the person runs 'installer retention --value ${days}' in their own terminal`);
  }
  const next: Retention = { days, at: now(), by: person.interactive ? person.as?.trim() || "terminal" : "agent" };
  await writeConfig(home, RETENTION_FILE, next);
  await appendAudit(home, { ts: now(), actor: person.interactive ? "human" : "agent", event: "retention.set", ref: RETENTION_FILE, payload: { from: current.days, to: days, by: next.by } });
  return { status: "saved", retention: next };
}

/** Finished runs that ended before the cutoff, each with its key (a damaged run record is left for `doctor` to name). */
async function pruneRuns(home: string, cutoff: string): Promise<number> {
  let count = 0;
  for (const record of await listRuns(home, undefined, async () => undefined)) {
    if (!FINISHED.includes(record.status) || (record.finished_at ?? record.started_at) >= cutoff) continue;
    await removeRun(home, record);
    count += 1;
  }
  return count;
}

/** Old numbered records go, except the newest of the folder, so new ids keep counting up (cursors compare ids). */
async function pruneNumbered(home: string, dir: string, field: string, cutoff: string, before?: (record: Numbered) => Promise<void>): Promise<number> {
  const records = await listRecords(home, dir, isNumbered);
  const newest = records.at(-1)?.id;
  let count = 0;
  for (const record of records) {
    const at = record[field];
    if (record.id === newest || typeof at !== "string" || at >= cutoff) continue;
    await before?.(record);
    if (await removeRecord(home, dir, record.id)) count += 1;
  }
  return count;
}

/** Marker files last changed before the cutoff. */
async function pruneFiles(home: string, dir: string, cutoffMs: number): Promise<number> {
  const folder = await confinedPath(home, dir);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    if ((await stat(join(folder, name))).mtimeMs >= cutoffMs) continue;
    await rm(join(folder, name), { force: true });
    count += 1;
  }
  return count;
}

/** Deletes what is older than the period (run by `installer doctor`); audited when anything went. Never the audit. */
export async function pruneOld(home: string, now: string): Promise<Pruned> {
  const { days } = await loadRetention(home);
  const cutoff = new Date(Date.parse(now) - days * DAY_MS).toISOString();
  const remember = (item: Numbered): Promise<void> => rememberContact(home, { channel: String(item.channel), address: String(item.from) });
  const pruned: Pruned = {
    runs: await pruneRuns(home, cutoff),
    inbox: await pruneNumbered(home, INBOX_DIR, "received_at", cutoff, remember),
    recordings: await pruneNumbered(home, OUTBOX_DIR, "at", cutoff),
    sent: await pruneNumbered(home, SENT_DIR, "at", cutoff),
    seen: await pruneFiles(home, SEEN_DIR, Date.parse(cutoff)),
  };
  if (Object.values(pruned).some((count) => count > 0)) await appendAudit(home, { ts: now, actor: "engine", event: "retention.pruned", ref: RETENTION_FILE, payload: { days, before: cutoff, ...pruned } });
  return pruned;
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/unit/retention.test.ts tests/unit/runs.test.ts tests/unit/channel-tools.test.ts`
Expected: PASS, 33 tests (5 new, the 5 runs tests and the 23 channel tool tests, unchanged).

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 85 files, 1194 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/retention.ts src/core/runs.ts src/core/inbox.ts tests/unit/retention.test.ts
git commit -m "feat(core): add retention"
```

---

### Task 3: `installer doctor`, orphan run claims and the gateway's pid file (§16.1, D103)

**Files:**
- Create: `src/core/doctor-checks.ts`, `src/core/doctor.ts`, `tests/unit/doctor.test.ts`
- Modify: `src/core/audit.ts`, `src/core/runs.ts`, `src/core/gateway-process.ts`, `src/core/channel-commands.ts`, `src/core/tick.ts`, `tests/e2e/gateway-cli.test.ts`

**Interfaces:**
- Consumes: `verifyAudit`, `loadState` / `isInstallState` / `statePath`, `getSecret`, `listChannels`, `CONNECTOR_SECRETS`, `loadSource`, `loadModelConfig`, `activeComboSlug` / `skillswikiTarget`, `gatewayStatus`, `HEARTBEAT_FILE`, `RUNNER_ALIVE_MS` (`lifecycle.ts`), `proposeHardening`, `listRuns`, `loadPause` (Task 1), `pruneOld` (Task 2).
- Produces: `CheckStatus`, `DoctorCheck` (`{id, status, detail, fix?}`), `DoctorContext`, `DoctorCheckDef` (`{id, run}`), `CLAIM_GRACE_MS`, `MIN_FREE_BYTES`, `isDomainError`, `defaultFreeBytes`, `DOCTOR_CHECKS` (`doctor-checks.ts`); `DOCTOR_FILE`, `DOCTOR_NEXT`, `DOCTOR_EVERY_MS`, `DoctorReport` (`{status, checked_at, checks}`), `DoctorOptions` (`{now, env?, freeBytes?}`), `runDoctor(home, options, checks?)`, `loadDoctorReport(home)`, `dailyDoctor(home, now, env?)`, `doctorCommand(home, now)` (`doctor.ts`); `OrphanClaim`, `orphanClaims(home, now)`, `clearClaim(home, claim, now)` (`runs.ts`); `withAuditLock` exported (`audit.ts`); `claimPid(home, startedAt)` exported (`gateway-process.ts`); `checkChannel(config, env)` (`channel-commands.ts`); `TickResult.doctor`. Tasks 4 and 7 add a check each to `DOCTOR_CHECKS`.

- [ ] **Step 1: Write the failing tests**

Each check's findings are pinned on a home made to show them: a broken audit chain and a damaged state (reported, not crashed on), an old orphan claim (cleared, the key usable again) next to a fresh one (left alone), a damaged run record, a missed run, a missing keychain item, an unreachable Skills Wiki, a dead gateway, a stopped runner, a nearly full disk, and the daily run that tells the decision maker. The pid file test pins the exclusive claim; the e2e test races two starts.

Create `tests/unit/doctor.test.ts`:

```ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_FILE, appendAudit } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { DOCTOR_FILE, dailyDoctor, loadDoctorReport, runDoctor } from "../../src/core/doctor.js";
import { PID_FILE, claimPid } from "../../src/core/gateway-process.js";
import { deleteSecret, setSecret } from "../../src/core/keychain.js";
import { startRun } from "../../src/core/runner.js";
import { KEYS_DIR, RUNS_DIR, recordMissed } from "../../src/core/runs.js";
import { STATE_FILE, loadState, saveState } from "../../src/core/state.js";
import { HEARTBEAT_FILE } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { OWNER, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { deadPid } from "../helpers/dead-pid.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const OLD = "2026-10-08T11:00:00.000Z";
const PLENTY = async (): Promise<number> => 50 * 1024 ** 3;
const NOTE = parseWorkflow({ workflow: "note", version: 1, steps: [{ id: "add", tool: "memo.add", args: { text: "x" } }] }, "note", DEFAULT_TOOLS);
let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const doctor = (home: string, freeBytes = PLENTY) => runDoctor(home, { now: () => AT, freeBytes });
const find = (report: { checks: readonly { id: string }[] }, id: string) => report.checks.find((check) => check.id === id);
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const keyFile = (home: string, key: string): string => join(home, KEYS_DIR, createHash("sha256").update(key).digest("hex"));

async function healthyHome(): Promise<string> {
  const home = await runnerHome();
  await writeConfig(home, HEARTBEAT_FILE, { last: AT, alive: AT, pid: 1 });
  return home;
}

describe("installer doctor (§16.1, D103)", () => {
  it("says ok for a healthy home, keeps the findings and audits the run", async () => {
    const home = await healthyHome();
    const report = await doctor(home);
    expect(report.status).toBe("ok");
    expect(report.checks.map((check) => check.id)).toEqual(["state", "audit", "pause", "secrets", "runner", "gateway", "disk", "run_claims", "run_records", "recent_runs", "retention", "hardening"]);
    expect(await loadDoctorReport(home)).toEqual(report);
    expect(await events(home)).toEqual(["doctor.ran"]);
  });

  it("reports a broken audit chain and a damaged state, naming the backup, instead of stopping", async () => {
    const home = await healthyHome();
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, started_at: AT });
    await appendAudit(home, { ts: AT, actor: "engine", event: "one", ref: "x", payload: {} });
    await appendAudit(home, { ts: AT, actor: "engine", event: "two", ref: "x", payload: {} });
    const lines = (await readFile(join(home, AUDIT_FILE), "utf8")).replace('"event":"one"', '"event":"won"');
    await writeFile(join(home, AUDIT_FILE), lines);
    await writeFile(join(home, STATE_FILE), "{ not json");
    const report = await doctor(home);
    expect(report.status).toBe("fail");
    expect(find(report, "state")).toMatchObject({ status: "fail", detail: expect.stringContaining("install-state.json.bak") });
    expect(find(report, "audit")).toMatchObject({ status: "fail", detail: expect.stringContaining("line 1: hash mismatch") });
    expect((await events(home)).filter((event) => event === "doctor.ran")).toEqual([]);
  });

  it("clears a run claim a crash left without its run.json once it is old, and the key works again", async () => {
    const home = await healthyHome();
    await mkdir(join(home, KEYS_DIR), { recursive: true });
    await writeFile(keyFile(home, "note:old"), JSON.stringify({ workflow: "note", run_id: "2026-10-08-0000aaaa" }));
    await utimes(keyFile(home, "note:old"), new Date(OLD), new Date(OLD));
    await writeFile(keyFile(home, "note:fresh"), JSON.stringify({ workflow: "note", run_id: "2026-10-08-0000bbbb" }));
    await utimes(keyFile(home, "note:fresh"), new Date(AT), new Date(AT));
    const report = await doctor(home);
    expect(find(report, "run_claims")).toMatchObject({ status: "fixed", detail: expect.stringContaining("cleared 1 run claim") });
    await expect(access(keyFile(home, "note:old"))).rejects.toThrow();
    await access(keyFile(home, "note:fresh"));
    expect(await events(home)).toContain("run.claim_cleared");
    expect((await startRun({ home, workflow: NOTE, key: "note:old", trigger: { kind: "manual" }, now: () => AT })).status).toBe("completed");
  });

  it("names damaged run records the tick skips, and runs of the last day that failed or were missed", async () => {
    const home = await healthyHome();
    await mkdir(join(home, RUNS_DIR, "note", "bad"), { recursive: true });
    await writeFile(join(home, RUNS_DIR, "note", "bad", "run.json"), "{");
    await recordMissed(home, "note", 1, "note:2026-10-08T11:00:00.000Z", "2026-10-08T11:00:00.000Z", "2026-10-08T11:30:00.000Z");
    const report = await doctor(home);
    expect(report.status).toBe("warn");
    expect(find(report, "run_records")).toMatchObject({ status: "warn", detail: expect.stringContaining("runs/note/bad") });
    expect(find(report, "recent_runs")).toMatchObject({ status: "warn", detail: expect.stringContaining("missed") });
  });

  it("finds missing keychain items, an unusable Skills Wiki and a channel whose secret is gone", async () => {
    const home = await channelHome(true);
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, skillswiki: { url: "http://127.0.0.1:9/mcp" } });
    await writeConfig(home, HEARTBEAT_FILE, { last: AT, alive: AT, pid: 1 });
    expect(find(await doctor(home), "channel.telegram")).toMatchObject({ status: "ok", detail: "@desk_test_bot answers" });
    await deleteSecret("telegram");
    const report = await doctor(home);
    expect(find(report, "secrets")).toMatchObject({ status: "fail", detail: "missing from the keychain: skillswiki, telegram", fix: "installer secret skillswiki; installer secret telegram" });
    expect(find(report, "skillswiki")).toMatchObject({ status: "fail", detail: expect.stringContaining("installer secret skillswiki") });
    expect(find(report, "channel.telegram")).toMatchObject({ status: "fail", detail: expect.stringContaining("installer secret telegram") });
    await setSecret("telegram", BOT_TOKEN);
  });

  it("sees a gateway that died, a runner that stopped ticking and a nearly full disk", async () => {
    const home = await channelHome(true);
    await writeConfig(home, HEARTBEAT_FILE, { last: OLD, alive: OLD, pid: 1 });
    await mkdir(join(home, "runtime", "gateway"), { recursive: true });
    await writeFile(join(home, PID_FILE), JSON.stringify({ pid: deadPid(), started_at: OLD }));
    const report = await doctor(home, async () => 100 * 1024 ** 2);
    expect(find(report, "gateway")).toMatchObject({ status: "fail", fix: expect.stringContaining("installer gateway start") });
    expect(find(report, "runner")).toMatchObject({ status: "warn", detail: "no tick for 60 minutes (last 2026-10-08T11:00:00.000Z)" });
    expect(find(report, "disk")).toMatchObject({ status: "warn", detail: "only 0.1 GiB free on the engine's disk" });
  });

  it("runs once a day from the tick, the first time only setting the time, and tells the decision maker what failed", async () => {
    const home = await channelHome(true);
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, skillswiki: { url: "http://127.0.0.1:9/mcp" } });
    expect(await dailyDoctor(home, () => AT)).toBeNull();
    expect(await dailyDoctor(home, () => "2026-10-08T18:00:00.000Z")).toBeNull();
    expect(await dailyDoctor(home, () => "2026-10-09T12:01:00.000Z")).toMatchObject({ status: "fail" });
    expect((await fake.sent()).filter((message) => message.chat_id === OWNER.address).map((message) => message.text)).toContainEqual(expect.stringContaining("Daily check:"));
    expect(await events(home)).toContain("doctor.notified");
    await access(join(home, DOCTOR_FILE));
  });
});

describe("the gateway's pid file (D103)", () => {
  it("is claimed exclusively: a live gateway's file is never replaced, a dead one's is", async () => {
    const home = await runnerHome();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      await mkdir(join(home, "runtime", "gateway"), { recursive: true });
      await writeFile(join(home, PID_FILE), JSON.stringify({ pid: sleeper.pid, started_at: AT }));
      await expect(claimPid(home, AT)).rejects.toThrow(`Another gateway is running for this home (pid ${sleeper.pid})`);
      await writeFile(join(home, PID_FILE), JSON.stringify({ pid: deadPid(), started_at: AT }));
      await claimPid(home, AT);
      expect(JSON.parse(await readFile(join(home, PID_FILE), "utf8"))).toEqual({ pid: process.pid, started_at: AT });
    } finally {
      sleeper.kill("SIGKILL");
    }
  });
});
```

In `tests/e2e/gateway-cli.test.ts`, replace:

```ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
```

with:

```ts
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
```

In `tests/e2e/gateway-cli.test.ts`, replace:

```ts
  return { home, env };
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
```

with:

```ts
  return { home, env };
}

/** `installer gateway start` without waiting for it, so two can race; resolves with its JSON line. */
const startAsync = (home: string, env: Record<string, string>): Promise<{ pid: number }> =>
  new Promise((done, fail) => {
    execFile(process.execPath, [resolve("dist/cli.js"), "--home", home, "gateway", "start"], { env: { ...process.env, ...env } }, (error, stdout) => (error ? fail(error) : done(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { pid: number })));
  });

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
```

In `tests/e2e/gateway-cli.test.ts`, replace:

```ts
  });

  it("refuses to start with no channel, says when nothing runs, and names its subcommands", async () => {
```

with:

```ts
  });

  it("leaves exactly one gateway when two starts race for the pid file (D103)", async () => {
    const { home, env } = await install();
    const [first, second] = await Promise.all([startAsync(home, env), startAsync(home, env)]);
    expect(first?.pid).toBe(second?.pid);
    expect(runCli(["gateway", "status"], { home, env }).json).toMatchObject({ status: "running", pid: first?.pid });
    expect(runCli(["gateway", "stop"], { home, env }).json).toMatchObject({ status: "stopped", pid: first?.pid });
    await waitForExit(first?.pid ?? 0);
  });

  it("refuses to start with no channel, says when nothing runs, and names its subcommands", async () => {
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/doctor.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/doctor.js'`; no test runs. (The new race test in the gateway CLI tests can pass before the fix: the window it guards is a few milliseconds wide.)

- [ ] **Step 3: The audit check reads under the lock; claims without their run are found and cleared**

A concurrent append could otherwise look like a damaged last line. A claim whose run.json is damaged is a damaged record, not an orphan.

In `src/core/audit.ts`, replace:

```ts
async function withAuditLock<T>(home: string, task: () => Promise<T>): Promise<T> {
```

with:

```ts
export async function withAuditLock<T>(home: string, task: () => Promise<T>): Promise<T> {
```

In `src/core/runs.ts`, replace:

```ts
import { mkdir, readdir, rm } from "node:fs/promises";
```

with:

```ts
import { mkdir, readdir, rm, stat } from "node:fs/promises";
```

In `src/core/runs.ts`, replace:

```ts
}

/** Called with a damaged run record's error instead of throwing it, so one damaged file does not stop the rest. */
```

with:

```ts
}

/** A claimed key whose run.json was never written (a crash between the two writes of `claimRun`). */
export interface OrphanClaim {
  readonly file: string;
  readonly workflow: string | null;
  readonly run_id: string | null;
  readonly age_ms: number;
}

/** Claims without their run (D103): such a key can never be started again, so `doctor` clears the old ones. */
export async function orphanClaims(home: string, now: string): Promise<OrphanClaim[]> {
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, KEYS_DIR))).filter((name) => /^[0-9a-f]{64}$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: OrphanClaim[] = [];
  for (const name of names) {
    const file = join(KEYS_DIR, name);
    const claim = await readConfig(home, file).catch(() => null);
    const ref = isRecord(claim) && typeof claim.workflow === "string" && typeof claim.run_id === "string" ? { workflow: claim.workflow, run_id: claim.run_id } : null;
    // A damaged run.json is still a run: `doctor` names it, it is not an orphan.
    if (ref && (await readConfig(home, runFile(ref.workflow, ref.run_id)).catch(() => "damaged")) !== null) continue;
    const age = Date.parse(now) - (await stat(await confinedPath(home, file))).mtimeMs;
    found.push({ file, workflow: ref?.workflow ?? null, run_id: ref?.run_id ?? null, age_ms: age });
  }
  return found;
}

export async function clearClaim(home: string, claim: OrphanClaim, now: string): Promise<void> {
  await rm(await confinedPath(home, claim.file), { force: true });
  await appendAudit(home, { ts: now, actor: "engine", event: "run.claim_cleared", ref: claim.file, payload: { workflow: claim.workflow, run_id: claim.run_id } });
}

/** Called with a damaged run record's error instead of throwing it, so one damaged file does not stop the rest. */
```

- [ ] **Step 4: The gateway's pid file is claimed exclusively**

Plan 6 read the pid file, removed it and created it again, so two starts at the same moment could both run. Now the create is exclusive and a dead holder's file is replaced once; the losing `start` reports the gateway that runs.

In `src/core/gateway-process.ts`, replace:

```ts
import { mkdir, open, readFile, rm } from "node:fs/promises";
```

with:

```ts
import { mkdir, readFile, rm } from "node:fs/promises";
```

In `src/core/gateway-process.ts`, replace:

```ts
import { isAlive } from "./durable.js";
```

with:

```ts
import { createExclusive, isAlive } from "./durable.js";
```

In `src/core/gateway-process.ts`, replace:

```ts
 * crash by the OS (launchd, systemd) is Plan 9's host readiness.
```

with:

```ts
 * crash by the OS (launchd, systemd) is Plan 9's host service (D104). The pid file is claimed with an exclusive create,
 * so two starts at the same moment leave one gateway (D103).
```

In `src/core/gateway-process.ts`, replace:

```ts
  const pid = await spawnGateway(home);
```

with:

```ts
  let pid: number;
  try {
    pid = await spawnGateway(home);
  } catch (error) {
    // Another start may have won the race for the pid file: then the gateway runs, which is what was asked.
    const raced = await gatewayStatus(home);
    if (raced.status === "running") return { ...raced, note: "Another start won the race: the gateway is running" };
    throw error;
  }
```

In `src/core/gateway-process.ts`, replace:

```ts
/** Claims the pid file for this process; a live owner wins, a dead one is replaced. */
async function claimPid(home: string, startedAt: string): Promise<void> {
  const path = await confinedPath(home, PID_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await readPid(home);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) throw new ActionFailure(`Another gateway is running for this home (pid ${existing.pid})`);
  await rm(path, { force: true });
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: startedAt }), "utf8");
  await handle.close();
```

with:

```ts
/**
 * Claims the pid file for this process with an exclusive create, so of two gateways starting at once exactly one
 * wins (D103: the read-then-remove of Plan 6 let both run). A live owner wins; a dead one is replaced once.
 */
export async function claimPid(home: string, startedAt: string): Promise<void> {
  const path = await confinedPath(home, PID_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createExclusive(path, JSON.stringify({ pid: process.pid, started_at: startedAt }))) return;
    const existing = await readPid(home);
    if (existing && existing.pid !== process.pid && isAlive(existing.pid)) throw new ActionFailure(`Another gateway is running for this home (pid ${existing.pid})`);
    await rm(path, { force: true });
  }
  throw new ActionFailure("Another gateway claimed this home at the same moment: run 'installer gateway status'");
```

- [ ] **Step 5: A channel check that sends and saves nothing**

In `src/core/channel-commands.ts`, replace:

```ts
}

/** A channel as the person and the agent see it: never its secret. */
```

with:

```ts
}

/** `doctor` (§16.1, D103): the channel still answers with its stored secret; nothing is sent and nothing is saved. */
export async function checkChannel(config: ChannelConfig, env: Env = process.env): Promise<string> {
  const secret = await channelSecret(config.channel, env);
  if (config.channel === "telegram") return `@${(await telegramApi(secret, env).getMe()).username} answers`;
  await withImap(config.imap, secret, (session) => session.examine(MAILBOX), env);
  await smtpVerify(config.smtp, secret, env);
  return "IMAP and SMTP sign-in work";
}

/** A channel as the person and the agent see it: never its secret. */
```

- [ ] **Step 6: The checks**

Create `src/core/doctor-checks.ts`:

```ts
import { readFile, readdir, statfs } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { verifyAudit, withAuditLock } from "./audit.js";
import { checkChannel } from "./channel-commands.js";
import { listChannels } from "./channels.js";
import { CONNECTOR_SECRETS } from "./connectors.js";
import { SOURCES_DIR, loadSource, readConfig } from "./data-source.js";
import { gatewayStatus } from "./gateway-process.js";
import { proposeHardening } from "./hardening.js";
import { ToolRefusal } from "./approvals.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { RUNNER_ALIVE_MS } from "./lifecycle.js";
import { MODEL_SECRET_ID, loadModelConfig } from "./model.js";
import { loadPause } from "./pause.js";
import { pruneOld } from "./retention.js";
import { REPORT_RUNS, clearClaim, listRuns, orphanClaims, type RunRecord } from "./runs.js";
import { SKILLSWIKI_SECRET_ID, activeComboSlug, skillswikiTarget } from "./skillswiki.js";
import { StateCorruptError, isInstallState, statePath } from "./state.js";
import { HEARTBEAT_FILE } from "./tick.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * The checks of `installer doctor` (spec §16.1, D103). Each looks at one part of the install and says `ok`, `warn`
 * (it works, but something needs a look), `fail` (something is broken) or `fixed` (doctor repaired it itself: only
 * run claims a crash left behind, and data past the retention period). Every finding names what to do next.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "fixed";

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export interface DoctorContext {
  readonly home: string;
  readonly state: InstallState | null;
  /** Why the install state could not be read, when it could not. */
  readonly stateError?: string;
  readonly now: string;
  readonly env: Env;
  readonly freeBytes: (path: string) => Promise<number>;
}

export interface DoctorCheckDef {
  readonly id: string;
  readonly run: (ctx: DoctorContext) => Promise<DoctorCheck | readonly DoctorCheck[] | null>;
}

/** A claim younger than this may still be getting its run.json (claimRun writes the key, then the run). */
export const CLAIM_GRACE_MS = 5 * 60 * 1000;
export const MIN_FREE_BYTES = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_FIX = "Run 'installer schedule install' and ask the person to run the commands it prints (on a team host: 'installer host service install')";

const ok = (id: string, detail: string): DoctorCheck => ({ id, status: "ok", detail });
/** A failure the person can act on, as opposed to a bug: it becomes a finding, never a crash. */
export const isDomainError = (error: unknown): error is Error =>
  error instanceof InputError || error instanceof ActionFailure || error instanceof ToolRefusal || error instanceof StateCorruptError;
const label = (record: RunRecord): string => `${record.workflow} ${record.run_id}`;

export const defaultFreeBytes = async (path: string): Promise<number> => {
  const info = await statfs(path);
  return info.bavail * info.bsize;
};

async function backupProblem(home: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(`${statePath(home)}.bak`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return isInstallState(JSON.parse(text)) ? null : "the state backup has an unexpected shape";
  } catch {
    return "the state backup is not valid JSON";
  }
}

async function stateCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  if (ctx.stateError) return { id: "state", status: "fail", detail: ctx.stateError, fix: "Keep a copy of both files, copy state/install-state.json.bak over state/install-state.json, then run 'installer doctor' again" };
  const backup = await backupProblem(ctx.home);
  return backup === null ? ok("state", "the install state and its backup are readable") : { id: "state", status: "warn", detail: backup, fix: "The next change of the install writes a fresh backup" };
}

async function auditCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const result = await withAuditLock(ctx.home, () => verifyAudit(ctx.home, ctx.state?.audit_head));
  if (result.ok) return ok("audit", `${result.lines} lines, hash chain intact`);
  return { id: "audit", status: "fail", detail: `audit/audit.jsonl, line ${result.line}: ${result.reason}`, fix: "Never edit the audit; restore it from a copy, and send 'installer support bundle' to the person who set this up" };
}

async function pauseCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const pause = await loadPause(ctx.home);
  if (!pause?.paused) return ok("pause", "running (not paused)");
  return { id: "pause", status: "warn", detail: `paused since ${pause.at} by ${pause.by}${pause.reason ? ` (${pause.reason})` : ""}: nothing is sent and no run starts`, fix: "A person runs 'installer unpause' in their own terminal, or the decision maker sends /unpause" };
}

/** The keychain items this install uses: Skills Wiki, each channel, each connected source's sign-in, the direct model. */
async function expectedSecrets(ctx: DoctorContext): Promise<string[]> {
  let names: string[] = [];
  try {
    names = (await readdir(await confinedPath(ctx.home, SOURCES_DIR))).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sources = await Promise.all(names.map((name) => loadSource(ctx.home, name.slice(0, -".json".length))));
  return [...new Set([
    ...(ctx.state?.skillswiki ? [SKILLSWIKI_SECRET_ID] : []),
    ...(await listChannels(ctx.home)).map((config) => config.channel),
    ...sources.flatMap((source) => (source ? [CONNECTOR_SECRETS[source.connector.id] ?? source.connector.id] : [])),
    ...((await loadModelConfig(ctx.home)) ? [MODEL_SECRET_ID] : []),
  ])];
}

async function secretsCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const ids = await expectedSecrets(ctx);
  const missing: string[] = [];
  for (const id of ids) if ((await getSecret(id, ctx.env)) === null) missing.push(id);
  if (missing.length === 0) return ok("secrets", ids.length === 0 ? "this install stores no keychain items" : `keychain items present: ${ids.join(", ")}`);
  return { id: "secrets", status: "fail", detail: `missing from the keychain: ${missing.join(", ")}`, fix: missing.map((id) => `installer secret ${id}`).join("; ") };
}

async function skillswikiCheck(ctx: DoctorContext): Promise<DoctorCheck | null> {
  if (!ctx.state?.skillswiki) return null;
  const slug = await activeComboSlug(await skillswikiTarget(ctx.state.skillswiki.url, ctx.env));
  if (slug) return ok("skillswiki", `reachable; combo '${slug}' is active`);
  return { id: "skillswiki", status: "warn", detail: "reachable, but no combo is active", fix: "Activate the combo in the Skills Wiki dashboard" };
}

async function channelsCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const config of await listChannels(ctx.home)) {
    try {
      checks.push(ok(`channel.${config.channel}`, await checkChannel(config, ctx.env)));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      checks.push({ id: `channel.${config.channel}`, status: "fail", detail: error.message, fix: `Check the ${config.channel} secret ('installer secret ${config.channel}') and the provider, then 'installer channel ${config.channel}'` });
    }
  }
  return checks;
}

async function runnerCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const beat = (await readConfig(ctx.home, HEARTBEAT_FILE)) as { last?: string; alive?: string } | null;
  const alive = beat?.alive ?? beat?.last;
  if (!alive) return { id: "runner", status: "warn", detail: "the runner has never ticked: nothing scheduled runs", fix: SCHEDULE_FIX };
  const minutes = Math.round((Date.parse(ctx.now) - Date.parse(alive)) / 60_000);
  if (Date.parse(ctx.now) - Date.parse(alive) <= RUNNER_ALIVE_MS) return ok("runner", `ticking (last tick ${alive})`);
  return { id: "runner", status: "warn", detail: `no tick for ${minutes} minutes (last ${alive})`, fix: SCHEDULE_FIX };
}

async function gatewayCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const status = await gatewayStatus(ctx.home);
  if (status.status === "running") return ok("gateway", `running (pid ${String(status.pid)})`);
  const channels = (await listChannels(ctx.home)).length;
  if (status.status === "stale") return { id: "gateway", status: "fail", detail: String(status.note), fix: "installer gateway start (on a team host: 'installer host service install' starts it at boot)" };
  return channels === 0 ? ok("gateway", "no channel is set up, so no gateway is needed") : { id: "gateway", status: "warn", detail: "stopped: messages are not received and approvals are not announced", fix: "installer gateway start" };
}

async function diskCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const free = await ctx.freeBytes(ctx.home);
  const gib = (free / 1024 ** 3).toFixed(1);
  if (free >= MIN_FREE_BYTES) return ok("disk", `${gib} GiB free`);
  return { id: "disk", status: "warn", detail: `only ${gib} GiB free on the engine's disk`, fix: "Free some space, or shorten the retention period in a person's terminal ('installer retention --value <days>')" };
}

/** D103: a key claimed by a process that died before writing its run.json blocks that key for ever; doctor clears it. */
async function claimsCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const claims = await orphanClaims(ctx.home, ctx.now);
  const stale = claims.filter((claim) => claim.age_ms >= CLAIM_GRACE_MS);
  for (const claim of stale) await clearClaim(ctx.home, claim, ctx.now);
  if (stale.length > 0) return { id: "run_claims", status: "fixed", detail: `cleared ${stale.length} run claim(s) a crash left without their run: ${stale.map((claim) => claim.workflow ?? claim.file).join(", ")}` };
  return ok("run_claims", claims.length > 0 ? `${claims.length} run claim(s) being written right now` : "every run claim has its run");
}

async function runsCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const damaged: string[] = [];
  const runs = await listRuns(ctx.home, undefined, async (_error, workflow, runId) => void damaged.push(`runs/${workflow}/${runId}`));
  const since = new Date(Date.parse(ctx.now) - DAY_MS).toISOString();
  const recent = runs.filter((run) => (run.finished_at ?? run.started_at) > since);
  const problems = [
    ...recent.filter((run) => run.status === "failed" || run.status === "missed").map((run) => `${label(run)} ${run.status}`),
    ...recent.filter((run) => run.workflow === REPORT_RUNS && run.status === "completed" && run.reason).map((run) => `report ${run.run_id}: ${run.reason ?? ""}`),
  ];
  return [
    damaged.length === 0 ? ok("run_records", `${runs.length} run records readable`) : { id: "run_records", status: "warn", detail: `damaged, skipped by the tick: ${damaged.join(", ")}`, fix: "Restore each file from a copy, or remove that run's folder (the run is then forgotten)" },
    problems.length === 0 ? ok("recent_runs", `${recent.length} runs in the last 24 hours, none failed or missed`) : { id: "recent_runs", status: "warn", detail: `in the last 24 hours: ${problems.join("; ")}`, fix: "See 'installer schedule list' and the run folders; 'installer run <workflow>' runs one again" },
  ];
}

async function retentionCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const pruned = await pruneOld(ctx.home, ctx.now);
  const total = Object.values(pruned).reduce((sum, count) => sum + count, 0);
  if (total === 0) return ok("retention", "nothing older than the retention period");
  return { id: "retention", status: "fixed", detail: `deleted past the retention period: ${Object.entries(pruned).filter(([, count]) => count > 0).map(([what, count]) => `${count} ${what}`).join(", ")} (the audit is kept)` };
}

async function hardeningCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const ready: string[] = [];
  for (const id of await workflowIds(ctx.home)) {
    try {
      if (!("reason" in (await proposeHardening(ctx.home, await loadWorkflow(ctx.home, id, DEFAULT_TOOLS))))) ready.push(id);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return ok("hardening", ready.length === 0 ? "no hardening proposal is ready" : `hardening proposals ready: ${ready.join(", ")} ('installer harden <workflow>' shows each)`);
}

export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
  { id: "state", run: stateCheck },
  { id: "audit", run: auditCheck },
  { id: "pause", run: pauseCheck },
  { id: "secrets", run: secretsCheck },
  { id: "skillswiki", run: skillswikiCheck },
  { id: "channels", run: channelsCheck },
  { id: "runner", run: runnerCheck },
  { id: "gateway", run: gatewayCheck },
  { id: "disk", run: diskCheck },
  { id: "run_claims", run: claimsCheck },
  { id: "runs", run: runsCheck },
  { id: "retention", run: retentionCheck },
  { id: "hardening", run: hardeningCheck },
];
```

- [ ] **Step 7: The doctor, its file and its daily run**

Create `src/core/doctor.ts`:

```ts
import { join } from "node:path";
import { AuditCorruptError, appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { DOCTOR_CHECKS, defaultFreeBytes, isDomainError, type DoctorCheck, type DoctorCheckDef, type DoctorContext } from "./doctor-checks.js";
import { InputError } from "./inputs.js";
import { SolutionError } from "./solution.js";
import { StateCorruptError, loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { MAX_TEXT, invokeTool, toolContext } from "./tools.js";
import type { InstallState } from "./types.js";

/**
 * `installer doctor` (spec §16.1, D103): every check of `doctor-checks.ts`, one after the other; a check that cannot
 * finish becomes a `fail` finding, never a crash, so a damaged state or audit is reported instead of stopping it.
 * The result is kept in `state/doctor/last.json` (the report shows it) and audited. The tick runs it once a day
 * (the first tick only sets the time, like the event cursor) and tells the decision maker when something failed.
 */
export const DOCTOR_DIR = join("state", "doctor");
export const DOCTOR_FILE = join(DOCTOR_DIR, "last.json");
export const DOCTOR_NEXT = join(DOCTOR_DIR, "next.json");
export const DOCTOR_EVERY_MS = 24 * 60 * 60 * 1000;

type Env = Readonly<Record<string, string | undefined>>;

export interface DoctorReport {
  readonly status: "ok" | "warn" | "fail";
  readonly checked_at: string;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly now: () => string;
  readonly env?: Env;
  readonly freeBytes?: (path: string) => Promise<number>;
}

async function contextOf(home: string, options: DoctorOptions): Promise<DoctorContext> {
  const base = { home, now: options.now(), env: options.env ?? process.env, freeBytes: options.freeBytes ?? defaultFreeBytes };
  let state: InstallState | null;
  try {
    state = await loadState(home);
  } catch (error) {
    if (!(error instanceof StateCorruptError)) throw error;
    return { ...base, state: null, stateError: error.message };
  }
  if (!state) throw new InputError("No install found in this home; run 'installer start --solution <ref>' first");
  return { ...base, state };
}

async function runOne(check: DoctorCheckDef, ctx: DoctorContext): Promise<DoctorCheck[]> {
  try {
    const found = await check.run(ctx);
    return found === null ? [] : Array.isArray(found) ? [...found] : [found as DoctorCheck];
  } catch (error) {
    if (!isDomainError(error) && !(error instanceof AuditCorruptError) && !(error instanceof SolutionError)) throw error;
    return [{ id: check.id, status: "fail", detail: error.message }];
  }
}

const overall = (checks: readonly DoctorCheck[]): DoctorReport["status"] =>
  checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok";

export async function runDoctor(home: string, options: DoctorOptions, checks: readonly DoctorCheckDef[] = DOCTOR_CHECKS): Promise<DoctorReport> {
  const ctx = await contextOf(home, options);
  const found: DoctorCheck[] = [];
  for (const check of checks) found.push(...(await runOne(check, ctx)));
  const report: DoctorReport = { status: overall(found), checked_at: ctx.now, checks: found };
  await writeConfig(home, DOCTOR_FILE, report);
  // A damaged audit gets no new line; the finding itself says what to do.
  if (!found.some((check) => check.id === "audit" && check.status === "fail")) {
    const counts = Object.fromEntries((["ok", "warn", "fail", "fixed"] as const).map((status) => [status, found.filter((check) => check.status === status).length]));
    await appendAudit(home, { ts: ctx.now, actor: "engine", event: "doctor.ran", ref: DOCTOR_FILE, payload: { status: report.status, ...counts } });
  }
  return report;
}

export const loadDoctorReport = async (home: string): Promise<DoctorReport | null> => (await readConfig(home, DOCTOR_FILE)) as DoctorReport | null;

/** The daily findings that failed, to the decision maker (L1, R6 and the kill switch apply); a message that cannot go out is audited. */
async function tellFailures(home: string, now: () => string, report: DoctorReport): Promise<void> {
  const failed = report.checks.filter((check) => check.status === "fail");
  const text = `Daily check: ${failed.length} problem(s). ${failed.map((check) => `${check.id}: ${check.detail}${check.fix ? ` (fix: ${check.fix})` : ""}`).join(" | ")} Run 'installer doctor' for the whole list.`.slice(0, MAX_TEXT);
  const name = (await loadState(home))?.roles?.decision_maker;
  let error: string | null = name ? null : "no decision maker is set (MODE phase)";
  if (name) {
    try {
      await invokeTool(await toolContext(home, "runner", DEFAULT_TOOLS, now), "channel.notify", { member: name, text });
    } catch (failure) {
      if (!isDomainError(failure)) throw failure;
      error = failure.message;
    }
  }
  await appendAudit(home, { ts: now(), actor: "engine", event: "doctor.notified", ref: DOCTOR_FILE, payload: { failed: failed.map((check) => check.id), delivered: error === null, ...(error ? { error } : {}) } });
}

/** Run by the tick: once every DOCTOR_EVERY_MS; the first call only sets the time. Returns the report when it ran. */
export async function dailyDoctor(home: string, now: () => string, env?: Env): Promise<DoctorReport | null> {
  const at = now();
  const next = ((await readConfig(home, DOCTOR_NEXT)) as { at?: string } | null)?.at;
  if (next !== undefined && at < next) return null;
  await writeConfig(home, DOCTOR_NEXT, { at: new Date(Date.parse(at) + DOCTOR_EVERY_MS).toISOString() });
  if (next === undefined) return null;
  const report = await runDoctor(home, { now, ...(env ? { env } : {}) });
  if (report.status === "fail") await tellFailures(home, now, report);
  return report;
}

/** `installer doctor`: runs every check now and prints the findings. */
export const doctorCommand = (home: string, now: () => string): Promise<DoctorReport> => runDoctor(home, { now });
```

In `src/core/tick.ts`, add after:

```ts
import { dueReports } from "./daily-report.js";
```

this:

```ts
import { dailyDoctor } from "./doctor.js";
```

In `src/core/tick.ts`, add after:

```ts
  readonly learnings: number;
```

this:

```ts
  /** The daily doctor's overall status when it ran in this tick (D103). */
  readonly doctor: "ok" | "warn" | "fail" | null;
```

In `src/core/tick.ts`, replace:

```ts
  const result: Tally = { status: "ran", started: [], missed: [], resumed: [], events: 0, back_online: false, alerts: 0, reminded: [], rate_limited: 0, learnings: 0, errors: [] };
```

with:

```ts
  const result: Tally = { status: "ran", started: [], missed: [], resumed: [], events: 0, back_online: false, alerts: 0, reminded: [], rate_limited: 0, learnings: 0, doctor: null, errors: [] };
```

In `src/core/tick.ts`, add after:

```ts
      result.learnings = (await submitLearnings(home, (await loadState(home))?.skillswiki?.url, state.at)).length;
    });
```

this:

```ts
    await guard(state, "doctor", async () => {
      result.doctor = (await dailyDoctor(home, now, env))?.status ?? null;
    });
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npx vitest run tests/unit/doctor.test.ts tests/e2e/gateway-cli.test.ts tests/unit/tick.test.ts`
Expected: PASS, 27 tests (8 new, the 4 gateway CLI tests with 1 new, and the 15 tick tests, unchanged).

- [ ] **Step 9: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 86 files, 1205 tests pass. Afterwards `pgrep -f gateway-serve` finds no gateway left by the tests.

- [ ] **Step 10: Commit**

```bash
git add src/core/doctor-checks.ts src/core/doctor.ts src/core/audit.ts src/core/runs.ts src/core/gateway-process.ts src/core/channel-commands.ts src/core/tick.ts tests/unit/doctor.test.ts tests/e2e/gateway-cli.test.ts
git commit -m "feat(core): add doctor and clear orphan run claims"
```

---

### Task 4: Host readiness, boot services and the dedicated user (§5.1, D42, D43, D50, D104, D105)

**Files:**
- Create: `src/core/host-service.ts`, `src/core/host.ts`, `tests/unit/host.test.ts`
- Modify: `src/core/scheduler.ts`, `src/core/doctor-checks.ts`, `src/core/doctor.ts`, `vitest.config.ts`, `tests/unit/doctor.test.ts`

**Interfaces:**
- Consumes: `runProcess` (`headless.ts`), `cronTimes`, `wallClock`, `MINUTE_MS` (`cron.ts`), `loadReportConfig`, `reportSlots` (`daily-report.ts`), `TICK_LOG`, `shellQuote`, `installerCliPath`, `loadWorkflow`, `workflowIds`, `DoctorContext` (Task 3).
- Produces: `HOST_CHECKS_ENV`, `READINESS_FILE`, `CommandRunner = (argv) => Promise<{code, stdout}>`, `HostProbe` (`{platform, run, exists}`), `ReadinessStatus` (`ok | fix | manual | advice | unknown`), `ReadinessCheck`, `Readiness` (`{mode, applies, score, checked_at, checks, dedicated_user?, note?}`), `systemProbe(env)`, `hostReadiness(home, state, probe, now)`, `saveReadiness(home, readiness)`, `hostCommand(home, sub, extra, now, options)` (`host.ts`); `SERVICE_DIR`, `ENGINE_USER`, `ServiceFile`, `ServicePlan`, `ServiceOptions`, `servicePlan(home, options)`, `serviceTargets(home, platform)`, `serviceCommand(home, sub, options, now)`, `dedicatedUserSteps(platform)`, `quietWindow(home, now)` (`host-service.ts`); `xml` exported (`scheduler.ts`); `DoctorContext.host`, `DoctorOptions.host`, the doctor check `host`.

- [ ] **Step 1: Write the failing tests**

A fake OS answers by command line and records what it was asked: the tests pin the score, each printed fix, that only reading commands are run, Personal mode's information-only answer, what cannot be read, the quiet window, the boot service files and their commands, and the doctor's `host` finding. The doctor's healthy-home test now also lists `host`.

Create `tests/unit/host.test.ts`:

```ts
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_CONFIG } from "../../src/core/daily-report.js";
import { writeConfig } from "../../src/core/data-source.js";
import { runDoctor } from "../../src/core/doctor.js";
import { ENGINE_USER, SERVICE_DIR, dedicatedUserSteps, quietWindow, serviceCommand } from "../../src/core/host-service.js";
import { READINESS_FILE, hostCommand, hostReadiness, type HostProbe } from "../../src/core/host.js";
import { loadState, saveState } from "../../src/core/state.js";
import type { InstallState, Mode } from "../../src/core/types.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const SERVICE = { node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js", user: ENGINE_USER };

/** A fake OS: answers by the command line; records every command it was asked to run. */
function fakeHost(platform: NodeJS.Platform, answers: Record<string, string | null>, installed = false): HostProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform, calls,
    run: async (argv) => {
      calls.push(argv.join(" "));
      const stdout = answers[argv.join(" ")];
      return stdout === null || stdout === undefined ? { code: null, stdout: "" } : { code: 0, stdout };
    },
    exists: async () => installed,
  };
}

const MAC_READY = { "pmset -g": "System-wide power settings:\n displaysleep         10\n sleep                0\n autorestart          1\n", "systemsetup -getusingnetworktime": "Network Time: On\n", "fdesetup status": "FileVault is On.\n" };
const MAC_ASLEEP = { "pmset -g": " disksleep 10\n sleep 10 (sleep prevented by coreaudiod)\n autorestart 0\n", "systemsetup -getusingnetworktime": "Network Time: On\n", "fdesetup status": "FileVault is Off.\n" };

async function homeWith(mode: Mode): Promise<{ home: string; state: InstallState }> {
  const home = await runnerHome();
  const state = { ...((await loadState(home)) as InstallState), mode };
  await saveState(home, state);
  return { home, state };
}

const statuses = (readiness: { checks: readonly { id: string; status: string }[] }) => Object.fromEntries(readiness.checks.map((entry) => [entry.id, entry.status]));

describe("host readiness, Layer 1 (§5.1, D42, D104)", () => {
  it("scores a ready macOS team host 5/5 and prints the dedicated-user steps", async () => {
    const { home, state } = await homeWith("team_host");
    const readiness = await hostReadiness(home, state, fakeHost("darwin", MAC_READY, true), AT);
    expect(readiness).toMatchObject({ applies: true, score: "5/5", mode: "team_host" });
    expect(statuses(readiness)).toEqual({ no_sleep: "ok", power_on: "ok", boot_service: "ok", time_sync: "ok", disk_encryption: "ok", updates: "advice", power_network: "advice" });
    expect(readiness.dedicated_user?.join(" ")).toContain(ENGINE_USER);
  });

  it("prints the fixes for a Mac that sleeps, stays off after a power cut and has no FileVault, and only reads settings", async () => {
    const { home, state } = await homeWith("team_host");
    const probe = fakeHost("darwin", MAC_ASLEEP);
    const readiness = await hostReadiness(home, state, probe, AT);
    expect(readiness.score).toBe("1/5");
    const fixes = Object.fromEntries(readiness.checks.map((entry) => [entry.id, entry.fix]));
    expect(fixes.no_sleep).toEqual(["sudo pmset -a sleep 0"]);
    expect(fixes.power_on).toEqual(["sudo pmset -a autorestart 1"]);
    expect(fixes.boot_service).toEqual(["installer host service install", "then run the sudo commands it prints, in your own terminal"]);
    expect(fixes.disk_encryption?.[0]).toContain("the engine never stores it (D43)");
    expect(probe.calls).toEqual(["pmset -g", "systemsetup -getusingnetworktime", "fdesetup status"]);
  });

  it("reads a Linux host with systemctl, timedatectl and lsblk; the firmware power setting is the person's to check", async () => {
    const { home, state } = await homeWith("hybrid");
    const probe = fakeHost("linux", { "systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target": "masked\nmasked\nmasked\nmasked\n", "timedatectl show -p NTPSynchronized --value": "yes\n", "lsblk -rno TYPE": "disk\npart\ncrypt\n" });
    const readiness = await hostReadiness(home, state, probe, AT);
    expect(readiness.score).toBe("3/4");
    expect(statuses(readiness)).toMatchObject({ no_sleep: "ok", power_on: "manual", boot_service: "fix", time_sync: "ok", disk_encryption: "ok" });
  });

  it("only informs on a Personal-mode laptop: no fixes, and says why scheduled jobs may be skipped", async () => {
    const { home, state } = await homeWith("personal");
    const readiness = await hostReadiness(home, state, fakeHost("darwin", MAC_ASLEEP), AT);
    expect(readiness).toMatchObject({ applies: false, note: expect.stringContaining("skipped while this computer sleeps") });
    expect(readiness.checks.some((entry) => entry.fix !== undefined)).toBe(false);
    expect(readiness.dedicated_user).toBeUndefined();
  });

  it("does not score what it cannot read", async () => {
    const { home, state } = await homeWith("team_host");
    const readiness = await hostReadiness(home, state, fakeHost("darwin", { "pmset -g": null, "systemsetup -getusingnetworktime": "You need administrator access to run this tool... exiting!\n", "fdesetup status": null }), AT);
    expect(statuses(readiness)).toMatchObject({ no_sleep: "unknown", power_on: "unknown", time_sync: "unknown", disk_encryption: "unknown", boot_service: "fix" });
    expect(readiness.score).toBe("0/1");
  });

  it("finds the quiet window: the longest gap in a day between scheduled runs and reports", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, { workflow: "early", version: 1, trigger: { cron: "0 8 * * *", tz: "UTC" }, steps: [{ id: "note", tool: "memo.add", args: { text: "x" } }] });
    await writeConfig(home, REPORT_CONFIG, { recipients: [{ member: "Owner", tz: "UTC" }], times: ["09:00", "17:00"] });
    expect(await quietWindow(home, AT)).toEqual({ from: "2026-10-08T17:00:00.000Z", to: "2026-10-09T08:00:00.000Z", hours: 15 });
    expect(await quietWindow(await runnerHome(), AT)).toBeNull();
  });

  it("writes the boot service files under the home and prints the sudo commands for the person", async () => {
    const home = await runnerHome();
    const mac = await serviceCommand(home, "install", { ...SERVICE, platform: "darwin" }, () => AT);
    const [gateway = "", tick = ""] = mac.files as string[];
    expect(gateway.startsWith(join(home, SERVICE_DIR))).toBe(true);
    const plist = await readFile(gateway, "utf8");
    expect(plist).toContain(`<key>UserName</key>\n  <string>${ENGINE_USER}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>gateway-serve</string>");
    expect(await readFile(tick, "utf8")).toContain("<key>StartInterval</key>\n  <integer>60</integer>");
    expect(mac.commands).toContainEqual(expect.stringMatching(/^sudo launchctl bootstrap system \/Library\/LaunchDaemons\/com\.installer\.gateway\.[0-9a-f]{8}\.plist$/));
    const linux = await serviceCommand(home, "install", { ...SERVICE, platform: "linux" }, () => AT);
    const unit = await readFile((linux.files as string[])[0] ?? "", "utf8");
    expect(unit).toContain(`User=${ENGINE_USER}\nExecStart="/usr/local/bin/node" "/opt/installer/dist/cli.js" "--home" "${home}" "gateway-serve"\nRestart=always`);
    expect(linux.commands).toContainEqual(expect.stringMatching(/^sudo systemctl enable --now installer-gateway-[0-9a-f]{8}\.service$/));
    const removed = await serviceCommand(home, "remove", { ...SERVICE, platform: "darwin" }, () => AT);
    expect(removed.commands).toContainEqual(expect.stringMatching(/^sudo launchctl bootout system\/com\.installer\.gateway\./));
    await expect(access(gateway)).rejects.toThrow();
    await expect(serviceCommand(join(home, "100%"), "install", { ...SERVICE, platform: "linux" }, () => AT)).rejects.toThrow("contains % or a line break");
  });

  it("puts the readiness score into doctor and the report's file; skips it where host checks are off", async () => {
    const { home } = await homeWith("team_host");
    const report = await runDoctor(home, { now: () => AT, freeBytes: async () => 50 * 1024 ** 3, host: fakeHost("darwin", MAC_ASLEEP) });
    expect(report.checks.find((entry) => entry.id === "host")).toMatchObject({ status: "warn", detail: "readiness 1/5; not right yet: no_sleep, power_on, boot_service, disk_encryption" });
    expect(JSON.parse(await readFile(join(home, READINESS_FILE), "utf8"))).toMatchObject({ score: "1/5", applies: true });
    expect((await runDoctor(home, { now: () => AT })).checks.find((entry) => entry.id === "host")).toMatchObject({ status: "ok", detail: expect.stringContaining("INSTALLER_HOST_CHECKS=none") });
    expect(await hostCommand(home, undefined, undefined, () => AT)).toMatchObject({ status: "skipped" });
    expect(dedicatedUserSteps("linux")[0]).toContain(`sudo useradd --create-home --shell /bin/bash ${ENGINE_USER}`);
  });
});
```

In `tests/unit/doctor.test.ts`, replace:

```ts
    expect(report.checks.map((check) => check.id)).toEqual(["state", "audit", "pause", "secrets", "runner", "gateway", "disk", "run_claims", "run_records", "recent_runs", "retention", "hardening"]);
```

with:

```ts
    expect(report.checks.map((check) => check.id)).toEqual(["state", "audit", "pause", "secrets", "runner", "gateway", "disk", "host", "run_claims", "run_records", "recent_runs", "retention", "hardening"]);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/host.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/host-service.js'`; no test runs.

- [ ] **Step 3: No real OS command in the test suite**

In `vitest.config.ts`, add after:

```ts
      INSTALLER_BROWSER: "none",
```

this:

```ts
      // Host readiness never reads the real OS settings in a test run (D104); tests pass a fake CommandRunner.
      INSTALLER_HOST_CHECKS: "none",
```

- [ ] **Step 4: Boot services, the dedicated user and the quiet window**

The LaunchDaemons reuse the scheduler's XML escaping, so it is exported. Every command is printed; nothing outside the home is written.

In `src/core/scheduler.ts`, replace:

```ts
const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
```

with:

```ts
export const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
```

Create `src/core/host-service.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { MINUTE_MS, cronTimes } from "./cron.js";
import { loadReportConfig, reportSlots } from "./daily-report.js";
import { InputError } from "./inputs.js";
import { installerCliPath, shellQuote } from "./register.js";
import { TICK_LOG, xml } from "./scheduler.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * The host side of Layer 1 (spec §5.1, D42, D43, D104): boot services, the quiet window and the dedicated OS user.
 * `installer host service install` writes a LaunchDaemon (macOS: the gateway with KeepAlive, and the tick every
 * minute) or a systemd unit (Linux: the gateway with Restart=always; the tick stays the engine user's crontab, which
 * cron runs from boot) under `runtime/service/`, and prints the `sudo` commands a person runs in their own terminal.
 * The installer never runs them and never changes the OS itself; it never creates users either.
 */
export const SERVICE_DIR = join("runtime", "service");
export const ENGINE_USER = "installer-engine";
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface ServiceFile {
  readonly name: string;
  readonly system_path: string;
  readonly text: string;
}

export interface ServicePlan {
  readonly files: readonly ServiceFile[];
  readonly install: readonly string[];
  readonly remove: readonly string[];
}

export interface ServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly node?: string;
  readonly cli?: string;
  readonly user?: string;
}

const tag = (home: string): string => createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8);

function daemonPlist(label: string, argv: readonly string[], user: string, log: string, everyMinute: boolean): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>\n  <string>${xml(label)}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${argv.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}\n  </array>`,
    `  <key>UserName</key>\n  <string>${xml(user)}</string>`,
    "  <key>RunAtLoad</key>\n  <true/>",
    everyMinute ? "  <key>StartInterval</key>\n  <integer>60</integer>" : "  <key>KeepAlive</key>\n  <true/>",
    `  <key>StandardOutPath</key>\n  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** systemd unit arguments in double quotes; `%` (specifiers) and line breaks are refused, like the crontab line (D82). */
function unitArg(text: string): string {
  if (/[%\n\r]/.test(text)) throw new InputError(`A systemd unit cannot hold '${text}' (it contains % or a line break): use a home path without them`);
  return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

function gatewayUnit(argv: readonly string[], user: string, home: string): string {
  return [
    "[Unit]", `Description=installer gateway for ${resolve(home).replace(/[%\n\r]/g, "")}`, "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", `User=${user}`, `ExecStart=${argv.map(unitArg).join(" ")}`, "Restart=always", "RestartSec=5", "",
    "[Install]", "WantedBy=multi-user.target", "",
  ].join("\n");
}

function macPlan(home: string, base: readonly string[], user: string): ServicePlan {
  const absolute = resolve(home);
  const files = [
    { label: `com.installer.gateway.${tag(home)}`, argv: [...base, "gateway-serve"], log: join(absolute, SERVICE_DIR, "gateway.out.log"), everyMinute: false },
    { label: `com.installer.tickd.${tag(home)}`, argv: [...base, "tick"], log: join(absolute, TICK_LOG), everyMinute: true },
  ].map(({ label, argv, log, everyMinute }) => ({ name: `${label}.plist`, system_path: `/Library/LaunchDaemons/${label}.plist`, text: daemonPlist(label, argv, user, log, everyMinute), label }));
  return {
    files,
    install: files.flatMap((file) => [`sudo cp ${shellQuote(join(absolute, SERVICE_DIR, file.name))} ${file.system_path}`, `sudo chown root:wheel ${file.system_path}`, `sudo chmod 644 ${file.system_path}`, `sudo launchctl bootstrap system ${file.system_path}`]),
    remove: files.flatMap((file) => [`sudo launchctl bootout system/${file.label}`, `sudo rm ${file.system_path}`]),
  };
}

function linuxPlan(home: string, base: readonly string[], user: string): ServicePlan {
  const name = `installer-gateway-${tag(home)}.service`;
  const file = { name, system_path: `/etc/systemd/system/${name}`, text: gatewayUnit([...base, "gateway-serve"], user, home) };
  return {
    files: [file],
    install: [`sudo cp ${shellQuote(join(resolve(home), SERVICE_DIR, name))} ${file.system_path}`, "sudo systemctl daemon-reload", `sudo systemctl enable --now ${name}`],
    remove: [`sudo systemctl disable --now ${name}`, `sudo rm ${file.system_path}`, "sudo systemctl daemon-reload"],
  };
}

export function servicePlan(home: string, options: ServiceOptions = {}): ServicePlan {
  const platform = options.platform ?? process.platform;
  const base = [options.node ?? process.execPath, options.cli ?? installerCliPath(), "--home", resolve(home)];
  const user = options.user ?? userInfo().username;
  if (platform === "darwin") return macPlan(home, base, user);
  if (platform === "linux") return linuxPlan(home, base, user);
  throw new InputError(`Boot services on ${platform} are not supported yet`);
}

/** Where the service files live once a person installed them (the readiness check `boot_service` looks there). */
export const serviceTargets = (home: string, platform: NodeJS.Platform): readonly string[] =>
  platform === "darwin" || platform === "linux" ? servicePlan(home, { platform, node: "node", cli: "cli", user: ENGINE_USER }).files.map((file) => file.system_path) : [];

/** `installer host service install | remove`: writes or deletes the files under the home and prints the commands. */
export async function serviceCommand(home: string, sub: string | undefined, options: ServiceOptions, now: () => string): Promise<Record<string, unknown>> {
  if (sub !== "install" && sub !== "remove") throw new InputError("host service takes: install, remove");
  const plan = servicePlan(home, options);
  const paths = [];
  for (const file of plan.files) {
    const path = await confinedPath(home, join(SERVICE_DIR, file.name));
    if (sub === "remove") await rm(path, { force: true });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.text, { encoding: "utf8", mode: 0o600 });
    }
    paths.push(path);
  }
  await appendAudit(home, { ts: now(), actor: "agent", event: `host.service_${sub}_printed`, ref: SERVICE_DIR, payload: { files: plan.files.map((file) => file.name) } });
  const before = sub === "install" ? ["installer gateway stop", "installer schedule remove (and the commands it prints), if the per-user schedule was loaded"] : [];
  return { ...(sub === "install" ? { files: paths } : {}), commands: [...before, ...(sub === "install" ? plan.install : plan.remove)], note: "A person with administrator rights runs these in their own terminal; the installer never runs sudo and never changes the OS itself (D42, D104)." };
}

/** D50, D61, D104: the steps for a dedicated engine user on a team host, printed for the person; the engine creates no user. */
export function dedicatedUserSteps(platform: NodeJS.Platform): string[] {
  const create = platform === "darwin"
    ? `Create a standard (not administrator) user named ${ENGINE_USER}: System Settings → Users & Groups → Add User. Keep its password yourself.`
    : `Create the user: sudo useradd --create-home --shell /bin/bash ${ENGINE_USER} (then sudo passwd ${ENGINE_USER}, a password you keep).`;
  return [
    create,
    `Sign in as ${ENGINE_USER} (${platform === "darwin" ? "fast user switching" : `sudo -iu ${ENGINE_USER}`}) and install Node 22, your agent and the installer there, so the engine home, its keychain items and the agent's MCP servers belong to that user, not to your own account (D50).`,
    `As ${ENGINE_USER}, run the install in its own folder (installer start …), then 'installer host service install' and run the printed sudo commands from your own administrator account.`,
    "Decide approvals from Telegram, where the sender is proven (D78). The agent also runs as this user, so the terminal-only checks are no boundary against it (D61); keep this account for the assistant alone and never give it administrator rights.",
  ];
}

/** The longest gap in the next 24 hours between scheduled runs and twice-daily reports: where OS updates belong (§5.1). */
export async function quietWindow(home: string, now: string): Promise<{ from: string; to: string; hours: number } | null> {
  const until = new Date(Date.parse(now) + DAY_MS).toISOString();
  const times: number[] = [];
  for (const id of await workflowIds(home)) {
    try {
      const { trigger } = await loadWorkflow(home, id, DEFAULT_TOOLS);
      if (trigger.kind === "cron") times.push(...cronTimes(trigger.cron, trigger.tz, now, until).map(Date.parse));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  const report = await loadReportConfig(home);
  if (report) for (const recipient of report.recipients) times.push(...reportSlots(report, recipient, now, until).map(Date.parse));
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const gaps = sorted.map((at, index) => ({ at, next: sorted[index + 1] ?? (sorted[0] ?? at) + DAY_MS }));
  const widest = gaps.reduce((best, gap) => (gap.next - gap.at > best.next - best.at ? gap : best));
  return { from: new Date(widest.at).toISOString(), to: new Date(widest.next).toISOString(), hours: Math.round(((widest.next - widest.at) / 3_600_000) * 10) / 10 };
}
```

- [ ] **Step 5: The readiness checks**

Create `src/core/host.ts`:

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { wallClock } from "./cron.js";
import { writeConfig } from "./data-source.js";
import { runProcess } from "./headless.js";
import { dedicatedUserSteps, quietWindow, serviceCommand, serviceTargets, type ServiceOptions } from "./host-service.js";
import { InputError } from "./inputs.js";
import { loadState } from "./state.js";
import type { InstallState, Mode } from "./types.js";

/**
 * Host readiness, Layer 1 (spec §5.1, D42, D43, D104). On a Team host or the host side of Hybrid, the engine reads
 * the OS settings that keep the assistant running (never sleeps, powers on after a power cut, starts at boot, clock
 * in sync, disk encrypted) and prints the fix for each one that is not right, for a person with administrator rights
 * to run in their own terminal: the engine never runs `sudo` and never changes the OS. On a Personal-mode laptop
 * the result is information only. Every OS command goes through a `CommandRunner`, so tests answer with fakes.
 */
export const HOST_CHECKS_ENV = "INSTALLER_HOST_CHECKS";
export const READINESS_FILE = join("state", "doctor", "host.json");
const COMMAND_TIMEOUT_MS = 10_000;
const SLEEP_TARGETS = ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"];
const PERSONAL_NOTE = "Personal mode: for information only, nothing to change. Scheduled jobs are skipped while this computer sleeps or is off (D38).";

export type CommandRunner = (argv: readonly string[]) => Promise<{ readonly code: number | null; readonly stdout: string }>;

export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly run: CommandRunner;
  readonly exists: (path: string) => Promise<boolean>;
}

export type ReadinessStatus = "ok" | "fix" | "manual" | "advice" | "unknown";

export interface ReadinessCheck {
  readonly id: string;
  readonly title: string;
  readonly status: ReadinessStatus;
  readonly detail: string;
  readonly fix?: readonly string[];
}

export interface Readiness {
  readonly mode: Mode | null;
  readonly applies: boolean;
  /** Checks that are right, of those the engine could read and that a person can change (`ok` or `fix`). */
  readonly score: string;
  readonly checked_at: string;
  readonly checks: readonly ReadinessCheck[];
  readonly dedicated_user?: readonly string[];
  readonly note?: string;
}

/** The real OS, read only; null when `INSTALLER_HOST_CHECKS=none` (the test suite: no real OS command ever runs there). */
export function systemProbe(env: Readonly<Record<string, string | undefined>> = process.env): HostProbe | null {
  if (env[HOST_CHECKS_ENV] === "none") return null;
  return {
    platform: process.platform,
    run: async (argv) => {
      const result = await runProcess(argv, "/", COMMAND_TIMEOUT_MS);
      return { code: result.code, stdout: result.stdout };
    },
    exists: async (path) => access(path).then(() => true, () => false),
  };
}

const check = (id: string, title: string, status: ReadinessStatus, detail: string, fix?: readonly string[]): ReadinessCheck => ({ id, title, status, detail, ...(fix ? { fix } : {}) });

/** One `pmset -g` value against what it should be. */
function pmsetCheck(output: { code: number | null; stdout: string }, name: string, want: string, id: string, title: string): ReadinessCheck {
  const value = output.code === 0 ? new RegExp(`^\\s*${name}\\s+(\\d+)`, "m").exec(output.stdout)?.[1] : undefined;
  if (value === undefined) return check(id, title, "unknown", `pmset ${name} could not be read`);
  return value === want ? check(id, title, "ok", `pmset ${name} is ${value}`) : check(id, title, "fix", `pmset ${name} is ${value}, should be ${want}`, [`sudo pmset -a ${name} ${want}`]);
}

async function bootCheck(probe: HostProbe, home: string): Promise<ReadinessCheck> {
  const missing: string[] = [];
  for (const target of serviceTargets(home, probe.platform)) if (!(await probe.exists(target))) missing.push(target);
  const title = "Starts at boot and restarts after a crash";
  if (missing.length === 0) return check("boot_service", title, "ok", "the boot service is installed");
  return check("boot_service", title, "fix", `not installed: ${missing.join(", ")}`, ["installer host service install", "then run the sudo commands it prints, in your own terminal"]);
}

async function macChecks(probe: HostProbe, home: string): Promise<ReadinessCheck[]> {
  const pmset = await probe.run(["pmset", "-g"]);
  const time = await probe.run(["systemsetup", "-getusingnetworktime"]);
  const vault = await probe.run(["fdesetup", "status"]);
  const clock = "Clock set automatically";
  const timeCheck = /Network Time: On/i.test(time.stdout) ? check("time_sync", clock, "ok", "network time is on")
    : /Network Time: Off/i.test(time.stdout) ? check("time_sync", clock, "fix", "network time is off", ["sudo systemsetup -setusingnetworktime on"])
      : check("time_sync", clock, "unknown", "could not be read without administrator rights: check System Settings → General → Date & Time → Set time and date automatically");
  const disk = "Disk encrypted";
  const vaultCheck = /FileVault is On/i.test(vault.stdout) ? check("disk_encryption", disk, "ok", "FileVault is on")
    : /FileVault is Off/i.test(vault.stdout) ? check("disk_encryption", disk, "fix", "FileVault is off", ["System Settings → Privacy & Security → FileVault → Turn On. Keep the recovery key yourself: the engine never stores it (D43)"])
      : check("disk_encryption", disk, "unknown", "fdesetup status could not be read");
  return [pmsetCheck(pmset, "sleep", "0", "no_sleep", "Never sleeps"), pmsetCheck(pmset, "autorestart", "1", "power_on", "Starts again after a power cut"), await bootCheck(probe, home), timeCheck, vaultCheck];
}

async function linuxChecks(probe: HostProbe, home: string): Promise<ReadinessCheck[]> {
  const sleep = await probe.run(["systemctl", "is-enabled", ...SLEEP_TARGETS]);
  const states = sleep.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const ntp = (await probe.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"])).stdout.trim();
  const blocks = await probe.run(["lsblk", "-rno", "TYPE"]);
  const never = "Never sleeps";
  return [
    states.length === SLEEP_TARGETS.length ? (states.every((state) => state === "masked") ? check("no_sleep", never, "ok", "sleep and suspend are masked") : check("no_sleep", never, "fix", `sleep targets: ${states.join(", ")}`, [`sudo systemctl mask ${SLEEP_TARGETS.join(" ")}`])) : check("no_sleep", never, "unknown", "systemctl could not be read"),
    check("power_on", "Starts again after a power cut", "manual", "a firmware setting the engine cannot read", ["In the firmware (BIOS/UEFI) setup, set 'Restore on AC power loss' (or 'After power failure') to Power On"]),
    await bootCheck(probe, home),
    ntp === "yes" ? check("time_sync", "Clock in sync", "ok", "NTP synchronized") : ntp === "no" ? check("time_sync", "Clock in sync", "fix", "NTP is not synchronized", ["sudo timedatectl set-ntp true"]) : check("time_sync", "Clock in sync", "unknown", "timedatectl could not be read"),
    blocks.code !== 0 ? check("disk_encryption", "Disk encrypted", "unknown", "lsblk could not be read") : blocks.stdout.split("\n").includes("crypt") ? check("disk_encryption", "Disk encrypted", "ok", "an encrypted (LUKS) volume is in use")
      : check("disk_encryption", "Disk encrypted", "fix", "no encrypted volume found", ["Encryption (LUKS) is chosen when the system is installed: move the engine to an encrypted disk. The engine never stores the unlock key (D43)"]),
  ];
}

/** Advice, never scored: updates in the quiet window (§5.1), wired network and a UPS (D43). */
async function adviceChecks(home: string, platform: NodeJS.Platform, now: string): Promise<ReadinessCheck[]> {
  const window = await quietWindow(home, now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const detail = window ? `the longest gap between scheduled runs and reports is ${wallClock(window.from, zone)} to ${wallClock(window.to, zone)} (${zone}, ${window.hours} h)` : "nothing is scheduled yet";
  const updates = platform === "darwin"
    ? ["Install macOS updates by hand in that window, or let them install overnight then", "A restart that needs the disk unlocked: a person runs 'sudo fdesetup authrestart' then and types the password (D43)"]
    : ["Set unattended-upgrades' Automatic-Reboot-Time to the window's start"];
  return [
    check("updates", "OS updates and restarts in the quiet window", "advice", detail, updates),
    check("power_network", "Wired network and a UPS", "advice", "a wired connection and a UPS keep short outages from stopping or restarting the host; a cloud server also works", ["Connect by cable; put the host on a UPS"]),
  ];
}

async function platformChecks(probe: HostProbe, home: string): Promise<ReadinessCheck[]> {
  if (probe.platform === "darwin") return macChecks(probe, home);
  if (probe.platform === "linux") return linuxChecks(probe, home);
  return [check("platform", "Supported host", "unknown", `readiness checks for ${probe.platform} are not written yet`)];
}

export async function hostReadiness(home: string, state: InstallState | null, probe: HostProbe, now: string): Promise<Readiness> {
  const mode = state?.mode ?? null;
  const applies = mode === "team_host" || mode === "hybrid";
  const found = [...(await platformChecks(probe, home)), ...(await adviceChecks(home, probe.platform, now))];
  const scored = found.filter((entry) => entry.status === "ok" || entry.status === "fix");
  const score = `${scored.filter((entry) => entry.status === "ok").length}/${scored.length}`;
  if (!applies) return { mode, applies, score, checked_at: now, checks: found.map(({ fix: _fix, ...rest }) => rest), note: PERSONAL_NOTE };
  return { mode, applies, score, checked_at: now, checks: found, dedicated_user: dedicatedUserSteps(probe.platform) };
}

export const saveReadiness = (home: string, readiness: Readiness): Promise<void> => writeConfig(home, READINESS_FILE, readiness);

/** `installer host [service install | remove]`: the readiness checks with their printed fixes, or the boot service files. */
export async function hostCommand(home: string, sub: string | undefined, extra: string | undefined, now: () => string, options: ServiceOptions & { probe?: HostProbe | null } = {}): Promise<Record<string, unknown>> {
  if (sub === "service") return serviceCommand(home, extra, options, now);
  if (sub !== undefined) throw new InputError("host takes nothing (the readiness checks) or: service install, service remove");
  const probe = options.probe === undefined ? systemProbe() : options.probe;
  if (!probe) return { status: "skipped", note: `Host checks are switched off here (${HOST_CHECKS_ENV}=none)` };
  const readiness = await hostReadiness(home, await loadState(home), probe, now());
  await saveReadiness(home, readiness);
  return { ...readiness, how: "A person with administrator rights runs each fix in their own terminal; the installer only reads settings and never runs sudo (D42, D104)" };
}
```

- [ ] **Step 6: The doctor re-checks the host and keeps the score for the report**

In `src/core/doctor-checks.ts`, add after:

```ts
import { proposeHardening } from "./hardening.js";
```

this:

```ts
import { HOST_CHECKS_ENV, hostReadiness, saveReadiness, type HostProbe } from "./host.js";
```

In `src/core/doctor-checks.ts`, add after:

```ts
  readonly freeBytes: (path: string) => Promise<number>;
```

this:

```ts
  /** Reads the OS settings of host readiness (D104); null where host checks are switched off. */
  readonly host: HostProbe | null;
```

In `src/core/doctor-checks.ts`, replace:

```ts
}

export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
```

with:

```ts
}

/** Layer 1 (D42, D104): re-checked daily; the score goes into the report, the fixes are printed by 'installer host'. */
async function hostCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  if (!ctx.host) return ok("host", `host readiness not checked here (${HOST_CHECKS_ENV}=none)`);
  const readiness = await hostReadiness(ctx.home, ctx.state, ctx.host, ctx.now);
  await saveReadiness(ctx.home, readiness);
  const open = readiness.checks.filter((entry) => entry.status === "fix").map((entry) => entry.id);
  if (!readiness.applies) return ok("host", `readiness ${readiness.score} (Personal mode: for information only)`);
  if (open.length === 0) return ok("host", `readiness ${readiness.score}`);
  return { id: "host", status: "warn", detail: `readiness ${readiness.score}; not right yet: ${open.join(", ")}`, fix: "'installer host' prints each fix; a person with administrator rights runs them in their own terminal" };
}

export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
```

In `src/core/doctor-checks.ts`, add after:

```ts
  { id: "disk", run: diskCheck },
```

this:

```ts
  { id: "host", run: hostCheck },
```

In `src/core/doctor.ts`, add after:

```ts
import { DOCTOR_CHECKS, defaultFreeBytes, isDomainError, type DoctorCheck, type DoctorCheckDef, type DoctorContext } from "./doctor-checks.js";
```

this:

```ts
import { systemProbe, type HostProbe } from "./host.js";
```

In `src/core/doctor.ts`, add after:

```ts
  readonly freeBytes?: (path: string) => Promise<number>;
```

this:

```ts
  /** The OS settings reader for host readiness; by default the real one, unless INSTALLER_HOST_CHECKS=none. */
  readonly host?: HostProbe | null;
```

In `src/core/doctor.ts`, replace:

```ts
  const base = { home, now: options.now(), env: options.env ?? process.env, freeBytes: options.freeBytes ?? defaultFreeBytes };
```

with:

```ts
  const env = options.env ?? process.env;
  const base = { home, now: options.now(), env, freeBytes: options.freeBytes ?? defaultFreeBytes, host: options.host === undefined ? systemProbe(env) : options.host };
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/unit/host.test.ts tests/unit/doctor.test.ts tests/unit/scheduler.test.ts`
Expected: PASS, 24 tests (8 new, the 8 doctor tests and the 8 scheduler tests).

- [ ] **Step 8: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 87 files, 1215 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/host.ts src/core/host-service.ts src/core/scheduler.ts src/core/doctor-checks.ts src/core/doctor.ts vitest.config.ts tests/unit/host.test.ts tests/unit/doctor.test.ts
git commit -m "feat(core): add host readiness and boot services"
```

---

### Task 5: The data-flow summary in the report (§14.6, D106)

**Files:**
- Create: `src/core/data-flow.ts`, `tests/unit/data-flow.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `loadPinnedContract`, `listChannels`, `loadSource`, `SOURCES_DIR`, `loadModelConfig`, `loadDoctorReport` (Task 3), `READINESS_FILE`, `Readiness` (Task 4), `loadPause`, `PauseState` (Task 1), Plan 2's `buildReport` / `renderReport`.
- Produces: `FlowRow` (`{party, via, receives, never?}`), `OperationsView` (`{paused, doctor, readiness, data_flow}`), `fieldsByTag(contract, entities, without?)`, `dataFlow(home, state)`, `operationsView(home, state)`, `renderOperations(view): string[]` (`data-flow.ts`); `installer report --json` gains `operations`, the text report four or more lines.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/data-flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { saveChannel } from "../../src/core/channels.js";
import { dataFlow, fieldsByTag, operationsView, renderOperations } from "../../src/core/data-flow.js";
import { saveSource, writeConfig } from "../../src/core/data-source.js";
import { runDoctor } from "../../src/core/doctor.js";
import { saveReadiness } from "../../src/core/host.js";
import { MODEL_CONFIG } from "../../src/core/model.js";
import { setPaused } from "../../src/core/pause.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadState, saveState } from "../../src/core/state.js";
import type { InstallState } from "../../src/core/types.js";
import { FAKE_RUNTIME, runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
/** A contract with one field of each tag, and one untagged. */
const SOLUTION = {
  id: "fixture-flow", version: "1.0.0",
  data_contract: { entities: { contact: { key: "email", fields: {
    name: { type: "text", tags: ["personal"], required: true }, email: { type: "email", tags: ["personal"] }, notes: { type: "text" },
    balance: { type: "money", tags: ["financial"] }, origin: { type: "text", tags: ["protected_ground"] },
  } } } },
  steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }],
};

async function flowHome(extra: Partial<InstallState> = {}): Promise<{ home: string; state: InstallState }> {
  const home = await runnerHome();
  await writePinnedSolution(home, JSON.stringify(SOLUTION));
  const state = { ...((await loadState(home)) as InstallState), ...extra };
  await saveState(home, state);
  return { home, state };
}

describe("the data-flow summary (§14.6, D106)", () => {
  it("names each outside party and the tagged fields it receives; the model never gets protected_ground fields", async () => {
    const { home, state } = await flowHome({ skillswiki: { url: "https://skills.example/mcp" } });
    await saveSource(home, { entity: "contact", connector: { id: "google-sheets", version: "1", sha256: "pinned" }, spreadsheet_id: "sheet-1" });
    await saveChannel(home, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: AT });
    const rows = await dataFlow(home, state);
    expect(rows.map((row) => row.party)).toEqual(["Model vendor", "google-sheets", "telegram", "Skills Wiki", "Support (only when you send it)"]);
    expect(rows[0]).toMatchObject({ via: "your agent (fake-agent) in headless calls with every tool off", receives: "what judge and agent steps are given: personal: contact.name, contact.email; untagged: contact.notes; financial: contact.balance" });
    expect(rows[0]?.receives).not.toContain("contact.origin");
    expect(rows[1]?.receives).toContain("protected_ground: contact.origin");
    expect(rows[3]).toMatchObject({ never: "business records, secrets, inbound messages, the audit" });
  });

  it("names the direct model when the agent cannot answer headless, and no model when neither is set up", async () => {
    const { home, state } = await flowHome({ runtime: { ...FAKE_RUNTIME, c4_headless: false } });
    expect((await dataFlow(home, state)).map((row) => row.party)).toEqual(["Support (only when you send it)"]);
    await writeConfig(home, MODEL_CONFIG, { provider: "anthropic", model: "a-model", max_tokens: 4096 });
    expect((await dataFlow(home, state))[0]).toMatchObject({ party: "Model vendor", via: "the direct model API (anthropic, a-model) with your own key" });
    expect(fieldsByTag(null, null)).toBe("no record fields");
  });

  it("adds the pause, the last doctor run, the readiness score and the data flow to the report", async () => {
    const { home, state } = await flowHome();
    expect(renderOperations(await operationsView(home, state))).toEqual(expect.arrayContaining(["🩺 Doctor     never run: run 'installer doctor'", "🖥️ Host       not checked yet: run 'installer host'", "🔀 Data flow"]));
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT);
    const doctor = await runDoctor(home, { now: () => AT });
    await saveReadiness(home, { mode: "personal", applies: false, score: "3/5", checked_at: AT, checks: [] });
    const view = await operationsView(home, state);
    expect(view).toMatchObject({ paused: { paused: true }, doctor: { status: doctor.status, checked_at: AT }, readiness: { score: "3/5", applies: false } });
    const lines = renderOperations(view);
    expect(lines[0]).toBe("⏸️ Paused     since 2026-10-08T12:00:00.000Z by agent: nothing is sent, no run starts ('installer unpause' in a person's terminal)");
    expect(lines).toContain("🖥️ Host       readiness 3/5 (Personal mode: for information only)");
    expect(lines.at(-1)).toContain("   Support (only when you send it) — 'installer support bundle'");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/data-flow.js'`; no test runs.

- [ ] **Step 3: The summary and the operations view**

`buildReport` stays pure and synchronous, because R6's `outboundBlock` depends on it; the operations view is read beside it.

Create `src/core/data-flow.ts`:

```ts
import { readdir } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { listChannels } from "./channels.js";
import type { DataContract } from "./contract.js";
import { SOURCES_DIR, loadSource, readConfig } from "./data-source.js";
import { loadDoctorReport } from "./doctor.js";
import { READINESS_FILE, type Readiness } from "./host.js";
import type { FieldTag } from "./levels.js";
import { loadModelConfig } from "./model.js";
import { loadPause, type PauseState } from "./pause.js";
import { loadPinnedContract } from "./pin.js";
import type { InstallState } from "./types.js";

/**
 * The data-flow summary (spec §14.6, D106): which fields, by tag, go to which outside party: the model vendor (through
 * the agent's headless calls or the direct model), each connected source, each channel, Skills Wiki, and a support
 * bundle when the person sends one. Worked out from the pinned contract and what is set up, never from the model.
 * Clients need it for their privacy duties (PIPEDA, GDPR). The report shows it with the kill switch, the last
 * doctor run and the host readiness score, without changing `buildReport` (which stays pure).
 */
export interface FlowRow {
  readonly party: string;
  readonly via: string;
  readonly receives: string;
  readonly never?: string;
}

export interface OperationsView {
  readonly paused: PauseState | null;
  readonly doctor: { readonly status: string; readonly checked_at: string } | null;
  readonly readiness: { readonly score: string; readonly applies: boolean; readonly checked_at: string } | null;
  readonly data_flow: readonly FlowRow[];
}

type Tagged = FieldTag | "untagged";

/** `personal: contact.email, contact.name; untagged: contact.notes` for the entities given, leaving out `without`. */
export function fieldsByTag(contract: DataContract | null, entities: readonly string[] | null, without: readonly FieldTag[] = []): string {
  const groups = new Map<Tagged, string[]>();
  for (const [entity, def] of Object.entries(contract?.entities ?? {})) {
    if (entities !== null && !entities.includes(entity)) continue;
    for (const [field, spec] of Object.entries(def.fields)) {
      if (spec.tags.some((tag) => without.includes(tag))) continue;
      for (const tag of spec.tags.length === 0 ? (["untagged"] as const) : spec.tags) groups.set(tag, [...(groups.get(tag) ?? []), `${entity}.${field}`]);
    }
  }
  return groups.size === 0 ? "no record fields" : [...groups.entries()].map(([tag, fields]) => `${tag}: ${fields.join(", ")}`).join("; ");
}

async function modelRow(home: string, state: InstallState, contract: DataContract | null): Promise<FlowRow | null> {
  const runtime = state.runtime;
  const config = await loadModelConfig(home);
  const via = runtime?.profile && runtime.c4_headless ? `your agent (${runtime.profile}) in headless calls with every tool off` : config ? `the direct model API (${config.provider}, ${config.model}) with your own key` : null;
  if (via === null) return null;
  return { party: "Model vendor", via, receives: `what judge and agent steps are given: ${fieldsByTag(contract, null, ["protected_ground"])}`, never: "fields tagged protected_ground (removed before every judge and agent call)" };
}

async function sourceRows(home: string, contract: DataContract | null): Promise<FlowRow[]> {
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, SOURCES_DIR))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: FlowRow[] = [];
  for (const name of names) {
    const source = await loadSource(home, name.slice(0, -".json".length));
    if (source) rows.push({ party: source.connector.id, via: `the spreadsheet of '${source.entity}', your system of record`, receives: `every field of '${source.entity}': ${fieldsByTag(contract, [source.entity])}` });
  }
  return rows;
}

export async function dataFlow(home: string, state: InstallState): Promise<FlowRow[]> {
  const contract = await loadPinnedContract(home);
  const model = await modelRow(home, state, contract);
  const channels = (await listChannels(home)).map((config): FlowRow => ({
    party: config.channel, via: "the gateway, for messages in and out",
    receives: "the text of each message a workflow or a person sends; messages to outside contacts are approved first (L2) and respect opt-outs",
  }));
  return [
    ...(model ? [model] : []),
    ...(await sourceRows(home, contract)),
    ...channels,
    ...(state.skillswiki ? [{ party: "Skills Wiki", via: "the engine's MCP client", receives: "skill and combo requests; learnings from people's corrections with personal and protected_ground values, email addresses and long numbers removed", never: "business records, secrets, inbound messages, the audit" }] : []),
    { party: "Support (only when you send it)", via: "'installer support bundle', a file you send yourself", receives: "the install's state, report, errors and settings, redacted", never: "secrets, names, addresses, message text, personal and protected_ground values" },
  ];
}

export async function operationsView(home: string, state: InstallState): Promise<OperationsView> {
  const doctor = await loadDoctorReport(home);
  const readiness = (await readConfig(home, READINESS_FILE)) as Readiness | null;
  return {
    paused: await loadPause(home),
    doctor: doctor ? { status: doctor.status, checked_at: doctor.checked_at } : null,
    readiness: readiness ? { score: readiness.score, applies: readiness.applies, checked_at: readiness.checked_at } : null,
    data_flow: await dataFlow(home, state),
  };
}

/** The lines the text report adds after Plan 2's (`renderReport`). */
export function renderOperations(view: OperationsView): string[] {
  const host = view.readiness ? `readiness ${view.readiness.score}${view.readiness.applies ? "" : " (Personal mode: for information only)"}` : "not checked yet: run 'installer host'";
  return [
    ...(view.paused?.paused ? [`⏸️ Paused     since ${view.paused.at} by ${view.paused.by}: nothing is sent, no run starts ('installer unpause' in a person's terminal)`] : []),
    `🩺 Doctor     ${view.doctor ? `${view.doctor.status} (${view.doctor.checked_at})` : "never run: run 'installer doctor'"}`,
    `🖥️ Host       ${host}`,
    "🔀 Data flow",
    ...view.data_flow.map((row) => `   ${row.party} — ${row.via}: ${row.receives}${row.never ? `. Never: ${row.never}` : ""}`),
  ];
}
```

- [ ] **Step 4: `installer report` shows it**

In `src/cli.ts`, add after:

```ts
import { connectEntity, mapEntity } from "./core/data-commands.js";
```

this:

```ts
import { operationsView, renderOperations } from "./core/data-flow.js";
```

In `src/cli.ts`, replace:

```ts
    return flags.json ? report : renderReport(report);
```

with:

```ts
    const operations = await operationsView(deps.home, state);
    return flags.json ? { ...report, operations } : [renderReport(report), ...renderOperations(operations)].join("\n");
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/unit/data-flow.test.ts tests/unit/report.test.ts tests/e2e/operator.test.ts`
Expected: PASS, 21 tests (3 new, the 13 report tests and the 5 operator tests, unchanged).

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 88 files, 1219 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/data-flow.ts src/cli.ts tests/unit/data-flow.test.ts
git commit -m "feat(core): add the data-flow summary"
```

---

### Task 6: Skills Wiki packs pinned by content (§14.3, D34, D107)

**Files:**
- Create: `src/core/packs.ts`, `tests/unit/packs.test.ts`
- Modify: `src/core/runner-steps.ts`

**Interfaces:**
- Consumes: `fetchSkillswikiSolution`, `parseSkillswikiRef`, `skillswikiTarget` (`skillswiki.ts`), `canonicalJson`, `readConfig` / `writeConfig`; Plan 7's `runJudge`.
- Produces: `PACKS_FILE`, `PACK_STORE`, `PackFiles`, `Candidate` (`{version, files, found_at}`), `PackPin` (`{version, files, pinned_at, candidate?}`), `Packs`, `PackUpdate` (`{pack, from, to, changed}`), `packVersion(files)`, `loadPacks(home)`, `savePacks(home, packs)`, `pinnedSkill(home, url, ref, now, shadow?)`, `checkPacks(home, url, now)` (`packs.ts`). Judges now read `pinnedSkill`, never the live text.

- [ ] **Step 1: Write the failing tests**

The fake Skills Wiki serves a skill file from a temporary folder the tests rewrite between runs, and the fake agent logs every judge prompt, so the tests see exactly which text a judge was shown.

Create `tests/unit/packs.test.ts`:

```ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { setSecret } from "../../src/core/keychain.js";
import { PACK_STORE, checkPacks, loadPacks, pinnedSkill } from "../../src/core/packs.js";
import { startRun } from "../../src/core/runner.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { LABEL_SCHEMA } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const SKILL = "skillswiki:demo/judge/guide.md";
/** A judge that reads a Skills Wiki skill, then a memo with its label. */
const SORT = parseWorkflow({ workflow: "sort", version: 1, steps: [{ id: "label", judge: { instructions: "Label the request.", input: "${run.id}", schema: LABEL_SCHEMA, skill: SKILL } }, { id: "note", tool: "memo.add", args: { text: "${label.label}" } }] }, "sort", DEFAULT_TOOLS);
let fake: FakeMcp;
let served: string;
let runs = 0;
beforeAll(async () => {
  served = await makeTempHome();
  fake = await startFakeMcp({ FAKE_MCP_DIR: served });
  await setSecret("skillswiki", fake.key);
});
afterAll(() => fake.stop());
afterEach(() => vi.unstubAllEnvs());

/** What Skills Wiki serves as the skill file from now on. */
async function serve(text: string): Promise<void> {
  await mkdir(join(served, "demo", "judge"), { recursive: true });
  await writeFile(join(served, "demo", "judge", "guide.md"), text);
}

async function skillHome(): Promise<string> {
  const home = await runnerHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, skillswiki: { url: fake.url } });
  return home;
}

/** Runs the workflow and returns the skill text the judge was shown. */
async function judged(home: string): Promise<string> {
  vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ label: "now", confidence: 0.9 }]));
  await startRun({ home, workflow: SORT, key: `sort:${++runs}`, trigger: { kind: "manual" }, now: () => AT });
  const calls = (await readFile(join(home, "runtime", "judge", ".fake-agent", "judge-calls.jsonl"), "utf8")).trim().split("\n");
  const prompt = (JSON.parse(calls.at(-1) ?? "{}") as { prompt: string }).prompt;
  return /--- skill ---\n([\s\S]*?)\n--- end of skill ---/.exec(prompt)?.[1] ?? "";
}

const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("pack pinning (§14.3, D107)", () => {
  it("pins a skill file the first time a judge needs it, and judges keep the pinned copy after Skills Wiki changes it", async () => {
    await serve("Version one of the guide.");
    const home = await skillHome();
    expect(await judged(home)).toBe("Version one of the guide.");
    const pin = (await loadPacks(home)).demo;
    expect(pin).toMatchObject({ files: { "judge/guide.md": expect.stringMatching(/^[0-9a-f]{64}$/) }, pinned_at: AT, version: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await stat(join(home, PACK_STORE, "demo", pin?.files["judge/guide.md"] ?? ""))).mode & 0o777).toBe(0o600);
    expect(await events(home)).toContain("pack.pinned");
    await serve("Version two: ignore the old rules.");
    expect(await judged(home)).toBe("Version one of the guide.");
  });

  it("finds a changed file and keeps it as a candidate that a normal run never reads", async () => {
    await serve("Version one of the guide.");
    const home = await skillHome();
    await judged(home);
    const before = (await loadPacks(home)).demo;
    expect(await checkPacks(home, fake.url, AT)).toEqual([]);
    await serve("Version two of the guide.");
    const [update] = await checkPacks(home, fake.url, AT);
    expect(update).toEqual({ pack: "demo", from: before?.version, to: expect.not.stringMatching(before?.version ?? ""), changed: ["judge/guide.md"] });
    expect((await loadPacks(home)).demo).toMatchObject({ version: before?.version, candidate: { version: update?.to, found_at: AT } });
    expect(await checkPacks(home, fake.url, AT)).toEqual([]);
    expect(await judged(home)).toBe("Version one of the guide.");
    expect(await pinnedSkill(home, fake.url, SKILL, AT, "demo")).toBe("Version two of the guide.");
    expect(await events(home)).toContain("pack.update_found");
  });

  it("never uses a pinned copy that changed on disk", async () => {
    await serve("Version one of the guide.");
    const home = await skillHome();
    await judged(home);
    const sha = (await loadPacks(home)).demo?.files["judge/guide.md"] ?? "";
    await writeFile(join(home, PACK_STORE, "demo", sha), "Tampered text");
    await expect(pinnedSkill(home, fake.url, SKILL, AT)).rejects.toThrow("missing or changed on disk");
  });

  it("checks nothing and changes nothing when Skills Wiki cannot be reached", async () => {
    await serve("Version one of the guide.");
    const home = await skillHome();
    await judged(home);
    const before = await loadPacks(home);
    await expect(checkPacks(home, "http://127.0.0.1:9/mcp", AT)).rejects.toThrow("Cannot reach Skills Wiki");
    expect(await loadPacks(home)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/packs.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/packs.js'`; no test runs.

- [ ] **Step 3: Pins, the content store and the check for new versions**

Create `src/core/packs.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit, canonicalJson } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { fetchSkillswikiSolution, parseSkillswikiRef, skillswikiTarget } from "./skillswiki.js";
import { StateCorruptError } from "./state.js";

/**
 * Pack pinning (spec §14.3, D34, D107). Skills Wiki serves the newest text of a skill file, and none of its MCP answers
 * says which version that is (`skill_pack_meta.commit_sha` is not served). So the engine pins by content: the first
 * time a judge needs a file of a pack, the engine fetches it, keeps the text under `packs/<pack>/<sha256>` and records
 * the sha256 in `config/packs.json`; from then on judges read the pinned copy, whatever Skills Wiki serves. A pack's
 * version is the sha256 of its files' sha256s. `checkPacks` (run by `installer packs check` and the daily doctor)
 * fetches every pinned file again: different text is a candidate version, kept beside the pinned one and read only
 * by shadow runs (D108) until the decision maker switches. A pinned copy that changed on disk is never used.
 */
export const PACKS_FILE = join("config", "packs.json");
export const PACK_STORE = "packs";

/** `<skill>/<path>` → sha256 of the file's text. */
export type PackFiles = Readonly<Record<string, string>>;

export interface Candidate {
  readonly version: string;
  readonly files: PackFiles;
  readonly found_at: string;
}

export interface PackPin {
  readonly version: string;
  readonly files: PackFiles;
  readonly pinned_at: string;
  readonly candidate?: Candidate;
}

export type Packs = Readonly<Record<string, PackPin>>;

export interface PackUpdate {
  readonly pack: string;
  readonly from: string;
  readonly to: string;
  readonly changed: readonly string[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const packVersion = (files: PackFiles): string => sha256(canonicalJson(files));

export async function loadPacks(home: string): Promise<Packs> {
  const raw = await readConfig(home, PACKS_FILE);
  if (raw === null) return {};
  if (!isRecord(raw) || !Object.values(raw).every((pin) => isRecord(pin) && typeof pin.version === "string" && isRecord(pin.files))) throw new StateCorruptError(`${PACKS_FILE} has an unexpected shape; restore it from a copy`);
  return raw as unknown as Packs;
}

export const savePacks = (home: string, packs: Packs): Promise<void> => writeConfig(home, PACKS_FILE, packs);

async function storeText(home: string, pack: string, text: string): Promise<string> {
  const sha = sha256(text);
  const path = await confinedPath(home, join(PACK_STORE, pack, sha));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return sha;
}

async function storedText(home: string, pack: string, sha: string): Promise<string> {
  const where = join(PACK_STORE, pack, sha);
  const text = await readFile(await confinedPath(home, where), "utf8").catch(() => null);
  if (text === null || sha256(text) !== sha) throw new ActionFailure(`The pinned copy ${where} is missing or changed on disk, so it is not used: restore it from a copy`);
  return text;
}

/** Fetches a file a pinned pack does not hold yet, keeps it, and adds it to the pin (a new pack is pinned this way). */
async function pinFile(home: string, url: string | undefined, ref: string, now: string): Promise<string> {
  const { pack, skill, path } = parseSkillswikiRef(ref);
  const text = await fetchSkillswikiSolution(await skillswikiTarget(url), ref);
  const sha = await storeText(home, pack, text);
  const packs = await loadPacks(home);
  const current = packs[pack];
  const files = { ...(current?.files ?? {}), [`${skill}/${path}`]: sha };
  const pin: PackPin = { ...current, version: packVersion(files), files, pinned_at: current?.pinned_at ?? now };
  await savePacks(home, { ...packs, [pack]: pin });
  await appendAudit(home, { ts: now, actor: "engine", event: "pack.pinned", ref: `pack:${pack}`, payload: { file: `${skill}/${path}`, sha256: sha, version: pin.version } });
  return text;
}

/** The text a judge reads: the pinned copy, or the candidate's in a shadow run of that pack (D108). */
export async function pinnedSkill(home: string, url: string | undefined, ref: string, now: string, shadow?: string): Promise<string> {
  const { pack, skill, path } = parseSkillswikiRef(ref);
  const pin = (await loadPacks(home))[pack];
  const key = `${skill}/${path}`;
  const sha = (shadow === pack ? pin?.candidate?.files[key] : undefined) ?? pin?.files[key];
  return sha === undefined ? pinFile(home, url, ref, now) : storedText(home, pack, sha);
}

/** Fetches every pinned file again; a pack whose text changed gets (or keeps) a candidate. Returns the new candidates. */
export async function checkPacks(home: string, url: string | undefined, now: string): Promise<PackUpdate[]> {
  const packs = await loadPacks(home);
  if (Object.keys(packs).length === 0) return [];
  const target = await skillswikiTarget(url);
  const updates: PackUpdate[] = [];
  let next: Packs = packs;
  for (const [pack, pin] of Object.entries(packs)) {
    const files: Record<string, string> = {};
    for (const key of Object.keys(pin.files)) files[key] = await storeText(home, pack, await fetchSkillswikiSolution(target, `skillswiki:${pack}/${key}`));
    const version = packVersion(files);
    if (version === pin.version || version === pin.candidate?.version) continue;
    const update = { pack, from: pin.version, to: version, changed: Object.keys(files).filter((key) => files[key] !== pin.files[key]) };
    next = { ...next, [pack]: { ...pin, candidate: { version, files, found_at: now } } };
    updates.push(update);
    await appendAudit(home, { ts: now, actor: "engine", event: "pack.update_found", ref: `pack:${pack}`, payload: update });
  }
  if (updates.length > 0) await savePacks(home, next);
  return updates;
}
```

- [ ] **Step 4: Judges read the pinned copy**

In `src/core/runner-steps.ts`, replace:

```ts
import { askJudge, protectedFields, runContextTools, skillText, stripFields, type ContextCall, type JudgeBackend } from "./judge.js";
import { needsApproval } from "./levels.js";
```

with:

```ts
import { askJudge, protectedFields, runContextTools, stripFields, type ContextCall, type JudgeBackend } from "./judge.js";
import { needsApproval } from "./levels.js";
import { pinnedSkill } from "./packs.js";
```

In `src/core/runner-steps.ts`, replace:

```ts
  const skill = spec.skill ? await skillText(exec.state?.skillswiki?.url, spec.skill) : null;
```

with:

```ts
  // D107: the pinned copy of the skill file, never whatever Skills Wiki serves today.
  const skill = spec.skill ? await pinnedSkill(exec.home, exec.state?.skillswiki?.url, spec.skill, now(exec)) : null;
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/unit/packs.test.ts tests/unit/judge.test.ts tests/unit/learning.test.ts`
Expected: PASS, 28 tests (4 new, the 16 judge tests and the 8 learning tests, unchanged).

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 89 files, 1224 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/packs.ts src/core/runner-steps.ts tests/unit/packs.test.ts
git commit -m "feat(core): pin Skills Wiki packs by content"
```

---

### Task 7: The shadow upgrade, its evals and the decision maker's switch (§14.3, D34, D108)

**Files:**
- Create: `src/core/shadow.ts`, `tests/unit/shadow.test.ts`
- Modify: `src/core/packs.ts`, `src/core/runs.ts`, `src/core/runner.ts`, `src/core/runner-steps.ts`, `src/core/doctor-checks.ts`

**Interfaces:**
- Consumes: `loadPacks`, `savePacks`, `checkPacks`, `Candidate` (Task 6), `startRun`, `listOutbox`, `deciderFor`, `invokeTool` / `toolContext`, `loadWorkflow` / `workflowIds`, `DoctorContext` (Task 3).
- Produces: `ShadowSide`, `ShadowComparison`, `EvalResult`, `ShadowEval` (`{name, evaluate(comparisons)}`), `ShadowResult` (`{at, version, comparisons, evals, passed}`), `SHADOW_RUNS_EVAL`, `shadowPack(home, pack, now, evals?)`, `switchPack(home, pack, roles, person, now)`, `packsCommand(home, sub, pack, roles, person, now)` (`shadow.ts`); `Candidate.shadow`; `RunRecord.shadow` and `RunRequest.shadow` (a shadow run is always a sandbox run); the doctor check `packs`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/shadow.test.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { runDoctor } from "../../src/core/doctor.js";
import { setSecret } from "../../src/core/keychain.js";
import { checkPacks, loadPacks } from "../../src/core/packs.js";
import { startRun } from "../../src/core/runner.js";
import { packsCommand, shadowPack, switchPack } from "../../src/core/shadow.js";
import { loadState, saveState } from "../../src/core/state.js";
import { HEARTBEAT_FILE } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { loadWorkflow } from "../../src/core/workflow.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { OWNER_ROLES, runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { LABEL_SCHEMA, writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const VALID = { label: "now", confidence: 0.9 };
/** A judge that reads a Skills Wiki skill, then a memo with its label. */
const SORT = { workflow: "sort", version: 1, steps: [{ id: "label", judge: { instructions: "Label the request.", input: "${run.id}", schema: LABEL_SCHEMA, skill: "skillswiki:demo/judge/guide.md" } }, { id: "note", tool: "memo.add", args: { text: "${label.label}" } }] };
let fake: FakeMcp;
let served: string;
let runs = 0;
beforeAll(async () => {
  served = await makeTempHome();
  fake = await startFakeMcp({ FAKE_MCP_DIR: served });
  await setSecret("skillswiki", fake.key);
});
afterAll(() => fake.stop());
afterEach(() => vi.unstubAllEnvs());

async function serve(text: string): Promise<void> {
  await mkdir(join(served, "demo", "judge"), { recursive: true });
  await writeFile(join(served, "demo", "judge", "guide.md"), text);
}

/** A home whose `sort` workflow pinned version one of the guide, while Skills Wiki now serves version two. */
async function updatedHome(answers: readonly unknown[] = [VALID]): Promise<string> {
  vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify(answers));
  const home = await runnerHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, skillswiki: { url: fake.url } });
  await writeWorkflow(home, SORT);
  await serve("Version one of the guide.");
  await run(home);
  await serve("Version two of the guide.");
  return home;
}

const run = async (home: string) => startRun({ home, workflow: await loadWorkflow(home, "sort", DEFAULT_TOOLS), key: `sort:${++runs}`, trigger: { kind: "manual" }, now: () => AT });
const skillsSeen = async (home: string): Promise<string[]> =>
  (await readFile(join(home, "runtime", "judge", ".fake-agent", "judge-calls.jsonl"), "utf8")).trim().split("\n").map((line) => /--- skill ---\n([\s\S]*?)\n--- end of skill ---/.exec((JSON.parse(line) as { prompt: string }).prompt)?.[1] ?? "");
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("the shadow upgrade (§14.3, D108)", () => {
  it("runs each workflow that reads the pack in sandbox, on the pinned and on the candidate text, and compares them", async () => {
    const home = await updatedHome();
    await checkPacks(home, fake.url, AT);
    const result = await shadowPack(home, "demo", () => AT);
    expect(result).toMatchObject({ passed: true, evals: [{ name: "shadow-runs", passed: true, detail: "1 workflow(s) did as well on the candidate" }] });
    expect(result.comparisons).toEqual([{ workflow: "sort", pinned: expect.objectContaining({ status: "completed", recorded: 1, needs_human: 0 }), candidate: expect.objectContaining({ status: "completed", recorded: 1, needs_human: 0 }) }]);
    expect((await skillsSeen(home)).slice(-2)).toEqual(["Version one of the guide.", "Version two of the guide."]);
    expect(await memos(home)).toEqual(["now"]);
    expect((await loadPacks(home)).demo?.candidate?.shadow).toMatchObject({ passed: true, version: result.version });
    expect(await shadowPack(home, "demo", () => AT)).toMatchObject({ comparisons: result.comparisons });
    expect(await events(home)).toEqual(expect.arrayContaining(["pack.shadow_ran", "pack.announced"]));
  });

  it("does not pass a candidate that needs a person more often, and such a version cannot be switched", async () => {
    const home = await updatedHome([VALID, VALID, { label: "maybe" }]);
    await checkPacks(home, fake.url, AT);
    const result = await shadowPack(home, "demo", () => AT);
    expect(result).toMatchObject({ passed: false, evals: [{ detail: "worse on the candidate: sort (failed, 1 need a person)" }] });
    await expect(switchPack(home, "demo", OWNER_ROLES, { interactive: true, as: "Owner" }, () => AT)).rejects.toThrow("have not passed");
  });

  it("is switched by the decision maker alone, in their own terminal; judges then read the new version", async () => {
    const home = await updatedHome();
    await checkPacks(home, fake.url, AT);
    await shadowPack(home, "demo", () => AT);
    await expect(switchPack(home, "demo", OWNER_ROLES, { interactive: false }, () => AT)).rejects.toThrow("in their own terminal");
    await expect(switchPack(home, "demo", OWNER_ROLES, { interactive: true, as: "Ada" }, () => AT)).rejects.toThrow("only the decision maker");
    expect((await events(home)).filter((event) => event === "pack.switch_refused")).toHaveLength(2);
    const candidate = (await loadPacks(home)).demo?.candidate?.version;
    expect(await packsCommand(home, "switch", "demo", OWNER_ROLES, { interactive: true, as: "Owner" }, () => AT)).toMatchObject({ status: "switched", to: candidate, by: "Owner" });
    expect((await loadPacks(home)).demo).toEqual(expect.objectContaining({ version: candidate }));
    expect((await loadPacks(home)).demo?.candidate).toBeUndefined();
    await run(home);
    expect((await skillsSeen(home)).at(-1)).toBe("Version two of the guide.");
    expect(await events(home)).toContain("pack.switched");
  });

  it("is started by the doctor, which finds the new version, runs the shadow and leaves the switch to the decision maker", async () => {
    const home = await updatedHome();
    await writeConfig(home, HEARTBEAT_FILE, { last: AT, alive: AT, pid: 1 });
    const report = await runDoctor(home, { now: () => AT, freeBytes: async () => 50 * 1024 ** 3 });
    expect(report.checks.find((check) => check.id === "packs")).toMatchObject({ status: "warn", detail: "demo: a new version, shadow passed", fix: expect.stringContaining("installer packs switch <pack>") });
    expect(await packsCommand(home, "list", undefined, OWNER_ROLES, { interactive: false }, () => AT)).toMatchObject({ packs: [{ pack: "demo", candidate: { shadow: { passed: true } } }] });
    await expect(packsCommand(home, "shadow", undefined, OWNER_ROLES, { interactive: false }, () => AT)).rejects.toThrow("packs takes:");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/shadow.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/shadow.js'`; no test runs.

- [ ] **Step 3: A shadow run reads the candidate**

In `src/core/runs.ts`, add after:

```ts
  readonly urgent?: boolean;
```

this:

```ts
  /** A shadow run (D108): a sandbox run whose judges read this pack's candidate version instead of the pinned one. */
  readonly shadow?: string;
```

In `src/core/runner.ts`, add after:

```ts
  readonly sandbox?: boolean;
```

this:

```ts
  /** A shadow run of this pack's candidate version (D108); always a sandbox run. */
  readonly shadow?: string;
```

In `src/core/runner.ts`, replace:

```ts
    status: "running", started_at: request.now(), sandbox: request.sandbox === true || (await runsInSandbox(request.home, request.workflow.id)), pid: process.pid, actions: 0, needs_human: 0,
```

with:

```ts
    status: "running", started_at: request.now(), sandbox: request.sandbox === true || request.shadow !== undefined || (await runsInSandbox(request.home, request.workflow.id)), pid: process.pid, actions: 0, needs_human: 0,
    ...(request.shadow ? { shadow: request.shadow } : {}),
```

In `src/core/runner-steps.ts`, replace:

```ts
  // D107: the pinned copy of the skill file, never whatever Skills Wiki serves today.
  const skill = spec.skill ? await pinnedSkill(exec.home, exec.state?.skillswiki?.url, spec.skill, now(exec)) : null;
```

with:

```ts
  // D107: the pinned copy of the skill file, never whatever Skills Wiki serves today (a shadow run reads the candidate, D108).
  const skill = spec.skill ? await pinnedSkill(exec.home, exec.state?.skillswiki?.url, spec.skill, now(exec), record.shadow) : null;
```

In `src/core/packs.ts`, add after:

```ts
import { ActionFailure } from "./failure.js";
```

this:

```ts
import type { ShadowResult } from "./shadow.js";
```

In `src/core/packs.ts`, add after:

```ts
  readonly found_at: string;
```

this:

```ts
  /** The last shadow of this candidate (D108); the decision maker can switch only after it passed. */
  readonly shadow?: ShadowResult;
```

- [ ] **Step 4: Shadow runs, the eval interface and the switch**

Hosted evals are not run: a model has to answer and grade their tasks in a conversation (fact 2), so they cannot run unattended in an install yet (O11), and the fake Skills Wiki has none. `ShadowEval` is the seam where they plug in later.

Create `src/core/shadow.ts`:

```ts
import { ToolRefusal, deciderFor } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { listOutbox } from "./outbound.js";
import { PACKS_FILE, checkPacks, loadPacks, savePacks, type Candidate, type Packs } from "./packs.js";
import { startRun } from "./runner.js";
import { parseSkillswikiRef } from "./skillswiki.js";
import { loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { invokeTool, toolContext } from "./tools.js";
import type { Roles } from "./types.js";
import { loadWorkflow, workflowIds, type Workflow } from "./workflow.js";

/**
 * The shadow upgrade (spec §14.3, D34, D108). A candidate pack version (D107) is tried before anyone relies on it:
 * each workflow whose judges read that pack runs twice in sandbox, on the pinned text and on the candidate (a shadow
 * run), so nothing is sent or changed. The two runs are compared (status, actions, recordings, answers that need a
 * person) and every `ShadowEval` grades the comparison. v1 has one eval, `shadow-runs`: Skills Wiki's hosted evals
 * (`eval_start` … `eval_submit`) need a model to answer and grade tasks in a conversation and cannot run unattended
 * yet (O11), and the test double has none. A passing candidate is announced to the decision maker; only they switch,
 * in their own terminal (a policy change). Every step is audited.
 */
export interface ShadowSide {
  readonly run_id: string;
  readonly status: string;
  readonly actions: number;
  readonly recorded: number;
  readonly needs_human: number;
}

export interface ShadowComparison {
  readonly workflow: string;
  readonly pinned: ShadowSide;
  readonly candidate: ShadowSide;
}

export interface EvalResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** A way to grade a candidate from its shadow runs; hosted evals would be another one (O11). */
export interface ShadowEval {
  readonly name: string;
  readonly evaluate: (comparisons: readonly ShadowComparison[]) => Promise<EvalResult>;
}

export interface ShadowResult {
  readonly at: string;
  readonly version: string;
  readonly comparisons: readonly ShadowComparison[];
  readonly evals: readonly EvalResult[];
  readonly passed: boolean;
}

/** Passes when every candidate run completed and none needs a person more often than the pinned version's run. */
export const SHADOW_RUNS_EVAL: ShadowEval = {
  name: "shadow-runs",
  evaluate: async (comparisons) => {
    const worse = comparisons.filter(({ pinned, candidate }) => candidate.status !== "completed" || candidate.needs_human > pinned.needs_human);
    const detail = worse.length > 0 ? `worse on the candidate: ${worse.map(({ workflow, candidate }) => `${workflow} (${candidate.status}, ${candidate.needs_human} need a person)`).join(", ")}`
      : comparisons.length === 0 ? "no workflow reads this pack" : `${comparisons.length} workflow(s) did as well on the candidate`;
    return { name: "shadow-runs", passed: worse.length === 0, detail };
  },
};

async function workflowsUsing(home: string, pack: string): Promise<Workflow[]> {
  const found: Workflow[] = [];
  for (const id of await workflowIds(home)) {
    try {
      const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
      if (workflow.steps.some((step) => step.kind === "judge" && step.judge.skill !== undefined && parseSkillswikiRef(step.judge.skill).pack === pack)) found.push(workflow);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return found;
}

/** One sandbox run with its own key (the same key again returns the same run, so a shadow is never run twice). */
async function side(home: string, workflow: Workflow, key: string, now: () => string, shadow?: string): Promise<ShadowSide> {
  const record = await startRun({ home, workflow, key, trigger: { kind: "manual" }, now, sandbox: true, ...(shadow ? { shadow } : {}) });
  const recorded = (await listOutbox(home, `${workflow.id}/${record.run_id}`)).length;
  return { run_id: record.run_id, status: record.status, actions: record.actions, recorded, needs_human: record.needs_human };
}

async function saveShadow(home: string, pack: string, result: ShadowResult): Promise<void> {
  const packs = await loadPacks(home);
  const pin = packs[pack];
  if (pin?.candidate?.version !== result.version) return;
  await savePacks(home, { ...packs, [pack]: { ...pin, candidate: { ...pin.candidate, shadow: result } } });
}

/** A passing candidate is announced to the decision maker (L1; R6 and the kill switch apply); a failed send is audited. */
async function announce(home: string, pack: string, result: ShadowResult, now: () => string): Promise<void> {
  const text = `Skills Wiki pack '${pack}' has a new version and its shadow runs passed (${result.comparisons.length} workflow(s); nothing was sent or changed). The pinned version stays in use until you run 'installer packs switch ${pack} --as <your name>' in your own terminal.`;
  const name = (await loadState(home))?.roles?.decision_maker;
  let error: string | null = name ? null : "no decision maker is set (MODE phase)";
  if (name) {
    try {
      await invokeTool(await toolContext(home, "runner", DEFAULT_TOOLS, now), "channel.notify", { member: name, text });
    } catch (failure) {
      if (!(failure instanceof InputError || failure instanceof ToolRefusal || failure instanceof ActionFailure)) throw failure;
      error = failure.message;
    }
  }
  await appendAudit(home, { ts: now(), actor: "engine", event: "pack.announced", ref: `pack:${pack}`, payload: { version: result.version, delivered: error === null, ...(error ? { error } : {}) } });
}

/** Runs the shadow of a pack's candidate, grades it, keeps the result with the candidate and announces a pass. */
export async function shadowPack(home: string, pack: string, now: () => string, evals: readonly ShadowEval[] = [SHADOW_RUNS_EVAL]): Promise<ShadowResult> {
  const candidate = (await loadPacks(home))[pack]?.candidate;
  if (!candidate) throw new InputError(`Pack '${pack}' has no new version to try: run 'installer packs check' first`);
  const comparisons: ShadowComparison[] = [];
  for (const workflow of await workflowsUsing(home, pack)) {
    const key = `${workflow.id}:shadow:${pack}:${candidate.version.slice(0, 12)}`;
    comparisons.push({ workflow: workflow.id, pinned: await side(home, workflow, `${key}:pinned`, now), candidate: await side(home, workflow, `${key}:candidate`, now, pack) });
  }
  const graded: EvalResult[] = [];
  for (const shadowEval of evals) graded.push(await shadowEval.evaluate(comparisons));
  const result: ShadowResult = { at: now(), version: candidate.version, comparisons, evals: graded, passed: graded.every((entry) => entry.passed) };
  await saveShadow(home, pack, result);
  await appendAudit(home, { ts: now(), actor: "engine", event: "pack.shadow_ran", ref: `pack:${pack}`, payload: { version: candidate.version, passed: result.passed, workflows: comparisons.map((entry) => entry.workflow) } });
  if (result.passed) await announce(home, pack, result, now);
  return result;
}

async function refuseSwitch(home: string, pack: string, by: string, reason: string, now: string): Promise<never> {
  await appendAudit(home, { ts: now, actor: by === "agent" ? "agent" : "human", event: "pack.switch_refused", ref: `pack:${pack}`, payload: { by, reason } });
  throw new InputError(reason);
}

/** The decision maker, in their own terminal, after a passing shadow of this very candidate: the candidate becomes the pin. */
export async function switchPack(home: string, pack: string, roles: Roles | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (!person.interactive) return refuseSwitch(home, pack, "agent", `Switching a pack version is the decision maker's call, in their own terminal: 'installer packs switch ${pack} --as <their name>'`, now());
  const decider = deciderFor(person.as, roles);
  if (decider.role !== "decision_maker") return refuseSwitch(home, pack, decider.name, "Switching a pack version is a policy change: only the decision maker switches (--as <their name>)", now());
  const packs: Packs = await loadPacks(home);
  const pin = packs[pack];
  const candidate: Candidate | undefined = pin?.candidate;
  if (!pin || !candidate) throw new InputError(`Pack '${pack}' has no new version: 'installer packs list' shows the pins`);
  if (candidate.shadow?.version !== candidate.version || !candidate.shadow.passed) throw new InputError(`The shadow runs of '${pack}' have not passed for this version: run 'installer packs shadow ${pack}' and read the comparison`);
  const { candidate: _done, ...kept } = pin;
  await savePacks(home, { ...packs, [pack]: { ...kept, version: candidate.version, files: candidate.files, pinned_at: now() } });
  await appendAudit(home, { ts: now(), actor: "human", event: "pack.switched", ref: `pack:${pack}`, payload: { from: pin.version, to: candidate.version, by: decider.name } });
  return { status: "switched", pack, from: pin.version, to: candidate.version, by: decider.name };
}

const summary = (packs: Packs) =>
  Object.entries(packs).map(([pack, pin]) => ({
    pack, version: pin.version, files: Object.keys(pin.files), pinned_at: pin.pinned_at,
    ...(pin.candidate ? { candidate: { version: pin.candidate.version, found_at: pin.candidate.found_at, shadow: pin.candidate.shadow ? { at: pin.candidate.shadow.at, passed: pin.candidate.shadow.passed, evals: pin.candidate.shadow.evals } : null } } : {}),
  }));

/** `installer packs [list | check | shadow <pack> | switch <pack> --as <name>]` (D107, D108). */
export async function packsCommand(home: string, sub: string | undefined, pack: string | undefined, roles: Roles | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (sub === undefined || sub === "list") return { packs: summary(await loadPacks(home)), file: PACKS_FILE };
  if (sub === "check") return { updates: await checkPacks(home, (await loadState(home))?.skillswiki?.url, now()) };
  if ((sub === "shadow" || sub === "switch") && pack) return sub === "shadow" ? { ...(await shadowPack(home, pack, now)) } : switchPack(home, pack, roles, person, now);
  throw new InputError("packs takes: list, check, shadow <pack>, switch <pack> --as <name>");
}
```

- [ ] **Step 5: The doctor finds new versions and tries them**

In `src/core/doctor-checks.ts`, add after:

```ts
import { MODEL_SECRET_ID, loadModelConfig } from "./model.js";
```

this:

```ts
import { checkPacks, loadPacks } from "./packs.js";
```

In `src/core/doctor-checks.ts`, add after:

```ts
import { REPORT_RUNS, clearClaim, listRuns, orphanClaims, type RunRecord } from "./runs.js";
```

this:

```ts
import { shadowPack } from "./shadow.js";
```

In `src/core/doctor-checks.ts`, replace:

```ts
}

export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
```

with:

```ts
}

/** §14.3, D107, D108: a new version of a pinned pack is found, tried in shadow, and left for the decision maker. */
async function packsCheck(ctx: DoctorContext): Promise<DoctorCheck | null> {
  if (Object.keys(await loadPacks(ctx.home)).length === 0) return null;
  for (const update of await checkPacks(ctx.home, ctx.state?.skillswiki?.url, ctx.now)) await shadowPack(ctx.home, update.pack, () => ctx.now);
  const waiting = Object.entries(await loadPacks(ctx.home)).filter(([, pin]) => pin.candidate !== undefined);
  if (waiting.length === 0) return ok("packs", "every pinned pack is what Skills Wiki serves");
  const states = waiting.map(([pack, pin]) => `${pack}: a new version, shadow ${pin.candidate?.shadow ? (pin.candidate.shadow.passed ? "passed" : "did not pass") : "not run"}`);
  return { id: "packs", status: "warn", detail: states.join("; "), fix: "The decision maker reads 'installer packs list' and switches with 'installer packs switch <pack> --as <name>' in their own terminal" };
}

export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
```

In `src/core/doctor-checks.ts`, add after:

```ts
  { id: "skillswiki", run: skillswikiCheck },
```

this:

```ts
  { id: "packs", run: packsCheck },
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/unit/shadow.test.ts tests/unit/packs.test.ts tests/unit/runner.test.ts`
Expected: PASS, 22 tests (4 new, the 4 pack tests and the 14 runner tests, unchanged).

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 90 files, 1229 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/shadow.ts src/core/packs.ts src/core/runs.ts src/core/runner.ts src/core/runner-steps.ts src/core/doctor-checks.ts tests/unit/shadow.test.ts
git commit -m "feat(core): add the shadow upgrade for packs"
```

---

### Task 8: `installer uninstall` and the support bundle (§16.4, §16.5, D34, D109, D110)

**Files:**
- Create: `src/core/uninstall.ts`, `src/core/support-bundle.ts`, `tests/unit/uninstall.test.ts`, `tests/unit/support-bundle.test.ts`
- Modify: `src/core/disconnect.ts`

**Interfaces:**
- Consumes: `setPaused` (Task 1), `stopGateway`, `deleteSecret`, `scheduleCommand`, `serviceCommand` (Task 4), `withAuditLock` / `verifyAudit` (Task 3), `loadDoctorReport`, `READINESS_FILE`, `loadPacks`, `loadRetention`, `personalFields` (`learning.ts`), `listMembers`, `listChannels`, `listApprovals`, `listRuns`, `buildReport`.
- Produces: `EXPORTS_DIR`, `ENGINE_SECRETS`, `exportAudit(home, now)`, `uninstall(home, person, now, options)` (`uninstall.ts`); `scrub(value, known, fields)`, `supportBundle(home, now)` (`support-bundle.ts`); `unregisterEverywhere(home, profileId, name?)` exported (`disconnect.ts`).

- [ ] **Step 1: Write the failing tests**

The uninstall tests register both MCP servers in the fake agent's own folder, store keychain items in a throwaway keychain and load a schedule file, then check what is removed, what is printed and what is kept. The bundle tests fill a home with sentinel values in every place personal data can sit and search the written file for them.

Create `tests/unit/uninstall.test.ts`:

```ts
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { isPaused } from "../../src/core/pause.js";
import { loadProfileById } from "../../src/core/profile.js";
import { TOOLS_MCP_NAME, registerMcpConfig } from "../../src/core/register.js";
import { SCHEDULE_DIR, scheduleCommand } from "../../src/core/scheduler.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { uninstall } from "../../src/core/uninstall.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const OS = { platform: "darwin" as const, node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js", user: "installer-engine" };

/** A home whose fake agent has both MCP servers registered, with keychain items, a loaded schedule and one memo. */
async function installedHome(): Promise<{ home: string; env: Record<string, string> }> {
  const home = await runnerHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, skillswiki: { url: "https://skills.example/mcp" } });
  const profile = await loadProfileById("fake-agent");
  await registerMcpConfig(profile, "skillswiki", JSON.stringify({ type: "http", url: "https://skills.example/mcp" }), home);
  await registerMcpConfig(profile, TOOLS_MCP_NAME, JSON.stringify({ type: "stdio", command: "node" }), home);
  const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  for (const id of ["skillswiki", "telegram", "model"]) await setSecret(id, `value-of-${id}`, env);
  await scheduleCommand(home, "install", undefined, () => AT, OS);
  await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "A business record" });
  return { home, env };
}

const registered = async (home: string, name: string): Promise<boolean> => access(join(home, ".fake-agent", "mcp", `${name}.json`)).then(() => true, () => false);

describe("installer uninstall (§16.4, D109)", () => {
  it("needs a person's terminal: the agent's attempt is refused, audited, and removes nothing", async () => {
    const { home, env } = await installedHome();
    await expect(uninstall(home, { interactive: false }, () => AT, { ...OS, env })).rejects.toThrow("in their own terminal");
    expect((await readFile(join(home, AUDIT_FILE), "utf8"))).toContain('"event":"engine.uninstall_refused"');
    expect(await getSecret("skillswiki", env)).toBe("value-of-skillswiki");
    expect(await registered(home, "skillswiki")).toBe(true);
  });

  it("pauses, unregisters, deletes the keys and the schedule, prints the OS commands, exports the audit and keeps the records", async () => {
    const { home, env } = await installedHome();
    const result = await uninstall(home, { interactive: true, as: "Owner" }, () => AT, { ...OS, env });
    expect(result).toMatchObject({ status: "uninstalled", gateway: "not_running", unregistered: { skillswiki: { unregistered: true }, installer: { unregistered: true } } });
    expect(result.secrets).toMatchObject({ skillswiki: "deleted", telegram: "deleted", model: "deleted", email: "none", google: "none" });
    expect(await isPaused(home)).toBe(true);
    expect([await registered(home, "skillswiki"), await registered(home, TOOLS_MCP_NAME)]).toEqual([false, false]);
    expect(await getSecret("telegram", env)).toBeNull();
    expect(await readdir(join(home, SCHEDULE_DIR))).toEqual([]);
    expect(result.commands).toContainEqual(expect.stringMatching(/^launchctl bootout gui\/\$\(id -u\)\/com\.installer\.tick\.[0-9a-f]{8}$/));
    expect(result.commands).toContainEqual(expect.stringMatching(/^sudo launchctl bootout system\/com\.installer\.gateway\./));
    const exported = result.audit_export as { file: string; lines: number; chain: string };
    expect(exported).toMatchObject({ file: expect.stringContaining(join(home, "exports", "audit-")), chain: "intact" });
    expect((await readFile(exported.file, "utf8")).trim().split("\n")).toHaveLength(exported.lines);
    expect((await stat(exported.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(exported.file, "utf8")).toContain('"event":"engine.uninstalled"');
    expect((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos).toEqual([expect.objectContaining({ text: "A business record" })]);
  });

  it("can run again safely: there is nothing left to remove", async () => {
    const { home, env } = await installedHome();
    await uninstall(home, { interactive: true }, () => AT, { ...OS, env });
    const again = await uninstall(home, { interactive: true }, () => AT, { ...OS, env });
    expect(again).toMatchObject({ status: "uninstalled", unregistered: { skillswiki: { unregistered: false }, installer: { unregistered: false } } });
    expect(Object.values(again.secrets as Record<string, string>)).toEqual(["none", "none", "none", "none", "none"]);
  });
});
```

Create `tests/unit/support-bundle.test.ts`:

```ts
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { saveSource } from "../../src/core/data-source.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { LOG_FILE } from "../../src/core/gateway.js";
import { storeInbound } from "../../src/core/inbox.js";
import { setSecret } from "../../src/core/keychain.js";
import { createInvite, joinWithCode } from "../../src/core/members.js";
import { TICK_LOG } from "../../src/core/scheduler.js";
import { loadState, saveState } from "../../src/core/state.js";
import { scrub, supportBundle } from "../../src/core/support-bundle.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import type { InstallState } from "../../src/core/types.js";
import { channelHome } from "../helpers/channel-home.js";
import { BOT_TOKEN } from "../helpers/fake-telegram.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const MODEL_KEY = "sk-SENTINEL-model-key";
beforeEach(async () => {
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
  await setSecret("telegram", BOT_TOKEN);
  await setSecret("model", MODEL_KEY);
});
afterEach(() => vi.unstubAllEnvs());

async function log(home: string, relative: string, line: string): Promise<void> {
  await mkdir(dirname(join(home, relative)), { recursive: true });
  await appendFile(join(home, relative), `${line}\n`);
}

/** A finished install full of personal data: members, a stranger's message, a memo, an approval, an answer, logs. */
async function personalHome(): Promise<string> {
  const home = await channelHome(true);
  const state = (await loadState(home)) as InstallState;
  await saveState(home, { ...state, roles: { decision_maker: "Marisol Okafor" }, work_dir: join(homedir(), "Desktop", "client-folder"), steps: { ...state.steps, "mode.decision-maker": { status: "done", at: AT, by: "human", value: "Marisol Okafor" } } });
  const { code } = await createInvite(home, "Quillon Vexmoor", state.roles, AT);
  await joinWithCode(home, code, { channel: "telegram", address: "7123456" }, AT);
  await storeInbound(home, normalizeInbound({ channel: "telegram", from: "5005", thread: "5005", text: "SENTINEL-MESSAGE call me at +1 416 555 0199 or zed@example.org", message_id: "s1" }, AT), "event");
  const ctx = await toolContext(home, "cli", DEFAULT_TOOLS, () => AT);
  await invokeTool(ctx, "memo.add", { text: "SENTINEL-MEMO" });
  await invokeTool(ctx, "approvals.request", { tool: "memo.edit", args: { id: 1, text: "SENTINEL-APPROVAL" }, why: "Fix it." });
  await saveSource(home, { entity: "contact", connector: { id: "google-sheets", version: "1", sha256: "pinned" }, spreadsheet_id: "1SENTINELsheetid" });
  await log(home, LOG_FILE, JSON.stringify({ ts: AT, level: "error", loop: "telegram", error: "send to zed@example.org failed for Quillon Vexmoor (+1 416 555 0199)" }));
  await log(home, TICK_LOG, JSON.stringify({ status: "ran", errors: ["No joined member is called 'Marisol Okafor'"] }));
  return home;
}

describe("installer support bundle (§16.5, D110)", () => {
  it("holds the install's shape: versions, state without answers, report, runs, settings, counts, the audit check and the logs", async () => {
    const home = await personalHome();
    const result = await supportBundle(home, () => AT);
    expect(result).toMatchObject({ status: "written", file: join(home, "exports", "support-2026-10-08T12-00-00-000Z.json") });
    expect((await stat(result.file as string)).mode & 0o777).toBe(0o600);
    const bundle = JSON.parse(await readFile(result.file as string, "utf8"));
    expect(Object.keys(bundle)).toEqual(["format", "created_at", "versions", "state", "report", "doctor", "readiness", "runs", "settings", "counts", "audit", "secrets_present", "logs"]);
    expect(bundle.state.steps["mode.decision-maker"]).toEqual({ status: "done", at: AT, by: "human" });
    expect(bundle.state.work_dir).toBe("~/Desktop/client-folder");
    expect(bundle.report).toMatchObject({ overall: "ready", solution: "fixture-channels@1.0.0" });
    expect(bundle.counts).toMatchObject({ approvals: { pending: 1 }, members: { "member joined": 2, "decision_maker joined": 1 }, inbox: 1 });
    expect(bundle.secrets_present).toMatchObject({ telegram: true, model: true, skillswiki: false });
    expect(bundle.audit.check).toMatchObject({ ok: true });
    expect(bundle.logs.gateway).toHaveLength(1);
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain('"event":"support.bundle_written"');
  });

  it("never holds a secret, a name, an address, a message, a record, an answer or the OS user's home folder", async () => {
    const home = await personalHome();
    const text = await readFile((await supportBundle(home, () => AT)).file as string, "utf8");
    for (const secret of [BOT_TOKEN, MODEL_KEY, "SENTINEL", "zed@example.org", "416 555", "Vexmoor", "Marisol", homedir()]) expect(text).not.toContain(secret);
    for (const word of [/\bAda\b/, /\bOwner\b/, /\b1001\b/, /\b1002\b/, /\b7123456\b/, /\b5005\b/, /desk_test_bot/]) expect(text).not.toMatch(word);
    expect(text).toContain("[redacted]");
    expect(text).toContain(AT);
  });

  it("redacts the values of fields the contract tags personal, wherever they appear", () => {
    expect(scrub({ email: "a@b.co", nested: [{ name: "Ada", ok: "2026-10-08T12:00:00.000Z" }] }, [], new Set(["email", "name"]))).toEqual({ email: "[redacted]", nested: [{ name: "[redacted]", ok: "2026-10-08T12:00:00.000Z" }] });
    expect(scrub("Call +44 20 7946 0958 about Ada's case", ["Ada"], new Set())).toBe("Call [number] about [redacted]'s case");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/uninstall.test.ts tests/unit/support-bundle.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/core/uninstall.js'` and `Error: Cannot find module '../../src/core/support-bundle.js'`; no test runs.

- [ ] **Step 3: Unregister any server the engine registered, by name**

In `src/core/disconnect.ts`, replace:

```ts
async function unregisterEverywhere(home: string, profileId: string | null | undefined): Promise<{ readonly unregistered: boolean; readonly note?: string }> {
```

with:

```ts
export async function unregisterEverywhere(home: string, profileId: string | null | undefined, name: string = SKILLSWIKI_MCP_NAME): Promise<{ readonly unregistered: boolean; readonly note?: string }> {
```

In `src/core/disconnect.ts`, replace:

```ts
    for (const profile of profiles) unregistered = (await unregisterMcp(profile, SKILLSWIKI_MCP_NAME, home)) || unregistered;
    return { unregistered };
  } catch (error) {
    return { unregistered: false, note: `Could not remove the agent's Skills Wiki registration (${(error as Error).message})` };
```

with:

```ts
    for (const profile of profiles) unregistered = (await unregisterMcp(profile, name, home)) || unregistered;
    return { unregistered };
  } catch (error) {
    return { unregistered: false, note: `Could not remove the agent's '${name}' registration (${(error as Error).message})` };
```

- [ ] **Step 4: Uninstall**

Create `src/core/uninstall.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { AUDIT_FILE, appendAudit, verifyAudit, withAuditLock } from "./audit.js";
import { CHANNEL_IDS } from "./channels.js";
import { CONNECTOR_SECRETS } from "./connectors.js";
import { unregisterEverywhere } from "./disconnect.js";
import { ActionFailure } from "./failure.js";
import { stopGateway } from "./gateway-process.js";
import { serviceCommand, type ServiceOptions } from "./host-service.js";
import { InputError } from "./inputs.js";
import { deleteSecret } from "./keychain.js";
import { MODEL_SECRET_ID } from "./model.js";
import { setPaused } from "./pause.js";
import { TOOLS_MCP_NAME } from "./register.js";
import { scheduleCommand } from "./scheduler.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID } from "./skillswiki.js";
import { loadState } from "./state.js";

/**
 * `installer uninstall` (spec §16.4, D34, D109): removes the engine's body and keeps the records. In order: pause, so
 * nothing goes out from here on (D101); stop the gateway; remove the agent's MCP registrations (`skillswiki`,
 * `installer`); delete the keychain items the engine stored; delete the schedule and boot service files it wrote
 * under the home; audit it; export the audit to `exports/`. It prints the OS commands that unload what a person
 * loaded, because the engine never changes the OS itself. Business records (the client's sheets and mailboxes,
 * `data/`, run logs) are not touched, and the home stays until the person deletes it. Only a person, in a terminal.
 */
export const EXPORTS_DIR = "exports";
export const ENGINE_SECRETS: readonly string[] = [SKILLSWIKI_SECRET_ID, ...CHANNEL_IDS, ...Object.values(CONNECTOR_SECRETS), MODEL_SECRET_ID];

type Env = Readonly<Record<string, string | undefined>>;
const stamp = (now: string): string => now.replace(/[:.]/g, "-");

/** A copy of the audit under `exports/` (0600), taken under the audit lock, with its chain checked. */
export async function exportAudit(home: string, now: string): Promise<{ file: string; lines: number; chain: string }> {
  const target = await confinedPath(home, join(EXPORTS_DIR, `audit-${stamp(now)}.jsonl`));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const check = await withAuditLock(home, async () => {
    await writeFile(target, await readFile(await confinedPath(home, AUDIT_FILE), "utf8"), { encoding: "utf8", mode: 0o600 });
    return verifyAudit(home);
  });
  return { file: target, lines: check.ok ? check.lines : 0, chain: check.ok ? "intact" : `broken at line ${check.line}: ${check.reason}` };
}

async function deleteSecrets(env: Env | undefined): Promise<Record<string, string>> {
  const outcome: Record<string, string> = {};
  for (const id of ENGINE_SECRETS) {
    try {
      outcome[id] = (await deleteSecret(id, env)) ? "deleted" : "none";
    } catch (error) {
      if (!(error instanceof ActionFailure)) throw error;
      outcome[id] = `not deleted: ${error.message}`;
    }
  }
  return outcome;
}

/** The schedule entry and the boot services: files under the home go, the OS commands are printed. */
async function osCommands(home: string, now: () => string, options: ServiceOptions): Promise<string[]> {
  const commands: string[] = [];
  for (const remove of [() => scheduleCommand(home, "remove", undefined, now, options), () => serviceCommand(home, "remove", options, now)]) {
    try {
      commands.push(...((await remove()).commands as string[]));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return commands;
}

export async function uninstall(home: string, person: { interactive: boolean; as?: string }, now: () => string, options: ServiceOptions & { env?: Env } = {}): Promise<Record<string, unknown>> {
  if (!person.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "engine.uninstall_refused", ref: "uninstall", payload: { command: "installer uninstall" } });
    throw new InputError("Uninstalling removes the engine's registrations, keys and schedules: the person runs 'installer uninstall' in their own terminal");
  }
  const by = person.as?.trim() || "terminal";
  await setPaused(home, true, { name: by, actor: "human", via: "cli" }, now(), "uninstall");
  const gateway = (await stopGateway(home, now)).status;
  const profile = (await loadState(home))?.runtime?.profile;
  const unregistered = { [SKILLSWIKI_MCP_NAME]: await unregisterEverywhere(home, profile, SKILLSWIKI_MCP_NAME), [TOOLS_MCP_NAME]: await unregisterEverywhere(home, profile, TOOLS_MCP_NAME) };
  const secrets = await deleteSecrets(options.env);
  const commands = await osCommands(home, now, options);
  await appendAudit(home, { ts: now(), actor: "human", event: "engine.uninstalled", ref: "uninstall", payload: { by, gateway, unregistered, secrets } });
  return {
    status: "uninstalled", gateway, unregistered, secrets, audit_export: await exportAudit(home, now()), commands,
    kept: ["the client's own sheets and mailboxes (never touched)", "data/ and runs/ under the home", "the audit, exported as above"],
    note: "Run the printed commands in your own terminal to unload what was loaded into the OS; once you have kept the audit export, delete the home folder yourself.",
  };
}
```

- [ ] **Step 5: The support bundle**

Numbers of seven digits or more go, but a date never does, and neither does a version such as `v22.14.0`; an email pattern needs a letter domain, so `fixture@1.0.0` stays.

Create `src/core/support-bundle.ts`:

```ts
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { listApprovals } from "./approvals.js";
import { AUDIT_FILE, appendAudit, verifyAudit, withAuditLock } from "./audit.js";
import { listChannels } from "./channels.js";
import { loadReportConfig } from "./daily-report.js";
import { SOURCES_DIR, readConfig } from "./data-source.js";
import { loadDoctorReport } from "./doctor.js";
import { LOG_FILE } from "./gateway.js";
import { READINESS_FILE } from "./host.js";
import { INBOX_DIR } from "./inbox.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { personalFields } from "./learning.js";
import { listMembers } from "./members.js";
import { loadModelConfig } from "./model.js";
import { listIds } from "./numbered.js";
import { OUTBOX_DIR } from "./outbound.js";
import { loadPacks } from "./packs.js";
import { loadPause } from "./pause.js";
import { loadPinnedSolution } from "./pin.js";
import { buildReport } from "./report.js";
import { loadRetention } from "./retention.js";
import { listRuns } from "./runs.js";
import { loadSandboxMode } from "./sandbox.js";
import { TICK_LOG } from "./scheduler.js";
import { loadState } from "./state.js";
import type { InstallState } from "./types.js";
import { ENGINE_SECRETS, EXPORTS_DIR } from "./uninstall.js";

/**
 * `installer support bundle` (spec §16.5, D34, D110): one JSON file under `exports/` that the person reads and sends
 * to whoever supports their install; nothing is sent by the engine and there is no remote access. It holds the
 * install's shape (versions, step statuses, report, doctor and readiness findings, recent run summaries, settings,
 * counts, the audit check, the tails of the gateway and tick logs) and never a secret, a person's name or address,
 * a message, a record or an answer: answers are left out, settings are copied field by field, every member's name and
 * address, the decision maker, the sheet ids and the OS user's home folder are replaced wherever they appear, and so
 * are email addresses, long numbers and the values of fields the contract tags personal or protected_ground.
 */
const REDACTED = "[redacted]";
const LOG_LINES = 50;
const RECENT_RUNS = 20;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (values: readonly string[]): Record<string, number> => values.reduce<Record<string, number>>((all, value) => ({ ...all, [value]: (all[value] ?? 0) + 1 }), {});

/** Known names first, then emails, then numbers of seven digits or more (phones, accounts) that are not a date. */
function scrubText(text: string, known: readonly string[]): string {
  const named = known.reduce((out, value) => out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, "giu"), REDACTED), text.split(homedir()).join("~"));
  const long = (match: string): boolean => match.replace(/\D/g, "").length >= 7 && !/^\d{4}-\d{2}-\d{2}/.test(match);
  return named.replace(/[^\s@"'()]+@[^\s@"'()]+\.[A-Za-z]{2,}\b/g, "[email]").replace(/\+?\d[\d\s().-]{5,}\d/g, (match) => (long(match) ? "[number]" : match));
}

export function scrub(value: unknown, known: readonly string[], fields: ReadonlySet<string>): unknown {
  if (typeof value === "string") return scrubText(value, known);
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, known, fields));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fields.has(key) ? REDACTED : scrub(entry, known, fields)]));
}

/** Names and addresses this home knows about, longest first, so a full name is replaced before a part of it. */
async function knownValues(home: string, state: InstallState, now: string): Promise<string[]> {
  const members = await listMembers(home, now);
  const channels = await listChannels(home);
  const report = await loadReportConfig(home);
  const values = [
    ...(state.roles ? [state.roles.decision_maker] : []), ...members.flatMap((member) => [member.name, ...(member.identity ? [member.identity.address] : [])]),
    ...channels.flatMap((config) => (config.channel === "email" ? [config.address, config.imap.user, config.smtp.user] : [config.bot.username])),
    ...(report?.recipients.map((recipient) => recipient.member) ?? []), ...(await sheetIds(home)),
  ];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))].sort((a, b) => b.length - a.length);
}

/** The spreadsheet ids of the connected sources: they point at the client's own records. */
async function sheetIds(home: string): Promise<string[]> {
  const names = await readdir(await confinedPath(home, SOURCES_DIR)).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const source = (await readConfig(home, join(SOURCES_DIR, name))) as Raw | null;
    if (typeof source?.spreadsheet_id === "string") ids.push(source.spreadsheet_id);
  }
  return ids;
}

async function tail(home: string, relative: string): Promise<string[]> {
  const text = await readFile(await confinedPath(home, relative), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").slice(-LOG_LINES);
}

/** The install state without any answer a person gave. */
const stateView = (state: InstallState) => ({
  solution: state.solution, started_at: state.started_at, mode: state.mode ?? null, runtime: state.runtime ?? null, work_dir: state.work_dir ?? null, audit_head: state.audit_head ?? null,
  steps: Object.fromEntries(Object.entries(state.steps).map(([id, { value: _answer, ...record }]) => [id, record])),
});

async function settings(home: string): Promise<Raw> {
  const channels = (await listChannels(home)).map((config) => ({ channel: config.channel, verified_at: config.verified_at, ...(config.channel === "email" ? { imap: { host: config.imap.host, port: config.imap.port, security: config.imap.security }, smtp: { host: config.smtp.host, port: config.smtp.port, security: config.smtp.security } } : {}) }));
  const model = await loadModelConfig(home);
  const report = await loadReportConfig(home);
  const packs = Object.fromEntries(Object.entries(await loadPacks(home)).map(([pack, pin]) => [pack, { version: pin.version, candidate: pin.candidate?.version ?? null }]));
  return {
    channels, model: model ? { provider: model.provider, model: model.model } : null, report: report ? { times: report.times, recipients: report.recipients.length } : null,
    sandbox: await loadSandboxMode(home), pause: await loadPause(home), retention: await loadRetention(home), packs,
  };
}

async function counts(home: string, now: string): Promise<Raw> {
  const members = await listMembers(home, now);
  return {
    approvals: count((await listApprovals(home, now)).map((item) => item.status)), members: count(members.map((member) => `${member.role} ${member.status}`)),
    inbox: (await listIds(home, INBOX_DIR)).length, recordings: (await listIds(home, OUTBOX_DIR)).length,
  };
}

async function runsView(home: string): Promise<Raw> {
  const runs = await listRuns(home, undefined, async () => undefined);
  const recent = runs.slice(-RECENT_RUNS).map((run) => ({ workflow: run.workflow, run_id: run.run_id, status: run.status, trigger: run.trigger.kind, started_at: run.started_at, finished_at: run.finished_at ?? null, sandbox: run.sandbox, actions: run.actions, needs_human: run.needs_human, reason: run.reason ?? null }));
  return { by_status: count(runs.map((run) => run.status)), recent };
}

async function auditView(home: string, state: InstallState): Promise<Raw> {
  const check = await withAuditLock(home, () => verifyAudit(home, state.audit_head));
  const lines = (await readFile(await confinedPath(home, AUDIT_FILE), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  return { check, events: count(lines.map((line) => String((JSON.parse(line) as Raw).event))) };
}

async function bundleOf(home: string, state: InstallState, now: string): Promise<Raw> {
  const { solution } = await loadPinnedSolution(home);
  const secrets = Object.fromEntries(await Promise.all(ENGINE_SECRETS.map(async (id) => [id, (await getSecret(id)) !== null])));
  return {
    format: 1, created_at: now, versions: { node: process.version, platform: `${process.platform} ${process.arch}` },
    state: stateView(state), report: buildReport(solution, state), doctor: await loadDoctorReport(home), readiness: await readConfig(home, READINESS_FILE),
    runs: await runsView(home), settings: await settings(home), counts: await counts(home, now), audit: await auditView(home, state),
    secrets_present: secrets, logs: { gateway: await tail(home, LOG_FILE), tick: await tail(home, TICK_LOG) },
  };
}

/** `installer support bundle`: writes the redacted file and says where it is; changes nothing else. */
export async function supportBundle(home: string, now: () => string): Promise<Record<string, unknown>> {
  const state = await loadState(home);
  if (!state) throw new InputError("No install found in this home; run 'installer start --solution <ref>' first");
  const at = now();
  const known = await knownValues(home, state, at);
  const fields = personalFields((await loadPinnedSolution(home)).solution.data_contract ?? null);
  const bundle = scrub(await bundleOf(home, state, at), known, fields) as Raw;
  const file = await confinedPath(home, join(EXPORTS_DIR, `support-${at.replace(/[:.]/g, "-")}.json`));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await appendAudit(home, { ts: at, actor: "engine", event: "support.bundle_written", ref: EXPORTS_DIR, payload: { sections: Object.keys(bundle) } });
  return { status: "written", file, sections: Object.keys(bundle), note: "Read it first, then send this file yourself to whoever supports your install. It holds no secrets, names, addresses, messages or records (D110)." };
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/unit/uninstall.test.ts tests/unit/support-bundle.test.ts tests/unit/disconnect-connector.test.ts`
Expected: PASS, 7 tests (6 new and the disconnect test, unchanged).

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 92 files, 1237 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/uninstall.ts src/core/support-bundle.ts src/core/disconnect.ts tests/unit/uninstall.test.ts tests/unit/support-bundle.test.ts
git commit -m "feat(core): add uninstall and the support bundle"
```

---

### Task 9: The CLI, INSTALL.md section 10 and the live pin read (§6.6, D101–D110)

**Files:**
- Create: `tests/e2e/operations-cli.test.ts`, `tests/live/packs.live.test.ts`
- Modify: `src/cli.ts`, `INSTALL.md`, `tests/e2e/install-doc.test.ts`

**Interfaces:**
- Consumes: `doctorCommand` (Task 3), `pauseCommand`, `unpauseCommand` (Task 1), `hostCommand` (Task 4), `packsCommand` (Task 7), `retentionCommand` (Task 2), `supportBundle`, `uninstall` (Task 8).
- Produces: CLI commands `doctor` (standalone: it reads the state itself), `pause [status]`, `unpause`, `host [service install | remove]`, `packs [list | check | shadow <pack> | switch <pack>]`, `retention [--value <days>]`, `support bundle`, `uninstall`.

- [ ] **Step 1: Write the failing tests**

The CLI runs from `dist/` without a terminal on stdin, like an agent's shell, so every command that loosens safety exits 2 there.

Create `tests/e2e/operations-cli.test.ts`:

```ts
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { STATE_FILE } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** A started install of the basic fixture; the CLI runs without a terminal on stdin, like an agent's shell. */
async function install(): Promise<string> {
  const home = await makeTempHome();
  expect(runCli(["start", "--solution", FIXTURE_REF], { home }).code).toBe(0);
  return home;
}

const audited = async (home: string, event: string): Promise<boolean> => (await readFile(join(home, AUDIT_FILE), "utf8")).includes(`"event":"${event}"`);

describe("installer doctor, pause, host, packs, retention, support and uninstall (§6.6, D101–D110)", () => {
  it("pauses from the agent's shell, and leaves unpausing to a person's terminal", async () => {
    const home = await install();
    expect(runCli(["pause", "--reason", "checking"], { home }).json).toMatchObject({ status: "paused", by: "agent", reason: "checking" });
    const refused = runCli(["unpause"], { home });
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ error: expect.stringContaining("in their own terminal") });
    expect(await audited(home, "engine.unpause_refused")).toBe(true);
    expect(runCli(["pause", "status"], { home }).json).toMatchObject({ pause: { paused: true } });
    expect(runCli(["tick"], { home }).json).toMatchObject({ status: "paused" });
  });

  it("runs the doctor, reports a damaged state instead of stopping, and never reads the real OS here", async () => {
    const home = await install();
    const report = runCli(["doctor"], { home });
    expect(report.code).toBe(0);
    expect(report.json).toMatchObject({ checks: expect.arrayContaining([{ id: "host", status: "ok", detail: "host readiness not checked here (INSTALLER_HOST_CHECKS=none)" }]) });
    await writeFile(join(home, STATE_FILE), "{");
    const damaged = runCli(["doctor"], { home });
    expect(damaged.code).toBe(0);
    expect(damaged.json).toMatchObject({ status: "fail", checks: expect.arrayContaining([expect.objectContaining({ id: "state", status: "fail" })]) });
    expect(runCli(["doctor"], { home: await makeTempHome() }).code).toBe(2);
  });

  it("refuses a shorter retention, a pack switch and an uninstall from the agent's shell", async () => {
    const home = await install();
    expect(runCli(["retention", "--value", "120"], { home }).json).toMatchObject({ status: "saved", retention: { days: 120 } });
    expect(runCli(["retention", "--value", "30"], { home }).code).toBe(2);
    expect(runCli(["packs", "switch", "demo"], { home }).code).toBe(2);
    expect(runCli(["uninstall"], { home }).code).toBe(2);
    expect([await audited(home, "retention.refused"), await audited(home, "pack.switch_refused"), await audited(home, "engine.uninstall_refused")]).toEqual([true, true, true]);
    expect(runCli(["packs"], { home }).json).toMatchObject({ packs: [] });
  });

  it("writes a support bundle, prints the boot service commands, and adds the operations to the report", async () => {
    const home = await install();
    const bundle = runCli(["support", "bundle"], { home }).json as { file: string };
    await access(bundle.file);
    expect(runCli(["support"], { home }).code).toBe(2);
    expect(runCli(["host"], { home }).json).toMatchObject({ status: "skipped" });
    const service = runCli(["host", "service", "install"], { home }).json as { commands: string[] };
    expect(service.commands.some((command) => command.startsWith("sudo "))).toBe(true);
    expect(runCli(["report", "--json"], { home }).json).toMatchObject({ operations: { paused: null, data_flow: [expect.objectContaining({ party: "Support (only when you send it)" })] } });
    expect(runCli(["report"], { home }).stdout).toContain("🔀 Data flow");
  });
});
```

In `tests/e2e/install-doc.test.ts`, replace:

```ts
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe", "secret", "disconnect", "tool", "approvals", "connect", "map", "channel", "invite", "members", "gateway", "run", "schedule", "model", "workflow", "dryrun", "sandbox", "harden", "autonomy", "alerts", "learnings"];
```

with:

```ts
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe", "secret", "disconnect", "tool", "approvals", "connect", "map", "channel", "invite", "members", "gateway", "run", "schedule", "model", "workflow", "dryrun", "sandbox", "harden", "autonomy", "alerts", "learnings", "doctor", "pause", "unpause", "host", "packs", "retention", "support", "uninstall"];
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/e2e/operations-cli.test.ts`
Expected: FAIL — `Unknown command 'pause'`; 4 tests fail.

- [ ] **Step 3: The commands**

In `src/cli.ts`, replace:

```ts
import { gatewayCommand, serveGateway } from "./core/gateway-process.js";
import { hardenCommand } from "./core/hardening.js";
```

with:

```ts
import { doctorCommand } from "./core/doctor.js";
import { gatewayCommand, serveGateway } from "./core/gateway-process.js";
import { hardenCommand } from "./core/hardening.js";
import { hostCommand } from "./core/host.js";
```

In `src/cli.ts`, replace:

```ts
import { loadPinnedSolution, writePinnedSolution } from "./core/pin.js";
```

with:

```ts
import { pauseCommand, unpauseCommand } from "./core/pause.js";
import { loadPinnedSolution, writePinnedSolution } from "./core/pin.js";
import { retentionCommand } from "./core/retention.js";
import { packsCommand } from "./core/shadow.js";
import { supportBundle } from "./core/support-bundle.js";
import { uninstall } from "./core/uninstall.js";
```

In `src/cli.ts`, replace:

```ts
const COMMANDS = "start, next, submit, verify, resume, report, probe, secret, disconnect, tool, approvals, connect, map, channel, invite, members, gateway, run, tick, schedule, model, workflow, dryrun, sandbox, harden, autonomy, alerts, learnings";
```

with:

```ts
const COMMANDS = "start, next, submit, verify, resume, report, probe, secret, disconnect, tool, approvals, connect, map, channel, invite, members, gateway, run, tick, schedule, model, workflow, dryrun, sandbox, harden, autonomy, alerts, learnings, doctor, pause, unpause, host, packs, retention, support, uninstall";
```

In `src/cli.ts`, add after:

```ts
  disconnect: (home, _flags, arg) => disconnect(home, requireArg(arg, "disconnect"), () => new Date().toISOString()),
```

this:

```ts
  /** D103: reads the state itself, so a damaged state is a finding, not an exit 3. */
  doctor: (home) => doctorCommand(home, () => new Date().toISOString()),
```

In `src/cli.ts`, add after:

```ts
  learnings: async ({ deps }) => ({ learnings: await listLearnings(deps.home) }),
```

this:

```ts
  pause: async ({ deps }, flags, arg) => pauseCommand(deps.home, arg, person(flags), flags.reason, deps.now),
  unpause: async ({ deps }, flags) => unpauseCommand(deps.home, person(flags), deps.now),
  host: async ({ deps }, _flags, arg, extra) => hostCommand(deps.home, arg, extra, deps.now),
  packs: async ({ state, deps }, flags, arg, extra) => packsCommand(deps.home, arg, extra, state.roles, person(flags), deps.now),
  retention: async ({ deps }, flags) => retentionCommand(deps.home, flags.value, person(flags), deps.now),
  support: async ({ deps }, _flags, arg) => {
    if (arg !== "bundle") throw new InputError("support takes: bundle");
    return supportBundle(deps.home, deps.now);
  },
  uninstall: async ({ deps }, flags) => uninstall(deps.home, person(flags), deps.now),
```

- [ ] **Step 4: The opt-in live read**

It reads one skill file twice and compares the sha256s; it is not part of the offline run.

Create `tests/live/packs.live.test.ts`:

```ts
/**
 * Opt-in live test of pack pinning (D48, D107): `npm run test:live` with SKILLSWIKI_API_KEY, SKILLSWIKI_MCP_URL and
 * SKILLSWIKI_LIVE_FILE=<pack>/<skill>/<path> in the environment reads ONE skill file twice through
 * `get_skill_resource` and checks that its text, and so its sha256 pin, is the same both times: content pinning
 * would otherwise see a new version on every check. Read-only: nothing is written to Skills Wiki. Skipped when a
 * variable is empty.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchSkillswikiSolution } from "../../src/core/skillswiki.js";

const KEY = process.env.SKILLSWIKI_API_KEY ?? "";
const URL = process.env.SKILLSWIKI_MCP_URL ?? "";
const RESOURCE = process.env.SKILLSWIKI_LIVE_FILE ?? "";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe.skipIf(!KEY || !URL || RESOURCE.split("/").length < 3)("Skills Wiki skill files pin by content (D107)", () => {
  it("serves the same text twice, so its sha256 pin is stable", async () => {
    const target = { url: URL, key: KEY };
    const first = await fetchSkillswikiSolution(target, `skillswiki:${RESOURCE}`);
    const second = await fetchSkillswikiSolution(target, `skillswiki:${RESOURCE}`);
    expect(first.length).toBeGreaterThan(0);
    expect(sha256(second)).toBe(sha256(first));
  });
});
```

- [ ] **Step 5: INSTALL.md section 10**

In `INSTALL.md`, replace:

```markdown
4. **Later.** `installer harden <id>` shows when the runner can turn calls the model repeats into fixed steps, and whether they pass the replay check; the person applies it in their own terminal. `installer autonomy` shows how many approvals in a row a step has; only the decision maker grants earned autonomy. `installer alerts` lists urgent alerts (the decision maker answers K<id> in Telegram to acknowledge one), and `installer learnings` lists the corrections, with personal data removed, sent to Skills Wiki.
```

with:

```markdown
4. **Later.** `installer harden <id>` shows when the runner can turn calls the model repeats into fixed steps, and whether they pass the replay check; the person applies it in their own terminal. `installer autonomy` shows how many approvals in a row a step has; only the decision maker grants earned autonomy. `installer alerts` lists urgent alerts (the decision maker answers K<id> in Telegram to acknowledge one), and `installer learnings` lists the corrections, with personal data removed, sent to Skills Wiki.

## 10. Health, the kill switch and support

1. **Health.** `installer doctor` checks the audit chain, the install state and its backup, the keychain items, Skills Wiki and each channel, the runner's last tick, the gateway, disk space and the host; it clears run claims a crash left behind and deletes run logs, messages and recordings older than the retention period (`installer retention`, 90 days unless the person sets another; the audit is never deleted). The runner also runs it once a day and tells the decision maker when something failed. Show the person each finding and its fix.
2. **The host.** On a team host, `installer host` reads the settings that keep the assistant running and prints the fix for each one that is not right, and the steps for a dedicated OS user; `installer host service install` writes the boot services and prints their `sudo` commands. Never run those commands yourself: the person runs them in their own terminal.
3. **Kill switch.** When the person wants everything to stop, run `installer pause`: nothing is sent and no workflow runs, while incoming messages are still kept. Only the person starts it again, with `installer unpause` in their own terminal, or the decision maker with /unpause in Telegram.
4. **Skills Wiki versions.** Judges use the text of each skill file as it was when first used. `installer packs` lists these pins; when Skills Wiki has a new version, the doctor tries it in sandbox and only the decision maker switches to it, in their own terminal (`installer packs switch <pack> --as <their name>`).
5. **Support and removal.** `installer support bundle` writes a file without secrets or personal data that the person may send for help. `installer uninstall`, in the person's own terminal only, removes the engine's registrations, keys and schedules, exports the audit and keeps the records.
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/e2e/operations-cli.test.ts tests/e2e/install-doc.test.ts tests/e2e/cli.test.ts`
Expected: PASS, 57 tests (4 new, the 7 install-doc tests and the 46 `cli.test.ts` tests).

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 93 files, 1241 tests pass (the live file is not part of the offline run).

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts INSTALL.md tests/e2e/operations-cli.test.ts tests/e2e/install-doc.test.ts tests/live/packs.live.test.ts
git commit -m "feat(cli): add doctor, pause, host, packs and more"
```

---

### Task 10: Decisions D101–D111, spec, roadmap, live test guide and human tasks

**Files:**
- Create: `docs/testing/2026-10-09-plan-9-live-test.md`
- Modify: `DECISIONS.md`, `docs/superpowers/specs/2026-10-06-installer-design.md`, `docs/superpowers/plans/README.md`, `docs/human-tasks.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the decision log, spec and roadmap describe what Tasks 1–9 built; a live guide that runs the doctor and host readiness on the developer's own Mac (read only), the kill switch, the boot service files, the support bundle's redaction and uninstall inside a test folder; human tasks to run it, and to set up a team host. No code changes.

- [ ] **Step 1: Record D101–D111**

The status line names the new decisions and Plan 9's branch; D99's last sentence points at the decisions that took its two items; the new rows go directly after D100.

In `DECISIONS.md`, replace:

```markdown
- Status: Design D1–D100. Implementation plans: `docs/superpowers/plans/` (roadmap + Plans 1–8). Plan 1 (engine core) implemented on branch `feat/engine-core`, Plan 2 on `feat/runtime-conformance`, Plan 3 on `feat/brain-secrets`, Plan 4 on `feat/approvals`, Plan 5 on `feat/connectors-data`, Plan 6 on `feat/gateway-channels`, Plan 7 on `feat/workflow-runner`, Plan 8 on `feat/workflow-lifecycle`.
```

with:

```markdown
- Status: Design D1–D111. Implementation plans: `docs/superpowers/plans/` (roadmap + Plans 1–9). Plan 1 (engine core) implemented on branch `feat/engine-core`, Plan 2 on `feat/runtime-conformance`, Plan 3 on `feat/brain-secrets`, Plan 4 on `feat/approvals`, Plan 5 on `feat/connectors-data`, Plan 6 on `feat/gateway-channels`, Plan 7 on `feat/workflow-runner`, Plan 8 on `feat/workflow-lifecycle`, Plan 9 on `feat/operations`.
```

In `DECISIONS.md`, replace:

```markdown
| D99 | **O12 thresholds, first pass.** Hardening N = 5 runs, replay K = 10 runs, earned-autonomy streak 25, urgent alert repeats every 10 minutes (6 sends), reminders at 12 hours (urgent every 5 minutes, 3 times), rate limits 3 a day per contact and 20 an hour, event runs 3 per sender and 30 per workflow an hour, agent calls 8 per step (at most 20). Chosen to be conservative; they are constants in the engine (rate limits and `max_turns` per recipe) and are tuned after a pilot. The 60 s cache and the 90-day retention are Plan 9's. | 2026-10-08 |
| D100 | **Left for later by Plan 8.** Model-chosen context tools for judges (§10.4; agents choose calls instead, D92); conversations with the agent from a member's channel (§12.3); re-subscribing after an opt-out; urgent alerts in the twice-daily report; `doctor` announcing hardening proposals and re-running evals (§10.10, Plan 9). | 2026-10-08 |
```

with:

```markdown
| D99 | **O12 thresholds, first pass.** Hardening N = 5 runs, replay K = 10 runs, earned-autonomy streak 25, urgent alert repeats every 10 minutes (6 sends), reminders at 12 hours (urgent every 5 minutes, 3 times), rate limits 3 a day per contact and 20 an hour, event runs 3 per sender and 30 per workflow an hour, agent calls 8 per step (at most 20). Chosen to be conservative; they are constants in the engine (rate limits and `max_turns` per recipe) and are tuned after a pilot. The 90-day retention arrived with Plan 9 (D102); the 60 s cache is left for later (D111). | 2026-10-08 |
| D100 | **Left for later by Plan 8.** Model-chosen context tools for judges (§10.4; agents choose calls instead, D92); conversations with the agent from a member's channel (§12.3); re-subscribing after an opt-out; urgent alerts in the twice-daily report; `doctor` announcing hardening proposals and re-running evals (§10.10, Plan 9). | 2026-10-08 |
| D101 | **The kill switch (§14.4, D34, D36).** `config/pause.json` (`{"paused","at","by","via","reason"?}`; no file means running). While paused: `outboundBlock` answers "paused" first, so every message (the gateway's announcements and answers too) is recorded in `sandbox/outbox/`, never sent; the gate refuses every call above L0 that is not a message tool (`tool.refused`), so nothing changes in the client's systems; `startRun` refuses, so `installer run`, dry runs and shadow runs do too; the tick writes only `alive` in the heartbeat and returns `paused`, so no run starts or resumes, and slots that fall due meanwhile are recorded `missed` after the unpause (D38) with no back-online notice; the gateway keeps receiving, so inbound is still logged. `installer pause [--reason]` may come from anyone, the agent included (stopping is always safe), and `installer pause status` shows it; `installer unpause` sends real messages again, so it needs a person's terminal (D61; an agent's attempt exits 2 and is audited `engine.unpause_refused`). From a channel, `/pause` and `/unpause` as the whole first line (a fourth command shape next to D76's three; `@<bot>` allowed) work only for the decision maker on a channel that proves the sender (Telegram, D78); anyone else's is refused and audited (`engine.switch_refused`), and a stranger's is an ordinary message. The answer to `/pause` is sent before the switch closes (a failed send never stops the pause), the answer to `/unpause` after it opens. Audit: `engine.paused`, `engine.unpaused`. | 2026-10-09 |
| D102 | **Retention (§14.5, D86).** `config/retention.json` (`{"days","at","by"}`; default 90, from 7 to 3650). `installer retention [--value <days>]` shows or sets it; a longer period may come from anywhere, a shorter one deletes data sooner, so it needs a person's terminal (audited `retention.refused`). `installer doctor` deletes what is older: finished runs (by their end) with their idempotency key, the key first so a crash never leaves a claim without its run; inbound messages, recordings in the sink and sent-message counts, always keeping the newest of each numbered folder so ids keep growing (cursors compare ids); the gateway's seen-message markers. The sender of a deleted message is kept as an empty first-contact marker (`data/channels/first-contact/`), so `consent: inbound_first` (D80) outlives the message. The audit is never deleted (it is exported, D109); business records are never touched. Audit: `retention.set`, `retention.pruned` with the counts. | 2026-10-09 |
| D103 | **`installer doctor` (§16.1).** Its checks, in order, each `ok`, `warn`, `fail` or `fixed` with a fix: the install state and its backup (doctor reads the state itself and needs no loaded install, so a damaged state is a finding, not exit 3), the audit chain against the recorded head (under the audit lock), the kill switch, the keychain items this install uses (Skills Wiki, each channel, each connected source's sign-in, the direct model), Skills Wiki (`get_active_combo`), pinned packs (D107, D108), each channel (Telegram `getMe`; IMAP sign-in and EXAMINE plus SMTP sign-in; nothing sent or saved), the runner's last tick, the gateway, free disk space (1 GiB), host readiness (D104), run claims, run records with the last 24 hours' failed and missed runs and report fallbacks, retention (D102), and hardening proposals that are ready (D100). Run claims: a key claimed by a process that died before writing its `run.json` can never be run again (Plan 7 review); doctor clears such claims once they are 5 minutes old (younger ones may still be being written) and audits `run.claim_cleared`. Damaged run records, which the tick skips, are named. A check that cannot finish becomes a `fail` finding, never a crash. The result is kept in `state/doctor/last.json` and audited (`doctor.ran`, not when the audit check failed). The tick runs it once a day (the first tick only sets the time, `state/doctor/next.json`) and tells the decision maker what failed (`doctor.notified`). Also from Plan 6's review: the gateway's pid file is claimed with an exclusive create, so of two starts at the same moment one gateway runs and the other start reports it. | 2026-10-09 |
| D104 | **Host readiness, Layer 1 (§5.1, D42, D43).** On a Team host or Hybrid host the engine reads, through an injectable `CommandRunner`: on macOS `pmset -g` (`sleep 0`, `autorestart 1`), `systemsetup -getusingnetworktime` and `fdesetup status`; on Linux `systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target` (all masked), `timedatectl show -p NTPSynchronized --value` and `lsblk -rno TYPE` (a `crypt` volume); and whether the boot service files exist. Each wrong setting gets its fix printed (for example `sudo pmset -a sleep 0`) for a person with administrator rights to run in their own terminal; the engine never runs `sudo` and never changes the OS. A setting it cannot read is `unknown` and not scored; Linux's firmware power setting is `manual`; OS updates in the quiet window (the longest gap in the next 24 hours between cron runs and report times) and a wired network with a UPS are advice. The score (`ok` out of `ok` and `fix`) is kept in `state/doctor/host.json`, re-checked by the daily doctor and shown in the report. Personal mode: information only, no fixes. `installer host` prints it all; `installer host service install | remove` writes the boot services under `runtime/service/` (macOS LaunchDaemons with `UserName`: the gateway with `KeepAlive`, the tick every 60 s; Linux: a systemd unit for the gateway with `Restart=always`, while the tick stays the engine user's crontab, which cron runs from boot) and prints the `sudo` commands. The test suite sets `INSTALLER_HOST_CHECKS=none`, so it never runs a real OS command. Windows: not supported yet. | 2026-10-09 |
| D105 | **The dedicated engine OS user (D34, D50, D61): documented and printed, never created.** On a Team host, `installer host` prints the steps: a standard (never administrator) user `installer-engine` owns the engine home, its keychain items and the agent's MCP servers; the install and the boot services run as that user; people decide approvals from Telegram, where the sender is proven. Known limit, unchanged: the agent runs as that same user, so the terminal-only checks are no boundary against it (D61); moving the agent to its own OS user with a `sudo` rule limited to `mcp-serve` is left for later (D111). | 2026-10-09 |
| D106 | **The data-flow summary in the report (§14.6).** `installer report` adds, without changing the pure `buildReport` (R6 depends on it): the kill switch, the last doctor run, the host readiness score, and which tagged fields go to which outside party, worked out from the pinned contract and what is set up. The model vendor (through the agent's headless calls or the direct model) gets what judges and agents are given, never `protected_ground` fields; each connected source gets every field of its entity; each channel gets the text of the messages sent (outside contacts' approved first, L2); Skills Wiki gets skill requests and redacted learnings, never records, secrets, inbound messages or the audit (§13.3); support gets a bundle only when the person sends one. `report --json` holds it as `operations`. | 2026-10-09 |
| D107 | **Pack pinning by content (§14.3).** Skills Wiki's MCP answers carry no version: `skill_pack_meta.commit_sha` is read only by its own scripts (checked in its source on 2026-10-09), and `get_skill_resource` answers `{path, kind, content}` with a fixed wrapper. So the engine pins by content: the first time a judge needs a file of a pack it fetches it, keeps the text under `packs/<pack>/<sha256>` (0600) and records `{version, files, pinned_at}` in `config/packs.json` (`version` = the sha256 of the files' sha256s); from then on judges read the pinned copy, whatever Skills Wiki serves, and a copy that changed on disk is never used. `installer packs check` and the daily doctor fetch every pinned file again; different text becomes the pack's `candidate`, which only shadow runs read (D108). The opt-in live test checks that the served text is stable (two reads, one sha256). Recording `commit_sha` too needs Skills Wiki to serve it (§13.4). | 2026-10-09 |
| D108 | **The shadow upgrade and its evals (§14.3).** `installer packs shadow <pack>`, and the doctor for every new candidate, runs each workflow whose judges read the pack twice, as sandbox runs with their own keys: on the pinned text and on the candidate (`RunRecord.shadow`), so nothing is sent or changed. Every `ShadowEval` grades the comparison (status, actions, recordings, answers needing a person); v1 has one, `shadow-runs`, which passes when each candidate run completed and needs a person no more often than the pinned one. Skills Wiki's hosted evals (`eval_start`, `eval_outputs`, `eval_submit`, `eval_status`) are not used: a model has to answer and grade their tasks in a conversation, they are switched on per user, and the test double has none (O11 stays open); the interface takes them later. The result is kept with the candidate and a pass is announced to the decision maker (`pack.announced`). Only the decision maker switches, in their own terminal (`installer packs switch <pack> --as <name>`; a policy change), and only after a passing shadow of that very candidate (`pack.switched`; refusals `pack.switch_refused`). | 2026-10-09 |
| D109 | **`installer uninstall` (§16.4).** A person's terminal only (an agent's attempt is audited `engine.uninstall_refused`). It pauses (D101), stops the gateway, removes the agent's `skillswiki` and `installer` MCP registrations through the probed profile, deletes the keychain items the engine stores (`skillswiki`, `telegram`, `email`, `google`, `model`), deletes the schedule and boot service files under the home and prints their unload commands (`launchctl bootout …`, the crontab line, `systemctl disable --now …`), audits `engine.uninstalled`, then exports the audit to `exports/audit-<time>.jsonl` (0600, chain checked). Business records (the client's sheets and mailboxes, `data/`, `runs/`) and the home itself stay; the person deletes the home once they have kept the export. Running it twice is safe. | 2026-10-09 |
| D110 | **`installer support bundle` (§16.5, D34).** One JSON file, `exports/support-<time>.json` (0600), that the person reads and sends themselves; the engine sends nothing and there is no remote access. It holds the versions, the step statuses without any answer, the report, the doctor and readiness findings, the last 20 run summaries, settings copied field by field (no addresses, sheet ids or bot names), counts (approvals, members, inbox, recordings), the audit check and event counts, which keychain items exist, and the last 50 lines of the gateway and tick logs. Every string is then scrubbed: the names and addresses of members, the decision maker and report recipients, mailbox users and bot names, and sheet ids are replaced wherever they appear; the OS user's home folder becomes `~`; email addresses and numbers of seven digits or more (not dates) are replaced; keys named like a `personal` or `protected_ground` field are replaced. Members, messages, memos, approvals, records and secrets are never read into it. Tested with sentinel values. | 2026-10-09 |
| D111 | **Left for later by Plan 9.** Hosted evals for the shadow upgrade (O11); recording `commit_sha` (Skills Wiki-side, §13.4); the agent in its own OS user with a `sudo` rule limited to `mcp-serve` (D105); host readiness and scheduling on Windows; the 60 s records cache (D99; every records call still reads through, which keeps D70's concurrency checks exact); signed installer updates and remote connector downloads (D65); drift alerts and logins nearing expiry in doctor (§16.1). Taken in from earlier plans: the gateway's two-starts race (D103) and the inbox's growth (D102). | 2026-10-09 |
```

- [ ] **Step 2: Update the spec**

The layout gains the new files; §5.1, §14.3–14.6 and §16.1, §16.4, §16.5 say what Plan 9 built; the CLI table, §13.4 (Skills Wiki-side work), §19 (O11, O12) and §20 (traceability) follow.

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
                                   # the install is finished (Plan 6, D79)
```

this:

```markdown
  config/pause.json                # the kill switch (Plan 9, D101)
  config/retention.json            # retention period in days (Plan 9, D102)
  data/channels/first-contact/     # who wrote first, kept when retention deletes messages (D102)
  state/doctor/                    # last doctor run, its next time, host readiness (D103, D104)
  runtime/service/                 # boot service files a person installs (Plan 9, D104)
  config/packs.json                # pinned Skills Wiki packs and candidates (Plan 9, D107, D108)
  packs/<pack>/<sha256>            # pinned skill file texts, by content (D107)
  exports/                         # audit exports and support bundles (Plan 9, D109, D110)
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
auto-unlock is configured on Linux by default.
```

with:

```markdown
auto-unlock is configured on Linux by default.

**Plan 9 (D104, D105).** `installer host` reads these settings through a
command runner (`pmset -g`, `systemsetup -getusingnetworktime`, `fdesetup
status`; `systemctl is-enabled`, `timedatectl`, `lsblk`) and prints the fix
for each one that is not right; a person with administrator rights runs it
in their own terminal, so the `ask` steps above are printed fixes instead,
and the engine never runs `sudo`. `installer host service install` writes
the boot services (LaunchDaemons, a systemd unit) and prints their
commands. The steps for a dedicated `installer-engine` OS user are printed
too; the engine creates no user.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| `installer gateway start|stop|status` | Manage the gateway: a detached process with a pid file under the engine home, replaced after a crash by the next start (D72); started at boot by the OS in Plan 9 |
| `installer doctor` | Health checks (§16.1) |
| `installer pause` / `installer unpause` | Kill switch (§14.4) |
| `installer disconnect <connector>` | Revoke access and delete stored credentials (`skillswiki`, or a pinned connector such as `google-sheets`: deletes its sign-in and names the provider page that removes the grant, D67) |
| `installer uninstall` | Remove the body; keep business records (§16.4) |
| `installer support bundle` | Redacted diagnostic package (§16.5) |
```

with:

```markdown
| `installer gateway start|stop|status` | Manage the gateway: a detached process with a pid file under the engine home, replaced after a crash by the next start (D72); started at boot by a service from `installer host service install` (D104) |
| `installer doctor` | Health checks with a fix for each finding; clears run claims a crash left, deletes data past the retention period, tries new pack versions in shadow; daily from the tick (§16.1, D103) |
| `installer host [service install \| remove]` | Host readiness with printed fixes and the dedicated-user steps; the boot service files and their `sudo` commands (§5.1, D104, D105) |
| `installer packs [list \| check \| shadow <pack> \| switch <pack>]` | Pinned Skills Wiki packs, new versions, shadow runs; the decision maker switches in their terminal (§14.3, D107, D108) |
| `installer retention [--value <days>]` | Show or set the retention period; shorter only in a person's terminal (§14.5, D102) |
| `installer pause [status]` / `installer unpause` | Kill switch: anyone pauses, only a person's terminal unpauses (§14.4, D101) |
| `installer disconnect <connector>` | Revoke access and delete stored credentials (`skillswiki`, or a pinned connector such as `google-sheets`: deletes its sign-in and names the provider page that removes the grant, D67) |
| `installer uninstall` | Remove the body, export the audit, keep business records; a person's terminal only (§16.4, D109) |
| `installer support bundle` | Redacted diagnostic file under `exports/` (§16.5, D110) |
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
- Add a `<workflow>` block to combos that want `combo_gate`.
```

this:

```markdown
- Serve each pack's `skill_pack_meta.commit_sha` with `get_skill_resource`
  (or a tool of its own), so installs can record it next to their content
  pins (D107).
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
- `instance.yaml` pins each Skills Wiki pack to a `commit_sha`.
```

with:

```markdown
- Each Skills Wiki pack is pinned by content (Plan 9, D107): the text of
  every skill file a judge uses is kept under `packs/` and recorded by its
  sha256 in `config/packs.json`; judges read only the pinned copy. Skills
  Wiki does not serve `commit_sha` yet (§13.4).
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
  comparison. Switching is a policy change (L3).
```

this:

```markdown
- Plan 9 (D108): the shadow runs the workflows that read the pack twice in
  sandbox (pinned and candidate); the eval in v1 compares them, hosted evals
  are left for later (O11); the decision maker switches in their terminal.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
- `/unpause` or `installer unpause` restores operation. Both audited.
```

this:

```markdown
- Plan 9 (D101): while paused, messages are recorded, actions above L0 are
  refused and runs do not start; `installer unpause` needs a person's
  terminal; `/pause` and `/unpause` count only from the decision maker on a
  channel that proves the sender.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
- Retention configurable (default: raw runs 90 days).
```

with:

```markdown
- Retention configurable (default: raw runs 90 days). Plan 9 (D102): run
  logs, inbound messages, recordings and sent counts; the audit is never
  deleted; a shorter period needs a person's terminal.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
privacy obligations (e.g. PIPEDA, GDPR).
```

with:

```markdown
privacy obligations (e.g. PIPEDA, GDPR). Plan 9 (D106): `installer report`
shows it with the kill switch, the last doctor run and the host readiness
score.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
space and retention. Findings posted to the decision maker's channel.
```

this:

```markdown
Plan 9 (D103): failed findings are posted; also host readiness (D104), run
claims a crash left behind (cleared) and damaged run records. Drift alerts
and logins nearing expiry are left for later (D111).
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
entries, gateway; export audit; leave business records untouched.
```

this:

```markdown
Plan 9 (D109): only in a person's terminal; it pauses first and prints the
OS commands that unload the schedule and the boot services.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, add after:

```markdown
`protected_ground` values. The client sends it to Allen. No remote access.
```

this:

```markdown
Plan 9 (D110): one JSON file under `exports/`, scrubbed of every known name,
address and sheet id, email addresses and long numbers.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| O11 | Whether hosted evals can run unattended inside an install | §15.4 at install time |
| O12 | ~~Default thresholds~~ First pass (D99): hardening N = 5, replay K = 10, autonomy streak 25, alert repeats 10 min × 6, reminders 12 h (urgent 5 min × 3), rate limits 3 a day per contact and 20 an hour; the 60 s cache and 90-day retention are Plan 9's | Tuning after pilot |
```

with:

```markdown
| O11 | Whether hosted evals can run unattended inside an install (the shadow upgrade grades by its own comparison until then, D108) | §15.4 at install time, hosted evals in shadow upgrades |
| O12 | ~~Default thresholds~~ First pass (D99): hardening N = 5, replay K = 10, autonomy streak 25, alert repeats 10 min × 6, reminders 12 h (urgent 5 min × 3), rate limits 3 a day per contact and 20 an hour; 90-day retention: D102; the 60 s cache is left for later (D111) | Tuning after pilot |
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| §5 | D9, D12, D41–D43 |
```

with:

```markdown
| §5 | D9, D12, D41–D43, D104, D105 |
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| §13 | D1, D6, D8, D19 |
| §14 | D24, D34, D43 |
| §15 | D31–D33, D91 |
| §16 | D34 |
```

with:

```markdown
| §13 | D1, D6, D8, D19, D107 |
| §14 | D24, D34, D43, D101, D102, D106–D108 |
| §15 | D31–D33, D91 |
| §16 | D34, D103, D109, D110 |
```

- [ ] **Step 3: Mark roadmap row 9 implemented**

In `docs/superpowers/plans/README.md`, replace:

```markdown
| 9 | **Operations + security hardening** | `doctor`, host readiness (Layer 1), pause / unpause, uninstall, support bundle, pack pinning + shadow upgrade, data-flow summary, retention | 1–8 | §5.1, §14, §16 | — | Not started |
```

with:

```markdown
| 9 | **Operations + security hardening** | `doctor`, host readiness (Layer 1), pause / unpause, uninstall, support bundle, pack pinning + shadow upgrade, data-flow summary, retention | 1–8 | §5.1, §14, §16 | — | [Implemented](2026-10-09-09-operations-hardening.md) on `feat/operations` |
```

- [ ] **Step 4: Write the live test guide**

Create `docs/testing/2026-10-09-plan-9-live-test.md`:

````markdown
# Plan 9 live test guide (doctor, host readiness, kill switch, pinned packs, support bundle, uninstall)

Use this guide to check Plan 9 by hand on your own Mac. Each test gives the commands to run, what you should see,
and a place to record what you actually saw. If a result differs, collect the items in **Diagnostics to capture** at
the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below were rehearsed in a sandbox with the host checks switched off; the host readiness lines
(Test 2) are predictions, because the automated tests never read a real Mac's settings. The first person to run this
guide replaces them with the actual output.

**What this guide changes on your machine:** nothing outside `~/installer-plan9-test`. It makes no `claude` call (the
test solution has no probe step), sends no message (it sets up no channel) and writes nothing to Skills Wiki: Test 1
reads one skill file twice. The keychain is a throwaway folder under the test directory (`INSTALLER_KEYCHAIN=file`),
so `installer uninstall` cannot delete your real keychain items, and `INSTALLER_PROFILE_DIR` points at an empty
folder, so it cannot remove your real Claude Code MCP servers either. Test 2 reads three settings with `pmset -g`,
`systemsetup -getusingnetworktime` and `fdesetup status` (read only); the fixes it prints are for you to read, not to
run, unless this Mac is meant to be a team host.

## What this build can and cannot do

Plan 9 adds: `installer doctor` (health checks with a fix for each finding; it clears run claims a crash left behind,
deletes data past the retention period and tries new Skills Wiki versions in shadow; the runner runs it once a day),
`installer host` (host readiness with printed fixes, the dedicated-user steps, `host service install` for boot
services), `installer pause` and `installer unpause` (the kill switch, also `/pause` and `/unpause` in Telegram),
`installer retention`, `installer packs` (skill files pinned by content, shadow runs, the decision maker's switch),
`installer support bundle` and `installer uninstall`, and the data-flow summary in `installer report`. Not yet: hosted
evals in the shadow upgrade, Windows host checks, the agent in its own OS user (D111).

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup: a team-host install with you as the decision maker | | |
| 1 | The automated live read: a skill file's pin is stable | | |
| 2 | Doctor and host readiness on your Mac | | |
| 3 | The kill switch: pause from anywhere, unpause only in your terminal | | |
| 4 | Boot service files, checked but not loaded | | |
| 5 | Retention and the support bundle's redaction | | |
| 6 | Uninstall, then clean up | | |

---

## Test 0: Setup

```bash
export T=~/installer-plan9-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX $T/keychain $T/no-profiles

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
export INSTALLER_HOME=$T/home INSTALLER_KEYCHAIN=file INSTALLER_KEYCHAIN_DIR=$T/keychain INSTALLER_PROFILE_DIR=$T/no-profiles
cat > $T/solution.json <<'JSON'
{ "id": "plan9-live", "version": "1.0.0",
  "steps": [
    { "step_id": "mode.shared-work", "phase": "MODE", "type": "ask", "title": "Shared work?", "why": "Mode.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes", "both"] } },
    { "step_id": "mode.always-on", "phase": "MODE", "type": "ask", "title": "Always on?", "why": "Mode.", "blocking": true, "input": { "kind": "choice", "options": ["no", "yes"] } },
    { "step_id": "mode.decision-maker", "phase": "MODE", "type": "ask", "title": "Decision maker?", "why": "Approvals and alerts.", "blocking": true, "input": { "kind": "text" } },
    { "step_id": "mode.derive", "phase": "MODE", "type": "auto", "title": "Choose the setup", "why": "Mode.", "blocking": true,
      "auto": { "action": "derive_mode", "args": { "shared_work": "mode.shared-work", "always_on": "mode.always-on", "decision_maker": "mode.decision-maker" } } }
  ] }
JSON
installer start --solution file:$T/solution.json
installer submit mode.shared-work --value '"yes"'
installer submit mode.always-on --value '"yes"'
installer submit mode.decision-maker --value '"<your first and last name>"'
installer report
cd $T
```

**Expected:** the last `submit` answers `{"status":"complete"}`. The report starts with
`✅ READY  (4 of 4 steps done) · plan9-live@1.0.0` and ends with `🩺 Doctor     never run: run 'installer doctor'`,
`🖥️ Host       not checked yet: run 'installer host'`, `🔀 Data flow` and one line for support (no channel, source,
model or Skills Wiki is set up, so they are not listed).

**Actual:**

---

## Test 1: The automated live read

Pick one skill file your Skills Wiki serves: `SKILLSWIKI_LIVE_RESOURCE` from the Plan 3 guide plus one path its test
listed, for example `<pack>/<skill>/references/<file>.md`.

```bash
cd $REPO
set -a; . ~/.config/installer-dev/.env; set +a
SKILLSWIKI_LIVE_FILE=<pack>/<skill>/<path> npm run test:live -- tests/live/packs.live.test.ts
cd $T
```

**Expected:** `1 passed`: the file's text, and so its sha256 pin (D107), is the same on two reads. A failure that
names different sha256s means content pinning would see a new version on every check: tell Claude.

**Actual:**

---

## Test 2: Doctor and host readiness on your Mac

```bash
installer doctor
installer host
installer report | tail -4
```

**Expected:** `doctor` exits 0 with `"status"` `ok` or `warn` and checks in this order: `state`, `audit` (`… lines,
hash chain intact`), `pause`, `secrets` (`this install stores no keychain items`), `runner` (`the runner has never
ticked`, a `warn`), `gateway` (`no channel is set up, so no gateway is needed`), `disk` (`… GiB free`), `host`,
`run_claims`, `run_records`, `recent_runs`, `retention`, `hardening`. The `host` check says `readiness N/5` and, for a
laptop, names `no_sleep` (your Mac sleeps after some minutes) and `boot_service`. `installer host` shows each check
with `"status"` `ok`, `fix`, `unknown` or `advice`: `no_sleep` with the fix `sudo pmset -a sleep 0`, `power_on`
(`pmset autorestart`), `time_sync` (probably `unknown`: `systemsetup` needs administrator rights to read it),
`disk_encryption` (`FileVault is on`, if it is), and the `dedicated_user` steps. Do not run the fixes on this laptop.
The report now shows `🩺 Doctor     warn (…)` and `🖥️ Host       readiness N/5`.

**Actual (paste the `host` checks):**

---

## Test 3: The kill switch

```bash
echo | installer pause --reason "live test"
echo | installer unpause; echo "exit $?"
installer tick
installer pause status
installer unpause
grep -c '"event":"engine.unpause_refused"' $INSTALLER_HOME/audit/audit.jsonl
```

**Expected:** the piped `pause` answers `"status":"paused"` with `"by":"agent"` (no terminal on stdin, like an
agent's shell: pausing is allowed from anywhere). The piped `unpause` prints
`{"error":"Unpausing sends real messages and starts runs again: the person runs 'installer unpause' in their own terminal, or the decision maker sends /unpause in Telegram","code":2}`
and `exit 2`. `tick` answers `"status":"paused"` with nothing started. `pause status` shows `"paused":true`. The
`unpause` you type answers `{"status":"unpaused","paused":false,…,"by":"terminal","via":"cli"}`, and `grep` counts `1`.

**Actual:**

---

## Test 4: Boot service files, checked but not loaded

```bash
installer host service install
plutil -lint $INSTALLER_HOME/runtime/service/*.plist
installer host service remove
```

**Expected:** `install` lists two files under `$INSTALLER_HOME/runtime/service/` (`com.installer.gateway.<8
characters>.plist` with `KeepAlive`, `com.installer.tickd.<8 characters>.plist` with `StartInterval` 60, both with
`UserName` set to you) and the commands `installer gateway stop`, then `sudo cp …`, `sudo chown root:wheel …`,
`sudo chmod 644 …` and `sudo launchctl bootstrap system …` for each. Run none of the `sudo` commands. `plutil` says
`OK` for both files. `remove` deletes them and prints `sudo launchctl bootout system/…` and `sudo rm …`.

**Actual:**

---

## Test 5: Retention and the support bundle

```bash
installer retention
echo | installer retention --value 30; echo "exit $?"
installer support bundle
B=$(ls $INSTALLER_HOME/exports/support-*.json)
grep -ci "<your last name>" $B; grep -c "$HOME" $B
less $B
```

**Expected:** `retention` shows `{"retention":{"days":90},…}`; the piped shorter period exits 2 (only your terminal
may shorten it). `support bundle` answers `"status":"written"` with its file and the sections `format`, `created_at`,
`versions`, `state`, `report`, `doctor`, `readiness`, `runs`, `settings`, `counts`, `audit`, `secrets_present`,
`logs`. Both `grep -c` print `0`: your name and your home folder are not in it. In `less`, the step
`mode.decision-maker` has no `value`, and `work_dir` starts with `~`.

**Actual:**

---

## Test 6: Uninstall, then clean up

```bash
echo | installer uninstall; echo "exit $?"
installer uninstall
wc -l $INSTALLER_HOME/exports/audit-*.jsonl
cd ~ && rm -rf $T
```

**Expected:** the piped `uninstall` exits 2. The one you type answers `"status":"uninstalled"`, `"gateway":"not_running"`,
both registrations `false` (the empty profile folder), every keychain item `"none"`, an `audit_export` with
`"chain":"intact"` and its line count (equal to `wc -l`), and the unload commands for the per-user schedule and the
boot services. Nothing was loaded in this test, so run none of them. Then delete the test folder.

**Actual:**

---

## Optional (a team host only)

On a Mac that is meant to run the assistant for a team, follow human task 13 instead: create the dedicated user, run
the fixes `installer host` prints, `installer host service install` and its `sudo` commands, then `installer doctor`
again: the `host` check should say `readiness 5/5`.
````

- [ ] **Step 5: Add the human tasks**

Task 12 runs the guide; task 13 is the team-host setup only a person with administrator rights can do (the dedicated user, the host readiness fixes, the boot services); the optional tasks move down and gain the Skills Wiki-side `commit_sha`.

In `docs/human-tasks.md`, replace:

```markdown
## Optional

### 12. Check Antigravity's terms (only if you want `agy` as an automatic model fallback)
```

with:

```markdown
### 12. Run the Plan 9 live test (doctor, host readiness, kill switch, support bundle, uninstall)

**Why:** the automated tests never read a real computer's settings (they answer with a fake), use a fake Skills Wiki and a file keychain. This checks the doctor and the host readiness checks on your own Mac (read only), the kill switch, the boot service files, the support bundle's redaction with your own name, and uninstall, all inside a test folder, and reads one Skills Wiki skill file twice. It makes no `claude` call and changes no OS setting. The host readiness outputs in the guide are predictions.

1. Open `docs/testing/2026-10-09-plan-9-live-test.md` and follow it in one terminal, in order.
2. Type `installer unpause`, `installer retention --value …` and `installer uninstall` yourself; the guide also shows that they refuse without a terminal.
3. Run none of the `sudo` commands the guide prints on your laptop; they are for a team host (task 13).
4. Paste each test's output to Claude, including the `installer host` checks of Test 2. If an output differs from the guide, Claude fixes the code or the guide.

### 13. Set up a team host: the dedicated user, the host readiness fixes and the boot services

**Why:** on a Team host the assistant must keep running when nobody is at the computer (D42), and the engine should belong to an OS user of its own rather than to a person's account (D50, D61, D105). The installer only reads the settings and prints what to change; a person with administrator rights makes every change. Do this on the client's always-on computer during their install (and once on a spare Mac or Linux box if you want to see it before a client does). About 30 minutes.

1. Create the engine user, as `installer host` prints it: on macOS a standard (not administrator) user named `installer-engine` (System Settings → Users & Groups → Add User); on Linux `sudo useradd --create-home --shell /bin/bash installer-engine`, then `sudo passwd installer-engine`. Keep its password yourself.
2. Sign in as `installer-engine`, install Node 22, the agent and the installer there, and run the install from that account, so the engine home, its keychain items and the agent's MCP servers belong to it.
3. As `installer-engine`, run `installer host`. For every check whose status is `fix`, run its command from your own administrator account (for example `sudo pmset -a sleep 0` and `sudo pmset -a autorestart 1` on macOS, `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` and `sudo timedatectl set-ntp true` on Linux). Turn on FileVault (macOS) if it is off, keeping the recovery key yourself (the engine never stores it, D43). On Linux, set the firmware's power-loss setting to Power On.
4. As `installer-engine`, run `installer schedule remove` if the per-user schedule was loaded (and the commands it prints), then `installer gateway stop` and `installer host service install`; run the printed `sudo cp`, `chown`, `chmod` and `launchctl bootstrap system …` (macOS) or `systemctl enable --now …` (Linux) commands from your administrator account. On Linux the tick stays the engine user's crontab (`installer schedule install`).
5. Follow the `updates` advice: schedule OS updates and planned restarts in the quiet window `installer host` names; put the computer on a wired network and a UPS.
6. Run `installer doctor` as `installer-engine`: the `host` check should say `readiness 5/5` (4/4 on Linux) and the `gateway` and `runner` checks `ok` after a minute. Decide approvals from Telegram; the terminal-only commands remain for a person at that account.
7. Tell Claude the readiness score you saw and any check that stayed `unknown`.

## Optional

### 14. Check Antigravity's terms (only if you want `agy` as an automatic model fallback)
```

In `docs/human-tasks.md`, replace:

```markdown
### 13. Check the crontab entry on a Linux host (only if a client will run on Linux)
```

with:

```markdown
### 15. Check the crontab entry on a Linux host (only if a client will run on Linux)
```

In `docs/human-tasks.md`, replace:

```markdown
4. Remove it with the command `installer schedule remove` prints. Tell Claude what you saw.
## Done
```

with:

```markdown
4. Remove it with the command `installer schedule remove` prints. Tell Claude what you saw.
### 16. Skills Wiki side: serve each pack's commit_sha (only if you want installs to record it)

**Why:** installs pin each skill file by its text (D107), because Skills Wiki's MCP answers do not say which version they are: `skill_pack_meta.commit_sha` is only read by its own scripts. If `get_skill_resource` (or a small tool of its own) also returned the pack's `commit_sha`, installs could record it next to the content pin, and the shadow upgrade's message could name the commit.

1. In the Skills Wiki repository, add the pack's `commit_sha` from `fetch_skill_pack_meta` to the `get_skill_resource` answer (for example a `commit_sha` field next to `path`, `kind` and `content`).
2. Tell Claude when it is live; the installer then records it with each pin (a small change, left for later in D111).

## Done
```

- [ ] **Step 6: Check that nothing else changed**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 93 files, 1241 tests pass (no code changed).

- [ ] **Step 7: Commit**

```bash
git add DECISIONS.md docs/superpowers/specs/2026-10-06-installer-design.md docs/superpowers/plans/README.md docs/human-tasks.md docs/testing/2026-10-09-plan-9-live-test.md
git commit -m "docs: record D101–D111, add the Plan 9 live guide"
```

---

## Self-Review Record

**Spec coverage.** §14.4 kill switch: Task 1 (engine, `/pause` and `/unpause`), Task 9 (CLI). §14.5 retention: Task 2. §16.1 doctor: Task 3 (audit chain, state and backup, keychain items, Skills Wiki and channel reachability through `get_active_combo` and `checkChannel`, the runner's heartbeat, the gateway, disk space, orphan run claims, damaged run records, missed runs and report fallbacks, retention, hardening proposals), Task 4 (host readiness), Task 7 (pinned pack updates in shadow); drift alerts and logins nearing expiry are left for later (D111). §5.1 host readiness and D42/D43: Task 4 (checks per OS, printed fixes, the score in the report, Personal mode informed only, the quiet window, UPS and wired network advice, boot services); the `ask` steps of §5.1 are printed fixes instead, because the engine never runs them (D104). D50/D61 dedicated OS user: Task 4 prints the steps, Task 10's human task 13 has the person do them (D105). §14.6 data-flow summary: Task 5. §14.3 pinning and shadow upgrade: Tasks 6 and 7; `commit_sha` cannot be read over MCP (fact 1), so pins are by content (D107); hosted evals are deferred behind `ShadowEval` (fact 2, O11, D108). §16.4 uninstall and §16.5 support bundle: Task 8 (engine), Task 9 (CLI). §14.1–14.2 threat model and controls: each control this plan owns maps to a task above (host: Tasks 4, 9; poisoned brain: Tasks 6, 7; insider and kill switch: Task 1; secrets in bundles: Task 8). From earlier plans: the gateway's two-starts race (Plan 6) in Task 3; the inbox's growth (Plan 6) in Task 2; the audit's growth is answered by export, never deletion (D102, D109).

**Placeholders.** None: every step carries its code or its exact text.

**Type consistency.** `PauseState`, `Switcher`, `Pruned`, `DoctorCheck`, `DoctorContext` (with `host` from Task 4), `Readiness`, `HostProbe`, `PackPin`, `Candidate` (with `shadow` from Task 7), `ShadowResult`, `RunRecord.shadow` and `RunRequest.shadow` are defined once and used with the same names in later tasks; `person` is `{ interactive: boolean; as?: string }` everywhere, as in Plan 8.

**Review Focus.** Each of the five lines above names its tests; all are in this plan's tasks.

**Verification:** every task of this plan was applied literally to a fresh copy of the repository at `6ae6ecc` (`feat/workflow-lifecycle` with the Plan 8 review fixes, 83 test files, 1180 tests) on 2026-10-09 by a script that executes only this plan's "Create", "In … replace", "In … add after" and "In … add before" instructions, its `Run:` lines and its commit blocks; every `Expected:` line above (including the failing runs and the exact counts) matched, every commit subject is at most 50 characters, and `npm run typecheck` and `npx vitest run` were green after each task (final: 93 test files, 1241 tests, offline, with the fake agent, the fake Skills Wiki and the fake Telegram; no gateway process was left running, and no real OS setting was read). The live test file and the live guide were not run; they are human task 12.
