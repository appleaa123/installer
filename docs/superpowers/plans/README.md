# Implementation Roadmap

The spec ([`../specs/2026-10-06-installer-design.md`](../specs/2026-10-06-installer-design.md))
covers several subsystems. It is delivered as **ten plans**, each producing
working, tested software on its own. Plans are written one at a time: a
plan is detailed only after the previous one has shipped, because later
plans build on the earlier plans' real signatures.

Language: TypeScript on Node ≥ 22 (D44).

| # | Plan | Deliverable | Depends on | Spec sections | Open items it resolves | Status |
|---|---|---|---|---|---|---|
| 1 | **Engine core** | `installer start / next / submit / verify / resume / report` driven by a scripted operator against a fixture solution; atomic resumable state; hash-chained audit; kill-between-steps and idempotency tests | — | §6.3–6.6, §11.8 (audit chain), §15.1 (engine tests), §15.2 (scripted operator) | — | [Implemented](2026-10-06-01-engine-core.md) on `feat/engine-core` |
| 2 | **Runtime conformance** | Runtime profiles as JSON, `installer probe` (C2, C4, C4 schema, C5) with a capability map in the state and report, `https:` solution refs with `recipe_version`, MODE phase (mode + decision maker), per-runtime hints on `agent_action`, `INSTALL.md`, starter solution (D46) | 1 | §5, §6.1–6.3, §7 | — | [Implemented](2026-10-08-02-runtime-conformance.md) on `feat/runtime-conformance` |
| 3 | **Secrets + BRAIN phase** | Non-blocking local browser page for `secret` (D47), keychain module with macOS / Linux / file backends (D51), `installer secret`, `mcp-headers` and `disconnect`, engine-run MCP registration with a headers helper (D52), hand-rolled MCP client and `skillswiki:` refs (D55), combo `human_action` verified via `get_active_combo` (D37), C6 probe in the agent's folder (D54), auto-action failure path (D53), starter solution with BRAIN steps, opt-in live tests (D48) | 1, 2 | §6.1–6.3, §7.2–7.3 C6, §8.3, §13, §14.2 | O3 (mostly), O6, O7, O8, O10 (deferred) | [Implemented](2026-10-08-03-secrets-brain.md) on `feat/brain-secrets` |
| 4 | **Local MCP server + approvals** | Local stdio MCP server `installer mcp-serve` registered by `preflight.tools` (D56), `installer tool` CLI fallback, approval items as files and a locked audit (D57), action-hash tokens (D58), level derivation with the compiled floor (D59), roles (D60), decisions approve / edit / reject from the person's terminal (D61) and lazy expiry (D62), `memo.*` + `approvals.*` tools (D63) | 1–3 | §7.4, §11.1–11.6, §11.9 | — | [Implemented](2026-10-08-04-approvals.md) on `feat/approvals` |
| 5 | **Connectors + data layer** | Data contract and field tags feeding levels (D64), pinned + checksummed connector packages (D65), Google sign-in with the client's own OAuth client via `installer secret google` (D66), Google Sheets adapter on Sheets API v4 (D67), `installer connect` / `installer map` for the DATA phase (D68), default sheet creation (Microsoft Excel deferred, D69), `records.find / get / create / update` with optimistic concurrency (D70), import with change preview (D71), `installer disconnect google-sheets` | 3, 4 | §8.1–8.2, §9, §14.2 (supply chain) | O3 (OAuth half) | [Implemented](2026-10-08-05-connectors-data.md) on `feat/connectors-data` |
| 6 | **Gateway + channels** | Always-on gateway, channel connector interface, Telegram + email connectors, inbound envelope, injection marking, sender identity via `invite`, reply codes, opt-out, consent policy | 3, 4, 5 | §12, §11.9 | O4 (tunnels, webhook channels later) | [Implemented](2026-10-08-06-gateway-channels.md) on `feat/gateway-channels` |
| 7 | **Workflow runner** | Workflow files, `tool` / `judge` / `approve` steps, judge invocation via profile or direct-model fallback, OS-scheduler triggers, event triggers, run log, idempotency keys, missed-run rule, host-back-online notice, twice-daily report, escalation | 2, 4, 5, 6 | §10.1–10.7, §10.9, §10.3 (D38–D40) | O14 (per-OS scheduler behaviour) | Not started |
| 8 | **Workflow lifecycle** | Phases 5–7 (workflows, dry run, activate), sandbox mode + recording sink, agentic mode, hardening proposals + replay gate, earned autonomy, urgent events, learning loop | 7 | §10.8, §10.10, §11.6–11.7, §15.5 | O12 (thresholds, first pass) | Not started |
| 9 | **Operations + security hardening** | `doctor`, host readiness (Layer 1), pause / unpause, uninstall, support bundle, pack pinning + shadow upgrade, data-flow summary, retention | 1–8 | §5.1, §14, §16 | — | Not started |
| 10 | **CI matrix + certification** | CI for engine + scripted operator, nightly real-agent matrix, connector contract nightlies, universal injection suite, Codex certification | 1–9 | §15 | O2 (vendor terms), O5 (other profiles), O7 (CI budget cap) | Not started |

O11 (unattended hosted evals) and O15 (combo activation by API key) are
handled when the plan that touches them is written. `oauth` input steps
(the OAuth redirect half of O3) arrived with the connectors in Plan 5 (D66).

## Carried forward from Plan 1

Plan 2 covers the items below that concern runtime, refs and views; the BRAIN items move to Plan 3 (D46):

- `installer next` prints a wrapped result, `{ "status": "step" | "blocked" | "complete", "view": { "step", "status", "attempts", "hint", "resume" } }`.
  The spec §6.3 field names live inside `view.step`. Update the §6.3 example to match.
- A step whose check failed is retried with `installer resume` when it is a `verify` step, and with
  `installer verify <step_id>` for any other step type. Each retry counts toward the three-failure limit.
  The step view's `resume` field and the report both name the right command.
- `installer resume` also reopens optional steps that were given up, so the report goes back to `in_progress`.
- A `--value` that starts with `-` must be written as `--value=<json>` (for example `--value=-5`).
- Plan 1 pins the solution by copying it into `<engine_home>/solution/solution.json` and comparing content
  hashes on `start`. Plan 2 adds `skillswiki:` refs and records the §6.4 `recipe_version` sha in the state.
- The spec examples still differ from the code. Update them when Plan 2 edits the spec:
  - §6.4: the state has no top-level `phase` (the report works it out from the steps), and a blocked step
    records `at`, `reason`, `hint` and `attempts` instead of `since`. `mode` arrives with the MODE phase in Plan 2.
  - §6.5: the report header counts steps (`6 of 7 steps done`), not phases.
  - §4.2: the layout gains `solution/solution.json` (the pinned solution) and `state/install-state.json.bak`.
  - §6.1: `file:` refs are accepted (used by tests and local solutions). Plain HTTPS refs are not supported yet.
- `installer resume` reopens every failed step, not only `verify` ones, keeping its attempts. A reopened
  `agent_action` step then shows `installer resume` instead of `installer verify <step_id>`; Plan 2's
  `agent_action` work should name the right command for a reopened step.
- `submit` and `verify` for a known step that is not current first finish any pending engine steps, then refuse.
  This only runs work that `next` would run anyway.
- D34 rules in the code: `start` creates a new home with mode `0700` and refuses an existing home that other users
  can open, without changing its mode. Paths that go through a symbolic link below the home are refused.
