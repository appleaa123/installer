# Weekly re-check of T5 and T7 (D170) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, in plain words:** agents and models change. A "yes, TaskFollow can run your agent unattended" from three weeks ago can quietly become a "no" after an update, a lost sign-in or a changed setting. Today a result only *goes stale* (30 days, a new version, a run that went wrong) and the doctor *reports* it; nobody re-tests (spec 8). The owner added a weekly unattended re-check to v1 (D170, 2026-10-16): once a week TaskFollow re-runs the test that proves its runner and its tools on the person's agent, keeps a "yes" fresh when it still holds, and tells the person when it no longer does.

**Architecture:** one small module, `src/core/recheck.ts`. The tick starts it at most once a week, in a **separate process** (the gateway's spawn pattern), so a check that takes minutes never holds the tick and never makes a scheduled run late. The process runs the existing preflight T7 (`runnerCheck` without a workflow) and records its result through the existing `recordResult`. A pass refreshes freshness; a fail is a *not-checked after a pass*, which the existing stop rule (`runnerStopReason`) already acts on, plus one notice to the decision maker; an error or timeout records nothing and is tried again the next day.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Measured against:** §9 (9.3 gap flagging, 9.15 "safer and honest feedback … from models drifting") and D170 (c): "The weekly unattended re-check of T5 and preflight T7 (D162 follow-up) is added to v1, after item 8, with its own plan and review." Spec 8 (freshness), D159 (T7), D162 (stop rule, doctor reports only), D155/D164 (telling a person with no channel). Nothing else is added: no other checks, no suggestions.

## What T5 and T7 are here (and why one test covers both)

- **T5** (spec 5.2, "tools (chat)") is the agent *in chat* calling `check.ping` through TaskFollow's MCP server. It needs a person's chat; it cannot run unattended.
- **Preflight T7** (spec 9, `runnerCheck` with no workflow, `check-runner.ts:44`) runs one real task step through TaskFollow's runner, under the hook, allowed only `mcp__installer__check_ping`, and passes only when the ping arrived **through MCP** and under the hook. It proves `runner` *and* `tools` (spec 9: "proving `runner` and `tools` only").
- So the unattended re-check of "T5 and T7" is **preflight T7**: it re-proves both needs the stop rule reads (`runnerStopReason` checks `runner` and `tools`, `check-fresh.ts:46`). The plan says this plainly in D174 and the doctor's words; it does not invent an unattended T5.
- **The mechanism, stated in D174:** `problem()` and `scoped()` (`check-fresh.ts`) select results by need and agent (and workflow), **never by test**. So a T7 pass, recorded with `test: "t7"` when the ping settles the challenge, makes current a `tools` result that T5 recorded (`test: "t5"`) weeks earlier: the newest `tools` entry is now T7's.

## What exists

- `runnerCheck(home, state, { now, env })` (`check-runner.ts:44-87`): needs a profile with `task` (else records *not checked*, "TaskFollow cannot run this agent unattended here"); starts a challenge with a word; `runTask` with `RUN_MS` = 5 minutes; records `yes-tested` for `runner` and `tools` (agent-wide: no `workflow`) on a pass, `not-checked` with a reason otherwise. It ignores `runTask`'s own result: a task that never started (timeout, the agent missing, a crash) looks the same as a task that ran and made no call.
- Freshness and the stop rule (`check-fresh.ts`): `problem()` treats a newest *not-checked* after any earlier pass as "a run went wrong", so a workflow with declared needs stops (`runnerStopReason`, runner.ts:209), with a stop notice at most once a day (`firstStopNoticeToday`). `checksDoctor` reports stale or failed agent-wide `runner`/`tools` as `warn`, with `taskfollow check start t7`.
- `scoped()` (`check-fresh.ts:39-43`): a workflow's own results win over the agent-wide ones. An agent-wide refresh therefore keeps fresh every workflow that has **no** results of its own; a workflow with its own per-workflow T7 is refreshed by its own real runs (`noteRunPassed`).
- The tick (`tick.ts:218-269`): returns early when paused (`isPaused`, :229); runs `guard`ed passes; the daily doctor keeps a `next` marker and runs with a 20 s budget per check "so the tick (and its lock) is never held for long" (`doctor.ts:23-24`, :127-141). Scheduled runs have a default tolerance of 5 minutes (`workflow.ts:23`), so a tick held 5 minutes can turn a due slot into *missed*.
- The gateway is started by the tick as a detached process (`gateway-process.ts:57`, `spawn(process.execPath, [installerCliPath(), "--home", home, "gateway-serve"], { detached: true … })`).
- Consultation: `state.steps["mode.purpose"].value === "consult"` (`report.ts:129`, `services.ts:46`).
- Telling the person: `channel.notify` to the decision maker (`doctor.ts:110-125`, `tellFailures`); when no channel reaches a person, `why`'s list form shows waiting items once (D164: `suggestionsField`, `why.ts:178`, `no_channel` `why.ts:169`).

## Design

### When it runs

The tick's new `recheck` pass (after the `checks` sweep, before the doctor) calls `recheckDue(home, now)` and, when due, `startRecheck(home)`. It is due only when **all** hold:

1. not paused (the tick already returns early), and the install is not a consultation;
2. the recorded agent's profile has a `task` command (today Claude Code; others have nothing to re-check);
3. an agent-wide `runner` **or** `tools` result for this agent passed at some time (nothing to re-check for a person who never passed T7; their setup does it);
4. `config/recheck.json` `next` is unset (then it is only set, to the later of now and the newest agent-wide `runner`/`tools` pass + 7 days: a fresh install was just checked at setup, an older one is due a week after its last pass) or `now >= next`;
5. no re-check process is alive (`runtime/recheck.lock`, the tick lock's `createExclusive` + `isAlive` pattern).

Sandbox mode does not stop it: the check sends nothing outward; its notice goes through `channel.notify`, which sandbox already records instead of sending (D91).

### How it runs

`startRecheck` copies the gateway's handshake exactly (`spawnGateway`, `gateway-process.ts:55-70`): it spawns `taskfollow recheck-run` (a hidden command like `gateway-serve`, not listed in `COMMANDS`) detached with `stdio: ["ignore", "ignore", "ignore", "ipc"]`; the child **takes the lock first**, then sends `process.send({ ready: true })`; the parent waits at most 10 s for that message, then `disconnect()`s and `unref()`s and returns. If the child exits before it is ready (it found the lock taken, or crashed), or the spawn itself errors, the parent throws an `ActionFailure` (a domain error, so `guard`, `tick.ts:209-216`, records it in `tick.errors` instead of rethrowing) and writes `last: { result: "error", why }` with `next` = now + 1 day. A lock whose pid is no longer alive is taken over (`isAlive`, as the tick lock). The child runs `weeklyRecheck(home, now, env)` inside a wrapper that, on any uncaught error, still writes `last` (result `error`) and audits `check.recheck` before it exits, then removes the lock. The check's own time is capped by `runTask`'s `RUN_MS` (5 minutes) plus the challenge's TTL (`RUN_MS + 60 s`): 5 minutes is a cap, not the usual time (task 34's real T7 took well under a minute).

### What it does with the outcome

| Outcome | Recorded | Marker | Told |
|---|---|---|---|
| **Pass** (the ping came through MCP under the hook) | `runnerCheck`'s `yes-tested` for `runner` and `tools`, agent-wide (unchanged), `test: "t7"` | `next` = now + 7 days; `last` = {at, result: "pass"} | nobody |
| **Fail** (the task ran, but no right call through TaskFollow's tool under the hook) | `runnerCheck`'s `not-checked` with its reason (unchanged), so the stop rule acts as it does today | `next` = now + 7 days; `last` = {at, result: "fail", why} | the decision maker, once (below) |
| **Could not run** (`runTask` returned `ok: false`: timeout, the agent missing, a crash), 1st or 2nd time in a row | **nothing** in `abilities` (the challenge is cancelled) | `next` = now + 1 day; `last` = {at, result: "error", why}; `errors` + 1 | nobody; the doctor's `checks` line is `warn` and says so |
| **Could not run, 3rd time in a row** | T7's `not-checked` for `runner` and `tools` (agent-wide), with the error as its reason, so the stop rule acts | as above; `errors` stays counted until a pass or a fail resets it | the decision maker, as on a fail |

An error is not a fail at first: a laptop that went to sleep or a network outage must not stop the person's workflows. But a broken agent must not stay silent either: `headless.ts` returns deterministic errors for an agent that is not installed (`:71-75`), exits with a code (`:76-77`), reported an error or printed no JSON (`:147-151`), and those repeat every day. So `config/recheck.json` keeps `errors`, the count of consecutive could-not-run results; the third one is recorded and told like a fail. A pass or a fail resets `errors` to 0.

This needs one change to `runnerCheck`: an option `quietOnError`. With it, after `runTask` returns, `runnerCheck` first checks `after?.status === "cancelled"` (**before** the `!throughTool` branch, `check-runner.ts:74-77`) and returns `{ error }`; then, when `runTask` returned `ok: false`, it cancels a still-open challenge, records nothing and returns `{ test: "t7", passed: false, error }`. If `runTask` returned `ok: false` but the challenge is `done`, through the tool and hooked, the pass was already recorded when the ping settled the challenge (`resultsFor`, `checks.ts:176-182`): it is a pass, and `weeklyRecheck` must not overwrite it with `last: error`. Without the option, `runnerCheck` behaves exactly as today (the person's own `check start t7` still records a not-checked, which the page explains).

### The notice on a fail

Text (one message, `MAX_TEXT` applies), sent once per failing week (a fail moves `next` a week on, so a still-broken agent is told again a week later, never daily):

> TaskFollow's weekly check found that it can no longer run your agent on this computer by itself: {why}. Workflows that run here may stop until this is fixed. Run 'taskfollow check start t7' to check again (about a minute).

Delivery, with the rule `why` uses (D164): when a channel that is not customers-only exists, a decision maker is set, the engine is **not in sandbox mode and not paused**, `channel.notify` to the decision maker. Otherwise (no channel reaches them, sandbox, or paused) the text waits in `config/recheck.json` `waiting`, and `why`'s list form shows it once under a new field `recheck` (rendered: "TaskFollow's weekly check (tell the person):"), clears it and audits `check.recheck_shown`. A damaged `recheck.json` gives a `recheck_damaged` line in `why`, mirroring `suggestionsField` (`why.ts:178`). `why.show` (D169) returns `recheck` and `recheck_damaged` first, like `suggestions`.

**A deliberate deviation from D164, stated in D174:** a channel failure (an outage, an unknown member) puts the notice in `waiting` instead of surfacing it for a retry, because the detached child has no tick to surface an error to; the person then sees it at their next session.

### Cost, said once

The report's runtime line (`report.ts`, where D155's "Runs" line says runs use the person's own plan) gains: "Once a week TaskFollow runs your agent once, for about a minute, to check it can still run here by itself." Only when conditions 1–3 above hold.

## Files

| File | Change |
|---|---|
| `src/core/check-runner.ts` | `RunnerCheckOptions.quietOnError`: a cancelled challenge first returns `error`; on `runTask` `ok: false` with an open challenge: cancel, record nothing, return `error`; a settled pass stays a pass |
| `src/core/recheck.ts` (new) | `RECHECK_FILE = config/recheck.json` (`next`, `last`, `errors`, `waiting`), `RECHECK_LOCK = runtime/recheck.lock`, `RECHECK_EVERY_MS` (7 days), `RECHECK_RETRY_MS` (1 day), `RECHECK_ERRORS_TO_RECORD` (3), `RECHECK_READY_MS` (10 s), `recheckDue`, `startRecheck` (the gateway handshake), `recheckRun` (the child: lock, ready, wrapped run, unlock), `weeklyRecheck`, `takeRecheckNotices` |
| `src/core/tick.ts` | the `recheck` pass (guarded), `TickResult.recheck: "started" | null` |
| `src/cli.ts` | hidden `recheck-run` command |
| `src/core/why.ts` | list form: `recheck` field (shown once), rendered line |
| `src/core/why-tools.ts` | `recheck` moved to the front with `suggestions` |
| `src/core/check-fresh.ts` | `checksDoctor`: `warn` (not `ok`) when `last.result === "error"`, with "the weekly check could not run on {day}: {why}" |
| `src/core/report.ts` | the cost sentence |
| `INSTALL.md` | rule 11: "…and TaskFollow's weekly check, if it waits" (one clause) |
| `DECISIONS.md` | D174 |
| `docs/next-steps.md` | the follow-up marked built; build map row; a new follow-up: a weekly per-workflow T7 for Home 1 workflows whose own `runner` result is stale or failed (so a stopped workflow could recover by itself) |
| `docs/superpowers/specs/2026-10-16-doability-check.md` | section 8: the parenthesis about the follow-up becomes one sentence on the weekly re-check |

## Tasks (test-first)

### Task 1: `runnerCheck` can stay quiet when its task could not run

- [ ] Failing tests in `tests/unit/check-runner.test.ts`:
  - `with quietOnError, a task that could not run records no result and cancels its check`
  - `with quietOnError, a cancelled check returns an error before anything is recorded`
  - `with quietOnError, a ping that settled the check is a pass even when the task then failed`
  - `with quietOnError, a pass still records runner and tools as before`
  - `without quietOnError, a task that could not run still records not checked (unchanged)`
- [ ] Implement: keep `runTask`'s result; with `quietOnError`, first `after?.status === "cancelled"` → return `{ error }`; then a settled pass (done, through the tool, hooked) → pass as today; then `!result.ok` → cancel a still-open challenge with "the weekly check could not run" and return `{ test: "t7", passed: false, error: result.error }` before any `recordResult`.
- [ ] Run the file; commit `feat(checks): T7 can stay quiet when its task could not run`.

### Task 2: when the re-check is due

- [ ] Failing tests in `tests/unit/recheck.test.ts` (new):
  - `is not due in a consultation`
  - `is not due for an agent whose profile has no task command`
  - `is not due before runner or tools ever passed for this agent`
  - `the first time, only sets the next check a week after the newest pass, or now if that is past`
  - `is due once next has passed, and not before`
  - `is not due while another re-check holds the lock`
- [ ] Implement `recheckDue(home, now)`.
- [ ] Commit `feat(checks): when the weekly re-check is due`.

### Task 3: the re-check and its outcome

- [ ] Failing tests (fake agent, as `check-runner.test.ts` uses; the notice through `doctor.test.ts`'s recorded-channel pattern):
  - `a pass refreshes runner and tools for the agent and moves next a week on`
  - `an old test:t5 tools entry is current after a weekly pass`
  - `a fail records not checked, moves next a week on, and tells the decision maker through their channel`
  - `a fail with no channel that reaches the person waits for why, once`
  - `a fail in sandbox mode, or while paused, waits for why instead of sending`
  - `a channel failure puts the notice in waiting`
  - `a task that could not run records nothing, tells nobody, and tries again the next day`
  - `the third could-not-run in a row records not checked with the error and tells the decision maker`
  - `a pass or a fail resets the count of could-not-run results`
  - `a pass settled before the task failed stays a pass and does not write last: error`
  - `an uncaught error in the run still writes last and audits check.recheck`
  - `after a fail, a workflow with declared needs and no results of its own is stopped by the existing rule`
  - `after a pass, a stale agent-wide result is fresh again and the doctor's checks line is ok`
  - `the doctor's checks line is warn when the last weekly check could not run`
- [ ] Implement `weeklyRecheck(home, now, env, check = runnerCheck)` with `quietOnError: true`; write `config/recheck.json` (`next`, `last`, `errors`, `waiting`) with read-again-before-write (D164's pattern); audit `check.recheck` with `{ result }`; the wrapper for uncaught errors.
- [ ] Commit `feat(checks): the weekly re-check and what it tells`.

### Task 4: the tick starts it, without waiting

- [ ] Failing tests in `tests/unit/tick.test.ts` (inject the starter, as `tick()` takes `start` for the gateway; assert the injected starter was called and `recheck: "started"`, with no timing assertions):
  - `the tick starts the weekly re-check when it is due`
  - `a paused install starts no re-check`
  - `a re-check that cannot start is a tick error, not a crash`
- [ ] Failing tests in `tests/unit/recheck.test.ts`:
  - `recheck-run takes the lock, says it is ready, runs once, and removes the lock` (call `recheckRun` directly)
  - `two ticks while a live child holds the lock start one`
  - `a child that exits before ready is a tick error and moves next a day on`
  - `a lock whose pid is dead is taken over`
- [ ] Implement `startRecheck` (the gateway's handshake, `gateway-process.ts:55-70`), the hidden `recheck-run` command, the guarded `recheck` pass.
- [ ] Commit `feat(tick): start the weekly re-check in its own process`.

### Task 5: what the person sees

- [ ] Failing tests:
  - `why.test.ts`: `the list shows a waiting weekly-check notice once, then clears it`
  - `why.test.ts`: `a damaged recheck file gives a recheck_damaged line and does not stop the list`
  - `why-tool.test.ts`: `why.show puts a waiting weekly-check notice first`
  - `check-fresh.test.ts`: `the doctor warns when the weekly check could not run`
  - `report.test.ts`: `the report says the agent runs once a week for the check, only for an agent that can be re-checked`
  - `tests/e2e/install-doc.test.ts`: rule 11 names the weekly check
- [ ] Implement; commit `feat(why): the weekly check's notice; doctor and report words`.

### Task 6: docs

- [ ] D174 (the build: what runs, when, the outcomes, an error is not a fail until the third in a row, the separate process with the gateway's handshake, 5 minutes is a cap, the mechanism by which T7 refreshes a T5 `tools` result, the deviation from D164 for channel failures, sandbox and paused notices wait), spec 8's sentence, `docs/next-steps.md` (follow-up built, build map row, the per-workflow T7 follow-up).
- [ ] Commit `docs: the weekly re-check (D174)`.

### Task 7: finish

- [ ] `npm run typecheck`; the full `npm test` twice (no edits meanwhile); settings checksum and `claude mcp list` before and after; PR.

## What the person sees

- Nothing on a pass.
- On a fail, or the third could-not-run in a row, once per failing week: the notice above (channel, or `why` at their next session: "TaskFollow's weekly check (tell the person): …").
- `taskfollow doctor`: `checks: warn — a check of what your agent can do no longer holds (runner: a run went wrong on {day})` (existing), and after a could-not-run: `checks: warn — the weekly check could not run on {day}: {why}`.
- The setup report, once: "Once a week TaskFollow runs your agent once, for about a minute, to check it can still run here by itself."

## Risks

1. **Per-workflow results are not refreshed.** A workflow with its own T7 results (`scoped()`) is kept fresh only by its own real runs. A workflow that has been stopped never runs, so it stays stopped until `taskfollow check start t7 --workflow <id>`, even after a weekly pass. This is today's behaviour, not new; recorded as a follow-up in `docs/next-steps.md`.
2. **A version change is not seen by the re-check.** Results are stamped with the version the probe recorded (spec 8: "a version change counts only after a re-probe"). The weekly check does not re-probe (out of scope, decided).
3. **The separate process outlives the tick.** It is bounded by `RUN_MS` plus the challenge TTL; a dead process leaves a stale lock, which the next due check takes over (`isAlive`).
4. **Orphaned agent processes (pre-existing).** If the child is killed mid-check, the agent process it started may outlive it, as for any task run killed today; not new, not fixed here.
5. **Cost.** One short agent run a week on the person's own plan; said in the report.
6. **No real-agent proof of the spawn path.** It reuses the gateway's detached spawn and handshake (D130) and `runnerCheck` (task 34, real Claude Code). No human task: the owner's real-user session will show the report line, and a stale result becoming fresh can be read in `taskfollow doctor` a week later.

## Out of scope

- Any other check (T1, T2–T4, T6, T6b, T8, T11), per-workflow T7 (a follow-up), Home 2 (Cowork has no task command), suggestions or workflow proposals, a re-probe of the agent's version, a schedule the person chooses.

## Decided in review

1. Per-workflow T7 in the weekly check: out of scope; a follow-up in `docs/next-steps.md`.
2. Reading the agent's version in the weekly check: no; out of scope.

## Plan review applied (2026-10-16)

The handshake copies `spawnGateway` (lock first, ready message, 10 s, a child that exits early is a tick error and a day's retry; a dead lock is taken over); a broken agent is recorded and told on the third could-not-run in a row, and the doctor warns after any; `quietOnError` checks a cancelled challenge first and keeps a pass that settled before the task failed; notices wait in sandbox, while paused, and on a channel failure (stated as a deviation from D164); the first marker is a week after the newest pass; D174 states the need-and-agent mechanism (a T7 pass makes an old T5 `tools` result current), that 5 minutes is a cap, and "once per failing week"; a `recheck_damaged` line in `why`; the new tests listed in Tasks 1, 3, 4 and 5.
