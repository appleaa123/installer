# Secrets + BRAIN Phase Implementation Plan (Plan 3 of 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person store their Skills Wiki key on a local page the agent never sees, and let the install's BRAIN phase run end to end: the engine registers the Skills Wiki MCP server in the host agent with a headers helper, the person activates their combo, the C6 probe confirms the agent reaches Skills Wiki, `skillswiki:` solution references resolve, and `installer disconnect skillswiki` undoes it all.

**Architecture:** A keychain module (`src/core/keychain.ts`) wraps macOS `security`, Linux `secret-tool` and a file backend for tests; values travel on stdin, never in argv, and the state only ever holds ids. `installer secret <id>` starts a detached page process (`src/core/secret-page.ts`) on 127.0.0.1 that writes the keychain once and exits. A hand-rolled Streamable HTTP MCP client (`src/core/mcp.ts`) gives the engine `get_active_combo` and `get_skill_resource`; `src/core/skillswiki.ts` builds refs, targets and the combo check on it. Registration is an auto action (`register_mcp`, `src/core/register.ts`) that runs the profile's `mcp_remove` then `mcp_register` templates with a config whose `headersHelper` is `installer mcp-headers skillswiki`. The C6 probe (`probe_mcp`) is a headless call in the agent's own folder that allows exactly one tool. Actions and checks that fail for a fixable reason throw `ActionFailure`, which the engine turns into a failed, then blocked, step (D53). Everything is tested offline against the fake agent and a fake Skills Wiki server; live tests are opt-in.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22 built-ins only at runtime (`node:http`, `node:child_process`, `node:crypto`, global `fetch`), Vitest. Still no runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-06-installer-design.md`](../specs/2026-10-06-installer-design.md) §6.1–6.3, §6.6, §7.2–7.3 (C6), §8.3, §13, §14.2. Decisions in [`DECISIONS.md`](../../../DECISIONS.md) (D8, D22, D34, D37, D46, and D47–D55 added by this plan). Roadmap: [`README.md`](README.md). Builds on [Plan 1](2026-10-06-01-engine-core.md) and [Plan 2](2026-10-08-02-runtime-conformance.md).

**Design decisions adopted by this plan (approved 2026-10-08, recorded as D47–D55 in Task 10):**

- **D47** Non-blocking secret entry: `installer secret <id>` spawns a detached page process, prints `{"status":"waiting","url":…,"pid":…}` and exits; the page is POST-only with Host/Origin checks, accepts one value, says "Done, you can close this tab", exits (or after 10 minutes unused), and writes only the keychain. A `human_action` step with `input.kind: "secret"` names the secret in `input.provider` and completes through `installer verify <step_id>` with the check `secret_present`. On a headless host the output carries an `ssh -L` hint.
- **D48** Local tests only; live tests in `tests/live/` run with `INSTALLER_LIVE=1` (`npm run test:live`), read `SKILLSWIKI_API_KEY` / `SKILLSWIKI_MCP_URL` from the environment and skip when empty. **D49** the name stays `installer`. **D50** team scale designed for, not delivered: helper and keychain run as the agent's OS user.
- **D51** Keychain backends macOS `security` (stdin), Linux `secret-tool` (stdin), file (`INSTALLER_KEYCHAIN=file` + `INSTALLER_KEYCHAIN_DIR`, 0600). Service `installer`, account `<id>`. Windows deferred.
- **D52** The engine registers `skillswiki` with `claude mcp add-json -s user skillswiki '{"type":"http","url":…,"headersHelper":"'<node>' '<installer cli>' mcp-headers skillswiki"}'`; `installer mcp-headers <id>` prints `{"Authorization":"Bearer <key>"}` or exits 1 silently. Idempotent as **remove then add** (see fact 9: `mcp get` was dropped because it health-checks the server and runs the helper; `remove` of a missing name is a clean exit 1). Profiles gain `mcp_register.cmd`, `mcp_remove.cmd`, `headless.tools_off` and `headless.allow_tool`.
- **D53** `ActionFailure` from an action or a check → attempts + 1, `failed` with the hint, third failure `blocked`; retried through `installer resume`; authoring errors still throw.
- **D54** C6 = `probe_mcp` after the combo step: a headless call in `state.work_dir` (the agent's `process.cwd()` at `start`), without tools-off flags, `--allowedTools mcp__skillswiki__get_active_combo`, prompt naming that tool; pass = the reported `combo_slug` equals the engine's own. `c6_mcp: boolean | "not_probed"`; support level counts C6.
- **D55** Hand-rolled MCP client; `skillswiki:<pack>/<skill>/<path>` via `get_skill_resource` with one outer `<skill_*>` element stripped; the key must exist before `start`. **The Skills Wiki MCP URL is per client and not a secret**, so it is a `start --url <MCP URL>` flag stored in the state as `skillswiki.url` (it is needed before any state exists to fetch a `skillswiki:` ref, and every later BRAIN step reads it from the state; a page field would force the page process to write state, which D47 forbids). `INSTALL.md` gets a third placeholder `{{SKILLSWIKI_URL}}` that whoever serves it fills in.

## Facts verified live before writing (2026-10-08, Claude Code 2.1.294, macOS, Node 22.14.0)

| # | Fact | Command | Observed |
|---|---|---|---|
| 1 | `security` reads the value from stdin | `printf 'add-generic-password -U -s <svc> -a <acct> -w "<value>"\n' \| security -i` | `ps -o args=` shows only `security -i`; a value with spaces, `"` and `\` round-trips when `\` and `"` are backslash-escaped inside double quotes; `find-generic-password -w` and `delete-generic-password` work with no GUI prompt |
| 2 | `security` exit codes | `find-generic-password` / `delete-generic-password` on a missing item; `security -i` with a bad command | missing item → exit **44** (both); bad command → exit 1; bad arguments → exit 2; success → 0 |
| 3 | `claude mcp add-json` registers an http server with a headers helper | `claude mcp add-json -s user <name> '{"type":"http","url":…,"headersHelper":"<script>"}'` | Registered; `claude mcp get` connects and every request carries the header the script prints — **only in a folder with persisted workspace trust** (otherwise "headersHelper not run — this workspace has no persisted trust…" and no header). `-s user` shows "User config (available in all your projects)" |
| 4 | Adding the same name twice | `claude mcp add-json … <name> …` again | "MCP server <name> already exists in local config", no replace |
| 5 | C6 rehearsal | `claude -p "Call the tool mcp__swtest__get_active_combo (no arguments) and reply with only the value of its combo_slug field, nothing else." --output-format json --allowedTools "mcp__swtest__get_active_combo" < /dev/null` (real Skills Wiki registered with a headers helper, trusted folder) | `.result` = the active combo slug, `permission_denials: []`. Without naming the exact tool the model chose the user's other `skills-wiki` server and was denied |
| 6 | Hosted Skills Wiki MCP | unauthenticated `initialize` | HTTP 401 |
| 7 | Hosted Skills Wiki MCP with Bearer | `initialize` → `notifications/initialized` → `tools/call` | `initialize` → 200 `text/event-stream`, one `data:` event, `mcp-session-id` header; `notifications/initialized` → 202 empty; `tools/list` → 31 tools incl. `get_active_combo`, `get_skill_resource`; `get_active_combo` → 200 SSE, `result: { content: [{ type: "text", text: <json> }], structuredContent: { combo: { id, name, slug, kind, description, activated_at }, combo_slug, has_loop, learning_mode, skills, skill_tools, skills_not_mounted, harness }, isError: false }`. With no active combo: unverified (error, `isError` and `combo: null` are all treated as "not activated") |
| 8 | `get_skill_resource` | `(pack, skill_name, path="")` and with a path | folder form `{ resources: [{ path, kind, size }] }`; file form `{ path, kind: "reference", content: "<skill_reference>\n…\n</skill_reference>" }` — one outer `<skill_[a-z]+>` element to strip |
| 9 | `claude mcp get` / `remove` on a missing name | `claude mcp get x; claude mcp remove x; claude mcp remove -s user x` | all exit **1** with `No MCP server named "x"` (`remove -s user`: "… in user scope"); `remove --help`: without `-s` it removes from whichever scope holds the name |
| 10 | Network | from this machine | the sandbox reaches the Skills Wiki host and GitHub; the test suite stays offline on a fake MCP server (`node:http`) that mimics facts 6–8 |

## Global Constraints

- Everything in Plan 1's and Plan 2's Global Constraints still applies (Node ≥ 22, strict TS, ESM `.js` suffixes, zero runtime dependencies, immutable updates, functions < 50 lines, files < 400 lines, no `console.log`, exit codes `0/1/2/3`, spec field names verbatim, D34 confinement, R4, R9/D27 neutrality: no real-estate vocabulary in `src/`, `tests/fixtures/`, `profiles/`, `solutions/`, `INSTALL.md`; headless calls `spawn` an argv with no shell, tools off, timeout and output cap).
- A secret value never appears in argv, a prompt, the state, the audit, a log line, a page URL or a CLI's stdout — except `installer mcp-headers <id>`, whose one line is read by the agent's MCP client. Keychain commands receive the value on stdin (`security -i` script form, fact 1).
- The page process binds `127.0.0.1` only, on a random port, with a 32-byte token in the path; it answers POST only with matching `Host` and `Origin`, accepts one value, then exits; unused it exits after `600 000` ms. It writes the keychain and nothing else.
- Skills Wiki is called over `https:` only (loopback `http://127.0.0.1` is allowed for the test server); every request has a `30 000` ms timeout and a `1 000 000` byte cap; a 401 is reported as "Skills Wiki key rejected: run `installer secret skillswiki`".
- Headless calls keep the profile's `tools_off` flags, except the C6 call, which replaces them with `allow_tool` for exactly one named tool.
- `ActionFailure` is an actionable condition: exit `2` at the CLI, a failed-then-blocked step inside an install. `installer mcp-headers` with no stored key exits `1` with empty stdout and stderr.
- Tests never touch the real keychain, open a browser or reach the network: `vitest.config.ts` sets `INSTALLER_KEYCHAIN=file`, a throwaway `INSTALLER_KEYCHAIN_DIR`, `INSTALLER_BROWSER=none` and `INSTALLER_CLI=dist/cli.js`. Live tests run only with `INSTALLER_LIVE=1`; nothing in this plan reads `~/.config/installer-dev/.env`.
- New state fields (`skillswiki`, `work_dir`) are optional and `CapabilityMap.c6_mcp` only widens, so `schema` stays `1` and Plan 1–2 state files keep loading.

## Review Focus

1. **The secret page receives a request it must refuse** — a wrong token, a foreign `Host`, a foreign or missing `Origin`, a POST after the one accepted value. Nothing is stored and the page keeps serving (or is already gone). Test: Task 3 (`refuses a POST with %s and stores nothing`, `stores one submitted value, says done, then stops serving`).
2. **The agent's folder has no persisted workspace trust**, so Claude Code never runs the headers helper. C6 fails with a note naming the folder, the install still finishes as READY WITH LIMITS. Test: Task 8 (`names the folder whose trust may be missing…`), Task 9 (`without workspace trust ends READY WITH LIMITS and names the folder`).
3. **The Skills Wiki key is rejected (401)** — at `start` with a `skillswiki:` ref, at the combo check, at any MCP call. The hint names `installer secret skillswiki`; `start` creates nothing; a check becomes a failed, retryable step. Test: Task 4 (`turns a 401 into the secret hint`), Task 5 (`names a rejected key and creates nothing`), Task 7 (`turns a rejected key into a failed check with the secret hint`).
4. **`start` is missing what Skills Wiki needs** — a `skillswiki:` ref without a stored key, a key without `--url`, a plain `http:` URL, a file solution with BRAIN steps and no `--url`. Exit `2`, no home created, the message names the command or flag. Test: Task 5 (`refuses to start without the key…`, `refuses to start with %s once the key exists…`).
5. **The MCP server answers something unexpected** — non-JSON, a stream without the request id, HTTP 500, a body over the cap, a timeout, an unreachable host. A failure with a reason, never a crash; through a check it is a failed step. Test: Task 4 (`turns %s into a failure with a reason`, `names a timeout`), Task 7 (`names the url when Skills Wiki is unreachable, and the step can be retried`).

---

## File Structure

```
profiles/
  claude-code.json             # MODIFY tools_off / allow_tool split, mcp_register, mcp_remove
solutions/
  starter.json                 # MODIFY + BRAIN steps: key, register, combo, probe-mcp
INSTALL.md                     # MODIFY secret before start, --url {{SKILLSWIKI_URL}}, secret steps, disconnect
package.json                   # MODIFY + test:live script
vitest.config.ts               # MODIFY file keychain, no browser, INSTALLER_CLI, live gate
src/
  cli.ts                       # MODIFY command table; secret, secret-serve, mcp-headers, disconnect; --url; skillswiki: start
  core/
    failure.ts                 # NEW ActionFailure (D53)
    engine.ts                  # MODIFY failStep, runAuto, checks may fail, retryCommand for auto, StartExtras
    actions.ts                 # MODIFY write_file failures, runCheck(state), secret_present, combo_active, register_mcp, probe_mcp
    keychain.ts                # NEW macOS / Linux / file backends, get/set/deleteSecret (D51)
    secret-page.ts             # NEW local page server, detached launcher, browser opener, headless hint (D47)
    mcp.ts                     # NEW Streamable HTTP client: callTool (D55)
    skillswiki.ts              # NEW refs, wrapper stripping, active combo, target, url rules
    register.ts                # NEW headers helper command, registerMcp / unregisterMcp (D52)
    disconnect.ts              # NEW installer disconnect skillswiki
    headless.ts                # MODIFY runProcess stdin + exit code, allowTool, buildArgv exported
    profile.ts                 # MODIFY tools_off, allow_tool, mcp_register, mcp_remove templates
    probe.ts                   # MODIFY probeMcp, withMcpProbe (C6)
    report.ts                  # MODIFY C6 limit
    solution.ts                # MODIFY skillswiki fetcher, secret step rule, BRAIN order rule
    state.ts, types.ts         # MODIFY skillswiki, work_dir, c6_mcp widening
tests/
  fakes/fake-agent.mjs         # MODIFY mcp add-json / get / remove, headers helper + tool call, DROP=mcp|trust
  fakes/fake-mcp-server.mjs    # NEW fake hosted Skills Wiki (facts 6–8)
  fixtures/
    profiles/fake-agent.json   # MODIFY tools_off, allow_tool, mcp templates
    skillswiki/demo/install/   # NEW recipe.json + notes.md served by the fake server
    solution-starter.json      # MODIFY + BRAIN steps
  helpers/http.ts              # NEW raw http request, form headers, waitForExit
  helpers/fake-mcp.ts          # NEW startFakeMcp
  operator/scripted-operator.ts# MODIFY startArgs, env, auto-failed → resume, starterScript
  unit/
    engine-failure.test.ts     # NEW (Task 1)
    keychain.test.ts           # NEW (Task 2)
    secret-page.test.ts        # NEW (Task 3)
    mcp.test.ts, skillswiki.test.ts            # NEW (Task 4, 5)
    register.test.ts           # NEW (Task 6)
    combo.test.ts              # NEW (Task 7)
    probe-mcp.test.ts          # NEW (Task 8)
    actions, solution, engine-actions, engine-advance, solution-refs, state-fields, profile, headless, report  # MODIFY
  e2e/
    cli.test.ts                # MODIFY secret, skillswiki refs, mcp-headers, disconnect, --url
    install-doc.test.ts        # MODIFY three placeholders, starter with BRAIN steps end to end
  live/skillswiki.live.test.ts # NEW opt-in (Task 10)
docs/
  superpowers/specs/2026-10-06-installer-design.md   # MODIFY (Task 10)
  superpowers/plans/README.md                        # MODIFY roadmap (Task 10)
  testing/2026-10-08-plan-3-live-test.md             # NEW live test guide (Task 10)
DECISIONS.md                   # MODIFY + D47–D55 (Task 10)
```

**Edit conventions used below.** "Create `path`:" gives the whole file. "In `path`, replace: … with: …" replaces exactly one occurrence of the first block (copy it from the current file; it must match byte for byte). "In `path`, add after: … this: …" inserts the second block on a new line directly after the line in which the anchor ends (no blank line); "add before" inserts it before the anchor followed by one blank line. Test counts in `Expected:` lines are for the named files; the suite totals include the neutrality scan, which adds one test per new file under `src/` and `tests/fixtures/`.

---

### Task 1: `ActionFailure` and the auto-action failure path (D53)

**Files:**
- Create: `src/core/failure.ts`
- Modify: `src/core/actions.ts` (`write_file`, `runCheck`), `src/core/engine.ts` (`retryCommand`, `failStep`, `runVerify`, `runAuto`, `advance`), `src/cli.ts` (`exitCodeFor`), `tests/operator/scripted-operator.ts`
- Test: `tests/unit/engine-failure.test.ts` (new)

**Interfaces:**
- Consumes: Plan 1/2 `runAction`, `runCheck`, `transition`, `recordOf`, `MAX_VERIFY_ATTEMPTS`.
- Produces (used by every later task):
  - `failure.ts`: `class ActionFailure extends Error` — thrown by actions and checks for conditions the person can fix.
  - `actions.ts`: `runCheck(home, check, state?)` (checks may read the state); `write_file` throws `ActionFailure` on file-system errors.
  - `engine.ts`: `retryCommand(step)` returns `installer resume` for `verify` **and** `auto` steps; a failed auto step is shown as `{ status: "step", view: { status: "failed", attempts, hint, resume: "installer resume" } }`; the third failure blocks it with `reason: "action failed 3 times"`; a check that throws `ActionFailure` fails with its message as the hint.
  - The scripted operator answers a failed `auto` step with `installer resume`, as INSTALL.md tells an agent to.

- [ ] **Step 1: Create the error class**

Create `src/core/failure.ts`:

```ts
/**
 * An action or check could not finish for a reason the person can fix: a network call, the keychain,
 * a child process (D53). The engine records it as a failed step with this message as the hint and
 * retries it through `installer resume`; the third failure blocks the step. Authoring errors
 * (InputError, SolutionError, ProfileError) are not failures: they still throw.
 */
export class ActionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionFailure";
  }
}
```

- [ ] **Step 2: Write the failing test**

A read-only `config/` folder makes `write_file` fail the way a full disk or a lost permission would, so the failure path is exercised with the real action.

Create `tests/unit/engine-failure.test.ts`:

```ts
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { advance, resume, retryCommand, start } from "../../src/core/engine.js";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { buildReport } from "../../src/core/report.js";
import { parseSolution } from "../../src/core/solution.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const WRITE = { step_id: "pre.write", phase: "PREFLIGHT", type: "auto", title: "Write a file", why: "Needed.", blocking: true, auto: { action: "write_file", args: { path: "config/a.txt", content: "x\n" } } };
const solution = () => parseSolution({ id: "failing", version: "1", steps: [WRITE] });

/** A read-only config folder makes write_file fail the way a full disk or a lost permission would. */
async function lockedHome(): Promise<string> {
  const home = await makeTempHome();
  await mkdir(join(home, "config"), { mode: 0o500 });
  return home;
}

const unlock = (home: string) => chmod(join(home, "config"), 0o700);
const cannotLock = process.platform === "win32" || process.getuid?.() === 0;

describe("retryCommand", () => {
  it("sends auto steps back through installer resume", () => {
    expect(retryCommand(solution().steps[0]!)).toBe("installer resume");
  });
});

describe.skipIf(cannotLock)("an auto step whose action fails (D53)", () => {
  it("write_file reports a failure the person can fix, not an internal error", async () => {
    const home = await lockedHome();
    await expect(runAction(home, WRITE.auto)).rejects.toThrow(ActionFailure);
    await expect(runAction(home, WRITE.auto)).rejects.toThrow("Cannot write config/a.txt (EACCES)");
  });

  it("is recorded as failed with the hint and retried through resume", async () => {
    const home = await lockedHome();
    const { deps } = memoryDeps(home, solution());
    const first = await start(deps, null, "file:/f.json");
    expect(first.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 1, hint: "Cannot write config/a.txt (EACCES)", resume: "installer resume" } });
    expect(buildReport(deps.solution, first.state).needs_you[0]?.detail).toContain("→ then run 'installer resume'");
    const again = await advance(deps, first.state);
    expect(again.result).toEqual(first.result);
    await unlock(home);
    const fixed = await resume(deps, first.state);
    expect(fixed.result).toEqual({ status: "complete" });
    expect(fixed.state.steps["pre.write"]).toMatchObject({ status: "done", by: "engine" });
  });

  it("blocks on the third failure with the reason recorded", async () => {
    const home = await lockedHome();
    const { deps } = memoryDeps(home, solution());
    let { state } = await start(deps, null, "file:/f.json");
    state = (await resume(deps, state)).state;
    const third = await resume(deps, state);
    expect(third.result).toMatchObject({ status: "blocked", view: { attempts: 3 } });
    expect(third.state.steps["pre.write"]).toMatchObject({ status: "blocked", attempts: 3, reason: "action failed 3 times" });
    await unlock(home);
    expect((await resume(deps, third.state)).result).toEqual({ status: "complete" });
  });
});

describe("authoring errors are not failures", () => {
  it("an action with a bad argument still throws and records nothing", async () => {
    const home = await makeTempHome();
    const bad = parseSolution({ id: "bad", version: "1", steps: [{ ...WRITE, auto: { action: "write_file", args: { path: 42 } } }] });
    const { deps, saved } = memoryDeps(home, bad);
    await expect(start(deps, null, "file:/b.json")).rejects.toThrow(InputError);
    expect(saved.at(-1)?.steps["pre.write"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/unit/engine-failure.test.ts`
Expected: FAIL — `src/core/failure.ts` does not exist (import error).

- [ ] **Step 4: Turn file-system errors into failures and let checks read the state**

In `src/core/actions.ts`, replace:

```ts
import { InputError } from "./inputs.js";
import { deriveModeAction } from "./mode.js";
```

with:

```ts
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { deriveModeAction } from "./mode.js";
```

In `src/core/actions.ts`, replace:

```ts
    const content = args.content === undefined ? "" : stringArg(args, "content");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    return {};
```

with:

```ts
    const content = args.content === undefined ? "" : stringArg(args, "content");
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      throw new ActionFailure(`Cannot write ${stringArg(args, "path")} (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
    }
    return {};
```

In `src/core/actions.ts`, replace:

```ts
const CHECKS: Readonly<Record<string, (home: string, args: Args) => Promise<CheckResult>>> = {
```

with:

```ts
type CheckRun = (home: string, args: Args, state: InstallState | undefined) => Promise<CheckResult>;

const CHECKS: Readonly<Record<string, CheckRun>> = {
```

In `src/core/actions.ts`, replace:

```ts
export async function runCheck(home: string, check: Check): Promise<CheckResult> {
  if (!Object.hasOwn(CHECKS, check.check)) throw new InputError(`Unknown check '${check.check}'`);
  const run = CHECKS[check.check];
  return run(home, check.args ?? {});
}
```

with:

```ts
export async function runCheck(home: string, check: Check, state?: InstallState): Promise<CheckResult> {
  if (!Object.hasOwn(CHECKS, check.check)) throw new InputError(`Unknown check '${check.check}'`);
  const run = CHECKS[check.check];
  return run(home, check.args ?? {}, state);
}
```

- [ ] **Step 5: Record failures in the engine**

In `src/core/engine.ts`, replace:

```ts
import { runAction, runCheck } from "./actions.js";
import { crashPoint } from "./crash.js";
import { AGENT_FORBIDDEN_KINDS, validateInput } from "./inputs.js";
import type { AuditHead, InstallState, Solution, StepDef, StepRecord, StepStatus } from "./types.js";
```

with:

```ts
import { runAction, runCheck, type CheckResult } from "./actions.js";
import { crashPoint } from "./crash.js";
import { ActionFailure } from "./failure.js";
import { AGENT_FORBIDDEN_KINDS, validateInput } from "./inputs.js";
import type { Action, AuditHead, InstallState, Solution, StatePatch, StepDef, StepRecord, StepStatus, StepType } from "./types.js";
```

In `src/core/engine.ts`, replace:

```ts
const SETTLED: readonly StepStatus[] = ["done", "skipped"];
```

with:

```ts
const SETTLED: readonly StepStatus[] = ["done", "skipped"];
/** Engine-owned steps are rerun by `installer resume`; a person or agent reruns the rest with `installer verify`. */
const RETRIED_BY_RESUME: readonly StepType[] = ["verify", "auto"];
```

In `src/core/engine.ts`, replace:

```ts
/** The command that retries a failed step: verify-type steps rerun through resume, the rest through verify. */
export function retryCommand(step: StepDef): string {
  return step.type === "verify" ? RESUME_HINT : `installer verify ${step.step_id}`;
}
```

with:

```ts
/** The command that retries a failed step: engine-owned steps rerun through resume, the rest through verify. */
export function retryCommand(step: StepDef): string {
  return RETRIED_BY_RESUME.includes(step.type) ? RESUME_HINT : `installer verify ${step.step_id}`;
}
```

In `src/core/engine.ts`, replace:

```ts
export async function runVerify(deps: EngineDeps, state: InstallState, step: StepDef, actor: Actor): Promise<{ state: InstallState; result: VerifyResult }> {
  if (!step.verify) throw new EngineError(`Step '${step.step_id}' has nothing to verify`);
  const check = await runCheck(deps.home, step.verify);
  if (check.ok) {
    return { state: await transition(deps, state, step, { status: "done", at: deps.now(), by: actor }, actor), result: { status: "passed" } };
  }
  const attempts = (recordOf(state, step.step_id)?.attempts ?? 0) + 1;
  const hint = check.hint ?? "Check failed";
  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    const record: StepRecord = { status: "blocked", at: deps.now(), attempts, hint, reason: `check failed ${attempts} times` };
    return { state: await transition(deps, state, step, record, actor), result: { status: "blocked", hint, retry: false } };
  }
  const record: StepRecord = { status: "failed", at: deps.now(), attempts, hint };
  return { state: await transition(deps, state, step, record, actor), result: { status: "failed", hint, retry: true } };
}
```

with:

```ts
/** One more failure of a step: `failed` with the hint, `blocked` on the third (D53: actions mirror checks). */
async function failStep(deps: EngineDeps, state: InstallState, step: StepDef, hint: string, actor: Actor, what: "check" | "action"): Promise<{ state: InstallState; result: VerifyResult }> {
  const attempts = (recordOf(state, step.step_id)?.attempts ?? 0) + 1;
  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    const record: StepRecord = { status: "blocked", at: deps.now(), attempts, hint, reason: `${what} failed ${attempts} times` };
    return { state: await transition(deps, state, step, record, actor), result: { status: "blocked", hint, retry: false } };
  }
  const record: StepRecord = { status: "failed", at: deps.now(), attempts, hint };
  return { state: await transition(deps, state, step, record, actor), result: { status: "failed", hint, retry: true } };
}

/** A check that could not run (network, keychain) counts as a failed check with its message as the hint. */
function asCheckResult(error: unknown): CheckResult {
  if (error instanceof ActionFailure) return { ok: false, hint: error.message };
  throw error;
}

export async function runVerify(deps: EngineDeps, state: InstallState, step: StepDef, actor: Actor): Promise<{ state: InstallState; result: VerifyResult }> {
  if (!step.verify) throw new EngineError(`Step '${step.step_id}' has nothing to verify`);
  const check = await runCheck(deps.home, step.verify, state).catch(asCheckResult);
  if (check.ok) {
    return { state: await transition(deps, state, step, { status: "done", at: deps.now(), by: actor }, actor), result: { status: "passed" } };
  }
  return failStep(deps, state, step, check.hint ?? "Check failed", actor, "check");
}

/** Runs an auto step; an ActionFailure becomes a failed (then blocked) step, anything else still throws. */
async function runAuto(deps: EngineDeps, state: InstallState, step: StepDef, action: Action): Promise<InstallState> {
  let patch: StatePatch;
  try {
    patch = await runAction(deps.home, action, state);
  } catch (error) {
    if (!(error instanceof ActionFailure)) throw error;
    return (await failStep(deps, state, step, error.message, "engine", "action")).state;
  }
  crashPoint("engine:after-action");
  return transition(deps, { ...state, ...patch }, step, { status: "done", at: deps.now(), by: "engine" }, "engine");
}
```

In `src/core/engine.ts`, replace:

```ts
    if (record?.status === "blocked") return { state: current, result: { status: "blocked", view: viewOf(step, record, current.runtime?.profile) } };
    if (step.type === "auto" && step.auto) {
      const patch = await runAction(deps.home, step.auto, current);
      crashPoint("engine:after-action");
      current = await transition(deps, { ...current, ...patch }, step, { status: "done", at: deps.now(), by: "engine" }, "engine");
      continue;
    }
    if (step.type === "verify" && (record === undefined || record.status === "pending")) {
      current = (await runVerify(deps, current, step, "engine")).state;
      continue;
    }
```

with:

```ts
    if (record?.status === "blocked") return { state: current, result: { status: "blocked", view: viewOf(step, record, current.runtime?.profile) } };
    const untried = record === undefined || record.status === "pending";
    if (step.type === "auto" && step.auto && untried) {
      current = await runAuto(deps, current, step, step.auto);
      continue;
    }
    if (step.type === "verify" && untried) {
      current = (await runVerify(deps, current, step, "engine")).state;
      continue;
    }
```

- [ ] **Step 6: Map `ActionFailure` to exit 2 and teach the operator about failed auto steps**

In `src/cli.ts`, replace:

```ts
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type SubmitPayload } from "./core/engine.js";
import { InputError } from "./core/inputs.js";
```

with:

```ts
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type SubmitPayload } from "./core/engine.js";
import { ActionFailure } from "./core/failure.js";
import { InputError } from "./core/inputs.js";
```

In `src/cli.ts`, replace:

```ts
  if (error instanceof InputError || error instanceof EngineError || error instanceof SolutionError || error instanceof NoInstallError || error instanceof ProfileError) return EXIT.USAGE;
```

with:

```ts
  if (error instanceof InputError || error instanceof EngineError || error instanceof SolutionError || error instanceof NoInstallError) return EXIT.USAGE;
  if (error instanceof ProfileError || error instanceof ActionFailure) return EXIT.USAGE;
```

In `tests/operator/scripted-operator.ts`, replace:

```ts
    } else if (type === "verify" && current.view.status === "failed") {
```

with:

```ts
    } else if ((type === "verify" || type === "auto") && current.view.status === "failed") {
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/unit/engine-failure.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (5 tests in `engine-failure.test.ts`); typecheck exits 0; the whole suite passes: 22 files, 266 tests (Plan 2's 260, plus 5, plus the neutrality scan of `failure.ts`).

- [ ] **Step 8: Commit**

```bash
git add src/core/failure.ts src/core/actions.ts src/core/engine.ts src/cli.ts tests/operator/scripted-operator.ts tests/unit/engine-failure.test.ts
git commit -m "feat(core): fail and block auto steps whose action cannot finish"
```

---

### Task 2: Keychain module and the `secret_present` check (D51)

**Files:**
- Create: `src/core/keychain.ts`
- Modify: `src/core/headless.ts` (`runProcess` stdin + exit code), `src/core/actions.ts` (`secret_present`), `src/core/solution.ts` (secret step rule), `vitest.config.ts` (file keychain), `tests/unit/engine-actions.test.ts`
- Test: `tests/unit/keychain.test.ts` (new), `tests/unit/actions.test.ts`, `tests/unit/solution.test.ts`

**Interfaces:**
- Consumes: `ActionFailure` (Task 1), `runProcess` (Plan 2).
- Produces:
  - `headless.ts`: `interface ProcessResult { stdout; code: number | null; error? }`; `runProcess(argv, cwd, timeoutMs, input?)` — `input` is written to the child's stdin, which is then closed.
  - `keychain.ts`: `KEYCHAIN_SERVICE = "installer"`, `KEYCHAIN_ENV = "INSTALLER_KEYCHAIN"`, `KEYCHAIN_DIR_ENV = "INSTALLER_KEYCHAIN_DIR"`, `SECRET_ID_PATTERN`, `requireSecretId(id)`, `requireSecretValue(value)` (trimmed, single line), `macAddScript(id, value)`, `interface Keychain { get; set; delete }`, `selectKeychain(env = process.env)`, `getSecret(id, env?): Promise<string | null>`, `setSecret(id, value, env?)`, `deleteSecret(id, env?): Promise<boolean>`. The `env` argument lets tests and the CLI pick a backend without touching `process.env`.
  - Check `secret_present` with `args.id` (and an optional `args.hint`).
  - Solution rule: a `human_action` whose `input.kind` is `secret` must carry `input.provider` (a secret id) and `verify: { check: "secret_present", args: { id: <provider> } }`.

- [ ] **Step 1: Let `runProcess` feed stdin and report the exit code**

In `src/core/headless.ts`, replace:

```ts
/** Spawns argv with no shell and no stdin; never rejects (Review Focus 1, 2, 5). */
export function runProcess(argv: readonly string[], cwd: string, timeoutMs: number): Promise<{ readonly stdout: string; readonly error?: string }> {
  const [file, ...args] = argv;
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let failure: string | undefined;
```

with:

```ts
export interface ProcessResult {
  readonly stdout: string;
  readonly code: number | null;
  readonly error?: string;
}

/** Spawns argv with no shell; stdin gets `input` (keychain values travel that way) and is closed at once. Never rejects. */
export function runProcess(argv: readonly string[], cwd: string, timeoutMs: number, input?: string): Promise<ProcessResult> {
  const [file, ...args] = argv;
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let failure: string | undefined;
```

In `src/core/headless.ts`, replace:

```ts
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ stdout, error: error.code === "ENOENT" ? `'${file}' is not installed` : error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, ...(failure ? { error: failure } : code === 0 ? {} : { error: `exited with code ${code}` }) });
    });
  });
}
```

with:

```ts
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ stdout, code: null, error: error.code === "ENOENT" ? `'${file}' is not installed` : error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, code, ...(failure ? { error: failure } : code === 0 ? {} : { error: `exited with code ${code}` }) });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
```

- [ ] **Step 2: Write the failing keychain test**

Create `tests/unit/keychain.test.ts`:

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { deleteSecret, getSecret, macAddScript, selectKeychain, setSecret } from "../../src/core/keychain.js";
import { makeTempHome } from "../helpers/temp-home.js";

const fileEnv = async () => ({ INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: join(await makeTempHome(), "keys") });

describe("file keychain backend", () => {
  it("stores, reads back and deletes a value, trimming surrounding whitespace", async () => {
    const env = await fileEnv();
    await setSecret("skillswiki", "  sw_live_abc  ", env);
    await expect(getSecret("skillswiki", env)).resolves.toBe("sw_live_abc");
    await expect(deleteSecret("skillswiki", env)).resolves.toBe(true);
    await expect(getSecret("skillswiki", env)).resolves.toBeNull();
    await expect(deleteSecret("skillswiki", env)).resolves.toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps the folder and the file private", async () => {
    const env = await fileEnv();
    await setSecret("demo", "k", env);
    expect((await stat(env.INSTALLER_KEYCHAIN_DIR)).mode & 0o777).toBe(0o700);
    expect((await stat(join(env.INSTALLER_KEYCHAIN_DIR, "demo"))).mode & 0o777).toBe(0o600);
    await expect(readdir(env.INSTALLER_KEYCHAIN_DIR)).resolves.toEqual(["demo"]);
  });

  it.each(["Demo", "a/b", "../x", ""])("refuses the secret id %j", async (id) => {
    const env = await fileEnv();
    await expect(getSecret(id, env)).rejects.toThrow(InputError);
  });

  it.each(["", "   ", "two\nlines", "tab\there"])("refuses the value %j", async (value) => {
    const env = await fileEnv();
    await expect(setSecret("demo", value, env)).rejects.toThrow(InputError);
  });
});

describe("backend selection", () => {
  it("needs the folder when the file backend is chosen", () => {
    expect(() => selectKeychain({ INSTALLER_KEYCHAIN: "file" })).toThrow(ActionFailure);
    expect(() => selectKeychain({ INSTALLER_KEYCHAIN: "file" })).toThrow("INSTALLER_KEYCHAIN=file needs INSTALLER_KEYCHAIN_DIR");
  });

  it("refuses an unknown backend name", () => {
    expect(() => selectKeychain({ INSTALLER_KEYCHAIN: "vault" })).toThrow("must be unset or 'file'");
  });

  it.skipIf(process.platform === "win32")("picks the OS keychain when nothing is set", () => {
    expect(selectKeychain({})).toBeDefined();
  });
});

describe("macOS security script", () => {
  it("passes the value on stdin with backslashes and double quotes escaped (fact 1)", () => {
    expect(macAddScript("skillswiki", 'a b"c\\d')).toBe('add-generic-password -U -s installer -a skillswiki -w "a b\\"c\\\\d"\n');
  });
});
```

Run: `npx vitest run tests/unit/keychain.test.ts`
Expected: FAIL — `src/core/keychain.ts` does not exist.

- [ ] **Step 3: Implement the keychain**

Create `src/core/keychain.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ActionFailure } from "./failure.js";
import { runProcess } from "./headless.js";
import { InputError } from "./inputs.js";

/** Keychain item: service `installer`, account `<secret id>`, one per OS user (D51). */
export const KEYCHAIN_SERVICE = "installer";
export const KEYCHAIN_ENV = "INSTALLER_KEYCHAIN";
export const KEYCHAIN_DIR_ENV = "INSTALLER_KEYCHAIN_DIR";
export const SECRET_ID_PATTERN = /^[a-z0-9-]+$/;
const KEYCHAIN_TIMEOUT_MS = 30_000;
/** `security` exits 44 when no item matches (verified live, macOS). */
const MAC_NOT_FOUND = 44;

type Env = Readonly<Record<string, string | undefined>>;

export interface Keychain {
  readonly get: (id: string) => Promise<string | null>;
  readonly set: (id: string, value: string) => Promise<void>;
  readonly delete: (id: string) => Promise<boolean>;
}

export function requireSecretId(id: string): string {
  if (!SECRET_ID_PATTERN.test(id)) throw new InputError(`Secret id '${id}' must be lowercase letters, digits and dashes`);
  return id;
}

/** Keys are single lines: a control character would break the keychain command protocol. */
export function requireSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new InputError("The secret is empty");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new InputError("The secret must be a single line");
  return trimmed;
}

/** The `security -i` script that stores a value read from stdin, never from argv (verified live: `\` and `"` escaped). */
export function macAddScript(id: string, value: string): string {
  const escaped = value.replace(/[\\"]/g, (char) => `\\${char}`);
  return `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -w "${escaped}"\n`;
}

async function keychainCommand(argv: readonly string[], input?: string): Promise<{ code: number | null; stdout: string; error?: string }> {
  return runProcess(argv, process.cwd(), KEYCHAIN_TIMEOUT_MS, input);
}

function requireOk(result: { code: number | null; error?: string }, what: string): void {
  if (result.code === 0) return;
  throw new ActionFailure(`The keychain could not ${what} (${result.error ?? `exit ${result.code}`})`);
}

const macBackend: Keychain = {
  get: async (id) => {
    const result = await keychainCommand(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"]);
    if (result.code === MAC_NOT_FOUND) return null;
    requireOk(result, `read '${id}'`);
    return result.stdout.replace(/\n$/, "");
  },
  set: async (id, value) => requireOk(await keychainCommand(["security", "-i"], macAddScript(id, value)), `store '${id}'`),
  delete: async (id) => {
    const result = await keychainCommand(["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id]);
    if (result.code === MAC_NOT_FOUND) return false;
    requireOk(result, `delete '${id}'`);
    return true;
  },
};

/** Linux Secret Service through `secret-tool`; the value travels on stdin. Not verified on this project's machine. */
const linuxBackend: Keychain = {
  get: async (id) => {
    const result = await keychainCommand(["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", id]);
    if (result.code === 1) return null;
    requireOk(result, `read '${id}'`);
    return result.stdout.replace(/\n$/, "");
  },
  set: async (id, value) => {
    const argv = ["secret-tool", "store", `--label=${KEYCHAIN_SERVICE}:${id}`, "service", KEYCHAIN_SERVICE, "account", id];
    requireOk(await keychainCommand(argv, value), `store '${id}'`);
  },
  delete: async (id) => (await keychainCommand(["secret-tool", "clear", "service", KEYCHAIN_SERVICE, "account", id])).code === 0,
};

/** Files of mode 0600 in a private folder; used by the test suite and as the fallback where no keychain exists. */
function fileBackend(dir: string): Keychain {
  const pathOf = (id: string): string => join(dir, id);
  return {
    get: async (id) => {
      try {
        return await readFile(pathOf(id), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new ActionFailure(`The keychain folder ${dir} cannot be read (${(error as NodeJS.ErrnoException).code})`);
      }
    },
    set: async (id, value) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(pathOf(id), value, { encoding: "utf8", mode: 0o600 });
    },
    delete: async (id) => {
      const existed = (await fileBackend(dir).get(id)) !== null;
      await rm(pathOf(id), { force: true });
      return existed;
    },
  };
}

export function selectKeychain(env: Env = process.env): Keychain {
  const chosen = env[KEYCHAIN_ENV];
  if (chosen === "file") {
    const dir = env[KEYCHAIN_DIR_ENV];
    if (!dir) throw new ActionFailure(`${KEYCHAIN_ENV}=file needs ${KEYCHAIN_DIR_ENV} to name a private folder`);
    return fileBackend(resolve(dir));
  }
  if (chosen !== undefined && chosen !== "") throw new ActionFailure(`${KEYCHAIN_ENV} must be unset or 'file', got '${chosen}'`);
  if (process.platform === "darwin") return macBackend;
  if (process.platform === "linux") return linuxBackend;
  throw new ActionFailure(`No keychain backend for ${process.platform} yet; set ${KEYCHAIN_ENV}=file and ${KEYCHAIN_DIR_ENV}=<private folder>`);
}

export async function getSecret(id: string, env?: Env): Promise<string | null> {
  return selectKeychain(env).get(requireSecretId(id));
}

export async function setSecret(id: string, value: string, env?: Env): Promise<void> {
  return selectKeychain(env).set(requireSecretId(id), requireSecretValue(value));
}

export async function deleteSecret(id: string, env?: Env): Promise<boolean> {
  return selectKeychain(env).delete(requireSecretId(id));
}
```

Run: `npx vitest run tests/unit/keychain.test.ts` — Expected: PASS (14 tests). The macOS and Linux backends are exercised only through `macAddScript` and the live guide (Task 10); the Linux backend was not run on this project's machine.

- [ ] **Step 4: Give the test suite a throwaway file keychain**

In `vitest.config.ts`, replace:

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    // Operator-only folder of extra runtime profiles; solutions name them by id (D34).
    env: { INSTALLER_PROFILE_DIR: resolve("tests/fixtures/profiles") },
  },
});
```

with:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    env: {
      // Operator-only folder of extra runtime profiles; solutions name them by id (D34).
      INSTALLER_PROFILE_DIR: resolve("tests/fixtures/profiles"),
      // Tests never touch the real OS keychain: a throwaway file keychain per run (D51).
      INSTALLER_KEYCHAIN: "file",
      INSTALLER_KEYCHAIN_DIR: mkdtempSync(join(tmpdir(), "installer-keychain-")),
    },
  },
});
```

- [ ] **Step 5: Write the failing check and solution-rule tests**

In `tests/unit/actions.test.ts`, replace:

```ts
import { describe, expect, it } from "vitest";
import { resolveInHome, runAction, runCheck } from "../../src/core/actions.js";
import { InputError } from "../../src/core/inputs.js";
import { makeTempHome } from "../helpers/temp-home.js";
```

with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInHome, runAction, runCheck } from "../../src/core/actions.js";
import { InputError } from "../../src/core/inputs.js";
import { setSecret } from "../../src/core/keychain.js";
import { makeTempHome } from "../helpers/temp-home.js";
```

In `tests/unit/actions.test.ts`, add after:

```ts
  it("rejects prototype member lookups like toString", async () => {
    const home = await makeTempHome();
    await expect(runCheck(home, { check: "toString" })).rejects.toThrow(InputError);
  });
});
```

this:

```ts

describe("secret_present", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails with a hint naming the secret command until the key is stored, then passes", async () => {
    const home = await makeTempHome();
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
    const check = { check: "secret_present", args: { id: "demo" } };
    await expect(runCheck(home, check)).resolves.toEqual({ ok: false, hint: expect.stringContaining("run 'installer secret demo'") });
    await setSecret("demo", "k-1");
    await expect(runCheck(home, check)).resolves.toEqual({ ok: true });
  });

  it("refuses an id that is not a secret id", async () => {
    await expect(runCheck(await makeTempHome(), { check: "secret_present", args: { id: "../x" } })).rejects.toThrow(InputError);
  });
});
```

In `tests/unit/solution.test.ts`, add before:

```ts
describe("loadSolution", () => {
```

this:

```ts
describe("secret steps (§8.3)", () => {
  const secret = (extra: Record<string, unknown>) => ({ id: "s", version: "1", steps: [{ step_id: "brain.key", phase: "BRAIN", type: "human_action", title: "Key", why: "Needed.", blocking: true, input: { kind: "secret", provider: "demo" }, ...extra }] });

  it("accepts a step whose provider matches its secret_present check", () => {
    expect(parseSolution(secret({ verify: { check: "secret_present", args: { id: "demo" } } })).steps).toHaveLength(1);
  });

  it.each([
    ["no provider", { input: { kind: "secret" }, verify: { check: "secret_present", args: { id: "demo" } } }, /needs input\.provider/],
    ["a provider that is not a secret id", { input: { kind: "secret", provider: "Demo Key" }, verify: { check: "secret_present", args: { id: "Demo Key" } } }, /needs input\.provider/],
    ["no check", {}, /must verify with/],
    ["a check for another id", { verify: { check: "secret_present", args: { id: "other" } } }, /must verify with/],
    ["a different check", { verify: { check: "file_exists", args: { path: "x" } } }, /must verify with/],
  ])("refuses a secret step with %s", (_name, extra, message) => {
    expect(() => parseSolution(secret(extra))).toThrow(SolutionError);
    expect(() => parseSolution(secret(extra))).toThrow(message);
  });
});
```

The Plan 1 secret test in `tests/unit/engine-actions.test.ts` builds a `human_action` secret step without a provider or a check, which the new rule refuses; give it both (the `submit` refusals it asserts come first and still hold):

In `tests/unit/engine-actions.test.ts`, replace:

```ts
      steps: [{ step_id: "s", phase: "BRAIN", type: "human_action", title: "Enter key", why: "Needed.", blocking: true, input: { kind: "secret" } }],
```

with:

```ts
      steps: [{ step_id: "s", phase: "BRAIN", type: "human_action", title: "Enter key", why: "Needed.", blocking: true, input: { kind: "secret", provider: "demo" }, verify: { check: "secret_present", args: { id: "demo" } } }],
```

Run: `npx vitest run tests/unit/actions.test.ts tests/unit/solution.test.ts tests/unit/engine-actions.test.ts`
Expected: FAIL — `secret_present` is an unknown check; the secret-step refusals do not throw.

- [ ] **Step 6: Add the check and the rule**

In `src/core/actions.ts`, replace:

```ts
import { InputError } from "./inputs.js";
import { deriveModeAction } from "./mode.js";
```

with:

```ts
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { deriveModeAction } from "./mode.js";
```

In `src/core/actions.ts`, replace:

```ts
      return { ok: false, hint: typeof args.hint === "string" ? args.hint : `Expected ${path} to exist` };
    }
  },
};
```

with:

```ts
      return { ok: false, hint: typeof args.hint === "string" ? args.hint : `Expected ${path} to exist` };
    }
  },
  secret_present: async (_home, args) => {
    const id = stringArg(args, "id");
    if ((await getSecret(id)) !== null) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : `No '${id}' key is stored yet: run 'installer secret ${id}', enter it on the page that opens, then run the verify again` };
  },
};
```

In `src/core/solution.ts`, add before:

```ts
export function parseSolution(raw: unknown): Solution {
```

this:

```ts
const SECRET_ID = /^[a-z0-9-]+$/;

/** A secret step names its id in input.provider and is confirmed by secret_present for that id, so `installer secret <provider>` always fits (§8.3). */
function checkSecretSteps(steps: readonly StepDef[]): void {
  for (const step of steps) {
    if (step.type !== "human_action" || step.input?.kind !== "secret") continue;
    const provider = step.input.provider;
    if (!provider || !SECRET_ID.test(provider)) throw new SolutionError(`Step '${step.step_id}': a secret step needs input.provider, the secret id entered with 'installer secret <provider>'`);
    if (step.verify?.check !== "secret_present" || step.verify.args?.id !== provider) {
      throw new SolutionError(`Step '${step.step_id}': a secret step must verify with { "check": "secret_present", "args": { "id": "${provider}" } }`);
    }
  }
}
```

In `src/core/solution.ts`, replace:

```ts
  checkModeReferences(steps);
  checkProbeArgs(steps);
  return { id, version, steps };
```

with:

```ts
  checkModeReferences(steps);
  checkProbeArgs(steps);
  checkSecretSteps(steps);
  return { id, version, steps };
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/unit/keychain.test.ts tests/unit/actions.test.ts tests/unit/solution.test.ts tests/unit/headless.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (14 + 21 + 19 + 10 tests); typecheck exits 0; the whole suite passes: 23 files, 289 tests.

- [ ] **Step 8: Commit**

```bash
git add src/core/keychain.ts src/core/headless.ts src/core/actions.ts src/core/solution.ts vitest.config.ts tests/unit/keychain.test.ts tests/unit/actions.test.ts tests/unit/solution.test.ts tests/unit/engine-actions.test.ts
git commit -m "feat(core): store secrets in the OS keychain, check them with secret_present"
```

---

### Task 3: The secret page and `installer secret` (D47)

**Files:**
- Create: `src/core/secret-page.ts`, `tests/helpers/http.ts`
- Modify: `src/cli.ts` (command table, `secret`, `secret-serve`), `vitest.config.ts` (`INSTALLER_BROWSER=none`)
- Test: `tests/unit/secret-page.test.ts` (new), `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `requireSecretId`, `setSecret` (Task 2), `InputError`.
- Produces:
  - `secret-page.ts`: `SECRET_PAGE_TTL_MS = 600_000`, `BROWSER_ENV = "INSTALLER_BROWSER"`, `startSecretPage({ id, store, ttlMs? }): Promise<{ url, done: Promise<"stored" | "expired">, close() }>`, `launchSecretPage(id): Promise<{ url, pid }>` (spawns `installer secret-serve <id>` detached with an IPC channel; the child reports `{ url }` and disconnects), `headlessHint(url, env?)`, `openBrowser(url, env?)`.
  - CLI: `installer secret <id>` prints `{"status":"waiting","url","pid"[,"hint"]}` and exits 0; `installer secret-serve <id>` is the page process (hidden; it writes only the keychain and never reads the engine home).
  - `tests/helpers/http.ts`: `request(url, { method?, headers?, body? })` on a fresh connection with the exact `Host`/`Origin` given, `formHeaders(origin)`, `waitForExit(pid)`.

- [ ] **Step 1: Write the HTTP test helper**

Create `tests/helpers/http.ts`:

```ts
import { request as httpRequest } from "node:http";

export interface HttpReply {
  readonly status: number;
  readonly text: string;
}

/** A raw request on a fresh connection whose Host and Origin headers are exactly what the test says (fetch would rewrite Host). */
export function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  const target = new URL(url);
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? "GET", headers: options.headers ?? {}, setHost: options.headers?.Host === undefined, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

export const formHeaders = (origin: string): Record<string, string> => ({ Origin: origin, "Content-Type": "application/x-www-form-urlencoded" });

/** Polls until the process is gone; fails after the timeout. */
export async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > until) throw new Error(`Process ${pid} is still running`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}
```

- [ ] **Step 2: Write the failing page tests**

Create `tests/unit/secret-page.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { headlessHint, openBrowser, startSecretPage, type SecretPage } from "../../src/core/secret-page.js";
import { formHeaders, request } from "../helpers/http.js";

const pages: SecretPage[] = [];
const stored: string[] = [];

async function page(store: (value: string) => Promise<void> = async (value) => void stored.push(value), ttlMs?: number): Promise<SecretPage> {
  const started = await startSecretPage({ id: "skillswiki", store, ...(ttlMs ? { ttlMs } : {}) });
  pages.push(started);
  return started;
}

const originOf = (url: string): string => new URL(url).origin;

afterEach(() => {
  pages.splice(0).forEach((open) => open.close());
  stored.splice(0);
});

describe("the secret page", () => {
  it("serves a password form on its one-time path, uncached", async () => {
    const { url } = await page();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    const reply = await request(url);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('<input type="password" name="value" autocomplete="off"');
    expect(reply.text).toContain("<code>skillswiki</code>");
  });

  it("stores one submitted value, says done, then stops serving (Review Focus 1)", async () => {
    const { url, done } = await page();
    const reply = await request(url, { method: "POST", headers: formHeaders(originOf(url)), body: "value=%20sw_live_123%20" });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Done, you can close this tab.");
    expect(stored).toEqual([" sw_live_123 "]);
    await expect(done).resolves.toBe("stored");
    await expect(request(url)).rejects.toThrow(/ECONNREFUSED/);
  });

  it.each([
    ["a wrong token", (url: string) => ({ url: `${originOf(url)}/s/${"0".repeat(64)}`, headers: formHeaders(originOf(url)) }), 404],
    ["a foreign Host header", (url: string) => ({ url, headers: { ...formHeaders(originOf(url)), Host: "evil.test" } }), 403],
    ["a foreign Origin", (url: string) => ({ url, headers: formHeaders("http://evil.test") }), 403],
    ["no Origin at all", (url: string) => ({ url, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), 403],
  ])("refuses a POST with %s and stores nothing (Review Focus 1)", async (_name, make, status) => {
    const { url } = await page();
    const target = make(url);
    const reply = await request(target.url, { method: "POST", headers: target.headers, body: "value=leak" });
    expect(reply.status).toBe(status);
    expect(stored).toEqual([]);
    expect((await request(url)).status).toBe(200);
  });

  it("shows the form again with the reason when the value is refused, and stays open", async () => {
    const { url } = await page(async (value) => {
      if (value.trim() === "") throw new InputError("The secret is empty");
    });
    const reply = await request(url, { method: "POST", headers: formHeaders(originOf(url)), body: "value=" });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("The secret is empty");
    expect(reply.text).toContain("<form");
    expect((await request(url)).status).toBe(200);
  });

  it("reports a keychain failure as a server error and stays open", async () => {
    const { url } = await page(async () => {
      throw new ActionFailure("The keychain could not store 'skillswiki' (exit 1)");
    });
    const reply = await request(url, { method: "POST", headers: formHeaders(originOf(url)), body: "value=k" });
    expect(reply.status).toBe(500);
    expect(reply.text).toContain("The keychain could not store");
  });

  it("expires unused after its time to live", async () => {
    const { url, done } = await page(undefined, 100);
    await expect(done).resolves.toBe("expired");
    await expect(request(url)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("browser and headless host", () => {
  it("prints an ssh tunnel hint over ssh (D47 headless host)", () => {
    const hint = headlessHint("http://127.0.0.1:4321/s/abc", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" });
    expect(hint).toBe("This machine has no browser: from your laptop run 'ssh -L 4321:127.0.0.1:4321 <user>@<this host>', then open http://127.0.0.1:4321/s/abc there");
  });

  it("gives no hint on a desktop", () => {
    expect(headlessHint("http://127.0.0.1:4321/s/abc", { DISPLAY: ":0" })).toBeUndefined();
  });

  it("opens nothing when INSTALLER_BROWSER is none", () => {
    expect(openBrowser("http://127.0.0.1:1/s/x", { INSTALLER_BROWSER: "none" })).toBe(false);
  });

  it("survives an opener that does not exist", () => {
    expect(openBrowser("http://127.0.0.1:1/s/x", { INSTALLER_BROWSER: "installer-test-no-such-browser" })).toBe(true);
  });
});
```

Run: `npx vitest run tests/unit/secret-page.test.ts`
Expected: FAIL — `src/core/secret-page.ts` does not exist.

- [ ] **Step 3: Implement the page**

Create `src/core/secret-page.ts`:

```ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { InputError } from "./inputs.js";

/** The page closes itself after ten minutes with nothing entered (D47). */
export const SECRET_PAGE_TTL_MS = 600_000;
/** Names the command that opens the browser; `none` opens nothing (tests, servers). */
export const BROWSER_ENV = "INSTALLER_BROWSER";
const MAX_BODY_BYTES = 65_536;
const HOST = "127.0.0.1";

export interface SecretPageOptions {
  readonly id: string;
  readonly store: (value: string) => Promise<void>;
  readonly ttlMs?: number;
}

export interface SecretPage {
  readonly url: string;
  /** Resolves once a value was stored, or when the page expired unused. */
  readonly done: Promise<"stored" | "expired">;
  readonly close: () => void;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function formPage(id: string, action: string, error?: string): string {
  const notice = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>installer: enter the ${escapeHtml(id)} key</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}input{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}button{margin-top:1rem;font-size:1rem;padding:.5rem 1.5rem}.error{color:#b00020}</style></head>
<body><h1>Enter the <code>${escapeHtml(id)}</code> key</h1>
<p>This page is served by the installer on this computer only. The key goes into your keychain; the agent never sees it.</p>${notice}
<form method="post" action="${action}"><input type="password" name="value" autocomplete="off" autofocus required><button type="submit">Save</button></form>
</body></html>`;
}

const DONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>installer: done</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto"><h1>Done, you can close this tab.</h1></body></html>`;

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        fail(new InputError("The submitted form is too large"));
        req.destroy();
      }
    });
    req.on("end", () => done(body));
    req.on("error", fail);
  });
}

interface PageState {
  readonly path: string;
  readonly origin: string;
  finished: boolean;
}

/** GET shows the form; POST (same origin only) stores one value and ends the page (D47). */
async function handle(req: IncomingMessage, res: ServerResponse, page: PageState, options: SecretPageOptions, finish: () => void): Promise<void> {
  if (req.headers.host !== page.origin.slice("http://".length)) return send(res, 403, "Forbidden");
  if (req.url !== page.path) return send(res, 404, "Not found");
  if (page.finished) return send(res, 410, DONE_PAGE);
  if (req.method === "GET") return send(res, 200, formPage(options.id, page.path));
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (req.headers.origin !== page.origin) return send(res, 403, "Forbidden");
  const value = new URLSearchParams(await readBody(req)).get("value") ?? "";
  try {
    await options.store(value);
  } catch (error) {
    const status = error instanceof InputError ? 400 : 500;
    return send(res, status, formPage(options.id, page.path, (error as Error).message));
  }
  page.finished = true;
  send(res, 200, DONE_PAGE);
  finish();
}

function listen(server: Server): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, HOST, () => done((server.address() as AddressInfo).port));
  });
}

export async function startSecretPage(options: SecretPageOptions): Promise<SecretPage> {
  const path = `/s/${randomBytes(32).toString("hex")}`;
  let settle: (how: "stored" | "expired") => void = () => undefined;
  const done = new Promise<"stored" | "expired">((resolve) => {
    settle = resolve;
  });
  const server = createServer();
  const close = (how: "stored" | "expired"): void => {
    server.close();
    server.closeAllConnections();
    settle(how);
  };
  const port = await listen(server);
  const page: PageState = { path, origin: `http://${HOST}:${port}`, finished: false };
  server.on("request", (req, res) => {
    handle(req, res, page, options, () => close("stored")).catch((error: Error) => send(res, 400, formPage(options.id, path, error.message)));
  });
  setTimeout(() => close("expired"), options.ttlMs ?? SECRET_PAGE_TTL_MS).unref();
  return { url: `${page.origin}${path}`, done, close: () => close("expired") };
}

/** Starts `installer secret-serve <id>` detached; the child reports its url over IPC and lives on after this process exits. */
export function launchSecretPage(id: string): Promise<{ url: string; pid: number }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [process.argv[1] ?? "", "secret-serve", id], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.once("message", (message) => {
      const { url } = message as { url?: unknown };
      if (typeof url !== "string" || !child.pid) return fail(new Error("The secret page did not report its url"));
      child.unref();
      done({ url, pid: child.pid });
    });
    child.once("exit", (code) => fail(new Error(`The secret page could not start (exit ${code})`)));
    child.once("error", fail);
  });
}

type Env = Readonly<Record<string, string | undefined>>;

/** On a machine without a browser, the person tunnels the port from their laptop (D47 headless host). */
export function headlessHint(url: string, env: Env = process.env): string | undefined {
  const headless = Boolean(env.SSH_CONNECTION) || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY);
  if (!headless) return undefined;
  const { port } = new URL(url);
  return `This machine has no browser: from your laptop run 'ssh -L ${port}:127.0.0.1:${port} <user>@<this host>', then open ${url} there`;
}

/** Best effort: a missing opener is not an error, the url is printed anyway. */
export function openBrowser(url: string, env: Env = process.env): boolean {
  const fallback = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : "none";
  const opener = env[BROWSER_ENV] || fallback;
  if (opener === "none") return false;
  spawn(opener, [url], { detached: true, stdio: "ignore" })
    .on("error", () => undefined)
    .unref();
  return true;
}
```

Run: `npx vitest run tests/unit/secret-page.test.ts` — Expected: PASS (13 tests).

- [ ] **Step 4: Wire the commands and turn `run` into a command table**

In `src/cli.ts`, replace:

```ts
import { InputError } from "./core/inputs.js";
import { buildReport, renderReport } from "./core/report.js";
```

with:

```ts
import { InputError } from "./core/inputs.js";
import { requireSecretId, setSecret } from "./core/keychain.js";
import { buildReport, renderReport } from "./core/report.js";
import { headlessHint, launchSecretPage, openBrowser, startSecretPage } from "./core/secret-page.js";
```

In `src/cli.ts`, replace:

```ts
const COMMANDS = "start, next, submit, verify, resume, report, probe";
```

with:

```ts
const COMMANDS = "start, next, submit, verify, resume, report, probe, secret";
```

In `src/cli.ts`, replace:

```ts
async function run(argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parse(argv);
  const home = resolve(flags.home || process.env.INSTALLER_HOME || join(homedir(), ".installer"));
  const [command, arg] = positionals;
  if (command === "start") {
    emit(process.stdout, await startCommand(home, flags));
    return EXIT.OK;
  }
  if (command === "probe") {
    emit(process.stdout, await probeCommand(flags));
    return EXIT.OK;
  }
  if (!command || !["next", "submit", "verify", "resume", "report"].includes(command)) {
    throw new InputError(`Unknown command '${command ?? ""}'. Commands: ${COMMANDS}`);
  }
  const { state, deps } = await loadInstall(home);
  if (command === "next") emit(process.stdout, (await advance(deps, state)).result);
  if (command === "submit") emit(process.stdout, (await submit(deps, state, requireArg(arg, command), submitPayload(flags))).result);
  if (command === "verify") {
    const verified = await verifyStep(deps, state, requireArg(arg, command));
    emit(process.stdout, { ...verified.result, next: verified.next });
  }
  if (command === "resume") emit(process.stdout, (await resume(deps, state)).result);
  if (command === "report") {
    const report = buildReport(deps.solution, state);
    emit(process.stdout, flags.json ? report : renderReport(report));
  }
  return EXIT.OK;
}
```

with:

```ts
/** `installer secret <id>`: starts the page detached, opens the browser, returns at once (D47). */
async function secretCommand(id: string): Promise<unknown> {
  const { url, pid } = await launchSecretPage(requireSecretId(id));
  const hint = headlessHint(url);
  if (!hint) openBrowser(url);
  return { status: "waiting", url, pid, ...(hint ? { hint } : {}) };
}

/** The detached page process: serves the form, writes the keychain once, then exits. Never touches the engine home. */
async function secretServeCommand(id: string): Promise<number> {
  const page = await startSecretPage({ id: requireSecretId(id), store: (value) => setSecret(id, value) });
  if (process.send) {
    process.send({ url: page.url });
    process.disconnect();
  } else {
    emit(process.stdout, { url: page.url });
  }
  await page.done;
  return EXIT.OK;
}

type Standalone = (home: string, flags: Flags, arg: string | undefined) => Promise<unknown>;
type OnInstall = (install: { state: InstallState; deps: EngineDeps }, flags: Flags, arg: string | undefined) => Promise<unknown>;

/** Commands that need no install state. */
const STANDALONE: Readonly<Record<string, Standalone>> = {
  start: (home, flags) => startCommand(home, flags),
  probe: (_home, flags) => probeCommand(flags),
  secret: (_home, _flags, arg) => secretCommand(requireArg(arg, "secret")),
};

/** Commands that run on the install in the home. */
const ON_INSTALL: Readonly<Record<string, OnInstall>> = {
  next: async ({ state, deps }) => (await advance(deps, state)).result,
  submit: async ({ state, deps }, flags, arg) => (await submit(deps, state, requireArg(arg, "submit"), submitPayload(flags))).result,
  verify: async ({ state, deps }, _flags, arg) => {
    const verified = await verifyStep(deps, state, requireArg(arg, "verify"));
    return { ...verified.result, next: verified.next };
  },
  resume: async ({ state, deps }) => (await resume(deps, state)).result,
  report: async ({ state, deps }, flags) => {
    const report = buildReport(deps.solution, state);
    return flags.json ? report : renderReport(report);
  },
};

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parse(argv);
  const home = resolve(flags.home || process.env.INSTALLER_HOME || join(homedir(), ".installer"));
  const [command = "", arg] = positionals;
  if (command === "secret-serve") return secretServeCommand(requireArg(arg, command));
  if (Object.hasOwn(STANDALONE, command)) {
    emit(process.stdout, await STANDALONE[command](home, flags, arg));
    return EXIT.OK;
  }
  if (!Object.hasOwn(ON_INSTALL, command)) throw new InputError(`Unknown command '${command}'. Commands: ${COMMANDS}`);
  emit(process.stdout, await ON_INSTALL[command](await loadInstall(home), flags, arg));
  return EXIT.OK;
}
```

In `vitest.config.ts`, replace:

```ts
      INSTALLER_KEYCHAIN_DIR: mkdtempSync(join(tmpdir(), "installer-keychain-")),
    },
```

with:

```ts
      INSTALLER_KEYCHAIN_DIR: mkdtempSync(join(tmpdir(), "installer-keychain-")),
      // `installer secret` must never open a browser tab during a test run.
      INSTALLER_BROWSER: "none",
    },
```

- [ ] **Step 5: Write the failing end-to-end test**

In `tests/e2e/cli.test.ts`, replace:

```ts
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_PATH, FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";
```

with:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { getSecret } from "../../src/core/keychain.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { formHeaders, request, waitForExit } from "../helpers/http.js";
import { FIXTURE_PATH, FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";
```

In `tests/e2e/cli.test.ts`, add before:

```ts
  it("report prints text by default and JSON with --json", async () => {
```

this:

```ts
  describe("installer secret (D47)", () => {
    const pids: number[] = [];

    afterEach(() => {
      for (const pid of pids.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone, which is what the tests expect
        }
      }
    });

    it("prints a waiting url and exits; the page stores one key in the keychain, then exits too", async () => {
      const dir = await makeTempHome();
      const result = runCli(["secret", "skillswiki"], { env: { INSTALLER_KEYCHAIN_DIR: dir } });
      expect(result.code).toBe(0);
      const { status, url, pid } = result.json as { status: string; url: string; pid: number };
      pids.push(pid);
      expect(status).toBe("waiting");
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
      expect((await request(url)).status).toBe(200);
      const reply = await request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: "value=sw_live_123" });
      expect(reply.text).toContain("Done, you can close this tab.");
      await expect(getSecret("skillswiki", { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir })).resolves.toBe("sw_live_123");
      await waitForExit(pid);
    });

    it("refuses an id that is not a secret id, exit 2, and starts no page", () => {
      const result = runCli(["secret", "Skills Wiki"], {});
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: "Secret id 'Skills Wiki' must be lowercase letters, digits and dashes" });
    });
  });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/unit/secret-page.test.ts tests/e2e/cli.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (13 + 34 tests); typecheck exits 0; the whole suite passes: 24 files, 305 tests. No browser window opens.

- [ ] **Step 7: Commit**

```bash
git add src/core/secret-page.ts src/cli.ts vitest.config.ts tests/helpers/http.ts tests/unit/secret-page.test.ts tests/e2e/cli.test.ts
git commit -m "feat(cli): enter secrets on a detached local page"
```

---

### Task 4: MCP client, fake Skills Wiki server and `skillswiki.ts` (D55)

**Files:**
- Create: `src/core/mcp.ts`, `src/core/skillswiki.ts`, `tests/fakes/fake-mcp-server.mjs`, `tests/helpers/fake-mcp.ts`, `tests/fixtures/skillswiki/demo/install/recipe.json`, `tests/fixtures/skillswiki/demo/install/notes.md`
- Test: `tests/unit/mcp.test.ts` (new), `tests/unit/skillswiki.test.ts` (new)

**Interfaces:**
- Consumes: `ActionFailure` (Task 1), `getSecret` (Task 2).
- Produces:
  - `mcp.ts`: `MCP_PROTOCOL_VERSION = "2025-06-18"`, `MCP_TIMEOUT_MS = 30_000`, `MCP_MAX_BYTES = 1_000_000`, `KEY_REJECTED_HINT`, `interface McpTarget { url; key }`, `type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string }`, `callTool(target, name, args?)`. Transport failures (network, timeout, 401, non-2xx, oversized, unparsable, missing id) throw `ActionFailure`; a JSON-RPC error or `isError: true` is an `ok: false` outcome.
  - `skillswiki.ts`: `SKILLSWIKI_SECRET_ID = "skillswiki"`, `SKILLSWIKI_MCP_NAME = "skillswiki"`, `KEY_MISSING_HINT`, `URL_MISSING_HINT`, `parseSkillswikiRef(ref)`, `stripSkillWrapper(content)`, `fetchSkillswikiSolution(target, ref)`, `activeComboSlug(target): Promise<string | null>`, `skillswikiTarget(url, env?)`.
  - Fake server protocol (`tests/fakes/fake-mcp-server.mjs`, started by `startFakeMcp(env?)` from `tests/helpers/fake-mcp.ts`, which resolves `{ url, key, stop }`): `FAKE_MCP_KEY` (default `test-key`), `FAKE_MCP_COMBO` (default `demo-combo`; empty = no active combo), `FAKE_MCP_DIR` (default `tests/fixtures/skillswiki`, served as `<pack>/<skill>/<path>`). Facts 6–8 exactly: 401 without the key, SSE answers with `mcp-session-id`, 202 for the notification, 400 for a missing session, `isError` for a missing file.

- [ ] **Step 1: Write the fixture resources and the fake server**

Create `tests/fixtures/skillswiki/demo/install/recipe.json`:

```json
{
  "id": "fixture-skillswiki",
  "version": "1.0.0",
  "steps": [
    { "step_id": "mode.name", "phase": "MODE", "type": "ask", "title": "Team name", "why": "Used in reports.", "blocking": true, "input": { "kind": "text" } },
    { "step_id": "report.final", "phase": "REPORT", "type": "auto", "title": "Finish the install", "why": "Marks the install as finished.", "blocking": true,
      "auto": { "action": "write_file", "args": { "path": "config/finished.txt", "content": "done\n" } } }
  ]
}
```



Create `tests/fixtures/skillswiki/demo/install/notes.md`:

```markdown
A second resource, so the folder form of get_skill_resource has two entries.
```



Create `tests/fakes/fake-mcp-server.mjs`:

```js
#!/usr/bin/env node
// Test double for the hosted Skills Wiki MCP server (Streamable HTTP), shaped like the live answers
// observed on 2026-10-08: 401 without the key, SSE answers with an mcp-session-id, 202 for the
// initialized notification, get_active_combo and get_skill_resource results.
// FAKE_MCP_KEY: the accepted Bearer key (default test-key). FAKE_MCP_COMBO: the active combo slug
// (default demo-combo; empty = no combo activated). FAKE_MCP_DIR: folder served as <pack>/<skill>/<path>.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const key = process.env.FAKE_MCP_KEY ?? "test-key";
const comboSlug = process.env.FAKE_MCP_COMBO ?? "demo-combo";
const resourceDir = process.env.FAKE_MCP_DIR ?? "";
const sessions = new Set();

const toolResult = (payload, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError });
const noCombo = { combo: null, combo_slug: null, has_loop: false, learning_mode: false, skills: [], skill_tools: [], skills_not_mounted: [], harness: "" };

function activeCombo() {
  if (!comboSlug) return toolResult(noCombo);
  const combo = { id: "combo-1", name: "Demo combo", slug: comboSlug, kind: "combo", description: "Fixture combo", activated_at: "2026-10-08T00:00:00Z" };
  return toolResult({ ...noCombo, combo, combo_slug: comboSlug, skills: ["demo/install"] });
}

function skillResource({ pack, skill_name: skill, path }) {
  const base = join(resourceDir, pack, skill);
  try {
    if (!path) return toolResult({ resources: readdirSync(base).map((name) => ({ path: name, kind: "reference", size: statSync(join(base, name)).size })) });
    const content = readFileSync(join(base, path), "utf8");
    return toolResult({ path, kind: "reference", content: `<skill_reference>\n${content}\n</skill_reference>` });
  } catch {
    return { content: [{ type: "text", text: `Resource not found: ${pack}/${skill}/${path}` }], isError: true };
  }
}

function callTool(params) {
  if (params.name === "get_active_combo") return { result: activeCombo() };
  if (params.name === "get_skill_resource") return { result: skillResource(params.arguments ?? {}) };
  return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
}

function answer(req, res, message) {
  if (message.method === "initialize") {
    const session = randomUUID();
    sessions.add(session);
    const result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-skills-wiki", version: "0.0.0" } };
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": session });
    return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  }
  if (!sessions.has(req.headers["mcp-session-id"])) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "missing or unknown mcp-session-id" }));
  }
  if (message.method === "notifications/initialized") {
    res.writeHead(202);
    return res.end();
  }
  const body = message.method === "tools/call" ? callTool(message.params ?? {}) : { error: { code: -32601, message: `Unknown method: ${message.method}` } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })}\n\n`);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    answer(req, res, JSON.parse(raw));
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` })}\n`);
});
```



Create `tests/helpers/fake-mcp.ts`:

```ts
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface FakeMcp {
  readonly url: string;
  readonly key: string;
  readonly stop: () => void;
}

/** Starts tests/fakes/fake-mcp-server.mjs on a free port; resolves once it printed its url. */
export function startFakeMcp(env: Record<string, string> = {}): Promise<FakeMcp> {
  const child = spawn(process.execPath, [resolve("tests/fakes/fake-mcp-server.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FAKE_MCP_DIR: resolve("tests/fixtures/skillswiki"), ...env },
  });
  return new Promise((done, fail) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const { url } = JSON.parse(buffer.slice(0, newline)) as { url: string };
      done({ url, key: env.FAKE_MCP_KEY ?? "test-key", stop: () => void child.kill("SIGKILL") });
    });
    child.once("exit", (code) => fail(new Error(`fake MCP server exited with ${code}`)));
    child.once("error", fail);
  });
}
```

- [ ] **Step 2: Write the failing client tests**

Create `tests/unit/mcp.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { KEY_REJECTED_HINT, MCP_MAX_BYTES, callTool } from "../../src/core/mcp.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";

const servers: FakeMcp[] = [];

async function server(env: Record<string, string> = {}): Promise<FakeMcp> {
  const started = await startFakeMcp(env);
  servers.push(started);
  return started;
}

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
  vi.restoreAllMocks();
});

describe("callTool against the fake Skills Wiki (facts 5 and 6)", () => {
  it("initializes, echoes the session id and returns structuredContent", async () => {
    const fake = await server();
    const outcome = await callTool({ url: fake.url, key: fake.key }, "get_active_combo");
    expect(outcome).toMatchObject({ ok: true, value: { combo_slug: "demo-combo", combo: { slug: "demo-combo" } } });
  });

  it("passes tool arguments and returns the folder form of get_skill_resource", async () => {
    const fake = await server();
    const outcome = await callTool({ url: fake.url, key: fake.key }, "get_skill_resource", { pack: "demo", skill_name: "install", path: "" });
    expect(outcome).toMatchObject({ ok: true, value: { resources: [{ path: "notes.md", kind: "reference" }, { path: "recipe.json", kind: "reference" }] } });
  });

  it("reports an isError answer as a tool error, not a crash", async () => {
    const fake = await server();
    const outcome = await callTool({ url: fake.url, key: fake.key }, "get_skill_resource", { pack: "demo", skill_name: "install", path: "missing.json" });
    expect(outcome).toEqual({ ok: false, error: "Resource not found: demo/install/missing.json" });
  });

  it("reports a JSON-RPC error as a tool error", async () => {
    const fake = await server();
    await expect(callTool({ url: fake.url, key: fake.key }, "no_such_tool")).resolves.toEqual({ ok: false, error: "Unknown tool: no_such_tool" });
  });

  it("turns a 401 into the secret hint (Review Focus 3)", async () => {
    const fake = await server();
    await expect(callTool({ url: fake.url, key: "wrong" }, "get_active_combo")).rejects.toThrow(KEY_REJECTED_HINT);
  });

  it("names the url when the server is unreachable", async () => {
    const fake = await server();
    fake.stop();
    await new Promise((tick) => setTimeout(tick, 50));
    await expect(callTool({ url: fake.url, key: fake.key }, "get_active_combo")).rejects.toThrow(`Cannot reach Skills Wiki at '${fake.url}'`);
  });
});

describe("callTool answer parsing (Review Focus 5)", () => {
  const target = { url: "https://wiki.test/mcp", key: "k" };
  const sse = (messages: unknown[]) => new Response(messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

  it("accepts application/json answers and falls back to JSON in content[0].text", async () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ combo_slug: "from-text" }) }], isError: false };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(json({ jsonrpc: "2.0", id: 2, result }));
    await expect(callTool(target, "get_active_combo")).resolves.toEqual({ ok: true, value: { combo_slug: "from-text" } });
  });

  it("picks the message with the matching id out of a multi-event stream", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sse([{ jsonrpc: "2.0", id: 1, result: {} }]))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(sse([{ jsonrpc: "2.0", method: "notifications/progress" }, { jsonrpc: "2.0", id: 2, result: { structuredContent: { x: 1 } } }]));
    await expect(callTool(target, "t")).resolves.toEqual({ ok: true, value: { x: 1 } });
  });

  it.each([
    ["non-JSON", () => new Response("<html>", { headers: { "content-type": "text/html" } }), /sent no answer to request 1/],
    ["a stream without the request id", () => sse([{ jsonrpc: "2.0", id: 9, result: {} }]), /sent no answer to request 1/],
    ["an HTTP 500", () => json({}, { status: 500 }), /answered HTTP 500/],
    ["a body over the cap", () => new Response("x".repeat(MCP_MAX_BYTES + 1), { headers: { "content-type": "application/json" } }), /larger than 1000000 bytes/],
  ])("turns %s into a failure with a reason", async (_name, make, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(make());
    await expect(callTool(target, "t")).rejects.toThrow(ActionFailure);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(make());
    await expect(callTool(target, "t")).rejects.toThrow(message);
  });

  it("names a timeout", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    await expect(callTool(target, "t")).rejects.toThrow("Cannot reach Skills Wiki at 'https://wiki.test/mcp' (timed out after 30000 ms)");
  });
});
```

Run: `npx vitest run tests/unit/mcp.test.ts`
Expected: FAIL — `src/core/mcp.ts` does not exist.

- [ ] **Step 3: Implement the client**

Create `src/core/mcp.ts`:

```ts
import { ActionFailure } from "./failure.js";

/** Hand-rolled MCP Streamable HTTP client: initialize → notifications/initialized → tools/call (D55). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_TIMEOUT_MS = 30_000;
export const MCP_MAX_BYTES = 1_000_000;
export const KEY_REJECTED_HINT = "Skills Wiki key rejected: run `installer secret skillswiki`";
const CLIENT_INFO = { name: "installer", version: "0.1.0" };

export interface McpTarget {
  readonly url: string;
  readonly key: string;
}

export type ToolOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

interface RpcMessage {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

interface Reply {
  readonly text: string;
  readonly contentType: string;
  readonly sessionId: string | null;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function describe(error: unknown): string {
  const { name, message } = error as { name?: string; message?: string };
  return name === "TimeoutError" ? `timed out after ${MCP_TIMEOUT_MS} ms` : (message ?? String(error));
}

/** One POST; the session id of the initialize answer is echoed on every later request. */
async function post(target: McpTarget, body: unknown, sessionId?: string | null): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.key}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
  let response: Response;
  try {
    response = await fetch(target.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(MCP_TIMEOUT_MS) });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Skills Wiki at '${target.url}' (${describe(error)})`);
  }
  if (response.status === 401) throw new ActionFailure(KEY_REJECTED_HINT);
  if (!response.ok) throw new ActionFailure(`Skills Wiki answered HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MCP_MAX_BYTES) throw new ActionFailure(`Skills Wiki answer is larger than ${MCP_MAX_BYTES} bytes`);
  return { text, contentType: response.headers.get("content-type") ?? "", sessionId: response.headers.get("mcp-session-id") };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** SSE: every event's `data:` lines joined are one JSON-RPC message; JSON: one message or a batch. */
function messagesOf(reply: Reply): unknown[] {
  if (!reply.contentType.includes("text/event-stream")) {
    const parsed = parseJson(reply.text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return reply.text.split(/\r?\n\r?\n/).map((event) =>
    parseJson(
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n"),
    ),
  );
}

function messageFor(reply: Reply, id: number): RpcMessage {
  const found = messagesOf(reply).find((message) => isRecord(message) && message.id === id);
  if (!found) throw new ActionFailure(`Skills Wiki sent no answer to request ${id} (${reply.contentType || "no content type"})`);
  return found as RpcMessage;
}

const errorText = (message: RpcMessage): string => (typeof message.error?.message === "string" ? message.error.message : "unknown error");

/** Prefers structuredContent; falls back to JSON in content[0].text (observed on the hosted Skills Wiki). */
function outcomeOf(result: unknown): ToolOutcome {
  if (!isRecord(result)) return { ok: false, error: "tool returned no result" };
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const first = content[0];
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
  if (result.isError === true) return { ok: false, error: text || "tool reported an error" };
  if (isRecord(result.structuredContent)) return { ok: true, value: result.structuredContent };
  const parsed = parseJson(text);
  return parsed === undefined ? { ok: false, error: "tool returned no JSON content" } : { ok: true, value: parsed };
}

const rpc = (id: number, method: string, params: unknown): unknown => ({ jsonrpc: "2.0", id, method, params });

export async function callTool(target: McpTarget, name: string, args: Readonly<Record<string, unknown>> = {}): Promise<ToolOutcome> {
  const init = await post(target, rpc(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }));
  const opened = messageFor(init, 1);
  if (opened.error) throw new ActionFailure(`Skills Wiki refused the connection: ${errorText(opened)}`);
  await post(target, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  const called = messageFor(await post(target, rpc(2, "tools/call", { name, arguments: args }), init.sessionId), 2);
  if (called.error) return { ok: false, error: errorText(called) };
  return outcomeOf(called.result);
}
```

Run: `npx vitest run tests/unit/mcp.test.ts` — Expected: PASS (13 tests).

- [ ] **Step 4: Write the failing Skills Wiki tests**

Create `tests/unit/skillswiki.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { setSecret } from "../../src/core/keychain.js";
import { KEY_MISSING_HINT, URL_MISSING_HINT, activeComboSlug, fetchSkillswikiSolution, parseSkillswikiRef, skillswikiTarget, stripSkillWrapper } from "../../src/core/skillswiki.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";

const RECIPE = readFileSync(resolve("tests/fixtures/skillswiki/demo/install/recipe.json"), "utf8");
const servers: FakeMcp[] = [];

async function server(env: Record<string, string> = {}): Promise<FakeMcp> {
  const started = await startFakeMcp(env);
  servers.push(started);
  return started;
}

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
});

describe("skillswiki: references", () => {
  it("splits pack, skill and a path with slashes", () => {
    expect(parseSkillswikiRef("skillswiki:demo/install/recipes/v1/recipe.json")).toEqual({ pack: "demo", skill: "install", path: "recipes/v1/recipe.json" });
  });

  it.each(["skillswiki:demo", "skillswiki:demo/install", "skillswiki:demo/install/", "skillswiki:/install/x", "https://x"])("refuses %s", (ref) => {
    expect(() => parseSkillswikiRef(ref)).toThrow(InputError);
  });

  it("strips one outer skill_* element and nothing else (fact 6)", () => {
    expect(stripSkillWrapper("<skill_reference>\n{ \"a\": 1 }\n</skill_reference>")).toBe('{ "a": 1 }');
    expect(stripSkillWrapper("<skill_script>\necho <skill_reference>x</skill_reference>\n</skill_script>")).toBe("echo <skill_reference>x</skill_reference>");
    expect(stripSkillWrapper("plain text")).toBe("plain text");
    expect(stripSkillWrapper("<skill_reference>\nopen")).toBe("<skill_reference>\nopen");
  });

  it("fetches a recipe through get_skill_resource with the wrapper removed", async () => {
    const fake = await server();
    await expect(fetchSkillswikiSolution({ url: fake.url, key: fake.key }, "skillswiki:demo/install/recipe.json")).resolves.toBe(RECIPE);
  });

  it("names the reference when Skills Wiki has no such file", async () => {
    const fake = await server();
    await expect(fetchSkillswikiSolution({ url: fake.url, key: fake.key }, "skillswiki:demo/install/nope.json")).rejects.toThrow(
      "Skills Wiki could not serve 'skillswiki:demo/install/nope.json': Resource not found: demo/install/nope.json",
    );
  });
});

describe("active combo (D37)", () => {
  it("returns the slug of the active combo", async () => {
    const fake = await server();
    await expect(activeComboSlug({ url: fake.url, key: fake.key })).resolves.toBe("demo-combo");
  });

  it("returns null when no combo is activated", async () => {
    const fake = await server({ FAKE_MCP_COMBO: "" });
    await expect(activeComboSlug({ url: fake.url, key: fake.key })).resolves.toBeNull();
  });

  it("lets a rejected key surface as the secret hint", async () => {
    const fake = await server();
    await expect(activeComboSlug({ url: fake.url, key: "nope" })).rejects.toThrow(ActionFailure);
  });
});

describe("skillswikiTarget", () => {
  it("needs the url and the stored key", async () => {
    const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    await expect(skillswikiTarget(undefined, env)).rejects.toThrow(URL_MISSING_HINT);
    await expect(skillswikiTarget("https://wiki.test/mcp", env)).rejects.toThrow(KEY_MISSING_HINT);
    await setSecret("skillswiki", "k-1", env);
    await expect(skillswikiTarget("https://wiki.test/mcp", env)).resolves.toEqual({ url: "https://wiki.test/mcp", key: "k-1" });
  });
});
```

Run: `npx vitest run tests/unit/skillswiki.test.ts`
Expected: FAIL — `src/core/skillswiki.ts` does not exist.

- [ ] **Step 5: Implement `skillswiki.ts`**

Create `src/core/skillswiki.ts`:

```ts
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { callTool, type McpTarget } from "./mcp.js";

/** The one keychain item and the MCP server name this version knows (D52). */
export const SKILLSWIKI_SECRET_ID = "skillswiki";
export const SKILLSWIKI_MCP_NAME = "skillswiki";
export const KEY_MISSING_HINT = "Skills Wiki key missing: run 'installer secret skillswiki' first";
export const URL_MISSING_HINT = "This install has no Skills Wiki URL: start again with --url <the MCP URL from your Skills Wiki dashboard>";

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export interface SkillswikiRef {
  readonly pack: string;
  readonly skill: string;
  readonly path: string;
}

/** `skillswiki:<pack>/<skill>/<path>`; the path may contain slashes (spec §6.1). */
export function parseSkillswikiRef(ref: string): SkillswikiRef {
  const match = /^skillswiki:([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
  if (!match || !match[1] || !match[2] || !match[3]) throw new InputError(`Solution reference '${ref}' must be skillswiki:<pack>/<skill>/<path>`);
  return { pack: match[1], skill: match[2], path: match[3] };
}

/** get_skill_resource wraps a file in one `<skill_reference>` (or similar) element; strip exactly that (fact 6). */
export function stripSkillWrapper(content: string): string {
  const match = /^\s*<(skill_[a-z]+)>\n?([\s\S]*?)\n?<\/\1>\s*$/.exec(content);
  return match?.[2] ?? content;
}

export async function fetchSkillswikiSolution(target: McpTarget, ref: string): Promise<string> {
  const { pack, skill, path } = parseSkillswikiRef(ref);
  const outcome = await callTool(target, "get_skill_resource", { pack, skill_name: skill, path });
  if (!outcome.ok) throw new ActionFailure(`Skills Wiki could not serve '${ref}': ${outcome.error}`);
  const content = isRecord(outcome.value) ? outcome.value.content : undefined;
  if (typeof content !== "string") throw new ActionFailure(`Skills Wiki returned no content for '${ref}'`);
  return stripSkillWrapper(content);
}

/** The active combo's slug, or null when none is activated (an error answer counts as not activated, D37). */
export async function activeComboSlug(target: McpTarget): Promise<string | null> {
  const outcome = await callTool(target, "get_active_combo");
  if (!outcome.ok || !isRecord(outcome.value)) return null;
  const slug = outcome.value.combo_slug;
  return typeof slug === "string" && slug !== "" && isRecord(outcome.value.combo) ? slug : null;
}

/** URL from the install state, key from the keychain; both are needed before Skills Wiki is called. */
export async function skillswikiTarget(url: string | undefined, env?: Env): Promise<McpTarget> {
  if (!url) throw new ActionFailure(URL_MISSING_HINT);
  const key = await getSecret(SKILLSWIKI_SECRET_ID, env);
  if (!key) throw new ActionFailure(KEY_MISSING_HINT);
  return { url, key };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/unit/mcp.test.ts tests/unit/skillswiki.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (13 + 13 tests); typecheck exits 0; the whole suite passes: 26 files, 335 tests.

- [ ] **Step 7: Commit**

```bash
git add src/core/mcp.ts src/core/skillswiki.ts tests/fakes/fake-mcp-server.mjs tests/helpers/fake-mcp.ts tests/fixtures/skillswiki tests/unit/mcp.test.ts tests/unit/skillswiki.test.ts
git commit -m "feat(core): call Skills Wiki over MCP from the engine"
```

---

### Task 5: `skillswiki:` references, `start --url` and the new state fields

**Files:**
- Modify: `src/core/types.ts`, `src/core/state.ts`, `src/core/solution.ts` (`loadSolutionSource`), `src/core/skillswiki.ts` (`usesSkillswiki`, `requireSkillswikiUrl`), `src/core/engine.ts` (`StartExtras`), `src/cli.ts` (`--url`, `startCommand`)
- Test: `tests/unit/state-fields.test.ts`, `tests/unit/solution-refs.test.ts`, `tests/unit/engine-advance.test.ts`, `tests/unit/skillswiki.test.ts`, `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `fetchSkillswikiSolution`, `KEY_MISSING_HINT` (Task 4), `getSecret` (Task 2).
- Produces:
  - `types.ts`: `InstallState.skillswiki?: { url }`, `InstallState.work_dir?: string`.
  - `solution.ts`: `loadSolutionSource(ref, fetchText = fetchHttps, fetchSkillswiki?: FetchText)`.
  - `skillswiki.ts`: `SKILLSWIKI_ACTIONS = ["register_mcp", "probe_mcp"]`, `SKILLSWIKI_CHECKS = ["combo_active"]`, `usesSkillswiki(solution)`, `requireSkillswikiUrl(url)` (https, or loopback http).
  - `engine.ts`: `type StartExtras = Partial<Pick<InstallState, "work_dir" | "skillswiki">>`; `initialState(ref, solution, now, recipeVersion?, extras?)`; `start(deps, existing, ref, recipeVersion?, extras?)` — extras are recorded on a fresh start only.
  - CLI: `installer start --solution <ref> [--url <MCP URL>]`. A `skillswiki:` ref needs the stored key (else exit 2 `KEY_MISSING_HINT`) and `--url`; a solution that uses Skills Wiki needs `--url`; the state records `work_dir: process.cwd()` and `skillswiki: { url }`; a second start may omit `--url` but not change it.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/state-fields.test.ts`, add after:

```ts
  it("still accepts a Plan 1 state without them", () => {
    expect(isInstallState(base)).toBe(true);
  });
```

this:

```ts

  it("accepts the Plan 3 fields skillswiki and work_dir", () => {
    expect(isInstallState({ ...base, skillswiki: { url: "https://wiki.test/mcp" }, work_dir: "/work" })).toBe(true);
  });
```

In `tests/unit/state-fields.test.ts`, replace:

```ts
    ["a runtime without a support level", { ...base, runtime: { profile: null } }],
  ])
```

with:

```ts
    ["a runtime without a support level", { ...base, runtime: { profile: null } }],
    ["a skillswiki entry without a url", { ...base, skillswiki: {} }],
    ["a non-string work_dir", { ...base, work_dir: 7 }],
  ])
```

In `tests/unit/solution-refs.test.ts`, replace:

```ts
  it("explains that skillswiki: refs need the Skills Wiki key step", async () => {
    await expect(loadSolutionSource("skillswiki:pack/skill/recipe.json")).rejects.toThrow(/Skills Wiki key step/);
  });
```

with:

```ts
  it("explains what a skillswiki: ref needs when no key-bearing fetcher is given", async () => {
    await expect(loadSolutionSource("skillswiki:pack/skill/recipe.json")).rejects.toThrow(/run 'installer secret skillswiki', then start with --url/);
  });

  it("loads a skillswiki: ref through the given fetcher and keeps its exact text", async () => {
    const loaded = await loadSolutionSource("skillswiki:pack/skill/recipe.json", fetchHttps, async () => FIXTURE_TEXT);
    expect(loaded.solution.id).toBe("fixture-basic");
    expect(loaded.text).toBe(FIXTURE_TEXT);
  });
```

In `tests/unit/engine-advance.test.ts`, add after:

```ts
describe("recipe_version", () => {
  it("is stored in the state on a fresh start", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF, "sha-of-text");
    expect(state.solution.recipe_version).toBe("sha-of-text");
  });
});
```

this:

```ts

describe("start extras", () => {
  it("records the working folder and the Skills Wiki url on a fresh start only", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    const extras = { work_dir: "/work/team", skillswiki: { url: "https://wiki.test/mcp" } };
    const { state } = await start(deps, null, FIXTURE_REF, "sha", extras);
    expect(state).toMatchObject(extras);
    const again = await start(deps, state, FIXTURE_REF, "sha", { work_dir: "/elsewhere" });
    expect(again.state.work_dir).toBe("/work/team");
  });
});
```

In `tests/unit/skillswiki.test.ts`, replace:

```ts
import { KEY_MISSING_HINT, URL_MISSING_HINT, activeComboSlug, fetchSkillswikiSolution, parseSkillswikiRef, skillswikiTarget, stripSkillWrapper } from "../../src/core/skillswiki.js";
```

with:

```ts
import { KEY_MISSING_HINT, URL_MISSING_HINT, activeComboSlug, fetchSkillswikiSolution, parseSkillswikiRef, requireSkillswikiUrl, skillswikiTarget, stripSkillWrapper, usesSkillswiki } from "../../src/core/skillswiki.js";
import type { Solution, StepDef } from "../../src/core/types.js";
```

In `tests/unit/skillswiki.test.ts`, add before:

```ts
describe("skillswikiTarget", () => {
```

this:

```ts
describe("start --url", () => {
  const step = (extra: Partial<StepDef>): StepDef => ({ step_id: "s", phase: "BRAIN", type: "auto", title: "S", why: "Needed.", blocking: true, ...extra });
  const solution = (...steps: StepDef[]): Solution => ({ id: "s", version: "1", steps });

  it("is needed by solutions that register, probe or check Skills Wiki", () => {
    expect(usesSkillswiki(solution(step({ auto: { action: "register_mcp" } })))).toBe(true);
    expect(usesSkillswiki(solution(step({ auto: { action: "probe_mcp" } })))).toBe(true);
    expect(usesSkillswiki(solution(step({ type: "human_action", verify: { check: "combo_active" } })))).toBe(true);
    expect(usesSkillswiki(solution(step({ auto: { action: "noop" } })))).toBe(false);
  });

  it.each(["https://wiki.test/mcp", "http://127.0.0.1:4321/mcp"])("accepts %s", (url) => {
    expect(requireSkillswikiUrl(url)).toBe(url);
  });

  it.each([undefined, "", "http://wiki.test/mcp", "ftp://wiki.test", "wiki.test/mcp"])("refuses %j", (url) => {
    expect(() => requireSkillswikiUrl(url)).toThrow(InputError);
  });
});
```

In `tests/e2e/cli.test.ts`:

In `tests/e2e/cli.test.ts`, replace:

```ts
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
```

with:

```ts
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
```

In `tests/e2e/cli.test.ts`, replace:

```ts
import { getSecret } from "../../src/core/keychain.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { formHeaders, request, waitForExit } from "../helpers/http.js";
```

with:

```ts
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { KEY_REJECTED_HINT } from "../../src/core/mcp.js";
import { KEY_MISSING_HINT } from "../../src/core/skillswiki.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { formHeaders, request, waitForExit } from "../helpers/http.js";
```

In `tests/e2e/cli.test.ts`, replace:

```ts
const LIVE_RETRY_PATH = resolve("tests/fixtures/live-retry.json");
```

with:

```ts
const LIVE_RETRY_PATH = resolve("tests/fixtures/live-retry.json");
const RECIPE_PATH = resolve("tests/fixtures/skillswiki/demo/install/recipe.json");
const SKILLSWIKI_REF = "skillswiki:demo/install/recipe.json";

/** A private keychain folder for one test, holding the Skills Wiki key when given. */
async function keychainEnv(key?: string): Promise<Record<string, string>> {
  const dir = await makeTempHome();
  if (key) await setSecret("skillswiki", key, { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir });
  return { INSTALLER_KEYCHAIN_DIR: dir };
}
```

In `tests/e2e/cli.test.ts`, replace:

```ts
    expect(result.json).toEqual({ error: `Unknown option '${raw}'. Options: --home, --solution, --value, --done, --json, --profile`, code: 2 });
```

with:

```ts
    expect(result.json).toEqual({ error: `Unknown option '${raw}'. Options: --home, --solution, --value, --done, --json, --profile, --url`, code: 2 });
```

In `tests/e2e/cli.test.ts`, replace:

```ts
  it.each(["http://example.test/s.json", "skillswiki:pack/skill/recipe.json"])("refuses %s with exit 2 and creates nothing", async (ref) => {
    const home = join(await makeTempHome(), "engine");
    const result = runCli(["start", "--solution", ref], { home });
    expect(result.code).toBe(2);
    await expect(access(home)).rejects.toThrow();
  });
```

with:

```ts
  it("refuses http://example.test/s.json with exit 2 and creates nothing", async () => {
    const home = join(await makeTempHome(), "engine");
    const result = runCli(["start", "--solution", "http://example.test/s.json"], { home });
    expect(result.code).toBe(2);
    await expect(access(home)).rejects.toThrow();
  });

  describe("skillswiki: references (D46)", () => {
    const servers: FakeMcp[] = [];

    afterEach(() => {
      servers.splice(0).forEach((fake) => fake.stop());
    });

    async function fakeWiki(env: Record<string, string> = {}): Promise<FakeMcp> {
      const fake = await startFakeMcp(env);
      servers.push(fake);
      return fake;
    }

    it("refuses to start without the key, names the secret command and creates nothing (Review Focus 4)", async () => {
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, "--url", "https://wiki.test/mcp"], { home, env: await keychainEnv() });
      expect(result.code).toBe(2);
      expect(result.json).toEqual({ error: KEY_MISSING_HINT, code: 2 });
      await expect(access(home)).rejects.toThrow();
    });

    it.each([
      ["no --url", []],
      ["a plain http url", ["--url", "http://wiki.test/mcp"]],
    ])("refuses to start with %s once the key exists, exit 2, creates nothing (Review Focus 4)", async (_name, urlArgs) => {
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, ...urlArgs], { home, env: await keychainEnv("k-1") });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: expect.stringContaining("--url") });
      await expect(access(home)).rejects.toThrow();
    });

    it("fetches the recipe, pins it and records the url, the working folder and the content sha", async () => {
      const fake = await fakeWiki();
      const [home, cwd] = [await makeTempHome(), await makeTempHome()];
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, "--url", fake.url], { home, cwd, env: await keychainEnv(fake.key) });
      expect(result.json).toMatchObject({ status: "step", view: { step: { step_id: "mode.name" } } });
      const recipe = await readFile(RECIPE_PATH, "utf8");
      expect(await loadState(home)).toMatchObject({
        solution: { ref: SKILLSWIKI_REF, id: "fixture-skillswiki", recipe_version: createHash("sha256").update(recipe).digest("hex") },
        skillswiki: { url: fake.url },
        work_dir: await realpath(cwd),
      });
      await expect(readFile(join(home, "solution", "solution.json"), "utf8")).resolves.toBe(recipe);
    });

    it("names a rejected key and creates nothing (Review Focus 3)", async () => {
      const fake = await fakeWiki();
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, "--url", fake.url], { home, env: await keychainEnv("not-the-key") });
      expect(result.code).toBe(2);
      expect(result.json).toEqual({ error: KEY_REJECTED_HINT, code: 2 });
      await expect(access(home)).rejects.toThrow();
    });

    it("refuses a second start with a different url", async () => {
      const home = await makeTempHome();
      expect(runCli(["start", "--solution", FIXTURE_REF, "--url", "https://one.test/mcp"], { home }).code).toBe(0);
      expect(runCli(["start", "--solution", FIXTURE_REF], { home }).code).toBe(0);
      const other = runCli(["start", "--solution", FIXTURE_REF, "--url", "https://two.test/mcp"], { home });
      expect(other.code).toBe(2);
      expect(other.json).toMatchObject({ error: expect.stringContaining("already has an install started with the Skills Wiki URL 'https://one.test/mcp'") });
    });
  });
```

Run: `npx vitest run tests/unit/state-fields.test.ts tests/unit/solution-refs.test.ts tests/unit/engine-advance.test.ts tests/unit/skillswiki.test.ts tests/e2e/cli.test.ts`
Expected: FAIL — the new fields are rejected, `--url` is an unknown option, `usesSkillswiki` is not exported.

- [ ] **Step 2: Add the state fields**

In `src/core/types.ts`, replace:

```ts
  readonly mode?: Mode;
  readonly roles?: Roles;
  readonly runtime?: CapabilityMap;
}
```

with:

```ts
  readonly mode?: Mode;
  readonly roles?: Roles;
  readonly runtime?: CapabilityMap;
  /** The per-client Skills Wiki MCP URL from `start --url`; not a secret, the key lives in the keychain (D51). */
  readonly skillswiki?: { readonly url: string };
  /** Where the agent ran `installer start`: the folder its MCP trust applies to (D54). */
  readonly work_dir?: string;
}
```

In `src/core/state.ts`, replace:

```ts
function hasValidExtras(value: Record<string, unknown>): boolean {
  const { mode, roles, runtime } = value;
  if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode)) return false;
  if (roles !== undefined && !(isRecord(roles) && typeof roles.decision_maker === "string")) return false;
  return runtime === undefined || (isRecord(runtime) && typeof runtime.support_level === "number");
}
```

with:

```ts
function hasValidExtras(value: Record<string, unknown>): boolean {
  const { mode, roles, runtime, skillswiki, work_dir: workDir } = value;
  if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode)) return false;
  if (roles !== undefined && !(isRecord(roles) && typeof roles.decision_maker === "string")) return false;
  if (skillswiki !== undefined && !(isRecord(skillswiki) && typeof skillswiki.url === "string")) return false;
  if (workDir !== undefined && typeof workDir !== "string") return false;
  return runtime === undefined || (isRecord(runtime) && typeof runtime.support_level === "number");
}
```

- [ ] **Step 3: Resolve `skillswiki:` refs through a key-bearing fetcher**

In `src/core/solution.ts`, replace:

```ts
export async function loadSolutionSource(ref: string, fetchText: FetchText = fetchHttps): Promise<{ solution: Solution; text: string }> {
  if (ref.startsWith("skillswiki:")) {
    throw new SolutionError("'skillswiki:' references need the Skills Wiki key step, which arrives in a later version; use a file: or https: reference");
  }
  if (ref.startsWith("https:")) {
```

with:

```ts
/** `fetchSkillswiki` is the key-bearing fetcher the CLI builds once the key and URL are known (D46). */
export async function loadSolutionSource(ref: string, fetchText: FetchText = fetchHttps, fetchSkillswiki?: FetchText): Promise<{ solution: Solution; text: string }> {
  if (ref.startsWith("skillswiki:")) {
    if (!fetchSkillswiki) throw new SolutionError("'skillswiki:' references need the Skills Wiki key and URL: run 'installer secret skillswiki', then start with --url <MCP URL>");
    const text = await fetchSkillswiki(ref);
    return { solution: parseSolutionText(text, ref), text };
  }
  if (ref.startsWith("https:")) {
```

In `src/core/skillswiki.ts`, replace:

```ts
import { callTool, type McpTarget } from "./mcp.js";
```

with:

```ts
import { callTool, type McpTarget } from "./mcp.js";
import type { Solution } from "./types.js";
```

In `src/core/skillswiki.ts`, replace:

```ts
export const URL_MISSING_HINT = "This install has no Skills Wiki URL: start again with --url <the MCP URL from your Skills Wiki dashboard>";
```

with:

```ts
export const URL_MISSING_HINT = "This install has no Skills Wiki URL: start again with --url <the MCP URL from your Skills Wiki dashboard>";
/** Actions and checks that call Skills Wiki; a solution with any of them needs `start --url`. */
export const SKILLSWIKI_ACTIONS: readonly string[] = ["register_mcp", "probe_mcp"];
export const SKILLSWIKI_CHECKS: readonly string[] = ["combo_active"];
const ALLOWED_URL = /^(https:\/\/|http:\/\/127\.0\.0\.1(:\d+)?\/)/;
```

In `src/core/skillswiki.ts`, add before:

```ts
/** URL from the install state, key from the keychain; both are needed before Skills Wiki is called. */
```

this:

```ts
export function usesSkillswiki(solution: Solution): boolean {
  return solution.steps.some((step) => SKILLSWIKI_ACTIONS.includes(step.auto?.action ?? "") || SKILLSWIKI_CHECKS.includes(step.verify?.check ?? ""));
}

/** The key only ever travels over https, or to this machine's own loopback (the test server). */
export function requireSkillswikiUrl(url: string | undefined): string {
  if (!url) throw new InputError("This solution uses Skills Wiki: run start again with --url <the MCP URL from your Skills Wiki dashboard>");
  if (!ALLOWED_URL.test(url)) throw new InputError(`--url must be an https URL, got '${url}'`);
  return url;
}
```

- [ ] **Step 4: Record the extras at `start`**

In `src/core/engine.ts`, replace:

```ts
export function initialState(ref: string, solution: Solution, now: string, recipeVersion?: string): InstallState {
  const pinned = { ref, id: solution.id, version: solution.version, ...(recipeVersion ? { recipe_version: recipeVersion } : {}) };
  return { schema: 1, solution: pinned, started_at: now, steps: {} };
}
```

with:

```ts
/** Facts known only at `start` time that later steps read back (D54: the agent's folder, D51: the Skills Wiki URL). */
export type StartExtras = Partial<Pick<InstallState, "work_dir" | "skillswiki">>;

export function initialState(ref: string, solution: Solution, now: string, recipeVersion?: string, extras: StartExtras = {}): InstallState {
  const pinned = { ref, id: solution.id, version: solution.version, ...(recipeVersion ? { recipe_version: recipeVersion } : {}) };
  return { schema: 1, solution: pinned, started_at: now, steps: {}, ...extras };
}
```

In `src/core/engine.ts`, replace:

```ts
export async function start(deps: EngineDeps, existing: InstallState | null, ref: string, recipeVersion?: string): Promise<Advanced> {
```

with:

```ts
export async function start(deps: EngineDeps, existing: InstallState | null, ref: string, recipeVersion?: string, extras?: StartExtras): Promise<Advanced> {
```

In `src/core/engine.ts`, replace:

```ts
  const fresh: InstallState = { ...initialState(ref, deps.solution, deps.now(), recipeVersion), audit_head: head };
```

with:

```ts
  const fresh: InstallState = { ...initialState(ref, deps.solution, deps.now(), recipeVersion, extras), audit_head: head };
```

- [ ] **Step 5: Add `--url` and the start-time checks to the CLI**

In `src/cli.ts`, replace:

```ts
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type SubmitPayload } from "./core/engine.js";
```

with:

```ts
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type StartExtras, type SubmitPayload } from "./core/engine.js";
```

In `src/cli.ts`, replace:

```ts
import { requireSecretId, setSecret } from "./core/keychain.js";
import { buildReport, renderReport } from "./core/report.js";
import { headlessHint, launchSecretPage, openBrowser, startSecretPage } from "./core/secret-page.js";
import { loadPinnedSolution, writePinnedSolution } from "./core/pin.js";
import { SolutionError, loadSolutionSource } from "./core/solution.js";
```

with:

```ts
import { getSecret, requireSecretId, setSecret } from "./core/keychain.js";
import { buildReport, renderReport } from "./core/report.js";
import { headlessHint, launchSecretPage, openBrowser, startSecretPage } from "./core/secret-page.js";
import { loadPinnedSolution, writePinnedSolution } from "./core/pin.js";
import { KEY_MISSING_HINT, SKILLSWIKI_SECRET_ID, fetchSkillswikiSolution, requireSkillswikiUrl, usesSkillswiki } from "./core/skillswiki.js";
import { SolutionError, fetchHttps, loadSolutionSource } from "./core/solution.js";
```

In `src/cli.ts`, replace:

```ts
  readonly json?: boolean;
  readonly profile?: string;
}
```

with:

```ts
  readonly json?: boolean;
  readonly profile?: string;
  readonly url?: string;
}
```

In `src/cli.ts`, replace:

```ts
const OPTIONS = { home: { type: "string" }, solution: { type: "string" }, value: { type: "string" }, done: { type: "boolean" }, json: { type: "boolean" }, profile: { type: "string" } } as const;
```

with:

```ts
const OPTIONS = { home: { type: "string" }, solution: { type: "string" }, value: { type: "string" }, done: { type: "boolean" }, json: { type: "boolean" }, profile: { type: "string" }, url: { type: "string" } } as const;
```

In `src/cli.ts`, replace:

```ts
async function startCommand(home: string, flags: Flags): Promise<unknown> {
  if (!flags.solution) throw new InputError("start needs --solution <ref>");
  const ref = flags.solution.startsWith("file:") ? `file:${resolve(flags.solution.slice("file:".length))}` : flags.solution;
  const { solution, text } = await loadSolutionSource(ref);
  const created = await mkdir(home, { recursive: true, mode: HOME_MODE });
  if (created !== undefined) await chmod(home, HOME_MODE);
  else await requirePrivateHome(home);
  const existing = await loadState(home);
  if (existing) await requireSameContent(home, existing, text);
  else await writePinnedSolution(home, text);
  return (await start(depsFor(home, solution), existing, ref, sha256(text))).result;
}
```

with:

```ts
/** A `skillswiki:` ref needs the stored key and the URL before anything is fetched or created (D46). */
async function solutionSource(ref: string, flags: Flags): Promise<{ solution: Solution; text: string }> {
  if (!ref.startsWith("skillswiki:")) return loadSolutionSource(ref);
  const key = await getSecret(SKILLSWIKI_SECRET_ID);
  if (!key) throw new InputError(KEY_MISSING_HINT);
  const url = requireSkillswikiUrl(flags.url);
  return loadSolutionSource(ref, fetchHttps, (target) => fetchSkillswikiSolution({ url, key }, target));
}

function requireSameUrl(existing: InstallState, url: string | undefined): void {
  if (url !== undefined && existing.skillswiki?.url !== url) {
    throw new EngineError(`This home already has an install started ${existing.skillswiki ? `with the Skills Wiki URL '${existing.skillswiki.url}'` : "without a Skills Wiki URL"}; use a different --home`);
  }
}

async function startCommand(home: string, flags: Flags): Promise<unknown> {
  if (!flags.solution) throw new InputError("start needs --solution <ref>");
  const ref = flags.solution.startsWith("file:") ? `file:${resolve(flags.solution.slice("file:".length))}` : flags.solution;
  const { solution, text } = await solutionSource(ref, flags);
  const url = flags.url === undefined && !usesSkillswiki(solution) ? undefined : requireSkillswikiUrl(flags.url);
  const created = await mkdir(home, { recursive: true, mode: HOME_MODE });
  if (created !== undefined) await chmod(home, HOME_MODE);
  else await requirePrivateHome(home);
  const existing = await loadState(home);
  if (existing) {
    await requireSameContent(home, existing, text);
    requireSameUrl(existing, url);
  } else {
    await writePinnedSolution(home, text);
  }
  const extras: StartExtras = { work_dir: process.cwd(), ...(url ? { skillswiki: { url } } : {}) };
  return (await start(depsFor(home, solution), existing, ref, sha256(text), extras)).result;
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/unit/state-fields.test.ts tests/unit/solution-refs.test.ts tests/unit/engine-advance.test.ts tests/unit/skillswiki.test.ts tests/e2e/cli.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (9 + 10 + 8 + 21 + 39 tests); typecheck exits 0; the whole suite passes: 26 files, 353 tests.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/state.ts src/core/solution.ts src/core/skillswiki.ts src/core/engine.ts src/cli.ts tests/unit/state-fields.test.ts tests/unit/solution-refs.test.ts tests/unit/engine-advance.test.ts tests/unit/skillswiki.test.ts tests/e2e/cli.test.ts
git commit -m "feat(cli): resolve skillswiki: refs and record the Skills Wiki url at start"
```

---

### Task 6: Profile MCP templates, `register_mcp` and `installer mcp-headers` (D52)

**Files:**
- Create: `src/core/register.ts`
- Modify: `src/core/profile.ts`, `src/core/headless.ts` (`allowTool`, `buildArgv`), `src/core/actions.ts` (`register_mcp`), `src/core/solution.ts` (BRAIN order rule), `src/cli.ts` (`mcp-headers`), `profiles/claude-code.json`, `tests/fixtures/profiles/fake-agent.json`, `tests/fakes/fake-agent.mjs`, `vitest.config.ts` (`INSTALLER_CLI`)
- Test: `tests/unit/register.test.ts` (new), `tests/unit/profile.test.ts`, `tests/unit/headless.test.ts`, `tests/unit/solution.test.ts`, `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `runProcess` with `code` (Task 2), `fillTemplate`, `loadProfileById`, `skillswikiTarget`, `SKILLSWIKI_MCP_NAME`, `SKILLSWIKI_SECRET_ID` (Tasks 4–5), `getSecret`.
- Produces:
  - `profile.ts`: `RuntimeProfile.headless.tools_off?`, `.headless.allow_tool?` (`{tool}`), `RuntimeProfile.mcp_register?: { cmd }` (`{name}`, `{config_json}`, `{profile_dir}`), `.mcp_remove?: { cmd }` (`{name}`, `{profile_dir}`); `argv(value, where, ...placeholders)`.
  - `headless.ts`: `HeadlessRequest.allowTool?: string`; `buildArgv(profile, request)` exported — appends `tools_off` by default, or `allow_tool` filled with the one tool.
  - `register.ts`: `MCP_COMMAND_TIMEOUT_MS = 60_000`, `CLI_PATH_ENV = "INSTALLER_CLI"`, `installerCliPath()` (`dist/core/register.js` → `dist/cli.js`, or the env override the test suite uses because it runs from `src/`), `headersHelperCommand(secretId, execPath, cliPath)` (single-quoted for the agent's shell), `mcpServerConfig(url, headersHelper)`, `registerMcp(profile, name, url, headersHelper, cwd)` (remove, then add; `ActionFailure` when the add fails), `unregisterMcp(profile, name, cwd): Promise<boolean>`.
  - Action `register_mcp` (no args): needs a probed profile and `state.skillswiki.url` + the stored key; registers `skillswiki`. Solution rule: `register_mcp` needs an earlier `probe_runtime`; `probe_mcp` (Task 8) needs an earlier `register_mcp`.
  - CLI: `installer mcp-headers <id>` prints `{"Authorization":"Bearer <key>"}` (exit 0) or nothing (exit 1).
  - Fake agent additions (`tests/fakes/fake-agent.mjs`): `mcp add-json -s <scope> <name> <json>` stores `<FAKE_AGENT_HOME>/mcp/<name>.json` (exit 1 "already exists" when present; `FAKE_AGENT_DROP=mcp` → exit 1); `mcp get <name>` / `mcp remove [-s <scope>] <name>` (exit 1 `No MCP server named "<name>"` when absent); a prompt `Call the tool mcp__<name>__get_active_combo …` with `--allowedTools` naming that tool runs the stored `headersHelper` through the shell, calls the stored url over MCP and answers the `combo_slug`; `FAKE_AGENT_DROP=trust` answers "headersHelper not run: this workspace has no persisted trust" instead.

- [ ] **Step 1: Write the profile files**

Replace the whole of `profiles/claude-code.json` with:

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "min_version": "2.1.0",
  "detect": { "cmd": ["claude", "--version"], "match": "Claude Code" },
  "headless": {
    "cmd": ["claude", "-p", "{prompt}", "--output-format", "json"],
    "result_path": "result",
    "session_path": "session_id",
    "error_path": "is_error",
    "tools_off": ["--tools", "", "--strict-mcp-config"],
    "allow_tool": ["--allowedTools", "{tool}"]
  },
  "schema": { "flag": ["--json-schema", "{schema_json}"], "result_path": "structured_output" },
  "resume": { "flag": ["-r", "{session_id}"] },
  "mcp_register": { "cmd": ["claude", "mcp", "add-json", "-s", "user", "{name}", "{config_json}"] },
  "mcp_remove": { "cmd": ["claude", "mcp", "remove", "-s", "user", "{name}"] },
  "tos_review": { "status": "ok", "note": "First-party CLI used headless by the client on their own account." }
}
```

Replace the whole of `tests/fixtures/profiles/fake-agent.json` with:

```json
{
  "id": "fake-agent",
  "name": "Fake Agent",
  "min_version": "1.0.0",
  "detect": { "cmd": ["node", "{profile_dir}/../../fakes/fake-agent.mjs", "--version"], "match": "Fake Agent" },
  "headless": {
    "cmd": ["node", "{profile_dir}/../../fakes/fake-agent.mjs", "-p", "{prompt}", "--output-format", "json"],
    "result_path": "result",
    "session_path": "session_id",
    "error_path": "is_error",
    "tools_off": ["--tools", ""],
    "allow_tool": ["--allowedTools", "{tool}"]
  },
  "schema": { "flag": ["--json-schema", "{schema_json}"], "result_path": "structured_output" },
  "resume": { "flag": ["-r", "{session_id}"] },
  "mcp_register": { "cmd": ["node", "{profile_dir}/../../fakes/fake-agent.mjs", "mcp", "add-json", "-s", "user", "{name}", "{config_json}"] },
  "mcp_remove": { "cmd": ["node", "{profile_dir}/../../fakes/fake-agent.mjs", "mcp", "remove", "-s", "user", "{name}"] },
  "tos_review": { "status": "ok", "note": "Test double used only by the test suite." }
}
```

Replace the whole of `tests/fakes/fake-agent.mjs` with:

```js
#!/usr/bin/env node
// Test double for a headless agent CLI (shaped like `claude -p … --output-format json` and `claude mcp …`).
// FAKE_AGENT_DROP switches off one capability: c4 | json | schema | c5 | hang | mcp | trust.
// FAKE_AGENT_HOME: where sessions and MCP registrations live (default ./.fake-agent in the working folder).
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const drop = process.env.FAKE_AGENT_DROP ?? "";
const store = process.env.FAKE_AGENT_HOME ?? join(process.cwd(), ".fake-agent");
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const mcpFile = (name) => join(store, "mcp", `${name}.json`);

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

// `mcp add-json -s <scope> <name> <json>` | `mcp get <name>` | `mcp remove [-s <scope>] <name>` (fact 3: no silent replace).
function mcp([command, ...rest]) {
  const [name, json] = rest.filter((part, index) => part !== "-s" && rest[index - 1] !== "-s");
  mkdirSync(join(store, "mcp"), { recursive: true });
  if (command === "add-json") {
    if (drop === "mcp") process.exit(1);
    if (existsSync(mcpFile(name))) {
      process.stdout.write(`MCP server ${name} already exists in user config\n`);
      process.exit(1);
    }
    writeFileSync(mcpFile(name), json);
    return process.stdout.write(`Added HTTP MCP server ${name} to user config\n`);
  }
  if (!existsSync(mcpFile(name))) {
    process.stdout.write(`No MCP server named "${name}"\n`);
    process.exit(1);
  }
  if (command === "get") return process.stdout.write(readFileSync(mcpFile(name), "utf8"));
  rmSync(mcpFile(name));
  process.stdout.write(`Removed MCP server ${name}\n`);
}

// The C6 rehearsal (fact 4): run the stored headersHelper through the shell, then call the tool over MCP.
async function callTool(name) {
  if (!(valueOf("--allowedTools") ?? "").includes(`mcp__${name}__get_active_combo`)) return "That tool is not allowed";
  if (!existsSync(mcpFile(name))) return `No MCP server named ${name}`;
  if (drop === "trust") return "headersHelper not run: this workspace has no persisted trust";
  try {
    const config = JSON.parse(readFileSync(mcpFile(name), "utf8"));
    const headers = JSON.parse(execSync(config.headersHelper, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const post = (body, session) =>
      fetch(config.url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify(body),
      });
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "9.9.9" } } });
    const session = init.headers.get("mcp-session-id");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    const reply = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_active_combo", arguments: {} } }, session)).text();
    const data = reply.split("\n").find((line) => line.startsWith("data:")) ?? "data: {}";
    return String(JSON.parse(data.slice("data:".length)).result?.structuredContent?.combo_slug ?? "null");
  } catch (error) {
    return `Could not call the tool: ${error.message}`;
  }
}

async function main() {
  if (args[0] === "--version") return process.stdout.write("9.9.9 (Fake Agent)\n");
  if (args[0] === "mcp") return mcp(args.slice(1));
  if (drop === "c4") process.exit(1);
  if (drop === "hang") return setInterval(() => undefined, 1000);
  const prompt = valueOf("-p") ?? "";
  const resumed = valueOf("-r");
  const session = resumed && drop !== "c5" ? resumed : randomUUID();
  mkdirSync(store, { recursive: true });
  const remember = /Remember this word: (\S+?)\./.exec(prompt);
  if (remember) writeFileSync(join(store, `${session}.txt`), remember[1]);
  const tool = /Call the tool mcp__([a-z0-9-]+)__get_active_combo/.exec(prompt);
  const result = tool ? await callTool(tool[1]) : answer(prompt, resumed, session);
  const field = /in the field word: (\S+)/.exec(prompt);
  const structured = valueOf("--json-schema") && drop !== "schema" ? { structured_output: { word: field ? field[1] : result } } : {};
  const out = { result, session_id: session, is_error: false, ...structured };
  process.stdout.write(drop === "json" ? "this is not json" : JSON.stringify(out));
}

await main();
```

- [ ] **Step 2: Write the failing tests**

In `tests/unit/profile.test.ts`, replace:

```ts
  it("loads the bundled Claude Code profile by id", async () => {
    const profile = await loadProfile("claude-code");
    expect(profile).toMatchObject({ id: "claude-code", headless: { result_path: "result" }, schema: { result_path: "structured_output" } });
  });
```

with:

```ts
  it("loads the bundled Claude Code profile by id", async () => {
    const profile = await loadProfile("claude-code");
    expect(profile).toMatchObject({ id: "claude-code", headless: { result_path: "result" }, schema: { result_path: "structured_output" } });
  });

  it("carries the verified MCP templates and tools-off flags of Claude Code (D52)", async () => {
    const profile = await loadProfile("claude-code");
    expect(profile.headless.cmd).toEqual(["claude", "-p", "{prompt}", "--output-format", "json"]);
    expect(profile.headless.tools_off).toEqual(["--tools", "", "--strict-mcp-config"]);
    expect(profile.headless.allow_tool).toEqual(["--allowedTools", "{tool}"]);
    expect(profile.mcp_register?.cmd).toEqual(["claude", "mcp", "add-json", "-s", "user", "{name}", "{config_json}"]);
    expect(profile.mcp_remove?.cmd).toEqual(["claude", "mcp", "remove", "-s", "user", "{name}"]);
  });
```

In `tests/unit/profile.test.ts`, replace:

```ts
    ["a placeholder the command cannot use", { ...valid, headless: { ...valid.headless, cmd: ["x", "-p", "{prompt}", "{session_id}"] } }, /headless.cmd uses \{session_id\}/],
  ])
```

with:

```ts
    ["a placeholder the command cannot use", { ...valid, headless: { ...valid.headless, cmd: ["x", "-p", "{prompt}", "{session_id}"] } }, /headless.cmd uses \{session_id\}/],
    ["an allow_tool without {tool}", { ...valid, headless: { ...valid.headless, allow_tool: ["--allowedTools"] } }, /headless.allow_tool must contain \{tool\}/],
    ["an mcp_register without {config_json}", { ...valid, mcp_register: { cmd: ["x", "mcp", "add", "{name}"] } }, /mcp_register.cmd must contain \{config_json\}/],
    ["an mcp_remove without {name}", { ...valid, mcp_remove: { cmd: ["x", "mcp", "remove"] } }, /mcp_remove.cmd must contain \{name\}/],
    ["an mcp_remove that uses {prompt}", { ...valid, mcp_remove: { cmd: ["x", "{name}", "{prompt}"] } }, /mcp_remove.cmd uses \{prompt\}/],
  ])
```

In `tests/unit/headless.test.ts`, replace:

```ts
import { fillTemplate, runHeadless, runProcess } from "../../src/core/headless.js";
```

with:

```ts
import { buildArgv, fillTemplate, runHeadless, runProcess } from "../../src/core/headless.js";
```

In `tests/unit/headless.test.ts`, add before:

```ts
describe("runProcess", () => {
```

this:

```ts
describe("buildArgv", () => {
  it("appends the tools-off flags to an ordinary call", async () => {
    const argv = buildArgv(await loadProfile("claude-code"), { prompt: "hi" });
    expect(argv).toEqual(["claude", "-p", "hi", "--output-format", "json", "--tools", "", "--strict-mcp-config"]);
  });

  it("allows exactly one tool instead when the request names it (C6 probe, D54)", async () => {
    const argv = buildArgv(await loadProfile("claude-code"), { prompt: "hi", allowTool: "mcp__skillswiki__get_active_combo" });
    expect(argv).toEqual(["claude", "-p", "hi", "--output-format", "json", "--allowedTools", "mcp__skillswiki__get_active_combo"]);
  });

  it("refuses to allow a tool on a profile without an allow_tool template", async () => {
    const profile = await loadProfile(resolve("tests/fixtures/profiles/missing-agent.json"));
    expect(() => buildArgv(profile, { prompt: "hi", allowTool: "x" })).toThrow(ProfileError);
  });
});
```

In `tests/unit/headless.test.ts`, replace:

```ts
  it("kills a command that runs past the timeout (Review Focus 1)", async () => {
    const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], await makeTempHome(), 300);
    expect(result.error).toBe("timed out after 300 ms");
  });
});
```

with:

```ts
  it("kills a command that runs past the timeout (Review Focus 1)", async () => {
    const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], await makeTempHome(), 300);
    expect(result.error).toBe("timed out after 300 ms");
  });

  it("passes input on stdin and reports the exit code", async () => {
    const echo = [process.execPath, "-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(44))"];
    const result = await runProcess(echo, await makeTempHome(), 5_000, "a b\"c");
    expect(result).toEqual({ stdout: "a b\"c", code: 44, error: "exited with code 44" });
  });
});
```

In `tests/unit/solution.test.ts`, add before:

```ts
describe("loadSolution", () => {
```

this:

```ts
describe("BRAIN step order", () => {
  const auto = (step_id: string, action: string) => ({ step_id, phase: "BRAIN", type: "auto", title: step_id, why: "Needed.", blocking: true, auto: { action } });

  it("refuses register_mcp before probe_runtime", () => {
    expect(() => parseSolution({ id: "b", version: "1", steps: [auto("brain.register", "register_mcp")] })).toThrow("Step 'brain.register': register_mcp needs an earlier probe_runtime step");
  });

  it("accepts register_mcp after probe_runtime", () => {
    expect(parseSolution({ id: "b", version: "1", steps: [auto("pre.probe", "probe_runtime"), auto("brain.register", "register_mcp")] }).steps).toHaveLength(2);
  });
});
```

In `tests/e2e/cli.test.ts`, add before:

```ts
  it("report prints text by default and JSON with --json", async () => {
```

this:

```ts
  describe("installer mcp-headers (D52)", () => {
    it("prints exactly the Authorization header line from the keychain", async () => {
      const result = runCli(["mcp-headers", "skillswiki"], { env: await keychainEnv("sw_live_123") });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('{"Authorization":"Bearer sw_live_123"}\n');
    });

    it("prints nothing and exits 1 when the key is missing", async () => {
      const result = runCli(["mcp-headers", "skillswiki"], { env: await keychainEnv() });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });
```



Create `tests/unit/register.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { resume, start } from "../../src/core/engine.js";
import { ActionFailure } from "../../src/core/failure.js";
import { setSecret } from "../../src/core/keychain.js";
import { loadProfile } from "../../src/core/profile.js";
import { headersHelperCommand, installerCliPath, mcpServerConfig, registerMcp, unregisterMcp } from "../../src/core/register.js";
import { KEY_MISSING_HINT } from "../../src/core/skillswiki.js";
import { parseSolution } from "../../src/core/solution.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const MISSING = resolve("tests/fixtures/profiles/missing-agent.json");
const URL = "https://wiki.test/mcp";
const HELPER = "'/usr/bin/node' '/opt/installer/dist/cli.js' mcp-headers skillswiki";
let agentHome = "";

const registered = (): Promise<string> => readFile(join(agentHome, "mcp", "skillswiki.json"), "utf8");

beforeEach(async () => {
  agentHome = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agentHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("headers helper command", () => {
  it("quotes both paths for the agent's shell, even with spaces and quotes (D52)", () => {
    expect(headersHelperCommand("skillswiki", "/opt/my node/bin/node", "/Users/o'brien/dist/cli.js")).toBe(
      "'/opt/my node/bin/node' '/Users/o'\\''brien/dist/cli.js' mcp-headers skillswiki",
    );
  });

  it("names the built CLI by an absolute path", () => {
    expect(installerCliPath()).toBe(resolve("dist/cli.js"));
  });

  it("builds the http server config with the helper and no key", () => {
    expect(JSON.parse(mcpServerConfig(URL, HELPER))).toEqual({ type: "http", url: URL, headersHelper: HELPER });
  });
});

describe("registerMcp against the fake agent", () => {
  it("stores the http config and replaces it when run again (idempotent, fact 3)", async () => {
    const profile = await loadProfile(FAKE);
    await registerMcp(profile, "skillswiki", URL, HELPER, agentHome);
    expect(JSON.parse(await registered())).toEqual({ type: "http", url: URL, headersHelper: HELPER });
    await registerMcp(profile, "skillswiki", "https://other.test/mcp", HELPER, agentHome);
    expect(JSON.parse(await registered())).toMatchObject({ url: "https://other.test/mcp" });
  });

  it("reports a refused registration as a failure the person can retry", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "mcp");
    await expect(registerMcp(await loadProfile(FAKE), "skillswiki", URL, HELPER, agentHome)).rejects.toThrow(ActionFailure);
    await expect(registerMcp(await loadProfile(FAKE), "skillswiki", URL, HELPER, agentHome)).rejects.toThrow(
      "Could not register the 'skillswiki' MCP server in Fake Agent: the command exited with code 1",
    );
  });

  it("unregisterMcp says whether a server was removed", async () => {
    const profile = await loadProfile(FAKE);
    await registerMcp(profile, "skillswiki", URL, HELPER, agentHome);
    await expect(unregisterMcp(profile, "skillswiki", agentHome)).resolves.toBe(true);
    await expect(unregisterMcp(profile, "skillswiki", agentHome)).resolves.toBe(false);
    await expect(registered()).rejects.toThrow();
  });

  it("refuses a profile without the MCP templates", async () => {
    await expect(registerMcp(await loadProfile(MISSING), "skillswiki", URL, HELPER, agentHome)).rejects.toThrow(/has no mcp_remove template/);
  });
});

describe("register_mcp in an install", () => {
  const steps = [
    { step_id: "pre.probe", phase: "PREFLIGHT", type: "auto", title: "Probe", why: "Needed.", blocking: true, auto: { action: "probe_runtime", args: { profile: "fake-agent" } } },
    { step_id: "brain.register", phase: "BRAIN", type: "auto", title: "Register", why: "Needed.", blocking: true, auto: { action: "register_mcp" } },
  ];

  async function install(key?: string) {
    const keychain = await makeTempHome();
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", keychain);
    if (key) await setSecret("skillswiki", key);
    const { deps } = memoryDeps(await makeTempHome(), parseSolution({ id: "r", version: "1", steps }));
    return { deps, started: await start(deps, null, "file:/r.json", "sha", { skillswiki: { url: URL } }) };
  }

  it("registers Skills Wiki in the probed agent with the installer's own headers helper", async () => {
    const { started } = await install("k-1");
    expect(started.result).toEqual({ status: "complete" });
    expect(JSON.parse(await registered())).toMatchObject({ type: "http", url: URL, headersHelper: expect.stringMatching(/mcp-headers skillswiki$/) });
  });

  it("fails with the key hint when no key is stored, and nothing is registered", async () => {
    const { started } = await install();
    expect(started.result).toMatchObject({ status: "step", view: { step: { step_id: "brain.register" }, status: "failed", hint: KEY_MISSING_HINT } });
    await expect(registered()).rejects.toThrow();
  });

  it("fails, then blocks after three refusals by the agent (D53)", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "mcp");
    const { deps, started } = await install("k-1");
    expect(started.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 1, resume: "installer resume" } });
    const second = await resume(deps, started.state);
    expect(second.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 2 } });
    const third = await resume(deps, second.state);
    expect(third.result).toMatchObject({ status: "blocked", view: { attempts: 3, hint: expect.stringContaining("Could not register") } });
  });

  it("needs a probed agent", async () => {
    await expect(runAction(await makeTempHome(), { action: "register_mcp" })).rejects.toThrow("The probe found no known agent");
  });
});
```

Run: `npx vitest run tests/unit/register.test.ts tests/unit/profile.test.ts tests/unit/headless.test.ts tests/unit/solution.test.ts tests/e2e/cli.test.ts`
Expected: FAIL — `src/core/register.ts` does not exist; the new profile parts are not parsed; `buildArgv` is not exported.

- [ ] **Step 3: Parse the new profile parts**

In `src/core/profile.ts`, replace:

```ts
  readonly headless: { readonly cmd: readonly string[]; readonly result_path: string; readonly session_path: string; readonly error_path?: string };
  readonly schema?: { readonly flag: readonly string[]; readonly result_path: string };
  readonly resume?: { readonly flag: readonly string[] };
  readonly tos_review: { readonly status: "ok" | "pending" | "blocked"; readonly note: string };
```

with:

```ts
  readonly headless: {
    readonly cmd: readonly string[];
    readonly result_path: string;
    readonly session_path: string;
    readonly error_path?: string;
    /** Appended to every headless call except the C6 probe, which uses allow_tool instead (D52, D54). */
    readonly tools_off?: readonly string[];
    readonly allow_tool?: readonly string[];
  };
  readonly schema?: { readonly flag: readonly string[]; readonly result_path: string };
  readonly resume?: { readonly flag: readonly string[] };
  /** Run by the engine, never by the agent, to add or remove an MCP server (D46, D52). */
  readonly mcp_register?: { readonly cmd: readonly string[] };
  readonly mcp_remove?: { readonly cmd: readonly string[] };
  readonly tos_review: { readonly status: "ok" | "pending" | "blocked"; readonly note: string };
```

In `src/core/profile.ts`, replace:

```ts
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "detect.cmd": ["profile_dir"],
  "headless.cmd": ["profile_dir", "prompt"],
  "schema.flag": ["schema_json"],
  "resume.flag": ["session_id"],
};

function argv(value: unknown, where: string, placeholder?: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) {
    throw new ProfileError(`Profile ${where} must be a non-empty list of strings`);
  }
  if (placeholder && !value.some((part: string) => part.includes(placeholder))) throw new ProfileError(`Profile ${where} must contain ${placeholder}`);
```

with:

```ts
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "detect.cmd": ["profile_dir"],
  "headless.cmd": ["profile_dir", "prompt"],
  "headless.tools_off": [],
  "headless.allow_tool": ["tool"],
  "schema.flag": ["schema_json"],
  "resume.flag": ["session_id"],
  "mcp_register.cmd": ["profile_dir", "name", "config_json"],
  "mcp_remove.cmd": ["profile_dir", "name"],
};

function argv(value: unknown, where: string, ...placeholders: string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) {
    throw new ProfileError(`Profile ${where} must be a non-empty list of strings`);
  }
  for (const placeholder of placeholders) {
    if (!value.some((part: string) => part.includes(placeholder))) throw new ProfileError(`Profile ${where} must contain ${placeholder}`);
  }
```

In `src/core/profile.ts`, add before:

```ts
function optionalParts(raw: Raw): Pick<RuntimeProfile, "schema" | "resume"> {
```

this:

```ts
function headlessPart(raw: Raw): RuntimeProfile["headless"] {
  const headless = obj(raw.headless, "headless");
  return {
    cmd: argv(headless.cmd, "headless.cmd", "{prompt}"),
    result_path: str(headless.result_path, "headless.result_path"),
    session_path: str(headless.session_path, "headless.session_path"),
    ...(headless.error_path === undefined ? {} : { error_path: str(headless.error_path, "headless.error_path") }),
    ...(headless.tools_off === undefined ? {} : { tools_off: argv(headless.tools_off, "headless.tools_off") }),
    ...(headless.allow_tool === undefined ? {} : { allow_tool: argv(headless.allow_tool, "headless.allow_tool", "{tool}") }),
  };
}

function mcpParts(raw: Raw): Pick<RuntimeProfile, "mcp_register" | "mcp_remove"> {
  const register = raw.mcp_register === undefined ? undefined : obj(raw.mcp_register, "mcp_register");
  const remove = raw.mcp_remove === undefined ? undefined : obj(raw.mcp_remove, "mcp_remove");
  return {
    ...(register ? { mcp_register: { cmd: argv(register.cmd, "mcp_register.cmd", "{name}", "{config_json}") } } : {}),
    ...(remove ? { mcp_remove: { cmd: argv(remove.cmd, "mcp_remove.cmd", "{name}") } } : {}),
  };
}
```

In `src/core/profile.ts`, replace:

```ts
  const detect = obj(raw.detect, "detect");
  const headless = obj(raw.headless, "headless");
  const tos = obj(raw.tos_review, "tos_review");
  if (!(TOS_STATUSES as readonly unknown[]).includes(tos.status)) throw new ProfileError(`Profile tos_review.status must be one of ${TOS_STATUSES.join(", ")}`);
  return {
    id,
    name: str(raw.name, "name"),
    min_version: str(raw.min_version, "min_version"),
    detect: { cmd: argv(detect.cmd, "detect.cmd"), match: str(detect.match, "detect.match") },
    headless: {
      cmd: argv(headless.cmd, "headless.cmd", "{prompt}"),
      result_path: str(headless.result_path, "headless.result_path"),
      session_path: str(headless.session_path, "headless.session_path"),
      ...(headless.error_path === undefined ? {} : { error_path: str(headless.error_path, "headless.error_path") }),
    },
    ...optionalParts(raw),
    tos_review: { status: tos.status as RuntimeProfile["tos_review"]["status"], note: str(tos.note, "tos_review.note") },
    dir,
  };
```

with:

```ts
  const detect = obj(raw.detect, "detect");
  const tos = obj(raw.tos_review, "tos_review");
  if (!(TOS_STATUSES as readonly unknown[]).includes(tos.status)) throw new ProfileError(`Profile tos_review.status must be one of ${TOS_STATUSES.join(", ")}`);
  return {
    id,
    name: str(raw.name, "name"),
    min_version: str(raw.min_version, "min_version"),
    detect: { cmd: argv(detect.cmd, "detect.cmd"), match: str(detect.match, "detect.match") },
    headless: headlessPart(raw),
    ...optionalParts(raw),
    ...mcpParts(raw),
    tos_review: { status: tos.status as RuntimeProfile["tos_review"]["status"], note: str(tos.note, "tos_review.note") },
    dir,
  };
```

- [ ] **Step 4: Let a headless request allow one tool**

In `src/core/headless.ts`, replace:

```ts
export interface HeadlessRequest {
  readonly prompt: string;
  readonly schema?: object;
  readonly sessionId?: string;
}
```

with:

```ts
export interface HeadlessRequest {
  readonly prompt: string;
  readonly schema?: object;
  readonly sessionId?: string;
  /** Exactly one tool the agent may call; replaces the profile's tools-off flags for this call (C6 probe, D54). */
  readonly allowTool?: string;
}
```

In `src/core/headless.ts`, replace:

```ts
function buildArgv(profile: RuntimeProfile, request: HeadlessRequest): string[] {
  const base = fillTemplate(profile.headless.cmd, { profile_dir: profile.dir, prompt: request.prompt });
  const schema = request.schema && profile.schema ? fillTemplate(profile.schema.flag, { schema_json: JSON.stringify(request.schema) }) : [];
  const resume = request.sessionId && profile.resume ? fillTemplate(profile.resume.flag, { session_id: request.sessionId }) : [];
  return [...base, ...schema, ...resume];
}
```

with:

```ts
function toolArgs(profile: RuntimeProfile, request: HeadlessRequest): string[] {
  if (request.allowTool === undefined) return [...(profile.headless.tools_off ?? [])];
  if (!profile.headless.allow_tool) throw new ProfileError(`Profile '${profile.id}' has no headless.allow_tool template, so it cannot allow '${request.allowTool}'`);
  return fillTemplate(profile.headless.allow_tool, { tool: request.allowTool });
}

/** Exported for tests: the exact argv a request produces. */
export function buildArgv(profile: RuntimeProfile, request: HeadlessRequest): string[] {
  const base = fillTemplate(profile.headless.cmd, { profile_dir: profile.dir, prompt: request.prompt });
  const schema = request.schema && profile.schema ? fillTemplate(profile.schema.flag, { schema_json: JSON.stringify(request.schema) }) : [];
  const resume = request.sessionId && profile.resume ? fillTemplate(profile.resume.flag, { session_id: request.sessionId }) : [];
  return [...base, ...toolArgs(profile, request), ...schema, ...resume];
}
```

- [ ] **Step 5: Implement registration**

Create `src/core/register.ts`:

```ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionFailure } from "./failure.js";
import { fillTemplate, runProcess, type ProcessResult } from "./headless.js";
import type { RuntimeProfile } from "./profile.js";

/** `claude mcp add-json` health-checks nothing, but a slow agent start is still possible. */
export const MCP_COMMAND_TIMEOUT_MS = 60_000;
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** The test suite runs from src/, so it points this at the built CLI; the package needs no override. */
export const CLI_PATH_ENV = "INSTALLER_CLI";

/** The installer's own entry file (dist/core/register.js → dist/cli.js), absolute, so the agent can run it from any folder. */
export function installerCliPath(): string {
  return realpathSync(process.env[CLI_PATH_ENV] || fileURLToPath(new URL("../cli.js", import.meta.url)));
}

/** The command the agent runs for every request's headers; absolute paths, quoted for the agent's shell (D52). */
export function headersHelperCommand(secretId: string, execPath: string, cliPath: string): string {
  return `${shellQuote(execPath)} ${shellQuote(cliPath)} mcp-headers ${secretId}`;
}

/** The `claude mcp add-json` payload: an http server whose Authorization header comes from the helper, never from a file. */
export function mcpServerConfig(url: string, headersHelper: string): string {
  return JSON.stringify({ type: "http", url, headersHelper });
}

function requireTemplate(profile: RuntimeProfile, key: "mcp_register" | "mcp_remove"): readonly string[] {
  const template = profile[key];
  if (!template) throw new ActionFailure(`The ${profile.name} profile has no ${key} template, so the installer cannot manage its MCP servers`);
  return template.cmd;
}

function mcpCommand(profile: RuntimeProfile, key: "mcp_register" | "mcp_remove", vars: Readonly<Record<string, string>>, cwd: string): Promise<ProcessResult> {
  return runProcess(fillTemplate(requireTemplate(profile, key), { profile_dir: profile.dir, ...vars }), cwd, MCP_COMMAND_TIMEOUT_MS);
}

const tail = (stdout: string): string => (stdout.trim() === "" ? "" : ` (${stdout.trim().slice(-200)})`);

/**
 * Remove, then add: verified live that `claude mcp add-json` refuses an existing name and that
 * `claude mcp remove` of a missing name exits 1 with a message, so this is idempotent without `mcp get`
 * (which would health-check the server and run the headers helper).
 */
export async function registerMcp(profile: RuntimeProfile, name: string, url: string, headersHelper: string, cwd: string): Promise<void> {
  await mcpCommand(profile, "mcp_remove", { name }, cwd);
  const result = await mcpCommand(profile, "mcp_register", { name, config_json: mcpServerConfig(url, headersHelper) }, cwd);
  if (result.error) throw new ActionFailure(`Could not register the '${name}' MCP server in ${profile.name}: the command ${result.error}${tail(result.stdout)}`);
}

/** True when a server of that name was removed, false when there was none (or the agent is gone). */
export async function unregisterMcp(profile: RuntimeProfile, name: string, cwd: string): Promise<boolean> {
  return (await mcpCommand(profile, "mcp_remove", { name }, cwd)).code === 0;
}
```

The test suite runs from `src/`, so point the helper at the built CLI:

In `vitest.config.ts`, replace:

```ts
      // `installer secret` must never open a browser tab during a test run.
      INSTALLER_BROWSER: "none",
    },
```

with:

```ts
      // `installer secret` must never open a browser tab during a test run.
      INSTALLER_BROWSER: "none",
      // In-process tests run from src/; the MCP headers helper must still name the built CLI (D52).
      INSTALLER_CLI: resolve("dist/cli.js"),
    },
```

- [ ] **Step 6: Add the action, the order rule and the `mcp-headers` command**

In `src/core/actions.ts`, replace:

```ts
import { deriveModeAction } from "./mode.js";
import { listBundledProfiles, loadProfileById } from "./profile.js";
import { runProbe } from "./probe.js";
import type { Action, Check, InstallState, StatePatch } from "./types.js";
```

with:

```ts
import { deriveModeAction } from "./mode.js";
import { listBundledProfiles, loadProfileById, type RuntimeProfile } from "./profile.js";
import { runProbe } from "./probe.js";
import { headersHelperCommand, installerCliPath, registerMcp } from "./register.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID, skillswikiTarget } from "./skillswiki.js";
import type { Action, CapabilityMap, Check, InstallState, StatePatch } from "./types.js";
```

In `src/core/actions.ts`, replace:

```ts
/** Working folder for headless agent calls made by the probe, inside the engine home (D34). */
export const PROBE_DIR = join("runtime", "probe");

type ActionRun = (home: string, args: Args, state: InstallState | undefined) => Promise<StatePatch>;
```

with:

```ts
/** Working folder for headless agent calls made by the probe, inside the engine home (D34). */
export const PROBE_DIR = join("runtime", "probe");
const NO_AGENT_HINT = "The probe found no known agent to register Skills Wiki in; install a supported agent, then run 'installer resume'";

async function probeDir(home: string): Promise<string> {
  const cwd = await confinedPath(home, PROBE_DIR);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

/** The capability map and profile the probe recorded; without them Skills Wiki cannot be registered (fallbacks are later plans). */
async function probedRuntime(state: InstallState | undefined): Promise<{ runtime: CapabilityMap; profile: RuntimeProfile }> {
  const runtime = state?.runtime;
  if (!runtime?.profile) throw new ActionFailure(NO_AGENT_HINT);
  return { runtime, profile: await loadProfileById(runtime.profile) };
}

type ActionRun = (home: string, args: Args, state: InstallState | undefined) => Promise<StatePatch>;
```

In `src/core/actions.ts`, replace:

```ts
  probe_runtime: async (home, args) => {
    const cwd = await confinedPath(home, PROBE_DIR);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const profiles = typeof args.profile === "string" ? [await loadProfileById(args.profile)] : await listBundledProfiles();
    return { runtime: await runProbe({ profiles, cwd }) };
  },
  derive_mode: async (_home, args, state) => deriveModeAction(args, state),
};
```

with:

```ts
  probe_runtime: async (home, args) => {
    const profiles = typeof args.profile === "string" ? [await loadProfileById(args.profile)] : await listBundledProfiles();
    return { runtime: await runProbe({ profiles, cwd: await probeDir(home) }) };
  },
  derive_mode: async (_home, args, state) => deriveModeAction(args, state),
  register_mcp: async (home, _args, state) => {
    const { profile } = await probedRuntime(state);
    const { url } = await skillswikiTarget(state?.skillswiki?.url);
    const helper = headersHelperCommand(SKILLSWIKI_SECRET_ID, process.execPath, installerCliPath());
    await registerMcp(profile, SKILLSWIKI_MCP_NAME, url, helper, await probeDir(home));
    return {};
  },
};
```

In `src/core/solution.ts`, add before:

```ts
const SECRET_ID = /^[a-z0-9-]+$/;
```

this:

```ts
/** BRAIN steps read what earlier engine steps recorded (the probed profile, the registration). */
const NEEDS_EARLIER: Readonly<Record<string, string>> = { register_mcp: "probe_runtime", probe_mcp: "register_mcp" };

function checkBrainOrder(steps: readonly StepDef[]): void {
  steps.forEach((step, index) => {
    const action = step.auto?.action ?? "";
    if (!Object.hasOwn(NEEDS_EARLIER, action)) return;
    const needed = NEEDS_EARLIER[action];
    if (!steps.slice(0, index).some((earlier) => earlier.auto?.action === needed)) throw new SolutionError(`Step '${step.step_id}': ${action} needs an earlier ${needed} step`);
  });
}
```

In `src/core/solution.ts`, replace:

```ts
  checkSecretSteps(steps);
  return { id, version, steps };
```

with:

```ts
  checkSecretSteps(steps);
  checkBrainOrder(steps);
  return { id, version, steps };
```

In `src/cli.ts`, replace:

```ts
type Standalone = (home: string, flags: Flags, arg: string | undefined) => Promise<unknown>;
```

with:

```ts
/** Run by the agent for every Skills Wiki request (D52): the header line, or exit 1 and no output when the key is missing. */
async function headersCommand(id: string): Promise<number> {
  const key = await getSecret(requireSecretId(id));
  if (key === null) return EXIT.INTERNAL;
  emit(process.stdout, JSON.stringify({ Authorization: `Bearer ${key}` }));
  return EXIT.OK;
}

type Standalone = (home: string, flags: Flags, arg: string | undefined) => Promise<unknown>;
```

In `src/cli.ts`, replace:

```ts
  if (command === "secret-serve") return secretServeCommand(requireArg(arg, command));
```

with:

```ts
  if (command === "secret-serve") return secretServeCommand(requireArg(arg, command));
  if (command === "mcp-headers") return headersCommand(requireArg(arg, command));
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/unit/register.test.ts tests/unit/profile.test.ts tests/unit/headless.test.ts tests/unit/solution.test.ts tests/e2e/cli.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (11 + 20 + 14 + 21 + 41 tests); typecheck exits 0; the whole suite passes: 27 files, 378 tests.

- [ ] **Step 8: Commit**

```bash
git add src/core/register.ts src/core/profile.ts src/core/headless.ts src/core/actions.ts src/core/solution.ts src/cli.ts profiles/claude-code.json vitest.config.ts tests/fixtures/profiles/fake-agent.json tests/fakes/fake-agent.mjs tests/unit/register.test.ts tests/unit/profile.test.ts tests/unit/headless.test.ts tests/unit/solution.test.ts tests/e2e/cli.test.ts
git commit -m "feat(core): register the Skills Wiki MCP in the agent with a headers helper"
```

---

### Task 7: The combo step (`combo_active`, D37)

**Files:**
- Modify: `src/core/actions.ts`
- Test: `tests/unit/combo.test.ts` (new)

**Interfaces:**
- Consumes: `runCheck(home, check, state)` and the `ActionFailure` → failed-check path (Task 1), `activeComboSlug`, `skillswikiTarget` (Task 4), `state.skillswiki.url` (Task 5).
- Produces: check `combo_active` (optional `args.hint`): passes when the engine's own `get_active_combo` reports a combo; otherwise fails with "No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again". A rejected key or an unreachable host becomes a failed check with that hint (retry with `installer verify <step_id>`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/combo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../../src/core/actions.js";
import { EngineError, start, submit, verifyStep } from "../../src/core/engine.js";
import { ActionFailure } from "../../src/core/failure.js";
import { setSecret } from "../../src/core/keychain.js";
import { KEY_REJECTED_HINT } from "../../src/core/mcp.js";
import { URL_MISSING_HINT } from "../../src/core/skillswiki.js";
import { parseSolution } from "../../src/core/solution.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const COMBO_STEP = {
  step_id: "brain.combo", phase: "BRAIN", type: "human_action", title: "Activate the combo", why: "Needed.", blocking: true,
  instructions: ["Open the Skills Wiki dashboard", "Activate the combo"], verify: { check: "combo_active" },
};
const servers: FakeMcp[] = [];

async function server(env: Record<string, string> = {}): Promise<FakeMcp> {
  const fake = await startFakeMcp(env);
  servers.push(fake);
  return fake;
}

async function installWith(url: string) {
  const { deps } = memoryDeps(await makeTempHome(), parseSolution({ id: "c", version: "1", steps: [COMBO_STEP] }));
  const { state } = await start(deps, null, "file:/c.json", "sha", { skillswiki: { url } });
  return { deps, state };
}

beforeEach(async () => {
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
  await setSecret("skillswiki", "test-key");
});

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
  vi.unstubAllEnvs();
});

describe("the combo step (D37)", () => {
  it("passes once a combo is active in Skills Wiki", async () => {
    const fake = await server();
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toEqual({ status: "passed" });
    expect(verified.state.steps["brain.combo"]).toMatchObject({ status: "done", by: "human" });
  });

  it("fails with a dashboard hint while no combo is active", async () => {
    const fake = await server({ FAKE_MCP_COMBO: "" });
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toEqual({ status: "failed", hint: "No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again", retry: true });
  });

  it("turns a rejected key into a failed check with the secret hint (Review Focus 3)", async () => {
    const fake = await server({ FAKE_MCP_KEY: "another-key" });
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toEqual({ status: "failed", hint: KEY_REJECTED_HINT, retry: true });
  });

  it("names the url when Skills Wiki is unreachable, and the step can be retried", async () => {
    const fake = await server();
    fake.stop();
    await new Promise((tick) => setTimeout(tick, 50));
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toMatchObject({ status: "failed", hint: expect.stringContaining(`Cannot reach Skills Wiki at '${fake.url}'`), retry: true });
    expect(verified.next).toMatchObject({ status: "step", view: { resume: "installer verify brain.combo" } });
  });

  it("cannot be completed with --done", async () => {
    const fake = await server();
    const { deps, state } = await installWith(fake.url);
    await expect(submit(deps, state, "brain.combo", { kind: "done" })).rejects.toThrow(EngineError);
  });

  it("needs the Skills Wiki url from the install state", async () => {
    await expect(runCheck(await makeTempHome(), { check: "combo_active" })).rejects.toThrow(ActionFailure);
    await expect(runCheck(await makeTempHome(), { check: "combo_active" })).rejects.toThrow(URL_MISSING_HINT);
  });
});
```

Run: `npx vitest run tests/unit/combo.test.ts`
Expected: FAIL — `combo_active` is an unknown check (the solution is refused at parse time).

- [ ] **Step 2: Add the check**

In `src/core/actions.ts`, replace:

```ts
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID, skillswikiTarget } from "./skillswiki.js";
```

with:

```ts
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID, activeComboSlug, skillswikiTarget } from "./skillswiki.js";
```

In `src/core/actions.ts`, replace:

```ts
  secret_present: async (_home, args) => {
    const id = stringArg(args, "id");
    if ((await getSecret(id)) !== null) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : `No '${id}' key is stored yet: run 'installer secret ${id}', enter it on the page that opens, then run the verify again` };
  },
};
```

with:

```ts
  secret_present: async (_home, args) => {
    const id = stringArg(args, "id");
    if ((await getSecret(id)) !== null) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : `No '${id}' key is stored yet: run 'installer secret ${id}', enter it on the page that opens, then run the verify again` };
  },
  /** D37: the person activates the combo in the Skills Wiki dashboard; the engine asks get_active_combo itself. */
  combo_active: async (_home, args, state) => {
    if (await activeComboSlug(await skillswikiTarget(state?.skillswiki?.url))) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : "No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again" };
  },
};
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/unit/combo.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (6 tests); typecheck exits 0; the whole suite passes: 28 files, 384 tests.

- [ ] **Step 4: Commit**

```bash
git add src/core/actions.ts tests/unit/combo.test.ts
git commit -m "feat(core): confirm the active combo through get_active_combo"
```

---

### Task 8: The C6 probe (`probe_mcp`), capability map and report (D54)

**Files:**
- Modify: `src/core/types.ts` (`c6_mcp`), `src/core/probe.ts` (`probeMcp`, `withMcpProbe`), `src/core/actions.ts` (`probe_mcp`), `src/core/report.ts` (C6 limit)
- Test: `tests/unit/probe-mcp.test.ts` (new), `tests/unit/report.test.ts`

**Interfaces:**
- Consumes: `runHeadless` with `allowTool` (Task 6), `registerMcp` / `headersHelperCommand` / `installerCliPath` (Task 6, used by the test to register the fake server), `activeComboSlug`, `skillswikiTarget`, `state.work_dir`.
- Produces:
  - `types.ts`: `CapabilityMap.c6_mcp: boolean | "not_probed"`.
  - `probe.ts`: `export interface ProbeCheck`, `interface McpProbeOptions { profile; cwd; serverName; expectedSlug; timeoutMs? }`, `mcpToolName(serverName)` = `mcp__<serverName>__get_active_combo`, `probeMcp(options): Promise<ProbeCheck>`, `withMcpProbe(runtime, check): CapabilityMap` (sets `c6_mcp`, replaces any older `C6 MCP:` note, recounts `support_level` over C4, C5, C6).
  - Action `probe_mcp` (no args): needs the probed runtime, the Skills Wiki target and an active combo (else `ActionFailure` "No combo is active in Skills Wiki yet…"); runs in `state.work_dir` (or the probe folder); records the result in `runtime`. A failed C6 is a note, not a failure: the install goes on.
  - `report.ts`: `runtimeLimits` adds `"no MCP client; Skills Wiki content is inlined"` when `c6_mcp === false`; `agentLine` already prints `MCP not checked yet` for `"not_probed"` and nothing for `true`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/probe-mcp.test.ts`:

```ts
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../src/core/engine.js";
import { setSecret } from "../../src/core/keychain.js";
import { loadProfile } from "../../src/core/profile.js";
import { mcpToolName, probeMcp, withMcpProbe } from "../../src/core/probe.js";
import { headersHelperCommand, installerCliPath, registerMcp } from "../../src/core/register.js";
import { parseSolution } from "../../src/core/solution.js";
import type { CapabilityMap } from "../../src/core/types.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const servers: FakeMcp[] = [];
let cwd = "";

const runtime: CapabilityMap = {
  profile: "fake-agent", agent_version: "9.9.9", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
  c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: ["C4 schema: unexpected answer"],
};

async function wiki(env: Record<string, string> = {}): Promise<FakeMcp> {
  const fake = await startFakeMcp(env);
  servers.push(fake);
  return fake;
}

/** The engine's own registration, so the fake agent finds the helper and the url the way the real one would. */
async function registered(fake: FakeMcp) {
  const profile = await loadProfile(FAKE);
  await registerMcp(profile, "skillswiki", fake.url, headersHelperCommand("skillswiki", process.execPath, installerCliPath()), cwd);
  return profile;
}

beforeEach(async () => {
  cwd = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
  await setSecret("skillswiki", "test-key");
});

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
  vi.unstubAllEnvs();
});

describe("probeMcp (C6, fact 4)", () => {
  it("passes when the agent reaches Skills Wiki through the registered server and reports the engine's slug", async () => {
    const profile = await registered(await wiki());
    await expect(probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "demo-combo" })).resolves.toEqual({ ok: true });
  });

  it("names the folder whose trust may be missing when the agent cannot run the helper (Review Focus 2)", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "trust");
    const profile = await registered(await wiki());
    const check = await probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "demo-combo" });
    expect(check.ok).toBe(false);
    expect(check.note).toBe(`C6 MCP: the agent answered 'headersHelper not run: this workspace has no persisted trust' instead of 'demo-combo'; workspace trust may be missing in ${cwd} (open the agent there once and accept the folder)`);
  });

  it("fails when the agent reports another combo than the engine saw", async () => {
    const profile = await registered(await wiki());
    const check = await probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "other-combo" });
    expect(check).toMatchObject({ ok: false, note: expect.stringContaining("answered 'demo-combo' instead of 'other-combo'") });
  });

  it("fails when the agent cannot run at all, without crashing", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "c4");
    const profile = await registered(await wiki());
    expect(await probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "demo-combo" })).toMatchObject({ ok: false, note: expect.stringContaining("the agent exited with code 1") });
  });

  it("names the one tool the agent may use", () => {
    expect(mcpToolName("skillswiki")).toBe("mcp__skillswiki__get_active_combo");
  });
});

describe("withMcpProbe", () => {
  it("records a pass as level 3 and keeps the other notes", () => {
    expect(withMcpProbe(runtime, { ok: true })).toEqual({ ...runtime, c6_mcp: true, support_level: 3 });
  });

  it("records a failure with its note, replacing an older C6 note", () => {
    const once = withMcpProbe(runtime, { ok: false, note: "C6 MCP: first" });
    const twice = withMcpProbe(once, { ok: false, note: "C6 MCP: second" });
    expect(twice).toEqual({ ...runtime, c6_mcp: false, support_level: 2, notes: ["C4 schema: unexpected answer", "C6 MCP: second"] });
  });
});

describe("probe_mcp in an install (D54)", () => {
  const steps = [
    { step_id: "pre.probe", phase: "PREFLIGHT", type: "auto", title: "Probe", why: "Needed.", blocking: true, auto: { action: "probe_runtime", args: { profile: "fake-agent" } } },
    { step_id: "brain.register", phase: "BRAIN", type: "auto", title: "Register", why: "Needed.", blocking: true, auto: { action: "register_mcp" } },
    { step_id: "brain.probe-mcp", phase: "BRAIN", type: "auto", title: "Probe MCP", why: "Needed.", blocking: true, auto: { action: "probe_mcp" } },
  ];

  async function install(url: string) {
    const { deps } = memoryDeps(await makeTempHome(), parseSolution({ id: "p", version: "1", steps }));
    return start(deps, null, "file:/p.json", "sha", { skillswiki: { url }, work_dir: cwd });
  }

  it("runs in the recorded working folder and lifts the support level to 3", async () => {
    const fake = await wiki();
    const { state, result } = await install(fake.url);
    expect(result).toEqual({ status: "complete" });
    expect(state.runtime).toMatchObject({ profile: "fake-agent", c6_mcp: true, support_level: 3, notes: [] });
  });

  it("records a failed C6 with the trust note and still completes the install", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "trust");
    const fake = await wiki();
    const { state, result } = await install(fake.url);
    expect(result).toEqual({ status: "complete" });
    expect(state.runtime).toMatchObject({ c6_mcp: false, support_level: 2, notes: [expect.stringContaining(`workspace trust may be missing in ${cwd}`)] });
  });

  it("fails with a dashboard hint while no combo is active", async () => {
    const fake = await wiki({ FAKE_MCP_COMBO: "" });
    const { result } = await install(fake.url);
    expect(result).toMatchObject({ status: "step", view: { step: { step_id: "brain.probe-mcp" }, status: "failed", hint: expect.stringContaining("No combo is active") } });
  });

  it("is refused at load time before register_mcp", () => {
    expect(() => parseSolution({ id: "p", version: "1", steps: [steps[0], steps[2]] })).toThrow("Step 'brain.probe-mcp': probe_mcp needs an earlier register_mcp step");
  });
});
```



In `tests/unit/report.test.ts`, add before:

```ts
  it("prints no agent line before the probe has run", () => {
```

this:

```ts
  it("counts a working MCP client as the third level with nothing missing", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime: { ...runtime, c6_mcp: true, support_level: 3 } });
    expect(report.overall).toBe("ready");
    expect(renderReport(report).split("\n")[2]).toBe("🤖 Agent      claude-code 2.1.294 — level 3 of 3");
  });

  it("turns a failed MCP probe into READY WITH LIMITS that names the inlining fallback (D54)", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime: { ...runtime, c6_mcp: false } });
    expect(report.overall).toBe("ready_with_limits");
    expect(report.runtime_limits).toEqual(["no MCP client; Skills Wiki content is inlined"]);
    expect(renderReport(report)).toContain("level 2 of 3 (no MCP client; Skills Wiki content is inlined)");
  });
```

Run: `npx vitest run tests/unit/probe-mcp.test.ts tests/unit/report.test.ts`
Expected: FAIL — `probeMcp` is not exported; `c6_mcp: true` is not assignable; `probe_mcp` is an unknown action.

- [ ] **Step 2: Widen the capability map and add the probe**

In `src/core/types.ts`, replace:

```ts
/** Result of `installer probe` (spec §7.3). C6 is probed by Plan 3. */
export interface CapabilityMap {
  readonly profile: string | null;
  readonly agent_version: string | null;
  readonly c2_shell: boolean;
  readonly c4_headless: boolean;
  readonly c4_schema: boolean;
  readonly c5_resume: boolean;
  readonly c6_mcp: "not_probed";
```

with:

```ts
/** Result of `installer probe` (spec §7.3); C6 is filled in by the BRAIN phase's probe_mcp step (D54). */
export interface CapabilityMap {
  readonly profile: string | null;
  readonly agent_version: string | null;
  readonly c2_shell: boolean;
  readonly c4_headless: boolean;
  readonly c4_schema: boolean;
  readonly c5_resume: boolean;
  readonly c6_mcp: boolean | "not_probed";
```

In `src/core/probe.ts`, replace:

```ts
interface ProbeCheck {
  readonly ok: boolean;
  readonly note?: string;
}
```

with:

```ts
export interface ProbeCheck {
  readonly ok: boolean;
  readonly note?: string;
}
```

In `src/core/probe.ts`, add before:

```ts
export function unknownRuntime(note: string): CapabilityMap {
```

this:

```ts
export interface McpProbeOptions {
  readonly profile: RuntimeProfile;
  /** The agent's own working folder: MCP trust is per folder (D52, D54). */
  readonly cwd: string;
  readonly serverName: string;
  /** What the engine's own get_active_combo call returned. */
  readonly expectedSlug: string;
  readonly timeoutMs?: number;
}

export const mcpToolName = (serverName: string): string => `mcp__${serverName}__get_active_combo`;

/** C6: the agent calls the registered server's get_active_combo and must report the same slug the engine saw (fact 5). */
export async function probeMcp(options: McpProbeOptions): Promise<ProbeCheck> {
  const tool = mcpToolName(options.serverName);
  if (!options.profile.headless.allow_tool) return { ok: false, note: `C6 MCP: the ${options.profile.name} profile has no headless.allow_tool template` };
  const request: HeadlessRequest = { prompt: `Call the tool ${tool} (no arguments) and reply with only the value of its combo_slug field, nothing else.`, allowTool: tool };
  const result = await runHeadless(options.profile, request, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? HEADLESS_TIMEOUT_MS });
  if (result.ok && result.text.trim() === options.expectedSlug) return { ok: true };
  const detail = result.ok ? `the agent answered '${result.text.trim().slice(0, 80)}' instead of '${options.expectedSlug}'` : `the agent ${result.error}`;
  return { ok: false, note: `C6 MCP: ${detail}; workspace trust may be missing in ${options.cwd} (open the agent there once and accept the folder)` };
}

/** Records the C6 result and recounts the support level (C4, C5, C6). */
export function withMcpProbe(runtime: CapabilityMap, check: ProbeCheck): CapabilityMap {
  const notes = [...runtime.notes.filter((note) => !note.startsWith("C6 MCP:")), ...(check.note ? [check.note] : [])];
  return { ...runtime, c6_mcp: check.ok, notes, support_level: [runtime.c4_headless, runtime.c5_resume, check.ok].filter(Boolean).length };
}
```

In `src/core/actions.ts`, replace:

```ts
import { runProbe } from "./probe.js";
```

with:

```ts
import { probeMcp, runProbe, withMcpProbe } from "./probe.js";
```

In `src/core/actions.ts`, replace:

```ts
const NO_AGENT_HINT = "The probe found no known agent to register Skills Wiki in; install a supported agent, then run 'installer resume'";
```

with:

```ts
const NO_AGENT_HINT = "The probe found no known agent to register Skills Wiki in; install a supported agent, then run 'installer resume'";
const NO_COMBO_HINT = "No combo is active in Skills Wiki yet: activate one in your dashboard, then run 'installer resume'";
```

In `src/core/actions.ts`, replace:

```ts
    await registerMcp(profile, SKILLSWIKI_MCP_NAME, url, helper, await probeDir(home));
    return {};
  },
};
```

with:

```ts
    await registerMcp(profile, SKILLSWIKI_MCP_NAME, url, helper, await probeDir(home));
    return {};
  },
  /** C6 (D54): runs in the agent's own folder, allowing exactly the registered server's get_active_combo tool. */
  probe_mcp: async (home, _args, state) => {
    const { runtime, profile } = await probedRuntime(state);
    const expectedSlug = await activeComboSlug(await skillswikiTarget(state?.skillswiki?.url));
    if (!expectedSlug) throw new ActionFailure(NO_COMBO_HINT);
    const cwd = state?.work_dir ?? (await probeDir(home));
    return { runtime: withMcpProbe(runtime, await probeMcp({ profile, cwd, serverName: SKILLSWIKI_MCP_NAME, expectedSlug })) };
  },
};
```

In `src/core/report.ts`, replace:

```ts
  return [
    ...(runtime.c4_headless ? [] : ["no headless calls"]),
    ...(runtime.c4_headless && !runtime.c4_schema ? ["no structured output"] : []),
    ...(runtime.c5_resume ? [] : ["no session resume"]),
  ];
```

with:

```ts
  return [
    ...(runtime.c4_headless ? [] : ["no headless calls"]),
    ...(runtime.c4_headless && !runtime.c4_schema ? ["no structured output"] : []),
    ...(runtime.c5_resume ? [] : ["no session resume"]),
    ...(runtime.c6_mcp === false ? ["no MCP client; Skills Wiki content is inlined"] : []),
  ];
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/unit/probe-mcp.test.ts tests/unit/report.test.ts tests/unit/probe.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (11 + 13 + 8 tests); typecheck exits 0; the whole suite passes: 29 files, 397 tests.

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/core/probe.ts src/core/actions.ts src/core/report.ts tests/unit/probe-mcp.test.ts tests/unit/report.test.ts
git commit -m "feat(core): probe the agent's MCP client in its own folder"
```

---

### Task 9: `installer disconnect`, `INSTALL.md`, the starter's BRAIN steps and the end-to-end install

**Files:**
- Create: `src/core/disconnect.ts`
- Modify: `src/cli.ts`, `INSTALL.md`, `solutions/starter.json`, `tests/fixtures/solution-starter.json`, `tests/operator/scripted-operator.ts`
- Test: `tests/e2e/install-doc.test.ts` (rewritten), `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `unregisterMcp` (Task 6), `deleteSecret` (Task 2), `loadProfileById`, `appendAudit`, `loadState`.
- Produces:
  - `disconnect.ts`: `disconnect(home, id, now): Promise<{ status: "disconnected"; unregistered: boolean; secret_deleted: boolean }>` — only `skillswiki` in this version; unregisters through the probed profile when the home has an install, deletes the keychain item, appends the audit event `secret.disconnected`.
  - CLI: `installer disconnect skillswiki`.
  - `INSTALL.md`: `installer secret skillswiki` before `installer start --solution {{SOLUTION_REF}} --url {{SKILLSWIKI_URL}}`; secret steps use `installer secret <input.provider>`; a "Removing the connection" section.
  - Starter solution: BRAIN steps `brain.key` (secret, `secret_present`), `brain.register` (`register_mcp`), `brain.combo` (`combo_active`), `brain.probe-mcp` (`probe_mcp`) between `mode.derive` and `report.final`.
  - Operator: `operate({ home, solutionRef, script, crash?, startArgs?, env? })`; `starterScript(storeKey)` performs `brain.key` with the given function and `brain.combo` with nothing.

- [ ] **Step 1: Implement `disconnect` and wire it**

Create `src/core/disconnect.ts`:

```ts
import { appendAudit } from "./audit.js";
import { InputError } from "./inputs.js";
import { deleteSecret } from "./keychain.js";
import { loadProfileById } from "./profile.js";
import { unregisterMcp } from "./register.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID } from "./skillswiki.js";
import { loadState } from "./state.js";

export interface Disconnected {
  readonly status: "disconnected";
  readonly unregistered: boolean;
  readonly secret_deleted: boolean;
}

/** Revoke and delete (D34, §14.2): remove the server from the probed agent, delete the keychain item, record it in the audit. */
export async function disconnect(home: string, id: string, now: () => string): Promise<Disconnected> {
  if (id !== SKILLSWIKI_SECRET_ID) throw new InputError(`Only '${SKILLSWIKI_SECRET_ID}' can be disconnected in this version`);
  const state = await loadState(home);
  const profileId = state?.runtime?.profile;
  const unregistered = profileId ? await unregisterMcp(await loadProfileById(profileId), SKILLSWIKI_MCP_NAME, home) : false;
  const deleted = await deleteSecret(id);
  if (state) await appendAudit(home, { ts: now(), actor: "human", event: "secret.disconnected", ref: id, payload: { unregistered, secret_deleted: deleted } });
  return { status: "disconnected", unregistered, secret_deleted: deleted };
}
```



In `src/cli.ts`, replace:

```ts
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type StartExtras, type SubmitPayload } from "./core/engine.js";
```

with:

```ts
import { disconnect } from "./core/disconnect.js";
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type StartExtras, type SubmitPayload } from "./core/engine.js";
```

In `src/cli.ts`, replace:

```ts
const COMMANDS = "start, next, submit, verify, resume, report, probe, secret";
```

with:

```ts
const COMMANDS = "start, next, submit, verify, resume, report, probe, secret, disconnect";
```

In `src/cli.ts`, replace:

```ts
  secret: (_home, _flags, arg) => secretCommand(requireArg(arg, "secret")),
};
```

with:

```ts
  secret: (_home, _flags, arg) => secretCommand(requireArg(arg, "secret")),
  disconnect: (home, _flags, arg) => disconnect(home, requireArg(arg, "disconnect"), () => new Date().toISOString()),
};
```

- [ ] **Step 2: Add the BRAIN steps to both starter solutions**

In `solutions/starter.json` **and** `tests/fixtures/solution-starter.json` (same block in each), add after:

```json
      "auto": { "action": "derive_mode", "args": { "shared_work": "mode.shared-work", "always_on": "mode.always-on", "decision_maker": "mode.decision-maker" } } },
```

this:

```json
    { "step_id": "brain.key", "phase": "BRAIN", "type": "human_action", "title": "Store your Skills Wiki key", "why": "The installer reaches Skills Wiki with this key; it stays in your keychain and never passes through the agent.", "blocking": true,
      "instructions": ["Open the page that 'installer secret skillswiki' printed (the agent runs that command for you)", "Paste the API key from your Skills Wiki dashboard and press Save", "Tell the agent when the page says Done"],
      "input": { "kind": "secret", "provider": "skillswiki" },
      "verify": { "check": "secret_present", "args": { "id": "skillswiki" } } },
    { "step_id": "brain.register", "phase": "BRAIN", "type": "auto", "title": "Connect your agent to Skills Wiki", "why": "Your agent reads its skills from Skills Wiki through this connection; the key is read from the keychain on every request.", "blocking": true,
      "auto": { "action": "register_mcp" } },
    { "step_id": "brain.combo", "phase": "BRAIN", "type": "human_action", "title": "Activate your combo in the Skills Wiki dashboard", "why": "The active combo decides which skills your agent uses.", "blocking": true,
      "instructions": ["Open your Skills Wiki dashboard", "Activate the combo for this solution", "Tell the agent when it is active"],
      "verify": { "check": "combo_active" } },
    { "step_id": "brain.probe-mcp", "phase": "BRAIN", "type": "auto", "title": "Check that your agent reaches Skills Wiki", "why": "Confirms the connection works from the folder your agent runs in; if it does not, Skills Wiki content is inlined instead.", "blocking": true,
      "auto": { "action": "probe_mcp" } },
```

- [ ] **Step 3: Rewrite `INSTALL.md`**

Replace the whole of `INSTALL.md` with:

````markdown
# Install this solution

You are the operator of this install. A person asked you to install a solution. Follow these steps exactly.

## 1. Install the installer

```bash
{{INSTALL_COMMAND}}
```

## 2. Let the person store their Skills Wiki key

```bash
installer secret skillswiki
```

This prints `{"status":"waiting","url":"http://127.0.0.1:…"}` and opens that page in the person's browser. Tell the person to paste the API key from their Skills Wiki dashboard into the page and press Save; the key goes into their keychain and never passes through you. If the output has a `hint`, relay it word for word (it says how to reach the page from another computer). Wait until the person says the page shows Done, then go on to step 3: `installer start` refuses to run while the key is missing and says so; if that happens, ask the person to finish the page, then run the start command again.

## 3. Start the install

```bash
installer start --solution {{SOLUTION_REF}} --url {{SKILLSWIKI_URL}}
```

`--url` is the MCP URL from the person's Skills Wiki dashboard; it is not a secret. Run this from the folder you work in: the install connects Skills Wiki to you in that folder.

## 4. Repeat until the install is finished or blocked

Every command prints one line of JSON. Read its `status`:

- `"step"`: act on `view.step` by its `type`.
  - `ask`: ask the person the step's `title` and tell them its `why`. Then run `installer submit <step_id> --value '<json>'`. Text answers are JSON strings, for example `--value '"North team"'`. A value that starts with `-` uses the `=` form: `--value=-5`.
  - `human_action`: tell the person the `instructions` and the `why`, and wait until they say it is done. Then run `installer verify <step_id>` if the step has a `verify`, otherwise `installer submit <step_id> --done`. When `input.kind` is `secret`, the person enters it on the page from `installer secret <input.provider>` (run that again if the page was closed); never ask for the value itself.
  - `agent_action`: do the `intent` yourself, following `view.hints` when present. Then run `installer verify <step_id>`.
- `"failed"` or `"blocked"`: tell the person the `hint` and the command in `view.resume`. Stop and wait for them.
- `"complete"`: run `installer report` and show it to the person.

`installer next` shows the current step again. `installer report` shows progress. After a break of minutes or days, `installer resume` continues where the install stopped.

## Removing the connection

`installer disconnect skillswiki` removes the Skills Wiki server from your configuration and deletes the key from the keychain.

## Operator rules

1. Never invent an answer on the person's behalf; ask.
2. Always tell the person why a step is needed (from the step's `why`).
3. Never request, repeat or store secrets in chat. Keys and sign-ins are entered on a page the installer opens on this computer, never through you.
4. At a blocking human step, stop; state exactly what to do and how to resume (`installer resume`).
5. After every `agent_action`, run the step's verify (`installer verify <step_id>`).
````

- [ ] **Step 4: Extend the scripted operator**

In `tests/operator/scripted-operator.ts`, replace:

```ts
export const STARTER_SCRIPT: OperatorScript = {
  answers: { "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner" },
  perform: {},
};
```

with:

```ts
/** The person's two BRAIN actions: the key is stored by the test in the file keychain, the combo is already active on the fake server. */
export function starterScript(storeKey: () => Promise<void>): OperatorScript {
  return {
    answers: { "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner" },
    perform: { "brain.key": storeKey, "brain.combo": async () => undefined },
  };
}
```

In `tests/operator/scripted-operator.ts`, replace:

```ts
/** A fake agent: follows the step protocol exactly as INSTALL.md tells a real agent to. */
export async function operate(options: { home: string; solutionRef: string; script: OperatorScript; crash?: CrashPlan }): Promise<OperatorRun> {
  const calls: CliResult[] = [];
  let crashed = 0;
  const call = (args: readonly string[]): CliResult => {
    const env = options.crash && calls.length === options.crash.atCall ? { INSTALLER_CRASH_AT: options.crash.point } : undefined;
    const result = runCli(args, { home: options.home, ...(env ? { env } : {}) });
    calls.push(result);
    return result;
  };
  const recover = (): CliResult => {
    const resumed = call(["resume"]);
    return resumed.code === 2 && resumed.stderr.includes("No install found") ? call(["start", "--solution", options.solutionRef]) : resumed;
  };
```

with:

```ts
export interface OperatorOptions {
  readonly home: string;
  readonly solutionRef: string;
  readonly script: OperatorScript;
  readonly crash?: CrashPlan;
  /** Extra `start` arguments, such as `--url` (Plan 3). */
  readonly startArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** A fake agent: follows the step protocol exactly as INSTALL.md tells a real agent to. */
export async function operate(options: OperatorOptions): Promise<OperatorRun> {
  const calls: CliResult[] = [];
  let crashed = 0;
  const startArgs = ["start", "--solution", options.solutionRef, ...(options.startArgs ?? [])];
  const call = (args: readonly string[]): CliResult => {
    const crash: Record<string, string> = options.crash && calls.length === options.crash.atCall ? { INSTALLER_CRASH_AT: options.crash.point } : {};
    const result = runCli(args, { home: options.home, env: { ...options.env, ...crash } });
    calls.push(result);
    return result;
  };
  const recover = (): CliResult => {
    const resumed = call(["resume"]);
    return resumed.code === 2 && resumed.stderr.includes("No install found") ? call(startArgs) : resumed;
  };
```

In `tests/operator/scripted-operator.ts`, replace:

```ts
  let current = step(["start", "--solution", options.solutionRef]);
```

with:

```ts
  let current = step(startArgs);
```

- [ ] **Step 5: Write the end-to-end tests**

Replace the whole of `tests/e2e/install-doc.test.ts` with:

```ts
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { usesSkillswiki } from "../../src/core/skillswiki.js";
import { parseSolution } from "../../src/core/solution.js";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { STARTER_REF, operate, starterScript } from "../operator/scripted-operator.js";

const DOC = readFileSync("INSTALL.md", "utf8");
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe", "secret", "disconnect"];

describe("INSTALL.md", () => {
  it("states the five operator rules from spec §6.1", () => {
    for (const rule of ["1. Never invent an answer", "2. Always tell the person why", "3. Never request, repeat or store secrets", "4. At a blocking human step, stop", "5. After every `agent_action`, run the step's verify"]) {
      expect(DOC).toContain(rule);
    }
  });

  it("has the three placeholders the solution server fills in, with the key stored before start (D46)", () => {
    expect(DOC).toContain("{{INSTALL_COMMAND}}");
    expect(DOC).toContain("installer start --solution {{SOLUTION_REF}} --url {{SKILLSWIKI_URL}}");
    expect(DOC.indexOf("installer secret skillswiki")).toBeLessThan(DOC.indexOf("installer start --solution"));
  });

  it("only names commands the CLI has", () => {
    const named = [...DOC.matchAll(/(?:^|`)installer ([\w-]+)/gm)].map((match) => match[1]);
    expect(named.filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it("the shipped starter solution loads, probes with the bundled profiles and connects Skills Wiki", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    expect(starter.steps[0]?.auto).toEqual({ action: "probe_runtime", args: {} });
    expect(starter.steps.map((step) => step.step_id)).toEqual(expect.arrayContaining(["brain.key", "brain.register", "brain.combo", "brain.probe-mcp"]));
    expect(usesSkillswiki(starter)).toBe(true);
  });
});

describe("starter install, operated the way INSTALL.md says", () => {
  const servers: FakeMcp[] = [];

  afterEach(() => {
    servers.splice(0).forEach((fake) => fake.stop());
  });

  /** A fake Skills Wiki, a private keychain folder and a private fake-agent config folder for one install. */
  async function setup(extraEnv: Record<string, string> = {}) {
    const fake = await startFakeMcp();
    servers.push(fake);
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const agentHome = await makeTempHome();
    const env = { ...keychain, FAKE_AGENT_HOME: agentHome, ...extraEnv };
    const script = starterScript(() => setSecret("skillswiki", fake.key, keychain));
    return { fake, env, keychain, script, registration: join(agentHome, "mcp", "skillswiki.json") };
  }

  it("ends READY at level 3 with Skills Wiki registered in the agent; disconnect then removes it all", async () => {
    const { fake, env, keychain, script, registration } = await setup();
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("complete");
    expect(await loadState(home)).toMatchObject({
      mode: "team_host", roles: { decision_maker: "Owner" }, skillswiki: { url: fake.url },
      runtime: { profile: "fake-agent", c6_mcp: true, support_level: 3, notes: [] },
    });
    const report = runCli(["report"], { home, env }).stdout;
    expect(report).toContain("✅ READY  (10 of 10 steps done) · fixture-starter@1.0.0");
    expect(report).toContain("🤖 Agent      fake-agent 9.9.9 — level 3 of 3");
    expect(JSON.parse(await readFile(registration, "utf8"))).toMatchObject({ type: "http", url: fake.url, headersHelper: expect.stringMatching(/mcp-headers skillswiki$/) });

    const gone = runCli(["disconnect", "skillswiki"], { home, env });
    expect(gone.json).toEqual({ status: "disconnected", unregistered: true, secret_deleted: true });
    await expect(access(registration)).rejects.toThrow();
    await expect(getSecret("skillswiki", keychain)).resolves.toBeNull();
    const lastAudit = (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(lastAudit)).toMatchObject({ event: "secret.disconnected", ref: "skillswiki", actor: "human" });
    await expect(verifyAudit(home, (await loadState(home))?.audit_head)).resolves.toMatchObject({ ok: true });
    expect(runCli(["disconnect", "skillswiki"], { home, env }).json).toEqual({ status: "disconnected", unregistered: false, secret_deleted: false });
  });

  it("without workspace trust ends READY WITH LIMITS and names the folder (D52, Review Focus 2)", async () => {
    const { fake, env, script } = await setup({ FAKE_AGENT_DROP: "trust" });
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("complete");
    expect((await loadState(home))?.runtime).toMatchObject({ c6_mcp: false, support_level: 2, notes: [expect.stringContaining("workspace trust may be missing in ")] });
    expect(runCli(["report"], { home, env }).stdout).toContain("⚠️ READY WITH LIMITS  (10 of 10 steps done)");
    expect(runCli(["report"], { home, env }).stdout).toContain("level 2 of 3 (no MCP client; Skills Wiki content is inlined)");
  });

  it("blocks at the key step, naming the secret command, when the person never enters the key", async () => {
    const { fake, env, script } = await setup();
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script: { ...script, giveUp: ["brain.key"] }, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("blocked");
    expect(runCli(["report", "--json"], { home, env }).json).toMatchObject({ overall: "blocked", needs_you: [{ step_id: "brain.key", detail: expect.stringContaining("run 'installer secret skillswiki'") }] });
  });
});
```



In `tests/e2e/cli.test.ts`, add before:

```ts
  it("report prints text by default and JSON with --json", async () => {
```

this:

```ts
  describe("installer disconnect", () => {
    it("deletes the key even when this home has no install, and reports it", async () => {
      const env = await keychainEnv("k-1");
      expect(runCli(["disconnect", "skillswiki"], { home: await makeTempHome(), env }).json).toEqual({ status: "disconnected", unregistered: false, secret_deleted: true });
      await expect(getSecret("skillswiki", { INSTALLER_KEYCHAIN: "file", ...env })).resolves.toBeNull();
    });

    it("only knows skillswiki in this version, exit 2", async () => {
      const result = runCli(["disconnect", "gmail"], { home: await makeTempHome() });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: "Only 'skillswiki' can be disconnected in this version" });
    });
  });
```

- [ ] **Step 6: Run the tests and check the package contents**

Run: `npx vitest run tests/e2e/install-doc.test.ts tests/e2e/cli.test.ts tests/e2e/operator.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (7 + 43 + 5 tests); typecheck exits 0; the whole suite passes: 29 files, 402 tests.

Run: `npm run build && npm pack --dry-run 2>&1 | grep -E "profiles/|solutions/|INSTALL.md"`
Expected: lists `INSTALL.md`, `profiles/claude-code.json` and `solutions/starter.json`.

- [ ] **Step 7: Commit**

```bash
git add src/core/disconnect.ts src/cli.ts INSTALL.md solutions/starter.json tests/fixtures/solution-starter.json tests/operator/scripted-operator.ts tests/e2e/install-doc.test.ts tests/e2e/cli.test.ts
git commit -m "feat(install): run the BRAIN phase end to end and disconnect Skills Wiki"
```

---

### Task 10: Opt-in live tests, decisions D47–D55, spec, roadmap and live test guide

**Files:**
- Create: `tests/live/skillswiki.live.test.ts`, `docs/testing/2026-10-08-plan-3-live-test.md`
- Modify: `vitest.config.ts`, `package.json`, `DECISIONS.md`, `docs/superpowers/plans/README.md`, `docs/superpowers/specs/2026-10-06-installer-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run test:live` (= `INSTALLER_LIVE=1 vitest run`) runs only `tests/live/**` against the real keychain; without `INSTALLER_LIVE=1` those files are excluded. The live file reads `SKILLSWIKI_API_KEY`, `SKILLSWIKI_MCP_URL`, optional `SKILLSWIKI_LIVE_RESOURCE=<pack>/<skill>`, `INSTALLER_LIVE_AGENT=1`, `INSTALLER_LIVE_DIR`, and skips when the key or URL is empty. Nothing reads `~/.config/installer-dev/.env`; the person sources it.

- [ ] **Step 1: Gate the live tests**

Replace the whole of `vitest.config.ts` with:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/** D48: `INSTALLER_LIVE=1` runs only tests/live/ (real Skills Wiki, real keychain, real agent); otherwise they are left out. */
const live = process.env.INSTALLER_LIVE === "1";
// Offline tests never touch the real OS keychain: a throwaway file keychain per run (D51). Live tests use the real one.
const keychain = live ? {} : { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: mkdtempSync(join(tmpdir(), "installer-keychain-")) };

export default defineConfig({
  test: {
    include: live ? ["tests/live/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(live ? [] : ["tests/live/**"])],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    env: {
      // Operator-only folder of extra runtime profiles; solutions name them by id (D34).
      INSTALLER_PROFILE_DIR: resolve("tests/fixtures/profiles"),
      ...keychain,
      // `installer secret` must never open a browser tab during a test run.
      INSTALLER_BROWSER: "none",
      // In-process tests run from src/; the MCP headers helper must still name the built CLI (D52).
      INSTALLER_CLI: resolve("dist/cli.js"),
    },
  },
});
```



In `package.json`, replace:

```json
    "test": "vitest run"
  },
```

with:

```json
    "test": "vitest run",
    "test:live": "INSTALLER_LIVE=1 vitest run"
  },
```

- [ ] **Step 2: Write the live tests**

Create `tests/live/skillswiki.live.test.ts`:

```ts
/**
 * Opt-in live tests (D48): `npm run test:live` with the Skills Wiki variables in the environment, for example
 *   set -a; . ~/.config/installer-dev/.env; set +a; npm run test:live
 * Needs SKILLSWIKI_API_KEY and SKILLSWIKI_MCP_URL; everything is skipped when either is empty.
 * SKILLSWIKI_LIVE_RESOURCE=<pack>/<skill> enables the resource test. INSTALLER_LIVE_AGENT=1 enables the real
 * Claude Code C6 rehearsal (costs tokens, writes a temporary `swtest-installer` server to the user MCP config and
 * a temporary `skillswiki-live` keychain item, both removed afterwards; run it from a folder Claude Code trusts).
 */
import { describe, expect, it } from "vitest";
import { deleteSecret, setSecret } from "../../src/core/keychain.js";
import { KEY_REJECTED_HINT, callTool } from "../../src/core/mcp.js";
import { probeMcp } from "../../src/core/probe.js";
import { loadProfile } from "../../src/core/profile.js";
import { headersHelperCommand, installerCliPath, registerMcp, unregisterMcp } from "../../src/core/register.js";
import { activeComboSlug, stripSkillWrapper } from "../../src/core/skillswiki.js";

const KEY = process.env.SKILLSWIKI_API_KEY ?? "";
const URL = process.env.SKILLSWIKI_MCP_URL ?? "";
const RESOURCE = process.env.SKILLSWIKI_LIVE_RESOURCE ?? "";
const AGENT = process.env.INSTALLER_LIVE_AGENT === "1";
const target = { url: URL, key: KEY };

describe.skipIf(!KEY || !URL)("hosted Skills Wiki MCP (fact 5)", () => {
  it("rejects a wrong key with the secret hint", async () => {
    await expect(callTool({ url: URL, key: "not-the-key" }, "get_active_combo")).rejects.toThrow(KEY_REJECTED_HINT);
  });

  it("answers get_active_combo with the active combo's slug, or null when none is active", async () => {
    const slug = await activeComboSlug(target);
    expect(slug === null || typeof slug === "string").toBe(true);
  });

  it.skipIf(!RESOURCE)("serves a pack's resources through get_skill_resource (fact 6)", async () => {
    const [pack = "", skill = ""] = RESOURCE.split("/");
    const folder = await callTool(target, "get_skill_resource", { pack, skill_name: skill, path: "" });
    expect(folder).toMatchObject({ ok: true, value: { resources: expect.any(Array) } });
    const first = (folder.ok ? (folder.value as { resources: { path: string }[] }).resources[0]?.path : undefined) ?? "";
    const file = await callTool(target, "get_skill_resource", { pack, skill_name: skill, path: first });
    expect(file).toMatchObject({ ok: true, value: { path: first, content: expect.any(String) } });
    const content = file.ok ? (file.value as { content: string }).content : "";
    expect(stripSkillWrapper(content)).not.toMatch(/^\s*<skill_[a-z]+>/);
  });
});

describe.skipIf(!KEY || !URL || !AGENT)("real Claude Code C6 rehearsal (fact 4)", () => {
  const SERVER = "swtest-installer";
  const SECRET = "skillswiki-live";

  it("registers a headers-helper server, has claude -p call get_active_combo, then cleans up", async () => {
    const profile = await loadProfile("claude-code");
    const cwd = process.env.INSTALLER_LIVE_DIR ?? process.cwd();
    await setSecret(SECRET, KEY);
    try {
      await registerMcp(profile, SERVER, URL, headersHelperCommand(SECRET, process.execPath, installerCliPath()), cwd);
      const expectedSlug = await activeComboSlug(target);
      if (!expectedSlug) throw new Error("Activate a combo in the Skills Wiki dashboard before this test");
      await expect(probeMcp({ profile, cwd, serverName: SERVER, expectedSlug })).resolves.toEqual({ ok: true });
    } finally {
      await unregisterMcp(profile, SERVER, cwd);
      await deleteSecret(SECRET);
    }
  }, 300_000);
});
```

Run: `npm run typecheck && npx vitest run && env -u SKILLSWIKI_API_KEY -u SKILLSWIKI_MCP_URL INSTALLER_LIVE=1 npx vitest run`
Expected: typecheck exits 0; the offline suite still passes with 29 files and 402 tests (no live file); the gated run reports `Test Files 1 skipped (1)`, `Tests 4 skipped (4)` and makes no network call. Do **not** run `npm run test:live` with real credentials as part of this plan; that is the live guide's Test 8.

- [ ] **Step 3: Record D47–D55**

In `DECISIONS.md`, replace:

```markdown
- Status: Design D1–D46. Implementation plans: `docs/superpowers/plans/` (roadmap + Plans 1–2). Plan 1 (engine core) implemented on branch `feat/engine-core`.
```

with:

```markdown
- Status: Design D1–D55. Implementation plans: `docs/superpowers/plans/` (roadmap + Plans 1–3). Plan 1 (engine core) implemented on branch `feat/engine-core`, Plan 2 on `feat/runtime-conformance`.
```

In `DECISIONS.md`, add after:

```markdown
| D46 | **Plan 2 needs no secret; BRAIN moves to Plan 3.**
```

these rows:

```markdown
| D47 | **Non-blocking secret entry (resolves most of O3).** `installer secret <id>` starts a detached page process bound to 127.0.0.1 on a random port with a 32-byte token in the path, opens the browser (`open` / `xdg-open`; `INSTALLER_BROWSER=none` opens nothing), prints `{"status":"waiting","url":…,"pid":…}` and exits. The page is POST-only with Host and Origin checks, accepts one value, answers "Done, you can close this tab" and exits; unused, it exits after 10 minutes. The page process writes only the keychain, never the state or the audit. A `human_action` step with `input.kind: secret` names its id in `input.provider` and completes through `installer verify <step_id>` with the check `secret_present`. Headless host: same page plus an `ssh -L` hint; remote entry stays open. | 2026-10-08 |
| D48 | **Local tests only, no paid CI (resolves O7).** `npm test` runs offline against fakes (fake agent, fake Skills Wiki MCP server on `node:http` that mimics the live answers). Live tests live in `tests/live/`, run only with `INSTALLER_LIVE=1` (`npm run test:live`), read `SKILLSWIKI_API_KEY` and `SKILLSWIKI_MCP_URL` from the environment (the person sources their own env file) and skip when either is empty. LLM-backed checks use the person's own `claude -p` subscription. | 2026-10-08 |
| D49 | **The name stays `installer` (resolves O8).** | 2026-10-08 |
| D50 | **Team scale is designed for, not delivered (O10 deferred).** v1 limit: the helper and the keychain run as the agent's OS user; one key per OS user. | 2026-10-08 |
| D51 | **Keychain module.** Backends: macOS `security` (value passed on stdin to `security -i`, never in argv; `find-generic-password -w` to read; exit 44 = missing), Linux `secret-tool` (stdin), and a file backend (`INSTALLER_KEYCHAIN=file`, `INSTALLER_KEYCHAIN_DIR=<private folder>`, files 0600) used by the tests and as the fallback where no keychain exists; Windows deferred. Service `installer`, account `<secret id>`, per OS user. The state only ever holds references (the secret id, the non-secret Skills Wiki URL), never a value. | 2026-10-08 |
| D52 | **The engine registers the Skills Wiki MCP** as `claude mcp add-json -s user skillswiki '{"type":"http","url":<url>,"headersHelper":"<node> <installer cli> mcp-headers skillswiki"}'` (paths single-quoted for the agent's shell). `installer mcp-headers <id>` prints exactly `{"Authorization":"Bearer <key>"}` from the keychain, or exits 1 with no output. Idempotent as remove-then-add (verified: `add-json` refuses an existing name, `remove` of a missing name exits 1), so no `mcp get`, which would health-check the server and run the helper. Profiles gain `mcp_register.cmd` and `mcp_remove.cmd` (placeholders `name`, `config_json`, `profile_dir`), `headless.tools_off` (split out of `headless.cmd`) and `headless.allow_tool` (`{tool}`) so the C6 call can allow exactly one tool. Trust caveat: Claude Code runs `headersHelper` only in folders with persisted workspace trust; the report names the folder when C6 fails. | 2026-10-08 |
| D53 | **Auto-action failure path mirrors checks.** An `ActionFailure` (network, keychain, child process) thrown by an action or a check is recorded as `failed` with its message as the hint, attempts + 1; the third failure blocks the step (`reason: "action failed 3 times"`). `installer resume` retries engine-owned steps (`auto` and `verify`); `write_file` turns file-system errors into failures the same way. Authoring errors (InputError, SolutionError, ProfileError) still throw. | 2026-10-08 |
| D54 | **C6 probe = `probe_mcp` after the combo step.** A headless call in the agent's working folder (`process.cwd()` at `start`, recorded as `work_dir`), without the tools-off flags, allowing exactly `mcp__skillswiki__get_active_combo`, with a prompt that names that tool (verified necessary: the person's Claude Code has another `skills-wiki` server and otherwise picks it). Pass = the agent reports the same `combo_slug` the engine's own `get_active_combo` returned. `CapabilityMap.c6_mcp: boolean \| "not_probed"`; support level counts C6; a failed C6 is a report limit ("no MCP client; Skills Wiki content is inlined") whose note says trust may be missing in `<dir>`. | 2026-10-08 |
| D55 | **Hand-rolled MCP client (Streamable HTTP).** `initialize` (protocol `2025-06-18`) → `notifications/initialized` → `tools/call`, echoing `mcp-session-id`; answers parsed from `application/json` or `text/event-stream` (`data:` lines, the message with the matching id); `structuredContent` preferred, JSON in `content[0].text` as fallback; 30 s timeout, 1 MB cap; 401 → "Skills Wiki key rejected: run `installer secret skillswiki`". `skillswiki:<pack>/<skill>/<path>` refs resolve through `get_skill_resource` with one outer `<skill_*>` element stripped; the key must exist before `start` (`INSTALL.md`: install → `installer secret skillswiki` → `installer start --solution … --url <MCP URL>` → loop). The per-client MCP URL is non-secret config passed as `start --url` and stored in the state. Combo step = `human_action` + check `combo_active` (D37); `installer disconnect skillswiki` unregisters, deletes the keychain item and writes an audit line. No live `get_active_combo` with no active combo was observed: error, `isError` and `combo: null` all count as "not activated". | 2026-10-08 |
```

- [ ] **Step 4: Update the roadmap**

In `docs/superpowers/plans/README.md`, replace:

```markdown
| 3 | **Secrets + BRAIN phase** | Local browser page for `secret`/`oauth`, OS keychain storage, Skills Wiki key, engine-run MCP registration (O6 syntax verified), C6 probe, `skillswiki:` refs, combo `human_action` verified via `get_active_combo`, `installer disconnect` for the Skills Wiki key (D46) | 1, 2 | §6.2 BRAIN, §7.3 C6, §8.3, §13, §14.2 | O3 (headless OAuth redirect), O10, O15 | Not started |
```

with:

```markdown
| 3 | **Secrets + BRAIN phase** | Non-blocking local browser page for `secret` (D47), keychain module with macOS / Linux / file backends (D51), `installer secret`, `mcp-headers` and `disconnect`, engine-run MCP registration with a headers helper (D52), hand-rolled MCP client and `skillswiki:` refs (D55), combo `human_action` verified via `get_active_combo` (D37), C6 probe in the agent's folder (D54), auto-action failure path (D53), starter solution with BRAIN steps, opt-in live tests (D48) | 1, 2 | §6.1–6.3, §7.2–7.3 C6, §8.3, §13, §14.2 | O3 (mostly), O6, O7, O8, O10 (deferred) | [Planned](2026-10-08-03-secrets-brain.md) |
```

In `docs/superpowers/plans/README.md`, replace:

```markdown
O8 (product name), O11 (unattended hosted evals) and O15 (combo activation
by API key) are handled when the plan that touches them is written.
```

with:

```markdown
O11 (unattended hosted evals) and O15 (combo activation by API key) are
handled when the plan that touches them is written. `oauth` input steps
(the OAuth redirect half of O3) arrive with the connectors in Plan 5.
```

- [ ] **Step 5: Update the spec**

In `docs/superpowers/specs/2026-10-06-installer-design.md`:

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
solutions and tests. A `skillswiki:` ref needs the Skills Wiki key before
`start`, so `INSTALL.md` runs `installer secret skillswiki` first (Plan 3,
D46). The `INSTALL.md` served at the solution URL
embeds this reference.
```

with:

```markdown
solutions and tests. A `skillswiki:` ref needs the Skills Wiki key before
`start`, so `INSTALL.md` runs `installer secret skillswiki` first, and the
per-client MCP URL from the dashboard (not a secret) is passed as
`installer start --solution <ref> --url <MCP URL>` and kept in the state
(D46, D55). `start` refuses with exit 2 and creates nothing when the key or
the URL is missing. The `INSTALL.md` served at the solution URL embeds the
reference and the URL (`{{SOLUTION_REF}}`, `{{SKILLSWIKI_URL}}`).
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
`input.kind`: `text | choice | multi_choice | confirm | number | time |
cron | secret | oauth | file`. `secret` and `oauth` are never collected
through the agent (§8.3).
```

with:

```markdown
`input.kind`: `text | choice | multi_choice | confirm | number | time |
cron | secret | oauth | file`. `secret` and `oauth` are never collected
through the agent (§8.3). A `human_action` with `input.kind: secret`
names the secret in `input.provider`, is entered through
`installer secret <provider>` and completes through
`installer verify <step_id>` with the check `secret_present` (D47).

An `auto` step whose action fails for a reason the person can fix
(network, keychain, a child process) is recorded as `failed` with the
hint and retried with `installer resume`; the third failure blocks it
(D53).
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| `installer secret <connector>` | Open the local browser page for credential entry (§8.3) |
```

with:

```markdown
| `installer secret <id>` | Start the local browser page for credential entry and return at once (§8.3, D47) |
| `installer mcp-headers <id>` | Run by the agent's MCP client: prints the Authorization header from the keychain (§7.2, D52) |
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
tools, so it is not used). Plan 3 adds `mcp_register.cmd`, an argv
template the **engine** runs with the key from the keychain, so the key
never enters the agent's context (D46). Its syntax is verified (O6):
`claude mcp add [-s scope] --transport http <name> <url> --header "Authorization: Bearer <key>"`.
```

with:

````markdown
tools, so it is not used). Plan 3 (D52) splits the tools-off flags into
`headless.tools_off`, adds `headless.allow_tool` (`["--allowedTools",
"{tool}"]`) for the C6 probe, and the templates the **engine** runs to
manage the agent's MCP servers, so the key never enters the agent's
context (D46):

```json
"headless": { "cmd": ["claude", "-p", "{prompt}", "--output-format", "json"], "tools_off": ["--tools", "", "--strict-mcp-config"], "allow_tool": ["--allowedTools", "{tool}"], "…": "…" },
"mcp_register": { "cmd": ["claude", "mcp", "add-json", "-s", "user", "{name}", "{config_json}"] },
"mcp_remove": { "cmd": ["claude", "mcp", "remove", "-s", "user", "{name}"] }
```

`{config_json}` is `{"type":"http","url":<url>,"headersHelper":"'<node>' '<installer cli>' mcp-headers skillswiki"}`;
`installer mcp-headers <id>` prints `{"Authorization":"Bearer <key>"}` from
the keychain for every request (verified live, O6 resolved). Claude Code
runs the helper only in folders with persisted workspace trust.
````

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| C6 MCP (Plan 3) | Engine registers Skills Wiki MCP, then the agent calls a ping tool | Ping succeeds |
```

with:

```markdown
| C6 MCP (`probe_mcp`, BRAIN) | Engine registers Skills Wiki MCP; a headless call in the agent's own folder (`work_dir`) allows exactly `mcp__skillswiki__get_active_combo` and names it in the prompt (D54) | The agent reports the same `combo_slug` the engine's own call returned |
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
- `input.kind: secret | oauth` steps are handled by the CLI, never by the
  agent: the CLI serves a **local browser page on localhost** (one-time
  path token, closes after use).
- OAuth uses the provider's redirect to that local page.
- **Headless host fallback:** the CLI prints a one-time link to open from a
  phone or laptop (redirect mechanics are an open item, §19).
- Storage: OS keychain (macOS Keychain, Windows Credential Manager, Linux
  Secret Service). Never written to config, state, logs, run folders or
  bundles.
- The agent only learns `{"status":"done"}`.
```

with:

```markdown
- `input.kind: secret | oauth` steps are handled by the CLI, never by the
  agent: `installer secret <id>` starts a **detached page process on
  127.0.0.1** (random port, 32-byte path token, Host and Origin checks,
  POST only, one accepted value, exits after it or after 10 minutes),
  opens the browser and returns at once with
  `{"status":"waiting","url":…,"pid":…}` (D47). The page process writes
  only the keychain.
- OAuth uses the provider's redirect to that local page (Plan 5).
- **Headless host fallback:** the output carries a `hint` with the
  `ssh -L <port>:127.0.0.1:<port>` tunnel to open the same page from a
  laptop; entry from another machine without a tunnel stays open (§19).
- Storage: OS keychain through `security` (macOS, value on stdin) or
  `secret-tool` (Linux), service `installer`, account `<id>`; a file
  backend (`INSTALLER_KEYCHAIN=file`) for tests and platforms without a
  keychain; Windows Credential Manager later (D51). Never written to
  config, state, logs, run folders or bundles; the state holds only ids
  and the non-secret Skills Wiki URL.
- The agent only learns `{"status":"waiting"}` and, after
  `installer verify <step_id>` with `secret_present`, `{"status":"passed"}`.
- `installer disconnect skillswiki` removes the MCP server from the agent,
  deletes the keychain item and writes an audit line.
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| O3 | OAuth redirect to a headless team host (loopback vs tunnel vs one-time link) | §8.3 fallback |
```

with:

```markdown
| O3 | Secret entry on a headless team host: resolved for `secret` by the `ssh -L` hint (D47); the OAuth redirect half stays open until Plan 5 | §8.3 fallback |
```

In `docs/superpowers/specs/2026-10-06-installer-design.md`, replace:

```markdown
| O6 | Claude Code `mcp add` exact syntax for remote HTTP MCP with auth header | Claude Code profile |
| O7 | CI monthly budget cap amount | §15.2 |
| O8 | Final CLI / product name | Packaging |
| O10 | Whether Skills Wiki `enterprise` routes support team seats | Hybrid/personal seats |
```

with:

```markdown
| O6 | ~~Claude Code `mcp add` exact syntax for remote HTTP MCP with auth header~~ Resolved: `claude mcp add-json -s user <name> '{"type":"http","url":…,"headersHelper":…}'` (D52) | — |
| O7 | ~~CI monthly budget cap amount~~ Resolved: no paid CI; local offline tests plus opt-in live tests (D48) | — |
| O8 | ~~Final CLI / product name~~ Resolved: `installer` (D49) | — |
| O10 | Whether Skills Wiki `enterprise` routes support team seats; v1 runs helper and keychain as the agent's OS user (D50) | Hybrid/personal seats |
```

- [ ] **Step 6: Write the live test guide**

The guide's **Expected** lines are predictions from this plan, not recorded output (unlike the Plan 1 and Plan 2 guides); the guide says so, and whoever runs it first replaces them with what they saw. Running the guide is not part of this plan.

Create `docs/testing/2026-10-08-plan-3-live-test.md`:

````markdown
# Plan 3 live test guide (secrets + BRAIN phase)

Use this guide to install the `installer` CLI on your own machine and check Plan 3 by hand, against your real
Claude Code, your real macOS keychain and the hosted Skills Wiki. Each test gives the commands to run, what you
should see, and a place to record what you actually saw. If a result differs, collect the items in
**Diagnostics to capture** at the end of the [Plan 1 guide](2026-10-07-plan-1-live-test.md#diagnostics-to-capture).

The **Expected** lines below are what the plan predicts; unlike the Plan 1 and Plan 2 guides they were not yet
produced by running the commands. The first person to run this guide replaces them with the actual output.

## What this build can and cannot do

Plan 3 adds: `installer secret skillswiki` (a local page that stores the key in your keychain), the engine-run
registration of the Skills Wiki MCP server in Claude Code with a headers helper (the key never enters the agent's
context), the combo step checked through `get_active_combo`, the C6 probe (`level 3 of 3`), `skillswiki:`
solution references, `installer disconnect skillswiki`, and opt-in live tests (`npm run test:live`).
It cannot yet enter OAuth sign-ins, connect data or channels: that is Plan 5 and later.

The C6 probe makes one headless Claude Code call with one MCP tool allowed, so it uses a little of your plan or credit.
Registration writes the server `skillswiki` to your **user** Claude Code config; Test 7 removes it.

## Results summary

| Test | What it checks | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Setup and install | | |
| 1 | The secret page stores the key in the keychain | | |
| 2 | `mcp-headers` prints the header; nothing else sees the key | | |
| 3 | Starter install through the BRAIN phase to level 3 of 3 | | |
| 4 | Workspace trust missing: level 2 of 3 with the folder named | | |
| 5 | A `skillswiki:` reference | | |
| 6 | A wrong key is named, nothing is created | | |
| 7 | `disconnect` removes the server and the key | | |
| 8 | Opt-in live tests | | |
| 9 | Clean up | | |

---

## Test 0: Setup and install

```bash
export T=~/installer-plan3-test
export REPO=/Users/allenliu/Desktop/ML-Project/installer
export PREFIX=$T/npm
mkdir -p $T $PREFIX

node --version            # must be v22 or later
cd $REPO && git log --oneline -1

npm install && npm run build && npm pack --pack-destination $T
npm install -g --prefix $PREFIX $T/installer-0.1.0.tgz
export PATH=$PREFIX/bin:$PATH
which installer
set -a; . ~/.config/installer-dev/.env; set +a      # exports SKILLSWIKI_API_KEY and SKILLSWIKI_MCP_URL for Tests 5 and 8
cd $T
```

**Expected:** `which installer` prints `<your home>/installer-plan3-test/npm/bin/installer`.

**Record:**
- Commit shown by `git log`:
- `which installer` printed:
- Pass / Fail:

---

## Test 1: The secret page stores the key in the keychain

```bash
installer secret skillswiki
echo $?
```

**Expected:** one line such as `{"status":"waiting","url":"http://127.0.0.1:54321/s/<64 hex>","pid":12345}`, exit `0`,
and the page opens in your browser at once (the command does not wait). Paste your Skills Wiki API key, press **Save**.

- The page says **Done, you can close this tab.** Reloading it fails (the page process has exited; `ps -p <pid>` prints nothing).
- `security find-generic-password -s installer -a skillswiki -w` prints the key; `ps -o args= -p <pid>` never showed it (the value went in on stdin).
- A second `installer secret skillswiki` opens a new page; saving there replaces the key (`-U`).
- Opening the url with a different token, or sending a POST from another origin, is refused (404 / 403); nothing changes.

**Record:**
- Output line:
- Keychain shows the key:
- Pass / Fail:

---

## Test 2: `mcp-headers` prints the header; nothing else sees the key

```bash
installer mcp-headers skillswiki; echo " exit=$?"
installer mcp-headers nothing-stored; echo " exit=$?"
```

**Expected:**

```
{"Authorization":"Bearer <your key>"}
 exit=0
 exit=1
```

The second line prints nothing at all on stdout or stderr before `exit=1`.

**Record:**
- Pass / Fail:

---

## Test 3: Starter install through the BRAIN phase to level 3 of 3

Run this from a folder Claude Code trusts (one you have opened Claude Code in and accepted), because the C6 probe
runs in the folder where `start` is run:

```bash
cd $REPO
installer --home $T/h1 start --solution file:$REPO/solutions/starter.json --url "$SKILLSWIKI_MCP_URL"
installer --home $T/h1 submit mode.shared-work --value '"yes"'
installer --home $T/h1 submit mode.always-on --value '"no"'
installer --home $T/h1 submit mode.decision-maker --value '"Owner"'
installer --home $T/h1 verify brain.key
claude mcp get skillswiki
installer --home $T/h1 next
```

**Expected:**
- `start` probes the agent first (10–30 seconds), then shows `mode.shared-work`; the submits lead to `brain.key`
  (a `human_action` with `"input":{"kind":"secret","provider":"skillswiki"}`).
- `verify brain.key` prints `{"status":"passed","next":{"status":"step","view":{"step":{"step_id":"brain.combo",…`:
  the registration step `brain.register` ran in between.
- `claude mcp get skillswiki` shows `Scope: User config (available in all your projects)`, `Type: http`, your URL,
  and connects (the helper supplied the header).
- `next` shows `brain.combo`. Activate the combo in your Skills Wiki dashboard, then:

```bash
installer --home $T/h1 verify brain.combo
installer --home $T/h1 report
node -e 'const s=require(process.argv[1]);console.log(JSON.stringify(s.runtime),s.work_dir)' $T/h1/state/install-state.json
```

- `verify brain.combo` prints `{"status":"passed","next":{"status":"complete"}}` (the C6 probe ran after it; allow 10–60 seconds).
- The report starts with `✅ READY  (10 of 10 steps done) · starter@1.0.0` and has the line
  `🤖 Agent      claude-code 2.1.294 — level 3 of 3` (your version may be newer).
- The last command prints `"c6_mcp":true,"support_level":3` inside the runtime, and your repo folder as `work_dir`.
- Running `verify brain.combo` **before** activating a combo prints
  `{"status":"failed","hint":"No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again","retry":true,…}`.

**Record:**
- `claude mcp get skillswiki` output:
- Report:
- Runtime line:
- Pass / Fail:

---

## Test 4: Workspace trust missing: level 2 of 3 with the folder named

```bash
mkdir -p $T/untrusted && cd $T/untrusted
installer --home $T/h2 start --solution file:$REPO/solutions/starter.json --url "$SKILLSWIKI_MCP_URL"
installer --home $T/h2 submit mode.shared-work --value '"no"'
installer --home $T/h2 submit mode.always-on --value '"no"'
installer --home $T/h2 submit mode.decision-maker --value '"Owner"'
installer --home $T/h2 verify brain.key
installer --home $T/h2 verify brain.combo
installer --home $T/h2 report
cd $T
```

**Expected:** the install still completes. The report says `⚠️ READY WITH LIMITS  (10 of 10 steps done)` and
`🤖 Agent      claude-code 2.1.294 — level 2 of 3 (no MCP client; Skills Wiki content is inlined)`;
`runtime.notes` in `$T/h2/state/install-state.json` contains
`workspace trust may be missing in <your home>/installer-plan3-test/untrusted (open the agent there once and accept the folder)`.
(If Claude Code treats the new folder as trusted on your machine, record that instead; the note then does not appear.)

**Record:**
- Report:
- Note:
- Pass / Fail:

---

## Test 5: A `skillswiki:` reference

Needs a recipe published as a skill file resource. Set `REF` to one you have (for example
`skillswiki:<pack>/<skill>/recipe.json`); if you have none, record "no published recipe" and skip.

```bash
export REF=skillswiki:<pack>/<skill>/recipe.json
installer --home $T/h3 start --solution $REF --url "$SKILLSWIKI_MCP_URL"
head -c 300 $T/h3/solution/solution.json
installer --home $T/h3 start --solution $REF
```

**Expected:** the first `start` fetches the recipe through `get_skill_resource` and prints its first step; the pinned
file is the recipe's JSON without any `<skill_reference>` wrapper; the second `start` (no `--url`) prints the same step
and changes nothing. `installer --home $T/h4 start --solution skillswiki:none/none/none.json --url "$SKILLSWIKI_MCP_URL"`
exits `2` with `Skills Wiki could not serve 'skillswiki:none/none/none.json': …` and creates no `$T/h4`.

**Record:**
- Ref used:
- Pass / Fail:

---

## Test 6: A wrong key is named, nothing is created

```bash
installer secret skillswiki        # enter the word wrong-key on the page
installer --home $T/h5 start --solution file:$REPO/solutions/starter.json --url "$SKILLSWIKI_MCP_URL"
installer --home $T/h5 submit mode.shared-work --value '"no"'
installer --home $T/h5 submit mode.always-on --value '"no"'
installer --home $T/h5 submit mode.decision-maker --value '"Owner"'
installer --home $T/h5 verify brain.key
installer --home $T/h5 verify brain.combo
```

**Expected:** `verify brain.combo` prints
`{"status":"failed","hint":"Skills Wiki key rejected: run `installer secret skillswiki`","retry":true,…}`.
Enter the real key again through `installer secret skillswiki`, then `installer --home $T/h5 verify brain.combo` passes.

**Record:**
- Pass / Fail:

---

## Test 7: `disconnect` removes the server and the key

```bash
installer --home $T/h1 disconnect skillswiki
claude mcp get skillswiki; echo " exit=$?"
security find-generic-password -s installer -a skillswiki -w; echo " exit=$?"
tail -1 $T/h1/audit/audit.jsonl
installer --home $T/h1 disconnect skillswiki
```

**Expected:**

```
{"status":"disconnected","unregistered":true,"secret_deleted":true}
No MCP server named "skillswiki". …
 exit=1
 exit=44
{"seq":…,"event":"secret.disconnected","ref":"skillswiki",…}
{"status":"disconnected","unregistered":false,"secret_deleted":false}
```

**Record:**
- Pass / Fail:

---

## Test 8: Opt-in live tests

```bash
cd $REPO
npm run test:live                                   # hosted Skills Wiki only; 4 tests, 1 or 2 skipped
INSTALLER_LIVE_AGENT=1 npm run test:live            # adds the real Claude Code C6 rehearsal (costs tokens)
npm test                                            # the offline suite never runs tests/live/
```

**Expected:** the first run passes the two hosted Skills Wiki tests (and the resource test when
`SKILLSWIKI_LIVE_RESOURCE=<pack>/<skill>` is exported) and skips the rest; the second also passes
`registers a headers-helper server, has claude -p call get_active_combo, then cleans up` and leaves no
`swtest-installer` server (`claude mcp get swtest-installer` exits 1) and no `skillswiki-live` keychain item.
`npm test` reports `Test Files  29 passed (29)` with no live file.

**Record:**
- Pass / Fail:

---

## Test 9: Clean up

```bash
installer disconnect skillswiki || true
cd ~
rm -rf ~/installer-plan3-test
claude mcp get skillswiki; echo " exit=$?"
```

**Expected:** `exit=1`; nothing was installed outside `~/installer-plan3-test`, and no key remains in the keychain.
````



- [ ] **Step 7: Run everything once more and commit**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck exits 0; 29 files, 402 tests pass.

```bash
git add vitest.config.ts package.json tests/live/skillswiki.live.test.ts DECISIONS.md docs/superpowers/plans/README.md docs/superpowers/specs/2026-10-06-installer-design.md docs/testing/2026-10-08-plan-3-live-test.md
git commit -m "docs: record D47–D55, add opt-in live tests and the Plan 3 live guide"
```

---

## Self-Review Record

**Spec coverage (Plan 3 scope):**

| Spec item | Task |
|---|---|
| §6.1 `skillswiki:` refs via `get_skill_resource`, key before `start`, `INSTALL.md` order and placeholders | 4, 5, 9 |
| §6.2 BRAIN: key → register MCP → combo activation (`human_action`) → verify via `get_active_combo` | 2, 6, 7, 9 |
| §6.3 `secret` never through the agent; completion of a secret step; failed auto steps | 1, 2, 3 |
| §6.6 `installer secret`, `installer disconnect`, (`mcp-headers`) | 3, 6, 9 |
| §7.2 profile templates run by the engine (D46/D52) | 6 |
| §7.3 C6 probe, support level 0–3, capability map in state and report | 8 |
| §8.3 local page on localhost, one-time token, headless hint, keychain storage, agent learns only status | 2, 3 |
| §13.1 per-client MCP URL + API key; `get_active_combo`; `get_skill_resource` as recipe source | 4, 5 |
| §14.2 secrets: keychain only, never in chat/logs/state; `disconnect` revokes + deletes | 2, 3, 9 |
| D37 combo activation is a dashboard `human_action` | 7, 9 |
| D48 local tests, opt-in live tests | 4, 10 |

Out of scope (later plans): `oauth` steps and the OAuth redirect (Plan 5), `installer tool` CLI fallback and the local MCP server (Plan 4), Skills inlining at run time (Plan 7), pack version pinning (Plan 9), Windows keychain, remote (non-tunnel) secret entry on a headless host.

**Placeholder scan:** no TBD/TODO; every code step carries the full code or an exact replace/add pair; the live guide is explicit about which lines are predictions.

**Review Focus coverage:** RF1 → Task 3 (`refuses a POST with %s and stores nothing`, `stores one submitted value, says done, then stops serving`); RF2 → Task 8 (`names the folder whose trust may be missing…`), Task 9 (`without workspace trust ends READY WITH LIMITS and names the folder`); RF3 → Task 4 (`turns a 401 into the secret hint`), Task 5 (`names a rejected key and creates nothing`), Task 7 (`turns a rejected key into a failed check with the secret hint`); RF4 → Task 5 (`refuses to start without the key…`, `refuses to start with %s once the key exists…`); RF5 → Task 4 (`turns %s into a failure with a reason`, `names a timeout`, `names the url when the server is unreachable`), Task 7 (`names the url when Skills Wiki is unreachable, and the step can be retried`).

**Type consistency:** `ActionFailure` (Task 1), `ProcessResult` / `runProcess(argv, cwd, timeoutMs, input?)` (Task 2), `McpTarget` / `ToolOutcome` / `callTool` (Task 4), `skillswikiTarget(url, env?)` (Task 4, called with `state?.skillswiki?.url` from Tasks 6–8), `StartExtras` (Task 5), `RuntimeProfile.headless.tools_off / allow_tool / mcp_register / mcp_remove` (Task 6), `HeadlessRequest.allowTool` (Task 6, used by Task 8), `ProbeCheck` / `probeMcp` / `withMcpProbe` (Task 8), `OperatorOptions.startArgs / env` and `starterScript` (Task 9) are each defined once and used with the same names later. The `register.test.ts` created in Task 6 is already the final version (its CLI-path test depends on `INSTALLER_CLI`, set in the same task).

**Verification:** every task of this plan was applied in order to a scratch copy of the repository on 2026-10-08; `npm run typecheck` and `npx vitest run` were green after each task with exactly the counts stated above (final: 29 test files, 402 tests, plus 4 gated live tests that skip without credentials). The live tests themselves were not run.
