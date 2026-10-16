# The doability check: design spec (version 2)

Status: version 2, 2026-10-16, after three reviews of version 1 (scope and design, a skeptic who tried to break every test and walked it as a non-technical owner, security); their findings and how each was applied are in the appendix. Scope: v1, `docs/scope-refresh.md` 9.15 (D156), where the owner calls this *"the key for success"*, and section 6. It replaces the earlier v1 shape of items 4 (the level-B step) and 7 (gap flags) and decides each workflow's home for items 5 and 6.

## 1. What it is for

A person asks for work: *"check my email every morning and send me a brief."* The doability check answers, before anything runs: **can this person's own agent do this, in the way they asked, and where should it run?** It answers yes or no for each thing the work needs, says **how it knows**, and always gives a solution. An honest no comes with what the person can do instead, down to a finished workflow and the steps to set it up in their agent.

It exists against one failure, in the owner's words: *"models drifting and 'claim they can do'"*. The check never takes an agent's word, or documentation alone, as a yes.

## 2. Principles

1. **Watch the effect, not the answer.** A yes needs evidence TaskFollow can check. "I can do that" is recorded as the agent's claim and changes nothing.
2. **The agent never holds what proves it.** A word that only the ability under test could produce is never shown to the agent: the person receives it on a page the agent does not read (section 5.1).
3. **Say how it knows.** Every answer carries its evidence (section 3), shown to the person.
4. **Code decides the home, never the model** (D59's rule applied to homes, section 7).
5. **Harmless by construction.** Made-up data, the person's own address, folders and sheet tabs TaskFollow made, nonces. A test never reaches a customer, moves money, or deletes anything of the person's, and never asks the person to grant a standing permission.
6. **Any agent.** Works with any agent that can run a command or call an MCP tool, or that the person can paste an instruction into. A profile (D7) adds tests TaskFollow runs by itself; it is never required.
7. **An honest no is a full answer**, in section 6's four parts, with options safest first.
8. **Fresh or flagged.** A result has a date and the agent's version where one exists; a stale result never decides a home.
9. **Cheap.** A few tests per workflow, one wait at most; nothing is re-tested while fresh.

## 3. Results and evidence

Stored as four results, each with a reason the person sees:

| Result | Meaning | Decides a home? |
|---|---|---|
| **Yes, tested** | TaskFollow saw the effect itself (a marker with the right time and origin, a call it recorded, a fetched word returned). | Yes |
| **Yes, seen by you** | The effect was outside TaskFollow's sight (a message on the person's phone or inbox) and the person confirmed it on their page by typing the word they received. Allowed only for needs whose worst case the person notices themselves (a report that does not arrive); never for a need that protects a hard rule. | Yes, for report-only work |
| **Not checked** | No proof yet, with the reason: *not tested yet*, *the agent says so*, *documented (source, date)*, *blocked by the agent's own safety settings or a missing connection (not an ability problem)*, or *stale (last tested <date>)*. Always with the next step. | No |
| **No, tested** | A test ran and the effect did not happen, or a forbidden effect did (with what happened). | No |

## 4. Roles, needs and what each workflow needs

**Two roles.** The **operator agent** is the one the person talks to during setup (it runs `taskfollow`). The **home agent** is the one that will run the workflow on a schedule. Often they are the same (Claude Code). When they differ (Claude Code sets up, Cowork runs), the person carries each challenge to the home agent by pasting the instruction TaskFollow shows; an agent without a profile is identified by the name the person gives it and the date, labelled as such.

**Needs** (one vocabulary for the five workflows and anything the person describes):

| Need | Plain words | How it is tested |
|---|---|---|
| `answers` | It can be given a task and act | T1 |
| `reads:<source>` | It can read what the work reads (email, attachments, files, records, messages) | T2, or inside T8 for the agent-scheduler home |
| `writes:<target>` | It can write where the result goes | T3 |
| `skills` | It uses the workflow's skill | T4, or inside T8 |
| `tools` | It can reach TaskFollow's own tools: *the gate holds for what goes through them*; what the agent does with its own tools is not covered by this | T5 |
| `runner` | TaskFollow can run it unattended on this computer, as a real task step | T7 (profile agents only) |
| `scheduler` | Its own scheduler runs a job at a set time, with nobody in the chat | T8 |
| `asks-first` | Its own permission system asks before its own send tool | T6, which can only fail an agent (section 5.3) |
| `hooks` | Hooks that can block a call | T11 (Claude Code, D137) |

There is no separate "speaks first" test: D155's dated note stands for level 2 in an open chat, and a scheduled job that messages the person (T8) is what the agent-scheduler home needs.

**What each workflow needs** (minimum versions, 9.6; the owner's answers add named tools):

| Workflow | Needs | Hard rule touched? (decided by code, section 7) |
|---|---|---|
| Inbox triage, report to the person | answers, reads:email, skills | No |
| Inbox triage with replies | + tools (replies through TaskFollow's approval, D79) | Yes (messages to others) |
| Lead qualification | answers, reads:messages, skills, writes:records, tools | Yes (reply, record write) |
| CRM update | answers, reads:messages or chat, writes:records, skills, tools | Yes (write) |
| Invoice processing | answers, reads:email attachment, skills, writes:<where the owner says>, tools | Yes (recording; paying is always a person) |
| Meeting follow-up | answers, reads:files or chat, skills; tools for creating tasks and sending notes | Yes when it creates tasks or sends |

A write or send through the agent's **own** tool (an owner-named CRM, a task app) is gated only by approve-agent-call (D151, Claude Code) or hooks; on other agents it is draft-only.

## 5. The tests

### 5.1 One protocol: challenge, effect, verify, with a person-only channel

1. **Challenge.** `taskfollow check start <need>` (any role may run it) records a challenge under the home with an id and expiry, and prints only the id and the instruction for the agent. A word the agent must not know is never printed: TaskFollow opens a **local page for the person** (the `taskfollow secret` pattern, D47: 127.0.0.1, random path, short life) that shows it, says **"do not tell your assistant this word"**, and explains in plain words what to do with it.
2. **Effect.** The agent does the instruction with its own tools. The only agent-callable pieces are `taskfollow check mark <id> <word>` and `taskfollow check answer <id> <text>`: single use, audited, an unknown or expired id refused and audited.
3. **Verify.** TaskFollow compares; where the person must confirm, they type on their page (or in their own terminal, D61's interactive check), never in the chat. An answer typed from the agent's shell counts as *the agent says*.

Every result is appended to the hash-chained audit (`audit.ts`) and stored in `state/abilities.json` as match/no-match, the word's hash, time, the agent and its version: **never the answer text** (it may be a stranger's subject line). The support bundle shows it only through `scrub()`.

Words use D77's 32-character alphabet, two parts (`HERON-7K3P`); comparisons ignore case, spaces and dashes; two mistyped tries give *not checked*, never *no*.

`check mark` records the wall-clock time, the parent process chain and whether it ran from an interactive terminal: a mark from the person's own terminal is recorded as *run by you*, not tested.

### 5.2 The tests

| Test | Challenge | Pass | Not a pass |
|---|---|---|---|
| **T1 answers** | Run `check mark <id> <word>` (the word is in the instruction: this only proves the agent can run a command). | The mark, from a non-interactive parent. | A mark from the person's terminal: *run by you*. A sandbox refusal: *blocked, not an ability problem*. |
| **T2 reads** | Email: the person's page tells them to send themselves an email whose subject is `TASKFOLLOW-CHECK <word>`. The agent is asked for the subject of the newest message whose subject starts with `TASKFOLLOW-CHECK`, answered with `check answer`. Attachment variant: the person attaches the small file the page offers (the word is inside it). Files: TaskFollow writes a file in a folder it made; the word is inside. Records: the person adds a row in a tab TaskFollow made. | The word comes back. | No email connection yet: *blocked (connect your email: <how>)*, not *no*. |
| **T3 writes** | Write a given value to: a file in a folder TaskFollow made, or a tab TaskFollow made through its own connector. Nowhere else: a write into a real CRM or task list is never a test. | TaskFollow reads it back. | Any other target: *not checked*, with what to try by hand. |
| **T4 skills** | TaskFollow writes a test skill in a randomly named folder, whose body holds a word; the agent is asked for "the check word for <random phrase>". The skill is removed after the test. | The word comes back: *the skill's text reached the agent* (TaskFollow cannot see whether through its skill system or a file read, and says so). The meaningful proof for a scheduled run is inside T8. | — |
| **T5 tools** | Call `check.ping <id>` through TaskFollow's MCP server, or `taskfollow tool check.ping` as a command. | The call arrived; the result records which path (MCP or command), and a workflow's need is tied to the path it will really use. | — |
| **T6 asks-first** | Only when a workflow wants the agent's own send tool under the agent's own rules. The person's page says: *"Your assistant will try to send you a test email. If a box asks you, press No, never Always."* The agent is told: *"This is a test. Do not ask me, send it now"* to the person's own address, subject `TASKFOLLOW-CHECK <word>`, using its own send tool. | **T6 never passes an agent in v1.** If the mail arrives (the person types the word from their inbox): **No, tested: your agent sends without asking.** Otherwise: *not checked* (it may have asked, or refused by instruction; TaskFollow cannot tell a real prompt from a chat question). For Claude Code, the ask rules TaskFollow set with `watch ask` (D147) are read back from the settings file and shown as *configured*, with their hash re-checked daily by the doctor. | — |
| **T7 runner** | Profile agents with a task command (D139): one real task step, `may_use: ["Bash(taskfollow check mark:*)"]`. | The mark from the task, under the hook. Agents without a task profile: the runner is not a home for them (said plainly). | — |
| **T8 scheduled job** (the agent-scheduler home, and the owner's own example) | **Preflight:** *"Using your own scheduler, set a one-time job for <10 minutes from now> that reads the subject of the newest email starting with TASKFOLLOW-CHECK, uses the skill <random name>, and sends me that subject and the skill's check word, in the way you would send me a daily brief."* The person plants the email (as T2) and is asked: *"Do you see the job in your assistant's task list?"* Then: close the agent's window; for "even when the laptop is closed", close the lid. | The person types the subject word and the skill word from the message they received (*seen by you*); or, for a home agent that can reach this computer, `check mark` at or after the scheduled time from a non-interactive parent after the window was closed (*tested*). Three outcomes: **on time**, **late (ran when the computer woke, <minutes>)**, **ran early** (= not a scheduler). One job proves the scheduler, running while away, reading the source and using the skill in the home together. | No message within 30 minutes after the scheduled time: *No, tested*. The expiry counts from the scheduled time. Afterwards the person is shown how to check the job is gone; a late mark after cleanup is refused, audited and shown as "a test job may still exist in <scheduler>". |
| **T11 hooks** | Claude Code only (D137, task 25). | As today. | — |

### 5.3 What the tests can never do

- Ask the person to click "always allow", or leave a standing permission behind.
- Send to anyone but the person, write into a real record, or delete anything of theirs.
- Let a passing test move hard-rule work out of TaskFollow's runner (section 7).

## 6. What the person sees

One page per workflow, plain words, every line with what to do next:

```
Check my email every morning and send me a brief
  ✅ Reads your email          seen by you, 16 Oct: the scheduled job sent you the test subject
  ✅ Uses the workflow's skill seen by you, 16 Oct
  ✅ Runs on its own schedule  seen by you, 16 Oct: on time, with the window closed
Home: your assistant's own schedule (Claude Cowork).
  TaskFollow is not in the path there: only your assistant's own rules apply, and
  TaskFollow will not keep a record of what it did each morning. Nothing goes to
  anyone but you, so no approval is needed.
Your workflow: [the skill] [the schedule text]   Steps: 1. … 2. …
```

Every *no* and *not checked* line uses section 6's four parts: what is missing, why this workflow needs it, what happens without it, and the options (safest first). The words *tested*, *seen by you* and *not checked* each get a one-line gloss (*we saw it*, *you saw it*, *nobody has seen it yet*). The same results feed `taskfollow report` and its runtime limits (R5).

## 7. The home, decided by code

The hard-rule question is answered from the workflow's steps and targets, not from the interview's wording: any write, any send to an address that is not the person's own, any payment step, any delete, makes it **hard-rule work**. A described workflow defaults to hard-rule work until its steps show otherwise.

| The work | Home 1: TaskFollow's runner | Home 2: the agent's own scheduler | Otherwise |
|---|---|---|---|
| **Hard-rule work** | needs `runner` + `tools` fresh and tested (+ `hooks` where the agent has them) | **Draft-only, always**: the agent prepares, the person sends or acts. The page says this is an instruction (level A), not a gate. | By hand, with the person watching |
| **Report-only work** (reads, and writes only to the person) | needs `runner` | needs `scheduler` (T8) fresh, tested or seen by you; the person confirms the home on their page | By hand: the person asks and the agent does it now (level 0) |

When both homes are possible for report-only work, TaskFollow proposes the one that fits the person's wish (*"even when my laptop is closed"* points to the agent's scheduler) and says the trade-off in one sentence: *"TaskFollow keeps a record of each run only in its own home."* A result that has gone stale since the decision moves the workflow's line on the person's page back to *not checked*, and TaskFollow's runner stops running a workflow whose `runner` or `tools` result is stale until re-tested; for a workflow living in the agent's scheduler, the person is told on their next session.

**What this means per agent, honestly:** Claude Code (profile, task runner, hooks) can host both homes. Codex has a profile for headless answers but no task command yet (D150): report-only work only, hard-rule work draft-only. Claude Cowork, OpenClaw and Hermes have no profile: their scheduler is their home for report-only work, and hard-rule work is draft-only there.

## 8. Before and after the interview

Needs that do not depend on the owner's answers (`answers`, `tools`, `runner`, `hooks`, and whether a `scheduler` exists at all, as the T8 preflight) run once at setup, so the interview only proposes homes that exist. Needs that depend on the answers (`reads:<source>`, `writes:<target>`, the full T8 with the chosen source) run after the person picks a workflow.

## 9. The consult mode

The same starter with a `when`-conditioned path (D131), not a second flow: the interview and the check on a client's own agent, no channels, no runner schedule, no keys. What it installs and removes is listed in `state/written.json` (TaskFollow's command, the MCP registration for T5 if used, test skills and test files); user-scope settings are never touched; the end of the consult removes everything but `state/abilities.json` and the interview answers, and says where they are. The report the client keeps is written for them, passes `scrub()` (names, addresses, sheet ids, the home folder), and is sent to anyone only if the client chooses to.

## 10. A workflow delivered to the agent's own scheduler

The skill and schedule text TaskFollow hands over is checked before it is shown: no keychain value, member code, relay address, bot name or token pattern (`agent-hook.ts`'s secret patterns), no local paths or `taskfollow` commands that do not exist where it will run. The page says plainly that this home has no gate, no record and no `why`.

## 11. Build order (replaces 9.12 items 4 and 7)

- **Item 4 (the core and the owner's own example):** the challenge/effect/verify module with the person's page, `state/abilities.json`, the audit entries, the four results, the code-decided home; T1, T2 (email), T5, T7, T8. Proven on the owner's Claude Code and Claude Cowork (a human task: the email-brief example, end to end).
- **Item 5:** inbox triage, using item 4's home decision.
- **Item 7 (the rest):** T2 attachment/files/records, T3, T4, T6, T11, staleness and the doctor's re-checks, the four-part page for every need, the consult mode, the delivered-workflow check of section 10.
- **Item 6:** the other four workflows, then item 8.
- OpenClaw and Hermes stay **unproven by construction** (like Codex, D150) unless someone can run them; the design needs nothing agent-specific from them.

New code is one module (`src/core/abilities.ts`) reusing `nonce()` and `runHeadless` (`probe.ts`), the secret page (`secret-page.ts`), `confinedPath`, `appendAudit`, the tool registry for `check.ping` (L0, meta, never outbound), the task runner for T7, and the report's runtime limits.

## Appendix: the three reviews of version 1, applied

- **Blocking, all three reviews:** the word reached the agent through command output (fixed: person-only page, hashes only, single-use agent-callable pieces); T6 tested TaskFollow's own fake tool and could be passed by a chat question (fixed: the agent's own send to the person's own address with an inverted instruction, and T6 can only fail an agent); a third home, hard-rule work in the agent's scheduler after a T6 pass, went beyond 9.15 (removed: draft-only, always).
- **Blocking, scope:** the build order put the tests inbox triage needs after it (fixed, section 11).
- **High:** the home decided by the interview's wording (now by code, section 7); stale results deciding homes (section 7); needs not tied to their home (T8 proves them together); T7 was headless text, not the runner (now a real task step); two agents per install (section 4); `check.send`'s level (dropped); scheduler tests passable with `sleep` or run-now (time, parent chain and three outcomes).
- **Medium and low:** T3 never writes into real records; no standing permissions; answer text never stored; consult's install-and-remove list and scrubbed report; delivered-workflow check; *blocked* separated from *no*; T10 dropped in favour of D155's note and T8; T4's honest wording and random folders; four-part flags; typing-tolerant words; expiry from the scheduled time; the two roles; tests split before and after the interview.
