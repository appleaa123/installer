# TaskFollow scope refresh

Started 2026-10-15. Sections 1–8 are the discussion record. **Section 9 is the scope**, settled by the owner on 2026-10-15: the numbered entries in `DECISIONS.md` and the rewrite of `docs/next-steps.md` derive from it. Until that rewrite, the current scope (`docs/next-steps.md`) is finished as planned (9.1).

## 1. Why TaskFollow exists (the owner's vision)

The idea started with a real Ontario realtor team, then widened to any business owner who wants to use their AI agent but cannot afford someone to build a vertical agent for them.

Two remarks from other developers shaped it:

> "Nowadays we just use skill + AI state machine for clients. AI agents like Claude Code, Codex, OpenClaw, Pi or Hermes and the base LLM can already write a plan and execute it. An AI state machine can monitor the status of execution. Agent development can now avoid LangGraph entirely."

> "I wrote my own harness and graph workflow; the core is set. I just need to write skills and tool sets."

So TaskFollow is a **thin layer** ("shell") around the agent the owner already has. It:
- guides a non-technical owner, step by step, to set up their agent,
- helps them find which work to automate,
- runs those workflows,
- and uses skills from Skills Wiki (MCP) or skills already installed in the agent.

The goal: owners no longer need someone to set this up for them, or at least they get a real taste of what an AI agent can do in their own work before they hire a professional.

### What businesses use agents for (owner's research)
- **Back-office work:** inbox triage, lead qualification, CRM updates, invoice processing, meeting follow-ups (action items, tickets). **This is TaskFollow's target.**
- **Systems administration:** firewalls, servers, CVE research. Not a fit for non-technical owners and high risk, so likely a non-goal.
- **What agents do well:** use tools across systems (spreadsheets, databases, web apps without APIs), judge from context, and run multi-step chains with a human overseeing the critical decisions.

## 2. How the scope grew (review of 2026-10-15)

| Version | Date | Scope |
|---|---|---|
| The client's need | before 10-06 | Five realtor problems (`DECISIONS.md` §1.1), served by installing the Skills Wiki realtor combo onto the team's own agent. |
| The first spec | 10-06 (D1–D34) | Already a general platform: six agents, "any business" (D27), its own gateway, a runner with hardening and replay, earned autonomy, shadow upgrades, certification. |
| Today | 10-15 (D150) | TaskFollow for any non-technical person: four channels (Telegram, email, Slack, WhatsApp), Windows, agent tasks, watching, "I noticed". About 16k lines and 1,868 tests. |

Findings:
- None of the five realtor problems has a workflow or recipe. A realtor recipe was never on the roadmap.
- `DECISIONS.md` §1.3 (gaps in the realtor skills) and §9 (follow-up skill edits) are still open from day one.
- The v1 non-goals from the spec (§1.2) all held: no hosted SaaS, no remote access, no fleet console, no industry logic in the engine.
- The redirections were recorded decisions, each made by the owner: D124 (the name), D126 (Skills Wiki optional), D136 (use the agent's own tools), D149 (WhatsApp).

## 3. Agreed in discussion (not yet decisions)

1. **Thin layer.** Guidance (instructions, skills, step-by-step setup) works on any agent, because every capable agent reads Markdown and runs commands. Enforcement does not carry across agents in the same way (section 4).
2. **Local skills are first-class.** Skills already installed in the owner's agent are used like any other. Skills Wiki is an optional add-on for people who have no skills yet: it adds ready-made skills and combos (skills plus harness instructions) without local installs, and it learns. This changes D126, which says skills come only from Skills Wiki.
3. **The agent owns** tools, MCP servers, CLIs, skills, API keys and sign-ins, and does the work. **TaskFollow owns** the setup steps, the workflow definitions and the interview that customises them, the schedule and run record (the "state machine"), the approval gate, and telling the owner what happened and why.
4. **Messaging.** For v1, the agent's own chat is enough: for example, after scanning email the agent says "10 properties to visit today to collect cheques" and asks before acting. Telegram, WhatsApp and Slack are extras: good experience, but they need more work and there is no user feedback yet.
5. **Keys.** Never paste a key into the chat. The owner enters it on the service's own page or in the agent's settings. Many agents store keys in plain-text config, so TaskFollow keeps teaching this rule.
6. **Basic workflows ship as shapes; the owner customises them.** TaskFollow covers the basic workflows above (inbox triage, lead qualification, CRM updates, invoice processing, meeting follow-ups). Each owner's specifics come from the owner. Example: in inbox triage, a realtor flags property repairs and a store owner pulls every Shopify return email. TaskFollow cannot and will not build every standard or benchmark for every business.
7. **First users.** The owner is user one. Friends in different industries follow, the realtor team among them. The owner's own test proves the workflows are useful. It cannot prove that a non-technical person can install it alone; a friend's run of `docs/testing/2026-10-14-real-life-install-test.md` (task 23) does that.

## 4. How much can a thin layer enforce?

**Lesson from Skills Wiki:** its harness puts human-in-the-loop rules into the prompt. `core/harness_compile.py` emits `<hitl_tool_rules>`: "present the plan… and get the user's confirmation before invoking the `write_file` or `run_shell` tools". Its own comments call the loop limits "advisory only… enforcement lives in the CLI orchestrator", and `combo_gate` returns advice only. **A prompt is a request, not a guarantee.** It weakens with drift, with a weaker model, or with injected text in an email the agent reads.

Four levels, from most to least universal:

| Level | What it is | Works on | Strength |
|---|---|---|---|
| A. Instructions | Rules in SKILL.md, `AGENTS.md` (read by Codex and many other agents), `CLAUDE.md` (Claude Code; it can import `AGENTS.md`), Skills Wiki's harness | Every agent | Advisory. Shapes behaviour; can be ignored. |
| B. The agent's own permission system | Claude Code: `permissions.ask` / `deny` in settings. Codex: sandbox, approval policy, rules files. Others: unknown until checked. | Each agent its own way | Enforced by the agent's program, not the model. |
| C. A gate inside TaskFollow's own tools | A tool refuses to act without an approval bound to that exact action (D23, D58). Any agent that speaks MCP or runs a CLI goes through it. | Every agent | Enforced, but only for actions that go through TaskFollow. If the agent calls its own Gmail tool directly, the gate is bypassed. |
| D. Hooks around the agent | The task gate and watching (D137, D146) | Claude Code (proven, tasks 25–26) | Enforced on Claude Code. On other agents, hooks let calls through when they fail (D150), so they can record but not gate. |

**"Ask the agent how to enforce it"** fits level B and follows the original principle D7 ("the host agent is the adapter"). The pattern:
1. TaskFollow states the intent: "always ask me before sending email, paying, or deleting".
2. The agent sets it up in its own permission system, using its own documentation.
3. TaskFollow **verifies** it with a harmless test: does a test send actually ask?

The agent's answer is a claim until the test passes.

**Enforcement for a thin v1 (agreed 2026-10-15):**
- **Level A everywhere.** Every workflow skill and the agent's instruction file say what needs approval.
- **Level B as a guided setup step,** checked by a test.
- **Level C for the actions that must never happen without a person:** sending to customers, money, legal, deletes and bulk changes (the D24 floor). Those go through TaskFollow's tools.
- **Level D only where it is already built** (Claude Code).
- **The report says honestly which levels each install reached** (R5).

## 5. Workflows delivered as skills

Agreed 2026-10-15: this section is the intended design.

### The split
- **TaskFollow's workflow file** says *when* and *what is gated*: trigger or schedule, steps, approvals, run record.
- **A skill** says *how to judge*: instructions, the owner's own rules, examples.

The workflow file is the state machine. The skill is portable Markdown the owner can read and edit.

### Yes: a full skill folder when it is needed
This follows the skill-creator guidance:

```
<agent's skills folder>/inbox-triage/
  SKILL.md                 # frontmatter (name, description) + steps, what needs approval, output format
  references/my-rules.md   # the owner's specifics from the interview (what to flag, who matters)
  scripts/                 # optional: deterministic, repeated work (fetch, format, totals)
  assets/                  # optional: reply templates, report template, sample outputs
```

Skill-creator guidance applied here:
- The **description** decides when the skill is used. Agents tend to under-use skills, so it should be specific and a little "pushy".
- Keep **SKILL.md under about 500 lines.** Put detail in `references/`; the agent loads it only when needed.
- Put work in **`scripts/`** when every run would otherwise rewrite the same helper. Scripts run without being loaded into the context.

### Who writes which part
- **TaskFollow ships the shape:** SKILL.md and the scripts, tested by us. Scripts are written in Node, because TaskFollow already requires Node.
- **The agent and the owner fill in `references/my-rules.md`** during the setup interview.
- **Scripts are not generated per owner by default.** Code the owner cannot review is a risk; owner-specific text is not.

### How enforced is it?
- **Triggering.** A scheduled run does not depend on the agent choosing the skill: TaskFollow's runner names the skill in the prompt. Only chat use depends on the description, so add a pushy description plus one line in `AGENTS.md`/`CLAUDE.md` listing the owner's workflows.
- **Drift within a run.** Several layers catch it:
  - scripts do the mechanical parts;
  - the runner checks the answer against the output format, retries once, then marks the run "needs a person" (D16);
  - the approval gate covers consequential actions (section 4);
  - every run is recorded and `why` explains it.
- **Testing.** Each workflow keeps a few examples from the owner's real past items, with the expected result (the skill-creator eval loop). Rerun them when the skill changes.
- **Learning.** When the owner edits or rejects a draft, the agent proposes a change to `references/my-rules.md`. It is written only after the owner approves it. This is the local version of Skills Wiki's `learning_record`.
- **To verify.** Do the agent's local skills load inside TaskFollow's restricted task run (`claude -p --restricted`)? Task 25 proved that MCP servers do; skills were not checked.

## 6. Flagging what the owner's agent cannot do

The owner's idea (2026-10-15): during setup or daily work, when a workflow needs something the owner's agent does not offer, TaskFollow says so in plain words. It explains what is missing and why it matters, and lists what the owner can do instead. Example: "This workflow needs a hook (a check the agent runs before every action, so nothing is sent without you). Codex does not offer one that blocks reliably. Here is what you can do instead."

Parts of this exist today:
- the probe (D32) tests the agent's abilities during setup;
- the report has a "ready with limits" status (R5: never fake coverage);
- `watch on` and `watch ask` refuse in plain words on agents other than Claude Code (D150).

What is missing is linking each workflow's needs to the agent's abilities.

**How it would work:**
1. **The agent's abilities are tested, not looked up.** The probe tries each ability with a harmless test and records the result. Documentation is not enough: the Codex research found hooks that are documented but let calls through when they fail (D150), and only a test shows that.
2. **Each workflow declares what it needs.** Examples: "runs while you're away", "asks before sending" (level B), "a gate in TaskFollow's tools" (level C), "a hook" (level D), "this skill loads in an unattended run".
3. **TaskFollow compares the two:**
   - at setup;
   - when a workflow is added;
   - in the daily `doctor` check, which tests again when the agent's version changes, because an update can add or remove an ability.
4. **Each gap is shown in plain words** with four parts:
   - what is missing;
   - why the workflow needs it;
   - what happens without it;
   - the owner's options.

**Typical options for the owner, from safest:**
- send the action through TaskFollow's own tool, so the gate (level C) holds on any agent;
- keep the workflow **draft-only**: the agent prepares everything, and the owner sends or acts;
- run the workflow by hand, with the owner watching, instead of on a schedule;
- turn on the agent's own "ask every time" mode, if it has one;
- use another agent that has the ability for this one workflow.

**Honesty rules:**
- Some gaps have no workaround. Then the workflow stays draft-only, and the flag says so.
- TaskFollow never claims a protection it did not test.

## 7. The emerging v1 shape

> **TaskFollow v1** = step-by-step setup + basic workflow shapes + an interview that turns the owner's specifics into local skills + a schedule and run record + an approval gate the owner sees in their agent. Everything else (tools, MCP, keys, skills, doing the work) belongs to the owner's agent. Skills Wiki is an optional add-on.

| | Items |
|---|---|
| Core, built | Setup steps and guided pages, workflow runner and run log, task steps through the agent, approvals, `why`, the setup interview (D140, D145) |
| Core, missing | Local skills as first-class (D126 says otherwise); the five basic workflow shapes as skill folders (only the Shopify examples exist); the guided level-B permission step with its test; workflow needs compared with the agent's tested abilities, with plain-words gap flags (section 6) |
| Built, kept, no new work in v1 (9.8) | Telegram, email, Slack and WhatsApp channels and the gateway; hardening and replay; earned autonomy; shadow upgrades; per-agent certification; Codex (D150) |

## 8. Open questions (all answered in section 9)

1. When a scheduled run needs approval and no chat session is open, where does the owner see it? → 9.4.
2. What happens to the built extras, and is approve-agent-call core? → 9.8.
3. Which agents does v1 promise? → 9.7.
4. Where does TaskFollow write a local skill? → 9.5.
5. Does TaskFollow ship the basic workflow shapes itself, or as a Skills Wiki pack? → 9.9.

## 9. The scope

Settled by the owner on 2026-10-15, after the discussion above. The owner's answers are the source; where a line below changes an earlier section, section 9 wins.

### 9.1 Two scopes side by side

- **Current scope, finish as planned** (from `docs/next-steps.md`, nothing added): task 28 and PR #40 (approve-agent-call, D151), PR #39 (flaky tests), publish to npm. Task 23 (a real-person install) moves to the end of v1: the owner and every other user try the product as it is after this adjustment, not before.
- **v1 scope:** the rest of this section. From here on, every review says which of the two it measures against.

### 9.2 The goal, in the owner's words

> Build this project for the general public: any business owner who wants to leverage their AI agent but can't afford to hire someone to build a vertical agent. A "shell" or layer that helps non-technical business owners set up an AI agent that can help them run their business, by step-by-step instructions, workflow identification and execution, and skills via Skills Wiki MCP or their locally installed skills. That way, business owners no longer need people to set this up for them, or at least get a chance to try AI agents in their real-life work.

TaskFollow is a thin layer on top of the agent the owner already has (Claude Code, Codex, Antigravity, Pi, OpenClaw, Hermes, …). **It does not change the agent and does not add capabilities to it.** It turns the agent the owner has into a "vertical" agent: the knowledge of which skills to use, which workflows to run, when to loop in a person, and whatever else a commercial, customised agent would offer. The agent's own model does the thinking: it gathers the inputs, asks the questions, chooses the tools and decides. TaskFollow executes what it can, or flags the gap and says why and what to do instead.

**The hard rules.** Money, legal matters, messages to customers, and deletes are hard-coded: when a workflow or a chat request runs into one of them, a person is asked, every time, however confident the model is. This exists today for every action that goes through TaskFollow's tools: the floor (D24, compiled in `src/core/levels.ts`, D59) and the approval on every external message (D79). The honest limit: when the agent calls one of its own tools directly (its own email server, for example), TaskFollow's code is not in the path. There the rule is enforced by the agent's own permission system (level B, set up and tested in 9.3) and by hooks where the agent has them (level D); where the agent offers neither, that is a gap, flagged in plain words (section 6).

In the terms of the two developer remarks in section 1: the *harness* is TaskFollow's setup, the operator rules in INSTALL.md, the agent-level file, and the hard rules; the *graph workflow* is the workflow file, described by the owner and run by the state machine; the *skills and tool sets* are the workflow skills and the agent's own tools. The core is set. What remains to write is skills and workflow shapes.

Three deliverables follow from the goal (9.3–9.5), plus the five back-office workflows from the owner's research (9.6). Nothing else is in v1 unless the owner adds it.

### 9.3 Deliverable 1: step-by-step setup

The owner owns their keys and every integration. TaskFollow helps them set up; it never holds their accounts.

- **Exists:** the one-sentence install, the agent leading the steps, the owner's own accounts and keys entered on local pages, the guided pages, the probe, the report.
- **Build:**
  - the "ask me before sending, paying or deleting" step (level B, section 4): TaskFollow states the rule, the agent sets it up in its own permission system, TaskFollow checks it with a harmless test;
  - gap flagging (section 6): each workflow declares what it needs, the probe's tested abilities are compared, and each gap is shown in plain words with the owner's options.

### 9.4 Deliverable 2: workflow identification and execution

The owner's version: *"I tell you my day, you tell me how to automate my day."*

- **Exists:** the interview ("walk me through your week"), the runner (the state machine: triggers, schedule, run record, `why`), task steps through the agent's own tools, approvals, `calc`.
- **Build:**
  - the interview proposes workflows from the five shapes (9.6) and anything else the owner's day suggests; the owner picks; the owner's answers go into the workflow's skill (`references/my-rules.md`, section 5);
  - **the opportunity rule:** whenever anyone (the model, TaskFollow, any trigger) sees repetitive work that could be a workflow, it says so, shows the proposed workflow, and the owner approves or gives feedback. Nothing is created without a yes. The agent is never limited to a fixed set of workflows a developer wrote for the owner.
  - **What exists today for observing:** "I noticed" (D148) is narrow. With watching on (opt-in, Claude Code only), TaskFollow looks once a day at the agent's own calls to the services the owner chose to watch; a service used on five or more of the last 28 days gets one message to one person, once, suggesting they describe that work; then the interview runs. It observes what the agent is used for, not the owner's day, and it never sees email or messages. The opportunity rule widens it: the model proposes in chat whenever it notices repetition in what it is asked to do or in what a workflow reads. Most of that widening is an operator rule (level A), not new machinery.
- **The bare minimum, and everything else optional.** Assume a real user is trying the product with no trust. They expect the bare minimum: *"just scan my email inbox daily and tell me here which property needs a visit"*, where "here" is the chat of their own agent. The install must work with nothing but the agent and the one service the workflow reads. Telegram, email reports, Slack and WhatsApp are optional, for a better experience, if the owner chooses them.
  - **How the owner is told, as a ladder.** An open chat window does nothing on its own: it speaks when the owner types, or when something pushes a message into it. A scheduled run happens in the background and cannot type into the window. So:

    | Level | How the owner is told | Needs |
    |---|---|---|
    | 0 | The owner asks; the agent scans and answers in chat (`taskfollow run`, exists) | Nothing new |
    | 1 | The run happened at 8:00; the agent tells the owner when they next speak (the result is in the run record, D86; `taskfollow why`) | One operator rule; workflow shapes end with the result, not a channel message, when no channel exists |
    | 2 | The agent speaks first, in the open window | The agent's ability to receive pushed messages (Claude Code Channels, research preview); **probed and flagged only** in v1 |
    | 3 | Telegram, email, Slack, WhatsApp | Exists; offered when the owner wants to be told away from the computer |

    **v1 is level 1.** Level 2 is a probe so the report says honestly which level an owner has. Today Telegram is required (START-HERE's prerequisites, the starter's first steps, `channel.notify` for reports and notices); v1 makes it optional. Nothing new is stored: the run record already holds every result.
  - **The next level is a gap flag, not a default.** When the owner's wish needs more than their setup gives ("tell me at 8 while I'm away", on a laptop that will be closed, or on an agent that cannot be pushed to), TaskFollow says so the way section 6 says every gap: *"Want this done every morning at 8 even if you're not here? Then keep the laptop on, and if you'd like to be told away from the computer we can set up Telegram or email."* Same mechanism as the hook flags: the workflow's need, the agent's tested ability, the owner's options.
- **Approval when no chat session is open** (open question 1), with no new build: the person's own terminal is the deciding surface (D61) and an item waits 24 hours (D62). A scheduled run pauses at the gate; at the owner's next session the agent shows what is pending (one new operator rule in INSTALL.md: "at session start, run `taskfollow approvals list` and present what is pending in plain words"); the owner approves in their own terminal, the same "open a new terminal window" pattern START-HERE already uses. Telegram, already built, stays the optional way to be told sooner.

### 9.5 Deliverable 3: skills

The point is not to move or control skills. It is to **remind the agent that relevant skills exist** and to **store the owner's workflows as skills in the agent's own skills folder**. There is no priority between Skills Wiki skills and locally installed skills unless the owner says so.

- **Exists:** Skills Wiki through MCP, optional (D126).
- **Build:**
  - TaskFollow tells the agent which skills exist for a workflow, from Skills Wiki or local, in the same way; this ends D126's "skills come only from Skills Wiki";
  - workflow skills (section 5) are written into the agent's own skills folder inside the install folder from START-HERE step 4 (for Claude Code, `.claude/skills/`), so chat and scheduled runs in that folder both see them; TaskFollow records the path (open question 4);
  - learning: when the owner edits or rejects a draft, the agent proposes a change to `references/my-rules.md`, written only after the owner says yes.
- **To verify first (9.12):** that the agent's own skill loading works inside a scheduled, restricted run. If it does not, TaskFollow reads the skill file and puts it into the prompt itself (the way D83 already does for `skillswiki:` skills); that is still "reminding the agent", not controlling it.

### 9.6 The five workflows, minimum version each

Each ships as a general workflow file plus a skill folder (section 5) and keeps a few of the owner's real past items as test cases.

**Workflows stay general; the agent picks the tools.** Unless the owner names a tool, the workflow describes the work and the agent chooses, from its own tool set, what fits best. The setup asks ("which CRM do you use now?") rather than assumes. When the owner says "for my daily work I use CRM 1, read email from 2, get messages from 3, and send decisions to my team by email", tools 1, 2 and 3 are written into that workflow as must-use. Otherwise the choice is left to the model. The hard rules (9.2) apply to every workflow, general or specific.

| Workflow | Input | The agent judges | Gated | Reported |
|---|---|---|---|---|
| Inbox triage | Email in (exists) | What matters, by the owner's rules | Any reply (exists) | A daily list |
| Lead qualification | A message from a new contact | Fit and the next step, by the owner's rules | The reply; the record write | New leads and their status |
| CRM update | The owner says "note that X", or a message arrives | Which record, and what changes | The write, with a preview | What changed |
| Invoice processing | An email attachment (exists); the agent reads the file itself | Vendor, amount, due date; **where the numbers go is the owner's call** (the agent asks; TaskFollow executes or flags a gap) | Recording it; anything paid is always a person | Due this week |
| Meeting follow-up | The owner gives the notes or transcript (minimum scope) | Action items, owners, dates | Creating tasks; sending notes | The list of actions |

For any of these, when the owner has no tool for the job, the agent says so; Google Sheets (`records.*`, exists) is available as the fallback record.

### 9.7 Agents

The same for every agent: **levels A, B and C plus gap flags** (section 4). Level B on any agent follows the same pattern: TaskFollow states the rule, the agent sets it up in its own permission system, TaskFollow tests it; whether the agent has such a system is one of the abilities the probe tests and flags. Level D wherever the agent offers it (Claude Code today; others when their hooks prove to block, D150).

What TaskFollow does for agents in v1: skills every agent reads, workflows, writing the agent-level files (`CLAUDE.md`, `AGENTS.md`, or the agent's equivalent), and saying every gap clearly. How far each agent gets depends on the agent and its model; TaskFollow says so in the report. (Context, not a rule: TaskFollow builds on the agent's existing abilities rather than adding new ones, and there is no capacity to be compatible with every agent on the market.)

### 9.8 Built extras

Kept as built, no new work in v1: Telegram, email, Slack and WhatsApp, the gateway, hardening and replay, earned autonomy, shadow upgrades, certification, the Codex research. Nothing built is removed. Approve-agent-call (D151) is level C applied to the agent's own tool: core; finish it (9.1).

### 9.9 Where the workflow shapes ship

In the TaskFollow package: offline, tested, no account needed. A Skills Wiki pack may carry the same shapes later as an add-on.

### 9.10 v1 non-goals

- Systems administration (firewalls, servers, CVEs).
- New channels, and customer-facing messaging beyond what is built.
- Anything hosted by the owner of TaskFollow; any access to the owner's machine.
- Removing built features.

### 9.11 Done means

In the owner's words: *"I, as a non-technical user, can install, set up, run and use TaskFollow daily on my own, without step-by-step help, without bugs."*

"Without step-by-step help" means without the development session: today the owner opens Claude Code, pastes a prompt or a test plan written here, and pastes the result back. Done means the owner uses TaskFollow as a normal user would, with only TaskFollow's own guidance (which stays step by step, for setup, workflows and everything else). The owner is user 1; friends in other industries, the realtor team among them, come after (section 3, item 7).

### 9.12 Build order

1. **Spike:** does the agent's own skill loading work inside a scheduled, restricted run (`claude -p --restricted`)? Decides whether 9.5 needs the prompt fallback.
2. Skills reminded, not controlled (9.5), in full:
   - **Inventory.** At setup and whenever a workflow is added, TaskFollow lists the skills the agent has: the local skill folders the agent reads (for Claude Code, `.claude/skills/` in the install folder and `~/.claude/skills/`; for other agents, their documented folder) and, when Skills Wiki is connected, its active skills. It keeps names and descriptions only; it never copies, installs, updates, ranks or deletes a skill.
   - **Matching by the model.** The agent reads the inventory and says which skills fit the workflow; the owner confirms. TaskFollow writes the chosen references into the workflow file, a local path or a `skillswiki:` reference alike. TaskFollow never chooses a skill itself.
   - **Reminding at run time.** A run's prompt names the workflow's skills, and the agent loads them itself. If the spike (item 1) shows a restricted run does not load them, TaskFollow reads the file and puts it into the prompt, as D83 does for `skillswiki:` skills.
   - **Reminding in chat.** One short section in the agent-level file (`CLAUDE.md`, `AGENTS.md`, or the agent's equivalent) lists the owner's workflows and the skills each uses. TaskFollow writes only that section and leaves the rest of the file alone.
   - **Workflow skills.** `taskfollow workflow add` also writes the workflow's skill folder (section 5) into the agent's skills folder, with `references/my-rules.md` from the interview, and records the path.
   - **D126 changes.** A workflow backed by a local skill is accepted without Skills Wiki; only `skillswiki:` references still need a connection.
3. The bare-minimum install (9.4): level 1 of the ladder (the operator rule, workflow shapes ending with the result when no channel exists), Telegram optional in START-HERE and the starter, and the level-2 probe with its gap flag.
4. The level-B guided step and its test (9.3). To settle in the plan: a headless run cannot answer an "ask", so the test is either interactive or a settings check plus a headless probe where "ask" shows as refused.
5. Inbox triage end to end; the owner uses it on their own mailbox.
6. The other four workflows (9.6), the interview proposing from them, and the opportunity rule (9.4).
7. Gap flagging (9.3, section 6).
8. Learning into `my-rules.md` (9.5).
9. Then 9.11: the owner's own daily use; task 23; npm publish of the v1 build.

Each item: plan first, Fable review, build test-first (the rule in `docs/next-steps.md`).

### 9.13 Tasks of the strategy change itself

This conversation is the product direction and vision correction. Every file in the project, README.md included, is subject to change to match it.

1. **The product description.** README.md, START-HERE.md and the INSTALL.md introduction say the vision in 9.2 (today they say TaskFollow "deploys Skills Wiki solutions onto a client's own AI agent"). INSTALL.md's operator rules gain the new rules: at session start, tell the owner about runs since they last spoke and present pending approvals (level 1 of the ladder in 9.4); the opportunity rule; the skills reminder.
2. **`docs/next-steps.md`** is rewritten from section 9 once the current scope (9.1) is finished; `docs/human-tasks.md` gains the new human tasks.
3. **Human task: the spike** (9.12, item 1) needs the owner's real Claude Code, like tasks 25 and 26.
4. **Where user 1's runs happen.** The owner decides at install time: a laptop (runs only while it is on and awake; missed runs are skipped, D38) or an always-on machine (Team host mode, exists). The report says plainly when runs happen and that they use the owner's own Claude plan.
5. **Uninstall** removes everything TaskFollow wrote, the skill folders and the `CLAUDE.md`/`AGENTS.md` section included, and nothing else: no other setting of the owner's is touched (D109's rule, extended to the new files).

### 9.14 What to do with PR #40 before v1 starts

State on 2026-10-15, end of day: #41 (this file, D152) and #39 (flaky tests) are merged into `main`. **#40 `feat/approve-agent-call` (D151) is open**, paused by the owner. It was stacked on #39, so against today's `main` it is only its own commits: an `approve` step with `agent_call` (a person approves one exact call to the agent's own MCP tool, then the agent may make that call once), and every task step hardened to fail closed (`onFailure: "block"`, Claude Code 2.1.295 or newer). It touches `src/core/{runner,runner-steps,task-step,workflow,approvals,approval-commands,agent-call,agent-hook,agent-task,profile,reply-codes}.ts`, `profiles/claude-code.json`, INSTALL.md (section 9a and the product example in 9b), DECISIONS.md, `docs/next-steps.md`, `docs/human-tasks.md`.

Why finish it before v1's workflow items: it is level C applied to the agent's own tool (9.8, core), its fail-closed gate is a hard-rules improvement (9.2), and it edits the same runner and INSTALL.md files that build items 3–6 will edit, so every week it waits costs a harder merge.

Steps, in order:

1. **Bring it up to date.** `git switch feat/approve-agent-call && git merge main`. The only expected conflict is in `DECISIONS.md`: two rows added at the same place; keep both, D151 above D152. Then `npm run typecheck` and the full `npm test` (do not edit files while it runs); push.
2. **Human task 28** (`docs/human-tasks.md`, about 20 minutes): on the owner's real Claude Code and test store, approve one product change, then let the agent make it. The owner pastes the output back; any fix goes on the same branch, test-first.
3. **The owner merges #40.** Then `git switch main && git pull`.
4. **Start v1 from `main`** with the build order in 9.12. Items 1–4 (the spike, skills, the bare-minimum install, the level-B step) do not depend on #40 and may go first if task 28 is delayed; item 5 (inbox triage) should not start before #40 is in.

Publishing to npm (9.1) waits for the v1 build (9.12, item 9); `npx --yes taskfollow instructions` is not needed before then, because the owner is user 1 and installs from the checkout.
