# TaskFollow: where things stand and what to do next

Last updated 2026-10-19. The scope is `docs/scope-refresh.md` section 9 (D152, widened by D156); the owner's later choices are D165–D170. This file is the short, current view; `DECISIONS.md` is the record.

## Done

The current scope (9.1) is finished: approve-agent-call (#40 via #58, D151, task 28 passed D167), the flaky tests (#39). v1 items built and merged: the spike (D153), skills reminded (D154), the bare-minimum install (D155), the doability check (D159–D163), "I noticed" without a channel (D164), inbox triage (D168), `why.show` (D169), the four back-office workflows and invoices due (D171), the interview, the opportunity rule and discovery (D172), learning into `my-rules.md` (D173), the weekly re-check (D174), real-user readiness (D175, #64).

**Build map** (to trace a bug from a terminal result to its PR; each PR's description lists the same):

| Item | PR | Decision | Files | What you see |
|---|---|---|---|---|
| 1, spike | #43 | D153 | `docs/testing/task29-spike.sh` | (test only) |
| 2, skills | #44 | D154 | `src/core/skills.ts`, `workflow-skill.ts`, `agent-file.ts`, `lifecycle.ts` (workflow add), `runner.ts` + `agent-task.ts`/`judge.ts`/`agentic.ts` (prompts), `uninstall.ts` | `taskfollow skills`; `.claude/skills/<workflow>/` and a "TaskFollow workflows" section in `CLAUDE.md` in the install folder; "The skill '…' could not be read" when a run fails on a skill |
| 3, bare minimum | #45 | D155 | `solutions/starter.json` 1.9.0, `src/core/solution.ts` + `visibility.ts` (`any`), `services.ts`, `why.ts`, `report.ts`, `profiles/claude-code.json` (`push`), INSTALL.md, START-HERE.md, README.md | the Telegram question; "💬 Told" and "🕒 Runs" in `taskfollow report`; "result:" and "(nobody was told: no channel)" in `taskfollow why` |
| 4a, doability core | #50 | D159 | `src/core/words.ts`, `checks.ts`, `check-page.ts`, `check-commands.ts`, `check-runner.ts`, `check-tools.ts`, `homes.ts` | `taskfollow check start` (t1, t5, t7, describe), `check home`, `check list`; a page in your browser with a word shown once; "🔎 Checked" in the report |
| 4b, doability Home 2 | #51 | D160 | `src/core/check-once.ts`, `check-email.ts`, `check-plant.ts`, `check-schedule.ts`, `check-schedule-form.ts`, `check-forms.ts`, `check-summary.ts`, `deliver.ts`, `zip.ts` | `taskfollow check once`, `check start t2`/`t8`, `check cannot`, `check deliver` (a skill zip in `<install folder>/taskfollow-deliver/`), `check summary`, `check missed`; the T8 checklist page; "Sent by your scheduled TaskFollow workflow …" at the end of a Cowork brief |
| 7a, doability rest | #54 | D162 | `src/core/check-reads.ts`, `check-write.ts`, `check-skill.ts`, `check-asks.ts`, `check-asks-form.ts`, `check-fresh.ts`, `check-runner.ts` (T11), `sheets.ts` (tabs) | `taskfollow check start t2a`/`t2f`/`t2r`/`t3f`/`t3r`/`t4`/`t6`/`t6b`/`t11`; "Not run: this workflow's check of TaskFollow's runner no longer holds" from a stopped run; a "checks" line in `taskfollow doctor` |
| 7b, the four-part page and the consult mode | #55 | D163 | `src/core/gap-words.ts`, `check-summary.ts`, `consult.ts`, `services.ts` (`add install`), `actions.ts` (`consult_report`, `consult_cleanup`), `solutions/starter.json` 2.0.0 | `taskfollow check summary` shows every need, each gap in four parts; the install's first question (install or consult); `exports/consult-report-<date>.md`; `taskfollow add install` after a consultation |
| 5, inbox triage | #59 | D168 | `src/core/channel-tools.ts` (`channel.inbox` `after`), `runs.ts` (`newestStepOutput`), `runner-steps.ts` + `workflow.ts` (`"last-run"`), `workflow-skill.ts` (shipped skills, `examples.md`), `lifecycle.ts` (a suggestion's time), `why.ts` (the whole result), `solutions/shapes/`, `solutions/starter.json` 2.1.0, INSTALL.md 9, 9b, rule 11 | `taskfollow workflow add inbox-triage`, the daily list, `taskfollow why <run id>` |
| `why` as an MCP tool | #60 | D169 | `src/core/why-tools.ts` (`why.show`), `why.ts` (patterns exported), `tool-set.ts`, INSTALL.md rule 11 | An agent without a shell answers "what happened, and why?" from TaskFollow's records (`mcp__installer__why_show`), the same JSON as `taskfollow why` |
| 6a, the four workflows and invoices due | #61 | D171 | `solutions/starter.json` 2.2.0 (records `lead`, `invoice`, `action`; five suggestions), `solutions/shapes/{lead-qualification,crm-update,invoice-processing,invoices-due,meeting-follow-up}/SKILL.md`, `homes.ts` (`SHAPES`), `task-files.ts` + `workflow.ts` + `task-step.ts` + `agent-task.ts` + `agent-hook.ts` (`Read`), `calc.ts` + `runner-steps.ts` (`where`), `lifecycle.ts` + `workflow-skill.ts` + `consult.ts` (`meeting-notes/`), INSTALL.md 9e | `taskfollow workflow suggestions` offers the five with a Google Sheet; their runs end with one result line; "Refused: this step may read only the files TaskFollow gave it."; uninstall says "meeting-notes/ was left: it holds your notes" |
| 6b, the interview, the opportunity rule and discovery | #62 | D172 | `solutions/starter.json` 2.3.0 (`workflows.choose`, `consult.choose`, step `workflows.discovery`), `solutions/skills/find-my-repetitive-work/SKILL.md`, `workflow-skill.ts` (`writeDiscoverySkill`), `actions.ts` (`discovery_skill`), `consult.ts` (written again after a consult), `agent-file.ts` (the opportunity line), INSTALL.md 9b items 1–2 and operator rule 14 | The interview proposes the shipped workflows first and asks which tool you use; it ends with "Not sure what repeats in your week? Ask me to find your repetitive work any time."; `.claude/skills/find-my-repetitive-work/` in the install folder |
| 8, learning into my-rules.md | #63 | D173 | `src/core/learning.ts` (rule candidates, `learningsCommand`), `workflow-skill.ts` (`appendRule`, `NO_RULES_YET`), `lifecycle.ts` (`workflow rule`), `why.ts` + `why-tools.ts` (`rule_candidates`), `consult.ts` (`consultKeptRules`), `deliver.ts` (`deliveredZip`, the recorded folder), `tick.ts`, `cli.ts` (`learnings dismiss`), INSTALL.md rules 11 and 15, section 9 and 9b | `taskfollow workflow rule <id> --value '{"rule":"…"}'`; `why` lists "Corrections to turn into rules"; `taskfollow learnings [dismiss <n>]` |
| Real-user readiness | #64 | D175 | `src/core/engine.ts` (a non-blocking auto step is blocked at once), `solutions/starter.json` + `starter-skillswiki.json` (`preflight.tools` not blocking; join lines), `check-commands.ts` (`UNPROFILED_AGENT`), `report.ts` (Agent and Runs lines), `skills.ts` (`.agents/skills`), `workflow-skill.ts` (`AGENTS.md`), `deliver.ts`, `email-page.ts` (sign-in name), `runner-steps.ts` (dry run of `agent_call`), `package.json` (`prepack`, not private), INSTALL.md, START-HERE.md, README.md | An install on any agent that can run commands reaches the questions; the report says in plain words what runs and what needs a model key; skills in `.agents/skills` and `AGENTS.md`; the email page names whose inbox is read; a dry run shows the call it would ask to approve |
| Weekly re-check | #66 | D174 | `src/core/recheck.ts` (new: due, start, child, the check, notices), `check-runner.ts` (`quietOnError`), `tick.ts` (the `recheck` pass), `cli.ts` (`recheck-run`, the report flag), `why.ts` + `why-tools.ts` (`recheck`), `check-fresh.ts` (doctor), `report.ts` (the weekly sentence), INSTALL.md rule 11 | Nothing on a pass; on a fail, once a week: "TaskFollow's weekly check found that it can no longer run your agent…" by channel or in `why`; `taskfollow doctor` warns when it could not run |
| INSTALL.md and README refresh | (this PR) | D176 | INSTALL.md (points 5-7, sections 1, 5, 9, 9a), README.md, START-HERE.md, `tests/e2e/install-doc.test.ts` | An agent other than Claude Code is told to work out what does not work on it, within three limits; the README says what TaskFollow is and how to install it |
| Read-only hook checks shell words (security review 2026-10-22; released in 0.2.2) | #78 | D181 | `src/core/agent-hook.ts` (`shellWords`), README.md, INSTALL.md (read-only Shopify scopes) | A read-only step refuses a quoted write flag such as `--allow-"mutations"`: "This step may only read…" |

## In progress

- Nothing; the owner's real-user test is next.

## Then: v1 is done when the owner uses it as a real user (9.11)

The owner's guide for this is `docs/testing/2026-10-17-real-user-test.md`: Claude Code, Antigravity and Claude Cowork as a real user, the human-only probes folded in, and when to send it to friends.

The owner installs TaskFollow on their own agent with only TaskFollow's guidance and uses it daily; friends try it on other agents; task 23 (a non-technical person installs it); TaskFollow is on npm (0.1.1, the README fix, is `latest`) and the repository is public (task 43 done 2026-10-19, D177). Every task for a person is in `docs/human-tasks.md` (37–43 for v1).

## Follow-ups (not yet planned)

- An agent writes its own profile and runs `taskfollow certify`; when it passes, that agent may run work unattended with no separate model key (owner's idea, 2026-10-19, D176). Certification already proves a forbidden tool is refused, so an agent-written profile is trusted only after it passes.

- B7's `tools` half: a failed or refused `mcp__installer__*` call in a run lowers `tools` too (D162).
- T6b MCP tool-name hints; the outbound "recorded" path counts notices as delivered; the consult cleanup always removes the user-wide `installer` MCP registration (known limit).
- The interactive half of comparison arm A, and arm B after item 5 (D161).
- A weekly per-workflow T7 for Home 1 workflows whose own `runner` result is stale or failed, so a stopped workflow could recover by itself (D174 checks only the agent-wide runner).

## Postponed on purpose

1. Level 2, the agent speaking first in an open chat, per agent (D170b): right after TaskFollow is ready for real users.
2. Profiles for other agents (Codex proven for real, OpenClaw, Hermes): they need the owner's or a friend's accounts (D150, D170a). Until then they install and use TaskFollow in chat (D175).
3. WhatsApp extras (templates, media, members on WhatsApp): after real use.
4. Re-run certification on the final build.
5. Non-goals stay out (9.10, D170d): systems administration, new channels, anything hosted by the owner.

## Rules to keep

- Ask before merging any PR.
- Never paste keys or tokens into chat; they're entered only on the local setup pages.
- Client data and keys live in the client's own accounts, never the owner's.
- Tests must never touch the real `~/.claude`: after each test run, `claude mcp list` should show no installer or taskfollow entries, and `~/.claude/settings.json` should have no `watch-hook`.
- Write the plan first, have Fable review it (it found real problems every time), then build test-first.
- Don't edit files while the full test suite is running.
