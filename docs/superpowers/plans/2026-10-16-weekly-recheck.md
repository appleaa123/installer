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
4. `config/recheck.json` `next` is unset (then it is only set to now + 7 days: a fresh install was just checked at setup) or `now >= next`;
5. no re-check process is alive (`runtime/recheck.lock`, the tick lock's `createExclusive` + `isAlive` pattern).

Sandbox mode does not stop it: the check sends nothing outward; its notice goes through `channel.notify`, which sandbox already records instead of sending (D91).

### How it runs

`startRecheck` spawns `taskfollow recheck-run` (a hidden command like `gateway-serve`, not listed in `COMMANDS`), detached, `stdio: "ignore"`, and returns at once. `recheck-run` takes the lock, runs `weeklyRecheck(home, now, env)`, and removes the lock. The check's own timeout is `runTask`'s (`RUN_MS`, 5 minutes) plus the challenge's TTL (already `RUN_MS + 60 s`).

### What it does with the outcome

| Outcome | Recorded | Marker | Told |
|---|---|---|---|
| **Pass** (the ping came through MCP under the hook) | `runnerCheck`'s `yes-tested` for `runner` and `tools`, agent-wide (unchanged), `test: "t7"` | `next` = now + 7 days; `last` = {at, result: "pass"} | nobody |
| **Fail** (the task ran, but no right call through TaskFollow's tool under the hook) | `runnerCheck`'s `not-checked` with its reason (unchanged), so the stop rule acts as it does today | `next` = now + 7 days; `last` = {at, result: "fail", why} | the decision maker, once (below) |
| **Could not run** (`runTask` returned `ok: false`: timeout, the agent missing, a crash) | **nothing** in `abilities` (the challenge is cancelled) | `next` = now + 1 day; `last` = {at, result: "error", why} | nobody; the doctor's `checks` line mentions it |

An error is not a fail: a laptop that went to sleep or a network outage must not stop the person's workflows. This needs one change to `runnerCheck`: an option `quietOnError` that, when `runTask` returns `ok: false`, cancels the challenge, records nothing and returns `{ test: "t7", passed: false, error }`. Without the option, `runnerCheck` behaves exactly as today (the person's own `check start t7` still records a not-checked, which the page explains).

### The notice on a fail

Text (one message, `MAX_TEXT` applies):

> TaskFollow's weekly check found that it can no longer run your agent on this computer by itself: {why}. Workflows that run here may stop until this is fixed. Run 'taskfollow check start t7' to check again (about a minute).

Delivery, with the rule `why` uses (D164): when a channel that is not customers-only exists and a decision maker is set, `channel.notify` to the decision maker; a channel failure is an error of the process, logged, and the notice goes to waiting instead. Otherwise the text waits in `config/recheck.json` `waiting`, and `why`'s list form shows it once under a new field `recheck` (rendered: "TaskFollow's weekly check (tell the person):"), clears it and audits `check.recheck_shown`. `why.show` (D169) returns the same field, first, like `suggestions`.

### Cost, said once

The report's runtime line (`report.ts`, where D155's "Runs" line says runs use the person's own plan) gains: "Once a week TaskFollow runs your agent once, for about a minute, to check it can still run here by itself." Only when conditions 1–3 above hold.

## Files

| File | Change |
|---|---|
| `src/core/check-runner.ts` | `RunnerCheckOptions.quietOnError`; on `runTask` `ok: false` with it: cancel, record nothing, return `error` |
| `src/core/recheck.ts` (new) | `RECHECK_FILE = config/recheck.json`, `RECHECK_LOCK = runtime/recheck.lock`, `RECHECK_EVERY_MS` (7 days), `RECHECK_RETRY_MS` (1 day), `recheckDue`, `startRecheck`, `weeklyRecheck`, `takeRecheckNotices` |
| `src/core/tick.ts` | the `recheck` pass (guarded), `TickResult.recheck: "started" | null` |
| `src/cli.ts` | hidden `recheck-run` command |
| `src/core/why.ts` | list form: `recheck` field (shown once), rendered line |
| `src/core/why-tools.ts` | `recheck` moved to the front with `suggestions` |
| `src/core/check-fresh.ts` | `checksDoctor`: adds "(the weekly check could not run on {day}: {why})" when `last.result === "error"` |
| `src/core/report.ts` | the cost sentence |
| `INSTALL.md` | rule 11: "…and TaskFollow's weekly check, if it waits" (one clause) |
| `DECISIONS.md` | D174 |
| `docs/next-steps.md` | the follow-up marked built; build map row |
| `docs/superpowers/specs/2026-10-16-doability-check.md` | section 8: the parenthesis about the follow-up becomes one sentence on the weekly re-check |

## Tasks (test-first)

### Task 1: `runnerCheck` can stay quiet when its task could not run

- [ ] Failing tests in `tests/unit/check-runner.test.ts`:
  - `with quietOnError, a task that could not run records no result and cancels its check`
  - `with quietOnError, a pass still records runner and tools as before`
  - `without quietOnError, a task that could not run still records not checked (unchanged)`
- [ ] Implement: keep `runTask`'s result; when `!result.ok && options.quietOnError`, cancel the open challenge with "the weekly check could not run" and return `{ test: "t7", passed: false, error: result.error }` before any `recordResult`.
- [ ] Run the file; commit `feat(checks): T7 can stay quiet when its task could not run`.

### Task 2: when the re-check is due

- [ ] Failing tests in `tests/unit/recheck.test.ts` (new):
  - `is not due in a consultation`
  - `is not due for an agent whose profile has no task command`
  - `is not due before runner or tools ever passed for this agent`
  - `the first time, only sets the next check a week ahead`
  - `is due once next has passed, and not before`
  - `is not due while another re-check holds the lock`
- [ ] Implement `recheckDue(home, now)`.
- [ ] Commit `feat(checks): when the weekly re-check is due`.

### Task 3: the re-check and its outcome

- [ ] Failing tests (fake agent, as `check-runner.test.ts` uses):
  - `a pass refreshes runner and tools for the agent and moves next a week on`
  - `a fail records not checked, moves next a week on, and tells the decision maker through their channel`
  - `a fail with no channel that reaches the person waits for why, once`
  - `a task that could not run records nothing, tells nobody, and tries again the next day`
  - `after a fail, a workflow with declared needs and no results of its own is stopped by the existing rule`
  - `after a pass, a stale agent-wide result is fresh again and the doctor's checks line is ok`
- [ ] Implement `weeklyRecheck(home, now, env, check = runnerCheck)` with `quietOnError: true`; write `config/recheck.json` (`next`, `last`, `waiting`) with read-again-before-write (D164's pattern); audit `check.recheck` with `{ result }`.
- [ ] Commit `feat(checks): the weekly re-check and what it tells`.

### Task 4: the tick starts it, without waiting

- [ ] Failing tests in `tests/unit/tick.test.ts` (inject the starter, as `tick()` takes `start` for the gateway):
  - `the tick starts the weekly re-check when it is due and does not wait for it`
  - `a paused install starts no re-check`
  - `a re-check that cannot start is a tick error, not a crash`
- [ ] Failing test in `tests/unit/recheck.test.ts`: `recheck-run takes the lock, runs once, and removes the lock` (call the command's function directly).
- [ ] Implement `startRecheck` (spawn like `gateway-process.ts:57`), the hidden `recheck-run` command, the guarded `recheck` pass.
- [ ] Commit `feat(tick): start the weekly re-check in its own process`.

### Task 5: what the person sees

- [ ] Failing tests:
  - `why.test.ts`: `the list shows a waiting weekly-check notice once, then clears it`
  - `why-tool.test.ts`: `why.show puts a waiting weekly-check notice first`
  - `check-fresh.test.ts`: `the doctor says when the weekly check could not run`
  - `report.test.ts`: `the report says the agent runs once a week for the check, only for an agent that can be re-checked`
  - `tests/e2e/install-doc.test.ts`: rule 11 names the weekly check
- [ ] Implement; commit `feat(why): the weekly check's notice; doctor and report words`.

### Task 6: docs

- [ ] D174 (the build: what runs, when, the three outcomes, error is not a fail, the separate process, T5's unattended part is T7's tools), spec 8's sentence, `docs/next-steps.md` (follow-up built, build map row).
- [ ] Commit `docs: the weekly re-check (D174)`.

### Task 7: finish

- [ ] `npm run typecheck`; the full `npm test` twice (no edits meanwhile); settings checksum and `claude mcp list` before and after; PR.

## What the person sees

- Nothing on a pass.
- On a fail, once: the notice above (channel, or `why` at their next session: "TaskFollow's weekly check (tell the person): …").
- `taskfollow doctor`: `checks: warn — a check of what your agent can do no longer holds (runner: a run went wrong on {day})` (existing), and on an error: `… current (the weekly check could not run on {day}: {why})`.
- The setup report, once: "Once a week TaskFollow runs your agent once, for about a minute, to check it can still run here by itself."

## Risks

1. **Per-workflow results are not refreshed.** A workflow with its own T7 results (`scoped()`) is kept fresh only by its own real runs. A workflow that has been stopped never runs, so it stays stopped until `taskfollow check start t7 --workflow <id>`, even after a weekly pass. This is today's behaviour, not new; see open question 1.
2. **A version change is not seen by the re-check.** Results are stamped with the version the probe recorded (spec 8: "a version change counts only after a re-probe"). The weekly check does not re-probe; see open question 2.
3. **The separate process outlives the tick.** It is bounded by `RUN_MS` plus the challenge TTL; a dead process leaves a stale lock, which the next due check takes over (`isAlive`).
4. **Cost.** One short agent run a week on the person's own plan; said in the report.
5. **No real-agent proof of the spawn path.** It reuses the gateway's detached spawn (D130) and `runnerCheck` (task 34, real Claude Code). No human task: the owner's real-user session will show the report line, and a stale result becoming fresh can be read in `taskfollow doctor` a week later.

## Out of scope

- Any other check (T1, T2–T4, T6, T6b, T8, T11), per-workflow T7, Home 2 (Cowork has no task command), suggestions or workflow proposals, a re-probe of the agent's version, a schedule the person chooses.

## Open questions (for the reviewer, not the owner)

1. Should a weekly pass also re-run the per-workflow T7 for Home 1 workflows with declared needs whose **own** `runner` result is stale or failed (one task each), so a stopped workflow can recover by itself? It is within D170's spirit ("re-run these tests on their own") but more agent use; the minimum is preflight T7 only.
2. Should the re-check first read the agent's version (`profile.detect`, a 10-second command, as the probe does) so a version change is seen within a week? It would change `state.runtime.agent_version` outside the probe.
