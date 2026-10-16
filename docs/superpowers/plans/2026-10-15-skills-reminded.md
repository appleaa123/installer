# Skills reminded, not controlled (9.12, item 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TaskFollow tells the owner's agent which skills exist for each workflow, from the agent's own skill folders or Skills Wiki alike, puts those skills into every run's prompt (D153), writes each workflow's own skill folder into the agent's skills folder, keeps one short section in the agent-level file (`CLAUDE.md`), and removes what it wrote on uninstall.

**Architecture:** A new `skills.ts` lists skills (names and descriptions only) and reads a local skill's text. A workflow file gains a `skills` list (local folder paths or `skillswiki:` references). The runner loads that list's text once per run, lazily, and every model-facing step (task, judge, agent) gets it in its prompt. `workflow add` writes the workflow's skill folder (`SKILL.md` + `references/my-rules.md`) under the install folder's `.claude/skills/`, records what it wrote, and rewrites a marked section of `CLAUDE.md`. `uninstall` removes exactly those.

**Tech Stack:** TypeScript on Node 22, vitest; no new dependencies.

**Spec:** `docs/scope-refresh.md` section 9: 9.5 and 9.12 item 2, plus 9.13 items 1 (the skills reminder rule only) and 5 (uninstall). D153 decides run time. **Measured against:** v1 (section 9).

## Global Constraints

- TaskFollow never copies, installs, updates, ranks or deletes a skill it did not write (9.12 item 2, "Inventory"). The one thing it writes is each workflow's own skill folder (9.12 "Workflow skills"), and uninstall removes only that.
- Names and descriptions only in the inventory; never a skill's body (9.12 "Inventory").
- TaskFollow never chooses a skill. The agent proposes from the inventory, the owner confirms, and `workflow add` records the confirmed references (9.12 "Matching by the model").
- No priority between local and Skills Wiki skills (9.5).
- In the agent-level file, TaskFollow writes only its own marked section and leaves the rest of the file byte-identical (9.12 "Reminding in chat").
- A local skill needs no Skills Wiki; only `skillswiki:` references need a connection (9.12 "D126 changes").
- Tests never touch the real `~/.claude`, the repo's own folder or the person's `CLAUDE.md` (the owner's rule). After the suite: `claude mcp list` shows no installer/taskfollow entry and `~/.claude/settings.json` has no watch-hook.
- `npm run typecheck` and the full `npm test` before the PR; do not edit files while the suite runs.
- Plain words in every message the person may see.

## Review Focus

1. **The install folder is the repo during tests.** Ten e2e files run `start` without a `cwd`, so `work_dir` would be the repo and `workflow add` would write `.claude/skills/` and `CLAUDE.md` into it. Task 1 makes `runCli` default to a fresh temporary folder and adds a check after the suite that the repo has no new `CLAUDE.md` or `.claude/skills/`.
2. **The owner already has a `CLAUDE.md`.** It must stay byte-identical outside the marked section, keep its file mode, and survive a second and third `workflow add`. A file with a begin marker and no end marker is refused, not overwritten (Task 5).
3. **A skill path that points elsewhere.** A local reference must resolve, after following links, inside the install folder's or the user's skills folder, and contain `SKILL.md`. Anything else is refused at `workflow add` and again at run time (Task 2, Task 4).
4. **A skill removed after the workflow was added.** The run fails at its first model step with a plain reason naming the folder, not a stack trace (Task 4).
5. **A skill too large for a prompt.** `SKILL.md` plus `references/*.md` over 64 KB is refused with the size and the limit (Task 2).

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/skills.ts` (new) | Skill folders for the agent, the inventory (local + Skills Wiki), reading one local skill's text, checking a reference |
| `src/core/workflow-skill.ts` (new) | Writing a workflow's own skill folder, the record of what TaskFollow wrote (`state/written.json`), removing it |
| `src/core/agent-file.ts` (new) | The marked section in `CLAUDE.md` / `AGENTS.md`: write, replace, remove |
| `src/core/profile.ts`, `profiles/*.json` | `skills_dirs` and `instructions_file` per agent |
| `src/core/workflow.ts` | `Workflow.skills` parsed and checked |
| `src/core/lifecycle.ts` | `workflow add`: `skills`, `my_rules`, the skill folder, the section, D126 |
| `src/core/runner.ts`, `runner-steps.ts`, `task-step.ts`, `agent-task.ts`, `judge.ts`, `agentic.ts` | The run's skills text, loaded once, put into each model-facing prompt |
| `src/core/uninstall.ts` | Remove the skill folders and the section |
| `src/cli.ts` | `taskfollow skills` |
| `INSTALL.md`, `solutions/starter.json` (1.8.0), `DECISIONS.md` (D154), `docs/next-steps.md`, `docs/human-tasks.md` | Operator rules, the WORKFLOWS step, the record |
| `tests/helpers/cli.ts`, `tests/global-setup.ts`, `vitest.config.ts` | Isolation |

---

### Task 1: Test isolation first

**Files:**
- Modify: `tests/helpers/cli.ts:24-31`
- Modify: `tests/global-setup.ts`
- Modify: `vitest.config.ts` (env block at line ~33)

**Interfaces:**
- Produces: env `INSTALLER_AGENT_USER_SKILLS` (a temp folder) that `skills.ts` reads instead of `~/.claude/skills` (Task 2).

- [ ] **Step 1:** In `runCli`, when `options.cwd` is absent, use a fresh `mkdtempSync(join(tmpdir(), "installer-cwd-"))`:

```ts
const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "installer-cwd-"));
const result = spawnSync(process.execPath, [CLI, ...homeArgs, ...args], {
  encoding: "utf8", cwd,
  ...(options.input === undefined ? {} : { input: options.input }),
  env: { ...process.env, ...options.env },
});
```

- [ ] **Step 2:** In `vitest.config.ts` env, add `INSTALLER_AGENT_USER_SKILLS: mkdtempSync(join(tmpdir(), "installer-user-skills-"))`.
- [ ] **Step 3:** `tests/global-setup.ts` returns a teardown that fails the run when the repo gained a `CLAUDE.md`, an `AGENTS.md` or a `.claude/skills` folder it did not have at setup:

```ts
const WATCHED = ["CLAUDE.md", "AGENTS.md", join(".claude", "skills")];
export default function setup(): () => void {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
  const before = WATCHED.filter((path) => existsSync(path));
  return () => {
    const added = WATCHED.filter((path) => existsSync(path) && !before.includes(path));
    if (added.length > 0) throw new Error(`Tests wrote into the repo: ${added.join(", ")}`);
  };
}
```

- [ ] **Step 4:** Run the full suite. Expected: green, same count as main (135 files, ~1,868 tests). Commit `test: run CLI tests from a temp folder and guard the repo`.

### Task 2: Skill folders and the inventory (`skills.ts`, `taskfollow skills`)

**Files:**
- Create: `src/core/skills.ts`, `tests/unit/skills.test.ts`
- Modify: `src/core/profile.ts` (type + validation), `profiles/claude-code.json`, `profiles/codex.json`, `src/cli.ts` (COMMANDS, ON_INSTALL)

**Interfaces:**
- Produces:

```ts
export const SKILL_FILE = "SKILL.md";
export const SKILL_TEXT_LIMIT = 64 * 1024;
export const USER_SKILLS_ENV = "INSTALLER_AGENT_USER_SKILLS";
export interface SkillRoots { readonly project?: string; readonly user?: string }
export interface SkillEntry { readonly source: "install folder" | "your own" | "Skills Wiki"; readonly name: string; readonly description: string; readonly ref: string }
export function skillRoots(profile: RuntimeProfile, workDir: string | undefined, env: NodeJS.ProcessEnv): SkillRoots;
export function frontmatter(text: string): { readonly name?: string; readonly description?: string };
export async function localSkills(root: string, source: SkillEntry["source"]): Promise<SkillEntry[]>;
export async function skillswikiSkills(target: McpTarget): Promise<SkillEntry[]>;
export async function inventory(home: string, env: NodeJS.ProcessEnv): Promise<{ readonly skills: readonly SkillEntry[]; readonly notes: readonly string[] }>;
export async function checkLocalSkill(ref: string, roots: SkillRoots): Promise<string>; // the folder's real path, or throws InputError
export async function localSkillText(ref: string, roots: SkillRoots): Promise<string>; // SKILL.md then references/*.md, ≤ SKILL_TEXT_LIMIT
```

- Profile additions: `skills_dirs?: { project?: string; user?: string }` (project is relative to the install folder; user may start with `~/`), `instructions_file?: string`. `claude-code.json`: `"skills_dirs": { "project": ".claude/skills", "user": "~/.claude/skills" }, "instructions_file": "CLAUDE.md"`. `codex.json`: `"instructions_file": "AGENTS.md"` only (Codex's skill folder is not checked: the inventory says so in `notes`).

Behaviour:
- `skillRoots`: `project = join(workDir, profile.skills_dirs.project)` when both exist; `user = env[USER_SKILLS_ENV] ?? expandHome(profile.skills_dirs.user)`.
- `localSkills(root)`: each direct subfolder with a `SKILL.md`; name from frontmatter `name`, else the folder name; description from frontmatter `description` (one line; quotes stripped), else `""`; `ref` is the folder's absolute path. A missing root gives `[]`. Unreadable entries are skipped.
- `frontmatter`: the block between a first line `---` and the next `---`; `key: value` lines only; a value in single or double quotes is unquoted; a folded value (`>` or `|`) takes the indented lines that follow, joined by spaces.
- `skillswikiSkills`: `callTool(target, "list_active_skills")`; for each `active_skills[]` entry, `callTool(target, entry.list_tool)` returns `{ "<skill>": "<description>" }`; `ref = skillswiki:<pack>/<skill>/SKILL.md`. A pack whose list call fails is skipped and named in `notes`. (Shapes seen on the live server on 2026-10-15.)
- `inventory`: project, then user, then Skills Wiki when `state.skillswiki` is set. `notes` says, in plain words, when the agent's skill folders are unknown (`skills_dirs` missing) or Skills Wiki could not be reached.
- `checkLocalSkill`: `ref` must be absolute; `realpath(ref)` must be inside `realpath(roots.project)` or `realpath(roots.user)`; `SKILL.md` must exist; `localSkillText` must fit. Messages: `"<ref>" is not inside your agent's skills folders (<project>, <user>)`, `"<ref>" has no SKILL.md`, `The skill "<ref>" is <n> KB; a workflow skill must stay under 64 KB with its references`.
- `localSkillText`: `SKILL.md` text, then each `references/*.md` sorted by name, each headed `### references/<file>`.
- CLI: `taskfollow skills` (on an install) prints `{ skills, notes, next: "Tell the person which of these fit the workflow and why; add the ones they confirm with \"skills\":[<ref>,…] in taskfollow workflow add" }`.

- [ ] **Step 1: Failing tests** in `tests/unit/skills.test.ts` (temp folders only):
  - lists two project skills and one user skill with names and descriptions, and never includes body text (assert a body sentence is absent from the JSON);
  - frontmatter: quoted, unquoted, folded `>` description; no frontmatter → folder name and `""`;
  - a folder without `SKILL.md` is not listed;
  - `checkLocalSkill`: accepts a project skill; refuses a path outside both roots; refuses a symlink inside the project root that points outside (Review Focus 3); refuses a folder without `SKILL.md`; refuses 65 KB of text (Review Focus 5);
  - `localSkillText` includes `references/my-rules.md` after `SKILL.md`;
  - `skillswikiSkills` against the fake Skills Wiki server used by `tests/unit/skillswiki*.test.ts` (extend it with `list_active_skills` and one `<pack>_list_…` tool returning the live shape): two entries with `skillswiki:` refs; a failing list tool lands in `notes`;
  - profile: a `skills_dirs.project` that is absolute or contains `..` is refused by profile validation.
- [ ] **Step 2:** Run `npx vitest run tests/unit/skills.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `skills.ts`, the profile fields and the CLI command.
- [ ] **Step 4:** Tests pass. Commit `feat(skills): list the agent's skills, names and descriptions only`.

### Task 3: A workflow's `skills` list, and D126

**Files:**
- Modify: `src/core/workflow.ts` (`Workflow`, `parseWorkflow`), `src/core/lifecycle.ts` (`newWorkflow`, `addWorkflow`, `describeAll`)
- Test: `tests/unit/workflow.test.ts`, `tests/unit/lifecycle.test.ts` (or the existing files that cover them; add to them)

**Interfaces:**
- Consumes: `checkLocalSkill`, `skillRoots` (Task 2).
- Produces: `Workflow.skills: readonly string[]` (empty when absent); `export const MAX_WORKFLOW_SKILLS = 10`; `export const isSkillswikiRef = (ref: string): boolean`.

Behaviour:
- `parseWorkflow`: `skills` optional; an array of at most 10 distinct non-empty strings, each `skillswiki:<pack>/<skill>/<path>` (checked with `parseSkillswikiRef`) or an absolute path. Messages: `skills must list at most 10 skills`, `skills[1] must be a folder path from 'taskfollow skills' or skillswiki:<pack>/<skill>/<path>`, `skills lists '<ref>' twice`.
- `workflow add`: `--value` may carry `skills` and `my_rules` in every form: a description (agentic), `steps` (typed), or, for a suggestion, a JSON object with no `description` (`taskfollow workflow add <suggested id> --value '{"skills":[…],"my_rules":"…"}'`). `skills` goes into the written file; `my_rules` does not (Task 6 writes it into the skill folder).
- Each local reference is checked with `checkLocalSkill` before anything is written.
- **D126 changes:** the Skills Wiki connection is required only when a judge `skill` or a workflow `skills` entry is a `skillswiki:` reference. A workflow with only local skills is added without Skills Wiki.
- `workflow list` shows each workflow's `skills`.

- [ ] **Step 1: Failing tests:** parse accepts local + skillswiki; refuses 11, a relative path, a bad skillswiki ref, duplicates; `workflow add` with a local skill and no Skills Wiki → added, file has `skills`; with a `skillswiki:` skill and no Skills Wiki → the existing plain message; a suggestion with `--value '{"skills":[…]}'` → added with the suggestion's steps and the skills; a local path outside the roots → refused and nothing written (no workflow folder).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass. Commit `feat(workflow): a workflow names its skills, local or Skills Wiki (D126)`.

### Task 4: Skills in every run's prompt (D153)

**Files:**
- Modify: `src/core/runner-steps.ts` (`Exec`), `src/core/runner.ts` (`prepare`), `src/core/task-step.ts`, `src/core/agent-task.ts` (`TaskRequest`, `taskPrompt`), `src/core/judge.ts` (`judgePrompt`, `askJudge` signature), `src/core/agentic.ts` (`agentPrompt`)
- Test: `tests/unit/agent-task.test.ts`, `tests/unit/judge*.test.ts`, `tests/unit/agentic*.test.ts`, `tests/unit/runner*.test.ts` (add to the existing files)

**Interfaces:**
- Consumes: `Workflow.skills` (Task 3), `localSkillText`, `skillRoots` (Task 2), `pinnedSkill` (`packs.ts`, D107).
- Produces: `Exec.skills: () => Promise<string | null>` (memoized like `backend`); `export function skillsBlock(sections: readonly { ref: string; text: string }[]): string | null` in `skills.ts`; `TaskRequest.skills?: string`.

Behaviour:
- `prepare` builds `skills` lazily: for each reference in order, local → `localSkillText` (checked again, Review Focus 3), `skillswiki:` → `pinnedSkill(home, url, ref, now, record.shadow)`; joined by `skillsBlock`:

```
The owner's skills for this workflow. Follow them; where they differ from the general rules above, the owner's rules win, except the hard rules (a person is asked before sending to customers, paying, legal matters and deleting).
--- skill: <ref> ---
<text>
--- end of skill ---
```

- A workflow without skills: `null`, no file read, no prompt change (existing prompts stay byte-identical: assert in one existing snapshot-style test).
- `taskPrompt(prompt, input, changes, skills?)`: the block goes after the step's prompt and before "Rules for this task". `judgePrompt`: after the instructions and the step's own `skill`. `agentPrompt`: after "The task". The fallback agent gets it too (it uses `agentPrompt`).
- A load failure (folder gone, now outside the roots, too large) throws `ActionFailure("The skill '<ref>' could not be read: <reason>. Fix the folder or add a new version of the workflow without it.")`; the step fails and the run's reason says it (Review Focus 4).

- [ ] **Step 1: Failing tests:** a task step's argv prompt contains the skill text and `references/my-rules.md`, in that order, before "Rules for this task"; a judge prompt and an agent prompt contain the block; no skills → prompts unchanged; the skill folder deleted between `workflow add` and `run` → run `failed`, reason names the folder; a `skillswiki:` workflow skill reads the pinned copy (no second fetch: the fake server counts calls).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. Commit `feat(runner): put the workflow's skills into each run's prompt (D153)`.

### Task 5: The section in the agent-level file (`agent-file.ts`)

**Files:**
- Create: `src/core/agent-file.ts`, `tests/unit/agent-file.test.ts`

**Interfaces:**
- Produces:

```ts
export const SECTION_BEGIN = "<!-- taskfollow:begin (TaskFollow rewrites only the lines between these markers) -->";
export const SECTION_END = "<!-- taskfollow:end -->";
export interface WorkflowLine { readonly workflow: string; readonly description: string; readonly skills: readonly string[] }
export function sectionText(lines: readonly WorkflowLine[], workDir: string): string;
export async function writeSection(file: string, body: string): Promise<{ readonly created: boolean }>;
export async function removeSection(file: string, created: boolean): Promise<"removed" | "deleted" | "absent">;
```

Section body:

```
## TaskFollow workflows

TaskFollow runs these workflows for the owner. When the owner asks about this work in chat, use the skills listed for it. Always ask the owner before sending anything to a customer, paying, anything legal, or deleting.

- **<workflow>**: <description, one line, at most 200 characters>. Skills: <name> (`.claude/skills/<name>`), skillswiki:<pack>/<skill>/SKILL.md
```

Local paths are shown relative to the install folder when inside it.

Behaviour:
- `writeSection`: file absent → create it with only the section (mode 0644), `created: true`. Present with both markers → replace between them (markers included). Present without markers → append a blank line and the section. A begin marker without an end marker, or two begin markers → `InputError("<file> has a TaskFollow section that is not closed; fix or remove the line '<SECTION_BEGIN>' and try again")`, file untouched. Write to a temp file in the same folder and rename; keep the original mode.
- `removeSection`: strip the markers and the lines between, and the blank line TaskFollow added before them; if `created` and the rest is only whitespace, delete the file.

- [ ] **Step 1: Failing tests:** create; replace keeps every byte outside the markers (compare prefix and suffix exactly, Review Focus 2); a file with CRLF line endings keeps them; append to an existing file; the unclosed marker refused and file unchanged; mode 0600 kept; remove restores the original bytes exactly for a file that existed; a created file is deleted on remove; remove on a file without the section → `absent`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. Commit `feat(agent-file): one marked section in CLAUDE.md, nothing else touched`.

### Task 6: `workflow add` writes the workflow's skill folder and the section

**Files:**
- Create: `src/core/workflow-skill.ts`, `tests/unit/workflow-skill.test.ts`
- Modify: `src/core/lifecycle.ts` (`addWorkflow`), `tests/e2e/` (one e2e: start in a temp install folder, `workflow add` with `my_rules`, check the files)

**Interfaces:**
- Consumes: `skillRoots`, `checkLocalSkill` (Task 2), `writeSection`, `sectionText` (Task 5).
- Produces:

```ts
export const WRITTEN_FILE = join("state", "written.json");
export interface Written { readonly skill_folders: readonly { readonly workflow: string; readonly path: string }[]; readonly agent_file?: { readonly path: string; readonly created: boolean } }
export async function loadWritten(home: string): Promise<Written>;
export async function writeWorkflowSkill(home: string, roots: SkillRoots, workflow: { id: string; description: string }, myRules: string | undefined): Promise<string | null>; // folder path, or null when the agent has no project skills folder
export async function refreshAgentFile(home: string): Promise<string | null>; // the file written, or null when the agent has no instructions_file
export async function removeWritten(home: string): Promise<{ readonly skill_folders: readonly string[]; readonly agent_file: string }>;
```

Behaviour:
- `writeWorkflowSkill`: when `roots.project` exists (the folder may need creating), write `<project>/<id>/SKILL.md` and `<project>/<id>/references/my-rules.md`. Refuse if `<project>/<id>` already exists: `Your agent already has a skill folder named '<id>' (<path>); choose another workflow name`. Nothing is overwritten.
- Generated `SKILL.md` (the shipped shapes of items 5–6 will replace this text for their workflows):

```
---
name: <id>
description: Use for the owner's "<id>" work, which TaskFollow also runs as a workflow: <description, one line, at most 300 characters>. Use it whenever this work comes up, in chat or in a run.
---

# <id>

<description>

## The owner's own rules

Read `references/my-rules.md` first. The owner's rules there win over anything general here.

## Always ask a person first

Before sending anything to a customer, paying or committing money, anything legal, and deleting anything, ask the owner and wait for a yes, however sure you are.
```

- `my-rules.md`: `# My rules for <id>\n\n<my_rules>` or, when absent, `# My rules for <id>\n\nNone yet. When the owner corrects a result, the agent proposes a rule here and adds it only after the owner says yes.\n`.
- `addWorkflow` order: parse and check everything (Task 3) → write the skill folder → write the workflow file with the folder's path first in `skills` → record in `written.json` → `refreshAgentFile` (all workflows, current versions) → audit `workflow.added` with `skill_folder` and `agent_file`. If the skill folder or the section fails, nothing of this workflow stays: remove the folder written in this call, do not write the workflow file, rethrow.
- No project skills folder for the agent (Codex today): the workflow is added without a folder, and the result says `note: "<agent> has no skills folder TaskFollow knows; the workflow's rules stay in the run's prompt only"`. `my_rules` then goes into the workflow file as `my_rules` and into the prompt block. *(Within 9.7: say every gap clearly.)*
- The result of `workflow add` adds `skill_folder` and `agent_file`.

- [ ] **Step 1: Failing tests:** the two files with the right text and frontmatter; `my_rules` absent → the placeholder; an existing folder → refused, nothing written, no workflow; a second workflow → the section lists both and the bytes outside it are unchanged; a failing section write (unclosed marker) → no folder, no workflow file; the e2e from a temp install folder writes `.claude/skills/<id>/` and `CLAUDE.md` there and nowhere else.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. Commit `feat(workflow): add writes the workflow's skill folder and the CLAUDE.md section`.

### Task 7: Uninstall removes what TaskFollow wrote (9.13 item 5)

**Files:**
- Modify: `src/core/uninstall.ts`, `tests/unit/uninstall*.test.ts` (or `tests/e2e/uninstall*.test.ts`)

**Interfaces:**
- Consumes: `removeWritten` (Task 6).

Behaviour:
- After unregistering and before deleting secrets: `removeWritten(home)`. Each recorded skill folder is removed only when its real path is still inside the recorded project root and still has `SKILL.md`; anything else is left and named in the result (`left: [{path, why}]`). The section is removed; a file TaskFollow created and that is now empty is deleted.
- The result gains `removed: { skill_folders, agent_file }`, and the audit payload the same. Other files in the install folder and other skills are untouched.

- [ ] **Step 1: Failing tests:** two workflow folders and the section removed; the owner's own skill folder beside them and the owner's text in `CLAUDE.md` untouched (byte-compare); an edited `my-rules.md` is still removed (TaskFollow wrote the folder); a recorded path that is now a symlink to elsewhere is left and reported.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass. Commit `feat(uninstall): remove workflow skill folders and the CLAUDE.md section`.

### Task 8: Operator rules, the starter step, and the record

**Files:**
- Modify: `INSTALL.md` (section 9, a new "Skills for a workflow" paragraph; Operator rules), `solutions/starter.json` (`workflows.choose` intent; version 1.8.0), `README.md` (one line under the commands list, if it lists commands), `DECISIONS.md` (D154), `docs/next-steps.md` (v1 map), `docs/human-tasks.md`

Text to add to INSTALL.md section 9:

> **Skills for a workflow.** Before adding a workflow, run `taskfollow skills`. It lists the skills your agent has (in the install folder, the person's own, and Skills Wiki when connected), names and descriptions only. Tell the person which ones fit this workflow and why, in plain words, and add only the ones they confirm: `"skills":["<ref from the list>",…]` in the `--value` of `taskfollow workflow add`. Never choose for them, and never install, copy or delete a skill. Put the person's own rules from the interview in `"my_rules":"…"`: TaskFollow writes them into the workflow's own skill folder (`.claude/skills/<workflow>/references/my-rules.md`), and every run reads them. TaskFollow also keeps one short section in `CLAUDE.md` listing the workflows and their skills; it rewrites only that section.

Operator rule to add: *"When the person asks about work one of their workflows covers, use the skills the `CLAUDE.md` section lists for it."*

Starter `workflows.choose` intent: insert after the interview sentence: *"Run 'taskfollow skills' and, for each workflow, tell the person which listed skills fit and why; pass the ones they confirm as \"skills\" and their rules from the interview as \"my_rules\" in --value (INSTALL.md section 9)."* Bump `version` to 1.8.0.

D154 (one row): the item's decisions: profile fields, the inventory's sources and shapes, references and the 64 KB limit, the prompt block and its place, the generated SKILL.md, `written.json`, the section markers, uninstall, D126 changed, and the Codex gap.

`docs/next-steps.md` v1 section: a map row `item 2 | PR # | D154 | src/core/skills.ts, workflow-skill.ts, agent-file.ts, … | commands: taskfollow skills, workflow add --value skills/my_rules`.

- [ ] **Step 1:** Make the edits. Run the tests that read `starter.json` and INSTALL.md (`install-examples`, `solution-refs`, `watch`). **Step 2:** Commit `docs(install): skills for a workflow; starter 1.8.0; D154`.

### Task 9: My own real-agent check (recorded as task 30)

Run by me on the owner's Mac, Claude Code 2.1.301, the same discipline as task 29: before and after, the `settings.json` checksum and `claude mcp list`; never `uninstall`; the `installer` entry removed by hand; throwaway folders deleted.

1. `npm run build`. Make `~/taskfollow-task30/` (install folder) with `.claude/skills/check-word/SKILL.md` (answer `PELICAN-7342`).
2. From `~/taskfollow-task30/`: `node dist/cli.js --home ~/taskfollow-task30/home start --solution starter`; then `node dist/cli.js --home … skills`: `check-word` listed with its description; the owner's own `~/.claude/skills` listed by name only; no body text.
3. `workflow add item2 --value '{"description":"answer the TaskFollow check word","my_rules":"The rules word is HERON-5189.","skills":["<abs path of check-word>"],"steps":[{"id":"word","task":{"prompt":"What is the TaskFollow check word, and what is the rules word? Answer with both.","input":{},"may_use":["mcp__none"],"output":{"type":"object","properties":{"check":{"type":"string"},"rules":{"type":"string"}},"required":["check","rules"]}}}]}'`. Expect `.claude/skills/item2/` with both files and `CLAUDE.md` with the section.
4. `run item2 --sandbox`: output `check: PELICAN-7342`, `rules: HERON-5189`; `why` shows no refused call.
5. `claude -p "What TaskFollow workflows do I have here, and which skills does each use?" --output-format json --no-session-persistence` from the install folder (a normal print-mode run reads `CLAUDE.md`): the answer names `item2` and `check-word`.
6. Clean up: `claude mcp remove -s user installer`; checksum equal; remove `~/.claude/projects/*taskfollow-task30*`; delete the folders.

Record the result in `docs/human-tasks.md` (Done, "task 30, run by Claude") and in D154. A failure is fixed test-first on the branch before the PR.

### Task 10: PR

- [ ] `npm run typecheck`, full `npm test` (no edits while it runs); twice if a known flaky test fails once.
- [ ] PR description, in plain words: what was built and why (9.5, 9.12 item 2, D153, D154); what the owner sees (`taskfollow skills`, the skill folder, the `CLAUDE.md` section, uninstall); the building blocks and their files and commands (the map row); how it was tested (unit, e2e, task 30 results). Merge on the owner's session authorization after the suite is green.

---

## Fable review of 2026-10-15, applied (this section overrides the tasks above where they differ)

Measured against v1 (section 9). Six blocking findings, eight to fix in the same build, six minor. The three code claims checked by me against the source: `tests/e2e/run-cli.test.ts:13` uses a relative `file:` ref; `tests/e2e/install-doc.test.ts:122-125` forbids "Skills Wiki" before INSTALL.md section 11; `src/core/hardening.ts:165-171` rebuilds the next version from a fixed field list.

**Task 1**
- H1: change `tests/e2e/run-cli.test.ts:13` to `` `file:${resolve("tests/fixtures/solution-channels.json")}` ``. Prove the guard once: make the teardown throw, run one test file, see a non-zero exit, revert.
- L4: the teardown also removes the `installer-cwd-*` folders it can find under `tmpdir()` that were made during the run (record the start time; only folders newer than it).

**Task 2**
- M4: `skillRoots` returns no `project` root when `work_dir` is the person's home folder or `realpath(project) === realpath(user)`; `inventory.notes` and `workflow add` then say: *"TaskFollow was started from your home folder, so it will not write a workflow skill or CLAUDE.md there; start it from the install folder (START-HERE step 4)."* Test: `work_dir = homedir()` → no project root, note present. Same rule for the instructions file (no `~/CLAUDE.md`).
- M3: `localSkillText` reads `SKILL.md` and `references/*.md` only when each file's real path is inside the checked skill folder; a symlink to elsewhere is refused with the folder's message. Test.
- M2: `SKILL_TEXT_LIMIT` (64 KB) is the limit of the **whole block** of a workflow (all its local skills together; `skillswiki:` text counted at run time). Checked at `workflow add` over all local references and again at run time. Message: `This workflow's skills come to <n> KB together; the limit is 64 KB (a run's prompt must stay small enough to start the agent)`.
- L2: the inventory lists every pack `list_active_skills` returns (all active skills, combo or not, as 9.12 says "its active skills"); `not_mounted` packs go into `notes`.
- M7: `tests/fixtures/profiles/fake-agent.json` gets `skills_dirs` and `instructions_file`; test homes that exercise writing get a temp `work_dir`.

**Task 3**
- H6: the owner's list is at most 9 (`MAX_OWNER_SKILLS = 9`); with the workflow's own folder first, the file holds at most 10 (`MAX_WORKFLOW_SKILLS = 10`, what `parseWorkflow` checks). `addWorkflow` parses the **final** raw (with the folder's path) before writing anything.
- M6: `namesSkillswikiSkill` (`skillswiki.ts:58-69`) also treats a `skills` array with a `skillswiki:` entry as using Skills Wiki. Test.
- M7: when `skills` is empty, the written file has no `skills` key (keeps `tests/unit/lifecycle.test.ts:53` exact).
- H3: `hardenedFile` (`hardening.ts:165-171`) carries `skills` from `current`; after `harden` and `rollback`, `refreshAgentFile(home)` runs. Tests: a hardened version keeps `skills`; the section reflects the current version after harden and after rollback.

**Task 4**
- M1: the block goes **after** "Rules for this task" and before the input in `taskPrompt`, and its first line reads: *"The owner's skills for this workflow. Follow them for how to do the work. The task's rules above and the hard rules (a person is asked before sending to customers, paying, legal matters and deleting) always win over a skill."* The same line in the judge and agent prompts (there "the rules above" are the judge's and agent's own framing).
- M5: `agentPrompt(run, turns, skills, retry?)` with `skills` awaited in `nextAnswer`; `judgePrompt(spec, input, context, skill, retry?, skills?)` keeps its first five positional parameters for the existing tests.
- L1: the run-time failure says: *"The skill '<ref>' could not be read: <reason>. Put the folder back, or add the workflow again under a new name without it (taskfollow workflow add)."*

**Task 6**
- H4: the order is: parse and check everything, **including the agent file's markers** (read it; an unclosed marker refuses here) → write the skill folder → refresh the section (it lists the new workflow from the raw in memory) → write the workflow file → `saveWorkflowState(sandbox)` → record in `written.json` → audit. On any failure after the folder was written: remove the folder, restore the section to the bytes read at the start, write no workflow file, rethrow. Test: a disk error injected at the workflow-file write leaves no folder, the agent file byte-identical, no `written.json` entry.
- H5: each `skill_folders` entry records `root` (the real path of the project skills folder at write time); Task 7 checks against it.
- Scope (owner's call, decided to stay within section 9): **no `my_rules` field in the workflow file.** An agent with no known skills folder gets the gap note only: *"<agent> has no skills folder TaskFollow knows, so this workflow's own rules have nowhere to live yet; tell the person (9.7)."* `my_rules` given in that case is refused with the same words, so nothing is silently dropped.

**Task 7**
- L5: after removing, `written.json` is deleted. A second uninstall finds no record and reports `removed: { skill_folders: [], agent_file: "absent" }`.

**Task 8**
- H2: the INSTALL.md section 9 paragraph does not name Skills Wiki. It says *"(in the install folder, the person's own, and the online skills from section 11 when that is set up)"*. Run `tests/e2e/install-doc.test.ts` with the others.

**Task 9**
- M8: step 5 runs `claude -p "…" --tools "" --output-format json --no-session-persistence` (answer only, no tools) and passes only when the answer gives the **pairing**: `item2` uses `check-word`. The rules word is `OSPREY-6627` (not task 29's word).

**Left as they are (owner's call, outside section 9):** L3, an audit entry when a local skill's text changes after `workflow add`; item 8 (learning) needs `my-rules.md` editable, and section 9 does not ask for pinning local skills. L6: `install-doc.test.ts`'s command-name regex still says `installer`; noted, not changed here (an unrelated pre-existing test).
