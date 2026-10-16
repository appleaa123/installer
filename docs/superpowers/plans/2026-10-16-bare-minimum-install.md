# The bare-minimum install (9.12, item 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on their own can install and use TaskFollow with nothing but their agent and the one service a workflow reads: Telegram becomes optional, scheduled results wait in the run record and the agent tells the person when they next speak (level 1), the report says honestly how the person is told and where runs happen, and the product description says what TaskFollow is now.

**Architecture:** Step conditions gain an `any` form, so the starter can ask a solo person whether they want Telegram and show Telegram, gateway and join steps only when a channel exists. `taskfollow why` (the list form) shows each run's result and any notice that could not be delivered, both read from what is already stored. INSTALL.md gains the session-start rule. The report gains two lines: how you are told (level 1; level 2 named as not available yet, with the options) and where runs happen. README, START-HERE and the INSTALL.md introduction say the vision in 9.2.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Spec:** `docs/scope-refresh.md` section 9: 9.4 ("The bare minimum", the ladder, "The next level is a gap flag", "Approval when no chat session is open"), 9.12 item 3, 9.13 items 1 and 4. **Measured against:** v1 (section 9).

## Global Constraints

- Nothing new is stored: the run record already holds every result (9.4). Results and notices are read from run records and the audit.
- Telegram, email, Slack and WhatsApp stay as built and stay offered (9.8); only the requirement goes, and only for a person on their own. A team keeps a channel, because members are reached through one (D77).
- Approvals with no chat open: the person's own terminal decides (D61), an item waits 24 hours (D62). No new build there, only the operator rule.
- Level 2 is a flag, not a build (9.4: "probed and flagged only"). Claude Code Channels (research preview) cannot be checked unattended: it needs `--channels` with an Anthropic-allowlisted plugin, events reach only an open interactive session, and the flag is not in `claude --help` during the preview (code.claude.com/docs/en/channels.md, read 2026-10-16). The report says so plainly; nothing claims a level that was not tested (R5, section 6).
- Plain words in everything the person sees. INSTALL.md stays free of industry words (`tests/unit/neutrality.test.ts`) and names Skills Wiki only from section 11 on (`tests/e2e/install-doc.test.ts`).
- Tests never touch the real `~/.claude`; `npm run typecheck` and the full `npm test` twice before the PR.

## Review Focus

1. **An existing install answered under the old starter.** Its state has no `services.telegram` answer. Conditions on a step that was never asked must not hide steps already done, and `taskfollow report` must not break. The pinned solution of an old install stays its own version; only new installs get 1.9.0.
2. **A team.** `mode.who = team` must still get Telegram and the join step exactly as today.
3. **A solo person who picks email but not Telegram.** The gateway must start (email is a channel), and the join step must name the mailbox, not Telegram.
4. **No channel at all, then a workflow sends `channel.notify`.** The suggested workflows must end with the result instead of failing the run.
5. **`why` on a home with damaged or very old run records.** A missing step log or an unparseable output must show no result, not crash.

---

### Task 1: `any` in a step's condition

**Files:** `src/core/types.ts` (`StepWhen`), `src/core/visibility.ts` (`whenHolds`), `src/core/solution.ts` (`checkWhen` and the parser), tests in `tests/unit/visibility*.test.ts` or `tests/unit/solution*.test.ts` (wherever `when` is tested now; add there).

**Interfaces:**
- `StepWhen` becomes `{ step: string; equals?: string; includes?: string } | { any: readonly StepWhen[] }` (one level; an `any` inside `any` is refused).
- `whenHolds({ any })` is true when one of them holds.
- `checkWhen` checks each part as today (each `step` names an earlier ask step; `equals`/`includes` is one of its options); `any` must list 2 to 8 parts.

- [ ] Failing tests: `any` true when one part holds, false when none; a part naming a step that was never answered counts as false (Review Focus 1); the parser refuses an empty `any`, a nested `any`, and a part naming a later step. Then implement; tests pass; commit `feat(solution): a step can be shown when any of several answers holds`.

### Task 2: The starter without Telegram for a person on their own (1.9.0)

**Files:** `solutions/starter.json`, tests that read the starter (`tests/unit/install-examples.test.ts`, `tests/unit/solution-refs.test.ts`, `tests/unit/watch.test.ts`, `tests/e2e/*` that walk the starter; find them with `grep -rln starter tests`), a new `tests/unit/starter-minimum.test.ts`.

Changes:
- New ask step `services.telegram` after `services.records`, `when: {step: "mode.who", equals: "me"}`: title *"Do you also want to be told on your phone, through Telegram, when you are away from the computer?"*; why *"Without it, your assistant tells you what happened here, in this chat, the next time you talk to it. Telegram is a free app; you can add it later with 'taskfollow add telegram'."*; options `["telegram", "none"]`, default `"none"`.
- `services.email` title: *"Should your assistant also use an email inbox?"* (drops "Besides Telegram").
- `channels.telegram-key`, `channels.telegram`: `when: {any: [{step: "mode.who", equals: "team"}, {step: "services.telegram", equals: "telegram"}]}`.
- `channels.gateway` and `activate.gateway`: `when: {any: [team, telegram, email=email, slack=slack, whatsapp=whatsapp]}`.
- `channels.join-solo`: `when: {any: [telegram=telegram, email=email]}`; title *"Link yourself to your assistant"*; instructions *"Send the code it prints to your Telegram bot, or by email from your own address to the assistant's mailbox"*.
- `mode.always-on`: no `when` (asked of everyone, 9.13 item 4); title *"Must your workflows run even when this computer is closed or asleep?"*; why *"Scheduled work runs only while this computer is on and awake; a run it misses is skipped, not run late. If it must run anyway, it needs a computer that stays on (a team host), which the helper can set up later."* `mode.derive-solo` takes `always_on` from `mode.always-on`.
- The two suggested workflows end with their result when nobody joined a channel: their instructions gain *"If channel.list shows nobody who joined a channel, send nothing and finish with the note as your summary: the person reads it the next time they talk to their agent."*
- `taskfollow add telegram` must work for a solo person who said `none` (D134's `add` reopens a `services.*` choice): check `addableOptions` lists `telegram`; if `add` only knows the four old services, add `telegram` to what it reopens.
- `version` 1.9.0.

- [ ] Failing tests (`starter-minimum.test.ts`, on the starter's visible steps after given answers, with `visibleSteps`):
  - solo + telegram none + email none: no `channels.*` step, no `activate.gateway`; `mode.always-on` is asked;
  - solo + telegram: the two Telegram steps, the gateway, `channels.join-solo`;
  - solo + email only: email steps, gateway, `join-solo`, no Telegram steps (Review Focus 3);
  - team: Telegram steps, gateway, `channels.join`, no `services.telegram` question (Review Focus 2);
  - the report's `can_add` offers `telegram` to a solo person who said none.
- [ ] Update every existing test that walks the starter's answers (new question, new defaults). Then implement; tests pass; commit `feat(starter): Telegram is optional for a person on their own (1.9.0)`.

### Task 3: `why` shows each run's result and the notices nobody received

**Files:** `src/core/why.ts` (list form, `renderWhy`), `tests/unit/why*.test.ts`.

**Interfaces:**
- Each listed run gains `result?: string`: the agent step's summary when the run ended in an agent step, otherwise the last done step's output as compact JSON; at most 300 characters (`…` when cut); absent when nothing readable (Review Focus 5).
- The list gains `undelivered: { at, what }[]`: audit entries since `since` whose payload has `delivered: false` (back online, escalations, doctor and shadow notices, daily reports): `what` = the payload's `text` when present, else the event name in words (`runner.back_online` → *"The computer was off or asleep; missed runs: …"*).
- `renderWhy` prints a `result:` line under each run and a block *"Messages nobody received (no channel):"* when there are any.

- [ ] Failing tests: a typed run's last output and an agentic run's summary appear; a 400-character output is cut at 300; a run with a missing step file shows no result; an undelivered back-online notice and an escalation appear with plain words; a delivered one does not. Implement; pass; commit `feat(why): show each run's result and the messages nobody received`.

### Task 4: How the person is told, and where runs happen, in the report

**Files:** `src/core/report.ts` (`Report`, `buildReport`, `renderReport`), `profiles/claude-code.json` (`push`), `src/core/profile.ts`, `tests/unit/report*.test.ts`.

**Interfaces:**
- Profile field `push?: { status: "preview" | "none"; note: string }`. `claude-code.json`: `{"status": "preview", "note": "Claude Code Channels (research preview): only with --channels and an allowlisted plugin, only while a chat window is open; it cannot be checked unattended"}`. Codex: absent (unknown → said so).
- `Report.told: { level: 1 | 3; how: string; next_level: string }`: level 3 when any channel step is done (Telegram, email, Slack), otherwise level 1, *"in your agent's chat, the next time you talk to it (scheduled results wait in the run record)"*. `next_level` is the gap flag in section 6's words: *"Your agent cannot start a conversation by itself here (<profile push note, or 'not checked for this agent'>). To be told at a set time while you are away, keep this computer on, and add Telegram or email ('taskfollow add telegram')."* For level 3 it names the channels instead.
- `Report.runs: string`: from `mode.always-on`: `no` → *"Scheduled runs happen on this computer while it is on and awake; a run it misses is skipped. They use your own Claude plan."*; `yes` → *"…on a computer that stays on (team host, INSTALL.md section 10). They use your own Claude plan."*; not answered → absent.
- `renderReport` prints `💬 Told` and `🕒 Runs` lines.
- The runtime support level and `overall` do not change because of level 1 (a channel-less install is not a limit, 9.4).

- [ ] Failing tests: solo no channel → level 1 with the gap text and the Claude Code note; a done Telegram step → level 3; `mode.always-on` no/yes → the two run sentences; an old state without the answer → no `runs`. Implement; pass; commit `feat(report): say how the person is told and where runs happen`.

### Task 5: The operator rules and the documents (9.4, 9.13 item 1)

**Files:** `INSTALL.md`, `START-HERE.md`, `README.md`, `tests/e2e/install-doc.test.ts` if it pins wording it no longer finds.

- INSTALL.md introduction: one paragraph with the vision of 9.2 in plain words (a thin layer on the agent the person already has; it sets up, finds and runs workflows, reminds the agent of skills; hard rules always ask a person).
- "Before you start", point 3: Telegram is optional (*"the Telegram app only if they want to be told on their phone when away from the computer"*).
- Section 7 title *"Channels (optional for a person on their own)"*, first line: a person on their own needs none; results wait in their agent's chat.
- Section 8, point 2 (the report): only when a channel exists.
- Operator rules gain:
  - *"At the start of each session with the person, run `taskfollow approvals list` and `taskfollow why <the day of your last session with them, or yesterday>`. Tell them in plain words what is waiting for their approval (they decide in their own terminal: give the complete command), what each scheduled run found, and any message nobody received."*
  - *"When the person wants to be told while away, or at a set time on a laptop that will be closed, say what their setup gives and what it does not, as the report's 'Told' line does, and offer the options there. Never promise a message their setup cannot send."*
- START-HERE: the list of what the person needs drops Telegram (*"Telegram only if you want messages on your phone"*); the first paragraph says what TaskFollow is in one sentence from 9.2.
- README: the opening paragraph says the vision of 9.2 (it still says "deploys Skills Wiki solutions onto a client's own AI agent"); "Who can use it today" says Telegram is optional.

- [ ] Run `install-doc`, `neutrality`, `install-examples`; commit `docs: TaskFollow as a thin layer; Telegram optional; session-start rule`.

### Task 6: My own check (task 31) and the record

Run by me on the owner's Mac, same discipline as tasks 29 and 30 (settings checksum before and after; `installer` MCP entry removed by hand; never `uninstall`; throwaway folders and the probe's transcript folder removed).

1. From a throwaway install folder: `start --solution starter`, then answer with `submit`: `mode.who me`, `mode.name`, `mode.always-on no`, `services.records none`, `services.telegram none`, `services.email none`, `services.slack none`, `services.whatsapp none`. Expect: `next` goes from the services questions straight to WORKFLOWS (`workflows.sandbox`), with no channel step.
2. `report`: the `💬 Told` line says level 1 with the Claude Code Channels note; the `🕒 Runs` line says this computer.
3. Add a workflow from plain words whose agent ends with a summary; `run` it; `why` shows the run with its `result`.
4. A normal `claude -p --tools ""` in the install folder is not part of this item (no chat behaviour changes here); the session-start rule is checked in the final human session.

Record: D155 in `DECISIONS.md` (the `any` condition, the starter 1.9.0 changes, `why` results and undelivered messages, the report lines, the level-2 finding with its source, the documents), task 31 in `docs/human-tasks.md`, the build map row in `docs/next-steps.md`.

### Task 7: PR

`npm run typecheck`, full `npm test` twice, a Fable review of the branch, the PR description in plain words (what was built and why, what the person sees, building blocks with files and messages, how it was tested), merge under the owner's session authorization.
