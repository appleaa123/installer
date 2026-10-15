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

- **Current scope, finish as planned** (from `docs/next-steps.md`, nothing added): task 28 and PR #40 (approve-agent-call, D151), PR #39 (flaky tests), publish to npm, task 23 (a real-person install).
- **v1 scope:** the rest of this section. From here on, every review says which of the two it measures against.

### 9.2 The goal, in the owner's words

> Build this project for the general public: any business owner who wants to leverage their AI agent but can't afford to hire someone to build a vertical agent. A "shell" or layer that helps non-technical business owners set up an AI agent that can help them run their business, by step-by-step instructions, workflow identification and execution, and skills via Skills Wiki MCP or their locally installed skills. That way, business owners no longer need people to set this up for them, or at least get a chance to try AI agents in their real-life work.

TaskFollow is a thin layer on top of the agent the owner already has (Claude Code, Codex, Antigravity, Pi, OpenClaw, Hermes, …). **It does not change the agent and does not add capabilities to it.** It turns the agent the owner has into a "vertical" agent: the knowledge of which skills to use, which workflows to run, when to loop in a person, and whatever else a commercial, customised agent would offer. The agent's own model does the thinking: it gathers the inputs, asks the questions, chooses the tools and decides. TaskFollow executes what it can, or flags the gap and says why and what to do instead.

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
  - **the opportunity rule:** whenever anyone (the model, TaskFollow, any trigger) sees repetitive work that could be a workflow, it says so, shows the proposed workflow, and the owner approves or gives feedback. Nothing is created without a yes. The agent is never limited to a fixed set of workflows a developer wrote for the owner. "I noticed" (D148) is one existing source of such proposals.
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

**Workflows stay general; the agent picks the tools.** Unless the owner names a tool, the workflow describes the work and the agent chooses, from its own tool set, what fits best. The setup asks ("which CRM do you use now?") rather than assumes. When the owner says "for my daily work I use CRM 1, read email from 2, get messages from 3, and send decisions to my team by email", tools 1, 2 and 3 are written into that workflow as must-use.

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

What TaskFollow does for agents in v1: skills every agent reads, workflows, writing the agent-level files (`CLAUDE.md`, `AGENTS.md`, or the agent's equivalent), and saying every gap clearly. What it does not do: create new capabilities for an agent, or promise compatibility with every agent on the market. How far each agent gets depends on the agent and its model; TaskFollow says so in the report.

### 9.8 Built extras

Kept as built, no new work in v1: Telegram, email, Slack and WhatsApp, the gateway, hardening and replay, earned autonomy, shadow upgrades, certification, the Codex research. Nothing built is removed. Approve-agent-call (D151) is level C applied to the agent's own tool: core; finish it (9.1).

### 9.9 Where the workflow shapes ship

In the TaskFollow package: offline, tested, no account needed. A Skills Wiki pack may carry the same shapes later as an add-on.

### 9.10 v1 non-goals

- Systems administration (firewalls, servers, CVEs).
- New channels, and customer-facing messaging beyond what is built.
- Creating new capabilities for an agent; guaranteed compatibility with every agent.
- Anything hosted by the owner of TaskFollow; any access to the owner's machine.
- Removing built features.

### 9.11 Done means

In the owner's words: *"I, as a non-technical user, can install, set up, run and use TaskFollow daily on my own, without step-by-step help, without bugs."* The owner is user 1; friends in other industries, the realtor team among them, come after (section 3, item 7).

### 9.12 Build order

1. **Spike:** does the agent's own skill loading work inside a scheduled, restricted run (`claude -p --restricted`)? Decides whether 9.5 needs the prompt fallback.
2. Skills reminded, not controlled (9.5): Skills Wiki and local alike; workflow skills written to the agent's skills folder.
3. The level-B guided step and its test (9.3). To settle in the plan: a headless run cannot answer an "ask", so the test is either interactive or a settings check plus a headless probe where "ask" shows as refused.
4. Inbox triage end to end; the owner uses it on their own mailbox.
5. The other four workflows (9.6), the interview proposing from them, and the opportunity rule (9.4).
6. Gap flagging (9.3, section 6).
7. Learning into `my-rules.md` (9.5).
8. Then 9.11: the owner's own daily use; task 23; npm publish.

Each item: plan first, Fable review, build test-first (the rule in `docs/next-steps.md`).
