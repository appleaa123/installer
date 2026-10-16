# Real-user readiness (D175)

Written 2026-10-16. Plan only: nothing here is built yet. Built **after items 6a and 6b**, which also edit `solutions/starter.json` and `INSTALL.md`; line numbers below are from main `5bc26c8` and may move, so every task names the text to find, not only the line.

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

- `preflight.tools` gets `"blocking": false` in both starters. Its hint stays `NO_AGENT_TOOLS_HINT`.
- The hint's last clause becomes truthful for any agent: "…no known agent to connect TaskFollow's tools to: use 'taskfollow tool <name>' for TaskFollow's tools (INSTALL.md section 5); install Claude Code only if you want the tools over MCP". (No "install a supported agent, then resume" as the only way out.)
- INSTALL.md §5 gains one sentence: "Only Claude Code registers TaskFollow's tools as an MCP server; any other agent uses `taskfollow tool <name> '<json>'`, which goes through the same approval gate."
- `starter-skillswiki.json` keeps its Skills Wiki registration steps blocking: Skills Wiki over MCP needs a known agent (`NO_AGENT_HINT`); that starter is optional (D126). Say so in Out of scope.

Tests:
- `starter-minimum.test.ts`: "preflight.tools is not blocking in either starter".
- e2e `an install on an agent with no profile reaches the MODE questions`: a scratch home, `PATH` without `claude`/`codex`, `start --solution starter`, `next` three times; expect step `mode.purpose` (or `mode.who`), and `preflight.tools` recorded `blocked` with the new hint; `report` lists it under Limited.

### Task 2 — A2: the doability page for an unknown agent

Files: `src/core/check-summary.ts` (`summaryCommand`, the `agentOf(state, undefined)` line), `src/core/check-commands.ts` (`homeOf`, `agentOf`), `INSTALL.md` §9c item 1, tests `check-summary.test.ts`, `check-commands.test.ts` (or where `agentOf` is tested).

- One helper, `runnerAgent(state)`, used by `check deliver`, `summaryCommand` and `homeOf`: the profile's name and version, else `{ agent: "no runner agent", version: null }` (today's `check deliver` fallback, moved).
- `agentOf`'s error when the probe ran but found no agent (state has `runtime` and `runtime.profile === null`): "TaskFollow knows no profile for this agent: name the agent being checked with --value '{\"agent\":\"<its name>\"}'". When no probe ran (no `runtime`), today's words stay.
- INSTALL.md 9c.1: "On an agent TaskFollow has no profile for, give its name: `taskfollow check start t1 --value '{\"agent\":\"<your name>\"}'` (the same for t5)."

Tests:
- "check summary works with no agent profile and names no runner agent".
- "check home works with no agent profile; the runner home says it cannot start this agent".
- "agentOf, after a probe that found no agent, asks for the agent's name and does not say run probe".

### Task 3 — A3 and A4: plain words about what TaskFollow can do on this agent

Files: `INSTALL.md` "Before you start", `src/core/report.ts` (`runtimeLimits`, `agentLine`), tests `report.test.ts`.

- INSTALL.md "Before you start", new point after the agent point: "**When TaskFollow cannot start you by itself** (any agent except Claude Code today): workflows that need a model's judgment run when the person asks you in chat, or on a schedule with a model key of the person's own (`taskfollow model`, then `taskfollow secret model`, section 8.3). Say this before the questions, not after."
- `runtimeLimits` with `profile` null returns one item: "TaskFollow cannot start this agent by itself: scheduled runs need a model key, or run by hand when you ask; approvals and records work through `taskfollow tool`".
- `agentLine` with no profile: `🤖 Agent      your agent (no TaskFollow profile) — <that sentence>`; the "level 0 of 3" wording is dropped for this case only.

Tests:
- "runtimeLimits for an unknown agent says in plain words what runs and what needs a key".
- "the report's agent line for an unknown agent has no 'fallbacks apply' and no level number".

### Task 4 — A5: skills and the agent file on any agent

Files: `src/core/workflow-skill.ts` (`installTargets`), `src/core/skills.ts` (listing, the note at line ~152), `src/core/agent-file.ts`, `src/core/uninstall.ts`, `src/core/lifecycle.ts` (`noFolderNote`), tests `workflow-skill.test.ts`, `skills.test.ts`, `uninstall.test.ts`.

- With no profile and a known `work_dir`, `installTargets` returns a generic target: `roots: { project: <work_dir>/.agents/skills }`, `agentFile: <work_dir>/AGENTS.md`. `AGENTS.md` is the cross-agent instructions file read by Codex, Cursor, Gemini CLI (when configured), opencode and others; `.agents/skills/` is the shared project folder of the open Agent Skills convention. **The builder confirms both against each named agent's current documentation before writing the code, records the date and links in D175, and if `.agents/skills/` is not read by any of them, uses `skills/` in the install folder with an `AGENTS.md` line pointing at it.** TaskFollow cannot know which folder an unknown agent reads; the `AGENTS.md` section names the skill paths, so an agent that reads only `AGENTS.md` still finds them.
- `taskfollow skills` lists that folder for an unknown agent, with the note "TaskFollow has no profile for this agent; it keeps workflow skills in .agents/skills and lists them in AGENTS.md".
- Written folders and the `AGENTS.md` section are recorded in `state/written.json` exactly as for Claude Code, so uninstall removes them and nothing else (D109; §9.13 item 5).
- A Claude Code install is unchanged (`.claude/skills/`, `CLAUDE.md`).

Tests:
- "an install with no agent profile writes the workflow skill under .agents/skills".
- "an install with no agent profile keeps one TaskFollow section in AGENTS.md and leaves the rest of the file alone".
- "taskfollow skills lists .agents/skills for an unknown agent".
- "uninstall removes the .agents/skills folders and the AGENTS.md section TaskFollow wrote, and nothing else".
- "a Claude Code install still writes .claude/skills and CLAUDE.md".

### Task 5 — A6 and Cowork: the words for any agent

Files: `INSTALL.md` "Before you start" point 4, `START-HERE.md` (prerequisites, steps 3–4), `README.md` (agent table), `tests/e2e/install-doc.test.ts`, the START-HERE test if one exists.

- INSTALL.md point 4 becomes: "**Which agent are you?** Say your name and version. TaskFollow has a certified profile for Claude Code; any other agent that can run commands in a terminal can install and use TaskFollow while the person is in the chat (section 5 for the tools, 'Before you start' on what needs a model key). Do not ask the person to install another agent."
- START-HERE prerequisites: "an AI assistant that can run commands on your computer (for example Claude Code, Antigravity, Codex; Claude Code is the one TaskFollow has tested most)". Steps 3–4 keep the Claude Code commands under the heading "If you use Claude Code", plus one line: "With another assistant, open it in the folder from step 4 and paste the same sentence."
- Antigravity (D114, D170a): one sentence in START-HERE and the README row: "Antigravity can install and use TaskFollow with you in its chat; TaskFollow never starts Antigravity on its own, because Antigravity's terms forbid that (read 2026-10-09)."
- Cowork, one paragraph in START-HERE and README: "Claude Cowork on the web has no terminal, so it cannot install TaskFollow. Install with an assistant that has one; TaskFollow can then hand a workflow that only reads and reports to Cowork, as a skill you upload and a scheduled task you paste (INSTALL.md 9c)."

Tests (doc text): "INSTALL.md does not ask the person to install Claude Code", "START-HERE names an assistant other than Claude Code", "README's Antigravity row says it can be used in chat", "START-HERE says Cowork on the web cannot install TaskFollow".

### Task 6 — B: §9.13 leftovers

Files: `package.json` (`description`), `INSTALL.md` title and first paragraph, `README.md` status line, `docs/next-steps.md`, `tests/e2e/install-doc.test.ts`.

- `package.json` description: "A thin layer on the AI agent you already have: step-by-step setup, workflows with a person's approval, and honest feedback on what your agent can do".
- INSTALL.md title "# Set up TaskFollow", first line: "You are the operator of this install. A person asked you to set up TaskFollow on the agent they already have (you). Follow these steps exactly." (Check every test that quotes the old title first; update it in the same commit.)
- README "Status": "v1 in progress (scope: docs/scope-refresh.md section 9); see docs/next-steps.md". Remove "Plans 1–11 implemented".
- `docs/next-steps.md` rewritten from §9, short and current: Done (v1 items with PR and decision), In progress, The owner's tasks (pointer to human-tasks.md), Postponed (D170b level 2, WhatsApp extras, other agents' profiles), Rules to keep. Drop the stale test counts and "the full rewrite comes once…". Keep the build map table (it traces bugs to PRs).

Tests: "package.json's description does not say Skills Wiki solutions", "INSTALL.md's first line says set up TaskFollow".

### Task 7 — C1: the email page says whose mailbox it reads

Files: `src/core/email-page.ts` (`connect`, `CONNECTED_PAGE`), `src/core/email-presets.ts` (read only), `tests/unit/email-page.test.ts`.

- Before the mailbox check: when `setup.imap.user` differs from the address (case-insensitive), and it is not the preset's `local` form (the part before `@`, `email-presets.ts:149`), and the form has no `confirm_user=yes`, re-render with: "The sign-in name <user> is not the address <address>: TaskFollow will read <user>'s inbox and send as <address>. If that is what you want, tick the box and connect again." plus a checkbox `confirm_user`.
- The Connected page names the mailbox: "Your mailbox <user> is connected (TaskFollow reads its inbox). Go back to the chat and tell your assistant. You can close this tab."

Tests:
- "the email page refuses a sign-in name that differs from the address until the box is ticked".
- "the email page accepts a sign-in name that is the preset's local part".
- "the Connected page names the mailbox that is read".
- "a ticked box connects with the different sign-in name".

### Task 8 — C2: how to join, in the exact words

Files: `solutions/starter.json` (`channels.join-solo` and the Telegram join step; find `"Send the code it prints`), `solutions/starter-skillswiki.json` (the two join steps), `src/core/actions.ts` (the "has not joined yet" hint), `INSTALL.md` §7 item 5, tests `starter-minimum.test.ts`, `actions.test.ts`.

- The instruction becomes: "Follow the line `taskfollow invite` printed for your channel: on Telegram open the link or send `/join <code>`; by email, send an email whose first line is `JOIN <code>`; in Slack, send `JOIN <code>` to the app". The Telegram-only step: "on Telegram open the link it printed, or send `/join <code>` to the bot".
- `actions.ts` hint ends the same way.

Tests: "no join step tells the person to send the bare code", "the email join instruction says the first line is JOIN <code>".

### Task 9 — C3: a dry run shows the call it would ask to approve

Files: `src/core/runner-steps.ts` (`runApprove`, the `agent_call` sandbox branch), `src/core/outbound.ts` (read only: `recordAction`), `tests/unit/agent-call.test.ts` (the test asserting `output: null` for the sandbox case).

- In the sandbox branch: `const recorded = await recordAction(exec.home, { tool: step.tool, args }, "L3", now(exec), \`${record.workflow}/${record.run_id}\`)`; save it as the step output and return it. Nothing reaches the agent.

Tests:
- "a dry run of an agent_call step records the exact call in the outbox and shows it in would_have".
- The existing sandbox test changes from `output: null` to the recorded action.
- "a dry run of an agent_call step does not run the agent" (kept).

### Task 10 — npm: a tarball is never stale

Files: `package.json` (`scripts`), `START-HERE.md` (one note), `tests/unit/package.test.ts` (or the release checklist test, if one exists).

- `"prepack": "npm run build"`.
- START-HERE, under the install sentence: "Before TaskFollow is published, the person who invited you sends a file `taskfollow-<version>.tgz`; run `npm install -g <that file>` first, then use the same sentence."

Test: "package.json builds before packing".

### Task 11 — docs and the decision

D175 in DECISIONS.md (the findings and fixes, the `.agents/skills` evidence with its date), the build map row in `docs/next-steps.md`, human task 42 in `docs/human-tasks.md`.

## Human task 42 (about 30 minutes): install on an agent TaskFollow has no profile for

On Antigravity (or any agent a friend has): first read Antigravity's current terms (the clause on other programs, D114) and tell Claude whether it still stands. Then, in a throwaway folder, paste the one-sentence install into Antigravity's chat and go through setup on your own; add one report-only workflow and run it once by asking in chat. Tell Claude where it confused you, where it stopped, and what the report's Agent line said.

## Risks

- `.agents/skills/` may not be read by a given agent; the `AGENTS.md` section names the paths, so the agent can still read them when asked. The report must not claim the agent loads them (R5).
- Making `preflight.tools` non-blocking means a Claude Code install whose MCP registration really fails also goes on; it lands under "Limited" with the hint, and the doability check's T5 reports tools honestly. Accepted.
- Item 6a/6b edits move lines in `starter.json` and `INSTALL.md`; every task names text, not only lines.

## Out of scope

- New agent profiles (Antigravity stays without one, D114; Codex unchanged, D150).
- Publishing to npm (the owner's account).
- An install path from Cowork on the web.
- Skills Wiki registration on an unknown agent (`starter-skillswiki.json` stays as is apart from Task 1's `preflight.tools`, which also makes it non-blocking there).
- Level 2 (D170b), WhatsApp extras.
