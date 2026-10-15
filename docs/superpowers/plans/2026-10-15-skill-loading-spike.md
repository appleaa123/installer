# Skill loading in a restricted task run: the spike (9.12, item 1)

> **For agentic workers:** this plan is a human test on the owner's real Claude Code, not a feature build. There is no code to write until the result is in. Record the result exactly as section "4. What I will do with the output" says, in the same session.

**Goal:** answer, layer by layer, whether Claude Code's own skill loading works inside TaskFollow's scheduled, restricted task run, so that build item 2 (skills reminded, not controlled) knows whether "a run's prompt names the workflow's skills, and the agent loads them itself" is enough, or TaskFollow must put the skill file into the prompt (the D83 fallback).

**Scope measured against:** v1, `docs/scope-refresh.md` 9.5 ("To verify first") and 9.12 item 1; the question was first raised in section 5 ("Task 25 proved that MCP servers do; skills were not checked"). Nothing here adds a requirement: every outcome maps to one of the two paths 9.12 item 2 names, "the agent loads them itself" (which may need the run to offer the agent its own `Skill` tool, a profile flag) or the D83 prompt fallback.

**Spec:** `docs/scope-refresh.md` section 9 (D152). Human task format: `docs/human-tasks.md` tasks 25 and 26. Reviewed by Fable on 2026-10-15 (8 findings, all applied: no `uninstall` in the test home because it deletes the owner's real keychain items; permission held constant across steps; tool calls made visible; the probe's transcript folder listed as a known touch; a deep-subfolder step; more outcome rows; the calls record read back; the helper tolerant of errors).

## Global constraints

- Claude Code 2.1.301 on the owner's Mac, Node 22; the owner runs every command and pastes the output back (9.13 item 3).
- Never paste keys into chat. Every run here is read-only: no store, no mailbox, no tool but the skill itself.
- The owner's real Claude Code is touched in three known ways only, each undone in the plan: one throwaway skill folder under `~/.claude/skills/` (step 8, removed in the same step); the `installer` MCP registration that `taskfollow start` makes at user scope in `~/.claude.json` (step 9, removed in step 10 with `claude mcp remove`); and one transcript folder under `~/.claude/projects/` from the install's probe step (step 9, by design per task 25, removed in step 10). `~/.claude/settings.json` must be byte-identical before and after (checksum in setup and step 10).
- **Never run `taskfollow uninstall` in the test home:** it deletes the keychain items named `installer` for the whole OS user (`src/core/uninstall.ts:84`, `src/core/keychain.ts:8`), which are the owner's real ones from earlier tasks.
- No transcript may be left behind by a task run (task 25, item 5): no folder under `~/.claude/projects/` containing `state-tasks`.
- The spike changes no code. If the result calls for a profile change, that is build item 2's PR.

## 1. Why one yes/no is not enough

A task step (`src/core/agent-task.ts`) runs the agent with the profile's task command (`profiles/claude-code.json`, `task.cmd`):

```
claude -p <prompt> --output-format json --restricted --permission-prompts none --permission-mode manual
       --tools <"" or "Bash"> --allowedTools <may_use + mcp__installer__actions_reason>
       --settings <hooks json> --mcp-config <installer server> --no-session-persistence
```

Four separate layers can each stop a skill from loading, and each one has a different fix. The spike has to tell them apart, so each step changes exactly one thing from the step before it:

| Layer | What the code does today | Where | If this is the blocker, the fix would be |
|---|---|---|---|
| **A. `--tools`** | `builtinTools()` yields `""` (no built-in tools) or `"Bash"`. Claude Code's skills are used through a built-in tool named `Skill`; `--tools ""` may remove it. | `src/core/agent-task.ts:64` | name `Skill` in the profile's `tools` |
| **B. Permission and the hook** | `--permission-prompts none` denies whatever `--allowedTools` does not list, and `Skill` needs permission. Then `decide()` refuses any tool not matched by `may_use`, and `parseMayUse` accepts only `mcp__…` and `Bash(…)` rules, so a `Skill` call is refused even when the tool exists. | `src/core/agent-hook.ts:66-70`, `src/core/workflow.ts:205-220` | allow `Skill(<name>)` for the workflow's named skills in `may_use` and `--allowedTools` |
| **C. The working directory** | A task runs in `<home>/state/tasks/<random>`, deleted afterwards; `home` defaults to `~/.installer` (`src/cli.ts:421`). Claude Code finds project skills in `.claude/skills/` of the start directory and its parents up to the repository root. The START-HERE install folder (`~/Desktop/taskfollow`) is not an ancestor of `~/.installer`, so 9.5's sentence "chat and scheduled runs in that folder both see them" needs `--add-dir <install folder>` or a different cwd. | `src/core/agent-task.ts:93-100`, `START-HERE.md` step 4 | `--add-dir` in the profile's task command, with the path TaskFollow records (9.5, open question 4) |
| **D. `--restricted` itself** | The docs say it "loads only managed settings and `--settings`" and say nothing about skills either way. `--safe-mode` is the flag that disables skills; `--disable-slash-commands` too. Neither is used. | Claude Code docs, `claude --help` | none possible: the D83 prompt fallback |

A fifth path needs no tool at all: the headless docs say "include `/skill-name` in the prompt string and Claude Code expands it before running" (user-invoked skills). If that works under the full flag set, "reminding at run time" can be a prompt prefix.

Two traps the steps are built around:

- **The right word without the skill.** `--restricted` keeps the file tools (Read, Glob, Grep) confined to the working directory, and `SKILL.md` is inside it, so the model can read the file and answer the check word without any skill invocation. Every step therefore prints the tools the model called (`--output-format stream-json`): a pass means the check word *and* a `Skill` call (or no tool call at all, which means the body was loaded without a gated call).
- **Permission as a hidden second cause.** Without `--restricted`, the owner's own settings may hold an allow rule for `Skill`; with it, that rule is gone. So steps 1 to 3 all carry `--allowedTools "Skill(taskfollow-spike)"`, and step 4 is the first to use the product's own list, which has no `Skill`.

What the docs state and what they do not (checked on 2026-10-15 at code.claude.com/docs: skills, cli-reference, tools-reference, headless, permissions, hooks):

- Documented: skill names and descriptions are always in context; the body loads only when the skill is invoked; the tool is `Skill`, rules are `Skill(name)` and `Skill(name *)`; `Skill` needs permission; `--permission-prompts none` denies anything that would prompt; project skills are found walking up from the start directory to the repository root; `--add-dir <dir>` loads that directory's `.claude/skills/`; `--tools ""` disables all built-in tools (and does not affect MCP tools).
- Not documented, so the spike must show it: whether `--tools ""` removes `Skill`; whether `--restricted` drops skill discovery; what `tool_name` a PreToolUse hook sees for a skill; what "repository root" means in a folder that is not a git repository (step 7c).

## 2. Outcomes and what each means for build item 2

A step "passes" when `result` is the check word and the tools line shows a `Skill` call or no call at all (see the first trap above). Prompt B "passes" when `taskfollow-spike` is in the list.

| Result | Meaning for 9.12 item 2, "reminding at run time" |
|---|---|
| Steps 2, 3 and 4 all pass | Skills load inside the restricted, tool-less run with the product's flags. Only the hook (`Skill(<name>)` in `may_use`) and cwd (step 7) need work. No prompt fallback. |
| Steps 2 and 3 pass, 4 fails, 5 passes | Permission only: `Skill(<name>)` goes into `may_use` and `--allowedTools` for the workflow's named skills; the `tools` template stays. No prompt fallback. |
| Step 2 passes, 3 fails, 5 passes | `--tools ""` removes the `Skill` tool. The profile's `tools` template names `Skill` and the hook allows `Skill(<name>)` for named skills. No prompt fallback. |
| Step 2 passes, 3 fails, 5 fails in both forms | The tool cannot be brought back under the product's flags. The D83 fallback: TaskFollow reads the skill file and puts it in the prompt. |
| Step 6 passes while 3 to 5 fail | The `/skill-name` prefix expands without the tool. Reminding at run time is a prompt prefix; the hook never sees a call. |
| Steps 5 and 6 both pass | D153 prefers the tool path (step 5): it is "the agent loads them itself" in 9.12's words, and the hook records the load. |
| Step 2 fails (and step 1 passed) | `--restricted` drops skills. The D83 fallback. |
| Step 1 fails | The test setup is wrong (see the retry in step 1), not the product. |
| Step 7a fails, 7b passes | Confirms layer C: `--add-dir <install folder>` is required in the task command. |
| Step 7c fails while 2 passed | The upward walk does not reach `.claude/skills/` from a deep subfolder outside git; step 9's cwd is such a folder, so `--add-dir` is required even when the home sits under the install folder. |
| Step 8 fails | `~/.claude/skills/` does not reach a run: the inventory may list its names, but run-time reminding for those skills must inline. |
| Step 9 gives the right `word` with no refused `Skill` call | The body loaded without a gated call; the hook never sees skill loads and layer B is moot for skills. |
| Step 9 shows a refused `Skill` call | Confirms layer B from the real command and gives the exact `tool_name` the hook receives. |

Whichever row applies, the fallback is never a change to the agent: a profile flag or `--add-dir` changes TaskFollow's own command, and inlining the skill text into the prompt is still "reminding", not controlling (9.5).

## 3. Human task 29: the test plan (about 40 minutes)

Paste each block into one terminal window and keep that window for the whole task (the `show` helper below lives in it). Each `claude` command prints a few lines: `result:`, `is_error:` and `tools called:` (the tool name and its input for every call the model made, or `none`). After each step, paste back those lines. If anything surprises you, paste its exact wording.

### Setup

```
mkdir -p ~/taskfollow-task29/.claude/skills/taskfollow-spike
cat > ~/taskfollow-task29/.claude/skills/taskfollow-spike/SKILL.md <<'SKILL'
---
name: taskfollow-spike
description: Use when asked for the TaskFollow check word.
---
When asked for the TaskFollow check word, answer with exactly: PELICAN-7342
SKILL
shasum -a 256 ~/.claude/settings.json
ls ~/.claude/projects | grep taskfollow-task29 || echo "no task29 transcripts"
show() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const used=[];for(const line of s.split("\n")){if(!line.trim())continue;let j;try{j=JSON.parse(line)}catch{console.log("raw:",line);continue}if(j.type==="assistant")for(const c of j.message?.content??[])if(c.type==="tool_use")used.push(c.name+" "+JSON.stringify(c.input));if(j.type==="result"){console.log("result:",j.result);console.log("is_error:",j.is_error)}}console.log("tools called:",used.length?used.join(" | "):"none")})'; }
cd ~/taskfollow-task29
```

Paste back: the checksum line and the transcripts line (expected: `no task29 transcripts`). They are compared in step 10.

Two prompts are used throughout:

- **A** (the body): `What is the TaskFollow check word? Answer with the word only.`
- **B** (the listing): `List the names of the skills you can see, comma-separated, nothing else.`

### Step 1: baseline, no restriction

```
claude -p "What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" | show
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" | show
```

Expect: A gives `PELICAN-7342` with a `Skill` call in the tools line; B includes `taskfollow-spike`. Paste back both results and both tools lines.

If A fails but B lists the skill, run A once more as `Use the taskfollow-spike skill. What is the TaskFollow check word? Answer with the word only.` and paste that result too: it tells whether the model saw the skill but did not choose it. **If that retry was needed, use the same "Use the taskfollow-spike skill." wording for prompt A in every later step**, so that later failures are not the model's choice. If B does not list it, look at whether the list seems cut off (you have about twenty skills of your own, and the listing the model sees is truncated at 1,536 characters): rerun B with `--setting-sources project,local` added, which leaves your user-level skills out. If `taskfollow-spike` appears then, the setup is fine and the truncation goes into D153 (item 2's inventory must allow for it). If it still does not appear, stop and tell Claude: the setup is wrong, not the product.

### Step 2: `--restricted` added (layer D)

```
claude -p "What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted | show
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted | show
```

Paste back both results and tools lines.

### Step 3: `--tools ""` added (layer A)

```
claude -p "What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted --tools "" | show
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted --tools "" | show
```

Paste back both results and tools lines.

### Step 4: the product's own permission flags, without the hook (layer B, permission half)

This is the profile's command with the product's `--allowedTools` list (no `Skill` in it), an empty settings object instead of the hook, and no MCP config.

```
claude -p "What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --restricted --permission-prompts none --permission-mode manual --tools "" --allowedTools "mcp__installer__actions_reason" --settings '{}' | show
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --restricted --permission-prompts none --permission-mode manual --tools "" --allowedTools "mcp__installer__actions_reason" --settings '{}' | show
```

Paste back both results, `is_error` and tools lines.

### Step 5: the same, with the `Skill` tool named and allowed (the possible profile fix)

```
claude -p "What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --restricted --permission-prompts none --permission-mode manual --tools "Skill" --allowedTools "Skill(taskfollow-spike),mcp__installer__actions_reason" --settings '{}' | show
```

Paste back `result`, `is_error` and the tools line. If it fails, run it once more with `--allowedTools "Skill,mcp__installer__actions_reason"` (the bare name) and paste that too.

### Step 6: the `/skill-name` prefix under the step 4 flags (the prompt path)

```
claude -p "/taskfollow-spike What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --restricted --permission-prompts none --permission-mode manual --tools "" --allowedTools "mcp__installer__actions_reason" --settings '{}' | show
```

Paste back `result`, `is_error` and the tools line.

### Step 7: from other folders (layer C)

7a, from a fresh empty folder with no skill above it:

```
mkdir -p ~/taskfollow-task29-elsewhere && cd ~/taskfollow-task29-elsewhere
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted | show
```

7b, the same folder with `--add-dir` pointing at the skill's folder:

```
claude -p "What is the TaskFollow check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted --add-dir ~/taskfollow-task29 | show
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted --add-dir ~/taskfollow-task29 | show
```

7c, from a deep subfolder of the skill's folder, which is not a git repository (step 9's task folder is like this):

```
mkdir -p ~/taskfollow-task29/deep/a/b/c && cd ~/taskfollow-task29/deep/a/b/c
claude -p "List the names of the skills you can see, comma-separated, nothing else." --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill(taskfollow-spike)" --restricted | show
cd ~/taskfollow-task29
```

Expect 7a: no `taskfollow-spike` in the list. Paste back all four results and tools lines.

### Step 8: a user-level skill (`~/.claude/skills/`), created and removed in this step

```
mkdir -p ~/.claude/skills/taskfollow-spike-user
cat > ~/.claude/skills/taskfollow-spike-user/SKILL.md <<'SKILL'
---
name: taskfollow-spike-user
description: Use when asked for the TaskFollow user check word.
---
When asked for the TaskFollow user check word, answer with exactly: HERON-5189
SKILL
claude -p "What is the TaskFollow user check word? Answer with the word only." --output-format stream-json --verbose --no-session-persistence --restricted --permission-prompts none --permission-mode manual --tools "" --allowedTools "mcp__installer__actions_reason" --settings '{}' | show
rm -r ~/.claude/skills/taskfollow-spike-user
ls ~/.claude/skills | grep taskfollow-spike-user || echo removed
```

Paste back `result`, `is_error`, the tools line and the last line (`removed`).

### Step 9: one real task step through TaskFollow (`taskfollow run`, then `why`)

The TaskFollow home goes under the skill's folder on purpose, so the task's working directory (`home/state/tasks/<random>`) has the skill folder above it and the hook is the only new layer (step 7c says whether the walk reaches it). This is not the real layout: 9.5 puts workflow skills in the START-HERE folder (`~/Desktop/taskfollow/.claude/skills/`) while the home defaults to `~/.installer`, which is step 7a's situation, so a scheduled run in real life also needs step 7b's `--add-dir` (or a cwd under the install folder) if 7a fails. `start` creates the home itself (do not create it by hand: it must be private), runs the install's probe (which saves the agent and leaves one transcript folder, task 25; the standalone `probe` does not save the agent) and registers the `installer` MCP server with your real Claude Code at user scope; step 10 removes both.

```
cd ~/Desktop/ML-Project/installer && npm run build
node dist/cli.js --home ~/taskfollow-task29/home start --solution starter
node dist/cli.js --home ~/taskfollow-task29/home workflow add spike --value '{"description":"spike: does the agent load a skill in a task run","trigger":{"manual":true},"steps":[{"id":"word","task":{"prompt":"What is the TaskFollow check word? If you can see a skill about it, use it. Answer with the word only.","input":{},"may_use":["mcp__none"],"output":{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}}}]}'
node dist/cli.js --home ~/taskfollow-task29/home run spike --sandbox
```

`run` prints JSON; the run id is the `"run_id"` value in it (it looks like `2026-10-16-1a2b3c4d`). Then, with that id in place of `<run id>`:

```
node dist/cli.js --home ~/taskfollow-task29/home why <run id>
cat ~/taskfollow-task29/home/runs/spike/<run id>/steps/word.json
cat ~/taskfollow-task29/home/runs/spike/<run id>/word.calls.jsonl
```

Paste back the `run` output, the `why` output, `word.json` and `word.calls.jsonl`. What matters: the `word` in the output; whether a call was refused and, if so, the `tool` name the hook received (expected `Skill`, by the hook's rule at `src/core/agent-hook.ts:69`; the calls file holds the raw name, `why` shows it as `refused …`).

If `workflow add` refuses the `may_use` rule, paste the refusal: the plan assumed `mcp__none` passes the rule check (`src/core/workflow.ts:205`).

### Step 10: clean up and check that nothing of yours changed

Do not run `taskfollow uninstall` here (see the constraints: it deletes your real keychain items). `claude mcp list` connects to every server and can take several seconds.

```
claude mcp remove -s user installer
claude mcp list
shasum -a 256 ~/.claude/settings.json
ls ~/.claude/projects | grep taskfollow-task29
ls ~/.claude/skills | grep taskfollow-spike || echo "no spike skill left"
rm -r ~/.claude/projects/*taskfollow-task29*
rm -r ~/taskfollow-task29 ~/taskfollow-task29-elsewhere
ls ~/.claude/projects | grep taskfollow-task29 || echo "transcripts removed"
```

Paste back: the `mcp list` output (no `installer` or `taskfollow` entry expected), the checksum (must equal the setup's), the `projects` line before removal (expected: one entry ending `-home-runtime-probe`, the probe's; other `taskfollow-task29` entries are just removed and reported; the only failure is an entry containing `state-tasks`, which means a task run saved a transcript, and it must not), the skill line, and the last line (`transcripts removed`).

## 4. What I will do with the output

1. Fill the outcome table (section 2) row by row; name the blocking layer(s).
2. Record D153 in `DECISIONS.md`: the question, each layer's result with the step that showed it, and the decision for item 2 (the profile change and hook rule, the `/skill-name` prefix, or the D83 inline fallback). Note for item 7 (gap flagging): the check-word skill is a ready-made harmless test for the need section 6 lists as "this skill loads in an unattended run".
3. Add the task 29 line to the Done section of `docs/human-tasks.md`, in the style of tasks 25 and 26 (what passed, what was seen, anything fixed).
4. Update `docs/next-steps.md` with the result and the next item (item 2). The full rewrite of `docs/next-steps.md` from section 9 waits for 9.13 item 2 ("once the current scope is finished", after #40 is merged) and goes in its own docs PR.
5. One PR, docs only, branch `docs/skill-loading-spike`, with this plan, D153, the task 29 line and the next-steps update. Ask before merging.

## 5. Review focus

Checked in the Fable review of 2026-10-15; kept here so a later reader sees what the steps guard:

1. Each step changes one thing from the step before it: 1→2 `--restricted`, 2→3 `--tools ""`, 3→4 the product's permission list, 4→5 `Skill` named and allowed, 4→6 the prompt prefix. The hook's half of layer B is seen only in step 9.
2. `mcp__none` passes `MCP_RULE`, is not `mcp__installer…`, and matches nothing, so the hook refuses every call except the reason tool and `StructuredOutput`.
3. Step 9's `start` registers an MCP server at user scope in `~/.claude.json` and the probe saves one transcript folder; step 10 removes both by hand, never with `uninstall`.
4. A check-word answer is read together with the tools line, because the file tools can read `SKILL.md` without a skill invocation.
5. The `/skill-name` prefix in step 6 sits at the start of the prompt string, where `-p` expands it; `taskPrompt()` puts the step's prompt first, so the same works in a task step.
