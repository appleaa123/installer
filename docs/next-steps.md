# TaskFollow: where things stand and what to do next

Last updated 2026-10-16.

## Done (merged into `main` on 2026-10-15)

Merged in order with your approval; `main` before the merge is tagged `pre-stack-merge-2`.

| PR | Branch | What it does | Decision |
|---|---|---|---|
| #31 | `feat/agent-tasks` | Workflows hand work to the person's own agent (MCP servers, CLIs such as the Shopify CLI). Restricted run, a hook as the gate, every call recorded with the agent's reason, `taskfollow why`. | D136–D142 |
| #32 | `feat/email-reply` | Reads HTML-only email; replies stay in the customer's thread (`reply_to`). | D143 |
| #33 | `feat/calc` | `calc` step for report numbers; comparison with the previous run (`previous.<step>`). | D144 |
| #34 | `feat/store-example` | Setup interview ("walk me through your week"); two Shopify example workflows in INSTALL.md §9b (tested as written). Starter 1.6.0. | D145 |
| #35 | `feat/watch` | Opt-in record of the agent's direct calls to watched services (hook in `~/.claude/settings.json`); `why direct`. | D146 |
| #36 | `feat/watch-ask` | Always-ask list (Claude Code's own `permissions.ask`); "I noticed" suggestions, sent only to the person who asked. | D147, D148 |
| #37 | `feat/whatsapp` | WhatsApp for customers through a relay in the client's own Cloudflare account; 24-hour window; 3-step setup page. Starter 1.7.0. | D149 |
| #38 | `feat/codex` | Task 25 and 26 follow-ups: the record keeps constants like `CREATED_AT`; the task gate waits 30 s, not 5; `watch on`/`ask` refuse for agents other than Claude Code; `unask` leaves no empty `permissions` and says what it did. Codex research and reviewed plan, postponed. | D150 |

Last full test run: 135 files, 1,868 tests, twice in a row with no failures (after the flaky-test fix on `fix/flaky-tests`). Task steps and watching are proven on the real Claude Code (tasks 25 and 26); everything else is tested against fakes only.

## v1 (scope: `docs/scope-refresh.md` section 9, D152)

The full rewrite of this file from section 9 comes once the current scope is finished (9.13 item 2, after #40). Until then, v1 progress is kept here.

1. ~~Build item 1, the spike~~ **done 2026-10-15 (task 29, D153):** a restricted task run loads only Claude Code's built-in skills, not the owner's, the folder's or plugins', and neither a `/skill` prefix nor `--add-dir` changes that. So the runner puts the workflow's skill text into the task prompt (9.5's fallback, like D83).
2. ~~Build item 2, skills reminded, not controlled~~ **built (D154)**: `taskfollow skills`, skills in every run's prompt, the workflow's own skill folder, the `CLAUDE.md` section, uninstall.
3. ~~Build item 3, the bare-minimum install~~ **built (D155)**: Telegram optional for a person on their own, results in `why`, the session-start rule, the report's Told and Runs lines, the vision in README/START-HERE/INSTALL. Next: item 4, the level-B step.
**Follow-ups (not yet planned):**

- A weekly unattended re-check of T5 and preflight T7 for profile agents, in its own guarded tick pass with its own timeout and weekly marker (spec section 8, D162). Until then the doctor reports stale results and a real successful run refreshes `runner`/`tools`.
- B7's `tools` half: a failed or refused `mcp__installer__*` call in a run lowers `tools` too (D162).
- From task 28 (D167): the dry run of an `agent_call` step shows the call it would ask to approve; the setup step's words say `JOIN <code>` for email; the email page warns when the address and the login account differ.

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
| 6b, the interview, the opportunity rule and discovery | (this PR) | D172 | `solutions/starter.json` 2.3.0 (`workflows.choose`, `consult.choose`, step `workflows.discovery`), `solutions/skills/find-my-repetitive-work/SKILL.md`, `workflow-skill.ts` (`writeDiscoverySkill`), `actions.ts` (`discovery_skill`), `consult.ts` (written again after a consult), `agent-file.ts` (the opportunity line), INSTALL.md 9b items 1–2 and operator rule 14 | The interview proposes the shipped workflows first and asks which tool you use; it ends with "Not sure what repeats in your week? Ask me to find your repetitive work any time."; `.claude/skills/find-my-repetitive-work/` in the install folder |

4. **#40 merged (2026-10-16):** task 28 passed (D167) and its three fixes went in; #40 itself landed on its stale stacked base `fix/flaky-tests` by mistake, so the same reviewed branch was merged into `main` through #58. Item 5 (inbox triage, D168) is built as #59, waiting for your review and human task 37; item 6 follows from its reviewed plan (`feat/workflows-four`; discovery D165, the owner's choices D166).

## For you to do (checklists in `docs/human-tasks.md`)

1. ~~Task 25~~ **done 2026-10-15**: one bug found and fixed (Claude Code's `StructuredOutput` tool), now on #31–#37; your MCP servers do load in restricted mode.
2. ~~Task 26~~ **done 2026-10-15**: all six steps passed; an ask rule wins over an allow rule for the same command.
3. ~~Task 28~~ **done 2026-10-16** (D167): the approved call worked on the real Claude Code; three fixes on #40.
4. **Task 27 (about 1 hour).** WhatsApp with Meta's free test number and a free Cloudflare account.
5. **Tasks 21–24, still open.** Real mailboxes (21), a Windows 11 PC (22), a real-person install test (23), a real Slack workspace (24).
6. ~~Merge #31 → #38~~ **done 2026-10-15.**
7. **Publish to npm.** Needs your account: the `taskfollow` package, so `npx --yes taskfollow instructions` works.
8. **On or after 2026-10-22:** re-run the Google token check and record the result in D123.
9. **Tasks 38 and 39 (item 6a, D171, about 40 minutes).** Your Claude Code reads only the file TaskFollow chose (an invoice PDF, a meeting note); then an invoice and a meeting, end to end, with your yes.
10. **Task 40 (item 6b, D172, about 10 minutes).** Ask your agent to "find my repetitive work" on the test Gmail: it quotes nothing, names nobody, and TaskFollow receives only the workflow you choose.

## Postponed on purpose (next coding work, in suggested order)

1. **Codex and other agents: researched and postponed (D150).** No Codex account to prove it in real use. The reviewed plan with Fable's 20 findings is in `docs/superpowers/plans/2026-10-15-codex-agents.md`; pick it up when someone can test with Codex (a pay-per-use OpenAI API key would do).
2. ~~Draft → a person approves → the agent publishes~~ **built on `feat/approve-agent-call` (D151)**: an `approve` step with `agent_call` approves one exact call to the agent's MCP tool, and the agent may then make only that call, once. Also hardens every task step (`onFailure: "block"`, Claude Code 2.1.295). Needs human task 28 on the real store.
3. ~~`why` as an MCP tool~~ **built (D169)**: `why.show` on TaskFollow's MCP server, the same answers as `taskfollow why`.
4. **WhatsApp extras:** message templates, media, team members on WhatsApp.
5. **Re-run certification** on the final build.
6. ~~Flaky tests~~ **fixed on `fix/flaky-tests`**: one keychain was shared by all test files, and the watch uninstall tests deleted the Skills Wiki key others had just stored (`shadow`, `packs`, `learning`); the Slack tests could mistake the previous test's closing connection for their own.

## Rules to keep

- Ask before merging any PR.
- Never paste keys or tokens into chat; they're entered only on the local setup pages.
- Client data and keys live in the client's own accounts, never the owner's.
- Tests must never touch the real `~/.claude`: after each test run, `claude mcp list` should show no installer or taskfollow entries, and `~/.claude/settings.json` should have no `watch-hook`.
- Write the plan first, have Fable review it (it found real problems every time), then build test-first.
- Don't edit files while the full test suite is running.
