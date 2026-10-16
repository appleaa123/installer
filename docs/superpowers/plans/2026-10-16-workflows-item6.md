# The other four workflows, item 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, in the owner's words:** *"I tell you my day, you tell me how to automate my day."* (9.4) Item 6 ships the other four back-office workflows of 9.6 (lead qualification, CRM update, invoice processing, meeting follow-up) at their minimum, has the interview propose from all five shapes, and adds the opportunity rule, with discovery as the owner settled it on 2026-10-16 (D165).

**Architecture:** The four shapes reuse what exists: starter suggestions whose ids are the `SHAPES` keys (`homes.ts`, D159), so `workflow add <id>` records the shape and its code-constant needs and hard-rule flag; typed steps (`tool`, `judge`, `approve`, `task`) on TaskFollow's own tools (`channel.inbox`, `records.*`, `channel.send`, `channel.notify`); approve-agent-call (D151, PR #40) for the owner's own tool; the Sheets fallback (`records.*`, D67–D70) when the owner has no tool. Each shape's skill uses item 5's format. The interview and the opportunity rule are operator text (level A). Discovery is one shipped skill run by the owner's agent in the owner's own chat; nothing in TaskFollow's code reads email or messages for it (D148 holds).

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Measured against:** v1, `docs/scope-refresh.md` 9.4, 9.5, 9.6, 9.9, section 5 (workflows delivered as skills) and section 6 (gap flags), read with 9.15 (two homes, the doability check), which wins where it differs; spec `docs/superpowers/specs/2026-10-16-doability-check.md` v3.1 sections 4 and 7; D151, D159, D163, D165.

## Order and dependencies

- **After PR #40 (D151) is merged** (9.14): the owner-named-tool path of every shape is an `approve` step with `agent_call`; without #40 those writes have no gate and stay draft-only. Item 6 edits the same runner, approval and INSTALL.md files.
- **After item 5 (inbox triage)**, plan `docs/superpowers/plans/2026-10-16-inbox-triage-item5.md`. Item 6 uses what item 5 settles and does not redesign it:
  1. **The shape skill** is one tool-neutral file per shape, `solutions/shapes/<id>/SKILL.md` (no `scripts/`, no `assets/`), which `workflow add <id>` writes into the agent's skills folder in place of the generic `skillMarkdown()` (`workflow-skill.ts`); `references/my-rules.md` stays the owner's.
  2. **The test cases** are a shipped-empty `references/examples.md`, filled from the interview with two or three of the owner's real past items and the expected result, rerun by the agent in chat when the skill or the rules change (level A; no replay command).
  3. **A suggestion's `--value`** carries only `trigger`, `skills` and `my_rules`; anything else makes it a described workflow, which loses the shape (D159).
  4. **`when`** on a suggestion uses `{step, equals}` or `any`/`all` of those (`solution.ts` 131, 157). Item 5 moves the starter to 2.1.0.
- **Every new shape has both a `SHAPES` entry and a template** (`solutions/shapes/<id>/SKILL.md`). Item 6 adds no new shape id: the four ids are already in `SHAPES`.
- **6b depends on 6a** (the interview proposes the shapes 6a ships).

## Global Constraints

- The hard rules (9.2) hold for every shape: replies to anyone, record writes, anything paid, and deletes go through a person, every time. Paying is never a step of any shape (9.6: "anything paid is always a person").
- The shapes' needs and hard-rule flags stay the code constant in `homes.ts` `SHAPES` (D159); item 6 does not change it.
- Workflows stay general; the agent picks the tools (9.6). A shipped suggestion uses only TaskFollow's own tools and the Sheets fallback, so it loads on every install. When the owner names their own tool, the agent writes a **described** workflow with `--value` (it loses the shape and is hard-rule unless the owner's check-page answers say otherwise, D159), with the owner's tool in a read-only `task` step and any write behind `approve` + `agent_call`.
- D148 holds: TaskFollow's code never reads the owner's email or messages for discovery; only patterns the owner confirms reach TaskFollow, and only as the words of a workflow they chose to add.
- Nothing is created without the owner's yes (9.4).
- Plain words; INSTALL.md free of industry words and of "Skills Wiki" before section 11.
- Tests never touch the real `~/.claude`; full `npm test` twice and `npm run typecheck` before each PR; a Fable code review before asking the owner to merge.
- **Two PRs, one starter bump each:** 6a = Tasks 1–6, the four shapes (starter 2.2.0); 6b = Tasks 7–9, the interview, the opportunity rule and discovery (starter 2.3.0). 6b starts after 6a merges: it edits the starter's interview intents, INSTALL.md 9b and the operator rules, `workflow-skill.ts`, `consult.ts` and `lifecycle.ts`.
- Tests assert what code decides (schemas, `when`, levels, gates, what is written), never what a model would say through the fake agent.

## Review Focus

1. **No shape reaches a person, a record or money without an approval.** Every `channel.send`, `records.create`, `records.update`, `records.import` and `agent_call` in a shipped suggestion is an `approve` step; a test walks each suggestion and fails on any ungated write. No `approve` uses `foreach` (refused at load, `workflow.ts` 265) and no L2/L3 `tool` step uses `foreach` (refused at run, `runner-steps.ts` 80).
2. **Shapes are recorded only when unchanged** (D159): a suggestion edited beyond trigger, skills and my_rules loses its shape. No path lets the agent's file set `shape`.
3. **The invoice amount is a financial field** (L3, decision maker), and no step of the invoice shape pays.
4. **Reading a file is confined to exact files:** a task may read only the saved attachments named in its own input, each realpath-checked under `<home>/data/inbox-files/`; the hook allows a `Read` call only for one of those absolute paths; anything else is refused.
5. **Discovery never sends anything to TaskFollow but a workflow the owner chose to add.** The skill reads only through the agent's own tools, only the sources the owner names, never writes, sends or deletes, and names no TaskFollow command but `workflow add`, `workflow suggestions` and `skills`.

---

## 6a: the four shapes (starter 2.2.0)

### Task 1: The fallback records (data contract)

**Files:** `solutions/starter.json` (`data_contract`), `tests/unit/starter-minimum.test.ts`, `tests/unit/solution.test.ts`.

9.6: "when the owner has no tool for the job, the agent says so; Google Sheets (`records.*`, exists) is available as the fallback record." The starter's contract has only `contact`. **Default, pending the owner (open question 1), the smaller option:**

- **Leads stay in `contact`**, which gains three optional fields: `status` (enum: `new`, `qualified`, `not a fit`, `waiting`), `next_step` (text), `source` (text: the channel it came in on).
- **`invoice`** (new): key `id` (text: vendor plus invoice number); `vendor` (text, required), `amount` (money, **financial**, required), `currency` (text), `due` (date), `status` (enum: `to check`, `approved to pay`, `paid`), `file` (text: the saved attachment's reference).
- **`action`** (new): key `id` (text); `what` (text, required), `owner` (text, personal), `due` (date), `meeting` (text), `status` (enum: `open`, `done`).

The agent connects `invoice` or `action` only when the owner picks the fallback for that workflow: `taskfollow connect <entity> --sheet new` and `taskfollow map <entity>` (D68, D69), as INSTALL.md 9e says (Task 6). No new DATA-phase step.

- [ ] Failing tests: `starter's contract has invoice and action, and contact has status, next_step and source`; `invoice.amount is tagged financial, so records.create of an invoice is L3`; `a contact's status outside its options is refused`. Implement; pass; commit `feat(starter): fallback records for leads, invoices and actions`.

### Task 2: Lead qualification

**Files:** `solutions/starter.json` (suggestion `lead-qualification`), `solutions/shapes/lead-qualification/SKILL.md`, tests.

9.6 row: *a message from a new contact → fit and the next step, by the owner's rules → gated: the reply; the record write → reported: new leads and their status.*

- **Trigger:** `{"event":"message.received","from":"external","channel":"email"}`; `when: {"step":"services.email","equals":"email"}`. Email only, because a reply in the customer's thread (`reply_to`) exists only on email (`channel-tools.ts` 64), and the contact's key is an email address.
- **Steps:** `known` (`tool records.find` on `contact` with `{"email":"${event.from}"}`) → `qualify` (`judge`; input: the message, marked untrusted, and `known`; schema `{new: boolean, fit: "yes"|"no"|"unsure", next_step: string, reply: string, why: string}`) → `save` (`approve records.create` on `contact` with `status`, `next_step`, `source: "email"`; `when: qualify.new == true`) → `reply` (`approve channel.send` with `reply_to`; `when: qualify.reply != ""`).
- **Reported:** the run's result is the lead line; with no channel to the owner it waits for `why` (level 1, D155).
- **Skill:** what a lead is, the three fit answers, that a known contact is not a new lead, the reply's tone, "never promise a price, a date or a discount the owner's rules do not give"; `references/my-rules.md` (who is a fit, what the next step is) and `references/examples.md` from the interview.
- **Home:** hard rule → Home 1 when T7 passes; otherwise draft-only (Home 2: the qualification and the reply text inside the brief to the owner) or by hand. `decideHome` unchanged.
- [ ] Failing tests: `lead-qualification loads and records its shape`; `it is offered only when email was chosen`; `known looks up the sender in contact`; `the judge's input marks the message untrusted`; `save and reply are approve steps, conditioned on qualify.new and a non-empty reply`. Implement; pass; commit `feat(shapes): lead qualification`.

### Task 3: CRM update

**Files:** `solutions/starter.json` (suggestion `crm-update`), `solutions/shapes/crm-update/SKILL.md`, tests.

9.6 row: *the owner says "note that X", or a message arrives → which record, and what changes → gated: the write, with a preview → reported: what changed.*

- **Two ways in, one shape:** a message from the owner to their TaskFollow channel (`{"event":"message.received","from":"member"}`; `when`: `any` of `services.telegram`=`telegram`, `services.email`=`email`, `services.slack`=`slack`, `services.whatsapp`=`whatsapp`, as the starter already writes it), and, with no channel, the owner saying it in chat: the agent then calls `records.update` itself through TaskFollow's tools (level 0, by hand; the same approval holds because it goes through TaskFollow's tool, which T5 proves in chat).
- **Steps:** `which` (`judge`; schema `{entity: string, key: string, changes: object, found: boolean, question: string}`) → `current` (`tool records.get`; `when: which.found == true`) → `change` (`approve records.update` with only the changed fields; `when: which.found == true`).
- **The preview** is the approval item (D70 shows the current values and the change, and refuses a record changed since); nothing new is built.
- **Owner's own CRM:** a described workflow (Global Constraints), write through `agent_call`.
- [ ] Failing tests: `crm-update loads and records its shape`; `with found false no records step runs and the result holds the question` (a scripted judge answer, asserting the `when` gates, not model behaviour); `change is an approve step for records.update`; `the update is refused when the record changed after the approval` (D70's helper). Implement; pass; commit `feat(shapes): CRM update`.

### Task 4: Reading a saved attachment in a task step

**Files:** `src/core/workflow.ts` (`parseMayUse` accepts the bare rule `Read`), `src/core/task-step.ts` (collects the step input's attachment references), `src/core/agent-task.ts` (`builtinTools`, the hook config), `src/core/agent-hook.ts` (`decide` for `Read`), tests in `tests/unit/agent-hook.test.ts`, `tests/unit/agent-task.test.ts`, `tests/unit/workflow.test.ts`.

Invoice processing says *"the agent reads the file itself"* (9.6). Today a task allows only MCP tools and `Bash(...)`, and `may_use` goes verbatim into `--allowedTools` (`agent-task.ts` 83), so a made-up rule would match nothing.

- **The rule:** `may_use` may list the bare word `Read`. It passes to `--allowedTools` as `Read`, and `--tools` gains `Read`.
- **What it may read:** only the saved attachments named in the step's own input, exactly in D133's form (`ATTACHMENT_REF`, `attachments.ts` 17). Before the agent starts, `task-step.ts` collects them from the interpolated input, resolves each with `realpath` and keeps it only if it is inside `realpath(<home>/data/inbox-files/)`; the resulting absolute paths go into the hook config (`hook.json`, next to `may_use`) and into the agent's input as `files: [{ref, path}]`.
- **The hook:** a `Read` call passes only when its `file_path` is absolute and its `realpath` equals one of those paths; everything else is refused (relative paths, `..`, links out, folders, any other file), and so is every `Read` when no file was listed. The call record keeps the file's name, never its content (D142).
- **Why not `Bash(cat:*)`:** it is a valid rule today (`workflow.ts` 210), but it reads any file the computer user can read; the shapes never use it.
- [ ] Failing tests: `Read allows exactly a listed saved attachment`; `Read refuses a relative path, a .., a link out, a folder and another file`; `Read is refused when the input names no attachment`; `a reference outside data/inbox-files is dropped before the agent runs`; `--allowedTools carries Read and --tools gains Read only when listed`. Implement; pass; commit `feat(task): read a saved attachment named in the step's input`.
- **Unproven on the real Claude Code** until human task 38: that a restricted task with `--tools Read` reads a PDF and that the hook sees `file_path`. Until then the summary's `reads:email-attachment` line stays as the doability check records it; nothing claims more.

### Task 5: Invoice processing

**Files:** `solutions/starter.json` (suggestion `invoice-processing`), `solutions/shapes/invoice-processing/SKILL.md`, tests.

9.6 row: *an email attachment (exists); the agent reads the file itself → vendor, amount, due date; **where the numbers go is the owner's call** (the agent asks; TaskFollow executes or flags a gap) → gated: recording it; anything paid is always a person → reported: due this week.*

- **Trigger:** `{"event":"message.received","from":"external","channel":"email"}`; `when: {"step":"services.email","equals":"email"}`.
- **Steps:** `read` (`task`, `may_use: ["Read"]`, input: the message's attachment references; schema `{is_invoice, vendor, number, amount, currency, due, file}`) → `save` (`approve records.create` on `invoice`, `when: read.is_invoice == true`; L3 because `amount` is financial).
- **"Due this week"** (default, pending open question 2): the run's result names the invoice and its due date; the owner asks in chat and the agent lists open invoices with `records.find` (by hand, level 0). No weekly report, no new `calc` feature and no new shape id unless the owner says yes to question 2.
- **Where the numbers go:** the shape writes to the `invoice` fallback; when the owner names their accounting tool, a described workflow with `agent_call`; when neither is possible, the gap in four parts (D163's words for `writes:records`).
- **Never paid:** the skill says paying is always the owner, by hand; no step pays.
- [ ] Failing tests: `invoice-processing loads and records its shape`; `read may use only Read and its input carries the attachment references`; `an invoice record is L3 and waits for the decision maker`; `with is_invoice false the save step does not run`. Implement; pass; commit `feat(shapes): invoice processing`.

### Task 6: Meeting follow-up, and the shapes in INSTALL.md

**Files:** `solutions/starter.json` (suggestion `meeting-follow-up`, version 2.2.0), `solutions/shapes/meeting-follow-up/SKILL.md`, INSTALL.md (section 9 and a new 9e "The five workflows"), tests including `tests/e2e/install-doc.test.ts`.

9.6 row: *the owner gives the notes or transcript (minimum scope) → action items, owners, dates → gated: creating tasks; sending notes → reported: the list of actions.*

- **Ways in** (default, pending open question 3): pasted in chat (by hand, level 0, with the skill), or emailed by the owner to the TaskFollow address as text or an attachment (D132): trigger `{"event":"message.received","from":"member","channel":"email"}`, `when: {"step":"services.email","equals":"email"}`. No notes folder.
- **Steps:** `notes` (`task`, `may_use: ["Read"]`, input: the message text and its attachment references; schema `{meeting: string, actions: [{id, what, owner, due}]}` with `owner` and `due` allowed empty) → `tasks` (one `approve records.import` on `action` with `rows: ${notes.actions}`: one approval for the whole list, L2 when it only adds, `import-tools.ts` 114; or `agent_call` for the owner's task app in a described version) → `send` (`approve channel.send` of the notes to the people the owner's rules name; present only in the owner's version when they want it).
- **Hard rule "ask"** (`SHAPES`): the check page's two questions (D159) decide; if the owner says it only sends the list to them, their version has no `tasks` or `send` step and is report-only (by hand or Home 1; it starts on a message, not a schedule, so Home 2's scheduler is not offered and the summary says so).
- **INSTALL.md 9e:** one paragraph per shape, in plain words: what starts it, what it reads, what waits for the owner's yes, where the result goes, and "if you already use a tool for this, tell me which, and I will use it instead of the sheet" (a described workflow).
- [ ] Failing tests: `meeting-follow-up loads and records its shape`; `the notes schema allows an action with no owner or date`; `tasks is one approve of records.import with the actions as rows`; `no shipped suggestion has an approve or an L2/L3 tool step with foreach`; `every shipped shape loads, dry-runs and records its shape` (the six, with item 5's); `every SHAPES id has a template under solutions/shapes`. Implement; pass; commit `feat(shapes): meeting follow-up; INSTALL.md 9e`.

## 6b: the interview, the opportunity rule, discovery (starter 2.3.0, after 6a)

### Task 7: The interview proposes from the five shapes

**Files:** `solutions/starter.json` (`workflows.choose` and `consult.choose` intents, version 2.3.0), INSTALL.md 9b item 1, `tests/e2e/operator.test.ts`.

9.4: *"the interview proposes workflows from the five shapes (9.6) and anything else the owner's day suggests; the owner picks; the owner's answers go into the workflow's skill (`references/my-rules.md`)."*

- The intent gains: after the walk-through of the week, compare what the person said with `taskfollow workflow suggestions`, propose the matching shapes first, in the person's words, then anything else their week suggests. For each, ask which tool they use for it today ("which CRM do you use now?", 9.6). **No tool named:** add the suggestion with `--value` carrying only `trigger`, `skills` and `my_rules`, and two or three real past items for `references/examples.md`. **A tool named:** write a described workflow with that tool (sections 9 and 9a); it is not the shipped shape, so the check page asks its two questions (D159).
- At the end of the interview, at most one line: *"Not sure what repeats in your week? Ask me to find your repetitive work any time."* (D165: on demand, nothing automatic.)
- [ ] Failing tests: `the interview intent names the five shapes, asks which tool the person uses, and says a named tool makes a described workflow`; the operator walk adds one shape with `my_rules` and finds them in `references/my-rules.md` with the shape kept. Implement; pass; commit `feat(starter): the interview proposes from the five shapes`.

### Task 8: The opportunity rule

**Files:** INSTALL.md (Operator rules, a new rule 14), `src/core/agent-file.ts` (one line in the TaskFollow section of `CLAUDE.md`), `tests/e2e/install-doc.test.ts`, `tests/unit/agent-file.test.ts`.

9.4: *"whenever anyone (the model, TaskFollow, any trigger) sees repetitive work that could be a workflow, it says so, shows the proposed workflow, and the owner approves or gives feedback. Nothing is created without a yes."* and *"Most of that widening is an operator rule (level A), not new machinery."*

Rule 14, as written:

> 14. When you notice work that repeats, in what the person asks you to do, in what a workflow's results show, or in a suggestion TaskFollow noticed, say so in one sentence and show the workflow you would set up: what starts it, what it reads, what it may change, and what waits for their yes. If they give feedback, change it and show it again. Add it only after they say yes; never create, change or turn on a workflow without one. Propose each kind of work once; propose it again only if they ask.

The `CLAUDE.md` section gains one line: *"When you notice work that repeats, offer to set it up as a workflow (INSTALL.md, operator rule 14); nothing is created without the owner's yes."*

- [ ] Failing tests: `INSTALL.md has operator rule 14`; `the CLAUDE.md section has one opportunity line`. Implement; pass; commit `docs(install): the opportunity rule`.

### Task 9: Discovery: the "find my repetitive work" skill (D165)

**Files:** new `solutions/skills/find-my-repetitive-work/SKILL.md`; `solutions/starter.json` (an `auto` step at the start of the WORKFLOWS phase, for install and consult alike, that writes it); `src/core/workflow-skill.ts` (write and record in `state/written.json`); `src/core/lifecycle.ts` / `src/core/actions.ts` (the auto action); `src/core/uninstall.ts` and `src/core/consult.ts` (remove it); INSTALL.md 9b (a new item: "If the person is not sure what repeats"); tests.

D165: A, "I noticed" (D148/D164), unchanged; B, the interview (Task 7); C, the opportunity rule (Task 8); D, this skill, on demand only. No weekly scheduled scan.

- **Where it lives:** written into the agent's project skills folder (`.claude/skills/find-my-repetitive-work/` for Claude Code) at the start of the WORKFLOWS phase, so it is there during the interview; for an agent without a known skills folder, under the TaskFollow home (`exports/find-my-repetitive-work/SKILL.md`), and INSTALL.md 9b tells the agent to read it from there. No Cowork zip: discovery runs in the owner's chat with the agent that set things up, and the skill names `taskfollow workflow add`, which `checkDelivered` refuses for an agent's own scheduler (`deliver.ts` 24, 78).
- **The skill, when the owner asks** ("find my repetitive work", "what could I automate?"):
  1. Ask which places to look at (their email, calendar, files, chat history with you) and how far back (four weeks unless they say otherwise). Look only there, only with your own tools, only in this chat.
  2. Read only. Never send, reply, write, move, label or delete anything while looking.
  3. List what repeats, one plain line each: what the work is, about how often, which service it touches, and which of the five workflows it resembles, or "something new". Quote no message, and name no person unless the owner asks you to.
  4. Ask the owner to confirm or drop each line.
  5. For each confirmed line, propose a workflow as INSTALL.md 9b says, and add it with `taskfollow workflow add` only after their yes, with their own words as the description and their rules as `my_rules`.
  6. Nothing you read leaves this chat except what the owner confirms in step 5.
- **How a confirmed pattern reaches TaskFollow:** only as the description and `my_rules` of a workflow the owner chose to add, through the existing `workflow add`. TaskFollow stores nothing else and gets no new command or tool (Review Focus 5).
- [ ] Failing tests: `the WORKFLOWS phase writes the discovery skill and records it`; `uninstall and the consult cleanup remove it`; `an agent without a skills folder gets it under exports/`; `its text names no TaskFollow command but workflow add, workflow suggestions and skills` (a grep on `taskfollow ` and `mcp__installer`). Implement; pass; commit `feat(skills): find my repetitive work (D165)`.

### Task 10: Records, human tasks, PRs

- Decisions (next free D-numbers when built): the fallback records; the `Read` rule bound to the input's saved attachments; each shape's steps and gates; meeting follow-up's ways in and its one import approval; the interview's change; rule 14's text; the discovery skill's place.
- `docs/next-steps.md` build map rows 6a and 6b; INSTALL.md 9e.
- **Human task 38 (owner, about 15 minutes):** on the real Claude Code, a restricted task with `Read` reads a PDF invoice saved by the email channel, the hook's record shows the file name, and a path outside is refused.
- **Human task 39 (owner, about 20 minutes, after #40 and task 38):** one test invoice to the TaskFollow email address: the invoice record waits for approval; after yes, it is in the sheet; asking "what is due this week?" in chat lists it.
- **Human task 40 (owner, about 10 minutes):** in a fresh chat, ask the agent to "find my repetitive work" on the test Gmail; the list quotes no message and names nobody; adding one confirmed workflow is the only thing TaskFollow receives (`taskfollow why` and the audit show only `workflow.added`).
- Typecheck, full suite twice, Fable code review, fixes, a PR in plain words per part (what was built and why, what the person sees, a building-blocks table of files and messages, how it was tested). The owner merges.

---

## What the person sees (exact messages)

- Suggestions (`taskfollow workflow suggestions`): *"Lead qualification: when someone new emails you, sorts out whether they are a fit and what to do next, and drafts the reply. You approve the reply and the new contact before anything is sent or saved."* · *"CRM update: when you tell me 'note that …', finds the record and shows you the change; nothing is saved until you say yes."* · *"Invoice processing: when an invoice arrives by email, reads the vendor, the amount and the due date, and records it where you choose once you approve. It never pays anything."* · *"Meeting follow-up: from the meeting notes you send me, lists who does what by when; creating tasks and sending the notes wait for your yes."*
- Read refused (call record and `why`): *"Refused: this step may read only the files attached to the message it was given."*
- No tool for the job (the agent, from 9.6): *"You don't have a tool for <leads | invoices | tasks> that I can use. I can keep them in a Google Sheet in your own account instead, or you can tell me the tool you use."*
- End of the interview: *"Not sure what repeats in your week? Ask me to find your repetitive work any time."*
- Discovery, step 3 line format: *"About <n> times a week: <what the work is>, in <service>. Looks like <shape | something new>. Keep it or drop it?"*

## Risks

- **Several message workflows on one email.** Lead qualification, invoice processing and an order-questions workflow all start on `message.received`; each runs and each ends quietly when the message is not theirs. Cost: one judge or task per workflow per email. Said in INSTALL.md 9e; not changed in item 6.
- **Read in a restricted task** may behave differently on the real Claude Code (task 38); if it does not work, invoice processing falls back to the owner's own email tool in `may_use` (a described workflow), and Task 4 is dropped.
- **Existing installs** pinned to an older starter have no `invoice` or `action` entity and no new `contact` fields until they start again with the new starter; the owner's test home is one of them.

## Out of scope

- A weekly scheduled patterns scan (option E, rejected in D165), and any change to "I noticed" (D148/D164).
- A weekly "invoices due" report and a `calc` filter (pending open question 2); a meeting-notes folder (pending open question 3).
- Learning into `my-rules.md` (item 8).
- Paying, in any shape; sending to customers outside an approval.
- New channels, or reading the owner's mail through anything but TaskFollow's email channel or the agent's own tools.
- Owner-named tools beyond what approve-agent-call (D151) gives.

## Open questions for the owner (the plan builds the default until answered)

1. **The fallback records.** Default: leads stay in `contact` with `status`, `next_step` and `source` columns; new `invoice` and `action` sheets. Or a separate `lead` sheet? *(pending)*
2. **Invoices due this week.** Default: named in each invoice's result and listed on request in chat. Or a separate Monday report (a new report-only shape, a `SHAPES` entry, a template and a `calc` filter, which could also run on Cowork)? *(pending)*
3. **Meeting notes.** Default: pasted in chat, or emailed to the TaskFollow address. Or a `meeting-notes/` folder in the install folder? *(pending)*

Answered by the review: the discovery skill is on demand, with at most one line at the interview's end and nothing automatic (D165); the opportunity rule proposes each kind of work once and again only if the owner asks (the D148 precedent).

## Fable review of 2026-10-16, applied

Item 5's format adopted (A1–A6); human tasks renumbered 38–40 (A7). B1 meeting actions as one `records.import` approval; B2 `Read` bound to the input's exact saved attachments, paths in the hook config, plain `Read` in `--allowedTools`; B3 lead qualification on email only, `known` looks in `contact`; B4 the weekly invoices report and `calc` filter cut, pending question 2; B5 the notes folder cut, pending question 3; B6 the discovery skill written at the WORKFLOWS phase, no Cowork zip; B7 rule 14 in INSTALL.md plus one `CLAUDE.md` line; B8 tests assert schemas and `when`, not model behaviour; B9 6b after 6a, with its real file list. No finding rejected: each cited line was checked (`workflow.ts` 265, `runner-steps.ts` 80, `agent-task.ts` 83 and 99, `actions.ts` 35, `attachments.ts` 17, `channel-tools.ts` 64, `deliver.ts` 24 and 78, `import-tools.ts` 114, `solution.ts` 131 and 157).
