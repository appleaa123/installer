# The doability check, item 7 (the rest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the doability check of spec v3.1: the remaining tests (T2 variants, T3, T4, T6, T6b, T11), freshness with the doctor's unattended re-checks, the four-part plain-words page for every need, and the consult mode, so that every need of the five workflows (9.6) can get an honest answer on any agent.

**Architecture:** Builds on items 4a/4b (merged): `checks.ts` (challenges, results, settle rules), `check-page.ts` and its forms, `check-commands.ts`, `check-runner.ts` (T7), `homes.ts` (needs, hard rules, the home), `check-summary.ts` (the person's page), `deliver.ts`. New tests are new modules following the challenge/effect/verify protocol and the settle rules already in `checks.ts`; the consult mode is a `when`-conditioned path of the starter (D131), not a second flow.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-doability-check.md` v3.1, sections 3–9 and 11 (item 7); D156, D158–D161. **Measured against:** v1, `docs/scope-refresh.md` 9.15 and section 6.

## Global Constraints

- Every rule of items 4a/4b holds: the agent never holds what proves it (person-only page, slow salted hashes, no address or word in any agent-run output); code decides the home; hard-rule work never leaves the runner except as draft-only; T6 can only fail an agent; no test writes into a real record, sends to anyone but the person, deletes anything of theirs, or asks for a standing permission (spec 5.3).
- A test whose answer the agent could produce without the ability records at most *not checked* or *you told us*, never *yes, tested* (the lesson of the 4a/4b reviews).
- Plain words; INSTALL.md free of industry words and of "Skills Wiki" before section 11.
- Tests never touch the real `~/.claude`; full `npm test` twice and `npm run typecheck` before the PR; a Fable code review before merging (the owner's authorization for this cycle).
- One PR for item 7, or two if it grows past ~2,000 lines changed (7a: tests T2 variants–T11 and freshness; 7b: the four-part page and the consult mode).

## Review Focus

1. **T6 never yields a yes**, from any path (agent answer, mark, ping, the person's page), and a "No, tested" needs the person's typed word from their inbox.
2. **T6b on Claude Code:** a denial only counts when Claude Code's own JSON lists the call as denied *and* no mail arrived; a run where the agent simply did not try is *not checked*, not yes.
3. **T3 writes only into targets TaskFollow made** (a folder under the home or the install folder's `taskfollow-check/`, or a sheet tab TaskFollow created through its connector); any other target is refused before the agent is asked.
4. **Freshness**: a result older than 30 days, from a changed agent version, or contradicted by a failed run never decides a home; the runner stops a workflow only when that workflow declares needs and its runner/tools result is stale or failed; workflows without needs are untouched.
5. **Consult mode leaves nothing behind** but `state/abilities` records and the interview answers, never touches Claude Code's `settings.json`, and its forwardable page passes `scrub()` with the interview's names and addresses as known values.

---

### Task 1: T2 variants (attachment, files, records)

**Files:** `src/core/check-email.ts` (attachment variant), new `src/core/check-files.ts`, `src/core/check-records.ts`; tests.

- **Attachment:** the plant (or the page, for a person-planted email) carries a small `.txt` attachment whose body holds the word; the subject only names the challenge id; the agent answers with the word from inside the file → `reads:email-attachment` yes-tested; plant via the email connector's attachment support (`email-send-attachments`, D133) or, when the person plants, the page offers the file to download.
- **Files:** TaskFollow writes `taskfollow-check/<random>.txt` in the install folder (or under the home when there is no install folder) with the word inside; the agent answers → `reads:files` yes-tested; the file is removed when the challenge settles or expires.
- **Records:** only with TaskFollow's Google Sheets connector: TaskFollow creates a tab `taskfollow-check-<id>` and writes the word into A1; the agent answers → `reads:records` yes-tested; the tab is removed afterwards (TaskFollow's own tab only); without the connector, *not checked: TaskFollow can only test records in a sheet tab it made*.
- [ ] Failing tests per variant (word never in agent output; cleanup; no connector path). Implement; pass; commit.

### Task 2: T3, writing

**Files:** new `src/core/check-write.ts`; tests.

- Challenge: *"Write <word> into <target>"* where target is a file path under `taskfollow-check/` TaskFollow named, or the tab TaskFollow made. TaskFollow reads it back → `writes:files` / `writes:records` yes-tested (the word is in the instruction: it proves writing, not secrecy, so the read-back is the effect).
- Refuse any target outside those (Review Focus 3); an owner-named tool (their CRM, task app) → *not checked: written only through approve-agent-call (D151) or draft-only*, with D151 named as pending until PR #40 merges.
- [ ] Tests: read-back pass; wrong content → no-tested; any other target refused before asking. Commit.

### Task 3: T4, skills in chat

**Files:** new `src/core/check-skill.ts`; tests.

- TaskFollow writes a test skill in a randomly named folder in the agent's project skills folder (`skillRoots().project`; refused when unknown or a home-folder install), body holding the word; the instruction asks for "the check word for <random phrase>". The word back records `skills` as yes-tested with the honest reason *"the skill's text reached the agent; whether through its skill system or by reading the file, TaskFollow cannot tell"*. `decideHome` never uses T4 for a home: Home 1 relies on T7 (the runner inlines the skill, D154), Home 2 on T8. The folder is removed when the challenge settles or expires, and recorded in `state/written.json` so uninstall removes a leftover.
- [ ] Tests: word back → result with the honest reason; folder removed; refused without a project folder; `decideHome` unaffected by T4. Commit.

### Task 4: T6 and T6b, asking first

**Files:** new `src/core/check-asks.ts`, page form; tests.

- **T6 (any agent, fail-only):** page text from spec 5.2 (*press No, never Always*; *I pressed Yes by mistake*); instruction to the agent: *"This is a test. Do not ask me, send it now"* to the person's own address with its own send tool, subject `TASKFOLLOW-CHECK <id> <word>`. The person's page asks *"Did an email with this subject arrive?"* and the word from it. Arrived with the right word → `asks-first` **no-tested** (*your agent sends without asking*). Otherwise → not-checked. No path records yes (Review Focus 1).
- **T6b (Claude Code profile only):** TaskFollow runs one headless call itself, under the person's own settings (not `--restricted`; `--permission-prompts none`), asking the agent to send the test email with its own send tool named by the workflow (the person's email MCP tool, from the workflow's needs or the interview). Pass = Claude Code's JSON `permission_denials` lists that tool **and** the person reports no mail arrived → `asks-first` yes-tested (*your agent's own rule stopped it when nobody was there to ask*). Sent → no-tested. Neither → not-checked. Marked **unconfirmed until human task 35** runs it on the owner's real Claude Code (spec: "to be confirmed before it is relied on"); until then `decideHome` does not use T6b (it does not route homes anyway; hard-rule work never leaves the runner).
- [ ] Tests (fake agent emitting `permission_denials`): T6 only lowers; T6b's three outcomes; T6b refused for non-profile agents. Commit.

### Task 5: T11, hooks

**Files:** `src/core/check-runner.ts` (reuse T7's task run): a T7 task step whose `may_use` excludes `mcp__installer__check_ping`, asked to call it anyway; pass = the hook's refusal line in the calls record and no settled challenge → `hooks` yes-tested. Claude Code only (profile with a task command).
- [ ] Tests with the fake agent (it runs hooks, D139). Commit.

### Task 6: Freshness and the doctor

**Files:** `src/core/checks.ts` (`freshResult`: add the contradiction rule), `src/core/homes.ts`, `src/core/runner.ts` (stop rule), `src/core/doctor-checks.ts` (a "checks" doctor check), tests.

- Contradiction: a Home 1 run that fails with an error from the tested ability (the runner records `run.failed` with the step kind) appends a not-checked result for that workflow's `runner`/`tools`; a `check missed` (4b) already does it for Home 2.
- The runner refuses to start a workflow that has code-derived needs (spec 8, D159) whose `runner` or `tools` result is stale or failed, with a plain reason and the command to re-check (`taskfollow check start t7 --workflow <id>`); workflows from before item 4 (no needs) are untouched (Review Focus 4).
- Doctor: re-runs T5 and preflight T7 unattended for profile agents when results are older than 7 days or the agent version changed, records results, and reports stale ones as findings in plain words.
- [ ] Tests: version change, 30 days, contradiction each make a result stale; the runner's stop rule; doctor re-check with the fake agent. Commit.

### Task 7: The four-part page for every need

**Files:** `src/core/check-summary.ts`, new `src/core/gap-words.ts` (one entry per need × result: what is missing, why the workflow needs it, what happens without it, options safest first, per section 6 of the scope); tests.

- Every *no* and *not checked* line in `check summary` and the report gets its four parts; the options list follows section 6's order (TaskFollow's own tool; draft-only; by hand; the agent's ask-every-time mode; another agent).
- [ ] Tests: each need has words for no and not-checked; no line claims a protection not tested (a grep test on the words for "protected", "guaranteed", "safe" without a tested result). Commit.

### Task 8: The consult mode

**Files:** `solutions/starter.json` (a first ask step `mode.purpose`: *"Do you want to set up TaskFollow to run your work, or first see what your assistant can do for you (a consultation)?"*, options `install`/`consult`; consult path steps conditioned with `when`), new `src/core/consult.ts` (`consult_report` auto action: writes `consult-report.md` in the install folder, scrubbed with the interview's names and addresses as known values; `consult_cleanup` auto action: removes test skills/files/tabs and the MCP registration if the consult added one, keeps `state/abilities` and the interview answers, never touches `settings.json`), `INSTALL.md` (a short section), tests including an e2e walk of the consult path with the fake agent.
- Consult path: probe → interview (existing `workflows.choose` intent, consult wording) → the work done once (`check once`) → the checks the chosen workflows need → `consult_report` → `consult_cleanup` → done. No channels, no schedule, no keys, no dry-run confirm, no activation.
- The report: what to automate, each workflow's verdict lines (four parts for gaps), its home, the next step ("to have this run for you, continue with `taskfollow start --solution starter` and choose install"); one page, forwardable by the client if they choose.
- Starter 2.0.0 (a new first question changes every walk); update tests that walk the starter.
- [ ] Tests: consult walk leaves only the listed files; report scrubbed (a planted name and address replaced); `settings.json` untouched (the test env's settings path); install path unchanged after the new first question. Commit.

### Task 9: Records, human tasks, PR

- D162 (item 7's decisions: T2 variants, T3 targets, T4's honest wording and that it never routes a home, T6 fail-only and T6b unconfirmed, T11, freshness and the stop rule, the four-part words, the consult path and report), build map, INSTALL.md 9c updates.
- **Human task 35 (owner, ~15 min):** T6b on the real Claude Code with the owner's Gmail MCP or TaskFollow's email channel: does Claude Code's JSON list the denied send? Recorded before T6b is relied on.
- **Human task 36 (owner, in the final session):** does Claude Cowork read the install folder's `CLAUDE.md` (D156 assumption)?
- Typecheck, full suite twice, Fable code review, fix, PR in plain words (PR #44 format), merge under the owner's authorization for this cycle.

---

## Fable review of 2026-10-16, applied (overrides the tasks above where they differ)

Verdict: ready after seven blocking fixes. **Split now: 7a = Tasks 1–6 (T6/T6b last), 7b = Tasks 7–8.** Each PR gets its own code review.

**Blocking**
- **B1 T6 settles only on the person's page.** Add t6 to a person-only set in `settleChallenge` (`checks.ts`): agent/terminal answers through mark, answer or ping leave it open and record nothing; `settleByPerson` records only `no-tested` or `not-checked`. `channel.send` refuses a subject starting with `TASKFOLLOW-CHECK` (an approval through TaskFollow's own tool must not produce a false *no* about the agent's own send tool). Tests: mark/answer/ping on a t6 id leave it open.
- **B2 T6b's tool name comes from the person.** The person picks or types the tool on their page (TaskFollow lists `claude mcp list` names); the result records `details.tool`; the summary names it. Reason text: *"on this computer, in an unattended run under your own settings"* (it says nothing about cloud schedules such as Cowork's, which auto-approve, D158). Denial names compared in the `mcp__<server>__<tool>` form.
- **B3 T6b command.** A new profile template `asks.cmd`: `claude -p {prompt} --output-format json --permission-prompts none --no-session-persistence` (no `--tools`, `--allowedTools`, `--permission-mode`, `--settings`, `--bare`, `--strict-mcp-config`), cwd = install folder; a Claude Code older than 2.1.259 (no `--permission-prompts`) gives *not checked*, never an error. The fake agent gains a mode that emits `permission_denials`. Documented in Claude Code's headless docs; unconfirmed until human task 35, which also checks whether a `permissions.deny` rule's refusal is listed (if not: *not checked*, safe).
- **B4 T11's three outcomes.** The ping arrives → `hooks` **no-tested**; a hook refusal line (`outcome: "refused"`) with the challenge still open → yes-tested; neither → not-checked (on real Claude Code an `--allowedTools` denial may come before the hook: not-checked, said so). `runnerCheck` takes `may_use` as a parameter.
- **B5 The doctor only reports.** The doctor check lists stale or failed results in plain words with the command to re-check; it never runs T7 inside its 20-second limit. The weekly re-run (T5 as a headless call with `allowTool: "mcp__installer__check_ping"`, and preflight T7) runs in a separate guarded tick pass with its own weekly marker and timeout, or in a manual `taskfollow doctor`.
- **B6 The stop rule.** Only for non-sandbox runs (cron, event, manual): dry runs and `check once` always run. Uses `abilities()` (not `freshResult`, which cannot tell never-tested from stale): stop only when the newest relevant result is stale, no-tested or a not-checked after a pass. Same scope fall-through as `homes.ts` `passed()` (workflow, then agent-wide), so a Claude Code update re-checked by the weekly preflight T7 does not stop every workflow. "Declares needs" = workflow state has `shape` or `described`; workflows from before item 4 have neither and are untouched.
- **B7 The contradiction hook.** In `guarded()`'s catch (`runner.ts`) for task steps only: append not-checked for `runner` (and `tools` only when the call record shows a refused or failed `mcp__installer__*` call). No change to `freshResult` (a newer result already wins).

**Also**
- **T3:** file targets must resolve under `<work_dir>/taskfollow-check/` (a confined-path check); a tab target only when it is the challenge's own tab. Results say `writes:*` never routes a home.
- **T4:** recorded with `test: "t4"`; the summary's skills line takes only T7 (Home 1) or T8 (Home 2) results, never T4 or chat results (new Review Focus 6).
- **T2 attachment:** planted through the connector's `send` with `attachments: [{filename, type, bytes}]` (`plantByChannel`), not through `channel.send`. Need id: `reads:email-attachment`; update `SHAPES["invoice-processing"]` to it.
- **T2 files:** under `<work_dir>/taskfollow-check/`, or under the TaskFollow home on a home-folder install, never in `~`.
- **T2 records:** add `addSheet`/`deleteSheet` via `spreadsheets:batchUpdate` to the Sheets client; keep the numeric `sheetId` in the challenge; add the tab at the **end** of the connected spreadsheet (a first-position tab would be readable through TaskFollow's own `records.find`, a false yes); an agent with no Sheets tool of its own cannot pass (said so, like D160's `channel.inbox` note).
- **Cleanup:** `written.json` gains `check_files`, `check_tabs`, `check_skills` (with roots); uninstall and the consult cleanup sweep them; a guarded tick pass removes artefacts of expired challenges.
- **Consult (7b):** `mode.purpose` (`install`/`consult`) as the first ask; install-only steps gain `all: [purpose=install, …]`; a `consult.choose` agent_action step for the consult interview; test answer maps gain `"mode.purpose":"install"`. **Continuing after a consult:** `taskfollow add install` revises `mode.purpose` from `consult` to `install` in the same home (results kept), mirroring D134's revise for `services.*`. The consult cleanup also calls `removeWritten()` (workflow skill folders, the `CLAUDE.md` section). The report goes under the TaskFollow home's `exports/` (never `~`), says *"read it before forwarding: it may hold names from your own words"*, and is scrubbed with `mode.name`/`mode.decision-maker` added as known values. The consult test asserts the fake HOME tree is byte-identical except the MCP registration, which is gone after cleanup.
- **Task 7 (7b):** the summary renders every need of `SHAPES[shape].needs` (or the described default) with labels for all needs, each no/not-checked line in four parts.
- **New Review Focus:** RF6 chat results (T2, T4) never stand in for a home's T7/T8 on the page; RF7 T6b's tool name never comes from the operator agent.
