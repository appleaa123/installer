# Plan: task steps, watching and always-ask for Codex (postponed item 1)

Status: **postponed** (2026-10-15, D150). The owner has no Codex account, so this cannot be proven in real use. Reviewed by Fable;
the findings are at the end and must be applied before building. Built from this plan already: the masking fix (§0, done
differently from the review's suggestion, which would have unmasked `api_key`), the 30 s gate timeout (finding 3) and
`watch` refusing for agents other than Claude Code (§2, first paragraph).

## What the research found (2026-10-15)
Codex CLI 0.162.1 was installed in a scratch folder only and run against a mock model server, with `CODEX_HOME`
pointed at a scratch folder. Gemini CLI 0.64.0 was tested the same way. Cursor, opencode and Copilot were researched
from their documentation and source only.

Codex facts this plan relies on:
- **Hooks.** `PreToolUse` and `PostToolUse` are stable since 0.124 and run in `codex exec` since 0.141.
  - The JSON on stdin has the same fields our hook already reads: `session_id`, `tool_name`, `tool_input`.
  - Deny output is the same as Claude Code's: `hookSpecificOutput.permissionDecision: "deny"`, or exit 2 with the
    reason on stderr.
- **Tool names match Claude Code's.**
  - MCP tools are `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_]` turned into `_`, so ours is
    `mcp__installer__actions_reason`.
  - Shell is `tool_name: "Bash"` with `tool_input.command` as one string.
  - `apply_patch` and web search are separate tools.
- **Hooks fail open.** A timeout, a crash, or exit 2 with an empty stderr all let the call go ahead. There is no
  failure event and no duration. `PostToolUse` does not fire for a blocked call.
- **Per-run settings.** `-c key=<TOML value>` takes arrays and inline tables. Hooks added this way are **skipped
  silently** unless they are trusted. They can be trusted either with `--dangerously-bypass-hook-trust` (0.131+;
  this also runs the person's own not-yet-trusted hooks) or with a precomputed trust hash (not documented, and its
  format depends on the version).
- **Approvals in `exec`.** `exec` always uses `approval_policy=never`.
  - An MCP call that needs approval is **denied**, unless the tool says it only reads (`readOnlyHint`) or the server
    or tool is set to `approval_mode="approve"`.
  - A shell command runs inside the sandbox (`-s read-only|workspace-write`).
  - A `prompt` rule in the person's own rules files becomes a denial.
  - `--disable shell_tool` removes the shell; `-c web_search="disabled"` removes web search.
- **Other flags.** `--ephemeral` saves no session. `--output-schema <file>` already works for us.
- **The person's own Codex settings.** `~/.codex/hooks.json` holds hooks as JSON. A new hook there does nothing
  until the person trusts it in Codex (`/hooks`).
  - Always-ask for commands: `~/.codex/rules/<file>.rules` with `prefix_rule(pattern=[...], decision="prompt")`.
  - Always-ask for MCP tools: `[mcp_servers.<s>.tools.<t>] approval_mode="prompt"` in `config.toml` (TOML).
- **One trap.** A research run without `HOME` isolated created `~/.codex/tmp/arg0`. Every Codex run in tests must
  set both `HOME` and `CODEX_HOME` to a temporary folder.

Other agents, summarised:
- **Gemini CLI.** Hooks fail open. A hook that answers "ask" hangs in headless mode. There is no schema output, and
  the settings files are trust-gated.
- **opencode.** Hooks are JS plugins; a rejected ask stops the whole loop.
- **Cursor and Copilot.** It is not verified that hooks fire in headless mode, and there is no per-run hook option.

**Decision:** this slice covers Codex only. The others have no profile today. For them the features stay off, with
a plain message, as now; the reasons are recorded in a D-entry so the research is not repeated.

## Design

### 0. Task 25 finding (small, first)
The masking in `summarize` hides harmless values such as `sortKey: CREATED_AT`.
- **Fix:** mask after a secret-like name only when the value looks like a secret: 16 or more characters with a
  digit, or a known prefix.
- **Test:** `sortKey: CREATED_AT` is kept; `api_key: abcd1234efgh5678` and `shpat_…` are still masked.

### 1. Task steps on Codex
**What stays the same.** The hook program (`taskfollow agent-hook pre|post`) and its rules (`decide`) do not change.
The stdin fields, tool names and deny output are the same as Claude Code's.

**The profile gets a `task` command:**
```
codex exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-hook-trust
  --sandbox {sandbox} --{shell_switch} shell_tool -c web_search="disabled"
  -c {hooks_toml} -c {mcp_toml} {prompt}
```
plus `--output-schema` as today. New placeholders: `{sandbox}`, `{shell_switch}`, `{hooks_toml}`, `{mcp_toml}`.
Each fills exactly one argv token, which keeps the "profiles are data" rule (D34).

**`{hooks_toml}`** is `hooks={SessionStart=[…],PreToolUse=[…],PostToolUse=[…]}` with `matcher="*"` and a 5 s
timeout.
- It is written by a tiny TOML value writer: strings, arrays and inline tables only; about 20 lines, no new
  dependency.
- **SessionStart** runs `agent-hook start <config>`, which writes a `gate-active` marker into the task folder.

**`{mcp_toml}`** is `mcp_servers.installer={command=…,args=[…],env={…},default_tools_approval_mode="approve"}`.
- Only TaskFollow's own server is approved by this setting.
- The person's servers keep Codex's default under `exec`: a write tool is denied unless the person set it to
  approve. That is an independent limit underneath the hook.

**Sandbox.** `{sandbox}` is `read-only` when `changes` is false and `workspace-write` when true.
- Network: Shopify CLI calls need the network. If Codex's sandbox blocks it, the step adds
  `-c sandbox_workspace_write.network_access=true`, and read-only steps use `workspace-write` in the private task
  folder.
- Which of these is needed is checked on the real binary (verification below) before it is fixed in the profile.

**Shell.** `{shell_switch}` is `disable` when `may_use` has no `Bash(...)` rule, else `enable`. With no command
listed, there is no shell at all, whatever the hook does.

**Why the bypass flag and not a trust hash.**
- The hash format is undocumented and changes between versions; a wrong hash means the gate is skipped silently.
- The flag is documented. What it also does (runs the person's own untrusted hooks) runs only their code, in their
  own account.
- Either way, the marker check below catches a gate that did not load.

**Proving the gate was active (the hooks fail open):**
- **(a) Before the first task with a given Codex version.** A check run with the same command and a tiny prompt
  ("Reply with exactly: ok"), no tools.
  - It passes only if the `gate-active` marker appears.
  - The result is cached in state by Codex version (`runtime.task_gate: {version, ok, at}`).
  - A task step on a version not checked, or one that failed, fails in plain words, before anything runs.
- **(b) After every task run.** No marker means the step fails with "TaskFollow could not confirm its checks were
  running; what the agent did may not be in the record" and an audit entry (`run.task_gate_missing`). The run stops
  for a person, as a crash does today.

**Record differences.**
- No failure event: a `pre` with no matching `post` is shown by `why` as "started, no result recorded".
- No `ms`: the field is already optional.
- So that `pre` and `post` can be paired, the hook records `pre` for allowed calls too, on Codex only. The hook
  config gets `record_pre: true`.

**Matching `may_use`.** Codex turns `get-shop-info` into `get_shop_info`. On a Codex profile, both the rule and the
tool name are compared with characters outside `[A-Za-z0-9_*]` turned into `_` (hook config `normalize: true`). A
workflow written for Claude Code then also works on Codex.

**The person's always-ask rules.** Codex turns them into denials inside tasks; this is kept on purpose (fail safe,
unlike Claude Code's `--restricted`). The report says so.

**Version.** The task needs Codex 0.141 or later (`task.min_version`). The profile's `min_version` for plain
headless calls stays as it is.

### 2. Watching on Codex
**Today** `watch` always edits `~/.claude/settings.json`, which is wrong for a Codex user. The profile gains
`"personal": "claude" | "codex"`. A profile without it means watching and always-ask are not available, said in
plain words.

**For Codex:**
- `watch on` adds one `PostToolUse` group to `~/.codex/hooks.json` (JSON), using the same safe edit as D146: copy
  first, plain JSON only, no lost update. Tests use `INSTALLER_CODEX_HOOKS`, set in the vitest config.
- The matcher is the same as Claude Code's (`watchMatcher`); the tool names match.
- `watch on` then tells the person: "Open Codex, type /hooks and trust TaskFollow's hook; until then nothing is
  recorded." TaskFollow never writes the trust hash itself: the person's review is the consent.
- `doctor` cannot see the trust state without parsing TOML. It says: "if `why direct` stays empty after you used a
  watched service, trust the hook in /hooks".

**No double records.** Task runs pass `--dangerously-bypass-hook-trust`, which would also run the watch hook.
- Task runs set `TASKFOLLOW_TASK=1` in their environment, and `watch-hook.js` exits at once when it is set.
- Whether Codex passes its environment on to hooks is checked on the real binary. If it does not, the watch hook
  instead skips sessions whose `cwd` is under `state/tasks/`.

**Reasons in the person's own sessions.** TaskFollow's reason tool is not registered with Codex (the profile has no
`mcp_register`). Direct calls show "the agent gave no reason". Registering it is out of scope; it is stated in the
report.

### 3. Always-ask on Codex
- **Commands (`Bash(<cmd>:*)` / `Bash(<exact>)`).** TaskFollow owns one file, `~/.codex/rules/taskfollow.rules`
  (tests: `INSTALLER_CODEX_RULES`). It is regenerated from `config/watch.json` `ask` as one
  `prefix_rule(pattern=[…words…], decision="prompt", justification="TaskFollow always-ask")` per rule. Removing the
  last rule deletes the file. The person's own rules files are never touched.
- **MCP tools.** These need a table in `config.toml`. Merging TOML text safely without a parser risks a duplicate
  table, which would break Codex, so `watch ask mcp__…` on Codex refuses in plain words and prints the two lines the
  person can add themselves. Recorded as a limit.
- **Rule format.** The pattern words come from splitting the rule's command on spaces. Words are written as Starlark
  strings, escaping `\` and `"`. A word with a quote or a new line is refused.
- **Uninstall.** Removes the rules file and the hooks entry.

### Where code goes
| File | Change |
|---|---|
| `profile.ts` | New placeholders, `task.min_version`, `personal` |
| `agent-task.ts` | Builds the per-agent parts. A `codex-task.ts` holds the TOML writer, the Codex part builder and the marker check, to keep files small |
| `agent-hook.ts` | `start` phase, `record_pre`, `normalize` |
| `watch.ts` | Picks the settings target by profile; Codex hooks file and rules file in a `watch-codex.ts` |
| `why.ts` | "started, no result recorded" |
| `profiles/codex.json` | `task`, `personal` |

## Testing
- **Unit tests:**
  - the TOML writer (escaping, nesting);
  - the argv for Codex with and without Bash, changes true and false;
  - normalize matching;
  - `record_pre`;
  - the marker check (missing marker → failure + audit; the version cache);
  - the watch target by profile;
  - hooks.json edits (kept entries, copy, non-JSON refused);
  - rules file generation and escaping;
  - MCP ask refused on Codex;
  - uninstall.
- **Fake agent:** `fake-codex.mjs` learns `-c hooks=…` well enough to run the SessionStart, PreToolUse and
  PostToolUse commands around one scripted tool call (`FAKE_AGENT_SCRIPT`). The task-step e2e tests then run the
  real `agent-hook` through it, as they do for the fake Claude: allowed, denied, joined command, marker present and
  missing.
- **Real Codex binary, opt-in (`CODEX_BIN` set, else skipped):**
  - Runs the real Codex against a mock Responses API server (a separate process). `HOME` and `CODEX_HOME` point to
    a temporary folder; there is no OpenAI login.
  - It proves on the real binary: hooks load through `-c` with the bypass flag (marker written); a denied
    `Bash(...)` call is blocked and recorded; an MCP tool not in `may_use` is blocked; `--disable shell_tool` works;
    our server's tool runs with approve.
  - It also settles three open questions: whether the environment reaches hooks; the sandbox network setting; the
    exact `--output-schema` result.
  - Before and after: `~/.codex` is not created or changed, and `~/.claude` is clean.
- **Real-world check (new human task 28):** install Codex, sign in, run one read-only Shopify task step (as task 25
  did), then `watch on` plus trust in `/hooks`, then one always-ask command rule. Task 15 (certify Codex) comes
  first.

## Slices (each test-first, small commits)
1. Masking fix (task 25 finding).
2. Profile placeholders, the TOML writer, the Codex task argv. `agent-hook` gains `start`, `record_pre` and
   `normalize`. The fake Codex runs hooks.
3. The gate marker check (a + b), `why` "no result recorded", `task.min_version`.
4. The opt-in real-binary test; fix the profile from what it shows.
5. Watch by profile, with the Codex hooks file.
6. Always-ask with the Codex rules file.
7. Docs: INSTALL.md agent notes, a D-entry (D150: Codex support, and why the other agents are off), human task
   28, next-steps.

## Open questions for review
1. Bypass flag versus trust hash: is the marker check enough to accept the flag's side effect (it runs the person's
   own untrusted hooks during tasks)?
2. Should read-only steps use the `read-only` sandbox if that blocks the network (Shopify CLI), or `workspace-write`
   in the private folder?
3. Refusing MCP always-ask on Codex, rather than editing `config.toml`: is that acceptable for v1?
4. Is normalising `may_use` across agents wise, or should a workflow be bound to the agent it was written for?

## Fable's review (2026-10-15), to apply when this is picked up
Checked against the Codex source at `rust-v0.162.1`.

Confirmed:
- `exec_command` reaches the hook as `Bash` with `{command}`.
- A parse error in the `-c hooks=` table drops all of that layer's hooks together.
- `--output-schema` is not a tool, so there is no `StructuredOutput` trap on Codex.
- `-c` values win over the person's own config.

Blockers:
1. **Automatic review in the person's config.** A person who set `approvals_reviewer = "auto_review"` makes `exec`
   rebuild its config without `approval_policy=never`, so a model answers the approvals the plan counts on being
   denied. Pin `-c approvals_reviewer="user"`, and say that with approve-mode servers the hook is the only gate.
2. **`write_stdin` is not hooked** (`write_stdin.rs`) and cannot be turned off. Once a command is allowed, stdin to it
   is unrecorded. On Codex, refuse `Bash(...)` rules whose first word is a shell or an interpreter (bash, sh, zsh,
   node, python, ssh, …).
3. **Hook timeout.** A hook that times out lets the call go ahead. Hooks run as `$SHELL -lc` (login shell plus a cold
   Node start). Use 30 s or more. (Done for Claude Code.)
4. **Prove the gate per run from `--json` items.** Every `command_execution`, `mcp_tool_call`, `file_change` or
   `collab_tool_call` item must have a hook line (with `record_pre`); more items than lines means the gate was not
   running. Make the once-per-version check a real deny test: `may_use: ["Bash(echo:*)"]`; run `echo <nonce>` and
   `uname`; pass only if `echo` is ok, `uname` is refused and the answer has the nonce. The SessionStart marker is a
   weak extra, and SessionStart in `exec` is untested.
5. **`taskEnv` drops `CODEX_HOME`.** Keep `CODEX_HOME`, and `CODEX_API_KEY`/`OPENAI_API_KEY` for API-key sign-in.

Should fix:
6. Pin `-c features.hooks=true` and `-c features.multi_agent=false`, and add `--disable view_image`. If the gate check
   fails, name `allow_managed_hooks_only` as a possible cause.
7. Always allow `update_plan` (beside `StructuredOutput`) and do not record it. `tool_search` is not hooked: it acts on
   nothing, but MCP tools are reached only through it, so check that it works under `exec`.
8. **Sandbox by "a Bash rule is listed", not by `changes`** (the sandbox limits files and network, not the service).
   - Bash rule: `workspace-write` plus `sandbox_workspace_write.network_access=true`, and maybe a writable root for
     the CLI's config folder.
   - MCP only: `read-only`.
   - Never `danger-full-access`.
9. Avoid double records by `cwd` under `state/tasks/` in `watch-hook.js`, not by an environment variable.
10. A changed matcher must be trusted again: print the `/hooks` line on `watch add`, `remove` and `on`. Uninstall
    leaves a harmless stale `hooks.state` entry in `config.toml`.
11. Apply the same name normalising in `watchMatcher` and `thinLine` (Codex also renames servers:
    `shopify-dev` → `shopify_dev`).
12. Pair `pre` and `post` by `tool_use_id` (record it as `call`). On Codex, `ms` then comes from the two timestamps.
13. Be honest about always-ask on Codex:
    - `prefix_rule` does not fire for commands with redirection, `$(…)` or variables.
    - With `auto_review`, a model answers instead of the person.
    - An ask rule turns matching commands into denials inside tasks.
    - Codex must be restarted.
14. Masking (done another way; see Status).
15. Slice order: run the real-binary spike first, before slices 2–3. Also check:
    - SessionStart fires in `exec`;
    - the `hooks.json` shape loads, and is skipped while untrusted;
    - MCP tools are reachable through `tool_search`;
    - `update_plan` is present;
    - the `--json` item counts.

    Set `required=true` on the `installer` MCP server.

Minor:
16. Prove that the TOML writer's output round-trips, including `\` and `"`.
17. Say that the person's own Codex hooks run during tasks.
18. The fake Codex can pull the hook commands out with a regex; it needs no TOML parser.
19. `default_tools_approval_mode` and `approvals_reviewer` have no version dates; the gate check covers them.
20. On Codex, the record, not the hook, is the guarantee (D137).

Answers to the open questions:
1. Use the bypass flag, but only together with findings 1, 4 and 9.
2. Choose the sandbox by whether a Bash rule is listed.
3. Refusing MCP always-ask on Codex is right for v1.
4. Normalise on Codex only, for MCP rules only, and document the near-twin collision.

Not built for the other agents (D150):
- **Gemini CLI.** Hooks fail open, a hook answering "ask" hangs in headless mode, there is no schema output, and
  settings are trust-gated (`GEMINI_CLI_TRUST_WORKSPACE`).
- **opencode.** JS plugins; a rejected ask stops the whole loop.
- **Cursor and Copilot.** It is unverified whether hooks fire in headless mode, and there is no per-run hook option.
