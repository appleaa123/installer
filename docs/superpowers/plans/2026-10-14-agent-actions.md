# Plan: the agent's own tools, recorded and explained (D136–D139, build items 1–2)

Status: revised after Fable's review (2026-10-14). Each slice test-first; fakes only; never the real `~/.claude`.

## What exists

- Audit: `audit/audit.jsonl`, hash-chained and locked; it stores a fingerprint of each payload, not the payload.
  Every append reads the whole file under a lock, so it is not a place for one line per agent tool call.
- Runs keep step logs. Step kinds: `tool`, `judge`, `approve` (bound to one exact TaskFollow tool call by hash),
  `agent` (the model picks TaskFollow tools). The headless agent runs with every tool off.
- Claude Code 2.1.300 (checked with `claude --help`): `--settings`, `--allowedTools`, `--restricted` (ignores the
  person's user/project/local settings, removes the built-in tools that run commands unless `--tools` names them,
  refuses bypassPermissions; managed settings and `--settings` still apply), `--permission-prompts none` (anything
  that would prompt is denied), `--no-session-persistence`, `--bare` (skips hooks: never used).
- Shopify CLI 4.9.4 on this machine: no `order` command; reads and writes both go through
  `shopify store execute -s <domain> -q <graphql>` (writes need `--allow-mutations` or `SHOPIFY_FLAG_ALLOW_MUTATIONS`).

## Choices (changed by the review)

1. **The record is its own file, sealed into the audit.** The hook appends one JSON line per call to the run's
   record (`runs/<workflow>/<run>/<step>.calls.jsonl`, single `O_APPEND` writes, no lock). When the step ends, the
   runner adds one audit entry `{file, from_line, to_line, sha256}`, so the record is tamper-evident from then on.
   Each line: time, Claude session id, tool, input summary (200 characters, secret-looking values masked), outcome,
   duration, and for `mcp__installer__actions_reason` the stated reason. TaskFollow's own MCP tools are not recorded
   there (the gate already audits them), except `actions_reason`.
2. **The hook is the gate in runs TaskFollow starts, and fails closed.** Task command:
   `claude -p <prompt> --output-format json --restricted --permission-prompts none --tools <"" or Bash>
   --allowedTools <may_use joined by commas> --settings <hook json> --json-schema <output> --no-session-persistence`.
   The `PreToolUse` hook denies anything outside `may_use` (a deny beats every allow) and denies Bash commands with
   shell operators (`;`, `&&`, `||`, `|`, `$(`, backticks, redirection), `--allow-mutations`, or the mutation env var,
   unless the step allows changes. Any internal error in a run's hook blocks the call (exit 2). The hook has a 5 s
   timeout. The run gets a minimal environment (no dev keys) and a private working folder under the home, never the
   person's project folder.
3. **Read-only by construction.** A lookup step lists read tools only (MCP `get`/`list` tools; or Bash
   `shopify store execute` with the hook refusing mutations). Steps that change things are separate steps that list
   write tools explicitly.
4. **The agent's reason** is the `mcp__installer__actions_reason {tool, why}` call itself: the MCP tool only
   acknowledges; the hook records it; `why` pairs a reason with the next call of that tool in the same session.
5. **Sending stays bound to the approval.** The Shopify support flow is task (look up, read-only) → judge (draft) →
   approve (exact `channel.send`) → send. An approve step without a tool (for "publish what the agent drafted") is
   deferred: approving shown text is not the same as approving the call the agent later makes, and needs its own design.
6. **Safety in odd cases.** A dry run or sandbox run never runs a `task` step (it could act on the real store); it
   shows what would be asked. A task step that started but did not finish (crash) is not re-run on resume: the run
   stops with `needs_human`, because it may already have acted. `timeout_minutes` reaches the process (default 10).
   Transcripts are not saved (`--no-session-persistence`), because they would hold customer mail.
7. **`taskfollow why`** (CLI only for now): a deterministic timeline from the audit, run logs, record files and
   approvals: time, who (TaskFollow / the agent inside a run), what, why (the reason, or "the agent gave no reason";
   the approval id and who approved). Filters `--run`, `--since`. The person's agent can run it and explain.
8. **Profiles.** Claude Code gets a `task` command template (new placeholders: `may_use`, `settings_json`,
   `tools`). Profiles without one (Codex for now) cannot add a workflow with a `task` step: plain refusal.
9. **Fake agent** learns `--settings` hooks (runs them around each scripted call with Claude Code's stdin shape and
   honours deny/exit 2), `--allowedTools`, `--restricted`. Real Claude Code is checked by hand (human task 25).

## Slices

1. Hook command `taskfollow hook pre|post|failed --record <file> --may-use <list>`: records; gate decisions;
   Bash rules; fail closed; masking; summary limit; reason lines.
2. Profile `task` template + `runTask` (argv, minimal env, private cwd, timeout, settings JSON with the hook).
3. Fake agent support.
4. Step kind `task` in workflows (parse, `may_use` required, output schema), runner (record sealing, crash →
   needs_human, dry run/sandbox skip), refusal for profiles without `task`.
5. `taskfollow why`.
6. End to end with the fake agent and a fake `shopify` command: email in → task lookup → judge draft → approve →
   send; `why --run` shows the lookup, its reason and the approval.
7. Docs: INSTALL.md, D142, human task 25 (real Claude Code: `--settings` hook fires under `--restricted`; user
   allow rules are ignored; a denial's reason reaches the agent; MCP wildcard syntax in `--allowedTools`; a claude.ai
   remote connector works in `-p` from the scheduler; your Shopify CLI with `--no-input`).

## Deferred (in order, after this)

- Email: HTML-only mail and replying in the thread (D141 item 3; needed before a real support test).
- The opt-in hook in the person's own Claude Code settings, with the list of watched services, consent, uninstall,
  and `doctor` checks: this is what records the agent calling Shopify directly outside TaskFollow. It is the
  privacy-sensitive half, so it gets its own slice and consent wording.
- Approve-without-tool for publish-through-agent; `why` as an MCP tool; unofficial-service records (D136 override).
- Codex task steps, after checking its hook and allow-list flags.

## Prerequisites a person does once (go into the starter)

- Shopify CLI signed in to the store: `shopify store auth -s <domain> --scopes read_orders,read_customers`
  (browser), or the Shopify MCP connector signed in. Tool names are discovered at setup, never assumed.
