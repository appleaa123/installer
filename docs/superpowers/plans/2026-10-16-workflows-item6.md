# The other four workflows, item 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, in the owner's words:** *"I tell you my day, you tell me how to automate my day."* (9.4) Item 6 ships the other four back-office workflows of 9.6 (lead qualification, CRM update, invoice processing, meeting follow-up) at their minimum, has the interview propose from all five shapes, and adds the opportunity rule, with discovery as the owner settled it on 2026-10-16 (D165).

**Architecture:** The four shapes reuse what exists: starter suggestions whose ids are the `SHAPES` keys (`homes.ts`, D159), so `workflow add <id>` records the shape and its code-constant needs and hard-rule flag; typed steps (`tool`, `judge`, `calc`, `approve`, `task`) on TaskFollow's own tools (`channel.inbox`, `records.*`, `channel.send`, `channel.notify`); approve-agent-call (D151, PR #40) for the owner's own tool; the Sheets fallback (`records.*`, D67–D70) when the owner has no tool. The shape's skill follows **item 5's shape-skill format** (see "Depends on item 5"). The interview and the opportunity rule are operator text (level A). Discovery is one shipped skill run by the owner's agent in the owner's own chat; nothing in TaskFollow's code reads email or messages for it (D148 holds).

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Measured against:** v1, `docs/scope-refresh.md` 9.4, 9.5, 9.6, 9.9, section 5 (workflows delivered as skills) and section 6 (gap flags), read with 9.15 (two homes, the doability check), which wins where it differs; spec `docs/superpowers/specs/2026-10-16-doability-check.md` v3.1 sections 4 and 7; D151, D159, D163, D165.

## Order and dependencies

- **After PR #40 (D151) is merged** (9.14): the owner-named-tool path of lead qualification, CRM update, invoice processing and meeting follow-up is an `approve` step with `agent_call`; without #40 those writes have no gate and stay draft-only. Item 6 edits the same runner, approval and INSTALL.md files.
- **After item 5 (inbox triage)**, whose plan is not written yet. Item 6 uses, and does not redesign, what item 5 settles:
  1. **The shape-skill format.** How a shipped shape carries its skill (9.6: "a general workflow file plus a skill folder (section 5)"): where the template lives in the package, how `workflow add` writes it instead of the generic `skillMarkdown()` (`workflow-skill.ts`), and what stays the owner's (`references/my-rules.md`).
  2. **The test cases.** How a workflow "keeps a few of the owner's real past items as test cases" (9.6, section 5 "Testing"), and how they are rerun.
  3. **How the shape's suggestion is written** in `solutions/starter.json` (the starter's `workflows` list, `when` conditions, `"tz":"local"`), and the starter version it moves to.

  **Assumed here** (each item-6 task names where it relies on it): a template folder per shape in the package (`shapes/<id>/SKILL.md`, optional `scripts/`, `assets/`), copied by `workflow add <id>` into `.claude/skills/<id>/` with the owner's `references/my-rules.md`, and an examples file the agent fills from the interview. **If item 5 lands differently, item 6 follows item 5** and this plan is corrected before building (a one-paragraph note in this file, not a re-review).

## Global Constraints

- The hard rules (9.2) hold for every shape: replies to anyone, record writes, anything paid, and deletes go through a person, every time. Paying is never a step of any shape (9.6: "anything paid is always a person").
- The shapes' needs and hard-rule flags stay the code constant in `homes.ts` `SHAPES` (D159). Item 6 changes no entry there except where a task below says so.
- Workflows stay general; the agent picks the tools (9.6). A shipped suggestion uses only TaskFollow's own tools and the Sheets fallback, so it loads on every install. When the owner names their tool, the agent writes the workflow with `--value` (described, hard-rule by default, D159), with the owner's tool in a read-only `task` step and any write behind `approve` + `agent_call`.
- D148 holds: TaskFollow's code never reads the owner's email or messages for discovery; only patterns the owner confirms reach TaskFollow, and only as the words of a workflow they chose to add.
- Nothing is created without the owner's yes (9.4).
- Plain words; INSTALL.md free of industry words and of "Skills Wiki" before section 11.
- Tests never touch the real `~/.claude`; full `npm test` twice and `npm run typecheck` before each PR; a Fable code review before asking the owner to merge.
- **Two PRs:** 6a = Tasks 1–6 (the four shapes); 6b = Tasks 7–9 (the interview, the opportunity rule, discovery). 6b can be built in parallel with 6a once item 5 has merged; it touches the starter's interview intents, INSTALL.md 9b and the operator rules, not the runner.

## Review Focus

1. **No shape reaches a person, a record or money without an approval.** Every `channel.send`, `records.create`, `records.update` and `agent_call` in a shipped suggestion is an `approve` step (or a `tool` step whose level already makes it an approval item); a test walks each suggestion and fails on any ungated write.
2. **Shapes are recorded only when unchanged** (D159): a suggestion edited by the agent loses its shape and falls back to "described" (hard-rule unless the person confirms otherwise). No path lets the agent's file set `shape`.
3. **The invoice amount is a financial field** (L3, decision maker), and no step of the invoice shape pays.
4. **Reading a file is confined:** the new `Read(...)` task rule (Task 4) reaches only TaskFollow's saved attachments and the meeting-notes folder the install made; any other path is refused by the hook, and a `..`, a symbolic link out, or an absolute path elsewhere is refused before the agent runs.
5. **Discovery never sends anything to TaskFollow but a workflow the owner chose to add.** The discovery skill reads only through the agent's own tools, only the sources the owner names, never writes, sends or deletes, and its text names no TaskFollow command that would carry message content (no `memo.add`, no `records.*`).

---

## 6a: the four shapes

### Task 1: The fallback records (data contract)

**Files:** `solutions/starter.json` (`data_contract`), `tests/unit/starter-minimum.test.ts`, `tests/unit/solution.test.ts`.

9.6: "when the owner has no tool for the job, the agent says so; Google Sheets (`records.*`, exists) is available as the fallback record." The starter's contract has only `contact`. Add three entities, each connected only when the owner chooses the fallback for that workflow (no new DATA-phase step):

- `lead`: key `email`; `name` (text, personal, required), `email` (email, personal), `source` (text: the channel it came in on), `status` (enum: `new`, `qualified`, `not a fit`, `waiting`), `next_step` (text), `notes` (text).
- `invoice`: key `id` (text: vendor plus invoice number); `vendor` (text, required), `amount` (money, **financial**, required), `currency` (text), `due` (date), `status` (enum: `to check`, `approved to pay`, `paid`), `file` (text: the saved attachment's reference).
- `action`: key `id` (text); `what` (text, required), `owner` (text, personal), `due` (date), `meeting` (text), `status` (enum: `open`, `done`).

The agent connects one when the owner picks the fallback: `taskfollow connect <entity> --sheet new` and `taskfollow map <entity>` (D68, D69), from the workflow's step in INSTALL.md (Task 6).

- [ ] Failing tests: `starter's contract has lead, invoice and action`; `invoice.amount is tagged financial, so records.create of an invoice is L3`; `a lead's status outside its options is refused`. Implement; pass; commit `feat(starter): fallback records for leads, invoices and actions`.

### Task 2: Lead qualification

**Files:** `solutions/starter.json` (suggestion `lead-qualification`), the shape's skill template (item 5's format), tests.

9.6 row: *a message from a new contact → fit and the next step, by the owner's rules → gated: the reply; the record write → reported: new leads and their status.*

- **Trigger:** `{"event":"message.received","from":"external"}` (any TaskFollow channel the owner set up; `when`: a channel exists).
- **Steps:** `known` (`tool records.find` on `lead` by `${event.from}`) → `judge` `qualify` (input: the message, marked untrusted, and `known`; output `{new: boolean, fit: "yes"|"no"|"unsure", next_step, reply, why}`; the skill holds how to judge, the owner's rules hold what "fit" means) → `save` (`approve records.create` on `lead`, `when: qualify.new == true`) → `reply` (`approve channel.send` with `reply_to`, `when: qualify.reply != ""`).
- **Reported:** the run's result is the lead line; with no channel to the owner it waits for `why` (level 1, D155); with one, the twice-daily report already lists runs.
- **Skill (`SKILL.md`):** what a lead is, the three fit answers, that an existing contact is not a new lead, the reply's tone, "never promise a price, a date or a discount the owner's rules do not give"; `references/my-rules.md` from the interview (who is a fit, what the next step is).
- **Home:** hard rule → Home 1 when T7 passes; otherwise draft-only (Home 2: the qualification and the reply text inside the brief to the owner) or by hand. Unchanged decision code (`decideHome`).
- [ ] Failing tests: `lead-qualification loads and records its shape`; `a dry run of a new contact's message would create one lead and send one reply, both waiting for approval`; `a known contact's message creates no lead`; `the message is passed to the judge as untrusted`. Implement; pass; commit `feat(shapes): lead qualification`.

### Task 3: CRM update

**Files:** `solutions/starter.json` (suggestion `crm-update`), skill template, tests.

9.6 row: *the owner says "note that X", or a message arrives → which record, and what changes → gated: the write, with a preview → reported: what changed.*

- **Two ways in, one shape:** a message from the owner to their TaskFollow channel (`{"event":"message.received","from":"member"}`), and, with no channel, the owner saying it in chat: the agent then calls `records.update` itself through TaskFollow's tools (level 0, by hand; the same approval holds because it goes through TaskFollow's tool, which T5 proves in chat).
- **Steps:** `which` (`judge`: entity, key and the fields to change, from the note and the contract's fields) → `current` (`tool records.get`) → `change` (`approve records.update` with only the changed fields; the approval item already shows the record before and after, D70's optimistic check refuses a record changed since).
- **The preview** is the approval item (D70 shows the current values and the change); nothing new is built for it.
- **Owner's own CRM:** described workflow via `--value`: read with a `task` step, write with `approve` + `agent_call` (D151). Without #40 merged, draft-only.
- [ ] Failing tests: `crm-update from a member's note proposes one records.update with only the changed fields`; `a note naming no known record ends with a question to the owner, not a create`; `the update is refused when the record changed after the approval` (reuse D70's test helper). Implement; pass; commit `feat(shapes): CRM update`.

### Task 4: Reading a file in a task step

**Files:** `src/core/workflow.ts` (`parseMayUse`), `src/core/agent-task.ts` (`builtinTools`), `src/core/agent-hook.ts` (`matchesRule`, `decide`), `profiles/claude-code.json` only if the task command needs a flag, tests in `tests/unit/agent-hook.test.ts`, `tests/unit/agent-task.test.ts`, `tests/unit/workflow.test.ts`.

Invoice processing says *"the agent reads the file itself"* (9.6) and meeting follow-up reads `files` (`SHAPES`). A task step today allows only MCP tools and `Bash(...)`. Add one rule form, `Read(<place>)`, where `<place>` is one of two names, never a path:

- `Read(attachments)`: files under `<home>/data/inbox-files/` (D133's saved attachments).
- `Read(meeting-notes)`: files under `<install folder>/meeting-notes/` (made by the meeting follow-up's add, Task 6).

The step's `--tools` gains `Read` when the rule is listed; the hook allows a `Read` call only when its `file_path`, resolved with `realpath`, is inside that place (`confinedPath`), and refuses everything else (a `..`, a symbolic link out, another absolute path, a folder). The call record keeps the file's name, never its content (D142).

- [ ] Failing tests: `Read(attachments) allows a saved attachment`; `Read refuses a path outside the place, a .. and a symlink out`; `an unknown place name is refused when the workflow loads`; `--tools includes Read only when a Read rule is listed`. Implement; pass; commit `feat(task): read a saved attachment or a meeting note`.
- **Unproven on the real Claude Code** until human task 37: that a restricted task with `--tools Read` reads a PDF and that the hook sees `file_path`. Until then the summary's `reads:email-attachment` and `reads:files` lines stay as the doability check records them (T2 variants, T7); nothing claims more.

### Task 5: Invoice processing

**Files:** `solutions/starter.json` (suggestions `invoice-processing`, `invoices-due`), skill template, `src/core/calc.ts` (`where`), `src/core/homes.ts` (`SHAPES["invoices-due"]`), tests.

9.6 row: *an email attachment (exists); the agent reads the file itself → vendor, amount, due date; **where the numbers go is the owner's call** (the agent asks; TaskFollow executes or flags a gap) → gated: recording it; anything paid is always a person → reported: due this week.*

- **Trigger:** `{"event":"message.received","from":"external","channel":"email"}`; `when`: the email channel exists.
- **Steps:** `read` (`task`, `may_use: ["Read(attachments)"]`, input: the message's attachment references; output `{is_invoice, vendor, number, amount, currency, due, file}`) → `save` (`approve records.create` on `invoice`, `when: read.is_invoice == true`; L3 because `amount` is financial). Amounts are read, never added up by a model; "due this week" totals use a `calc` step (Task 5b).
- **5b, the weekly "due this week" report:** a second suggestion `invoices-due` (cron Monday 08:00 local): `records.find` on `invoice` (all rows; `records.find` matches one exact value per field, so it cannot select two statuses or a date range) → `calc` (sum of `amount` by `currency`, count) with a new, small `where` on `calc` (D144 today has none): `{"status":["to check","approved to pay"],"due_within_days":7}` (a list means any of; `due_within_days` keeps rows whose date field `due` is on or before today plus N in the workflow's time zone; a row with an empty or malformed date is kept and counted apart as "no due date") → `judge` (the list in plain words, numbers only from `calc`) → `channel.notify` when a channel exists, otherwise the result waits for `why`. It only reads: report-only, so it may also go to Home 2 if T8 passes (its shape entry: needs `answers`, `reads:records`, `skills`; `hardRule: false`; added to `SHAPES`, the one change to that constant, recorded in the decision).
- **Where the numbers go:** the shape writes to the `invoice` fallback; when the owner names their accounting tool, the agent writes a described workflow with a read-only `task` on that tool and `approve` + `agent_call` for the write; when neither is possible it says the gap in four parts (D163's words for `writes:records`).
- **Never paid:** the skill says paying is always the owner, by hand; no step pays, and `approved to pay` is set only by the owner's own `records.update` approval.
- [ ] Failing tests: `invoice-processing reads only through Read(attachments)`; `an invoice record waits for the decision maker (L3)`; `a non-invoice email creates nothing`; `invoices-due sums amounts with calc and never in the judge` (the judge's input holds the calc output); `calc where keeps any listed status and dates within N days, and counts rows without a due date apart`; `invoices-due is report-only and invoice-processing is hard-rule in decideHome`. Implement; pass; commit `feat(shapes): invoice processing and invoices due`.

### Task 6: Meeting follow-up, and the shapes in INSTALL.md

**Files:** `solutions/starter.json` (suggestion `meeting-follow-up`), skill template, `src/core/lifecycle.ts` (the add makes `meeting-notes/` when the install folder is known; recorded in `state/written.json`, removed by uninstall only when empty), INSTALL.md (section 9 and a new 9e "The five workflows"), tests including `tests/e2e/install-doc.test.ts`.

9.6 row: *the owner gives the notes or transcript (minimum scope) → action items, owners, dates → gated: creating tasks; sending notes → reported: the list of actions.*

- **Trigger:** manual. The owner puts the notes in `meeting-notes/` in the install folder, or pastes them in chat (by hand, level 0, with the skill).
- **Steps:** `notes` (`task`, `may_use: ["Read(meeting-notes)"]`, newest file; output `{meeting, actions:[{what, owner, due}]}`) → `tasks` (`approve records.create` on `action`, `foreach` action; or, for the owner's task app, `agent_call` in a described version) → `send` (`approve channel.send`, the notes to the people the owner lists in `my-rules.md`, `when`: the owner's rules name recipients).
- **Hard rule "ask"** (`SHAPES`): the check page's two questions (D159) decide; if the owner says it only sends the list to them, the `tasks` and `send` steps are absent from their version and it is report-only (by hand or Home 1; it is not scheduled, so Home 2's scheduler is not offered; the summary says so).
- **INSTALL.md 9e:** one paragraph per shape, in plain words: what starts it, what it reads, what waits for the owner's yes, where the result goes, and "if you already use a tool for this, tell me which, and I will use it instead of the sheet". The doc test adds every suggestion as written.
- [ ] Failing tests: `meeting-follow-up reads the newest note only`; `an action without an owner or a date is listed, not invented` (the judge schema allows empty); `with "only to me" answered, the hard rule is off and no send step remains`; `workflow add meeting-follow-up makes meeting-notes/ and uninstall removes it only when empty`; `every shipped shape loads, dry-runs and records its shape` (the five, with item 5's). Implement; pass; commit `feat(shapes): meeting follow-up; INSTALL.md 9e`.

## 6b: the interview, the opportunity rule, discovery

### Task 7: The interview proposes from the five shapes

**Files:** `solutions/starter.json` (`workflows.choose` and `consult.choose` intents), INSTALL.md 9b item 1, `tests/e2e/operator.test.ts` (the scripted operator walks it).

9.4: *"the interview proposes workflows from the five shapes (9.6) and anything else the owner's day suggests; the owner picks; the owner's answers go into the workflow's skill (`references/my-rules.md`)."*

- The intent gains: after the walk-through of the week, compare what the person said with `taskfollow workflow suggestions` (now the five shapes plus `invoices-due`), propose the ones that match first, in the person's words, then anything else their week suggests; for each, ask which tool they use for it today ("which CRM do you use now?", 9.6) and write that tool in only if they name one; put their answers in `my_rules`.
- A starter version bump (minor), with tests that walk the starter updated.
- [ ] Failing tests: `the interview intent names the five shapes and asks which tool the person uses`; the operator walk adds one shape with `my_rules` and finds them in `references/my-rules.md`. Implement; pass; commit `feat(starter): the interview proposes from the five shapes`.

### Task 8: The opportunity rule

**Files:** INSTALL.md (Operator rules, a new rule 14), `tests/e2e/install-doc.test.ts`.

9.4: *"whenever anyone (the model, TaskFollow, any trigger) sees repetitive work that could be a workflow, it says so, shows the proposed workflow, and the owner approves or gives feedback. Nothing is created without a yes."* and *"Most of that widening is an operator rule (level A), not new machinery."*

Rule 14, as written:

> 14. When you notice work that repeats, in what the person asks you to do, in what a workflow's results show, or in a suggestion TaskFollow noticed, say so in one sentence and show the workflow you would set up: what starts it, what it reads, what it may change, and what waits for their yes. If they give feedback, change it and show it again. Add it only after they say yes; never create, change or turn on a workflow without one.

The same rule, in the same words, goes into the TaskFollow section of `CLAUDE.md` that `workflow add` keeps (D154), so chat outside a TaskFollow session sees it.

- [ ] Failing tests: `INSTALL.md has the opportunity rule`; `the CLAUDE.md section carries the opportunity rule`. Implement; pass; commit `docs(install): the opportunity rule`.

### Task 9: Discovery: the "find my repetitive work" skill (D165)

**Files:** new package skill `skills/find-my-repetitive-work/SKILL.md`, `src/core/workflow-skill.ts` (written with the first workflow add, like the `CLAUDE.md` section, recorded in `state/written.json`; uninstall and the consult cleanup remove it), `src/core/consult.ts` (the zip under `exports/` for an agent without a known skills folder, D158's format), INSTALL.md 9b (a new item: "If the person is not sure what repeats"), tests.

The owner's decision (D165): A, "I noticed" (D148/D164), unchanged; B, the interview (Task 7); C, the opportunity rule (Task 8); D, this skill. No weekly scheduled scan.

The skill, run by the owner's agent in the owner's own chat when the owner asks ("find my repetitive work", "what could I automate?"):

1. Ask which places to look at (their email, calendar, files, chat history with you) and how far back (four weeks unless they say otherwise). Look only there, only with your own tools, only in this chat.
2. Read only. Never send, reply, write, move, label or delete anything while looking.
3. List what repeats, one plain line each: what the work is, about how often, which service it touches, and which of the five workflows it resembles, or "something new". Quote no message, and name no person unless the owner asks you to.
4. Ask the owner to confirm or drop each line.
5. For each confirmed line, propose a workflow as INSTALL.md 9b says, and add it with `taskfollow workflow add` only after their yes, with their own words as the description and their rules as `my_rules`.
6. Nothing you read leaves this chat except what the owner confirms in step 5.

How a confirmed pattern reaches TaskFollow: only as the description and `my_rules` of a workflow the owner chose to add, through the existing `workflow add`. TaskFollow stores nothing else and gets no new command or tool (Review Focus 5).

- [ ] Failing tests: `the discovery skill is written with the first workflow and removed by uninstall`; `the consult cleanup removes it`; `its text names no TaskFollow command but workflow add, suggestions and skills` (a grep test on `taskfollow ` and `mcp__installer`); `an agent without a skills folder gets the zip under exports/, scrubbed`. Implement; pass; commit `feat(skills): find my repetitive work (D165)`.

### Task 10: Records, human tasks, PRs

- Decisions (next free D-numbers when built): the fallback entities; the `Read(<place>)` rule and its two places; each shape's steps and gates; `invoices-due` as a report-only shape (the one `SHAPES` change); meeting follow-up's notes folder; the interview's change; the opportunity rule's text; the discovery skill.
- `docs/next-steps.md` build map rows 6a and 6b; INSTALL.md 9e.
- **Human task 37 (owner, about 15 minutes):** on the real Claude Code, a restricted task with `Read(attachments)` reads a PDF invoice saved by the email channel, and the hook's record shows the file name; a path outside is refused.
- **Human task 38 (owner, about 20 minutes, after #40 and task 37):** one test invoice to the TaskFollow email address: the invoice record waits for approval; after yes, it is in the sheet; Monday's `invoices-due` list shows it.
- **Human task 39 (owner, about 10 minutes):** in a fresh chat, ask the agent to "find my repetitive work" on the test Gmail; the list quotes no message and names nobody; adding one confirmed workflow is the only thing TaskFollow receives (`taskfollow why` and the audit show only `workflow.added`).
- Typecheck, full suite twice, Fable code review, fixes, PR in plain words per PR (what was built and why, what the person sees, a building-blocks table of files and messages, how it was tested). The owner merges.

---

## What the person sees (exact messages)

- Suggestions (`taskfollow workflow suggestions`): *"Lead qualification: when someone new writes to you, sorts out whether they are a fit and what to do next, and drafts the reply. You approve the reply and the new lead before anything is sent or saved."* · *"CRM update: when you tell me 'note that …', finds the record and shows you the change; nothing is saved until you say yes."* · *"Invoice processing: when an invoice arrives by email, reads the vendor, the amount and the due date, and records it where you choose once you approve. It never pays anything."* · *"Invoices due: every Monday, the invoices still to pay this week, with their total."* · *"Meeting follow-up: from your meeting notes, lists who does what by when; creating tasks and sending the notes wait for your yes."*
- Read refused (call record and `why`): *"Refused: the step may read only <saved attachments | the meeting-notes folder>, and this file is elsewhere."*
- No meeting note: *"There is no note in meeting-notes/ yet. Put the notes or transcript there as a file, or paste them in this chat."*
- No tool for the job (the agent, from 9.6): *"You don't have a tool for <leads | invoices | tasks> that I can use. I can keep them in a Google Sheet in your own account instead, or you can tell me the tool you use."*
- Discovery, step 3 line format: *"About <n> times a week: <what the work is>, in <service>. Looks like <shape | something new>. Keep it or drop it?"*

## Risks

- **Several message workflows on one message.** Lead qualification, invoice processing and an order-questions workflow all start on `message.received`; each runs and each ends quietly when the message is not theirs. Cost: one judge or task per workflow per message. Said in INSTALL.md 9e; not changed in item 6.
- **Read in a restricted task** may behave differently on the real Claude Code (task 37); if it does not work, invoice processing falls back to the owner's own email tool in `may_use` (a described workflow), and the plan's Task 4 is dropped.
- **Existing installs** pinned to an older starter have no `lead`, `invoice` or `action` entity until they start again with the new starter; the owner's test home is one of them.
- **Item 5's format** may differ from the assumption above; the shapes follow it.

## Out of scope

- A weekly scheduled patterns scan (option E, rejected in D165), and any change to "I noticed" (D148/D164).
- Learning into `my-rules.md` (item 8).
- Paying, in any shape; sending to customers outside an approval.
- New channels, or reading the owner's mail through anything but TaskFollow's email channel or the agent's own tools.
- Owner-named tools beyond what approve-agent-call (D151) gives.

## Open questions for the owner

1. **The fallback records.** Are `lead`, `invoice` and `action` with the fields in Task 1 the right minimum, or should leads stay in the existing `contact` sheet with a status column?
2. **Invoices due.** 9.6 reports "due this week" for invoices. Is a separate Monday report (Task 5b, report-only, so it can also run on Cowork) what you meant, or should the list come with each new invoice instead?
3. **Meeting notes.** Is a `meeting-notes/` folder in the install folder (plus pasting in chat) the way you would hand over notes, or do you want to email them to the TaskFollow address?
4. **The discovery skill's reach.** Should it be offered once at the end of the interview ("not sure what repeats? I can look for you"), or only when you ask?
5. **The opportunity rule's frequency.** Should the agent stop proposing a kind of work after you say no once, or keep mentioning it when it repeats? 9.4 does not say; rule 14 as written says neither.
