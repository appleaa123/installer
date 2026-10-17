# Learning into my-rules.md, item 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, in the owner's words (9.5):** *"when the owner edits or rejects a draft, the agent proposes a change to `references/my-rules.md`, written only after the owner says yes."* The workflow gets better at the owner's own way of working, the owner sees every rule word for word before it exists, and nothing about the hard rules (9.2) can be loosened by a rule.

**Architecture:** No new step kind, no new store, no new top-level command. Two kinds of correction reach the same place:

1. **In chat** (level A): the owner corrects a result the agent shows them (a daily list, a draft). The workflow's skill already says *"When the owner corrects a result, the agent proposes a rule here and adds it only after the owner says yes"* (`rulesMarkdown`, D154). Item 8 adds the operator rule and the one recorded way to write the rule.
2. **In an approval** (Home 1, the owner decides in their own terminal, D61): an edit or a rejection happens where no chat is open. The existing learning loop (D97, `learning.ts`) already turns such decisions into candidates, but only for a judge naming a Skills Wiki skill. Item 8 reuses the same collection (the claim per approval, the body built from the person's side only, the redaction) to keep a **rule candidate** for any workflow that has the skill folder TaskFollow wrote, and shows it at the next session through the list form of `taskfollow why` (the D164 path the session-start rule already runs).

Either way the agent proposes the wording, the owner says yes, and the agent runs `taskfollow workflow rule <id> --value '{"rule":"…"}'`, which appends that one line to the workflow's `references/my-rules.md` and audits it. Runs read `references/*.md` at run time (D153, `skills.ts`), so the rule applies from the next run, and in chat at once. The workflow file is not touched, so its version and its shape (D159) stay as they are.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Measured against:** v1, `docs/scope-refresh.md` 9.5 (learning), 9.12 item 8, section 5 (workflows as skills, `my-rules.md`), read with 9.15 (two homes), which wins where they differ. D97 (the learning loop), D154 (workflow skills), D160 (delivery to Claude Cowork), D163 (consult), D164 (`why` shows what TaskFollow noticed), D151 (an `agent_call` can be rejected, not edited).

**Precondition:** branch from `main` **after PR 6b merges** (`feat/workflows-6b`). Items 5 and 6a and the `why.show` tool (D169) are on `main` (6592fed); operator rule 14, item 6's opportunity rule, exists only on `feat/workflows-6b`, and this item's rule is **15**, so the test "operator rules are numbered 1 to 15 without gaps" needs 6b first.

**Shapes that make rule candidates** (they ask for an approval, D171 and item 5): `inbox-triage-replies`, `lead-qualification`, `crm-update`, `invoice-processing`, `meeting-follow-up`. `inbox-triage` and `invoices-due` are report-only and make none. No shape uses `agent_call`, so its test uses a synthetic approval item.

## What exists, and what this item builds

| Part | Exists | Built here |
|---|---|---|
| The rules file | `references/my-rules.md` written by `workflow add` from the interview's `my_rules` ("None yet…" when empty), recorded in `state/written.json` (D154); inlined into every run's prompt (D153); inlined into the Cowork zip under "## The owner's own rules" (D160) | `workflow rule <id>` appends one rule, replacing the "None yet" line the first time, refusing a file TaskFollow no longer owns |
| Corrections in an approval | edit / reject with `--reason` in the person's terminal (D61); `collectLearnings` makes at most one candidate per decided item, body from the person's side only, redacted (D97), sent to Skills Wiki only for a `skillswiki:` judge | the same collection keeps a **rule candidate** for a workflow with a TaskFollow-written skill folder (separate claim, separate folder, never sent anywhere) |
| Telling the agent at the next session | operator rule 11 runs `taskfollow why <day>`; the list form shows "TaskFollow noticed (tell the person):" (D164) | the list form also shows open rule candidates, until the agent adds a rule or dismisses one |
| Corrections in chat | the skill's sentence in `rulesMarkdown` | operator rule 15 says when and how to propose, and that only `workflow rule` writes |
| Home 2 (Claude Cowork) | `check deliver` writes the zip with the rules inlined (D160); Cowork keeps its uploaded copy | `workflow rule` says plainly that Cowork still has the old copy, and how to deliver again |

## Global Constraints

- **Nothing is written without the owner's yes.** TaskFollow cannot see a chat, so it cannot check that a yes was given: the yes is the agent's duty under operator rule 15, exactly like "nothing is created without a yes" for `workflow add` (D145). What TaskFollow can do, it does: one rule per call, shown back word for word, audited (`rules.added`, the text's fingerprint and the workflow), and the operator rule tells the agent to repeat the exact text to the owner.
- **A rule cannot loosen a hard rule.** The gate (approval levels, the hook, `channel.send` approvals) never reads `my-rules.md`; the skill's "Always ask a person first" section stays above it; a test proves a rule such as "send replies without asking" changes no level. This is standing point 1 (D161): the gate does not depend on what instructions say.
- **D97 holds for anything that leaves the computer.** Rule candidates are built from the person's side only (the same `learningBody`, redacted) and never sent to Skills Wiki; the rule's wording is the agent's, gated by the owner's yes, and stays in the owner's own files. Skills Wiki learnings are unchanged.
- **TaskFollow writes only the file it wrote.** The folder passes the checks uninstall uses (`removeWritten`: the recorded folder, resolved with `realpath`, still inside the recorded skills root and still holding `SKILL.md`), and the rules file itself passes `skillFile`'s single-file check (`skills.ts`: `realpath`, then inside the folder), because `removeWritten` checks only the folder and a `my-rules.md` that is a link would otherwise be written through; otherwise it refuses and says why.
- Plain words in everything the person sees; no industry words in INSTALL.md before section 11; tests never touch the real `~/.claude`; `npm run typecheck` and the full `npm test` twice before the PR; no edits while the suite runs; a Fable code review, then the fixes.

## Review Focus

1. **One candidate per decided approval, never two, never lost.** A separate claim folder (`state/learnings/from-approvals-rules/`) so a workflow with both a `skillswiki:` judge and its own skill gets both kinds, each once. A candidate stays open until `workflow rule … "learning":N` or `learnings dismiss N`.
2. **The append is safe.** A rule is one line, 1 to 600 characters after trimming (D97's `MAX_BODY`, the limit learnings already use), no line breaks, not starting with `#` (so it cannot break the "## The owner's own rules" heading `skillText` relies on), not naming `references/my-rules.md` (such a rule would reach Cowork pointing at a file that does not exist there: `deliver.ts:90` filters that pointer out of `SKILL.md`'s lines only, not out of the rules), and it passes `checkDelivered(home, rule)` itself (`deliver.ts`: a key or channel setting from this computer, a token, a local path, a `taskfollow` command) rather than a partial copy of those checks.
3. **Home 2 is told the truth.** TaskFollow cannot update a skill already uploaded to Cowork. When the workflow was delivered (its zip exists in `taskfollow-deliver/`), the answer says so and gives the two steps to deliver again. Whether an upload with the same name replaces the old skill is not known: human task 41 checks it.

---

### Task 1: rule candidates from approvals

**Files:** `src/core/learning.ts` (a `RuleCandidate` type, `RULES_DIR = state/learnings/rules`, `RULES_CLAIM_DIR = state/learnings/from-approvals-rules`, `collectRuleCandidates`, `listRuleCandidates`, `dismissRuleCandidate`); `src/core/tick.ts` (the learning guard also collects rule candidates); tests `tests/unit/learning.test.ts`.

- A candidate: `{ id, approval, workflow, step, body, status: "open" | "added" | "dismissed", created_at, closed_at? }`. `body` comes from `learningBody`, whose two sentences about a Skills Wiki judge (`learning.ts:73,78`: "…the call that followed this skill's judgment", "Next time, judge similar input…") become a parameter: the Skills Wiki wording stays byte for byte for D97 learnings, and a rule candidate says "…a person rejected the channel.send call in step '<step>'" with no closing advice. The redaction stays shared.
- Made for every edited or rejected approval item with `source.run`, when `loadWritten(home).skill_folders` has that workflow. An `agent_call` item can only be rejected (D151), so its candidate carries the reason only. `editItem` (`approvals.ts:219-232`) records no reason (only `rejectItem` does), so an edit's candidate names the changed fields and values; the rule wording takes `run.step` so the agent knows which step the person corrected. Test fixtures need a skill folder in `state/written.json` (`saveWritten`, or `workflow add`). A workflow without a TaskFollow-written folder (an agent with no known skills folder) gets no candidate.
- [ ] Failing tests: `an edited approval of a workflow with its own skill becomes one open rule candidate`; `a rejected approval with a reason keeps the reason, redacted`; `the same approval never becomes two candidates, even across ticks`; `a workflow without a skill folder TaskFollow wrote gets no candidate`; `a skillswiki judge's correction still becomes a Skills Wiki learning, and a rule candidate too`; `rule candidates are never sent to Skills Wiki`; `a rejected agent_call becomes a candidate with its reason` (a synthetic item: no shape uses `agent_call`); `a Skills Wiki learning's body is unchanged by the parameter`; `an approval decided by the agent's refused attempt (approval.refused) makes no candidate`.
- [ ] Implement; tests pass.

### Task 2: the rule writer, `workflow rule`

**Files:** `src/core/workflow-skill.ts` (`appendRule(home, workflow, rule, now)`; `ownedRulesFile(home, workflow)` reusing `removeWritten`'s folder check); `src/core/skills.ts` (export `skillFile`, `:211`, and `inside`, `:173`, for the single-file check); `src/core/lifecycle.ts` (`workflowCommand` sub `rule`, and the usage string at `:188` gains `rule <id> --value <json>`); `src/core/learning.ts` (closing the candidate); tests `tests/unit/workflow-skill.test.ts`, `tests/unit/lifecycle.test.ts`.
- `rulesMarkdown`'s default ("None yet. When the owner corrects a result…", `workflow-skill.ts:84`) becomes an exported constant, so the first append replaces exactly that line. `levels.ts:76` also exports a `RULES_FILE` (`config/approval-rules.json`): where both are imported, alias one of them.

- `taskfollow workflow rule <id> --value '{"rule":"<one line>","learning":<id, optional>}'`.
- Appends `- <rule>` to `references/my-rules.md`. The first time, it replaces the "None yet…" line `rulesMarkdown` wrote: it reads the file again right before writing, as D164 does (`watch-notice.ts:118-124`), so a rule another process added meanwhile is kept; the remaining window is the few milliseconds of that read and write (documented in the code). Later rules use `appendFile`. With `learning`, the candidate becomes `added`. Audit `rules.added` with `{ workflow, learning?, sha256 }`, never the text.
- Answer: `{ "status": "added", "workflow": "<id>", "rule": "<the text>", "file": "<path>", "next": "Tell the person exactly this rule, word for word: it applies from the next run and in chat now. To change or remove a rule, they edit <path> themselves." }`, plus `"cowork"` when delivered (Task 4).
- Refusals, exact words:
  - no such workflow: the existing `loadWorkflow` message;
  - no rules file TaskFollow wrote: `"Workflow '<id>' has no rules file TaskFollow wrote (its agent has no skills folder TaskFollow knows), so there is nowhere to keep a rule: tell the person, and keep the rule in mind in chat"`;
  - the file was moved or linked elsewhere: `"TaskFollow did not write <path> as it is now (moved, linked elsewhere, or without SKILL.md), so it leaves it alone: the person can add the rule there themselves"`;
  - bad shape: `"A rule is one line of 1 to 600 characters, with no line breaks, not starting with #, and not naming references/my-rules.md: say it in the person's words, shorter"`;
  - text `checkDelivered` refuses (so a rule can always be delivered to Cowork later): its message (`deliver.ts:73`) ends "then deliver it again", which fits delivery, not a rule; `appendRule` catches it and says `"This rule holds <kind>, which must stay on this computer: say it without that"`, keeping only the kind;
  - after a consult's clean-up (Task 5): `"This consultation was cleaned up, so workflow '<id>' has no rules file now; its rules are kept and come back with 'taskfollow add install': tell the person, and keep the rule in mind in chat"`;
  - a learning that is not open: `"Rule candidate <n> is <status> already"`.
- [ ] Failing tests: `workflow rule appends one line and replaces the None yet line the first time`; `a second rule is appended below the first`; `workflow rule refuses a line break, a leading #, a mention of references/my-rules.md and text over 600 characters`; `workflow rule refuses a rule checkDelivered refuses (a local path, a taskfollow command, a token)`; `workflow rule refuses a rules folder moved or linked out of the recorded root`; `workflow rule refuses a my-rules.md that is a link`; `the first rule keeps a rule written meanwhile by another process`; `workflow rule refuses a workflow whose agent has no skills folder`; `workflow rule with learning closes that candidate; a closed one is refused`; `the rule is audited by fingerprint, never by text`; `the workflow file, its version and its shape are unchanged after a rule`; `the next run's prompt holds the new rule` (fake agent, the prompt it was given); `a rule saying to send without asking changes no approval level` (real, with the rules file saying "send replies without asking": `prepareAction` (`tools.ts:99`) for `channel.send` stays L2; `prepareAction` never yields an `agent_call`, so the L3 half goes through `prepareAgentCall` (`agent-call.ts:29`)).
- [ ] Implement; tests pass.

### Task 3: telling the agent, and dismissing

**Files:** `src/core/why.ts` (list form: collect, then show open candidates); `src/core/why-tools.ts` (`why.show` emits `rule_candidates` and its description changes); `src/cli.ts` (`learnings dismiss <id>`, `learnings` also lists rule candidates); tests `tests/unit/why.test.ts`, `tests/unit/why-tool.test.ts`, `tests/unit/learning.test.ts`.

- `taskfollow why` (list form) first runs `collectRuleCandidates`, so a correction made in the terminal shows at the very next session, not only after a tick. Then, below D164's lines:

  ```
  Corrections to turn into rules (propose one rule each in the person's words; add it with 'taskfollow workflow rule' only after they say yes, or 'taskfollow learnings dismiss <n>'):
      rule 3: in workflow 'inbox-triage', a person rejected the channel.send call in step 'reply'. Their reason: "too formal".
  ```

  In the JSON the list is the field `rule_candidates`, each shown as "rule <n>:" so it is not confused with Skills Wiki learning ids. Its place: suggestions first, then `rule_candidates`, then the rest. In `why.ts` (`~:171`) it goes right after `suggestionsField` and before `next`; `why.show` (`why-tools.ts:35-36`) reorders only `suggestions` and `suggestions_damaged`, so it also takes `rule_candidates` out and puts it after those two keys.
- **A write side effect in the list form.** Collecting claims approvals, writes candidates and audits `rules.candidate`. D169 says `why.show` is read-only except D164's once-shown suggestions: item 8's D-number (D173) amends that wording, and the `why.show` description (`why-tools.ts:17`) says "except that waiting suggestions are shown only once, and corrections from approvals are kept as rule candidates". `why-tool.test.ts:168` ("writes nothing to the audit log of its own, except D164's shown-suggestions line") still holds: its fixture has no edited or rejected approval, so nothing is collected; the test says so in a comment. Open candidates are shown at every session until closed, at most 5 lines, plus "and <k> more ('taskfollow learnings')". Unlike D164's suggestions they are not cleared by showing, because the yes may come later.
- `taskfollow learnings dismiss <n>` gives `{ "status": "dismissed", "learning": n }` and audits `rules.dismissed`.
- [ ] Failing tests: `why lists an open rule candidate made since the last tick, as rule_candidates`; `why.show puts suggestions first, then rule_candidates`; `why lists a candidate once collected and audits rules.candidate once`; `why lists at most five candidates and says how many more`; `a dismissed or added candidate is no longer listed`; `learnings lists Skills Wiki learnings and rule candidates`; `learnings dismiss refuses an unknown or closed candidate`.
- [ ] Implement; tests pass.

### Task 4: Home 2, Claude Cowork

**Files:** `src/core/workflow-skill.ts` (`appendRule` checks for the zip where `writeSkillZip` puts it, `<work_dir ?? home>/taskfollow-deliver/<id>.zip` (`deliver.ts:99`), through one shared helper); `src/core/deliver.ts` (`skillText`, `:84-88`, hard-codes `.claude/skills`: it reads the folder from `loadWritten`'s recorded `path` instead, two lines, so it keeps working once the readiness item's `rootsFor` lands); tests `tests/unit/workflow-skill.test.ts`, `tests/unit/deliver.test.ts`.

- TaskFollow cannot reach a skill already uploaded to Cowork, and it cannot see Cowork's chat. The agent may run `check deliver` itself (it writes a local zip only); the upload is the person's. When the workflow's zip exists, the answer adds `"cowork": "This workflow also runs on Claude Cowork's own schedule, which still has the copy uploaded before this rule. To use the rule there: run 'taskfollow check deliver <id>' and upload the new zip in Settings, then Skills, in place of the old '<id>' skill."`.
- A correction the owner makes in Cowork's own chat happens where TaskFollow is not: Cowork's agent can propose the rule there, but it writes nothing on this computer. Operator rule 15's last sentence asks the agent in the install folder, at the next session, whether the owner corrected a result of a workflow that runs on their assistant's own schedule, and adds the rule the usual way (next to rule 13, which already asks whether that workflow's message arrived).
- [ ] Failing tests: `a rule for a delivered workflow says Cowork still has the old copy, and how to deliver again`; `a delivered zip made after the rule holds the rule under The owner's own rules`; `a rule for a workflow never delivered says nothing about Cowork`; `skillText reads the skill folder TaskFollow recorded`.
- [ ] Implement; tests pass.

### Task 5: operator rule 15, INSTALL.md, consult

**Files:** `INSTALL.md` (operator rule 15; rule 11's wording; section 9b, one sentence after the interview; section 9 in the workflow list); `src/core/consult.ts` (a new exported `consultKeptRules(home, id)`: the rules a consult's clean-up kept for that workflow, or null); `src/core/lifecycle.ts` calls it, not `workflow-skill.ts`, which would make an import cycle; tests in `tests/e2e/install-doc.test.ts`, which already reads the operator rules (line 59) and to which item 6 adds rule 14.

- Rule 15, word for word: *"When the person edits or rejects a result of one of their workflows, in chat or in an approval, propose one short rule for that workflow's `references/my-rules.md`, in their words, and show it. Add it with `taskfollow workflow rule <id> --value '{\"rule\":\"…\"}'` only after they say yes, then tell them the exact text that was added. Propose once per correction; if they say no, do not propose it again in this conversation (and dismiss it with `taskfollow learnings dismiss <n>` when it came from an approval). A rule never changes what needs their approval. At the start of a session, also ask whether they corrected a result of a workflow that runs on their assistant's own schedule, and offer a rule for it the same way."*
- Rule 11's wording is reconciled (INSTALL.md:255): it says what TaskFollow noticed is shown once (D164's suggestions), while rule candidates stay listed until closed; rule 11 says both. `install-doc.test.ts:65-67` asserts D169's sentence in rule 11 byte for byte ("If you reach TaskFollow through its tools rather than a shell, …"), so that sentence stays exactly as it is.
- Consult (D163): a consultation does add workflows (item 5 Task 4 offers its shapes there), with their skill folders. Before the clean-up, `workflow rule` works as in an install. `consultCleanup` (`consult.ts:75-92`) keeps each workflow's `my-rules.md` in the consult record and, through `removeWritten`, removes `written.json` (`workflow-skill.ts:173`), so the generic "no rules file" refusal would fire first. `workflow rule` therefore asks `consultKeptRules` first and, after a clean-up, refuses with the consult words of Task 2, which tell the agent to tell the person; `add install` brings the rules back with the folders.
- [ ] Failing tests (in `tests/e2e/install-doc.test.ts`): `INSTALL.md has operator rule 15 with workflow rule, the yes and the scheduled-workflow question`; `operator rules are numbered 1 to 15 without gaps`; `rule 11 says rule candidates stay listed until closed`. In `tests/unit/consult.test.ts`: `before consult cleanup, workflow rule writes the rule`; `after consult cleanup, workflow rule refuses and says to tell the person`.
- [ ] Implement; tests pass.

### Task 6: docs, verification, PR

- [ ] DECISIONS.md: D173 for item 8 (it also amends D169's "read-only" wording, Task 3). `docs/next-steps.md`: the build map row. `docs/human-tasks.md`: **task 41** (below).
- [ ] `npm run typecheck`; the full `npm test` twice; the safety checks (`claude mcp list`, `~/.claude/settings.json` checksum).
- [ ] A Fable code review, then the fixes; the PR in plain words with the building-blocks table.

## What the person sees

- At the next session after rejecting a reply in their terminal: the agent says *"Yesterday you rejected the reply to the plumber because it was too formal. Shall I add this rule to your inbox replies: 'Write replies in a short, friendly tone, first names only'?"*
- After yes: *"Added to your inbox-triage rules: 'Write replies in a short, friendly tone, first names only.' It applies from the next run."* When the workflow also runs on Cowork: *"Your Cowork copy still has the old rules; to update it, upload the new zip I just made (Settings, then Skills)."*
- After no: nothing is written, and the agent does not ask about it again (`learnings dismiss`).

## Human task 41 (about 20 minutes, after items 5, 6 and 8 are merged)

On the owner's real Claude Code (2.1.295 or later) in a throwaway install with the email channel and `inbox-triage-replies`. The replies shape is used because only an approval makes a rule candidate, and the report-only `inbox-triage` asks for no approval:

1. Let a run draft a reply; reject it in your terminal with `--reason "too formal"`.
2. Open a new session in the install folder: the agent should mention the correction and propose a rule. Say yes.
3. Check `.claude/skills/inbox-triage-replies/references/my-rules.md` holds exactly that line, and that the next run's draft follows it.
4. Optional, Home 2: run `check deliver` for a report-only workflow after adding a rule, upload the new zip with the same name, and say whether Cowork replaced the old skill or refused or kept both.

Clean-up as in earlier tasks: settings checksum unchanged, `claude mcp remove -s user installer`, the `~/.claude/projects/*<test>*` folders inspected and deleted, never `taskfollow uninstall`.

## Risks

- **The yes cannot be verified by code.** It rests on operator rule 15 and the agent's honesty, as `workflow add` does (D145). The audit and the word-for-word answer make a silent write visible afterwards. Making it a terminal-only command would prove a person typed it, but would move a chat decision out of the chat (decided below: the agent runs it).
- **A rule inlined into prompts is instructions.** A rule the owner accepted could still be badly worded. It can never change a level or skip an approval (Global Constraints), and the owner can edit or delete it in the file.
- **Cowork's copy goes stale** until the owner delivers again; TaskFollow says so each time, and cannot do more (9.15: an honest no, with the steps).
- **Many corrections, many prompts.** Five lines at most in `why`, and a dismissed candidate never returns.

## Out of scope

- Editing or removing a rule through TaskFollow (decided below: the owner edits the file).
- Remembering across conversations that the owner said no to a rule proposed from a correction in chat: no new storage; the limit is "in this conversation" (rule 15). A no to a candidate from an approval is kept by `learnings dismiss`.
- Rules learned from corrections inside Cowork's own chat being written on this computer automatically.
- Sending rules or candidates anywhere (Skills Wiki learnings stay as D97 built them).
- Any change to how levels are derived, the hook, or approvals.
- A weekly patterns scan (D165), new channels, Windows-specific work.

## Decided (the owner, 2026-10-16)

1. **The agent runs `workflow rule` after the owner's yes in chat**, like `workflow add` (D145): a rule reaches no one, and the gate ignores it (D161).
2. **v1 is add-only.** The owner edits `my-rules.md` to change or remove a rule (section 5: "portable Markdown the owner can read and edit").
