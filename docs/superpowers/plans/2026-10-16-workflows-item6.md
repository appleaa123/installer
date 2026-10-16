# The other four workflows, item 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, in the owner's words:** *"I tell you my day, you tell me how to automate my day."* (9.4) Item 6 ships the other four back-office workflows of 9.6 (lead qualification, CRM update, invoice processing, meeting follow-up) at their minimum, plus the weekly "invoices due" report the owner chose (D166). It also has the interview propose from the shipped shapes, and adds the opportunity rule, with discovery as the owner settled it on 2026-10-16 (D165).

**Architecture:** The shapes reuse what exists:
- starter suggestions whose ids are the `SHAPES` keys (`homes.ts`, D159), so `workflow add <id>` records the shape and its code-constant needs and hard-rule flag;
- typed steps (`tool`, `judge`, `calc`, `approve`, `task`) on TaskFollow's own tools (`channel.inbox`, `records.*`, `channel.send`, `channel.notify`);
- approve-agent-call (D151, PR #40) for the owner's own tool;
- the Sheets fallback (`records.*`, D67–D70) when the owner has no tool.

Each shape's skill uses item 5's format. Two small pieces of code are new:
- a task may `Read` exact files the runner chose (saved attachments, or the newest meeting note);
- `calc` gains a minimal `where` for the invoices-due report.

The interview and the opportunity rule are operator text (level A). Discovery is one shipped skill run by the owner's agent in the owner's own chat; nothing in TaskFollow's code reads email or messages for it (D148 holds).

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Measured against:** v1. The scope parts are `docs/scope-refresh.md` 9.4, 9.5, 9.6, 9.9, section 5 (workflows delivered as skills) and section 6 (gap flags). They are read with 9.15 (two homes, the doability check), which wins where it differs. The spec is `docs/superpowers/specs/2026-10-16-doability-check.md` v3.1, sections 4 and 7. Decisions: D151, D159, D163, D165, and **D166 (the owner's choices on records, the invoices-due report and the meeting-notes folder; it amends D159's six v1 shapes to seven)**.

## Order and dependencies

- **After PR #40 (D151) is merged** (9.14): every shape writes to an owner-named tool through an `approve` step with `agent_call`. Without #40 those writes have no gate and stay draft-only. Item 6 edits the same runner, approval and INSTALL.md files.
- **After item 5 (inbox triage)**, whose plan is `docs/superpowers/plans/2026-10-16-inbox-triage-item5.md`. Item 6 uses what item 5 settles and does not redesign it:
  1. **The shape skill** is one tool-neutral file per shape, `solutions/shapes/<id>/SKILL.md` (no `scripts/`, no `assets/`). `workflow add <id>` writes it into the agent's skills folder in place of the generic `skillMarkdown()` (`workflow-skill.ts`). `references/my-rules.md` stays the owner's.
  2. **The test cases** are a shipped-empty `references/examples.md`. The interview fills it with two or three of the owner's real past items and the expected result. The agent reruns them in chat when the skill or the rules change (level A; no replay command).
  3. **A suggestion's `--value`** carries only `trigger`, `skills` and `my_rules`. Anything else makes it a described workflow, which loses the shape (D159).
  4. **`when`** on a suggestion uses `{step, equals}` or `any`/`all` of those (`solution.ts` 131, 157). Item 5 moves the starter to 2.1.0.
- **Every shape has both a `SHAPES` entry and a template** (`solutions/shapes/<id>/SKILL.md`). Item 6 adds one shape id, `invoices-due` (D166).
- **Every shipped shape that reads or writes records needs Google Sheets.**
  - `records.*` throws for a record type that is not connected (`records.ts` 47–48). Without Sheets the DATA phase never ran.
  - So each of these suggestions carries `services.records`=`google-sheets` in its `when`: lead qualification, CRM update, invoice processing, invoices due and meeting follow-up.
  - The owner's own tool is the described-workflow path (INSTALL.md 9e says so).
- **Not offered in a consultation.** `services.records` is asked only in an install (`starter.json` 292–309, `when: mode.purpose = install`), so these `when`s never hold in a consult.
  - This differs from item 5's inbox shapes, which a consult offers because they need no records.
  - The consult interview may still name such work in words. The report shows it as work that needs a Google Sheet or the owner's own tool, through D163's four-part words for `writes:records`.
- **6b depends on 6a** (the interview proposes the shapes 6a ships).

## Global Constraints

- The hard rules (9.2) hold for every shape: replies to anyone, record writes, anything paid, and deletes go through a person, every time. Paying is never a step of any shape (9.6: "anything paid is always a person").
- The shapes' needs and hard-rule flags stay the code constant in `homes.ts` `SHAPES` (D159). Item 6's only change to it is the new `invoices-due` entry (D166).
- Workflows stay general; the agent picks the tools (9.6). A shipped suggestion uses only TaskFollow's own tools and the Sheets fallback, so it loads on every install.
- When the owner names their own tool, the agent writes a **described** workflow with `--value`. It loses the shape and is hard-rule unless the owner's check-page answers say otherwise (D159). The owner's tool goes in a read-only `task` step, and any write goes behind `approve` + `agent_call`.
- D148 holds: TaskFollow's code never reads the owner's email or messages for discovery. Only patterns the owner confirms reach TaskFollow, and only as the words of a workflow they chose to add.
- Nothing is created without the owner's yes (9.4).
- Plain words; INSTALL.md free of industry words and of "Skills Wiki" before section 11.
- Tests never touch the real `~/.claude`; full `npm test` twice and `npm run typecheck` before each PR; a Fable code review before asking the owner to merge.
- **Two PRs, one starter bump each:**
  - 6a = Tasks 1–6, the shapes, starter 2.2.0. It also edits `calc.ts`, `homes.ts`, `workflow.ts`, `task-step.ts`, `agent-task.ts`, `agent-hook.ts`, `lifecycle.ts`, `workflow-skill.ts` and `uninstall.ts`.
  - 6b = Tasks 7–9, the interview, the opportunity rule and discovery, starter 2.3.0. It starts after 6a merges, and edits the starter's interview intents, INSTALL.md 9b and the operator rules, `agent-file.ts`, `workflow-skill.ts`, `consult.ts`, `lifecycle.ts`/`actions.ts` and `uninstall.ts`.
- Tests assert what code decides (schemas, `when`, levels, gates, what is written and removed), never what a model would say through the fake agent.

## Review Focus

1. **No shape reaches a person, a record or money without an approval.**
   - Every `channel.send`, `records.create`, `records.update`, `records.import` and `agent_call` in a shipped suggestion is an `approve` step; a test walks each suggestion and fails on any ungated write.
   - No `approve` uses `foreach` (refused at load, `workflow.ts` 265).
   - No L2/L3 `tool` step uses `foreach` (refused at run, `runner-steps.ts` 80).
2. **Shapes are recorded only when unchanged** (D159): a suggestion edited beyond trigger, skills and my_rules loses its shape. No path lets the agent's file set `shape`.
3. **The invoice amount is a financial field** (L3, decision maker), and no step of an invoice shape pays.
4. **Reading a file is confined to exact files TaskFollow's code chose:**
   - which files: the saved attachments named in the step's input, or the newest regular file in `<install folder>/meeting-notes/`, chosen by the runner;
   - each is `realpath`-checked inside its folder, and the size cap applies;
   - the meeting-notes folder itself is `lstat`-checked and refused when it is a symbolic link;
   - its absolute path goes into `hook.json`, and the hook allows `Read` only for those paths;
   - the model never chooses a path.
   - **Accepted limit:** a file swapped between the hook's `realpath` and Claude Code's read, by a process running as the same computer user (the same-user limit D159 records). Nothing more is claimed.
5. **Discovery never sends anything to TaskFollow but a workflow the owner chose to add.** The skill reads only through the agent's own tools and only the sources the owner names. It never writes, sends or deletes, and names no TaskFollow command but `workflow add`, `workflow suggestions` and `skills`.
6. **The owner's notes are never deleted.** Uninstall removes `meeting-notes/` only when TaskFollow created it and it is empty. Otherwise it leaves the folder and says so.

---

## 6a: the shapes (starter 2.2.0)

### Task 1: The fallback records (data contract, D166)

**Files:** `solutions/starter.json` (`data_contract`), `tests/unit/starter-minimum.test.ts`, `tests/unit/solution.test.ts`.

9.6: "when the owner has no tool for the job, the agent says so; Google Sheets (`records.*`, exists) is available as the fallback record." The starter's contract has only `contact`. D166 adds three record types; `contact` is unchanged:

- **`lead`:** key `email`; `name` (text, personal, required), `email` (email, personal), `source` (text: the channel it came in on), `status` (enum: `new`, `qualified`, `not a fit`, `waiting`), `next_step` (text), `notes` (text).
- **`invoice`:** key `id` (text: vendor plus invoice number); `vendor` (text, required), `amount` (money, **financial**, required), `currency` (text), `due` (date), `status` (enum: `to check`, `approved to pay`, `paid`), `file` (text: the saved attachment's reference).
- **`action`:** key `id` (text); `what` (text, required), `owner` (text, personal), `due` (date), `meeting` (text), `status` (enum: `open`, `done`).

The agent connects one only when the owner picks the fallback for that workflow: `taskfollow connect <entity> --sheet new` and `taskfollow map <entity>` (D68, D69), as INSTALL.md 9e says (Task 6). There is no new DATA-phase step.

- [ ] Failing tests:
  - `starter's contract has lead, invoice and action, and contact is unchanged`
  - `invoice.amount is tagged financial, so records.create of an invoice is L3`
  - `a lead's status outside its options is refused`

  Implement; pass; commit `feat(starter): fallback records for leads, invoices and actions`.

### Task 2: Lead qualification

**Files:** `solutions/starter.json` (suggestion `lead-qualification`), `solutions/shapes/lead-qualification/SKILL.md`, tests.

9.6 row: *a message from a new contact → fit and the next step, by the owner's rules → gated: the reply; the record write → reported: new leads and their status.*

- **Trigger:** `{"event":"message.received","from":"external","channel":"email"}`.
  - Email only, because a reply in the customer's thread (`reply_to`) exists only on email (`channel-tools.ts` 64), and the lead's key is an email address.
  - `when`: `all` of `services.email`=`email` and `services.records`=`google-sheets` (Order and dependencies: every records shape).
- **Known already? Both `lead` and `contact`, and that is sound only under this `when`.**
  - `records.find` throws on a record type that is not connected (`records.ts` 48).
  - `contact` is connected by the install's DATA phase exactly when `services.records` is `google-sheets`.
  - `lead` is connected when the shape is added (INSTALL.md 9e, before the dry run; the dry run fails in plain words if it was skipped).
  - Steps `known_lead` and `known_contact` are two L0 `records.find` steps on `{"email":"${event.from}"}`. Someone already in either is not a new lead.
- **Steps:**
  1. `qualify` (`judge`). Input: the message, marked untrusted, plus both lookups. Schema `{new: boolean, fit: "yes"|"no"|"unsure", next_step: string, reply: string, why: string}`.
  2. `save`: `approve records.create` on `lead`, with `status`, `next_step` and `source: "email"`; `when: qualify.new == true`.
  3. `reply`: `approve channel.send` with `reply_to`; `when: qualify.reply != ""`.
- **Reported:** the run's result is the lead line. With no channel to the owner it waits for `why` (level 1, D155).
- **Skill:** what a lead is, the three fit answers, that a known person is not a new lead, the reply's tone, and "never promise a price, a date or a discount the owner's rules do not give". Plus `references/my-rules.md` (who is a fit, what the next step is) and `references/examples.md`.
- **Home:** hard rule, so Home 1 when T7 passes. Otherwise draft-only (Home 2: the qualification and the reply text inside the brief to the owner) or by hand. `decideHome` is unchanged.
- [ ] Failing tests:
  - `lead-qualification loads and records its shape`
  - `it is offered only when email and Google Sheets were chosen`
  - `the sender is looked up in lead and in contact`
  - `the judge's input marks the message untrusted`
  - `save and reply are approve steps, conditioned on qualify.new and a non-empty reply`

  Implement; pass; commit `feat(shapes): lead qualification`.

### Task 3: CRM update

**Files:** `solutions/starter.json` (suggestion `crm-update`), `solutions/shapes/crm-update/SKILL.md`, tests.

9.6 row: *the owner says "note that X", or a message arrives → which record, and what changes → gated: the write, with a preview → reported: what changed.*

- **Two ways in, one shape:**
  - A message from the owner to their TaskFollow channel: `{"event":"message.received","from":"member"}`. `when`: `all` of two parts: `services.records`=`google-sheets`, and `any` of `services.telegram`=`telegram`, `services.email`=`email`, `services.slack`=`slack`, `services.whatsapp`=`whatsapp` (the `any` as the starter already writes it; an `all` may hold an `any`, `solution.ts` 157).
  - With no channel, the owner says it in chat, and the agent calls `records.update` itself through TaskFollow's tools (level 0, by hand). The same approval holds, because it goes through TaskFollow's tool, which T5 proves in chat.
- **Steps:**
  1. `which` (`judge`): schema `{entity: string, key: string, changes: object, found: boolean, question: string}`.
  2. `current`: `tool records.get`; `when: which.found == true`.
  3. `change`: `approve records.update` with only the changed fields; `when: which.found == true`.
- **The preview** is the approval item: D70 shows the current values and the change, and refuses a record changed since. Nothing new is built.
- **Owner's own CRM:** a described workflow (Global Constraints), writing through `agent_call`.
- [ ] Failing tests:
  - `crm-update loads and records its shape`
  - `with found false no records step runs and the result holds the question` (a scripted judge answer, asserting the `when` gates, not model behaviour)
  - `change is an approve step for records.update`
  - `the update is refused when the record changed after the approval` (D70's helper)

  Implement; pass; commit `feat(shapes): CRM update`.

### Task 4: Reading exact files in a task step

**Files:**
- `src/core/workflow.ts`: `parseMayUse` accepts the bare rule `Read`, and a task may declare `read_from: "attachments" | "meeting-notes"`.
- `src/core/task-step.ts`: the runner picks the files.
- `src/core/agent-task.ts`: `builtinTools` and the hook config.
- `src/core/agent-hook.ts`: `decide` for `Read`.
- Tests in `tests/unit/agent-hook.test.ts`, `tests/unit/agent-task.test.ts`, `tests/unit/task-step.test.ts` and `tests/unit/workflow.test.ts`.

9.6 says invoice processing has *"the agent read the file itself"*, and meeting follow-up reads `files`. Today a task allows only MCP tools and `Bash(...)`, and `may_use` goes verbatim into `--allowedTools` (`agent-task.ts` 83), so a made-up rule would match nothing.

- **The rule:** `may_use` may list the bare word `Read`. It passes to `--allowedTools` as `Read`, and `--tools` gains `Read`. A step that lists `Read` must say `read_from`, and a step with `read_from` must list `Read`; the workflow is refused at load otherwise.
- **Which files: TaskFollow's code picks them; the model never names a path.**
  - **`read_from: "attachments"`:** the saved attachments named in the step's interpolated input, exactly in D133's form (`ATTACHMENT_REF`, `attachments.ts` 17). Each is resolved through the existing `confinedPath` (`attachments.ts` 26, `actions.ts` 35), which refuses a link below the home. It is kept only if it is a regular file inside `realpath(<home>/data/inbox-files/)`.
  - **`read_from: "meeting-notes"`:** the runner first `lstat`s `<install folder>/meeting-notes/` itself and refuses it when it is a symbolic link or not a folder. It then chooses the newest regular file by modification time. It skips directories and other non-files, symbolic links (`lstat`), anything whose `realpath` is outside `realpath(<install folder>/meeting-notes/)`, and files over the attachment size cap (`MAX_ATTACHMENT_BYTES`, `mime.ts` 26).
    - Without a known install folder (`state.work_dir`), the step fails in plain words.
  - **For both kinds:** if no usable file is left, the step does not start the agent. The run ends with the plain message under "What the person sees", and nothing is spent.
- **Handing them over:** the chosen absolute paths go into the hook config (`hook.json`, a new `files` list next to `may_use`), and into the agent's input as `files: [{name, path}]`. `loadHookConfig` (`agent-hook.ts` 44–50) validates `files` as a list of absolute paths and treats anything else as damaged settings, which blocks.
- **Accepted limit:** between the hook's `realpath` check and Claude Code's own read, a process running as the same computer user could swap the file. This is the same-user limit D159 already records; nothing more is claimed.
- **The hook:** a `Read` call passes only when its `file_path` is absolute and its `realpath` equals one of those paths. Everything else is refused: relative paths, `..`, links out, folders, any other file, and every `Read` when no file was listed. The call record keeps the file's name, never its content (D142).
- **Why not `Bash(cat:*)`:** it is a valid rule today (`workflow.ts` 210), but it reads any file the computer user can read. The shapes never use it.
- [ ] Failing tests:
  - `Read allows exactly a listed saved attachment`
  - `Read refuses a relative path, a .., a link out, a folder and another file`
  - `Read is refused when no file was chosen`
  - `a reference outside data/inbox-files is dropped before the agent runs`
  - `meeting-notes: the newest regular file is chosen`
  - `meeting-notes: a symbolic link pointing out of the folder is skipped`
  - `meeting-notes: a directory or other non-file entry is skipped`
  - `meeting-notes: an empty folder gives the plain message and starts no agent`
  - `meeting-notes: a file over the size cap is skipped`
  - `meeting-notes: a folder that is a symbolic link is refused`
  - `attachments: no usable attachment starts no agent`
  - `loadHookConfig refuses a files list that is not absolute paths`
  - `a step listing Read without read_from, or read_from without Read, is refused at load`
  - `--allowedTools carries Read and --tools gains Read only when listed`

  Implement; pass; commit `feat(task): read exact files the runner chose`.
- **Unproven on the real Claude Code** until human task 38: that a restricted task with `--tools Read` reads a PDF, and that the hook sees `file_path`. Until then the summary's `reads:email-attachment` and `reads:files` lines stay as the doability check records them; nothing claims more.

### Task 5: Invoice processing

**Files:** `solutions/starter.json` (suggestion `invoice-processing`), `solutions/shapes/invoice-processing/SKILL.md`, tests.

9.6 row: *an email attachment (exists); the agent reads the file itself → vendor, amount, due date; **where the numbers go is the owner's call** (the agent asks; TaskFollow executes or flags a gap) → gated: recording it; anything paid is always a person → reported: due this week* (Task 5b).

- **Trigger:** `{"event":"message.received","from":"external","channel":"email"}`; `when`: `all` of `services.email`=`email` and `services.records`=`google-sheets`.
- **Steps:**
  1. `read`: a `task` with `may_use: ["Read"]` and `read_from: "attachments"`; input: the message's attachment references; schema `{is_invoice, vendor, number, amount, currency, due, file}`.
  2. `save`: `approve records.create` on `invoice`; `when: read.is_invoice == true`. It is L3 because `amount` is financial.
- **Where the numbers go:**
  - the shape writes to the `invoice` fallback;
  - when the owner names their accounting tool, a described workflow writes through `agent_call`;
  - when neither is possible, the agent states the gap in four parts (D163's words for `writes:records`).
- **Never paid:** the skill says paying is always the owner, by hand. No step pays.
- [ ] Failing tests:
  - `invoice-processing loads and records its shape`
  - `read may use only Read, from attachments, and its input carries the attachment references`
  - `an invoice record is L3 and waits for the decision maker`
  - `with is_invoice false the save step does not run`

  Implement; pass; commit `feat(shapes): invoice processing`.

### Task 5b: The weekly "invoices due" report (D166, a seventh shape)

**Files:**
- `src/core/calc.ts`: `where`.
- `src/core/workflow.ts`: `parseCalc` accepts `where`.
- `src/core/homes.ts`: `SHAPES["invoices-due"]`.
- `solutions/shapes/invoices-due/SKILL.md`.
- `solutions/starter.json`: suggestion `invoices-due`.
- `src/core/runner-steps.ts`: `runCalc` passes the zone and the run's clock.
- Tests in `tests/unit/calc-step.test.ts`, `tests/unit/homes.test.ts` and `tests/unit/workflow.test.ts`.

D166 amends D159's six v1 shapes to seven, although the review advised cutting this.

- **The `calc` filter, minimal.** `calc` gains an optional `where`, an object with at most these two kinds of keys:
  - `"<field>": ["<value>", …]` keeps rows whose field equals any listed value, exactly as text;
  - `"due_within_days": N` (1–366) keeps rows whose `due` field is a date (`YYYY-MM-DD`) on or before today plus N days. Overdue rows are kept.
- **Today, without guessing a zone.** `runCalc` (`runner-steps.ts` 155) has no handle on the workflow's settings, so the zone comes from the workflow's trigger:
  - `due_within_days` is accepted at load only when the trigger is cron, and the zone is its `trigger.tz`;
  - any other trigger is refused at load in plain words.
  - Today and the limit are built as `YYYY-MM-DD` text with `Intl.DateTimeFormat` in that zone, from the run's clock (`exec.ctx.now()`), and compared as text; never `Date.parse`.
- **Rows without a date.** A row whose `due` is empty or not a `YYYY-MM-DD` date is excluded from the count and the sum, and counted in a new `no_date` number, so it is not dropped silently.
- Anything else in `where` is refused at load. Without `where`, `calc` is unchanged.
- **The shape:** `SHAPES["invoices-due"] = { needs: ["answers", "reads:records", "skills"], hardRule: false }`. It is report-only, so it may run in either home: Home 1 when T7 passes, Home 2 when T8 passes.
- **Money on Home 2: list, never total.** On Home 2 the agent's own model would add the amounts, which D144 and INSTALL.md 9a.4 forbid ("never let a model add up money"). The shape keeps both homes, as D166 asks, and the template's `SKILL.md` says, for any run without TaskFollow's `calc`: *"List each invoice with its own amount and due date. Never add amounts up or give a total."*
  - The Home 1 run gets its totals from `calc`, so it may say them.
  - Keeping the shape on Home 1 only was rejected: D166 chose a report-only shape so it can run while the laptop is closed, and a list without a total keeps that within D144.
- **The suggestion:**
  - Trigger: cron `0 8 * * 1`, `"tz":"local"`.
  - `when`: `services.records`=`google-sheets`.
  - Steps:
    1. `open`: `tool records.find` on `invoice` with `limit: 100`. `records.find` matches one exact value per field, so it cannot select two statuses or a date range itself, and it returns at most 100 rows (`record-tools.ts` 15–16). The skill and the message therefore say *"the first 100 invoices in your sheet"* whenever 100 came back.
    2. `due`: `calc` from `${open}` with `where: {"status":["to check","approved to pay"],"due_within_days":7}`, `group_by: "currency"`, `sum: ["amount"]`.
    3. `say`: `judge`, writing the list in plain words with numbers only from `due`.
    4. The ending follows item 5's rule for inbox triage: `channel.notify` when the person has a channel; otherwise the run ends with the result, which waits for `why`.
- **Home 2 delivery:** it reads TaskFollow's own sheet through `records.find`, which an agent's own scheduler cannot reach. So Home 2 needs the agent's own Google Sheets tool, and the doability check's `reads:records` result (T2 records variant, T8) decides it. The template is tool-neutral, as item 5 requires.
- **Starter bookkeeping:** added in 6a's 2.2.0 with the other shapes; `invoices-due` is listed in INSTALL.md 9e.
- [ ] Failing tests (filter first):
  - `calc where keeps any listed status`
  - `calc where due_within_days keeps dates on or before today plus N in the trigger's zone, overdue included` (a clock near midnight UTC whose local date differs)
  - `calc where counts a row without a date in no_date and leaves it out of count and sum`
  - `calc where refuses an unknown key at load`
  - `due_within_days is refused at load for a workflow whose trigger is not cron`
  - `the invoices-due template says to list amounts and never total them`
  - `calc without where is unchanged`
  - `invoices-due is report-only in decideHome and may go to the agent's scheduler after T8`
  - `invoices-due loads and records its shape`
  - `its judge's input is the calc output`
  - `every SHAPES id has a template`

  Implement; pass; commit `feat(shapes): invoices due each week (D166)`.

### Task 6: Meeting follow-up, the notes folder, and the shapes in INSTALL.md

**Files:**
- `solutions/starter.json`: suggestion `meeting-follow-up`, version 2.2.0.
- `solutions/shapes/meeting-follow-up/SKILL.md`.
- `src/core/lifecycle.ts`: the add makes `meeting-notes/`.
- `src/core/workflow-skill.ts`: `Written` gains `notes_folder`.
- `src/core/uninstall.ts` / `removeWritten`.
- INSTALL.md: section 9 and a new 9e, "The workflows".
- Tests, including `tests/e2e/install-doc.test.ts`.

9.6 row: *the owner gives the notes or transcript (minimum scope) → action items, owners, dates → gated: creating tasks; sending notes → reported: the list of actions.*

- **One suggestion, one way into the runner** (within D166's "besides notes pasted in chat or emailed"):
  - The shipped `meeting-follow-up` has a manual trigger and `read_from: "meeting-notes"`. The owner drops the notes in `meeting-notes/` in the install folder, then runs `taskfollow run meeting-follow-up` (or asks the agent to).
  - Notes **pasted in chat, or emailed to the owner's agent**, are handled by hand in chat with the shape's skill (level 0). Creating tasks still goes through TaskFollow's `records.import` approval.
  - There is no second suggestion id and no emailed variant: `--value` may change only `trigger`, `skills` and `my_rules`, so an emailed variant would need a second trigger and `read_from` it cannot carry.
  - INSTALL.md 9e and "What the person sees" say this.
  - `when`: `services.records`=`google-sheets`.
- **The folder's lifecycle:**
  - `workflow add meeting-follow-up` makes `<install folder>/meeting-notes/` when the install folder is known and nothing is there. It records `{path, created: true}` in `state/written.json`.
  - An existing plain folder is used as it is and recorded with `created: false`.
  - A path that is a symbolic link (`lstat`) or a file is refused in plain words. Nothing is written, as `addWorkflow` refuses before writing (H4).
  - Without a known install folder, the add says so (like `noFolderNote`), and the chat way still works.
- **Uninstall (D109, 9.13 item 5: TaskFollow removes what it wrote and keeps the owner's records):**
  - The folder is removed only when all of these hold: it was `created: true`; `lstat` shows a plain folder, not a link; it is at the same `realpath`; and it is empty.
  - Otherwise it is left, and the uninstall output says so in `left`: *"meeting-notes/ was left: it holds your notes"*, *"…: TaskFollow did not create it"*, or *"…: it is no longer the folder TaskFollow made"*.
  - The owner's notes are never deleted.
- **The consult cleanup and continuing after it:**
  - The cleanup follows the same rule.
  - Because `removeWritten` deletes `state/written.json` (`workflow-skill.ts` 154), a folder the cleanup left (it holds notes) would lose its `created` record. So `restoreAfterConsult` (`consult.ts` 101) records the folder again on `taskfollow add install`, with `created: true` only when the consult's own record said so, which the cleanup keeps in the consult file.
  - (In practice the shape is not offered in a consult, Order and dependencies, but a hand-written `workflow add` there must still be safe.)
- **Steps:**
  1. `notes`: a `task` with `may_use: ["Read"]` and `read_from: "meeting-notes"`. Schema `{meeting: string, actions: [{id, what, owner, due}], send_to: string, summary: string}`; `owner`, `due` and `send_to` may be empty.
  2. `tasks`: one `approve records.import` on `action` with `rows: ${notes.actions}`. That is one approval for the whole list, L2 when it only adds (`import-tools.ts` 114). In a described version, `agent_call` for the owner's task app instead.
  3. `send`: `approve channel.send` of the summary to the one address the owner's rules name (`to: ${notes.send_to}`, for example a team list); `when: notes.send_to != ""`.
- **Hard rule, by the floor.** The shipped shape has `approve` steps, so `codeFloor` makes it hard-rule before `SHAPES`'s `"ask"` is read (`homes.ts` 63).
  - The check page's two questions (D159) apply only to a **described** version the owner writes without those steps, for example "just list the actions for me".
  - The shipped shape runs on Home 1, or by hand. It is not scheduled, so Home 2's scheduler is not offered, and the summary says so.
- **INSTALL.md 9e:**
  - One paragraph per shape, in plain words: what starts it, what it reads, what waits for the owner's yes, and where the result goes.
  - Each record-keeping shape says it needs the Google Sheet chosen at install. Each ends with "if you already use a tool for this, tell me which, and I will set it up with that tool instead" (the described-workflow path, sections 9 and 9a).
  - For meeting follow-up: the folder, or pasting in chat.
- [ ] Failing tests:
  - `meeting-follow-up loads and records its shape`
  - `workflow add makes meeting-notes/ and records created: true`
  - `an existing meeting-notes/ is recorded created: false`
  - `uninstall removes meeting-notes/ only when TaskFollow created it and it is empty`
  - `uninstall leaves a folder with notes and says so`
  - `uninstall leaves a folder TaskFollow did not create`
  - `workflow add refuses a meeting-notes that is a symbolic link`
  - `uninstall leaves a meeting-notes that became a symbolic link`
  - `add install after a consult records the left folder again`
  - `meeting-follow-up is hard-rule by the floor in decideHome`
  - `every shape that uses records.* is offered only when Google Sheets was chosen, and none of them in a consultation`
  - `the notes schema allows an action with no owner or date`
  - `tasks is one approve of records.import with the actions as rows`
  - `no shipped suggestion has an approve or an L2/L3 tool step with foreach`
  - `every shipped shape loads, dry-runs and records its shape` (the seven, with item 5's)

  Implement; pass; commit `feat(shapes): meeting follow-up and its notes folder; INSTALL.md 9e`.

## 6b: the interview, the opportunity rule, discovery (starter 2.3.0, after 6a)

### Task 7: The interview proposes from the shipped shapes

**Files:** `solutions/starter.json` (`workflows.choose` and `consult.choose` intents, version 2.3.0), INSTALL.md 9b item 1, `tests/e2e/operator.test.ts`.

9.4: *"the interview proposes workflows from the five shapes (9.6) and anything else the owner's day suggests; the owner picks; the owner's answers go into the workflow's skill (`references/my-rules.md`)."*

- **After the walk-through of the week:** the agent compares what the person said with `taskfollow workflow suggestions`, proposes the matching shapes first in the person's words, then anything else their week suggests. For each, it asks which tool they use for it today ("which CRM do you use now?", 9.6).
- **No tool named:** add the suggestion with `--value` carrying only `trigger`, `skills` and `my_rules`, plus two or three real past items for `references/examples.md`.
- **A tool named:** write a described workflow with that tool (sections 9 and 9a). It is not the shipped shape, so the check page asks its two questions (D159).
- **At the end of the interview,** at most one line: *"Not sure what repeats in your week? Ask me to find your repetitive work any time."* (D165: on demand, nothing automatic.)
- [ ] Failing tests:
  - `the interview intent names the shipped shapes, asks which tool the person uses, and says a named tool makes a described workflow`
  - the operator walk adds one shape with `my_rules`, and finds them in `references/my-rules.md` with the shape kept

  Implement; pass; commit `feat(starter): the interview proposes from the shipped shapes`.

### Task 8: The opportunity rule

**Files:** INSTALL.md (Operator rules, a new rule 14), `src/core/agent-file.ts` (one line in the TaskFollow section of `CLAUDE.md`), `tests/e2e/install-doc.test.ts`, `tests/unit/agent-file.test.ts`.

9.4: *"whenever anyone (the model, TaskFollow, any trigger) sees repetitive work that could be a workflow, it says so, shows the proposed workflow, and the owner approves or gives feedback. Nothing is created without a yes."* and *"Most of that widening is an operator rule (level A), not new machinery."*

Rule 14, as written:

> 14. When you notice work that repeats, in what the person asks you to do, in what a workflow's results show, or in a suggestion TaskFollow noticed, say so in one sentence and show the workflow you would set up: what starts it, what it reads, what it may change, and what waits for their yes. If they give feedback, change it and show it again. Add it only after they say yes; never create, change or turn on a workflow without one. Propose each kind of work once; propose it again only if they ask.

The `CLAUDE.md` section gains one line: *"When you notice work that repeats, offer to set it up as a workflow (INSTALL.md, operator rule 14); nothing is created without the owner's yes."* This line is the one thing item 6 adds beyond D165's wording. It is kept because Claude Cowork reads `CLAUDE.md` (the D156 assumption, human task 36), while INSTALL.md is read only in a setup session.

- [ ] Failing tests: `INSTALL.md has operator rule 14`; `the CLAUDE.md section has one opportunity line`. Implement; pass; commit `docs(install): the opportunity rule`.

### Task 9: Discovery: the "find my repetitive work" skill (D165)

**Files:**
- new `solutions/skills/find-my-repetitive-work/SKILL.md`;
- `solutions/starter.json`: an `auto` step at the start of the WORKFLOWS phase, for install and consult alike, that writes the skill;
- `src/core/workflow-skill.ts`: write it and record it in `state/written.json`;
- `src/core/lifecycle.ts` / `src/core/actions.ts`: the auto action;
- `src/core/uninstall.ts` and `src/core/consult.ts`: remove it;
- INSTALL.md 9b: a new item, "If the person is not sure what repeats";
- tests.

D165 settled four parts: A, "I noticed" (D148/D164), unchanged; B, the interview (Task 7); C, the opportunity rule (Task 8); D, this skill, on demand only. There is no weekly scheduled scan.

- **Where it lives:**
  - It is written into the agent's project skills folder (`.claude/skills/find-my-repetitive-work/` for Claude Code) at the start of the WORKFLOWS phase, so it is there during the interview.
  - For an agent without a known skills folder, it goes under the TaskFollow home (`exports/find-my-repetitive-work/SKILL.md`), and INSTALL.md 9b tells the agent to read it from there.
  - There is no Cowork zip. Discovery runs in the owner's chat with the agent that set things up, and the skill names `taskfollow workflow add`, which `checkDelivered` refuses for an agent's own scheduler (`deliver.ts` 24, 78).
- **The skill, when the owner asks** ("find my repetitive work", "what could I automate?"):
  1. Ask which places to look at (their email, calendar, files, chat history with you) and how far back (four weeks unless they say otherwise). Look only there, only with your own tools, only in this chat.
  2. Read only. Never send, reply, write, move, label or delete anything while looking.
  3. List what repeats, one plain line each: what the work is, about how often, which service it touches, and which of the shipped workflows it resembles, or "something new". Quote no message, and name no person unless the owner asks you to.
  4. Ask the owner to confirm or drop each line.
  5. For each confirmed line, propose a workflow as INSTALL.md 9b says, and add it with `taskfollow workflow add` only after their yes, with their own words as the description and their rules as `my_rules`.
  6. Nothing you read leaves this chat except what the owner confirms in step 5.
- **How a confirmed pattern reaches TaskFollow:** only as the description and `my_rules` of a workflow the owner chose to add, through the existing `workflow add`. TaskFollow stores nothing else and gets no new command or tool (Review Focus 5).
- [ ] Failing tests:
  - `the WORKFLOWS phase writes the discovery skill and records it`
  - `uninstall and the consult cleanup remove it`
  - `an agent without a skills folder gets it under exports/`
  - `its text names no TaskFollow command but workflow add, workflow suggestions and skills` (a grep on `taskfollow ` and `mcp__installer`)

  Implement; pass; commit `feat(skills): find my repetitive work (D165)`.

### Task 10: Records, human tasks, PRs

- **Decisions** (next free D-numbers when built):
  - the fallback records as built (D166's choice);
  - the `Read` rule with `read_from` and the runner's file choice;
  - each shape's steps and gates;
  - the `calc` filter and the seventh shape;
  - the notes folder's lifecycle and uninstall rule;
  - the interview's change;
  - rule 14's text;
  - the discovery skill's place.
- `docs/next-steps.md` build map rows 6a and 6b; INSTALL.md 9e.
- **Human task 38 (owner, about 20 minutes):** on the real Claude Code, version 2.1.295 or later (the task command's minimum, D151):
  - a restricted task with `Read` reads a PDF invoice saved by the email channel, and the newest note in `meeting-notes/`;
  - the hook's record shows each file's name;
  - a path the runner did not choose is refused.
- **Human task 39 (owner, about 20 minutes, after #40 and task 38):**
  1. Send one test invoice to the TaskFollow email address. The invoice record waits for approval; after yes, it is in the sheet.
  2. A manual run of `invoices-due` lists it with its total.
  3. One meeting note dropped in `meeting-notes/` gives a list of actions that waits for one approval.
- **Human task 40 (owner, about 10 minutes):** in a fresh chat, ask the agent to "find my repetitive work" on the test Gmail.
  - The list quotes no message and names nobody.
  - Adding one confirmed workflow is the only thing TaskFollow receives: `taskfollow why` and the audit show only `workflow.added`.
- Typecheck, full suite twice, Fable code review, fixes, and a PR in plain words per part (what was built and why, what the person sees, a building-blocks table of files and messages, how it was tested). The owner merges.

---

## What the person sees (exact messages)

- **Suggestions** (`taskfollow workflow suggestions`):
  - *"Lead qualification: when someone new emails you, sorts out whether they are a fit and what to do next, and drafts the reply. You approve the reply and the new lead before anything is sent or saved."*
  - *"CRM update: when you tell me 'note that …', finds the record and shows you the change; nothing is saved until you say yes."*
  - *"Invoice processing: when an invoice arrives by email, reads the vendor, the amount and the due date, and records it where you choose once you approve. It never pays anything."*
  - *"Invoices due: every Monday, the invoices still to pay this week, with their total."*
  - *"Meeting follow-up: put your meeting notes in the meeting-notes folder and run it, and it lists who does what by when; creating tasks and sending the notes wait for your yes. Notes you paste here or email me, I handle with you in this chat."*
- **Read refused** (call record and `why`): *"Refused: this step may read only the files TaskFollow gave it."*
- **No meeting note:** *"There is no note in meeting-notes/ yet. Put the notes or transcript there as a file, or paste them in this chat."*
- **No usable attachment:** *"This email has no attachment TaskFollow could hand over, so nothing was read."*
- **Invoices due, 100 rows came back:** *"…from the first 100 invoices in your sheet."*
- **A records workflow without Google Sheets** (the agent, from 9e): *"This one keeps records, and you didn't choose a Google Sheet at install. Tell me the tool you use and I'll set it up with that, or add a Google Sheet."*
- **Meeting-notes folder left at uninstall:** *"meeting-notes/ was left: it holds your notes."*
- **No tool for the job** (the agent, from 9.6): *"You don't have a tool for <leads | invoices | tasks> that I can use. I can keep them in a Google Sheet in your own account instead, or you can tell me the tool you use."*
- **End of the interview:** *"Not sure what repeats in your week? Ask me to find your repetitive work any time."*
- **Discovery, the format of each line in step 3:** *"About <n> times a week: <what the work is>, in <service>. Looks like <shape | something new>. Keep it or drop it?"*

## Risks

- **Several message workflows on one email.** Lead qualification, invoice processing and an order-questions workflow all start on `message.received`. Each runs, and each ends quietly when the message is not theirs. The cost is one judge or task per workflow per email. INSTALL.md 9e says so; item 6 does not change it.
- **Read in a restricted task** may behave differently on the real Claude Code (task 38). If it does not work:
  - invoice processing falls back to the owner's own email tool in `may_use` (a described workflow);
  - meeting follow-up keeps the chat way;
  - Task 4's `Read` is dropped.
- **Invoices due on Home 2** needs the agent's own Sheets tool; without it, it stays on Home 1 or by hand, and the four-part page says so.
- **Existing installs** pinned to an older starter have no `lead`, `invoice` or `action` record type until they start again with the new starter. The owner's test home is one of them.

## Out of scope

- A weekly scheduled patterns scan (option E, rejected in D165), and any change to "I noticed" (D148/D164).
- `calc` filters beyond the two `where` forms above.
- Learning into `my-rules.md` (item 8).
- Paying, in any shape; sending to customers outside an approval.
- New channels, or reading the owner's mail through anything but TaskFollow's email channel or the agent's own tools.
- Owner-named tools beyond what approve-agent-call (D151) gives.

## The owner's answers

- **Records, the weekly invoices report and the notes folder: D166** (2026-10-16).
  - New `lead`, `invoice` and `action` record types; leads are not kept in `contact`, though the lead check also looks there to see who is known.
  - A separate weekly invoices-due report, the seventh shape.
  - A `meeting-notes/` folder, besides chat and email.
- **The discovery skill is on demand,** with at most one line at the end of the interview and nothing automatic (D165).
- **The opportunity rule** proposes each kind of work once, and again only if the owner asks (the D148 precedent).

## Fable review of 2026-10-16, applied

- **Item 5's format adopted** (A1–A6); human tasks renumbered 38–40 (A7).
- **B1:** meeting actions as one `records.import` approval.
- **B2:** `Read` bound to exact files TaskFollow's code chose, with the paths in the hook config and a plain `Read` in `--allowedTools`.
- **B3:** lead qualification on email only.
- **B4** (the weekly invoices report) and **B5** (the notes folder) were cut by the review, then **restored by the owner in D166**, with the filter kept minimal and the folder read through B2's exact-path design.
- **B6:** the discovery skill written at the WORKFLOWS phase, no Cowork zip.
- **B7:** rule 14 in INSTALL.md plus one `CLAUDE.md` line.
- **B8:** tests assert schemas and `when`, not model behaviour.
- **B9:** 6b after 6a, with its real file list.
- **No finding rejected.** Each cited line was checked: `workflow.ts` 265, `runner-steps.ts` 80, `agent-task.ts` 83 and 99, `actions.ts` 35, `attachments.ts` 17, `channel-tools.ts` 64, `deliver.ts` 24 and 78, `import-tools.ts` 114, `solution.ts` 131 and 157.

## Fable confirmation review of 2026-10-16 (at a549598), applied

- **1 (records need Sheets):** every shape that uses `records.*` carries `services.records`=`google-sheets` in its `when`; crm-update uses an `all` of that and the any-channel answers. The owner's own tool is the described-workflow path (9e). These shapes are not offered in a consultation, because `services.records` is install-only; this differs from item 5's inbox shapes, which need no records (D163).
- **2 (meeting follow-up):**
  - The shipped shape is hard-rule by the floor (`homes.ts` 63); the check page's questions apply only to a described version.
  - One suggestion: a manual trigger reading `meeting-notes/`. Notes pasted or emailed are handled by hand in chat.
  - Its `send` is one approval to one address.
- **3 (Read confinement):**
  - The notes folder is `lstat`-checked at add, at run and at uninstall.
  - Attachments go through `confinedPath`.
  - No usable file means no agent run, for both kinds.
  - `loadHookConfig` validates `files`.
  - `Read` and `read_from` must come together.
  - The same-user window between the hook's check and the read is an accepted limit (D159).
- **4 (invoices due):**
  - `limit: 100`, said in the message.
  - The zone comes from the cron trigger's `tz`, and `due_within_days` is refused for other triggers. Dates are compared as `Intl`-built text; overdue rows are kept; `no_date` rows are left out of count and sum.
  - On Home 2 the skill lists amounts and never totals them (D144), keeping D166's either-home.
- **5:**
  - The calc tests are in `calc-step.test.ts`.
  - `restoreAfterConsult` records the notes folder again.
  - Human task 38 needs Claude Code 2.1.295 or later.
  - The `CLAUDE.md` line is named as the one addition beyond D165.
- **No finding rejected.** One citation was corrected: `removeWritten` deletes `state/written.json` at `workflow-skill.ts` 154, not 160. The other cited lines match: `records.ts` 47–48, `homes.ts` 63, `attachments.ts` 26, `actions.ts` 35, `agent-hook.ts` 44–50, `record-tools.ts` 15–16, `runner-steps.ts` 155, `consult.ts` 101; consult skips `services.records` (`starter.json` 292–309).
