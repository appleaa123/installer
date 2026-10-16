# Learning into my-rules.md, item 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, in the owner's words (9.5):** *"when the owner edits or rejects a draft, the agent proposes a change to `references/my-rules.md`, written only after the owner says yes."* The workflow gets better at the owner's own way of working, the owner sees every rule word for word before it exists, and nothing about the hard rules (9.2) can be loosened by a rule.

**Architecture:** No new step kind, no new store, no new top-level command. Two kinds of correction reach the same place:

1. **In chat** (level A): the owner corrects a result the agent shows them (a daily list, a draft). The workflow's skill already says *"When the owner corrects a result, the agent proposes a rule here and adds it only after the owner says yes"* (`rulesMarkdown`, D154). Item 8 adds the operator rule and the one recorded way to write the rule.
2. **In an approval** (Home 1, the owner decides in their own terminal, D61): an edit or a rejection happens where no chat is open. The existing learning loop (D97, `learning.ts`) already turns such decisions into candidates, but only for a judge naming a Skills Wiki skill. Item 8 reuses the same collection (the claim per approval, the body built from the person's side only, the redaction) to keep a **rule candidate** for any workflow that has the skill folder TaskFollow wrote, and shows it at the next session through the list form of `taskfollow why` (the D164 path the session-start rule already runs).

Either way the agent proposes the wording, the owner says yes, and the agent runs `taskfollow workflow rule <id> --value '{"rule":"…"}'`, which appends that one line to the workflow's `references/my-rules.md` and audits it. Runs read `references/*.md` at run time (D153, `skills.ts`), so the rule applies from the next run, and in chat at once. The workflow file is not touched, so its version and its shape (D159) stay as they are.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Measured against:** v1, `docs/scope-refresh.md` 9.5 (learning), 9.12 item 8, section 5 (workflows as skills, `my-rules.md`), read with 9.15 (two homes), which wins where they differ. D97 (the learning loop), D154 (workflow skills), D160 (delivery to Claude Cowork), D163 (consult), D164 (`why` shows what TaskFollow noticed), D151 (an `agent_call` can be rejected, not edited).

**Precondition:** items 5 and 6 are merged (their shapes write `references/my-rules.md`, their skills say how rules are used); operator rule 14 is item 6's opportunity rule, so this item's rule is **15**.

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
- **TaskFollow writes only the file it wrote.** The same checks uninstall uses (`removeWritten`): the recorded folder, resolved with `realpath`, still inside the recorded skills root and still holding `SKILL.md`; otherwise it refuses and says why.
- Plain words in everything the person sees; no industry words in INSTALL.md before section 11; tests never touch the real `~/.claude`; `npm run typecheck` and the full `npm test` twice before the PR; no edits while the suite runs; a Fable code review, then the fixes.

## Review Focus

1. **One candidate per decided approval, never two, never lost.** A separate claim folder (`state/learnings/from-approvals-rules/`) so a workflow with both a `skillswiki:` judge and its own skill gets both kinds, each once. A candidate stays open until `workflow rule … "learning":N` or `learnings dismiss N`.
2. **The append is safe.** A rule is one line, 1 to 300 characters after trimming, no line breaks, no `taskfollow <command>` text (`checkDelivered` would refuse it in a Cowork zip anyway), and no Markdown heading (`#`), so it cannot break the "## The owner's own rules" heading `skillText` relies on.
3. **Home 2 is told the truth.** TaskFollow cannot update a skill already uploaded to Cowork. When the workflow was delivered (its zip exists in `taskfollow-deliver/`), the answer says so and gives the two steps to deliver again. Whether an upload with the same name replaces the old skill is not known: human task 41 checks it.

---

### Task 1: rule candidates from approvals

**Files:** `src/core/learning.ts` (a `RuleCandidate` type, `RULES_DIR = state/learnings/rules`, `RULES_CLAIM_DIR = state/learnings/from-approvals-rules`, `collectRuleCandidates`, `listRuleCandidates`, `dismissRuleCandidate`); `src/core/tick.ts` (the learning guard also collects rule candidates); tests `tests/unit/learning.test.ts`.

- A candidate: `{ id, approval, workflow, step, body, status: "open" | "added" | "dismissed", created_at, closed_at? }`. `body` is `learningBody(item, names)`, the same redacted text from the person's side.
- Made for every edited or rejected approval item with `source.run`, when `loadWritten(home).skill_folders` has that workflow. An `agent_call` item can only be rejected (D151), so its candidate carries the reason only. A workflow without a TaskFollow-written folder (an agent with no known skills folder) gets no candidate.
- [ ] Failing tests: `an edited approval of a workflow with its own skill becomes one open rule candidate`; `a rejected approval with a reason keeps the reason, redacted`; `the same approval never becomes two candidates, even across ticks`; `a workflow without a skill folder TaskFollow wrote gets no candidate`; `a skillswiki judge's correction still becomes a Skills Wiki learning, and a rule candidate too`; `rule candidates are never sent to Skills Wiki`; `a rejected agent_call becomes a candidate with its reason`; `an approval decided by the agent's refused attempt (approval.refused) makes no candidate`.
- [ ] Implement; tests pass.

### Task 2: the rule writer, `workflow rule`

**Files:** `src/core/workflow-skill.ts` (`appendRule(home, workflow, rule, now)`; `ownedRulesFile(home, workflow)` reusing `removeWritten`'s `inside`/`realpath` check); `src/core/lifecycle.ts` (`workflowCommand` sub `rule`); `src/core/learning.ts` (closing the candidate); tests `tests/unit/workflow-skill.test.ts`, `tests/unit/lifecycle.test.ts`.

- `taskfollow workflow rule <id> --value '{"rule":"<one line>","learning":<id, optional>}'`.
- Appends `- <rule>` to `references/my-rules.md`. The first time, it replaces the "None yet…" line `rulesMarkdown` wrote. With `learning`, the candidate becomes `added`. Audit `rules.added` with `{ workflow, learning?, sha256 }`, never the text.
- Answer: `{ "status": "added", "workflow": "<id>", "rule": "<the text>", "file": "<path>", "next": "Tell the person exactly this rule, word for word: it applies from the next run and in chat now. To change or remove a rule, they edit <path> themselves." }`, plus `"cowork"` when delivered (Task 4).
- Refusals, exact words:
  - no such workflow: the existing `loadWorkflow` message;
  - no rules file TaskFollow wrote: `"Workflow '<id>' has no rules file TaskFollow wrote (its agent has no skills folder TaskFollow knows), so there is nowhere to keep a rule: tell the person, and keep the rule in mind in chat"`;
  - the file was moved or linked elsewhere: `"TaskFollow did not write <path> as it is now (moved, linked elsewhere, or without SKILL.md), so it leaves it alone: the person can add the rule there themselves"`;
  - bad text: `"A rule is one line of 1 to 300 characters, with no line breaks, no heading and no taskfollow command: say it shorter, in the person's words"`;
  - a learning that is not open: `"Rule candidate <n> is <status> already"`.
- [ ] Failing tests: `workflow rule appends one line and replaces the None yet line the first time`; `a second rule is appended below the first`; `workflow rule refuses a line break, a heading, a taskfollow command and text over 300 characters`; `workflow rule refuses a rules file moved or linked out of the recorded folder`; `workflow rule refuses a workflow whose agent has no skills folder`; `workflow rule with learning closes that candidate; a closed one is refused`; `the rule is audited by fingerprint, never by text`; `the workflow file, its version and its shape are unchanged after a rule`; `the next run's prompt holds the new rule` (fake agent, the prompt it was given); `a rule saying to send without asking changes no approval level` (levels derived as before for `channel.send` and an `agent_call`).
- [ ] Implement; tests pass.

### Task 3: telling the agent, and dismissing

**Files:** `src/core/why.ts` (list form: collect, then show open candidates); `src/cli.ts` (`learnings dismiss <id>`, `learnings` also lists rule candidates); tests `tests/unit/why.test.ts`, `tests/unit/learning.test.ts`.

- `taskfollow why` (list form) first runs `collectRuleCandidates`, so a correction made in the terminal shows at the very next session, not only after a tick. Then, below D164's lines:

  ```
  Corrections to turn into rules (propose one rule each in the person's words; add it with 'taskfollow workflow rule' only after they say yes, or 'taskfollow learnings dismiss <n>'):
      3: in workflow 'inbox-triage', a person rejected the channel.send call. Their reason: "too formal".
  ```

  Open candidates are shown at every session until closed, at most 5 lines, plus "and <k> more ('taskfollow learnings')". Unlike D164's suggestions they are not cleared by showing, because the yes may come later.
- `taskfollow learnings dismiss <n>` gives `{ "status": "dismissed", "learning": n }` and audits `rules.dismissed`.
- [ ] Failing tests: `why lists an open rule candidate made since the last tick`; `why lists at most five candidates and says how many more`; `a dismissed or added candidate is no longer listed`; `learnings lists Skills Wiki learnings and rule candidates`; `learnings dismiss refuses an unknown or closed candidate`.
- [ ] Implement; tests pass.

### Task 4: Home 2, Claude Cowork

**Files:** `src/core/workflow-skill.ts` (`appendRule` checks `<work_dir>/taskfollow-deliver/<id>.zip`); tests `tests/unit/workflow-skill.test.ts`, `tests/unit/deliver.test.ts`.

- TaskFollow cannot reach a skill already uploaded to Cowork, and it cannot see Cowork's chat. When the workflow's zip exists, the answer adds `"cowork": "This workflow also runs on Claude Cowork's own schedule, which still has the copy uploaded before this rule. To use the rule there: run 'taskfollow check deliver <id>' and upload the new zip in Settings, then Skills, in place of the old '<id>' skill."`.
- A correction the owner makes in Cowork's own chat happens where TaskFollow is not: Cowork's agent can propose the rule there, but it writes nothing on this computer. The operator rule asks the agent in the install folder, at the next session, whether the owner corrected a Cowork result, and adds the rule the usual way.
- [ ] Failing tests: `a rule for a delivered workflow says Cowork still has the old copy, and how to deliver again`; `a delivered zip made after the rule holds the rule under The owner's own rules`; `a rule for a workflow never delivered says nothing about Cowork`.
- [ ] Implement; tests pass.

### Task 5: operator rule 15, INSTALL.md, consult

**Files:** `INSTALL.md` (operator rule 15; section 9b, one sentence after the interview; section 9 in the workflow list); tests: a new `tests/unit/operator-rules.test.ts` (no test reads the operator rules today; `neutrality.test.ts` and `install-examples.test.ts` read INSTALL.md for other things and must stay green).

- Rule 15, word for word: *"When the person edits or rejects a result of one of their workflows, in chat or in an approval, propose one short rule for that workflow's `references/my-rules.md`, in their words, and show it. Add it with `taskfollow workflow rule <id> --value '{\"rule\":\"…\"}'` only after they say yes, then tell them the exact text that was added. Propose once per correction; if they say no, do not propose it again. A rule never changes what needs their approval."*
- Consult (D163): a consultation adds no workflows, so there is nothing to keep a rule in; `workflow rule` answers with the existing "no such workflow" refusal, and the consult report is unchanged.
- [ ] Failing tests: `INSTALL.md has operator rule 15 with workflow rule and the yes`; `operator rules are numbered 1 to 15 without gaps`.
- [ ] Implement; tests pass.

### Task 6: docs, verification, PR

- [ ] DECISIONS.md: a new D-number for item 8. `docs/next-steps.md`: the build map row. `docs/human-tasks.md`: **task 41** (below).
- [ ] `npm run typecheck`; the full `npm test` twice; the safety checks (`claude mcp list`, `~/.claude/settings.json` checksum).
- [ ] A Fable code review, then the fixes; the PR in plain words with the building-blocks table.

## What the person sees

- At the next session after rejecting a reply in their terminal: the agent says *"Yesterday you rejected the reply to the plumber because it was too formal. Shall I add this rule to your inbox replies: 'Write replies in a short, friendly tone, first names only'?"*
- After yes: *"Added to your inbox-triage rules: 'Write replies in a short, friendly tone, first names only.' It applies from the next run."* When the workflow also runs on Cowork: *"Your Cowork copy still has the old rules; to update it, upload the new zip I just made (Settings, then Skills)."*
- After no: nothing is written, and the agent does not ask about it again (`learnings dismiss`).

## Human task 41 (about 20 minutes, after items 5, 6 and 8 are merged)

On the owner's real Claude Code (2.1.295 or later) in a throwaway install with the email channel and `inbox-triage-replies`:

1. Let a run draft a reply; reject it in your terminal with `--reason "too formal"`.
2. Open a new session in the install folder: the agent should mention the correction and propose a rule. Say yes.
3. Check `.claude/skills/inbox-triage-replies/references/my-rules.md` holds exactly that line, and that the next run's draft follows it.
4. Optional, Home 2: run `check deliver` for a report-only workflow after adding a rule, upload the new zip with the same name, and say whether Cowork replaced the old skill or refused or kept both.

Clean-up as in earlier tasks: settings checksum unchanged, `claude mcp remove -s user installer`, the `~/.claude/projects/*<test>*` folders inspected and deleted, never `taskfollow uninstall`.

## Risks

- **The yes cannot be verified by code.** It rests on operator rule 15 and the agent's honesty, as `workflow add` does (D145). The audit and the word-for-word answer make a silent write visible afterwards. Making it a terminal-only command would prove a person typed it, but would move a chat decision out of the chat (open question 1).
- **A rule inlined into prompts is instructions.** A rule the owner accepted could still be badly worded. It can never change a level or skip an approval (Global Constraints), and the owner can edit or delete it in the file.
- **Cowork's copy goes stale** until the owner delivers again; TaskFollow says so each time, and cannot do more (9.15: an honest no, with the steps).
- **Many corrections, many prompts.** Five lines at most in `why`, and a dismissed candidate never returns.

## Out of scope

- Editing or removing a rule through TaskFollow (the owner edits the file; open question 2).
- Rules learned from corrections inside Cowork's own chat being written on this computer automatically.
- Sending rules or candidates anywhere (Skills Wiki learnings stay as D97 built them).
- Any change to how levels are derived, the hook, or approvals.
- A weekly patterns scan (D165), new channels, Windows-specific work.

## Open questions for the owner

1. **Who may run `workflow rule`:** the agent after your yes in chat (this plan's default, like `workflow add`), or only you in your own terminal (proves a person typed it, but the yes leaves the chat)?
2. **Changing or removing a rule:** is editing `my-rules.md` yourself enough for v1, or should `workflow rule` also remove a rule by its line?
