# TaskFollow scope refresh

Started 2026-10-15. A discussion record, not a decision log: nothing here has a D-number yet. When the owner settles the exact scope, the agreed points become numbered entries in `DECISIONS.md` and `docs/next-steps.md` is rewritten around them. Until then, the current scope (`docs/next-steps.md`) continues as planned.

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
| Possibly extra | Telegram, email, Slack and WhatsApp channels and the gateway; hardening and replay; earned autonomy; shadow upgrades; per-agent certification; Codex (D150) |

## 8. Open questions

1. When a scheduled run needs approval and no chat session is open, where does the owner see it? The agent's chat only works while a session is open; this is why Telegram exists today.
2. What happens to the built extras? Options: keep them as is, hide them behind opt-in, or remove them. And does the current work (approve-agent-call, D151 on PR #40) belong to the core?
3. Which agents does v1 promise? Instructions (level A) work everywhere; the safety levels B–D are proven only on Claude Code.
4. Where does TaskFollow write a local skill: the agent's own skills folder (per agent), or one TaskFollow folder that each agent is told about?
5. Does TaskFollow ship the basic workflow shapes itself, or as a free Skills Wiki pack?
