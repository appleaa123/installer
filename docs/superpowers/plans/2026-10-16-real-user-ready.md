# Real-user readiness (D175)

Written 2026-10-16. Plan only: nothing here is built yet. Built **after item 8** (D173, operator rule 15, building now); items 6a (D171) and 6b (D172) are merged. Line numbers below are checked against main `d1ae599` where marked "pre-build check"; item 8 may still move some, so every task names the text to find, not only the line.

## Goal, in the owner's words

> "My goal is to use TaskFollow as a real user in my agent (any agent, I'll ask friends to test on all agents possible). I have Claude Cowork, Antigravity and Claude Code."

§9.11: a person installs, sets up, runs and uses TaskFollow with only TaskFollow's own guidance. A read-only audit of main (2026-10-16) found what stops that today. This item fixes exactly those findings and nothing else.

## What exists vs what is built

| Finding | Today (main 5bc26c8) | Built here |
|---|---|---|
| A1 blocker | An agent with no profile (Antigravity, OpenClaw, Hermes, Gemini CLI, Cursor) is blocked at `preflight.tools`: `register_tools_mcp` throws `NO_AGENT_TOOLS_HINT` (`actions.ts:59`, `:102-104`, `:147`), the step is `blocking: true` (starter.json step 2; starter-skillswiki.json line 27), and the engine blocks it after 3 tries (`engine.ts:114-119`); only a non-blocking blocked step is skipped (`engine.ts:82`). Nothing after PREFLIGHT is reachable. | `blocking: false`, so the step lands under "Limited" with its hint and the install goes on; one INSTALL.md sentence on the CLI path |
| A2 | `check summary` / `check home` throw "No agent was found yet: run 'taskfollow probe' first" for an unknown agent (`check-summary.ts:62` calls `agentOf(state, undefined)`; throw at `check-commands.ts:52`), although the probe ran | `check deliver`'s fallback (`check-commands.ts:147`) used in both; truthful error words |
| A3 | Judges need a direct model key on any agent without headless C4 (`model.ts:166`); setup says so only in INSTALL.md §8.3 | One line in "Before you start" and in the report |
| A4 | The report says "unknown agent — level 0 of 3 (no known agent profile; fallbacks apply)" (`report.ts:117`, `:161`) | A plain sentence |
| A5 | No profile → no skill roots, no agent file (`workflow-skill.ts:45`), so `workflow add … my_rules` is refused (`lifecycle.ts:103` area, `noFolderNote`) and `taskfollow skills` lists nothing (`skills.ts:152`) | A generic fallback: `.agents/skills/` in the install folder and an `AGENTS.md` section |
| A6 | INSTALL.md "Before you start" point 4 ("If you cannot run `claude --version` … install the Claude Code command-line tool before you go on") and START-HERE's prerequisites and steps 3–4 assume Claude Code | Any agent that can run commands; Claude Code is the certified one |
| Cowork | No word anywhere that Cowork on the web cannot install TaskFollow | One paragraph in START-HERE and README |
| B | §9.13 leftovers: `package.json` description, INSTALL.md title and first line, README status line and Antigravity row, `docs/next-steps.md` not rewritten | Rewritten |
| C1 | The email page saves an address and a different sign-in name without a word (`email-page.ts:111-137`) | A plain warning and a tick box; the Connected page names the mailbox read |
| C2 | "Send the code" (starter.json `channels.join-solo` and the Telegram join step, starter-skillswiki.json lines 107 and 110, `actions.ts:205`, INSTALL.md §7 item 5); a bare code is never accepted (`envelope.ts:97`) | The exact line per channel |
| C3 | A dry run of an `agent_call` approve step saves `output: null` and records nothing (`runner-steps.ts:139-142`), so `would_have` is empty (`lifecycle.ts` dryRun reads `listOutbox` only) | The call is recorded in the outbox like any other sandboxed action |
| npm | No `prepack`; a tarball ships whatever `dist/` holds | `"prepack": "npm run build"` |

## Tasks (each test-first: the named test fails first, then the smallest change makes it pass)

### Task 1 — A1: the install goes on without a known agent

Files: `solutions/starter.json`, `solutions/starter-skillswiki.json` (step `preflight.tools`, the line containing `"Connect your agent to the installer's tools"`), `INSTALL.md` §5, `tests/unit/starter-minimum.test.ts`, `tests/e2e/` (one new file or the existing starter e2e).

- `preflight.tools` gets `"blocking": false` in both starters, and in `tests/fixtures/solution-starter.json` (line 24). In the shipped starter the step is at `starter.json:810-819`, `"blocking": true` at `:815` (pre-build check). Its hint stays `NO_AGENT_TOOLS_HINT`.
- **Non-blocking alone is not enough (review finding 1).** A failed auto step is returned as the current step until `resume` (`engine.ts:161-170`; `currentStep` skips only a *blocked* non-blocking step, `engine.ts:82`), and `resume` reopens every blocked step with `attempts: 0` (`engine.ts:268-269`), so the three-failure loop would repeat on every resume. Change, in the engine: `failStep` (`engine.ts:115-123`) moves a step that is **not blocking** straight to `blocked` on its first failure (hint and reason kept), and `resume` leaves a non-blocking blocked step alone (it reopens only blocking ones and failed ones). A blocking step keeps today's three tries.
- The hint's last clause becomes truthful for any agent: "…no known agent to connect TaskFollow's tools to: use 'taskfollow tool <name>' for TaskFollow's tools (INSTALL.md section 5); install Claude Code only if you want the tools over MCP". (No "install a supported agent, then resume" as the only way out.)
- INSTALL.md §5 gains one sentence: "Only Claude Code registers TaskFollow's tools as an MCP server; any other agent uses `taskfollow tool <name> '<json>'`, which goes through the same approval gate."
- `starter-skillswiki.json` keeps its Skills Wiki registration steps blocking: Skills Wiki over MCP needs a known agent (`NO_AGENT_HINT`); that starter is optional (D126). Say so in Out of scope.

Tests:
- `starter-minimum.test.ts`: "preflight.tools is not blocking in either starter".
- e2e `an install on an agent with no profile reaches the MODE questions in one start`. **Safety (pre-build check, finding 6): do NOT strip `PATH`.** A `start` in a test home has registered with the real Claude Code before (`docs/human-tasks.md:271`). Use the pinned-starter pattern of `tests/e2e/consult.test.ts:11-19` with `probe.args = { profile: "missing-agent" }` (`tests/fixtures/profiles/missing-agent.json`). ONE `start --solution <pinned>` returns step `mode.purpose` (`starter.json` ~:821); `preflight.tools` is recorded `blocked` with the new hint after one attempt; `report` lists it under Limited.
- `tests/unit/engine-failure.test.ts` (next to its tests at :39 and :53, not engine.test.ts): "a non-blocking auto step that fails is blocked at once and the install goes on"; "resume reopens a blocked blocking step but leaves a blocked non-blocking step alone"; "a blocking step still gets three tries" (kept behaviour).
- **Why non-blocking is safe for Claude Code too (Q1, accepted):** a Claude Code install whose registration fails shows `register.ts:69`'s error under Limited; T5 still records the tools path through `taskfollow tool`; T7 carries its own `--mcp-config`, so the runner proof does not depend on the user-scope registration.

### Task 2 — A2: the doability page for an unknown agent

Files: `src/core/check-commands.ts` (`agentOf`), `src/core/check-summary.ts` (`summaryCommand`), `src/core/check-once.ts` (line 37), `homeOf`, tests `check-summary.test.ts`, `check-once.test.ts`, `check-commands.test.ts` (or where `agentOf` is tested).

- After a probe that found no agent (`state.runtime` exists and `runtime.profile === null`), `agentOf(state, undefined)` returns a fixed name, `{ agent: "your agent (no TaskFollow profile)", version: null }`, instead of throwing. `--value '{"agent":"…"}'` still names a different agent when given (T8, Cowork). With no probe at all, today's error stays.
- One helper used by `check deliver`, `summaryCommand`, `homeOf` and `check once` returns that same value, so results recorded by t1/t5/once (keyed by agent) match what the summary and the home look up. `check deliver`'s "no runner agent" literal goes.
- No INSTALL.md change: t1/t5 run bare on any agent.

Tests:
- "after a probe that found no agent, t1 and t5 run bare and their results show on check summary".
- "check home works with no agent profile; the runner home says TaskFollow cannot start this agent".
- "check once works with no agent profile".
- "with no probe at all, check summary still asks to run the probe".

### Task 3 — A3 and A4: plain words about what TaskFollow can do on this agent

Files: `INSTALL.md` "Before you start", `src/core/report.ts` (`runtimeLimits`, `agentLine`), tests `report.test.ts`.

- INSTALL.md "Before you start", new point after the agent point: "**When TaskFollow cannot start you by itself** (any agent except Claude Code today): a workflow's dry run, and every workflow that needs a model's judgment, needs a model key of the person's own (`taskfollow model`, then `taskfollow secret model`, section 8.3); without one the install stops at the dry run. Say this before the questions, so the person can have a key ready; a typed workflow with no judge or agent step needs none." (Review finding 5: `model.ts:163-168`; the dry-run check `dry_runs_done`, `actions.ts:212`.)
- `report.ts` `RUNS_HERE` / `RUNS_WANTED` (lines 91-92) say "They use your own Claude plan." only when the profile is Claude Code; with another profile "They use your own <agent> plan."; with no profile and a model key "They use your own model key."; with neither, the sentence is left out (review finding 6).
- `runtimeLimits` with `profile` null returns one item: "TaskFollow cannot start this agent by itself: scheduled runs need a model key, or run by hand when you ask; approvals and records work through `taskfollow tool`".
- `agentLine` with no profile: `🤖 Agent      your agent (no TaskFollow profile) — <that sentence>`; the "level 0 of 3" wording is dropped for this case only.

Tests:
- "runtimeLimits for an unknown agent says in plain words what runs and what needs a key".
- "the report's agent line for an unknown agent has no 'fallbacks apply' and no level number". In the same commit, rewrite `tests/unit/report.test.ts:108-113` ("says fallbacks apply when no agent was recognised"), which asserts the old "unknown agent — level 0 of 3 …" line.
- "the Runs line names Claude only for Claude Code".
- e2e "a dry run on an agent with no profile stops with the hint naming taskfollow model and taskfollow secret model" (the exact hint is asserted), and "with a direct model set up (a fake model server, as the model tests do), the same dry run completes".

### Task 4 — A5: skills and the agent file on any agent

Files: `src/core/skills.ts` (`skillRoots` and a new `rootsFor`), `src/core/workflow-skill.ts` (`installTargets`), `src/core/runner.ts:55`, `src/core/check-reads.ts:35`, `src/core/check-skill.ts:26`, `src/core/agent-file.ts`, `src/core/uninstall.ts`, `src/core/lifecycle.ts` (`noFolderNote`), tests `skills.test.ts`, `workflow-skill.test.ts`, `runner.test.ts` (skills block), `check-reads.test.ts`, `check-skill.test.ts`, `uninstall.test.ts`.

- **One function (review finding 2).** `rootsFor(profile | undefined, workDir, env)` in `skills.ts` is the only place roots are derived: the profile's `skills_dirs` when it has them; otherwise, with a known `work_dir`, `{ project: <work_dir>/.agents/skills }`. **It keeps `skillRoots`' home-folder guard (`skills.ts:57-58`, pre-build check finding 2):** when the install folder is the person's home folder, there is no project root and nothing is written; never `~/.agents/skills`. It replaces the four `profile ? skillRoots(...) : {}` call sites (`runner.ts:55`, `check-reads.ts:35`, `check-skill.ts:26`, `installTargets`) and the inventory (`skills.ts:154`), so a run, the checks and `workflow add` agree on where the skill is. `restoreAfterConsult` (`consult.ts:108`) also reads `installTargets` and follows automatically.
- **The discovery skill moves too (pre-build check finding 1).** 6b's `writeDiscoverySkill` (`workflow-skill.ts:117-135`) goes through `installTargets`, so with `rootsFor` it lands in `<work_dir>/.agents/skills/find-my-repetitive-work` and is recorded in `written.json`; `exports/` is used only when `work_dir` is unknown or is the home folder. Update INSTALL.md 9b item 2 (`:137`) to say where the skill is, and the uninstall "kept" entry (`uninstall.ts:94`) to say "only when TaskFollow knows no install folder". D175 amends D172 accordingly.
- **The Cowork zip (pre-build check finding 3).** `skillText` (`deliver.ts:84-88`) hard-codes `.claude/skills`. After item 8 merges (it should read the path from `loadWritten`), verify it; if it still names `.claude/skills`, route it through `installTargets` / `written.json` in this item, so a workflow skill under `.agents/skills` is the one zipped.
- **The no-folder note (pre-build check finding 4).** `noFolderNote` (`lifecycle.ts:104-108`): the "does not know which folder" branch (`:106`) is conditioned on `!workDirKnown` alone, since with the fallback every profile has a project root once `work_dir` is known.
- **Any profile without `skills_dirs` (review finding 3).** `profiles/codex.json` has `instructions_file: "AGENTS.md"` but no `skills_dirs`, so today `workflow add … my_rules` is refused for Codex. The fallback applies to any profile without `skills_dirs`, not only to no profile; no profile file changes. This amends Out of scope's earlier "Codex unchanged" (D150): Codex gets `.agents/skills/` too.
- The agent file: the profile's `instructions_file` when it has one; with no profile, `<work_dir>/AGENTS.md`.
- **The folder is read by all six agents (Q2; sources read 2026-10-16, recorded in D175):** Codex learn.chatgpt.com/docs/build-skills; Gemini CLI geminicli.com/docs/cli/skills/; Cursor cursor.com/docs/context/skills; OpenClaw docs.openclaw.ai/tools/skills.md (caveat: its workspace defaults to `~/.openclaw/workspace`, so the install folder must be its workspace); Hermes hermes-agent.nousresearch.com/docs/user-guide/features/skills (after `hermes skills trust`); Antigravity antigravity.google/docs/skills. No fallback folder is needed.
- `AGENTS.md` support is weaker, so it is still written, but the report and `taskfollow skills` say "listed in AGENTS.md; ask your agent to read it" and never claim the agent loads it (R5).
- `taskfollow skills` lists `.agents/skills` for such an agent with the note "TaskFollow keeps workflow skills in .agents/skills (read by Codex, Gemini CLI, Cursor, OpenClaw, Hermes and Antigravity) and lists them in AGENTS.md; ask your agent to read it".
- Written folders and the `AGENTS.md` section are recorded in `state/written.json` as for Claude Code, so uninstall removes them and nothing else (D109; §9.13 item 5).
- A Claude Code install is unchanged (`.claude/skills/`, `CLAUDE.md`).

Tests:
- "rootsFor gives .agents/skills for no profile and for a profile without skills_dirs, and the profile's folders otherwise".
- "an install with no agent profile writes the workflow skill under .agents/skills".
- "a Codex install accepts workflow add with my_rules and writes .agents/skills".
- "a run on an agent without skills_dirs inlines the skill from .agents/skills" (runner).
- "the skills checks find the skill under .agents/skills" (check-reads, check-skill).
- "an install with no agent profile keeps one TaskFollow section in AGENTS.md and leaves the rest of the file alone".
- "taskfollow skills for an unknown agent says listed in AGENTS.md, ask your agent to read it".
- "uninstall removes the .agents/skills folders and the AGENTS.md section TaskFollow wrote, and nothing else".
- "a Claude Code install still writes .claude/skills and CLAUDE.md".
- "an install with no agent profile writes the discovery skill under .agents/skills, not exports/".
- "an install in the home folder writes no workflow skill and no discovery skill under ~/.agents/skills".
- "a Cowork zip of a workflow whose skill is under .agents/skills carries that skill" (only if `skillText` still names `.claude/skills` after item 8).
- "with a known install folder, the no-folder note never says TaskFollow does not know the folder".

### Task 5 — A6 and Cowork: the words for any agent

Files: `INSTALL.md` "Before you start" point 4, `START-HERE.md` (prerequisites, steps 3–4), `README.md` (agent table), `tests/e2e/install-doc.test.ts`, the START-HERE test if one exists.

- INSTALL.md point 4 becomes: "**Which agent are you?** Say your name and version. TaskFollow has a certified profile for Claude Code; any other agent that can run commands in a terminal can install and use TaskFollow while the person is in the chat (section 5 for the tools, 'Before you start' on what needs a model key). Do not ask the person to install another agent."
- START-HERE prerequisites: "an AI assistant that can run commands on your computer (for example Claude Code, Antigravity, Codex; Claude Code is the one TaskFollow has tested most)". Steps 3–4 keep the Claude Code commands under the heading "If you use Claude Code", plus one line: "With another assistant, open it in the folder from step 4 and paste the same sentence."
- Antigravity (D114, D170a): one sentence in START-HERE and the README row: "Antigravity can install and use TaskFollow with you in its chat; TaskFollow never starts Antigravity on its own, because Antigravity's terms forbid that (read 2026-10-09)."
- Cowork, one paragraph in START-HERE and README: "Claude Cowork on the web has no terminal, so it cannot install TaskFollow. Install with an assistant that has one; TaskFollow can then hand a workflow that only reads and reports to Cowork, as a skill you upload and a scheduled task you paste (INSTALL.md 9c)."

- Operator rule 10 (`INSTALL.md:253`) says "of your agent file (CLAUDE.md, or AGENTS.md on other agents)" instead of naming only CLAUDE.md (pre-build check finding 5). D175 adds no operator rule (rule 14 is at `INSTALL.md:259`, rule 15 is item 8's).
- Anchors (pre-build check finding 9): INSTALL.md point 4 at `:14`, point 1 at `:11`; START-HERE `:6` (prerequisites), `:23-51` (steps 3–4), `:65` (last bullet).
- INSTALL.md "Before you start" point 1's restart line ("quit Claude Code … `claude --continue`") becomes agent-neutral: "if you have to restart, the person opens their assistant again in the same folder and says 'carry on with TaskFollow' (Claude Code: `claude --continue`)". START-HERE's last bullet gets the same wording.

Tests (doc text): "INSTALL.md does not ask the person to install Claude Code", "the restart line names Claude Code only as an example". Update `tests/e2e/install-doc.test.ts:116-117`, which asserts /quit Claude Code and open it again/, in the same commit, "START-HERE names an assistant other than Claude Code", "README's Antigravity row says it can be used in chat", "START-HERE says Cowork on the web cannot install TaskFollow".

### Task 6 — B: §9.13 leftovers

Files: `package.json` (`description`), `INSTALL.md` title and first paragraph, `README.md` status line, `docs/next-steps.md`, `tests/e2e/install-doc.test.ts`.

- `package.json` description: "A thin layer on the AI agent you already have: step-by-step setup, workflows with a person's approval, and honest feedback on what your agent can do".
- INSTALL.md title "# Set up TaskFollow", first line: "You are the operator of this install. A person asked you to set up TaskFollow on the agent they already have (you). Follow these steps exactly." (Check every test that quotes the old title first; update it in the same commit.)
- README "Status" (`:14`): "v1 in progress (scope: docs/scope-refresh.md section 9); see docs/next-steps.md". Remove "Plans 1–11 implemented". README `:15` ("The package is not published (`"private": true`)") goes with Task 10. The agent table rows for Antigravity (`:36`) and "Any other agent" (`:37`) are reworded with Task 5 (any agent installs and uses TaskFollow in chat; `.agents/skills`, AGENTS.md). `docs/next-steps.md:24`'s stale sentence goes with the rewrite.
- `docs/next-steps.md` rewritten from §9, short and current: Done (v1 items with PR and decision), In progress, The owner's tasks (pointer to human-tasks.md), Postponed (D170b level 2, WhatsApp extras, other agents' profiles), Rules to keep. Drop the stale test counts and "the full rewrite comes once…". Keep the build map table (it traces bugs to PRs).

Tests: "package.json's description does not say Skills Wiki solutions", "INSTALL.md's first line says set up TaskFollow".

### Task 7 — C1: the email page says whose mailbox it reads

Files: `src/core/email-page.ts` (`connect`, `CONNECTED_PAGE`), `src/core/email-presets.ts` (read only), `tests/unit/email-page.test.ts`.

- Before the mailbox check: when `setup.imap.user` or `setup.smtp.user` differs from the address (case-insensitive), and it is not the preset's `local` form (the part before `@`, `email-presets.ts:149`), and the form has no `confirm_user=yes`, re-render with: "The sign-in name <user> is not the address <address>: TaskFollow will read <user>'s inbox and send as <address>. If that is what you want, tick the box and connect again." plus a checkbox `confirm_user`.
- The Connected page names the mailbox: "Your mailbox <user> is connected (TaskFollow reads its inbox). Go back to the chat and tell your assistant. You can close this tab."

Tests:
- "the email page refuses a sign-in name that differs from the address until the box is ticked".
- "the email page accepts a sign-in name that is the preset's local part".
- "the Connected page names the mailbox that is read".
- "a ticked box connects with the different sign-in name".
- "an SMTP sign-in name that differs from the address is caught too".

### Task 8 — C2: how to join, in the exact words

Files: `solutions/starter.json` (`channels.join-solo` and the Telegram join step; find `"Send the code it prints`), `solutions/starter-skillswiki.json` (the two join steps), `src/core/actions.ts` (the "has not joined yet" hint), `INSTALL.md` §7 items 1, 2 and 5, tests `starter-minimum.test.ts`, `actions.test.ts`. Anchors (pre-build check): `starter.json:1669` (team) and `:1713` (solo), `starter-skillswiki.json:107` and `:110`, `actions.ts:210`, INSTALL §7 item 2 (`:89`) and item 5 (`:93`). (The review also named the `members.ts:13` comment; it already says `/join CODE`, the start link, or an email whose first line is `JOIN CODE`, so it stays.)

- The instruction becomes: "Follow the line `taskfollow invite` printed for your channel: on Telegram open the link or send `/join <code>`; by email, send an email whose first line is `JOIN <code>`; in Slack, send `JOIN <code>` to the app". The Telegram-only step: "on Telegram open the link it printed, or send `/join <code>` to the bot".
- `actions.ts` hint ends the same way.

Tests: "no join step tells the person to send the bare code", "the email join instruction says the first line is JOIN <code>".

### Task 9 — C3: a dry run shows the call it would ask to approve

Files: `src/core/runner-steps.ts` (`runApprove`, the `agent_call` sandbox branch), `src/core/outbound.ts` (read only: `recordAction`), `tests/unit/agent-call.test.ts` (the test asserting `output: null` for the sandbox case).

- In the sandbox branch: `const recorded = await recordAction(exec.home, { tool: step.tool, args }, prepared.level, now(exec), \`${record.workflow}/${record.run_id}\`)`; save it as the step output, **keeping `skipped: true` on the saved log** (`why.ts:90` and `:208` rely on it), and return it. Nothing reaches the agent.

Tests:
- "a dry run of an agent_call step records the exact call in the outbox and shows it in would_have".
- The existing sandbox test changes from `output: null` to the recorded action.
- "a dry run of an agent_call step does not run the agent" (kept).

### Task 10 — npm: a tarball is never stale

Files: `package.json` (`scripts`), `START-HERE.md` (one note), `tests/unit/package.test.ts` (or the release checklist test, if one exists).

- `"prepack": "npm run build"`.
- Remove `"private": true` (`package.json:4`): it makes `npm publish` refuse, which would block the owner's publish. The owner still runs the publish.
- START-HERE, under the install sentence: "Before TaskFollow is published, the person who invited you sends a file `taskfollow-<version>.tgz`; run `npm install -g <that file>` first, then use the same sentence."

Tests, in `tests/e2e/release.test.ts` (next to the pack tests at :23-30): "package.json builds before packing", "package.json is not private".

### Task 11 — docs and the decision

D175 in DECISIONS.md (the findings and fixes, the `.agents/skills` evidence with its date), the build map row in `docs/next-steps.md`, human task 42 in `docs/human-tasks.md`.

## Human task 42 (about 30 minutes; 40 is the highest on main, item 8 takes 41, this item takes 42): install on an agent TaskFollow has no profile for

On Antigravity (or any agent a friend has): first read Antigravity's current terms (the clause on other programs, D114) and tell Claude whether it still stands. Then, in a throwaway folder, paste the one-sentence install into Antigravity's chat and go through setup on your own; add one report-only workflow and run it once by asking in chat. Tell Claude where it confused you, where it stopped, and what the report's Agent line said.

## Risks

- `.agents/skills/` may not be read by a given agent; the `AGENTS.md` section names the paths, so the agent can still read them when asked. The report must not claim the agent loads them (R5).
- Making `preflight.tools` non-blocking means a Claude Code install whose MCP registration really fails also goes on; it lands under "Limited" with the hint, and the doability check's T5 reports tools honestly. Accepted.
- Item 6a/6b edits move lines in `starter.json` and `INSTALL.md`; every task names text, not only lines.

## Out of scope

- New agent profiles (Antigravity stays without one, D114). Codex's profile file is unchanged (D150), but Task 4's fallback gives it `.agents/skills/`.
- Publishing to npm (the owner's account).
- An install path from Cowork on the web.
- Skills Wiki registration on an unknown agent (`starter-skillswiki.json` stays as is apart from Task 1's `preflight.tools`, which also makes it non-blocking there).
- Level 2 (D170b), WhatsApp extras.

## Plan review applied (2026-10-16)

1. Task 1: a non-blocking auto step is blocked on its first failure and left alone by `resume`; one `start` reaches the MODE questions (engine.ts:82, 115-123, 161-170, 268-269 checked).
2. Task 4: one `rootsFor` in skills.ts for installTargets, the inventory, runner.ts:55, check-reads.ts:35 and check-skill.ts:26.
3. Task 4: the fallback covers any profile without `skills_dirs`, so Codex (profiles/codex.json) gets `.agents/skills/`.
4. Task 2: a fixed agent name after a probe that found none, shared with check once (check-once.ts:37); no INSTALL `--value` instruction.
5. Task 3: without a model key the install stops at the dry run; the sentence and an e2e say so.
6. Task 3: the Runs line names Claude only for Claude Code (report.ts:91-92).
7. C3 keeps `skipped: true` and uses `prepared.level`; C1 compares the SMTP name too; C2 covers INSTALL §7 items 1–2; the restart line is agent-neutral; `"private": true` is removed. Rejected: the `members.ts:13` comment is already right.
Q1 accepted with the review's reasons; Q2 answered with sources (Task 4, D175).

## Pre-build check applied (2026-10-16, main d1ae599)

Rebased onto main after 6a (D171) and 6b (D172) merged. Applied: (1) the discovery skill follows `rootsFor` into `.agents/skills`, INSTALL 9b item 2 and the uninstall "kept" entry updated, D175 amends D172; `restoreAfterConsult` named; (2) `rootsFor` keeps the home-folder guard; (3) `skillText`'s hard-coded `.claude/skills` is verified after item 8 and routed through the written path if still there; (4) `noFolderNote` on `!workDirKnown` alone; (5) operator rule 10 names AGENTS.md; (6) the e2e uses the pinned starter with the `missing-agent` profile and never strips PATH; (7) engine tests in `engine-failure.test.ts`, anchors refreshed; (8) `report.test.ts:108-113` rewritten with Task 3; (9) `install-doc.test.ts:116-117` updated with Task 5; (10) README :14/:15/:36/:37, release tests in `release.test.ts`, next-steps :24; (11) join-wording anchors; (12) human task 42 with 40 the highest on main. All citations checked on d1ae599.
